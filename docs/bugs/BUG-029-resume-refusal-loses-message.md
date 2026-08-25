```orchard-ticket
{
  "id": "BUG-029",
  "type": "bug",
  "title": "Refused resume discarded the typed message",
  "summary": "Refused resume attempts now restore the typed message, remove the temporary message bubble, release the busy state immediately, and prepare a clean retry. The client change is live after reload; server retryability metadata arrives with the next service restart.",
  "impact_if_we_wait": "Until the routine restart, the server omits retryability metadata, but the client rollback is already live. Bounded: this affects refused-resume messaging and status display, not persisted transcripts or other sessions.",
  "current_need": "Treat the ticket as closed: the refused-resume case and interface suite passed after the correction, and type checking stayed clean.",
  "severity": "high",
  "area": "Resumed message delivery",
  "reported": "2026-08-05",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-05",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A refused resume restores the typed message to the composer",
    "The temporary message bubble disappears when the turn never starts",
    "Busy state clears immediately without a delayed status change",
    "The next submission retries the same resumed session cleanly"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": "startTurn",
      "note": "Stores the resume target with the pending message before opening the connection."
    },
    {
      "path": "public/app.js",
      "symbol": "case 'error'",
      "note": "Rolls back a refused pre-turn start before the busy watchdog branch."
    },
    {
      "path": "public/app.js",
      "symbol": "rollBackPendingStart",
      "note": "Restores composer text, removes the temporary bubble, closes the unused socket, and prepares retry."
    },
    {
      "path": "src/server/index.ts",
      "symbol": "survivor guard",
      "note": "Marks the refusal as retryable while the earlier server finishes draining the transcript."
    }
  ],
  "related": [
    {
      "id": "BUG-022",
      "relation": "depends_on"
    },
    {
      "id": "BUG-027",
      "relation": "see_also"
    },
    {
      "id": "BUG-028",
      "relation": "see_also"
    },
    {
      "id": "BUG-033",
      "relation": "see_also"
    },
    {
      "id": "BUG-038",
      "relation": "see_also"
    },
    {
      "id": "FEAT-015",
      "relation": "see_also"
    },
    {
      "id": "FEAT-040",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-029-resume-refusal-loses-message.md",
    "sha256": "8f9cb51ec8065f7157c6a4d2f63c7ff43e0559375d7ae4aef21dcdc7d9726a9b",
    "bytes": 5453,
    "original_title": "resume refused while a survivor drains loses the typed message + toggles the banner",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared line by line with the archived BUG-029 text; the symptom, cause, correction, rollout boundary, related work, and executed evidence remain represented.",
    "dropped": []
  }
}
```

# BUG-029 — Refused resume discarded the typed message

## Diagnosis

The resume path optimistically added the typed message, cleared the composer, marked the session busy, and sent a start request. While a FEAT-015 survivor was still draining the same transcript, the server correctly refused that request before acknowledgement. The client treated the nonfatal refusal like a stalled running turn, retained a session-less socket, and later released the composer through a misleading watchdog message.

## Evidence

Before the fix, verify:resume-refusal failed 4/5 cases. After the fix, verify:resume-refusal passed 5/5, verify:ui passed 7/7, and typecheck completed cleanly. The original live symptom included a disappearing typed message, a temporary message bubble, and a banner that changed after four seconds.

## Implementation notes

The server marks the survivor-guard response `retryable: true`. The client records `state.pendingStartResume` with `state.pendingStart`. A refusal received before the start acknowledgement invokes `rollBackPendingStart()`, restores the composer, removes the last main `.you` bubble, closes the half-open socket intentionally, arms `state.resumeOnNextSend`, and clears busy state immediately.

## Verification plan

Drive a resume whose start is refused before acknowledgement. Confirm the message returns to the composer, the temporary bubble disappears, busy state clears immediately, and the next submission reconnects and retries the same resume.

## Migration and rollback

The client half becomes active on reload. The retryable server flag becomes active with the next :4317 restart. Either half can be reverted independently through its orchestrator commit.

## Risks

The rollback must apply only before a start acknowledgement. Applying it to a running turn could restore text that was already accepted or remove a legitimate message bubble.

## Activity log (APPEND-ONLY)
### 2026-08-05 — main
- Diagnosed from live user report. Confirmed hosts dir empty at diagnosis time (the drain window
  had passed), server healthy — so the fault is purely the client's handling of the (correct)
  retryable refusal.
- **Changed:**
  - `src/server/events.ts` — `error` event gains `retryable?: boolean`.
  - `src/server/index.ts` — survivor-drain guard error now carries `retryable: true`.
  - `public/app.js` — `state.pendingStart`/`pendingStartResume` documented + stashed in
    `startTurn()`; new `rollBackPendingStart()`; `case 'error'` routes a pre-turn (never-acked)
    refusal there instead of the 4s watchdog; `pendingStartResume` cleared on the `start` ack.
  - `scripts/verify-resume-refusal.mjs` + `package.json` `verify:resume-refusal` — new regression
    test: plants a survivor-host status file (real live dummy pid) for a real on-disk session and
    drives the REAL app.js to resume it, forcing the guard with no systemd/slow-turn.
- **Verified:**
  - `npm run typecheck` — PASS.
  - `npm run verify:resume-refusal` — 5/5 PASS (message kept, phantom bubble rolled back, composer
    released immediately, retryable refusal recognised).
  - Confirmed the test FAILS 4/5 on pre-fix code (git stash of the 3 source files) → genuine guard.
  - `npm run verify:ui` — 7/7 PASS (no regression to the normal live/resume paths).
- **Still open / handoff:** none for the client fix. Not yet committed (awaiting user's go-ahead per
  repo convention). The server correctly refuses during a real drain window (BUG-022) — this ticket
  only fixes the client's honesty about it.
