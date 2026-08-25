/**
 * BUG-074 — a GHOST background claim no longer holds the user's message.
 *
 *   node scripts/verify-bug-074-ghost-drain.mjs
 *
 * TWO SUSPECTS, each reproduced against a REAL session-host broker whose fake
 * stream-json CLI replays the exact frame ordering the real CLI 2.1.227 emits
 * (captured by the ticket's probes):
 *
 *  SUSPECT 2 (the confirmed user harm) — a background SUB-AGENT streams inner
 *  frames on the SAME stdout the broker sniffs, and every such frame carries a
 *  top-level `parent_tool_use_id`. Pre-fix the broker's midTurn tracker took each
 *  as foreground-turn activity and PINNED midTurn=true for the agent's whole
 *  life (there is no foreground `result` to clear it) — so the FEAT-065 delivery
 *  gate (midTurn===false) stayed shut and the queued message waited the entire
 *  background agent (the user's 26 minutes). Post-fix the broker keeps
 *  parent_tool_use_id / background-lifecycle frames OUT of midTurn, so it stays
 *  false and the message DELIVERS at the next boundary tick.
 *    S1a must-FAIL pre-fix: midTurn published false while sub-agent frames stream.
 *    S1b must-FAIL pre-fix: the send is ACKED deliveredVia:survivor (not refused).
 *
 *  SUSPECT 1 (bounded trust, ARCH-002) — a non-empty level that goes
 *  UNCORROBORATED for BG_STALE_MS is downgraded 'yes' -> 'unknown'. The drain
 *  STILL HOLDS (unknown never EOFs — BUG-044 safe: declared-live work is never
 *  truncated), but the trust is bounded and the delivery gate is reconciled so
 *  the stale/quiet level cannot strand the user's message.
 *    S2a must-FAIL pre-fix: backgroundLifetime reported 'unknown' after the
 *        window (pre-fix it stays a confident 'yes' forever).
 *    S2b anti-regression (BUG-044): the CLI stays ALIVE through the downgrade.
 *    S2c: a send in that stale state still DELIVERS.
 *
 *  ANTI-REGRESSION — a GENUINE foreground turn still pins midTurn=true (the fix
 *  did not make midTurn always-false / weaken BUG-022's reap guard); such a
 *  survivor still gets today's queue-and-wait.
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
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b74-work-'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b74-data-'));

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
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const readLines = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean); } catch { return []; } };

/* -------------------------------------------------------------- fake CLI ---
 * Replays the real CLI's stdout ordering. On startup:
 *   init; result (idle);
 *   FAKE_FG_BG=1 : a foreground turn that dispatches a background sub-agent —
 *     assistant tool_use(Task, run_in_background id toolu_probe) + a
 *     background_tasks_changed level (tasks=1, local_agent) + result. => bgLive,
 *     foreground idle.
 *   FAKE_SUBAGENT_STREAM=1 : then, on an interval and WITH NO trailing result,
 *     the sub-agent's inner frames (assistant/user carrying
 *     parent_tool_use_id=toolu_probe) — the midTurn-pinning shape.
 *   FAKE_STALE=1 : only the level (tasks=1) + result, then SILENCE (no stream) —
 *     the uncorroborated 'yes' shape for the bounded-trust downgrade.
 *   FAKE_FG_OPEN=1 : a foreground assistant frame (NO parent_tool_use_id, NO
 *     result) — a genuinely open foreground turn (midTurn must stay true).
 * Injected user frames run a normal turn (transcript + result), single writer.
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
function appendTranscript(entry) { const t = process.env.FAKE_TRANSCRIPT; if (!t) return; fs.appendFileSync(t, JSON.stringify(entry) + '\\n'); }
function writeTurn(userText, replyText) {
  const u = uuid(), a = uuid(); const now = () => new Date().toISOString();
  appendTranscript({ parentUuid: lastUuid, isSidechain: false, userType: 'external', cwd: process.cwd(), sessionId: sdkId, version: '2.1.227', type: 'user', message: { role: 'user', content: userText }, uuid: u, timestamp: now() });
  appendTranscript({ parentUuid: u, isSidechain: false, userType: 'external', cwd: process.cwd(), sessionId: sdkId, version: '2.1.227', type: 'assistant', message: { id: 'msg_' + a.slice(0, 8), type: 'message', role: 'assistant', model: 'fake-survivor', content: [{ type: 'text', text: replyText }], stop_reason: 'end_turn' }, uuid: a, timestamp: now() });
  lastUuid = a;
}
say({ type: 'system', subtype: 'init', session_id: sdkId });
say({ type: 'result', subtype: 'success' });
const TASK_ID = process.env.FAKE_TASK_ID || 'bg-b74';
if (process.env.FAKE_FG_BG === '1' || process.env.FAKE_STALE === '1') {
  // Foreground turn: dispatch a background lane, then a level frame, then close.
  say({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'toolu_probe', name: 'Task', input: { run_in_background: true } }] } });
  say({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: TASK_ID, task_type: 'local_agent' }] });
  say({ type: 'system', subtype: 'task_started', task_id: TASK_ID, tool_use_id: 'toolu_probe', task_type: 'local_agent' });
  say({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'STARTED' }] } });
  say({ type: 'result', subtype: 'success' }); // foreground idle from here — bg lane alive
}
if (process.env.FAKE_SUBAGENT_STREAM === '1') {
  // The background sub-agent streams inner frames FOREVER (no trailing result).
  // Every one carries parent_tool_use_id — the exact midTurn-pinning shape.
  const iv = setInterval(() => {
    say({ type: 'assistant', parent_tool_use_id: 'toolu_probe', message: { content: [{ type: 'thinking', thinking: 'sub working' }] } });
    say({ type: 'assistant', parent_tool_use_id: 'toolu_probe', message: { content: [{ type: 'tool_use', id: 'toolu_inner', name: 'Bash', input: { command: 'echo tick' } }] } });
    say({ type: 'user', parent_tool_use_id: 'toolu_probe', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_inner', content: 'tick' }] } });
  }, 250);
  iv.unref?.();
}
if (process.env.FAKE_FG_OPEN === '1') {
  // A genuinely-open FOREGROUND turn (no parent_tool_use_id, never results).
  say({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'foreground turn still running' }] } });
}
function runTurn(userText) {
  const reply = 'ECHO:' + userText;
  say({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: reply }] } });
  writeTurn(userText, reply);
  say({ type: 'result', subtype: 'success' });
  logEv({ ev: 'turn-complete', userText, at: Date.now() });
}
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString('utf8'); let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { logIn({ raw: line }); continue; }
    logIn(m);
    if (m.type === 'user') { const c = m.message?.content; const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b?.text ?? '').join(' ') : ''; runTurn(text); }
  }
});
const emptyFlag = process.env.FAKE_BG_EMPTY_FLAG;
const iv2 = setInterval(() => {
  if (emptyFlag && fs.existsSync(emptyFlag)) { clearInterval(iv2); say({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }); say({ type: 'result', subtype: 'success' }); }
}, 150); iv2.unref?.();
process.stdout.on('error', () => {});
process.stdin.on('end', () => { logEv({ ev: 'stdin-eof', at: Date.now() }); process.exit(0); });
process.stdin.resume();
setInterval(() => {}, 1000);
`);

const brokerDirs = [];
function mkBroker(name, env, { dir = null, key = null } = {}) {
  const d = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), `cs-b74-broker-${name}-`));
  if (!dir) brokerDirs.push(d);
  fs.mkdirSync(d, { recursive: true });
  const k = key ?? `h-b74-${name}`;
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
      CLAUDE_STATION_HOST_DRAIN_TERM_MS: '4000',
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
  for (const p of [st?.claudePid, st?.hostPid, x.broker?.pid]) { if (p && pidAlive(p)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } } }
  for (const ext of ['.json', '.sock', '.err', '.ctl.json']) { try { fs.rmSync(path.join(x.dir, `${x.key}${ext}`), { force: true }); } catch { /* ignore */ } }
}

const liveBrokers = [];
async function plantHeldSurvivor(name, sdkSessionId, transcriptPath, extraEnv = {}) {
  const hostsDir = path.join(DATA, 'session-hosts');
  fs.mkdirSync(hostsDir, { recursive: true });
  const inputLog = path.join(WORK, `${name}-input.log`);
  const eventsLog = path.join(WORK, `${name}-events.log`);
  const b = mkBroker(name, { FAKE_SDK_ID: sdkSessionId, FAKE_INPUT_LOG: inputLog, FAKE_EVENTS: eventsLog, FAKE_TRANSCRIPT: transcriptPath, ...extraEnv }, { dir: hostsDir, key: `h-b74-${name}` });
  b.inputLog = inputLog; b.eventsLog = eventsLog;
  liveBrokers.push(b);
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) { const st = readJson(b.statusPath); if (st?.sdkSessionId === sdkSessionId) ready = true; else await sleep(200); }
  if (!ready) throw new Error(`planted broker ${name} never recorded the sdk session id`);
  try { process.kill(b.broker.pid, 'SIGTERM'); } catch { /* gone */ } // = adoptSurvivingHosts -> reapHost
  let holding = false;
  for (let i = 0; i < 50 && !holding; i++) { const st = readJson(b.statusPath); if (st?.state === 'draining') holding = true; else await sleep(200); }
  if (!holding) throw new Error(`planted broker ${name} never reached the held drain`);
  return b;
}

let server1 = null, server2 = null;
function spawnServer(port, extraEnv = {}) {
  const s = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_STATION_SURVIVE: '0', ...extraEnv },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  s.stderr?.on('data', () => { /* quiet */ });
  return s;
}
async function waitHealth(port, ms = 40_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* not up */ } await sleep(250); }
  return false;
}
function openWs(port) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); const events = [];
    ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
    ws.once('open', () => res({ ws, events, send: (o) => ws.send(JSON.stringify(o)) }));
    ws.once('error', rej); ws.on('error', () => {});
  });
}
const waitEv = async (events, pred, ms = 30_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const hit = events.find(pred); if (hit) return hit; await sleep(150); } return null; };
function findTranscript(sdkId) {
  const base = path.join(os.homedir(), '.claude', 'projects'); let dirs = [];
  try { dirs = fs.readdirSync(base); } catch { return null; }
  for (const d of dirs) { const p = path.join(base, d, `${sdkId}.jsonl`); if (fs.existsSync(p)) return p; }
  return null;
}
const transcriptUserLines = (p, marker) => readLines(p).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e?.type === 'user' && JSON.stringify(e.message?.content ?? '').includes(marker));
function secondClaudeFor(sdkId) {
  const hits = []; let pids = [];
  try { pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch { return hits; }
  for (const pid of pids) { if (Number(pid) === process.pid) continue; let cmd = ''; try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' '); } catch { continue; } if (cmd.includes('--resume') && cmd.includes(sdkId)) hits.push(Number(pid)); }
  return hits;
}

let projectId = null, sdkSessionId = null, transcriptPath = null, port2 = null;
async function setup() {
  console.log('\n=== SETUP: real seed session -> real transcript -> restart-shaped server ===');
  const port1 = await freePort();
  server1 = spawnServer(port1);
  if (!(await waitHealth(port1))) throw new Error('server 1 never became healthy');
  const reg = await (await fetch(`http://127.0.0.1:${port1}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: WORK, name: 'bug074' }) })).json();
  projectId = reg.project?.id;
  if (!projectId) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  await fetch(`http://127.0.0.1:${port1}/api/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: { permissionMode: 'bypassPermissions', model: 'haiku' } }) });
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
  server2 = spawnServer(port2, { CLAUDE_STATION_DELIVERY_APPROVAL_MS: '3000' });
  if (!(await waitHealth(port2))) throw new Error('server 2 never became healthy');
  console.log(`  seed sdkSessionId=${sdkSessionId}`);
}

/* ---- SUSPECT 2: sub-agent frames must not pin midTurn; delivery fires ------ */
async function sectionSubagentPin() {
  console.log('\n=== SECTION 1 (SUSPECT 2): background sub-agent stream must NOT pin midTurn — delivery fires ===');
  const b = await plantHeldSurvivor('s1', sdkSessionId, transcriptPath, {
    FAKE_FG_BG: '1', FAKE_SUBAGENT_STREAM: '1', FAKE_TASK_ID: 'bg-b74-live',
  });
  // Let the sub-agent stream run so the pin (if any) is firmly established.
  await sleep(1500);
  const st = readJson(b.statusPath);
  check('S1a (must-FAIL pre-fix): while the background sub-agent streams inner frames (parent_tool_use_id), the broker publishes midTurn:FALSE — pre-fix each frame PINS it true',
    st?.state === 'draining' && st?.backgroundLive === 1 && st?.midTurn === false,
    { state: st?.state, backgroundLive: st?.backgroundLive, midTurn: st?.midTurn, backgroundLifetime: st?.backgroundLifetime });

  const MARKER = 'BUG-074-S1-DELIVER';
  const c = await openWs(port2);
  const t0 = Date.now();
  c.send({ type: 'start', projectId, prompt: `deliver me: ${MARKER}`, resumeSessionId: sdkSessionId });
  const ack = await waitEv(c.events, (e) => e.t === 'ack' && e.of === 'start', 20_000);
  const ackMs = Date.now() - t0;
  check('S1b (must-FAIL pre-fix): the send is DELIVERED (ack deliveredVia:survivor) within one boundary tick — pre-fix it is refused retryably and waits the whole agent',
    ack?.deliveredVia === 'survivor' && ackMs < 15_000,
    { ack: ack ?? c.events.find((e) => e.t === 'error')?.message?.slice(0, 120) ?? '(nothing)', ackMs });
  const frames = readLines(b.inputLog).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((m) => m?.type === 'user' && JSON.stringify(m).includes(MARKER));
  check('S1c: the engine received EXACTLY ONE user frame (the survivor\'s own stdin — single writer) and no second claude spawned',
    frames.length === 1 && secondClaudeFor(sdkSessionId).length === 0,
    { engineUserFrames: frames.length, secondClaude: secondClaudeFor(sdkSessionId).length });
  const done = await waitEv(c.events, (e) => e.t === 'survivor-delivery' && e.phase === 'turn-done', 15_000);
  check('S1c: the injected turn completes (turn-done) even though the background sub-agent keeps streaming',
    !!done, { done: done ?? '(never)' });
  try { c.send({ type: 'close' }); c.ws.close(); } catch { /* ignore */ }
  stopBrokerFamily(b);
  await sleep(300);
}

/* ---- SUSPECT 1: an uncorroborated 'yes' is bounded to 'unknown' ------------ */
async function sectionBoundedTrust() {
  console.log('\n=== SECTION 2 (SUSPECT 1): an uncorroborated level is bounded (yes -> unknown), never EOFs, still delivers ===');
  const emptyFlag = path.join(WORK, 's2-empty.flag');
  const b = await plantHeldSurvivor('s2', sdkSessionId, transcriptPath, {
    FAKE_STALE: '1', FAKE_TASK_ID: 'bg-b74-stale', FAKE_BG_EMPTY_FLAG: emptyFlag,
    CLAUDE_STATION_HOST_BG_STALE_MS: '2500', // knob the anti-stale window small for the run
  });
  const st0 = readJson(b.statusPath);
  check('S2 PRECONDITION: held (draining), background level live (yes), foreground idle',
    st0?.state === 'draining' && st0?.backgroundLive === 1 && st0?.backgroundLifetime === 'yes' && st0?.midTurn === false,
    { state: st0?.state, backgroundLive: st0?.backgroundLive, backgroundLifetime: st0?.backgroundLifetime, midTurn: st0?.midTurn });
  // Wait past BG_STALE_MS with NO corroborating frames. The held drain's re-check
  // cadence (400ms) refreshes the status file, so the downgrade surfaces.
  let downgraded = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 12_000) {
    const st = readJson(b.statusPath);
    if (st?.backgroundLifetime === 'unknown') { downgraded = st; break; }
    await sleep(300);
  }
  check('S2a (must-FAIL pre-fix): after the anti-stale window the broker reports backgroundLifetime:UNKNOWN while backgroundLive is still 1 — pre-fix it stays a confident yes forever',
    downgraded?.backgroundLifetime === 'unknown' && downgraded?.backgroundLive === 1,
    { backgroundLifetime: downgraded?.backgroundLifetime ?? readJson(b.statusPath)?.backgroundLifetime, backgroundLive: downgraded?.backgroundLive });
  const cliPid = readJson(b.statusPath)?.claudePid;
  check('S2b ANTI-REGRESSION (BUG-044): the bounded-trust downgrade NEVER EOFs — the declared-live CLI is still alive and the drain still held',
    !!cliPid && pidAlive(cliPid) && readJson(b.statusPath)?.state === 'draining',
    { cliPid, alive: cliPid ? pidAlive(cliPid) : null, state: readJson(b.statusPath)?.state });

  const MARKER = 'BUG-074-S2-DELIVER';
  const c = await openWs(port2);
  c.send({ type: 'start', projectId, prompt: `deliver me: ${MARKER}`, resumeSessionId: sdkSessionId });
  const ack = await waitEv(c.events, (e) => e.t === 'ack' && e.of === 'start', 20_000);
  check('S2c: a send in the stale/uncorroborated state still DELIVERS (the ghost/quiet level does not strand the user)',
    ack?.deliveredVia === 'survivor',
    { ack: ack ?? c.events.find((e) => e.t === 'error')?.message?.slice(0, 120) ?? '(nothing)' });
  try { c.send({ type: 'close' }); c.ws.close(); } catch { /* ignore */ }
  // Settle: the empty frame arrives -> drain commits -> reaps (proves it still releases honestly).
  fs.writeFileSync(emptyFlag, '1');
  let reaped = false; const t1 = Date.now();
  while (Date.now() - t1 < 15_000) { if (!fs.existsSync(b.statusPath)) { reaped = true; break; } await sleep(250); }
  check('S2d: when the CLI\'s own empty frame lands the drain commits and reaps cleanly (the level self-heals; the hold releases)',
    reaped, { reaped });
  stopBrokerFamily(b);
  await sleep(300);
}

/* ---- ANTI-REGRESSION: a genuine foreground turn STILL pins midTurn --------- */
async function sectionForegroundStillPins() {
  console.log('\n=== SECTION 3 (ANTI-REGRESSION): a genuine open FOREGROUND turn STILL pins midTurn -> queue-and-wait ===');
  const b = await plantHeldSurvivor('s3', sdkSessionId, transcriptPath, {
    FAKE_FG_BG: '1', FAKE_FG_OPEN: '1', FAKE_TASK_ID: 'bg-b74-fg',
  });
  await sleep(800);
  const st = readJson(b.statusPath);
  check('S3a: a foreground turn genuinely in flight (assistant frame, no parent_tool_use_id, no result) publishes midTurn:TRUE — the fix did not make midTurn always-false (BUG-022 reap guard intact)',
    st?.midTurn === true, { midTurn: st?.midTurn, state: st?.state });
  const c = await openWs(port2);
  c.send({ type: 'start', projectId, prompt: 'BUG-074-S3-must-wait', resumeSessionId: sdkSessionId });
  const err = await waitEv(c.events, (e) => e.t === 'error', 15_000);
  const ack = c.events.find((e) => e.t === 'ack' && e.of === 'start');
  check('S3b: that mid-foreground-drain survivor keeps today\'s queue-and-wait (refused retryably, nothing injected)',
    !!err && err.retryable === true && !ack && readLines(b.inputLog).every((l) => { try { return JSON.parse(l).type !== 'user'; } catch { return true; } }),
    { refused: !!err, retryable: err?.retryable, injectedUserFrames: readLines(b.inputLog).filter((l) => { try { return JSON.parse(l).type === 'user'; } catch { return false; } }).length });
  try { c.ws.close(); } catch { /* ignore */ }
  stopBrokerFamily(b);
  await sleep(300);
}

async function main() {
  await setup();
  await sectionSubagentPin();
  await sectionBoundedTrust();
  await sectionForegroundStillPins();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => { console.error(`\nFATAL: ${err.stack ?? err.message}`); process.exitCode = 1; }).finally(async () => {
  for (const b of liveBrokers) stopBrokerFamily(b);
  const hostsDir = path.join(DATA, 'session-hosts');
  try { for (const f of fs.readdirSync(hostsDir).filter((n) => n.endsWith('.json') && !n.endsWith('.ctl.json'))) { const st = readJson(path.join(hostsDir, f)); for (const p of [st?.claudePid, st?.hostPid]) if (p && pidAlive(p)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } } } } catch { /* none */ }
  for (const s of [server1, server2]) { if (s?.pid) { try { process.kill(s.pid, 'SIGKILL'); } catch { /* gone */ } } }
  await sleep(500);
  for (const d of [WORK, DATA, ...brokerDirs]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  setTimeout(() => process.exit(process.exitCode ?? 0), 400).unref();
});
