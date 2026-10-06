```orchard-ticket
{
  "id": "BUG-213",
  "type": "bug",
  "title": "A refused fork retries as a plain resume of its source",
  "summary": "When the server refuses a fork's start before its ack, the rollback re-arms the SOURCE session id as a plain resume (resumeOnNextSend, or a drain-wait row's drainWait). The next Enter, or the automatic drain-wait retry, resumes the source instead of forking it, so the fork is silently dropped and the message goes into the source session.",
  "impact_if_we_wait": "Medium. After a pre-ack refusal, the user's fork silently becomes a message to the original session. The staged fork bag also stays pending, so explicit override edits on that source run are not saved (the BUG-198 owner model).",
  "current_need": "Keep the fork intent through every pre-ack rollback (rollBackPendingStart, queueRetryableRefusal + attemptDrainRetry, handleLiveElsewhere, keepUnconfirmedStart), so a retry re-sends fork:true from the same source. Prove it with a routed-socket refusal of a row-menu fork.",
  "severity": "medium",
  "area": "fork lifecycle — public/app.js",
  "reported": "2026-09-29",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-09-29",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Row-menu fork, the first start refused before ack (non-retryable): the next Enter sends start with fork:true and the same resumeSessionId, never a plain resume.",
    "The same fork with a retryable refusal: the drain-wait self-retry sends fork:true.",
    "Must-FAIL on the current tree: the retry frame has no fork flag (observed 2026-09-29, see Evidence)."
  ],
  "code_refs": [],
  "related": [
    {
      "id": "BUG-198",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": true,
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

# BUG-213 — A refused fork retries as a plain resume of its source

## Symptom
Fork a session (row menu → Fork, or the frozen-bar Fork), type the first message and send. If the server refuses that start before its ack, the typed text comes back and the next Enter RESUMES the source session instead of forking it. With a retryable refusal the drain-wait self-retry does the same thing by itself. The user is told nothing about the dropped fork.

## Repro
1. Right-click session A → Fork → the same project. `armFork` sets `state.forkFrom = A`.
2. Send. `submit()` clears `state.forkFrom` and calls `startTurn(text, { resumeSessionId: A, fork: true })`. `startTurn` records `state.pendingStartResume = A` and does not record the fork.
3. The server refuses before ack (an `error` frame, not fatal). `rollBackPendingStart()` re-arms `state.resumeOnNextSend = A`.
4. Press Enter. `submit()` finds no `forkFrom`, takes `resumeOnNextSend`, and sends `start` with `resumeSessionId: A` and no `fork`.

## Evidence
Observed 2026-09-29 by the BUG-198 round-3 lane, on a real page over a routed real socket (scratch probe `~/.local/state/claude-station/scratch/bug198-r3/probe-forkrefuse.mjs`, SYNTHETIC store). The first frame was `{fork:true, resumeSessionId:A}`. After a non-retryable refusal, the retry frame was `{fork:null, resumeSessionId:A}`, and it carried the fork's staged overrides.

## Context pack (grows — the "where to look", so no agent cold-starts)
- `public/app.js`: `submit()` (the `state.forkFrom` branch clears it before `startTurn`), `startTurn` (`pendingStartResume`), `rollBackPendingStart`, `queueRetryableRefusal` (the row's `drainWait: resume`), `attemptDrainRetry` (`startTurn(item.text, { resumeSessionId })`, no fork), `handleLiveElsewhere`, `keepUnconfirmedStart`.
- BUG-198 consequence: the staged fork bag is a pending owner, so a plain resume (not a birth) never adopts it and nothing persists for the rest of that run. That resolves itself once the fork intent survives, because the retry is then a birth and its own init adopts the bag.
- Related: BUG-029 (pre-ack rollback), BUG-045 (drain-wait retry), BUG-090 (needs-fork: `pendingFork`/`forkFrom` already win in submit for that path), BUG-149, BUG-191.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-29 — agent
- **Filed:** through the board tool; the record was validated before it was written.
