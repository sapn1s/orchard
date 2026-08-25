# BUG-123 — regenerating the board erases what a promoted ticket's row was saying

- **Status:** FIXED (2026-08-20) — independent clean-room verification outstanding.
- **Severity:** medium. Nothing is destroyed in the ticket file and the loss is repairable by hand,
  which is what happened this time. It is not low because the erased cell is the one a person scans
  to see which decisions are waiting and what is recommended, and because the erasure is silent and
  arrives in a single pass over all 191 remaining tickets at cutover.
- **Area:** the board index — the Open table's Status cell (`board:gen`)
- **Reported:** 2026-08-20 by the orchestrator, from running `board:gen` for real after ARCH-005 was
  promoted
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED

## Symptom

Regenerating the board rewrote ARCH-005's Open row from

```
| ARCH-005 | … | 👤 | OPEN — NEEDS A HUMAN DECISION (4 options below). **No build starts until an option below is chosen.** Recommended: 3 — land the ratchet first, because it is the only option that produces the inventory the 1-vs-2 choice needs… | med |
```

to

```
| ARCH-005 | Projects can show another project's running activity | 👤 | OPEN | med |
```

The title improving is BUG-122's fix working. The Status cell lost the recommendation, the "no build
starts until a human picks" instruction, and the named consequence of delay — reduced to a word that
says nothing. The orchestrator reverted the regeneration and hand-edited the rows (`aebf332`), so the
board is correct today; hand-editing 191 rows is not an answer.

## Diagnosis

The Status cell is not preserved from `INDEX.md`. It is **re-derived on every `gen`** from the
ticket's own prose `- **Status:**` header (FEAT-068 item #1, `boardStatusFromHeader`), so that a
stale blurb cannot linger on the board. A promoted ticket has no prose Status header at all, so that
function received `''` and returned its empty-input default, the bare word `OPEN`.

This is the third surface where a promoted ticket degrades, and all three are one shape: something
reads prose that promotion deletes. BUG-122 fixed the first two (the readers, and the decision that
never reached the rail). This is the same defect, in the writer.

## The fix

`board:gen` composes a promoted ticket's Status cell from its record
(`boardStatusFromRecord`, `scripts/board.mjs`), and leaves every other ticket exactly as it was.

**The rule, chosen deliberately rather than by default** — the judgement the orchestrator asked to
have stated:

- a ticket **with a prose Status header** keeps that header, verbatim (whitespace collapsed, `|`
  escaped) — it is a human's curated sentence and regenerating must not paraphrase it;
- a ticket **with a record** has no such sentence, so the cell is composed from the record's own
  authored fields.

No curated prose can be lost, because the new branch fires only where the source of the legacy cell
does not exist. That is the same reasoning as BUG-122's owner-from-INDEX decision: the record may
supply what is missing, never overwrite what a person wrote.

What it composes, all of it fields the record already carries, read through the one shared reader
(no fourth grammar; ARCH-008 untouched):

- the work state, as the same word `WORK_STATE_STATUS_WORD` already maps it;
- `NEEDS A HUMAN DECISION (N options).` when `human_action` asks for a choice, or the ticket offers
  ≥2 options — and `awaiting your answer` / `awaiting your review` for the other human actions;
- `No build starts until an option is chosen.` **only for `type: "architecture"`**, because that is
  where it is true: WA §N makes an ARCH ticket a question, not a licence to rewrite working code. A
  bug or feature awaiting a decision gets the rest of the cell without a rule that does not apply;
- `Recommended: <key> — <reason>`, with the key **validated against the real option keys** and
  dropped when it matches none — the same rule `ticketDecision` applies, so the board and the Decide
  card can never badge different things;
- `If we wait: <impact_if_we_wait>` — the named consequence of delay;
- `current_need` instead of the decision clauses when nothing is being asked of a human.

Nothing is truncated. The record's own word caps bound `recommendation_reason` at 40 words and
`impact_if_we_wait` at 50, so the cell is bounded by construction — this project collapses whole or
states absence, it does not elide with an ellipsis.

## Verification

`npm run verify:bug-123` (`scripts/verify-bug-123-record-status-cell.mjs`) — **20/20**. Real board,
promoted ticket discovered at runtime rather than named, aborts loudly if the board holds no ticket
of either kind. Nothing is generated into the real board: every generation runs in a scratch copy.

- **must-FAIL, anchored to a synthesized pre-change state:** the pre-change cell for a promoted
  ticket is exactly `boardStatusFromHeader(statusRaw)`, which is still live behaviour and still what
  every legacy ticket gets. The suite asserts it really does return the bare state word (`"OPEN"`, 4
  chars) and that the generated cell is no longer it (484 chars). That reference is a property of the
  format, not of a revision, so committing this cannot turn it green.
- **the legacy half, asserted as byte-identity:** all 28 legacy Open rows are byte-identical between
  the committed generator and this one over the same corpus — and the promoted row DID change, so the
  comparison cannot pass vacuously.
- idempotence (a second `gen` is a no-op), `board:check` on the regenerated board exit 0 / zero
  FAILs, the cell is one well-formed table cell with no raw pipe, and a recommendation matching no
  option is dropped rather than badged.
- **the neighbouring guard agrees rather than being defeated:** `verify-unmappable-status.mjs`'s
  narrowed `board:gen` guard (BUG-122) asserts the generated INDEX matches HEAD's except on promoted
  tickets' own rows. This change alters exactly one promoted row, so that guard must still pass — the
  suite runs it and asserts it does.
- the composed cell reaches the ticket API's Status column whole (`TicketSummary.boardStatus`), over
  a real server on a free port.

## Context pack

- Files in play: `scripts/board.mjs` (`boardStatusFromRecord`, `boardStatusFromHeader`,
  `readTickets`, `genBoard`)
- Related tickets: **BUG-122** (the same defect in the readers and in the decision path — this is its
  third surface), **ARCH-008** (who owns the record grammar — cited, not pre-empted), **ARCH-005**
  (the artifact), **FEAT-068** (item #1 — the rule that the Status cell is re-derived, kept intact
  for legacy tickets)
- Repro test: `npm run verify:bug-123`

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-20 — mixed-format reader lane (worker)

- **Class:** `fix`. Third in one class, all found by using the product rather than by a test.
- **Understood:** the orchestrator found this by running `board:gen` for real, and had already
  repaired the board by hand (`aebf332`) — so this was not urgent, but it is a precondition for the
  bulk cutover. The cause is the same as BUG-122's: a surface reads prose that promotion deletes.
- **Changed:** `scripts/board.mjs` — `boardStatusFromRecord` composes the cell from the record;
  `readTickets` carries it as `boardStatus` (null for a legacy ticket, meaning "use the prose
  header"); `genBoard` prefers it and falls back to `boardStatusFromHeader`, which is untouched. Both
  composers exported so the suite can drive them directly. New suite + `verify:bug-123`.
- **Verified:** `npm run verify:bug-123` **20/20**; before/after on the real board's own copy shows
  exactly ONE changed line, ARCH-005's, with 28 legacy rows byte-identical; `npm run gate` PASS
  (exit 0, unpiped). Anti-regressions: `verify:board-tool` 34/34, `verify:bug-122` 71/71,
  `verify:decision-shape` 25/25, `verify:reachability` 16/16, `verify:feat-082` 52/52,
  `verify:unmappable-status` **690/2** (measured with a regenerated INDEX — see below).
- **A correction to BUG-122's log, made here because that entry is append-only.** BUG-122 recorded
  `verify:unmappable-status` at 691/1. The honest number is 690/2: the two `fleet sweep` /
  `STALE copied schema` checks are a PAIR, both of them fail at the pinned pre-fix baseline
  (`64c3389`), and the 691/1 run was one where half the pair happened to pass. That pair depends on
  sibling repos found on disk (its own output shows `would-create` outcomes for tools it could not
  locate), so it is environment-sensitive, not a signal about either change. Neither number was ever
  a regression; the smaller one was luck, and quoting it would have been quoting the flattering run.
- **Reading `unmappable-status` at all requires a regenerated INDEX**, for the third time in this
  lane: seven of its checks assert `board:check exits 0` over a COPY of the real board, so any
  ticket whose INDEX row the orchestrator has not yet added — this one, on filing — reddens them.
  With `board:gen` run on the copy first, the count is 690/2 as above. That coupling is worth a
  ticket of its own; it is not this one.
- **Not re-run, and why:** the browser leg. BUG-122's run already captured this exact field
  (`boardStatus`) rendering verbatim in the All-tickets Status column
  (`docs/bugs/assets/BUG-122-after-all-tickets.png`), so what was unproven here was the VALUE, which
  block F asserts against a real server, not the rendering.
- **Still open / handoff:**
  1. **The board still shows the hand-edited cell** until someone runs `board:gen`. That is the
     orchestrator's call and their file; this fix only changes what a regeneration would produce.
  2. A **server restart is still owed** from BUG-122 (`src/server/tickets.ts`, `src/server/board.ts`).
     This ticket's change is a script, so it needs no restart of its own.
  3. Independent clean-room verification, as for BUG-122 — I wrote both fix and fixture.
### 2026-08-20 — mixed-format reader lane (worker), suite repair

- **My own suite had the moving-baseline defect, and I shipped it.** Block C compared the generated
  INDEX against `git show HEAD:scripts/board.mjs`'s output. It passed while the fix was uncommitted
  and went RED the instant `efc927b` landed, because HEAD BECAME the fixed state: the two generators
  were then the same program, no row differed, and the block's own anti-vacuity check ("the promoted
  row DID change") correctly reported that the comparison had stopped comparing anything. This is
  precisely the trap `docs/CONVENTIONS.md` names — written into the suite that was supposed to
  respect it, in the same lane that quoted the rule twice. The guard caught it, which is the only
  reason it did not sit there as a decoration.
- **Changed:** `scripts/verify-bug-123-record-status-cell.mjs` block C — no git baseline at all. The
  anchor is now a PROPERTY: the pre-change rule for every ticket was
  `boardStatusFromHeader(statusRaw)`, that function is still live and is still exactly what a legacy
  ticket must get, so all 28 legacy Open rows are asserted against it directly, and every promoted
  row is asserted NOT to equal it. A property cannot become the fixed state by being committed. The
  HEAD-vs-now comparison is not lost — `verify-unmappable-status.mjs` owns it and block E asserts
  that guard still passes.
- **Verified:** `verify:bug-123` **19/19** (was 20 checks; block C went from 4 to 3). Non-vacuity
  re-proven the honest way, against a synthesized broken state rather than a revision: reverting the
  one-line fix (`t.boardStatus ?? …` → `boardStatusFromHeader(…)`) in a scratch copy takes the suite
  to **11/19**, with 8 checks red — every substantive claim, including the composed cell, the
  recommendation, the delay consequence, the API surface, and block C's promoted-row arm. `npm run
  gate` PASS (exit 0, unpiped).
- **Handoff:** the same audit is worth running over the other suites this lane touched. I checked
  `verify-bug-122-mixed-format-readers.mjs` when writing it and its must-FAILs are anchored to
  `mode: 'compat'` and to the record-stripped body — both properties, neither a revision — and it
  still reads 71/71 after two commits, which is the evidence that they do not move.

- **Symptom of a deeper design flaw?** yes → **ARCH-008**, already open and awaiting a human. Three
  surfaces have now degraded on the first promoted ticket (the readers, the decision path, the board
  writer), each found by use rather than by a test, which is the recurrence signal WA §N asks to be
  named. Recorded here rather than filed again: ARCH-008 is the container for that decision, and the
  useful new evidence is that the cost of the format landing in more than one reader is now measured
  in three separate defects on ONE ticket, before the other 191 have moved.
