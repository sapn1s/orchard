```orchard-ticket
{
  "id": "BUG-123",
  "type": "bug",
  "title": "Regenerating the board erased a waiting decision from its row",
  "summary": "Regenerating the board index rewrote a promoted ticket's Status cell down to the single word \"OPEN\", losing the recommendation, the instruction that no build starts until someone chooses, and the named cost of delay. Board generation now composes that cell from the promoted ticket's own recorded fields, and leaves every other ticket's curated sentence untouched.",
  "impact_if_we_wait": "The one cell a person scans to see which decisions are waiting would silently empty on the next regeneration, across all 191 remaining tickets at cutover. Bounded: the ticket files keep everything, so the loss is display-only and repairable by hand.",
  "current_need": "Nothing is outstanding. The pre-change cell was shown to collapse to the bare state word, the composed cell came through whole, every legacy row stayed byte-identical, and standing checks stayed clean.",
  "severity": "medium",
  "area": "Ticket board index",
  "reported": "2026-08-20",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-20",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A promoted ticket's board row carries its recommendation, delay cost and decision prompt",
    "Every ticket with a curated status sentence keeps that sentence verbatim",
    "A second regeneration changes nothing",
    "A recommendation naming no real option is dropped rather than shown",
    "The composed cell reaches the ticket API's status column intact"
  ],
  "code_refs": [
    {
      "path": "scripts/board.mjs",
      "symbol": "boardStatusFromRecord",
      "note": "composes the row from the record's own authored fields; fires only where no prose status header exists"
    },
    {
      "path": "scripts/board.mjs",
      "symbol": "boardStatusFromHeader",
      "note": "FEAT-068 item #1 — re-derives the cell from prose on every generation; returns the bare state word for empty input, which is what a promoted ticket gave it"
    },
    {
      "path": "scripts/board.mjs",
      "symbol": "genBoard",
      "note": null
    },
    {
      "path": "scripts/verify-bug-123-record-status-cell.mjs",
      "symbol": null,
      "note": "repro suite for BUG-123; discovers a promoted ticket at runtime and generates only into a scratch copy"
    }
  ],
  "related": [
    {
      "id": "BUG-122",
      "relation": "recurrence_of"
    },
    {
      "id": "FEAT-068",
      "relation": "depends_on"
    },
    {
      "id": "ARCH-008",
      "relation": "see_also"
    },
    {
      "id": "ARCH-005",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [
    "BUG-122"
  ],
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
    "archived_path": "docs/bugs/archive/BUG-123-board-gen-flattens-a-promoted-tickets-status-cell.md",
    "sha256": "353e0cb440c894127319c427163ac69209e06c76140584cd6412e60bff27331d",
    "bytes": 12943,
    "original_title": "regenerating the board erases what a promoted ticket's row was saying",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared clause by clause against the original: the symptom rows, the re-derivation diagnosis, the two-branch rule, every composed clause, and the suite's must-FAIL anchoring are all present.",
    "dropped": [
      "the two verbatim before/after markdown table rows, kept in Evidence as a paraphrase of what the cell carried",
      "the context-pack file list, now in code_refs"
    ]
  }
}
```

# BUG-123 — Regenerating the board erased a waiting decision from its row

## Diagnosis

### Why the cell emptied

The Status cell is never preserved from the index — it is re-derived on every generation from the ticket's own prose `- **Status:**` header, so that a stale blurb cannot linger on the board. A promoted ticket has no prose Status header at all, so `boardStatusFromHeader` received `''` and returned its empty-input default: the bare word `OPEN`.

This is the third surface where a promoted ticket degrades, and all three are the same shape — something reads prose that promotion deletes. BUG-122 fixed the first two, in the readers and in the decision path; this one is in the writer.

## Evidence

### What regeneration did

ARCH-005's row went from a cell carrying `OPEN — NEEDS A HUMAN DECISION (4 options below)`, the no-build-until-chosen instruction and `Recommended: 3 — land the ratchet first…` to `| ARCH-005 | Projects can show another project's running activity | 👤 | OPEN | med |`. The title improving is BUG-122's fix working; the rest is the loss. The rows were reverted and hand-edited in `aebf332`, which is not an answer for 191 of them.

### What ran

- `verify:bug-123` and `verify:bug-123-record-status-cell` — 20/20 each
- `verify:board-tool` — 34/34
- `verify:bug-122` — 71/71
- `verify:decision-shape` — 25/25
- `verify:reachability` — 16/16
- `verify:feat-082` — 52/52
- a further 19/19 recorded without an adjacent suite name
- `board:check` clean

## Implementation notes

### The rule, chosen rather than defaulted to

A ticket **with a prose Status header** keeps that header verbatim — whitespace collapsed, pipes escaped. It is a person's curated sentence and regeneration must not paraphrase it. A ticket **with a record** has no such sentence, so the cell is composed from the record's authored fields. No curated prose can be lost, because the new branch fires only where the legacy cell's source does not exist. That is BUG-122's owner-from-index reasoning: the record may supply what is missing, never overwrite what a person wrote.

Composed, all through the one shared reader — no fourth grammar, ARCH-008 untouched:

- the work state, via the same word mapping already in use;
- `NEEDS A HUMAN DECISION (N options).` when the human action asks for a choice or the ticket offers two or more options, and `awaiting your answer` / `awaiting your review` for the other human actions;
- `No build starts until an option is chosen.` for architecture tickets only, because that is where it is true — the working agreement makes an architecture ticket a question, not a licence to rewrite working code. A bug or feature awaiting a decision gets the rest of the cell without a rule that does not apply to it;
- `Recommended: <key> — <reason>`, with the key validated against the real option keys and dropped when it matches none, under the same rule the decision reader applies, so the board and the Decide card can never badge different things;
- `If we wait: …`, the named consequence of delay;
- the current need instead of the decision clauses when nothing is being asked of a person.

Nothing is truncated. The record's own caps bound the recommendation reason at 40 words and the delay impact at 50, so the cell is bounded by construction — this project collapses whole or states absence rather than eliding.

## Verification plan

### How the suite is built

It runs against the real board, discovers a promoted ticket at runtime rather than naming one, and aborts loudly if the board holds no ticket of either kind. Nothing is generated into the real board — every generation runs in a scratch copy.

- **Must-FAIL, anchored to a synthesized pre-change state.** The pre-change cell for a promoted ticket is exactly `boardStatusFromHeader(statusRaw)`, which is still live behaviour and still what every legacy ticket gets. The suite asserts it really does return the bare state word (`"OPEN"`, 4 chars) and that the generated cell is no longer it (484 chars). That reference is a property of the format, not of a revision, so committing the fix cannot turn it green.
- **The legacy half, asserted as byte-identity.** All 28 legacy Open rows are byte-identical between the committed generator and this one over the same corpus, and the promoted row did change — so the comparison cannot pass vacuously.
- Idempotence, `board:check` on the regenerated board at exit 0 with zero failures, one well-formed table cell with no raw pipe, and a recommendation matching no option dropped rather than badged.
- **The neighbouring guard agrees rather than being defeated.** BUG-122's narrowed generation guard asserts the generated index matches HEAD's except on promoted tickets' own rows. This change alters exactly one promoted row, so that guard must still pass; the suite runs it and asserts it does.
- The composed cell reaches the ticket API's status column whole, over a real server on a free port.

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
