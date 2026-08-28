```orchard-ticket
{
  "id": "FEAT-110",
  "type": "feature",
  "title": "Refuse private-token leaks at ticket-write time, not just at commit",
  "summary": "Board tool file/update now refuse a ticket write carrying a home path, username or private project name, reusing the leak-gate token list — closing the authoring-time gap that let BUG-155 and BUG-156 leak.",
  "impact_if_we_wait": "Every leaked ticket blocks the gate for all lanes and needs a redaction; on a public repo an un-caught one is an exposure the moment it is pushed, recoverable only by a history rewrite.",
  "current_need": "Review the built guard; decide whether to also add a turn-end/pre-commit hook to cover Write-tool-authored tickets (the residual gap).",
  "severity": "medium",
  "area": "board tooling / publish-safety",
  "reported": "2026-08-27",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-08-27",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A board-tool ticket write carrying a private token is refused before it lands.",
    "The detector is the leak-gate token list, not a second matcher.",
    "A clean ticket, and a ticket discussing token shapes, are not blocked."
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

# FEAT-110 — Refuse private-token leaks at ticket-write time, not just at commit

'"$BODY"'

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-27 — agent
- **Filed:** through the board tool; the record was validated before it was written.
