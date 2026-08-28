#!/usr/bin/env node
/**
 * BUG-157 — CONTAINER/DIRECT SESSIONS KILL LIVE WORK when the detached-close fuse
 * fires MID-TURN. This suite proves the two ENGINE-FRAME-DRIVEN halves of the fix
 * deterministically, on DIRECT survival sessions, with a scripted fake `claude`
 * (CLAUDE_STATION_CLAUDE_BIN) — real server, real AgentSession, real ClaudeRuntime
 * + SDK; only the model process is scripted. The container-specific quiet gate and
 * exec-reap reschedule are proven separately against a REAL docker container in
 * scripts/verify-bug-157-container-close-live-work.mjs.
 *
 * THE DEFECT CHAIN (agent-bridge.ts):
 *  1. `busy` was set only in start()/send(), so a turn the CLI STARTS ITSELF from a
 *     task notification (a "woken"/"surfacing" turn) left busy=false — and the
 *     detached-close fuse (#armDetachedClose) requires `!this.busy` to fire, so it
 *     fired mid-turn, reaping the broker (whose stdin-EOF/SIGTERM kills the CLI and
 *     its live background agents).
 *  3. A SendMessage-revived retired task was invisible to workLifetime() (BUG-105
 *     keeps a re-announced id retired), so a revived agent made the session MORE
 *     closeable while running.
 *
 * THE FIXES UNDER TEST:
 *  A  — main-thread frames (`init`, main-thread `assistant`) pin `busy` via
 *       #markForegroundTurnLive(); `result` clears it. A background subagent's
 *       inner frames (parent_tool_use_id != null) must NOT pin busy.
 *  B2 — a `task_started` for a task with an ESTABLISHED outcome records the id in
 *       #revivedTasks; workLifetime() returns 'unknown' (biased to detach) while a
 *       revival is live; its own next terminal frame retires it.
 *
 * SCENARIOS (each on its own server + free port + scratch dataDir):
 *   woken     — a task-notification-woken turn runs a live heartbeat with an EMPTY
 *               background level. FIXED: busy is pinned, the fuse declines, the
 *               woken turn RUNS TO COMPLETION (DONE). PRE-FIX: busy=false, the fuse
 *               fires ~3s in, the session is closed out from under the turn, the
 *               fake is stdin-EOF'd, DONE never lands.
 *   revival   — a retired agent is re-announced (SendMessage revival). FIXED:
 *               #revivedTasks → workLifetime 'unknown' → stays open until the
 *               revival's own terminal frame, then closes. PRE-FIX: the revival is
 *               invisible, workLifetime 'no', the fuse closes it mid-run, no DONE.
 *   finished  — NON-VACUITY: a genuinely finished detached session (turn done,
 *               level empty, nothing unsettled) STILL closes and reaps. Proves the
 *               fuse is not disabled. (Closes on BOTH trees — a control.)
 *   innerframe— Fix A classification: a burst of ONLY background-subagent inner
 *               frames (parent_tool_use_id != null) must NOT pin busy, so a
 *               finished session with only inner frames still closes. Proves the
 *               pin is foreground-specific (no over-suppression). (Both trees.)
 *
 * SAFETY: free ephemeral port, scratch dataDir + store + cwd under the OS tmp,
 * every process killed BY PID. Needs `systemd-run --user` — the survival broker is
 * what close() reaps, and that reap is the kill under test. :4317 / the real
 * service / scopes not ours are never touched.
 *
 * Usage: node scripts/verify-bug-157-woken-turn-and-revival.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug157-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug157-store-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug157-work-'));
const FAKE = path.join(WORK, 'fake-claude.mjs');

/** Seconds the woken/revival turn's heartbeat runs. > the fuse's first 3s fire. */
const WORK_MS = 18_000;

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

/* ------------------------------------------------------------------------- *
 * THE SCRIPTED FAKE `claude`.
 *
 * Turn 1 is user-driven (the `start`): it dispatches a background agent and ends
 * the turn, so a socket drop DETACHES (workLifetime 'yes' via a level frame)
 * rather than closing. Then it watches a FLAG FILE the harness writes AFTER it
 * detaches, and — WITH NO USER MESSAGE, exactly like a task-notification-woken
 * turn — drives the second phase. The SDK yields these spontaneous frames to the
 * bridge's #handle unchanged (claude-runtime.ts messages() is an unconditional
 * `for await`), which is why the real CLI's woken turns reach the bridge at all.
 * ------------------------------------------------------------------------- */
fs.writeFileSync(FAKE, `
import * as readline from 'node:readline';
import * as ffs from 'node:fs';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const SCENARIO = process.env.SCENARIO || 'woken';
const FLAG = process.env.PHASE2_FLAG;
const HB = process.env.HEARTBEAT_FILE;
const WORK_MS = Number(process.env.WORK_MS || '18000');
const SDK_ID = process.env.FAKE_SDK_ID || ('fakesdk-' + process.pid);
const rl = readline.createInterface({ input: process.stdin });
// The broker's reap EOFs our stdin — the close under test. Exit immediately so a
// mid-heartbeat close leaves the heartbeat TRUNCATED (no DONE), the pre-fix tell.
rl.on('close', () => process.exit(0));

const A = (parent, id, name, input) => say({ type: 'assistant', ...(parent ? { parent_tool_use_id: parent } : {}), message: { model: 'claude-haiku-4-5', content: [ { type: 'tool_use', id, name, input: input || {} } ] } });
const TEXT = (parent, t) => say({ type: 'assistant', ...(parent ? { parent_tool_use_id: parent } : {}), message: { model: 'claude-haiku-4-5', content: [ { type: 'text', text: t } ] } });
const TS = (task, tu, extra) => say({ type: 'system', subtype: 'task_started', task_id: task, tool_use_id: tu, ...extra });
const TU = (task, status) => say({ type: 'system', subtype: 'task_updated', task_id: task, patch: { status } });
const BG = (tasks) => say({ type: 'system', subtype: 'background_tasks_changed', tasks });
const INIT = () => say({ type: 'system', subtype: 'init', session_id: SDK_ID, cwd: process.cwd(), model: 'haiku', tools: [], slash_commands: [] });
const RESULT = () => say({ type: 'result', subtype: 'success', total_cost_usd: 0 });
const AGENT = (d) => ({ subagent_type: 'worker', description: d });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function heartbeat(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { ffs.appendFileSync(HB, Date.now() + '\\n'); } catch {} await sleep(500); }
}
async function waitFlag() { while (!(FLAG && ffs.existsSync(FLAG))) await sleep(150); }

let started = false;
rl.on('line', (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.type === 'control_request') {
    say({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
    return;
  }
  if (m.type !== 'user') return;
  if (started) return;
  started = true;
  driveTurnOne();
});

async function driveTurnOne() {
  INIT();
  // A background agent so the socket drop DETACHES (level 'yes'), not closes.
  A(null, 'task_tu_BG', 'Task', { subagent_type: 'worker', description: 'bg root', run_in_background: true });
  TS('bgTask', 'task_tu_BG', AGENT('bg root'));
  BG([{ task_id: 'bgTask', task_type: 'local_agent', description: 'bg root' }]); // clears #bgDispatchAt
  TEXT(null, 'TURN ONE — dispatched, ending turn');
  RESULT();
  await phaseTwo();
}

async function phaseTwo() {
  await waitFlag();
  if (SCENARIO === 'woken') {
    // A self-started surfacing turn: fresh init + a MAIN-THREAD assistant frame
    // (both must pin busy, fix A), then real work, on an EMPTY background level.
    INIT();
    TEXT(null, 'WOKEN TURN — surfacing after a task notification');
    BG([]);                              // the level empties → arms the close fuse
    await heartbeat(WORK_MS);            // the live work the fuse must not kill
    RESULT();
    try { ffs.appendFileSync(HB, 'DONE\\n'); } catch {}
    return;
  }
  if (SCENARIO === 'revival') {
    TU('bgTask', 'completed');           // the agent retires (establishes an outcome)
    BG([]);                              // empty level
    // SendMessage revival — a FOREGROUND turn that re-announces a settled id, then
    // ends (result clears the busy the dispatch pinned), leaving the revived agent
    // running in the background. The revival is what workLifetime must now see.
    A(null, 'task_tu_REV', 'Task', { subagent_type: 'worker', description: 'revived', run_in_background: true });
    TS('bgTask', 'task_tu_REV', AGENT('revived by SendMessage'));
    TEXT(null, 'REVIVAL TURN — re-dispatched the retired agent, ending turn');
    RESULT();                            // the revival turn ends → busy clears, fuse re-arms
    // The engine's level frame after the re-announce: BUG-105 keeps a re-announced
    // id OUT of the level (it stays vetoed), so the level is EMPTY. This clears the
    // pre-signal race hint (#bgDispatchAt) too, so the ONLY thing that can keep the
    // session open through the revival is #revivedTasks — the signal fix B2 adds.
    BG([]);
    await heartbeat(WORK_MS);            // the revival's live work
    try { ffs.appendFileSync(HB, 'DONE\\n'); } catch {}
    TU('bgTask', 'completed');           // the revival's OWN terminal frame — retires it
    BG([]);                              // the engine's level frame for the now-empty set
    return;
  }
  if (SCENARIO === 'finished') {
    // NON-VACUITY: genuinely finished. Nothing outlives the turn → must close+reap.
    TU('bgTask', 'completed');
    BG([]);
    // no further frames — the fuse should close this within a couple of windows
    return;
  }
  if (SCENARIO === 'innerframe') {
    // Fix A classification: ONLY background-subagent inner frames. They must NOT
    // pin busy, so a finished session with only inner frames still closes.
    TU('bgTask', 'completed');
    BG([]);
    for (let i = 0; i < 40; i++) { TEXT('task_tu_BG', 'inner background frame ' + i); await sleep(500); }
    return;
  }
}
`);

/* -------------------------------- harness -------------------------------- */
const servers = new Set();
function spawnServer(port, env) {
  const s = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE,
      CLAUDE_STATION_CLAUDE_BIN: FAKE, CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  s.stdout.on('data', (d) => { if (process.env.VERIFY_BUG157_DEBUG) process.stderr.write(`  [server] ${d}`); });
  s.stderr.on('data', (d) => { if (process.env.VERIFY_BUG157_DEBUG) process.stderr.write(`  [server!] ${d}`); });
  servers.add(s);
  return s;
}
async function waitHealth(port) { for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${port}/api/health`); return true; } catch { await sleep(250); } } return false; }
function openWs(port) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); const events = [];
    ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch {} });
    ws.once('open', () => res({ ws, events, send: (o) => ws.send(JSON.stringify(o)) }));
    ws.once('error', rej); ws.on('error', () => {});
  });
}
const waitEv = async (events, pred, ms = 60_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const h = events.find(pred); if (h) return h; await sleep(120); } return null; };
const waitCount = async (events, pred, n, ms = 60_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (events.filter(pred).length >= n) return true; await sleep(120); } return false; };

async function register(port, cwd, name) {
  const r = await (await fetch(`http://127.0.0.1:${port}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: cwd, name }) })).json();
  if (!r.project?.id) throw new Error(`register(${name}) failed ` + JSON.stringify(r));
  return r.project.id;
}
const sessionOpen = async (port, stationId) => {
  try { const h = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(); return (h?.sessions ?? []).some((x) => x.stationSessionId === stationId); }
  catch { return false; }
};

const hostsDir = () => path.join(DATA, 'session-hosts');
function hostStatuses() {
  try {
    return fs.readdirSync(hostsDir()).filter((f) => f.endsWith('.json') && !f.endsWith('.ctl.json'))
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(hostsDir(), f), 'utf8')); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
const hostFor = (stationId) => hostStatuses().find((h) => h.stationSessionId === stationId) ?? null;
const hbHas = (hb, tok) => { try { return fs.readFileSync(hb, 'utf8').includes(tok); } catch { return false; } };
const hbBeats = (hb) => { try { return fs.readFileSync(hb, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };

/**
 * One scenario end to end. Starts a session (turn 1 dispatches a background
 * agent), waits for turn-end, DETACHES the socket, writes the phase-2 flag, then
 * samples: was the session still open while phase 2 ran, did the heartbeat reach
 * DONE, and is the CLI process (the fake) alive/dead at the end.
 */
async function runScenario(scenario, { holdMs }) {
  const port = await freePort();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `cs-bug157-${scenario}-`));
  const hb = path.join(WORK, `hb-${scenario}.txt`);
  const flag = path.join(WORK, `flag-${scenario}`);
  try { fs.unlinkSync(hb); } catch {}
  try { fs.unlinkSync(flag); } catch {}
  spawnServer(port, { SCENARIO: scenario, PHASE2_FLAG: flag, HEARTBEAT_FILE: hb, WORK_MS: String(WORK_MS), FAKE_SDK_ID: `fakesdk-${scenario}` });
  if (!(await waitHealth(port))) throw new Error(`${scenario} server never healthy`);
  const pid = await register(port, cwd, `bug157-${scenario}`);

  const c = await openWs(port);
  c.send({ type: 'start', projectId: pid, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' }, prompt: 'go' });
  const ack = await waitEv(c.events, (e) => e.t === 'ack' && e.of === 'start');
  const init = await waitEv(c.events, (e) => e.t === 'session-init');
  if (!ack || !init) throw new Error(`${scenario}: session never initialised`);
  const stationId = ack.stationSessionId;
  if (!(await waitCount(c.events, (e) => e.t === 'turn-end', 1, 60_000))) throw new Error(`${scenario}: turn one never ended`);
  await sleep(600);
  const host = hostFor(stationId);
  const claudePid = host?.claudePid ?? null;

  // DETACH — drop the socket. workLifetime is 'yes' (bgTask on the level) so the
  // server detaches instead of closing; the session stays open for phase 2.
  try { c.ws.close(); } catch {}
  await sleep(1200);
  const openAfterDetach = await sessionOpen(port, stationId);

  // Fire phase 2 — the self-started woken turn / revival / finish.
  fs.writeFileSync(flag, '1');

  // Sample while phase 2 runs. `holdMs` covers the woken/revival heartbeat +
  // margin; for finished/innerframe it covers a couple of fuse windows.
  const deadline = Date.now() + holdMs;
  let openDuringWork = true;
  let sawClosedAt = null;
  while (Date.now() < deadline) {
    const open = await sessionOpen(port, stationId);
    if (!open && sawClosedAt == null) { sawClosedAt = Date.now(); openDuringWork = false; }
    if (hbHas(hb, 'DONE')) break;
    await sleep(500);
  }
  const done = hbHas(hb, 'DONE');
  const beats = hbBeats(hb);

  // For the woken/revival scenarios the session should close CLEANLY once the
  // work is done — give it a window and confirm the reap.
  let closedEventually = !(await sessionOpen(port, stationId));
  const cd = Date.now() + 60_000;
  while (!closedEventually && Date.now() < cd) { closedEventually = !(await sessionOpen(port, stationId)); await sleep(1000); }

  let cliDead = claudePid == null || !pidAlive(claudePid);
  const pd = Date.now() + 30_000;
  while (!cliDead && Date.now() < pd) { cliDead = !pidAlive(claudePid); await sleep(1000); }

  fs.rmSync(cwd, { recursive: true, force: true });
  return { scenario, stationId, claudePid, openAfterDetach, openDuringWork, done, beats, closedEventually, cliDead, closedWhileWorking: sawClosedAt != null && !done };
}

async function main() {
  if (spawnSync('systemd-run', ['--version'], { encoding: 'utf8' }).status !== 0) {
    console.error('FATAL: needs `systemd-run --user` — the survival broker reap is the close under test.');
    process.exitCode = 1; return;
  }
  const ONLY = process.env.ONLY_SCENARIO ? process.env.ONLY_SCENARIO.split(',') : null;
  const want = (s) => !ONLY || ONLY.includes(s);

  if (want('woken')) {
  console.log('\n=== SCENARIO 1: task-notification-woken turn on a detached session (fix A) ===');
  const woken = await runScenario('woken', { holdMs: WORK_MS + 20_000 });
  check('[woken] PRECONDITION: the session DETACHED on the socket drop (background work outlived the turn)', woken.openAfterDetach, woken);
  // THE DISCRIMINATOR (must-FAIL pre-fix): busy is pinned by the woken turn's
  // main-thread frames, so the server does NOT close the session out from under
  // the live turn. Pre-fix busy=false → the fuse fires mid-turn → session closed.
  check('[woken] FIX A: the server did NOT close the live session mid-woken-turn (busy pinned, fuse declined)', woken.openDuringWork, woken);
  // CONTEXT (not a discriminator on DIRECT): the woken turn reached DONE. On a
  // direct survival session the broker's own BUG-043/044 lifetime hold can backstop
  // the kill even when the server wrongly closes, so `done` passes on both arms —
  // the true work-kill is proven on the CONTAINER path (reapExec hard-kill, no
  // broker grace). Reported for evidence the mechanism actually ran.
  check('[woken] the woken turn produced live heartbeat work (mechanism ran; DONE is broker-backstopped on direct)', woken.beats > 0,
    { done: woken.done, beats: woken.beats, closedMidTurn: !woken.openDuringWork });
  check('[woken] NO LEAK: once the woken turn finished the session closed and the CLI was reaped', woken.closedEventually && woken.cliDead, woken);
  }

  if (want('revival')) {
  console.log('\n=== SCENARIO 2: SendMessage revival of a retired agent (fix B2) ===');
  const rev = await runScenario('revival', { holdMs: WORK_MS + 20_000 });
  check('[revival] PRECONDITION: the session detached on the socket drop', rev.openAfterDetach, rev);
  // THE DISCRIMINATOR (must-FAIL pre-fix): the empty level + cleared race-hint mean
  // #revivedTasks is the ONLY signal keeping the session open. Post-fix workLifetime
  // returns 'unknown' → the server keeps it open. Pre-fix the revival is invisible →
  // workLifetime 'no' → the server closes the session while the revival runs.
  check('[revival] FIX B2: the server did NOT close the session while the SendMessage-revived agent ran', rev.openDuringWork, rev);
  check('[revival] the revival produced live heartbeat work (mechanism ran; DONE is broker-backstopped on direct)', rev.beats > 0,
    { done: rev.done, beats: rev.beats, closedMidRun: !rev.openDuringWork });
  check('[revival] NO LEAK: after the revival emitted its own terminal frame the session closed and the CLI was reaped', rev.closedEventually && rev.cliDead, rev);
  }

  if (want('finished')) {
  console.log('\n=== SCENARIO 3: NON-VACUITY — a genuinely finished detached session STILL closes+reaps ===');
  const fin = await runScenario('finished', { holdMs: 75_000 });
  check('[finished] PRECONDITION: the session detached on the socket drop', fin.openAfterDetach, fin);
  check('[finished] the fuse is NOT disabled: a finished session (empty level, nothing unsettled) closed and reaped its CLI', fin.closedEventually && fin.cliDead, fin);
  }

  if (want('innerframe')) {
  console.log('\n=== SCENARIO 4: Fix A classification — inner background frames do NOT pin busy ===');
  const inner = await runScenario('innerframe', { holdMs: 75_000 });
  check('[innerframe] PRECONDITION: the session detached on the socket drop', inner.openAfterDetach, inner);
  check('[innerframe] NO OVER-SUPPRESSION: a finished session emitting ONLY inner (parent_tool_use_id) frames still closed and reaped', inner.closedEventually && inner.cliDead, inner);
  }

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(async () => {
  for (const h of hostStatuses()) {
    for (const p of [h.claudePid, h.hostPid]) { if (p && pidAlive(p)) { try { process.kill(p, 'SIGKILL'); } catch {} } }
  }
  for (const s of servers) { try { process.kill(s.pid, 'SIGTERM'); } catch {} }
  await sleep(1500);
  for (const s of servers) { try { process.kill(s.pid, 'SIGKILL'); } catch {} }
  setTimeout(() => {
    for (const d of [DATA, STORE, WORK]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
    process.exit(process.exitCode ?? 0);
  }, 2000);
});
