/**
 * The "N agents ran in this session" summary must NOT be dumped into the tail
 * of a session that is being written LIVE (dashboard OR external terminal) —
 * it injected a turn-1 sub-agent as if it just finished. A genuinely idle
 * (historical) session with the same recorded agent still SHOWS the summary.
 *
 *   node scripts/verify-agent-summary.mjs      (no live model turn needed)
 *
 * Both fixtures are EXTERNAL (no dashboard bridge, drivenByDashboard:false) —
 * the exact scenario that persisted. "Live" is purely file-mtime recency, so
 * touching the file to now puts it in the live list.
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
const PORT = Number(process.env.VERIFY_AGENTSUM_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-as-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-as-chrome-'));
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

/** Session file + one recorded sub-agent under <store>/<sid>/subagents/. */
function makeSessionWithAgent(store, sid, ageMs) {
  const ts = new Date(Date.now() - ageMs).toISOString();
  const lines = [
    JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', uuid: uid(1), timestamp: ts, sessionId: sid,
      message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] } }),
    JSON.stringify({ parentUuid: uid(1), isSidechain: false, type: 'assistant', uuid: uid(2), timestamp: ts, sessionId: sid,
      message: { role: 'assistant', content: [{ type: 'text', text: 'working on it' }] } }),
  ];
  const f = path.join(store, `${sid}.jsonl`);
  fs.writeFileSync(f, lines.join('\n') + '\n');
  // A recorded sub-agent in the sibling subagents/ dir → listSubagents returns 1.
  const agDir = path.join(store, sid, 'subagents');
  fs.mkdirSync(agDir, { recursive: true });
  fs.writeFileSync(path.join(agDir, 'agent-abc123.jsonl'),
    JSON.stringify({ isSidechain: true, agentId: 'abc123', type: 'assistant', timestamp: ts,
      message: { role: 'assistant', content: [{ type: 'text', text: 'sub-agent output' }], usage: { output_tokens: 5 } } }) + '\n');
  fs.writeFileSync(path.join(agDir, 'agent-abc123.meta.json'),
    JSON.stringify({ agentType: 'general-purpose', description: 'Fix stale example-app permissionMode', toolUseId: 'tu-x' }));
  execFileSync('touch', ['-d', ts, f]);
  return f;
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

  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-as-proj-'));
  cleanupDirs.push(projDir);
  const encoded = projDir.replace(/[/.]/g, '-');
  const store = path.join(os.homedir(), '.claude', 'projects', encoded);
  fs.mkdirSync(store, { recursive: true });
  cleanupDirs.push(store);
  const sidStale = 'aaaaaaaa-1111-4111-8111-111111111111';
  const sidLive = 'bbbbbbbb-2222-4222-8222-222222222222';
  const fileStale = makeSessionWithAgent(store, sidStale, 3600_000); // 1h old — NOT live
  const fileLive = makeSessionWithAgent(store, sidLive, 3600_000);
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: projDir, name: 'agentsum-fixture' }),
  })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  // Sanity: both sessions really report the recorded sub-agent.
  const subs = await (await fetch(`${BASE}/api/sessions/${sidStale}/subagents?dir=${encodeURIComponent(encoded)}`)).json();
  if (!(Array.isArray(subs.subagents) && subs.subagents.length === 1)) throw new Error(`fixture: subagent not reported: ${JSON.stringify(subs).slice(0, 200)}`);

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');

  const openAt = (sid) => cdp.send('Page.navigate', { url: `${BASE}/#/project/${pid}/session/${sid}?dir=${encodeURIComponent(encoded)}` });
  const HERE = `document.querySelector('#panes .pane.on .you, #panes .pane.on .claude') !== null`;

  console.log('\n=== idle/historical session: summary SHOWS ===');
  await openAt(sidStale);
  await cdp.waitFor('stale transcript', HERE, 30_000);
  await sleep(800);
  const staleHasSummary = await cdp.waitFor('summary present',
    `[...document.querySelectorAll('#panes .pane.on .ran-stack')].length > 0`, 8_000);
  check('a genuinely idle session with a recorded agent still shows the "N agents ran" summary',
    staleHasSummary, `ran-stack count: ${await cdp.eval(`document.querySelectorAll('#panes .pane.on .ran-stack').length`)}`);

  console.log('\n=== LIVE (external) session: summary SUPPRESSED ===');
  // Make the live session current in the live list: touch to NOW right before open.
  execFileSync('touch', [fileLive]);
  await openAt(sidLive);
  await cdp.waitFor('live transcript', HERE, 30_000);
  await sleep(1200); // let liveRecordFor + agent handling settle
  const liveState = await cdp.eval(`({
    ranStacks: document.querySelectorAll('#panes .pane.on .ran-stack').length,
    say: document.querySelector('#fine')?.textContent ?? '',
    isLive: (window.__station.state.liveIds instanceof Map) ? [...window.__station.state.liveIds.values()].some(v => v.sessionId === ${JSON.stringify(sidLive)}) : null,
  })`);
  check('a LIVE (external) session does NOT get the historical agent summary dumped in',
    liveState.ranStacks === 0, JSON.stringify(liveState));
  check('…and the follow is framed honestly ("written live by another process")',
    /written live by another process|following/i.test(liveState.say), JSON.stringify(liveState.say));

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
