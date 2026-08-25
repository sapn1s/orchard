```orchard-ticket
{
  "id": "BUG-008",
  "type": "bug",
  "title": "Reattached sessions hid requests blocking the active turn",
  "summary": "Reattached sessions now restore outstanding approval, question, and plan requests, allowing blocked turns to continue. Previously, reloading or losing the connection removed the response card while the session continued showing as working.",
  "impact_if_we_wait": "Affected turns remain blocked until manually interrupted because the required response is invisible. Bounded: this affects session continuity and status display, not transcript data or unrelated sessions.",
  "current_need": "Treat the ticket as closed: reattachment, detachment, and live-reload cases passed, with the standing type check clean.",
  "severity": "high",
  "area": "Session reattachment",
  "reported": "2026-08-03",
  "reported_by": "bug-hunt workflow",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Reattachment restores every outstanding approval, question, and plan request",
    "Users can answer restored requests and allow the blocked turn to continue",
    "Reloaded sessions do not remain silently blocked while appearing to work"
  ],
  "code_refs": [
    {
      "path": "src/server/agent-bridge.ts",
      "symbol": "attach",
      "note": "Replays outstanding control requests to a newly attached client"
    },
    {
      "path": "src/server/index.ts",
      "symbol": null,
      "note": "Reattachment path previously emitted initialization events without pending requests"
    }
  ],
  "related": [
    {
      "id": "BUG-018",
      "relation": "see_also"
    },
    {
      "id": "BUG-020",
      "relation": "see_also"
    },
    {
      "id": "BUG-022",
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
    "Migration and rollback": false,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-008-pending-approval-question-plan-is-lost-on-re.md",
    "sha256": "eff662fcfede08f4adbb2750790a24e2a0ab3cd7e2e4f68dc20eb61ef045b411",
    "bytes": 6138,
    "original_title": "Pending approval/question/plan is lost on reattach — session shows 'working' while silently blocked forever",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the supplied ticket and extracted evidence; the symptom, cause, fix direction, scope, proof, and manual-interrupt escape are preserved.",
    "dropped": []
  }
}
```

# BUG-008 — Reattached sessions hid requests blocking the active turn

## Diagnosis

When the connection closed during an open control request, the session detached but retained the pending request and remained busy. Reattachment emitted an acknowledgement and synthetic session initialization without replaying pending requests. Because these requests were absent from the transcript, file following could not restore the missing card.

## Evidence

Before the fix, reloading during an approval, question, or plan request left the session showing as active while the required card was absent. `verify:reattach-approval` passed 11/11, `verify:detach` passed 7/7, and `verify:reload-live` passed 3/3. The standing typecheck was clean.

## Implementation notes

On attach and reattach, replay outstanding pending approval, question, and plan control requests to the newly attached client. This preserves the existing open turn and gives the user its response controls again.

## Verification plan

Open each supported control request, reload or disconnect, and reattach. Confirm the request card returns, accepts a response, and lets the turn continue. Exercise ordinary detachment and live reload behavior, then run the standing type check.

## Risks

Replaying a request that was already resolved could show stale controls or submit a duplicate response. Reattachment must replay only requests that remain outstanding.

## Activity log (APPEND-ONLY)

### 2026-08-03 — bug-hunt (read-only hunter)
- **Understood:** If the page reloads (or the socket drops) while a permission prompt, AskUserQuestion, or ExitPlanMode card is open, the reattached session presents as busy/working but never progresses. The card that would let the user answer is gone, so the turn is blocked indefinitely on a request the user can no longer see or respond to.
- **Verified:** diagnosis traced against source (see Repro); NOT yet reproduced with a running test.
- **Handoff:** On attach/reattach, replay any outstanding #approvals (pending approval/question/plan control requests) to the newly attached client so the user can answer the still-open turn.

### 2026-08-04 — fix + verification (subagent)
- **Understood:** The pending control request (approval/question/plan) lives ONLY in the session's in-memory `#approvals` map — it is never written to the transcript `.jsonl` (confirmed by the new test: the requestId is nowhere in a 17KB completed transcript). So when the driving socket dies mid-card, `ws.on('close')` detaches the busy session (index.ts:1882), the request stays pending and unanswered, and the reattach path (index.ts:1632) re-emitted only ack + synthetic session-init. A file-follower can NEVER surface the card, so replay from `#approvals` is the only recovery. Confirmed the emit shapes in `#onCanUseTool` (agent-bridge.ts:846): `question-request` / `plan-request` / `approval-request`, keyed by requestId; answers settle via `answerQuestion` / `answerPlan` / `answerApproval`, each deleting the map entry, and `#onCanUseTool`'s `once()` guard makes the promise resolve exactly once.
- **Changed:**
  - `src/server/agent-bridge.ts` — `PendingApproval` now retains the EXACT announce `event: StationEvent`. `#onCanUseTool` builds that event once, stores it on the pending entry, then emits it. Added `replayPending()`: re-emits every still-open pending event to the current `#emit` sink. Re-emitting is safe — same requestId, promise untouched, still settles once.
  - `src/server/index.ts` — reattach path (~1666) calls `running.replayPending()` AFTER the ack + session-init handshake, so the client has session context before the card lands.
  - `scripts/verify-reattach-approval.mjs` + `package.json` script `verify:reattach-approval` — new real-ws/real-haiku test.
- **Verified:**
  - `npm run verify:reattach-approval` → **PASS 11/11** (with fix). Drives a default-mode Write → real `approval-request`, drops socket A mid-card (session detaches, busy), re-attaches a NEW socket, asserts the SAME card is replayed (same requestId), answers it using ONLY the requestId the new socket was shown, asserts the turn unblocks (turn-end, file `REATTACHED` on disk, no interrupt marker), and asserts a duplicate answer is refused (`matched:false` → settled exactly once). Transcript-absence of the requestId asserted against the completed 17KB `.jsonl`.
  - **Negative control (fix git-stashed):** same test → **FAIL 6/11**. The 5 load-bearing checks fail: card not replayed to the new socket; the socket has no requestId to answer with → "turn is blocked forever" (the exact symptom); Write never ran; exactly-once check skipped. Proves the test is real, not a green-on-empty check.
  - `npm run verify:detach` → **PASS 7/7** (no regression to detach/reattach stream handover).
  - `npm run verify:reload-live` → **PASS 3/3** (no regression to reload-liveness).
  - `npm run typecheck` → **PASS** (tsc --noEmit clean).
- **Notes for reviewer:** An early version of the test answered with the id captured from the dead socket, which made it pass even pre-fix (a real reloaded user has no such id). Hardened to answer ONLY via the replayed card's requestId — that is what makes the negative control fail correctly. Constraints honored: no server touched on 4317, scratch servers on free ports killed by pid, no commit.
- **Handoff:** None — fixed and verified. Orchestrator to review diff + commit. Note: BUG-008 shares `src/server/index.ts` and `src/server/agent-bridge.ts` with other bridge tickets; serialize commits.
