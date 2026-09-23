# BUG-175 — cost telemetry reports three wrong numbers: dispatch wait, 7-day spend, ticketless coverage

- **Status:** IN-PROGRESS
- **Severity:** high
- **Area:** server / cost telemetry (scripts/cost-collect.mjs, scripts/lib/cost-model.mjs, scripts/usage.mts)
- **Reported:** 2026-09-08 by orchestrator (from `docs/bugs/_scratch-orchard-telemetry.md`)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED

## Symptom

Three measured defects in Orchard's own cost telemetry, each producing a number a
human reads and acts on:

1. **`blocked_on_lane` reads 3.8% where the truth is ~84%.** The phase that should
   answer "how much of the orchestrator's time is spent waiting on dispatched
   lanes" reports 7.95 h blocked against 1027 h "idle" fleet-wide — the single
   largest fact about the pipeline was filed under suspended-laptop idle.
2. **`npm run usage` over-reports 7-day spend ~4×.** It reported **$2665.89** for
   the last 7 days where per-request measurement gives **$645.14**.
3. **`Dispatch: ticket=none` is counted as MALFORMED.** A ticketless-by-design
   dispatch (exploration, measurement) polluted the coverage line FEAT-100 exists
   to keep honest, showing up in the top-5 rejected-declaration complaints.

## Repro

1. `node scripts/cost-collect.mjs` → PHASE table shows `blocked_on_lane` at ~3.8%
   of accounted time, with ~1027 h swept into idle.
2. `npm run usage` → "OUR OWN SPEND · last 7d" bucket ≈ $2665, because a 36-day
   session's entire cost lands in 7d by its `ended_at`.
3. A charter whose first line is `Dispatch: ticket=none …` → the collector lists
   `rejected in a declaration: ticket=none (not a ticket id)`.

## Root cause (measured, not guessed)

1. `attributePhases()` charges each inter-row interval to the phase of the tool
   call spanning it, and sends any interval > `idleGapMs` (5 min) to idle. An
   `Agent` dispatch is **asynchronous**: the tool returns instantly with a task
   id (measured Agent tool span = **0.082 h across 619 calls**), so there is no
   tool span to charge. The real wait is the inter-turn gap between the dispatch
   and the `<task-notification>` that reports the lane back — median **10.6 min**,
   and **415 of 535** such waits exceed the 5-min cutoff, so they were booked as
   idle.
2. `usage.mts ownSpend()` bucketed a **whole lane's** cost into the window
   containing its `ended_at`. Short lanes rarely straddle a window (so 5 h / 24 h
   were roughly right), but the 36-day orchestrator session dropped all $2088 into
   "last 7d".
3. `declValue('ticket')` in `cost-model.mjs` validated every token against the
   ticket-id regex and pushed `none` to `rejected`. The grammar had no legal token
   for a declared absence, so "no ticket" was indistinguishable from a malformed
   typo and from never having declared.

## Expected

1. Pair each `Agent` `tool_use` id to the `task-notification` that resolves it;
   the interval between them is dispatch-outstanding time, EXEMPT from the idle
   rule. Report occupancy as the UNION of outstanding intervals (parallel lanes
   are one occupied hour, not two) and parallelism = summed-wait ÷ union.
2. Attribute each request's cost to the window containing THAT request's
   timestamp; prorate any timestamp-less rows across the lane span and say so.
3. Accept `none` as a VALID declared value distinct from `undeclared`; report the
   three states separately (declared-with-ticket / declared-none / undeclared).

## Context pack

- Files/functions in play:
  - `scripts/lib/cost-model.mjs` — new `pairDispatches`, `dispatchOccupancy`,
    `mergeIntervals`, `laneRequestCosts`; `attributePhases` now exempts
    outstanding waits from the idle rule; grammar `declValue`/`parseDispatchDeclaration`/
    `resolveLaneAttribution` accept the `ticket=none` sentinel (`ticket_none`).
  - `scripts/cost-collect.mjs` — `buildLane` attaches per-lane `dispatch`
    occupancy + in-memory `request_costs` (stripped before ledger append and from
    `--json`); `rollUp` adds a fleet `dispatch` aggregate + `coverage.ticket_none`;
    report prints an ASYNC DISPATCH OCCUPANCY section and the three-state coverage.
  - `scripts/usage.mts` — `ownSpend` bins per request timestamp with proration.
- Repro test: `node scripts/verify-bug-175.mjs` (33 checks, must-FAIL proofs +
  real orchestrator transcript). Existing `npm run verify:cost-collect` still 62/62.
- Related tickets: FEAT-086 (the cost collector), FEAT-100 (the Dispatch grammar),
  FEAT-119 (`npm run usage`), ARCH-017 (the lane ledger — separate, still empty).
- Known dependencies: full CLI `dispatch.mjs --ticket none` support needs a
  one-line change in `scripts/dispatch.mjs` (in-flight WIP by another lane, out of
  scope here) — see handoff.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-08 — worker (fixing, round 1, class fix)

- **Understood:** the three defects from `_scratch-orchard-telemetry.md` §5.1/§5.2/
  §5.4, with the reference session `87564f3e` numbers as the known-good oracle.
- **Changed (unstaged):**
  - `scripts/lib/cost-model.mjs` — added `pairDispatches`, `dispatchOccupancy`,
    `mergeIntervals`, `laneRequestCosts`; reworked `attributePhases` to charge the
    dispatch-outstanding portion of a >idle gap to `blocked_on_lane` (partition
    sum invariant preserved); added the `ticket=none` sentinel path through
    `emptyDecl`/`declValue`/`parseDispatchDeclaration`/`resolveLaneAttribution`.
  - `scripts/cost-collect.mjs` — per-lane `dispatch` + `request_costs`, ledger/
    `--json` stripping of `request_costs`, fleet `dispatch` aggregate,
    `coverage.ticket_none`, the ASYNC DISPATCH OCCUPANCY report section, and the
    three-state coverage line.
  - `scripts/usage.mts` — per-request window binning with proration + a note.
  - `scripts/verify-bug-175.mjs` — new proof suite.
- **Verified (fixer's own run — necessary, not sufficient):**
  - `node scripts/verify-bug-175.mjs` → **ALL PASS: 33 passed, 0 failed**, with
    must-FAIL proofs that redden against synthesized pre-fix rules for all three
    defects, plus real-transcript checks.
  - **DEFECT 1, reference session `87564f3e` through the FIXED collector:** 619
    dispatches, 584 paired · engaged wall **123.0 h** · outstanding union
    **105.3 h = 85.6% occupancy** · parallelism **1.53×** · wait median/p90/max
    **10.1 / 29.0 / 573.4 min**. (Scratch oracle: 84.0% / 1.52× / 10.6 / 29.7 /
    573.4 — within a few points on every axis, and nowhere near the old 3.8%.)
    Real-data must-fail: the Agent TOOL span the old metric could see is **0.082 h**
    across 619 dispatches vs **105.3 h** truly outstanding.
  - **DEFECT 2, real orchestrator lane, 7 d anchored at lane end:** per-request
    **$180.82** vs whole-lane-by-end **$2088.07** (11.5× over-report) — same
    direction and magnitude as the scratch's $645 vs $2665.
  - **DEFECT 3:** `ticket=none` → `ticket_none:true, tickets:null`, zero
    complaints; live report now shows "52 declared ticket=none (ticketless BY
    DESIGN — not a gap)" and `ticket=none` is gone from the rejected list (the
    remaining `ticket=<file`/`<none`/`<scrub`/`<the` are genuinely malformed).
  - `npm run verify:cost-collect` → **62 passed, 0 failed** (anti-regression).
  - `npm run gate` → **FAIL, typecheck** — but all 8 tsc errors are in
    `src/server/dispatch-broker.ts`, another lane's in-flight WIP that I never
    touched (`npx tsc` shows zero errors in any file I changed). leak-gate and
    check-nul PASS. My files are type-clean; the gate FAIL is not attributable to
    this ticket.
- **Verified-by:** PENDING — clean-room dispatch required before VERIFIED. This is
  session-lifecycle-adjacent measurement code that drives park/go and
  intervention decisions; an independent verify pass (`scripts/independent-verify.mjs`)
  should re-derive the reference session's occupancy from the raw transcript and
  confirm the per-request 7-day figure, not trust this fixture.
- **Still open / handoff:**
  1. Independent clean-room verification (above).
  2. `dispatch.mjs --ticket none` (CLI path) still dies at its round-trip check
     because it compares `(back.tickets ?? []).join(',')` to `'none'`; with
     `tickets` now null for the sentinel that comparison fails. It died BEFORE this
     fix too (the grammar rejected `none`), so this is not a regression — but full
     CLI support wants a one-line change in `scripts/dispatch.mjs` (another lane's
     WIP) to read `back.ticket_none`. The primary defect (in-process charters
     writing `ticket=none` in prose) is fully fixed. Handoff to whoever owns
     dispatch.mjs.
  3. Occupancy pairing requires `<status>completed</status>`; 35 of 619 reference
     dispatches were unpaired (interrupted / still-outstanding at end) and are
     reported as `unpaired`, not fabricated. Fleet-wide across small lanes this is
     larger (207/842); that is honest, not a bug.
- **Symptom of a deeper design flaw?** open — leaning **yes**: the same shape
  recurs (`blocked_on_lane`, `usage`, the grammar each independently guessed a
  fact the async-dispatch/request-timestamp/declaration OWNER already knew), which
  is the ARCH-010 "whoever owns a fact writes it down" class. Not filing an ARCH
  ticket unilaterally; flag for the orchestrator to decide at close.
