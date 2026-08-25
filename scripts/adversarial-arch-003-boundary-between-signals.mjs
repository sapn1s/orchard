#!/usr/bin/env node
/**
 * ARCH-003 — THE 5th CLEAN-ROOM VERDICT, MADE PERMANENT.
 *
 * VERDICT (dispatch openai run 01a0154b-31fd-7e22-be9b-9257c0dc8509, verbatim):
 *   node adversarial-boundary-between-signals.mjs  → exit 1
 *   {"owner":"still-running-owner","resident":1,"open":1}
 *   DEFECT: a completed call became permanently open when reclamation ran between
 *           its end and issue signals
 *
 * THE MECHANISM. `ended(id)` with no open entry records an ENDED_UNMATCHED so that a
 * late `issuedBySubagent(id, …)` ANNIHILATES against it instead of resurrecting a
 * finished call. `reap()` drops everything that is not OPEN — including that
 * tombstone. So if a turn boundary falls BETWEEN the two signals, the annihilation
 * window closes, the late issue creates an OPEN record for a call that is already
 * over, and NO FURTHER EVIDENCE OF ITS ENDING CAN EVER ARRIVE. It survived 10,000
 * reclamations in the clean room.
 *
 * THE PATTERN THIS SCRIPT ACTUALLY GRADES — which is bigger than that one ordering.
 * Five consecutive leak verdicts have the same shape: an OPEN record's ONLY route to
 * reclamation is a signal that may never arrive (dropped, consumed, or already spent).
 * Repairing a sixth route would leave the sixth-and-a-half open. So what is asserted
 * here is the ROUTE-INDEPENDENT property:
 *
 *   AN OPEN RECORD WHOSE OWNING AGENT IS NO LONGER LIVE CANNOT STILL BE IN FLIGHT,
 *   AND MUST BE RECLAIMED — WITHOUT ANY END SIGNAL, TERMINAL FRAME OR RE-ISSUE
 *   EVER ARRIVING FOR IT.
 *
 * Every case below therefore withholds `ended()` AND `ownerEnded()` — the two
 * edge-triggered signals — and reclaims purely from LEVEL-TRIGGERED owner liveness
 * asked at the boundary. Cases (4) and (5) are the counterweight: property (b) must
 * survive the new reclamation path, or the cure is worse than the leak.
 *
 * Usage: node scripts/adversarial-arch-003-boundary-between-signals.mjs
 */
import { OpenToolCalls as RealOpenToolCalls } from '../src/server/open-tool-calls.ts';

/**
 * THE FRAME THESE FIXTURES USED TO OMIT (ARCH-003, 8th clean-room verdict).
 *
 * A background agent's OWN Task call is a MAIN-THREAD `tool_use`, and the bridge
 * records it (`issuedByMainThread`) BEFORE any child can name it as
 * `parent_tool_use_id` — the child's frame carries the id of a call an EARLIER
 * assistant frame minted. A fixture that names `ownerW` as a parent without ever
 * issuing it is therefore not modelling a root: it is modelling a chain whose top
 * NOBODY HAS EVER NAMED, which since the 8th verdict is UNKNOWN ANCESTRY (there may
 * be live owners above it that no frame has mentioned) rather than "the chain ends
 * here". The type now says so instead of guessing, and refuses to reclaim on it for
 * one boundary.
 *
 * So the fixtures supply the frame the real stream always contains: the first time a
 * name is used as a parent, its own main-thread issue frame is played first. Nothing
 * else about the fixture changes, and the numbers below are the numbers the guard
 * published before this rule existed — which is the point of doing it this way rather
 * than relaxing the rule.
 *
 * A case that deliberately withholds a parent's issue frame must use
 * `RealOpenToolCalls` directly (see `adversarial-arch-003-reservation-window.mjs`).
 */
class OpenToolCalls extends RealOpenToolCalls {
  #issued = new Set();
  issuedByMainThread(id) { this.#issued.add(id); super.issuedByMainThread(id); }
  issuedBySubagent(id, parent) {
    if (!this.#issued.has(parent)) this.issuedByMainThread(parent);
    this.#issued.add(id);
    super.issuedBySubagent(id, parent);
  }
}


let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  ok ? pass++ : (fail++, failures.push(name));
}

/**
 * The bridge's real reclamation evidence, modelled: a call cannot still be in flight
 * if its OWNER is not live any more, or if its own lane has gone terminal. `live` is
 * a level-triggered set — re-read at every boundary — exactly like `#backgroundTasks`
 * / a running `#agents` row. An owner NOBODY has ever heard of (the re-attach degrade)
 * is NOT evidence of death and must be kept.
 */
function evidence({ live, known, terminalLanes = new Set() }) {
  return (toolUseId, chain) => {
    if (terminalLanes.has(toolUseId)) return true;
    // The 6th clean-room verdict: the predicate is asked about the WHOLE OWNERSHIP
    // CHAIN, so a leaf under a still-live ANCESTOR is never reclaimed on the strength
    // of a terminal intermediate. Reclaimable only when NOT ONE ancestor can be live.
    if (!chain.length) return false;
    return chain.every((owner) => known.has(owner) && !live.has(owner));
  };
}

// ---------------------------------------------------------------------- (1)
// The verdict's own sequence, reproduced signal for signal.
{
  const r = new OpenToolCalls();
  const live = new Set(['still-running-owner']);
  const known = new Set(['still-running-owner']);
  const isOver = evidence({ live, known });

  r.ended('completed-call');                                   // the result arrives …
  r.reap(isOver);                                              // … a turn boundary falls between …
  r.issuedBySubagent('completed-call', 'still-running-owner'); // … and only THEN its issue frame
  for (let i = 0; i < 10_000; i++) r.reap(isOver);

  // The clean room's line, printed as it printed it. While the owner is genuinely
  // live this record is INDISTINGUISHABLE from a call in flight, and the design
  // must keep it — sparing a live worker's child is property (b).
  console.log('        verdict line while the owner is live: '
    + JSON.stringify({ owner: r.parentOf('completed-call'), resident: r.size, open: r.openSize }));

  // The owner now retires. NO terminal frame is delivered (`ownerEnded` is never
  // called) and NO result ever arrives — every edge-triggered route is withheld.
  // Liveness is the only evidence left, and it must be enough.
  live.delete('still-running-owner');
  r.reap(isOver);
  check('(1) THE 5th VERDICT: a call completed before its own issue frame, with a reclamation in between, is reclaimed once its owner is no longer live — with NO end signal, NO terminal frame and NO re-issue ever arriving for it',
    r.size === 0 && r.openSize === 0, { resident: r.size, open: r.openSize, parentOf: r.parentOf('completed-call') });
}

// ---------------------------------------------------------------------- (2)
// The verifier's actual claim was GROWTH — "ownership storage grows without bound
// under repeated calls of this ordering". Repeat it across a realistic session.
{
  const r = new OpenToolCalls();
  const live = new Set(), known = new Set();
  const isOver = evidence({ live, known });
  const ROUNDS = 10_000, WORKERS = 8;
  let peak = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const owner = `w${i % WORKERS}_${Math.floor(i / WORKERS / 25)}`;   // a worker retires every 25 calls
    live.add(owner); known.add(owner);
    r.ended('c' + i);                       // result …
    r.reap(isOver);                         // … boundary …
    r.issuedBySubagent('c' + i, owner);     // … issue: the record is now permanently OPEN
    peak = Math.max(peak, r.size);
    if (i % WORKERS === WORKERS - 1 && i % (WORKERS * 25) === WORKERS * 25 - 1) {
      for (const o of [...live]) live.delete(o);   // that generation of workers retires, unseen
    }
  }
  for (const o of [...live]) live.delete(o);
  r.reap(isOver);
  check(`(2) NO UNBOUNDED GROWTH UNDER REPETITION: ${ROUNDS.toLocaleString()} rounds of end>boundary>issue leave ${r.size} resident entries (peak ${peak}); on the defective build all ${ROUNDS.toLocaleString()} records were immortal`,
    r.size === 0 && peak < 400, { rounds: ROUNDS, resident: r.size, peakWhileWorkersLive: peak });
}

// ---------------------------------------------------------------------- (3)
// The generalisation: ANY reason an end signal never arrives. The engine stops
// emitting tool_results entirely, terminal frames are lost too, ids are never
// re-issued. Nothing edge-triggered is left. Residency must still be bounded.
{
  const r = new OpenToolCalls();
  const live = new Set(), known = new Set();
  const isOver = evidence({ live, known });
  for (let gen = 0; gen < 200; gen++) {
    const owner = 'gen' + gen;
    live.add(owner); known.add(owner);
    for (let i = 0; i < 100; i++) r.issuedBySubagent(`g${gen}_${i}`, owner);   // no result, ever
    live.delete(owner);                                                        // no terminal frame, ever
    r.reap(isOver);
  }
  check('(3) EVERY END SIGNAL WITHHELD, FOR ANY REASON: 20,000 calls that never report a result, whose owners never emit a terminal frame and whose ids are never re-issued, leave zero resident — owner liveness bounds the cases nobody has thought of, not just the one the verifier found',
    r.size === 0, { resident: r.size });
}

// ---------------------------------------------------------------------- (4)
// PROPERTY (b), the hazard. Reclaiming on liveness must NEVER take the ownership
// answer away from a child that is genuinely still running.
{
  const r = new OpenToolCalls();
  const live = new Set(['liveWorker']), known = new Set(['liveWorker', 'deadWorker']);
  const isOver = evidence({ live, known });
  r.issuedBySubagent('liveChild', 'liveWorker');
  r.issuedBySubagent('deadChild', 'deadWorker');
  for (let i = 0; i < 10_000; i++) r.reap(isOver);
  check('(4) A LIVE WORKER\'S CHILD IS NEVER RECLAIMED: 10,000 boundaries with the owner still live leave the in-flight call open and still answering with its own owner, while a dead worker\'s abandoned call is gone',
    r.parentOf('liveChild') === 'liveWorker' && r.parentOf('deadChild') === null && r.size === 1,
    { liveChild: r.parentOf('liveChild'), deadChild: r.parentOf('deadChild'), resident: r.size });
}

// ---------------------------------------------------------------------- (5)
// The re-attach degrade: an owner the bridge has NEVER heard of is not evidence of
// death. Reclaiming it would turn the spared child into a fabricated death.
{
  const r = new OpenToolCalls();
  const live = new Set(), known = new Set();       // nothing is known at all
  const isOver = evidence({ live, known });
  r.issuedBySubagent('reattachChild', 'ownerWeNeverSaw');
  for (let i = 0; i < 10_000; i++) r.reap(isOver);
  check('(5) ABSENCE OF EVIDENCE IS NOT EVIDENCE OF DEATH: an owner the bridge never observed (the re-attach degrade) keeps its child\'s record across 10,000 boundaries — the child is spared, not fabricated',
    r.parentOf('reattachChild') === 'ownerWeNeverSaw', { parentOf: r.parentOf('reattachChild'), resident: r.size });
}

// ---------------------------------------------------------------------- (6)
// The second evidence axis: the CALL's own lane went terminal. Verdict-neutral by
// construction (the sweep only ever asks about `running` lanes) and it reclaims the
// abandoned tail whose owner is still working.
{
  const r = new OpenToolCalls();
  const live = new Set(['liveWorker']), known = new Set(['liveWorker']);
  const terminalLanes = new Set();
  const isOver = evidence({ live, known, terminalLanes });
  for (let i = 0; i < 1000; i++) r.issuedBySubagent('lane' + i, 'liveWorker');
  r.issuedBySubagent('stillRunningLane', 'liveWorker');
  for (let i = 0; i < 1000; i++) terminalLanes.add('lane' + i);   // the sweep settled them
  r.reap(isOver);
  check('(6) A CALL WHOSE OWN LANE IS TERMINAL IS OVER: 1,000 settled lanes are reclaimed even though their owner is still working, and the one lane still running keeps its owner',
    r.size === 1 && r.parentOf('stillRunningLane') === 'liveWorker',
    { resident: r.size, stillRunning: r.parentOf('stillRunningLane') });
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) console.log(`failed: ${failures.join(' | ')}`);
process.exit(fail ? 1 : 0);
