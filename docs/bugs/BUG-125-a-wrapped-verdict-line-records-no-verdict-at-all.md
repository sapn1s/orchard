# BUG-125 — a verification verdict written on a second line is recorded as no verdict at all

- **Status:** FIXED — the extraction reads a record as its list item's first paragraph, not its first line; 6 real records across 3 tickets change verdict. Independent clean-room verification outstanding.
- **Severity:** high — it silently records the wrong verdict. Three `VERDICT: BROKEN` records on `FEAT-061` were being transcribed as `invalid`, and the board would have kept that answer in a migrated record permanently.
- **Area:** ticket migration — how a `Verified-by:` record is read out of prose
- **Reported:** 2026-08-20 by the orchestrator, from `FEAT-062` quarantining on a conflict it did not have
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED

## Symptom

`FEAT-062` was quarantined out of the migration with a conflict it does not
contain: the checker reported `verification 78fb3b76…: verdict changed none →
holds` for a run the ticket records as HOLDS twice, consistently. The stop was
deterministic — a fresh dispatch produced byte-identical violations — and it
happened on both providers.

`FEAT-061` is the same defect without the stop, which is worse: three of its
independent verdicts read BROKEN in the file and `invalid` in the record, and
nothing anywhere said so.

## Repro

A `Verified-by:` line wraps. `formatVerifiedBy` emits one long line, but a
person writing the same record — or an editor reflowing it — puts the run id on
one line and the verdict on the next. `FEAT-062`, line 979:

```
- **Verified-by:** dispatch anthropic/sonnet run 78fb3b76-6bc3-41f0-81b0-737328e704cd (clean-room,
  `scripts/independent-verify.mjs`) — VERDICT: HOLDS
```

Both readers of these records — `extractVerificationRecords`
(`scripts/migrate-tickets.mjs`) and its deliberate mirror `extractVerifications`
(`scripts/provenance-check.mjs`) — scanned ONE PHYSICAL LINE for `VERDICT:`.
There is none on line 979, so the first recorded `invalid` and the second
recorded `none`. `FEAT-062` writes the same run id again at line 1006 unwrapped,
where both readers see HOLDS; `provenanceCheck` keys its reconciliation by run
id, the two readings of one run disagreed, and the ticket was stopped for
contradicting itself.

## Expected

A record's verdict does not depend on where the line happens to break. The two
readers agree, and a ticket is stopped only when it genuinely disagrees with
itself.

## What changed

`joinVerdictContinuation` (`scripts/lib/verdict-contract.mjs`, beside
`VERIFIED_BY_RE` and `formatVerifiedBy`, so the extractor stays the formatter's
inverse in one place). A record is its list item's FIRST PARAGRAPH: the head
line plus indented continuation lines that do not open something new — not a new
list item, heading, fence, blockquote, table row, or another `Verified-by:`
record, which is never swallowed into the one above it. A blank line ends it.
Both readers call it; neither reader's expression changed, so "two readers, one
contract" is preserved by construction.

**Absorption is bounded on purpose.** Joining is how text a ticket does not
assert could become a verdict it never wrote — precisely the class ARCH-009
exists to close. So the join STOPS at the first `VERDICT:` token: a record's own
sentence is complete once its verdict is in it, and nothing past that point can
change what the record says. Measured over all 196 real ticket files, the
bounded and unbounded joins return identical results, no record's paragraph
contains two different verdict words, and no record reads more than one
continuation line.

**Every record that changes verdict, on the real board** — 6, across 3 tickets,
all of them `invalid` (the no-verdict fallback) becoming what the ticket wrote:

| Ticket | Run | Was | Is |
|---|---|---|---|
| BUG-107 | `01a01633-9b3e-7302-ba61-efe7a13bed26` | invalid | broken |
| FEAT-061 | `e4a9d6c9-1e5f-42c3-ab99-23ece2c7949c` | invalid | broken |
| FEAT-061 | `1ab8fc96-609f-47a3-b80b-ac41db0dba54` | invalid | broken |
| FEAT-061 | `b281aae3-f037-4c40-9ce5-43209138bbc8` | invalid | broken |
| FEAT-062 | `87b38f59-732f-4f1b-9aec-56b6be262624` | invalid | broken |
| FEAT-062 | `78fb3b76-6bc3-41f0-81b0-737328e704cd` | invalid | holds |

No record count changed and no already-recorded verdict was rewritten.
`FEAT-061`'s seventh record stays `invalid` correctly — that line says "contract
INVALID (prose, 0 recorded runs)" and carries no `VERDICT:` token anywhere.

**A second, unrelated finding fixed here:** `--validate-set` reported 193/193,
but nothing checked that a staged record was graded against the file it NAMES.
`grade()` now compares `source.sha256` against the sha of the file it was handed
and fails loudly when they differ, saying every provenance result above it is
about the wrong pair of files. Before that check, one row of 193 was vacuous.

## Not fixed here, deliberately

- **`FEAT-091` stays quarantined.** Its contest is genuine: twelve of its verdict
  lines are its own, and a line in an old log entry begins with three backticks
  in wrapped prose, so the fence-aware and fence-blind readings legitimately
  disagree. A human says which lines it asserts.
- **`BUG-107` is now quarantined, and that is the gate working.** Its Status line
  says VERIFIED while it carries an independent BROKEN that no later HOLDS
  resolves — a real self-contradiction that was invisible only because the
  verdict was unreadable. `BUG-109` and `FEAT-061` had the same shape and were
  settled by correcting the Status word; this one needs the same decision. Note
  its verdict line is uncommitted working-tree work from another lane.

## Context pack

- Files/functions in play: `scripts/lib/verdict-contract.mjs`
  (`joinVerdictContinuation`, `isVerdictContinuationLine`),
  `scripts/migrate-tickets.mjs` (`extractVerificationRecords`, `grade`),
  `scripts/provenance-check.mjs` (`extractVerifications`).
- Related tickets: ARCH-009 (this is a defect in the one extraction its option C
  leaves standing, not in the derivation it deleted), BUG-119, FEAT-061,
  FEAT-062, BUG-107.
- Repro test: `npm run verify:bug-125`.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-20 — BUG-125 fix lane

- **Understood:** the charter's hypothesis — "join continuation lines onto their
  `Verified-by:` line, a continuation being an indented line that does not start
  a new list item or heading" — was tested against the real corpus BEFORE
  building, and holds. Of 70 `Verified-by:` lines in `docs/bugs/` and
  `docs/bugs/archive/`, 63 carry `VERDICT:` on their own line and 7 do not; 6 of
  those 7 are genuine wraps whose verdict sits on the immediately following
  indented line, and the 7th (`FEAT-061` line 514) has no `VERDICT:` token at
  all and is followed by a blank line, so joining reaches nothing. The wrap
  patterns are not more varied than the hypothesis says. The absorption hazard
  the charter named was measured rather than argued: with an unbounded
  paragraph join, four records absorb 5–18 lines of prose, so the join was
  bounded to stop at the first verdict — which returns identical results on
  every one of the 70 records and reads at most one continuation line.
- **Changed:** `scripts/lib/verdict-contract.mjs` (new
  `joinVerdictContinuation` + `isVerdictContinuationLine`),
  `scripts/migrate-tickets.mjs` (`extractVerificationRecords` reads the joined
  record; `grade` gains the `source.sha256` check),
  `scripts/provenance-check.mjs` (`extractVerifications`, the mirror half),
  `scripts/verify-bug-125-wrapped-verdict.mjs` (new suite). Restored the
  `ARCH-005` pair to its pre-cutover state: the verbatim original
  (`dd72a9ab…`) is back at `docs/bugs/`, the migrated copy (`82f4a47c…`) and the
  one-row `docs/bugs/archive/INDEX.md` are removed, and `docs/bugs/archive/` no
  longer exists. No ticket prose was edited. Committed as `5a64311`.
- **Verified:** `verify:bug-125` 44/44 — every ticket it exercises discovered at
  runtime, no id pinned, and it fails loudly if the corpus holds no wrapped
  record. Non-vacuity is anchored to a SYNTHESIZED copy of both pre-change
  readers inside the suite, never to `HEAD`: with that copy the pre-change
  provenance reader disagrees with the fixed migrate reader on 3 tickets, the
  two copies of `FEAT-062`'s duplicated run id read `["invalid","holds"]`, and a
  migrated file transcribing the pre-change verdicts is caught as a
  contradiction. Ten deliberately broken variants prove the join cannot absorb a
  new list item, blank line, heading, un-indented line, fence, blockquote, table
  row, later prose, or a second `Verified-by:` record. Three more prove the
  `source.sha256` check reddens on a wrong hash and on a missing one.
  Anti-regressions: `verify:migrate-tickets` **53/0** (was 52 passed / 1 failed —
  the failure was "promotion refusing left docs/bugs untouched", which asserts
  `docs/bugs/archive` does not exist, and the `ARCH-005` restore fixed it),
  `verify:provenance` 17/0, `verify:bug-119` 121/121, `verify:ticket-schema`
  63/0, `verify:ticket-view-redesign` 243/0, `verify:ticket-writing` all pass,
  `board:check` OK. `npm run gate` exits 0.
- **Re-staged**, `--force`, into the scratch staging dir
  (`~/scratch/ticket-migration/staged-final/`) with `--provider anthropic --model claude-opus-5`: `FEAT-062` migrated first
  attempt in 34s (it had been rejected twice on this defect), `FEAT-061`
  migrated on attempt 2 in 81s and now records `broken×6 + invalid`, where it
  recorded `broken×3 + invalid×4` before. `BUG-107` quarantined before dispatch
  at zero cost, and its stale staged record was removed so the set stays
  coherent. Two priced dispatches, $0.24 as the run reports it (that figure uses
  the GPT-5.6 price constants, so it is indicative, not billed). `--validate-set`
  193/193 with 2 quarantined (`BUG-107`, `FEAT-091`) — and `ARCH-005`'s row now
  grades against the original it names instead of against itself.
- **Promotion rehearsed on a full copy of the real corpus** in a throwaway git
  repo: 193 tickets promoted, the archived `ARCH-005` original byte-identical at
  `dd72a9ab…`, the generated `archive/INDEX.md` row correct, staging drained.
  Against a SYNTHESIZED pre-restore copy of the pair, `git mv` fails
  `fatal: destination exists` with exit 128 — the half-applied cutover this
  restore removes — and promotion now refuses that state earlier, on the
  `source.sha256` check, before moving anything.
- **Still open / handoff:** (1) an independent clean-room pass; this touches the
  surface that has produced three stop-everything defects and generation must
  not be its own verifier. The attack to commission: find a document shape where
  joining a continuation makes a record assert a verdict the ticket does not
  write — quoted or templated `Verified-by:` prose, a lazy-continuation list, a
  wrapped line inside a nested fence, CRLF or a lone CR (ARCH-006), and a
  wrapped record whose paragraph contains a second, different verdict word.
  (2) `BUG-107` and `FEAT-091` need a human. (3) `docs/bugs/INDEX.md` needs a row
  for this ticket — proposed below; the orchestrator owns that file.
- **Symptom of a deeper design flaw?** No new ARCH. It is ARCH-009's family and
  its own ticket says so: extraction happens exactly once, at migration, and
  this is a defect in reading a record rather than in judging one.
  `contestedEvidence` structurally could not catch it, because both readings
  were fence-blind and agreed with each other.

## Proposed INDEX row (orchestrator owns `INDEX.md`)

```
| [BUG-125](BUG-125-a-wrapped-verdict-line-records-no-verdict-at-all.md) | a verification verdict written on a second line is recorded as no verdict at all | FIXED | high | — |
```
