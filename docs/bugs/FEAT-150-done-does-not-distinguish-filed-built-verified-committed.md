# FEAT-150 — "done"/"all green" does not distinguish filed / built-unverified / verified / committed

- **Status:** IN VERIFICATION — the completion-claim ground-truth check is built and self-verified (11/11 against the REAL board + a pre-fix must-FAIL). Independent clean-room verify warranted before VERIFIED (it BLOCKS the orchestrator's turn and touches the load-bearing response-format stop hook).
- **Severity:** high (the user acts on "done"; an ambiguous claim costs a chain of "is it really done / what's left / what blocked you" turns — the loop this ticket exists to make impossible)
- **Area:** orchestrator response format — `scripts/hooks/response-format-gate.mjs` (stop hook, enforced path), `scripts/lib/format-metrics.mjs` (`completionClaims`), binds to `scripts/board-status.mjs` (FEAT-149's reader)
- **Reported:** 2026-09-23 by a dispatched finding lane, from the user's verbatim loop (below) and FEAT-149's Activity-log record of defects (a)/(b)/(c) as unaddressed
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED (session-turn-blocking; regression-prone surface).

## Symptom (user, verbatim in substance)
> "change the sidebar color to red" → "ok all green" → "how come I don't see changes?" → "just filed a ticket" → "you said done, finish it" → "ok all done" → "still not seeing it" → "oh I changed a different background, next step is the sidebar" → "but you said all green"

Three compounding defects, recorded in FEAT-149's round-2 log as unaddressed:
- (a) the orchestrator asks permission for work it was told to do autonomously;
- **(b) it says "done"/"all green" for something that is filed, or partially built, or built-but-unverified — the word does not distinguish them;**
- (c) the user must spend turns asking "is it done, what's left, what blocked you".

## Root cause / design (ARCH-010)
A completion word typed from the orchestrator's memory is the defect. The fix is ARCH-010: the WORK declares its state and the reader READS it. FEAT-149 already built the reader — `npm run board:status -- <ID>`, runnable under the orchestrator profile, over the ONE board parser. This ticket makes a completion CLAIM mechanically checkable against that reader.

A completion claim is not fuzzy prose — it is a STRUCTURED `orchard-digest` item whose `kind` is `done` (KIND_ALIAS folds done/changed/completed/complete in). The stop hook now, on the FEAT-137/138 **enforced-by-default** path:
1. extracts every `kind:"done"` digest item that names a ticket `ref` (`completionClaims`, `format-metrics.mjs`);
2. reads that ticket's REAL state through `board-status.mjs`'s `buildTicketReport` (no second parser);
3. **refuses the turn** (blocks once, one-correction cap) unless the board's `work_state` ∈ `{verified, done}` — or if the board has NO record for the ref. The block reason states the ticket and its real `work_state`, so the correction is a re-word to the true state, not a wording tweak.

This makes the ambiguous "all green" mechanically impossible for a ticket-scoped claim: you cannot mark a ticket done in the digest while the board reads it filed / in-progress / in-verification.

## Fix
- `scripts/lib/format-metrics.mjs` — new pure `completionClaims(digest)` extracting `kind:"done"` items + their refs.
- `scripts/hooks/response-format-gate.mjs` — enforced completion-claim check binding ref'd done-items to `buildTicketReport`; folded into `summarise()`/`reviseTurn()`; fail-open (no board tooling on disk → silently skips; any throw → logged + allow, never wedges).
- `package.json` — `verify:feat-150`.

## Scope / forks stopped at (product-direction)
- **Ad-hoc, ticket-less completion claims** (the literal "sidebar red" case) carry no `ref`, so there is no board record to bind to. Deliberately NOT graded — a false block on a legitimate ad-hoc "done" would reintroduce the pain. Binding an ad-hoc claim to ground truth means inventing a git-scoped truth (which files? verified how?) for an arbitrary change; that is a separate mechanism. **Fork:** require every completion claim to be ticketed, or accept vocabulary-only (from memory, weaker) for ad-hoc? Not decided here.
- **Defect (a)** — asking permission for already-authorized autonomous work — needs the PRIOR user turn, which the stop hook (final-message only) does not see. Separate mechanism, not built.
- **Injecting the rule into RESPONSE_FORMAT.md's core** was NOT done: the injected region has ~6 bytes of headroom under the 5900 pin (FEAT-142), so adding text requires compressing landed FEAT-142 work. The rule is carried by the self-explanatory block reason (just-in-time, how the model actually learns it) instead. Follow-up if budget frees.

## Context pack
- Files: `scripts/hooks/response-format-gate.mjs`, `scripts/lib/format-metrics.mjs` (`completionClaims`), `scripts/board-status.mjs` (`buildTicketReport`, `normalizeId`), `scripts/lib/ticket-schema.mjs` (`DONE_WORK_STATES`), `scripts/verify-feat-150-completion-claim.mjs`.
- Related: FEAT-149 (board:status reader + defects a/b/c record), FEAT-137/138 (the enforced-by-default block precedent this reuses), ARCH-010 (owner writes, reader reads), FEAT-091/143 (digest vocabulary), FEAT-142 (inject byte budget).
- Repro test: `npm run verify:feat-150` (11/11 against the real board).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-23 — finding+fixing lane (round 1, class explore→fix)
- **Understood:** defect (b) from FEAT-149's log — "done" does not distinguish filed / built-unverified / verified / committed. Confirmed no prior implementation existed (FEAT-149 built board:status but left a/b/c unaddressed; searched the board + tree first).
- **Changed:** `completionClaims` in `format-metrics.mjs`; the enforced completion-claim check in `response-format-gate.mjs`; `verify:feat-150`. Unstaged (git left to the user).
- **Verified (fixer's own — real board, not a fixture):**
  - `npm run verify:feat-150` → 11/11. Discovers a verified ticket (ARCH-001) and an in-progress ticket (ARCH-010) at runtime from the real board.
  - BLOCK proven: a `kind:"done"` digest item for ARCH-010 (board work_state `in_progress`) is refused by DEFAULT (no `ORCHARD_STOP_HOOK_ENFORCE`); reason names ARCH-010 and its real `work_state`.
  - ALLOW proven: the same shape for a verified ticket passes (not an always-block).
  - Non-vacuity / cannot-pass-on-missing: a done item for a non-existent `FEAT-99999` is BLOCKED ("no ticket record"); an in-flight item about ARCH-010 ALLOWS (only `done` is graded) — the differential isolates the check.
  - Must-FAIL: the HEAD (pre-fix) hook run in place ALLOWS the false ARCH-010 "done" (bug reproduced); post-fix blocks it.
  - Anti-regression: `verify:feat-085-stop-hook` 61/61, `verify:feat-091` 278/0, `verify:feat-084` 37/0, `verify:feat-149` 9/0; `npm run gate` PASS (exit 0, unpiped).
- **Verified-by:** PENDING — independent clean-room verify warranted (blocks the orchestrator's turn; load-bearing hook with a false-block history).
- **Still open / handoff:** the two forks above (ad-hoc/ticket-less claims; defect (a)); optional injected-core reminder if the byte budget frees.
