```orchard-ticket
{
  "id": "BUG-079",
  "type": "bug",
  "title": "Messages crossed sessions or disappeared",
  "summary": "Session changes now discard pending delivery state, preventing messages from disappearing or reaching another session. Pre-fix cases demonstrated both failures, corrected cross-session behavior passed, and same-session retry and forced delivery remained intact.",
  "impact_if_we_wait": "Without the correction, a refused message could disappear or interrupted text could reach the wrong session. Bounded: this affects pending message delivery during session switches, not stored transcripts or unrelated session data.",
  "current_need": "Treat the ticket as closed: the pre-fix cases failed, corrected cross-session behavior passed, and standing checks stayed clean.",
  "severity": "high",
  "area": "Session message delivery",
  "reported": "2026-08-12",
  "reported_by": "area-review workflow",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-12",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Switching sessions clears pending drain-wait retry state and cancels its timer",
    "Switching sessions clears forced-delivery state and cancels its watchdog",
    "A retryable refusal after switching queues the new session's message",
    "A turn ending after switching cannot deliver the previous session's text",
    "Same-session self-retry and forced delivery continue working"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": "resetTranscript",
      "note": "Session boundary that cleared the queue but retained other pending-delivery state"
    },
    {
      "path": "public/app.js",
      "symbol": "closeSocket",
      "note": "Socket transition that retained pending-delivery pointers"
    },
    {
      "path": "public/app.js",
      "symbol": "openSession",
      "note": "Session transition that retained pending-delivery pointers"
    },
    {
      "path": "public/app.js",
      "symbol": "queueRetryableRefusal",
      "note": "A stale drain-wait attempt suppressed creation of the new queue row"
    },
    {
      "path": "public/app.js",
      "symbol": "forceSend",
      "note": "Stored interrupted text until a later turn-end handler consumed it"
    },
    {
      "path": "public/app.js",
      "symbol": "deliverForced",
      "note": "Could deliver stored text through the currently open session"
    }
  ],
  "related": [
    {
      "id": "BUG-045",
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
    "archived_path": "docs/bugs/archive/BUG-079-session-switch-leaks-pending-delivery-state.md",
    "sha256": "0826dabd65accf5c6ec0ec2154a3933955b56c3c71cae515e4034fa9592d691d",
    "bytes": 5706,
    "original_title": "session switch doesn't clear pending delivery state: message lost OR delivered into the wrong session",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared field by field with the supplied ticket; both failure modes, shared cause, boundary cleanup, timer handling, regressions, and executed evidence remain represented.",
    "dropped": []
  }
}
```

# BUG-079 — Messages crossed sessions or disappeared

## Diagnosis

`resetTranscript`, `closeSocket`, and `openSession` cleared `state.queue` without clearing `state.drainWaitAttempt` or `state.forceSend`. The stale drain-wait pointer suppressed queuing after a retryable refusal, losing the cleared message. The stale force-send pointer could later deliver session A's text through session B's socket.

## Evidence

With the pre-fix `app.js` restored, all six required failure cases failed as intended. After correction, `verify:resume-refusal` passed 13/13 and `verify:refusal-visible` passed 19/19. Another matched set recorded 10/10 without an adjacent suite name. Typecheck and leak-gate were clean. `verify:queue`, `verify:ui`, and `verify:bug-079-session-switch-state` were named without recorded results.

## Implementation notes

Clear both pending-delivery pointers on `resetTranscript`, `closeSocket`, and `openSession`. Cancel the drain-wait ghost-release timer and force-send watchdog at the same boundaries. Audit sibling pending-delivery pointers while preserving retry and forced-delivery behavior within one session.

## Verification plan

Exercise a drain-wait retry in session A, switch to B, trigger a retryable refusal, and require B's message to enter its queue. Separately, start forced delivery in A, switch to B, and require B's turn-end to deliver only B's text. Repeat both flows without switching to protect same-session behavior.

## Risks

Clearing pending state too broadly could break same-session self-retry or forced delivery. Missing timer cancellation could allow cleared state to be recreated or acted upon after the switch.

## Activity log (APPEND-ONLY)
### 2026-08-12 — orchestrator
- Filed from the area-review workflow (two fe-core findings, same root cause — session-switch does
  not clear pending-delivery pointers). Client-only, no deploy. app.js lane.

### 2026-08-12 — worker (fix + §C)
- Root cause confirmed exactly as filed: `resetTranscript()` zeroes `state.queue` but leaves
  `state.drainWaitAttempt` (+ its self-retry interval) and `state.forceSend` (+ the force-send
  watchdog) pointing at the abandoned session.
- Fix: new `clearPendingDelivery()` helper (public/app.js, next to cancelForceSend) clears
  drainWaitAttempt + `disarmDrainWaitRetry()`, forceSend + `clearTimeout(busyWatchdog)`, and the
  audited siblings pendingStart/pendingStartResume/pendingSend. Called from the THREE true boundary
  entry points: `openSession` (in the "never inherit" block), `startNew`, and the route-resolves-to-
  no-session path in the hash router.
- Design note (preserving same-session behaviors): the helper is DELIBERATELY not called from
  `resetTranscript()`/`closeSocket()` themselves — both are re-entered WITHIN a single session
  (BUG-045 drain-retry runs `attemptDrainRetry -> startTurn -> resetTranscript` with drainWaitAttempt
  already set; the FEAT-065 relay close runs `closeSocket` while the drain-wait loop must keep going),
  so clearing there would break exactly the behaviors the ticket says to preserve. Calling only at the
  boundary entry points fixes both findings without touching the same-session paths.
- Sibling audit (the same pending-delivery class): `resumeOnNextSend`, `deliveryRelay`,
  `pendingAnswers` are ALREADY cleared by `closeSocket()`; `pendingStart`/`pendingStartResume`/
  `pendingSend` were NOT cleared on a switch and are now cleared too (belt-and-braces — the outgoing
  session's in-flight `start` text / optimistic bubble).
- §C — scripts/verify-bug-079-session-switch-state.mjs (real app.js in happy-dom against a real
  server; real openSession switch via row click; wire events staged through the real onEvent):
  - PRE-FIX (app.js stashed): the 6 must-FAIL assertions FAILED — after the switch drainWaitAttempt
    survived ("A drain-wait row (stale)"), drainWaitTimer stayed armed, forceSend + busyWatchdog
    survived, B's own retryable refusal was DROPPED (queue 0->0), and A's force text was INJECTED
    into B (bubble present). Same-session regressions that ran stayed green.
  - POST-FIX: 10/10 PASS (6 boundary/behavioral + 2 same-session regressions: FEAT-031 force-send
    within its own session still delivers; BUG-045 re-refused self-retry keeps exactly one row).
  - Anti-regressions all green: verify:queue (14/0), verify:resume-refusal (13/13),
    verify:refusal-visible (19/19), verify:ui (7/0), typecheck (0), leak-gate (PASS).
- Commit: BUG-079: session switch clears pending drain-wait + force-send state (no loss, no wrong-target delivery).
