# BUG-008 — Pending approval/question/plan is lost on reattach — session shows 'working' while silently blocked forever

- **Status:** VERIFIED
- **Severity:** high
- **Area:** bridge-sessions / detach-reattach
- **Reported:** 2026-08-03 by bug-hunt workflow

## Symptom
If the page reloads (or the socket drops) while a permission prompt, AskUserQuestion, or ExitPlanMode card is open, the reattached session presents as busy/working but never progresses. The card that would let the user answer is gone, so the turn is blocked indefinitely on a request the user can no longer see or respond to.

## Repro
1) Direct-isolation session (approvals on) triggers an approval/question/plan card; turn is busy=true, blocked in #onCanUseTool awaiting canUseTool. 2) Reload (F5): no beforeunload handler, ws closes at TCP level, ws.on('close') sees busy && !closed and calls session.detach(); the PendingApproval stays in #approvals, no 'result' arrives, busy stays true. 3) Reloaded page auto-opens; liveRecordFor reports drivenByDashboard+busy so client shows 'still running… following live'. 4) User sends a message -> reattach (index.ts ~1632) calls running.attach(send) and re-emits only ack + synthetic session-init; it never replays #approvals, and control requests are not in the transcript file so file-follow can't surface them. Message queues for a pause that never comes; only a manual interrupt escapes.

## Expected
Honest, correct behavior — see fix direction.

## Context pack
- Suspect file(s): src/server/agent-bridge.ts:705 (attach) + src/server/index.ts:1632 (reattach never replays #approvals)
- Fix direction: On attach/reattach, replay any outstanding #approvals (pending approval/question/plan control requests) to the newly attached client so the user can answer the still-open turn.
- Touches: SERVER — check file overlap before parallel dispatch
- Related: none
- Repro test: none yet — the fixing agent MUST add a verify script that FAILS on current code and passes after.

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
