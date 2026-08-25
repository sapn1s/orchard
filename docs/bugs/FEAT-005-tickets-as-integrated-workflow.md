```orchard-ticket
{
  "id": "FEAT-005",
  "type": "feature",
  "title": "Ticket discipline stayed a manual convention for one project",
  "summary": "The append-only ticket practice worked, but it lived only as a habit people followed by hand in one repository. Nothing scaffolded a ticket, dispatched a worker with the ticket's full history, or required an outcome to be written back. That gap was later taken up by the durable working-system work, which closed this ticket.",
  "impact_if_we_wait": "Nothing here is at risk now, because a successor ticket carries the same goal. Bounded: this concerns how the practice is tooled, not the tickets themselves, which remained readable and appendable throughout under the manual convention.",
  "current_need": "Nothing is outstanding. This closed as superseded rather than built: the convention it recommended was already running, and the tooling moved to the successor.",
  "severity": "low",
  "area": "Ticket board tooling",
  "reported": "2026-08-03",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-03",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-03",
      "question": "Should the ticket practice stay a convention, become a repo command, or become a first-class dashboard feature?",
      "mode": "single",
      "options_keys": [
        "1",
        "2",
        "3"
      ],
      "chosen": "1 now, with 3 as the direction",
      "chosen_on": "2026-08-03",
      "chosen_by": "user",
      "note": "The convention was already in use when the ticket was written. The dashboard version was to be designed once the manual pattern had proven its shape on real tickets, with BUG-001 named as one of the first proving grounds. That direction was taken up by FEAT-017 and this ticket closed as superseded."
    }
  ],
  "success_criteria": [
    "Ticket practice is described generally rather than as a directory local to one app",
    "A worker can be dispatched already holding a ticket's accumulated history",
    "A dispatched worker is required to write its outcome back onto the ticket"
  ],
  "code_refs": [
    {
      "path": "docs/bugs/",
      "symbol": null,
      "note": "the append-only ticket directory whose discipline FEAT-005 proposed generalizing"
    }
  ],
  "related": [
    {
      "id": "FEAT-017",
      "relation": "superseded_by"
    },
    {
      "id": "BUG-001",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "exempt",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-005-tickets-as-integrated-workflow.md",
    "sha256": "a61f72bb4fbb66d7fda45deea2c2b20749dd8f5f3322c61df7414ad6806797d4",
    "bytes": 2061,
    "original_title": "Generalize accumulating-context tickets into the workflow",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "The motivation, the three routes with their relative cost, the staged recommendation and its proving-ground condition are all present in the fields above.",
    "dropped": [
      "BUG-004, the second named proving ground, which adds nothing the first does not"
    ]
  }
}
```

# FEAT-005 — Ticket discipline stayed a manual convention for one project

## Diagnosis

The append-only ticket pattern was not specific to this application. It is a way for multi-agent development to keep memory, so that fixes build on each other instead of restarting cold and reintroducing the same faults. As written, it existed only as a directory plus a discipline people remembered to follow.

## Evidence

The practice was already running by hand when the ticket was filed on 2026-08-03, and BUG-001 was one of the first tickets it was exercised against.

## Implementation notes

Three routes were laid out. The first was convention only: the directory discipline plus a reusable preamble handed to every fix worker — read the whole ticket, do not repeat a logged failed approach, append an entry, run the full verify suite, hand off if incomplete. The second was a repo-local command that scaffolds a ticket and dispatches a worker with the discipline and full ticket context baked in. The third made tickets first-class objects attached to a project or session, with an append-only context log, linked commits, and a button that launches a worker pre-loaded with the ticket and required to append its outcome — the orchestration tool hosting its own bug process.

## Activity log (APPEND-ONLY)

### 2026-08-03 — orchestrator
- Established (1): rewrote docs/bugs/README + TEMPLATE for append-only Activity
  logs, read-all-before, full-suite verify, explicit handoff. First tickets
  under it: BUG-004 (with 3 prior attempts retro-logged as the demonstration).
