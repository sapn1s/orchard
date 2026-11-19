```orchard-ticket
{
  "id": "BUG-300",
  "type": "bug",
  "title": "Multi-ref push refusal does not lead with the AGENT block",
  "summary": "A push whose refs carry different allowlist versions runs one child gate per group, so a passing group's lines can print before the failing group's AGENT block and groups are capped separately. The refusal still names the fix; only ordering and the combined cap are off. Split from BUG-272 (IV run ed4fcfa1).",
  "impact_if_we_wait": "Only multi-ref pushes are affected (git push of a branch plus a tag with different allowlists, or --follow-tags). The user's real flow is a single-branch push. A pasted multi-ref refusal is noisier but still names the fix.",
  "current_need": "Build one unified FAIL path: capture each group's output in the parent, print failing groups first with one AGENT block and one combined cap, then re-verify.",
  "severity": "low",
  "area": "leak-gate / push",
  "reported": "2026-11-19",
  "reported_by": "worker (BUG-272/ARCH-023 fixing r1, 2026-11-19)",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-11-19",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A multi-ref push refusal opens with exactly one AGENT block, followed by every failing group's hits before any passing group's lines.",
    "The combined multi-group output fits the same cap as a single-group refusal, ending with the (+N more) pointer when it overflows.",
    "Single-ref push output is unchanged (verify-bug-272-r3 and verify-arch-023-push-range stay green)."
  ],
  "code_refs": [],
  "related": [
    {
      "id": "BUG-272",
      "relation": "see_also"
    },
    {
      "id": "ARCH-023",
      "relation": "see_also"
    }
  ],
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

# BUG-300 — Multi-ref push refusal does not lead with the AGENT block

## What happened

BUG-272 r3 IV run ed4fcfa1 found that the BUG-272 hits-first refusal re-order covers single-group pushes only. Rescoped out of BUG-272 on 2026-11-19 because the user's request (paste a refusal to an orchestrator and have it fix it) is met for single-ref pushes, and the multi-ref refusal still carries the AGENT block and the hit lines (demonstrated in a synthetic scratch repo: a branch with a fixture address hit plus a tag with a different allowlist; exit 1, AGENT block and hit present, the passing tag group's PASS line printed after it, then the overall FAIL).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-11-19 — worker (BUG-272/ARCH-023 fixing r1, 2026-11-19)
- **Filed:** through the board tool; the record was validated before it was written.
