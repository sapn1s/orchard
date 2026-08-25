/**
 * FEAT-037 P2b — Orchard-owned transcript capture for engines with
 * `capabilities.persistedTranscript:false` (Codex). Non-vacuous (§C): every
 * layer is the real code — the REAL server + bridge + CodexRuntime speaking
 * JSON-RPC to the protocol-VALIDATING fake app-server (spawn seam
 * CLAUDE_STATION_CODEX_BIN), plus the real UI over brave headless CDP.
 *
 *  A. CAPTURE — a codex session driven through the real websocket writes
 *     dataDir()/transcripts/openai/<encodedDir>/<threadId>.jsonl: entries are
 *     valid Claude-store shapes (user prompt + assistant reply), every line
 *     carries uuid/timestamp/sessionId/provider, and a second turn APPENDS
 *     (old bytes are a strict prefix — append-only proven, not asserted).
 *  B. HISTORY SERVES — the same /api/transcript tail route that serves the
 *     Claude store serves the Orchard file (200, both roles render); the
 *     project sessions route lists the codex session with provider 'openai';
 *     /api/sessions/live saw it while it was being written.
 *  C. RESUME — with CODEX_FAKE_EXPECT_RESUME pinned to the first session's
 *     thread id, reopening via the websocket MUST hit thread/resume with that
 *     exact id on the wire (anything else = fake violation = transport death
 *     = fatal error the checks would see). The resumed turn appends to the
 *     SAME file; the directory still holds exactly one file.
 *  D. UI — reopening the session from the real sidebar renders the recorded
 *     history (fixture reply text visible), the row carries the quiet `codex`
 *     engine tag, and sending from the reopened view resumes the same thread
 *     id end-to-end through the composer path.
 *
 * MUST-FAIL pre-change: run against a HEAD worktree via P2B_SERVER_ROOT — no
 * transcript file is written, the transcript route 404s, the sessions list is
 * empty and resume is refused by explainUnresumable.
 *
 * Never touches :4317; scratch ports; kills by pid; installs nothing.
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

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_ROOT = process.env.P2B_SERVER_ROOT ? path.resolve(process.env.P2B_SERVER_ROOT) : ROOT;
const FAKE = path.join(SERVER_ROOT, 'scripts', 'fixtures', 'codex-fake-app-server.mjs');
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';
const SHOT = path.join(ROOT, 'docs', 'bugs', 'assets');
const THREAD_ID = 'thr_fixture_0001'; // what the fake's thread/start mints

let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const children = [];
const cleanupDirs = [];
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

async function startServer(extraEnv = {}) {
  const port = await freePort();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-p2b-data-'));
  cleanupDirs.push(data);
  const child = spawn(process.execPath, [path.join(SERVER_ROOT, 'src', 'server', 'index.ts')], {
    cwd: SERVER_ROOT,
    env: { ...process.env, PORT: String(port), CLAUDE_STATION_DATA: data, ...extraEnv },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (d) => process.stderr.write(`  [server:${port}!] ${d}`));
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${base}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error(`server on ${port} never became healthy`);
  return { child, base, port, data };
}

async function registerProject(base, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cs-p2b-${name}-`));
  cleanupDirs.push(dir);
  cleanupDirs.push(path.join(os.homedir(), '.claude', 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-')));
  const r = await (await fetch(`${base}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: dir, name }),
  })).json();
  if (!r.project?.id) throw new Error(`register failed: ${JSON.stringify(r)}`);
  return { project: r.project, dir, enc: dir.replace(/[^a-zA-Z0-9]/g, '-') };
}

/** Drive one websocket session; resolves handles for inspection. */
function openWs(base) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
  const events = [];
  ws.on('message', (d) => { try { events.push(JSON.parse(String(d))); } catch { /* noise */ } });
  const until = async (pred, timeoutMs = 20_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const hit = events.find(pred);
      if (hit) return hit;
      await sleep(100);
    }
    return null;
  };
  return new Promise((res, rej) => {
    ws.once('open', () => res({ ws, events, until, send: (o) => ws.send(JSON.stringify(o)) }));
    ws.once('error', rej);
  });
}

/* -------------------------------------------------------- CDP plumbing */
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
  async shot(file) {
    try {
      const r = await this.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOT, file), Buffer.from(r.data, 'base64'));
      console.log(`        (screenshot ${file})`);
    } catch { /* best effort */ }
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

async function startBrowser() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-p2b-chrome-'));
  cleanupDirs.push(profile);
  const b = spawn(BRAVE, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(b);
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  return cdp;
}

/* ================================ main ================================ */

async function main() {
  console.log('\n=== A. capture: a codex session writes an Orchard-owned transcript ===');
  const srv = await startServer({
    CLAUDE_STATION_CODEX_BIN: FAKE,
    // Pins the ONE legal thread/resume target — the wire assertion for C.
    CODEX_FAKE_EXPECT_RESUME: THREAD_ID,
  });
  const { project, enc } = await registerProject(srv.base, 'orchard');
  await fetch(`${srv.base}/api/projects/${project.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'openai' }),
  });

  const tFile = path.join(srv.data, 'transcripts', 'openai', enc, `${THREAD_ID}.jsonl`);

  const s1 = await openWs(srv.base);
  s1.send({ type: 'start', projectId: project.id, prompt: 'hello orchard capture' });
  const init1 = await s1.until((e) => e.t === 'session-init');
  const end1 = await s1.until((e) => e.t === 'turn-end');
  check('session started against the fake app-server (session-init carries the thread id) and the turn ended',
    init1?.sessionId === THREAD_ID && !!end1, { init: init1?.sessionId, end: end1?.subtype });

  const exists1 = fs.existsSync(tFile);
  check('the Orchard transcript file exists at dataDir()/transcripts/openai/<encodedDir>/<threadId>.jsonl',
    exists1, tFile.replace(srv.data, '<data>'));

  let lines = [];
  if (exists1) lines = fs.readFileSync(tFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const shapesOk = lines.length >= 2 && lines.every((e) =>
    (e.type === 'user' || e.type === 'assistant')
    && typeof e.uuid === 'string' && typeof e.timestamp === 'string'
    && e.sessionId === THREAD_ID && e.provider === 'openai'
    && Array.isArray(e.message?.content));
  check('every entry is a valid Claude-store shape (type user|assistant, uuid/timestamp/sessionId/provider, content blocks)',
    shapesOk, { lines: lines.length, first: lines[0]?.type, roles: lines.map((e) => e.type).join(',') });
  check('entry 0 is the USER prompt (recorded at the send seam — the engine never echoes it)',
    lines[0]?.type === 'user' && /hello orchard capture/.test(JSON.stringify(lines[0]?.message)),
    JSON.stringify(lines[0]?.message ?? null).slice(0, 120));
  check('the assistant reply frame was captured',
    lines.some((e) => e.type === 'assistant' && /Hello from fixture Codex\./.test(JSON.stringify(e.message))),
    lines.filter((e) => e.type === 'assistant').length + ' assistant entries');

  // liveness while being written (mtime window) + driven by this dashboard
  const liveNow = await (await fetch(`${srv.base}/api/sessions/live`)).json();
  const liveRow = (liveNow.sessions ?? []).find((s) => s.sessionId === THREAD_ID);
  check('B: /api/sessions/live sees the Orchard file being written (drivenByDashboard true)',
    !!liveRow && liveRow.drivenByDashboard === true, liveRow ?? '(absent)');

  // append-only across a second turn
  const before = fs.existsSync(tFile) ? fs.readFileSync(tFile, 'utf8') : '';
  s1.send({ type: 'send', prompt: 'second turn please' });
  await s1.until((e) => e.t === 'turn-end' && s1.events.filter((x) => x.t === 'turn-end').length >= 2);
  const after = fs.existsSync(tFile) ? fs.readFileSync(tFile, 'utf8') : '';
  check('append-only: after a second turn the old bytes are a STRICT PREFIX of the file (nothing rewritten)',
    after.length > before.length && after.startsWith(before) && /second turn please/.test(after),
    { beforeBytes: before.length, afterBytes: after.length });

  console.log('\n=== B. history serves through the UNCHANGED transcript/session routes ===');
  const tr = await fetch(`${srv.base}/api/transcript/${enc}/${THREAD_ID}?tail=50`);
  const tj = tr.status === 200 ? await tr.json() : null;
  const roles = (tj?.messages ?? []).map((m) => m.role);
  check('GET /api/transcript/<enc>/<threadId>?tail — the SAME route that serves Claude sessions serves the Orchard file',
    tr.status === 200 && roles.includes('user') && roles.includes('assistant')
      && (tj.messages ?? []).some((m) => (m.blocks ?? []).some((b) => /Hello from fixture Codex\./.test(String(b.text ?? '')))),
    { status: tr.status, total: tj?.total, roles: roles.join(',') });

  const sess = await (await fetch(`${srv.base}/api/projects/${project.id}/sessions`)).json();
  const row = (sess.sessions ?? []).find((s) => s.sessionId === THREAD_ID);
  check('the project session list includes the codex session, provider-tagged, titled from the first prompt',
    !!row && row.provider === 'openai' && /hello orchard capture/.test(String(row.displayTitle)),
    row ? { provider: row.provider, title: row.displayTitle, messages: row.messageCount } : '(absent)');

  // close the idle session (socket close → bridge close) so resume is a REAL reopen
  s1.ws.close();
  let closed = false;
  for (let i = 0; i < 50 && !closed; i++) {
    const l = await (await fetch(`${srv.base}/api/sessions`)).json();
    closed = (l.sessions ?? []).length === 0;
    if (!closed) await sleep(200);
  }
  check('closing the tab closes the idle bridge session (resume below is a REAL reopen, not a reattach)', closed, { closed });

  console.log('\n=== C. resume: reopening MUST hit thread/resume with the SAME thread id on the wire ===');
  const s2 = await openWs(srv.base);
  s2.send({ type: 'start', projectId: project.id, prompt: 'resumed turn', resumeSessionId: THREAD_ID, resumeEncodedDir: enc });
  const init2 = await s2.until((e) => e.t === 'session-init');
  const end2 = await s2.until((e) => e.t === 'turn-end');
  const fatal2 = s2.events.find((e) => e.t === 'error' && e.fatal === true);
  // CODEX_FAKE_EXPECT_RESUME makes any OTHER id (or a fresh thread/start
  // pretending to resume) a protocol VIOLATION → fake exits 1 → transport
  // death → fatal error → these checks fail. A completed resumed turn IS the
  // wire proof.
  check('the reopened session resumed the SAME thread (init echoes the id; the validating fake allowed exactly this id)',
    init2?.sessionId === THREAD_ID && !!end2 && !fatal2,
    { init: init2?.sessionId, end: end2?.subtype, fatal: fatal2?.message ?? null });
  const after2 = fs.existsSync(tFile) ? fs.readFileSync(tFile, 'utf8') : '';
  const dirFiles = fs.existsSync(path.dirname(tFile)) ? fs.readdirSync(path.dirname(tFile)) : [];
  check('the resumed turn APPENDED to the same file — one file per thread, before-bytes still a strict prefix',
    after2.startsWith(after) && /resumed turn/.test(after2) && dirFiles.length === 1,
    { files: dirFiles, bytes: after2.length });
  s2.ws.close();
  for (let i = 0; i < 50; i++) {
    const l = await (await fetch(`${srv.base}/api/sessions`)).json();
    if ((l.sessions ?? []).length === 0) break;
    await sleep(200);
  }

  console.log('\n=== D. UI: the sidebar reopens the codex session — history renders, resume flows through the composer ===');
  const cdp = await startBrowser();
  await cdp.send('Page.navigate', { url: `${srv.base}/#/project/${project.id}` });
  await cdp.waitFor('boot', 'window.__station !== undefined');
  const rowUi = await cdp.waitFor('codex session row with engine tag',
    `document.querySelector('.row[data-provider="openai"] .prov-tag')?.textContent === 'codex'`, 15_000);
  check('the session list row is UN-GATED: visible, provider-tagged with the quiet `codex` chip', rowUi, { rowUi });
  await cdp.eval(`document.querySelector('.row[data-provider="openai"]')?.click()`);
  const histUi = await cdp.waitFor('recorded history renders',
    `[...document.querySelectorAll('#panes .claude .body')].some((n) => n.textContent.includes('Hello from fixture Codex.'))`, 20_000);
  const userUi = await cdp.eval(`[...document.querySelectorAll('#panes .msg, #panes .user, #panes .you')].some((n) => n.textContent.includes('hello orchard capture'))
    || [...document.querySelectorAll('#panes *')].some((n) => n.children.length === 0 && n.textContent.trim() === 'hello orchard capture')`);
  check('reopening renders the recorded transcript exactly like a Claude session (assistant + user turns visible)',
    histUi && userUi, { histUi, userUi });
  await cdp.shot('FEAT-037-P2b-fixture-history.png');

  await cdp.eval(`(() => {
    document.querySelector('#prompt').value = 'ui resumed turn';
    document.querySelector('#go').click();
  })()`);
  const uiResumed = await cdp.waitFor('composer resume completes',
    `window.__station.state.busy === false && window.__station.state.sdkSessionId === ${JSON.stringify(THREAD_ID)}
      && [...document.querySelectorAll('#panes .claude .body')].filter((n) => n.textContent.includes('Hello from fixture Codex.')).length >= 2`, 30_000);
  const after3 = fs.readFileSync(tFile, 'utf8');
  check('sending from the reopened view resumes the same thread END-TO-END (composer → bridge → thread/resume) and appends',
    uiResumed && /ui resumed turn/.test(after3) && after3.startsWith(after2), { uiResumed, bytes: after3.length });
  cdp.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exitCode = 1;
}).finally(() => {
  for (const c of children) stopByPid(c);
  setTimeout(() => {
    for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
    process.exit(process.exitCode ?? 1);
  }, 2500);
});
