/**
 * FEAT-065 — queued messages DELIVER into the drain-held survivor.
 *
 *   node scripts/verify-feat-065-delivery.mjs
 *
 * The real-shape bar (ticket): restart with a foreground-idle + live-background
 * survivor → send → the message reaches the model WITHOUT waiting for the
 * background completion — one SDK stream-json user frame into the SAME CLI pid
 * (no second claude spawned), reply visible, background completes, EXACTLY ONE
 * delivery (client DOM + on-disk store + engine input log), permission-raising
 * injected turns BOTH round-trip an approval AND take the bounded deny
 * fallback, and unknown-lifetime / mid-foreground-drain survivors keep today's
 * queue-and-wait. PRE-FIX every delivery check FAILS: the message waits the
 * whole drain.
 *
 * Sections:
 *   S1 raw-WS delivery E2E (ack deliveredVia within the 15s window, engine
 *      input exactly-once, transcript grows WHILE the drain is held, no
 *      `claude --resume` ever spawned, turn-done notice, clean reap after the
 *      background empties)
 *   S2 permission arm A — approval-request relayed to the ws, answered allow,
 *      control_response reaches the CLI, turn completes APPROVED
 *   S3 permission arm B — nobody answers; the BOUNDED deny lands (knob'd 3s),
 *      turn completes DENIED, drain not wedged
 *   S4 mid-FOREGROUND-drain survivor (midTurn true) → queue-and-wait refusal,
 *      nothing injected
 *   S5 real app.js (happy-dom) + the BUG-045 loop: unknown lifetime → refusal
 *      + chip + NOTHING injected (ARCH-002 honored); level frame lands →
 *      the client's own retry start gets delivered — chip retires, DOM shows
 *      the message exactly once + the reply LIVE via the transcript follow
 *
 * SAFETY: free ports, scratch dataDirs, everything killed BY PID; :4317 / the
 * real service / other scopes are never touched.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Window } from 'happy-dom';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const HOST_SCRIPT = path.join(ROOT, 'src', 'server', 'session-host.mjs');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f65-work-'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f65-data-'));

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

/** Any live process whose cmdline resumes this sdk session = a second claude. */
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
 * Speaks enough stream-json for the broker's sniffer AND for FEAT-065's
 * delivery: it logs every stdin line (FAKE_INPUT_LOG — the engine-input
 * exactly-once proof), runs a fake turn for every injected user frame
 * (appending the user message + a reply to the REAL transcript file, like the
 * real CLI does — single writer: only this pid), raises a can_use_tool
 * control_request when the prompt says NEEDS-APPROVAL, and honours the
 * control_response it gets back.
 * -------------------------------------------------------------------------- */
const FAKE_CLI = path.join(WORK, 'fake-cli.mjs');
fs.writeFileSync(FAKE_CLI, `
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const logIn = (o) => { if (process.env.FAKE_INPUT_LOG) fs.appendFileSync(process.env.FAKE_INPUT_LOG, JSON.stringify(o) + '\\n'); };
const logEv = (o) => { if (process.env.FAKE_EVENTS) fs.appendFileSync(process.env.FAKE_EVENTS, JSON.stringify(o) + '\\n'); };
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
if (process.env.FAKE_DISPATCH === '1') {
  // A background dispatch OBSERVED but no level frame yet => lifetime 'unknown'.
  say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 999', run_in_background: true } }] } });
  say({ type: 'result', subtype: 'success' });
}
if (process.env.FAKE_EMIT_BG === '1') {
  say({ type: 'system', subtype: 'background_tasks_changed', tasks: [
    { task_id: process.env.FAKE_TASK_ID || 'bg-task-1', task_type: 'local_agent' },
  ] });
  say({ type: 'result', subtype: 'success' }); // the level frame must not leave midTurn=true
}
if (process.env.FAKE_MIDTURN === '1') {
  // Foreground turn genuinely in flight (never results) — mid-FOREGROUND-drain.
  say({ type: 'assistant', message: { content: [{ type: 'text', text: 'foreground turn still running' }] } });
}
let pendingApproval = null; // { userText, requestId }
let reqCounter = 0;
function runTurn(userText) {
  if (userText.includes('NEEDS-APPROVAL')) {
    reqCounter += 1;
    const requestId = 'req-' + reqCounter;
    pendingApproval = { userText, requestId };
    say({ type: 'control_request', request_id: requestId, request: {
      subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'touch /tmp/feat065-marker' },
      permission_suggestions: [], tool_use_id: 'toolu_' + requestId } });
    logEv({ ev: 'control-request-emitted', requestId, at: Date.now() });
    return; // the turn stalls until a control_response arrives (probe 4's shape)
  }
  const reply = 'ECHO:' + userText;
  say({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
  writeTurn(userText, reply);
  say({ type: 'result', subtype: 'success' });
  logEv({ ev: 'turn-complete', userText, at: Date.now() });
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
    } else if (m.type === 'control_response' && pendingApproval) {
      const p = pendingApproval; pendingApproval = null;
      const inner = m.response?.response;
      const allowed = inner?.behavior === 'allow';
      const reply = (allowed ? 'APPROVED-RAN ' : 'DENIED-FELL-BACK ') + p.userText;
      say({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
      writeTurn(p.userText, reply);
      say({ type: 'result', subtype: 'success' });
      logEv({ ev: 'approval-settled', allowed, denyMessage: allowed ? null : (inner?.message ?? null), at: Date.now() });
    }
  }
});
const flags = [
  [process.env.FAKE_BG_LEVEL_FLAG, () => { // background level frame lands => lifetime 'yes'
    say({ type: 'system', subtype: 'background_tasks_changed', tasks: [
      { task_id: process.env.FAKE_TASK_ID || 'bg-task-1', task_type: 'local_agent' } ] });
    say({ type: 'result', subtype: 'success' });
  }],
  [process.env.FAKE_BG_EMPTY_FLAG, () => { // background work COMPLETES
    say({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    say({ type: 'result', subtype: 'success' });
  }],
];
const fired = new Set();
const iv = setInterval(() => {
  for (const [flag, fn] of flags) {
    if (flag && !fired.has(flag) && fs.existsSync(flag)) { fired.add(flag); fn(); }
  }
}, 150);
iv.unref?.();
let midTurnOpen = false;
process.stdout.on('error', () => {});
process.stdin.on('end', () => {
  logEv({ ev: 'stdin-eof', at: Date.now(), midTurnOpen: !!pendingApproval || process.env.FAKE_MIDTURN === '1' });
  process.exit(0);
});
process.stdin.resume();
setInterval(() => {}, 1000);
`);

const brokerDirs = [];
let brokerSeq = 0;
function mkBroker(name, env, { dir = null, key = null } = {}) {
  const d = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), `cs-f65-broker-${name}-`));
  if (!dir) brokerDirs.push(d);
  fs.mkdirSync(d, { recursive: true });
  const k = key ?? `h-f65-${++brokerSeq}`;
  const ctl = path.join(d, `${k}.ctl.json`);
  const statusPath = path.join(d, `${k}.json`);
  fs.writeFileSync(ctl, JSON.stringify({
    sock: path.join(d, `${k}.sock`), status: statusPath, errlog: path.join(d, `${k}.err`),
    command: process.execPath, args: [FAKE_CLI], meta: { stationSessionId: `fake-${name}` },
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
  return { dir: d, statusPath, broker, key: k };
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

/** Plant a broker in the server's hostsDir, wait for the sdk id, SIGTERM it (the boot re-adopt reap), wait for the HELD drain. */
async function plantHeldSurvivor(name, sdkSessionId, transcriptPath, extraEnv = {}) {
  const hostsDir = path.join(DATA, 'session-hosts');
  fs.mkdirSync(hostsDir, { recursive: true });
  const inputLog = path.join(WORK, `${name}-input.log`);
  const eventsLog = path.join(WORK, `${name}-events.log`);
  const b = mkBroker(name, {
    FAKE_SDK_ID: sdkSessionId, FAKE_INPUT_LOG: inputLog, FAKE_EVENTS: eventsLog,
    FAKE_TRANSCRIPT: transcriptPath, ...extraEnv,
  }, { dir: hostsDir, key: `h-f65-${name}` });
  b.inputLog = inputLog;
  b.eventsLog = eventsLog;
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    const st = readJson(b.statusPath);
    if (st?.sdkSessionId === sdkSessionId) ready = true; else await sleep(200);
  }
  if (!ready) throw new Error(`planted broker ${name} never recorded the sdk session id`);
  try { process.kill(b.broker.pid, 'SIGTERM'); } catch { /* gone */ } // = adoptSurvivingHosts → reapHost
  let holding = false;
  for (let i = 0; i < 50 && !holding; i++) {
    const st = readJson(b.statusPath);
    if (st?.state === 'draining') holding = true; else await sleep(200);
  }
  if (!holding) throw new Error(`planted broker ${name} never reached the held drain`);
  return b;
}
/** Complete the fake background work and wait for the clean reap. */
async function settleAndReap(b, emptyFlag) {
  fs.writeFileSync(emptyFlag, '1');
  const t0 = Date.now();
  while (Date.now() - t0 < 15_000) {
    if (!fs.existsSync(b.statusPath)) return true;
    await sleep(250);
  }
  return false;
}

let server1 = null, server2 = null;
const liveBrokers = [];
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

/* ------------------------------------------------------------------ setup --- */
let projectId = null, sdkSessionId = null, transcriptPath = null, port2 = null;
async function setup() {
  console.log('\n=== SETUP: real seed session, then a restart-shaped server 2 ===');
  const port1 = await freePort();
  server1 = spawnServer(port1);
  if (!(await waitHealth(port1))) throw new Error('server 1 never became healthy');
  const reg = await (await fetch(`http://127.0.0.1:${port1}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: WORK, name: 'feat065-delivery' }),
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
  port2 = await freePort();
  // The bounded approval fallback is knob'd small so S3 proves the bound in-run.
  server2 = spawnServer(port2, { CLAUDE_STATION_DELIVERY_APPROVAL_MS: '3000' });
  if (!(await waitHealth(port2))) throw new Error('server 2 never became healthy');
  console.log(`  seed sdkSessionId=${sdkSessionId}\n  transcript=${transcriptPath}`);
}

/* -------------------------------------------------------------------------- *
 * SECTION 1 — raw-WS delivery E2E (every delivery check FAILS pre-fix)
 * -------------------------------------------------------------------------- */
async function sectionDelivery() {
  console.log('\n=== SECTION 1: delivery into the drain-held survivor (raw WS) ===');
  const emptyFlag = path.join(WORK, 's1-bg-empty.flag');
  const b = await plantHeldSurvivor('s1', sdkSessionId, transcriptPath, {
    FAKE_EMIT_BG: '1', FAKE_TASK_ID: 'bg-feat065-live', FAKE_BG_EMPTY_FLAG: emptyFlag,
  });
  liveBrokers.push(b);
  const st0 = readJson(b.statusPath);
  check('S1 PRECONDITION: broker held (draining), background live, foreground idle (midTurn:false published)',
    st0?.state === 'draining' && st0?.backgroundLive === 1 && st0?.midTurn === false,
    { state: st0?.state, backgroundLive: st0?.backgroundLive, midTurn: st0?.midTurn ?? '(absent)' });

  const MARKER = 'FEAT-065-S1-MARKER';
  const linesBefore = readLines(transcriptPath).length;
  const c = await openWs(port2);
  const t0 = Date.now();
  c.send({ type: 'start', projectId, prompt: `deliver me: ${MARKER}`, resumeSessionId: sdkSessionId });
  const ack = await waitEv(c.events, (e) => e.t === 'ack' && e.of === 'start', 20_000);
  const ackMs = Date.now() - t0;
  const spawnedDuring = secondClaudeFor(sdkSessionId);
  check('S1 (LOAD-BEARING, fails pre-fix): the start is ACKED deliveredVia:survivor — not refused',
    ack?.deliveredVia === 'survivor',
    { ack: ack ?? c.events.find((e) => e.t === 'error')?.message?.slice(0, 140) ?? '(nothing)' });
  check('S1: the ack lands inside the client\'s 15s ghost-release window',
    !!ack && ackMs < 15_000, { ackMs });

  // The reply must land WHILE the drain is still held (that is the whole point).
  let grew = false;
  const t1 = Date.now();
  while (Date.now() - t1 < 15_000) {
    if (transcriptUserLines(transcriptPath, MARKER).length > 0
      && readLines(transcriptPath).some((l) => l.includes(`ECHO:`) && l.includes(MARKER))) { grew = true; break; }
    await sleep(250);
  }
  const stDuring = readJson(b.statusPath);
  check('S1 (fails pre-fix): the message + reply reached the transcript WITHOUT waiting for background completion (drain still held, bg still live)',
    grew && stDuring?.state === 'draining' && stDuring?.backgroundLive === 1,
    { transcriptGrew: grew, brokerState: stDuring?.state ?? 'gone', backgroundLive: stDuring?.backgroundLive });
  const frames = readLines(b.inputLog).map((l) => JSON.parse(l)).filter((m) => m.type === 'user' && JSON.stringify(m).includes(MARKER));
  check('S1 (fails pre-fix): the ENGINE received exactly ONE user frame carrying the message (same pid — the survivor\'s own stdin)',
    frames.length === 1, { engineUserFrames: frames.length });
  check('S1: exactly ONE user message with the marker in the on-disk store',
    transcriptUserLines(transcriptPath, MARKER).length === 1,
    { storeUserLines: transcriptUserLines(transcriptPath, MARKER).length });
  check('S1: no second claude was ever spawned onto this transcript (no `--resume <id>` process)',
    spawnedDuring.length === 0 && secondClaudeFor(sdkSessionId).length === 0,
    { atAck: spawnedDuring, now: secondClaudeFor(sdkSessionId) });
  const doneEv = await waitEv(c.events, (e) => e.t === 'survivor-delivery' && e.phase === 'turn-done', 15_000);
  check('S1 (fails pre-fix): the injected turn\'s end is reported (survivor-delivery turn-done)',
    !!doneEv && doneEv.sessionId === sdkSessionId, { doneEv: doneEv ?? '(never arrived)' });
  try { c.send({ type: 'close' }); c.ws.close(); } catch { /* ignore */ }

  // Background completes → the drain commits and reaps cleanly (delivery must not fight commitDrain).
  const reaped = await settleAndReap(b, emptyFlag);
  const evts = readLines(b.eventsLog).map((l) => JSON.parse(l));
  const eof = evts.find((e) => e.ev === 'stdin-eof');
  check('S1: background completes → the drain commits and reaps cleanly, EOF landing with the turn CLOSED',
    reaped && !!eof && eof.midTurnOpen === false,
    { reaped, eof: eof ?? '(none)', linesBefore, linesAfter: readLines(transcriptPath).length });
}

/* -------------------------------------------------------------------------- *
 * SECTION 2 — permission arm A: approval round-trips via the dashboard flow
 * -------------------------------------------------------------------------- */
async function sectionApprovalAllow() {
  console.log('\n=== SECTION 2: injected turn raises a permission — dashboard approval round-trips (allow) ===');
  const emptyFlag = path.join(WORK, 's2-bg-empty.flag');
  const b = await plantHeldSurvivor('s2', sdkSessionId, transcriptPath, {
    FAKE_EMIT_BG: '1', FAKE_TASK_ID: 'bg-feat065-perm', FAKE_BG_EMPTY_FLAG: emptyFlag,
  });
  liveBrokers.push(b);
  const MARKER = 'FEAT-065-S2-NEEDS-APPROVAL';
  const c = await openWs(port2);
  c.send({ type: 'start', projectId, prompt: MARKER, resumeSessionId: sdkSessionId });
  const ack = await waitEv(c.events, (e) => e.t === 'ack' && e.of === 'start', 20_000);
  check('S2 (fails pre-fix): the permission-raising message is delivered (ack deliveredVia:survivor)',
    ack?.deliveredVia === 'survivor', { ack: ack ?? '(refused)' });
  const req = await waitEv(c.events, (e) => e.t === 'approval-request', 15_000);
  check('S2 (fails pre-fix): the control_request is relayed to the ws as the ORDINARY approval-request card',
    !!req && req.toolName === 'Bash' && typeof req.requestId === 'string',
    { req: req ? { requestId: req.requestId, toolName: req.toolName } : '(never arrived)' });
  if (req) c.send({ type: 'approval-response', requestId: req.requestId, allow: true });
  const rAck = await waitEv(c.events, (e) => e.t === 'ack' && e.of === 'approval-response', 10_000);
  check('S2: the answer is acked matched:true (same settle contract as a live session\'s card)',
    rAck?.matched === true && rAck?.allow === true, { rAck: rAck ?? '(no ack)' });
  let settled = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 12_000 && !settled) {
    settled = readLines(b.eventsLog).map((l) => JSON.parse(l)).find((e) => e.ev === 'approval-settled');
    if (!settled) await sleep(250);
  }
  check('S2 (fails pre-fix): the allow control_response reached the CLI and the turn completed APPROVED',
    settled?.allowed === true && readLines(transcriptPath).some((l) => l.includes('APPROVED-RAN') && l.includes(MARKER)),
    { settled: settled ?? '(never)', transcriptHasApproved: readLines(transcriptPath).some((l) => l.includes('APPROVED-RAN')) });
  const doneEv = await waitEv(c.events, (e) => e.t === 'survivor-delivery' && e.phase === 'turn-done', 10_000);
  check('S2: the approved injected turn ends normally (turn-done)', !!doneEv, { doneEv: doneEv ?? '(never)' });
  try { c.send({ type: 'close' }); c.ws.close(); } catch { /* ignore */ }
  const reaped = await settleAndReap(b, emptyFlag);
  check('S2: drain then completes and reaps cleanly', reaped, { reaped });
}

/* -------------------------------------------------------------------------- *
 * SECTION 3 — permission arm B: nobody answers → the BOUNDED deny fallback
 * -------------------------------------------------------------------------- */
async function sectionApprovalDenyFallback() {
  console.log('\n=== SECTION 3: unanswered permission takes the bounded deny (knob 3s) — the drain is never wedged ===');
  const emptyFlag = path.join(WORK, 's3-bg-empty.flag');
  const b = await plantHeldSurvivor('s3', sdkSessionId, transcriptPath, {
    FAKE_EMIT_BG: '1', FAKE_TASK_ID: 'bg-feat065-deny', FAKE_BG_EMPTY_FLAG: emptyFlag,
  });
  liveBrokers.push(b);
  const MARKER = 'FEAT-065-S3-NEEDS-APPROVAL';
  const c = await openWs(port2);
  c.send({ type: 'start', projectId, prompt: MARKER, resumeSessionId: sdkSessionId });
  const ack = await waitEv(c.events, (e) => e.t === 'ack' && e.of === 'start', 20_000);
  check('S3 (fails pre-fix): delivered (ack deliveredVia:survivor)', ack?.deliveredVia === 'survivor', { ack: ack ?? '(refused)' });
  const req = await waitEv(c.events, (e) => e.t === 'approval-request', 15_000);
  const reqAt = Date.now();
  check('S3: the approval-request reaches the ws (and is then deliberately ignored)', !!req, { req: req ? req.requestId : '(never)' });
  // Nobody answers. The bounded fallback must deny and the turn must COMPLETE.
  let settled = null;
  while (Date.now() - reqAt < 15_000 && !settled) {
    settled = readLines(b.eventsLog).map((l) => JSON.parse(l)).find((e) => e.ev === 'approval-settled');
    if (!settled) await sleep(250);
  }
  const denyMs = settled ? settled.at - reqAt : null;
  check('S3 (fails pre-fix): the deny lands BOUNDED (~3s knob, well under any drain window) with an honest notice',
    settled?.allowed === false && typeof settled?.denyMessage === 'string' && /denied by claude-station/.test(settled.denyMessage) && denyMs != null && denyMs < 10_000,
    { settled: settled ?? '(never — the turn would hang forever, probe 4)', denyMsApprox: denyMs });
  const denied = await waitEv(c.events, (e) => e.t === 'permission-denied', 5_000);
  check('S3: the client is TOLD about the fallback (permission-denied with the notice)',
    !!denied && /denied so the drain can complete/.test(denied.reason ?? ''), { denied: denied ?? '(never)' });
  const doneEv = await waitEv(c.events, (e) => e.t === 'survivor-delivery' && e.phase === 'turn-done', 10_000);
  check('S3 (fails pre-fix): the denied turn still COMPLETES (drain not wedged) and reports turn-done',
    !!doneEv && readLines(transcriptPath).some((l) => l.includes('DENIED-FELL-BACK') && l.includes(MARKER)),
    { doneEv: doneEv ?? '(never)', transcriptHasDenied: readLines(transcriptPath).some((l) => l.includes('DENIED-FELL-BACK')) });
  try { c.send({ type: 'close' }); c.ws.close(); } catch { /* ignore */ }
  const reaped = await settleAndReap(b, emptyFlag);
  check('S3: drain then completes and reaps cleanly', reaped, { reaped });
}

/* -------------------------------------------------------------------------- *
 * SECTION 4 — mid-FOREGROUND-drain survivor keeps today's queue-and-wait
 * -------------------------------------------------------------------------- */
async function sectionMidForegroundRefusal() {
  console.log('\n=== SECTION 4: survivor whose FOREGROUND turn still runs → queue-and-wait, never injected ===');
  const b = await plantHeldSurvivor('s4', sdkSessionId, transcriptPath, {
    FAKE_EMIT_BG: '1', FAKE_TASK_ID: 'bg-feat065-mid', FAKE_MIDTURN: '1',
  });
  const st = readJson(b.statusPath);
  check('S4 PRECONDITION: broker holds with the foreground turn OPEN (midTurn:true published)',
    st?.state === 'draining' && st?.midTurn === true, { state: st?.state, midTurn: st?.midTurn ?? '(absent)' });
  const c = await openWs(port2);
  c.send({ type: 'start', projectId, prompt: 'FEAT-065-S4-must-wait', resumeSessionId: sdkSessionId });
  const err = await waitEv(c.events, (e) => e.t === 'error', 15_000);
  const ack = c.events.find((e) => e.t === 'ack' && e.of === 'start');
  check('S4: the send is REFUSED retryably (today\'s queue-and-wait), not delivered',
    !!err && err.retryable === true && !ack, { err: (err?.message ?? '(none)').slice(0, 120), ack: ack ?? null });
  check('S4: nothing was injected into the survivor (engine input log has no user frame)',
    readLines(b.inputLog).every((l) => { try { return JSON.parse(l).type !== 'user'; } catch { return true; } }),
    { inputLines: readLines(b.inputLog).length });
  try { c.ws.close(); } catch { /* ignore */ }
  stopBrokerFamily(b);
  await sleep(400);
}

/* -------------------------------------------------------------------------- *
 * SECTION 5 — real app.js: unknown lifetime honored, then the BUG-045 retry
 * loop DELIVERS — chip retires, exactly-once, reply renders LIVE.
 * -------------------------------------------------------------------------- */
async function sectionDomLoop() {
  console.log('\n=== SECTION 5: real app.js — refusal+chip while lifetime unknown, then the retry start is DELIVERED ===');
  const levelFlag = path.join(WORK, 's5-bg-level.flag');
  const emptyFlag = path.join(WORK, 's5-bg-empty.flag');
  const b = await plantHeldSurvivor('s5', sdkSessionId, transcriptPath, {
    FAKE_DISPATCH: '1', FAKE_TASK_ID: 'bg-feat065-dom',
    FAKE_BG_LEVEL_FLAG: levelFlag, FAKE_BG_EMPTY_FLAG: emptyFlag,
  });
  liveBrokers.push(b);
  const st0 = readJson(b.statusPath);
  check('S5 PRECONDITION: broker held with lifetime UNKNOWN (dispatch observed, no level frame yet)',
    st0?.state === 'draining' && st0?.backgroundLifetime === 'unknown',
    { state: st0?.state, backgroundLifetime: st0?.backgroundLifetime ?? '(absent)' });

  const MARKER = 'FEAT-065-DOM-MARKER';
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const BASE = `http://127.0.0.1:${port2}`;
  const win = new Window({ url: `${BASE}/` });
  const doc = win.document;
  doc.write(html.replace(/<link[^>]*>/g, '').replace(/<script[^>]*><\/script>/g, ''));
  doc.close();
  const realFetch = globalThis.fetch;
  win.fetch = (input, init2) => realFetch(String(input).startsWith('http') ? input : BASE + input, init2);
  const openSockets = [];
  class TrackedWebSocket extends WebSocket { constructor(...args) { super(...args); openSockets.push(this); } }
  win.WebSocket = TrackedWebSocket;
  win.location.host = `127.0.0.1:${port2}`;
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.WebSocket = win.WebSocket;
  globalThis.location = win.location;
  globalThis.fetch = win.fetch;
  try {
    await import(`${path.join(ROOT, 'public', 'app.js')}?ui=${Date.now()}`);
    const q = (s) => doc.querySelector(s);
    const qa = (s) => [...doc.querySelectorAll(s)];
    const booted = await (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 20_000) { if (qa('#tree button.proj').length > 0) return true; await sleep(150); }
      return false;
    })();
    if (!booted) throw new Error('app.js never rendered the project tree');
    const rows = () => qa('#tree button.row');
    const t0 = Date.now();
    while (Date.now() - t0 < 20_000 && rows().length === 0) await sleep(150);
    if (!rows().length) throw new Error('no session rows rendered');
    rows()[0].click();
    const t0b = Date.now();
    while (Date.now() - t0b < 30_000 && qa('#panes .pane .you, #panes .pane .claude').length === 0) await sleep(200);
    await sleep(1200);
    const prompt = q('#prompt');
    prompt.value = MARKER;
    q('#go').click();

    // Phase 1 — UNKNOWN lifetime: refusal + chip, NOTHING injected (ARCH-002).
    let chip = '';
    const t1 = Date.now();
    let queued = false;
    while (Date.now() - t1 < 15_000) {
      chip = q('#queueBox .q-l')?.textContent ?? '';
      if (/waiting/.test(chip)) { queued = true; break; }
      await sleep(300);
    }
    check('S5 phase 1: while lifetime is UNKNOWN the message is refused + queued with the BUG-045 chip (not injected)',
      queued, { chip: chip || '(no chip)' });
    check('S5 phase 1: the survivor received NO injected frame while unknown (ARCH-002: unknown = wait)',
      readLines(b.inputLog).every((l) => { try { return JSON.parse(l).type !== 'user'; } catch { return true; } }),
      { inputLines: readLines(b.inputLog).length });

    // Phase 2 — the CLI's level frame lands: lifetime becomes 'yes'; the
    // client's OWN retry start must now be DELIVERED (the exactly-once ride).
    fs.writeFileSync(levelFlag, '1');
    const stApi = win.__station?.state;
    let delivered = false;
    const t2 = Date.now();
    while (Date.now() - t2 < 25_000) {
      const userFrames = readLines(b.inputLog).filter((l) => { try { const m = JSON.parse(l); return m.type === 'user' && JSON.stringify(m).includes(MARKER); } catch { return false; } });
      if (userFrames.length > 0) { delivered = true; break; }
      await sleep(400);
    }
    check('S5 phase 2 (LOAD-BEARING, fails pre-fix): the retry start is DELIVERED into the survivor — pre-fix the message waits the WHOLE drain',
      delivered, { deliveredWithinMs: delivered ? Date.now() - t2 : null });
    // Chip retires exactly once; the row leaves the queue on the ack.
    let chipGone = false;
    const t3 = Date.now();
    while (Date.now() - t3 < 10_000) {
      if (!stApi?.queue?.some((x) => !x.dead && x.drainWait)) { chipGone = true; break; }
      await sleep(300);
    }
    check('S5 (fails pre-fix): the drain-wait row retires on the delivered ack (exactly-once, BUG-045 seam)',
      chipGone, { queue: stApi?.queue?.map((x) => ({ drainWait: !!x.drainWait, dead: x.dead })) ?? '(no state)' });
    // The turn renders LIVE from the transcript follow: user message once + reply.
    let paneText = '';
    let replyLive = false;
    const t4 = Date.now();
    while (Date.now() - t4 < 20_000) {
      paneText = qa('#panes .pane').map((p) => p.textContent).join('\n');
      if (paneText.includes(`ECHO:${MARKER}`)) { replyLive = true; break; }
      await sleep(400);
    }
    const domCount = (paneText.match(new RegExp(MARKER, 'g')) ?? []).length - (paneText.includes(`ECHO:${MARKER}`) ? 1 : 0);
    check('S5 (fails pre-fix): the injected turn renders LIVE in the open session view (reply via transcript follow)',
      replyLive, { replyLive });
    check('S5: the delivered message appears EXACTLY ONCE in the client DOM',
      replyLive && domCount === 1, { userBubbleOccurrences: domCount });
    check('S5: engine input log carries EXACTLY ONE user frame with the message',
      readLines(b.inputLog).filter((l) => { try { const m = JSON.parse(l); return m.type === 'user' && JSON.stringify(m).includes(MARKER); } catch { return false; } }).length === 1,
      { frames: readLines(b.inputLog).filter((l) => l.includes(MARKER)).length });
    check('S5: on-disk store carries EXACTLY ONE user message with the marker',
      transcriptUserLines(transcriptPath, MARKER).length === 1,
      { storeUserLines: transcriptUserLines(transcriptPath, MARKER).length });
    // The relay closes itself on turn-done (routine close — no "dropped" scare).
    let relayClosed = false;
    const t5 = Date.now();
    while (Date.now() - t5 < 10_000) {
      if (!stApi?.deliveryRelay && !stApi?.live) { relayClosed = true; break; }
      await sleep(300);
    }
    check('S5: the approval-relay socket closes deliberately on turn-done (no dropped-connection state)',
      relayClosed && stApi?.dropped !== true, { relayClosed, dropped: stApi?.dropped ?? '(no state)' });
    try {
      if (stApi?.drainWaitTimer) { clearInterval(stApi.drainWaitTimer); stApi.drainWaitTimer = null; }
      if (stApi?.liveTimer) { clearInterval(stApi.liveTimer); stApi.liveTimer = null; }
    } catch { /* app never got that far */ }
  } finally {
    for (const s of openSockets) { try { s.removeAllListeners?.(); s.close(); } catch { /* closed */ } }
    await sleep(300);
    globalThis.fetch = realFetch;
  }
  const reaped = await settleAndReap(b, emptyFlag);
  check('S5: background completes → drain commits and reaps cleanly after the delivery', reaped, { reaped });
}

async function main() {
  await setup();
  await sectionDelivery();
  await sectionApprovalAllow();
  await sectionApprovalDenyFallback();
  await sectionMidForegroundRefusal();
  await sectionDomLoop();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(async () => {
  for (const b of liveBrokers) stopBrokerFamily(b);
  const hostsDir = path.join(DATA, 'session-hosts');
  try {
    for (const f of fs.readdirSync(hostsDir).filter((n) => n.endsWith('.json') && !n.endsWith('.ctl.json'))) {
      const st = readJson(path.join(hostsDir, f));
      for (const p of [st?.claudePid, st?.hostPid]) if (p && pidAlive(p)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    }
  } catch { /* no hosts dir */ }
  for (const s of [server1, server2]) { if (s?.pid) { try { process.kill(s.pid, 'SIGKILL'); } catch { /* gone */ } } }
  await sleep(500);
  for (const d of [WORK, DATA, ...brokerDirs]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  setTimeout(() => process.exit(process.exitCode ?? 0), 400).unref();
});
