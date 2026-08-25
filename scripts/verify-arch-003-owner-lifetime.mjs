#!/usr/bin/env node
/**
 * ARCH-003 — THE OWNER MAP'S LIFETIME. Follow-up to the per-row-owner sweep
 * (verify-arch-003-per-row-owner-sweep.mjs) after an independent cross-provider
 * clean-room verdict of BROKEN on 0dcea36.
 *
 * THE DEFECT the clean-room found. `#toolUseOwner` (block.id -> owning agent id)
 * was WRITTEN on every subagent-issued tool_use but never CLEARED for a
 * main-thread frame carrying the same block.id (`agent-bridge.ts:2210` had a set
 * with no else). So a null-owner main-thread `tool_use` that reuses a still-pending
 * subagent tool_use id inherits the STALE subagent owner; `task_started` stamps it;
 * and `#ownerIsLiveBackgroundAgent()` then SUPPRESSES that main lane's genuine
 * death — the over-suppression hole (direction a) reached through a different door.
 * Separately the map was UNBOUNDED: a foreground subagent's tool call gets no
 * `task_started` (real-CLI finding), so its entry is never consumed and leaks over
 * a days-long session.
 *
 * THE FIX under test (`src/server/agent-bridge.ts`):
 *  - the write is BALANCED — a subagent frame sets block.id -> owner; a main-thread
 *    (null-parent) frame DELETES any entry for that block.id (closes the collision);
 *  - `task_started` still CONSUMES (deletes) the entry it stamps (already present);
 *  - a hard CAP evicts the OLDEST entry when the map exceeds a bound — a legit entry
 *    (a background child's) is consumed within its own frame burst so it sits at the
 *    NEWEST end; only never-consumed foreground-subagent leak entries age to oldest.
 *
 * WHAT THIS GUARD PROVES, as real assertions (not comments), the two NON-NEGOTIABLES
 * in EVERY scenario the clean-room said were unexplored:
 *   (a) a genuinely-dead MAIN-THREAD task is recorded dead and CANNOT be suppressed
 *       by any combination of live background agents;
 *   (b) a child of a STILL-RUNNING background agent is never recorded dead.
 * Scenarios: collision (the must-FAIL), rapid repeated sweeps with a pending entry
 * straddling a `result`, an owner dying between the paired frames, nested
 * grandchildren (an owner that is itself a subagent), a task that outlives its owner,
 * and several background agents alive at once with interleaved children.
 *
 * ENGINE: a scripted fake `claude` via CLAUDE_STATION_CLAUDE_BIN — real server, real
 * bridge, real ClaudeRuntime + SDK; only the model process is scripted, so the exact
 * adversarial frame ordering (and the real parent_tool_use_id linkage captured live
 * for this fix) is reproducible with no API cost.
 *
 * PROVENANCE / HONEST LIMIT: like every prior ARCH-003 run these are SCRIPTED model
 * frames through the real server + bridge, not raw real-CLI frames. The collision's
 * suppression harm is only reachable via tool_use id REUSE, which the real CLI is not
 * known to emit; the underlying stale-entry LEAK is reachable WITHOUT reuse (a
 * foreground subagent's tool call) and is what the cap bounds. See the ticket log.
 *
 * SAFETY: free port, scratch dataDir + store + project cwd; every process killed BY
 * PID. :4317 / the real service / scopes not ours are untouched.
 *
 * Usage: node scripts/verify-arch-003-owner-lifetime.mjs
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-arch003l-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-arch003l-store-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-arch003l-work-'));
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

/*
 * The scripted fake `claude`. Each SCENARIO reproduces the real frame ordering:
 * a subagent's tool_use rides an assistant frame carrying the owner's
 * parent_tool_use_id BEFORE the child's own local_bash task_started (which echoes
 * that tool_use id). `A(parent, id, name, input)` = an assistant tool_use frame;
 * `TS(task, tu, extra)` = a task_started; `BG(tasks)` = a level frame.
 */
fs.writeFileSync(FAKE, `
import * as readline from 'node:readline';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const SCENARIO = process.env.SCENARIO || 'collision';
const rl = readline.createInterface({ input: process.stdin });
let started = false;
const A = (parent, id, name, input) => say({ type: 'assistant', ...(parent ? { parent_tool_use_id: parent } : {}), message: { model: 'claude-haiku-4-5', content: [ { type: 'tool_use', id, name, input: input || {} } ] } });
const TS = (task, tu, extra) => say({ type: 'system', subtype: 'task_started', task_id: task, tool_use_id: tu, ...extra });
const BG = (tasks) => say({ type: 'system', subtype: 'background_tasks_changed', tasks });
const TEXT = (t) => say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [ { type: 'text', text: t } ] } });
const RESULT = () => say({ type: 'result', subtype: 'success', total_cost_usd: 0 });
const AG = (st) => ({ task_type: 'local_agent', subagent_type: 'worker', description: st });
const BASH = (cmd) => ({ task_type: 'local_bash', description: cmd });

rl.on('line', (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.type === 'control_request') { say({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }); return; }
  if (m.type !== 'user' || started) return;
  started = true;
  say({ type: 'system', subtype: 'init', session_id: 'fakesdk-' + process.pid, cwd: process.cwd(), model: 'haiku', tools: [], slash_commands: [] });

  if (SCENARIO === 'collision') {
    // Main dispatches a live BACKGROUND worker.
    A(null, 'task_tu_W', 'Task', { subagent_type: 'worker', description: 'bg worker W', run_in_background: true });
    BG([{ task_id: 'workerW', task_type: 'local_agent', description: 'bg worker W' }]);
    TS('workerW', 'task_tu_W', { subagent_type: 'worker', description: 'bg worker W' });
    // The worker issues a FOREGROUND child tool_use with id SHARED — stored as owned
    // by workerW. A foreground subagent tool call gets NO task_started, so this entry
    // is never consumed and stays pending (the leak, and the stale entry).
    A('task_tu_W', 'SHARED', 'Bash', { command: 'echo child' });
    // Main thread now issues its OWN bash REUSING id SHARED (parent null). On the
    // buggy code this does NOT clear the stale workerW owner.
    A(null, 'SHARED', 'Bash', { command: 'sleep 300' });
    TS('mainbash', 'SHARED', BASH('sleep 300'));
    TEXT('DISPATCHED'); RESULT();
    return;
  }

  if (SCENARIO === 'rapidsweep') {
    // Background worker + a child bash whose task_started arrives AFTER a result —
    // the entry must survive the sweep (we must NOT clear #toolUseOwner on result).
    A(null, 'task_tu_W', 'Task', { subagent_type: 'worker', description: 'bg worker W', run_in_background: true });
    BG([{ task_id: 'workerW', task_type: 'local_agent', description: 'bg worker W' }]);
    TS('workerW', 'task_tu_W', { subagent_type: 'worker', description: 'bg worker W' });
    A('task_tu_W', 'bash_tu_C', 'Bash', { command: 'npm run verify:ui' }); // stored, pending
    RESULT();                                                              // rapid sweep #1: entry straddles it
    TS('childbashC', 'bash_tu_C', BASH('npm run verify:ui'));             // consumed AFTER the sweep
    A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });                  // main orphan
    TS('orphanbash', 'fg_tu', BASH('sleep 300'));
    TEXT('DISPATCHED'); RESULT();                                        // sweep #2
    return;
  }

  if (SCENARIO === 'ownerdies') {
    // The owner dies BETWEEN the child's paired frames (assistant, then the owner's
    // terminal frame, then the child's task_started). A second worker stays live.
    A(null, 'task_tu_W', 'Task', { subagent_type: 'worker', description: 'bg worker W', run_in_background: true });
    A(null, 'task_tu_W2', 'Task', { subagent_type: 'worker', description: 'bg worker W2', run_in_background: true });
    BG([{ task_id: 'workerW', task_type: 'local_agent' }, { task_id: 'workerW2', task_type: 'local_agent' }]);
    TS('workerW', 'task_tu_W', { subagent_type: 'worker' });
    TS('workerW2', 'task_tu_W2', { subagent_type: 'worker' });
    A('task_tu_W', 'bash_tu_C', 'Bash', { command: 'work C' });   // child of W: assistant (stored)
    say({ type: 'system', subtype: 'task_updated', task_id: 'workerW', patch: { status: 'completed' } }); // owner W dies HERE
    BG([{ task_id: 'workerW2', task_type: 'local_agent' }]);        // level drops W
    TS('childbashC', 'bash_tu_C', BASH('work C'));                  // child's task_started AFTER owner died
    A('task_tu_W2', 'bash_tu_C2', 'Bash', { command: 'work C2' }); // child of the STILL-LIVE W2
    TS('childbashC2', 'bash_tu_C2', BASH('work C2'));
    A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });            // main orphan
    TS('orphanbash', 'fg_tu', BASH('sleep 300'));
    TEXT('DISPATCHED'); RESULT();
    return;
  }

  if (SCENARIO === 'grandchild') {
    // W (bg agent) -> S (bg sub-subagent) -> G (child bash). G's owner is S, which is
    // itself a live background agent. Plus a main orphan.
    A(null, 'task_tu_W', 'Task', { subagent_type: 'worker', description: 'W', run_in_background: true });
    BG([{ task_id: 'workerW', task_type: 'local_agent' }]);
    TS('workerW', 'task_tu_W', { subagent_type: 'worker' });
    A('task_tu_W', 'task_tu_S', 'Task', { subagent_type: 'worker', description: 'S', run_in_background: true }); // W dispatches S
    BG([{ task_id: 'workerW', task_type: 'local_agent' }, { task_id: 'subS', task_type: 'local_agent' }]);
    TS('subS', 'task_tu_S', { subagent_type: 'worker' });
    A('task_tu_S', 'bash_tu_G', 'Bash', { command: 'grand work' }); // S dispatches child bash G
    TS('childbashG', 'bash_tu_G', BASH('grand work'));
    A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });             // main orphan
    TS('orphanbash', 'fg_tu', BASH('sleep 300'));
    TEXT('DISPATCHED'); RESULT();
    return;
  }

  if (SCENARIO === 'outlives') {
    // A task that OUTLIVES its owner: W dispatches child C, then W retires while C is
    // still running. A second worker W2 with child C2 stays fully live.
    A(null, 'task_tu_W', 'Task', { subagent_type: 'worker', description: 'W', run_in_background: true });
    A(null, 'task_tu_W2', 'Task', { subagent_type: 'worker', description: 'W2', run_in_background: true });
    BG([{ task_id: 'workerW', task_type: 'local_agent' }, { task_id: 'workerW2', task_type: 'local_agent' }]);
    TS('workerW', 'task_tu_W', { subagent_type: 'worker' });
    TS('workerW2', 'task_tu_W2', { subagent_type: 'worker' });
    A('task_tu_W', 'bash_tu_C', 'Bash', { command: 'work C' });
    TS('childbashC', 'bash_tu_C', BASH('work C'));
    A('task_tu_W2', 'bash_tu_C2', 'Bash', { command: 'work C2' });
    TS('childbashC2', 'bash_tu_C2', BASH('work C2'));
    say({ type: 'system', subtype: 'task_updated', task_id: 'workerW', patch: { status: 'completed' } }); // W retires
    BG([{ task_id: 'workerW2', task_type: 'local_agent' }]);        // level drops W; W2 stays live
    A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });            // main orphan
    TS('orphanbash', 'fg_tu', BASH('sleep 300'));
    TEXT('DISPATCHED'); RESULT();
    return;
  }

  if (SCENARIO === 'multi') {
    // Three background workers alive at once with INTERLEAVED children, plus a main
    // orphan. Each child must be spared by ITS OWN owner; the orphan must die.
    A(null, 'task_tu_1', 'Task', { subagent_type: 'worker', description: 'W1', run_in_background: true });
    A(null, 'task_tu_2', 'Task', { subagent_type: 'worker', description: 'W2', run_in_background: true });
    A(null, 'task_tu_3', 'Task', { subagent_type: 'worker', description: 'W3', run_in_background: true });
    BG([{ task_id: 'w1', task_type: 'local_agent' }, { task_id: 'w2', task_type: 'local_agent' }, { task_id: 'w3', task_type: 'local_agent' }]);
    TS('w1', 'task_tu_1', { subagent_type: 'worker' });
    TS('w2', 'task_tu_2', { subagent_type: 'worker' });
    TS('w3', 'task_tu_3', { subagent_type: 'worker' });
    // Interleave the children's paired frames across owners.
    A('task_tu_1', 'b1', 'Bash', { command: 'c1' });
    A('task_tu_2', 'b2', 'Bash', { command: 'c2' });
    TS('cb1', 'b1', BASH('c1'));
    A('task_tu_3', 'b3', 'Bash', { command: 'c3' });
    TS('cb2', 'b2', BASH('c2'));
    A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });   // main orphan interleaved too
    TS('cb3', 'b3', BASH('c3'));
    TS('orphanbash', 'fg_tu', BASH('sleep 300'));
    TEXT('DISPATCHED'); RESULT();
    return;
  }
});
process.stdin.resume();
`);

const servers = new Set();
function spawnServer(port, env) {
  const s = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE,
      CLAUDE_STATION_CLAUDE_BIN: FAKE, CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.add(s);
  return s;
}
async function waitHealth(port) { for (let i = 0; i < 160; i++) { try { await fetch(`http://127.0.0.1:${port}/api/health`); return true; } catch { await sleep(250); } } return false; }
function openWs(port) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); const events = [];
    ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch {} });
    ws.once('open', () => res({ ws, events, send: (o) => ws.send(JSON.stringify(o)) }));
    ws.once('error', rej); ws.on('error', () => {});
  });
}
const waitEv = async (events, pred, ms = 60_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const h = events.find(pred); if (h) return h; await sleep(120); } return null; };
const countEv = (events, pred) => events.filter(pred).length;
const waitCount = async (events, pred, n, ms = 60_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (countEv(events, pred) >= n) return true; await sleep(120); } return false; };
const getRunning = async (port, id) => (await (await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/running`)).json()).snapshot;
const rowsById = (snap, id) => (snap?.running ?? []).filter((r) => r.id === id);
const deathsForId = (snap, id) => (snap?.ended ?? []).filter((o) => o.agentId === id && o.kind === 'unknown');

async function startSession(port, projectId, prompt) {
  const c = await openWs(port);
  c.send({ type: 'start', projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' }, prompt });
  const ack = await waitEv(c.events, (e) => e.t === 'ack' && e.of === 'start');
  if (!ack) throw new Error('no start ack');
  return { c, stationId: ack.stationSessionId };
}
async function register(port, cwd, name) {
  const r = await (await fetch(`http://127.0.0.1:${port}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: cwd, name }) })).json();
  if (!r.project?.id) throw new Error(`register(${name}) failed ` + JSON.stringify(r));
  return r.project.id;
}

// Run one scenario end to end; returns the /running snapshot after the LAST turn.
async function runScenario(scenario, prompt, turns = 1) {
  const port = await freePort();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `cs-arch003l-${scenario}-`));
  spawnServer(port, { SCENARIO: scenario });
  if (!(await waitHealth(port))) throw new Error(`${scenario} server never healthy`);
  const pid = await register(port, cwd, `arch003l-${scenario}`);
  const s = await startSession(port, pid, prompt);
  await waitEv(s.c.events, (e) => e.t === 'agent-started', 30_000);
  if (!(await waitCount(s.c.events, (e) => e.t === 'turn-end', turns, 30_000))) throw new Error(`${scenario} turns never ended`);
  await sleep(900);
  const snap = await getRunning(port, s.stationId);
  try { s.c.ws.close(); } catch {}
  fs.rmSync(cwd, { recursive: true, force: true });
  return snap;
}

async function main() {
  // ---- COLLISION — the must-FAIL. ----
  const col = await runScenario('collision', 'collision: a main-thread bash reuses a pending subagent tool_use id');
  check('(1) COLLISION FIXED (over-suppression, direction a): a MAIN-THREAD bash reusing a still-pending subagent tool_use id records its own honest `unknown` death — the stale subagent owner was CLEARED by the null-parent frame (FAILS on 0dcea36: no else at :2210, so the main lane inherited the live-worker owner and its death was SILENTLY SWALLOWED)',
    deathsForId(col, 'mainbash').length === 1,
    { mainbashDeaths: deathsForId(col, 'mainbash').map((o) => `${o.agentId}:${o.kind}`), allEnded: (col?.ended ?? []).map((o) => `${o.agentId}:${o.kind}`) });

  // ---- RAPID SWEEPS with a pending entry straddling a result. ----
  const rap = await runScenario('rapidsweep', 'rapid repeated sweeps with a child task_started arriving after a result', 2);
  check('(2b) LIVE-OWNER CHILD SPARED across a rapid sweep: the background worker\'s child, whose task_started landed AFTER an intervening `result`, records NO death — the owner entry survived the sweep (proves #toolUseOwner is NOT cleared on result)',
    deathsForId(rap, 'childbashC').length === 0,
    { childDeaths: deathsForId(rap, 'childbashC').map((o) => o.agentId), allEnded: (rap?.ended ?? []).map((o) => `${o.agentId}:${o.kind}`) });
  check('(2a) MAIN ORPHAN DIES across rapid sweeps: the main-thread orphan records its honest death and the worker is not suppressed by any of it',
    deathsForId(rap, 'orphanbash').length === 1,
    { orphanDeaths: deathsForId(rap, 'orphanbash').map((o) => o.agentId) });

  // ---- OWNER DIES between the child's two paired frames. ----
  const od = await runScenario('ownerdies', 'the owner dies between the child\'s paired frames');
  check('(3b) LIVE-OWNER CHILD SPARED while a SIBLING owner died: W2\'s child records NO death even though W (a different worker) retired mid-pair',
    deathsForId(od, 'childbashC2').length === 0,
    { c2Deaths: deathsForId(od, 'childbashC2').map((o) => o.agentId), allEnded: (od?.ended ?? []).map((o) => `${o.agentId}:${o.kind}`) });
  check('(3a) MAIN ORPHAN DIES: recorded honestly regardless of the owner-death timing',
    deathsForId(od, 'orphanbash').length === 1,
    { orphanDeaths: deathsForId(od, 'orphanbash').map((o) => o.agentId) });

  // ---- GRANDCHILD — an owner that is itself a subagent. ----
  const gc = await runScenario('grandchild', 'nested grandchildren: W -> S -> child bash');
  check('(4b) GRANDCHILD SPARED: a child bash whose owner S is ITSELF a live background subagent records NO death (owner attribution works at depth)',
    deathsForId(gc, 'childbashG').length === 0,
    { gDeaths: deathsForId(gc, 'childbashG').map((o) => o.agentId), allEnded: (gc?.ended ?? []).map((o) => `${o.agentId}:${o.kind}`) });
  check('(4a) MAIN ORPHAN DIES alongside a live grandchild chain',
    deathsForId(gc, 'orphanbash').length === 1,
    { orphanDeaths: deathsForId(gc, 'orphanbash').map((o) => o.agentId) });

  // ---- OUTLIVES — a task that outlives its owner. ----
  const ol = await runScenario('outlives', 'a task that outlives its owner');
  check('(5b) LIVE-OWNER CHILD STILL SPARED: W2 is live, so its child records NO death even as W\'s child is being recorded',
    deathsForId(ol, 'childbashC2').length === 0,
    { c2Deaths: deathsForId(ol, 'childbashC2').map((o) => o.agentId), allEnded: (ol?.ended ?? []).map((o) => `${o.agentId}:${o.kind}`) });
  check('(5c) OUTLIVED CHILD RECORDED HONESTLY: a child whose owning background agent has RETIRED records an honest death — a retired owner is not a live parent, so its child is no longer spared (the anti-over-suppression side; NOT a suppression of a main lane)',
    deathsForId(ol, 'childbashC').length === 1,
    { cDeaths: deathsForId(ol, 'childbashC').map((o) => o.agentId) });
  check('(5a) MAIN ORPHAN DIES: unaffected by owner retirement',
    deathsForId(ol, 'orphanbash').length === 1,
    { orphanDeaths: deathsForId(ol, 'orphanbash').map((o) => o.agentId) });

  // ---- MULTI — several background agents alive at once, interleaved children. ----
  const mu = await runScenario('multi', 'several background agents alive at once with interleaved children');
  check('(6b) ALL THREE LIVE-OWNER CHILDREN SPARED with interleaved frames: cb1, cb2, cb3 each spared by its OWN owner, none cross-contaminated',
    deathsForId(mu, 'cb1').length === 0 && deathsForId(mu, 'cb2').length === 0 && deathsForId(mu, 'cb3').length === 0,
    { cb1: deathsForId(mu, 'cb1').length, cb2: deathsForId(mu, 'cb2').length, cb3: deathsForId(mu, 'cb3').length, allEnded: (mu?.ended ?? []).map((o) => `${o.agentId}:${o.kind}`) });
  check('(6a) MAIN ORPHAN DIES amid three live workers: cannot be suppressed by any combination of live background agents',
    deathsForId(mu, 'orphanbash').length === 1,
    { orphanDeaths: deathsForId(mu, 'orphanbash').map((o) => o.agentId) });

  // settle-check on multi: every local_bash row cleared from /running (BUG-030).
  check('(6c) ALL local_bash rows SETTLED off /running (BUG-030 — nothing spins past a result)',
    rowsById(mu, 'cb1').length === 0 && rowsById(mu, 'cb2').length === 0 && rowsById(mu, 'cb3').length === 0 && rowsById(mu, 'orphanbash').length === 0,
    { cb1: rowsById(mu, 'cb1').length, cb2: rowsById(mu, 'cb2').length, cb3: rowsById(mu, 'cb3').length, orphan: rowsById(mu, 'orphanbash').length });
}

let fatal = false;
main().catch((e) => { console.error('FATAL', e.stack ?? e.message); fatal = true; process.exitCode = 1; }).finally(async () => {
  await sleep(400);
  try { for (const f of fs.readdirSync(path.join(DATA, 'session-hosts'))) { try { const h = JSON.parse(fs.readFileSync(path.join(DATA, 'session-hosts', f), 'utf8')); for (const p of [h.claudePid, h.hostPid]) if (p && pidAlive(p)) try { process.kill(p, 'SIGKILL'); } catch {} } catch {} } } catch {}
  for (const s of servers) { if (s?.pid) { try { process.kill(s.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(s.pid, 'SIGKILL'); } catch {} }, 2000).unref(); } }
  setTimeout(() => {
    console.log(`\n${pass}/${pass + fail} checks passed${fatal ? ' (FATAL — the run aborted before completing)' : ''}`);
    if (fail) console.log(`failed: ${failures.join(' | ')}`);
    for (const d of [DATA, WORK, STORE]) fs.rmSync(d, { recursive: true, force: true });
    process.exit((fail || fatal || pass + fail === 0) ? 1 : 0);
  }, 1500);
});
