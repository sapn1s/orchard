```orchard-ticket
{
  "id": "FEAT-017",
  "type": "feature",
  "title": "Working practices died with the session that invented them",
  "summary": "The team's way of working lived only in one repository's notes and in an open session, so it vanished at compaction. Those practices are now re-supplied to every session automatically, with a portable ticket board and a shared skill that scaffolds one in any project. A cross-project rollup surface remains beyond what shipped.",
  "impact_if_we_wait": "Each new session would relearn the same conventions and reinvent tracking. Bounded: this affects continuity of practice, not stored work, since the tickets themselves are ordinary files in the repository.",
  "current_need": "Nothing is outstanding. The three durability tiers shipped and the board they define is the one this project runs on today.",
  "severity": "high",
  "area": "Working practices durability",
  "reported": "2026-08-04",
  "reported_by": "user",
  "owner": "you",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-04",
      "question": "Where should the durable store live, and where should the methodology text live?",
      "mode": "multi",
      "options_keys": [
        "D1",
        "D2",
        "D3"
      ],
      "chosen": "D1+D2",
      "chosen_on": null,
      "chosen_by": "user",
      "note": "The markdown ticket files became the source of truth, rendered rather than duplicated into a database. The shared practices are injected into every session rather than kept per-project. Build order followed from those two."
    }
  ],
  "success_criteria": [
    "A fresh session in any project receives the shared working practices without being asked",
    "The ticket board scaffolds into a new project from a skill, with no server dependency",
    "Ticket files stay the single source of truth and survive compaction and restart"
  ],
  "code_refs": [
    {
      "path": "docs/prompts/WORKING_AGREEMENT.v2.md",
      "symbol": null,
      "note": "the re-injected practices text — tier 1"
    },
    {
      "path": "docs/bugs/README.md",
      "symbol": null,
      "note": "the board conventions the portable skill encodes — tier 2"
    }
  ],
  "related": [
    {
      "id": "FEAT-005",
      "relation": "supersedes"
    },
    {
      "id": "FEAT-018",
      "relation": "blocks"
    },
    {
      "id": "FEAT-018",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-019",
      "relation": "blocks"
    },
    {
      "id": "FEAT-020",
      "relation": "see_also"
    },
    {
      "id": "FEAT-021",
      "relation": "blocks"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "plan+review",
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
    "archived_path": "docs/bugs/archive/FEAT-017-durable-cross-project-working-system.md",
    "sha256": "f64573ef826db2f496ab41b624954ad4e301cb73c9500762718ae7ddab69e160",
    "bytes": 5607,
    "original_title": "Make our working system survive compaction & reusable across all projects",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Checked against the original head: the three tiers, the files-as-source insight, the two settled questions and the containment of the earlier ticket are all present above.",
    "dropped": [
      "the enumerated home candidates for the practices text, now settled and recorded as history",
      "the optional API or tool endpoint for appending a ticket from any session, offered in passing and not built"
    ]
  }
}
```

# FEAT-017 — Working practices died with the session that invented them

## Diagnosis

Everything built during the originating session — the ticket and board mechanism, the orchestrator role, the output contract that says nothing important lives only in chat, verification-as-the-deliverable, and the git-safety concurrency rules — existed in one repository's `docs/` and in that session's live context. Context dies at compaction, so the practices were valuable only for as long as one conversation lasted, and only in the repository that happened to hold the notes.

## Evidence

FEAT-017 was filed on 2026-08-04 by the user against exactly the material that session had produced. FEAT-005, an earlier attempt to generalise the accumulating-context ticket idea, is contained by this one rather than pursued separately.

## Implementation notes

Three durability tiers, all shipped.

### Tier 1 — practices as durable, auto-re-injected text
The universal content: orchestrator role; the output contract; verification-is-the-deliverable; git-safety rules (no blanket staging while agents are in flight, commit explicit file lists, serialise tickets touching the same file); append-only ticket discipline where the orchestrator owns the index and agents append only. This is injected per session rather than left in a project file.

### Tier 2 — the board mechanism as a portable skill
Invokable in any project. It scaffolds the tracker directory with its README, index and template, and encodes the append-only and orchestrator-owns-the-index rules. No server dependency.

### Tier 3 — durable store plus a human surface
The key insight that shaped the architecture: the markdown ticket files are themselves the durable store. They are tracked in git, portable, and survive compaction and restart. The skill writes them and the station renders and aggregates them. One source of truth, no database, no synchronisation. The rail delivered under FEAT-018 carries the glanceable strip.

## Verification plan

The proof is use: a session started cold in this project receives the practices and works the board without being told they exist.

## Risks

Injecting shared practices into every session makes them global, which was the acknowledged cost of choosing that home over a per-project file.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed as the umbrella for making the whole working system survivable. Captures
  the 3-tier plan so the PLAN itself survives compaction (the user's own point).
  Awaiting D1/D2 before building.

### 2026-08-04 — orchestrator (decisions + tiers 1-2 shipped)
- **D1 decided:** files live in each project's own docs/ dir, **OPT-IN** — a
  project has a board iff it already contains docs/bugs/. Real repos (this,
  external-project-A) benefit; scratch dirs like ~ do NOT get one. Station will
  RENDER these files, not own a DB.
- **D2 decided:** methodology → user-level ~/.claude/CLAUDE.md (global, consented).
- **Tier 1 DONE:** wrote ~/.claude/CLAUDE.md — output contract (NEEDS YOU),
  orchestrator model, verification-is-deliverable, git-safety, process-safety,
  opt-in board discipline. Re-loads every session in every project.
- **Tier 2 DONE:** wrote ~/.claude/skills/tickets/SKILL.md — portable scaffolder +
  discipline; explicitly NOT for scratch dirs.
- **Tier 3 REMAINING → FEAT-018:** claude-station renders/aggregates the per-project
  docs/bugs/ files (Needs-you / In-flight / Done strip + cross-project rollup).
  Touches app.js+server → waits for the app.js lane to free.

### 2026-08-04 — orchestrator (course-correction: use the mechanism that already exists)
- User pushed back on the global ~/.claude/CLAUDE.md; on inspection the app ALREADY
  has the right mechanism: src/server/templates.ts `composeInstructions()` appends
  selected instruction templates to each launched session's system prompt, and it
  SEEDS a living "Working Agreement v2" (docs/prompts/WORKING_AGREEMENT.v2.md) the
  user evolves. That is the survivable + reusable + opt-in home — a blunt global
  file both duplicated it and polluted scratch (~) prompts.
- **Reversed:** DELETED ~/.claude/CLAUDE.md.
- **Done instead:** appended sections H–K to WORKING_AGREEMENT.v2.md (output
  contract / NEEDS-YOU, orchestrate-multi-item, git-safety-with-agents, opt-in
  board discipline) — the station injects this into project sessions already.
- **Kept:** ~/.claude/skills/tickets (portable scaffolder; complements, doesn't
  duplicate — it creates the docs/bugs/ files a project opts into).
- **Remaining real work:**
  - FEAT-018 — station renders the per-project board (human-facing glanceable strip).
  - Board-snapshot INJECTION — extend composeInstructions so a launched session in a
    board-having project also gets the current open/needs-you tickets appended, so
    every session boots already in sync with the board (machine-facing sync). Needs
    its own small design (composeInstructions is static templates today). Noted here;
    ticket when we pick it up.
  - Make the v2 edits LIVE: the seeded template copy under <data>/templates/ only
    seeds when absent, so the repo edit doesn't auto-update a running install —
    sync needed (see board note).

- 2026-08-06 — privacy scrub for public release (FEAT-049, sanctioned append-only exception): private names/paths neutralized (project aliases, home paths → ~).
