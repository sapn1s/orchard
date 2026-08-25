/**
 * BUG-072 — a delivery-mode session is OWNED-ENOUGH TO BE VISIBLE: no surface
 * may say "nothing running" while a FEAT-065-delivered turn executes.
 *
 *   node scripts/verify-bug-072-delivery-visible.mjs
 *
 * The captured live failure this reproduces (ticket evidence): the orchestrator
 * session had a survivor whose drain was held by continuous background lanes,
 * so adoption was deferred forever and EVERY user message was delivered into
 * the surviving CLI — while `/api/sessions/<sdk>/running` answered
 * `turn.running:false, rows:[], source:'no-session'`, `/api/sessions/live` said
 * `busy:false`, `/api/health` said `busy:null`, and the strip rendered nothing.
 *
 * Sections:
 *   S1 preconditions — a real broker holding its drain for a declared live
 *      background lane, foreground idle, publishing the boundary + lane facts
 *   S2 N successive sends: EACH delivers (FEAT-065 intact) AND, while that
 *      delivered turn is open, /running shows the main turn + the lane,
 *      /api/sessions/live says busy, /api/health says busy + deliveryActive,
 *      and the ws got a pushed running-snapshot in the same tick as the ack
 *   S3 single-writer + exactly-once: no second `claude --resume` ever existed,
 *      the engine got exactly N user frames, the store has exactly N messages
 *   S4 no false positives: between turns the main row is GONE (the lane stays),
 *      health reports not-busy — the fix reports evidence, not optimism
 *   S5 REAL BROWSER (brave/CDP): the running strip renders the main row while
 *      the delivered turn is open, and drops it when the turn ends
 *   S6 an OLDER broker (no turn-boundary field) reports `unknown`, never
 *      "idle" — ARCH-002: unknown is not coerced
 *   S7 after the background settles the drain commits, the broker reaps, and
 *      the snapshot goes honestly empty (no phantom rows outlive the survivor)
 *
 * SAFETY: free ports, scratch dataDirs, everything killed BY PID; :4317 / the
 * real service / other scopes are never touched.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const HOST_SCRIPT = path.join(ROOT, 'src', 'server', 'session-host.mjs');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b72-work-'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b72-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b72-brave-'));
const BRAVE = process.env.VERIFY_BROWSER ?? 'brave';
const SENDS = Number(process.env.BUG072_SENDS ?? 3);

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  ok ? pass++ : (fail++, failures.push(name));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const readLines = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const getJson = async (port, p) => {
  try { const r = await fetch(`http://127.0.0.1:${port}${p}`); return await r.json(); } catch { return null; }
};

/** Any live process whose cmdline resumes this sdk session = a second claude (BUG-022). */
function secondClaudeFor(sdkId) {
  const hits = [];
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch { return hits; }
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    let cmd = '';
    try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' '); } catch { continue; }
    if (cmd.includes('--resume') && cmd.includes(sdkId)) hits.push({ pid: Number(pid), cmd: cmd.slice(0, 160) });
  }
  return hits;
}

/* -------------------------------------------------------------- fake CLI ---
 * Same shape as FEAT-065's, with ONE addition this ticket needs: a turn whose
 * text contains HOLD stays OPEN (assistant frames, no `result`) until a flag
 * file appears — so every surface can be interrogated WHILE the delivered turn
 * is genuinely mid-flight, which is exactly the state BUG-072 captured.
 * -------------------------------------------------------------------------- */
const FAKE_CLI = path.join(WORK, 'fake-cli.mjs');
fs.writeFileSync(FAKE_CLI, `
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const logIn = (o) => { if (process.env.FAKE_INPUT_LOG) fs.appendFileSync(process.env.FAKE_INPUT_LOG, JSON.stringify(o) + '\\n'); };
const sdkId = process.env.FAKE_SDK_ID || ('fake-sdk-' + process.pid);
const uuid = () => crypto.randomUUID();
let lastUuid = null;
function appendTranscript(entry) {
  const t = process.env.FAKE_TRANSCRIPT;
  if (!t) return;
  fs.appendFileSync(t, JSON.stringify(entry) + '\\n');
}
function writeTurn(userText, replyText) {
  const u = uuid(), a = uuid();
  const now = () => new Date().toISOString();
  appendTranscript({ parentUuid: lastUuid, isSidechain: false, userType: 'external', cwd: process.cwd(),
    sessionId: sdkId, version: '2.1.227', type: 'user',
    message: { role: 'user', content: userText }, uuid: u, timestamp: now() });
  appendTranscript({ parentUuid: u, isSidechain: false, userType: 'external', cwd: process.cwd(),
    sessionId: sdkId, version: '2.1.227', type: 'assistant',
    message: { id: 'msg_' + a.slice(0, 8), type: 'message', role: 'assistant', model: 'fake-survivor',
      content: [{ type: 'text', text: replyText }], stop_reason: 'end_turn' }, uuid: a, timestamp: now() });
  lastUuid = a;
}
say({ type: 'system', subtype: 'init', session_id: sdkId });
say({ type: 'result', subtype: 'success' });
// A declared live background lane => lifetime 'yes' => the drain HOLDS (BUG-044).
say({ type: 'system', subtype: 'background_tasks_changed', tasks: [
  { task_id: process.env.FAKE_TASK_ID || 'bg-b72-lane', task_type: 'local_bash' } ] });
say({ type: 'result', subtype: 'success' });
let held = null; // { userText, releaseFlag }
function finishHeld() {
  if (!held) return;
  const h = held; held = null;
  const reply = 'ECHO:' + h.userText;
  say({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
  writeTurn(h.userText, reply);
  say({ type: 'result', subtype: 'success' });
}
function runTurn(userText) {
  if (userText.includes('HOLD')) {
    // Turn OPEN: frames flow (so the broker publishes midTurn:true) but no result.
    say({ type: 'assistant', message: { content: [{ type: 'text', text: 'working on ' + userText }] } });
    held = { userText };
    return;
  }
  const reply = 'ECHO:' + userText;
  say({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
  writeTurn(userText, reply);
  say({ type: 'result', subtype: 'success' });
}
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { logIn({ raw: line }); continue; }
    logIn(m);
    if (m.type === 'user') {
      const c = m.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b?.text ?? '').join(' ') : '';
      runTurn(text);
    }
  }
});
const iv = setInterval(() => {
  if (held && process.env.FAKE_RELEASE_FLAG && fs.existsSync(process.env.FAKE_RELEASE_FLAG)) {
    try { fs.rmSync(process.env.FAKE_RELEASE_FLAG, { force: true }); } catch {}
    finishHeld();
  }
  if (process.env.FAKE_BG_EMPTY_FLAG && fs.existsSync(process.env.FAKE_BG_EMPTY_FLAG) && !held) {
    try { fs.rmSync(process.env.FAKE_BG_EMPTY_FLAG, { force: true }); } catch {}
    say({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    say({ type: 'result', subtype: 'success' });
  }
}, 150);
iv.unref?.();
process.stdout.on('error', () => {});
process.stdin.on('end', () => { process.exit(0); });
process.stdin.resume();
setInterval(() => {}, 1000);
`);

/* ------------------------------------------------------------ the harness --- */
const brokers = [];
function mkBroker(name, env, dir, key) {
  fs.mkdirSync(dir, { recursive: true });
  const ctl = path.join(dir, `${key}.ctl.json`);
  const statusPath = path.join(dir, `${key}.json`);
  fs.writeFileSync(ctl, JSON.stringify({
    sock: path.join(dir, `${key}.sock`), status: statusPath, errlog: path.join(dir, `${key}.err`),
    command: process.execPath, args: [FAKE_CLI], meta: { stationSessionId: `cs-b72-${name}` },
  }));
  const broker = spawn(process.execPath, [HOST_SCRIPT, ctl], {
    cwd: WORK,
    env: {
      ...process.env,
      CLAUDE_STATION_HOST_ABANDON_MS: '300000',
      CLAUDE_STATION_HOST_DRAIN_TERM_MS: '2000',
      CLAUDE_STATION_HOST_DRAIN_KILL_LAG_MS: '1000',
      CLAUDE_STATION_HOST_DRAIN_RECHECK_MS: '400',
      ...env,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const b = { dir, statusPath, broker, key };
  brokers.push(b);
  return b;
}
function stopBrokerFamily(x) {
  if (!x) return;
  const st = readJson(x.statusPath);
  for (const p of [st?.claudePid, st?.hostPid, x.broker?.pid]) {
    if (p && pidAlive(p)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  }
  for (const ext of ['.json', '.sock', '.err', '.ctl.json']) {
    try { fs.rmSync(path.join(x.dir, `${x.key}${ext}`), { force: true }); } catch { /* ignore */ }
  }
}

let server1 = null, server2 = null, browser = null;
function spawnServer(port, extraEnv = {}) {
  const s = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA,
      CLAUDE_STATION_SURVIVE: '0', // the only brokers in hostsDir must be ours
      ...extraEnv,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  s.stderr?.on('data', () => { /* quiet */ });
  return s;
}
async function waitHealth(port, ms = 40_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* not up */ }
    await sleep(250);
  }
  return false;
}
function openWs(port) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const events = [];
    ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
    ws.once('open', () => res({ ws, events, send: (o) => ws.send(JSON.stringify(o)) }));
    ws.once('error', rej);
  });
}
const waitEv = async (events, pred, ms = 30_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = events.find(pred);
    if (hit) return hit;
    await sleep(150);
  }
  return null;
};
function findTranscript(sdkId) {
  const base = path.join(os.homedir(), '.claude', 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(base); } catch { return null; }
  for (const d of dirs) {
    const p = path.join(base, d, `${sdkId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
const transcriptUserLines = (p, marker) => readLines(p)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((e) => e?.type === 'user' && JSON.stringify(e.message?.content ?? '').includes(marker));

/* --------------------------------------------------------------- raw CDP --- */
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
const READ_UI = () => ({
  rows: [...document.querySelectorAll('#stripRows .lag')].map((r) => ({
    key: r.dataset.thread,
    ty: r.querySelector('.ty')?.textContent ?? '',
    gl: r.querySelector('.gl')?.textContent ?? '',
    run: r.classList.contains('run'),
  })),
  hidden: document.querySelector('#strip')?.hidden === true,
  sum: document.querySelector('#stripSum')?.textContent ?? '',
});

/* ------------------------------------------------------------------ setup --- */
let projectId = null, sdkSessionId = null, transcriptPath = null, port2 = null;
let survivor = null;
const RELEASE_FLAG = path.join(WORK, 'release.flag');
const BG_EMPTY_FLAG = path.join(WORK, 'bg-empty.flag');
const INPUT_LOG = path.join(WORK, 'engine-input.log');

async function setup() {
  console.log('\n=== SETUP: real seed session, restart-shaped server 2, background-holding survivor ===');
  const port1 = await freePort();
  server1 = spawnServer(port1);
  if (!(await waitHealth(port1))) throw new Error('server 1 never became healthy');
  const reg = await (await fetch(`http://127.0.0.1:${port1}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: WORK, name: 'bug072-visible' }),
  })).json();
  projectId = reg.project?.id;
  if (!projectId) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  await fetch(`http://127.0.0.1:${port1}/api/projects/${encodeURIComponent(projectId)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { permissionMode: 'bypassPermissions', model: 'haiku' } }),
  });
  const c0 = await openWs(port1);
  c0.send({ type: 'start', projectId, prompt: 'Reply with exactly: SEED-OK' });
  const init = await waitEv(c0.events, (e) => e.t === 'session-init', 90_000);
  if (!init?.sessionId) throw new Error('seed turn never started');
  sdkSessionId = init.sessionId;
  await waitEv(c0.events, (e) => e.t === 'turn-end', 90_000);
  c0.send({ type: 'close' });
  try { c0.ws.close(); } catch { /* ignore */ }
  await sleep(500);
  try { process.kill(server1.pid, 'SIGKILL'); } catch { /* ignore */ }
  await sleep(500);
  transcriptPath = findTranscript(sdkSessionId);
  if (!transcriptPath) throw new Error('seed transcript not found on disk');

  // The survivor: a REAL broker declaring the seed session's sdk id, holding
  // its drain for a declared live background lane (the BUG-044 hold), planted
  // in the fresh server's hostsDir and SIGTERM'd exactly as boot's re-adopt does.
  const hostsDir = path.join(DATA, 'session-hosts');
  survivor = mkBroker('s1', {
    FAKE_SDK_ID: sdkSessionId, FAKE_TRANSCRIPT: transcriptPath, FAKE_INPUT_LOG: INPUT_LOG,
    FAKE_TASK_ID: 'bg-b72-lane', FAKE_RELEASE_FLAG: RELEASE_FLAG, FAKE_BG_EMPTY_FLAG: BG_EMPTY_FLAG,
  }, hostsDir, 'h-b72-s1');
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    const st = readJson(survivor.statusPath);
    if (st?.sdkSessionId === sdkSessionId) ready = true; else await sleep(200);
  }
  if (!ready) throw new Error('planted broker never recorded the sdk session id');
  try { process.kill(survivor.broker.pid, 'SIGTERM'); } catch { /* gone */ }
  let holding = false;
  for (let i = 0; i < 50 && !holding; i++) {
    const st = readJson(survivor.statusPath);
    if (st?.state === 'draining') holding = true; else await sleep(200);
  }
  if (!holding) throw new Error('planted broker never reached the held drain');

  port2 = await freePort();
  server2 = spawnServer(port2);
  if (!(await waitHealth(port2))) throw new Error('server 2 never became healthy');
  console.log(`  seed sdkSessionId=${sdkSessionId}\n  transcript=${transcriptPath}\n  port2=${port2}`);
}

/* ------------------------------------------------- S1 — the captured state --- */
async function s1Preconditions() {
  console.log('\n=== S1: the survivor is holding, foreground idle, and this server owns NO bridge ===');
  const st = readJson(survivor.statusPath);
  check('S1 the broker holds its drain for a DECLARED live background lane, foreground idle',
    st?.state === 'draining' && st?.backgroundLive === 1 && st?.backgroundLifetime === 'yes' && st?.midTurn === false,
    { state: st?.state, backgroundLive: st?.backgroundLive, lifetime: st?.backgroundLifetime, midTurn: st?.midTurn });
  check('S1 (fails pre-fix): the heartbeat carries the LANE facts the strip needs (id + engine task_type + first-seen stamp)',
    Array.isArray(st?.backgroundTasks) && st.backgroundTasks.length === 1
      && st.backgroundTasks[0].id === 'bg-b72-lane' && st.backgroundTasks[0].type === 'local_bash'
      && !!st.backgroundTasks[0].since,
    { backgroundTasks: st?.backgroundTasks ?? '(absent)' });
  const h = await getJson(port2, '/api/health');
  const row = (h?.sessions ?? []).find((s) => s.sdkSessionId === sdkSessionId);
  check('S1 the session is surviving-unadopted with NO live bridge (the state BUG-072 was captured in)',
    h?.liveBridges === 0 && row?.adopted === false && row?.state === 'surviving-unadopted',
    { liveBridges: h?.liveBridges, adopted: row?.adopted, state: row?.state });
}

/* ------------------------------------- S2 — N sends, each delivered + visible --- */
const acks = [];
async function s2Deliveries() {
  console.log(`\n=== S2: ${SENDS} successive sends — each DELIVERS and each is VISIBLE while it runs ===`);
  for (let i = 1; i <= SENDS; i++) {
    const MARKER = `BUG-072-HOLD-${i}`;
    const c = await openWs(port2);
    const t0 = Date.now();
    c.send({ type: 'start', projectId, prompt: `deliver me: ${MARKER}`, resumeSessionId: sdkSessionId });
    const ack = await waitEv(c.events, (e) => e.t === 'ack' && e.of === 'start', 20_000);
    acks.push(ack);
    check(`S2.${i} the start is ACKED deliveredVia:survivor (FEAT-065 intact — delivery still happens)`,
      ack?.deliveredVia === 'survivor',
      { ack: ack ?? c.events.find((e) => e.t === 'error')?.message?.slice(0, 120) ?? '(nothing)', ms: Date.now() - t0 });

    // The turn is now OPEN inside the survivor (the fake CLI withholds `result`
    // until the release flag) — this is the exact window BUG-072 captured.
    const push = await waitEv(c.events, (e) => e.t === 'running-snapshot', 8000);
    check(`S2.${i} (fails pre-fix): the ws is PUSHED a running snapshot in the same tick as the ack — main row present`,
      !!push && push.snapshot?.turn?.running === true
        && (push.snapshot?.running ?? []).some((r) => r.id === 'main' && r.row === 'main'),
      { turn: push?.snapshot?.turn ?? '(no push)', rows: (push?.snapshot?.running ?? []).map((r) => r.id) });

    let snap = null;
    const t1 = Date.now();
    while (Date.now() - t1 < 10_000) {
      snap = (await getJson(port2, `/api/sessions/${encodeURIComponent(sdkSessionId)}/running`))?.snapshot ?? null;
      if (snap?.turn?.running) break;
      await sleep(200);
    }
    const ids = (snap?.running ?? []).map((r) => r.id);
    check(`S2.${i} (LOAD-BEARING, fails pre-fix): /running shows the MAIN TURN while the delivered turn executes`,
      snap?.turn?.running === true && ids.includes('main') && snap?.source === 'survivor',
      { turn: snap?.turn ?? '(none)', rows: ids, source: snap?.source });
    const mainRow = (snap?.running ?? []).find((r) => r.id === 'main');
    check(`S2.${i} the main row carries an HONEST server-side start (no fabricated stopwatch)`,
      typeof mainRow?.startedAt === 'number' && mainRow.startedAt > 0 && mainRow.startedAt <= Date.now(),
      { startedAt: mainRow?.startedAt ?? null });
    check(`S2.${i} (fails pre-fix): the background LANE is a row too, labelled by the engine's own task_type`,
      (snap?.running ?? []).some((r) => r.id === 'bg-b72-lane' && r.label === 'local_bash' && r.row === 'tool'),
      { rows: (snap?.running ?? []).map((r) => ({ id: r.id, label: r.label, row: r.row })) });

    const liveRows = (await getJson(port2, '/api/sessions/live'))?.sessions ?? [];
    const lr = liveRows.find((s) => s.sessionId === sdkSessionId);
    check(`S2.${i} (fails pre-fix): /api/sessions/live reports the session BUSY (it said busy:false in the incident)`,
      lr?.busy === true && lr?.survivingUnadopted === true && lr?.liveness?.live === true,
      { row: lr ? { busy: lr.busy, survivingUnadopted: lr.survivingUnadopted, live: lr.liveness?.live } : '(absent)' });

    const h = await getJson(port2, '/api/health');
    const hr = (h?.sessions ?? []).find((s) => s.sdkSessionId === sdkSessionId);
    check(`S2.${i} (fails pre-fix): /api/health reports busy + an ACTIVE delivery relay (it said busy:null)`,
      hr?.busy === true && hr?.deliveryActive === true && hr?.work?.turnRunning === true && (hr?.work?.lanes ?? []).length === 1,
      { busy: hr?.busy ?? null, deliveryActive: hr?.deliveryActive ?? null, work: hr?.work ?? '(absent)' });
    check(`S2.${i} /api/health keeps its honest lifecycle label (no fake adoption claimed)`,
      hr?.state === 'surviving-unadopted' && hr?.adopted === false,
      { state: hr?.state, adopted: hr?.adopted });

    // Release the held turn: it completes normally in the SAME CLI.
    fs.writeFileSync(RELEASE_FLAG, '1');
    let landed = false;
    const t2 = Date.now();
    while (Date.now() - t2 < 15_000) {
      if (transcriptUserLines(transcriptPath, MARKER).length > 0
        && readLines(transcriptPath).some((l) => l.includes('ECHO:') && l.includes(MARKER))) { landed = true; break; }
      await sleep(200);
    }
    const stAfter = readJson(survivor.statusPath);
    check(`S2.${i} the delivered turn really ran in the survivor: message + reply in the transcript, drain STILL held`,
      landed && stAfter?.state === 'draining' && stAfter?.backgroundLive === 1,
      { landed, brokerState: stAfter?.state ?? 'gone', backgroundLive: stAfter?.backgroundLive });
    c.send({ type: 'close' });
    try { c.ws.close(); } catch { /* ignore */ }
    await sleep(400);
  }
}

/* -------------------------------------------- S3 — the invariants that matter --- */
async function s3SingleWriter() {
  console.log('\n=== S3: single writer + exactly-once (the invariants this fix may not relax) ===');
  check('S3 no second `claude --resume` for this session has EVER existed (BUG-022 invariant)',
    secondClaudeFor(sdkSessionId).length === 0, secondClaudeFor(sdkSessionId));
  const frames = readLines(INPUT_LOG).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((m) => m?.type === 'user' && JSON.stringify(m).includes('BUG-072-HOLD-'));
  check(`S3 the ENGINE received exactly ${SENDS} user frames — one per send, on the survivor's own stdin`,
    frames.length === SENDS, { engineUserFrames: frames.length });
  const stored = readLines(transcriptPath)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e?.type === 'user' && JSON.stringify(e.message?.content ?? '').includes('BUG-072-HOLD-'));
  check(`S3 the on-disk store has exactly ${SENDS} delivered user messages (no doubles)`,
    stored.length === SENDS, { storedUserMessages: stored.length });
  check('S3 every send was acked deliveredVia:survivor — adoption was deferred, and that is what made visibility mandatory',
    acks.length === SENDS && acks.every((a) => a?.deliveredVia === 'survivor'),
    acks.map((a) => a?.deliveredVia ?? '(none)'));
}

/* ------------------------------------------------ S4 — no false positives --- */
async function s4Idle() {
  console.log('\n=== S4: between turns the main row is GONE — evidence, not optimism ===');
  let snap = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 10_000) {
    snap = (await getJson(port2, `/api/sessions/${encodeURIComponent(sdkSessionId)}/running`))?.snapshot ?? null;
    if (snap && snap.turn?.running === false) break;
    await sleep(250);
  }
  const ids = (snap?.running ?? []).map((r) => r.id);
  check('S4 with no turn in flight the snapshot claims NO main row (the fix reports the broker\'s truth, not a constant)',
    snap?.turn?.running === false && !ids.includes('main'), { turn: snap?.turn, rows: ids });
  check('S4 …but the live background LANE is still reported (it is genuinely running — BUG-041: no false deaths)',
    ids.includes('bg-b72-lane'), { rows: ids });
  const h = await getJson(port2, '/api/health');
  const hr = (h?.sessions ?? []).find((s) => s.sdkSessionId === sdkSessionId);
  check('S4 /api/health agrees (busy:false, no delivery relay in flight) — one authority, no disagreement',
    hr?.busy === false && hr?.deliveryActive === false, { busy: hr?.busy, deliveryActive: hr?.deliveryActive });
}

/* --------------------------------------------------- S5 — the real browser --- */
async function s5Browser() {
  console.log('\n=== S5: REAL BROWSER — the running strip renders the delivered turn ===');
  browser = spawn(BRAVE, [
    '--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--window-size=1280,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 80 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  if (!devPort) throw new Error('browser never wrote DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  const encoded = WORK.replace(/[/.]/g, '-');
  const BASE = `http://127.0.0.1:${port2}`;
  await cdp.send('Page.navigate', {
    url: `${BASE}/#/project/${encodeURIComponent(projectId)}/session/${sdkSessionId}?dir=${encodeURIComponent(encoded)}`,
  });
  const booted = await cdp.waitFor('boot', 'window.__station !== undefined', 60_000);
  const opened = await cdp.waitFor('session open',
    `window.__station.state.current.sessionId === ${JSON.stringify(sdkSessionId)}`, 30_000);
  check('S5 SETUP: the dashboard opened the surviving session', booted && opened, { booted, opened });

  // Deliver one more message — the turn stays open while we look at the strip.
  const MARKER = 'BUG-072-HOLD-UI';
  const c = await openWs(port2);
  c.send({ type: 'start', projectId, prompt: `deliver me: ${MARKER}`, resumeSessionId: sdkSessionId });
  const ack = await waitEv(c.events, (e) => e.t === 'ack' && e.of === 'start', 20_000);
  check('S5 the UI-run message was delivered into the survivor', ack?.deliveredVia === 'survivor', { ack: ack ?? '(none)' });
  await cdp.eval('window.__station.pollRunning()');
  const sawMain = await cdp.waitFor('main row in the strip',
    "document.querySelector('#stripRows button.lag.main.run') !== null", 20_000);
  const ui = await cdp.eval(`(${READ_UI.toString()})()`);
  check('S5 (LOAD-BEARING, fails pre-fix): the STRIP renders the running main row while the delivered turn executes',
    sawMain && ui.hidden === false && ui.rows.some((r) => r.key === 'main' && r.ty === 'main' && r.run), ui);
  check('S5 the strip also renders the background lane row',
    ui.rows.some((r) => r.key === 'bg-b72-lane'), ui.rows.map((r) => r.key));

  fs.writeFileSync(RELEASE_FLAG, '1');
  const t0 = Date.now();
  let gone = false;
  while (Date.now() - t0 < 20_000) {
    await cdp.eval('window.__station.pollRunning()');
    const u = await cdp.eval(`(${READ_UI.toString()})()`);
    if (!u.rows.some((r) => r.key === 'main')) { gone = true; break; }
    await sleep(500);
  }
  check('S5 when the delivered turn ends the main row LEAVES the strip (no phantom row)', gone, { gone });
  c.send({ type: 'close' });
  try { c.ws.close(); } catch { /* ignore */ }
  cdp.close();
}

/* ---------------------------------------- S6 — an older broker: unknown, not idle --- */
async function s6UnknownNotCoerced() {
  console.log('\n=== S6: a PRE-FEAT-065 broker publishes no boundaries — unknown is not coerced to idle ===');
  const holder = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const hostsDir = path.join(DATA, 'session-hosts');
  const key = 'h-b72-old';
  const statusPath = path.join(hostsDir, `${key}.json`);
  const fakeSdk = `b72-old-${Date.now()}`;
  fs.writeFileSync(statusPath, JSON.stringify({
    hostPid: holder.pid, claudePid: holder.pid, sock: path.join(hostsDir, `${key}.sock`), status: statusPath,
    stationSessionId: 'cs-b72-old', sdkSessionId: fakeSdk, state: 'draining', exitCode: null, signal: null,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    // deliberately NO midTurn / backgroundTasks — an older broker's file
  }));
  const snap = (await getJson(port2, `/api/sessions/${encodeURIComponent(fakeSdk)}/running`))?.snapshot ?? null;
  check('S6 an older broker yields NO fabricated main row (nothing is claimed that was never declared)',
    snap?.turn?.running === false && !(snap?.running ?? []).some((r) => r.id === 'main'),
    { turn: snap?.turn, rows: (snap?.running ?? []).map((r) => r.id) });
  check('S6 …and it is reported as UNKNOWN, never as "idle" (ARCH-002: unknown is never coerced)',
    /unknown/i.test(snap?.turn?.reason ?? ''), { reason: snap?.turn?.reason });
  const h = await getJson(port2, '/api/health');
  const hr = (h?.sessions ?? []).find((s) => s.sdkSessionId === fakeSdk);
  check('S6 /api/health carries the same unknown (busy:null), not a false negative',
    hr?.busy === null && hr?.work?.turnRunning === null, { busy: hr?.busy ?? '(absent)', work: hr?.work ?? '(absent)' });
  try { process.kill(holder.pid, 'SIGKILL'); } catch { /* gone */ }
  try { fs.rmSync(statusPath, { force: true }); } catch { /* ignore */ }
}

/* --------------------------------- S7 — the drain still commits and reaps --- */
async function s7Reap() {
  console.log('\n=== S7: the background settles → the drain commits → nothing phantom survives ===');
  fs.writeFileSync(BG_EMPTY_FLAG, '1');
  let reaped = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 25_000) {
    if (!fs.existsSync(survivor.statusPath)) { reaped = true; break; }
    await sleep(250);
  }
  check('S7 the drain committed and the broker reaped cleanly (BUG-044 lifecycle unchanged by this fix)',
    reaped, { reaped, statusFileGone: !fs.existsSync(survivor.statusPath) });
  const snap = (await getJson(port2, `/api/sessions/${encodeURIComponent(sdkSessionId)}/running`))?.snapshot ?? null;
  check('S7 with the survivor gone the snapshot is honestly EMPTY again (source no-session)',
    snap?.source === 'no-session' && (snap?.running ?? []).length === 0 && snap?.turn?.running === false,
    { source: snap?.source, rows: (snap?.running ?? []).length });
}

/* -------------------------------------------------------------------- main --- */
async function main() {
  await setup();
  await s1Preconditions();
  await s2Deliveries();
  await s3SingleWriter();
  await s4Idle();
  await s5Browser();
  await s6UnknownNotCoerced();
  await s7Reap();
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  fail += 1;
  failures.push(`FATAL: ${err.message}`);
}).finally(async () => {
  for (const b of brokers) stopBrokerFamily(b);
  for (const p of [browser, server1, server2]) {
    if (p?.pid && pidAlive(p.pid)) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }
  }
  await sleep(500);
  for (const d of [WORK, DATA, PROFILE]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (failures.length) console.log(`FAILED:\n  - ${failures.join('\n  - ')}`);
  process.exit(fail ? 1 : 0);
});
