```orchard-ticket
{
  "id": "BUG-282",
  "type": "bug",
  "title": "Session list can stay incomplete when a session file is future-dated",
  "summary": "FEAT-199 r9 IV (anthropic run 6567f228) found two reconcile-guard gaps, both needing a page-1 session file with a future (clock-skewed) mtime: a delete plus an add keep the union count equal to the total, so the guard never fires; a failed reconcile is not retried. Accepted residual; a reload shows the full list.",
  "impact_if_we_wait": "With clock-skewed session files, a session can be missing from the scrolled list until reload.",
  "current_need": "reconcile unconditionally once when paging reaches the end (compare ids, not counts) and retry a failed reconcile; first measure whether any real session file has a future mtime.",
  "severity": "low",
  "area": "ui/performance",
  "reported": "2026-10-28",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-10-28",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Reaching the end of the list always yields the full set by id, even with future-dated files"
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "64129a8c-3304-4f7d-a6c4-203b1baefdbd",
      "verdict": "holds",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T03:45:47.562Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "93348e163b7e31458e468011b7a9a6306fcb88796be2989a9165196e2151593d",
      "verify_mode": "mixed-state"
    }
  ],
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

# BUG-282 — Session list can stay incomplete when a session file is future-dated

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-28 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-28 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run 64129a8c-3304-4f7d-a6c4-203b1baefdbd — VERDICT: HOLDS — mixed-state candidate 93348e163b7e. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — fixing lane r9 (worker)
- **Fixed under FEAT-199 round-9 — see that ticket's 2026-10-28 r9 entry for the full narrative.** Real store measured read-only: 13141 `.jsonl` files, **0 with a future mtime** (max skew 0.000 h), so the clock-skew precondition does not occur on this machine today; the fix is by-construction insurance. When the keyset walk reaches hasMore=false the client now ALWAYS reconciles once against the authoritative full list BY ID (no count guard), covering both gaps run 6567f228 found: the equal-count/different-members case (a delete of an already-shown row leaves a ghost while a stranded add keeps the union count equal to the total) and the failed reconcile that silently latched. A failed reconcile flags `listIncomplete` (a visible "list may be incomplete — retry" hint), retries with backoff, and is cleared by a successful reconcile / the retry button / a page-1 reload.
- **Success criterion met:** "Reaching the end of the list always yields the full set by id, even with future-dated files" — proven by scripts/verify-feat-199-r9.mjs (pure-model must-FAILs for both breaks + REAL headless-browser E1 future-head delete+bump == full by id and E2 failed-reconcile → visible hint, not a silent latch, then retry → 150/150). Independent verify: anthropic run 64129a8c — VERDICT HOLDS (VALID, manifest-backed), candidate 93348e163b7e. Files: public/app.js, public/styles.css, scripts/verify-feat-199-r9.mjs.
