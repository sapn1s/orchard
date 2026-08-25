/**
 * BUG-016 verification — the Needs-You rail must be a LIVE mirror of the
 * board, not just optimistic on its own submit + reconciled on manual reload.
 *
 *   node scripts/verify-rail-refresh.mjs
 *
 * Driven in a REAL Chromium (brave --headless=new over raw CDP; happy-dom has
 * no real timers/visibility semantics worth trusting here) against a REAL
 * server. Everything is real: a scratch project with an opt-in docs/bugs/
 * board, registered through the API, rendered by the real public/app.js.
 *
 * Checks:
 *   (a) a card resolved OUT OF BAND — a chat/orchestrator-style append of the
 *       answer mark directly to the ticket file, NOT via the card's own Respond
 *       button — disappears from the rail within the poll interval, with NO
 *       manual reload;
 *   (b) a 👤 item added OUT OF BAND — a fresh ticket file + an INDEX.md row,
 *       simulating an orchestrator INDEX edit — appears in the rail the same way;
 *   (c) a card the user is mid-typing in (still present in the board's set)
 *       is NOT wiped/reset by a background poll that happens while they type.
 *
 * Ports are OS-assigned (VERIFY_RAIL_REFRESH_PORT pins one); never 4317 (the
 * live server). Processes are killed by PID, never pkill.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_RAIL_REFRESH_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-railref-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-railref-store-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-railref-chrome-'));
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-railref-proj-'));
const BRAVE = process.env.VERIFY_RAIL_BROWSER ?? 'brave';

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- raw CDP */
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c = new Cdp(ws);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && c.waiting.has(m.id)) {
        const { res, rej } = c.waiting.get(m.id);
        c.waiting.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.waiting.set(id, { res, rej }));
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async waitFor(label, expr, timeoutMs = 20_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.eval(expr)) return true; } catch { /* mid-navigation */ }
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

let server = null, browser = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

const ID_STAYS = 'BUG-820';   // stays open the whole run; user types a partial answer here
const ID_RESOLVED_OOB = 'BUG-821'; // resolved out-of-band (chat/INDEX-style append), NOT via its button
const ID_ADDED_OOB = 'BUG-822';    // does not exist at boot; added out-of-band mid-run
const PARTIAL_TEXT = 'still thinking about this, do not clobber me — ';

const bugsDir = path.join(PROJ, 'docs', 'bugs');

function writeIndex(rows) {
  fs.writeFileSync(path.join(bugsDir, 'INDEX.md'),
    `# Board\n\n## Open\n\n` +
    `| ID | Title | Owner | Status | Sev |\n` +
    `|----|-------|-------|--------|-----|\n` +
    rows.map((r) => `| ${r.id} | ${r.title} | 👤 | needs decision | med |\n`).join('') +
    `\n## Done (committed)\n\n| ID | Title | Commit |\n|----|-------|--------|\n`);
}
function writeTicket(id, title) {
  fs.writeFileSync(path.join(bugsDir, `${id}-t.md`),
    `# ${id} — ${title}\n\n- **Status:** OPEN\n\n## Activity log (APPEND-ONLY)\n\n### 2026-08-04 — orchestrator\n- filed.\n`);
}

async function seedBoard() {
  fs.mkdirSync(bugsDir, { recursive: true });
  writeIndex([
    { id: ID_STAYS, title: 'keep this response field intact across a poll' },
    { id: ID_RESOLVED_OOB, title: 'ack this one out of band, like a chat resolution' },
  ]);
  writeTicket(ID_STAYS, 'keep this response field intact across a poll');
  writeTicket(ID_RESOLVED_OOB, 'ack this one out of band, like a chat resolution');
}

async function registerProject(hostPath, name) {
  const r = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath, name }),
  })).json();
  if (!r.project?.id) throw new Error(`could not register ${name}: ${JSON.stringify(r)}`);
  return r.project.id;
}

async function main() {
  await seedBoard();
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); }
  }
  if (!up) throw new Error('server never became healthy');

  const projId = await registerProject(PROJ, 'Rail Refresh');

  const b0 = await (await fetch(`${BASE}/api/projects/${projId}/board`)).json();
  check('PRECONDITION: board starts with both seeded 👤 tickets and neither third one',
    b0.needsYou?.length === 2 && b0.needsYou.some((x) => x.id === ID_STAYS) && b0.needsYou.some((x) => x.id === ID_RESOLVED_OOB),
    JSON.stringify(b0.needsYou?.map((x) => x.id)));

  browser = spawn(BRAVE, [
    '--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--window-size=1400,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  if (!devPort) throw new Error('browser never wrote DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const clickProj = async (name) => cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('#tree button.proj')];
    const row = rows.find((r) => (r.querySelector('.nm')?.textContent ?? '').includes(${JSON.stringify(name)}));
    if (!row) return false;
    row.click(); return true;
  })()`);

  console.log('\n=== rail-refresh: boot with two 👤 cards ===');
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('boot', `document.querySelectorAll('#tree button.proj').length >= 1`, 30_000);
  const picked = await clickProj('Rail Refresh');
  check('PRECONDITION: the seeded project is in the sidebar and selectable', picked, `clicked=${picked}`);
  await cdp.waitFor('two needs-you cards', `document.querySelectorAll('#railNeeds .needs-card').length === 2`, 20_000);

  const pollMs = await cdp.eval(`window.__station?.RAIL_POLL_MS ?? 0`);
  check('PRECONDITION: the page exposes a poll interval for the rail (the fix under test)', pollMs > 0, `RAIL_POLL_MS=${pollMs}`);
  const waitMs = (pollMs > 0 ? pollMs : 5000) + 4000; // one full cycle + slack, no manual refresh call

  // Type a partial, unsubmitted answer into the card that STAYS — and focus it,
  // exactly like a user paused mid-thought while a poll fires in the background.
  await cdp.eval(`(() => {
    const c = document.querySelector('.needs-card[data-id=${JSON.stringify(ID_STAYS)}]');
    const ta = c.querySelector('textarea.nc-input');
    ta.focus();
    ta.value = ${JSON.stringify(PARTIAL_TEXT)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const typedOk = await cdp.eval(`document.querySelector('.needs-card[data-id=${JSON.stringify(ID_STAYS)}] textarea.nc-input')?.value`);
  check('PRECONDITION: the partial answer was typed into the surviving card', typedOk === PARTIAL_TEXT, typedOk);

  console.log('\n=== rail-refresh: resolve one card OUT OF BAND (not via its Respond button) ===');
  // Simulate a chat ack / orchestrator resolution: append the rail's own answer
  // mark directly to the ticket file on disk. The card's button is never touched.
  fs.appendFileSync(path.join(bugsDir, `${ID_RESOLVED_OOB}-t.md`),
    `\n### 2026-08-04 — you (via Needs-You rail)\n- **Answer:** resolved in chat, out of band\n`);

  console.log('\n=== rail-refresh: add a NEW 👤 item OUT OF BAND (orchestrator-style INDEX edit) ===');
  writeTicket(ID_ADDED_OOB, 'a brand new decision the orchestrator just raised');
  writeIndex([
    { id: ID_STAYS, title: 'keep this response field intact across a poll' },
    { id: ID_RESOLVED_OOB, title: 'ack this one out of band, like a chat resolution' },
    { id: ID_ADDED_OOB, title: 'a brand new decision the orchestrator just raised' },
  ]);

  console.log(`\n=== rail-refresh: wait up to ${waitMs}ms for the LIVE mirror to catch up — NO reload ===`);
  const settled = await cdp.waitFor('rail reconciled to the out-of-band truth',
    `(() => {
      const ids = [...document.querySelectorAll('#railNeeds .needs-card')].map((c) => c.dataset.id);
      return ids.includes(${JSON.stringify(ID_ADDED_OOB)}) && !ids.includes(${JSON.stringify(ID_RESOLVED_OOB)}) && ids.includes(${JSON.stringify(ID_STAYS)});
    })()`, waitMs);

  const finalState = await cdp.eval(`(() => {
    const cards = [...document.querySelectorAll('#railNeeds .needs-card')];
    return {
      ids: cards.map((c) => c.dataset.id),
      staysTextareaValue: document.querySelector('.needs-card[data-id=${JSON.stringify(ID_STAYS)}] textarea.nc-input')?.value ?? null,
      staysStillFocused: document.activeElement === document.querySelector('.needs-card[data-id=${JSON.stringify(ID_STAYS)}] textarea.nc-input'),
    };
  })()`);

  check('(a) the OUT-OF-BAND-resolved card DISAPPEARED without a manual reload',
    !finalState.ids.includes(ID_RESOLVED_OOB), JSON.stringify(finalState.ids));
  check('(b) the OUT-OF-BAND-added card APPEARED without a manual reload',
    finalState.ids.includes(ID_ADDED_OOB), JSON.stringify(finalState.ids));
  check('    both reconciled inside one poll cycle (the waitFor condition itself settled)',
    settled, `settled=${settled}`);
  check('(c) the still-present card\'s half-typed answer was NOT wiped by the background poll',
    finalState.staysTextareaValue === PARTIAL_TEXT, finalState.staysTextareaValue);
  check('    the still-present card\'s textarea kept focus across the poll (not remounted)',
    finalState.staysStillFocused, `focused=${finalState.staysStillFocused}`);

  cdp.close();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(() => {
  stopByPid(browser);
  stopByPid(server);
  setTimeout(() => {
    for (const d of [DATA, STORE, PROFILE, PROJ]) fs.rmSync(d, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }, 2500);
});
