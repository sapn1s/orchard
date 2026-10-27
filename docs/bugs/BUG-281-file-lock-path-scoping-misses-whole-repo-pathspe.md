```orchard-ticket
{
  "id": "BUG-281",
  "type": "bug",
  "title": "File-lock path-scoping misses whole-repo pathspecs on simple git lines",
  "summary": "BUG-277 r9 IV (anthropic run 2c55fd7b) found gitMutationTarget keys whole-repo pathspecs narrow on a simple line: git magic :/ (restore/checkout/rm), paths normalizing to the repo root or above (src/.., $PWD), and globs (git checkout -- *). A real-git wipe passed a foreign lock. Pre-existing, independent of BUG-277 count logic.",
  "impact_if_we_wait": "A simple git command can wipe another lane uncommitted work despite the file lock.",
  "current_need": "in gitMutationTarget treat magic pathspecs, root-or-above normalizations and glob metacharacters as whole-tree; must-FAIL from current code; independent verify.",
  "severity": "high",
  "area": "lanes/file-lock",
  "reported": "2026-10-27",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-10-27",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "checkout/restore/rm with :/, a root-normalizing path or a glob is classified whole-tree under a foreign lock"
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

# BUG-281 — File-lock path-scoping misses whole-repo pathspecs on simple git lines

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-27 — agent
- **Filed:** through the board tool; the record was validated before it was written.
