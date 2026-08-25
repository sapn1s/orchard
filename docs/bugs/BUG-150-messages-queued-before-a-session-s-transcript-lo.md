```orchard-ticket
{
  "id": "BUG-150",
  "type": "bug",
  "title": "Messages queued before a session's transcript loads are not stored",
  "summary": "openSession sets state.current, then awaits the transcript fetch, and only calls adoptQueue afterwards. Until that call, queueKey is null and persistQueue writes nothing. Anything queued in that window lives only in the tab's heap — the exact condition BUG-129 exists to end.",
  "impact_if_we_wait": "A message typed in the moment right after opening a session is silently non-durable. It looks queued and is not stored, so a reload or a tab close destroys it with no signal, which is the failure class the board treats as the worst this product has.",
  "current_need": "confirm the window is reachable by a person (not only by a script), then close it",
  "severity": "medium",
  "area": "Composer message queue",
  "reported": "2026-08-25",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A message queued at any point after a session is on screen is written to storage",
    "Adoption of the stored rows never duplicates a row already in state.queue",
    "The BUG-129 suite still passes unchanged"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": "openSession",
      "note": "adoptQueue() is called after the awaited transcript fetch; queueKey stays null until then"
    },
    {
      "path": "public/app.js",
      "symbol": "queueTargetKey",
      "note": "returns null while queueKey is null, so persistQueue is a no-op for rows queued in that window"
    }
  ],
  "related": [
    {
      "id": "BUG-129",
      "relation": "see_also"
    },
    {
      "id": "BUG-149",
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

# BUG-150 — Messages queued before a session's transcript loads are not stored

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-25 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-25 — agent
- **Evidence — how this was noticed:** Found while verifying BUG-149, not by looking for it. The BUG-149 suite queues a message immediately after the session row is clicked (as soon as state.current.sessionId settles) and then reads localStorage. In the PRE-FIX leg the store was empty — "(nothing stored)" — even though the dock showed the row on screen. In the FIXED leg the same row WAS stored, because the refusal handler paints the dock again a second or two later, by which time adoptQueue has run and queueKey is set. So the write is not reliable; it is rescued by whatever happens to repaint after the fetch returns. The ordering in openSession is the cause: state.current is set, the transcript fetch is awaited, and adoptQueue() (which assigns queueKey) runs only after it. NOT PROVEN against a human typing speed — a person may never be fast enough to land in the window. That is exactly what current_need asks for before anything is changed.
