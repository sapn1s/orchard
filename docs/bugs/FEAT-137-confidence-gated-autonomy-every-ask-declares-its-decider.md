# FEAT-137 — Confidence-gated autonomy: every ask declares its confidence and the user-held thing that decides it

- **Status:** RESOLVED (round 2) — the deferred doc edit landed and the check was
  promoted. The `confidence:` / `decider:` contract is now injected into
  `RESPONSE_FORMAT.md`'s core (5899/5900 chars, spec funded by trimming the
  redundant collapsed-block name list), and `missing-confidence` is PROMOTED from
  recorded-only to a BLOCK. Every ask must now declare a confidence and a decider,
  or be decided rather than asked. RESIDUAL for the orchestrator: a session that
  launched BEFORE this deploys still runs the old prompt, so its no-confidence asks
  are blocked once (one-correction cap) until relaunch — deployment-timing call.
  Independent clean-room verify WARRANTED (Stop-hook decision change).
- **Severity:** medium
- **Area:** scripts/hooks (response-format-gate.mjs) / scripts/lib (format-metrics.mjs)
  · docs/prompts/RESPONSE_FORMAT.md (deferred spec injection)
- **Reported:** 2026-09-07 by user (via orchestrator dispatch)
- **Verification-class:** behavioural (real Stop-hook subprocess over fixtures +
  real transcripts) + anti-regression

## Symptom
The orchestrator hands the user decisions that are not theirs, or asks instead of
deciding when the answer is obvious. The user's verbatim example of the failure:
*"there is a breaking bug which will corrupt data … not sure if u want to fix it
tho, so i will leave it."* Their described fix: the orchestrator should state a
**confidence** in its recommended decision and, when confidence is high and the
answer is obviously yes, **JUST DO IT** instead of spending a turn asking.

## Why nothing existing covered it
- The RULE already exists and is ignored: WA §A's ownership test (FEAT-127,
  `WORKING_AGREEMENT.v4.md:61-73`) says an ask is legitimate only if you can name
  the user-held thing that decides it. It is PROSE, and prose has failed.
- FEAT-127 concluded this is an **enforcement** problem, not a specification one,
  and left only a MEASUREMENT (`askBlocks`). Nothing mechanical detected an unowned
  ask.

## Fix (the mechanical form)
1. **A machine-checkable declaration for `orchard-ask`** — every ask carries, in
   its body, a `confidence:` line (high/med/low) and a `decider:` line naming the
   user-held thing (taste/priority/spend/risk/direction). Parsed by
   `askOwnershipDefects(parsed)` in `format-metrics.mjs`.
2. **The gate BLOCKS the sharp, unambiguous defect** at the Stop hook (via the same
   `reviseTurn` path as FEAT-138), coupled to the confidence protocol:
   - `high-confidence-no-decider` → BLOCK. This is the user's verbatim case.
   - `missing-decider` (a `confidence:` level IS declared, no `decider:`) → BLOCK.
   - `missing-confidence` (no `confidence:` line at all) → **recorded only, NOT
     blocked** — see the safety property below.

## What a static gate can and cannot do (stated honestly)
- It CAN detect a **missing or malformed** decider declaration — the shape the user
  actually hit. That is what is enforced.
- It CANNOT read the model's mind: it cannot verify a declared `decider: taste` is
  genuinely a taste call rather than a sequencing choice wearing the label. A model
  can mislabel. The gate raises the floor (you must name a decider) and the metrics
  surface the rest for a human; it does not claim to prove ownership.

## The safety property that shaped the enforcement (and the deferred doc)
The `confidence:` / `decider:` contract is NEW: it must reach sessions via the
injected `RESPONSE_FORMAT.md` core before it is fair to require it. Blocking
`missing-confidence` today would block **every ask in flight** from sessions that
never received the spec — a regression the dispatch explicitly forbids ("do not
break existing sessions"). Proven on real data: over 20 recent real transcripts, an
earlier strict build blocked 5 asks purely for `missing-confidence`; the shipped
build blocks **zero** of them (they declare no confidence, so ownership never
fires) and only blocks genuine length overages.

So enforcement is **coupled to the protocol**: the gate fires only once an author
has engaged it (declared a confidence). The doc edit that injects the protocol is
**deferred**: `docs/prompts/RESPONSE_FORMAT.md` is under live concurrent edit by
another lane (observed changing between reads; a FEAT-129 shared-tree collision).
Editing it now risks clobbering that lane. NOTE: this file is NOT a methodology
mirror — `sync-methodology.mjs` syncs only `WORKING_AGREEMENT.*`/`ROUTING.md`, so
the eventual edit is made directly here, no `sync:methodology` needed. The WA §A
rule (the semantic home) already shipped in FEAT-127.

## Decisions the orchestrator must take
1. Sequence the ~95-char spec addition to the `orchard-ask` line of the
   `RESPONSE_FORMAT.md` injected core (draft: "lead with my recommendation, then
   `confidence:` high/med/low and `decider:` the user-held call it needs
   (taste/priority/spend/risk/direction)"), AFTER the concurrent RF lane lands, and
   fund it under the char cap (the section is at 5899/5900 chars; ~95 chars can be
   funded by trimming the redundant collapsed-block name list on
   `RESPONSE_FORMAT.md` — the collapsed set is already stated once above it).
2. Once injected, promote `missing-confidence` from recorded-only to a block
   (one line in the hook's ownership loop, already flagged in a code comment).

## Files
- `scripts/lib/format-metrics.mjs` — `askOwnershipDefects()`, `confidenceLevel()`;
  `asksMissingConfidence` / `asksHighNoDecider` / `asksMissingDecider` record
  fields; summary + ENFORCEMENT report section.
- `scripts/hooks/response-format-gate.mjs` — the ownership reasons + enforcement
  coupling in the `reviseTurn` path.
- `scripts/verify-feat-137-138-enforcement.mjs` — the behavioural suite.
- DEFERRED: `docs/prompts/RESPONSE_FORMAT.md` (spec injection — see decisions).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-07 — dispatched fix lane (fixing, round 1)
- **Understood:** the ownership rule exists in prose (WA §A) and is ignored; the
  need is a mechanical gate, not more prose. The gate must not break in-flight
  sessions that never got the new declaration format.
- **Changed:** the files above (doc injection deferred on a collision).
- **Must-FAIL proof (real commands):**
  - BEFORE (HEAD hook): a reply with the user's verbatim ask (`confidence: high`,
    NO decider) exits 0 with **no block** — the unowned ask passes today.
  - AFTER: the same reply → `{"decision":"block", …HIGH confidence but names no
    user-held decider … it is YOUR decision — make it and move on, do not ask.}`.
- **Ownership tiers verified (fixtures, real hook subprocess):** high+no-decider →
  BLOCK; med+no-decider → BLOCK; no-confidence-line (un-spec'd) → ALLOW;
  confidence+decider (owned) → ALLOW.
- **No-regression sweep:** 20 recent real transcripts — 0 asks blocked for
  ownership (all declare no confidence yet); the 4 real ask turns present all
  ALLOWED (under the 250 budget). The only real blocks are length overages
  (FEAT-138).
- **Anti-regression:** `verify-feat-084` 37/0, `verify-feat-091` 277/0,
  `verify-feat-137-138-enforcement` 13/0.
- **Gate (shared with FEAT-138):** `npm run gate` — leak-gate + typecheck; result
  recorded at commit time in the handoff. This lane wrote no git commands and left
  everything unstaged.
- **Independent verify:** WARRANTED (session-lifecycle / regression-prone; changes
  the Stop-hook decision). Recommend a clean-room pass on the confidence-protocol
  coupling and the un-spec'd-session safety property.

### 2026-09-07 — dispatched fix lane (fixing, round 2)
- **Did the two deferred steps, in the safe order.** FEAT-136 released
  `RESPONSE_FORMAT.md`; injected the spec FIRST, verified it, THEN flipped the check.
- **Spec injected (`docs/prompts/RESPONSE_FORMAT.md`).** The `orchard-ask` core line
  now reads: "lead with my recommendation, then `confidence:` high/med/low and
  `decider:` (taste/priority/spend/risk/direction)". Funded under the HARD 5900-char
  cap by removing the redundant collapsed-block name list (the folding set is
  already stated above it) plus a trivial "ends the fold there"→"ends the fold" trim.
  The ~95-char estimate was low — the faithful spec is ~87 chars net even after
  dropping the "user-held call it needs" gloss (redundant with the ask's own "it is
  YOURS" and with the taxonomy that follows); both ENFORCED fields (`confidence:`
  values, `decider:` taxonomy) are kept in full. `responseFormatSection()` (the REAL
  compose fn) measures **5899/5900 chars**; both tokens present; name-list gone.
- **Ordering PROVEN:** the injected section carried the spec (5899, tokens verified)
  BEFORE any edit to the hook. Only then was `missing-confidence` promoted.
- **Promotion (`scripts/hooks/response-format-gate.mjs`).** Added the
  `missing-confidence` → BLOCK branch in the ownership loop (the one-line change the
  round-1 code comment flagged), with the comment rewritten to record why the
  coupling is now satisfied.
- **Must-FAIL (real hook subprocess, identical no-confidence ask):** round-1 HEAD
  hook → ALLOWED; round-2 current hook → BLOCKED. Same input, opposite decision.
- **Evidence set re-run:** `verify-feat-137-138-enforcement` **13/0** (the round-1
  un-spec'd-ALLOWED assertion was intentionally flipped to no-confidence-BLOCKED and
  its comments updated to name the retired safety property); `verify-feat-084`
  **37/0**; `verify-feat-091-response-blocks` **277/0**.
- **20 real-transcript sweep (newest 20, real hook, throwaway dataDir):** 13 BLOCKED
  / 7 ALLOWED. Reasons: 9 length (FEAT-138, pre-existing), **4 missing-confidence**
  (the newly-promoted check firing on real historical asks), 0 high-confidence-no-
  decider, 0 missing-decider. The 4 are the expected teeth of the promotion AND the
  concrete face of the residual: those turns predate the spec.
- **Gate:** `npm run gate` → **PASS (exit 0)** — leak-gate + check-nul + typecheck.
  No git commands run; all work left unstaged.
- **Residual flagged for orchestrator:** in-flight sessions launched before deploy
  run the old prompt and will be blocked once until relaunch — a deployment-timing
  decision, not a code defect. Independent clean-room verify still WARRANTED.
