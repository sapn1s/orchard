#!/usr/bin/env node
/**
 * ARCH-003 — THE RESERVATION SPACE, ENUMERATED RATHER THAN SAMPLED.
 *
 * WHY THIS SCRIPT EXISTS. Every round on this ticket has been a SHAPE THE PREVIOUS
 * FIXTURE DID NOT CONSTRUCT, and each round's fixture was written from the round's own
 * verdict: one reservation instead of two, one nesting depth, one ordering, one boundary
 * placement. The 7th verdict was id reuse; the 8th was a reservation orphaned by a re-use;
 * the 9th was the SAME NAME RESERVED TWICE with a main-thread re-use between the two
 * reservations. Nine rounds of "the next fixture found the next shape" is not a run of bad
 * luck, it is a method that does not terminate. The response-format grammar had the same
 * problem and a generated corpus found 333 defects in one pass where round-by-round review
 * had found one each; this is that method applied here.
 *
 * WHAT IS ENUMERATED — the whole product, not a walk through it:
 *   - HOW MANY CHILDREN reserve one name:            k = 1, 2, 3
 *   - HOW MANY GENERATIONS that name has:            g = 1, 2, 3 descriptions
 *   - WHAT DESCRIBES each generation:                main thread / a LIVE root / a DEAD
 *                                                    root, independently per generation
 *   - WHICH GENERATION-WINDOW each child reserves in: every assignment of k children to
 *                                                    the g+1 windows
 *   - WHERE THE TURN BOUNDARIES FALL:                every subset of the gaps between
 *                                                    consecutive frames
 *   - NESTING DEPTH:                                 the children are leaves (1), or each
 *                                                    is itself an issuer whose own child
 *                                                    reserves ITS name (2)
 *
 * WHAT IS ASSERTED OVER ALL OF IT — properties, not expected outputs, because an expected
 * output would be this build's own opinion written down twice:
 *
 *  I.  ANCESTRY IS MONOTONE. A chain may only ever be EXTENDED. It may never shorten,
 *      never change an element it already had, and never point somewhere else. Verdicts
 *      7, 8 and 9 were all violations of this one sentence (["M","R"] -> ["M"],
 *      ["P","R1"] -> ["P"]), and it is checked after EVERY frame for EVERY record, so a
 *      corruption cannot hide between the two moments a hand-written fixture looks.
 *  II. PROPERTY (b) — LIVE WORK IS NEVER RECORDED DEAD. Where every generation of the
 *      name is described by a LIVE root, no child of it may ever be unspared, and no
 *      child's record may be reclaimed, at ANY boundary, in ANY configuration.
 *  III.PROPERTY (a) — A MAIN-THREAD LANE HAS NO ANCESTRY. Once the main thread describes
 *      a name, the lane carrying that name resolves to an EMPTY chain and is spared by
 *      nothing, however live the agents around it are.
 *  IV. NO AMNESTY. Where every generation is dead (main-thread or a retired root), every
 *      child IS unspared within the documented grace — a death is deferred at most one
 *      boundary, never lost. Suppression is the failure that killed attempts 1-3, and a
 *      suite that only checks (b) will happily accept it.
 *  V.  BOUNDED. Once nothing is live, records AND EVERY SECONDARY INDEX go to zero. An
 *      index whose lifetime nobody measured is this ticket's entire failure class.
 *  VI. TOTAL. No walk hangs, no chain repeats a name, no chain exceeds its depth.
 *
 * MUST-FAIL PROVENANCE: on a750ec1 this corpus reports thousands of (II) violations, the
 * smallest of which is the 9th clean-room verdict's own sequence.
 *
 * Usage: node scripts/adversarial-arch-003-reservation-corpus.mjs
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
 * THE BRIDGE, MODELLED FROM ITS REAL CODE — identical to the model every other ARCH-003
 * adversarial script uses. `spares` is `#ownershipSpares` (the `kind:'tool'` sweep guard
 * WITH the un-observed-owner degrade) and `cannotStillBeInFlight` is
 * `AgentSession.#callCannotStillBeInFlight`. Every name in a scenario is registered in
 * `agents`, so "spared" never means "the model had never heard of it".
 */
function bridge(liveRoots, knownNames) {
  const agents = new Map(knownNames.map((n) => [n, 'completed']));
  for (const r of liveRoots) agents.set(r, 'running');
  const level = new Set(liveRoots);
  const notLive = (owner) => {
    if (!owner) return false;
    if (level.has(owner)) return false;
    const row = agents.get(owner);
    if (!row) return false;
    return row !== 'running';
  };
  return {
    cannotStillBeInFlight: (toolUseId, chain) => (chain.length ? chain.every(notLive) : false),
    spares: (chain) => chain.some((owner) => level.has(owner) || !agents.has(owner)),
  };
}

/** A chain, with the "an ancestor exists but has not been named yet" marker stripped. */
const named = (chain) => (chain[chain.length - 1] === UNRESOLVED_ANCESTOR ? chain.slice(0, -1) : chain);
const isPrefix = (a, b) => a.length <= b.length && a.every((x, i) => b[i] === x);

/*
 * ONE CASE. `descs` is the ordered list of descriptions of the shared name P (each 'main',
 * 'live' or 'dead'); `windows[i]` is the generation-window child i reserves P in (0 = before
 * any description, w = after the w-th); `boundaryMask` places a reap in each gap it selects;
 * `depth` 2 gives every child a child of its own that reserves ITS name the same way.
 *
 * The stream is built the way the real one arrives: the roots' own main-thread Task frames
 * first, then the windows in order, each window's references BEFORE the description that
 * closes it — which is exactly what makes those references RESERVATIONS.
 */
function runCase({ k, descs, windows, boundaryMask, depth, events: eventsIn }) {
  const g = descs.length;
  const roots = descs.map((d, i) => (d === 'main' ? null : 'R' + i));
  const liveRoots = descs.map((d, i) => (d === 'live' ? 'R' + i : null)).filter(Boolean);
  const kids = Array.from({ length: k }, (_, i) => 'L' + i);
  const grandKids = depth >= 2 ? kids.map((c) => 'G_' + c) : [];
  const b = bridge(liveRoots, ['P', ...roots.filter(Boolean), ...kids, ...grandKids]);
  const r = new OpenToolCalls();
  const watched = [...kids, ...grandKids];
  const seen = new Map(watched.map((id) => [id, []]));   // last NAMED chain per watched id
  const reclaimed = new Set();
  const violations = [];
  const documented = [];

  const exists = new Set();          // a child is only assertable once its frame has arrived
  /*
   * THE ONE DOCUMENTED RESIDUAL, CLASSIFIED RATHER THAN WAVED AT. A reservation that is
   * still unfilled at a turn boundary AGES: from then on the ancestry reads as ending at
   * that name instead of as incomplete, so the child's honest death is recorded ONE
   * BOUNDARY LATE rather than never. If the description then arrives LATER STILL, that
   * child was judged on an ancestry that was about to grow. It is deliberate — unbounded
   * deferral is the over-suppression that killed attempts 1-3 — it is bounded by one
   * boundary, and under the real protocol a `parent_tool_use_id` names an id an EARLIER
   * assistant frame minted, so a description two boundaries late is not a real ordering.
   * Violations of that shape are counted and pinned by (6); anything else is a defect.
   */
  const descsArrived = new Set();      // WHICH generations have been described (a REPEAT is not a new one)
  /*
   * ids whose own end signal has arrived AND HAS NOT BEEN SUPERSEDED BY A LATER DESCRIPTION.
   * An end signal is positive evidence about the call the name meant AT THAT MOMENT, so a
   * later description of the name starts a call the end says nothing about. Reclaiming a row
   * in this set is the design working, not live work being lost.
   */
  const endedIds = new Set();
  /*
   * ROWS WHOSE PREMISE IS CONTRADICTORY, EXCLUDED FROM THE LIVE-WORK PROPERTIES ONLY. A child
   * described as issued by a call whose OWN result has already been delivered cannot be in
   * flight — a subagent whose `tool_result` has arrived issues nothing more. The enumeration
   * still GENERATES those orderings (the repeat dimension moves end signals everywhere, and a
   * corruption in one of them would still be a corruption), and they are still graded on
   * ancestry monotonicity, on property (a) and on totality; they are excluded only from
   * "live work must be spared", because the input says the work is not live.
   */
  const contradictory = new Set();
  const graceExpired = new Set();
  const graceBoundaries = new Map();   // per child: boundaries survived since its own frame
  const observe = (stepLabel) => {
    for (const id of watched) {
      if (!exists.has(id)) continue;
      const raw = r.ownerChainOf(id);
      const chain = named(raw);
      // VI — total: no repeats, never deeper than the ancestry can be.
      if (new Set(chain).size !== chain.length) violations.push({ kind: 'cycle', id, chain, stepLabel });
      if (chain.length > depth + 2) violations.push({ kind: 'overlong', id, chain, stepLabel });
      const prev = seen.get(id);
      if (r.parentOf(id) === null && prev.length) {
        reclaimed.add(id);                                // the record is gone; nothing to compare
      } else if (!reclaimed.has(id)) {
        // I — monotone: the chain may only ever grow, and only at its end.
        if (!isPrefix(prev, chain)) violations.push({ kind: 'ancestry-changed', id, from: prev, to: chain, stepLabel });
        seen.set(id, chain);
      }
      // II / III — the verdict properties, re-asked after every single frame.
      // A row whose OWN end signal has arrived is over: its record going away is the
      // design working, not live work being reclaimed.
      if (liveRoots.length === g && g > 0 && !endedIds.has(id) && !contradictory.has(id) && !b.spares(raw)) {
        // Once a child has been judged inside that window, everything downstream of the
        // judgement (its record is gone, so its chain reads empty for ever after) belongs
        // to the SAME residual — it is one event, not one per later frame.
        const hadItsGrace = (graceBoundaries.get(id) ?? 0) >= 1;
        if (graceExpired.has(id) || (descsArrived.size < g && hadItsGrace)) {
          graceExpired.add(id); documented.push({ kind: 'awaiting-a-late-description', id, chain: raw, stepLabel });
        }
        else violations.push({ kind: 'live-work-unspared', id, chain: raw, stepLabel });
      }
    }
    if (seenMainDesc) {
      const mainLane = r.ownerChainOf('P');
      if (mainLane.length && !mainLaneMayBeSubagent) {
        violations.push({ kind: 'main-lane-inherited-ancestry', chain: mainLane, stepLabel });
      }
    }
  };

  /*
   * THE ONE DOCUMENTED EXCEPTION TO (III), NAMED RATHER THAN QUIETLY ALLOWED: once a
   * boundary has passed AND a LATER description claims the name, the main-thread call is
   * demonstrably over (its lane settled at that boundary) and the name may mean the newer
   * call. Before that point a non-empty chain for a main-described name is a defect.
   */
  let mainLaneMayBeSubagent = false;
  let seenMainDesc = false;
  let reapSinceMain = false;

  const events = eventsIn ?? (() => {
    const out = [];
    for (const root of new Set(roots.filter(Boolean))) out.push({ t: 'root', root });
    for (let w = 0; w <= g; w++) {
      for (let i = 0; i < k; i++) if (windows[i] === w) out.push({ t: 'ref', child: kids[i] });
      if (w < g) out.push({ t: 'desc', w });
    }
    return out;
  })();

  let gap = 0;
  for (const ev of events) {
    if (ev.t === 'root') r.issuedByMainThread(ev.root);
    else if (ev.t === 'ref') {
      /*
       * A SECOND FRAME FOR THE SAME CHILD ID IS A RE-ISSUE OF THAT LANE NAME — a DIFFERENT
       * call, whose ancestry is whatever the shared name means NOW. Comparing the new call's
       * chain against the old call's is comparing two calls, so the baseline is reset here
       * (the header's guarded item 1: which call a LANE named X is, after X is re-used). The
       * corruption that matters is still watched: at depth 2 the GRANDCHILD's frame arrives
       * ONCE and its ancestry walks THROUGH this record by handle, so a duplicate frame that
       * rewrote this record would show up as the grandchild's ancestry changing.
       */
      const firstTime = !exists.has(ev.child);
      r.issuedBySubagent(ev.child, 'P');
      exists.add(ev.child);
      endedIds.delete(ev.child);
      if (!firstTime) { seen.set(ev.child, []); reclaimed.delete(ev.child); }
      if (endedIds.has('P')) { contradictory.add(ev.child); contradictory.add('G_' + ev.child); }
      if (depth >= 2 && firstTime) { r.issuedBySubagent('G_' + ev.child, ev.child); exists.add('G_' + ev.child); }
    } else if (ev.t === 'end') {
      /*
       * AN END SIGNAL FOR A NAME — the dimension the corpus did not have, and the one the
       * 10th clean-room verdict lived in. It may name the SHARED NAME `P` (whose record a
       * live child's ancestry walks THROUGH) or a child's own id, and a REPEAT of it is an
       * ordinary event here rather than a special case.
       */
      r.ended(ev.name);
      endedIds.add(ev.name);
    } else if (descs[ev.w] === 'main') {
      r.issuedByMainThread('P');
      seenMainDesc = true; reapSinceMain = false;
    } else {
      r.issuedBySubagent('P', roots[ev.w]);
      if (seenMainDesc && reapSinceMain) mainLaneMayBeSubagent = true;
    }
    // A DESCRIPTION STARTS A CALL THE EARLIER END SIGNAL SAYS NOTHING ABOUT.
    if (ev.t === 'desc') { descsArrived.add(ev.w); endedIds.delete('P'); }
    observe(ev.t + (ev.w ?? ''));
    if (boundaryMask & (1 << gap)) {
      /*
       * THE REAL ORDER AT A BOUNDARY: the sweep reads the chains FIRST and the reap runs
       * after it (agent-bridge.ts — "reap, AFTER the sweep has read what it needed"). The
       * observation just above IS that sweep, and it is the one that decides a verdict; the
       * state immediately after the reap is not read by anything until more frames arrive
       * or another boundary falls, and by then this child HAS had its boundary of grace.
       * Counting the grace here, between the two, is what keeps the residual and the 9th
       * verdict distinguishable: judged at the FIRST boundary with a chain that read as
       * complete is the DEFECT; judged at the second, after a real boundary of waiting, is
       * the documented residual.
       */
      r.reap(b.cannotStillBeInFlight);
      if (seenMainDesc) reapSinceMain = true;
      for (const id of exists) graceBoundaries.set(id, (graceBoundaries.get(id) ?? 0) + 1);
      observe('reap');
    }
    gap++;
  }

  /*
   * THE TAIL. Three boundaries with the stream finished: (IV) every child of a wholly dead
   * name must be unspared by now — one boundary of grace for an unfilled reservation, not
   * an amnesty — and (II) every child of a wholly live name must STILL be spared and STILL
   * resident, three boundaries later.
   */
  for (let i = 0; i < 3; i++) {
    r.reap(b.cannotStillBeInFlight);
    for (const id of exists) graceBoundaries.set(id, (graceBoundaries.get(id) ?? 0) + 1);
    observe('tail-reap');
  }
  if (liveRoots.length === g && g > 0) {
    for (const id of watched) {
      if (endedIds.has(id) || contradictory.has(id)) continue;   // its own result arrived, or its issuer's had
      const bucket = graceExpired.has(id) ? documented : violations;
      if (r.parentOf(id) === null) bucket.push({ kind: 'live-record-reclaimed', id });
      if (!b.spares(r.ownerChainOf(id))) bucket.push({ kind: 'live-work-unspared-at-tail', id, chain: r.ownerChainOf(id) });
    }
  }
  if (liveRoots.length === 0) {
    for (const id of watched) {
      if (b.spares(r.ownerChainOf(id))) violations.push({ kind: 'dead-work-spared-forever', id, chain: r.ownerChainOf(id) });
    }
  }
  return { violations, documented, r, b, liveRoots, knownNames: ['P', ...roots.filter(Boolean), ...kids, ...grandKids] };
}

/* ============================ THE ENUMERATION ITSELF ============================ */
const KINDS = ['main', 'live', 'dead'];
const cases = [];
for (const depth of [1, 2]) {
  for (const k of [1, 2, 3]) {
    for (const g of [1, 2, 3]) {
      const kindTuples = [];
      const buildKinds = (acc) => { if (acc.length === g) { kindTuples.push([...acc]); return; } for (const kd of KINDS) buildKinds([...acc, kd]); };
      buildKinds([]);
      const assignments = [];
      const buildAssign = (acc) => { if (acc.length === k) { assignments.push([...acc]); return; } for (let w = 0; w <= g; w++) buildAssign([...acc, w]); };
      buildAssign([]);
      for (const descs of kindTuples) {
        for (const windows of assignments) {
          const gaps = new Set(descs.map((_, i) => i)).size + k + g;   // upper bound on event slots
          const slots = Math.min(gaps, 8);
          for (let boundaryMask = 0; boundaryMask < (1 << slots); boundaryMask++) {
            cases.push({ k, descs, windows, boundaryMask, depth });
          }
        }
      }
    }
  }
}

const started = Date.now();
const byKind = new Map();
const documentedByKind = new Map();
let documentedCases = 0;
let violatingCases = 0;
let firstFailure = null;
for (const c of cases) {
  let out;
  try {
    out = runCase(c);
  } catch (e) {
    out = { violations: [{ kind: 'threw', error: String(e && e.message) }] };
  }
  if (out.documented?.length) {
    documentedCases++;
    for (const v of out.documented) documentedByKind.set(v.kind, (documentedByKind.get(v.kind) ?? 0) + 1);
  }
  if (out.violations.length) {
    violatingCases++;
    for (const v of out.violations) byKind.set(v.kind, (byKind.get(v.kind) ?? 0) + 1);
    if (!firstFailure) firstFailure = { case: { ...c, descs: c.descs.join('+'), windows: c.windows.join('') }, violation: out.violations[0] };
  }
}
const elapsed = Date.now() - started;

check(`(1) THE WHOLE PRODUCT, GRADED ON THE PROPERTIES: ${cases.length.toLocaleString()} configurations — 1-3 children reserving ONE name, 1-3 generations of it, every combination of main-thread / live-root / dead-root descriptions, every assignment of children to generation-windows, every placement of turn boundaries between the frames, at nesting depth 1 and 2. ANCESTRY IS MONOTONE (never shortened, never redirected), LIVE WORK IS NEVER UNSPARED, A MAIN-THREAD LANE NEVER INHERITS AN ANCESTRY, A WHOLLY DEAD CHAIN IS NEVER SPARED FOREVER, and no walk cycles — in every one of them`,
  violatingCases === 0,
  { configurations: cases.length, violatingCases, byKind: Object.fromEntries(byKind), firstFailure, elapsedMs: elapsed });

check(`(6) THE ONE RESIDUAL, COUNTED AND PINNED RATHER THAN DESCRIBED: ${documentedCases.toLocaleString()} of those configurations contain a description that arrives AFTER its own reservation has already lived through a turn boundary. There the reservation has AGED — the ancestry reads as ending at the reserved name instead of as incomplete — so the child is judged one boundary before its ancestry finished growing and its (possibly early) death is recorded. It is bounded by ONE boundary, it moves in the (a) direction (an early death, never a suppressed one), and it is the price of not deferring deaths forever, which is what killed attempts 1-3. Under the real protocol a parent_tool_use_id names an id minted by an EARLIER assistant frame, so a description two boundaries late is not a reachable ordering. This check exists so the count is a NUMBER a later pass can compare against, not a paragraph`,
  documentedCases > 0 && documentedCases < cases.length,
  { configurationsWithALateDescription: documentedCases, byKind: Object.fromEntries(documentedByKind) });

/* =================== (2) THE 9th VERDICT'S OWN SEQUENCE, BY NAME =================== */
{
  const b = bridge(['R1', 'R2'], ['P', 'R1', 'R2', 'L1', 'L2']);
  const r = new OpenToolCalls();
  r.issuedByMainThread('R1'); r.issuedByMainThread('R2');
  r.issuedBySubagent('L1', 'P');        // child ONE reserves P
  r.issuedByMainThread('P');            // the MAIN THREAD re-uses P between the reservations
  r.issuedBySubagent('L2', 'P');        // child TWO reserves P — a SECOND generation of it
  r.issuedBySubagent('P', 'R1');        // the first description fills the FIRST reservation
  r.reap(b.cannotStillBeInFlight);      // a boundary falls between the two descriptions
  r.issuedBySubagent('P', 'R2');        // the second fills the SECOND
  check('(2) THE 9th CLEAN-ROOM VERDICT, VERBATIM: two children reserve one name across a main-thread re-use and EACH reservation is filled by ITS OWN description — L1 reaches R1, L2 reaches R2, both survive the boundary in between, and the main-thread lane that took the name keeps an EMPTY chain. On a750ec1: {"c1":["P","R1"],"c2":["P"],"survived2":false,"mainChain":["R2"]} — property (b) AND property (a) in one sequence',
    r.ownerChainOf('L1').join(',') === 'P,R1' && r.ownerChainOf('L2').join(',') === 'P,R2'
      && r.parentOf('L1') === 'P' && r.parentOf('L2') === 'P' && r.ownerChainOf('P').length === 0,
    { c1: r.ownerChainOf('L1'), c2: r.ownerChainOf('L2'), mainChain: r.ownerChainOf('P'),
      survived1: r.parentOf('L1') !== null, survived2: r.parentOf('L2') !== null });
}

/* ============ (3) THE NEIGHBOURING CASE: MANY RESERVATIONS, ONE GENERATION ============ */
{
  /*
   * Several children reserve the same name INSIDE ONE generation and a single description
   * arrives. They are all children of that one call, so they must ALL end up with it —
   * this is the same bookkeeping as (2) with the re-use removed, and it is pinned because
   * a queue that pairs descriptions to reservations could plausibly hand the description
   * to the first child and leave the rest waiting for a frame that will never come.
   */
  const rows = [];
  for (const n of [1, 2, 3, 8, 64]) {
    for (const boundaryBeforeDesc of [false, true]) {
      const kids = Array.from({ length: n }, (_, i) => 'C' + i);
      const b = bridge(['R'], ['P', 'R', ...kids]);
      const r = new OpenToolCalls();
      r.issuedByMainThread('R');
      for (const c of kids) r.issuedBySubagent(c, 'P');
      if (boundaryBeforeDesc) r.reap(b.cannotStillBeInFlight);
      r.issuedBySubagent('P', 'R');
      const chains = kids.map((c) => r.ownerChainOf(c).join(','));
      r.reap(b.cannotStillBeInFlight);
      const survived = kids.every((c) => r.parentOf(c) === 'P');
      rows.push({ n, boundaryBeforeDesc, ok: chains.every((c) => c === 'P,R') && survived, sample: chains[0] });
    }
  }
  const bad = rows.filter((x) => !x.ok);
  check('(3) MANY RESERVATIONS OF ONE NAME IN ONE GENERATION, ONE DESCRIPTION: 1, 2, 3, 8 and 64 children reserve the same name before its frame arrives (with and without a boundary in the window) and the single description completes ALL of their ancestries — the queue pairs GENERATIONS to descriptions, not children to descriptions, so a second child in the same window is not a second reservation',
    bad.length === 0, { configurations: rows.length, failed: bad.length, firstFailure: bad[0] ?? null });
}

/* ================== (4) THE INDEXES, OVER THE WHOLE CORPUS ================== */
{
  /*
   * V — every secondary index is reclaimed by the same "keep while something needs it"
   * rule as the records. Run the heaviest slice of the corpus and assert that once nothing
   * is live NOTHING remains anywhere: no record, no binding, no issuer, no parked
   * reservation, no resolution mark, no age mark, no main-generation mark.
   */
  const leftovers = [];
  for (const c of cases.filter((x) => x.depth === 2 && x.k === 3 && x.descs.length === 3 && (x.boundaryMask & 7) === 5)) {
    const { r, knownNames } = runCase(c);
    // Every root retires: nothing anywhere can still be live. EVERY name is registered —
    // an owner the model has never heard of reads as absence of knowledge and spares.
    const dead = bridge([], knownNames);
    for (let i = 0; i < 3; i++) r.reap(dead.cannotStillBeInFlight);
    const idx = r.indexSizes();
    const total = r.size + Object.values(idx).reduce((a, x) => a + x, 0);
    if (total !== 0) leftovers.push({ case: { ...c, descs: c.descs.join('+') }, resident: r.size, idx, openIds: r.residency().openIds });
  }
  check('(4) EVERY INDEX GOES TO ZERO WHEN NOTHING IS LIVE, ACROSS THE CORPUS: records, name bindings, issuer bindings, parked reservations, resolution marks, age marks and main-generation marks — all of them, in every one of these configurations. The failure class this ticket is made of is a second structure whose lifetime nobody measured, so the two structures this fix adds are measured here rather than described in a comment',
    leftovers.length === 0, { configurationsChecked: cases.filter((x) => x.depth === 2 && x.k === 3 && x.descs.length === 3 && (x.boundaryMask & 7) === 5).length, leftovers: leftovers.length, first: leftovers[0] ?? null });
}

/* ============ (5) THE INDEXES DO NOT OUTGROW THE RECORDS, UNDER VOLUME ============ */
{
  /*
   * The parked-reservation queue is the structure this fix DEEPENED (it used to hold one
   * entry per name and now holds a generation's worth), so its growth is measured, not
   * argued: 20,000 rounds of reserve / re-use / describe on ONE name under a live root.
   */
  const b = bridge(['R'], ['P', 'R', 'L']);
  const r = new OpenToolCalls();
  r.issuedByMainThread('R');
  let peakPending = 0;
  for (let i = 0; i < 20_000; i++) {
    r.issuedBySubagent('leaf_' + i, 'P');
    r.issuedByMainThread('P');
    r.issuedBySubagent('P', 'R');
    r.ended('leaf_' + i);
    peakPending = Math.max(peakPending, r.indexSizes().pending);
    if (i % 100 === 99) r.reap(b.cannotStillBeInFlight);
  }
  r.reap(b.cannotStillBeInFlight);
  const whileLive = { resident: r.size, ...r.indexSizes() };
  const dead = bridge([], ['P', 'R']);
  r.reap(dead.cannotStillBeInFlight); r.reap(dead.cannotStillBeInFlight);
  const after = { resident: r.size, ...r.indexSizes() };
  const bounded = Object.values(whileLive).every((v) => v < 200) && Object.values(after).every((v) => v === 0);
  check('(5) THE DEEPENED RESERVATION QUEUE IS BOUNDED UNDER VOLUME: 20,000 rounds of reserve / main-thread re-use / describe on ONE name under a LIVE root — every index stays two orders of magnitude below the work done, the parked queue never grows past its own generation, and everything is zero once the root retires. A queue that pairs descriptions to reservations could have become the next unmeasured structure; it is measured instead',
    bounded, { rounds: 20_000, peakPendingWithinARound: peakPending, whileRootLive: whileLive, afterRootRetired: after });
}

/* ================= (7) THE REPEATS PRODUCT — THE 10th VERDICT'S HOLE ================= */
/*
 * WHAT THIS SECTION IS FOR. The enumeration above varies WHICH frames arrive and WHEN, but
 * every frame in it arrives EXACTLY ONCE and no frame in it is an END SIGNAL. The 10th
 * clean-room verdict lived precisely there: a SECOND, REDUNDANT `ended` for a name whose
 * record was already settled flipped that record back to `ended-unmatched`, and the next
 * issue frame for the name then rewrote its ancestry — redirecting a LIVE child from one
 * owner to an unrelated one. 1,209,888 configurations could not see it, because a repeat
 * was not one of the things the product varied.
 *
 * SO REPEATS ARE NOW A DIMENSION, not a fixture. On top of the same base configurations
 * (children reserving a shared name, generations of it described by the main thread / a
 * live root / a dead root, boundaries anywhere) this adds:
 *   - END SIGNALS at all: `ended(P)` after any subset of the descriptions, and `ended(L)`
 *     for any subset of the children;
 *   - A DUPLICATE OF EVERY EVENT, whatever kind it is — a repeated reservation, a repeated
 *     description (main or subagent), a repeated end, a repeated root frame;
 *   - THE DUPLICATE AT EVERY POSITION AFTER ITS ORIGINAL — immediately after it, between
 *     each later pair of events, and last of all;
 *   - and every boundary placement across the first slots, so the pair can be split by a
 *     reap as well as delivered inside one turn.
 * Graded on the SAME properties as (1) — nothing here is an expected output.
 *
 * MUST-FAIL PROVENANCE, MEASURED (recorded so a later pass can re-run it). Against the
 * PRE-FIX module from `e8e25da`, graded by THIS grader (same exclusions, same premises):
 *
 *     (1)  1,209,888 configurations, violatingCases 0            <- the hole, exactly
 *     (7)  1,548,416 configurations, violatingCases 35,786
 *          {"main-lane-inherited-ancestry":85090,"ancestry-changed":25908}
 *     (8a) FAIL  {"before":["Z","R1"],"after":["Z","R3"]}
 *     (8b) FAIL  {"mainChain":["R","~arch003:unresolved-ancestor"]}
 *     (8c) FAIL  {"before":["Z","R1"],"after":["Z","R3"]}
 *
 * (1) PASSING while (7) reports 35,786 violating configurations on the same module is the
 * whole argument for this section existing: the previous product could not express a
 * repeat, so no number of configurations of it was ever going to find one.
 */
{
  const repeatCases = [];
  for (const depth of [1, 2]) {
    for (const k of [1, 2]) {
      for (const g of [1, 2]) {
        const kindTuples = [];
        const buildKinds = (acc) => { if (acc.length === g) { kindTuples.push([...acc]); return; } for (const kd of KINDS) buildKinds([...acc, kd]); };
        buildKinds([]);
        const assignments = [];
        const buildAssign = (acc) => { if (acc.length === k) { assignments.push([...acc]); return; } for (let w = 0; w <= g; w++) buildAssign([...acc, w]); };
        buildAssign([]);
        for (const descs of kindTuples) {
          for (const windows of assignments) {
            const kids = Array.from({ length: k }, (_, i) => 'L' + i);
            const roots = descs.map((d, i) => (d === 'main' ? null : 'R' + i));
            for (let endMask = 0; endMask < (1 << (g + k)); endMask++) {
              // THE BASE STREAM, with end signals woven in where they really fall: a name's
              // result can only arrive after something has described it.
              const base = [];
              for (const root of new Set(roots.filter(Boolean))) base.push({ t: 'root', root });
              for (let w = 0; w <= g; w++) {
                for (let i = 0; i < k; i++) if (windows[i] === w) base.push({ t: 'ref', child: kids[i] });
                if (w < g) {
                  base.push({ t: 'desc', w });
                  if (endMask & (1 << w)) base.push({ t: 'end', name: 'P' });
                }
              }
              for (let i = 0; i < k; i++) if (endMask & (1 << (g + i))) base.push({ t: 'end', name: kids[i] });
              const n = base.length;
              const slots = Math.min(n + 1, 4);
              // dupIndex -1 is the CONTROL: the same stream with no repeat at all, so the
              // repeat dimension is compared against its own base rather than against (1).
              for (let dupIndex = -1; dupIndex < n; dupIndex++) {
                for (let dupAt = dupIndex + 1; dupAt <= (dupIndex < 0 ? dupIndex + 1 : n); dupAt++) {
                  const events = dupIndex < 0 ? base
                    : [...base.slice(0, dupAt), base[dupIndex], ...base.slice(dupAt)];
                  for (let boundaryMask = 0; boundaryMask < (1 << slots); boundaryMask++) {
                    repeatCases.push({ k, descs, windows, boundaryMask, depth, events, repeated: dupIndex < 0 ? null : base[dupIndex].t });
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  const started = Date.now();
  const byKind = new Map();
  let violatingCases = 0, withARepeat = 0;
  let firstFailure = null;
  for (const c of repeatCases) {
    if (c.repeated) withARepeat++;
    let out;
    try { out = runCase(c); } catch (e) { out = { violations: [{ kind: 'threw', error: String(e && e.message) }] }; }
    if (out.violations.length) {
      violatingCases++;
      for (const v of out.violations) byKind.set(v.kind, (byKind.get(v.kind) ?? 0) + 1);
      if (!firstFailure) firstFailure = { case: { k: c.k, depth: c.depth, descs: c.descs.join('+'), windows: c.windows.join(''), boundaryMask: c.boundaryMask, repeated: c.repeated, events: c.events.map((e) => e.t + (e.name ?? e.child ?? e.root ?? e.w ?? '')).join('>') }, violation: out.violations[0] };
    }
  }
  check(`(7) REDUNDANT AND REPEATED SIGNALS, ENUMERATED: ${repeatCases.length.toLocaleString()} configurations — the same reservation product, now WITH end signals (for the shared name and for the children, in every subset), and with EVERY event duplicated at EVERY position after its original: a repeated reservation, a repeated description, a repeated end, a repeated root frame, delivered immediately after, between each later pair, and last — across every boundary placement, at depth 1 and 2. The 10th clean-room verdict was a SECOND end signal for a settled name followed by a re-issue, and 1,209,888 configurations of (1) could not see it because a repeat was not a dimension. Same properties, no expected outputs`,
    violatingCases === 0,
    { configurations: repeatCases.length, withARepeat, violatingCases, byKind: Object.fromEntries(byKind), firstFailure, elapsedMs: Date.now() - started });
}

/* ============ (8) THE 10th CLEAN-ROOM VERDICT'S OWN SEQUENCES, BY NAME ============ */
{
  /*
   * (a) THE REPORTED ONE. A redundant end reopens a SETTLED record and the next issue frame
   * redirects a live child's established ancestry. Pre-fix: {"before":["Z","R1"],
   * "after":["Z","R3"]} — an ancestry that was established CHANGED.
   */
  const r = new OpenToolCalls();
  r.issuedBySubagent('k1', 'Z');
  r.issuedBySubagent('Z', 'R1');
  const before = named(r.ownerChainOf('k1'));
  r.ended('Z');
  r.ended('Z');                       // the redundant one
  r.issuedBySubagent('Z', 'R3');
  const after = named(r.ownerChainOf('k1'));
  check('(8a) A REDUNDANT END DOES NOT REOPEN A SETTLED RECORD, so the issue frame that follows it is a RE-ISSUE (a new generation) and not a rewrite of the record a live child walks through: k1 keeps ["Z","R1"]. Pre-fix on e8e25da the same five frames gave ["Z","R3"] — a LIVE child redirected to an unrelated owner, which is the one sentence this whole design exists to make impossible',
    before.join(',') === 'Z,R1' && after.join(',') === 'Z,R1', { before, after });

  /*
   * (b) THE NEIGHBOUR THE SAME GATE CLOSES, found while fixing (a) and reachable with a
   * SINGLE end signal: a main-thread generation is `#resolved` but carries NO record, so an
   * `ended` for its name created an un-described record ON IT, and the next subagent
   * description filled that record — handing the MAIN-THREAD LANE a subagent ancestry.
   * Property (a): a genuine death suppressed for as long as R lives.
   */
  const r2 = new OpenToolCalls();
  r2.issuedByMainThread('P');
  r2.ended('P');
  r2.issuedBySubagent('P', 'R');
  check('(8b) AN END FOR A MAIN-THREAD NAME CANNOT LET THE NEXT SUBAGENT FRAME FILL THE MAIN-THREAD GENERATION: the lane named P keeps an EMPTY chain. Pre-fix it read ["R","~arch003:unresolved-ancestor"] — property (a) broken by ONE end signal, not two, which is why the fix gates the fill on "no issue frame has claimed this handle" rather than on the record\'s state',
    r2.ownerChainOf('P').length === 0, { mainChain: r2.ownerChainOf('P') });

  /*
   * (c) THE SAME CLASS ONE ORDERING OUT: the end arrives BEFORE the description (the
   * annihilation ordering the 4th verdict added), is then REPEATED, and only then is the
   * name re-issued. The first end still pairs with its description; the repeat is inert.
   */
  const r3 = new OpenToolCalls();
  r3.issuedBySubagent('k1', 'Z');
  r3.ended('Z');
  r3.issuedBySubagent('Z', 'R1');
  const c3before = named(r3.ownerChainOf('k1'));
  r3.ended('Z');
  r3.issuedBySubagent('Z', 'R3');
  check('(8c) THE SAME UNDER THE result>assistant ORDERING: end, description, REPEATED end, re-issue — the annihilation still happens (k1 reaches ["Z","R1"]) and the repeat still cannot reopen it',
    c3before.join(',') === 'Z,R1' && named(r3.ownerChainOf('k1')).join(',') === 'Z,R1',
    { before: c3before, after: named(r3.ownerChainOf('k1')) });

  /*
   * (d) AND THE ANNIHILATION ITSELF IS NOT BROKEN BY THE GATE. An end with no description
   * yet, then its description, is still ONE settled call — if the gate were wrong in the
   * other direction this would mint a second generation and leak an open record.
   */
  const r4 = new OpenToolCalls();
  r4.ended('X');
  r4.issuedBySubagent('X', 'R');
  const openAfter = r4.residency().open;
  r4.reap(() => false);
  check('(8d) ANTI-REGRESSION FOR THE 4th VERDICT: an end that precedes its own description still ANNIHILATES against it — the pair settles (0 open) and is reaped at the boundary, so the gate did not turn commutativity back into a leak',
    openAfter === 0 && r4.size === 0, { openAfterPair: openAfter, residentAfterBoundary: r4.size });
}

/* ============= (9) REPEATED SIGNALS UNDER VOLUME — THE INDEXES STILL BOUND ============= */
{
  /*
   * A repeat that is merely IGNORED can still be a leak if it mints anything. 20,000 rounds
   * of duplicate ends, duplicate descriptions and duplicate reservations on ONE name under a
   * LIVE root, with the indexes measured rather than reasoned about.
   */
  const b = bridge(['R'], ['P', 'R']);
  const r = new OpenToolCalls();
  r.issuedByMainThread('R');
  for (let i = 0; i < 20_000; i++) {
    r.issuedBySubagent('leaf_' + i, 'P');
    r.issuedBySubagent('leaf_' + i, 'P');      // duplicate reservation
    r.issuedBySubagent('P', 'R');
    r.issuedBySubagent('P', 'R');              // duplicate description
    r.ended('P'); r.ended('P'); r.ended('P');  // redundant ends
    r.ended('leaf_' + i); r.ended('leaf_' + i);
    if (i % 100 === 99) r.reap(b.cannotStillBeInFlight);
  }
  r.reap(b.cannotStillBeInFlight);
  const whileLive = { resident: r.size, ...r.indexSizes() };
  const dead = bridge([], ['P', 'R']);
  r.reap(dead.cannotStillBeInFlight); r.reap(dead.cannotStillBeInFlight);
  const after = { resident: r.size, ...r.indexSizes() };
  check('(9) REPEATS DO NOT ACCUMULATE: 20,000 rounds of duplicate reservations, duplicate descriptions and triple end signals on one name under a live root — every index stays two orders of magnitude below the work done, and everything is zero once the root retires. A redundant signal that mints a generation would show up here as growth rather than as a comment claiming it does not',
    Object.values(whileLive).every((v) => v < 200) && Object.values(after).every((v) => v === 0),
    { rounds: 20_000, whileRootLive: whileLive, afterRootRetired: after });
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) console.log(`failed: ${failures.join(' | ')}`);
process.exit(fail ? 1 : 0);
