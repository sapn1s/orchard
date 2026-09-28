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
 *   S3 permission arm B — nobody answers: while the ws stays ATTACHED the card
 *      waits (BUG-187 round 6); on responder LOSS the deny lands, the turn
 *      completes DENIED, drain not wedged
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
import { startWhenAdmitted } from './lib/host-admission.mjs';
import { isolatedStoreEnv } from './lib/station-boot.mjs';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const HOST_SCRIPT = path.join(ROOT, 'src', 'server', 'session-host.mjs');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f65-work-'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f65-data-'));
// The seed turn runs a REAL claude CLI, and the server now refuses a session whose
// transcript would land in the user's real store (assertSessionStoreIsolated, the
// fixture-pollutes-reality guard). Writer AND reader point at a scratch store under
// DATA, so the UI lists exactly this suite's seed session and cleanup removes it.
const STORE = isolatedStoreEnv(path.join(DATA, 'claude-config'), { alsoReader: true });

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
      ...process.env, ...STORE, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA,
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
  const base = STORE.CLAUDE_PROJECTS_DIR;
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
    // FEAT-131: direct-isolation lifecycle suite — pin isolation so the
    // container-default for new projects cannot move the session off-host.
    body: JSON.stringify({ hostPath: WORK, name: 'feat065-delivery', isolation: 'direct' }),
  })).json();
  projectId = reg.project?.id;
  if (!projectId) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  await fetch(`http://127.0.0.1:${port1}/api/projects/${encodeURIComponent(projectId)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { permissionMode: 'bypassPermissions', model: 'haiku' } }),
  });
  // FEAT-151: retry only the boot-runtime-check refusal (scripts/lib/host-admission.mjs).
  const { c: c0, init } = await startWhenAdmitted(openWs, port1, { type: 'start', projectId, prompt: 'Reply with exactly: SEED-OK' });
  if (!init?.sessionId) throw new Error(`seed turn never started: ${JSON.stringify(c0?.events.slice(-4))}`);
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
  check('S3: the approval-request reaches the ws (and is then deliberately left undecided)', !!req, { req: req ? req.requestId : '(never)' });
  /*
   * BUG-187 round 6 — the invariant changed on purpose: a card an ATTACHED
   * person owns waits for them (plan-review point 5); only responder LOSS
   * denies it. The old 3 s bound for an attached, undecided person is gone
   * (the broker now holds its drain under an owned card instead). So: hold
   * well past the old knob with the ws attached → NOT denied; then drop the
   * ws → the deny lands promptly with an honest notice and the turn completes.
   */
  const settledNow = () => readLines(b.eventsLog).map((l) => JSON.parse(l)).find((e) => e.ev === 'approval-settled') ?? null;
  await sleep(7_000); // > 2 × the 3 s knob
  const earlyDeny = settledNow();
  check('S3 (round 6): an ATTACHED, undeciding person is NOT timed out (held > 2 × the old 3 s knob, no deny)',
    !earlyDeny, { settledWhileAttached: earlyDeny ?? '(none — held)' });
  const lossAt = Date.now();
  try { c.send({ type: 'close' }); c.ws.close(); } catch { /* ignore */ }
  let settled = null;
  while (Date.now() - lossAt < 15_000 && !settled) { settled = settledNow(); if (!settled) await sleep(250); }
  const denyMs = settled ? settled.at - lossAt : null;
  check('S3 (round 6): responder LOSS (the ws closes) → the deny lands promptly with an honest notice',
    settled?.allowed === false && typeof settled?.denyMessage === 'string' && /denied by Orchard/.test(settled.denyMessage) && /disconnected/.test(settled.denyMessage) && denyMs != null && denyMs < 5_000,
    { settled: settled ?? '(never — the turn would hang forever, probe 4)', denyMsAfterLoss: denyMs });
  const deniedDone = await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 10_000) { if (readLines(transcriptPath).some((l) => l.includes('DENIED-FELL-BACK') && l.includes(MARKER))) return true; await sleep(250); } return false; })();
  check('S3 (fails pre-fix): the denied turn still COMPLETES (drain not wedged)', deniedDone, { transcriptHasDenied: deniedDone });
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

/* -------------------------------------------------------------------------- *
 * SECTION 6 — BUG-190: a REAL headless browser, the transcript watch socket
 * DISCONNECTED, and a turn delivered / lines written DURING the gap. After the
 * watch reconnects the open view must converge to the full transcript — every
 * gap line rendered exactly once, no reload. Pre-fix a fresh follow starts at
 * the file's end, so the gap bytes are never rendered.
 * -------------------------------------------------------------------------- */
function browserPath() {
  const want = process.env.VERIFY_BROWSER ?? 'brave';
  if (path.isAbsolute(want)) return want;
  try { return execFileSync('which', [want], { encoding: 'utf8' }).trim(); } catch { return null; }
}
async function visibleOnce(page, text) {
  const loc = page.locator('#panes .pane').getByText(text, { exact: true });
  const count = await loc.count();
  let shown = false;
  if (count === 1) { await loc.scrollIntoViewIfNeeded(); shown = await loc.isVisible(); }
  return { count, shown, ok: count === 1 && shown };
}
async function waitAllOnce(page, texts, ms) {
  const t0 = Date.now();
  let last = {};
  while (Date.now() - t0 < ms) {
    last = {};
    for (const t of texts) last[t] = await visibleOnce(page, t);
    if (Object.values(last).every((r) => r.ok)) return { ok: true, seen: last };
    await sleep(300);
  }
  return { ok: false, seen: last };
}
async function dropWatch(page) {
  // Kill the passive transcript-watch socket the way a network blip would.
  await page.evaluate(() => window.__station.state.watchWs?.close());
  await page.waitForFunction(() => window.__station.state.watchWs == null || window.__station.state.watchWs.readyState !== 1, null, { timeout: 5_000 });
}
async function sectionReconnectGap() {
  console.log('\n=== SECTION 6: REAL BROWSER — watch disconnected, turn delivered + lines written DURING the gap (BUG-190) ===');
  const exe = browserPath();
  if (!exe || !fs.existsSync(exe)) throw new Error(`S6 needs a real headless browser (set VERIFY_BROWSER); none found for ${process.env.VERIFY_BROWSER ?? 'brave'}`);
  const emptyFlag = path.join(WORK, 's6-bg-empty.flag');
  const b = await plantHeldSurvivor('s6', sdkSessionId, transcriptPath, {
    FAKE_EMIT_BG: '1', FAKE_TASK_ID: 'bg-feat065-gap', FAKE_BG_EMPTY_FLAG: emptyFlag,
  });
  liveBrokers.push(b);
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    // Must-FAIL harness: serve a pinned pre-fix app.js to the real browser without
    // touching the shared working-tree file (other lanes edit it concurrently).
    if (process.env.BUG190_APP_VARIANT) {
      const body = fs.readFileSync(process.env.BUG190_APP_VARIANT, 'utf8');
      await page.route('**/app.js*', (route) => route.fulfill({ contentType: 'text/javascript', body }));
    }
    await page.goto(`http://127.0.0.1:${port2}/`);
    await page.locator('#tree button.row').first().click();
    await page.waitForFunction(() => window.__station?.state?.following === true, null, { timeout: 30_000 });
    await sleep(800);

    // 6a — a turn DELIVERED into the survivor while the watch is down.
    const M = 'BUG-190-GAP-DELIVERY';
    await dropWatch(page);
    await page.locator('#prompt').fill(M);
    await page.locator('#go').click();
    let persisted = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 20_000 && !persisted) {
      persisted = transcriptUserLines(transcriptPath, M).length === 1 && readLines(transcriptPath).some((l) => l.includes(`ECHO:${M}`));
      if (!persisted) await sleep(250);
    }
    check('S6a PRECONDITION: the gap-delivered message + reply are in the store (delivered into the survivor)', persisted, { persisted });
    const a = await waitAllOnce(page, [M, `ECHO:${M}`], 15_000);
    check('S6a (LOAD-BEARING, fails pre-fix): after the watch reconnects, the message delivered DURING the gap and its reply render — each exactly once, no reload',
      a.ok, a.seen);
    await sleep(2_000);
    const a2 = await waitAllOnce(page, [M, `ECHO:${M}`], 1_000);
    check('S6a: still exactly once after settling (the catch-up and the live follow do not double-render)', a2.ok, a2.seen);

    // 6b — two disconnects back to back, lines written in each gap, then a
    // control line after the view is live again.
    const entry = (text) => JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), parentUuid: null, isSidechain: false,
      sessionId: sdkSessionId, timestamp: new Date().toISOString(), message: { role: 'user', content: text } }) + '\n';
    const gapLines = ['BUG-190-GAP-1', 'BUG-190-GAP-2', 'BUG-190-GAP-3', 'BUG-190-GAP-4'];
    await dropWatch(page);
    fs.appendFileSync(transcriptPath, entry(gapLines[0]));
    fs.appendFileSync(transcriptPath, entry(gapLines[1]));
    await page.waitForFunction(() => window.__station.state.watchWs?.readyState === 1 && window.__station.state.following === true, null, { timeout: 15_000 });
    await dropWatch(page); // second blip, straight after the first reconnect
    fs.appendFileSync(transcriptPath, entry(gapLines[2]));
    fs.appendFileSync(transcriptPath, entry(gapLines[3]));
    await page.waitForFunction(() => window.__station.state.watchWs?.readyState === 1 && window.__station.state.following === true, null, { timeout: 20_000 });
    fs.appendFileSync(transcriptPath, entry('BUG-190-POST-RECONNECT-CONTROL'));
    const bRes = await waitAllOnce(page, [...gapLines, 'BUG-190-POST-RECONNECT-CONTROL'], 15_000);
    check('S6b (LOAD-BEARING, fails pre-fix): lines written across TWO back-to-back watch gaps all render exactly once after reconnect, plus the post-reconnect control',
      bRes.ok, bRes.seen);
    const order = await page.evaluate((ids) => {
      const txt = [...document.querySelectorAll('#panes .pane')].map((p) => p.innerText).join('\n');
      return ids.map((id) => txt.indexOf(id));
    }, [M, ...gapLines, 'BUG-190-POST-RECONNECT-CONTROL']);
    check('S6b: the caught-up lines render in transcript order', order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), { order });

    // 6c — the store API's backward selector names REAL indices even when asked
    // for a window past the end (the client catch-up and loadNewer both rely on
    // the one coordinate system; pre-fix before=total+100 relabelled the tail).
    const dir = await page.evaluate(() => window.__station.state.current.encodedDir);
    const base = `http://127.0.0.1:${port2}/api/transcript/${encodeURIComponent(dir)}/${encodeURIComponent(sdkSessionId)}`;
    const whole = await (await fetch(`${base}?tail=3`)).json();
    const past = await (await fetch(`${base}?tail=3&before=${whole.total + 100}`)).json();
    const ix = (j) => (j.messages ?? []).map((m) => m.index);
    check('S6c (fails pre-fix): ?before past the end is clamped — the tail keeps its REAL indices (ends at total-1)',
      whole.total > 0 && JSON.stringify(ix(past)) === JSON.stringify(ix(whole)) && ix(past).at(-1) === whole.total - 1,
      { total: whole.total, tail: ix(whole), pastEnd: ix(past) });

    // ---- BUG-190 round 3 arms (the verifier's run 01a0e3de repros, owned here) ----
    const append = (t) => fs.appendFileSync(transcriptPath, entry(t));
    const connected = () => page.waitForFunction(() => window.__station.state.watchWs?.readyState === 1 && window.__station.state.following === true, null, { timeout: 20_000 });
    // Rendered-text census in ONE evaluate: how many times each text is a whole
    // visible line of the pane (innerText excludes what is not rendered).
    const census = (texts) => page.evaluate((ts) => {
      const lines = [...document.querySelectorAll('#panes .pane')].map((p) => p.innerText).join('\n').split('\n').map((l) => l.trim());
      const count = {}; for (const t of ts) count[t] = 0;
      for (const l of lines) if (l in count) count[l]++;
      const joined = lines.join('\n');
      return { count, order: ts.map((t) => joined.indexOf(t)) };
    }, texts);
    const converged = async (texts, ms) => {
      const t0 = Date.now(); let c;
      while (Date.now() - t0 < ms) {
        c = await census(texts);
        if (texts.every((t) => c.count[t] === 1)) break;
        await sleep(400);
      }
      const bad = Object.entries(c.count).filter(([, n]) => n !== 1);
      const inOrder = c.order.every((v, i) => v >= 0 && (i === 0 || v > c.order[i - 1]));
      return { ok: bad.length === 0, inOrder, bad: bad.slice(0, 8), badCount: bad.length, total: texts.length };
    };

    // 6d — a trailing PARTIAL line present at reconnect, completed afterwards.
    {
      const P = ['BUG-190-PART-A', 'BUG-190-PART-B', 'BUG-190-PART-C', 'BUG-190-PART-D'];
      await dropWatch(page);
      append(P[0]); append(P[1]);
      const line = entry(P[2]); const cut = line.length - 15;
      fs.appendFileSync(transcriptPath, line.slice(0, cut));
      await connected(); await sleep(1500);
      fs.appendFileSync(transcriptPath, line.slice(cut)); append(P[3]);
      const r = await converged(P, 15_000);
      check('S6d (fails pre-fix): a partial trailing line present at reconnect and completed afterwards renders — all four exactly once, in order',
        r.ok && r.inOrder, r);
    }

    // 6e — a gap LONGER than one catch-up page (260 lines, page 120), with a line
    // appended while the first backward page is being read.
    {
      const G = Array.from({ length: 260 }, (_, i) => `BUG-190-BIG-${String(i).padStart(3, '0')}`);
      let backward = 0;
      await page.route('**/api/transcript/**', async (route) => {
        if (route.request().url().includes('before=')) {
          backward++;
          if (backward === 1) { append('BUG-190-BIG-DURING-READ'); await sleep(600); }
        }
        await route.continue();
      });
      await dropWatch(page);
      for (const t of G) append(t);
      await connected();
      const r = await converged([...G, 'BUG-190-BIG-DURING-READ'], 25_000);
      await page.unroute('**/api/transcript/**');
      check('S6e PRECONDITION: the catch-up really paged backward (more than one page behind)', backward > 0, { backward });
      check('S6e (LOAD-BEARING, fails pre-fix): a 260-message reconnect gap converges — every line exactly once, in order, none truncated',
        r.ok && r.inOrder, r);
    }

    // 6f — the catch-up read fails once (HTTP 503), then the store is back.
    {
      let failures = 0;
      await page.route('**/api/transcript/**', async (route) => {
        if (failures === 0 && route.request().url().includes('tail=')) { failures++; await route.fulfill({ status: 503, body: 'temporarily unavailable' }); }
        else await route.continue();
      });
      await dropWatch(page);
      append('BUG-190-FAILED-READ-GAP');
      await connected(); await sleep(2000);
      append('BUG-190-FAILED-READ-LIVE');
      const r = await converged(['BUG-190-FAILED-READ-GAP', 'BUG-190-FAILED-READ-LIVE'], 20_000);
      await page.unroute('**/api/transcript/**');
      check('S6f PRECONDITION: one catch-up read was failed with a 503', failures === 1, { failures });
      check('S6f (fails pre-fix): after a transient catch-up failure the view converges on its own — the gap line and the later live line, once each, in order',
        r.ok && r.inOrder, r);
    }

    // 6g — a live append split in the middle of a multi-byte character.
    {
      const U = 'BUG-190-UTF8-🙂-END';
      const bytes = Buffer.from(entry(U));
      const at = bytes.indexOf(Buffer.from('🙂')) + 2;
      fs.appendFileSync(transcriptPath, bytes.subarray(0, at));
      await sleep(700);
      fs.appendFileSync(transcriptPath, bytes.subarray(at));
      const r = await converged([U], 10_000);
      check('S6g (fails pre-fix): a line whose write is split inside a multi-byte character renders intact, once', r.ok, r);
    }

    // 6h — BUG-190 round 4: records completed WITHOUT a trailing newline.
    {
      // (i) live watch: a genuinely partial record never renders half-done…
      const H1 = 'BUG-190-NONL-LIVE', H2 = 'BUG-190-NONL-NEXT';
      const l1 = entry(H1).replace(/\n$/, '');
      const cutAt = l1.length - 1; // everything but the closing brace: the marker is written, the record is not complete
      fs.appendFileSync(transcriptPath, l1.slice(0, cutAt));
      await sleep(1500);
      const half = await census([H1]);
      check('S6h: a PARTIAL record (marker written, object not closed) is never rendered half-done', half.count[H1] === 0, half);
      // …and renders the moment it is complete, before any newline arrives.
      fs.appendFileSync(transcriptPath, l1.slice(cutAt));
      const r1 = await converged([H1], 10_000);
      check('S6h (fails pre-fix): a record completed WITHOUT its trailing newline renders on the live watch, once', r1.ok, r1);
      // The newline arriving later, and the next record, add no duplicate.
      await sleep(600);
      fs.appendFileSync(transcriptPath, '\n');
      append(H2);
      const r2 = await converged([H1, H2], 10_000);
      check('S6h: the late newline adds nothing — the completed record stays exactly once and the next record follows, in order', r2.ok && r2.inOrder, r2);

      // (ii) reconnect: a partial last line at re-subscribe, then completed with no newline.
      const R = ['BUG-190-NONL-RC-A', 'BUG-190-NONL-RC-B'];
      await dropWatch(page);
      append(R[0]);
      const lb = entry(R[1]).replace(/\n$/, '');
      const cutB = lb.length - 12;
      fs.appendFileSync(transcriptPath, lb.slice(0, cutB));
      await connected(); await sleep(1500);
      fs.appendFileSync(transcriptPath, lb.slice(cutB));
      const r3 = await converged(R, 10_000);
      check('S6h (fails pre-fix): after a reconnect, the last record completed with NO trailing newline renders — both lines once, in order', r3.ok && r3.inOrder, r3);
      fs.appendFileSync(transcriptPath, '\n'); // leave the file well-formed for what follows
    }

    // 6i — BUG-190 round 5: an EMPTY session (no renderable message, total 0),
    // watch dropped, its FIRST message written during the gap, then a live one.
    {
      const sid = crypto.randomUUID();
      const file = path.join(path.dirname(transcriptPath), `${sid}.jsonl`);
      const recFor = (text) => JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), parentUuid: null, isSidechain: false,
        sessionId: sid, timestamp: new Date().toISOString(), message: { role: 'user', content: text } }) + '\n';
      fs.writeFileSync(file, recFor('BUG-190-EMPTY-ANCHOR')); // gives the row a title to click
      await page.reload();
      const row = page.locator('#tree button.row').filter({ hasText: 'BUG-190-EMPTY-ANCHOR' });
      await row.waitFor({ timeout: 20_000 });
      fs.writeFileSync(file, recFor('')); // now EMPTY: one record, nothing renderable
      await row.click();
      await page.waitForFunction((id) => window.__station.state.current.sessionId === id && window.__station.state.following === true, sid, { timeout: 20_000 });
      await sleep(600);
      const empty = await page.evaluate(() => ({ lastIndex: window.__station.state.threads?.get?.('main')?.lastIndex ?? null }));
      await dropWatch(page);
      fs.appendFileSync(file, recFor('BUG-190-EMPTY-FIRST'));
      await connected(); await sleep(600);
      fs.appendFileSync(file, recFor('BUG-190-EMPTY-SECOND'));
      const r = await converged(['BUG-190-EMPTY-FIRST', 'BUG-190-EMPTY-SECOND'], 12_000);
      check('S6i (LOAD-BEARING, fails pre-fix): an EMPTY session\'s first message, written while the watch was down, renders after reconnect — both messages once, in order',
        r.ok && r.inOrder, { ...r, empty });
      const hint = await page.locator('#panes .pane .empty-session-hint').count();
      check('S6i: the "no readable messages" notice is gone once the session has a message', hint === 0, { hint });
    }

    // 6j — BUG-190 round 5 sibling: a thread the LIVE BRIDGE rendered has no store
    // indices at all. A real new session (real CLI turn) in the browser; then its
    // driving socket drops, the watch drops, a message lands in the gap, and the
    // watch reconnects. The view must converge — nothing skipped, nothing twice.
    {
      const plus = page.locator('#tree [aria-label^="New session in "]');
      console.log('  (S6j: project "+" buttons in the tree:', await plus.count(), JSON.stringify(await plus.evaluateAll((ns) => ns.map((n) => n.getAttribute('aria-label')))), ')');
      await plus.first().dispatchEvent('click'); // this project's own "+" (hover-revealed, so dispatched)
      await page.waitForFunction(() => window.__station.state.current.projectId === 'feat065-delivery' && !window.__station.state.current.sessionId, null, { timeout: 10_000 });
      await page.locator('#prompt').fill('Reply with exactly: B190-BRIDGE-OK');
      await page.locator('#go').click();
      // The bridge renders the turn (the model's reply itself is not needed: this
      // environment's CLI may not be able to authenticate, and the thread is
      // bridge-rendered either way — the user bubble and the turn's end are).
      await page.waitForFunction(() => window.__station.state.current.sessionId && window.__station.state.live && !window.__station.state.busy
        && [...document.querySelectorAll('#panes .pane .you')].some((n) => n.innerText.includes('B190-BRIDGE-OK')), null, { timeout: 120_000 });
      const live = await page.evaluate(() => ({ sid: window.__station.state.sdkSessionId, dir: window.__station.state.current.encodedDir, lastIndex: window.__station.state.threads?.get?.('main')?.lastIndex ?? '(n/a)' }));
      const bridgeFile = path.join(STORE.CLAUDE_PROJECTS_DIR, live.dir ?? '', `${live.sid}.jsonl`);
      check('S6j PRECONDITION: a real bridge-driven session rendered its turn and has a transcript on disk', !!live.sid && fs.existsSync(bridgeFile), { ...live, exists: fs.existsSync(bridgeFile) });
      // The driving socket drops (the session detaches server-side), then the watch.
      await page.evaluate(() => window.__station.state.ws?.close());
      await page.waitForFunction(() => !window.__station.state.live, null, { timeout: 15_000 });
      await dropWatch(page);
      const brec = (text) => JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), parentUuid: null, isSidechain: false,
        sessionId: live.sid, timestamp: new Date().toISOString(), message: { role: 'user', content: text } }) + '\n';
      fs.appendFileSync(bridgeFile, brec('BUG-190-BRIDGE-GAP'));
      await page.waitForFunction(() => window.__station.state.watchWs?.readyState === 1, null, { timeout: 20_000 });
      await sleep(2500);
      fs.appendFileSync(bridgeFile, brec('BUG-190-BRIDGE-LIVE'));
      const r = await converged(['BUG-190-BRIDGE-GAP', 'BUG-190-BRIDGE-LIVE'], 20_000);
      const prompt = await page.evaluate(() => [...document.querySelectorAll('#panes .pane .you')].filter((n) => n.innerText.includes('B190-BRIDGE-OK')).length);
      check('S6j (fails pre-fix): a bridge-rendered view followed after its bridge dropped converges — the gap line and the live line once each, in order, and the bridge-rendered prompt still exactly once',
        r.ok && r.inOrder && prompt === 1, { ...r, prompt });
    }
  } finally {
    await browser.close();
  }
  const reaped = await settleAndReap(b, emptyFlag);
  check('S6: background completes → drain commits and reaps cleanly', reaped, { reaped });
}

async function main() {
  await setup();
  await sectionDelivery();
  await sectionApprovalAllow();
  await sectionApprovalDenyFallback();
  await sectionMidForegroundRefusal();
  await sectionDomLoop();
  await sectionReconnectGap();
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
