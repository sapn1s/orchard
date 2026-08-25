/**
 * BUG-011 — switching sessions from inside a subagent thread must not stamp
 * a stale ?agent=<id> onto the NEW session's history entry.
 *
 * Root cause (traced): openSession() called syncUrl('push') BEFORE
 * resetTranscript() cleared state.viewing back to 'main'. currentRoute()
 * reads state.viewing to decide whether to append &agent=…, so while the
 * user was parked on session A's subagent thread, opening session B pushed
 * `.../session/B?agent=<A's agent id>`. Reloading that URL then hit the
 * honest-but-wrong "this link names an agent thread not recorded in this
 * session" warning and dropped the user on the project view — the app
 * corrupting its own link.
 *
 *   node scripts/verify-session-switch-url.mjs
 *
 * Checks:
 *   1. viewing a recorded subagent thread of session A puts ?agent=<id> in
 *      the URL
 *   2. clicking session B (sidebar) while still parked on that agent thread
 *      pushes a URL for B with NO agent= param
 *   3. reloading that pushed URL lands on B's MAIN thread — no false
 *      "not recorded in this session" warning
 *   4. a genuine deep link `session/A?agent=<real id>` still opens the agent
 *      thread (the fix must not break legitimate agent deep-links)
 *
 * Ports are parameterised (VERIFY_SWITCHURL_PORT), never fixed — two verify
 * suites defaulting to the same port collide the moment both run.
 */
import { spawn, execFileSync } from 'node:child_process';
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
const PORT = Number(process.env.VERIFY_SWITCHURL_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-switchurl-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-switchurl-chrome-'));
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';

let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const cleanupDirs = [DATA, PROFILE];
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

const uid = (n, tag) => `00000000-0000-4000-${tag}-${String(n).padStart(12, '0')}`;

/** A plain (no subagent) session — this is "session B". */
function makePlainSession(store, sid) {
  const ts = new Date(Date.now() - 60_000).toISOString();
  const lines = [
    JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', uuid: uid(1, 'b111'), timestamp: ts, sessionId: sid,
      message: { role: 'user', content: [{ type: 'text', text: 'hello from B' }] } }),
    JSON.stringify({ parentUuid: uid(1, 'b111'), isSidechain: false, type: 'assistant', uuid: uid(2, 'b111'), timestamp: ts, sessionId: sid,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi, this is session B main thread' }] } }),
  ];
  fs.writeFileSync(path.join(store, `${sid}.jsonl`), lines.join('\n') + '\n');
}

/** A session with ONE recorded sub-agent thread — this is "session A". */
function makeSessionWithAgent(store, sid, agentId) {
  const ts = new Date(Date.now() - 60_000).toISOString();
  const lines = [
    JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', uuid: uid(1, 'a111'), timestamp: ts, sessionId: sid,
      message: { role: 'user', content: [{ type: 'text', text: 'do the subagent thing' }] } }),
    JSON.stringify({ parentUuid: uid(1, 'a111'), isSidechain: false, type: 'assistant', uuid: uid(2, 'a111'), timestamp: ts, sessionId: sid,
      message: { role: 'assistant', content: [{ type: 'text', text: 'dispatched a subagent' }] } }),
  ];
  fs.writeFileSync(path.join(store, `${sid}.jsonl`), lines.join('\n') + '\n');
  const agDir = path.join(store, sid, 'subagents');
  fs.mkdirSync(agDir, { recursive: true });
  fs.writeFileSync(path.join(agDir, `agent-${agentId}.jsonl`),
    JSON.stringify({ isSidechain: true, agentId, type: 'assistant', timestamp: ts,
      message: { role: 'assistant', content: [{ type: 'text', text: 'sub-agent output' }], usage: { output_tokens: 5 } } }) + '\n');
  fs.writeFileSync(path.join(agDir, `agent-${agentId}.meta.json`),
    JSON.stringify({ agentType: 'general-purpose', description: 'Investigate the thing', toolUseId: 'tu-1' }));
}

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-switchurl-proj-'));
  cleanupDirs.push(projDir);
  const encoded = projDir.replace(/[/.]/g, '-');
  const store = path.join(os.homedir(), '.claude', 'projects', encoded);
  fs.mkdirSync(store, { recursive: true });
  cleanupDirs.push(store);

  const sidA = 'aaaaaaaa-1111-4111-8111-111111111111';
  const sidB = 'bbbbbbbb-2222-4222-8222-222222222222';
  const agentId = 'agentA001xyz';
  makeSessionWithAgent(store, sidA, agentId);
  makePlainSession(store, sidB);

  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: projDir, name: 'switchurl-fixture' }),
  })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`register failed: ${JSON.stringify(reg)}`);

  // Sanity: A really reports the recorded sub-agent; B has none.
  const subsA = await (await fetch(`${BASE}/api/sessions/${sidA}/subagents?dir=${encodeURIComponent(encoded)}`)).json();
  if (!(Array.isArray(subsA.subagents) && subsA.subagents.some((a) => (a.agentId ?? a.id) === agentId))) {
    throw new Error(`fixture: session A's subagent not reported: ${JSON.stringify(subsA).slice(0, 200)}`);
  }

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--window-size=1280,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  if (!devPort) throw new Error('browser never wrote DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');

  const openAt = (sid) => cdp.send('Page.navigate', { url: `${BASE}/#/project/${pid}/session/${sid}?dir=${encodeURIComponent(encoded)}` });
  const HERE = `document.querySelector('#panes .pane.on .you, #panes .pane.on .claude') !== null`;

  console.log('\n=== setup: open session A, then jump into its recorded subagent thread ===');
  await openAt(sidA);
  await cdp.waitFor('session A transcript', HERE, 30_000);
  await sleep(500);
  await cdp.eval(`window.__station.viewAgent(${JSON.stringify(agentId)})`);
  await cdp.waitFor('viewing agent thread', `window.__station.state.viewing === ${JSON.stringify(agentId)}`, 15_000);
  let hash = await cdp.eval('location.hash');
  check('viewing session A\'s subagent thread put ?agent=<id> in the URL',
    hash.includes(`agent=${agentId}`), hash);

  console.log('\n=== switching to session B from inside that subagent thread ===');
  // The settled/reloaded URL alone is a WEAK signal: openSession's later
  // resetTranscript() -> showThread('main') -> syncUrl('replace') can correct
  // a bad push within the same synchronous tick, before anything external
  // ever observes it. That self-heal must not be mistaken for "no bug" — the
  // defect is that the PUSH ITSELF (the actual history.pushState call) still
  // carries the stale agent= id. Capture the raw call, not just the outcome.
  await cdp.eval(`(() => {
    window.__pushLog = [];
    const orig = window.history.pushState.bind(window.history);
    window.history.pushState = (...a) => { window.__pushLog.push(a[2]); return orig(...a); };
  })()`);
  // Sidebar click on B's row — the exact repro path (not a programmatic route).
  const clicked = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('#tree .kids button.row')];
    // Only two sessions live in this fixture project: A (currently open,
    // aria-current="true") and B. Pick the one that is NOT current.
    const row = rows.find((r) => r.getAttribute('aria-current') !== 'true');
    if (row) { row.click(); return true; }
    return false;
  })()`);
  if (!clicked) throw new Error('could not find session B\'s sidebar row to click');
  await cdp.waitFor('session B open', `window.__station.state.current.sessionId === ${JSON.stringify(sidB)}`, 30_000);
  await sleep(300);

  const pushLog = await cdp.eval(`window.__pushLog`);
  const pushedForB = (pushLog ?? []).find((u) => typeof u === 'string' && u.includes(`/session/${sidB}`));
  check('the history.pushState call ITSELF (not just the settled/self-healed URL) carried no stale agent=',
    !!pushedForB && !pushedForB.includes('agent='), JSON.stringify(pushLog));

  hash = await cdp.eval('location.hash');
  check('switching to session B pushed a URL with NO stale agent= param',
    hash.includes(`/session/${sidB}`) && !hash.includes('agent='), hash);
  check('…and state.viewing was reset to main (not carried over from A)',
    await cdp.eval(`window.__station.state.viewing`) === 'main', await cdp.eval(`window.__station.state.viewing`));

  console.log('\n=== reloading the pushed URL for B: no false "not recorded" warning ===');
  await cdp.eval('location.reload()');
  await sleep(600);
  await cdp.waitFor('session B transcript after reload', HERE, 30_000);
  await sleep(800);
  const afterReload = await cdp.eval(`({
    sessionId: window.__station.state.current.sessionId,
    viewing: window.__station.state.viewing,
    said: [...document.querySelectorAll('#panes .hint-row, #fine')].map((n) => n.textContent).join(' | '),
  })`);
  check('reload landed on session B, on its MAIN thread',
    afterReload.sessionId === sidB && afterReload.viewing === 'main', JSON.stringify(afterReload));
  check('…with NO false "not recorded in this session" warning',
    !/not recorded in this session/i.test(afterReload.said), JSON.stringify(afterReload.said));

  console.log('\n=== regression guard: a GENUINE agent deep-link still works ===');
  await cdp.send('Page.navigate', { url: `${BASE}/#/project/${pid}/session/${sidA}?dir=${encodeURIComponent(encoded)}&agent=${agentId}` });
  await cdp.waitFor('boot after deep link', `document.querySelectorAll('#tree button.proj').length > 0`, 30_000);
  const deepOk = await cdp.waitFor('deep-linked agent thread opened',
    `window.__station.state.current.sessionId === ${JSON.stringify(sidA)} && window.__station.state.viewing === ${JSON.stringify(agentId)}`, 20_000);
  const deepState = await cdp.eval(`({
    sessionId: window.__station.state.current.sessionId,
    viewing: window.__station.state.viewing,
    said: [...document.querySelectorAll('#panes .hint-row, #fine')].map((n) => n.textContent).join(' | '),
  })`);
  check('a genuine ?agent=<id> deep-link into a session that HAS that agent still opens the agent thread',
    deepOk && !/not recorded in this session/i.test(deepState.said), JSON.stringify(deepState));

  cdp.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exitCode = 1;
}).finally(() => {
  stopByPid(browser);
  stopByPid(server);
  setTimeout(() => {
    for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }, 2500);
});
