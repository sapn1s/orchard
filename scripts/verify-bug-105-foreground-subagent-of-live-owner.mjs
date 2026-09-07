#!/usr/bin/env node
/**
 * BUG-105 — A STILL-RUNNING FOREGROUND SUBAGENT OF A LIVE BACKGROUND OWNER IS
 * RECORDED DEAD AT THE MAIN TURN'S END.
 *
 * THE SHAPE. The orchestrator dispatches a worker with `run_in_background: true`
 * (the house pattern). That worker dispatches its OWN subagent in the FOREGROUND
 * (nothing forbids it — `.claude/agents/worker.md` sets no `tools:` restriction).
 * The foreground subagent gets a `kind:'agent'` lane that the engine's background
 * level never lists, because it is not background work — it is a child of work that
 * is. The MAIN thread's `result` then arrives, the turn-end sweep sees a `running`
 * row the level does not vouch for, settles it and writes an `unknown` DEATH — for
 * an agent that is at that instant still working. Probed live on the real bridge
 * during the ARCH-003 6th-verdict build: `allEnded=["fgSub:unknown", …]`.
 *
 * WHY IT SURVIVED ARCH-003. ARCH-003 made the sweep resolve ownership per row and
 * hold the death of a lane whose OWNERSHIP CHAIN holds a live background agent —
 * but only for `kind:'tool'` rows (`a.kind === 'tool' && #ownershipSpares(chain)`),
 * because BUG-096's incident was a child BASH. The row-kind restriction is the bug:
 * ownership liveness is a fact about the CHAIN, not about the row's kind.
 *
 * THE SECOND-ORDER DAMAGE (check 3): because the fg subagent's row was SETTLED, the
 * reap treats its lane as terminal evidence and drops its ownership record. A bash
 * that the same, still-running subagent issues in a LATER turn then has a truncated
 * chain, resolves to no live owner, and has its death fabricated too — the ARCH-003
 * 6th-verdict shape, re-entered through this door.
 *
 * THE TWO NON-NEGOTIABLES, asserted together in every scenario:
 *   (a) a genuine MAIN-THREAD death is recorded and cannot be suppressed by any
 *       arrangement of live agents;
 *   (b) work that is still running is never recorded as dead.
 * Plus the anti-blanket property this fix specifically has to buy nothing with:
 *   (c) a foreground subagent that GENUINELY died is still reported — whether it
 *       died under a live owner (its own terminal frame), or by being abandoned by
 *       the main thread (no chain), or by outliving the owner that dispatched it.
 *
 * ENGINE: a scripted fake `claude` via CLAUDE_STATION_CLAUDE_BIN — real server, real
 * bridge, real ClaudeRuntime + SDK; only the model process is scripted.
 * PROVENANCE / HONEST LIMIT: SCRIPTED model frames, like every run on this surface.
 * The fix depends on no property of real frames — it removes a row-kind restriction
 * from a rule that already reads the ancestry the frames carry.
 *
 * SAFETY: free port, scratch dataDir + store + project cwd; every process killed BY
 * PID. :4317 / the real service / scopes not ours are untouched.
 *
 * Usage: node scripts/verify-bug-105-foreground-subagent-of-live-owner.mjs
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug105-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug105-store-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug105-work-'));
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

fs.writeFileSync(FAKE, `
import * as readline from 'node:readline';
import * as ffs from 'node:fs';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const SCENARIO = process.env.SCENARIO || 'fgsub';
const rl = readline.createInterface({ input: process.stdin });
let started = false;
const A = (parent, id, name, input) => say({ type: 'assistant', ...(parent ? { parent_tool_use_id: parent } : {}), message: { model: 'claude-haiku-4-5', content: [ { type: 'tool_use', id, name, input: input || {} } ] } });
const TR = (parent, tuid) => say({ type: 'user', ...(parent ? { parent_tool_use_id: parent } : {}), message: { content: [ { type: 'tool_result', tool_use_id: tuid, content: 'ok' } ] } });
const TS = (task, tu, extra) => say({ type: 'system', subtype: 'task_started', task_id: task, tool_use_id: tu, ...extra });
const BG = (tasks) => say({ type: 'system', subtype: 'background_tasks_changed', tasks });
const TEXT = (t) => say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [ { type: 'text', text: t } ] } });
const RESULT = () => say({ type: 'result', subtype: 'success', total_cost_usd: 0 });
const BASH = (cmd) => ({ task_type: 'local_bash', description: cmd });
const AGENT = (d) => ({ subagent_type: 'worker', description: d });
const TU = (task, status) => say({ type: 'system', subtype: 'task_updated', task_id: task, patch: { status } });
// The OTHER terminal frame, and the weaker one: a SIGTERM'd CLI emits status "stopped"
// for EVERY still-open task on its way out (probe-verified v2.1.220) — a blanket about
// the session, not a verdict about one task.
const TN = (task, status) => say({ type: 'system', subtype: 'task_notification', task_id: task, status, message: 'task notification' });
const SDK_ID = process.env.FAKE_SDK_ID || ('fakesdk-' + process.pid);
const ROLE = process.env.ROLE || 'pre';

let turnNo = 0;
let awaitingInterrupt = false;
rl.on('line', (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.type === 'control_request') {
    say({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
    /*
     * An INTERRUPT is a second, independent way this bridge's OWN inference settles
     * rows (the sweep marks every running row 'killed' when the turn was
     * interrupted). The real CLI answers an interrupt by ending the turn, so the
     * fake does too — but only once the turn's frames are out, so the control
     * requests the SDK makes at start-up cannot end a turn that never began.
     */
    if (awaitingInterrupt) { awaitingInterrupt = false; say({ type: 'result', subtype: 'error_during_execution', total_cost_usd: 0 }); }
    return;
  }
  if (m.type !== 'user') return;

  /*
   * TURN-DRIVEN SCENARIOS. One user message = one turn, so the harness can take a
   * snapshot AT each boundary instead of only after the last one — which is what
   * the consumer-side question ("does anything accumulate or misreport while a row
   * stays spared past a boundary?") and the repeated-deferral question need.
   */
  if (SCENARIO === 'settleinterrupt') {
    /*
     * A SECOND PATH BY WHICH THIS BRIDGE'S OWN SETTLING COULD REACH RETIREMENT —
     * the INTERRUPT. Scenario 'settlenoretire' drives the ordinary turn-end sweep;
     * an interrupted turn settles every running row 'killed' instead, which reads
     * far more like a real ending and is the likelier candidate for someone to wire
     * into '#retireTask'. If it ever did, the id would be filtered out of every
     * later level frame FOREVER: the engine's own word that the lane is live
     * background work could never be heard again and its children's deaths would be
     * fabricated at every boundary.
     *
     *   turn 1  'intLane' is running; the user INTERRUPTS; the sweep settles it 'killed'
     *   turn 2  the engine's level then says 'intLane' IS live background work, and
     *           the lane issues a child bash — which must be spared
     */
    turnNo += 1;
    if (turnNo === 1) {
      say({ type: 'system', subtype: 'init', session_id: SDK_ID, cwd: process.cwd(), model: 'haiku', tools: [], slash_commands: [] });
      A(null, 'task_tu_INT', 'Task', AGENT('a lane settled by an interrupt, not by a terminal frame'));
      TS('intLane', 'task_tu_INT', AGENT('a lane settled by an interrupt, not by a terminal frame'));
      A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });
      TS('mainOrphan', 'fg_tu', BASH('sleep 300'));
      TEXT('TURN ONE — WAITING TO BE INTERRUPTED');
      awaitingInterrupt = true;        // the interrupt ends this turn
      return;
    }
    BG([{ task_id: 'intLane', task_type: 'local_agent', description: 'the engine says the interrupted lane is live background work' }]);
    A('task_tu_INT', 'bash_tu_INTC', 'Bash', { command: 'child of the interrupted lane' });
    TS('intChild', 'bash_tu_INTC', BASH('child of the interrupted lane'));
    A(null, 'fg_tu2', 'Bash', { command: 'sleep 301' });
    TS('mainOrphan2', 'fg_tu2', BASH('sleep 301'));
    TEXT('TURN TWO'); RESULT();
    return;
  }

  if (SCENARIO === 'ownerterminal' || SCENARIO === 'nestedterminal') {
    turnNo += 1;
    if (turnNo === 1) say({ type: 'system', subtype: 'init', session_id: SDK_ID, cwd: process.cwd(), model: 'haiku', tools: [], slash_commands: [] });

    if (SCENARIO === 'ownerterminal') {
      /*
       * THE CLEAN-ROOM VERDICT'S SHAPE (BUG-105 1st independent verify, property (a)).
       * A background owner retires by EMITTING A TERMINAL FRAME while the engine's
       * background LEVEL still lists it — the level is a snapshot and goes stale, and
       * nothing removed the entry. The sparing rule read that stale membership, so the
       * dead owner's foreground subagent was spared FOREVER: its owed death was never
       * reported and its lane sat running indefinitely.
       *   turn 1  rootW live on the level  → fgSub spared (property (b) — correct)
       *   turn 2  rootW emits 'task_updated completed', LEVEL ENTRY LINGERS
       *           → fgSub's death is now OWED and must be recorded
       *   turn 3  a further boundary → the death must not be recorded a SECOND time
       */
      if (turnNo === 1) {
        A(null, 'task_tu_ROOT', 'Task', { subagent_type: 'worker', description: 'bg ROOT', run_in_background: true });
        BG([{ task_id: 'rootW', task_type: 'local_agent', description: 'bg ROOT' }]);
        TS('rootW', 'task_tu_ROOT', AGENT('bg ROOT'));
        A('task_tu_ROOT', 'task_tu_FG', 'Task', AGENT('fg SUB of a root that retires WITH a terminal frame'));
        TS('fgSub', 'task_tu_FG', AGENT('fg SUB of a root that retires WITH a terminal frame'));
        A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });
        TS('mainOrphan', 'fg_tu', BASH('sleep 300'));
        TEXT('TURN ONE'); RESULT();
        return;
      }
      if (turnNo === 2) {
        TU('rootW', 'completed');   // the owner RETIRES — and the level entry is never withdrawn
        A(null, 'fg_tu2', 'Bash', { command: 'sleep 301' });
        TS('mainOrphan2', 'fg_tu2', BASH('sleep 301'));
        TEXT('TURN TWO'); RESULT();
        return;
      }
      A(null, 'fg_tu3', 'Bash', { command: 'sleep 302' });
      TS('mainOrphan3', 'fg_tu3', BASH('sleep 302'));
      TEXT('TURN THREE'); RESULT();
      return;
    }

    /*
     * THE OTHER HALF, PROVED IN THE SAME FAMILY — tightening the liveness rule must
     * NOT start reporting deaths for work that is genuinely running. A NESTED chain:
     * a live background root → an intermediate agent that emits its own TERMINAL frame
     * → the intermediate's own children (an agent lane and a bash lane) that are still
     * in flight. The intermediate is positively dead; the ROOT is positively live. The
     * children must be spared at every boundary until the root itself retires, and
     * then recorded — deferred across THREE boundaries, never lost.
     */
    if (turnNo === 1) {
      A(null, 'task_tu_ROOT', 'Task', { subagent_type: 'worker', description: 'bg ROOT', run_in_background: true });
      BG([{ task_id: 'rootW', task_type: 'local_agent', description: 'bg ROOT' }]);
      TS('rootW', 'task_tu_ROOT', AGENT('bg ROOT'));
      A('task_tu_ROOT', 'task_tu_MID', 'Task', AGENT('intermediate agent'));
      TS('midSub', 'task_tu_MID', AGENT('intermediate agent'));
      A('task_tu_MID', 'task_tu_LEAF', 'Task', AGENT('leaf subagent of the intermediate'));
      TS('leafSub', 'task_tu_LEAF', AGENT('leaf subagent of the intermediate'));
      A('task_tu_MID', 'bash_tu_LEAF', 'Bash', { command: 'leaf work' });
      TS('leafBash', 'bash_tu_LEAF', BASH('leaf work'));
      TU('midSub', 'completed');   // the INTERMEDIATE retires with a terminal frame
      A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });
      TS('mainOrphan', 'fg_tu', BASH('sleep 300'));
      TEXT('TURN ONE'); RESULT();
      return;
    }
    if (turnNo === 2) {
      A(null, 'fg_tu2', 'Bash', { command: 'sleep 301' });
      TS('mainOrphan2', 'fg_tu2', BASH('sleep 301'));
      TEXT('TURN TWO'); RESULT();
      return;
    }
    TU('rootW', 'completed');      // now the ROOT retires too — nothing in the chain is live
    A(null, 'fg_tu3', 'Bash', { command: 'sleep 302' });
    TS('mainOrphan3', 'fg_tu3', BASH('sleep 302'));
    TEXT('TURN THREE'); RESULT();
    return;
  }

  if (SCENARIO === 'reannounce') {
    /*
     * BUG-105 (5th independent clean-room verdict) — A TASK RE-ANNOUNCED AS LIVE
     * AFTER A SESSION-WIDE TEARDOWN BLANKET.
     *
     * The 4th-verdict fix stopped a row-less blanket from being PROMOTED into a
     * death, but the blanket still wrote the id into the terminal-evidence set,
     * which is the veto both liveness write sites read — the level rebuild and the
     * background-birth tag. Nothing ever withdrew it. So the engine could announce
     * the SAME id as live background work afterwards and the id was filtered out of
     * every level frame forever: starved of the liveness evidence the sparing rule
     * reads, and therefore settleable as dead while it was genuinely working.
     *
     *   turn 1  a teardown blanket names 'reann', for which this bridge has NO row
     *   turn 2  the engine RE-ANNOUNCES 'reann' as live background work — level
     *           frame FIRST, then its task_started, then a foreground subagent of
     *           its own. Neither may be recorded dead at this boundary.
     *   turn 3  a refreshed level frame still lists it: still live, still no deaths
     *   turn 4  'reann' really finishes (task_updated completed) and a STALE level
     *           frame follows it — the finished task must NOT be resurrected, and
     *           its child's owed death must be recorded exactly once.
     */
    turnNo += 1;
    if (turnNo === 1) {
      say({ type: 'system', subtype: 'init', session_id: SDK_ID, cwd: process.cwd(), model: 'haiku', tools: [], slash_commands: [] });
      TN('reann', 'stopped');                                   // the blanket, before any row
      A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });
      TS('mainOrphan', 'fg_tu', BASH('sleep 300'));
      TEXT('TURN ONE'); RESULT();
      return;
    }
    if (turnNo === 2) {
      A(null, 'task_tu_R', 'Task', { subagent_type: 'worker', description: 'the re-announced background root', run_in_background: true });
      // LEVEL FIRST, task_started second: the SDK documents their relative ordering
      // as unspecified, so a fix that only works in one order is not a fix.
      BG([{ task_id: 'reann', task_type: 'local_agent', description: 'the re-announced background root' }]);
      TS('reann', 'task_tu_R', AGENT('the re-announced background root'));
      A('task_tu_R', 'task_tu_RC', 'Task', AGENT('fg SUB of the re-announced root'));
      TS('reannChild', 'task_tu_RC', AGENT('fg SUB of the re-announced root'));
      A(null, 'fg_tu2', 'Bash', { command: 'sleep 301' });
      TS('mainOrphan2', 'fg_tu2', BASH('sleep 301'));
      TEXT('TURN TWO'); RESULT();
      return;
    }
    if (turnNo === 3) {
      BG([{ task_id: 'reann', task_type: 'local_agent', description: 'the re-announced background root' }]);
      A(null, 'fg_tu3', 'Bash', { command: 'sleep 302' });
      TS('mainOrphan3', 'fg_tu3', BASH('sleep 302'));
      TEXT('TURN THREE'); RESULT();
      return;
    }
    TU('reann', 'completed');                                   // the per-task verdict
    BG([{ task_id: 'reann', task_type: 'local_agent', description: 'a level snapshot that went stale' }]);
    A(null, 'fg_tu4', 'Bash', { command: 'sleep 303' });
    TS('mainOrphan4', 'fg_tu4', BASH('sleep 303'));
    TEXT('TURN FOUR'); RESULT();
    return;
  }

  if (SCENARIO === 'notifverdict') {
    /*
     * BUG-105 (6th independent clean-room verdict) — THE TWO DIRECTIONS OF THE SAME
     * SEAM, DRIVEN SIDE BY SIDE, BECAUSE THEY PULL AGAINST EACH OTHER AND EACH HAS
     * ALREADY BEEN A VERDICT ON THIS TICKET.
     *
     * The 5th-verdict fix made a row-less teardown blanket WITHDRAWABLE, which is
     * right. The 4th-verdict fix had made every NOTIFICATION unable to establish an
     * outcome, which is wrong: for a local_bash/tool task the notification is the
     * ONLY terminal frame the CLI ever emits (BUG-030), so a row-less
     * 'status:"completed"' established nothing, left only the withdrawable veto, and
     * a later 'task_started' RESURRECTED a task the engine had positively reported
     * FINISHED (clean-room repro: 'snap2.running = ['bashDone','bashChild']').
     *
     *   turn 1  four row-less terminal frames and one parity pair, no rows at all:
     *             notifDone   / notifDoneB     'completed' — a per-task VERDICT
     *             notifFail                    'failed'    — a per-task VERDICT
     *             notifBlanket / notifBlanketB 'stopped'   — a session-wide BLANKET
     *             parityLate  'task_updated completed' then 'task_notification failed'
     *   turn 2  every one of them is announced/re-announced, in BOTH frame orderings
     *           (level-then-task_started and task_started-then-level), each verdict
     *           lane with a foreground subagent of its own; plus 'parityRow', the
     *           same three frames with the row PRESENT, as the parity reference.
     */
    turnNo += 1;
    if (turnNo === 1) {
      say({ type: 'system', subtype: 'init', session_id: SDK_ID, cwd: process.cwd(), model: 'haiku', tools: [], slash_commands: [] });
      TN('notifDone', 'completed');        // the defect: a positive per-task finish
      TN('notifDoneB', 'completed');       // the same, for the other frame ordering
      TN('notifFail', 'failed');           // the other per-task verdict a notification carries
      TN('notifBlanket', 'stopped');       // a teardown blanket — must stay withdrawable
      TN('notifBlanketB', 'stopped');
      TU('parityLate', 'completed'); TN('parityLate', 'failed');
      A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });
      TS('mainOrphan', 'fg_tu', BASH('sleep 300'));
      TEXT('TURN ONE'); RESULT();
      return;
    }
    // ORDERING A: the level frame first, then the announcement.
    A(null, 'tu_nd', 'Task', { subagent_type: 'worker', description: 'finished, then re-announced', run_in_background: true });
    BG([{ task_id: 'notifDone', task_type: 'local_agent', description: 'finished, then re-announced' },
      { task_id: 'notifBlanket', task_type: 'local_agent', description: 'blanketed, then re-announced' }]);
    TS('notifDone', 'tu_nd', AGENT('finished, then re-announced'));
    A('tu_nd', 'tu_ndc', 'Task', AGENT('fg SUB of the finished-then-re-announced root'));
    TS('notifDoneChild', 'tu_ndc', AGENT('fg SUB of the finished-then-re-announced root'));
    A(null, 'tu_nb', 'Task', { subagent_type: 'worker', description: 'blanketed, then re-announced', run_in_background: true });
    TS('notifBlanket', 'tu_nb', AGENT('blanketed, then re-announced'));
    A('tu_nb', 'tu_nbc', 'Task', AGENT('fg SUB of the blanketed-then-re-announced root'));
    TS('notifBlanketChild', 'tu_nbc', AGENT('fg SUB of the blanketed-then-re-announced root'));
    // ORDERING B: the announcement first, then the level frame.
    A(null, 'tu_ndB', 'Task', { subagent_type: 'worker', description: 'finished, then re-announced (row first)', run_in_background: true });
    TS('notifDoneB', 'tu_ndB', AGENT('finished, then re-announced (row first)'));
    A(null, 'tu_nbB', 'Task', { subagent_type: 'worker', description: 'blanketed, then re-announced (row first)', run_in_background: true });
    TS('notifBlanketB', 'tu_nbB', AGENT('blanketed, then re-announced (row first)'));
    BG([{ task_id: 'notifDone', task_type: 'local_agent', description: 'finished, then re-announced' },
      { task_id: 'notifBlanket', task_type: 'local_agent', description: 'blanketed, then re-announced' },
      { task_id: 'notifDoneB', task_type: 'local_agent', description: 'finished, then re-announced (row first)' },
      { task_id: 'notifBlanketB', task_type: 'local_agent', description: 'blanketed, then re-announced (row first)' }]);
    // The row-less per-task FAILURE finally gets its row.
    A(null, 'tu_nf', 'Task', AGENT('reported failed by notification before its row existed'));
    TS('notifFail', 'tu_nf', AGENT('reported failed by notification before its row existed'));
    // PARITY: the same three frames with the row already present.
    A(null, 'tu_pl', 'Task', AGENT('completed then a failed notification — row late'));
    TS('parityLate', 'tu_pl', AGENT('completed then a failed notification — row late'));
    A(null, 'tu_pr', 'Task', AGENT('completed then a failed notification — row present'));
    TS('parityRow', 'tu_pr', AGENT('completed then a failed notification — row present'));
    TU('parityRow', 'completed'); TN('parityRow', 'failed');
    A(null, 'fg_tu2', 'Bash', { command: 'sleep 301' });
    TS('mainOrphan2', 'fg_tu2', BASH('sleep 301'));
    TEXT('TURN TWO'); RESULT();
    return;
  }

  if (SCENARIO === 'blanketrow') {
    /*
     * BUG-105 (7th independent clean-room verdict) — THE BLANKET LANDING ON A ROW
     * THAT ALREADY EXISTS. The 6th round demoted a teardown blanket only where it
     * had NO row to land on; with a row present it still wrote a per-task 'killed',
     * settled the row and removed it from the strip — including for a foreground
     * subagent whose ancestor was STILL LIVE on the engine's background level.
     * "Demoted" is not the same as "not a verdict".
     *
     * All four directions of the rule are driven in ONE stream, because each has
     * already been a verdict on this ticket and they pull against each other:
     *   (1) NEVER FABRICATES  — 'fgLive' (row present, ancestor LIVE) and
     *       'orphanRow' (row present, no chain at all) are blanketed. Neither may
     *       be settled or written dead BY THE BLANKET.
     *   (2) NEVER STARVES     — 'bgRow' is a level-listed background lane WITH a
     *       row when the blanket lands, then re-declared live in turn two: the
     *       engine's later word must be heard.
     *   (3) A REAL REPORT STILL LANDS — 'verdictRowF'/'verdictRowC' (per-task
     *       notification, row PRESENT) and 'verdictLateF'/'verdictLateC' (the same,
     *       row LATE), plus 'patchRow' (a 'task_updated' death, row present).
     *   (4) A REAL TEARDOWN DEATH IS STILL RECORDED, EXACTLY ONCE — 'orphanRow' has
     *       no live ancestor, so the ORDINARY inference path (the turn-end sweep)
     *       must record it, once, across two boundaries. Buying (1) by losing this
     *       is the mirror failure.
     * 'mainOrphan'/'mainOrphan2' are direction (a)'s control in each sweep.
     */
    turnNo += 1;
    if (turnNo === 1) {
      say({ type: 'system', subtype: 'init', session_id: SDK_ID, cwd: process.cwd(), model: 'haiku', tools: [], slash_commands: [] });
      A(null, 'task_tu_ROOT', 'Task', { subagent_type: 'worker', description: 'bg ROOT', run_in_background: true });
      A(null, 'tu_bgRow', 'Task', { subagent_type: 'worker', description: 'bg lane blanketed WITH a row', run_in_background: true });
      BG([{ task_id: 'rootW', task_type: 'local_agent', description: 'bg ROOT' },
        { task_id: 'bgRow', task_type: 'local_agent', description: 'bg lane blanketed WITH a row' }]);
      TS('rootW', 'task_tu_ROOT', AGENT('bg ROOT'));
      TS('bgRow', 'tu_bgRow', AGENT('bg lane blanketed WITH a row'));
      // (1) THE DEFECT: a blanket on an EXISTING row whose ancestor is LIVE.
      A('task_tu_ROOT', 'task_tu_FGL', 'Task', AGENT('fg SUB, live under a live root'));
      TS('fgLive', 'task_tu_FGL', AGENT('fg SUB, live under a live root'));
      // (1) …and on an existing MAIN-THREAD row, which nothing can spare.
      A(null, 'tu_orphanRow', 'Task', AGENT('main-thread lane blanketed with a row present'));
      TS('orphanRow', 'tu_orphanRow', AGENT('main-thread lane blanketed with a row present'));
      // (3) GENUINE per-task reports, row PRESENT, both outcomes.
      A(null, 'tu_vrf', 'Task', AGENT('per-task failure by notification, row present'));
      TS('verdictRowF', 'tu_vrf', AGENT('per-task failure by notification, row present'));
      A(null, 'tu_vrc', 'Task', AGENT('per-task completion by notification, row present'));
      TS('verdictRowC', 'tu_vrc', AGENT('per-task completion by notification, row present'));
      A(null, 'tu_pr2', 'Task', AGENT('engine-reported failure by patch, row present'));
      TS('patchRow', 'tu_pr2', AGENT('engine-reported failure by patch, row present'));
      // (3) the same reports with the row LATE — the other frame ordering.
      TN('verdictLateF', 'failed');
      TN('verdictLateC', 'completed');
      // THE TEARDOWN: what a SIGTERM'd CLI emits for EVERY still-open task, all at
      // once, interleaved with the genuine per-task verdicts of the same moment.
      TN('fgLive', 'stopped');
      TN('orphanRow', 'stopped');
      TN('bgRow', 'stopped');
      TN('verdictRowF', 'failed');
      TN('verdictRowC', 'completed');
      TU('patchRow', 'failed');
      A(null, 'tu_vlf', 'Task', AGENT('per-task failure by notification, row late'));
      TS('verdictLateF', 'tu_vlf', AGENT('per-task failure by notification, row late'));
      A(null, 'tu_vlc', 'Task', AGENT('per-task completion by notification, row late'));
      TS('verdictLateC', 'tu_vlc', AGENT('per-task completion by notification, row late'));
      A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });
      TS('mainOrphan', 'fg_tu', BASH('sleep 300'));
      TEXT('TURN ONE'); RESULT();                               // sweep #1
      return;
    }
    // TURN TWO. The root is STILL live on the level, so 'fgLive' must be spared a
    // SECOND time (the spare is re-asked every boundary, never a one-shot), and the
    // engine re-declares 'bgRow' live — the never-starves direction, with a row.
    BG([{ task_id: 'rootW', task_type: 'local_agent', description: 'bg ROOT' },
      { task_id: 'bgRow', task_type: 'local_agent', description: 'bg lane blanketed WITH a row' }]);
    TS('bgRow', 'tu_bgRow', AGENT('bg lane blanketed WITH a row'));
    A(null, 'fg_tu2', 'Bash', { command: 'sleep 301' });
    TS('mainOrphan2', 'fg_tu2', BASH('sleep 301'));
    TEXT('TURN TWO'); RESULT();                                 // sweep #2
    return;
  }

  if (started) return;
  started = true;
  say({ type: 'system', subtype: 'init', session_id: SDK_ID, cwd: process.cwd(), model: 'haiku', tools: [], slash_commands: [] });

  if (SCENARIO === 'fgsub') {
    /*
     * THE REPORTED SHAPE, plus its second-order damage and its anti-blanket control,
     * all in ONE stream so the properties are proved in the SAME sweeps.
     *   rootW    — a live BACKGROUND worker (on the engine's level).
     *   fgSub    — rootW's FOREGROUND subagent: a kind:'agent' lane, never on the
     *              level, STILL RUNNING at the main turn's end.
     *   fgSub3   — another of rootW's foreground subagents that GENUINELY FAILS
     *              while rootW is live (its own terminal frame). Must be reported.
     *   gcBash   — a bash fgSub issues in the NEXT turn: it must not be fabricated
     *              either, which needs fgSub's ownership record to survive sweep #1.
     *   mainOrphan/mainOrphan2 — genuine main-thread deaths in both sweeps.
     */
    A(null, 'task_tu_ROOT', 'Task', { subagent_type: 'worker', description: 'bg ROOT', run_in_background: true });
    BG([{ task_id: 'rootW', task_type: 'local_agent', description: 'bg ROOT' }]);
    TS('rootW', 'task_tu_ROOT', AGENT('bg ROOT'));
    A('task_tu_ROOT', 'task_tu_FG', 'Task', AGENT('fg SUB of a live background root'));
    TS('fgSub', 'task_tu_FG', AGENT('fg SUB of a live background root'));
    A('task_tu_ROOT', 'task_tu_FG3', 'Task', AGENT('fg SUB that really dies'));
    TS('fgSub3', 'task_tu_FG3', AGENT('fg SUB that really dies'));
    TU('fgSub3', 'failed');                                     // a GENUINE agent death
    A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });
    TS('mainOrphan', 'fg_tu', BASH('sleep 300'));
    TEXT('TURN ONE'); RESULT();                                 // sweep #1
    A('task_tu_FG', 'bash_tu_GC', 'Bash', { command: 'grandchild work' });
    TS('gcBash', 'bash_tu_GC', BASH('grandchild work'));        // issued AFTER the boundary
    A(null, 'fg_tu2', 'Bash', { command: 'sleep 301' });
    TS('mainOrphan2', 'fg_tu2', BASH('sleep 301'));
    TEXT('TURN TWO'); RESULT();                                 // sweep #2
    return;
  }

  if (SCENARIO === 'agentreuse') {
    /*
     * DIRECTION (a) THROUGH THE NEW ROW CLASS. A MAIN-THREAD Task re-issues a
     * tool_use id that a live background worker's subagent call still has open. The
     * re-issue is itself evidence the earlier call ended, so the main-thread agent
     * lane must have an EMPTY chain and record its own honest death — a stale
     * subagent record must never hand a main-thread AGENT row an ancestor to be
     * spared by, which is exactly the over-suppression hole that broke BUG-096's
     * first fix in the tool-row direction.
     */
    A(null, 'task_tu_ROOT', 'Task', { subagent_type: 'worker', description: 'bg ROOT', run_in_background: true });
    BG([{ task_id: 'rootW', task_type: 'local_agent', description: 'bg ROOT' }]);
    TS('rootW', 'task_tu_ROOT', AGENT('bg ROOT'));
    A('task_tu_ROOT', 'SHARED', 'Task', AGENT('a subagent-issued call holding SHARED'));
    A(null, 'SHARED', 'Task', AGENT('main-thread agent re-issuing SHARED'));
    TS('mainAgent', 'SHARED', AGENT('main-thread agent re-issuing SHARED'));
    A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });
    TS('mainOrphan', 'fg_tu', BASH('sleep 300'));
    TEXT('DISPATCHED'); RESULT();
    return;
  }

  if (SCENARIO === 'terminalfirst') {
    /*
     * THE REGRESSION b0dfaf6 INTRODUCED (BUG-105 follow-up investigation).
     * A terminal report is handled from the FRAME, before the row lookup — deliberately,
     * so a level-listed task this bridge has no row for still retires. But the handler
     * then returned early on 'if (!a) return', so the STATUS was dropped on the floor. If
     * the row appears afterwards it is built 'running', nothing re-applies the terminal
     * report, and the turn-end sweep settles it 'unknown': a task that POSITIVELY SAID
     * IT FINISHED is written into the ledger as an unexplained death.
     *
     * ORDERING, HONESTLY: a terminal report strictly BEFORE that same task's own
     * 'task_started' on ONE live stream is SYNTHETIC — a real engine cannot report a
     * task id it has not announced. It is used here because it is the smallest driver of
     * the REAL code path ('#retireTask' from the frame with no row), which re-attach and
     * 'skip_transcript' shapes reach for real. The assertions are written against the
     * ordering this stream actually drives: 'rootW' positively completed, so 'fgSub''s
     * death IS owed at this boundary and is asserted as owed, not as spared.
     */
    A(null, 'task_tu_ROOT', 'Task', { subagent_type: 'worker', description: 'bg ROOT', run_in_background: true });
    BG([{ task_id: 'rootW', task_type: 'local_agent', description: 'bg ROOT' }]);
    TU('rootW', 'completed');                                   // the terminal report — no row exists yet
    TS('rootW', 'task_tu_ROOT', AGENT('bg ROOT'));              // …and the row arrives after it
    A('task_tu_ROOT', 'task_tu_FG', 'Task', AGENT('fg SUB of a root that already reported completed'));
    TS('fgSub', 'task_tu_FG', AGENT('fg SUB of a root that already reported completed'));
    A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });
    TS('mainOrphan', 'fg_tu', BASH('sleep 300'));
    TEXT('TURN ONE'); RESULT();
    return;
  }

  if (SCENARIO === 'unseenterminal') {
    /*
     * THE REACHABLE COUSIN (re-attach) AND THE DOUBLE REPORT.
     *   ghostBg  — the engine's level lists a task from before this bridge attached, and
     *              its terminal frame arrives for a task that HAS no row and never gets
     *              one. Nothing may be fabricated for it, and the sweep must be unharmed.
     *   dblFail  — the SAME terminal report twice. One death happened; one death must be
     *              written. Two ledger rows for one report is a fabricated second death.
     */
    BG([{ task_id: 'ghostBg', task_type: 'local_agent', description: 'work from before this bridge attached' }]);
    TU('ghostBg', 'completed');                                 // terminal for a task never seen
    A(null, 'task_tu_D', 'Task', AGENT('an agent whose failure is reported twice'));
    TS('dblFail', 'task_tu_D', AGENT('an agent whose failure is reported twice'));
    TU('dblFail', 'failed');
    TU('dblFail', 'failed');                                    // the same terminal report, again
    A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });
    TS('mainOrphan', 'fg_tu', BASH('sleep 300'));
    TEXT('TURN ONE'); RESULT();
    A(null, 'fg_tu2', 'Bash', { command: 'sleep 301' });
    TS('mainOrphan2', 'fg_tu2', BASH('sleep 301'));
    TEXT('TURN TWO'); RESULT();
    return;
  }

  if (SCENARIO === 'conflictreport') {
    /*
     * BUG-105 (3rd independent clean-room verdict, property (c)) — TWO TERMINAL
     * REPORTS FOR ONE TASK THAT DISAGREE.
     *
     * THE DEFECT AS FOUND: 'task_updated completed' then 'task_updated failed',
     * both BEFORE the row exists. '#retireTask' kept the first, 'task_started'
     * applied it, and '#recordAgentEnd' drops a 'completed' — so an engine-reported
     * FAILURE left no ledger row at all. The SAME two frames with the row already
     * present write a 'failed' row. The two orders disagreed about what the engine
     * said, which is what property (c) forbids.
     *
     * SO THE PROPERTY UNDER TEST IS PARITY, not a preferred winner: every ordering
     * below is driven TWICE — once with the row arriving LATE ('…Late') and once
     * with the row ALREADY PRESENT ('…Row') — and the two ledgers must match. The
     * row-present path is the reference: it is where each of these decisions was
     * already made and probe-checked.
     *
     * ORDERING, HONESTLY: a report arriving before its own 'task_started' on one
     * live stream is SYNTHETIC (see 'terminalfirst'); it is the smallest driver of
     * the REAL row-less path that re-attach and 'skip_transcript' shapes reach.
     */
    // (1) completed → failed, both by PATCH: the reported defect and its reference.
    TU('confLate', 'completed'); TU('confLate', 'failed');
    A(null, 'tu_confLate', 'Task', AGENT('completed then failed, row late'));
    TS('confLate', 'tu_confLate', AGENT('completed then failed, row late'));
    A(null, 'tu_confRow', 'Task', AGENT('completed then failed, row first'));
    TS('confRow', 'tu_confRow', AGENT('completed then failed, row first'));
    TU('confRow', 'completed'); TU('confRow', 'failed');
    // (2) failed → completed: a death the engine already named is never retracted.
    TU('revLate', 'failed'); TU('revLate', 'completed');
    A(null, 'tu_revLate', 'Task', AGENT('failed then completed, row late'));
    TS('revLate', 'tu_revLate', AGENT('failed then completed, row late'));
    A(null, 'tu_revRow', 'Task', AGENT('failed then completed, row first'));
    TS('revRow', 'tu_revRow', AGENT('failed then completed, row first'));
    TU('revRow', 'failed'); TU('revRow', 'completed');
    // (3) completed by PATCH, then the teardown BLANKET notification: a blanket
    //     about every still-open task must never be promoted into a death.
    TU('blanketLate', 'completed'); TN('blanketLate', 'stopped');
    A(null, 'tu_blanketLate', 'Task', AGENT('completed then a teardown blanket, row late'));
    TS('blanketLate', 'tu_blanketLate', AGENT('completed then a teardown blanket, row late'));
    A(null, 'tu_blanketRow', 'Task', AGENT('completed then a teardown blanket, row first'));
    TS('blanketRow', 'tu_blanketRow', AGENT('completed then a teardown blanket, row first'));
    TU('blanketRow', 'completed'); TN('blanketRow', 'stopped');
    // (4) two DIFFERENT specific deaths: one ending, recorded once, the first.
    TU('twoLate', 'failed'); TU('twoLate', 'killed');
    A(null, 'tu_twoLate', 'Task', AGENT('failed then killed, row late'));
    TS('twoLate', 'tu_twoLate', AGENT('failed then killed, row late'));
    A(null, 'tu_twoRow', 'Task', AGENT('failed then killed, row first'));
    TS('twoRow', 'tu_twoRow', AGENT('failed then killed, row first'));
    TU('twoRow', 'failed'); TU('twoRow', 'killed');
    // (5) A DUPLICATE RECORD APPEARING AFTER A REPORT: the same 'task_started'
    //     delivered twice once the report is already held.
    TU('dupLate', 'failed');
    A(null, 'tu_dupLate', 'Task', AGENT('a duplicated row after its report'));
    TS('dupLate', 'tu_dupLate', AGENT('a duplicated row after its report'));
    TS('dupLate', 'tu_dupLate', AGENT('a duplicated row after its report'));
    A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });
    TS('mainOrphan', 'fg_tu', BASH('sleep 300'));
    TEXT('TURN ONE'); RESULT();
    return;
  }

  if (SCENARIO === 'blanketfirst' || SCENARIO === 'noblanket') {
    /*
     * BUG-105 (4th independent clean-room verdict, property (c) again) — A TEARDOWN
     * BLANKET ARRIVING BEFORE THE ROW.
     *
     * THE DEFECT AS FOUND: a 'task_notification status:"stopped"' as the FIRST frame
     * for a task — before this bridge has a row — was stored as that task's outcome
     * and applied as a 'killed' DEATH when the row appeared. With the row already
     * present the same frame is only a weak session notice (the row-present handler's
     * 'a.status === running' demotion) and writes nothing. So the two orderings
     * disagreed and the row-less one fabricated an ENGINE-REPORTED death out of a
     * session-wide blanket, for a task the engine never gave a per-task verdict on.
     *
     * THE SHAPE IS THE REAL ONE: a SIGTERM'd CLI emits 'stopped' for EVERY still-open
     * task on its way out (probe-verified v2.1.220), so the stream below blankets
     * SEVERAL tasks at once, not one — a teardown, not a single frame.
     *
     * THE CONTROL IS THE POINT. 'noblanket' is the SAME stream with the blanket
     * frames REMOVED and nothing else changed, so the property can be stated as an
     * equivalence rather than a preferred value: a blanket leaves NO TRACE on the
     * outcome path, i.e. the ledger for 'blanketFirst' is the ledger it would have
     * had if the blanket had never been sent.
     *
     * AND THE OPPOSITE DIRECTION, in the same stream: a blanket really does mean the
     * CLI is going away, so work really is ending. 'liveA'/'liveB' are rows this
     * bridge IS holding running when the blanket lands (the row is the evidence the
     * blanket is about live work of ours) — their deaths must still be recorded — and
     * 'patchLate' is a GENUINE per-task verdict arriving during the same teardown
     * with no row yet, which must still reach the ledger.
     */
    const BLANKET = SCENARIO === 'blanketfirst';
    // Two lanes this bridge is holding RUNNING when the teardown lands.
    A(null, 'tu_liveA', 'Task', AGENT('live when the teardown blanket lands'));
    TS('liveA', 'tu_liveA', AGENT('live when the teardown blanket lands'));
    A(null, 'tu_liveB', 'Task', AGENT('also live when the teardown blanket lands'));
    TS('liveB', 'tu_liveB', AGENT('also live when the teardown blanket lands'));
    // THE FINDING: the blanket is the FIRST frame for this task; its row comes after.
    if (BLANKET) TN('blanketFirst', 'stopped');
    A(null, 'tu_blanketFirst', 'Task', AGENT('blanket arrives before the row'));
    TS('blanketFirst', 'tu_blanketFirst', AGENT('blanket arrives before the row'));
    // …and a blanket for a task that never gets a row at all (the re-attach cousin).
    if (BLANKET) TN('ghostBlanket', 'stopped');
    // A GENUINE per-task verdict during the same teardown, also before its row.
    TU('patchLate', 'failed');
    A(null, 'tu_patchLate', 'Task', AGENT('a real per-task verdict during teardown, row late'));
    TS('patchLate', 'tu_patchLate', AGENT('a real per-task verdict during teardown, row late'));
    // The teardown blanket over every still-open task — what a SIGTERM'd CLI emits.
    if (BLANKET) { TN('liveA', 'stopped'); TN('liveB', 'stopped'); }
    A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });
    TS('mainOrphan', 'fg_tu', BASH('sleep 300'));
    TEXT('TURN ONE'); RESULT();
    return;
  }

  if (SCENARIO === 'uilive') {
    /*
     * PROPERTY (e) AT THE BROWSER LEVEL. Four lanes, a BUSY mid-turn state, and the
     * turn deliberately HELD OPEN (no 'result' until the harness drops a flag file)
     * so a real browser can attach while the display is live rather than only after
     * everything settled:
     *   liveOne     — genuinely running: the control that proves the strip renders.
     *   doneLate    — reported 'failed' BEFORE its row exists (the row-less path).
     *   doneEarly   — reported 'completed' AFTER its row exists (the reference path).
     *   blanketUI   — a teardown blanket before its row: the engine gave NO per-task
     *                 verdict, so this row is live work as far as anyone knows.
     */
    A(null, 'tu_liveOne', 'Task', AGENT('genuinely running while the browser looks'));
    TS('liveOne', 'tu_liveOne', AGENT('genuinely running while the browser looks'));
    TU('doneLate', 'failed');
    A(null, 'tu_doneLate', 'Task', AGENT('reported failed before its row existed'));
    TS('doneLate', 'tu_doneLate', AGENT('reported failed before its row existed'));
    A(null, 'tu_doneEarly', 'Task', AGENT('reported completed after its row existed'));
    TS('doneEarly', 'tu_doneEarly', AGENT('reported completed after its row existed'));
    TU('doneEarly', 'completed');
    TN('blanketUI', 'stopped');
    A(null, 'tu_blanketUI', 'Task', AGENT('a teardown blanket before its row'));
    TS('blanketUI', 'tu_blanketUI', AGENT('a teardown blanket before its row'));
    TEXT('THE TURN IS HELD OPEN');
    const flag = process.env.UI_RELEASE_FLAG || '';
    const t = setInterval(() => {
      if (flag && ffs.existsSync(flag)) { clearInterval(t); RESULT(); }
    }, 250);
    return;
  }

  if (SCENARIO === 'crossboundary') {
    /*
     * A TERMINAL REPORT LANDING ON THE FAR SIDE OF A REAL PROCESS BOUNDARY.
     * ROLE 'pre' is the CLI of the server that gets killed; ROLE 'post' is the CLI
     * of the fresh server the session is resumed onto. The second bridge's
     * '#terminallyReportedTasks' and '#agents' are EMPTY — only the on-disk ledger
     * crosses — so this is where a report about work announced before the boundary
     * has the least state to land in.
     */
    if (ROLE === 'pre') {
      // A live background root with a foreground subagent under it: the subagent is
      // SPARED at the boundary (property (b)), so it crosses with no ledger row.
      A(null, 'task_tu_ROOT', 'Task', { subagent_type: 'worker', description: 'bg ROOT', run_in_background: true });
      BG([{ task_id: 'rootW', task_type: 'local_agent', description: 'bg ROOT' }]);
      TS('rootW', 'task_tu_ROOT', AGENT('bg ROOT'));
      A('task_tu_ROOT', 'task_tu_FG', 'Task', AGENT('fg SUB that outlives the server'));
      TS('fgSub', 'task_tu_FG', AGENT('fg SUB that outlives the server'));
      A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });
      TS('mainOrphan', 'fg_tu', BASH('sleep 300'));
      TEXT('TURN ONE'); RESULT();
      return;
    }
    // FAR SIDE. Two arms:
    //   fgSub  — RE-ANNOUNCED by the resumed CLI and then reported failed: the new
    //            bridge owns a row for it, so the engine's outcome must reach the
    //            ledger exactly once.
    //   ghostX — reported failed with NO row on this side and none coming: absorbed,
    //            never fabricated into anything (property (21) across a real boundary).
    A(null, 'task_tu_FG2', 'Task', AGENT('fg SUB re-announced after the restart'));
    TS('fgSub', 'task_tu_FG2', AGENT('fg SUB re-announced after the restart'));
    TU('fgSub', 'failed');
    TU('ghostX', 'failed');
    A(null, 'fg_tu3', 'Bash', { command: 'sleep 302' });
    TS('mainOrphan3', 'fg_tu3', BASH('sleep 302'));
    TEXT('TURN TWO'); RESULT();
    return;
  }

  if (SCENARIO === 'settlenoretire') {
    /*
     * THE LOAD-BEARING SEAM, ASSERTED RATHER THAN ASSERTED-ABOUT: only the ENGINE'S OWN
     * terminal frame may retire a task. The turn-end sweep's settle is THIS BRIDGE'S
     * INFERENCE and can be wrong about a lane that is genuinely working (the ARCH-003
     * 6th verdict), so if it ever reached '#retireTask' the retired id would be filtered
     * out of every later level frame — permanently — and the engine's own word that the
     * lane is live background work could never be heard again. Its children's deaths
     * would then be fabricated at every boundary.
     *
     * The stream drives exactly that: a lane the level has NOT caught up on is settled by
     * sweep #1 (honestly — no evidence, no chain), and the engine's level THEN says it is
     * live background work. Its child must be spared at sweep #2.
     */
    A(null, 'task_tu_W', 'Task', AGENT('a lane the level has not caught up on'));
    TS('lateBg', 'task_tu_W', AGENT('a lane the level has not caught up on'));
    A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });
    TS('mainOrphan', 'fg_tu', BASH('sleep 300'));
    TEXT('TURN ONE'); RESULT();                                 // sweep #1 SETTLES lateBg
    BG([{ task_id: 'lateBg', task_type: 'local_agent', description: 'the engine says it is live background work' }]);
    A('task_tu_W', 'bash_tu_C', 'Bash', { command: 'child work' });
    TS('childBash', 'bash_tu_C', BASH('child work'));
    A(null, 'fg_tu2', 'Bash', { command: 'sleep 301' });
    TS('mainOrphan2', 'fg_tu2', BASH('sleep 301'));
    TEXT('TURN TWO'); RESULT();                                 // sweep #2
    return;
  }

  if (SCENARIO === 'bglifetime') {
    /*
     * THE "IS BACKGROUND WORK STILL RUNNING" QUERY NOW ANSWERS ONE FRAME EARLIER —
     * a retired task leaves '#backgroundTasks' on its terminal frame instead of waiting
     * for the next level frame to drop it. 'workLifetime()' is that map, and the
     * close-on-detach fuse closes a detached session the moment it answers 'no'; a close
     * reaps the broker, whose SIGTERM kills whatever is still working. So the expensive
     * direction is a close that lands while OTHER background work is live.
     *
     * TWO background roots. One retires with a terminal frame AFTER the detach; the other
     * is still on the level, with a foreground subagent of its own in flight. The session
     * must stay open.
     */
    A(null, 'task_tu_A', 'Task', { subagent_type: 'worker', description: 'bg A', run_in_background: true });
    A(null, 'task_tu_B', 'Task', { subagent_type: 'worker', description: 'bg B', run_in_background: true });
    BG([
      { task_id: 'rootA', task_type: 'local_agent', description: 'bg A' },
      { task_id: 'rootB', task_type: 'local_agent', description: 'bg B' },
    ]);
    TS('rootA', 'task_tu_A', AGENT('bg A'));
    TS('rootB', 'task_tu_B', AGENT('bg B'));
    A('task_tu_B', 'task_tu_FGB', 'Task', AGENT('fg SUB of the root that is still working'));
    TS('fgSubB', 'task_tu_FGB', AGENT('fg SUB of the root that is still working'));
    TEXT('DISPATCHED'); RESULT();
    // …and one root retires while nobody is attached.
    setTimeout(() => TU('rootA', 'completed'), 6000);
    return;
  }

  if (SCENARIO === 'deadfg') {
    /*
     * THE ANTI-BLANKET SCENARIO — the sparing must not swallow genuine agent deaths.
     *   mainFgSub — a foreground subagent of the MAIN THREAD still running at its own
     *               turn's end. It has NO ownership chain, so nothing can spare it:
     *               its honest death is recorded in sweep #1.
     *   fgSub2    — a foreground subagent of a background root that then RETIRES by
     *               dropping out of the engine's level with NO terminal frame ever
     *               emitted. Spared in sweep #1 (the root was live), and recorded
     *               HONESTLY in sweep #2 once nothing in its chain is live.
     */
    A(null, 'task_tu_MFG', 'Task', AGENT('main-thread fg sub'));
    TS('mainFgSub', 'task_tu_MFG', AGENT('main-thread fg sub'));
    A(null, 'task_tu_ROOT', 'Task', { subagent_type: 'worker', description: 'bg ROOT', run_in_background: true });
    BG([{ task_id: 'rootW', task_type: 'local_agent', description: 'bg ROOT' }]);
    TS('rootW', 'task_tu_ROOT', AGENT('bg ROOT'));
    A('task_tu_ROOT', 'task_tu_FG2', 'Task', AGENT('fg SUB of a root that retires'));
    TS('fgSub2', 'task_tu_FG2', AGENT('fg SUB of a root that retires'));
    TEXT('TURN ONE'); RESULT();                                 // sweep #1
    BG([]);                                                     // the root retires, unseen
    A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });
    TS('mainOrphan', 'fg_tu', BASH('sleep 300'));
    TEXT('TURN TWO'); RESULT();                                 // sweep #2
    return;
  }

  if (SCENARIO === 'donethenstart') {
    /*
     * THE OPPOSITE DIRECTION OF THE SAME SEAM, and the reason the withdrawal cannot
     * simply be "any task_started clears the evidence": a task the engine gave a
     * PER-TASK VERDICT for is finished, and neither a re-announcement nor a stale
     * level frame may resurrect it.
     *
     *   done1     — 'task_updated completed' with no row, then its task_started
     *               (the row-less path), then a level frame listing it.
     *   doneChild — a foreground subagent of that finished task. Nothing in its
     *               chain is live, so its honest death MUST be recorded: if the
     *               re-announcement had restored done1's liveness, this death would
     *               be suppressed for as long as the stale entry lingers.
     */
    TU('done1', 'completed');
    A(null, 'tu_done1', 'Task', { subagent_type: 'worker', description: 'a finished task the engine re-announces', run_in_background: true });
    TS('done1', 'tu_done1', AGENT('a finished task the engine re-announces'));
    BG([{ task_id: 'done1', task_type: 'local_agent', description: 'a level snapshot that went stale' }]);
    A('tu_done1', 'tu_doneChild', 'Task', AGENT('fg SUB of the finished task'));
    TS('doneChild', 'tu_doneChild', AGENT('fg SUB of the finished task'));
    A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });
    TS('mainOrphan', 'fg_tu', BASH('sleep 300'));
    TEXT('TURN ONE'); RESULT();
    return;
  }

  if (SCENARIO === 'triconflict') {
    /*
     * THE CONFLICT REGISTRY WITH THREE OR MORE FRAMES — listed as untested by the
     * last two clean-room passes and exercised by neither. The registry pairs the
     * FIRST-SEEN status against the LATEST one, so a third frame is judged against
     * the first, not against its predecessor. Driven in both orderings, because the
     * property is parity: the row-late ledger must equal the row-present ledger.
     */
    // (1) three DIFFERENT terminal reports, in the order that tests every clause.
    TU('triLate', 'completed'); TU('triLate', 'failed'); TU('triLate', 'killed');
    A(null, 'tu_triLate', 'Task', AGENT('completed, failed, killed — row late'));
    TS('triLate', 'tu_triLate', AGENT('completed, failed, killed — row late'));
    A(null, 'tu_triRow', 'Task', AGENT('completed, failed, killed — row first'));
    TS('triRow', 'tu_triRow', AGENT('completed, failed, killed — row first'));
    TU('triRow', 'completed'); TU('triRow', 'failed'); TU('triRow', 'killed');
    // (2) a RE-DELIVERED frame among three: the second and third agree.
    TU('reLate', 'completed'); TU('reLate', 'failed'); TU('reLate', 'failed');
    A(null, 'tu_reLate', 'Task', AGENT('completed, failed, failed — row late'));
    TS('reLate', 'tu_reLate', AGENT('completed, failed, failed — row late'));
    A(null, 'tu_reRow', 'Task', AGENT('completed, failed, failed — row first'));
    TS('reRow', 'tu_reRow', AGENT('completed, failed, failed — row first'));
    TU('reRow', 'completed'); TU('reRow', 'failed'); TU('reRow', 'failed');
    // (3) three frames ending in a teardown BLANKET, both orderings.
    TU('triBlanketLate', 'completed'); TU('triBlanketLate', 'failed'); TN('triBlanketLate', 'stopped');
    A(null, 'tu_tbl', 'Task', AGENT('completed, failed, blanket — row late'));
    TS('triBlanketLate', 'tu_tbl', AGENT('completed, failed, blanket — row late'));
    A(null, 'tu_tbr', 'Task', AGENT('completed, failed, blanket — row first'));
    TS('triBlanketRow', 'tu_tbr', AGENT('completed, failed, blanket — row first'));
    TU('triBlanketRow', 'completed'); TU('triBlanketRow', 'failed'); TN('triBlanketRow', 'stopped');
    A(null, 'fg_tu', 'Bash', { command: 'sleep 300' });
    TS('mainOrphan', 'fg_tu', BASH('sleep 300'));
    TEXT('TURN ONE'); RESULT();
    return;
  }

  if (SCENARIO === 'reanndetach') {
    /*
     * THE EXPENSIVE DIRECTION THE 5th VERDICT COULD NOT TEST: does a STARVED task
     * reach the close-on-detach path and cut off live work?
     *
     * 'workLifetime()' IS the level mirror, and the close-on-detach fuse closes a
     * detached session the moment it answers 'no' — a close reaps the broker, and
     * the broker's SIGTERM kills whatever is still running. So a task filtered out
     * of the level by a stale blanket does not merely lose its sparing: it makes
     * the engine's only "background work is still running" answer read EMPTY, and
     * the session is closed on top of live work.
     */
    TN('reannD', 'stopped');                                    // a blanket, no row
    A(null, 'task_tu_D', 'Task', { subagent_type: 'worker', description: 're-announced bg root', run_in_background: true });
    BG([{ task_id: 'reannD', task_type: 'local_agent', description: 're-announced bg root' }]);
    TS('reannD', 'task_tu_D', AGENT('re-announced bg root'));
    A('task_tu_D', 'task_tu_DFG', 'Task', AGENT('fg SUB of the re-announced root'));
    TS('reannDChild', 'task_tu_DFG', AGENT('fg SUB of the re-announced root'));
    TEXT('DISPATCHED'); RESULT();
    return;
  }

  if (SCENARIO === 'blanketrowui') {
    /*
     * BUG-105 (7th verdict) — THE THING THIS PASS COULD NOT SEE: the defect was
     * measured at the ledger/snapshot level only, so the DISPLAY side of a blanket
     * landing on an EXISTING row was unverified. This drives exactly that shape
     * into a real headless browser, mid-turn, with the turn held open:
     *   liveOne     — a genuinely running foreground lane, the control.
     *   rootUI      — a live BACKGROUND root on the engine's level.
     *   fgLiveUI    — rootUI's foreground subagent. Its row EXISTS and is running
     *                 when the teardown blanket lands on it. It is live work under
     *                 a live ancestor: it must stay a ◐ row in the real DOM, both
     *                 mid-turn and after the held turn ends. Pre-fix the blanket
     *                 settled it and it left the strip while it worked.
     *   doneUI      — a per-task 'status:"completed"' on an EXISTING row: the
     *                 control that proves the display is not simply ignoring every
     *                 notification. It must LEAVE the strip.
     */
    A(null, 'tu_liveOne', 'Task', AGENT('a foreground lane, the control'));
    TS('liveOne', 'tu_liveOne', AGENT('a foreground lane, the control'));
    A(null, 'tu_rootUI', 'Task', { subagent_type: 'worker', description: 'bg ROOT', run_in_background: true });
    BG([{ task_id: 'rootUI', task_type: 'local_agent', description: 'bg ROOT' }]);
    TS('rootUI', 'tu_rootUI', AGENT('bg ROOT'));
    A('tu_rootUI', 'tu_fgLiveUI', 'Task', AGENT('fg SUB, live under a live root'));
    TS('fgLiveUI', 'tu_fgLiveUI', AGENT('fg SUB, live under a live root'));
    A(null, 'tu_doneUI', 'Task', AGENT('a per-task completion on an existing row'));
    TS('doneUI', 'tu_doneUI', AGENT('a per-task completion on an existing row'));
    TN('fgLiveUI', 'stopped');                                  // the BLANKET, row present
    TN('doneUI', 'completed');                                  // a per-task VERDICT, row present
    TEXT('THE TURN IS HELD OPEN');
    const t4 = setInterval(() => {
      const flag4 = process.env.UI_RELEASE_FLAG || '';
      if (flag4 && ffs.existsSync(flag4)) { clearInterval(t4); RESULT(); }
    }, 250);
    return;
  }

  if (SCENARIO === 'notifui') {
    /*
     * BUG-105 (6th verdict) — THE THING THE CLEAN-ROOM PASS COULD NOT SEE: the
     * resurrection was confirmed only at the running-snapshot and ledger level, so
     * this drives the SAME shape into a real headless browser. Both directions are
     * on screen at once, mid-turn and after the held turn ends:
     *   liveOne        — a genuinely running foreground lane, the control.
     *   doneNotifUI    — a per-task 'task_notification status:"completed"' before its
     *                    row, then RE-ANNOUNCED as live background work. It is
     *                    finished; the strip must never show it as a running lane.
     *   blanketNotifUI — a session-wide teardown blanket before its row, then
     *                    re-announced. The engine gave no per-task verdict, so this
     *                    one IS live and the strip must keep showing it (the 5th
     *                    verdict, which the fix must not trade away).
     */
    A(null, 'tu_liveOne', 'Task', AGENT('a foreground lane, the control'));
    TS('liveOne', 'tu_liveOne', AGENT('a foreground lane, the control'));
    TN('doneNotifUI', 'completed');                             // a per-task VERDICT, row-less
    TN('blanketNotifUI', 'stopped');                            // a teardown BLANKET, row-less
    A(null, 'tu_doneNotifUI', 'Task', { subagent_type: 'worker', description: 'finished, then re-announced', run_in_background: true });
    A(null, 'tu_blanketNotifUI', 'Task', { subagent_type: 'worker', description: 'blanketed, then re-announced', run_in_background: true });
    BG([{ task_id: 'doneNotifUI', task_type: 'local_agent', description: 'finished, then re-announced' },
      { task_id: 'blanketNotifUI', task_type: 'local_agent', description: 'blanketed, then re-announced' }]);
    TS('doneNotifUI', 'tu_doneNotifUI', AGENT('finished, then re-announced'));
    TS('blanketNotifUI', 'tu_blanketNotifUI', AGENT('blanketed, then re-announced'));
    TEXT('THE TURN IS HELD OPEN');
    const t3 = setInterval(() => {
      const flag3 = process.env.UI_RELEASE_FLAG || '';
      if (flag3 && ffs.existsSync(flag3)) { clearInterval(t3); RESULT(); }
    }, 250);
    return;
  }

  if (SCENARIO === 'reannui') {
    /*
     * THE REAL-BROWSER DISPLAY AFTER A RE-ANNOUNCEMENT — the second thing the 5th
     * verdict listed as untested. The turn is held open so a real browser can
     * attach mid-turn, and the measurement that matters is taken AFTER the held
     * turn ends: live background work must still be a running row, and the
     * foreground control must not be.
     */
    A(null, 'tu_liveOne', 'Task', AGENT('a foreground lane, the control'));
    TS('liveOne', 'tu_liveOne', AGENT('a foreground lane, the control'));
    TN('reannUI', 'stopped');                                   // the blanket, before the row
    A(null, 'tu_reannUI', 'Task', { subagent_type: 'worker', description: 're-announced after a blanket', run_in_background: true });
    BG([{ task_id: 'reannUI', task_type: 'local_agent', description: 're-announced after a blanket' }]);
    TS('reannUI', 'tu_reannUI', AGENT('re-announced after a blanket'));
    TEXT('THE TURN IS HELD OPEN');
    const t2 = setInterval(() => {
      const flag2 = process.env.UI_RELEASE_FLAG || '';
      if (flag2 && ffs.existsSync(flag2)) { clearInterval(t2); RESULT(); }
    }, 250);
    return;
  }
});
process.stdin.resume();
`);

const servers = new Set();
/** Headless browsers this run spawned — killed BY PID in the teardown. */
const browsers = new Set();
/**
 * The server's own log for the scenario currently running. A CONFLICT between two
 * terminal reports can be real and still write no ledger row (the engine said
 * `completed` and a teardown blanket said otherwise), so the warning is the only
 * place that signal exists — and a signal nobody can read is not a signal.
 */
let serverLog = '';
function spawnServer(port, env) {
  const s = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE,
      CLAUDE_STATION_CLAUDE_BIN: FAKE, CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  s.stdout.on('data', (d) => { serverLog += String(d); });
  s.stderr.on('data', (d) => { serverLog += String(d); });
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
const endedForId = (snap, id) => (snap?.ended ?? []).filter((o) => o.agentId === id);
const allEnded = (snap) => (snap?.ended ?? []).map((o) => `${o.agentId}:${o.kind}`);

async function startSession(port, projectId, prompt) {
  const c = await openWs(port);
  c.send({ type: 'start', projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' }, prompt });
  const ack = await waitEv(c.events, (e) => e.t === 'ack' && e.of === 'start');
  if (!ack) throw new Error('no start ack');
  return { c, stationId: ack.stationSessionId };
}
async function register(port, cwd, name) {
  const r = await (await fetch(`http://127.0.0.1:${port}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: cwd, name, isolation: 'direct' }) })).json(); // FEAT-131: pin direct (container-default off)
  if (!r.project?.id) throw new Error(`register(${name}) failed ` + JSON.stringify(r));
  return r.project.id;
}

/** The WS event stream of the LAST `runScenario` — what a live-display consumer saw. */
let lastEvents = [];
async function runScenario(scenario, prompt, turns = 1, env = {}) {
  const port = await freePort();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `cs-bug105-${scenario}-`));
  serverLog = '';
  spawnServer(port, { SCENARIO: scenario, ...env });
  if (!(await waitHealth(port))) throw new Error(`${scenario} server never healthy`);
  const pid = await register(port, cwd, `bug105-${scenario}`);
  const s = await startSession(port, pid, prompt);
  await waitEv(s.c.events, (e) => e.t === 'agent-started', 40_000);
  if (!(await waitCount(s.c.events, (e) => e.t === 'turn-end', turns, 60_000))) throw new Error(`${scenario} turns never ended`);
  await sleep(1200);
  const snap = await getRunning(port, s.stationId);
  lastEvents = s.c.events.slice();
  try { s.c.ws.close(); } catch {}
  fs.rmSync(cwd, { recursive: true, force: true });
  return snap;
}

/**
 * THE INTERRUPT DRIVER. Turn 1 is ended by a real `interrupt` command over the
 * session's own socket (what the ⏹ button sends), so the turn-end sweep settles
 * every running row `killed` — this bridge's INFERENCE wearing the most
 * terminal-looking status it ever writes. Turn 2 then lets the engine's level
 * declare the same lane live background work.
 */
async function runInterrupted(scenario, prompts) {
  const port = await freePort();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `cs-bug105-${scenario}-`));
  spawnServer(port, { SCENARIO: scenario });
  if (!(await waitHealth(port))) throw new Error(`${scenario} server never healthy`);
  const pid = await register(port, cwd, `bug105-${scenario}`);
  const s = await startSession(port, pid, prompts[0]);
  if (!(await waitEv(s.c.events, (e) => e.t === 'agent-started', 40_000))) throw new Error(`${scenario} no agent-started`);
  await sleep(600);
  s.c.send({ type: 'interrupt' });                       // the real ⏹ path
  if (!(await waitCount(s.c.events, (e) => e.t === 'turn-end', 1, 60_000))) throw new Error(`${scenario} interrupt never ended the turn`);
  await sleep(1500);
  const snaps = [await getRunning(port, s.stationId)];
  s.c.send({ type: 'send', prompt: prompts[1] });
  if (!(await waitCount(s.c.events, (e) => e.t === 'turn-end', 2, 60_000))) throw new Error(`${scenario} turn 2 never ended`);
  await sleep(1500);
  snaps.push(await getRunning(port, s.stationId));
  try { s.c.ws.close(); } catch {}
  fs.rmSync(cwd, { recursive: true, force: true });
  return snaps;
}

/* ------------------------------------------------------------- raw CDP ---- */
/** Minimal CDP client — the house pattern (see verify-bug-072-delivery-visible.mjs). */
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
      try { if (await this.eval(expr)) return true; } catch {}
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  close() { try { this.ws.close(); } catch {} }
}

/**
 * WHAT THE USER'S RUNNING DISPLAY ACTUALLY SHOWS. Read from the real DOM (the
 * strip is the live "what is running now" surface) plus the client's own thread
 * state, which is what a card/lede would render from.
 */
const READ_UI = () => ({
  strip: [...document.querySelectorAll('#stripRows .lag')].map((r) => ({
    key: r.dataset.thread,
    ty: r.querySelector('.ty')?.textContent ?? '',
    gl: r.querySelector('.gl')?.textContent ?? '',
    run: r.classList.contains('run'),
  })),
  hidden: document.querySelector('#strip')?.hidden === true,
  threads: Object.fromEntries([...window.__station.state.threads.entries()].map(([k, t]) => [k, t.status ?? null])),
  agents: Object.fromEntries([...window.__station.state.agents.entries()].map(([k, a]) => [k, a.agent?.status ?? null])),
});

/**
 * PROPERTY (e) AT THE BROWSER LEVEL — a real headless Brave over CDP, driving the
 * real composer (value + Enter, which is what `submit()` is wired to), against a
 * BUSY mid-turn state that is held open by the scripted engine until this function
 * drops the release flag. Two rounds of this ticket could only assert property (e)
 * at the event and API level because `public/app.js` was another lane's live file.
 */
async function runUiLive(scenario = 'uilive', liveKey = 'liveOne') {
  const port = await freePort();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `cs-bug105-${scenario}-`));
  const flag = path.join(WORK, `${scenario}-release.flag`);
  fs.rmSync(flag, { force: true });
  spawnServer(port, { SCENARIO: scenario, UI_RELEASE_FLAG: flag, FAKE_SDK_ID: `fakesdk-${scenario}-105` });
  if (!(await waitHealth(port))) throw new Error(`${scenario} server never healthy`);
  const projectId = await register(port, cwd, `bug105-${scenario}`);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug105-brave-'));
  const brave = spawn(process.env.VERIFY_BROWSER ?? 'brave', [
    '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--window-size=1280,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  browsers.add(brave);
  let devPort = 0;
  for (let i = 0; i < 120 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  if (!devPort) throw new Error('brave never wrote DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  // Theme by CDP rather than localStorage (there is no origin on about:blank).
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/#/project/${encodeURIComponent(projectId)}` });
  const booted = await cdp.waitFor('boot', 'window.__station !== undefined', 60_000);
  const onProject = await cdp.waitFor('project current',
    `window.__station.currentProject()?.id === ${JSON.stringify(projectId)}`, 30_000);

  // THE REAL CLICK-PATH: type into the composer and press Enter.
  await cdp.eval(`(() => {
    const ta = document.querySelector('#prompt') ?? document.querySelector('textarea');
    ta.value = 'a busy turn with lanes the engine has already reported on';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  const sawLive = await cdp.waitFor('the live lane in the strip',
    `[...document.querySelectorAll('#stripRows .lag')].some((r) => r.dataset.thread === ${JSON.stringify(liveKey)})`, 60_000);
  await sleep(1200);                                   // let every frame of the burst land
  const mid = await cdp.eval(`(${READ_UI.toString()})()`);
  // The server's own answer at the same instant — the display and the API must agree.
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  const stationId = (health?.sessions ?? [])[0]?.stationSessionId ?? null;
  const midSnap = stationId ? await getRunning(port, stationId) : null;

  fs.writeFileSync(flag, '1');                         // release the held turn
  const settled = await cdp.waitFor('the turn to finish in the UI',
    "[...document.querySelectorAll('#stripRows .lag')].every((r) => r.dataset.thread !== 'main')", 60_000);
  await sleep(1500);
  const after = await cdp.eval(`(${READ_UI.toString()})()`);
  // The server's own answer at that same instant, taken WHILE THE BROWSER IS STILL
  // ATTACHED: once the last socket drops, `/running` can be answered from the
  // survivor broker's own level sniff instead of this bridge's state, which is a
  // different question from the one the display is showing.
  const afterSnap = stationId ? await getRunning(port, stationId) : null;
  cdp.close();
  try { process.kill(brave.pid, 'SIGKILL'); } catch {}
  for (let i = 0; i < 20 && pidAlive(brave.pid); i++) await sleep(100);
  fs.rmSync(cwd, { recursive: true, force: true });
  // The profile dir is still being written as the browser dies — retry rather
  // than let a teardown race abort a run that has already made its measurements.
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  return { booted, onProject, sawLive, mid, after, midSnap, afterSnap, settled };
}

/**
 * A REAL PROCESS BOUNDARY. Run one turn on server 1, kill server 1 outright, kill
 * the brokers/CLIs it left behind BY PID (so the resume is the ordinary
 * from-disk path and not a delivery into a survivor), boot server 2 on the SAME
 * dataDir + store, and resume the SAME sdk session id onto it. Server 2's bridge
 * is a brand-new `AgentSession`: empty `#agents`, empty `#terminallyReportedTasks`.
 * Only the on-disk outcome ledger crosses. Returns the snapshot from EACH side.
 */
async function runAcrossRestart(scenario, sdkId) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `cs-bug105-${scenario}-`));
  serverLog = '';
  const port1 = await freePort();
  const s1 = spawnServer(port1, { SCENARIO: scenario, ROLE: 'pre', FAKE_SDK_ID: sdkId });
  if (!(await waitHealth(port1))) throw new Error(`${scenario} server 1 never healthy`);
  const pid = await register(port1, cwd, `bug105-${scenario}`);
  const a = await startSession(port1, pid, 'work that will outlive this server process');
  if (!(await waitCount(a.c.events, (e) => e.t === 'turn-end', 1, 60_000))) throw new Error(`${scenario} pre-turn never ended`);
  await sleep(1500);
  const before = await getRunning(port1, a.stationId);
  try { a.c.ws.close(); } catch {}

  // Kill server 1 by pid, then everything it left behind, by pid.
  const s1pid = s1.pid;
  try { process.kill(s1pid, 'SIGKILL'); } catch {}
  for (let i = 0; i < 40 && pidAlive(s1pid); i++) await sleep(100);
  const hostDir = path.join(DATA, 'session-hosts');
  const strays = [];
  try {
    for (const f of fs.readdirSync(hostDir)) {
      try {
        const h = JSON.parse(fs.readFileSync(path.join(hostDir, f), 'utf8'));
        for (const p of [h.claudePid, h.hostPid]) if (p && pidAlive(p)) { strays.push(p); try { process.kill(p, 'SIGKILL'); } catch {} }
      } catch {}
      fs.rmSync(path.join(hostDir, f), { force: true });
    }
  } catch {}
  await sleep(800);

  /*
   * The resume-from-disk path refuses a session id with no transcript under the
   * store, and the scripted CLI writes none (a real one does). Plant the minimal
   * one the lookup needs — this is the ONE synthetic part of the boundary; the
   * process death, the fresh server, the fresh bridge and the resumed CLI are all
   * real.
   */
  const encoded = cwd.replace(/\//g, '-');
  fs.mkdirSync(path.join(STORE, encoded), { recursive: true });
  fs.writeFileSync(path.join(STORE, encoded, `${sdkId}.jsonl`), [
    JSON.stringify({ type: 'user', sessionId: sdkId, cwd, timestamp: new Date().toISOString(), message: { role: 'user', content: 'work that will outlive this server process' } }),
    JSON.stringify({ type: 'assistant', sessionId: sdkId, cwd, timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'TURN ONE' }] } }),
  ].join('\n') + '\n');

  const port2 = await freePort();
  spawnServer(port2, { SCENARIO: scenario, ROLE: 'post', FAKE_SDK_ID: sdkId });
  if (!(await waitHealth(port2))) throw new Error(`${scenario} server 2 never healthy`);
  // The registry lives in the shared dataDir, so server 2 already knows this
  // project — re-registering the same host path is refused. Look it up instead.
  const list = await (await fetch(`http://127.0.0.1:${port2}/api/projects`)).json();
  const pid2 = (list.projects ?? []).find((p) => p.hostPath === cwd || p.path === cwd)?.id ?? pid;
  const c = await openWs(port2);
  c.send({ type: 'start', projectId: pid2, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' },
    prompt: 'resumed onto a fresh server process', resumeSessionId: sdkId });
  const ack = await waitEv(c.events, (e) => e.t === 'ack' && e.of === 'start', 40_000);
  if (!ack) throw new Error(`${scenario} resume never acked — frames=${JSON.stringify(c.events.slice(0, 12))}`);
  if (!(await waitCount(c.events, (e) => e.t === 'turn-end', 1, 60_000))) throw new Error(`${scenario} post-turn never ended`);
  await sleep(1500);
  const after = await getRunning(port2, ack.stationSessionId ?? ack.sessionId);
  lastEvents = c.events.slice();
  try { c.ws.close(); } catch {}
  fs.rmSync(cwd, { recursive: true, force: true });
  return { before, after, strays, resumeAck: ack };
}

/**
 * One user message per turn, with a SNAPSHOT TAKEN AT EACH BOUNDARY — the only way
 * to see what a spared row does WHILE it is spared, rather than only after the last
 * sweep. Returns one snapshot per prompt.
 */
async function runTurns(scenario, prompts) {
  const port = await freePort();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `cs-bug105-${scenario}-`));
  spawnServer(port, { SCENARIO: scenario });
  if (!(await waitHealth(port))) throw new Error(`${scenario} server never healthy`);
  const pid = await register(port, cwd, `bug105-${scenario}`);
  const s = await startSession(port, pid, prompts[0]);
  await waitEv(s.c.events, (e) => e.t === 'agent-started', 40_000);
  const snaps = [];
  for (let i = 0; i < prompts.length; i++) {
    if (i > 0) s.c.send({ type: 'send', prompt: prompts[i] });
    if (!(await waitCount(s.c.events, (e) => e.t === 'turn-end', i + 1, 60_000))) throw new Error(`${scenario} turn ${i + 1} never ended`);
    await sleep(1500);
    snaps.push(await getRunning(port, s.stationId));
  }
  // BUG-105 (7th verdict): this driver never published its socket frames, so every
  // `const xEvents = lastEvents` after a `runTurns(...)` was silently reading the
  // PREVIOUS scenario's stream — a check asserting "no agent-completed went out"
  // passed against a run in which the event did go out. Found by must-FAILing the
  // new checks on 08ecda4: (85) passed on the defect it was written to catch.
  lastEvents = s.c.events.slice();
  try { s.c.ws.close(); } catch {}
  fs.rmSync(cwd, { recursive: true, force: true });
  return snaps;
}

/**
 * The DETACHED driver: run one turn, drop the socket (that is what "detached"
 * means to this server), and let the close-on-detach fuse re-ask the lifetime
 * question across its own re-check loop while the engine retires one of two
 * background roots. What is measured is the USER-VISIBLE consequence of a wrong
 * close: the live root's rows disappearing, and the ledger filling with `cut`
 * rows for work that was still running.
 */
async function runDetached(scenario, prompt, waitMs = 22_000) {
  const port = await freePort();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `cs-bug105-${scenario}-`));
  spawnServer(port, { SCENARIO: scenario });
  if (!(await waitHealth(port))) throw new Error(`${scenario} server never healthy`);
  const pid = await register(port, cwd, `bug105-${scenario}`);
  const s = await startSession(port, pid, prompt);
  await waitEv(s.c.events, (e) => e.t === 'agent-started', 40_000);
  if (!(await waitCount(s.c.events, (e) => e.t === 'turn-end', 1, 60_000))) throw new Error(`${scenario} turn never ended`);
  const t0 = Date.now();
  try { s.c.ws.close(); } catch {}          // DETACH — the fuse arms here
  await sleep(waitMs);                       // rootA retires at +6s; the fuse re-checks at 3s/30s
  const snap = await getRunning(port, s.stationId);
  fs.rmSync(cwd, { recursive: true, force: true });
  return {
    rootBRows: rowsById(snap, 'rootB').length,
    fgSubBRows: rowsById(snap, 'fgSubB').length,
    running: (snap?.running ?? []).map((r) => r.id),
    deaths: allEnded(snap),
    waitedMs: Date.now() - t0,
  };
}

/**
 * THE DETACHED DRIVER, GENERALISED — run one turn, drop the socket, and let the
 * close-on-detach fuse re-ask `workLifetime()` across its own re-check loop.
 * Returns the raw snapshot plus whether the session is still open at all, which
 * is the user-visible consequence: a closed session has had its broker reaped and
 * its live work SIGTERM'd, and the ledger fills with `cut` rows.
 */
async function runDetachedSnap(scenario, prompt, waitMs = 22_000) {
  const port = await freePort();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `cs-bug105-${scenario}-`));
  serverLog = '';
  spawnServer(port, { SCENARIO: scenario });
  if (!(await waitHealth(port))) throw new Error(`${scenario} server never healthy`);
  const pid = await register(port, cwd, `bug105-${scenario}`);
  const s = await startSession(port, pid, prompt);
  await waitEv(s.c.events, (e) => e.t === 'agent-started', 40_000);
  if (!(await waitCount(s.c.events, (e) => e.t === 'turn-end', 1, 60_000))) throw new Error(`${scenario} turn never ended`);
  try { s.c.ws.close(); } catch {}                        // DETACH — the fuse arms here
  await sleep(waitMs);
  const snap = await getRunning(port, s.stationId);
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  const stillOpen = (health?.sessions ?? []).some((x) => x.stationSessionId === s.stationId);
  fs.rmSync(cwd, { recursive: true, force: true });
  return { snap, stillOpen, log: serverLog, source: snap?.source ?? null,
    running: (snap?.running ?? []).map((r) => r.id), deaths: allEnded(snap) };
}

async function main() {
  // ---- FGSUB — the reported shape. ----
  const fg = await runScenario('fgsub', 'a background worker dispatches a foreground subagent that is still running at the main turn end', 2);

  check('(1b) A STILL-RUNNING FOREGROUND SUBAGENT OF A LIVE BACKGROUND OWNER IS NOT RECORDED DEAD: the main turn ended while `fgSub` — a kind:\'agent\' lane the engine\'s background level never lists, dispatched by a background worker that is STILL on the level — was genuinely working. MUST-FAIL on cb2ceb2: the sweep only ever held the death of a kind:\'tool\' row, so it wrote `fgSub:unknown`',
    deathsForId(fg, 'fgSub').length === 0,
    { fgSubDeaths: deathsForId(fg, 'fgSub').map((o) => o.kind), allEnded: allEnded(fg) });

  check('(1c) …AND ITS ROW IS STILL LIVE: the lane is not settled off /running either. A row whose owner is still working is not contained by THIS turn — the same treatment the engine\'s own background lanes get, re-asked at every boundary rather than assumed once',
    rowsById(fg, 'fgSub').length === 1,
    { fgSubRunningRows: rowsById(fg, 'fgSub').length, running: (fg?.running ?? []).map((r) => r.id) });

  check('(2) A GENUINE FOREGROUND-SUBAGENT DEATH UNDER THE SAME LIVE OWNER IS STILL REPORTED: `fgSub3` failed with its own terminal frame while the root stayed live — the sparing is not a blanket over the kind:\'agent\' row class',
    endedForId(fg, 'fgSub3').some((o) => o.kind === 'failed'),
    { fgSub3Ended: endedForId(fg, 'fgSub3').map((o) => o.kind), allEnded: allEnded(fg) });

  check('(3) NO SECOND-ORDER FABRICATION: a bash the still-running foreground subagent issues in a LATER turn is not recorded dead either. MUST-FAIL on cb2ceb2 for a second reason — settling `fgSub`\'s lane made the reap treat it as terminal evidence and drop its ownership record, so `gcBash`\'s chain was truncated and resolved to no live owner',
    deathsForId(fg, 'gcBash').length === 0,
    { gcBashDeaths: deathsForId(fg, 'gcBash').map((o) => o.agentId), allEnded: allEnded(fg) });

  check('(4a) MAIN-THREAD DEATHS STILL RECORD IN BOTH SWEEPS: no arrangement of live background agents and their foreground subagents suppresses a genuine main-thread death — direction (a), preserved by construction (a main-thread lane has an EMPTY ownership chain)',
    deathsForId(fg, 'mainOrphan').length === 1 && deathsForId(fg, 'mainOrphan2').length === 1,
    { mainOrphan: deathsForId(fg, 'mainOrphan').length, mainOrphan2: deathsForId(fg, 'mainOrphan2').length });

  // ---- DEADFG — the anti-blanket scenario. ----
  const df = await runScenario('deadfg', 'a main-thread foreground subagent dies honestly, and a background root retires under its own foreground subagent', 2);

  check('(5) A MAIN-THREAD FOREGROUND SUBAGENT STILL RECORDS ITS HONEST DEATH: `mainFgSub` has no ownership chain at all, so nothing can spare it — the common case (the orchestrator\'s own foreground subagents) is untouched by this fix',
    deathsForId(df, 'mainFgSub').length === 1,
    { mainFgSubDeaths: deathsForId(df, 'mainFgSub').map((o) => o.kind), allEnded: allEnded(df) });

  check('(6) A FOREGROUND SUBAGENT THAT OUTLIVES ITS OWNER RECORDS HONESTLY AT THE NEXT BOUNDARY: `fgSub2` was spared while the root was on the engine\'s level, and the root then retired with NO terminal frame — the sparing is LEVEL-triggered, re-asked every sweep, so the death is deferred, never lost',
    deathsForId(df, 'fgSub2').length === 1 && rowsById(df, 'fgSub2').length === 0,
    { fgSub2Deaths: deathsForId(df, 'fgSub2').map((o) => o.kind), fgSub2RunningRows: rowsById(df, 'fgSub2').length, allEnded: allEnded(df) });

  check('(7a) AND THE MAIN-THREAD ORPHAN OF THAT SAME SWEEP STILL DIES',
    deathsForId(df, 'mainOrphan').length === 1,
    { mainOrphanDeaths: deathsForId(df, 'mainOrphan').length });

  // ---- AGENTREUSE — direction (a) through the newly-sparable row class. ----
  const ar = await runScenario('agentreuse', 'a main-thread Task re-issues a tool_use id a live worker\'s subagent call still holds');

  check('(8a) ID REUSE CANNOT SUPPRESS AN AGENT DEATH EITHER: a main-thread Task lane that re-issues a still-open subagent tool_use id records its own honest death — the re-issue closes the subagent entry, so the main-thread AGENT row has no ancestor to be spared by (the over-suppression hole that broke BUG-096\'s first fix, checked in the row class this ticket newly makes sparable)',
    deathsForId(ar, 'mainAgent').length === 1 && deathsForId(ar, 'mainOrphan').length === 1,
    { mainAgentDeaths: deathsForId(ar, 'mainAgent').length, mainOrphanDeaths: deathsForId(ar, 'mainOrphan').length, allEnded: allEnded(ar) });

  // ---- OWNERTERMINAL — the 1st independent clean-room verdict's shape (property (a)). ----
  const ot = await runTurns('ownerterminal', [
    'a background worker dispatches a foreground subagent',
    'the background worker retires by emitting a terminal frame while the level still lists it',
    'one more boundary',
  ]);

  check('(9) AN OWNER THAT RETIRED WITH A TERMINAL FRAME NO LONGER SPARES ITS CHILD: `rootW` emitted `task_updated completed` and the engine\'s background LEVEL still listed it (a level is a snapshot; nothing withdrew the entry). MUST-FAIL before this fix — the sparing rule read that STALE membership, so the dead owner\'s foreground subagent was spared across every boundary, its owed death never reported and its lane running indefinitely',
    deathsForId(ot[1], 'fgSub').length === 1 && rowsById(ot[1], 'fgSub').length === 0,
    { fgSubDeaths: deathsForId(ot[1], 'fgSub').map((o) => o.kind), fgSubRunningRows: rowsById(ot[1], 'fgSub').length, running: (ot[1]?.running ?? []).map((r) => r.id), allEnded: allEnded(ot[1]) });

  check('(10) …AND THE SAME ROW WAS CORRECTLY SPARED AT THE BOUNDARY BEFORE IT: while `rootW` was genuinely live, `fgSub` was neither recorded dead nor settled. Property (b) and property (a) are proved on the SAME row in the SAME run — a fix that reported the death one boundary early would fail here',
    deathsForId(ot[0], 'fgSub').length === 0 && rowsById(ot[0], 'fgSub').length === 1,
    { boundary1FgSubDeaths: deathsForId(ot[0], 'fgSub').length, boundary1FgSubRows: rowsById(ot[0], 'fgSub').length, running: (ot[0]?.running ?? []).map((r) => r.id), allEnded: allEnded(ot[0]) });

  check('(11) A SPARED ROW\'S DEATH IS RECORDED ONCE, NOT ONCE PER BOUNDARY: a third turn ends and `fgSub` still has exactly one death on the ledger, while that turn\'s own main-thread orphan records normally — the consumer-side question of what a persisted-then-settled row does to the ledger over repeated boundaries',
    deathsForId(ot[2], 'fgSub').length === 1 && deathsForId(ot[2], 'mainOrphan3').length === 1,
    { fgSubDeathsAtB3: deathsForId(ot[2], 'fgSub').length, mainOrphan3: deathsForId(ot[2], 'mainOrphan3').length, allEnded: allEnded(ot[2]) });

  check('(12) NOTHING ACCUMULATES OR MISREPORTS WHILE THE ROW IS SPARED: at the boundary where `fgSub` persists, the running set is exactly the two lanes that are genuinely working (`rootW`, `fgSub`) — the settled main-thread lane left, the spared row appears ONCE and is not duplicated per sweep — and the session does not claim a turn is in flight',
    JSON.stringify((ot[0]?.running ?? []).map((r) => r.id).sort()) === JSON.stringify(['fgSub', 'rootW'])
      && ot[0]?.turn?.running === false
      && deathsForId(ot[0], 'mainOrphan').length === 1,
    { running: (ot[0]?.running ?? []).map((r) => r.id), turnRunning: ot[0]?.turn?.running, mainOrphan: deathsForId(ot[0], 'mainOrphan').length });

  // ---- NESTEDTERMINAL — the other half: live work must NOT start being reported dead. ----
  const nt = await runTurns('nestedterminal', [
    'a live background root, an intermediate agent that finishes, and the intermediate\'s children still in flight',
    'another boundary while the root is still working',
    'the root retires too',
  ]);

  check('(13) A CHILD OF A DEAD INTERMEDIATE UNDER A LIVE ROOT IS STILL SPARED: `midSub` emitted its own terminal frame, but `rootW` — its background owner and the leaves\' grandparent — is still on the level. Neither `leafSub` (an agent lane) nor `leafBash` (a tool lane) may be recorded dead: liveness is a fact about the whole CHAIN, and tightening it on the owner must not start fabricating deaths one level down',
    deathsForId(nt[0], 'leafSub').length === 0 && rowsById(nt[0], 'leafSub').length === 1 && deathsForId(nt[0], 'leafBash').length === 0,
    { leafSubDeaths: deathsForId(nt[0], 'leafSub').length, leafSubRows: rowsById(nt[0], 'leafSub').length, leafBashDeaths: deathsForId(nt[0], 'leafBash').length, running: (nt[0]?.running ?? []).map((r) => r.id), allEnded: allEnded(nt[0]) });

  check('(14) AND SURVIVES A REPEATED BOUNDARY: a second turn ends with the root still live and the leaves are still not recorded dead, nor settled — the spare is re-asked every sweep and answers the same way while the evidence is the same',
    deathsForId(nt[1], 'leafSub').length === 0 && rowsById(nt[1], 'leafSub').length === 1 && deathsForId(nt[1], 'leafBash').length === 0,
    { leafSubDeaths: deathsForId(nt[1], 'leafSub').length, leafSubRows: rowsById(nt[1], 'leafSub').length, leafBashDeaths: deathsForId(nt[1], 'leafBash').length, allEnded: allEnded(nt[1]) });

  check('(15) DEFERRED ACROSS THREE BOUNDARIES, NEVER LOST: the root retires with its own terminal frame at the third turn and `leafSub` records its honest death in that sweep — a spared AGENT row eventually reports its death once its ancestors retire, however many boundaries it was held over, and the terminal frame is what ends the deferral (before this fix the stale level entry would have deferred it forever)',
    deathsForId(nt[2], 'leafSub').length === 1 && rowsById(nt[2], 'leafSub').length === 0,
    { leafSubDeaths: deathsForId(nt[2], 'leafSub').map((o) => o.kind), leafSubRows: rowsById(nt[2], 'leafSub').length, running: (nt[2]?.running ?? []).map((r) => r.id), allEnded: allEnded(nt[2]) });

  check('(15b) A SPARED **TOOL** ROW IS OMITTED, NOT DEFERRED — THE PRE-EXISTING BUG-096/BUG-030 POSTURE, PINNED HERE SO IT CANNOT DRIFT EITHER WAY: `leafBash` SETTLED at the first boundary (BUG-030: no tool call may spin past a `result`) with only its ledger write held, so no later sweep revisits it and no death is ever written for it. That is deliberate honesty-by-omission, and it is the OPPOSITE of an agent row, which stays running and is re-judged. This check fails if a future tightening starts fabricating a bash death, and equally if a tool row is left spinning',
    deathsForId(nt[2], 'leafBash').length === 0 && rowsById(nt[0], 'leafBash').length === 0 && rowsById(nt[2], 'leafBash').length === 0,
    { leafBashDeathsEver: deathsForId(nt[2], 'leafBash').map((o) => o.kind), leafBashRowsAtB1: rowsById(nt[0], 'leafBash').length, leafBashRowsAtB3: rowsById(nt[2], 'leafBash').length });

  check('(16) AND EVERY MAIN-THREAD ORPHAN OF ALL THREE NESTED SWEEPS STILL DIES: direction (a) is not traded for any of the above',
    deathsForId(nt[2], 'mainOrphan').length === 1 && deathsForId(nt[2], 'mainOrphan2').length === 1 && deathsForId(nt[2], 'mainOrphan3').length === 1,
    { mainOrphans: ['mainOrphan', 'mainOrphan2', 'mainOrphan3'].map((id) => deathsForId(nt[2], id).length) });

  // ---- TERMINALFIRST — the regression b0dfaf6 introduced: a terminal report whose row
  // does not exist yet is retired and then DROPPED, so the row is never marked terminal.
  const tf = await runScenario('terminalfirst', 'a terminal report arrives before its own task row exists');

  check('(17) A TASK THAT POSITIVELY REPORTED `completed` IS NEVER RECORDED AS A DEATH: `rootW` emitted `task_updated completed` at a moment when this bridge had no row for it (the re-attach / skip_transcript shape the retirement is taken from the FRAME for). When its row then appeared, the terminal report had to still apply to it. MUST-FAIL on b0dfaf6: the handler retired the task and returned early on `if (!a) return`, dropping the status, so the row was built `running`, nothing re-applied it, and the sweep settled a finished task as `rootW:unknown` — an unmarked death for work that said it finished. NOT a regression on the parent a7f6ca2, where the stale level entry happened to spare the row',
    endedForId(tf, 'rootW').length === 0,
    { rootWEnded: endedForId(tf, 'rootW').map((o) => o.kind), allEnded: allEnded(tf) });

  check('(18) …AND THAT TASK IS NOT LEFT SPINNING EITHER: a terminal report ends the row, whenever the row shows up — the status is applied, not merely withheld from the ledger',
    rowsById(tf, 'rootW').length === 0,
    { rootWRunningRows: rowsById(tf, 'rootW').length, running: (tf?.running ?? []).map((r) => r.id) });

  check('(19) …AND THE CHILD\'S DEATH IS STILL OWED, BECAUSE IN THIS ORDERING THE OWNER REALLY DID RETIRE FIRST: `fgSub`\'s owner `rootW` reported `completed` BEFORE this boundary, so nothing in its chain is live and its honest death is recorded here. This asserts the ordering the stream actually drives — the opposite assertion (spared) would be true only for a stream where the owner is still live at the boundary, which is what checks (10) and (12) cover in the `ownerterminal` scenario',
    deathsForId(tf, 'fgSub').length === 1 && rowsById(tf, 'fgSub').length === 0,
    { fgSubDeaths: deathsForId(tf, 'fgSub').map((o) => o.kind), fgSubRows: rowsById(tf, 'fgSub').length, allEnded: allEnded(tf) });

  check('(20) AND THE MAIN-THREAD ORPHAN OF THAT SWEEP STILL DIES: direction (a) untraded in the new scenario too',
    deathsForId(tf, 'mainOrphan').length === 1,
    { mainOrphanDeaths: deathsForId(tf, 'mainOrphan').length });

  // ---- UNSEENTERMINAL — the reachable cousin (re-attach) + a repeated terminal report.
  const ut = await runScenario('unseenterminal', 'a terminal report for a task this bridge never saw, and a terminal report delivered twice', 2);

  check('(21) A TERMINAL REPORT FOR A TASK THIS BRIDGE NEVER SAW IS ABSORBED, NOT FABRICATED INTO ANYTHING: `ghostBg` was listed by the engine\'s level (the re-attach shape — work that predates this bridge) and then reported `completed`, with no `task_started` ever arriving. No ledger row may be written for a lane that never existed here, no row may appear in the live set, and the sweep must be unharmed',
    endedForId(ut, 'ghostBg').length === 0 && rowsById(ut, 'ghostBg').length === 0
      && deathsForId(ut, 'mainOrphan').length === 1 && deathsForId(ut, 'mainOrphan2').length === 1,
    { ghostBgEnded: endedForId(ut, 'ghostBg').map((o) => o.kind), ghostBgRows: rowsById(ut, 'ghostBg').length, mainOrphans: [deathsForId(ut, 'mainOrphan').length, deathsForId(ut, 'mainOrphan2').length], allEnded: allEnded(ut) });

  check('(22) ONE DEATH REPORTED TWICE IS ONE DEATH ON THE LEDGER: the engine reported `dblFail` `failed` twice (a re-delivery, a resumed stream, a notification racing a patch). The ledger is the record the orchestrator is briefed from, so a second row for the same report is a fabricated second death — the same dishonesty as an unmarked one, in the other direction',
    endedForId(ut, 'dblFail').length === 1 && endedForId(ut, 'dblFail')[0]?.kind === 'failed',
    { dblFailEnded: endedForId(ut, 'dblFail').map((o) => o.kind), allEnded: allEnded(ut) });

  // ---- SETTLENORETIRE — the seam the whole property balance rests on.
  const sr = await runScenario('settlenoretire', 'a lane the sweep settles is then declared live background work by the engine', 2);

  check('(23) THE TURN-END SWEEP\'S OWN SETTLE NEVER REACHES RETIREMENT: sweep #1 settled `lateBg` on this bridge\'s INFERENCE (no evidence, no chain). The engine then said `lateBg` IS live background work. Because only the engine\'s own terminal frame retires a task, that level frame is heard and `childBash` is spared. If a settle ever retired, the id would be filtered out of every later level frame forever, a genuinely live lane would be permanently unhearable, and its children\'s deaths would be fabricated at every boundary — the entire property balance rests on this seam',
    deathsForId(sr, 'childBash').length === 0,
    { childBashDeaths: deathsForId(sr, 'childBash').map((o) => o.kind), running: (sr?.running ?? []).map((r) => r.id), allEnded: allEnded(sr) });

  check('(24) …AND THE SETTLE ITSELF IS STILL HONEST IN BOTH SWEEPS: `lateBg` had no evidence and no chain, so its `unknown` death IS recorded, and both main-thread orphans record — sparing the child buys nothing from direction (a)',
    deathsForId(sr, 'lateBg').length === 1 && deathsForId(sr, 'mainOrphan').length === 1 && deathsForId(sr, 'mainOrphan2').length === 1,
    { lateBgDeaths: deathsForId(sr, 'lateBg').map((o) => o.kind), mainOrphans: [deathsForId(sr, 'mainOrphan').length, deathsForId(sr, 'mainOrphan2').length] });

  // ---- BGLIFETIME — the lifetime query answering one frame earlier must not cut off live work.
  const bl = await runDetached('bglifetime', 'two background roots, one of which retires while nobody is attached');

  check('(25) RETIRING A TASK ONE FRAME EARLIER THAN THE LEVEL WOULD CANNOT CUT OFF LIVE WORK: a DETACHED session whose close fuse re-asks `workLifetime()` every few seconds saw `rootA` retire with its own terminal frame while `rootB` was still on the level with a foreground subagent in flight. Withdrawing the retired task must remove exactly that task from the lifetime answer — the session stays open, because a close reaps the broker and the broker\'s SIGTERM is what kills the work that is still running',
    bl.rootBRows >= 1 && bl.fgSubBRows >= 1,
    { rootBRows: bl.rootBRows, fgSubBRows: bl.fgSubBRows, running: bl.running, waitedMs: bl.waitedMs });

  check('(26) …AND NOTHING WAS RECORDED DEAD WHILE IT WAITED: neither the still-live root nor its foreground subagent is written into the ledger by the detached session\'s own re-checks',
    bl.deaths.length === 0,
    { endedWhileDetached: bl.deaths });

  // ---- CONFLICTREPORT — two terminal reports for one task that DISAGREE (BUG-105,
  // 3rd clean-room verdict, property (c)). Each ordering driven twice: row-late vs
  // row-present. The row-present path is the reference; the ledgers must match.
  const cr = await runScenario('conflictreport', 'two terminal reports for one task that disagree');
  const crLog = serverLog;
  const crEvents = lastEvents;
  const kinds = (snap, id) => endedForId(snap, id).map((o) => o.kind);

  check('(27) THE FINDING: A LATER ENGINE-REPORTED **FAILURE** IS NOT DISCARDED BECAUSE AN EARLIER FRAME SAID `completed`. `confLate` got `task_updated completed` then `task_updated failed`, BOTH before its row existed. Pre-fix `#retireTask` kept the first report, `task_started` applied `completed`, and `#recordAgentEnd` drops a `completed` — so the engine-reported failure left NO LEDGER ROW AT ALL. Property (c) says the ledger reflects what the ENGINE said',
    JSON.stringify(kinds(cr, 'confLate')) === '["failed"]',
    { confLateEnded: kinds(cr, 'confLate'), allEnded: allEnded(cr) });

  check('(28) …AND THAT IS NOT A NEW PREFERENCE BUT **PARITY**: every ordering driven with the row LATE lands the same ledger as the same ordering with the row ALREADY PRESENT. The row-present path is where each of these decisions was already made; "a terminal report marks the eventual row terminal IN EITHER ORDER" is worth nothing if the two orders disagree about WHICH report',
    JSON.stringify(kinds(cr, 'confLate')) === JSON.stringify(kinds(cr, 'confRow'))
      && JSON.stringify(kinds(cr, 'revLate')) === JSON.stringify(kinds(cr, 'revRow'))
      && JSON.stringify(kinds(cr, 'blanketLate')) === JSON.stringify(kinds(cr, 'blanketRow'))
      && JSON.stringify(kinds(cr, 'twoLate')) === JSON.stringify(kinds(cr, 'twoRow')),
    { 'completed→failed': [kinds(cr, 'confLate'), kinds(cr, 'confRow')], 'failed→completed': [kinds(cr, 'revLate'), kinds(cr, 'revRow')],
      'completed→blanket': [kinds(cr, 'blanketLate'), kinds(cr, 'blanketRow')], 'failed→killed': [kinds(cr, 'twoLate'), kinds(cr, 'twoRow')] });

  check('(29) A DEATH THE ENGINE NAMED IS NEVER RETRACTED BY A LATER `completed`, AND NEVER RECLASSIFIED BY A SECOND ONE: `failed` then `completed` keeps `failed` (the row-present path could not have retracted the row it already wrote), and `failed` then `killed` records the FIRST, most specific ending once',
    JSON.stringify(kinds(cr, 'revLate')) === '["failed"]' && JSON.stringify(kinds(cr, 'twoLate')) === '["failed"]',
    { revLate: kinds(cr, 'revLate'), twoLate: kinds(cr, 'twoLate') });

  check('(30) A TEARDOWN BLANKET IS NEVER PROMOTED INTO A DEATH: a SIGTERM\'d CLI emits `task_notification status:"stopped"` for EVERY still-open task, which is a statement about the session, not a verdict on a task the engine already said `completed`. No ledger row for either arrangement — the same thing the row-present handler has always done with its `a.status === \'running\'` guard. This is the check that makes "last report wins" unadoptable',
    kinds(cr, 'blanketLate').length === 0 && kinds(cr, 'blanketRow').length === 0,
    { blanketLate: kinds(cr, 'blanketLate'), blanketRow: kinds(cr, 'blanketRow') });

  check('(31) THE DISAGREEMENT IS SURFACED, NOT SILENTLY RESOLVED: two conflicting terminal reports for one task means something upstream is wrong (a re-delivered stream, a reused id, a blanket landing late), so every conflict is warned on the server — INCLUDING the `blanketLate` one, where the resolution correctly writes no ledger row at all and the warning is therefore the only place the signal exists',
    /CONFLICTING terminal outcomes for task confLate/.test(crLog) && /CONFLICTING terminal outcomes for task blanketLate/.test(crLog),
    { warnedTasks: [...crLog.matchAll(/CONFLICTING terminal outcomes for task (\S+)/g)].map((m) => m[1]) });

  check('(32) …AND THE ROW THE READER IS BRIEFED FROM SAYS SO: the ledger `detail` for a death written after a conflict quotes both reports, so the orchestrator reading "this agent failed" also learns the engine contradicted itself about it',
    /CONFLICTING terminal outcomes/.test(endedForId(cr, 'confLate')[0]?.detail ?? ''),
    { confLateDetail: endedForId(cr, 'confLate')[0]?.detail ?? null });

  check('(33) A DUPLICATE ROW APPEARING AFTER A REPORT IS STILL ONE DEATH AND STILL NOT LEFT SPINNING: `dupLate` was reported `failed` with no row, then its `task_started` was delivered TWICE. One ledger row, and no running row from the duplicate',
    JSON.stringify(kinds(cr, 'dupLate')) === '["failed"]' && rowsById(cr, 'dupLate').length === 0,
    { dupLateEnded: kinds(cr, 'dupLate'), dupLateRows: rowsById(cr, 'dupLate').length });

  check('(34) THE LIVE DISPLAY IS NOT TOLD A FINISHED TASK IS STARTING: when the report is already held, `task_started` must announce the row as SETTLED (one `agent-completed`), never as `agent-started` — app.js\'s `agent-started` handler hardcodes `th.status = \'running\'`, so the old order genuinely put the row into the strip as live and relied on the event behind it to correct it. A consumer that samples between them, or replays only starts, keeps a ghost. The still-running arm is the control: `mainOrphan` IS announced',
    countEv(crEvents, (e) => e.t === 'agent-started' && e.agent?.agentId === 'confLate') === 0
      && countEv(crEvents, (e) => e.t === 'agent-completed' && e.agent?.agentId === 'confLate') === 1
      && countEv(crEvents, (e) => e.t === 'agent-started' && e.agent?.agentId === 'mainOrphan') === 1,
    { confLateStarted: countEv(crEvents, (e) => e.t === 'agent-started' && e.agent?.agentId === 'confLate'),
      confLateCompleted: countEv(crEvents, (e) => e.t === 'agent-completed' && e.agent?.agentId === 'confLate'),
      mainOrphanStarted: countEv(crEvents, (e) => e.t === 'agent-started' && e.agent?.agentId === 'mainOrphan') });

  check('(35) …AND NOTHING IN THIS SCENARIO IS LEFT SPINNING OR LOSES DIRECTION (a): every reported task is off the live set, and the main-thread orphan of the sweep still records its honest death',
    (cr?.running ?? []).length === 0 && deathsForId(cr, 'mainOrphan').length === 1,
    { running: (cr?.running ?? []).map((r) => r.id), mainOrphanDeaths: deathsForId(cr, 'mainOrphan').length });

  // ---- CROSSBOUNDARY — a terminal report landing on the far side of a REAL
  // process boundary, onto a bridge whose in-memory state is empty.
  const cb = await runAcrossRestart('crossboundary', 'fakesdk-crossboundary-105');

  check('(36) PRECONDITION: the pre-boundary side behaved — the foreground subagent of the live background root was SPARED at its turn end (no death), and the main-thread orphan of that same sweep died',
    endedForId(cb.before, 'fgSub').length === 0 && deathsForId(cb.before, 'mainOrphan').length === 1,
    { fgSubEndedBefore: endedForId(cb.before, 'fgSub').map((o) => o.kind), mainOrphanBefore: deathsForId(cb.before, 'mainOrphan').length, resumed: cb.resumeAck?.reattached ?? null, strayPidsKilled: cb.strays.length });

  check('(37) A TERMINAL REPORT LANDING AFTER A REAL PROCESS BOUNDARY REACHES THE LEDGER EXACTLY ONCE: the server was killed, a fresh one booted on the same dataDir and store, the session was resumed onto a BRAND-NEW bridge (empty `#agents`, empty `#terminallyReportedTasks`), and only there did the engine re-announce `fgSub` and report it `failed`. The engine\'s outcome must survive the boundary — one `failed` row, not zero and not two',
    JSON.stringify(kinds(cb.after, 'fgSub')) === '["failed"]',
    { fgSubEndedAfter: kinds(cb.after, 'fgSub'), allEndedAfter: allEnded(cb.after) });

  check('(38) …AND A REPORT FOR A TASK THE NEW BRIDGE NEVER SAW IS STILL ABSORBED, NOT FABRICATED: `ghostX` was reported `failed` on the far side with no row and none coming. Nothing may be invented for a lane this bridge has no row for, and the far-side sweep must still record its own main-thread orphan',
    endedForId(cb.after, 'ghostX').length === 0 && rowsById(cb.after, 'ghostX').length === 0
      && deathsForId(cb.after, 'mainOrphan3').length === 1,
    { ghostXEnded: endedForId(cb.after, 'ghostX').map((o) => o.kind), ghostXRows: rowsById(cb.after, 'ghostX').length, mainOrphan3: deathsForId(cb.after, 'mainOrphan3').length, allEndedAfter: allEnded(cb.after) });

  // ---- BLANKETFIRST / NOBLANKET — the 4th clean-room verdict: a teardown blanket
  // that arrives BEFORE the row, and the same stream with the blanket removed.
  const bf = await runScenario('blanketfirst', 'a teardown blanket arrives before the task row');
  const bfEvents = lastEvents;
  const nb = await runScenario('noblanket', 'the same stream with the blanket frames removed');
  const kinds2 = (snap, id) => endedForId(snap, id).map((o) => o.kind);
  const ENGINE_REPORTED = ['completed', 'failed', 'killed'];

  check('(39) THE 4th VERDICT\'S FINDING — A TEARDOWN BLANKET ARRIVING BEFORE A ROW IS NOT PROMOTED INTO AN ENGINE-REPORTED DEATH: `task_notification status:"stopped"` was the FIRST frame for `blanketFirst`, before this bridge had a row. MUST-FAIL on d2a56b5: it was stored as that task\'s outcome and applied as `killed` when the row appeared — an engine-reported death for a task the engine never gave a per-task verdict on, from a frame the row-present handler treats as a mere session notice. No `completed`/`failed`/`killed` may be on the ledger for it',
    kinds2(bf, 'blanketFirst').every((k) => !ENGINE_REPORTED.includes(k)),
    { blanketFirstEnded: kinds2(bf, 'blanketFirst'), allEnded: allEnded(bf) });

  check('(40) …AND THE PROPERTY IS AN EQUIVALENCE, NOT A PREFERRED VALUE: the `noblanket` control is the SAME stream with only the blanket frames removed, and `blanketFirst` lands the IDENTICAL ledger and the identical live set. A blanket leaves NO TRACE on the outcome path — it is neither promoted into a death nor allowed to suppress the honest turn-end death the row would have had anyway (the over-correction direction: a row that records nothing at all)',
    JSON.stringify(kinds2(bf, 'blanketFirst')) === JSON.stringify(kinds2(nb, 'blanketFirst'))
      && rowsById(bf, 'blanketFirst').length === rowsById(nb, 'blanketFirst').length,
    { withBlanket: kinds2(bf, 'blanketFirst'), withoutBlanket: kinds2(nb, 'blanketFirst'),
      rows: [rowsById(bf, 'blanketFirst').length, rowsById(nb, 'blanketFirst').length] });

  check('(41) THE OPPOSITE DIRECTION — A GENUINE DEATH DURING THE SAME TEARDOWN IS STILL RECORDED, EXACTLY ONCE, AND BY THE ORDINARY INFERENCE PATH: `liveA` and `liveB` were rows this bridge WAS holding running when the blanket landed. BUG-105 (7th verdict) revised WHAT records them: the blanket no longer settles them into an engine-reported `killed` — it is a statement about the process, not a verdict about these tasks — so the turn-end sweep settles them and writes its honest death, one row each. The equivalence with the `noblanket` control is now TOTAL: with the blanket and without it, these two land the identical ledger. Over-correcting into "a blanket never means anything" would still lose two real deaths here, and this is the check that catches it',
    deathsForId(bf, 'liveA').length === 1 && deathsForId(bf, 'liveB').length === 1
      && JSON.stringify(kinds2(bf, 'liveA')) === JSON.stringify(kinds2(nb, 'liveA'))
      && JSON.stringify(kinds2(bf, 'liveB')) === JSON.stringify(kinds2(nb, 'liveB')),
    { liveA: kinds2(bf, 'liveA'), liveB: kinds2(bf, 'liveB'),
      withoutBlanket: [kinds2(nb, 'liveA'), kinds2(nb, 'liveB')], allEnded: allEnded(bf) });

  check('(42) …AND SO IS A REAL PER-TASK VERDICT THAT ARRIVES DURING THE TEARDOWN WITH NO ROW YET: `patchLate` got `task_updated failed` before its `task_started`. A `task_updated` is the engine\'s specific word about ONE task, so it settles the eventual row in either ordering — the demotion is of the BLANKET frame type, not of row-less reports',
    JSON.stringify(kinds2(bf, 'patchLate')) === '["failed"]' && JSON.stringify(kinds2(nb, 'patchLate')) === '["failed"]',
    { withBlanket: kinds2(bf, 'patchLate'), withoutBlanket: kinds2(nb, 'patchLate') });

  check('(43) A BLANKET FOR A TASK THAT NEVER GETS A ROW INVENTS NOTHING, AND THE SWEEP OF THAT TEARDOWN STILL RECORDS ITS MAIN-THREAD ORPHAN: direction (a) is untraded in the teardown shape too',
    endedForId(bf, 'ghostBlanket').length === 0 && rowsById(bf, 'ghostBlanket').length === 0
      && deathsForId(bf, 'mainOrphan').length === 1 && deathsForId(nb, 'mainOrphan').length === 1,
    { ghostBlanketEnded: endedForId(bf, 'ghostBlanket').map((o) => o.kind), mainOrphans: [deathsForId(bf, 'mainOrphan').length, deathsForId(nb, 'mainOrphan').length] });

  check('(44) …AND NO CONSUMER OF THE LIVE STREAM WAS EVER TOLD THE BLANKETED TASK DIED: not one `agent-completed` carrying a `killed`/`failed` status for `blanketFirst` went out on the socket. The ledger and the event stream have to agree — a fabricated death that only appears in the strip is still a fabricated death',
    countEv(bfEvents, (e) => e.t === 'agent-completed' && e.agent?.agentId === 'blanketFirst'
      && (e.agent?.status === 'killed' || e.agent?.status === 'failed')) === 0,
    { blanketFirstCompletedEvents: bfEvents.filter((e) => e.t === 'agent-completed' && e.agent?.agentId === 'blanketFirst').map((e) => e.agent?.status) });

  // ---- STRUCTURE — the equivalence is one decision, not two that must be kept
  // in sync, and retirement has exactly the two entry points it is documented to.
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'server', 'agent-bridge.ts'), 'utf8');
  const retireCalls = [...bridgeSrc.matchAll(/this\.#retireTask\(/g)].length;
  const establishWrites = [...bridgeSrc.matchAll(/#establishedOutcomes\.set\(/g)].length;
  const settlesCalls = [...bridgeSrc.matchAll(/this\.#terminalFrameSettles\(/g)].length;
  // The predicate's own body — from its signature to its closing brace, so check (78)
  // can assert the ORDER of its arms without the doc comment above it interfering.
  const settleBody = (bridgeSrc.match(/#terminalFrameSettles\(\s*taskId: string,[\s\S]*?\n  \}/) ?? [''])[0];

  check('(45) THE EQUIVALENCE IS STRUCTURAL: there is exactly ONE call to the settle predicate and exactly ONE writer of the map the eventual row is settled from, so the row-less path cannot hold an outcome the row-present path would have refused. If a future edit adds a second write site this check fails — which is the point: the previous fix restated the parity in prose and it drifted for the other report type within one round',
    establishWrites === 1 && settlesCalls === 1,
    { establishedOutcomesWriteSites: establishWrites, settlePredicateCallSites: settlesCalls });

  check('(46) AND RETIREMENT IS STILL REACHABLE ONLY FROM THE ENGINE\'S OWN TERMINAL FRAMES: exactly two call sites, both inside the `task_updated` / `task_notification` handlers, both passing a literal authority. Nothing this bridge INFERS — the turn-end sweep\'s settle, the session-end record, the detached close, the stall detector — can reach it, which is the seam checks (23) and (47) depend on',
    retireCalls === 2
      && /case 'task_updated':[\s\S]*?this\.#retireTask\(String\(m\.task_id\), status, 'patch', /.test(bridgeSrc)
      && /case 'task_notification':[\s\S]*?this\.#retireTask\(String\(m\.task_id\), terminal, 'notification', /.test(bridgeSrc),
    { retireTaskCallSites: retireCalls });

  // ---- SETTLEINTERRUPT — the OTHER way this bridge's own settling could reach
  // retirement: an interrupted turn settles every running row `killed`.
  const si = await runInterrupted('settleinterrupt', [
    'a lane that will be settled by an interrupt rather than by a terminal frame',
    'the engine then declares that same lane live background work',
  ]);

  check('(47) AN INTERRUPT-DRIVEN SETTLE DOES NOT RETIRE EITHER: the user interrupted turn 1, so the sweep settled `intLane` `killed` — the most terminal-looking status this bridge writes on its OWN inference. The engine then said `intLane` IS live background work, and that level frame must still be heard: `intChild` is spared. Scenario (23) drives the ordinary turn-end settle; this drives the interrupt, which is the likelier candidate to be mistaken for a real ending',
    deathsForId(si[1], 'intChild').length === 0,
    { intChildDeaths: deathsForId(si[1], 'intChild').map((o) => o.kind), running: (si[1]?.running ?? []).map((r) => r.id), allEnded: allEnded(si[1]) });

  check('(48) …AND THE INTERRUPTED TURN IS STILL HONEST: the interrupt\'s own sweep recorded `intLane` and the turn\'s main-thread orphan, and the second turn recorded its own — an interrupt suppresses nothing',
    endedForId(si[0], 'intLane').length === 1 && endedForId(si[0], 'mainOrphan').length === 1
      && endedForId(si[1], 'mainOrphan2').length === 1,
    { intLane: endedForId(si[0], 'intLane').map((o) => o.kind), mainOrphan: endedForId(si[0], 'mainOrphan').map((o) => o.kind), mainOrphan2: endedForId(si[1], 'mainOrphan2').map((o) => o.kind) });

  // ---- A CONFLICT THAT RESOLVES TO WRITING NOTHING: is a genuine outcome lost
  // where only server stderr can see it? Read the warnings back and check each one.
  const warned = [...crLog.matchAll(/CONFLICTING terminal outcomes for task (\S+) \(([^)]*)\); the recorded outcome is ([^\n]*)/g)]
    .map((m) => ({ task: m[1], seq: m[2], recorded: m[3].trim() }));
  const lostSilently = warned.filter((w) => /^(failed|killed)$/.test(w.recorded) && endedForId(cr, w.task).length === 0);

  check('(49) NO CONFLICT RESOLVES TO A DEATH THAT ONLY SERVER STDERR KNOWS ABOUT: every warned conflict whose resolution IS a death also has that death on the ledger, carrying the conflict note. The conflicts that write no ledger row are exactly the ones that resolve to a completion (`blanketLate`) — nothing was lost there, because no death was ever established. So the stderr warning is a diagnostic for an upstream anomaly, not the sole record of an outcome',
    lostSilently.length === 0,
    { warned: warned.map((w) => `${w.task}:${w.seq}→${w.recorded}`), lostSilently: lostSilently.map((w) => w.task) });

  // ---- UILIVE — property (e) in a REAL BROWSER, over a busy mid-turn state.
  const ui = await runUiLive();

  check('(50) BROWSER SETUP: real headless Brave over CDP booted the dashboard on the project and the composer\'s own Enter path started a turn whose lanes reached the strip — the live display, not a scripted DOM',
    ui.booted && ui.onProject && ui.sawLive,
    { booted: ui.booted, onProject: ui.onProject, sawLiveLane: ui.sawLive, strip: ui.mid.strip.map((r) => r.key) });

  check('(51) PROPERTY (e) IN THE REAL RUNNING DISPLAY: a task the engine REPORTED FINISHED never appears as live. `doneLate` was reported `failed` BEFORE its row existed (the row-less path this ticket keeps re-breaking) and `doneEarly` `completed` after its row existed — mid-turn, with other lanes genuinely running, NEITHER is a ◐ row in the strip, and neither thread is left in `running`. Asserted here in the DOM for the first time: two earlier rounds could only reach the event and API level because `public/app.js` was another lane\'s live file',
    !ui.mid.strip.some((r) => r.key === 'doneLate' || r.key === 'doneEarly')
      && ui.mid.threads.doneLate !== 'running' && ui.mid.threads.doneEarly !== 'running',
    { strip: ui.mid.strip.map((r) => `${r.key}${r.run ? ':run' : ''}`), doneLateThread: ui.mid.threads.doneLate ?? null, doneEarlyThread: ui.mid.threads.doneEarly ?? null });

  check('(52) …AND THE CONTROL PROVES THE DISPLAY IS ACTUALLY WORKING: `liveOne` IS a running row in the strip at that same instant, and the server\'s own snapshot agrees with the DOM about who is live — a display that showed nothing at all would pass (51) vacuously',
    ui.mid.strip.some((r) => r.key === 'liveOne' && r.run)
      && (ui.midSnap?.running ?? []).some((r) => r.id === 'liveOne')
      && !(ui.midSnap?.running ?? []).some((r) => r.id === 'doneLate' || r.id === 'doneEarly'),
    { strip: ui.mid.strip.map((r) => `${r.key}${r.run ? ':run' : ''}`), snapshot: (ui.midSnap?.running ?? []).map((r) => r.id) });

  check('(53) THE BLANKETED LANE IS SHOWN AS LIVE, WHICH IS THE HONEST ANSWER AND THE PINNED CONSEQUENCE OF THE FIX: a teardown blanket that arrived before `blanketUI`\'s row established NO per-task outcome, so the row is work this bridge has no ending for and the display says so. Pre-fix it was shown settled on the strength of a session-wide blanket. If a future change starts settling it again, this fails and (39) fails with it',
    ui.mid.strip.some((r) => r.key === 'blanketUI' && r.run),
    { strip: ui.mid.strip.map((r) => `${r.key}${r.run ? ':run' : ''}`) });

  check('(54) AND WHEN THE HELD TURN FINALLY ENDS, NOTHING IS LEFT SPINNING IN THE UI: no lane keeps a ◐ row after the turn — not the live one, not the blanketed one, and not the two the engine reported on',
    ui.settled && ui.after.strip.filter((r) => r.run).length === 0,
    { stripAfter: ui.after.strip.map((r) => `${r.key}${r.run ? ':run' : ''}`), threadsAfter: ui.after.threads });

  /* ==================== BUG-105, 5th independent clean-room verdict ====================
   * A SESSION-WIDE BLANKET MUST NOT PERMANENTLY VETO A LATER, REAL LIVENESS SIGNAL.
   * The 4th-verdict fix removed the fabrication direction (the blanket can no longer
   * be promoted into a death) but left the blanket writing the id into the veto both
   * liveness write sites read, with nothing able to withdraw it.
   */
  const ra = await runTurns('reannounce', [
    'a teardown blanket names a task this bridge has no row for',
    'the engine re-announces that same task as live background work',
    'a refreshed level frame still lists it',
    'and finally it really finishes',
  ]);

  check('(55) THE 5th VERDICT\'S FINDING — A TASK RE-ANNOUNCED AS LIVE AFTER A ROW-LESS TEARDOWN BLANKET IS NOT RECORDED DEAD WHILE IT IS WORKING: `reann` was named by a blanket before this bridge had any row for it, and the engine then announced it as live background work (level frame FIRST, then `task_started`). MUST-FAIL on 991ac79: the blanket wrote `reann` into the terminal-evidence veto, the level rebuild filtered it out and the background-birth tag refused it, so the sweep saw a `running` row nothing vouched for and wrote `reann:unknown` — a death for work the engine had just said was running',
    deathsForId(ra[1], 'reann').length === 0,
    { reannDeaths: deathsForId(ra[1], 'reann').map((o) => o.kind), allEnded: allEnded(ra[1]) });

  check('(56) …AND NEITHER IS THE FOREGROUND SUBAGENT UNDER IT: `reannChild`\'s only claim to being spared is that a member of its chain — `reann` — is live background work. Starving `reann` of that evidence fabricates the child\'s death too, one level down',
    deathsForId(ra[1], 'reannChild').length === 0 && rowsById(ra[1], 'reann').length === 1 && rowsById(ra[1], 'reannChild').length === 1,
    { childDeaths: deathsForId(ra[1], 'reannChild').map((o) => o.kind), running: (ra[1]?.running ?? []).map((r) => r.id) });

  check('(57) AND THE RE-ADMISSION SURVIVES THE NEXT LEVEL FRAME AND THE NEXT BOUNDARY: turn 3 refreshes the level with `reann` still on it — the withdrawal is not a one-frame reprieve that the next rebuild undoes, and no death is written at that boundary either',
    deathsForId(ra[2], 'reann').length === 0 && deathsForId(ra[2], 'reannChild').length === 0
      && rowsById(ra[2], 'reann').length === 1 && rowsById(ra[2], 'reannChild').length === 1,
    { reann: deathsForId(ra[2], 'reann').length, child: deathsForId(ra[2], 'reannChild').length, running: (ra[2]?.running ?? []).map((r) => r.id) });

  check('(58) THE OTHER DIRECTION ON THE SAME ROW: A GENUINELY FINISHED TASK STAYS FINISHED AND A STALE LEVEL FRAME CANNOT RESURRECT IT. Turn 4 gives `reann` a per-task `task_updated completed` and then a level frame that still lists it. The row settles, no later frame re-admits it, and the child\'s owed death is recorded EXACTLY ONCE at that boundary — the 1st verdict\'s invariant, re-proved on a row that was legitimately re-admitted first',
    rowsById(ra[3], 'reann').length === 0 && deathsForId(ra[3], 'reannChild').length === 1
      && endedForId(ra[3], 'reann').filter((o) => o.kind !== 'completed').length === 0,
    { reannRows: rowsById(ra[3], 'reann').length, reannEnded: endedForId(ra[3], 'reann').map((o) => o.kind),
      childDeaths: deathsForId(ra[3], 'reannChild').map((o) => o.kind), allEnded: allEnded(ra[3]) });

  check('(59) AND DIRECTION (a) IS UNTRADED ACROSS ALL FOUR SWEEPS: every main-thread orphan of every boundary records its honest death exactly once — the re-admission spares subagent rows by NAMED live evidence, never by blanket',
    deathsForId(ra[0], 'mainOrphan').length === 1 && deathsForId(ra[1], 'mainOrphan2').length === 1
      && deathsForId(ra[2], 'mainOrphan3').length === 1 && deathsForId(ra[3], 'mainOrphan4').length === 1,
    { orphans: [deathsForId(ra[0], 'mainOrphan').length, deathsForId(ra[1], 'mainOrphan2').length,
      deathsForId(ra[2], 'mainOrphan3').length, deathsForId(ra[3], 'mainOrphan4').length] });

  // ---- DONETHENSTART — the asymmetry that decides WHAT MAY BE WITHDRAWN.
  const dt = await runScenario('donethenstart', 'a finished task is re-announced and a stale level frame lists it');
  const dtEvents = lastEvents;

  check('(60) AN ESTABLISHED PER-TASK OUTCOME IS NOT WITHDRAWN BY A RE-ANNOUNCEMENT: `done1` was reported `completed` before its row existed; its `task_started` then arrived and a level frame listed it. The announcement is NOT newer evidence than a verdict about the same task, so the row is settled on arrival (one `agent-completed`, never `agent-started`) and is not in the live set',
    rowsById(dt, 'done1').length === 0
      && countEv(dtEvents, (e) => e.t === 'agent-started' && e.agent?.agentId === 'done1') === 0
      && countEv(dtEvents, (e) => e.t === 'agent-completed' && e.agent?.agentId === 'done1') === 1,
    { done1Rows: rowsById(dt, 'done1').length,
      started: countEv(dtEvents, (e) => e.t === 'agent-started' && e.agent?.agentId === 'done1'),
      completed: countEv(dtEvents, (e) => e.t === 'agent-completed' && e.agent?.agentId === 'done1') });

  check('(61) …AND THE OVER-PERMISSIVE FIX IS RULED OUT BY ITS CONSEQUENCE: `doneChild` is a foreground subagent of that finished task, so nothing in its chain is live and its honest death MUST be recorded here. A withdrawal rule keyed on "any `task_started`" would re-admit `done1` to the level from that stale frame and suppress this death for as long as the entry lingers — the exact 1st-verdict incident, re-entered through the new door',
    deathsForId(dt, 'doneChild').length === 1 && deathsForId(dt, 'mainOrphan').length === 1,
    { doneChildDeaths: deathsForId(dt, 'doneChild').map((o) => o.kind), allEnded: allEnded(dt) });

  // ---- TRICONFLICT — the conflict registry with THREE OR MORE frames, listed as
  // untested by the last two passes and exercised by neither.
  const tc = await runScenario('triconflict', 'three terminal reports for one task');
  const tcLog = serverLog;
  const kinds3 = (id) => endedForId(tc, id).map((o) => o.kind);
  const seqFor = (id) => ([...tcLog.matchAll(new RegExp(`CONFLICTING terminal outcomes for task ${id} \\(([^)]*)\\)`, 'g'))].pop()?.[1] ?? null);

  check('(62) THREE FRAMES, AND THE TWO ORDERINGS STILL LAND THE SAME LEDGER: `completed → failed → killed`, `completed → failed → failed` and `completed → failed → blanket` each driven with the row LATE and with the row PRESENT. Parity is the property; a registry that pairs first-seen against latest must not make the row-less path prefer a different report once a third frame arrives',
    JSON.stringify(kinds3('triLate')) === JSON.stringify(kinds3('triRow'))
      && JSON.stringify(kinds3('reLate')) === JSON.stringify(kinds3('reRow'))
      && JSON.stringify(kinds3('triBlanketLate')) === JSON.stringify(kinds3('triBlanketRow')),
    { 'c→f→k': [kinds3('triLate'), kinds3('triRow')], 'c→f→f': [kinds3('reLate'), kinds3('reRow')],
      'c→f→blanket': [kinds3('triBlanketLate'), kinds3('triBlanketRow')] });

  check('(63) …AND THE DEATH IS THE FIRST ONE THE ENGINE NAMED, RECORDED ONCE, WITH THE DISAGREEMENT ON THE ROW AND THE FULL SEQUENCE IN THE LOG: a third frame neither reclassifies the death nor adds a second one. The ledger `detail` quotes the conflict AS KNOWN WHEN THE ROW WAS WRITTEN (the second frame — the ledger does not retract, which is the documented honest limit), and the server warning carries all three reports in arrival order, identically for both orderings — so the registry pairs first-seen against latest the same way whether or not a row existed',
    JSON.stringify(kinds3('triLate')) === '["failed"]'
      && /completed, then failed/.test(endedForId(tc, 'triLate')[0]?.detail ?? '')
      && /completed, then failed/.test(endedForId(tc, 'triRow')[0]?.detail ?? '')
      && seqFor('triLate') === 'completed then failed then killed, latest via patch'
      && seqFor('triLate') === seqFor('triRow'),
    { triLate: kinds3('triLate'), detailLate: endedForId(tc, 'triLate')[0]?.detail ?? null,
      warnedLate: seqFor('triLate'), warnedRow: seqFor('triRow') });

  check('(64) …AND A THIRD FRAME THAT IS A RE-DELIVERY OF THE SECOND CHANGES NOTHING BUT THE DIAGNOSTIC: `completed → failed → failed` records one `failed`, in both orderings, and both orderings warn the same sequence — the registry is an arrival log, so a re-delivered frame is logged, never promoted into a second death',
    JSON.stringify(kinds3('reLate')) === '["failed"]' && seqFor('reLate') === seqFor('reRow')
      && !/killed/.test(endedForId(tc, 'reLate')[0]?.detail ?? ''),
    { reLate: kinds3('reLate'), reRow: kinds3('reRow'), seqLate: seqFor('reLate'), seqRow: seqFor('reRow') });

  // ---- REANNDETACH — the expensive direction: does a STARVED task reach the
  // close-on-detach path and cut off live work?
  const rd = await runDetachedSnap('reanndetach', 'a re-announced background root while nobody is attached');

  check('(65) THE DOWNSTREAM CONSEQUENCE THE 5th VERDICT COULD NOT TEST — A STARVED TASK REACHES THE CLOSE DECISION AND ITS WORK IS RECORDED DEAD: `workLifetime()` IS the level mirror, so a task filtered out of it makes a detached session answer "the engine reports no background task is running" — and `releaseSocketSession` closes on exactly that answer, reaping the broker whose SIGTERM kills the work. MUST-FAIL on 991ac79, measured: the sweep wrote `reannD:unknown` and `reannDChild:unknown` into the ledger while the CLI\'s own broker was still declaring the lane running, and the drop took the close branch instead of logging the detach. No ledger row may exist for either, and the drop must be a DETACH, named in the server\'s own log',
    endedForId(rd.snap, 'reannD').length === 0 && endedForId(rd.snap, 'reannDChild').length === 0
      && /detached instead of closed — work outlives the turn \(yes/.test(rd.log),
    { ended: rd.deaths, snapshotSource: rd.source, running: rd.running,
      detachLogged: (rd.log.match(/detached instead of closed[^\n]*/) ?? [null])[0] });

  check('(66) …AND THE WORK IS STILL THERE, ANSWERED BY THE BRIDGE THAT WAS ABOUT TO DECLARE IT DEAD: both the re-announced root and its foreground subagent are still live rows in the session\'s own snapshot after the detached fuse has re-checked several times. On 991ac79 the only surface that still knew the lane existed was the survivor broker\'s independent level sniff (`source:"survivor"`) — the engine itself contradicting the ledger this bridge had just written',
    rowsById(rd.snap, 'reannD').length === 1 && rowsById(rd.snap, 'reannDChild').length === 1,
    { running: rd.running, snapshotSource: rd.source, ended: rd.deaths });

  // ---- REANNUI — the real-browser display AFTER a re-announcement.
  const rui = await runUiLive('reannui', 'reannUI');

  check('(67) BROWSER SETUP (RE-ANNOUNCEMENT ARM): real headless Brave booted the dashboard and the composer\'s own Enter path started the turn; the re-announced lane reached the strip',
    rui.booted && rui.onProject && rui.sawLive,
    { booted: rui.booted, onProject: rui.onProject, sawLane: rui.sawLive, strip: rui.mid.strip.map((r) => r.key) });

  check('(68) THE LIVE DISPLAY AFTER A RE-ANNOUNCEMENT: when the held turn ends, the re-announced background lane is STILL a running row in the real DOM, and the server\'s snapshot agrees. MUST-FAIL on 991ac79: starved of its level entry, `reannUI` was settled by the turn-end sweep, so the user watching the strip saw live work vanish at the boundary',
    rui.settled && rui.after.strip.some((r) => r.key === 'reannUI' && r.run)
      && (rui.afterSnap?.running ?? []).some((r) => r.id === 'reannUI'),
    { stripAfter: rui.after.strip.map((r) => `${r.key}${r.run ? ':run' : ''}`),
      snapshotAfter: (rui.afterSnap?.running ?? []).map((r) => r.id),
      // OUT-OF-LANE FINDING, recorded rather than asserted: the client's own
      // BUG-030 turn-end sweep (`settleCut` in public/app.js) settles any agent
      // CARD still `running` at a turn-end as "cut by shutdown", on the assumption
      // that nothing from a turn can outlive its `result` — which is exactly what
      // background work does (BUG-037). The strip (server snapshot) and the card
      // therefore disagree for live background work at every boundary. Not this
      // lane's file and not introduced here; reported on the ticket.
      clientCardStateForReannUI: rui.after.agents.reannUI ?? null });

  check('(69) …AND THE CONTROL PROVES THE DISPLAY IS NOT JUST KEEPING EVERYTHING: `liveOne` is a MAIN-THREAD foreground lane with no chain, so the same boundary settles it — it is gone from the strip and its honest death is on the ledger. Live work shown live, contained work shown finished, in the same frame',
    !rui.after.strip.some((r) => r.key === 'liveOne' && r.run)
      && (rui.afterSnap?.ended ?? []).some((o) => o.agentId === 'liveOne'),
    { stripAfter: rui.after.strip.map((r) => `${r.key}${r.run ? ':run' : ''}`), endedAfter: allEnded(rui.afterSnap) });

  // ---- STRUCTURAL — the 5th verdict's rule made unrepresentable rather than
  // restated, in the same style as (45)/(46): the previous two rounds each stated
  // a correct rule in prose and had it drift within one round.
  const vetoDeletes = [...bridgeSrc.matchAll(/#retiredTasks\.delete\(/g)].length;
  const levelDerivations = [...bridgeSrc.matchAll(/this\.#backgroundTasks = /g)].length;

  check('(70) THE WITHDRAWAL HAS EXACTLY ONE SITE AND IT IS GUARDED BY THE ESTABLISHED OUTCOME: a veto is removed in one place, `#withdrawLivenessVeto`, which returns early when `#establishedOutcomes` holds a verdict for the task. "A finished task can never be resurrected" is therefore a property of the code\'s shape, not of every future caller remembering the guard',
    vetoDeletes === 1
      && /#withdrawLivenessVeto\(taskId: string\): void \{[\s\S]*?if \(this\.#establishedOutcomes\.has\(taskId\)\) return;[\s\S]*?this\.#retiredTasks\.delete\(taskId\);/.test(bridgeSrc),
    { retiredTasksDeleteSites: vetoDeletes });

  check('(71) AND THE LEVEL-DERIVED LIVE SET HAS EXACTLY ONE WRITER, SO FRAME ORDER CANNOT CHANGE THE ANSWER: `#backgroundTasks` is assigned only inside `#rebuildBackgroundLevel()`, from the raw level frame minus the veto. A level frame that lands before the announcement and one that lands after are the same computation over the same two inputs — the ordering the SDK explicitly leaves unspecified is no longer a variable',
    levelDerivations === 1
      && /#rebuildBackgroundLevel\(\): void \{\s*this\.#backgroundTasks = new Map\(\s*\[\.\.\.this\.#levelRaw\]\.filter\(\(\[id\]\) => !this\.#retiredTasks\.has\(id\)\),/.test(bridgeSrc),
    { backgroundTasksAssignments: levelDerivations });

  // ---- NOTIFVERDICT — the 6th verdict's finding, with the 5th verdict's property
  // driven on the SAME run so the two cannot be traded for one another.
  const nv = await runTurns('notifverdict', [
    'row-less terminal frames: two per-task verdicts, two teardown blankets, one parity pair',
    'every one of them is announced, in both frame orderings',
  ]);
  const nvEvents = lastEvents;

  check('(72) THE 6th VERDICT\'S FINDING — A TASK THE ENGINE POSITIVELY REPORTED FINISHED IS NEVER RESURRECTED BY A LATER `task_started`: `notifDone` got `task_notification status:"completed"` — for a local_bash/tool task the ONLY terminal frame the CLI ever emits (BUG-030) — before this bridge had any row, and the engine then re-announced it as live background work. MUST-FAIL on 59c50d0, reproduced live: the settle predicate asked only `rowState === \'running\'` for a notification and ignored its status, so the verdict established nothing, only the WITHDRAWABLE veto, and the re-announcement re-admitted the finished task to the live set (`snap2.running = [\'bashDone\',\'bashChild\']`)',
    rowsById(nv[1], 'notifDone').length === 0 && rowsById(nv[1], 'notifDoneB').length === 0,
    { notifDoneRows: rowsById(nv[1], 'notifDone').length, notifDoneBRows: rowsById(nv[1], 'notifDoneB').length,
      running: (nv[1]?.running ?? []).map((r) => r.id) });

  check('(73) …IN BOTH FRAME ORDERINGS, AND ITS FOREGROUND SUBAGENT IS NOT SPARED BY A ROOT THAT IS FINISHED: `notifDone` was re-announced level-frame-FIRST and `notifDoneB` `task_started`-FIRST (the SDK leaves the order unspecified), and neither is live. `notifDoneChild`\'s only possible claim to sparing was a live root, so nothing in its chain is live and its honest death is recorded exactly once — the consequence that rules out the over-permissive fix, re-asked for the notification frame type',
    deathsForId(nv[1], 'notifDoneChild').length === 1 && rowsById(nv[1], 'notifDoneChild').length === 0
      && countEv(nvEvents, (e) => e.t === 'agent-started' && e.agent?.agentId === 'notifDone') === 0,
    { childDeaths: endedForId(nv[1], 'notifDoneChild').map((o) => o.kind),
      startedEventsForFinishedRoot: countEv(nvEvents, (e) => e.t === 'agent-started' && e.agent?.agentId === 'notifDone'),
      allEnded: allEnded(nv[1]) });

  check('(74) AND THE 5th VERDICT\'S PROPERTY IS NOT TRADED FOR IT, ON THE SAME RUN: `notifBlanket` / `notifBlanketB` were named by a session-wide teardown blanket (`status:"stopped"`) before their rows — which is not a verdict about any one task — and the engine then re-announced them as live in the two orderings. Both are STILL live rows, neither they nor their foreground subagents are recorded dead. The line is what the frame SAYS, not which frame type carried it: draw it at the type and (72) breaks; draw it at "any notification settles" and this breaks',
    rowsById(nv[1], 'notifBlanket').length === 1 && rowsById(nv[1], 'notifBlanketB').length === 1
      && deathsForId(nv[1], 'notifBlanket').length === 0 && deathsForId(nv[1], 'notifBlanketB').length === 0
      && deathsForId(nv[1], 'notifBlanketChild').length === 0 && rowsById(nv[1], 'notifBlanketChild').length === 1,
    { blanketRows: [rowsById(nv[1], 'notifBlanket').length, rowsById(nv[1], 'notifBlanketB').length],
      blanketChildRows: rowsById(nv[1], 'notifBlanketChild').length, allEnded: allEnded(nv[1]) });

  check('(75) A ROW-LESS PER-TASK **FAILURE** CARRIED BY A NOTIFICATION REACHES THE LEDGER AS THE ENGINE\'S OWN WORD: `notifFail` got `task_notification status:"failed"` with no row, and its row arrived a turn later. It must be settled `failed` — not left running, and not settled by this bridge\'s own turn-end inference as an `unknown` death. MUST-FAIL on 59c50d0, which recorded `notifFail:unknown`: the previous round\'s rule discarded every row-less notification, so the only verdict a tool task ever gets was thrown away',
    endedForId(nv[1], 'notifFail').length === 1 && endedForId(nv[1], 'notifFail')[0]?.kind === 'failed'
      && rowsById(nv[1], 'notifFail').length === 0,
    { notifFailEnded: endedForId(nv[1], 'notifFail').map((o) => o.kind), rows: rowsById(nv[1], 'notifFail').length });

  check('(76) …AND THAT NEW POWER STOPS AT THE FIRST VERDICT, SO THE TWO ORDERINGS STILL LAND THE SAME LEDGER: `task_updated completed` then `task_notification failed` writes NO ledger row when the row is present (the row is no longer `running`, so the notification is ignored), and must write none with the row LATE either. The row-less mirror of "already settled" is the established outcome, so `parityLate` and `parityRow` are identical — without that clause this fix would have created a fresh parity break in the direction property (c) forbids',
    endedForId(nv[1], 'parityLate').length === endedForId(nv[1], 'parityRow').length
      && endedForId(nv[1], 'parityLate').filter((o) => o.kind !== 'completed').length === 0
      && rowsById(nv[1], 'parityLate').length === 0 && rowsById(nv[1], 'parityRow').length === 0,
    { parityLate: endedForId(nv[1], 'parityLate').map((o) => o.kind), parityRow: endedForId(nv[1], 'parityRow').map((o) => o.kind) });

  check('(77) AND DIRECTION (a) IS UNTRADED IN THE NOTIFICATION SHAPE TOO: the main-thread orphan of each of the two sweeps records its honest death exactly once, with five reported tasks and four re-announcements in flight',
    deathsForId(nv[0], 'mainOrphan').length === 1 && deathsForId(nv[1], 'mainOrphan2').length === 1,
    { orphans: [deathsForId(nv[0], 'mainOrphan').length, deathsForId(nv[1], 'mainOrphan2').length] });

  check('(78) THE CLASSIFICATION IS STRUCTURAL AND STATUS-BASED, IN THE ONE PREDICATE, AND THE BLANKET ARM IS DECIDED BEFORE ANY ROW STATE IS READ: `#terminalFrameSettles` answers `authority === \'patch\'`, then refuses every outside-imposed notification ending (`status === \'killed\'` — where raw `"stopped"` and `"killed"` map) UNCONDITIONALLY, and only then looks at `rowState`. BUG-105 (7th verdict): the previous shape tested `rowState === \'running\'` FIRST, so a blanket with a row present was still a verdict — "demoted" is not the same as "not a verdict". Ordering the two clauses this way is what makes it one rule rather than two, and this regex fails the moment a row-state arm is put back in front of it',
    /#terminalFrameSettles\(\s*taskId: string,[\s\S]*?if \(authority === 'patch'\) return true;[\s\S]*?if \(status === 'killed'\) return false;[\s\S]*?if \(rowState === 'running'\) return true;[\s\S]*?if \(rowState !== 'absent'\) return false;[\s\S]*?return !this\.#establishedOutcomes\.has\(taskId\);\s*\}/.test(bridgeSrc)
      // …and the blanket arm is the FIRST executable statement after the patch arm:
      // no `rowState` test may precede it, which is exactly the shape that failed.
      && settleBody.indexOf("if (status === 'killed') return false;") < settleBody.indexOf('rowState =')
      && settleBody.indexOf("if (status === 'killed') return false;") >= 0,
    { blanketRefusedUnconditionally: /if \(status === 'killed'\) return false;/.test(bridgeSrc),
      blanketArmAt: settleBody.indexOf("if (status === 'killed') return false;"),
      firstRowStateTestAt: settleBody.indexOf('rowState ='),
      alreadySettledIsRead: /return !this\.#establishedOutcomes\.has\(taskId\);/.test(bridgeSrc) });

  // ---- NOTIFUI — the same resurrection in the REAL RUNNING DISPLAY, which the
  // clean-room pass could only reach at the snapshot and ledger level.
  const nui = await runUiLive('notifui', 'liveOne');

  check('(79) BROWSER SETUP (VERDICT-NOTIFICATION ARM): real headless Brave booted the dashboard on the project and the composer\'s own Enter path started a turn whose lanes reached the strip',
    nui.booted && nui.onProject && nui.sawLive,
    { booted: nui.booted, onProject: nui.onProject, strip: nui.mid.strip.map((r) => `${r.key}${r.run ? ':run' : ''}`) });

  check('(80) THE RESURRECTION IN THE REAL DISPLAY: `doneNotifUI` was reported `completed` by a notification before its row and then re-announced as live background work. MID-TURN, with other lanes genuinely running, it is NOT a ◐ row in the strip and the server\'s snapshot agrees — on 59c50d0 the user would have watched a finished task reappear as live work. The control `liveOne` IS running at that same instant, so the display is not passing vacuously',
    !nui.mid.strip.some((r) => r.key === 'doneNotifUI' && r.run)
      && !(nui.midSnap?.running ?? []).some((r) => r.id === 'doneNotifUI')
      && nui.mid.strip.some((r) => r.key === 'liveOne' && r.run),
    { stripMid: nui.mid.strip.map((r) => `${r.key}${r.run ? ':run' : ''}`),
      snapshotMid: (nui.midSnap?.running ?? []).map((r) => r.id) });

  check('(81) …AND THE OTHER DIRECTION IN THE SAME FRAME: `blanketNotifUI` was named only by a session-wide teardown blanket, so the engine never gave a per-task verdict on it and its re-announcement stands — it IS a running row in the real DOM mid-turn and after the held turn ends, and the snapshot agrees. A fix that settled every re-announced task would pass (80) and fail here',
    nui.mid.strip.some((r) => r.key === 'blanketNotifUI' && r.run)
      && nui.settled && nui.after.strip.some((r) => r.key === 'blanketNotifUI' && r.run)
      && (nui.afterSnap?.running ?? []).some((r) => r.id === 'blanketNotifUI'),
    { stripAfter: nui.after.strip.map((r) => `${r.key}${r.run ? ':run' : ''}`),
      snapshotAfter: (nui.afterSnap?.running ?? []).map((r) => r.id),
      // BUG-113 (out of lane, asserted-as-known): the client's own turn-end
      // cut-sweep in public/app.js settles the CARD of live background work while
      // the strip keeps showing the lane. Recorded, not asserted, here too.
      clientCardStateForBlanketNotifUI: nui.after.agents.blanketNotifUI ?? null });

  check('(82) AND WHEN THE HELD TURN ENDS, THE FINISHED TASK IS STILL NOT SPINNING AND THE FOREGROUND CONTROL IS CONTAINED: `doneNotifUI` is absent from the strip and from the snapshot, and `liveOne` — a main-thread foreground lane with no chain — is settled at the boundary with its honest death on the ledger',
    !nui.after.strip.some((r) => r.key === 'doneNotifUI' && r.run)
      && !(nui.afterSnap?.running ?? []).some((r) => r.id === 'doneNotifUI')
      && !nui.after.strip.some((r) => r.key === 'liveOne' && r.run)
      && (nui.afterSnap?.ended ?? []).some((o) => o.agentId === 'liveOne'),
    { stripAfter: nui.after.strip.map((r) => `${r.key}${r.run ? ':run' : ''}`), endedAfter: allEnded(nui.afterSnap) });

  // ---- BLANKETROW — the 7th clean-room verdict: the teardown blanket landing on a
  // row that ALREADY EXISTS. All four directions on one run, because each has been a
  // verdict on this ticket and a fix for any one of them has broken another.
  const br = await runTurns('blanketrow', [
    'a teardown blanket lands on rows that already exist, alongside real per-task verdicts',
    'the root is still live and the engine re-declares the blanketed background lane',
  ]);
  const brEvents = lastEvents;

  check('(83) THE 7th VERDICT\'S FINDING — A TEARDOWN BLANKET NEVER BECOMES A PER-TASK VERDICT WHEN THE ROW ALREADY EXISTS: `fgLive` is a foreground subagent of `rootW`, a background root the engine\'s level still lists as LIVE, and its row was RUNNING when `task_notification status:"stopped"` landed on it. MUST-FAIL on 08ecda4 (measured live through the real server and bridge: `ended=["killed"], rows=0`) — the row was settled, removed from the live set and written dead while it worked. The blanket says the PROCESS is going away; it says nothing about this task',
    deathsForId(br[0], 'fgLive').length === 0 && rowsById(br[0], 'fgLive').length === 1,
    { fgLiveEnded: endedForId(br[0], 'fgLive').map((o) => o.kind), fgLiveRows: rowsById(br[0], 'fgLive').length,
      allEnded: allEnded(br[0]), provenance: 'SCRIPTED FAKE CLI through real server + real bridge' });

  check('(84) …AND THE SPARE IS RE-ASKED AT THE NEXT BOUNDARY, NOT A ONE-SHOT: a second sweep with `rootW` still on the level leaves `fgLive` running and still unrecorded. A fix that merely delayed the fabricated death by one turn passes (83) and fails here',
    deathsForId(br[1], 'fgLive').length === 0 && rowsById(br[1], 'fgLive').length === 1,
    { fgLiveEnded: endedForId(br[1], 'fgLive').map((o) => o.kind), fgLiveRows: rowsById(br[1], 'fgLive').length });

  check('(85) NOR IS A CONSUMER OF THE LIVE STREAM TOLD OTHERWISE: not one `agent-completed` for `fgLive` went out on the socket in either turn. The ledger and the event stream have to agree — a death that only appears in the strip is still a fabricated death, and it is the one the user watches happen',
    countEv(brEvents, (e) => e.t === 'agent-completed' && e.agent?.agentId === 'fgLive') === 0,
    { fgLiveCompletedEvents: countEv(brEvents, (e) => e.t === 'agent-completed' && e.agent?.agentId === 'fgLive') });

  check('(86) THE MIRROR DIRECTION, WHICH IS THE ONE THAT HIDES WORK HAVING ENDED — A ROW THAT GENUINELY DIES AT THE TEARDOWN IS STILL RECORDED, EXACTLY ONCE: `orphanRow` is a main-thread lane with NO ownership chain, blanketed with its row present. Nothing spares it, so the ORDINARY inference path (the turn-end sweep) settles it and writes its honest death — once in sweep #1, and NOT a second time in sweep #2. The fix declines to make a verdict from the frame; it can never suppress a write',
    deathsForId(br[0], 'orphanRow').length === 1 && deathsForId(br[1], 'orphanRow').length === 1
      && rowsById(br[1], 'orphanRow').length === 0,
    { sweep1: endedForId(br[0], 'orphanRow').map((o) => o.kind), sweep2: endedForId(br[1], 'orphanRow').map((o) => o.kind),
      rowsAfter: rowsById(br[1], 'orphanRow').length });

  check('(87) A BLANKET NEVER PERMANENTLY STARVES A TASK THE ENGINE LATER DECLARES LIVE, WITH A ROW PRESENT: `bgRow` was a level-listed background lane whose row existed when the blanket landed, and turn two re-declares it live. The blanket established no outcome, so the liveness veto is withdrawable and the engine\'s later word is heard — `bgRow` is a running row again. The 5th verdict\'s property, re-asked in the row-present arm the 7th verdict found untested',
    rowsById(br[1], 'bgRow').length === 1,
    { bgRowSweep1: rowsById(br[0], 'bgRow').length, bgRowSweep2: rowsById(br[1], 'bgRow').length,
      bgRowEnded: endedForId(br[1], 'bgRow').map((o) => o.kind) });

  check('(88) AND A GENUINE PER-TASK REPORT STILL REACHES THE LEDGER WITH THE OUTCOME THE ENGINE GAVE — IN EITHER FRAME ORDER, ROW PRESENT OR ABSENT, ARRIVING IN THE SAME TEARDOWN BURST AS THE BLANKETS: `verdictRowF` (notification `failed`, row present) and `verdictLateF` (the same, row late) both record `failed`; `verdictRowC`/`verdictLateC` (`completed`) record nothing and leave no spinning row; `patchRow` (a `task_updated failed`) records `failed`. Silencing the blanket must not silence the frames that ARE verdicts',
    JSON.stringify(endedForId(br[1], 'verdictRowF').map((o) => o.kind)) === '["failed"]'
      && JSON.stringify(endedForId(br[1], 'verdictLateF').map((o) => o.kind)) === '["failed"]'
      && JSON.stringify(endedForId(br[1], 'patchRow').map((o) => o.kind)) === '["failed"]'
      && endedForId(br[1], 'verdictRowC').length === 0 && endedForId(br[1], 'verdictLateC').length === 0
      && rowsById(br[1], 'verdictRowC').length === 0 && rowsById(br[1], 'verdictLateC').length === 0
      && rowsById(br[1], 'verdictRowF').length === 0 && rowsById(br[1], 'verdictLateF').length === 0,
    { rowPresent: { F: endedForId(br[1], 'verdictRowF').map((o) => o.kind), C: endedForId(br[1], 'verdictRowC').map((o) => o.kind) },
      rowLate: { F: endedForId(br[1], 'verdictLateF').map((o) => o.kind), C: endedForId(br[1], 'verdictLateC').map((o) => o.kind) },
      patchRow: endedForId(br[1], 'patchRow').map((o) => o.kind), allEnded: allEnded(br[1]) });

  check('(89) AND DIRECTION (a) IS UNTRADED IN THE ROW-PRESENT TEARDOWN SHAPE TOO: each sweep\'s main-thread orphan records its honest death exactly once, with three blanketed rows and five per-task verdicts in the same burst',
    deathsForId(br[0], 'mainOrphan').length === 1 && deathsForId(br[1], 'mainOrphan2').length === 1,
    { orphans: [deathsForId(br[0], 'mainOrphan').length, deathsForId(br[1], 'mainOrphan2').length] });

  // ---- BLANKETROWUI — the display side of THIS defect, in a real browser. The
  // 7th-verdict pass could not repeat its adversarial case in a browser at all.
  const bui = await runUiLive('blanketrowui', 'liveOne');

  check('(90) BROWSER SETUP (ROW-PRESENT BLANKET ARM): real headless Brave over CDP booted the dashboard on the project and the composer\'s own Enter path started a turn whose lanes reached the strip — the live display, not a scripted DOM',
    bui.booted && bui.onProject && bui.sawLive && bui.mid.strip.length > 0,
    { booted: bui.booted, onProject: bui.onProject, strip: bui.mid.strip.map((r) => `${r.key}${r.run ? ':run' : ''}`) });

  check('(91) THE DEFECT IN THE REAL RUNNING DISPLAY: `fgLiveUI` is a foreground subagent of a LIVE background root, and a teardown blanket landed on its EXISTING running row. MID-TURN, with other lanes genuinely running, it is STILL a ◐ row in the real DOM and the server\'s snapshot agrees. On 08ecda4 the user would have watched a still-working subagent vanish from the strip. The control `liveOne` IS running at that same instant, so the display is not passing vacuously',
    bui.mid.strip.some((r) => r.key === 'fgLiveUI' && r.run)
      && (bui.midSnap?.running ?? []).some((r) => r.id === 'fgLiveUI')
      && bui.mid.strip.some((r) => r.key === 'liveOne' && r.run),
    { stripMid: bui.mid.strip.map((r) => `${r.key}${r.run ? ':run' : ''}`), midRunning: (bui.midSnap?.running ?? []).map((r) => r.id) });

  check('(92) …AND IT SURVIVES THE BOUNDARY ON SCREEN: after the held turn ends and the sweep runs, `fgLiveUI` is STILL a running row in the real DOM and in the snapshot (its root is still live), and nothing was written into the ledger for it. A fix that only kept it alive mid-turn passes (91) and fails here',
    bui.settled && bui.after.strip.some((r) => r.key === 'fgLiveUI' && r.run)
      && (bui.afterSnap?.running ?? []).some((r) => r.id === 'fgLiveUI')
      && !(bui.afterSnap?.ended ?? []).some((o) => o.agentId === 'fgLiveUI'),
    { stripAfter: bui.after.strip.map((r) => `${r.key}${r.run ? ':run' : ''}`), endedAfter: allEnded(bui.afterSnap),
      // PRE-EXISTING, NOT THIS FIX, AND NOT THIS LANE'S FILE: the client's own
      // turn-end cut-sweep in public/app.js settles the CARD of live background
      // work to `cut` while the strip keeps showing the lane — the identical value
      // check (81) records for `blanketNotifUI`. Recorded, not asserted.
      clientCardStateForFgLiveUI: bui.after.agents.fgLiveUI ?? null });

  check('(93) AND THE DISPLAY IS NOT SIMPLY IGNORING EVERY NOTIFICATION — THE CONTROL PROVES IT: `doneUI` got a per-task `status:"completed"` on its own EXISTING row in the same burst, and it is gone from the strip and from the snapshot both mid-turn and after. A fix that made notifications inert would pass (91)/(92) and fail here',
    !bui.mid.strip.some((r) => r.key === 'doneUI' && r.run)
      && !(bui.midSnap?.running ?? []).some((r) => r.id === 'doneUI')
      && !bui.after.strip.some((r) => r.key === 'doneUI' && r.run)
      && !(bui.afterSnap?.running ?? []).some((r) => r.id === 'doneUI'),
    { doneUIMid: bui.mid.strip.filter((r) => r.key === 'doneUI').map((r) => `${r.key}${r.run ? ':run' : ''}`),
      doneUIAfter: bui.after.strip.filter((r) => r.key === 'doneUI').map((r) => `${r.key}${r.run ? ':run' : ''}`) });
}

let fatal = false;
main().catch((e) => { console.error('FATAL', e.stack ?? e.message); fatal = true; process.exitCode = 1; }).finally(async () => {
  await sleep(400);
  try { for (const f of fs.readdirSync(path.join(DATA, 'session-hosts'))) { try { const h = JSON.parse(fs.readFileSync(path.join(DATA, 'session-hosts', f), 'utf8')); for (const p of [h.claudePid, h.hostPid]) if (p && pidAlive(p)) try { process.kill(p, 'SIGKILL'); } catch {} } catch {} } } catch {}
  for (const b of browsers) { if (b?.pid) { try { process.kill(b.pid, 'SIGKILL'); } catch {} } }
  for (const s of servers) { if (s?.pid) { try { process.kill(s.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(s.pid, 'SIGKILL'); } catch {} }, 2000).unref(); } }
  setTimeout(() => {
    console.log(`\n${pass}/${pass + fail} checks passed${fatal ? ' (FATAL — the run aborted before completing)' : ''}`);
    if (fail) console.log(`failed: ${failures.join(' | ')}`);
    for (const d of [DATA, WORK, STORE]) fs.rmSync(d, { recursive: true, force: true });
    process.exit((fail || fatal || pass + fail === 0) ? 1 : 0);
  }, 1500);
});
