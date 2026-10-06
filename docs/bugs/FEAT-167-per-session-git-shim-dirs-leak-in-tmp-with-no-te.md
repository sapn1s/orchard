```orchard-ticket
{
  "id": "FEAT-167",
  "type": "feature",
  "title": "Per-session git shim dirs leak in /tmp with no teardown",
  "summary": "Each session's git shim lives in its own /tmp/orchard-git-shim-* dir, one per session, and nothing removes it. BUG-230 correctly made install never delete a dir, but left no owner teardown, so the dirs accumulate. Cleanup cannot key on server stop: survival sessions outlive a restart, and removing a live session's shim reopens the BUG-230 ungated-git hole.",
  "impact_if_we_wait": "Unbounded accumulation of shim dirs in /tmp, one per session per boot (/tmp is wiped on reboot, swept at 10 days, but it litters a busy host). No lifecycle owner means any future cleanup written without the right signal risks deleting a live session's shim.",
  "current_need": "A teardown that removes a session's shim dir exactly when that session's CLI has TRULY exited — not on server stop. The work is defining and plumbing a reliable 'CLI really gone' signal and hanging shim-dir removal off it alone.",
  "severity": "low",
  "area": "FEAT-135 / BUG-230 git shim lifecycle",
  "reported": "2026-10-05",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-10-05",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A session's shim dir is removed once its CLI process has truly exited.",
    "A survival/background session's shim dir SURVIVES an Orchard server restart while that session is still alive.",
    "No cleanup path keys on server shutdown to remove a shim dir."
  ],
  "code_refs": [],
  "related": [
    {
      "id": "BUG-230",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "plan+review",
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

# FEAT-167 — Per-session git shim dirs leak in /tmp with no teardown

### Evidence

Follow-up (1) in the BUG-230 fixing-r1 Activity log. Before BUG-230 every top-level session already leaked one shim dir; BUG-230 (install never deletes; the owner's teardown deletes) makes the missing teardown visible as a steady leak.

### Diagnosis

Ownership of the shim dir is declared at creation (BUG-230's install handle), but no code holds the other end of the lifecycle: deletion. Deletion cannot key on server shutdown because a survival/background session's CLI keeps running across an Orchard restart and its shim must survive with it (removing it reopens the fall-through-to-real-git hole).

### Fix direction (not built)

Introduce a 'CLI process truly exited' signal (observe the session's CLI pid/exit, not the server's) and remove the shim dir only on it. Until such a signal exists, leaving the dirs is the safe choice. See the liveness/store-isolation authorities for where session-process liveness is already tracked.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-05 — agent
- **Filed:** through the board tool; the record was validated before it was written.
