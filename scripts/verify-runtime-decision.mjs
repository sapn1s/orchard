/**
 * Runtime-raised decision cards (FEAT-029) — a RUNNING session raises a decision
 * that becomes a persistent, tracked Needs-You rail card, and the user's answer
 * routes back to that specific session.
 *
 *   node scripts/verify-runtime-decision.mjs
 *
 * Everything is real: a REAL server on a SCRATCH free port (never 4317), a REAL
 * haiku session started through the UI, and the REAL public/app.js rail. It runs
 * ONE cheap haiku session and drives it twice. Checks:
 *   (a) a session raises a decision via POST /api/sessions/:sid/needs-you → a
 *       card appears in the rail with the question + option buttons + a free-text
 *       field;
 *   (b) answering (option click) DELIVERS the answer to the raising session (its
 *       transcript gains the answer as a user message + it starts a turn) and
 *       REMOVES the card (record resolved);
 *   (c) an unanswered decision PERSISTS across a full page reload (it lives in a
 *       JSON store, not the DOM) until answered; a free-text answer after the
 *       raising session is gone is still RECORDED (delivered:false), not a crash;
 *   (d) a bad POST (empty question) → 400, and an unknown session → 400.
 *
 * Ports are OS-assigned (VERIFY_DECISION_PORT pins one); never 4317. Processes
 * are killed by PID, never pkill.
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
const PORT = Number(process.env.VERIFY_DECISION_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dec-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dec-store-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dec-chrome-'));
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dec-proj-'));
const BRAVE = process.env.VERIFY_DECISION_BROWSER ?? 'brave';

const QUESTION = 'Ship the importer now, or hold for the schema review?';
const OPT_A = 'Ship now';
const OPT_B = 'Hold for review';
const Q2 = 'Which region should the first deploy target?';

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
  async waitFor(label, expr, timeoutMs = 30_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.eval(expr)) return true; } catch { /* nav */ }
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

let server = null, browser = null;
const cleanupDirs = [DATA, STORE, PROFILE, PROJ];
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let json = null;
  try { json = await r.json(); } catch { /* non-json */ }
  return { status: r.status, json };
}

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    // NOTE: no CLAUDE_PROJECTS_DIR — the CLI writes transcripts to ~/.claude/
    // projects and the station must READ from the same place (as verify-queue
    // does), or the routed-back answer would be unreadable on disk. Only the
    // decisions store (under CLAUDE_STATION_DATA) is scratch-isolated.
    env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const reg = await postJson(`${BASE}/api/projects`, { hostPath: PROJ, name: 'Decision Fixture' });
  const projectId = reg.json?.project?.id;
  if (!projectId) throw new Error(`register failed: ${JSON.stringify(reg)}`);

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
  const cdp = await Cdp.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const selectProj = async () => cdp.eval(`(() => {
    const row = [...document.querySelectorAll('#tree button.proj')]
      .find((r) => (r.querySelector('.nm')?.textContent ?? '').includes('Decision Fixture'));
    if (!row) return false; row.click(); return true;
  })()`);

  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('boot', `window.__station !== undefined && document.querySelectorAll('#tree button.proj').length >= 1`, 30_000);
  if (!await selectProj()) throw new Error('could not select the fixture project');

  /* ---- start a REAL haiku session so there is a live bridge to route back to ---- */
  console.log('\n=== decision: start a live haiku session ===');
  await cdp.eval(`(() => {
    const st = window.__station.state;
    st.overrides.model = 'haiku';
    document.querySelector('#prompt').value = 'Reply with exactly: SESSION-READY';
    document.querySelector('#go').click();
  })()`);
  if (!await cdp.waitFor('turn running', `window.__station.state.busy === true`, 30_000)) throw new Error('haiku turn never started');
  if (!await cdp.waitFor('turn idle', `window.__station.state.busy === false`, 90_000)) throw new Error('haiku turn never finished');
  const sid = await cdp.eval(`window.__station.state.current.sessionId`);
  const dir = await cdp.eval(`window.__station.state.current.encodedDir`);
  check('a live haiku session is running with an SDK session id', typeof sid === 'string' && sid.length > 0, JSON.stringify({ sid, dir }));

  /* ---- (d) bad POSTs ---- */
  console.log('\n=== decision: bad raises are rejected ===');
  const empty = await postJson(`${BASE}/api/sessions/${encodeURIComponent(sid)}/needs-you`, { question: '   ' });
  check('(d1) empty question → 400', empty.status === 400, JSON.stringify(empty));
  const unknown = await postJson(`${BASE}/api/sessions/not-a-real-session/needs-you`, { question: QUESTION });
  check('(d2) unknown session → 400', unknown.status === 400, JSON.stringify(unknown));

  /* ---- (a) raise a decision with options → a rail card ---- */
  console.log('\n=== decision: a raised decision becomes a rail card with options ===');
  const raised = await postJson(`${BASE}/api/sessions/${encodeURIComponent(sid)}/needs-you`, {
    question: QUESTION, options: [OPT_A, OPT_B],
  });
  const recId = raised.json?.id;
  check('(a0) raise returns 201 + a record id', raised.status === 201 && typeof recId === 'string' && recId.length > 0, JSON.stringify(raised));

  // Server-side precondition: the record now appears in the project's board feed
  // as a decision Needs-You item, in front of any board tickets.
  const feed = await (await fetch(`${BASE}/api/projects/${projectId}/board`)).json();
  check('(a1) the decision surfaces in the board feed needsYou with kind:decision + options',
    (feed.needsYou ?? []).some((x) => x.id === recId && x.kind === 'decision' && Array.isArray(x.options) && x.options.length === 2),
    JSON.stringify(feed.needsYou?.map((x) => ({ id: x.id, kind: x.kind, options: x.options }))));

  await cdp.eval(`window.__station.refreshRail(true)`);
  await cdp.waitFor('decision card', `document.querySelector('#railNeeds .needs-card[data-kind="decision"]') !== null`, 20_000);
  const cardA = await cdp.eval(`(() => {
    const c = document.querySelector('#railNeeds .needs-card[data-kind="decision"]');
    return c ? {
      id: c.dataset.id,
      title: c.querySelector('.nc-title')?.textContent ?? '',
      hasField: !!c.querySelector('textarea.nc-input'),
      opts: [...c.querySelectorAll('.nc-opt')].map((b) => b.textContent),
    } : null;
  })()`);
  check('(a) the rail shows the decision card: question text + free-text field + both option buttons',
    !!cardA && cardA.id === recId && cardA.title === QUESTION && cardA.hasField
      && cardA.opts.length === 2 && cardA.opts.includes(OPT_A) && cardA.opts.includes(OPT_B),
    JSON.stringify(cardA));

  // Screenshot the runtime card for the ticket.
  try {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const outDir = path.join(ROOT, 'docs', 'bugs', 'assets');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'FEAT-029-runtime-card.png'), Buffer.from(shot.data, 'base64'));
    console.log(`        (screenshot → docs/bugs/assets/FEAT-029-runtime-card.png)`);
  } catch (e) { console.log(`        (screenshot failed: ${e.message})`); }

  /* ---- (b) answering an option delivers to the raising session + removes the card ---- */
  console.log('\n=== decision: answering an option routes back to the raising session ===');
  const decStore = () => JSON.parse(fs.readFileSync(path.join(DATA, 'decisions.json'), 'utf8'));
  // GET /api/sessions reports the live bridges + their busy flag — the
  // server-authoritative signal (the TAB's busy only flips on tab-initiated
  // turns, never on a server-side send routed in from the rail).
  const liveBridge = async () => (await (await fetch(`${BASE}/api/sessions`)).json())
    .sessions.find((s) => s.sdkSessionId === sid);

  await cdp.eval(`(() => {
    const c = document.querySelector('#railNeeds .needs-card[data-kind="decision"]');
    const btn = [...c.querySelectorAll('.nc-opt')].find((b) => b.textContent === ${JSON.stringify(OPT_A)});
    btn.click();
  })()`);
  const cardGone = await cdp.waitFor('decision card removed',
    `document.querySelector('#railNeeds .needs-card[data-id=${JSON.stringify(recId)}]') === null`, 10_000);
  check('(b1) answering the option removed the decision card from the rail', cardGone,
    `cards now = ${await cdp.eval(`document.querySelectorAll('#railNeeds .needs-card').length`)}`);

  // THE routing-back proof: the resolved record records delivered:true — the
  // answer entered the RAISING session's input queue via AgentSession.send().
  await sleep(600);
  const rec1 = decStore().find((r) => r.id === recId);
  check('(b2) the option answer was DELIVERED to the raising session (record delivered:true)',
    rec1?.resolved === true && rec1?.answer === OPT_A && rec1?.delivered === true, JSON.stringify(rec1));

  // Downstream confirmation: the routed answer runs a turn whose user message is
  // the option text, on disk in the raising session's own transcript.
  await (async () => {
    for (let i = 0; i < 60; i++) {
      const b = await liveBridge();
      if (b && b.busy === false) break; // turn finished
      await sleep(1000);
    }
  })();
  await sleep(800);
  const t = await (await fetch(`${BASE}/api/transcript/${encodeURIComponent(dir)}/${encodeURIComponent(sid)}?tail=200`)).json();
  const userTexts = (t.messages ?? []).flatMap((mm) => (mm.blocks ?? [])
    .filter((b) => b.type === 'text').map((b) => `${mm.role}:${b.text}`))
    .filter((x) => x.startsWith('user:'));
  check('(b3) the option answer landed in the raising session transcript as a user message',
    userTexts.some((x) => x.includes(OPT_A)), JSON.stringify(userTexts.map((x) => x.slice(0, 60))));

  // The record is resolved server-side: it no longer appears in the feed.
  const feed2 = await (await fetch(`${BASE}/api/projects/${projectId}/board`)).json();
  check('(b4) the resolved decision is gone from the board feed',
    !(feed2.needsYou ?? []).some((x) => x.id === recId), JSON.stringify(feed2.needsYou?.map((x) => x.id)));

  /* ---- (c) persistence across reload + graceful record when the session is gone ---- */
  console.log('\n=== decision: an unanswered decision persists across a page reload ===');
  // Make sure the routed turn has fully settled so the reload closes an IDLE
  // session (a busy one would only detach and stay live).
  await (async () => {
    for (let i = 0; i < 60; i++) { const b = await liveBridge(); if (!b || b.busy === false) break; await sleep(1000); }
  })();
  const raised2 = await postJson(`${BASE}/api/sessions/${encodeURIComponent(sid)}/needs-you`, { question: Q2 });
  const rec2 = raised2.json?.id;
  check('(c0) a second decision (no options) was raised', raised2.status === 201 && !!rec2, JSON.stringify(raised2));

  // Full reload — the DOM is discarded; only a persisted record can bring the
  // card back. (The idle raising session is closed by the reload, which also
  // exercises the "session gone" answer path below.)
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('reboot', `window.__station !== undefined && document.querySelectorAll('#tree button.proj').length >= 1`, 30_000);
  await selectProj();
  const survived = await cdp.waitFor('decision survived reload',
    `document.querySelector('#railNeeds .needs-card[data-id=${JSON.stringify(rec2)}]') !== null`, 20_000);
  const feed3 = await (await fetch(`${BASE}/api/projects/${projectId}/board`)).json();
  check('(c1) the unanswered decision persisted across the reload (store-backed, not DOM)',
    survived && (feed3.needsYou ?? []).some((x) => x.id === rec2), JSON.stringify({ survived, feed: feed3.needsYou?.map((x) => x.id) }));

  // The reload closed the idle raising session — confirm the bridge is gone, so
  // the free-text answer below legitimately exercises the "session gone" path.
  const bridgeGone = await (async () => {
    for (let i = 0; i < 40; i++) { if (!await liveBridge()) return true; await sleep(500); }
    return !await liveBridge();
  })();
  check('(c1b) the raising session bridge closed on reload (so the next answer hits the gone-session path)',
    bridgeGone, JSON.stringify(await liveBridge() ?? 'gone'));

  // Answer via FREE TEXT now — the raising session is gone, so it is recorded
  // (delivered:false) and must NOT crash; the card still leaves the rail.
  console.log('\n=== decision: free-text answer is recorded even when the session is gone ===');
  const freeAnswer = 'us-east-1, keep it simple.';
  await cdp.eval(`(() => {
    const c = document.querySelector('#railNeeds .needs-card[data-id=${JSON.stringify(rec2)}]');
    const ta = c.querySelector('textarea.nc-input');
    ta.value = ${JSON.stringify(freeAnswer)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    c.querySelector('.nc-send').click();
  })()`);
  const gone2 = await cdp.waitFor('free-text answered card removed',
    `document.querySelector('#railNeeds .needs-card[data-id=${JSON.stringify(rec2)}]') === null`, 15_000);
  check('(c2) a free-text answer removed the card', gone2,
    `cards now = ${await cdp.eval(`document.querySelectorAll('#railNeeds .needs-card').length`)}`);
  await sleep(500);
  const feed4 = await (await fetch(`${BASE}/api/projects/${projectId}/board`)).json();
  const store = JSON.parse(fs.readFileSync(path.join(DATA, 'decisions.json'), 'utf8'));
  const rec2Stored = store.find((r) => r.id === rec2);
  check('(c3) the answer was RECORDED to the resolved decision (delivered:false, session gone) — no crash',
    !(feed4.needsYou ?? []).some((x) => x.id === rec2) && rec2Stored?.resolved === true && rec2Stored?.answer === freeAnswer && rec2Stored?.delivered === false,
    JSON.stringify(rec2Stored));
  // The server is still healthy after answering into a dead session.
  const health = await (await fetch(`${BASE}/api/health`)).json();
  check('(c4) the server stayed healthy through the whole flow', health.ok === true, JSON.stringify({ ok: health.ok }));

  cdp.close();
}

main()
  .catch((err) => { console.error(`\nFATAL: ${err.stack ?? err}`); fail++; failures.push(`FATAL: ${err.message}`); })
  .finally(async () => {
    stopByPid(browser);
    stopByPid(server);
    await sleep(400);
    for (const d of cleanupDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
    console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
    if (failures.length) console.log(`  failing: ${failures.join(' | ')}`);
    process.exit(fail === 0 ? 0 : 1);
  });
