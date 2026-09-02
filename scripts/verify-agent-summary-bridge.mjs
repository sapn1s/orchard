/**
 * BUG-004, the case all three prior attempts missed: a session that is still
 * owned by a LIVE BRIDGE but whose jsonl mtime is STALE (idle >LIVE_WINDOW, so it
 * has DROPPED OUT of the mtime-based /api/sessions/live list) must STILL suppress
 * the historical "N agents ran" summary on reopen. Liveness is the UNION of the
 * mtime live list AND a live bridge; this test exercises the bridge-only half.
 *
 *   node scripts/verify-agent-summary-bridge.mjs      (needs OAuth — one haiku turn)
 *
 * How the bridge-idle condition is constructed honestly (no faked bridge):
 *   1. Tab A starts a REAL (cheap haiku) turn via the dashboard → a real bridge
 *      with a real sdkSessionId is created; the tab stays ATTACHED so the bridge
 *      does NOT auto-close when the turn finishes (only DETACHED idle bridges
 *      self-close after ~3s — see agent-bridge.ts).
 *   2. The turn finishes; the tab stays open (bridge lingers, idle).
 *   3. A recorded sub-agent is injected into the session's store so a summary
 *      WOULD render if the session were treated as finished history.
 *   4. The session's jsonl mtime is aged to >2 min ago → it is NO LONGER in the
 *      mtime live list (asserted against the API). The bridge is still there
 *      (also asserted).
 *   5. Tab B opens the same session. With mtime saying "dead" and the bridge
 *      saying "alive", the UNION must treat it as LIVE: NO ran-stack summary, and
 *      the follow is framed as still-running.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { isolatedStoreEnv } from './lib/station-boot.mjs';

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_ASB_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-asb-data-'));
// This suite creates a REAL (PONG) session and then reads it BACK — both by
// walking the store and via the server's subagents/live APIs. So isolate the
// CLI writer AND Orchard's reader to the same scratch store (alsoReader), and
// walk THAT store below instead of ~/.claude/projects.
const STORE_ENV = isolatedStoreEnv(path.join(DATA, 'store'), { alsoReader: true });
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-asb-chrome-'));
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
const cleanupDirs = [DATA, PROFILE];
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

const uid = (n) => `00000000-0000-4000-e000-${String(n).padStart(12, '0')}`;

/** Inject a recorded sub-agent under <store>/<sid>/subagents/ so a summary WOULD
 *  render for this session if it were treated as finished history. */
function injectRecordedAgent(store, sid) {
  const ts = new Date().toISOString();
  const agDir = path.join(store, sid, 'subagents');
  fs.mkdirSync(agDir, { recursive: true });
  fs.writeFileSync(path.join(agDir, 'agent-abc123.jsonl'),
    JSON.stringify({ isSidechain: true, agentId: 'abc123', type: 'assistant', timestamp: ts,
      message: { role: 'assistant', content: [{ type: 'text', text: 'sub-agent output' }], usage: { output_tokens: 5 } } }) + '\n');
  fs.writeFileSync(path.join(agDir, 'agent-abc123.meta.json'),
    JSON.stringify({ agentType: 'general-purpose', description: 'Fix stale example-app permissionMode', toolUseId: 'tu-x' }));
}

async function newPage(devPort) {
  const created = await (await fetch(`http://127.0.0.1:${devPort}/json/new`, { method: 'PUT' })).json().catch(async () => {
    // Older/newer builds vary on the verb; fall back to GET.
    return (await (await fetch(`http://127.0.0.1:${devPort}/json/new`)).json());
  });
  return Cdp.connect(created.webSocketDebuggerUrl);
}

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, ...STORE_ENV },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-asb-proj-'));
  cleanupDirs.push(projDir);
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: projDir, name: 'asb-fixture' }),
  })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`register failed: ${JSON.stringify(reg)}`);

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const tabA = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await tabA.send('Page.enable');

  console.log('\n=== Tab A: start a real haiku turn (creates a real bridge), keep it attached ===');
  await tabA.send('Page.navigate', { url: `${BASE}/` });
  await tabA.waitFor('boot', `window.__station !== undefined`);
  await tabA.waitFor('project selected + composer ready', `window.__station.state.current.projectId && document.querySelector('#prompt')`);
  await sleep(600);
  await tabA.eval(`(() => {
    const s = window.__station.state; s.overrides.model = 'haiku';
    document.querySelector('#prompt').value = 'Reply with exactly the single word: PONG';
    document.querySelector('#go').click();
  })()`);
  const busy = await tabA.waitFor('turn running with an id',
    `window.__station.state.busy === true && !!window.__station.state.current.sessionId`, 30_000);
  const sid = await tabA.eval(`window.__station.state.current.sessionId`);
  if (!busy || !sid) throw new Error('turn never started (OAuth/model unavailable?) — cannot honestly build the bridge-idle case');
  console.log(`        sdkSessionId = ${sid}`);
  // Let the turn FINISH. Tab A stays attached, so the bridge lingers (idle, not detached).
  const finished = await tabA.waitFor('turn finishes', `window.__station.state.busy === false`, 180_000);
  if (!finished) throw new Error('haiku turn never finished within 180s');
  await sleep(500);

  // Locate the REAL jsonl the SDK wrote (its own path encoding), derive the store dir.
  let jsonl = null;
  for (let i = 0; i < 40 && !jsonl; i++) {
    const root = STORE_ENV.CLAUDE_PROJECTS_DIR;
    const hit = (function walk(dir) {
      let out = null;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { out = walk(p); if (out) return out; }
        else if (e.name === `${sid}.jsonl`) return p;
      }
      return out;
    })(root);
    if (hit) jsonl = hit; else await sleep(250);
  }
  if (!jsonl) throw new Error(`could not find the session jsonl for ${sid} under the isolated store ${STORE_ENV.CLAUDE_PROJECTS_DIR}`);
  const store = path.dirname(jsonl);
  const encoded = path.basename(store);
  cleanupDirs.push(store);
  console.log(`        store = ${store}`);

  console.log('\n=== inject a recorded sub-agent + age the jsonl mtime past the live window ===');
  injectRecordedAgent(store, sid);
  const subs = await (await fetch(`${BASE}/api/sessions/${sid}/subagents?dir=${encodeURIComponent(encoded)}`)).json();
  check('fixture: the session reports the injected recorded sub-agent (so a summary CAN render)',
    Array.isArray(subs.subagents) && subs.subagents.length === 1, JSON.stringify(subs).slice(0, 160));

  // Age the file so it drops out of the mtime live window (LIVE_WINDOW_MS = 30s).
  spawnSyncTouch(jsonl, '-d', '120 seconds ago');

  const liveList = await (await fetch(`${BASE}/api/sessions/live`)).json();
  const inMtimeList = (liveList.sessions ?? []).some((s) => s.sessionId === sid);
  check('precondition: the idle session has DROPPED OUT of the mtime live list',
    inMtimeList === false, `mtime live sessions: ${JSON.stringify((liveList.sessions ?? []).map((s) => s.sessionId))}`);

  const bridgeList = await (await fetch(`${BASE}/api/sessions`)).json();
  const bridgeHas = (bridgeList.sessions ?? []).some((s) => s.sdkSessionId === sid);
  check('precondition: a LIVE BRIDGE still owns this session (mtime-independent)',
    bridgeHas === true, `bridges: ${JSON.stringify((bridgeList.sessions ?? []).map((s) => s.sdkSessionId))}`);

  console.log('\n=== Tab B: reopen the session — UNION liveness must SUPPRESS the summary ===');
  const tabB = await newPage(devPort);
  await tabB.send('Page.enable');
  await tabB.send('Page.navigate', { url: `${BASE}/#/project/${pid}/session/${sid}?dir=${encodeURIComponent(encoded)}` });
  const HERE = `document.querySelector('#panes .pane.on .you, #panes .pane.on .claude') !== null`;
  await tabB.waitFor('reopened transcript', HERE, 30_000);
  await sleep(2000); // outlast a refreshLive tick — followingLive must SURVIVE it

  // followingLive is the durable, load-bearing signal: it is set ONLY in
  // openSession's `liveRec.drivenByDashboard` branch, so followingLive === true is
  // proof the UNION detected the live BRIDGE (mtime said dead) AND framed the
  // session as reattachable/following — and that the mtime-blind refreshLive
  // teardown did NOT wrongly clear it. (The transient "still running" #fine line
  // is overwritten by a subsequent idle project repaint, so it is not asserted.)
  const bState = await tabB.eval(`({
    ranStacks: document.querySelectorAll('#panes .pane.on .ran-stack').length,
    following: window.__station.state.followingLive,
    say: document.querySelector('#fine')?.textContent ?? '',
  })`);
  check('BRIDGE-IDLE, STALE-FILE session does NOT get the historical agent summary dumped in',
    bState.ranStacks === 0, JSON.stringify(bState));
  check('…and it is reflected as live/following (bridge detected via UNION; survives refreshLive teardown)',
    bState.following === true, JSON.stringify(bState));

  // Evidence: the reopened live (bridge-idle) session showing the streaming tail
  // with NO stray "agents ran" summary.
  try {
    const shot = await tabB.send('Page.captureScreenshot', { format: 'png' });
    const outDir = path.join(ROOT, 'docs', 'bugs', 'assets');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'BUG-004-after.png'), Buffer.from(shot.data, 'base64'));
    console.log(`        screenshot → docs/bugs/assets/BUG-004-after.png`);
  } catch (e) { console.log(`        (screenshot failed: ${e.message})`); }

  tabA.close(); tabB.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

import { spawnSync } from 'node:child_process';
function spawnSyncTouch(file, ...args) {
  const r = spawnSync('touch', [...args, file]);
  if (r.status !== 0) throw new Error(`touch failed: ${r.stderr}`);
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
