```orchard-ticket
{
  "id": "FEAT-100",
  "type": "feature",
  "title": "A dispatch does not declare its ticket, phase, round or class",
  "summary": "Cost is attributed to a session, not a ticket. Lifecycle phase is guessed from tool use, which is a different axis. Round and dispatch class are recorded nowhere. All four are known by the dispatcher at the moment it writes the charter, and nothing asks it for them.",
  "impact_if_we_wait": "The per-ticket finding/fixing/verifying breakdown that was asked for cannot be produced. Bounded: nothing breaks while this waits, but each passing window is one whose phase split is unrecoverable, because the facts were only knowable at dispatch time.",
  "current_need": "none - the capture and the report are built and verified; what remains is dispatchers actually writing the line.",
  "severity": "medium",
  "area": "Process cost attribution",
  "reported": "2026-08-21",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "in_progress",
  "human_action": "none",
  "updated": "2026-08-21",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A ticket declared at dispatch is the ticket the report attributes the cost to, even when the charter prose names a different one",
    "A field that was not declared is reported as undeclared, never inferred and never defaulted",
    "The lifecycle phase is never derived from the tool-derived phase map, which measures a different axis",
    "Two declarations that disagree yield nothing rather than a pick",
    "The per-ticket phase parts sum to the same total as the ticket whole",
    "Lanes that ran before this existed still read, and report as a gap rather than a zero",
    "A charter that quotes the syntax inside a code fence is not read as declaring it",
    "The dispatch path does no additional work at runtime"
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": false,
    "Implementation notes": false,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": null,
    "sha256": null,
    "original_title": null,
    "migrated_on": null,
    "migrated_by": null,
    "confirmation": "Authored directly in the record format through scripts/board-tool.mjs. There is no legacy original.",
    "dropped": []
  }
}
```

# FEAT-100 — A dispatch does not declare its ticket, phase, round or class

## What the user asked for

Per-ticket cost and time, split by lifecycle phase (finding, fixing, verifying) so that a UI fix taking two hours becomes evidence about the architecture rather than a feeling. See `docs/analysis/orchestrator-required-workflow-2026-08-20.md`.

## Why it could not be produced

`scripts/cost-collect.mjs` already derives per-lane hours, tokens, cost, models and verdicts from transcripts, retroactively and at zero runtime cost. It cannot produce the split, because the split depends on four facts that are not properties of what an agent did:

- **ticket** — inferred by regexing ids out of charter prose; a multi-ticket lane is attributed wholly to the first id mentioned. The previous analysis had to mark six tickets *(batched)* with no cost figure at all rather than print a fabricated one.
- **phase** — substituted from tool use. `orienting / investigating / building / testing` describes what an agent reached for, not which step of the ticket's life the work belonged to. A verify lane that spends its run reading and grepping scores as `investigating`, which is true and is a different claim.
- **round** — a lane's position in a list sorted by start time.
- **class** — Working Agreement §I requires the orchestrator to classify the dispatch and record the class in the charter, and explicitly anticipates the audit "how many `fix` dispatches turned out to need `explore`?". Nothing stored it, so that audit was impossible.

This is the defect this board keeps producing: a fact its owner knows at the moment it happens, left for a reader to re-derive later. The dispatcher knows all four. Nothing asked it.

## The shape

One line, first line of the charter:

    Dispatch: ticket=BUG-123 phase=fixing round=2 class=fix

Chosen because it costs the dispatch path nothing. The charter is already written and already becomes the lane's first transcript message, which the collector already reads. No new store, no extra write, no runtime call — a string concatenation of facts already in hand.

The grammar lives once, in `scripts/lib/cost-model.mjs`, and is shared by the writer (`scripts/dispatch.mjs --ticket/--phase/--round/--class`) and the reader. The CLI formats the line and then parses its own output back through the reader's grammar, refusing the dispatch if it does not round-trip: emitting a declaration the reader cannot read would be worse than emitting none, because it looks like a record.

## Absent is recorded as absent

Every field is independent and optional. An undeclared field is null and is counted in a coverage line printed with every report. Out-of-vocabulary values are rejected by name rather than coerced. Two declarations that disagree drop the conflicting fields entirely rather than picking one. A quoted example inside a code fence is not a declaration. The inferred values are kept beside the declared ones, computed over the charter with the declaration lines removed, so "how often did the old inference disagree with the fact" is answerable from the ledger alone.

## Deliberately not built

No UI. The concern is spend, and a dashboard to watch spending is the wrong first move — `npm run cost:collect` and `node scripts/cost-collect.mjs --ticket=<id>` are the whole surface.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-21 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-21 — agent
- **Landed:** Landed in 327a1e4. The grammar (parseDispatchDeclaration / formatDispatchDeclaration / stripDispatchDeclarations / resolveLaneAttribution) lives once in scripts/lib/cost-model.mjs and is shared by the writer and the reader; scripts/dispatch.mjs gained --ticket/--phase/--round/--class, which format the line and parse their own output back through the reader grammar and refuse the run if it does not round-trip. Ledger records go to schema 2; schema-1 records still read.

  VERIFIED AGAINST TWO REAL DISPATCHES, not fixtures. A real claude -p run (session 63e47483-8a3c-4648-a4e5-7bdd809c4e44, model claude-haiku-4-5) declaring ticket=FEAT-100 phase=verifying round=1 class=verify, and a real in-process subagent (agent a4f84b779f1f5a9b0) declaring phase=finding round=2 class=explore. Both were read back out of the agent CLI own transcripts by node scripts/cost-collect.mjs --ticket=FEAT-100, which printed each lane declared / resolved / inferred side by side and produced the per-ticket finding-vs-verifying split. Both dispatch paths are therefore proven, not just the CLI one.

  MUST-FAIL, in a clean room built from HEAD by git archive (no worktree, no index touched): the same charter reports round 1 where the dispatcher declared round 7, class null, no lifecycle phase field at all, and the report has no lifecycle axis. A multi-ticket declaration of three ids collapses to the first and the other two are lost - the exact shape the previous analysis had to mark (batched) with no figure.

  TRUNCATION. The collector reads transcripts another process is writing, so the suite truncates a declaration-bearing transcript at every one of its 2324 byte offsets and grades each read: 1710 read the declaration exactly, 0 read it wrong. A wrong value at any offset fails the suite.

  WHAT THE LANES THAT RAN BEFORE THIS LOOK LIKE - stated rather than filled in. The real ledger holds 1173 schema-1 records. npm run cost:report reads them and prints: coverage ticket 0/1173, phase 0/1173, round 0/1173, class 0/1173; 1173 lane(s) predate the declaration and carry NO record of it - that is a gap, not a zero; and the whole 143.42 agent-hours sits in the undeclared lifecycle bucket. Their inferred ticket attribution still works and is still shown, labelled inferred. Nothing was back-filled.

  ONE DEFECT FOUND BY THE SUITE IN THIS LANE OWN WORK: the inferred fields were being computed over the raw charter, so the declaration line was itself a first mention and a lane declaring BUG-902 reported BUG-902 as its own independent inference. stripDispatchDeclarations now removes declaration lines before inference, so the inferred column answers what a pre-FEAT-100 reader would have concluded.

  DELIBERATELY NOT BUILT: no UI. The concern is spend, and a dashboard to watch spending is the wrong first move.

  NOT YET TRUE: coverage is 2 lanes. The capture and the report are done; the value arrives only as dispatchers actually write the line. docs/CONVENTIONS.md now carries the rule and is auto-injected into launched sessions.

  AN INDEPENDENT CLEAN-ROOM VERIFY PASS IS WARRANTED. This is a measurement surface whose failure mode is a confident wrong number, and generation must not be its own only verifier. The attack surface worth a second pair of eyes: the fence boundary in parseDispatchDeclaration (a hand-written recogniser over a prose boundary - the ARCH-004 signature), whether any path can promote a tool-derived phase into the lifecycle phase, and whether the per-ticket phase parts can be made to disagree with the ticket whole.

### 2026-08-21 — agent
- **Correction:** CORRECTION to the session ids in the entry above. Those two real dispatches were run while this ticket was still expected to be numbered FEAT-099, so they declared ticket=FEAT-099 - a real end-to-end proof of the mechanism, but pointing at the wrong id. Rather than leave a log that says something the transcripts do not, both were re-run against the landed code declaring FEAT-100:

    process lane   65626230-7386-447a-abc6-00eeb6ae8986  (claude -p, claude-haiku-4-5)
                   Dispatch: ticket=FEAT-100 phase=verifying round=1 class=verify
    subagent lane  a7cdbda578df1b24b  (in-process Agent, charter-declared)
                   Dispatch: ticket=FEAT-100 phase=finding round=2 class=explore

  node scripts/cost-collect.mjs --ticket=FEAT-100 reads both back out of the agent CLI own transcripts and resolves all four fields as (declared) on both lanes, with the finding and verifying phases separated. Note the inferred column on both now reads ticket=- : neither charter mentions the id anywhere except the declaration line, and declaration lines are stripped before inference, so there is genuinely nothing a pre-FEAT-100 reader could have concluded. That is the honest answer, and it is what the earlier FEAT-099 pair would have shown too had the strip existed when they ran.
