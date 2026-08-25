```orchard-ticket
{
  "id": "FEAT-026",
  "type": "feature",
  "title": "Every session carried a long instruction preamble by default",
  "summary": "Each launched session was given the full working agreement document, about nine and a half kilobytes, on top of everything else injected. A proposal to split it into an always-sent core plus an on-demand full version was raised and then closed unbuilt, because other work had already trimmed the injected text and capped the routing section.",
  "impact_if_we_wait": "Nothing is at risk: the size concern that prompted this was resolved by other shipped work. Bounded to how much instruction text a session carries, not to correctness of any session behaviour.",
  "current_need": "Nothing is outstanding. This was closed without a build once the injected text shrank and the routing section gained a cap.",
  "severity": "low",
  "area": "Session instruction injection",
  "reported": "2026-08-04",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-06",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-04",
      "question": "Should the working agreement be split into an always-injected core and an on-demand full document?",
      "mode": "single",
      "options_keys": [
        "A",
        "B"
      ],
      "chosen": "B",
      "chosen_on": "2026-08-06",
      "chosen_by": "user",
      "note": "Closed without build. The consolidation work under FEAT-019 slimmed the document from 14255 to 12949 bytes and relocated project-specific leaks, and FEAT-043 added a capped condensed routing section, so a core/full split would add machinery with no remaining need."
    }
  ],
  "success_criteria": [
    "Not recorded"
  ],
  "code_refs": [
    {
      "path": "docs/prompts/WORKING_AGREEMENT.v2.md",
      "symbol": null,
      "note": "the document proposed for a core/extended split under FEAT-026; the injected template would have carried a pointer to it"
    }
  ],
  "related": [
    {
      "id": "FEAT-019",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-021",
      "relation": "see_also"
    },
    {
      "id": "FEAT-038",
      "relation": "blocks"
    },
    {
      "id": "FEAT-043",
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
    "Verification plan": true,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-026-wa-core-full-split.md",
    "sha256": "a1b02e589fa9cbc0cb45c864dde6c087048e907ae9635e3a45fb4690b1a48edb",
    "bytes": 1702,
    "original_title": "Split the Working Agreement into CORE (always-injected) vs FULL (on-demand)",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Checked against the original head section by section: the size pressure, the core-versus-extended tagging, the pointer-plus-budget design, the planned checks and the closure reasoning are all present.",
    "dropped": []
  }
}
```

# FEAT-026 — Every session carried a long instruction preamble by default

## Diagnosis

The working agreement was roughly 9.6KB and was injected into every launched session, with a per-session board snapshot planned to land on top of it. The attention-budget argument applies to the model as much as to a person: an always-on preamble that only grows dilutes signal and costs tokens on every turn.

## Evidence

The consolidation pass reduced the document from 14255 bytes to 12949 bytes and moved project-specific material out of it. A separate change capped the condensed routing section. Together those removed the growth pressure this ticket was raised against, which is what the closure rests on — no build ran and no size assertion was written.

## Implementation notes

The design was to tag sections as core — output contract, orchestration, verification, git and process safety, the ambient-versus-instructions rule — versus extended, covering examples, rationale and project-specific material. The injected template would then be core plus a one-line pointer to the full document, with a size budget on core enforced by the consolidation pass.

## Verification plan

The composed session prompt would contain the core sections and the pointer while staying under the budget, with the full document still carrying everything. A typecheck and a size assertion were planned.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed from R2. Pairs with FEAT-021 (both add to the injected surface).

### 2026-08-06 — orchestrator
- Closed per user ('026 ok') — obsoleted by auto-consolidation; reopen if the injected surface grows past budget again.
