```orchard-ticket
{
  "id": "FEAT-097",
  "type": "feature",
  "title": "Every board change went through a hand-written index edit",
  "summary": "Filing a ticket, placing its row and asking the board a question could only be done by writing the files by hand. That is the largest cluster of work a dispatch-only surface would refuse, and hand-built row edits are the mechanism behind four defects on this board.",
  "impact_if_we_wait": "Row edits keep being hand-built, which has already lost rows and flattened a curated cell four times, and any restriction of the shell converts the board work into an unmet need instead of a tool call.",
  "current_need": "none — the tool is what places board rows now; this sweep used it for eleven tickets and two filings",
  "severity": "medium",
  "area": "board tooling",
  "reported": "2026-08-20",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A ticket can be filed without writing the file by hand",
    "A record that fails validation is refused and nothing is written",
    "A row change goes through the board generator, never string surgery",
    "A commit stages only the tickets it was given and refuses a red gate",
    "The board is clean after the tool has written to it"
  ],
  "code_refs": [
    {
      "path": "scripts/board-tool.mjs",
      "symbol": null,
      "note": "the tool: query, check, reconcile, file, update, commit"
    },
    {
      "path": "scripts/verify-feat-097-board-tool.mjs",
      "symbol": null,
      "note": "84 assertions against a copy of the real board in a real scratch git repo"
    },
    {
      "path": "scripts/lib/ticket-schema.mjs",
      "symbol": "deriveBodySlots",
      "note": "moved here so the migration and the tool derive body slots by one rule"
    },
    {
      "path": "src/server/tickets.ts",
      "symbol": "setBoardOwner",
      "note": "the single writer of the curated Owner cell; setNeedsYou now delegates to it"
    },
    {
      "path": "scripts/board.mjs",
      "symbol": "reachabilityFails",
      "note": "exported so the tool checks what board:check checks, not a weaker subset"
    }
  ],
  "related": [
    {
      "id": "FEAT-096",
      "relation": "see_also"
    },
    {
      "id": "BUG-123",
      "relation": "see_also"
    },
    {
      "id": "BUG-133",
      "relation": "see_also"
    },
    {
      "id": "ARCH-008",
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
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": null,
    "sha256": null,
    "original_title": null,
    "migrated_on": null,
    "migrated_by": null,
    "confirmation": "Authored directly in the record format by the lane that built the tool. There is no legacy original.",
    "dropped": []
  }
}
```

# FEAT-097 — Every board change went through a hand-written index edit

## Diagnosis

The orchestrator has no way to touch the board except by writing the files
itself. Filing a ticket is a Write, placing its row is an in-place edit of
`INDEX.md`, and asking a question of the board — "which tickets are open", "what
is FEAT-089's status", "what was filed since last night" — is a shell command
that greps markdown.

Two costs follow from that, and they are separate.

The first is measured. `docs/analysis/orchestrator-surface-retroactive-2026-08-20.md`
classified 2,412 tool calls from a real session and found that in the
orchestrator-role window, 63% of the refused shell calls were board and ticket
content, 25% were `board:gen`/`board:check`, 20% were `git add`/`commit`, and 15
of the 22 refused file writes were ticket files and `INDEX.md`. That is one
cluster, not a long tail, and it is the largest thing standing between the
current role and a dispatch-only surface.

The second is a defect class that exists whatever anyone decides about profiles.
Row edits have been performed with in-place `python3` heredocs, and four tickets
on this board are failures of exactly that mechanism: a curated status cell
flattened to the word OPEN (BUG-123), rows lost (BUG-127), a self-referencing
relation written by a partial rewrite (BUG-128), and an archive index rebuilt
from only the files one run touched (BUG-133). Every one of them is a hand-built
edit of a file that already has a generator.

## Evidence

- The measurement, with the daily series and the per-purpose breakdown:
  `docs/analysis/orchestrator-surface-retroactive-2026-08-20.md` §2 and §3.
- The four tickets named above, all on this board.
- `docs/bugs/README.md` already states the rule this tool now enforces
  mechanically: rebuild `INDEX.md` from the ticket files; never hand-edit rows.

## Implementation notes

`scripts/board-tool.mjs`. Six verbs — `query`, `check`, `reconcile`, `file`,
`update`, `commit` — returning JSON on stdout and an exit status, never prose.

It is orchestration, not new rules. Validation is `validateTicket`, serialization
is `formatTicket`, reading is `parseTicket`, row generation and drift detection
are `genBoard`/`checkBoard`, and listing, search, id allocation, the append-only
writer and the freshness gate are the ticket API in `src/server/tickets.ts`. The
gate is `scripts/gate.mjs`, spawned as a child so its exit status is read
directly and no pipeline can mask it.

Three small changes were made elsewhere so that nothing had to be copied:

- `deriveBodySlots` moved into `scripts/lib/ticket-schema.mjs` and the migration
  now calls it there. Two writers of records had to agree about which sections a
  body has, and one loop in two files is how they stop agreeing.
- `setBoardOwner` in `src/server/tickets.ts` is now the single writer of the
  curated Owner cell, with `setNeedsYou` delegating to it rather than the reverse.
  It gained the agent value the dashboard never needed.
- `reachabilityFails` is exported from `scripts/board.mjs`. `board:check`'s verdict
  is the drift check plus both ride-alongs; a caller running only `checkBoard`
  would have called a board clean that the project's own command calls broken —
  and then committed it.

Two refusals are load-bearing. A record that fails `validateTicket` is not
written and the violations are returned as data. A commit whose gate is red does
not happen and the gate's own failing lines are returned as data. So is one
absence: `commit` has no "everything that is dirty" mode. It requires the ticket
ids, derives the paths itself, and stages them by name, because a blanket stage
once swept an unrelated lane's uncommitted code into a triage commit.

The interface takes no path and no shell command. Arguments are a verb, ticket
ids checked against the schema's own pattern, enum values checked against the
schema's own enums, free text that only ever lands in a ticket field, and a
commit message.

## Verification plan

`node scripts/verify-feat-097-board-tool.mjs` — 84 assertions against a copy of
the REAL board (210 tickets, mixed record and legacy prose, 25 needs-you rows)
inside a real scratch git repository with the real gate. It discovers the tickets
it needs at runtime and stops loudly if the board holds no qualifying one.

Four must-fail proofs, each against a state the suite synthesizes rather than
against a moving revision: an invalid record leaves no file behind; a leaked home
path turns the gate red and the commit does not happen, and the same commit then
succeeds once the leak is removed; an orphan index row makes `commit` refuse; a
stale freshness token is a conflict rather than a clobber. A real ticket is
truncated at four points, because agents write these files while this reads them,
and a half-written record must be reported rather than guessed at.

## Risks

The tool writes to the board and commits. The mitigations are that every row
change goes through `genBoard`, that a body is carried across a record update
byte-for-byte, that the log is only ever appended to, that a commit stages
nothing it was not given by id, and that a red gate or a drifting board stops it.

Two things are deliberately not solved here. `createTicket` in the ticket API
still files the LEGACY prose format from `TEMPLATE.md` while this files the record
format, so the board now has two filing paths producing two shapes; that is worth
one follow-up, not a silent unification. And the record's `owner` field and the
index's Owner cell remain two representations of one fact — this tool writes both
through one mapping, which contains the divergence without removing it (ARCH-008).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-20 — worker (dispatched lane)
- **Understood:** the measurement names this cluster as the largest, and names the
  commit clause as what makes it vanish rather than relocate. Built the tool as
  orchestration over the modules that already own each rule, and reported the one
  rule that had to move rather than copying it.
- **Changed:** `scripts/board-tool.mjs` and `scripts/verify-feat-097-board-tool.mjs`
  (new); `scripts/lib/ticket-schema.mjs` + `.d.mts` (`deriveBodySlots`);
  `scripts/migrate-tickets.mjs` (calls it); `src/server/tickets.ts`
  (`setBoardOwner`, an attributed `appendNote`, two existing helpers exported);
  `scripts/board.mjs` (exports `reachabilityFails`).
- **Verified:** `node scripts/verify-feat-097-board-tool.mjs` — 84 passed, 0 failed,
  against a copy of the real board. `npm run gate` PASS (exit 0, read directly).
  Anti-regression, all run before and after the change and identical in both:
  `verify:migrate-tickets` 53/53 PASS, `verify-decision-shape` 25/25 PASS,
  `verify-bug-123-record-status-cell` 377/377 PASS. Four suites fail identically
  with and without this change and were red on HEAD beforehand:
  `verify-board-tool` (33/1), `verify-ticket-schema` (C), `verify-ticket-dashboard`
  (Done→Open row), `verify-bug-122-mixed-format-readers` (needs a rail capture).
- **Found while building, in this tool's own code:** `git status --porcelain` puts
  the two status columns in the first two characters, so a leading space is data.
  Trimming that output turned ` M docs/bugs/X.md` into a report that the file
  `ocs/bugs/X.md` had been left uncommitted. Caught by the suite's "the other
  lane's dirty file is reported, not silently ignored" assertion, which is the one
  that exists because a wrong report there is how a lane's work gets lost.
- **Still open / handoff:** the INDEX row for this ticket is PROPOSED, not placed —
  the orchestrator owns that file, so `board:check` reads MISSING FROM BOARD until
  the row lands or `board-tool reconcile` is run. Two npm script entries
  (`board:tool`, `verify:feat-097`) are listed in the handoff for the same reason
  another lane was mid-edit of `package.json` when this started. The two follow-ups
  named under Risks are unfiled. Landed as `660f02b`; both npm entries went in with
  it, since `package.json` was free by then.
- **Symptom of a deeper design flaw?** Not closed here, so not answered here — but
  the two representations named under Risks (a filing path per format, an owner
  field per reader) are both instances of the question ARCH-008 already asks, and
  this ticket adds two more citations to it rather than a new suspicion.

### 2026-08-25 — worker
- **bookkeeping-sweep:** 2026-08-25 bookkeeping sweep (authorised by the user). The current_need here was "use the tool for the next board change instead of editing the file" — that is what this entry is. Every board change in this sweep went through `scripts/board-tool.mjs`: eleven `update` calls (log + record fields) and two `file` calls (BUG-142, BUG-143, ids ALLOCATED by the tool, both refused first for a real reason — a missing verification_class and a 13-word title — and written only once valid). No hand-edit of INDEX.md was made by this lane; `board:check` reads OK, no drift, 227 records. Suite: `npm run verify:feat-097` — 83 passed, 1 failed. The one failure was `the real repo was never written to`, and it was NOT the tool: that assertion required the real `docs/bugs` to be CLEAN, so any lane holding an uncommitted ticket — including the lane running the suite — reported as a violation by this tool. Proven directly instead: `git status --porcelain -- docs/bugs` captured before and immediately after a full run is IDENTICAL, so the suite and the tool wrote nothing to the real board. The assertion is now that comparison rather than a cleanliness requirement, which is what it always meant. Closing as verified. Noted honestly: the re-run that would show 84/84 is blocked right now because section 6 asserts a commit succeeds once the gate is green, and the repo-wide gate is currently red on ANOTHER lane uncommitted ticket file — an environmental block, not a defect here. Symptom of a deeper design flaw? Handed forward as written: this tool writes two representations of one fact (record + INDEX cell) through one mapping, which is another citation for ARCH-008 rather than a new suspicion.

### 2026-08-25 — worker
- **suite-green:** 2026-08-25, after the sweep landed as 885d3ff: `npm run verify:feat-097` is now 85 passed / 0 failed, exit 0 read directly — including the commit clause (a red gate refuses, a green one commits, exactly the ticket and INDEX.md are staged, and another lane dirty files are reported as left behind rather than swept in) and the before/after proof that this suite wrote nothing to the real board while two other lanes tickets sat uncommitted in it. That is the run the entry above said was blocked; it is unblocked and green.
