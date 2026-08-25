```orchard-ticket
{
  "id": "FEAT-030",
  "type": "feature",
  "title": "No way to pass matured findings between projects",
  "summary": "When one project produces a result another project needs, there is no supported way to move it across. The handover happens by hand, and the receiving project's next session has no idea anything arrived. A lightweight file-drop design exists on paper, recommended over live project-to-project messaging, but nothing has been built.",
  "impact_if_we_wait": "Occasional handovers stay manual, roughly a few times a year. Bounded: nothing breaks and no work is lost, since copying a note across by hand still works and no existing project behaviour depends on this.",
  "current_need": "Confirm this stays parked at low priority, or raise it so the file-drop design can be built.",
  "severity": "low",
  "area": "Cross-project handoff",
  "reported": "2026-08-04",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "decide",
  "updated": "2026-08-04",
  "decision": {
    "mode": "single",
    "question": "Should cross-project handoff stay parked at low priority, or be scheduled now?",
    "options": [
      {
        "key": "A",
        "label": "Keep it parked",
        "what_changes": "Nothing is built. Moving a finding between projects stays a manual copy when it comes up.",
        "benefit": "No effort spent on something needed a handful of times a year.",
        "cost": "Each handover stays manual, and the receiving project keeps missing that anything arrived.",
        "why_not_obvious": "A design left unbuilt long enough stops matching the parts it was drawn against, so the parked work quietly gets more expensive."
      },
      {
        "key": "B",
        "label": "Schedule the file drop",
        "what_changes": "A curated note is written into the target project's inbox, and that project's next session is told it is there.",
        "benefit": "The handover becomes durable and the receiving side notices it without being told.",
        "cost": "Real build work on the inbound-awareness surface for a rare need.",
        "why_not_obvious": "It spends a scarce build slot on a path used a few times a year, ahead of work people hit daily."
      }
    ],
    "recommendation": "A",
    "recommendation_reason": "The need is genuinely rare and the manual workaround costs almost nothing, so this can wait without accumulating harm.",
    "prerequisite": null
  },
  "decision_history": [],
  "success_criteria": [
    "Handing a document from one project to another writes an inbox file carrying its source project and date",
    "The receiving project's next session opens already showing an inbound count",
    "Accepting an inbound note files it into the receiving project's own documents",
    "Dismissing an inbound note removes it"
  ],
  "code_refs": [
    {
      "path": "docs/inbox/",
      "symbol": null,
      "note": "proposed per-project inbox directory; append-only files as the source of truth, named by date and source project"
    }
  ],
  "related": [
    {
      "id": "FEAT-021",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-020",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "plan+review",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": false,
    "Verification plan": true,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-030-cross-project-handoff.md",
    "sha256": "697a029302a10db26c19a90d50e7d0e70a95013906a020bc727268db8b6b7633",
    "bytes": 3264,
    "original_title": "Cross-project handoff: pass curated findings from one project to another (async, not live)",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Checked against the original head section by section: the async-not-live argument, the inbox file shape, inbound awareness, the curated-not-raw rule, the triage ask and the verification steps are all present.",
    "dropped": [
      "the restatement that nothing breaks if you do nothing, which the impact field now carries",
      "the framing note marking everything below the summary as reference material"
    ]
  }
}
```

# FEAT-030 — No way to pass matured findings between projects

## Diagnosis

### Why a handoff rather than live messaging

Findings mature over weeks and the value is the distilled result, not the working context that produced it. That makes the need asynchronous and curated. Two sessions running at once, plus routing and a protocol between them, is heavy plumbing for something used a handful of times a year, and it would stream raw context where a curated note is what is wanted. Live agent-to-agent messaging is worth revisiting only if a genuinely real-time case appears.

### The proposed shape

A "hand off to project…" action takes a curated document or selection in the source project and writes it into the target project's inbox, under a date-and-source filename, with a provenance header naming the source project, the date, and an optional note. Files are append-only and are the source of truth, matching how the board already works. Participation is opt-in: only projects that keep documentation take part.

Inbound awareness reuses the boot-aware injection described in FEAT-021, so the receiving project's next session and its rail show how many inbound handoffs are waiting and where they came from. Someone on the receiving side then files each one into that project's real documents, or dismisses it. The raw-versus-curated distinction is the one already drawn in FEAT-020.

## Evidence

The need was reported on 2026-08-04 from a concrete case: findings from one research project that should feed a separate research project. Nothing has been built and nothing has been run against this design.

## Verification plan

Hand a document from a source project to a target and confirm the target's inbox gains a file carrying the source project and date. Boot a session in the target and confirm the inbound count appears in the injected context and in the rail. Confirm accepting files the note into the target's documents and dismissing removes it. Run the offline UI check and a typecheck alongside.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed from a user design question. Recommend the async-handoff shape over live
  messaging. Low prio / parked unless the user prioritizes it.

- 2026-08-06 — privacy scrub for public release (FEAT-049, sanctioned append-only exception): private names/paths neutralized (project aliases, home paths → ~).
