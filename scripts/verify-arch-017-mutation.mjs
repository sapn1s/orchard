#!/usr/bin/env node
/**
 * ARCH-017 step 2 — THE STANDING ANTI-VACUITY CHECK.
 *
 * A suite that stays green when you DELETE the property it claims to test is
 * decoration. This ran as a one-off in an independent verify and found exactly
 * that: with the possession comparison replaced by `if (false)`, the drain
 * suite still returned 13 PASS / 0 FAIL, and E5 printed the forgery being
 * accepted while reporting PASS. Step 1 lost five rounds to this same class, so
 * the technique is promoted from "something a reviewer did once" to something
 * the build runs.
 *
 * HOW IT WORKS. For each mutant: export the repo's sources into a fresh /tmp
 * sandbox (node_modules symlinked — the repo is NEVER modified), apply a
 * textual mutation that REMOVES one named property, run the drain suite in its
 * DEFAULT mode, and require the suite to go RED. A mutant that survives is a
 * property nothing asserts.
 *
 * The default mode matters: `--must-fail-proof` is optional and nobody runs it
 * by reflex, so a property guarded only there is a property whose green run is
 * not evidence. Pass `--must-fail-proof` here to grade that mode instead.
 *
 * Exit 0 only if EVERY mutant is killed.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GRADE_MUST_FAIL = process.argv.includes('--must-fail-proof');
const DRAIN = 'scripts/verify-arch-017-drain.mjs';
const LEDGER = 'scripts/verify-lane-ledger.mjs';
/*
 * ROUND 3 — THE SET NOW REACHES THE UI AND API PATHS.
 *
 * An independent verifier pointed out that this check only ever mutated
 * `lane-drain.ts` and `lanes.ts`, which are the two files the drain suite
 * loads. Three of round 2's five fixes live in `src/server/index.ts` and
 * `public/app.js`, and the verifier's own mutants scored 3 killed / 5 SURVIVED
 * against them: the 503 guard, the CAP/+N more logic, the composer append and
 * the warn row could each be deleted with every suite still green. "0 survived"
 * was a true statement about two files and a false impression about a feature.
 * `verify-arch-017-rail.mjs` (real server + real browser) is what those mutants
 * are graded against now.
 */
const RAIL = 'scripts/verify-arch-017-rail.mjs';
/*
 * ROUND 6 — THE STANDING VACUITY SCANNER IS ALSO A GRADER.
 *
 * It is a SOURCE check, so the property "an assertion that passes on empty
 * input is caught" can be mutated like any other: delete a cardinality guard
 * from a suite and the scanner must refuse. Without this, the scanner is the
 * one check in the set that nothing checks — and round 6 found it had been
 * reporting a clean sweep over three blind spots.
 */
const VACUITY = 'scripts/verify-arch-017-vacuity.mjs';
/*
 * A mutant is graded against the suite that OWNS the property. Grading a
 * `lanes.ts` boot-reconciliation property against the drain suite would report
 * a survivor that is really just a mis-filed question — and, worse, could hide
 * a genuine one in the noise. M8 was filed here against the drain suite first,
 * reported SURVIVED, and turned out to survive the ledger suite too.
 */

/**
 * Each mutant names the PROPERTY it removes, not the line it edits — the point
 * is "is this property asserted anywhere", and the edit is just how we ask.
 */
const MUTANTS = [
  {
    id: 'M1', property: 'the possession proof is COMPARED, not merely shaped',
    suite: DRAIN, file: 'src/server/lane-drain.ts',
    edits: [
      /*
       * RE-POINTED (round 6). The comparison moved to `lanes.receiptMatches`
       * when the broker's duplicate hashing was folded into the store, so the
       * old literal stopped matching and this mutant silently scored as a
       * survivor. Same question, new line.
       */
      ['    if (!lanes.receiptMatches(want, got) || !Number.isFinite(receipt.bytes) || receipt.bytes !== rec.handoffBytes) {', '    if (false) {'],
      /* RE-POINTED (round 7): the empty-channel fix changed `!wantChannel` to
       * `wantChannel == null` (an empty channel is now a legal declared value),
       * so the old anchor stopped matching and M1 was silently an ANCHOR-MISSING
       * error — the exact "mutant stopped asking its question" class round 6 hit. */
      ['    if (!want || !wantNonce || wantChannel == null) {', '    if (false) {'],
    ],
  },
  {
    id: 'M2', property: 'HAZARD 2 — an OPEN group never drains',
    suite: DRAIN, file: 'src/server/lane-drain.ts',
    edits: [["  if (g.open) return { terminal: false,", "  if (false && g.open) return { terminal: false,"]],
  },
  {
    id: 'M3', property: 'HAZARD 3 — a forgotten group is closed by its deadline',
    suite: DRAIN, file: 'src/server/lane-drain.ts',
    edits: [['    if (deadline > now) continue;', '    if (true) continue;']],
  },
  {
    id: 'M4', property: 'HAZARD 4 — a starved held result is released on its own',
    suite: DRAIN, file: 'src/server/lane-drain.ts',
    /* RE-POINTED (round 9): readiness gained a persisted-release arm.
     * RE-POINTED (round 10): readiness is now the stamp ALONE (`= r.starvationReleasedAt != null;`). */
    edits: [['      const starved = r.starvationReleasedAt != null;', '      const starved = false;']],
  },
  {
    id: 'M5', property: 'an in-flight group does NOT collapse to one item',
    suite: DRAIN, file: 'src/server/lane-drain.ts',
    edits: [['    const complete = !open && outstanding === 0;', '    const complete = true;']],
  },
  {
    id: 'M6', property: 'a re-drained lane can still be acknowledged (the stranding bug)',
    suite: DRAIN, file: 'src/server/lane-drain.ts',
    /* RE-POINTED (round 6): the fixpoint renamed `bytes` to `trialBytes`.
     * RE-POINTED (round 9): restampHandoff gained a generation argument. */
    edits: [['      lanes.restampHandoff(l.id, trialBytes, evidence, genById.get(l.id));', '      lanes.markHandoff(l.id, trialBytes, evidence);']],
  },
  {
    id: 'M7', property: 'a declared member that never spawns is CUT when its group closes',
    suite: DRAIN, file: 'src/server/lanes.ts',
    edits: [["    if (r.state === 'pending') {\n      r.state = 'cut';\n      r.settledAt = now;\n      r.failureKind = 'never-spawned';\n      r.heldReason = `the group was closed", "    if (false && r.state === 'pending') {\n      r.state = 'cut';\n      r.settledAt = now;\n      r.failureKind = 'never-spawned';\n      r.heldReason = `the group was closed"]],
  },
  {
    id: 'M8', property: 'adoption requires the argv TOKEN, not just a live pid',
    suite: LEDGER, file: 'src/server/lanes.ts',
    edits: [["    if (status === 'alive') {", "    if (status === 'alive' || status === 'pid-reused') {"]],
  },
  {
    id: 'M9', property: 'an acknowledged record stops saying why it is held',
    suite: LEDGER, file: 'src/server/lanes.ts',
    edits: [['  rec.heldReason = null;\n  writeAll(all);\n  return rec;\n}\n\nexport interface LaneQuery', '  writeAll(all);\n  return rec;\n}\n\nexport interface LaneQuery']],
  },
  {
    id: 'M10', property: 'the 503 guard — a drain that handed over NOTHING is refused',
    suite: RAIL, file: 'src/server/index.ts',
    edits: [['      if (bundle.skipped.length && !bundle.lanes.length) {', '      if (false) {']],
  },
  {
    id: 'M11', property: 'no rail row is unreachable (the CAP and the +N more toggle)',
    suite: RAIL, file: 'public/app.js',
    edits: [
      ['  const CAP = 12;', '  const CAP = 1;'],
      ['  if (overflow > 0 || state.showAllPending) {', '  if (false) {'],
    ],
  },
  {
    id: 'M12', property: 'the collected bundle APPENDS to the composer (never eats the draft)',
    suite: RAIL, file: 'public/app.js',
    /* RE-POINTED (round 6): the composer write now reads the prior draft into
     * a `before` local first (so it can be read BACK afterwards), and the
     * line lost two spaces of indent. */
    edits: [["  box.value = `${before ? `${before.replace(/\\s+$/, '')}\\n\\n` : ''}${header}\\n${r.bundle}\\n`;", "  box.value = `${header}\\n${r.bundle}\\n`;"]],
  },
  {
    id: 'M13', property: 'a failed drain is NAMED at the user (the warn row)',
    suite: RAIL, file: 'public/app.js',
    edits: [['    state.pendingActionProblem = `could not collect: ${err.message}`;', '    state.pendingActionProblem = null;']],
  },
  {
    id: 'M14', property: 'the warn row WRAPS — the recovery path is readable without hovering',
    suite: RAIL, file: 'public/styles.css',
    edits: [['.rail-sub .brow.problem .bt {\n  white-space: normal;', '.rail-sub .brow.problem .bt {\n  white-space: nowrap;']],
  },
  {
    id: 'M15', property: 'restampHandoff clears the now-stale heldReason',
    suite: DRAIN, file: 'src/server/lanes.ts',
    edits: [['  // The old reason names an expected digest that is no longer expected.\n  clearHeldReason(rec);\n  writeAll(all);', '  writeAll(all);']],
  },
  {
    id: 'M16', property: 'dismiss() clears heldReason — a dismissed record is not held',
    suite: DRAIN, file: 'src/server/lanes.ts',
    edits: [['    // `dismissedAt` makes isHeld() false, so "why it is held" stops being true.\n    clearHeldReason(r);\n    n++;', '    n++;']],
  },
  {
    /*
     * The one mutant that ADDS a line. The property here is a deliberate
     * ABSENCE — `markHandoff` must NOT clear `heldReason`, because a handoff
     * grants nothing and the record is still held — and round 2 broke it by
     * "tidying" exactly this line in. A mutation set that can only delete could
     * never have caught that, and D4 stayed red for a whole round.
     */
    id: 'M18', property: 'markHandoff LEAVES heldReason standing (a handed-off lane is still held, and still says why)',
    suite: DRAIN, file: 'src/server/lanes.ts',
    /* RE-POINTED (round 9): markHandoff gained a durable-seal line between the
     * evidence write and the heldReason comment. */
    edits: [['  // fact outlives this row being pruned and the groupId being reused.\n  sealGroupDurably(rec.groupId, \'drained\', `that group has already been drained (lane ${rec.id} was handed over)`, rec.handoffAt);\n  /* heldReason is DELIBERATELY untouched here', '  // fact outlives this row being pruned and the groupId being reused.\n  sealGroupDurably(rec.groupId, \'drained\', `that group has already been drained (lane ${rec.id} was handed over)`, rec.handoffAt);\n  clearHeldReason(rec);\n  /* heldReason is DELIBERATELY untouched here']],
  },
  {
    /*
     * ROUND 3 — re-filed from LEDGER to DRAIN, and it stopped surviving.
     * This edit is in `lane-drain.ts`, which the ledger suite does not load;
     * graded there it reported `RESULT 63 PASS / 0 FAIL` and SURVIVED. It was
     * a real survivor either way — the count arm was asserted only in the drain
     * suite's OPTIONAL `--must-fail-proof` leg 2 — and `R4` now covers it in
     * the default run.
     */
    id: 'M17', property: 'the receipt BYTE COUNT is checked, not only the digest',
    suite: DRAIN, file: 'src/server/lane-drain.ts',
    /* RE-POINTED (round 6): same line as M1, but M17 keeps the DIGEST check
     * and drops only the byte count, so the two mutants stay distinct. */
    edits: [['    if (!lanes.receiptMatches(want, got) || !Number.isFinite(receipt.bytes) || receipt.bytes !== rec.handoffBytes) {', '    if (!lanes.receiptMatches(want, got)) {']],
  },
  /*
   * V1-V6 — THE INDEPENDENT VERIFIER'S OWN MUTANTS, ADOPTED WHOLESALE.
   *
   * They scored 0 killed / 6 SURVIVED against the round-3 suites. A mutant set
   * containing only the author's guesses is the same false assurance in a new
   * place, so an outside set that beat this check is exactly the set worth
   * keeping permanently. V1 and V3 are the sharpest: they delete the round-3
   * CSS being landed and the rail suite stayed 15/0.
   */
  {
    id: 'V1', property: "the recovery text is REACHABLE — the clipped box scrolls",
    suite: RAIL, file: 'public/styles.css',
    edits: [['  overflow: auto;\n  text-overflow: clip;', '  overflow: hidden;\n  text-overflow: clip;']],
  },
  {
    id: 'V2', property: 'the recovery instruction is FRONT-loaded, inside the visible band',
    suite: RAIL, file: 'public/app.js',
    edits: [["    if (hint) body.append(el('strong', { class: 'fix-first', text: hint }), el('br'));\n    const rest =", "    const rest ="], ["    body.append(document.createTextNode(rest));", "    body.append(document.createTextNode(rest));\n    if (hint) body.append(el('br'), el('strong', { class: 'fix-first', text: hint }));"]],
  },
  {
    id: 'V3', property: 'the warn row shows MORE THAN ONE line of the message',
    suite: RAIL, file: 'public/styles.css',
    edits: [['  max-height: 11.6em;', '  max-height: 1.45em;']],
  },
  {
    id: 'V4', property: 'process-all NEVER pulls from a group that is still filling',
    suite: RAIL, file: 'src/server/index.ts',
    edits: [["        ? items.filter((i) => rest[1] === 'dismiss' || i.ready).map((i) => i.id)", '        ? items.map((i) => i.id)']],
  },
  {
    id: 'V5', property: 'a PARTIAL skip (some lanes handed over, some not) is named at the user',
    suite: RAIL, file: 'public/app.js',
    edits: [['    state.pendingActionProblem = `${r.skipped.length} result(s) could not be handed over and are still held: ${r.skipped.map((x) => x.why).join(\'; \')}`;', '    state.pendingActionProblem = null;']],
  },
  {
    id: 'V6', property: 'a refused ACK after a successful send is named at the user',
    suite: RAIL, file: 'public/app.js',
    edits: [['      state.pendingActionProblem = `${ack.refused.length} result(s) were sent but could not be marked collected, so they will be offered again: ${ack.refused.map((x) => x.why).join(\'; \')}`;', '      state.pendingActionProblem = null;']],
  },
  {
    id: 'V7', property: 'the 503 body de-duplicates its reasons (round-4 finding 1)',
    suite: RAIL, file: 'src/server/index.ts',
    edits: [['        const reasons = [...new Set(bundle.skipped.map((s) => s.why))];', '        const reasons = bundle.skipped.map((s) => s.why);']],
  },
  {
    id: 'V8', property: 'markHeldReason refuses a dismissed or still-running record',
    suite: DRAIN, file: 'src/server/lanes.ts',
    edits: [["  if (rec.dismissedAt != null) return rec;   // discarded: not held, so nothing to explain\n  if (rec.state === 'running' || rec.state === 'pending') return rec; // not finished: not held yet\n", '']],
  },
  /*
   * Y1-Y8 — THE FIRST CROSS-PROVIDER REVIEW'S PROBES, as mutants.
   *
   * Its five findings survived three same-family verification rounds, so its
   * probes are adopted into the standing set exactly as V1-V8 were. Each
   * removes the round-5 fix for one finding; each must die.
   */
  {
    id: 'Y1', property: 'a late joiner cannot re-open a CLOSED group (no double delivery)',
    suite: DRAIN, file: 'src/server/lanes.ts',
    /* RE-POINTED (round 6): admission now asks the single `groupSeal` rule,
     * so the local `closedSibling` variable no longer exists. */
    edits: [['  if (seal) {', '  if (false && seal) {']],
  },
  {
    id: 'Y2', property: 'a DUPLICATE lane id is refused (no unreachable, blocking row)',
    suite: DRAIN, file: 'src/server/lanes.ts',
    edits: [["  if (all.some((r) => r.id === rec.id)) {", '  if (false) {']],
  },
  {
    id: 'Y3', property: 'a DISMISSED member is not outstanding (no permanent group hang)',
    suite: DRAIN, file: 'src/server/lanes.ts',
    edits: [["    outstanding: rows.filter((r) => (r.state === 'pending' || r.state === 'running') && r.dismissedAt == null).length,", "    outstanding: rows.filter((r) => r.state === 'pending' || r.state === 'running').length,"]],
  },
  {
    id: 'Y4', property: 'the receipt is NONCE-bound — an earlier receipt cannot acknowledge a later send',
    suite: DRAIN, file: 'src/server/lane-drain.ts',
    edits: [['    if (receipt?.nonce !== wantNonce) {', '    if (false) {']],
  },
  {
    id: 'Y5', property: 'the receipt is CHANNEL-bound — possession alone is not delivery',
    suite: DRAIN, file: 'src/server/lane-drain.ts',
    edits: [['    if (receipt?.channel !== wantChannel) {', '    if (false) {']],
  },
  {
    id: 'Y6', property: 'the bundle contains ONLY lanes that were really handed off',
    suite: DRAIN, file: 'src/server/lane-drain.ts',
    /* RE-POINTED (round 6): the convergence test became a multi-line block
     * when the N+1 bound and the refuse-on-exhaustion path were added.
     * RE-POINTED (round 11): finding 1 removed `digest = trialDigest` from the
     * converged branch (the response no longer carries the digest), moving this
     * anchor; the comment also grew. Re-pointed to the current block. */
    edits: [['    if (!failedNow.length) {\n      /* Every candidate stamped against THIS bundle: payload and disk agree.\n       * `trialDigest` is recorded in the evidence (on disk) but NOT returned —\n       * finding 1: the response must never carry the value acknowledge compares. */\n      sent = ok; bundle = trial; bytes = trialBytes; converged = true;\n      break;\n    }', '    { sent = candidates; bundle = trial; bytes = trialBytes; converged = true; break; } // keep every candidate in the bundle']],
  },
  {
    id: 'Y7', property: 'a MISSING result file is refused, not silently replaced by its excerpt',
    suite: DRAIN, file: 'src/server/lane-drain.ts',
    edits: [['    const text = lanes.readResult(id);\n    if (text == null) {', '    const text = lanes.readResult(id) ?? rec.resultExcerpt ?? \'\';\n    if (false) {']],
  },
  {
    id: 'Y8', property: 'the composer receives the result BEFORE the acknowledgement is sent',
    suite: RAIL, file: 'public/app.js',
    // RELOCATE, not delete: deleting would test "never delivers", while the
    // defect under review was "delivers, but acknowledges first".
    /* RE-POINTED (round 7): the round-7 #3 fix inserted the channelBytes/digest
     * lines AND the pre-ack `composerProblem` re-check between the delivery block
     * and the ack, so the old anchor (which ran to `const digest`) no longer
     * matches. The mutant still RELOCATES the whole delivery block to after the
     * ack; C5 (result-in-composer-at-ack-time) kills it. */
    edits: [
      ['  let delivery;\n  try {\n    delivery = showPendingBundle(r);\n  } catch (err) {\n    delivery = { delivered: false, why: `the collected results could not be placed in your message box (${err.message})` };\n  }\n  if (!delivery.delivered) {\n    state.pendingActionProblem = `${delivery.why}. Nothing was marked collected, so these results are still held and will be offered again.`;\n    await refreshPending();\n    return;\n  }\n', '  // [Y8] delivery relocated to after the ack\n'],
      ['  await refreshPending();\n}', '  showPendingBundle(r);\n  await refreshPending();\n}'],
    ],
  },
  /*
   * W1-W7 — THE CROSS-PROVIDER REVIEWER'S ROUND-5 PROBES, ADOPTED THE WAY
   * V1-V8 AND Y1-Y8 WERE.
   *
   * Its probe file (`/tmp/arch017-r5.cjs`) did not survive to round 6, so these
   * are rebuilt from the five areas the handoff recorded rather than copied
   * verbatim — the difference is stated because it matters: these are OUR
   * encoding of ITS questions, and an area we mis-transcribed is an area still
   * unprobed. The areas were: a group closed at birth draining twice; the two
   * receipt implementations diverging on uppercase digests and on a
   * `composer/main` channel; fixpoint exhaustion leaving disk stamps outside
   * the payload; a missing composer still acknowledging; and empty inputs
   * passing rail A4, drain R1 and the open-group item assertion.
   */
  {
    id: 'W1', property: 'a group already DRAINED is sealed — it cannot be delivered a second time',
    suite: DRAIN, file: 'src/server/lanes.ts',
    /* RE-POINTED (round 8): the drained clause was made ABSORBING (checked before
     * `closed`, and now also covers `acknowledgedAt`), so its text moved. */
    edits: [['  const drained = rows.find((r) => r.handoffAt != null || r.acknowledgedAt != null);', '  const drained = rows.find(() => false);']],
    unreachable: 'ROUND 9 made the seal DURABLE: handoff writes `sealGroupDurably`, and `groupSealFor` consults the durable store BEFORE the rows. So any group with a handoff has a durable seal that masks this row-based clause — the property is enforced (and asserted by W9/W19) via the durable path (W21 kills that), and this in-memory fallback is now defence-in-depth that no observable behaviour depends on while the durable file is intact.',
  },
  /* ROUND 8 — the fourth cross-provider review's probes (r7.cjs / r7-scan.cjs),
   * adopted as mutants: each removes exactly the property a round-8 fix added. */
  {
    id: 'W11', property: 'the DELIVERED seal ABSORBS closed — closing cannot mask a drained group (round-8 finding 1)',
    suite: DRAIN, file: 'src/server/lanes.ts',
    edits: [['  const drained = rows.find((r) => r.handoffAt != null || r.acknowledgedAt != null);', '  const drained = rows.find((r) => (r.handoffAt != null || r.acknowledgedAt != null) && r.groupClosedAt == null);']],
    unreachable: 'ROUND 9: same as W1 — the durable seal (written at handoff, consulted first by `groupSealFor`) dominates this row-based clause, so the absorbing-order property is now enforced and asserted via the durable path. Kept as defence-in-depth.',
  },
  {
    id: 'W12', property: 'pending readiness goes through the ONE predicate, not a local re-derivation (round-8 finding 1)',
    suite: DRAIN, file: 'src/server/lane-drain.ts',
    edits: [['    const open = g.open;', '    const open = rows.some((r) => r.groupOpen);']],
  },
  {
    id: 'W13', property: 'the client hashes the ACTUAL payload (empty stays empty), not a substituted fallback (round-8 finding 2)',
    suite: DRAIN, file: 'src/server/dispatch-client.mjs',
    edits: [["  const payload = Buffer.from(f.text ?? '', 'utf8');", "  const payload = Buffer.from(f.text || 'x', 'utf8');"]],
  },
  {
    id: 'W14', property: 'composerProblem checks ANCESTOR visibility, not just the box itself (round-8 finding 3)',
    suite: RAIL, file: 'public/app.js',
    edits: [['  for (let el = box; el; el = el.parentElement) {', '  for (let el = box; el === box; el = el.parentElement) {']],
  },
  {
    id: 'W15', property: 'a pre-ack re-check that THROWS is a refusal, not an escape (round-8 finding 3)',
    suite: RAIL, file: 'public/app.js',
    edits: [['  let lost;\n  try { lost = composerProblem(node.prompt, r.bundle); }\n  catch (err) { lost = `the message box could not be confirmed (${err && err.message})`; }', '  let lost = composerProblem(node.prompt, r.bundle);']],
  },
  {
    id: 'W16', property: 'the scanner catches afterBad.every() going vacuous when its own guard is removed (round-8 finding 5)',
    suite: VACUITY, file: DRAIN,
    edits: [['  assert.equal(afterBad.length, 3, `precondition: the disk still holds all three lanes; got ${afterBad.length}`);', '  void 0;']],
  },
  {
    id: 'W17', property: 'the scanner catches W4 reports.every() going vacuous when its own guard is removed (round-8 finding 5)',
    suite: VACUITY, file: LEDGER,
    edits: [['  assert.equal(w4.reports.length, 4, `precondition: all four contenders reported; got ${w4.reports.length}`);', '  void 0;']],
  },
  /* ROUND 9 — the fifth cross-provider review's probes (r8.cjs), adopted as mutants. */
  {
    id: 'W21', property: 'the seal is DURABLE — consulted from storage that outlives pruned rows (round-9 finding 1)',
    suite: DRAIN, file: 'src/server/lanes.ts',
    edits: [['  return durableGroupSeal(groupId) ?? groupSeal(rows);', '  return groupSeal(rows);']],
  },
  {
    id: 'W22', property: 'the handoff refuses a record whose GENERATION changed underneath the drain (round-9 finding 3)',
    suite: DRAIN, file: 'src/server/lanes.ts',
    edits: [['  if (expectGeneration != null && rec.generation !== expectGeneration) {', '  if (false && expectGeneration != null && rec.generation !== expectGeneration) {']],
  },
  {
    id: 'W23', property: 'an overflowing deadline is CLAMPED finite, not persisted as null-forever (round-9 finding 4)',
    suite: DRAIN, file: 'src/server/lanes.ts',
    edits: [['  if (!Number.isFinite(value)) return MAX_DEADLINE;', '  if (!Number.isFinite(value)) return value;']],
  },
  {
    id: 'W24', property: 'starvation readiness is the PERSISTED stamp, not the clock — monotonic and not exposed-and-reversible (round-9/10 findings 2/4/5)',
    suite: DRAIN, file: 'src/server/lane-drain.ts',
    /* RE-POINTED (round 10): reverting to the time-based expression drops the
     * persisted-stamp semantics; W18 (rollback) and W32 (re-read) kill it. */
    edits: [['      const starved = r.starvationReleasedAt != null;', '      const starved = waited >= lanes.HELD_STARVATION_MS;']],
  },
  /* ROUND 10 — the sixth review's probes (arch017-r9.cjs), adopted as mutants. */
  {
    id: 'W26', property: 'delivery captures the field session selection ACTUALLY stores (sessionId), not a non-existent .id (round-10 finding 1)',
    suite: RAIL, file: 'public/app.js',
    /* RE-POINTED (round 11): the round-10 origin/sessionMoved anchor was rewritten
     * by finding 2 (originRef + encodedDir + null-refuse). The round-9 regression
     * is still reproduced by capturing the origin from `.id` (a field a selected
     * session does not have) — the guard then compares the real `sessionId`
     * against a null origin and refuses every delivery, which the delivery checks
     * (C5/B3 and C10/C11) all catch. */
    edits: [['    sessionId: state.current?.sessionId ?? null,\n    projectId: state.current?.projectId ?? null,\n    encodedDir: state.current?.encodedDir ?? null,', '    sessionId: state.current?.id ?? null,\n    projectId: state.current?.projectId ?? null,\n    encodedDir: state.current?.encodedDir ?? null,']],
  },
  {
    id: 'W27', property: 'an unreadable/invalid seal store FAILS CLOSED, not open (round-10 finding 2)',
    suite: DRAIN, file: 'src/server/lanes.ts',
    edits: [['    return { kind: \'drained\', why: `${(e as Error).message} — failing closed: every group is treated as already delivered until the seal store is readable again` };', '    return null;']],
  },
  {
    id: 'W28', property: 'a legacy row gets a UNIQUE generation, not one derived from the reusable id (round-10 finding 4)',
    suite: DRAIN, file: 'src/server/lanes.ts',
    edits: [['    if (typeof rec.generation !== \'string\' || !rec.generation) { rec.generation = randomBytes(12).toString(\'hex\'); upgradedGeneration = true; }', '    if (typeof rec.generation !== \'string\' || !rec.generation) { rec.generation = `legacy-${rec.id}`; upgradedGeneration = true; }']],
  },
  {
    id: 'W25', property: 'delivery is bound to the initiating session — no cross-project leak (round-9 finding 5)',
    suite: RAIL, file: 'public/app.js',
    edits: [["  if (sessionMoved()) {\n    state.pendingActionProblem = 'you switched session while these results were being collected", "  if (false && sessionMoved()) {\n    state.pendingActionProblem = 'you switched session while these results were being collected"]],
  },
  {
    id: 'W2', property: 'the receipt comparison is CASE-INSENSITIVE in the one shared place (uppercase digest)',
    suite: DRAIN, file: 'src/server/lanes.ts',
    edits: [['  return expected.toLowerCase() === presented.toLowerCase();', '  return expected === presented;']],
  },
  {
    id: 'W3', property: 'a channel containing "/" survives the evidence round trip (composer/main)',
    suite: DRAIN, file: 'src/server/lanes.ts',
    // Re-introduces the exact truncation the JSON encoding replaced.
    edits: [["    if (typeof f?.sha256 !== 'string' || typeof f?.nonce !== 'string' || typeof f?.channel !== 'string') return null;\n    return f;", "    if (typeof f?.sha256 !== 'string' || typeof f?.nonce !== 'string' || typeof f?.channel !== 'string') return null;\n    return { ...f, channel: f.channel.split('/')[0] };"]],
  },
  {
    id: 'W4', property: 'fixpoint EXHAUSTION refuses — it never returns a payload the disk disagrees with',
    suite: DRAIN, file: 'src/server/lane-drain.ts',
    edits: [['  if (!converged) {', '  if (false) {']],
    /*
     * UNREACHABLE BY CONSTRUCTION — and that is the round-5 fix's own claim,
     * so the mutant is kept as the place where the claim is written down.
     *
     * The loop is `for (attempt = 0; attempt <= laneIds.length &&
     * candidates.length; attempt++)`. `candidates` is built by filtering
     * `laneIds`, so it starts at C ≤ N = laneIds.length. Every non-final pass
     * moves at least one lane from `candidates` to `skipped`, so after k
     * failing passes at most C−k remain; the set is empty or fully stamped by
     * pass C, and the loop is allowed N+1 ≥ C+1 passes. `converged` is
     * therefore true on exit by either the `break` or the `!candidates.length`
     * line — the refusal branch cannot be entered from any input.
     *
     * That makes it a safety net for a future edit that lowers the bound (the
     * round-5 defect was a fixed bound of 4), not a live path. No in-process
     * test can reach it: forcing a partial, repeated stamp failure needs
     * per-lane injection into `lanes.restampHandoff`, and ESM namespace objects
     * are read-only — the same constraint X5 and X5b already document, which is
     * why they use an unwritable directory (all lanes fail at once, so the
     * candidate set empties in ONE pass and converges).
     *
     * Reported as UNREACHABLE rather than SURVIVED, and not counted against the
     * run. Deleting it would hide the gap; leaving it red forever would train
     * everyone to ignore a gate whose whole value is that it is believed.
     */
    unreachable: 'the N+1 bound makes exhaustion impossible: candidates ⊆ laneIds and each failing pass removes ≥1, so the loop always converges. Reaching it needs per-lane write-failure injection, which ESM read-only namespaces prevent in-process.',
  },
  {
    id: 'W5', property: 'the composer is RE-CHECKED at the ACK INSTANT, not trusted from the pre-await pass (finding 3)',
    suite: RAIL, file: 'public/app.js',
    /* RE-POINTED (round 7): the round-6 missing-composer refusal moved into the
     * shared `composerProblem`, and the round-7 fix added the pre-ack RE-CHECK
     * that is the actual subject of cross-provider finding 3 (a composer torn
     * DURING the async gap). Deleting the re-check (force `lost` null) lets a
     * torn composer be acknowledged; the new C6 leg kills it. W8 covers the
     * before-run missing composer via the isConnected guard.
     * RE-POINTED (round 8): the round-8 fix wrapped the re-check in try/catch, so
     * the one-line anchor moved; this deletes the whole re-check block. */
    edits: [['  let lost;\n  try { lost = composerProblem(node.prompt, r.bundle); }\n  catch (err) { lost = `the message box could not be confirmed (${err && err.message})`; }', '  let lost = null;']],
  },
  {
    id: 'W8', property: 'the composer check asks the DOM, not a boot-time cache (isConnected)',
    suite: RAIL, file: 'public/app.js',
    // The exact regression this uncovered: `node.prompt` is captured once at boot,
    // so a detached textarea passes a bare existence check and reads its own writes
    // back. RE-POINTED (round 7): the guard moved into the shared `composerProblem`
    // and split from `!box`; neutering the isConnected clause lets a composer removed
    // BEFORE the run be acknowledged, which the W5-leg (no composer on screen) kills.
    edits: [["  if (!box.isConnected) return 'the message box was removed from the page before the collected results could be confirmed in it';", "  if (false) return 'x';"]],
  },
  {
    id: 'W6', property: 'the vacuity scanner catches an unguarded empty-true assertion (rail A4)',
    suite: VACUITY, file: RAIL,
    edits: [['    onDisk.length === records.length && records.length > 0\n      && onDisk.every((r) => r.handoffAt == null && r.acknowledgedAt == null),', '    onDisk.every((r) => r.handoffAt == null && r.acknowledgedAt == null),']],
  },
  {
    id: 'W7', property: 'the vacuity scanner catches the open-group item assertion going empty-true (C1)',
    suite: VACUITY, file: RAIL,
    edits: [["      okPre && pulled.length > 0 && pulled.includes('lane-v4-control')\n        && !pulled.includes('lane-v4-done') && !pulled.includes('lane-v4-running'),", "      okPre && !pulled.includes('lane-v4-done') && !pulled.includes('lane-v4-running'),"]],
  },
  {
    id: 'W36', property: 'the drain RESPONSE withholds the expected digest — echoing it back cannot acknowledge (round-11 finding 1, the echo defence)',
    suite: DRAIN, file: 'src/server/lane-drain.ts',
    /* Re-introduces the leak: the response carries the exact value acknowledge
     * compares, so a consumer that emits nothing and echoes the envelope collects.
     * W33 (digest===undefined + echo refused) kills it. THIS is the mutant the
     * seventh review asked for: the test must fail if the echo defence is removed. */
    edits: [['    receipt: { nonce, channel, bytes },', '    receipt: { nonce, channel, bytes, digest: lanes.receiptDigest(nonce, channel, bundle) },']],
  },
  {
    id: 'W37', property: 'a PRESENT-but-malformed seal entry fails CLOSED, not open (round-11 finding 3)',
    suite: DRAIN, file: 'src/server/lanes.ts',
    /* The exact defect: a groupId mapped to a non-seal (`false`) reads as unsealed
     * via truthiness, admitting a late member. W34 kills it. */
    edits: [['  if (!isDurableSeal(s)) {', '  if (!s) { return null; } else if (!isDurableSeal(s)) {']],
  },
  {
    id: 'W38', property: 'retention never evicts the seal JUST written (round-11 finding 4)',
    suite: DRAIN, file: 'src/server/lanes.ts',
    /* Puts the just-written groupId back among the eviction candidates, so a fresh
     * seal with a rolled-back clock is dropped the instant it is created. W35 kills it. */
    edits: [['  const ids = Object.keys(seals).filter((id) => id !== groupId);', '  const ids = Object.keys(seals);']],
  },
  {
    id: 'W39', property: 'the session guard keys on encodedDir + object reference + refuses an absent id (round-11 finding 2)',
    suite: RAIL, file: 'public/app.js',
    /* Reverts the guard to the round-10 shape (sessionId+projectId only), which
     * still delivered when the id was absent, the dir changed, or the context was
     * re-opened with the same id. C11/absent, C11/directory and C11/recreated kill it. */
    edits: [['  const sessionMoved = () =>\n    (state.current?.sessionId ?? null) == null ||               // (1) no destination\n    state.current !== originRef ||                              // (3) context re-opened\n    (state.current?.sessionId ?? null) !== origin.sessionId || // (2) …\n    (state.current?.projectId ?? null) !== origin.projectId ||\n    (state.current?.encodedDir ?? null) !== origin.encodedDir;', '  const sessionMoved = () =>\n    (state.current?.sessionId ?? null) !== origin.sessionId ||\n    (state.current?.projectId ?? null) !== origin.projectId;']],
  },
  {
    id: 'W40', property: 'auto-allocated lane ids carry CSPRNG entropy, not Math.random (round-11 finding 4)',
    suite: DRAIN, file: 'src/server/lanes.ts',
    /* The exact weakness: ~31 bits from a non-cryptographic PRNG. W35's entropy
     * assertion (suffix >= 16 hex chars) kills it. */
    edits: [["  return `lane-${at.toString(36)}-${randomBytes(9).toString('hex')}`;", "  return `lane-${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;"]],
  },
];

/*
 * ROUND 7 — OPTIONAL SUITE FILTER, so the 42-mutant set can be run in foreground
 * chunks under a wall-clock cap without splitting the score. The 15 RAIL mutants
 * each boot a real server + browser; on a loaded box the full run exceeds ten
 * minutes. `ARCH017_MUT_SUITES=DRAIN,LEDGER,VACUITY` grades just those; unset =
 * every suite, unchanged. The reported score is the UNION across chunks, and the
 * baseline-first anti-vacuity discipline is per-suite, so a chunk is exactly as
 * sound as the whole. Never a way to grade FEWER checks — only fewer mutants.
 */
const SUITE_NAMES = { [DRAIN]: 'DRAIN', [LEDGER]: 'LEDGER', [RAIL]: 'RAIL', [VACUITY]: 'VACUITY' };
const ONLY_SUITES = (process.env.ARCH017_MUT_SUITES || '').split(',').map((s) => s.trim()).filter(Boolean);
const SELECTED = ONLY_SUITES.length ? MUTANTS.filter((m) => ONLY_SUITES.includes(SUITE_NAMES[m.suite])) : MUTANTS;

function sandbox(mutant) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `a17mut-${mutant.id}-`));
  /*
   * `docs` IS NOT OPTIONAL. The server calls `seedTemplates()` at boot and
   * reads `docs/prompts/WORKING_AGREEMENT.md`; without it every sandboxed run
   * died with "scratch server never became healthy" and the harness counted
   * that crash as a KILL. Five mutants were reported killed by a sandbox that
   * could not start — a mutation check producing false kills is worse than
   * none, because it manufactures exactly the confidence it exists to withhold.
   * The baseline assertion below is the permanent guard against it.
   */
  const tar = spawnSync('bash', ['-c', `tar -cf - -C ${JSON.stringify(ROOT)} src scripts public docs package.json tsconfig.json | tar -xf - -C ${JSON.stringify(dir)}`], { encoding: 'utf8' });
  if (tar.status !== 0) throw new Error(`sandbox export failed: ${tar.stderr}`);
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  const target = path.join(dir, mutant.file);
  let src = fs.readFileSync(target, 'utf8');
  for (const [from, to] of mutant.edits) {
    if (!src.includes(from)) {
      throw new Error(`ANCHOR MISSING in ${mutant.file}: ${JSON.stringify(from.slice(0, 70))} — the code moved, so this mutant is no longer asking its question. Re-point it.`);
    }
    src = src.replace(from, to);
  }
  fs.writeFileSync(target, src);
  return dir;
}

/**
 * ROUND 3 — A MUTANT IS NOT KILLED BY A FAILURE THAT WAS ALREADY THERE.
 *
 * The harness graded on `run.status !== 0` alone. That is only sound while the
 * suite is green to begin with, and round 3 walked straight into the case where
 * it was not: round 2's `heldReason` change turned D4 red on the UNMUTATED tree,
 * and the harness then reported `9 killed / 0 survived` with M9 *and* M8 both
 * "killed by D4". M9 removes the very line whose absence D4 was already
 * complaining about, so its only killer was a pre-existing failure — it was a
 * SURVIVOR being credited as a kill, and the check that exists to stop false
 * assurance was producing some.
 *
 * So each suite is now run UNMUTATED first, and a mutant counts as killed only
 * if it fails a check the baseline PASSES. A suite that is red before any
 * mutation is reported as such and grades nothing: a mutation score over a
 * broken suite is not a number worth having.
 */
function runSuite(cwd, suite) {
  const args = ['tsx', suite, ...(GRADE_MUST_FAIL ? ['--must-fail-proof'] : [])];
  const run = spawnSync('npx', args, { cwd, encoding: 'utf8', timeout: 600_000, env: { ...process.env, npm_config_loglevel: 'silent' } });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  return {
    status: run.status,
    result: (out.match(/RESULT (\d+) PASS \/ (\d+) FAIL/) || [])[0] ?? '(no RESULT line)',
    failing: new Set([...out.matchAll(/^(?:FAIL|ERROR) ([^:]+):/gm)].map((x) => x[1].split('—')[0].trim())),
  };
}

console.log(`=== ARCH-017 mutation check — ${SELECTED.length}${ONLY_SUITES.length ? `/${MUTANTS.length}` : ''} mutants${ONLY_SUITES.length ? ` (suites: ${ONLY_SUITES.join(',')})` : ''}${GRADE_MUST_FAIL ? ', --must-fail-proof mode' : ', DEFAULT run'} ===\n`);

/*
 * BASELINE FIRST, IN THE SANDBOX, AND IT DECIDES TWO THINGS.
 *
 * A mutant is "killed" when the suite goes red. Two other things also turn a
 * sandbox red and are indistinguishable from a kill unless you look:
 *
 *  1. THE SANDBOX CANNOT RUN THE SUITE AT ALL. Measured: five UI/API mutants
 *     reported KILLED by a sandbox missing `docs/`, where the server never
 *     booted. Nothing was asserted; the harness just liked the exit code.
 *  2. THE SUITE WAS ALREADY FAILING. Measured this round: with D4 red on the
 *     UNMUTATED tree, the harness printed `9 killed / 0 survived` with M9 AND
 *     M8 both "killed by D4" — and M9 deletes the very line D4 was already
 *     complaining about, so its only killer was a pre-existing failure. It was
 *     a survivor wearing a kill's clothes, produced by the one check whose job
 *     is to stop false assurance.
 *
 * So the unmutated suite is run first IN A SANDBOX, and its failing set is
 * kept. A red baseline aborts the whole run (a mutation score over a broken
 * suite is not a number worth having), and below, a mutant is credited only
 * with checks the baseline PASSES.
 */
const baselines = new Map();
for (const suite of [...new Set(SELECTED.map((m) => m.suite))]) {
  let dir = sandbox({ id: 'baseline', file: 'package.json', edits: [] });
  let base = runSuite(dir, suite);
  fs.rmSync(dir, { recursive: true, force: true });
  /*
   * ONE RETRY BEFORE BELIEVING A RED BASELINE.
   *
   * `D7` in the ledger suite is a WALL-CLOCK sweep — it calibrates a landing
   * time and then kills a peer at T-40+2i ms across 24 trials — so it goes red
   * on a loaded box. A verifier hit exactly that and the whole run ABORTED,
   * grading zero mutants: the standing anti-vacuity check's verdict depended on
   * machine load, and its failure mode was silent. A retry costs one run and
   * removes most of the flake.
   */
  if (base.status !== 0 && base.failing.size) {
    console.log(`BASELINE RETRY   ${path.basename(suite)} — ${base.result}  (${[...base.failing].join(', ')} — re-running once before treating it as real)`);
    dir = sandbox({ id: 'baseline', file: 'package.json', edits: [] });
    base = runSuite(dir, suite);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  baselines.set(suite, base);
  if (base.status === 0) {
    console.log(`BASELINE OK      ${path.basename(suite)} — ${base.result}`);
    continue;
  }
  /*
   * A CRASH still aborts — nothing was asserted, so no number is worth having.
   * But a baseline that names its failures does NOT void the run: those checks
   * are simply excluded from kill credit (`newlyFailing` below), and every
   * other check in the suite still grades every mutant. Discarding eighteen
   * good verdicts because one wall-clock check flaked is a worse answer than
   * reporting eighteen verdicts and naming the check that could not take part.
   */
  if (!base.failing.size) {
    console.log(`BASELINE BROKEN  ${path.basename(suite)} — ${base.result}`);
    console.log(`\nABORT: ${suite} fails UNMUTATED with no named check — it did not run at all, so every "kill" would be a crash, not an assertion.`);
    process.exit(2);
  }
  console.log(`BASELINE FLAKY   ${path.basename(suite)} — ${base.result}  ALREADY FAILING: ${[...base.failing].join(', ')}`);
  console.log(`                 → these checks are EXCLUDED from kill credit; the run continues on the rest.`);
}
console.log('');

const survivors = [];
const killed = [];
/* Declared unreachable-by-construction and survived: reported, not counted. */
const unreachable = [];
for (const m of SELECTED) {
  let dir = null;
  try {
    dir = sandbox(m);
    const run = runSuite(dir, m.suite);
    const base = baselines.get(m.suite);
    /* The checks this mutation broke — NOT the ones that were already broken.
     * A mutant whose only "killer" is a baseline failure has killed nothing. */
    const newlyFailing = [...run.failing].filter((f) => !base.failing.has(f));
    /*
     * `harness` ALONE IS NOT A KILL. It is the suite's catch-all name, so a
     * mutant that merely crashes the run would be credited with coverage it
     * does not have — the `docs/`-missing false kills one level down. Reported
     * as CRASHED so it is visible and investigated rather than counted.
     */
    const namedKillers = newlyFailing.filter((f) => f !== 'harness');
    const crashedOnly = newlyFailing.length > 0 && namedKillers.length === 0;
    const dead = run.status !== 0 && namedKillers.length > 0;
    /*
     * A mutant may DECLARE its property unreachable by construction, with the
     * argument written out at the definition. Such a mutant is still run — if
     * it is killed, the justification was wrong and we want to know — but a
     * survival is reported as UNREACHABLE and does not fail the run. The
     * alternative to naming this is deleting the mutant, which hides the gap,
     * or a permanently red gate, which teaches everyone to ignore it.
     */
    const excused = !dead && !crashedOnly && !!m.unreachable;
    console.log(`${dead ? 'KILLED  ' : crashedOnly ? 'CRASHED ' : excused ? 'UNREACH ' : 'SURVIVED'} ${m.id} [${path.basename(m.suite)}] — ${m.property}`);
    if (excused) console.log(`         UNREACHABLE BY CONSTRUCTION: ${m.unreachable}`);
    if (dead && m.unreachable) console.log(`         NOTE: declared unreachable, but a check KILLED it — the justification is stale, drop the annotation.`);
    const preExisting = [...run.failing].filter((f) => base.failing.has(f));
    console.log(`         observed: ${run.result}${namedKillers.length ? `  killed by: ${namedKillers.join(', ')}` : ''}${crashedOnly ? '  — the suite CRASHED; NOT counted as a kill' : ''}${preExisting.length ? `  (pre-existing, NOT credited: ${preExisting.join(', ')})` : ''}${run.status !== 0 && !newlyFailing.length ? '  — exited non-zero but broke NOTHING the baseline passes' : ''}`);
    (dead ? killed : excused ? unreachable : survivors).push(m);
  } catch (e) {
    console.log(`ERROR    ${m.id} — ${e.message}`);
    survivors.push(m);
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nRESULT ${killed.length} killed / ${survivors.length} SURVIVED (a survivor is a property nothing asserts)`);
for (const s of survivors) console.log(`  SURVIVOR ${s.id} — nothing in the suite notices when this is removed: ${s.property}`);
for (const u of unreachable) console.log(`  UNREACHABLE ${u.id} — ${u.property}\n      not counted: ${u.unreachable}`);
process.exit(survivors.length ? 1 : 0);
