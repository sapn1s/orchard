```orchard-ticket
{
  "id": "BUG-124",
  "type": "bug",
  "title": "Board checks went red when tickets were used correctly",
  "summary": "Standing board checks kept failing after ordinary, correct board use, though no ticket was broken. Reopened when the format cutover this ticket anticipated reddened four more suites: the first pass fixed the two instances in front of it and never generalised. All six now grade the property at runtime, and each still fails on a real violation.",
  "impact_if_we_wait": "Red checks that name healthy tickets teach people to ignore the checks, and the format migration did arrive under a wall of failures — 180 of them across four suites, none a product defect. Bounded: this is a checking-suite fault only, with no production code and no ticket content affected.",
  "current_need": "Treat the ticket as closed again: all six corrected checks pass, each was shown to still fail on a constructed violation, and the neighbouring board checks stayed clean.",
  "severity": "medium",
  "area": "Board tooling",
  "reported": "2026-08-20",
  "reported_by": "orchestrator",
  "owner": "agent",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-20",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Every check stays green when a ticket is promoted to the record format",
    "Every check stays green when a status line is corrected from its own evidence",
    "A board with every ticket promoted produces no failures",
    "Every check still fails on a genuine property violation",
    "No check pins a location the migration is free to move, or a population correct use is free to empty",
    "A check whose population empties says so loudly rather than passing on nothing"
  ],
  "code_refs": [
    {
      "path": "scripts/verify-bug-125-wrapped-verdict.mjs",
      "symbol": null,
      "note": "asserted docs/bugs held the verbatim originals and that no archive/ existed; both were pinned pre-cutover LOCATIONS. Replaced by the traceability property itself, checked against source.archived_path"
    },
    {
      "path": "scripts/verify-migrate-tickets.mjs",
      "symbol": null,
      "note": "used !exists(docs/bugs/archive) as a stand-in for 'a refused promotion moved nothing'; now snapshots docs/bugs whole and diffs it"
    },
    {
      "path": "scripts/verify-bug-123-record-status-cell.mjs",
      "symbol": null,
      "note": "three pinned populations: every promoted ticket assumed Open, every promoted ticket assumed decision-bearing, and a >=10 legacy-Open-row floor the two-legacy-ticket design made unsatisfiable"
    },
    {
      "path": "scripts/verify-ticket-writing-contract.mjs",
      "symbol": "ORIGINALS",
      "note": "the must-FAIL corpus was addressed as docs/bugs, so the cutover silently re-aimed it at the contract's own output; now docs/bugs/archive, with a guard that the corpus is prose"
    },
    {
      "path": "scripts/verify-ticket-schema.mjs",
      "symbol": null,
      "note": "built its corpus from the prose Status line, so a promoted ticket arrived with an empty status; its done-flag comparison also mirrored the pre-BUG-122 read path"
    },
    {
      "path": "scripts/verify-bug-119-verification-evidence.mjs",
      "symbol": null,
      "note": "asserted three facts about the live contested set, which resolving a claim legitimately changes"
    },
    {
      "path": "scripts/verify-unmappable-status.mjs",
      "symbol": null,
      "note": "worked precedent for the same narrowing"
    },
    {
      "path": "src/server/tickets.ts",
      "symbol": "parseTicket",
      "note": "reads the parsed summary's done flag since BUG-122, not the prose status"
    },
    {
      "path": "docs/CONVENTIONS.md",
      "symbol": null,
      "note": "names the failure of asserting on a value that legitimate use changes"
    }
  ],
  "related": [
    {
      "id": "BUG-122",
      "relation": "depends_on"
    },
    {
      "id": "BUG-119",
      "relation": "see_also"
    },
    {
      "id": "ARCH-009",
      "relation": "see_also"
    },
    {
      "id": "FEAT-062",
      "relation": "see_also"
    },
    {
      "id": "FEAT-061",
      "relation": "see_also"
    },
    {
      "id": "BUG-109",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-124-suites-redden-when-a-ticket-is-promoted-or-a-verdict-recorded.md",
    "sha256": "7a03b190c12dad2473e7f93de6df37114740fabb3a6ef4d883b52e564def9183",
    "bytes": 9557,
    "original_title": "Board checks fail when a ticket is promoted or a verdict recorded",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head section by section; the symptom, repro, both diagnoses, the rehearsed 193-failure cutover measurement, the precedent and the named tickets are all present.",
    "dropped": [
      "the numbered repro steps, restated as prose in the verification plan",
      "the Context pack heading, whose contents moved into code_refs and related"
    ]
  }
}
```

# BUG-124 — Board checks went red when tickets were used correctly

## Diagnosis

Both suites asserted on values that correct use of the board changes.

`verify-ticket-schema.mjs` built its entire corpus from the prose `- **Status:**` line. A promoted ticket has no such line, so it arrived as `statusRaw: ""` and failed a check about statuses — reported as `ARCH-005:""`. One line below, the same defect sat unnoticed: `apiDone` was computed with `isDoneStatus(statusRaw)` and labelled as the way `tickets.ts` reaches it, but `tickets.ts` has read `parseTicket(…).summary.done` since BUG-122. At the migration cutover that would have produced a three-way disagreement between `board.mjs` and an API that never disagreed.

`verify-bug-119-verification-evidence.mjs` asserted three facts about the live contested set: that every ticket a deleted derivation mis-derived is contested, that both kinds of conflict occur on the real board, and that every fold disagreement is stopped. All three are functions of what tickets currently claim, and resolving a claim is exactly what the gate exists to cause. The evidence arm had one live instance; a person resolved it correctly on 2026-08-20 and the suite reddened.

## Evidence

`verify:ticket-schema` went from 57/58 to 63/63, and the all-promoted board was rehearsed and measured at 193 unmappable failures before the change. `verify:bug-119-evidence` went from 115/118 to 121/121, with 121/121 recorded on the corrected run. Neighbouring suites stayed clean: `verify:board-tool` 34/34 and `verify:bug-122` 71/71.

The three status lines corrected on 2026-08-20 — FEAT-061, BUG-109 and FEAT-062 — landed in `3288342`; they were corrected from each ticket's own verdicts, which is what took those tickets out of the contested set.

## Implementation notes

No production code changed. The defect is in what the suites assert, not in what they assert it about. `verify-unmappable-status.mjs` took the same narrowing for the same reason under BUG-122: its `board:gen` comparison now excludes a promoted ticket's own row, prints every differing row, and still fails on churn to a legacy row.

## Verification plan

Promote a ticket to the record format, or correct a status line from its own verdicts, then run both suites and expect green. Rehearse a board where every ticket is promoted and expect no unmappable failures. Introduce a genuine property violation and expect each suite to fail on it.

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

### 2026-08-20 — REOPENED by the cutover this ticket was written for

- **What happened:** the schema cutover landed (`f109aa8`, 194 tickets promoted,
  originals moved to `docs/bugs/archive/`) and four MORE suites went red — 180
  failures, not one of them a product defect. `regressed-from: BUG-124` — its own
  fix. The first pass corrected the two suites that were red in front of it and
  then closed, treating a general class as two instances; the entry above even
  names the cutover as the thing it was protecting against. It did not go looking
  for the same fault in the suites that were still green, so the failure that was
  predicted arrived anyway.

- **Understood — one class, two shapes.** Every one of the four pinned something
  the cutover was ENTITLED to change:
  - a pinned LOCATION. `verify:bug-125` asserted `!exists(docs/bugs/archive)` and
    that every ticket file was pre-migration prose; `verify:migrate-tickets` used
    `!exists(archive)` as a stand-in for "the refused promotion moved nothing";
    `verify:ticket-writing`'s must-FAIL corpus was addressed as `docs/bugs`. The
    last is the dangerous one: it did not merely go red, it silently RE-AIMED the
    negative corpus at the contract's own output, so the check kept running while
    measuring the opposite of what it meant. It failed only because separation
    collapsed to 138/198 — had the rules been a little more permissive it would
    have gone green having inverted itself.
  - a pinned POPULATION. `verify:bug-123` graded all 194 promoted tickets as if
    each must have an Open row (166 are legitimately done), asserted every
    promoted ticket carries decision wording (9 have no decision), and required
    `>= 10` legacy Open rows when the cutover left two legacy tickets by
    decision — a floor the design forbids ever meeting again.

- **Changed:** no production code. Each pinned value was replaced by the property
  it stood in for, and none was deleted as vacuous — every one had a real
  property behind it.
  - `verify-bug-125-wrapped-verdict.mjs`: the two location checks became five
    traceability checks read off `source.archived_path` — the archived original
    exists, its bytes still hash to the `source.sha256` the record derives from,
    it is prose rather than a migrated copy, one ID resolves to one live file,
    and no record half-declares its origin. This is strictly stronger than what
    it replaced: ARCH-005's actual defect (an "original" that was really a
    migrated copy, with a hash regenerated to match it) passes the sha check and
    is caught only by the prose check.
  - `verify-migrate-tickets.mjs`: `docs/bugs` is snapshotted whole — every file,
    recursively, by content — and diffed after the refusal. The old check watched
    three named tickets plus the archive's absence, so a refusal that corrupted
    any of the other 195 files was invisible to it.
  - `verify-bug-123-record-status-cell.mjs`: the population is discovered, not
    assumed, and the "not flattened" claim is anchored to `boardStatusFromHeader`
    — the live pre-change rule — rather than to decision wording. Four coverage
    assertions keep the discovered population from quietly becoming
    uninteresting, and section C now grades a declared-synthetic legacy row
    alongside the real one so the property survives the last legacy ticket
    closing.
  - `verify-ticket-writing-contract.mjs`: `ORIGINALS` is `docs/bugs/archive`,
    overridable via `TICKET_ORIGINALS_DIR`. Two new guards close the holes the
    re-aim exposed: the corpus must contain no record block (it is prose, not
    output), and an empty corpus fails loudly instead of satisfying
    `bad.length === originals.length` as `0 === 0`.

- **Verified** — counts are honest; every suite was run to completion and its
  exit status read directly.
  - `verify:bug-125` 43/2 → **49 passed, 0 failed**, exit 0.
  - `verify:migrate-tickets` 52/1 → **53 passed, 0 failed**, exit 0.
  - `verify:bug-123` 125/302 (177 failures) → **325/325**, exit 0. Note the count
    ROSE: fixing section B revealed two further pinned populations in sections C
    and F that the 177 failures had been masking.
  - `verify:ticket-writing` 1 failure → **ALL CHECKS PASS**, exit 0, on 194/194
    originals violating with all five rules firing.
  - MUST-FAIL, every one against a SYNTHESIZED broken state in a scratch copy of
    the tree, never against `HEAD`:
    - bug-125: archived original deleted → "still exists" fails; its bytes edited
      → "VERBATIM … hash" fails; **the archive replaced by the migrated copy with
      the record's sha256 regenerated to match** → only "no record is its OWN
      archive" fails, which is ARCH-005's exact shape and the case a hash check
      cannot see; a duplicate live file → "exactly ONE live file" fails; sha256
      nulled → "half-declares" fails; all `archived_path` nulled → "there ARE
      migrated records to trace" fails.
    - migrate-tickets: the refusal path patched to write `archive/ARCH-005-leaked.md`
      → "untouched" fails with `added archive/ARCH-005-leaked.md`, while the
      sibling check "REFUSES … and moves nothing" still PASSED — the new check
      catches what the old one could not. Patched to append to `BUG-001`, a
      ticket the run never names → fails with `modified BUG-001-…`.
    - bug-123: every promoted ticket closed → the population guard and all four
      coverage guards fail (0 gradable) instead of reporting a green 15/15;
      `gen` patched to compose a cell for legacy tickets → section C fails on
      both the real row and the synthetic one; `gen` patched to flatten promoted
      cells → section B and the section F anchor both fail.
    - ticket-writing: corpus pointed at `docs/bugs` → the record-block guard
      fires and names the file, reproducing the cutover regression on demand;
      empty corpus → fails loudly where the old code passed on `0 === 0`; one
      constructed CLEAN original added to the 194 real ones → "only 194/195
      violate; the rules do not discriminate".
  - Anti-regression: `npm run board:check` OK, no drift; `npm run gate` PASS
    (exit 0, read directly, never piped).

- **Could not verify:** section E of `verify:bug-123` shells out to
  `verify-unmappable-status.mjs` and needs a git repo, so it fails in the
  exported scratch copy used for the must-FAIL runs. It passes in the real tree
  and was not touched; the must-FAIL evidence for sections B, C and F is
  unaffected by it.

- **Symptom of a deeper design flaw?** Yes, and it is already filed — ARCH-009,
  plus the rule in `docs/CONVENTIONS.md`. What this round adds is that the class
  has a SECOND shape nobody had written down. The convention says "do not assert
  values legitimate use changes", and every prior instance was a value. These
  four were a pinned LOCATION and a pinned POPULATION, which read as structural
  facts rather than as values, which is exactly why four suites carried them past
  a review that was specifically looking for this class. Worth a line in
  `docs/CONVENTIONS.md` if it recurs a third time; not filed as new today,
  because ARCH-009 is open and unanswered and a fourth container would split the
  decision rather than inform it.
</content>
</invoke>
