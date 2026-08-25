#!/usr/bin/env node
/**
 * ARCH-003 — THE 8th CLEAN-ROOM VERDICT, MADE PERMANENT: A NAME CAN BE RESERVED FOR A
 * RECORD THAT DOES NOT EXIST YET, AND A RESERVATION MUST BE AS UNTOUCHABLE AS A RECORD.
 *
 * VERDICT (8th clean-room pass, verbatim):
 *   node scratch-verifier-reuse-window.mjs → exit 1
 *   {"provenance":"DIRECT UNIT DRIVE","before":[],"after":[],
 *    "survived":false,"mainChain":["R"],"resident":1,"bindings":2}
 *
 * THE SEQUENCE. A child L names its parent P BEFORE P's own issue frame arrives (so L
 * RESERVES the name P); the MAIN THREAD then re-uses P; a reclamation falls at a
 * boundary; only then does the delayed `P → R` issue arrive. BOTH non-negotiables broke
 * in that one sequence:
 *   (b) L lost its live-root ancestry and was reclaimed — live work recorded dead;
 *   (a) the main-thread lane named P INHERITED R's ancestry (`mainChain:["R"]`), where a
 *       main-thread lane must have an EMPTY chain or its genuine death is suppressed.
 *
 * WHY THE 7th FIX DID NOT COVER IT, AND WHY THE 7th LANE'S OWN ASSESSMENT WAS WRONG.
 * Handles and creation-time capture protect records THAT ALREADY EXIST; the 7th entry
 * called this window "an AMBIGUITY, not a corruption" and left it guarded. It is a
 * corruption: a RESERVATION WAS NOT A RECORD, so the main thread's re-issue orphaned it,
 * the late frame filled the NEW generation (which the main lane's name resolves to), and
 * the reservation the live child was holding could never be filled by anything.
 *
 * WHAT THIS SCRIPT GRADES — the class, not the sequence:
 *   A RESERVATION IS FIRST-CLASS FROM THE MOMENT IT IS REFERENCED. A re-issue rebinds
 *   the NAME and cannot reach it; the issue frame that eventually arrives for that name
 *   FILLS THE RESERVATION rather than the current generation; and an ancestry that walks
 *   into an unfilled reservation is reported as INCOMPLETE rather than as ending there.
 *
 * (6)(7)(8) are the counterweights and the RESIDUALS, pinned rather than described, so
 * the next pass finds today's behaviour documented rather than surprising.
 *
 * Usage: node scripts/adversarial-arch-003-reservation-window.mjs
 */
import { OpenToolCalls, UNRESOLVED_ANCESTOR } from '../src/server/open-tool-calls.ts';

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  ok ? pass++ : (fail++, failures.push(name));
}

/**
 * THE BRIDGE, MODELLED FROM ITS REAL CODE (identical to the model in the other ARCH-003
 * adversarial scripts, plus the BUG-105 strict half). `agents` is `#agents`, `level` is
 * `#backgroundTasks`. `cannotStillBeInFlight` mirrors
 * `AgentSession.#callCannotStillBeInFlight`, `spares` mirrors `#ownershipSpares` (the
 * `kind:'tool'` sweep guard, WITH the un-observed-owner degrade), and `sparesAgentRow`
 * mirrors `#chainHasLiveBackgroundAgent` (the `kind:'agent'` guard, WITHOUT it).
 */
function bridge({ agents, level, terminalLanes = new Set() }) {
  const notLive = (owner) => {
    if (!owner) return false;
    if (level.has(owner)) return false;
    const row = agents.get(owner);
    if (!row) return false;                       // untracked — no evidence at all
    return row !== 'running';
  };
  return {
    cannotStillBeInFlight: (toolUseId, chain) => {
      if (terminalLanes.has(toolUseId)) return true;
      if (!chain.length) return false;
      return chain.every(notLive);
    },
    spares: (chain) => chain.some((owner) => level.has(owner) || !agents.has(owner)),
    sparesAgentRow: (chain) => chain.some((owner) => level.has(owner)),
  };
}

// R is the LIVE background root; P (the intermediate whose id gets re-used) is terminal.
const ROOT_LIVE = () => bridge({ agents: new Map([['R', 'running'], ['P', 'completed']]), level: new Set(['R']) });

// ============================================================= (1) THE VERDICT
{
  /*
   * The verifier's own scratch, signal for signal — including its choice NOT to play
   * R's own issue frame, which is why R's ancestry reads as unresolved at the end.
   */
  const r = new OpenToolCalls();
  r.issuedBySubagent('L', 'P');      // the child RESERVES the parent name P
  r.issuedByMainThread('P');         // the MAIN THREAD re-uses P
  r.reap(ROOT_LIVE().cannotStillBeInFlight);   // a boundary falls INSIDE the window
  const before = r.ownerChainOf('L');
  r.issuedBySubagent('P', 'R');       // …and only NOW does P's own issue frame arrive
  const after = r.ownerChainOf('L');
  const res = r.residency();
  check('(1) THE 8th CLEAN-ROOM VERDICT: a name RESERVED by a live child cannot be taken from it by a re-issue — the delayed issue frame still fills the child\'s reservation, so the child keeps its live-root ancestry AND the main-thread lane that re-used the id keeps an EMPTY chain. On ba9039e this printed the verdict line: {"before":[],"after":[],"survived":false,"mainChain":["R"],"resident":1,"bindings":2}',
    r.parentOf('L') === 'P' && after.includes('P') && after.includes('R')
      && r.ownerChainOf('P').length === 0 && before.includes('P'),
    { provenance: 'DIRECT UNIT DRIVE', before, after,
      survived: r.parentOf('L') !== null, mainChain: r.ownerChainOf('P'),
      resident: res.resident, bindings: res.bindings });
}

// ============ (2) THE SAME SEQUENCE AS THE REAL FRAME STREAM (R's own frame played)
{
  /*
   * The real stream always contains the root's OWN main-thread Task frame before
   * anything names it, so the healed chain is exactly ["P","R"] with nothing unresolved
   * left in it. Both non-negotiables are asserted in the SAME run: the leaf is spared
   * while R is live, and the main-thread lane that took the name over is NOT.
   */
  const r = new OpenToolCalls();
  r.issuedByMainThread('R');
  r.issuedBySubagent('L', 'P');
  r.issuedByMainThread('P');
  const b = ROOT_LIVE();
  r.reap(b.cannotStillBeInFlight);
  r.issuedBySubagent('P', 'R');
  const leafChain = r.ownerChainOf('L');
  const mainChain = r.ownerChainOf('P');
  r.reap(b.cannotStillBeInFlight);
  check('(2) AND WITH THE ROOT\'S OWN FRAME IN THE STREAM, THE HEALED CHAIN IS EXACT: the leaf resolves to ["P","R"], is spared by the live root at the next boundary and keeps its record, while the main-thread lane that re-used P resolves to [] and is spared by NOTHING — property (b) bought without property (a), in one run',
    leafChain.join(',') === 'P,R' && mainChain.length === 0
      && b.spares(leafChain) === true && b.spares(mainChain) === false
      && r.parentOf('L') === 'P',
    { leafChain, mainChain, leafSpared: b.spares(leafChain), mainSpared: b.spares(mainChain),
      leafRecordSurvived: r.parentOf('L') !== null });
}

// ====================== (3) THE SWEEP INSIDE THE WINDOW, NOT ONLY THE RECORD
{
  /*
   * A surviving record is worth nothing if the sweep records the death anyway at that
   * same boundary: the sweep asks `ownerChainOf` and spares on what it says. INSIDE the
   * window the ancestry is not known, and the chain must SAY SO — `UNRESOLVED_ANCESTOR`
   * reads to the bridge as an owner it has never observed, which is exactly what it is.
   */
  const r = new OpenToolCalls();
  r.issuedByMainThread('R');
  r.issuedBySubagent('L', 'P');
  r.issuedByMainThread('P');
  const b = ROOT_LIVE();
  const chainAtSweep = r.ownerChainOf('L');
  check('(3) THE SWEEP IS SPARED INSIDE THE WINDOW TOO, NOT JUST THE RECORD: while the parent\'s issue frame has not arrived, the chain reports an UNRESOLVED ancestor instead of pretending to end, so the turn-end sweep spares the live leaf\'s lane rather than recording its death on an ancestry nobody has named yet',
    chainAtSweep[chainAtSweep.length - 1] === UNRESOLVED_ANCESTOR && b.spares(chainAtSweep) === true
      && chainAtSweep[0] === 'P',
    { chainAtSweep, spared: b.spares(chainAtSweep) });
}

// ================================= (4) THE VERDICT MINUS THE RE-USE (one step simpler)
{
  /*
   * The re-use is not load-bearing. Child before parent, a boundary in between, NO id
   * reuse at all: on a build that judged a partial chain, the leaf was reclaimed here
   * too. This is the case the next pass would have found by deleting one line.
   */
  const r = new OpenToolCalls();
  r.issuedByMainThread('R');
  r.issuedBySubagent('L', 'P');
  const b = ROOT_LIVE();
  r.reap(b.cannotStillBeInFlight);
  const survivedBoundary = r.parentOf('L') !== null;
  r.issuedBySubagent('P', 'R');
  check('(4) AND WITHOUT ANY ID REUSE: a child issued before its parent, with a reclamation in between, keeps its record and gets its full ancestry when the parent\'s frame finally lands — the defect needs only the ORDERING, so guarding the reuse alone would have been the eighth guard on one cause',
    survivedBoundary && r.ownerChainOf('L').join(',') === 'P,R',
    { survivedBoundary, chainAfterLateIssue: r.ownerChainOf('L') });
}

// ======================================= (5) EVERY PLACEMENT AND EVERY DEPTH
{
  /*
   * The window opened wherever it can open: the reuse before or after the boundary,
   * several boundaries inside the window, the reservation two and three levels up, and
   * an end signal spent on the reserved name while it waits.
   */
  const rows = [];
  for (const depth of [1, 2, 3]) {
    for (const boundaries of [0, 1, 3]) {
      for (const reuseFirst of [true, false]) {
        for (const endInWindow of [true, false]) {
          const r = new OpenToolCalls();
          const b = ROOT_LIVE();
          r.issuedByMainThread('R');
          // A chain of `depth` reserved ancestors above the leaf: L -> a0 -> a1 … -> R
          const names = Array.from({ length: depth }, (_, i) => 'a' + i);
          r.issuedBySubagent('L', names[0]);
          if (reuseFirst) r.issuedByMainThread(names[0]);
          if (endInWindow) r.ended(names[0]);
          for (let i = 0; i < boundaries; i++) r.reap(b.cannotStillBeInFlight);
          if (!reuseFirst) r.issuedByMainThread(names[0]);
          // the delayed issue frames, innermost first
          for (let i = 0; i < depth; i++) r.issuedBySubagent(names[i], names[i + 1] ?? 'R');
          const chain = r.ownerChainOf('L');
          rows.push({ depth, boundaries, reuseFirst, endInWindow,
            ok: r.parentOf('L') === names[0] && chain.includes('R') && r.ownerChainOf(names[0]).length === 0 });
        }
      }
    }
  }
  const bad = rows.filter((x) => !x.ok);
  check(`(5) EVERY PLACEMENT OF THE WINDOW, AT EVERY DEPTH: ${rows.length} configurations — the reuse before or after the boundary, 0/1/3 boundaries inside the window, reservations 1-3 levels up, with and without an end signal spent on the reserved name — the leaf reaches the live root in every one and the re-used name resolves to an EMPTY chain in every one`,
    bad.length === 0, { configurations: rows.length, failed: bad.length, firstFailure: bad[0] ?? null });
}

// ===================== (6) THE RESIDUAL: UNKNOWN IS A ONE-BOUNDARY STATE, NOT AMNESTY
{
  /*
   * PINNED RESIDUAL. If the parent's issue frame NEVER arrives, the ancestry can never
   * be completed — and sparing on that forever is the OVER-SUPPRESSION that killed
   * attempts 1-3 (a genuine death silenced by absence of knowledge). So a reservation is
   * "still coming" for exactly ONE boundary; after that the ancestry is read as ending
   * at the reserved name and the lane records its honest death. A death here is
   * DEFERRED BY ONE TURN, never lost — and if a live ancestor above it was never named
   * by any frame, that deferred death is recorded on an ancestry that was never
   * knowable. That is the price, stated rather than hidden.
   */
  const r = new OpenToolCalls();
  const b = bridge({ agents: new Map([['P', 'completed']]), level: new Set() });
  r.issuedBySubagent('L', 'P');
  const atFirstBoundary = r.ownerChainOf('L');
  r.reap(b.cannotStillBeInFlight);
  const survivedFirst = r.parentOf('L') !== null;
  const atSecondBoundary = r.ownerChainOf('L');
  r.reap(b.cannotStillBeInFlight);
  check('(6) PINNED RESIDUAL — UNKNOWN ANCESTRY IS A ONE-BOUNDARY STATE: a parent whose issue frame never arrives spares its child at the FIRST boundary (the frame may still be coming); at the SECOND the chain is read as ending at that name, the record is reclaimed and any lane answered from it records its honest death. The spare is bounded by ONE boundary rather than lasting forever — an unbounded spare is the attempts-1-3 failure. (A row the sweep already settled inside the window keeps its HELD write; that is the bridge\'s existing honest-by-omission degrade, pinned end-to-end at (12d) of verify-arch-003-open-tool-calls.)',
    survivedFirst && b.spares(atFirstBoundary) === true
      && atSecondBoundary.join(',') === 'P' && b.spares(atSecondBoundary) === false
      && r.parentOf('L') === null,
    { atFirstBoundary, survivedFirst, atSecondBoundary, reclaimedAtSecond: r.parentOf('L') === null });
}

// ================== (7) THE RESIDUAL: WHICH CALL A *LANE* NAMED `P` IS, AFTER THE REUSE
{
  /*
   * PINNED RESIDUAL, AND A DELIBERATE DIRECTION. Once the main thread has re-used P, a
   * LANE that carries the id P resolves to the MAIN-THREAD generation — an empty chain —
   * because that is what the name means now. If that lane is really the EARLIER
   * subagent call, its death is recorded although its owner is live: ONE ROW, the
   * re-used id itself. No DESCENDANT is affected (descendants walk handles, not names),
   * which is the whole point of the handle redesign. The trade is one-directional on
   * purpose: a wrong answer toward (a) records a death that may be early, a wrong answer
   * toward (b) suppresses a real death forever.
   */
  const r = new OpenToolCalls();
  r.issuedByMainThread('R');
  r.issuedBySubagent('L', 'P');
  r.issuedByMainThread('P');
  r.issuedBySubagent('P', 'R');            // the delayed frame fills L's reservation
  const b = ROOT_LIVE();
  check('(7) PINNED RESIDUAL — A LANE NAMED P AFTER THE REUSE IS THE MAIN THREAD\'S: the name resolves to the main-thread generation (empty chain, death recorded), while the earlier call\'s ancestry survives for its DESCENDANTS by handle. If the lane really belonged to the earlier subagent call, that one row records a death its live owner would have spared — the ambiguity is irreducible (nothing distinguishes the two) and it is resolved toward recording, never toward suppressing',
    r.ownerChainOf('P').length === 0 && b.spares(r.ownerChainOf('P')) === false
      && r.ownerChainOf('L').join(',') === 'P,R' && b.spares(r.ownerChainOf('L')) === true,
    { laneNamedP: r.ownerChainOf('P'), laneNamedPSpared: b.spares(r.ownerChainOf('P')),
      descendantChain: r.ownerChainOf('L') });
}

// ============ (8) THE RESIDUAL: AN AGENT ROW WITH AN UNKNOWN ANCESTRY IS STILL RECORDED
{
  /*
   * PINNED RESIDUAL, NOT ELIMINATED, AND NOT FIXABLE FROM THIS TYPE. Inside the window
   * the chain reports an un-observed ancestor, which SPARES a `kind:'tool'` lane through
   * the bridge's re-attach degrade — but BUG-105 deliberately does NOT extend that
   * degrade to `kind:'agent'` rows ("absence of knowledge must not silence an agent
   * death"), so an AGENT row whose ancestry is not yet known still records its death at
   * that boundary. Closing it means changing `#chainHasLiveBackgroundAgent` in
   * agent-bridge.ts; this test pins today's behaviour so the next pass finds it named.
   */
  const r = new OpenToolCalls();
  r.issuedByMainThread('R');
  r.issuedBySubagent('L', 'P');
  r.issuedByMainThread('P');
  const b = ROOT_LIVE();
  const chain = r.ownerChainOf('L');
  check('(8) PINNED RESIDUAL — THE `kind:\'agent\'` HALF IS GUARDED, NOT ELIMINATED: inside the window an unknown ancestry spares a `kind:\'tool\'` lane (the re-attach degrade) but NOT a `kind:\'agent\'` row, whose death is still recorded — BUG-105 declines the degrade for agent rows on purpose, and that decision lives in agent-bridge.ts, outside this type',
    b.spares(chain) === true && b.sparesAgentRow(chain) === false,
    { chain, toolRowSpared: b.spares(chain), agentRowSpared: b.sparesAgentRow(chain) });
}

// =========================================== (9) AND IT DOES NOT LEAK
{
  /*
   * The bound, asserted rather than argued: 20,000 reservation windows, each with its
   * own reuse and its own delayed frame, leave nothing resident once the roots retire —
   * and the INDEXES (bindings, parked reservations, resolutions, ages) empty with them.
   * A structure with an unmeasured lifetime is this ticket's entire failure class.
   */
  const ROUNDS = 20_000;
  const r = new OpenToolCalls();
  const live = new Set(['R']);
  const pred = (_id, chain) => chain.length > 0 && chain.every((o) => !live.has(o) && o !== UNRESOLVED_ANCESTOR);
  r.issuedByMainThread('R');
  for (let i = 0; i < ROUNDS; i++) {
    r.issuedBySubagent('leaf_' + i, 'mid_' + i);   // reserves mid_i
    r.issuedByMainThread('mid_' + i);              // the main thread takes the name
    r.reap(pred);                                  // a boundary inside every window
    r.issuedBySubagent('mid_' + i, 'R');           // the delayed frame fills the reservation
    r.ended('leaf_' + i);
  }
  const whileRootLive = { resident: r.size, ...r.indexSizes() };
  live.clear();
  r.reap(pred); r.reap(pred);
  const afterRootRetired = { resident: r.size, ...r.indexSizes() };
  /*
   * THE NUMBER HERE IS A RESIDUAL, NAMED. Each window leaves ONE open record: after the
   * main thread has taken the name, the filled reservation can no longer be reached BY
   * NAME, so its own `tool_result` lands on the main-thread generation and the record
   * has no end signal left. It is the SAME residual the header already names for the
   * immortal owner (1,000 calls / 1,000 records) — bounded by one owner-liveness
   * generation, not by time: it is exactly the rounds while R is live and exactly ZERO
   * the moment R retires, which is what is asserted. The INDEXES do not add a term of
   * their own: they track the records and empty with them.
   */
  check(`(9) AND THE WINDOW DOES NOT LEAK BEYOND ITS OWNER: ${ROUNDS.toLocaleString()} reservation windows, each with a reuse, a boundary inside it and a delayed frame — while the root is live each window holds ONE record whose name the main thread took (${whileRootLive.resident}, the named residual, indexes tracking it 1:1), and the instant the root retires EVERY structure is empty (${JSON.stringify(afterRootRetired)})`,
    afterRootRetired.resident === 0 && afterRootRetired.bindings === 0
      && afterRootRetired.pending === 0 && afterRootRetired.resolved === 0 && afterRootRetired.aged === 0
      && whileRootLive.resident <= ROUNDS + 1 && whileRootLive.pending === 0
      && whileRootLive.bindings <= 4 && whileRootLive.resolved <= whileRootLive.resident + 3,
    { rounds: ROUNDS, whileRootLive, afterRootRetired });
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) console.log('failed: ' + failures.join(' | '));
process.exit(fail ? 1 : 0);
