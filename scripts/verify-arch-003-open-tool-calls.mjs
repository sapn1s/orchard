#!/usr/bin/env node
/**
 * ARCH-003 (attempt 6) — OWNERSHIP AS A MIRROR OF THE OPEN TOOL CALLS, RESOLVED LAZILY.
 *
 * THE FAILURE CLASS THIS GUARD EXISTS FOR. Five attempts, three independent
 * clean-room BROKEN verdicts, one shape: a side map (`#toolUseOwner`, block.id ->
 * owner) that stored a DERIVED association in advance and reclaimed it by a POLICY
 * rather than by the life of the tool call it described.
 *   - never removed      -> stale owner stamped on an unrelated main-thread task,
 *                           suppressing its genuine death (direction a);
 *   - removed on consume -> a second consumer finds nothing -> fabricated death;
 *   - evicted by size    -> the clean-room `CAP-b` verdict: a LEGITIMATE pending
 *                           association at the oldest end is evicted under load, the
 *                           child then finds no owner, and the sweep FABRICATES a
 *                           death for a live worker's child (direction b).
 *
 * THE DESIGN UNDER TEST. `OpenToolCalls` (src/server/open-tool-calls.ts) mirrors the
 * subagent-issued tool calls that are currently OPEN. Nothing consumes; nothing is
 * evicted; `LiveAgent.owner` is gone. The turn-end sweep RESOLVES ownership at the
 * instant it needs it (`ownerOf(row.toolUseId)`), so the two paired frames may arrive
 * in EITHER ORDER, any number of times, across turn boundaries. Entries are removed
 * only on positive evidence the call ended (its `tool_result`, its id being re-issued,
 * or its owning agent going terminal).
 *
 * MUST-FAIL ON `53a6cff` (recorded in the ticket): scenarios `capload`, `startfirst`
 * and `twice` below each fail on the cap/consume design and pass on this one.
 * Scenarios `reuse` and `multiload` are anti-regressions for the two directions that
 * prior attempts traded against each other.
 *
 * AND THE 6th CLEAN-ROOM VERDICT (scenario `nested`, checks 9a/9b/9c) — the only one
 * of the six that broke a VERDICT rather than the bound. OWNERSHIP IS A CHAIN: a
 * background ROOT dispatches an intermediate agent, the intermediate issues the bash
 * whose lane is still running, the intermediate goes terminal while the root keeps
 * running — and the leaf's record was discarded (by the boundary predicate AND by
 * `ownerEnded` at the terminal frame), ownership resolved null, and the sweep recorded
 * an `unknown` death for live work. MUST-FAIL on `0ba4ce1`: 19/20, exit 1, with (9b)
 * printing `{"leafChildDeaths":["leafChild"]}` while (9a) and (9c) PASSED in the same
 * run — direction (b) isolated with direction (a) held green.
 *
 * THE TWO NON-NEGOTIABLES, asserted in EVERY scenario:
 *   (a) a main-thread task that genuinely died is recorded dead, and cannot be
 *       suppressed by any combination of live background agents;
 *   (b) a child of a still-running background agent is NEVER recorded dead.
 *
 * ENGINE: a scripted fake `claude` via CLAUDE_STATION_CLAUDE_BIN — real server, real
 * bridge, real ClaudeRuntime + SDK; only the model process is scripted.
 * PROVENANCE / HONEST LIMIT: SCRIPTED model frames, like every prior ARCH-003 run. It
 * matters LESS here than for any prior attempt: this design makes no assumption about
 * the relative order of `assistant`, `task_started` and `tool_result` — `startfirst`
 * asserts exactly that — so there is no ordering property left for a real capture to
 * falsify. See the ticket's explore entry.
 *
 * SAFETY: free port, scratch dataDir + store + project cwd; every process killed BY
 * PID. :4317 / the real service / scopes not ours are untouched.
 *
 * Usage: node scripts/verify-arch-003-open-tool-calls.mjs
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-arch003o-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-arch003o-store-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-arch003o-work-'));
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
 * The scripted fake `claude`.
 *   A(parent, id, name, input) — an assistant frame carrying a tool_use block.
 *                                `parent` non-null = a SUBAGENT issued the call.
 *   TR(parent, tuid)           — the matching `user` tool_result (the call ENDED).
 *   TS(task, tu, extra)        — a task_started (a lane for that tool_use id).
 *   BG(tasks)                  — the engine's background level frame.
 * LOAD_N is the number of never-consumed subagent associations used to drive the old
 * design past its 4096-entry cap.
 */
fs.writeFileSync(FAKE, `
import * as readline from 'node:readline';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const SCENARIO = process.env.SCENARIO || 'capload';
const LOAD_N = Number(process.env.LOAD_N || 4200);
const rl = readline.createInterface({ input: process.stdin });
let started = false;
const A = (parent, id, name, input) => say({ type: 'assistant', ...(parent ? { parent_tool_use_id: parent } : {}), message: { model: 'claude-haiku-4-5', content: [ { type: 'tool_use', id, name, input: input || {} } ] } });
const TR = (parent, tuid) => say({ type: 'user', ...(parent ? { parent_tool_use_id: parent } : {}), message: { content: [ { type: 'tool_result', tool_use_id: tuid, content: 'ok' } ] } });
const TS = (task, tu, extra) => say({ type: 'system', subtype: 'task_started', task_id: task, tool_use_id: tu, ...extra });
const BG = (tasks) => say({ type: 'system', subtype: 'background_tasks_changed', tasks });
const TEXT = (t) => say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [ { type: 'text', text: t } ] } });
const RESULT = () => say({ type: 'result', subtype: 'success', total_cost_usd: 0 });
const BASH = (cmd) => ({ task_type: 'local_bash', description: cmd });
const TU = (task, status) => say({ type: 'system', subtype: 'task_updated', task_id: task, patch: { status } });

rl.on('line', (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.type === 'control_request') { say({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }); return; }
  if (m.type !== 'user' || started) return;
  started = true;
  say({ type: 'system', subtype: 'init', session_id: 'fakesdk-' + process.pid, cwd: process.cwd(), model: 'haiku', tools: [], slash_commands: [] });

  if (SCENARIO === 'capload') {
    /*
     * THE CLEAN-ROOM 'CAP-b' SHAPE. A live background worker's LEGITIMATE child
     * association is created FIRST (so it is the OLDEST entry), then LOAD_N newer
     * subagent associations arrive, then the child's task_started lands. Under the
     * 4096-cap design the oldest — the live child's — is evicted and its owner is
     * lost, so the sweep fabricates a death for a live worker's child.
     */
    A(null, 'task_tu_W', 'Task', { subagent_type: 'worker', description: 'bg worker W', run_in_background: true });
    BG([{ task_id: 'workerW', task_type: 'local_agent', description: 'bg worker W' }]);
    TS('workerW', 'task_tu_W', { subagent_type: 'worker', description: 'bg worker W' });
    A('task_tu_W', 'bash_tu_LIVE', 'Bash', { command: 'long child work' }); // OLDEST legit entry
    for (let i = 0; i < LOAD_N; i++) A('task_tu_W', 'load_' + i, 'Bash', { command: 'fg call ' + i });
    TS('liveChild', 'bash_tu_LIVE', BASH('long child work'));               // lands after the load
    A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });                     // main-thread orphan
    TS('mainOrphan', 'fg_tu', BASH('sleep 300'));
    TEXT('DISPATCHED'); RESULT();
    return;
  }

  if (SCENARIO === 'startfirst') {
    /*
     * CONSUMPTION BEFORE THE ASSOCIATION. The child's task_started arrives BEFORE the
     * assistant frame that carries its parentage. Any design that stamps the owner AT
     * task_started has already decided (owner null -> main thread) by the time the
     * truth arrives, and fabricates a death for a live worker's child.
     */
    A(null, 'task_tu_W', 'Task', { subagent_type: 'worker', description: 'bg worker W', run_in_background: true });
    BG([{ task_id: 'workerW', task_type: 'local_agent', description: 'bg worker W' }]);
    TS('workerW', 'task_tu_W', { subagent_type: 'worker', description: 'bg worker W' });
    TS('liveChild', 'bash_tu_LIVE', BASH('long child work'));   // lane FIRST
    A('task_tu_W', 'bash_tu_LIVE', 'Bash', { command: 'long child work' }); // parentage SECOND
    A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });
    TS('mainOrphan', 'fg_tu', BASH('sleep 300'));
    TEXT('DISPATCHED'); RESULT();
    return;
  }

  if (SCENARIO === 'twice') {
    /*
     * THE SAME TOOL CALL CONSUMED TWICE — two lanes echo one tool_use id (the engine
     * re-announcing a lane after a reconnect is the realistic door). A design where
     * task_started DELETES the association serves the first lane and fabricates a
     * death for the second, which is just as alive.
     */
    A(null, 'task_tu_W', 'Task', { subagent_type: 'worker', description: 'bg worker W', run_in_background: true });
    BG([{ task_id: 'workerW', task_type: 'local_agent', description: 'bg worker W' }]);
    TS('workerW', 'task_tu_W', { subagent_type: 'worker', description: 'bg worker W' });
    A('task_tu_W', 'bash_tu_LIVE', 'Bash', { command: 'child work' });
    TS('liveChild', 'bash_tu_LIVE', BASH('child work'));       // first consumer
    TS('liveChild2', 'bash_tu_LIVE', BASH('child work'));      // second consumer, same id
    A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });
    TS('mainOrphan', 'fg_tu', BASH('sleep 300'));
    TEXT('DISPATCHED'); RESULT();
    return;
  }

  if (SCENARIO === 'reuse') {
    /*
     * ANTI-REGRESSION for direction (a): a main-thread bash REUSES a still-open
     * subagent tool_use id. Its genuine death must still be recorded — a stale
     * subagent association must not survive the re-issue.
     */
    A(null, 'task_tu_W', 'Task', { subagent_type: 'worker', description: 'bg worker W', run_in_background: true });
    BG([{ task_id: 'workerW', task_type: 'local_agent', description: 'bg worker W' }]);
    TS('workerW', 'task_tu_W', { subagent_type: 'worker', description: 'bg worker W' });
    A('task_tu_W', 'SHARED', 'Bash', { command: 'echo child' });  // subagent opens SHARED
    A(null, 'SHARED', 'Bash', { command: 'sleep 300' });          // main thread RE-ISSUES SHARED
    TS('mainOrphan', 'SHARED', BASH('sleep 300'));
    TEXT('DISPATCHED'); RESULT();
    return;
  }

  if (SCENARIO === 'multiload') {
    /*
     * THREE live background workers with INTERLEAVED children, under the same heavy
     * association load, with tool_results flowing for the completed calls. Every
     * child must be spared by ITS OWN owner and the main orphan must still die —
     * both non-negotiables at once, under the conditions that broke attempt 5.
     */
    A(null, 'task_tu_1', 'Task', { subagent_type: 'worker', description: 'W1', run_in_background: true });
    A(null, 'task_tu_2', 'Task', { subagent_type: 'worker', description: 'W2', run_in_background: true });
    A(null, 'task_tu_3', 'Task', { subagent_type: 'worker', description: 'W3', run_in_background: true });
    BG([{ task_id: 'w1', task_type: 'local_agent' }, { task_id: 'w2', task_type: 'local_agent' }, { task_id: 'w3', task_type: 'local_agent' }]);
    TS('w1', 'task_tu_1', { subagent_type: 'worker' });
    TS('w2', 'task_tu_2', { subagent_type: 'worker' });
    TS('w3', 'task_tu_3', { subagent_type: 'worker' });
    A('task_tu_1', 'b1', 'Bash', { command: 'c1' });   // three legit entries, all OLD
    A('task_tu_2', 'b2', 'Bash', { command: 'c2' });
    A('task_tu_3', 'b3', 'Bash', { command: 'c3' });
    for (let i = 0; i < LOAD_N; i++) {
      const owner = ['task_tu_1', 'task_tu_2', 'task_tu_3'][i % 3];
      A(owner, 'load_' + i, 'Bash', { command: 'fg call ' + i });
      if (i % 2 === 0) TR(owner, 'load_' + i);        // half of them complete
    }
    A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });
    TS('cb1', 'b1', BASH('c1'));
    TS('mainOrphan', 'fg_tu', BASH('sleep 300'));
    TS('cb2', 'b2', BASH('c2'));
    TS('cb3', 'b3', BASH('c3'));
    TEXT('DISPATCHED'); RESULT();
    return;
  }

  if (SCENARIO === 'resultfirst') {
    /*
     * THE 4th CLEAN-ROOM ORDERING, END TO END. A live background worker floods the
     * stream with calls whose tool_result arrives BEFORE the assistant frame that
     * issued them — the ordering the design CLAIMS to support, and the one under which
     * the end signal used to be discarded so the entry became immortal. Two children ride
     * through it: one genuinely in flight, and one whose early result arrived a whole
     * TURN before its assistant frame. Both non-negotiables are asserted under it.
     */
    A(null, 'task_tu_W', 'Task', { subagent_type: 'worker', description: 'bg worker W', run_in_background: true });
    BG([{ task_id: 'workerW', task_type: 'local_agent', description: 'bg worker W' }]);
    TS('workerW', 'task_tu_W', { subagent_type: 'worker', description: 'bg worker W' });
    for (let i = 0; i < LOAD_N; i++) {                             // result BEFORE assistant
      TR('task_tu_W', 'load_' + i);
      A('task_tu_W', 'load_' + i, 'Bash', { command: 'fg call ' + i });
    }
    TR('task_tu_W', 'bash_tu_STRADDLE');                           // early result, turn 1
    A('task_tu_W', 'bash_tu_LIVE', 'Bash', { command: 'long child work' });
    TS('liveChild', 'bash_tu_LIVE', BASH('long child work'));
    A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });
    TS('mainOrphan', 'fg_tu', BASH('sleep 300'));
    TEXT('DISPATCHED'); RESULT();                                  // sweep #1
    A('task_tu_W', 'bash_tu_STRADDLE', 'Bash', { command: 'straddling child' }); // assistant, turn 2
    TS('straddleChild', 'bash_tu_STRADDLE', BASH('straddling child'));
    A(null, 'fg_tu2', 'Bash', { command: 'sleep 301' });
    TS('mainOrphan2', 'fg_tu2', BASH('sleep 301'));
    TEXT('AGAIN'); RESULT();                                       // sweep #2
    return;
  }

  if (SCENARIO === 'boundarybetween') {
    /*
     * THE 5th CLEAN-ROOM ORDERING, END TO END: a turn boundary falls BETWEEN a call's
     * end and its own issue frame (ended > reap > issued), which used to leave a
     * completed call permanently OPEN. Driven at volume, with a live worker's child
     * riding through it, and then the worker RETIRING WITHOUT A TERMINAL FRAME — it
     * simply drops out of the engine's background level, which is the reclamation
     * route the fix adds (nothing edge-triggered ever arrives for it).
     *
     * Residency itself is deliberately NOT asserted here and cannot be: a resident
     * record's ONLY effect is to spare a lane whose owner is live, so a stale record
     * of a live owner is externally indistinguishable from a live call — which is
     * exactly why the server suite could not see the leak (the 5th verdict's own
     * WHY-UNCOVERED). The bound is asserted on the type, in the growth-bound guard.
     * What THIS proves is that buying the bound cost neither non-negotiable.
     */
    A(null, 'task_tu_W', 'Task', { subagent_type: 'worker', description: 'bg worker W', run_in_background: true });
    BG([{ task_id: 'workerW', task_type: 'local_agent', description: 'bg worker W' }]);
    TS('workerW', 'task_tu_W', { subagent_type: 'worker', description: 'bg worker W' });
    for (let i = 0; i < LOAD_N; i++) TR('task_tu_W', 'load_' + i);   // ends, with nothing open
    A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });
    TS('mainOrphan', 'fg_tu', BASH('sleep 300'));
    TEXT('TURN ONE'); RESULT();                                      // sweep #1 — the reap between
    for (let i = 0; i < LOAD_N; i++) A('task_tu_W', 'load_' + i, 'Bash', { command: 'fg call ' + i });
    A('task_tu_W', 'bash_tu_LIVE', 'Bash', { command: 'long child work' });
    TS('liveChild', 'bash_tu_LIVE', BASH('long child work'));        // genuinely in flight
    A(null, 'fg_tu2', 'Bash', { command: 'sleep 301' });
    TS('mainOrphan2', 'fg_tu2', BASH('sleep 301'));
    TEXT('TURN TWO'); RESULT();                                      // sweep #2
    A('task_tu_W', 'bash_tu_ORPHANED', 'Bash', { command: 'outlives its owner' });
    TS('orphanChild', 'bash_tu_ORPHANED', BASH('outlives its owner'));
    BG([]);                                                          // the worker retires, unseen
    A(null, 'fg_tu3', 'Bash', { command: 'sleep 302' });
    TS('mainOrphan3', 'fg_tu3', BASH('sleep 302'));
    TEXT('TURN THREE'); RESULT();                                    // sweep #3
    return;
  }

  if (SCENARIO === 'nested') {
    /*
     * THE 6th CLEAN-ROOM VERDICT, DRIVEN THROUGH THE REAL BRIDGE — and the reason it
     * is driven here rather than only as a unit case: the verdict's own two
     * adversarial runs were DIRECT unit drives of OpenToolCalls with the verifier
     * supplying a predicate that MODELLED the bridge's, so the bridge's real code
     * path was never executed. This scenario executes it.
     *
     * OWNERSHIP IS A CHAIN. A background ROOT agent dispatches an INTERMEDIATE
     * background agent; the intermediate issues a Bash whose lane is still running;
     * the intermediate then goes terminal while the ROOT KEEPS RUNNING. Every
     * consumer used to ask about the IMMEDIATE owner only, and the intermediate's
     * terminal frame ALSO called ownerEnded, which deleted the leaf's record
     * outright — so ownership resolved null and the sweep recorded an 'unknown'
     * death for a live worker's live child. That is property (b): live work reported
     * dead, the failure BUG-037 is named after, not a residency leak.
     *
     * Turn 2 is the counterweight: the ROOT retires too (it simply leaves the
     * engine's level, no terminal frame), and a second nested leaf must then record
     * its honest death — the chain rule must not spare everything forever.
     */
    A(null, 'task_tu_ROOT', 'Task', { subagent_type: 'worker', description: 'bg ROOT', run_in_background: true });
    BG([{ task_id: 'rootW', task_type: 'local_agent', description: 'bg ROOT' }]);
    TS('rootW', 'task_tu_ROOT', { subagent_type: 'worker', description: 'bg ROOT' });
    A('task_tu_ROOT', 'task_tu_MID', 'Task', { subagent_type: 'worker', description: 'nested MID', run_in_background: true });
    BG([{ task_id: 'rootW', task_type: 'local_agent' }, { task_id: 'midW', task_type: 'local_agent' }]);
    TS('midW', 'task_tu_MID', { subagent_type: 'worker', description: 'nested MID' });
    A('task_tu_MID', 'bash_tu_LEAF', 'Bash', { command: 'nested child work' });
    TS('leafChild', 'bash_tu_LEAF', BASH('nested child work'));
    TU('midW', 'completed');                       // the INTERMEDIATE goes terminal …
    BG([{ task_id: 'rootW', task_type: 'local_agent' }]);   // … the ROOT keeps running
    A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });
    TS('mainOrphan', 'fg_tu', BASH('sleep 300'));
    TEXT('TURN ONE'); RESULT();                    // sweep #1
    A('task_tu_MID', 'bash_tu_LEAF2', 'Bash', { command: 'second nested child' });
    TS('leafChild2', 'bash_tu_LEAF2', BASH('second nested child'));
    BG([]);                                        // the ROOT retires, unseen
    A(null, 'fg_tu2', 'Bash', { command: 'sleep 301' });
    TS('mainOrphan2', 'fg_tu2', BASH('sleep 301'));
    TEXT('TURN TWO'); RESULT();                    // sweep #2
    return;
  }

  if (SCENARIO === 'idreuse') {
    /*
     * THE 7th CLEAN-ROOM VERDICT, DRIVEN THROUGH THE REAL BRIDGE. The verdict's own
     * case was a DIRECT UNIT DRIVE of OpenToolCalls, so this scenario answers the
     * same provenance question the 6th verdict's 'nested' scenario did: the bridge's
     * real code path, its real predicate, no callback of ours.
     *
     * A background ROOT dispatches an intermediate background agent MID; MID issues
     * the bash whose lane is still running; MID goes terminal while the ROOT KEEPS
     * RUNNING (the 6th verdict's configuration, which the chain rule handles) — and
     * then THE MAIN THREAD RE-ISSUES MID'S TOOL_USE ID. On the pre-fix build that
     * deleted MID's record, the leaf's chain truncated from [MID, ROOT] to [MID], the
     * live root became unreachable and the leaf was recorded dead.
     *
     * Both non-negotiables are in the same sweep: the leaf must live (b) AND the
     * main-thread lane that re-used the id must record its own honest death (a) —
     * the direction id reuse broke in attempts 1-3.
     */
    A(null, 'task_tu_ROOT', 'Task', { subagent_type: 'worker', description: 'bg ROOT', run_in_background: true });
    BG([{ task_id: 'rootW', task_type: 'local_agent', description: 'bg ROOT' }]);
    TS('rootW', 'task_tu_ROOT', { subagent_type: 'worker', description: 'bg ROOT' });
    A('task_tu_ROOT', 'task_tu_MID', 'Task', { subagent_type: 'worker', description: 'nested MID', run_in_background: true });
    BG([{ task_id: 'rootW', task_type: 'local_agent' }, { task_id: 'midW', task_type: 'local_agent' }]);
    TS('midW', 'task_tu_MID', { subagent_type: 'worker', description: 'nested MID' });
    A('task_tu_MID', 'bash_tu_LEAF', 'Bash', { command: 'nested child work' });
    TS('leafChild', 'bash_tu_LEAF', BASH('nested child work'));
    TU('midW', 'completed');                                 // the INTERMEDIATE goes terminal …
    BG([{ task_id: 'rootW', task_type: 'local_agent' }]);    // … the ROOT keeps running
    A(null, 'task_tu_MID', 'Bash', { command: 'the main thread RE-USES the id' });
    TS('mainReuse', 'task_tu_MID', BASH('the main thread RE-USES the id'));
    A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });
    TS('mainOrphan', 'fg_tu', BASH('sleep 300'));
    TEXT('TURN ONE'); RESULT();                              // sweep #1
    A('task_tu_MID', 'bash_tu_LEAF2', 'Bash', { command: 'second nested child' });
    TS('leafChild2', 'bash_tu_LEAF2', BASH('second nested child'));
    BG([]);                                                  // the ROOT retires, unseen
    A(null, 'fg_tu2', 'Bash', { command: 'sleep 301' });
    TS('mainOrphan2', 'fg_tu2', BASH('sleep 301'));
    TEXT('TURN TWO'); RESULT();                              // sweep #2
    return;
  }

  if (SCENARIO === 'reservation') {
    /*
     * THE 8th CLEAN-ROOM VERDICT, DRIVEN THROUGH THE REAL BRIDGE — and the combination
     * no prior end-to-end fixture had: CHILD-BEFORE-PARENT ordering, IDENTIFIER REUSE
     * inside that window, and an INTERVENING RECLAMATION, in one stream.
     *
     * The leaf's assistant frame names task_tu_MID as its issuer BEFORE any frame has
     * issued task_tu_MID — so the leaf RESERVES that name. The MAIN THREAD then takes
     * the name for a bash of its own, the turn ends (the reclamation falls INSIDE the
     * window), and only in turn 2 does the ROOT's frame finally issue task_tu_MID.
     *
     * On the pre-fix build the reservation was orphaned by the re-use: the leaf lost its
     * live-root ancestry and was recorded dead at sweep #1 (property (b)), while the
     * main-thread lane that took the id INHERITED the root's ancestry and had its own
     * genuine death suppressed (property (a)). Both, in one sweep, through the bridge's
     * own predicate with no callback of ours.
     *
     * Turn 3 is the counterweight: the ROOT retires and a leaf issued under the (now
     * healed) intermediate records its HONEST death — the fix must not spare forever.
     */
    A(null, 'task_tu_ROOT', 'Task', { subagent_type: 'worker', description: 'bg ROOT', run_in_background: true });
    BG([{ task_id: 'rootW', task_type: 'local_agent', description: 'bg ROOT' }]);
    TS('rootW', 'task_tu_ROOT', { subagent_type: 'worker', description: 'bg ROOT' });
    A('task_tu_MID', 'bash_tu_LEAF', 'Bash', { command: 'child names MID before MID exists' });
    TS('leafChild', 'bash_tu_LEAF', BASH('child names MID before MID exists'));
    A(null, 'task_tu_MID', 'Bash', { command: 'the main thread TAKES the reserved id' });
    TS('mainReuse', 'task_tu_MID', BASH('the main thread TAKES the reserved id'));
    A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });
    TS('mainOrphan', 'fg_tu', BASH('sleep 300'));
    TEXT('TURN ONE'); RESULT();                              // sweep #1 — INSIDE the window
    A('task_tu_ROOT', 'task_tu_MID', 'Task', { subagent_type: 'worker', description: 'the DELAYED issue of MID' });
    TS('mainReuse2', 'task_tu_MID', BASH('the main thread lane lands AFTER the delayed frame'));
    A('task_tu_MID', 'bash_tu_LEAF2', 'Bash', { command: 'second child, root still live' });
    TS('leafChild2', 'bash_tu_LEAF2', BASH('second child, root still live'));
    A(null, 'fg_tu2', 'Bash', { command: 'sleep 301' });
    TS('mainOrphan2', 'fg_tu2', BASH('sleep 301'));
    TEXT('TURN TWO'); RESULT();                              // sweep #2 — root still live
    A('task_tu_MID', 'bash_tu_LEAF3', 'Bash', { command: 'third child, after the root retires' });
    TS('leafChild3', 'bash_tu_LEAF3', BASH('third child, after the root retires'));
    BG([]);                                                  // the ROOT retires, unseen
    A(null, 'fg_tu3', 'Bash', { command: 'sleep 302' });
    TS('mainOrphan3', 'fg_tu3', BASH('sleep 302'));
    TEXT('TURN THREE'); RESULT();                            // sweep #3 — nothing is live
    return;
  }

  if (SCENARIO === 'tworeservations') {
    /*
     * THE 9th CLEAN-ROOM VERDICT, DRIVEN THROUGH THE REAL BRIDGE — the shape the 8th
     * fixture did not construct: the SAME name reserved TWICE, by two different children,
     * with a main-thread re-use BETWEEN the two reservations, and each reservation's own
     * description arriving in a LATER turn (so a reclamation falls between them).
     *
     * The verdict was a DIRECT UNIT DRIVE and said so; it stated that reachability
     * through the real frame protocol was unestablished. This scenario establishes it:
     * the frames below are ordinary assistant / task_started / background_tasks_changed
     * frames, and the defect appears through the bridge's OWN predicate.
     *
     * On a750ec1 the second reservation had nowhere to live — reservations were held one
     * per name — so bash_tu_L2 bound to the MAIN THREAD's generation of task_tu_P,
     * read as a COMPLETE ancestry ending at a dead main-thread bash, and was reclaimed at
     * sweep #2 while ROOT2 (its real ancestor, whose description had not arrived yet) was
     * still on the engine's background level: live work recorded dead. In the same stream
     * the delayed task_tu_P -> ROOT2 description landed on the main thread's own
     * generation, so the lane that re-used the id INHERITED ROOT2's ancestry and its
     * genuine death was suppressed — property (b) and property (a) again, in one run.
     */
    A(null, 'task_tu_R1', 'Task', { subagent_type: 'worker', description: 'bg ROOT1', run_in_background: true });
    A(null, 'task_tu_R2', 'Task', { subagent_type: 'worker', description: 'bg ROOT2', run_in_background: true });
    BG([{ task_id: 'rootR1', task_type: 'local_agent', description: 'bg ROOT1' },
      { task_id: 'rootR2', task_type: 'local_agent', description: 'bg ROOT2' }]);
    TS('rootR1', 'task_tu_R1', { subagent_type: 'worker', description: 'bg ROOT1' });
    TS('rootR2', 'task_tu_R2', { subagent_type: 'worker', description: 'bg ROOT2' });
    A('task_tu_P', 'bash_tu_L1', 'Bash', { command: 'child ONE reserves the name P' });
    TS('leafChild1', 'bash_tu_L1', BASH('child ONE reserves the name P'));
    A(null, 'task_tu_P', 'Bash', { command: 'the main thread RE-USES P between the reservations' });
    TS('mainReuse', 'task_tu_P', BASH('the main thread RE-USES P between the reservations'));
    A('task_tu_P', 'bash_tu_L2', 'Bash', { command: 'child TWO reserves the name P — a second generation' });
    TS('leafChild2', 'bash_tu_L2', BASH('child TWO reserves the name P — a second generation'));
    A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });
    TS('mainOrphan', 'fg_tu', BASH('sleep 300'));
    TEXT('TURN ONE'); RESULT();                       // sweep #1 — BOTH reservations unfilled
    A('task_tu_R1', 'task_tu_P', 'Task', { subagent_type: 'worker', description: 'the FIRST delayed description of P' });
    A(null, 'fg_tu2', 'Bash', { command: 'sleep 301' });
    TS('mainOrphan2', 'fg_tu2', BASH('sleep 301'));
    TEXT('TURN TWO'); RESULT();                       // sweep #2 — L1 filled, L2 STILL waiting
    A('task_tu_R2', 'task_tu_P', 'Task', { subagent_type: 'worker', description: 'the SECOND delayed description of P' });
    A('task_tu_P', 'bash_tu_L3', 'Bash', { command: 'a child issued after both descriptions landed' });
    TS('leafChild3', 'bash_tu_L3', BASH('a child issued after both descriptions landed'));
    A(null, 'fg_tu3', 'Bash', { command: 'sleep 302' });
    TS('mainOrphan3', 'fg_tu3', BASH('sleep 302'));
    TEXT('TURN THREE'); RESULT();                     // sweep #3 — both descriptions in
    BG([]);                                           // BOTH roots retire, no terminal frame
    A('task_tu_P', 'bash_tu_L4', 'Bash', { command: 'a child issued after the roots retire' });
    TS('leafChild4', 'bash_tu_L4', BASH('a child issued after the roots retire'));
    A(null, 'fg_tu4', 'Bash', { command: 'sleep 303' });
    TS('mainOrphan4', 'fg_tu4', BASH('sleep 303'));
    TEXT('TURN FOUR'); RESULT();                      // sweep #4 — nothing is live: honest deaths
    return;
  }

  if (SCENARIO === 'redundantend') {
    /*
     * THE 10th CLEAN-ROOM VERDICT, DRIVEN THROUGH THE REAL BRIDGE. The verdict was a
     * DIRECT UNIT DRIVE and said so — "reachability through the real frame protocol is
     * unproven". This scenario is that reachability question answered as far as it can be
     * answered from this side: the frames below are ordinary assistant / user /
     * task_started / background_tasks_changed frames, and the corruption appears through
     * the bridge's OWN predicate and is visible as a DEATH ROW.
     *
     * (Whether the ENGINE ever emits the second tool_result frame is a separate question, and
     * the honest answer is measured rather than assumed: 0 duplicate tool_result ids and 0
     * repeated tool_use ids across 113,963 real tool calls in 3,663 captured sessions. So
     * this is a state-machine fault reachable by a stream the engine is not known to
     * produce — exactly the status id reuse had for six verdicts before one of them turned
     * out to matter.)
     *
     * THE SEQUENCE. Z is a subagent dispatched by the LIVE root R1, and the leaf runs under
     * Z. Z's own result then arrives TWICE, and the name Z is afterwards re-issued by R3,
     * which has RETIRED. Pre-fix the second, redundant result flipped Z's settled record
     * back to ended-unmatched, the re-issue REWROTE that record's parent from R1 to R3,
     * and the leaf — still running under a LIVE R1 — resolved to a wholly dead ancestry and
     * had its death recorded. Live work reported dead: the BUG-037 failure.
     */
    A(null, 'task_tu_R1', 'Task', { subagent_type: 'worker', description: 'bg ROOT1', run_in_background: true });
    A(null, 'task_tu_R3', 'Task', { subagent_type: 'worker', description: 'bg ROOT3', run_in_background: true });
    BG([{ task_id: 'rootR1', task_type: 'local_agent', description: 'bg ROOT1' },
      { task_id: 'rootR3', task_type: 'local_agent', description: 'bg ROOT3' }]);
    TS('rootR1', 'task_tu_R1', { subagent_type: 'worker', description: 'bg ROOT1' });
    TS('rootR3', 'task_tu_R3', { subagent_type: 'worker', description: 'bg ROOT3' });
    A('task_tu_R1', 'task_tu_Z', 'Task', { subagent_type: 'worker', description: 'the MID agent Z, dispatched by ROOT1' });
    TS('midZ', 'task_tu_Z', { subagent_type: 'worker', description: 'the MID agent Z, dispatched by ROOT1' });
    A('task_tu_Z', 'bash_tu_L1', 'Bash', { command: 'the leaf running under Z' });
    TS('leafChild1', 'bash_tu_L1', BASH('the leaf running under Z'));
    /*
     * ALL OF IT INSIDE ONE TURN, and that is not an accident of layout: the turn-end
     * sweep SETTLES every running row (BUG-030) and the reap then reclaims its record,
     * so a lane is judged at exactly ONE boundary — the first one after its frames. A
     * corruption delivered in a LATER turn than the lane cannot reach any verdict,
     * which is why the first cut of this scenario passed on the broken module.
     */
    TR('task_tu_R1', 'task_tu_Z');                    // Z's result
    TR('task_tu_R1', 'task_tu_Z');                    // THE REDUNDANT SECOND RESULT
    BG([{ task_id: 'rootR1', task_type: 'local_agent', description: 'bg ROOT1' }]);
    TU('rootR3', 'completed');                        // R3 has RETIRED — observed, not running
    A('task_tu_R3', 'task_tu_Z', 'Task', { subagent_type: 'worker', description: 'the name Z RE-ISSUED by the retired ROOT3' });
    A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });
    TS('mainOrphan', 'fg_tu', BASH('sleep 300'));
    TEXT('TURN ONE'); RESULT();                       // sweep #1 — the leaf must STILL be under R1
    A(null, 'fg_tu2', 'Bash', { command: 'sleep 301' });
    TS('mainOrphan2', 'fg_tu2', BASH('sleep 301'));
    TEXT('TURN TWO'); RESULT();                       // sweep #2 — the sweep is demonstrably awake
    return;
  }

  if (SCENARIO === 'residency') {
    /*
     * RESIDENCY, MEASURED RATHER THAN INFERRED (BUG-105's open handoff). A resident
     * record's only external effect is to spare a lane whose owner is live, so every
     * previous pass could only argue reclamation from deaths that did NOT happen —
     * which is precisely why two leak verdicts survived the server suite. The bridge
     * now publishes OpenToolCalls.residency() at each boundary when
     * CLAUDE_STATION_ARCH003_RESIDENCY_LOG is set, so this scenario asserts the
     * TRANSITION directly.
     *
     * Worker W is live and issues calls that will never report a result and never get
     * a lane — records with no end signal of any kind. Worker V stays live throughout
     * with one such call of its own. In turn 2 W goes TERMINAL by frame, which is the
     * liveness input BUG-105 corrected (a retired task leaves the engine's level at
     * its terminal frame). W's records must be GONE at that boundary and V's must NOT
     * be — reclamation that reached V's would be the fabrication direction.
     */
    A(null, 'task_tu_W', 'Task', { subagent_type: 'worker', description: 'bg worker W', run_in_background: true });
    A(null, 'task_tu_V', 'Task', { subagent_type: 'worker', description: 'bg worker V', run_in_background: true });
    BG([{ task_id: 'workerW', task_type: 'local_agent', description: 'bg worker W' },
      { task_id: 'workerV', task_type: 'local_agent', description: 'bg worker V' }]);
    TS('workerW', 'task_tu_W', { subagent_type: 'worker', description: 'bg worker W' });
    TS('workerV', 'task_tu_V', { subagent_type: 'worker', description: 'bg worker V' });
    for (let i = 0; i < 3; i++) A('task_tu_W', 'wcall_' + i, 'Bash', { command: 'no result ever ' + i });
    A('task_tu_V', 'vcall_0', 'Bash', { command: 'V is still working' });
    A('task_tu_V', 'bash_tu_VLIVE', 'Bash', { command: 'V child in flight' });
    TS('vLiveChild', 'bash_tu_VLIVE', BASH('V child in flight'));
    A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });
    TS('mainOrphan', 'fg_tu', BASH('sleep 300'));
    TEXT('TURN ONE'); RESULT();                              // sweep #1 — W and V both live
    TU('workerW', 'completed');                              // W's TERMINAL FRAME
    BG([{ task_id: 'workerV', task_type: 'local_agent', description: 'bg worker V' }]);
    A(null, 'fg_tu2', 'Bash', { command: 'sleep 301' });
    TS('mainOrphan2', 'fg_tu2', BASH('sleep 301'));
    TEXT('TURN TWO'); RESULT();                              // sweep #2 — W retired, V live
    return;
  }

  if (SCENARIO === 'straddle') {
    /*
     * A pending association STRADDLES a turn boundary, under load, with rapid repeated
     * sweeps while frames still arrive. Turn 1 ends with the child's association open
     * and its lane not yet announced; turn 2 announces it. Nothing at a turn boundary
     * may drop a still-open call.
     */
    A(null, 'task_tu_W', 'Task', { subagent_type: 'worker', description: 'bg worker W', run_in_background: true });
    BG([{ task_id: 'workerW', task_type: 'local_agent', description: 'bg worker W' }]);
    TS('workerW', 'task_tu_W', { subagent_type: 'worker', description: 'bg worker W' });
    A('task_tu_W', 'bash_tu_LIVE', 'Bash', { command: 'straddling child' });
    for (let i = 0; i < LOAD_N; i++) { A('task_tu_W', 'load_' + i, 'Bash', { command: 'x' }); TR('task_tu_W', 'load_' + i); }
    RESULT();                                                    // sweep #1 — entry straddles it
    TS('liveChild', 'bash_tu_LIVE', BASH('straddling child'));   // lane announced in turn 2
    A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });
    TS('mainOrphan', 'fg_tu', BASH('sleep 300'));
    TEXT('DISPATCHED'); RESULT();                                // sweep #2
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
const allEnded = (snap) => (snap?.ended ?? []).map((o) => `${o.agentId}:${o.kind}`);

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

/*
 * THE RESIDENCY SEAM (BUG-105's open handoff). Record residency has never been
 * observable from outside the process, so every reclamation claim on this surface has
 * been an INFERENCE from deaths that did not happen — and two clean-room leak verdicts
 * lived in exactly that blind spot. `CLAUDE_STATION_ARCH003_RESIDENCY_LOG` makes the
 * bridge append one `OpenToolCalls.residency()` line per turn boundary. Off unless set.
 */
const residencyLines = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
};

async function runScenario(scenario, prompt, turns = 1, env = {}) {
  const port = await freePort();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `cs-arch003o-${scenario}-`));
  const residencyLog = path.join(WORK, `residency-${scenario}.jsonl`);
  spawnServer(port, { SCENARIO: scenario, CLAUDE_STATION_ARCH003_RESIDENCY_LOG: residencyLog, ...env });
  if (!(await waitHealth(port))) throw new Error(`${scenario} server never healthy`);
  const pid = await register(port, cwd, `arch003o-${scenario}`);
  const s = await startSession(port, pid, prompt);
  await waitEv(s.c.events, (e) => e.t === 'agent-started', 40_000);
  if (!(await waitCount(s.c.events, (e) => e.t === 'turn-end', turns, 60_000))) throw new Error(`${scenario} turns never ended`);
  await sleep(1200);
  const snap = await getRunning(port, s.stationId);
  try { s.c.ws.close(); } catch {}
  fs.rmSync(cwd, { recursive: true, force: true });
  snap.residency = residencyLines(residencyLog);
  return snap;
}

/*
 * THE ONE-BOUNDARY GRACE, CALIBRATED AGAINST THE REAL SESSION STORE (ARCH-003, 11th
 * pass, residual on guarded item 2).
 *
 * The type gives a record whose ancestry is not yet knowable EXACTLY ONE turn boundary
 * of grace (`CallRecord.aged`). A description that arrives LATER than that is judged on
 * a chain that reads complete while its live ancestor was still on its way — an EARLY
 * DEATH, and 16,520 of the reservation corpus's 1,209,888 configurations sit in it. It
 * has been carried as GUARDED across three verdicts on an ARGUMENT: "a
 * `parent_tool_use_id` names an id an EARLIER assistant frame minted, so a description
 * two boundaries late is not a reachable ordering."
 *
 * That argument is now a MEASUREMENT. This scan walks the real captured session store
 * and, for every frame that names an owning call, asks where the frame that MINTS that
 * owner sits relative to it, counting the turn boundaries in between. It also re-takes
 * the id-reuse calibration the `redundantend` scenario's comment quotes, so that number
 * is asserted on this machine's store rather than transcribed from a previous pass.
 *
 * HONEST LIMIT, and it is the reason this is a CALIBRATION and not a proof: the
 * persisted transcript is not the SDK stream the bridge consumes. Ordering in the file
 * is a PROXY for ordering on the wire. It is the closest evidence available while no
 * clean room on this surface has real-CLI capture — see the ticket's PROVENANCE note.
 *
 * VACUITY: a store that is absent or too small SKIPS rather than passing. A check that
 * can only pass is worth nothing, and this ticket has been burned by exactly that.
 */
function scanSessionStore() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) files.push(p);
    }
  };
  try { walk(root); } catch { return null; }
  const out = {
    files: files.length, toolUseBlocks: 0, toolResultBlocks: 0,
    repeatedToolUseIds: 0, duplicateToolResultIds: 0,
    ownerRefs: 0, ownerFrameEarlier: 0, ownerFrameSameLine: 0, ownerFrameLater: 0,
    ownerIdNotInFile: 0, maxBoundariesLate: 0, lateHistogram: {}, examples: [],
  };
  for (const f of files) {
    let lines;
    try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch { continue; }
    const mintTU = new Map(), mintUUID = new Map(), objs = [], boundaries = [];
    const seenTU = new Map(), seenTR = new Map();
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]) { objs.push(null); continue; }
      let o; try { o = JSON.parse(lines[i]); } catch { objs.push(null); continue; }
      objs.push(o);
      if (o.uuid && !mintUUID.has(o.uuid)) mintUUID.set(o.uuid, i);
      const c = o?.message?.content;
      if (Array.isArray(c)) for (const b of c) {
        if (b?.type === 'tool_use' && b.id) {
          out.toolUseBlocks++; seenTU.set(b.id, (seenTU.get(b.id) ?? 0) + 1);
          if (!mintTU.has(b.id)) mintTU.set(b.id, i);
        }
        if (b?.type === 'tool_result' && b.tool_use_id) {
          out.toolResultBlocks++; seenTR.set(b.tool_use_id, (seenTR.get(b.tool_use_id) ?? 0) + 1);
        }
      }
      // A turn boundary: an SDK `result` frame, or a top-level (non-sidechain) user prompt.
      if (o?.type === 'result') boundaries.push(i);
      else if (o?.type === 'user' && o?.isSidechain !== true && !o?.isMeta && typeof o?.message?.content === 'string') boundaries.push(i);
    }
    for (const v of seenTU.values()) if (v > 1) out.repeatedToolUseIds++;
    for (const v of seenTR.values()) if (v > 1) out.duplicateToolResultIds++;
    for (let i = 0; i < objs.length; i++) {
      const o = objs[i];
      if (!o) continue;
      // Every field the transcript uses to name the call that OWNS this frame.
      for (const [id, table] of [
        [o.sourceToolUseID, mintTU], [o.parentToolUseID, mintTU],
        [o.parent_tool_use_id, mintTU], [o.sourceToolAssistantUUID, mintUUID],
      ]) {
        if (!id) continue;
        out.ownerRefs++;
        const m = table.get(id);
        if (m === undefined) { out.ownerIdNotInFile++; continue; }
        if (m < i) { out.ownerFrameEarlier++; continue; }
        if (m === i) { out.ownerFrameSameLine++; continue; }
        out.ownerFrameLater++;
        const late = boundaries.filter((b) => b > i && b < m).length;
        out.lateHistogram[late] = (out.lateHistogram[late] ?? 0) + 1;
        if (late > out.maxBoundariesLate) out.maxBoundariesLate = late;
        if (out.examples.length < 3) out.examples.push({ file: path.basename(f), refLine: i, mintLine: m, boundariesBetween: late });
      }
    }
  }
  return out;
}

const MIN_OWNER_REFS = 1000;   // below this the store cannot falsify anything: SKIP, do not pass.
const MIN_TOOL_CALLS = 10_000;

function storeCalibration() {
  const s = scanSessionStore();
  if (!s || s.ownerRefs < MIN_OWNER_REFS || s.toolUseBlocks < MIN_TOOL_CALLS) {
    console.log(`  SKIP  (15) REAL-STORE CALIBRATION: no usable ~/.claude/projects on this machine — NOT counted as a pass\n        observed: ${JSON.stringify(s ? { files: s.files, toolUseBlocks: s.toolUseBlocks, ownerRefs: s.ownerRefs, needed: { ownerRefs: MIN_OWNER_REFS, toolCalls: MIN_TOOL_CALLS } } : { store: 'absent' })}`);
    return;
  }
  check('(15) NO DESCRIPTION IN THE REAL STORE IS EVEN ONE TURN BOUNDARY LATE: for every frame naming an owning call, the frame that MINTS that owner is counted against the turn boundaries between them. The owner frame is almost always EARLIER; where it is later it is later WITHIN THE SAME TURN. `maxBoundariesLate` is 0, so the one-boundary grace exceeds the worst ordering this machine has ever recorded by a full boundary — the guarded "description more than one boundary late" is a corpus ordering, not an observed one. This is the NUMBER a later pass compares against; it is a calibration, not a proof (the transcript is a proxy for the wire)',
    s.maxBoundariesLate === 0,
    { files: s.files, ownerRefs: s.ownerRefs, earlier: s.ownerFrameEarlier, later: s.ownerFrameLater, ownerIdNotInFile: s.ownerIdNotInFile, maxBoundariesLate: s.maxBoundariesLate, lateHistogram: s.lateHistogram, examples: s.examples });
  check('(15b) AND THE ID-REUSE CALIBRATION IS RE-TAKEN ON THIS MACHINE rather than transcribed: the repeat that the 10th verdict rode in on has still never been emitted — no `tool_use` id appears twice, and no `tool_use_id` is answered by two `tool_result` blocks, anywhere in the store. The type must hold on its own terms regardless (the `redundantend` scenario above proves it does); this bounds how much the field has ever exercised it',
    s.repeatedToolUseIds === 0 && s.duplicateToolResultIds === 0,
    { files: s.files, toolUseBlocks: s.toolUseBlocks, toolResultBlocks: s.toolResultBlocks, repeatedToolUseIds: s.repeatedToolUseIds, duplicateToolResultIds: s.duplicateToolResultIds });
}

async function main() {
  storeCalibration();

  // ---- CAPLOAD — the clean-room CAP-b must-FAIL. ----
  const cl = await runScenario('capload', 'a legitimate pending association under heavy load from other associations');
  check('(1b) LIVE CHILD UNDER LOAD IS NOT KILLED: a live background worker\'s child, whose association was the OLDEST when 4200 newer ones arrived, records NO death (FAILS on 53a6cff — oldest-first eviction dropped the legit entry and the sweep fabricated `liveChild:unknown`)',
    deathsForId(cl, 'liveChild').length === 0,
    { liveChildDeaths: deathsForId(cl, 'liveChild').map((o) => o.agentId), allEnded: allEnded(cl) });
  check('(1a) MAIN ORPHAN STILL DIES under the same load: no combination of live background agents suppresses a genuine main-thread death',
    deathsForId(cl, 'mainOrphan').length === 1,
    { mainOrphanDeaths: deathsForId(cl, 'mainOrphan').map((o) => o.agentId) });

  // ---- STARTFIRST — consumption before the association. ----
  const sf = await runScenario('startfirst', 'the child lane is announced BEFORE the frame carrying its parentage');
  check('(2b) ORDER-INDEPENDENT OWNERSHIP: the live child is spared even though its `task_started` arrived BEFORE the assistant frame carrying `parent_tool_use_id` (FAILS on 53a6cff — the owner is stamped AT task_started, so the decision was already made as `main thread`)',
    deathsForId(sf, 'liveChild').length === 0,
    { liveChildDeaths: deathsForId(sf, 'liveChild').map((o) => o.agentId), allEnded: allEnded(sf) });
  check('(2a) MAIN ORPHAN STILL DIES with the paired frames reversed',
    deathsForId(sf, 'mainOrphan').length === 1,
    { mainOrphanDeaths: deathsForId(sf, 'mainOrphan').map((o) => o.agentId) });

  // ---- TWICE — the same tool call consumed twice. ----
  const tw = await runScenario('twice', 'two lanes echo the same tool_use id');
  check('(3b) DOUBLE CONSUMPTION IS SAFE: BOTH lanes echoing one tool_use id are spared (FAILS on 53a6cff — the first `task_started` DELETED the association, so the second fabricated a death)',
    deathsForId(tw, 'liveChild').length === 0 && deathsForId(tw, 'liveChild2').length === 0,
    { liveChild: deathsForId(tw, 'liveChild').length, liveChild2: deathsForId(tw, 'liveChild2').length, allEnded: allEnded(tw) });
  check('(3a) MAIN ORPHAN STILL DIES alongside a double-consumed association',
    deathsForId(tw, 'mainOrphan').length === 1,
    { mainOrphanDeaths: deathsForId(tw, 'mainOrphan').map((o) => o.agentId) });

  // ---- REUSE — anti-regression on the collision (direction a). ----
  const ru = await runScenario('reuse', 'a main-thread bash re-issues a still-open subagent tool_use id');
  check('(4a) ID REUSE CANNOT SUPPRESS: a main-thread bash that re-issues a still-open subagent tool_use id records its own honest death — the re-issue closed the subagent\'s entry',
    deathsForId(ru, 'mainOrphan').length === 1,
    { mainOrphanDeaths: deathsForId(ru, 'mainOrphan').map((o) => o.agentId), allEnded: allEnded(ru) });

  // ---- MULTILOAD — three live owners, interleaved children, heavy load, results flowing. ----
  const ml = await runScenario('multiload', 'three live background agents with interleaved children under load');
  check('(5b) ALL THREE LIVE CHILDREN SPARED under load with tool_results flowing: each spared by ITS OWN owner, none cross-contaminated, none evicted',
    deathsForId(ml, 'cb1').length === 0 && deathsForId(ml, 'cb2').length === 0 && deathsForId(ml, 'cb3').length === 0,
    { cb1: deathsForId(ml, 'cb1').length, cb2: deathsForId(ml, 'cb2').length, cb3: deathsForId(ml, 'cb3').length, allEnded: allEnded(ml) });
  check('(5a) MAIN ORPHAN DIES amid three live workers under load — both non-negotiables in the SAME sweep',
    deathsForId(ml, 'mainOrphan').length === 1,
    { mainOrphanDeaths: deathsForId(ml, 'mainOrphan').map((o) => o.agentId) });

  // ---- STRADDLE — a pending call across a turn boundary, under load, rapid sweeps. ----
  const st = await runScenario('straddle', 'a pending association straddles a turn boundary under load', 2);
  check('(6b) STRADDLING CALL SURVIVES A TURN BOUNDARY under load: the child announced in the NEXT turn is still spared — nothing at a turn boundary drops a still-open call',
    deathsForId(st, 'liveChild').length === 0,
    { liveChildDeaths: deathsForId(st, 'liveChild').map((o) => o.agentId), allEnded: allEnded(st) });
  check('(6a) MAIN ORPHAN DIES across rapid repeated sweeps while frames still arrive',
    deathsForId(st, 'mainOrphan').length === 1,
    { mainOrphanDeaths: deathsForId(st, 'mainOrphan').map((o) => o.agentId) });
  // ---- RESULTFIRST — the 4th clean-room ordering, driven end to end. ----
  const rf = await runScenario('resultfirst', 'a live worker floods the stream with result-before-assistant calls', 2);
  check('(7b) BOTH NON-NEGOTIABLES HOLD UNDER RESULT-BEFORE-ASSISTANT: with 4200 calls whose tool_result preceded their own assistant frame, a genuinely live child is spared AND a child whose early result arrived a whole TURN before its assistant frame is spared too — the ordering that produced the 4th clean-room BROKEN verdict changes neither answer',
    deathsForId(rf, 'liveChild').length === 0 && deathsForId(rf, 'straddleChild').length === 0,
    { liveChild: deathsForId(rf, 'liveChild').length, straddleChild: deathsForId(rf, 'straddleChild').length, allEnded: allEnded(rf) });
  check('(7a) MAIN ORPHANS STILL DIE under that same flood, in BOTH sweeps: no arrangement of result-first frames from live background agents suppresses a genuine main-thread death',
    deathsForId(rf, 'mainOrphan').length === 1 && deathsForId(rf, 'mainOrphan2').length === 1,
    { mainOrphan: deathsForId(rf, 'mainOrphan').length, mainOrphan2: deathsForId(rf, 'mainOrphan2').length });

  // ---- BOUNDARYBETWEEN — the 5th clean-room ordering, driven end to end. ----
  const bb = await runScenario('boundarybetween', 'a turn boundary falls between a call\'s end and its own issue frame', 3);
  check('(8b) NEITHER NON-NEGOTIABLE IS TRADED FOR THE BOUND: with 4200 calls whose end signal arrived a whole TURN BEFORE their issue frame (the 5th clean-room ordering — each one becomes a permanently-open record of a completed call, and the new boundary-liveness reclamation is what removes them), the live worker\'s genuinely in-flight child is still spared',
    deathsForId(bb, 'liveChild').length === 0,
    { liveChildDeaths: deathsForId(bb, 'liveChild').map((o) => o.agentId), allEnded: allEnded(bb) });
  check('(8a) MAIN ORPHANS STILL DIE IN ALL THREE SWEEPS under that ordering — including the sweep in which the owner retires, so the new reclamation cannot be hiding a genuine death',
    deathsForId(bb, 'mainOrphan').length === 1 && deathsForId(bb, 'mainOrphan2').length === 1 && deathsForId(bb, 'mainOrphan3').length === 1,
    { mainOrphan: deathsForId(bb, 'mainOrphan').length, mainOrphan2: deathsForId(bb, 'mainOrphan2').length, mainOrphan3: deathsForId(bb, 'mainOrphan3').length });
  check('(8c) A CHILD THAT OUTLIVES ITS OWNER STILL RECORDS HONESTLY: the worker leaves the engine\'s background level with NO terminal frame ever emitted — the exact condition the new reclamation reads — and its still-open child records its honest death rather than being spared by a stale record',
    deathsForId(bb, 'orphanChild').length === 1,
    { orphanChildDeaths: deathsForId(bb, 'orphanChild').map((o) => o.agentId), allEnded: allEnded(bb) });

  // ---- NESTED — the 6th clean-room verdict, driven through the real bridge. ----
  const ns = await runScenario('nested', 'a background root dispatches an intermediate agent whose child bash outlives it', 2);
  check('(9b) A LEAF UNDER A STILL-RUNNING ROOT IS NEVER RECORDED DEAD: a background ROOT dispatched an intermediate agent, the intermediate issued the bash whose lane is still running, and the intermediate then went TERMINAL while the root kept running. On 0ba4ce1 the terminal intermediate satisfied `#callCannotStillBeInFlight` AND `ownerEnded` deleted the record outright, ownership resolved null, and the sweep FABRICATED the live child\'s death — the 6th clean-room verdict, here through the real bridge and its own predicate rather than a modelled one',
    deathsForId(ns, 'leafChild').length === 0,
    { leafChildDeaths: deathsForId(ns, 'leafChild').map((o) => o.agentId), allEnded: allEnded(ns) });
  check('(9a) MAIN ORPHANS STILL DIE IN BOTH SWEEPS with a two-level ownership chain live: walking the ancestry can only ever spare a lane that HAS an ancestry, and a main-thread lane has none — direction (a) is preserved by construction, not by a second rule',
    deathsForId(ns, 'mainOrphan').length === 1 && deathsForId(ns, 'mainOrphan2').length === 1,
    { mainOrphan: deathsForId(ns, 'mainOrphan').length, mainOrphan2: deathsForId(ns, 'mainOrphan2').length });
  check('(9c) AND THE CHAIN RULE DOES NOT SPARE FOREVER: once the ROOT retires as well (it simply leaves the engine\'s level — no terminal frame), a second nested leaf records its HONEST death. Nothing in the chain is live, so nothing spares it',
    deathsForId(ns, 'leafChild2').length === 1,
    { leafChild2Deaths: deathsForId(ns, 'leafChild2').map((o) => o.agentId), allEnded: allEnded(ns) });

  // ---- IDREUSE — the 7th clean-room verdict, driven through the real bridge. ----
  const ir = await runScenario('idreuse', 'the main thread re-uses a live intermediate agent\'s tool_use id', 2);
  check('(10b) A REUSED ANCESTOR ID CANNOT ORPHAN A LIVE LEAF: a background ROOT dispatched an intermediate, the intermediate issued the bash whose lane is still running and then went terminal, and the MAIN THREAD then re-issued the intermediate\'s tool_use id. On 3cedfb9 that deletion truncated the leaf\'s chain from [MID,ROOT] to [MID], the live root became unreachable and the leaf was recorded dead — the 7th clean-room verdict, here through the real bridge and its own predicate rather than a modelled one',
    deathsForId(ir, 'leafChild').length === 0,
    { leafChildDeaths: deathsForId(ir, 'leafChild').map((o) => o.agentId), allEnded: allEnded(ir) });
  check('(10a) AND THE LANE THAT RE-USED THE ID STILL DIES, IN THE SAME SWEEP: the main-thread bash that took over the id resolves to an EMPTY chain however live the background root is, so its genuine death is recorded — property (b) is not bought with property (a), which is the trade that killed attempts 1-3',
    deathsForId(ir, 'mainReuse').length === 1 && deathsForId(ir, 'mainOrphan').length === 1 && deathsForId(ir, 'mainOrphan2').length === 1,
    { mainReuse: deathsForId(ir, 'mainReuse').length, mainOrphan: deathsForId(ir, 'mainOrphan').length, mainOrphan2: deathsForId(ir, 'mainOrphan2').length });
  check('(10c) AND THE PRESERVED CHAIN STILL DOES NOT SPARE FOREVER: once the ROOT retires too, a second leaf issued under the re-used id records its HONEST death — keeping old generations alive for their descendants is not a blanket amnesty',
    deathsForId(ir, 'leafChild2').length === 1,
    { leafChild2Deaths: deathsForId(ir, 'leafChild2').map((o) => o.agentId), allEnded: allEnded(ir) });

  /* ---- THE 8th VERDICT: the RESERVATION WINDOW, end to end. The combination no prior
   * fixture had — child-before-parent ordering, identifier reuse inside that window, and
   * an intervening reclamation — driven through the real server, the real bridge and its
   * own predicate. Both non-negotiables are asserted at the SAME boundary. ---- */
  const rv = await runScenario('reservation', 'a child reserves its parent\'s id, the main thread re-uses it, and a reclamation falls in between', 3);
  check('(12b) A NAME RESERVED BY A LIVE CHILD SURVIVES A RE-USE AND A RECLAMATION: the leaf named its issuer BEFORE any frame issued that id, the MAIN THREAD then took the id, and a turn boundary fell inside that window. The leaf is under a live background ROOT and records NO death — on ba9039e the re-use orphaned the reservation, the leaf lost its live-root ancestry and its death was recorded here (the 8th clean-room verdict, through the real bridge rather than a unit drive)',
    deathsForId(rv, 'leafChild').length === 0,
    { leafChildDeaths: deathsForId(rv, 'leafChild').map((o) => o.agentId), allEnded: allEnded(rv) });
  check('(12a) AND THE MAIN-THREAD LANE THAT TOOK THE RESERVED ID STILL DIES, IN THE SAME SWEEP: it resolves to an EMPTY chain however live the background root is, so its genuine death is recorded — INCLUDING the second lane whose task_started lands AFTER the delayed frame, which is where the property-(a) half is observable through the bridge: on ba9039e that lane resolved to the delayed frame\'s ancestry (`mainChain:["R"]`) and a LIVE root suppressed its death — property (a) and (b) broke in one sequence, and they are fixed in one',
    deathsForId(rv, 'mainReuse').length === 1 && deathsForId(rv, 'mainReuse2').length === 1
      && deathsForId(rv, 'mainOrphan').length === 1
      && deathsForId(rv, 'mainOrphan2').length === 1 && deathsForId(rv, 'mainOrphan3').length === 1,
    { mainReuse: deathsForId(rv, 'mainReuse').length, mainReuse2: deathsForId(rv, 'mainReuse2').length,
      mainOrphan: deathsForId(rv, 'mainOrphan').length,
      mainOrphan2: deathsForId(rv, 'mainOrphan2').length, mainOrphan3: deathsForId(rv, 'mainOrphan3').length });
  check('(12c) THE DELAYED ISSUE FRAME HEALS THE CHAIN, THROUGH THE REAL BRIDGE: a child issued under the SAME id AFTER the late frame landed resolves to [MID, ROOT] and records no death while the ROOT is live — the reservation was filled by the frame it was waiting for, so the ancestry the child needs is there. On ba9039e the late frame landed on the main thread\'s generation instead, which is how the main lane inherited an ancestry and the child lost one',
    deathsForId(rv, 'leafChild2').length === 0,
    { leafChild2Deaths: deathsForId(rv, 'leafChild2').map((o) => o.agentId), allEnded: allEnded(rv) });
  /*
   * PINNED, NOT ASSERTED AS DESIRABLE. `leafChild3` is issued under the re-used id in
   * turn 3, by which point every record for that id has been reclaimed (the lane that
   * took the id went terminal at sweep #1, so the reap had positive evidence). Its
   * ancestry is therefore not known at sweep #3 and its `kind:'tool'` row is SPARED —
   * the same honest-by-omission degrade the bridge already applies to an owner it has
   * never observed (`#ownerIsUntrackedSubagent`), reached here through the type rather
   * than through a re-attach. The type's one-boundary aging bounds the RECORD and the
   * next row's answer; it cannot un-hold a write the sweep already held, because the row
   * settles at that same boundary (BUG-030). Named here so the 9th pass finds it
   * documented rather than surprising; "does not spare forever" is asserted where it is
   * assertable — (9c)/(10c) above, and (6) of adversarial-arch-003-reservation-window.
   */
  check('(12d) PINNED RESIDUAL — A CHILD OF A REUSED ID WHOSE RECORDS WERE ALL RECLAIMED IS SPARED, HONEST-BY-OMISSION: with nothing left that names its issuer, the third child\'s lane settles with its death HELD rather than written. That is the existing un-observed-owner degrade, not a new amnesty: the record itself is reclaimed at the next boundary and the next row is answered from a complete chain',
    deathsForId(rv, 'leafChild3').length === 0,
    { leafChild3Deaths: deathsForId(rv, 'leafChild3').length, allEnded: allEnded(rv) });

  /* ---- THE 9th VERDICT: ONE NAME, TWO RESERVATIONS, END TO END. The verifier could
   * only drive the unit and said so — "reachability through the real frame protocol is
   * unestablished". It is established here: the same defect, through the real server, the
   * real bridge and its own predicate, with the two roots' liveness coming from the
   * engine's background level rather than a modelled one. ---- */
  const tr = await runScenario('tworeservations', 'one name reserved twice across a main-thread re-use, each description arriving a turn late', 4);
  check('(13b) THE 9th CLEAN-ROOM VERDICT, THROUGH THE REAL BRIDGE: two children reserved the SAME name with a main-thread re-use between them, and each reservation was filled by its OWN description a turn later. NEITHER child is recorded dead while its own root is live — on a750ec1 the second reservation had nowhere to live, bound to the main thread\'s generation, read as an ancestry ending at a dead bash and was reclaimed under a LIVE ROOT2 (the unit drive\'s {"c2":["P"],"survived2":false})',
    deathsForId(tr, 'leafChild1').length === 0 && deathsForId(tr, 'leafChild2').length === 0,
    { leafChild1: deathsForId(tr, 'leafChild1').length, leafChild2: deathsForId(tr, 'leafChild2').length, allEnded: allEnded(tr) });
  check('(13a) AND EVERY MAIN-THREAD LANE IN THAT STREAM STILL DIES, INCLUDING THE ONE THAT RE-USED THE RESERVED NAME: it resolves to an EMPTY chain however live either root is. On a750ec1 the second delayed description landed on the main thread\'s own generation and a live root suppressed this death — property (a) and (b) broke in one stream and are fixed in one',
    deathsForId(tr, 'mainReuse').length === 1 && deathsForId(tr, 'mainOrphan').length === 1
      && deathsForId(tr, 'mainOrphan2').length === 1 && deathsForId(tr, 'mainOrphan3').length === 1
      && deathsForId(tr, 'mainOrphan4').length === 1,
    { mainReuse: deathsForId(tr, 'mainReuse').length, mainOrphan: deathsForId(tr, 'mainOrphan').length,
      mainOrphan2: deathsForId(tr, 'mainOrphan2').length, mainOrphan3: deathsForId(tr, 'mainOrphan3').length,
      mainOrphan4: deathsForId(tr, 'mainOrphan4').length });
  check('(13c) A CHILD ISSUED AFTER BOTH DESCRIPTIONS LANDED REACHES THE LIVE ROOT: the name means the most recently ISSUED generation as an issuer, so the third child resolves through it to ROOT2 and records no death while ROOT2 is live',
    deathsForId(tr, 'leafChild3').length === 0,
    { leafChild3: deathsForId(tr, 'leafChild3').length });
  check('(13d) AND TWO RESERVATIONS ARE NOT A BLANKET AMNESTY: once BOTH roots leave the engine\'s level, a fourth child issued under the same name records its HONEST death — the pairing of reservations to descriptions spares work under a live ancestor and nothing else',
    deathsForId(tr, 'leafChild4').length === 1,
    { leafChild4: deathsForId(tr, 'leafChild4').length, allEnded: allEnded(tr) });

  /* ---- THE 10th VERDICT: A REDUNDANT END SIGNAL, END TO END. The finding was a direct
   * unit drive and its reachability through the real frame protocol was unproven; this is
   * that case built through the real server, the real bridge and its own predicate. ---- */
  const re = await runScenario('redundantend', 'a subagent\'s result arrives twice and its id is then re-issued by a retired root', 2);
  check('(14b) A REDUNDANT `tool_result` CANNOT REDIRECT A LIVE LANE\'S ANCESTRY, THROUGH THE REAL BRIDGE: Z\'s result arrives TWICE and the name Z is then re-issued by a RETIRED root, while the leaf running under Z is still in flight beneath a LIVE ROOT1. The leaf records NO death — on e8e25da the second result flipped Z\'s settled record back to unmatched, the re-issue REWROTE its parent from ROOT1 to the retired ROOT3, and the leaf\'s death was recorded here: live work reported dead (BUG-037\'s failure), reached by a repeat rather than by a reordering',
    deathsForId(re, 'leafChild1').length === 0,
    { leafChild1Deaths: deathsForId(re, 'leafChild1').map((o) => o.agentId), allEnded: allEnded(re) });
  check('(14a) AND THE SWEEP IS NOT MERELY ASLEEP IN THAT RUN: both main-thread orphans — the one in the turn before the duplicate result and the one in the turn after it — record their genuine deaths, so (14b)\'s zero is a decision and not an absence of sweeping',
    deathsForId(re, 'mainOrphan').length === 1 && deathsForId(re, 'mainOrphan2').length === 1,
    { mainOrphan: deathsForId(re, 'mainOrphan').length, mainOrphan2: deathsForId(re, 'mainOrphan2').length, allEnded: allEnded(re) });

  // ---- RESIDENCY — measured through the seam, not inferred from deaths. ----
  const rs = await runScenario('residency', 'residency is asserted directly at each boundary', 2);
  const resLines = rs.residency ?? [];
  const wIds = ['wcall_0', 'wcall_1', 'wcall_2'];
  const openAt = (i) => (resLines[i]?.openIds ?? []);
  check('(11r) RESIDENCY IS NOW OBSERVED, NOT INFERRED: the bridge publishes what is actually resident in the open-call registry at each turn boundary. At sweep #1, with both background workers live, all three of W\'s never-ending calls ARE resident — so the reclamation asserted below is a measured TRANSITION and not an empty file',
    wIds.every((id) => openAt(0).includes(id)) && openAt(0).includes('vcall_0'),
    { boundaries: resLines.length, sweep1: resLines[0] ?? null });
  check('(11r-b) THE RECLAMATION-SIDE INSTANCE BUG-105 COULD ONLY MEASURE INDIRECTLY, MEASURED DIRECTLY: when W reaches a TERMINAL FRAME (the liveness input that fix corrected — a retired task leaves the engine\'s background level), every one of its records is GONE at that boundary, with no tool_result, no re-issue and no lane ever supplied. Previously this could only be argued from deaths that did not happen',
    resLines.length === 2 && wIds.every((id) => !openAt(1).includes(id)),
    { sweep2: resLines[1] ?? null, wCallsStillResident: wIds.filter((id) => openAt(1).includes(id)) });
  check('(11r-c) AND RECLAMATION DID NOT REACH THE LIVE WORKER\'S RECORDS: V is still on the engine\'s level, so its own never-ending call is STILL resident at the same boundary that reclaimed all of W\'s — the reclamation is per-chain liveness, not a sweep of everything old',
    openAt(1).includes('vcall_0'),
    { sweep2OpenIds: openAt(1) });
  check('(11a/b) AND BOTH NON-NEGOTIABLES HELD WHILE RESIDENCY WAS MEASURED: the live worker V\'s in-flight child records no death, and the main-thread orphans of BOTH sweeps record theirs',
    deathsForId(rs, 'vLiveChild').length === 0 && deathsForId(rs, 'mainOrphan').length === 1 && deathsForId(rs, 'mainOrphan2').length === 1,
    { vLiveChildDeaths: deathsForId(rs, 'vLiveChild').length, mainOrphan: deathsForId(rs, 'mainOrphan').length, mainOrphan2: deathsForId(rs, 'mainOrphan2').length, allEnded: allEnded(rs) });

  check('(6c) EVERY local_bash ROW SETTLED off /running (BUG-030 — nothing spins past a `result`)',
    rowsById(st, 'liveChild').length === 0 && rowsById(st, 'mainOrphan').length === 0,
    { liveChild: rowsById(st, 'liveChild').length, mainOrphan: rowsById(st, 'mainOrphan').length });
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
