# ARCH-009 — a ticket's verification state is computed from text the pipeline cannot attribute and does not read whole

- **Status:** FIXED — decided (C, gated by A) and built 2026-08-20; independent clean-room verification outstanding. `verification_state` no longer exists: the derivation is deleted, the field is off the record schema, and the one pass where verdicts still have to be read out of prose STOPS on contested evidence instead of guessing. 4 of 192 real tickets are contested and quarantined.
- **Severity:** high — not for the board's current state, but for what the migration is about to write. Two real tickets (`FEAT-061`, `FEAT-062`) are mis-derived at the reviewed revision `c0e4257` with no uncommitted state involved, and the migration would write that answer into 195 files in one pass.
- **Area:** ticket migration — how `verification_state` is decided
- **Reported:** 2026-08-20, by the BUG-119 fix lane, on the explicit instruction of a third clean-room verdict (`dispatch openai run 01a01bda-0005-7a83-95d0-a7452f81eb92`) to answer the §N recurrence question before building a fourth guard.
- **Recurrence evidence:** BUG-119 rounds 1, 2 and 3 — three consecutive stop-everything defects in `deriveVerificationState`/`verificationStateFrom`, each found by an independent clean-room pass and never by the fixer.

## Violated invariant

**`verification_state` must be a function of the evidence a ticket ASSERTS, taken
whole: adding text the ticket does not assert, or a record that resolves nothing,
must never change the state.**

That is testable directly, and metamorphically — which is the point, because it
does not require knowing the right answer for any particular ticket:

- append a quoted `Verified-by:` line inside a worked example → state unchanged;
- append a record that supersedes nothing (an `invalid`) → state unchanged;
- reorder records that do not change what is outstanding → state unchanged.

All three rounds below are different ways of breaking that one sentence.

## The design that produces this class

`verification_state` is computed by a **sequence of precedence guards over a lossy
summary of an untrusted set**. Three separate weaknesses compound:

1. **The evidence set is unattributed.** `extractVerificationRecords` regex-scans
   the whole file for `Verified-by:` lines. A line the ticket *quotes* — a worked
   example, a pasted excerpt, a template being explained — is indistinguishable
   from one it *asserts*. Fence-awareness cannot rescue this: measured over 195
   real tickets, a CommonMark-correct strip drops 8 genuine verdicts from
   `FEAT-091` (`plain=67, strict=59, language-token=62`), because that document
   nests fences the spec closes early. **Confirmed independently and settled** —
   the extractor cannot be made attribution-aware by parsing.
2. **The set is then read partially.** `verificationStateFrom` returns a value
   derived from the LAST record only. Everything before it is discarded before
   any precedence rule runs.
3. **The rules are a discovered sequence, not a stated function.** Each round
   added a guard for the route the previous round left open, so the rules are
   ordered by the history of their discovery rather than by any property.

The compounding is what makes this a class rather than three bugs: guard (2) from
round 3 — "`broken` outranks every claim" — is only sound if the set is
attributed, and guard (1) from round 3 — "only the status line grants `holds`" —
is only sound if the set is read whole. **The two guards now pull in opposite
directions and both are absolute**, which is why round 3's fix for one created
round 3's defect in the other.

## Why local patches did not hold

| Round | What it patched | What it left reachable |
|---|---|---|
| 1 | Derived the state from `Verified-by:` records only, ignoring the status line — so 121 VERIFIED tickets read `not_recorded`. Added the status line as a source. | A `holds` verdict on a REOPENED ticket still claimed proof for code that had changed. |
| 2 | Demoted a record-derived `holds` on an unfinished ticket. | The status line returned BEFORE the verdicts were consulted, so a VERIFIED ticket with a newer BROKEN verdict claimed `holds` — live on `BUG-109`. |
| 3 | Made `broken` unconditional and first; made the status line the only route to `holds`. | (a) `broken` is suppressed by any trailing non-`broken` record, because only the LAST record is read — **live on `FEAT-061` and `FEAT-062`**; (b) a QUOTED `VERDICT: BROKEN` now fabricates `broken` on a verified ticket, a direct consequence of making the first guard absolute. |

Every patch was correct for the route it addressed. That is the test §N names, and
it is met: the design is wrong, not the fixes.

## Measured, at `c0e4257`, clean checkout, ARCH-005 excluded

- 13 tickets carry verification records at all.
- 10 have an outstanding `broken` under the whole-set predicate ("a `broken` with
  no later `holds`").
- **2 are mis-derived today** — the last-record fold disagrees with the whole-set
  predicate on `FEAT-061` (`broken,broken,broken,invalid,invalid,invalid,invalid`)
  and `FEAT-062` (`broken,broken,invalid,broken,invalid`). Both derive `holds`
  while carrying an unresolved `broken`. `invalid` is a legal verdict
  (`VERDICTS`, `scripts/lib/ticket-schema.mjs:111`) and the normal outcome of a
  clean-room run that fails its contract, so this is an ordinary occurrence, not
  an exotic one.
- The number of tickets a human would have to adjudicate under option A is
  therefore **2 today, 13 at most** — the cost of asking is small and known.

## Decision — should the pipeline refuse to guess, restate the rule, or stop deriving this at all?

- **A — Quarantine the ambiguity; the migration asks rather than guesses.** The
  pipeline computes the state as now, but any ticket where the evidence is
  CONTESTED — the status line disagrees with the whole-set verdict predicate, or
  a record's attribution is uncertain — is routed to the existing quarantine path
  with the conflict named, and migrates only after a human resolves it. Costs one
  new gate on a path that already exists, plus a human pass over the contested
  tickets (2 today, ≤13 ever). Buys: a wrong answer becomes a stopped migration
  instead of a silent field in 195 files, and the class stops being able to ship.
  Gives up: a fully unattended migration run.
- **B — State the rule once, as a function of the whole set, with metamorphic
  tests.** Replace the guard sequence with one declarative rule over all records
  (an outstanding `broken` is "a `broken` with no later `holds`", never "the last
  record"), and enforce the three metamorphic properties above as the suite.
  Costs a rewrite of the derivation plus a property harness. Buys: the
  read-partially half of the class is gone by construction and the rules become
  auditable in one place. Gives up: nothing structurally — but attribution is
  untouched, so a quoted verdict still lies, and that is a documented permanent
  limit rather than a fixed defect.
- **C — Stop deriving it; carry the evidence and let the record hold facts.**
  `verification_state` ceases to be computed. The migration transcribes only what
  the ticket itself states, and the verdicts live in the record block as data, so
  after migration `verification[]` is the attributed source and no scraper decides
  anything. Costs: consumers that filter or sort on the state need rework, and it
  overlaps ARCH-008's question about who owns the record block. Buys: the class
  becomes impossible rather than guarded. Gives up: a cheap "show me broken
  tickets" until a consumer re-derives it — from attributed data, correctly.
- **D — Keep patching.** Priced honestly: three rounds, three stop-everything
  defects, each found only by an independent clean-room pass and none by the
  fixer or by 98 self-written checks. Round 3's two guards are already in mutual
  conflict, so a fourth guard must weaken one of them. Expected cost: another
  round, and the fifth guard interacting with the first four.

## Migration path

Landable in this order; each step is independently verifiable and none blocks the
board:

1. **Do not run the migration to completion** until an option is chosen. Sample
   runs are fine; a full pass writes the contested answer into every file.
2. **B first if B or A is chosen** — the whole-set predicate is a strict
   improvement under every option and is the smallest change: it removes the
   `last record` fold and adds the three metamorphic tests. Rollback is a revert;
   nothing else reads `verificationStateFrom`.
3. **Then A** — add the contested-evidence gate to the existing quarantine path,
   which reports rather than decides. Run it over the corpus and publish the list
   (expected: 2).
4. **C, if chosen, lands after the migration** and is a consumer change, not a
   pipeline change: it deletes the derivation and moves the question to whoever
   renders the board. It should be sequenced with ARCH-008, which is deciding who
   owns the record block that C would make authoritative.

Throughout: `extractVerificationRecords` and `provenance-check.mjs`'s mirror stay
byte-compatible, so the "two readers, one contract" property is not disturbed by
any option.

## Proof bar — what would have to be true to call the new design right

- The three metamorphic properties hold as EXECUTABLE tests over the real corpus:
  appending a quoted verdict, appending an `invalid`, and reordering
  non-decisive records each leave every ticket's state unchanged. None of these
  could have passed before — round 3 fails all three.
- No rule about `verification_state` exists outside one named function, checkable
  by grep, so a future guard cannot be added in a second place.
- The contested list is non-empty on today's corpus (it is: `FEAT-061`,
  `FEAT-062`), so the gate is proven non-vacuous on real data rather than on a
  fixture.
- A clean-room pass that has not seen this ticket attempts the same class —
  "find a third route by which text in a file becomes a claim the ticket did not
  make" — and fails.

**What would falsify this redesign:** if the contested set turns out to be large
(say >25 of 195), option A is not a gate but a wall, and the honest reading is
that the corpus cannot support a derived state at all — which is option C, and
this ticket should be re-decided rather than patched. Equally, if a fourth defect
in this class appears in a component OUTSIDE `deriveVerificationState`, then the
class was mis-drawn here and the real invariant is about attribution across the
whole extraction layer, not about this one field.

## Decision record

- **Chosen option:** **C, gated by A for the one-time migration pass.** Decided by
  the user on 2026-08-20, on the instruction to pick what is best long-term
  regardless of cost.
- **Explicitly rejected:** **D**, on its own price — three rounds, three
  stop-everything defects, none found by the fixer, and round 3's two guards
  already in mutual conflict, so a fourth guard had to weaken one of them.
  **B as a separate build**, because a declarative rule over scraped text still
  lets a quoted verdict lie; C removes the scraping decision instead. B's
  *content* is not rejected and is recorded below so it is not lost.

**Why C is the destination.** `verification_state` stops being computed. The
migration transcribes only what the ticket itself states, the verdicts live in
the record block as attributed data, and no scraper decides anything afterwards.
That makes the class impossible rather than guarded.

**Why A gates it.** C removes derivation *after* migration, but the migration
itself must extract verdicts out of prose exactly once, and that extraction has
the attribution problem C is designed to end. So any ticket whose evidence is
CONTESTED routes to the existing quarantine path with the conflict named, and
migrates only after a human resolves it.

**B's surviving content — the rule any future consumer uses.** "Show me the
broken tickets" is re-derived from attributed `verification[]` data by this rule
and no other:

> **An outstanding `broken` is a `broken` with no LATER `holds`** — never "the
> last record".

It lives in exactly one place, `outstandingBroken()` in
`public/lib/ticket-record.js`, and is the fold both the migration gate and the
ticket view use. A second rule about proof appearing anywhere else is this class
coming back.

## What landed (2026-08-20)

- **Deleted:** `deriveVerificationState` and `verificationStateFrom`
  (`scripts/migrate-tickets.mjs`); `verification_state` from `REQUIRED_KEYS`,
  from the schema's enum check, and from the two cross-field rules that kept it
  coherent with `verification[]` (`scripts/lib/ticket-schema.mjs`); the field
  from the prompt's schema contract, its worked example, its CONSEQUENCES block
  and its return-key list; `VERIFICATION_LABEL` and the `verificationState` view
  field (`public/lib/ticket-record.js`); three of the four hero proof pills
  (`public/app.js`, `public/styles.css`).
- **Added:** `contestedEvidence(g, text)` — the gate, which answers "contested or
  not" and never "what the state is". Two conflicts: the Status line claims
  `holds` while an outstanding `broken` stands (3 tickets: `BUG-109`,
  `FEAT-061`, `FEAT-062`), or the fence-blind and fence-aware readings of the
  file disagree about which `Verified-by:` lines the ticket asserts (1 ticket:
  `FEAT-091`, 8 records). It runs BEFORE the dispatch, so a contested ticket is
  never sent to a model and the contested set is discoverable by a dry run.
- **Added:** `outstandingBroken()` — B's rule, one definition, both consumers.
- **Kept deliberately:** the LEGACY status-line classification
  (`LEGACY_STATUS_TABLE.verificationState`). It is a transcription of one
  authored word by one fixed table, not a derivation over an evidence set, and
  the gate needs it in order to have something to compare the evidence against.
  It is never written into a record.
- **The one compromise, stated rather than hidden:** `verification_state` is a
  RETIRED key — tolerated on a record already on disk (exactly one: `ARCH-005`),
  never required, never read, and stripped by `formatTicket` the moment anything
  rewrites that record. A hard rejection would have made a live board file
  invalid for a lane that may not edit it, and the queued full migration removes
  the leftover anyway. The WRITER paths all refuse it: `MODEL_KEYS` omits it,
  `compose` drops it, `grade` raises it as a violation by name.

**Measured on the live board, after the change:** 192 tickets, 18 carrying
verdicts, **4 contested (2.1%)** — well inside this ticket's own falsification
threshold of ">25 of 195 means A is a wall, not a gate".

## Proof bar — how it was met

- The three metamorphic properties run as EXECUTABLE tests over the real corpus
  (`scripts/verify-bug-119-verification-evidence.mjs` §10): appending a quoted
  verdict, appending an `invalid`, and reordering non-decisive records. Round 3
  fails all three, proven against a synthesized copy of its rule in §10b — never
  against `HEAD`, which would become the fixed state on commit.
- The contested list is non-empty on today's corpus and every ticket the two
  folds disagree about is quarantined rather than answered (§12), discovered at
  runtime rather than pinned to `FEAT-061`/`FEAT-062`.
- No rule about proof exists outside `outstandingBroken` — checkable by grep.
- Still outstanding: the clean-room pass attempting "find a third route by which
  text in a file becomes a claim the ticket did not make".

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-20 — BUG-119 fix lane

- **Understood:** a third clean-room verdict found a third stop-everything defect
  in the same function and required the §N question answered before any further
  guard. The invariant above is statable in one sentence and all three rounds
  break it, so this is a class and the answer is an ARCH ticket, not a fourth fix.
- **Changed:** nothing in the derivation. This ticket is the deliverable; per §N
  and the template, no build starts until a human picks an option.
- **Verified:** the two live mis-derivations were reproduced in a clean checkout
  at `c0e4257` (`git worktree --detach`), with no uncommitted state involved:
  `FEAT-061` and `FEAT-062` both carry an outstanding `broken` and both derive
  `holds`. Defect 2 (a quoted `VERDICT: BROKEN` flipping real `ARCH-003` from
  `holds` to `broken`) reproduced against the same revision.
- **Still open / handoff:** a human picks A, B, C or D. Until then the migration
  must not be run to completion — sample runs are fine and are how the prose half
  of BUG-119 is being verified.

### 2026-08-20 — ARCH-009 build lane (C, gated by A)

- **Understood:** the user chose C gated by A. The charter's hypothesis — "the
  consumers reading `verification_state` are few" — was checked FIRST and holds,
  with one correction worth recording: there are TWO different things called
  `verification_state`, and only one of them is this class. The MIGRATED
  record's field was derived from scraped `Verified-by:` lines (this ticket).
  The LEGACY reader's field is `classifyLegacyStatus` transcribing one authored
  Status word by a fixed table, which is not a derivation over an evidence set
  and was deliberately left alone — the gate needs it to compare against. The
  actual consumers of the derived field were four: the migration's own
  prompt/compose/grade, the schema's enum + two coherence rules, one hero pill
  in `public/app.js` via `VERIFICATION_LABEL`, and `blockSummary` in
  `scripts/lib/ticket-schema.mjs` (added by the concurrent BUG-122 lane while
  this was in flight). No filter and no sort read it.
- **Changed:** see "What landed" above. The UI question the charter flagged —
  "if a consumer would silently show wrong or empty state rather than degrade
  honestly, STOP" — was answered rather than skipped: dropping the pill outright
  would have left a VERIFIED ticket with an unresolved BROKEN showing nothing.
  So the hero now draws ONE proof pill, the loud one, from the record's own
  `verification[]` via `outstandingBroken()`; the three quiet pills are gone
  because they restated the work-state pill beside them and were computed by the
  thing that was wrong. Absence of proof is still STATED in the plan's own
  words, on the Proof card, which prints "Not recorded" and lists every verdict
  with its provider, run id and date. All three of the user's acceptance
  criteria are served: the model can no longer emit a proof field at all, the
  hero drops three pills, and a reader holds three orthogonal state fields
  instead of four.
- **Verified:** `verify:bug-119-verification-evidence` rewritten into C's
  properties and green at **118/118** (was 98 checks asserting the old
  behaviour, including a §12 that deliberately pinned the two defects as
  PRESENT; that section is now the same two cases inverted, on the same
  runtime-discovered donors). Every must-FAIL is anchored to a SYNTHESIZED copy
  of round 3's rule, never to `HEAD`. Non-vacuity, from the run's own output:
  round 3 mis-derives `FEAT-061 [broken,broken,broken,invalid,invalid,invalid,invalid] -> holds`
  and `FEAT-062 [broken,broken,invalid,broken,invalid] -> holds`, and both are
  now quarantined; a quoted `VERDICT: BROKEN` flipped real `ARCH-003` from
  `holds` to `broken` under round 3 and now stops the file instead; one
  `invalid` appended to real `ARCH-004` made round 3 report `pending` over an
  outstanding `broken`. The gate is driven END TO END through the real driver
  with a dispatch responder that records being called: the contested ticket is
  not staged, lands in `failed/` with the conflict named, the original is
  byte-identical, and **the model was never asked**. Anti-regressions run:
  `verify:ticket-schema` (57 passed, 1 pre-existing failure), `verify:migrate-tickets`
  (52 passed, 1 pre-existing failure), `verify:ticket-view-redesign` (238 passed,
  5 pre-existing failures — the same 5 the pre-change baseline shows in a
  detached worktree at `HEAD`). `npm run gate` exits 0.
- **Still open / handoff:** (1) an independent clean-room pass — this is a
  regression-prone file with a three-round history and generation must not be
  its own verifier; the attack to commission is ARCH-009's own proof bar, "find
  a third route by which text in a file becomes a claim the ticket did not
  make". (2) The 4 contested tickets need a human: `BUG-109`, `FEAT-061`,
  `FEAT-062` each say VERIFIED over an unresolved BROKEN; `FEAT-091` needs
  someone to say which of its 12 `Verified-by:` lines it ASSERTS. (3) The
  vestigial `verification_state` line in `ARCH-005`'s record — out of this
  lane's scope to edit, harmless (tolerated and unread), and removed
  automatically by the queued full migration. (4) A summariser gap found while
  rewriting the suite and reported rather than hidden: `summariseSelfEvidence`
  has no line for the PASS-MARKER-only shape, so `FEAT-028` has
  `hasSelfEvidence` true and an empty summary, and its prompt carries no
  evidence block. That is silence, not the denial BUG-119 was about, and it
  predates this lane.
