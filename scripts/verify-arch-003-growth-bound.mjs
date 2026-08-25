#!/usr/bin/env node
/**
 * ARCH-003 — THE GROWTH BOUND, PROVED WITH NUMBERS, AND THE REGISTRY'S INVARIANTS.
 *
 * The three clean-room BROKEN verdicts all came from `#toolUseOwner`'s LIFETIME. The
 * last one came specifically from the CAP that existed to bound it: a legitimate
 * pending entry aged to the oldest end under load and was evicted, and the sweep
 * fabricated a death for a live worker's child. `OpenToolCalls` has no cap, so the
 * bound has to be earned rather than imposed — this guard earns it, on the real type
 * (`src/server/open-tool-calls.ts`), directly, with no server in the loop.
 *
 * WHAT IT ASSERTS
 *  - the two structural invariants, as behaviour: an OPEN call is never removed by
 *    anything (no size, age or turn rule can touch it), and an ENDED call never
 *    survives past the next turn boundary;
 *  - order-independence: the answer at "sweep time" is identical for every ordering
 *    of the paired frames, including a `tool_result` that precedes its own lane;
 *  - the days-long-session bound: a simulated 3-day session at a realistic and then a
 *    deliberately absurd rate, printing the resident count so the number is on the
 *    record rather than argued;
 *  - the fail-safe direction: with reclamation TOTALLY disabled (no `tool_result`
 *    frames at all — the worst case if the engine stopped emitting them) the resident
 *    set still cannot produce a wrong answer, only bytes, and the owner-terminal rule
 *    still reclaims.
 *
 * Usage: node scripts/verify-arch-003-growth-bound.mjs
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

/**
 * THE BOUNDARY EVIDENCE the bridge supplies, modelled — and modelled at the level the
 * fixed type asks at: the WHOLE OWNERSHIP CHAIN. `reap()` hands the predicate every
 * ancestor of the call, and a record is reclaimable only if NOT ONE of them can still
 * be running. An owner nobody has heard of is not in `dead` and is therefore kept:
 * absence of knowledge is never evidence (the re-attach degrade).
 *
 * `ownerEnded()` is GONE from the type (6th clean-room verdict — it removed records by
 * IMMEDIATE parent, so it orphaned a leaf whose root was still live). Everywhere this
 * suite used to call it, it now supplies the same fact as boundary evidence instead.
 */
const deadChain = (dead) => (_id, chain) => chain.length > 0 && chain.every((p) => dead.has(p));


let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  ok ? pass++ : (fail++, failures.push(name));
}

// ---------------------------------------------------------------- invariant 1
{
  const r = new OpenToolCalls();
  r.issuedBySubagent('live', 'ownerW');
  // Every kind of pressure the prior designs reclaimed under, applied at once.
  for (let i = 0; i < 100_000; i++) { r.issuedBySubagent('load_' + i, 'ownerW'); r.ended('load_' + i); }
  for (let i = 0; i < 50; i++) r.reap();
  r.reap(deadChain(new Set(['someOtherOwner'])));   // an unrelated owner's death
  r.issuedByMainThread('an_unrelated_id');
  check('(1) AN OPEN CALL IS NEVER REMOVED: after 100,000 other calls opened and ended, 50 turn boundaries, an unrelated owner\'s death and an unrelated main-thread re-issue, the one still-open call still resolves to its owner (this is the CAP-b defect made unrepresentable — there is no eviction path to reach it)',
    r.parentOf('live') === 'ownerW', { parentOf_live: r.parentOf('live'), resident: r.size });

  check('(2) AN ENDED CALL NEVER OUTLIVES THE NEXT BOUNDARY: 100,000 ended calls left 1 resident entry — the single open one',
    r.size === 1, { resident: r.size });
}

// ---------------------------------------------------------------- invariant 2
{
  const r = new OpenToolCalls();
  r.issuedBySubagent('c', 'ownerW');
  r.ended('c');
  check('(3) GRACE WITHIN THE TURN: a call whose `tool_result` arrived is STILL readable until the boundary, so a `tool_result` that preceded its own `task_started` cannot cost the lane its owner',
    r.parentOf('c') === 'ownerW', { parentOf_c: r.parentOf('c') });
  r.reap();
  check('(4) REAPED AT THE BOUNDARY: the same call is gone after the turn ends',
    r.parentOf('c') === null && r.size === 0, { parentOf_c: r.parentOf('c'), resident: r.size });
}

// ---------------------------------------------------------------- ordering
{
  // The three frames that matter, in every order. The registry is asked at the END
  // (the sweep), which is what makes the orderings equivalent.
  const frames = {
    assistant: (r) => r.issuedBySubagent('c', 'ownerW'),
    lane: () => {},                       // `task_started` touches the registry AT ALL — it must not
    result: (r) => r.ended('c'),
  };
  const orders = [
    ['assistant', 'lane', 'result'], ['assistant', 'result', 'lane'],
    ['lane', 'assistant', 'result'], ['lane', 'result', 'assistant'],
    ['result', 'assistant', 'lane'], ['result', 'lane', 'assistant'],
  ];
  const results = orders.map((o) => {
    const r = new OpenToolCalls();
    for (const f of o) frames[f](r);
    const owner = r.parentOf('c');          // the answer AT THE SWEEP
    r.reap();                                // ... and then the turn boundary
    return { order: o.join('>'), owner, residentAfterBoundary: r.size };
  });
  check('(5) ORDER-INDEPENDENT: all 6 orderings of (assistant / task_started / tool_result) give the SAME owner at sweep time — the design assumes nothing about frame ordering, which no prior attempt could say (each stamped the owner AT task_started)',
    results.every((x) => x.owner === 'ownerW'), { orders: results.map((x) => x.order + '=' + x.owner) });

  /*
   * (5b) IS THE HALF THAT WAS MISSING, and its absence is exactly what let the 4th
   * clean-room BROKEN verdict through. (5) asserted every ordering gives the same
   * OWNERSHIP ANSWER; nothing asserted the entry was subsequently RECLAIMED. Under
   * `result > assistant` the answer was right and the entry was immortal — 100,000
   * such calls, 100,000 resident entries. An ordering is only supported if BOTH hold.
   */
  check('(5b) ORDER-INDEPENDENT RECLAMATION: every one of the same 6 orderings also leaves ZERO resident entries after the turn boundary — a completed call is reclaimed no matter which of its two signals arrived first (the missing assertion that let the result-before-assistant leak through)',
    results.every((x) => x.residentAfterBoundary === 0),
    { orders: results.map((x) => x.order + '=' + x.residentAfterBoundary) });
}

// ---------------------------------------------------------------- id reuse
{
  const r = new OpenToolCalls();
  r.issuedBySubagent('SHARED', 'ownerW');
  r.issuedByMainThread('SHARED');
  check('(6) ID REUSE CANNOT SUPPRESS A REAL DEATH: a main-thread re-issue leaves NO subagent owner for that id, so the main lane resolves to null and its genuine death records (direction a, the hole attempt 2 reopened)',
    r.parentOf('SHARED') === null, { parentOf_SHARED: r.parentOf('SHARED'), resident: r.size });
}

// ---------------------------------------------------------------- owner death
{
  const r = new OpenToolCalls();
  for (let i = 0; i < 500; i++) r.issuedBySubagent('abandoned_' + i, 'ownerW');
  r.issuedBySubagent('other', 'ownerV');
  const before = r.size;
  r.reap(deadChain(new Set(['ownerW'])));           // ownerW is no longer live
  check('(7) AN ABANDONED CALL IS RECLAIMED BY ITS OWNER\'S DEATH: 500 calls that will never report a result are dropped at the first boundary after their owner stops being live (no terminal FRAME required — `ownerEnded` was deleted for the 6th verdict), and a live owner\'s call is untouched',
    r.size === 1 && r.parentOf('other') === 'ownerV', { before, after: r.size, other: r.parentOf('other') });
}

// ------------------------------------------------- days-long session, numbers
function simulate({ days, callsPerHour, turnsPerHour, abandonRatePerHour, label, ordering = 'assistant-first', liveness = false, boundaryBetweenSignals = false, workerLifetimeTurns = 30 }) {
  const r = new OpenToolCalls();
  const hours = days * 24;
  let peak = 0, opened = 0, wrongOwner = 0;
  /*
   * `liveness` supplies the bridge's boundary evidence: a worker that is no longer
   * live has no calls in flight. `boundaryBetweenSignals` drives the 5th clean-room
   * verdict's ordering (result > BOUNDARY > issue) for every single call — the one
   * that made a completed call permanently open. Without the evidence predicate the
   * simulation is the previous build's, verbatim, so the two figures are comparable.
   */
  const live = new Set();
  // The chain form: reclaimable only when NO ancestor is live. Single-level chains
  // here, so the figures stay directly comparable with the previous build's.
  const pred = liveness ? ((_id, chain) => chain.length > 0 && chain.every((p) => !live.has(p))) : undefined;
  const reap = () => r.reap(pred);
  /*
   * Workers are not immortal. A real subagent runs for a while and retires; here a
   * generation of 4 workers is replaced every `workerLifetimeTurns` turns, and the
   * retiring generation emits NO terminal frame — it simply stops being live. That is
   * the only reclamation route the 5th verdict's ordering leaves, so it is the one
   * the bound is measured against. (An owner that NEVER retires is the named residual
   * and is measured separately, in check (19).)
   */
  let turnIndex = 0;
  for (let h = 0; h < hours; h++) {
    for (let t = 0; t < turnsPerHour; t++) {
      const perTurn = Math.round(callsPerHour / turnsPerHour);
      // A turn's worth of subagent tool calls, opened and completed (the FOREGROUND
      // subagent tool call — the class that leaked under the old design — is exactly
      // this: no `task_started`, but a `tool_result` like every other call).
      // `ordering` decides which of the call's two signals arrives first: BOTH are
      // supported orderings, and `result-first` is the one that just broke the build.
      const generation = Math.floor(turnIndex / workerLifetimeTurns);
      if (liveness) { live.clear(); for (let k = 0; k < 4; k++) live.add(`w${k}g${generation}`); }
      turnIndex++;
      for (let i = 0; i < perTurn; i++) {
        const id = `h${h}t${t}i${i}`, owner = `w${i % 4}g${generation}`;
        const resultFirst = ordering === 'result-first' || (ordering === 'mixed' && i % 2 === 0);
        if (resultFirst && boundaryBetweenSignals) { r.ended(id); reap(); r.issuedBySubagent(id, owner); }
        else if (resultFirst) { r.ended(id); r.issuedBySubagent(id, owner); }
        else { r.issuedBySubagent(id, owner); r.ended(id); }
        // The ownership answer must still be correct at sweep time, in either order.
        if (r.parentOf(id) !== owner) wrongOwner++;
        opened++;
      }
      peak = Math.max(peak, r.size);
      reap(); // the turn boundary
    }
    // Calls abandoned this hour: an owner died before its call reported. Half of the
    // owners are seen to go terminal; the rest were the genuinely unreclaimable tail —
    // the ONLY term that grew with elapsed time. With boundary liveness they are not a
    // tail at all: an owner that is not live has no calls in flight.
    for (let i = 0; i < abandonRatePerHour; i++) { r.issuedBySubagent(`ab${h}_${i}`, `dead${h}_${i}`); opened++; }
    // Their owners are gone. WITHOUT the liveness evidence (the `liveness: false`
    // shapes below, kept for comparability with the previous build) nothing can know
    // that, so every one of them stays resident — this is the abandoned tail, and it
    // is the term the boundary predicate exists to remove.
    if (liveness) { /* the dead owners are simply not in `live` */ }
  }
  reap(); // the boundary of the session's last turn
  return { label, ordering, days, opened, wrongOwner, perTurn: Math.round(callsPerHour / turnsPerHour), peakWithinATurn: peak, residentAtEnd: r.size, bytesApprox: r.size * 120 };
}

const realistic = simulate({ days: 3, callsPerHour: 400, turnsPerHour: 20, abandonRatePerHour: 2, label: 'realistic busy 3-day session' });
const absurd = simulate({ days: 3, callsPerHour: 20_000, turnsPerHour: 200, abandonRatePerHour: 20, label: 'absurd 3-day session (50x realistic)' });

/*
 * The bound being asserted, stated exactly: resident = the abandoned tail (calls whose
 * owner died unseen), and the peak within a turn = that tail plus ONE turn's calls.
 * Neither term is a function of elapsed time — which is the whole claim. The tail is
 * the only term that grows at all, at the rate owners are abandoned unseen (1/hour in
 * this simulation), and 3 days of it is 72 entries / ~8 KB.
 */
check(`(8) DAYS-LONG BOUND, REALISTIC: ${realistic.opened.toLocaleString()} subagent tool calls over 3 days leave ${realistic.residentAtEnd} resident entries (~${realistic.bytesApprox} bytes); peak within a turn was ${realistic.peakWithinATurn} = one turn's ${realistic.perTurn} calls + the ${realistic.residentAtEnd}-entry abandoned tail. NOTHING here is a function of elapsed time except the tail, which grows only when an owner dies unseen — the old design leaked one entry per foreground subagent tool call (all ${realistic.opened.toLocaleString()} of these) and needed a 4096 cap to survive it`,
  realistic.residentAtEnd < 200 && realistic.peakWithinATurn <= realistic.perTurn + realistic.residentAtEnd, realistic);

check(`(9) DAYS-LONG BOUND, ABSURD (50x): ${absurd.opened.toLocaleString()} calls leave ${absurd.residentAtEnd} resident (~${Math.round(absurd.bytesApprox / 1024)} KB); peak within a turn ${absurd.peakWithinATurn}. Even at a rate no real session approaches the resident set is bounded by the abandoned tail, and the 4096 boundary that produced the CAP-b fabrication is never a boundary at all`,
  absurd.residentAtEnd < 2000 && absurd.peakWithinATurn <= absurd.perTurn + absurd.residentAtEnd, absurd);

// ------------------------------------------------- fail-safe: no reclamation
{
  // The worst case: the engine stops emitting subagent `tool_result` frames entirely,
  // so `ended()` is never called. Nothing is reclaimed except by owner death.
  const r = new OpenToolCalls();
  for (let i = 0; i < 20_000; i++) r.issuedBySubagent('x' + i, 'w' + (i % 50));
  r.reap();
  const afterReap = r.size;
  r.issuedBySubagent('live', 'liveOwner');
  r.reap(deadChain(new Set(Array.from({ length: 50 }, (_, i) => 'w' + i))));
  check('(10) FAIL-SAFE DIRECTION: with reclamation TOTALLY disabled (no tool_result ever) 20,000 entries stay resident — and that is the WHOLE damage. No entry can spare a lane it did not create, so total reclamation failure costs bytes, never a fabricated or suppressed death; owner liveness still reclaims all 20,000 at a boundary, and the one live call survives',
    afterReap === 20_000 && r.size === 1 && r.parentOf('live') === 'liveOwner',
    { afterReapWithNoResults: afterReap, afterOwnersDied: r.size, liveStillResolves: r.parentOf('live') });
}

// ============================================================================
// THE ADVERSARIAL ORDERING — the 4th clean-room BROKEN verdict, made permanent.
// Everything below covers what the verifier could not reach because it stopped
// once `result > assistant` growth landed.
// ============================================================================

// ---------------------------------------------- (11) the verdict's own scenario
{
  const r = new OpenToolCalls();
  const TOTAL = 100_000;
  let wrongOwner = 0;
  for (let i = 0; i < TOTAL; i++) {
    const id = 'c' + i;
    r.ended(id);                        // the tool_result arrives BEFORE the frame
    r.issuedBySubagent(id, 'ownerW');   // ... that issued the call
    if (r.parentOf(id) !== 'ownerW') wrongOwner++;   // answer still correct
    if (i % 1000 === 0) r.reap();
  }
  r.reap();
  check(`(11) RESULT BEFORE ASSISTANT, AT VOLUME: ${TOTAL.toLocaleString()} calls whose tool_result preceded their own assistant frame leave ${r.size} resident entries, and all ${TOTAL.toLocaleString()} still gave the CORRECT owner at sweep time. This is the 4th clean-room verdict verbatim ({"resident":100000,"bounded":false}) — the two signals now annihilate in either order instead of the early end being discarded`,
    r.size === 0 && wrongOwner === 0, { total: TOTAL, resident: r.size, wrongOwnerAnswers: wrongOwner });
}

// ---------------------------------------------- (12) double end / end-then-reissue
{
  const a = new OpenToolCalls();
  a.issuedBySubagent('d', 'ownerW'); a.ended('d'); a.ended('d');   // ends twice
  const ownerAfterDoubleEnd = a.parentOf('d');
  a.reap();
  const residentAfterDoubleEnd = a.size;

  const b = new OpenToolCalls();
  b.issuedBySubagent('d', 'ownerW'); b.ended('d');
  b.issuedBySubagent('d', 'ownerV');                                // id re-issued
  const ownerAfterReissue = b.parentOf('d');
  b.reap();
  const residentAfterReissue = b.size;                              // the NEW call is live

  const c = new OpenToolCalls();
  for (let i = 0; i < 50_000; i++) { c.ended('x'); c.ended('x'); c.issuedBySubagent('x', 'ownerW'); c.ended('x'); }
  c.reap();

  check('(12) ENDING TWICE, AND ENDING THEN BEING RE-ISSUED: a doubly-ended call is reclaimed (an unmatched second end cannot resurrect it); a re-issued id is a NEW OPEN call that survives the boundary and answers with its NEW owner; and 50,000 rounds of end/end/open/end on ONE id leave one map entry at most, reclaimed at the boundary',
    ownerAfterDoubleEnd === 'ownerW' && residentAfterDoubleEnd === 0
    && ownerAfterReissue === 'ownerV' && residentAfterReissue === 1 && c.size === 0,
    { ownerAfterDoubleEnd, residentAfterDoubleEnd, ownerAfterReissue, residentAfterReissue, afterHammering: c.size });
}

// ---------------------------------------------- (13) an end that never gets an open
{
  const r = new OpenToolCalls();
  for (let i = 0; i < 100_000; i++) r.ended('never_opened_' + i);
  const beforeBoundary = r.size;
  r.reap();
  const afterBoundary = r.size;
  r.issuedBySubagent('live', 'ownerW');
  for (let i = 0; i < 100_000; i++) r.ended('never_opened2_' + i);
  r.reap();
  check(`(13) AN EARLY RESULT FOR A CALL THAT NEVER GETS AN ASSISTANT FRAME: 100,000 unmatched ends cost ${beforeBoundary} entries WITHIN the turn (the transient term — bounded by the tool_results in ONE TURN, a quantity the engine bounds, not a policy this type invented) and ${afterBoundary} after the boundary. A live call sitting through all of it is untouched`,
    beforeBoundary <= 100_000 && afterBoundary === 0 && r.size === 1 && r.parentOf('live') === 'ownerW',
    { withinTurn: beforeBoundary, afterBoundary, afterSecondRound: r.size, liveStillResolves: r.parentOf('live') });
}

// ---------------------------------------------- (14) out-of-order interleavings
{
  /*
   * Several calls mid-flight, their results arriving out of order relative to their
   * opens — including results that arrive before their own opens, results for calls
   * whose owner is a different agent, and two calls left genuinely in flight.
   */
  const r = new OpenToolCalls();
  const owners = { A: 'w1', B: 'w2', C: 'w3', D: 'w1', E: 'w2' };
  r.issuedBySubagent('A', owners.A);
  r.ended('C');                        // C's result before C's open
  r.issuedBySubagent('B', owners.B);
  r.ended('B');                        // B closes in order
  r.issuedBySubagent('C', owners.C);   // ... C's open arrives now: pair annihilates
  r.ended('E');                        // E's result before E's open
  r.issuedBySubagent('D', owners.D);   // D stays IN FLIGHT
  r.ended('A');                        // A closes, long after opening
  r.issuedBySubagent('E', owners.E);   // E's open arrives: pair annihilates
  const atSweep = Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map((k) => [k, r.parentOf(k)]));
  const inFlightAnswer = r.parentOf('D');
  r.reap();
  const survivors = ['A', 'B', 'C', 'D', 'E'].filter((k) => r.parentOf(k) !== null);
  check('(14) INTERLEAVED, OUT-OF-ORDER: five calls whose results arrive out of order relative to their opens (two results BEFORE their own opens, one call left in flight) — every one answers with its OWN owner at the sweep, and after the boundary the ONLY survivor is the call that is genuinely still in flight',
    Object.entries(atSweep).every(([k, v]) => v === owners[k]) && inFlightAnswer === 'w1'
    && survivors.length === 1 && survivors[0] === 'D' && r.size === 1,
    { atSweep, survivorsAfterBoundary: survivors, resident: r.size });
}

// ---------------------------------------------- (15) the bound under the adversarial ordering
const adversarial = simulate({ days: 3, callsPerHour: 400, turnsPerHour: 20, abandonRatePerHour: 2, label: 'realistic busy 3-day session, RESULT-BEFORE-ASSISTANT throughout', ordering: 'result-first' });
const mixedOrder = simulate({ days: 3, callsPerHour: 400, turnsPerHour: 20, abandonRatePerHour: 2, label: 'realistic busy 3-day session, orderings MIXED per call', ordering: 'mixed' });

check(`(15) THE DAYS-LONG BOUND HOLDS UNDER THE ORDERING THAT JUST BROKE IT: the same realistic 3-day session driven ENTIRELY as result-before-assistant — ${adversarial.opened.toLocaleString()} calls → ${adversarial.residentAtEnd} resident (~${adversarial.bytesApprox} bytes), peak within a turn ${adversarial.peakWithinATurn}, ${adversarial.wrongOwner} wrong owner answers — IDENTICAL to the ${realistic.residentAtEnd}/${realistic.peakWithinATurn} figures under the assistant-first ordering. On the defective build this same simulation left ${realistic.opened.toLocaleString()} resident entries`,
  adversarial.residentAtEnd === realistic.residentAtEnd
  && adversarial.peakWithinATurn === realistic.peakWithinATurn
  && adversarial.wrongOwner === 0, adversarial);

check(`(16) ... AND UNDER MIXED ORDERINGS: half the calls result-first, half assistant-first, interleaved — ${mixedOrder.opened.toLocaleString()} calls → ${mixedOrder.residentAtEnd} resident, peak ${mixedOrder.peakWithinATurn}, ${mixedOrder.wrongOwner} wrong owner answers. THE BOUND IS A FUNCTION OF THE CALLS IN FLIGHT, NOT OF THE ORDERING`,
  mixedOrder.residentAtEnd === realistic.residentAtEnd
  && mixedOrder.peakWithinATurn === realistic.peakWithinATurn
  && mixedOrder.wrongOwner === 0, mixedOrder);

// ---------------------------------------------- (17) exhaustive orderings, N calls
{
  /*
   * The generalisation of (5b): rather than the six orderings someone thought to
   * write, every permutation of the 2N signals of N concurrent calls. Each is graded
   * on BOTH properties — the ownership answer at the sweep and reclamation after the
   * boundary — which is the pairing whose absence let the defect through.
   */
  const perms = (xs) => xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
  const signals = ['A+', 'A-', 'B+', 'B-', 'C+', 'C-'];   // + = assistant, - = result
  const owners = { A: 'w1', B: 'w2', C: 'w3' };
  let checked = 0, badAnswer = 0, badReclaim = 0;
  for (const p of perms(signals)) {
    const r = new OpenToolCalls();
    for (const s of p) s[1] === '+' ? r.issuedBySubagent(s[0], owners[s[0]]) : r.ended(s[0]);
    for (const k of ['A', 'B', 'C']) if (r.parentOf(k) !== owners[k]) badAnswer++;
    r.reap();
    if (r.size !== 0) badReclaim++;
    checked++;
  }
  check(`(17) EVERY PERMUTATION, NOT THE SIX WE THOUGHT OF: all ${checked} interleavings of three concurrent calls' six signals — each graded on BOTH properties. Every ordering gives every call its own owner at the sweep AND leaves zero resident after the boundary. There is no arrangement of opens and ends, in any order, that leaves an ended call resident`,
    badAnswer === 0 && badReclaim === 0, { permutations: checked, wrongOwnerAnswers: badAnswer, orderingsThatLeaked: badReclaim });
}

// ------------------------------- (18) RECLAMATION INSIDE THE PERMUTATION SPACE
{
  /*
   * THE STRUCTURAL GAP THAT LET THE 5th VERDICT THROUGH, closed.
   *
   * (17) permutes the six signals WITHIN ONE reclamation window and reaps once, at
   * the end. It therefore cannot express the defect the 5th clean room found, which
   * needs a `reap()` BETWEEN two signals OF THE SAME CALL: `ended` > `reap` >
   * `issued` drops the tombstone before the pair can annihilate, and the late issue
   * opens a record for a call that is already over. Two verdicts in a row were found
   * in a region this guard could not see — so reclamation points are now part of the
   * permutation space rather than a step applied afterwards.
   *
   * 720 orderings x 128 subsets of the 7 gap positions = 92,160 configurations, each
   * graded on THREE properties at once:
   *   (i)   RECLAMATION — once no owner is live, nothing is resident. This is the
   *         route-independent property: no end signal, terminal frame or re-issue is
   *         supplied for anything, so only owner liveness can bound it.
   *   (ii)  PROPERTY (b) — a call that is genuinely in flight (D: issued, never
   *         ended, owner live throughout) keeps its owner across EVERY reap. The
   *         bound must not be bought with a fabricated death.
   *   (iii) NO CROSS-CONTAMINATION — at no point in any configuration does a call
   *         answer with another call's owner.
   */
  const perms = (xs) => xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
  const signals = ['A+', 'A-', 'B+', 'B-', 'C+', 'C-'];
  const owners = { A: 'w1', B: 'w2', C: 'w3', D: 'w4' };
  const orderings = perms(signals);
  const gaps = signals.length + 1;                       // 7 positions a boundary can fall in
  let configs = 0, badReclaim = 0, badLiveAnswer = 0, badOwnerAnswer = 0, resurrected = 0;

  for (const p of orderings) {
    for (let mask = 0; mask < (1 << gaps); mask++) {
      const live = new Set(['w1', 'w2', 'w3', 'w4']);
      // level-triggered liveness, over the WHOLE CHAIN (the 6th verdict's contract)
      const isOver = (_id, chain) => chain.length > 0 && chain.every((p) => !live.has(p));
      const r = new OpenToolCalls();
      r.issuedBySubagent('D', owners.D);                   // genuinely in flight, throughout
      const grade = () => {
        for (const k of ['A', 'B', 'C', 'D']) {
          const v = r.parentOf(k);
          if (v !== null && v !== owners[k]) badOwnerAnswer++;
        }
        if (r.parentOf('D') !== owners.D) badLiveAnswer++;
      };
      for (let i = 0; i <= p.length; i++) {
        if (mask & (1 << i)) { r.reap(isOver); grade(); }  // a turn boundary falls here
        if (i < p.length) {
          const s = p[i];
          s[1] === '+' ? r.issuedBySubagent(s[0], owners[s[0]]) : r.ended(s[0]);
          grade();
        }
      }
      // Every call except D has had BOTH signals; D is the only one in flight. Any
      // other survivor is a record resurrected by a boundary landing between a call's
      // end and its issue — measured, not assumed.
      r.reap(isOver);
      if (r.size > 1) resurrected++;
      // The route-independent bound: the owners retire. No terminal frame is
      // delivered for any of them and no further result arrives — liveness alone.
      live.clear();
      r.reap(isOver);
      if (r.size !== 0) badReclaim++;
      configs++;
    }
  }
  check(`(18) RECLAMATION INTERLEAVED INTO THE PERMUTATION SPACE: ${configs.toLocaleString()} configurations — all ${orderings.length} orderings of three calls' six signals x all ${1 << gaps} placements of turn boundaries between them. (17) could never see the 5th clean-room defect because it only ever reaps AFTER the last signal; ${resurrected.toLocaleString()} of these configurations do resurrect a completed call (a boundary landing between its end and its issue), and EVERY ONE of them is still reclaimed once its owner is no longer live — with no end signal, terminal frame or re-issue ever supplied. The call genuinely in flight keeps its owner in all ${configs.toLocaleString()}`,
    badReclaim === 0 && badLiveAnswer === 0 && badOwnerAnswer === 0,
    { configurations: configs, configurationsThatResurrectACompletedCall: resurrected, leakedAfterOwnersRetired: badReclaim, liveCallLostItsOwner: badLiveAnswer, wrongOwnerAnswers: badOwnerAnswer });
}

// ------------------------------- (20) the bound WITH boundary liveness, every ordering
{
  /*
   * The same realistic 3-day session, now with the reclamation route this fix adds —
   * across every ordering INCLUDING the 5th verdict's (result > BOUNDARY > issue for
   * every call, the one that made completed calls permanently open). The abandoned
   * tail, which was the only term that grew with elapsed time, goes to zero: an owner
   * that is not live has nothing in flight, so no end signal is needed to know it.
   */
  const shapes = [
    { label: 'assistant-first', ordering: 'assistant-first' },
    { label: 'result-first', ordering: 'result-first' },
    { label: 'mixed', ordering: 'mixed' },
    { label: 'THE 5th VERDICT ORDERING (result > BOUNDARY > issue, EVERY call)', ordering: 'result-first', boundaryBetweenSignals: true },
    { label: 'absurd 50x, result-first', ordering: 'result-first', rate: { callsPerHour: 20_000, turnsPerHour: 200, abandonRatePerHour: 20 } },
  ];
  /*
   * The claim being tested is NOT "resident is zero" — under the 5th verdict's
   * ordering a completed call IS resurrected as an OPEN record, and while its owner
   * is still working that record is indistinguishable from a call in flight and MUST
   * be kept. The claim is that residency is A FUNCTION OF THE LIVE OWNERS, NOT OF
   * ELAPSED TIME. So every shape is run over 3 days and again over 9 days (3x the
   * calls) and the two figures must be IDENTICAL.
   */
  const rows = shapes.map((s) => {
    const base = { callsPerHour: 400, turnsPerHour: 20, abandonRatePerHour: 2, ...(s.rate ?? {}) };
    const d3 = simulate({ days: 3, ...base, label: s.label, ordering: s.ordering, liveness: true, boundaryBetweenSignals: s.boundaryBetweenSignals });
    const d9 = simulate({ days: 9, ...base, label: s.label, ordering: s.ordering, liveness: true, boundaryBetweenSignals: s.boundaryBetweenSignals });
    return {
      label: s.label, callsIn3d: d3.opened, callsIn9d: d9.opened,
      residentAfter3d: d3.residentAtEnd, residentAfter9d: d9.residentAtEnd,
      peak3d: d3.peakWithinATurn, peak9d: d9.peakWithinATurn,
      wrongOwner: d3.wrongOwner + d9.wrongOwner,
    };
  });
  check(`(20) THE DAYS-LONG BOUND WITH BOUNDARY LIVENESS, UNDER EVERY ORDERING INCLUDING THE ONE THAT BROKE THE 5th BUILD — FLAT IN TIME **WHEN OWNERS RETIRE**, which is the honest form of the claim (the unqualified "flat in time" was the 6th clean room's property-(c) finding; the owner that never retires is measured in (19) and (21)): ${rows.map((r) => `${r.label} ${r.residentAfter3d}@3d/${r.residentAfter9d}@9d`).join('; ')}. The ${realistic.residentAtEnd}-entry abandoned tail is gone entirely (owner liveness reclaims it with no terminal frame). Under the 5th verdict's ordering every completed call IS resurrected as an OPEN record — and residency still does not move between 3 and 9 days, because it is bounded by ONE LIVE OWNER-GENERATION's calls (30 turns x 20 = 600), not by the ${rows[3].callsIn9d.toLocaleString()} calls issued. ${rows.reduce((n, r) => n + r.wrongOwner, 0)} wrong owner answers`,
    rows.every((r) => r.residentAfter3d === r.residentAfter9d && r.peak3d === r.peak9d && r.wrongOwner === 0),
    rows);
}

// ------------------------------- (19) the residual, measured rather than claimed
{
  /*
   * HONEST BOUND. Owner liveness reclaims a resurrected record only when the owner
   * stops being live. While the owner IS live the record is indistinguishable from a
   * call in flight and MUST be kept — sparing a live worker's child is property (b).
   * So the residual is named and measured here rather than argued away: the resident
   * set of an immortal owner grows with the number of calls it issues under the
   * pathological ordering, and returns to zero the moment it retires.
   */
  const r = new OpenToolCalls();
  const live = new Set(['immortal']);
  const isOver = (_id, chain) => chain.length > 0 && chain.every((p) => !live.has(p));
  for (let i = 0; i < 10_000; i++) { r.ended('c' + i); r.reap(isOver); r.issuedBySubagent('c' + i, 'immortal'); }
  const whileImmortal = r.size;
  live.clear();
  r.reap(isOver);
  check(`(19) THE NAMED RESIDUAL, MEASURED: an owner that NEVER retires accumulates one record per call issued under the end>boundary>issue ordering — ${whileImmortal.toLocaleString()} here — and all of them go the instant it is no longer live (${r.size} resident). This is the one sequence that can still hold records indefinitely, and it needs an agent that never terminates; it is stated in ARCH-003 rather than hidden`,
    whileImmortal === 10_000 && r.size === 0, { whileOwnerImmortal: whileImmortal, afterOwnerRetired: r.size });
}

// ============================================================================
// THE 6th CLEAN-ROOM VERDICT — property (c): the flat-growth CLAIM was false, and
// property (b): ownership is a CHAIN. Both made permanent below.
// ============================================================================

// ---------------- (21) the property-(c) case, reproduced and stated truthfully
{
  /*
   * VERDICT (dispatch openai run 01a01563-cd26-79a1-b9e4-d589ccafb49a, verbatim):
   *   node scratch-flat-bound.mjs → exit 1
   *   {"shortDurationResident":1000,"longDurationResident":10000,"flat":false}
   *
   * The verifier was RIGHT and the previous build's claim was wrong. Under
   * end > boundary > issue with a CONTINUOUSLY LIVE owner, each completed call
   * becomes an OPEN record whose every end signal is already spent, and while its
   * owner is live that record is INDISTINGUISHABLE FROM A CALL IN FLIGHT — keeping
   * it IS property (b). So this check does not pretend the residual away and does not
   * assert "flat": it asserts THE TRUE BOUND, in the shape a future change would have
   * to keep honest.
   *   (i)   with an immortal owner it is LINEAR IN THE CALLS ISSUED — exactly one
   *         record per call, 1,000 at the short duration and 10,000 at the long one,
   *         the clean room's own numbers;
   *   (ii)  it goes to ZERO the moment that owner is no longer live, at BOTH
   *         durations — so it is bounded by one owner-liveness generation, never by
   *         elapsed time;
   *   (iii) with an owner that DOES retire (every real agent), the same two very
   *         different durations give IDENTICAL residency — that, and only that, is
   *         the flatness the design can claim.
   */
  const run = (calls, immortal) => {
    const r = new OpenToolCalls();
    const live = new Set(['w']);
    const isOver = (_id, chain) => chain.length > 0 && chain.every((p) => !live.has(p));
    for (let i = 0; i < calls; i++) {
      if (!immortal && i % 100 === 0) { live.clear(); live.add('w'); }   // a retiring generation
      r.ended('c' + i);
      r.reap(isOver);
      r.issuedBySubagent('c' + i, i % 100 === 0 && !immortal ? 'w' : 'w');
      if (!immortal && i % 100 === 99) { live.clear(); r.reap(isOver); live.add('w'); }
    }
    const resident = r.size;
    live.clear();
    r.reap(isOver);
    return { resident, afterOwnerRetires: r.size };
  };
  const shortImmortal = run(1_000, true);
  const longImmortal = run(10_000, true);
  const shortRetiring = run(1_000, false);
  const longRetiring = run(10_000, false);
  const observed = {
    shortDurationResident: shortImmortal.resident,
    longDurationResident: longImmortal.resident,
    flat: shortImmortal.resident === longImmortal.resident,
    immortalOwnerResidencyIsOneRecordPerCall:
      shortImmortal.resident === 1_000 && longImmortal.resident === 10_000,
    goesToZeroWhenTheOwnerRetires: [shortImmortal.afterOwnerRetires, longImmortal.afterOwnerRetires],
    retiringOwnerResidentShortVsLong: [shortRetiring.resident, longRetiring.resident],
  };
  check(`(21) PROPERTY (c), STATED TRUTHFULLY RATHER THAN AS "FLAT": the 6th clean room drove ${observed.longDurationResident.toLocaleString()} end>boundary>issue calls past a CONTINUOUSLY LIVE owner and got ${observed.longDurationResident.toLocaleString()} resident records against ${observed.shortDurationResident.toLocaleString()} for a tenth of the work — {"flat":false}, and it was right. The bound this build claims instead, and asserts here: ONE record per such call while the owner never retires (it is indistinguishable from a call in flight, so keeping it IS property (b)); ZERO the instant the owner stops being live, at BOTH durations; and IDENTICAL residency at both durations for an owner that does retire. Residency is a function of the LIVE OWNER-GENERATIONS, never of elapsed time`,
    observed.immortalOwnerResidencyIsOneRecordPerCall
    && observed.goesToZeroWhenTheOwnerRetires.every((n) => n === 0)
    && shortRetiring.resident === longRetiring.resident,
    observed);
}

// ---------------- (22) NESTED OWNERSHIP: chains, at depth, under reclamation
{
  /*
   * PROPERTY (b), the 6th verdict's other half, in the unit space: a record is
   * reclaimable ONLY if nothing in its whole ancestry can still be running. Driven
   * over every chain depth 1..6, with the intermediates retiring in EVERY order and
   * a reclamation after each retirement — 2^k orders per depth. Graded on three
   * properties at once, the pairing whose absence let the verdict through:
   *   (i)   while the ROOT is live, the leaf ALWAYS still names its immediate owner
   *         (no arrangement of terminal intermediates may orphan it);
   *   (ii)  once the root retires too, EVERYTHING is reclaimed (the bound is kept);
   *   (iii) no call ever answers with another call's owner.
   */
  let configs = 0, orphanedWhileRootLive = 0, leakedAfterRootRetired = 0, wrongOwner = 0;
  for (let depth = 1; depth <= 6; depth++) {
    const ids = ['R', ...Array.from({ length: depth - 1 }, (_, i) => 'a' + i)];
    for (let mask = 0; mask < (1 << ids.length); mask++) {
      const r = new OpenToolCalls();
      for (let i = 1; i < ids.length; i++) r.issuedBySubagent(ids[i], ids[i - 1]);
      r.issuedBySubagent('L', ids[ids.length - 1]);
      const live = new Set(ids);
      const isOver = (_id, chain) => chain.length > 0 && chain.every((p) => !live.has(p));
      // retire the intermediates (never the root) in the order this mask names
      for (let i = 1; i < ids.length; i++) {
        if (mask & (1 << i)) { live.delete(ids[i]); r.reap(isOver); }
      }
      r.reap(isOver);
      if (r.parentOf('L') !== ids[ids.length - 1]) orphanedWhileRootLive++;
      if (r.ownerChainOf('L')[r.ownerChainOf('L').length - 1] !== 'R') orphanedWhileRootLive++;
      for (let i = 1; i < ids.length; i++) if (r.parentOf(ids[i]) !== null && r.parentOf(ids[i]) !== ids[i - 1]) wrongOwner++;
      live.clear();                       // the root retires as well
      r.reap(isOver);
      if (r.size !== 0) leakedAfterRootRetired++;
      configs++;
    }
  }
  check(`(22) NESTED OWNERSHIP, EVERY DEPTH x EVERY RETIREMENT ORDER: ${configs} configurations — chains 1 to 6 deep, every subset of intermediates retiring, a reclamation after each. In ALL of them the leaf still names its own issuer and its chain still reaches the live root (${orphanedWhileRootLive} orphaned), nothing answers with another call's owner (${wrongOwner}), and once the ROOT retires too every record goes (${leakedAfterRootRetired} leaked). The 6th clean-room verdict is one configuration of this space; asking only the IMMEDIATE owner fails all of them at depth >= 2`,
    orphanedWhileRootLive === 0 && leakedAfterRootRetired === 0 && wrongOwner === 0,
    { configurations: configs, leafOrphanedWhileRootLive: orphanedWhileRootLive, leakedAfterRootRetired, wrongOwnerAnswers: wrongOwner });
}

// -------- (23) ID REUSE: AN ESTABLISHED CHAIN IS IMMUTABLE, AND STILL BOUNDED
{
  /*
   * THE 7th CLEAN-ROOM VERDICT, IN THE UNIT SPACE — and its cost, measured.
   *
   * Records used to be keyed by the id the ENGINE mints, so any later write under an
   * id another record's ancestry passed through rewrote that ancestry: a main-thread
   * re-issue DELETED the ancestor (chain ["M","R"] -> ["M"], the live root
   * unreachable, the leaf reclaimed and fabricated dead) and a subagent re-issue
   * REDIRECTED it. Keying by an internally-minted handle makes both unrepresentable —
   * but it does so by KEEPING superseded generations while a descendant walks through
   * them, and a structure kept for a reason still needs a measured bound. Two of them
   * here, because the fix also added a second collection (the name index):
   *   (i)   an id re-issued N times leaves nothing behind once its calls have ended;
   *   (ii)  the NAME INDEX never outgrows the records it indexes, and empties with
   *         them. A second collection whose lifetime nobody measured is this ticket's
   *         entire failure class; it is not repeated on trust.
   */
  const ROUNDS = 20_000;
  const r = new OpenToolCalls();
  let chainCorrupted = 0;
  for (let i = 0; i < ROUNDS; i++) {
    r.issuedBySubagent('HOT', 'R');            // one id, re-issued every round
    r.issuedBySubagent('leaf_' + i, 'HOT');
    r.issuedByMainThread('HOT');               // …and taken over by the main thread
    if (r.ownerChainOf('leaf_' + i).join(',') !== 'HOT,R') chainCorrupted++;
    if (r.ownerChainOf('HOT').length !== 0) chainCorrupted++;   // property (a) every round
    r.ended('leaf_' + i);
  }
  const liveRoot = (_id, chain) => chain.length > 0 && chain.every((p) => p !== 'R');
  r.reap(liveRoot);
  const residentWhileRootLive = r.size, bindingsWhileRootLive = r.bindingSize;
  r.reap(() => true);
  /*
   * THE NUMBER THAT MOVED, AND WHY (8th clean-room verdict). `bindingsWhileRootLive`
   * was 0 here and is now 2: a name whose call could STILL BE SPEAKING keeps its
   * meaning for ONE boundary after nothing points at it, because a call issued by a
   * record reclaimed at this boundary can arrive in the NEXT turn and must find "this
   * name was issued, its ancestry ends there" rather than "this name is unknown" —
   * which spares a death forever. The two are `R` and the main thread's current
   * generation of `HOT`; the 20,000 superseded generations and the 20,000 ENDED leaves
   * get NO grace (an ended call cannot issue anything) and go at once, so the grace is
   * a CONSTANT, not a term that grows with the rounds. Both are gone one boundary later,
   * which is asserted here rather than described.
   */
  check(`(23) ID REUSE CANNOT CORRUPT A CHAIN, AND KEEPING THE OLD GENERATIONS COSTS NOTHING AFTERWARDS: ${ROUNDS.toLocaleString()} re-issues of ONE id, each with its own leaf — every leaf keeps the ancestry it was created with and the main thread's own generation of that id keeps an EMPTY chain (${chainCorrupted} corrupted), and once the leaves end, ${residentWhileRootLive} records and ${bindingsWhileRootLive} name bindings remain (the grace is a constant 2 — R and the live HOT generation — not a function of the ${ROUNDS.toLocaleString()} rounds), and 0 of both one boundary later. On the pre-fix build the first re-issue truncated the leaf's chain to ["M"] and the boundary reclaimed a live leaf under a live root`,
    chainCorrupted === 0 && residentWhileRootLive === 0 && bindingsWhileRootLive === 2 && r.size === 0 && r.bindingSize === 0,
    { rounds: ROUNDS, corruptedChains: chainCorrupted, residentWhileRootLive, bindingsWhileRootLive, residentAtEnd: r.size, bindingsAtEnd: r.bindingSize });
}

// ------------------------- (24) THE NAME INDEX'S OWN BOUND, ACROSS THE SIMS
{
  /*
   * The index maps a tool_use id to the generation it currently means. It is the
   * second collection in a type whose whole history is second collections with
   * unmeasured lifetimes, so its bound is asserted the same way the records' is: over
   * a realistic days-long session, at two very different durations, under every
   * ordering — and it must go to ZERO whenever the records do.
   */
  const rows = [];
  for (const days of [3, 9]) {
    for (const ordering of ['assistant-first', 'result-first']) {
      const r = new OpenToolCalls();
      const live = new Set();
      const turns = days * 24 * 6;
      for (let t = 0; t < turns; t++) {
        const owner = 'w' + (t % 5);
        live.add(owner);
        for (let i = 0; i < 20; i++) {
          const id = `c${t}_${i}`;
          if (ordering === 'result-first') { r.ended(id); r.issuedBySubagent(id, owner); }
          else { r.issuedBySubagent(id, owner); r.ended(id); }
        }
        if (t % 3 === 2) live.delete(owner);            // owners retire as they finish
        r.reap((_id, chain) => chain.length > 0 && chain.every((p) => !live.has(p)));
      }
      live.clear();
      r.reap((_id, chain) => chain.length > 0 && chain.every((p) => !live.has(p)));
      rows.push({ days, ordering, resident: r.size, bindings: r.bindingSize });
    }
  }
  check('(24) THE NAME INDEX IS BOUNDED BY THE CALLS IT INDEXES, AT BOTH DURATIONS AND UNDER BOTH ORDERINGS: a realistic session over 3 and 9 days leaves ZERO records and ZERO bindings — the index is reclaimed by the same "keep while something needs it" rule as the records, not by a policy of its own, so it cannot become the next structure that outlives its subject',
    rows.every((x) => x.resident === 0 && x.bindings === 0), rows);
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) console.log(`failed: ${failures.join(' | ')}`);
process.exit(fail ? 1 : 0);
