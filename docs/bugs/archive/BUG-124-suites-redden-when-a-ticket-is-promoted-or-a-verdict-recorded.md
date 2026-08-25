# BUG-124 — Board checks fail when a ticket is promoted or a verdict recorded

- **Status:** FIXED — both suites now assert the invariant instead of today's board. `verify:ticket-schema` 57/58 → 63/63, and would have been 193 failures at the migration cutover (rehearsed and measured); `verify:bug-119-evidence` 115/118 → 121/121. Independent clean-room verification outstanding.
- **Severity:** medium
- **Area:** Board tooling
- **Reported:** 2026-08-20 by orchestrator
- **Verification-class:** fix  ⟶ independent verification REQUIRED before VERIFIED

## Symptom

Two checks went red without anybody breaking anything.

`verify:ticket-schema` failed the moment the first ticket was promoted to the
record format: `(C) every real ticket's status maps to a work_state (1
unmappable) — ARCH-005:""`. One failure today. Rehearsed against a board where
every ticket is promoted — which is what the queued migration produces — the
same check reports **193 unmappable**, so the cutover would have arrived with a
wall of failures and no defect behind any of them.

`verify:bug-119-verification-evidence` read 115/118. Its three failures all
followed from a person doing the right thing: on 2026-08-20 three tickets' status
lines were corrected from their own evidence, the tickets stopped being
contested, and three checks that had pinned the contested set went red.

## Repro

1. Promote any ticket to the record format, or correct a status line that claimed
   a verification its verdicts do not hold.
2. `npm run verify:ticket-schema` / `node scripts/verify-bug-119-verification-evidence.mjs`.
3. Both report failures naming tickets that are in perfect order.

## Expected

Neither suite has an opinion about which tickets are promoted or which are
contested. Both discover the qualifying artifact at runtime, grade the property,
and stay green while the board is used correctly — while still failing on a
genuine violation.

## Diagnosis

Both suites read a value that legitimate use changes, which is the failure
`docs/CONVENTIONS.md` names.

`verify-ticket-schema.mjs` built its whole corpus from the prose `- **Status:**`
line. A promoted ticket has no such line, so it arrived as `statusRaw: ""` and
failed a check about statuses. The same defect sat unnoticed one line below:
`apiDone` was computed with `isDoneStatus(statusRaw)` and labelled "the way
tickets.ts reaches it", but `tickets.ts` has read `parseTicket(…).summary.done`
since BUG-122 — so at cutover the suite would also have reported a three-way
disagreement between `board.mjs` and an API that never disagreed.

`verify-bug-119-verification-evidence.mjs` asserted three facts about the LIVE
contested set: that every ticket a deleted derivation mis-derived is contested,
that both kinds of conflict occur on the real board, and that every fold
disagreement is stopped. All three are functions of what tickets currently
claim, and resolving a claim is exactly what the gate exists to cause. The
evidence arm had one live instance; a human resolved it, correctly, and the
suite reddened.

## Context pack

- Files in play: `scripts/verify-ticket-schema.mjs`,
  `scripts/verify-bug-119-verification-evidence.mjs`. No production code
  changed — the defect is in what the suites assert, not in what they assert it
  about.
- Worked precedent: `scripts/verify-unmappable-status.mjs` took the same
  narrowing for the same reason (BUG-122) — its `board:gen` comparison now
  excludes a promoted ticket's own row, prints every differing row, and still
  fails on churn to a legacy row.
- Related tickets: BUG-122 (promoted tickets read correctly), ARCH-009 (the
  proof state deleted), BUG-119 (self-evidence recovery), FEAT-061 / BUG-109 /
  FEAT-062 (the status lines corrected in `3288342`).
- Repro test: the two suites themselves.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-20 — fix lane

- **Understood:** both suites pinned values the board changes under correct use.
  Neither is vacuous-by-nature, so both were rewritten rather than deleted —
  each pinned value stood in for a real property.

- **Changed:** committed as `39c60c7`.
  - `scripts/verify-ticket-schema.mjs`. The corpus is now read through
    `parseTicket(…, { mode: 'auto' })` and split by FORMAT; the promoted ids are
    printed, never silently excluded. `(C)` became a TOTAL property — every
    ticket's `work_state` is determined, prose tickets by the legacy status
    table, promoted tickets by their own record — so promoting a ticket moves it
    between arms of the check instead of out of it. `apiDone` now uses
    `.summary.done`, the path `tickets.ts` actually uses. `(D)` and the
    narrow-rule comparison are claims about PROSE and are scoped to the prose
    half with the exclusion named; when the last legacy ticket is promoted they
    have no subject and say so in ONE loud failure carrying the remedy, rather
    than passing on an empty set.
  - `scripts/verify-bug-119-verification-evidence.mjs`. No check asserts which
    tickets are contested. Donors are discovered at runtime (any ticket whose
    verdicts leave a `broken` unresolved) and the conflict is DRIVEN onto their
    real prose — one status line rewritten, every other byte real, in the shape
    BUG-109 and FEAT-061 genuinely carried until `3288342`. Both arms of the
    gate are exercised that way; the live contested set is printed as context
    and graded only where the property is genuinely about it (ARCH-009's
    gate-not-a-wall proportion). §12 now asserts what the READER gets — where
    the two folds disagree the whole-set answer reaches `ticketView` and the
    verdicts arrive verbatim — with a disagreeing sequence constructible from a
    real ticket so the section can never be vacuous. §10d copies the board and
    drives the conflict onto the copy, so it no longer needs a live contested
    ticket and never writes to `docs/bugs`.

- **Verified:**
  - `node scripts/verify-ticket-schema.mjs` — 57 passed / 1 failed → **63/63**, exit 0.
  - `node scripts/verify-bug-119-verification-evidence.mjs` — 115/118 → **121/121**, exit 0.
  - CUTOVER REHEARSAL, since the headline claim is about a board that does not
    exist yet: a full copy of the real board with all 193 tickets promoted to
    valid records and their prose headers removed (the shape ARCH-005 really
    has). The pre-change corpus rule, transcribed rather than fetched from a
    revision, reports **193 unmappable**; the new rule reports **0**. Running
    the whole rewritten suite against that board gives 62/63 — one deliberate,
    self-explaining failure saying the prose-only guards have no subject left
    and naming the remedy.
  - MUST-FAIL, each against a SYNTHESIZED pre-change state in a scratch copy,
    never against `HEAD`:
    - evidence arm of `contestedEvidence` disabled → 116/121; the driven donors
      are "not stopped", ARM 1 reports 0/11, and 10d records that the model WAS
      dispatched.
    - gate keyed on the `broken` alone, ignoring the claim → 120/121; the
      discriminator fails on all 11 donors. This is the halt-everything
      direction, and it is now caught.
    - attribution arm disabled → 118/121; ARM 2 reports 0/193 flagged.
    - `ticketView` truncated to the last verdict → 119/121; §12 names
      `FEAT-061: view [invalid] outstanding=false vs ticket [broken,…] outstanding=true`.
    - a real promoted ticket given `"work_state": "nearly"` → `(C)` fails,
      naming `ARCH-005[promoted]`. The equivalent prose violation is asserted
      inside the suite itself by a probe that injects one of each kind into a
      copy of the real board.
  - LIVE DECOUPLING, unplanned and better than a test: while this ran, the other
    lane added BUG-123 to the board. Both suites absorbed it without reddening.
  - Anti-regression: `verify:board-tool` 34/34, `verify:bug-122` 71/71,
    `npm run gate` PASS (exit 0, read directly).
  - PRE-EXISTING RED, not caused by this change and left alone: `board:check`
    fails on `MISSING FROM BOARD: BUG-123` (the orchestrator owns INDEX), which
    cascades into 7 exit-code assertions in `verify:unmappable-status`; that
    suite's other 2 failures are its own HEAD-anchored staleness pair comparing
    `scripts/lib/ticket-schema.mjs` against an identical `HEAD` copy — the
    moving-baseline trap `docs/CONVENTIONS.md` describes, now realised.
    `verify:ticket-writing`, `verify:provenance`, `verify:arch-watch` and
    `verify:migrate-tickets` are red at `HEAD` with the same board.

- **Still open / handoff:** two follow-ups, neither blocking.
  1. At the migration cutover the prose-only guards `(D)` and the narrow-rule
     comparison lose their subject and fail loudly by design. Delete them then,
     or re-anchor them to a corpus snapshot pinned at the parser-collapse
     revision. The failure message says so.
  2. `verify:unmappable-status`'s stale-copy pair anchors its baseline to
     `git show HEAD:scripts/lib/ticket-schema.mjs`. That is the exact trap this
     ticket is about, in a third suite, and it is red today for that reason.

- **Symptom of a deeper design flaw?** Not filed as new. This is the third
  instance of the class ARCH-009 and `docs/CONVENTIONS.md` already name — a
  check that pins a value the product legitimately changes — and the standing
  remedy (discover the artifact, drive the value, assert the property) applied
  cleanly here without a structural change.
</content>
</invoke>
