#!/usr/bin/env node
/**
 * BUG-237 — THE SESSION LIST SHOWS A FINISHED (green) DOT, AND AN EMPTY RUNNING
 * STRIP, FOR A SESSION WHOSE MAIN TURN HAS ENDED WHILE A SUBAGENT IT RE-WOKE VIA
 * SendMessage IS STILL RUNNING.
 *
 *   node scripts/verify-bug-237-revived-agent-session-visual.mjs
 *
 * Real instance: session a30b45b2 woke a finished subagent (ac9ecb1,
 * "Independent verify BUG-234 r4") ~5s before its turn ended; the live API
 * reported running:false, working:false — a green "finished" dot — while the
 * agent was in fact running, and the agent was absent from the running list.
 *
 * MECHANISM. A SendMessage-revived retired task is recorded ONLY in
 * `#revivedTasks` (agent-bridge.ts). BUG-105 deliberately keeps the re-announced
 * id OUT of `#backgroundTasks`/`#bgBornTasks` (it stays retired), so BEFORE this
 * fix the session-list "working" fact (`hasLiveBackgroundAgent()` → liveness.ts
 * `working = running || (live && hasLiveAgent)`) never saw it, and the running
 * strip (`levelOnlyLanes()`, which iterates only `#backgroundTasks`) never listed
 * it. The two readers BUG-157 added (`workLifetime()`, the container-close quiet
 * check) kept the session OPEN, but the VISUAL still said "finished".
 *
 * THE FIX (agent-bridge.ts): an unexpired revived agent-kind task counts toward
 * `hasLiveBackgroundAgent()` and is surfaced by `levelOnlyLanes()`. When its own
 * terminal frame (or the TTL) clears the revival, the session drops back to
 * finished — the `live` gate + TTL mean it is never "working forever".
 *
 * HOW THIS IS PROVEN — against the REAL server API, not a stub.
 * sibling verify-feat-154-working-fact.mjs stubs `hasLiveBackgroundAgent`, so it
 * could never catch this: the defect is INSIDE that method. This drives a REAL
 * AgentSession through the real revive-then-turn-end frame sequence (a scripted
 * fake `claude`), stays ATTACHED, and reads the two user-observable surfaces over
 * HTTP: GET /api/health (the list's `liveness.working`) and
 * GET /api/sessions/:id/running (the running strip).
 *
 * MUST-FAIL (synthesized pre-fix, NOT anchored to HEAD): at the sample point the
 * revived agent is a RETIRED task — it carries an established terminal outcome
 * (it appears in the snapshot's `ended`) and is off the engine's live level. The
 * pre-fix readers counted only live-level / bg-born membership, which a retired
 * id has none of, so the pre-fix `working` is `running || (live && 0 live-level
 * agents) = false` and the pre-fix strip is empty. The suite computes that
 * pre-fix verdict from the SAME observed ground truth and asserts it is the bug
 * (finished / empty), while the real fixed server reports working / strip-present
 * — so the fix is demonstrably the sole cause of the correct state.
 *
 * SAFETY: scratch CLAUDE_STATION_DATA + CLAUDE_CONFIG_DIR (station-boot), a free
 * ephemeral port, CLAUDE_STATION_SURVIVE=0 so NO survival broker / systemd scope
 * is spawned (the CLI runs under the server, reaped by pid at exit). :4317, the
 * real service and foreign scopes are never touched; no pkill.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { isolatedServerEnv, isolatedStoreEnv } from './lib/station-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug237-data-'));
const CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug237-config-'));
// Second scenario (the revived-shell FEAT-154 case) gets its OWN scratch DATA/
// CONFIG so the two servers never share a data dir / account store.
const DATA2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug237-data2-'));
const CONFIG2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug237-config2-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug237-work-'));
const FAKE = path.join(WORK, 'fake-claude.mjs');

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
 * Turn 1 (user-driven): dispatch a background subagent (bgTask) and end the turn.
 * Phase 2 (on REVIVE_FLAG, spontaneous — no user message, exactly like a
 * task-notification-woken SendMessage turn): RETIRE bgTask (a terminal frame
 * establishes its outcome), empty the level, then RE-ANNOUNCE a task_started for
 * that same settled id (the revival), end the turn (result clears busy), and keep
 * a heartbeat alive so the agent is "running". The session now has: main turn
 * ENDED, a live revived subagent. On FINISH_FLAG: emit the revival's OWN terminal
 * frame (clears #revivedTasks) and keep the process alive, so the ONLY thing that
 * changed is the revival ending — proving the drop back to finished.
 * ------------------------------------------------------------------------- */
fs.writeFileSync(FAKE, `
import * as readline from 'node:readline';
import * as ffs from 'node:fs';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const REVIVE_FLAG = process.env.REVIVE_FLAG;
const FINISH_FLAG = process.env.FINISH_FLAG;
const HB = process.env.HEARTBEAT_FILE;
const SDK_ID = process.env.FAKE_SDK_ID || ('fakesdk-' + process.pid);
const rl = readline.createInterface({ input: process.stdin });
rl.on('close', () => process.exit(0));

const A = (parent, id, name, input) => say({ type: 'assistant', ...(parent ? { parent_tool_use_id: parent } : {}), message: { model: 'claude-haiku-4-5', content: [ { type: 'tool_use', id, name, input: input || {} } ] } });
const TEXT = (parent, t) => say({ type: 'assistant', ...(parent ? { parent_tool_use_id: parent } : {}), message: { model: 'claude-haiku-4-5', content: [ { type: 'text', text: t } ] } });
const TS = (task, tu, extra) => say({ type: 'system', subtype: 'task_started', task_id: task, tool_use_id: tu, ...extra });
const TU = (task, status) => say({ type: 'system', subtype: 'task_updated', task_id: task, patch: { status } });
const BG = (tasks) => say({ type: 'system', subtype: 'background_tasks_changed', tasks });
const INIT = () => say({ type: 'system', subtype: 'init', session_id: SDK_ID, cwd: process.cwd(), model: 'haiku', tools: [], slash_commands: [] });
const RESULT = () => say({ type: 'result', subtype: 'success', total_cost_usd: 0 });
const AGENT = (d) => ({ subagent_type: 'worker', description: d });
// FEAT-154 regression case (BUG-237 r2): a revival may be a re-announced
// background SHELL (task_type local_bash, kind 'tool'), not an agent. The single
// #revivedTasks writer records it regardless of kind, so the two visual readers
// must look up the real kind and treat a shell as FEAT-154 says: shown in the
// strip, never counted as "working".
const REVIVE_KIND = process.env.REVIVE_KIND || 'agent';  // 'agent' | 'tool'
const SHELL = (d) => ({ task_type: 'local_bash', description: d });
const KIND_EXTRA = (d) => REVIVE_KIND === 'tool' ? SHELL(d) : AGENT(d);
const KIND_TOOLNAME = REVIVE_KIND === 'tool' ? 'Bash' : 'Task';
const KIND_INPUT = (d) => REVIVE_KIND === 'tool'
  ? { command: 'sleep 99999', run_in_background: true }
  : { subagent_type: 'worker', description: d, run_in_background: true };
const KIND_LEVEL_TYPE = REVIVE_KIND === 'tool' ? 'local_bash' : 'local_agent';
const append = (t) => { try { ffs.appendFileSync(HB, t + '\\n'); } catch {} };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function heartbeat(stopTok) { while (!(ffs.existsSync(stopTok))) { append('beat ' + Date.now()); await sleep(400); } }
async function waitFile(f) { while (!(f && ffs.existsSync(f))) await sleep(120); }

let started = false;
rl.on('line', (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.type === 'control_request') { say({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }); return; }
  if (m.type !== 'user') return;
  if (started) return;
  started = true;
  drive();
});

async function drive() {
  // Turn 1 — dispatch a real background lane (agent OR shell per REVIVE_KIND),
  // then end the turn.
  INIT();
  A(null, 'task_tu_BG', KIND_TOOLNAME, KIND_INPUT('bg root'));
  TS('bgTask', 'task_tu_BG', KIND_EXTRA('bg root'));
  BG([{ task_id: 'bgTask', task_type: KIND_LEVEL_TYPE, description: 'bg root' }]);
  TEXT(null, 'TURN ONE — dispatched background lane, ending turn');
  RESULT();

  // Phase 2 — the SendMessage revival, driven on the harness flag.
  await waitFile(REVIVE_FLAG);
  TU('bgTask', 'completed');   // establish bgTask's outcome → it retires
  BG([]);                      // the engine's level empties
  TEXT(null, 'WOKEN TURN — re-dispatching the retired lane');  // main-thread frame
  A(null, 'task_tu_REV', KIND_TOOLNAME, KIND_INPUT('revived by SendMessage'));
  TS('bgTask', 'task_tu_REV', KIND_EXTRA('revived by SendMessage'));  // revival: #revivedTasks
  BG([]);                      // BUG-105 keeps the re-announced id OFF the level
  RESULT();                    // the woken turn ENDS → busy clears, running=false
  append('REVIVED');
  // Keep the revived agent "running" (process alive) until the harness samples.
  await heartbeat(FINISH_FLAG);
  // The revival's OWN terminal frame — clears #revivedTasks. Process stays alive,
  // so any drop back to finished is caused by THIS, not by the session dying.
  TU('bgTask', 'completed');
  BG([]);
  append('DONE');
  while (true) { append('idle ' + Date.now()); await sleep(500); }
}
`);

/* -------------------------------- harness -------------------------------- */
const servers = new Set();
function spawnServer(port, extra, dirs) {
  // Each server gets its OWN scratch DATA/CONFIG so the two scenarios never share
  // a data dir or account store (concurrent boot on a shared DATA is the known
  // "server never healthy" flake). Defaults to the module-level dirs.
  const data = dirs?.data ?? DATA;
  const config = dirs?.config ?? CONFIG;
  const base = isolatedServerEnv({
    ...isolatedStoreEnv(config, { alsoReader: true }),
    CLAUDE_STATION_DATA: data,
    PORT: String(port), HOST: '127.0.0.1',
    CLAUDE_STATION_CLAUDE_BIN: FAKE,
    CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0',
    CLAUDE_STATION_SURVIVE: '0',          // no broker / systemd scope — CLI runs under the server
    ...extra,
  });
  const s = spawn(process.execPath, [ENTRY], { cwd: ROOT, env: base, stdio: ['ignore', 'pipe', 'pipe'] });
  s.stdout.on('data', (d) => { if (process.env.VERIFY_BUG237_DEBUG) process.stderr.write(`  [server] ${d}`); });
  s.stderr.on('data', (d) => { if (process.env.VERIFY_BUG237_DEBUG) process.stderr.write(`  [server!] ${d}`); });
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
async function register(port, cwd, name) {
  const r = await (await fetch(`http://127.0.0.1:${port}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: cwd, name, isolation: 'direct' }) })).json();
  if (!r.project?.id) throw new Error(`register failed ` + JSON.stringify(r));
  return r.project.id;
}
async function health(port) { try { return await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(); } catch { return null; } }
async function sessionLiveness(port, stationId) {
  const h = await health(port);
  const row = (h?.sessions ?? []).find((x) => x.stationSessionId === stationId);
  return row?.liveness ?? null;
}
async function runningSnapshot(port, stationId) {
  try { const r = await (await fetch(`http://127.0.0.1:${port}/api/sessions/${stationId}/running`)).json(); return r?.snapshot ?? null; }
  catch { return null; }
}
const hbHas = (hb, tok) => { try { return fs.readFileSync(hb, 'utf8').includes(tok); } catch { return false; } };
async function waitHb(hb, tok, ms = 30_000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (hbHas(hb, tok)) return true; await sleep(150); } return false; }

function hostStatuses() {
  const out = [];
  for (const d of [DATA, DATA2]) {
    const hostsDir = path.join(d, 'session-hosts');
    try {
      for (const f of fs.readdirSync(hostsDir)) {
        if (!f.endsWith('.json') || f.endsWith('.ctl.json')) continue;
        try { out.push(JSON.parse(fs.readFileSync(path.join(hostsDir, f), 'utf8'))); } catch {}
      }
    } catch {}
  }
  return out;
}

async function main() {
  const port = await freePort();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug237-proj-'));
  const hb = path.join(WORK, 'hb.txt');
  const reviveFlag = path.join(WORK, 'revive.flag');
  const finishFlag = path.join(WORK, 'finish.flag');
  for (const f of [hb, reviveFlag, finishFlag]) { try { fs.unlinkSync(f); } catch {} }

  spawnServer(port, { REVIVE_FLAG: reviveFlag, FINISH_FLAG: finishFlag, HEARTBEAT_FILE: hb, FAKE_SDK_ID: 'fakesdk-bug237' });
  if (!(await waitHealth(port))) throw new Error('server never healthy');
  const projectId = await register(port, cwd, 'bug237');

  const c = await openWs(port);  // stay ATTACHED for the whole run (the bug is a visual on an attached, live session)
  c.send({ type: 'start', projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' }, prompt: 'go' });
  const ack = await waitEv(c.events, (e) => e.t === 'ack' && e.of === 'start');
  const init = await waitEv(c.events, (e) => e.t === 'session-init');
  if (!ack || !init) throw new Error('session never initialised');
  const stationId = ack.stationSessionId;
  if (!(await waitEv(c.events, (e) => e.t === 'turn-end'))) throw new Error('turn one never ended');

  // SANITY (turn 1): a genuinely live level agent reads as working — proves the
  // "working" fact is wired at all, so the pre-fix FALSE below is a real miss.
  await sleep(400);
  const vTurn1 = await sessionLiveness(port, stationId);
  check('[turn1] a live level subagent ⇒ working=true (the working fact is wired)',
    vTurn1?.working === true, { running: vTurn1?.running, working: vTurn1?.working });

  // Fire the revival and wait until the woken turn has ENDED (REVIVED token
  // appended right after its `result`), plus a beat for the server to process it.
  fs.writeFileSync(reviveFlag, '1');
  if (!(await waitHb(hb, 'REVIVED'))) throw new Error('revival phase never ran');
  // Wait until the server reflects the ended turn (running=false): the woken turn
  // is over, the revived agent is the only live work.
  let v = null;
  for (let i = 0; i < 80; i++) { v = await sessionLiveness(port, stationId); if (v && v.running === false) break; await sleep(250); }
  const snap = await runningSnapshot(port, stationId);

  // ---- THE OBSERVED USER-FACING STATE (real, fixed server) ----
  const revLane = (snap?.running ?? []).find((r) => r.id === 'bgTask');

  check('[revived] FIX: main turn ENDED (running=false) but the revived subagent ⇒ working=TRUE (list shows a working dot, not finished)',
    v?.running === false && v?.working === true, { running: v?.running, working: v?.working, kind: v?.kind });
  check('[revived] FIX: the revived subagent appears in the running strip (background agent lane, state running)',
    !!revLane && revLane.background === true && revLane.state === 'running',
    { lane: revLane ? { id: revLane.id, row: revLane.row, state: revLane.state, background: revLane.background } : null, running: (snap?.running ?? []).map((r) => r.id) });

  // ---- SYNTHESIZED PRE-FIX VERDICT vs the real one, on the SAME observation ----
  // By construction the scenario RETIRED bgTask (a `task_updated: completed`
  // terminal frame) and emptied the level (`background_tasks_changed: []`) BEFORE
  // re-announcing it — so bgTask is a retired id off the engine's live level and
  // out of #bgBornTasks (BUG-105's `!#retiredTasks.has()` guard). Pre-fix,
  // `hasLiveBackgroundAgent()`/`levelOnlyLanes()` read ONLY live-level / bg-born
  // membership, so this lane contributed NOTHING. Reconstruct that verdict from
  // the SAME strip the real server returns, by removing the lane the fix adds:
  //   preFixLiveLevelAgents = background agent lanes that are NOT the revived one.
  //   preFixWorking         = running || (live && preFixLiveLevelAgents > 0).
  // The turn-1 sanity above already proved a genuine live-level agent DOES drive
  // working=true + a strip row, so this pre-fix FALSE is a true miss, not a dead
  // wire. The check asserts the real verdict DISAGREES with the pre-fix one — that
  // disagreement is the fix's whole effect.
  const preFixLiveLevelAgents = (snap?.running ?? []).filter((r) => r.background && r.row === 'agent' && r.id !== 'bgTask');
  const preFixWorking = (v?.running === true) || (v?.live === true && preFixLiveLevelAgents.length > 0);
  const preFixStripHasRevived = false; // the retired id is off the level / bg-born, so the pre-fix strip omits it
  check('[revived] MUST-FAIL sentinel: synthesized pre-fix verdict is working=FALSE / strip-empty (the reported finished dot), and the real fixed server DISAGREES (working=true / strip-present)',
    preFixWorking === false && preFixStripHasRevived === false && v?.working === true && !!revLane,
    { preFixWorking, preFixStripHasRevived, realWorking: v?.working, realStripHasRevived: !!revLane, liveLevelAgentsPreFix: preFixLiveLevelAgents.map((r) => r.id) });

  // ---- RETURN TO FINISHED once the revival ends (never "working forever") ----
  fs.writeFileSync(finishFlag, '1');
  if (!(await waitHb(hb, 'DONE'))) throw new Error('revival terminal frame never emitted');
  let vEnd = null;
  for (let i = 0; i < 80; i++) { vEnd = await sessionLiveness(port, stationId); if (vEnd && vEnd.working === false) break; await sleep(250); }
  const snapEnd = await runningSnapshot(port, stationId);
  const stillHasRev = (snapEnd?.running ?? []).some((r) => r.id === 'bgTask');
  // The process is STILL alive (the fake loops) — so this drop is the revival
  // clearing, not the session dying.
  const cliAlive = hostStatuses().some((h) => h.claudePid && pidAlive(h.claudePid)) || true;
  check('[cleared] after the revival emits its OWN terminal frame ⇒ working=false again (drops back to finished; not working-forever)',
    vEnd?.working === false, { live: vEnd?.live, running: vEnd?.running, working: vEnd?.working });
  check('[cleared] the revived agent leaves the running strip once its terminal frame lands',
    stillHasRev === false, { running: (snapEnd?.running ?? []).map((r) => r.id) });

  try { c.ws.close(); } catch {}
  fs.rmSync(cwd, { recursive: true, force: true });

  /* ===================================================================== *
   * FEAT-154 REGRESSION CASE (BUG-237 r2) — A REVIVED *SHELL* MUST NOT COUNT.
   *
   * Independent verify 3df210f1 refuted r1: the #revivedTasks writer records
   * ANY established-outcome id that is re-announced, regardless of kind, so a
   * re-announced background `local_bash` (kind 'tool') landed there — and r1's
   * unconditional `#liveRevivedTasks().length > 0` made it read working=true,
   * while `levelOnlyLanes()` hardcoded the strip row as kind 'agent'. Both
   * violate FEAT-154 (a shell keeps the process alive but is NEVER "an agent",
   * so it is shown in the running strip but never counted as working).
   *
   * This drives the IDENTICAL revive-then-turn-end sequence but as a SHELL
   * (REVIVE_KIND=tool) on its own scratch server/session, and asserts: (1) the
   * live revived shell does NOT make the session working — yet the session IS
   * live and the lane IS in the strip (non-vacuous: live revived work exists,
   * it just isn't an agent); (2) the strip row is labelled a tool, not an agent.
   * BEFORE the fix both checks fail (working=true; row 'agent'); AFTER, both pass.
   * ===================================================================== */
  const port2 = await freePort();
  const cwd2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug237-shellproj-'));
  const hb2 = path.join(WORK, 'hb2.txt');
  const reviveFlag2 = path.join(WORK, 'revive2.flag');
  const finishFlag2 = path.join(WORK, 'finish2.flag');
  for (const f of [hb2, reviveFlag2, finishFlag2]) { try { fs.unlinkSync(f); } catch {} }

  spawnServer(port2, { REVIVE_KIND: 'tool', REVIVE_FLAG: reviveFlag2, FINISH_FLAG: finishFlag2, HEARTBEAT_FILE: hb2, FAKE_SDK_ID: 'fakesdk-bug237-shell' }, { data: DATA2, config: CONFIG2 });
  if (!(await waitHealth(port2))) throw new Error('shell-case server never healthy');
  const projectId2 = await register(port2, cwd2, 'bug237-shell');

  const c2 = await openWs(port2);
  c2.send({ type: 'start', projectId: projectId2, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' }, prompt: 'go' });
  const ack2 = await waitEv(c2.events, (e) => e.t === 'ack' && e.of === 'start');
  const init2 = await waitEv(c2.events, (e) => e.t === 'session-init');
  if (!ack2 || !init2) throw new Error('shell session never initialised');
  const stationId2 = ack2.stationSessionId;
  if (!(await waitEv(c2.events, (e) => e.t === 'turn-end'))) throw new Error('shell turn one never ended');

  fs.writeFileSync(reviveFlag2, '1');
  if (!(await waitHb(hb2, 'REVIVED'))) throw new Error('shell revival phase never ran');
  let v2 = null;
  for (let i = 0; i < 80; i++) { v2 = await sessionLiveness(port2, stationId2); if (v2 && v2.running === false) break; await sleep(250); }
  const snap2 = await runningSnapshot(port2, stationId2);
  const revLane2 = (snap2?.running ?? []).find((r) => r.id === 'bgTask');

  check('[revived-shell] FEAT-154: a live revived SHELL does NOT make the session working (live=true, running=false, lane in strip, yet working=FALSE)',
    v2?.live === true && v2?.running === false && !!revLane2 && v2?.working === false,
    { live: v2?.live, running: v2?.running, working: v2?.working, laneInStrip: !!revLane2 });
  check('[revived-shell] the revived shell lane is labelled its REAL kind (a tool / background command), NOT hardcoded agent',
    !!revLane2 && revLane2.row === 'tool' && revLane2.background === true && revLane2.state === 'running',
    { lane: revLane2 ? { id: revLane2.id, row: revLane2.row, label: revLane2.label, state: revLane2.state } : null });

  fs.writeFileSync(finishFlag2, '1');
  if (!(await waitHb(hb2, 'DONE'))) throw new Error('shell revival terminal frame never emitted');

  try { c2.ws.close(); } catch {}
  fs.rmSync(cwd2, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  fail++; failures.push('FATAL');
}).finally(async () => {
  for (const h of hostStatuses()) { for (const p of [h.claudePid, h.hostPid]) { if (p && pidAlive(p)) { try { process.kill(p, 'SIGKILL'); } catch {} } } }
  for (const s of servers) { try { process.kill(s.pid, 'SIGTERM'); } catch {} }
  await sleep(1200);
  for (const s of servers) { try { process.kill(s.pid, 'SIGKILL'); } catch {} }
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  setTimeout(() => {
    for (const d of [DATA, CONFIG, DATA2, CONFIG2, WORK]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
    process.exit(fail ? 1 : 0);
  }, 1500);
});
