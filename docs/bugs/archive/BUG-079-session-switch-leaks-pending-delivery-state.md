# BUG-079 — session switch doesn't clear pending delivery state: message lost OR delivered into the wrong session

- **Status:** VERIFIED — fixed 2026-08-12 (both findings, one root cause; §C incl. must-FAIL-pre-fix proof + same-session regressions)
- **Area:** public/app.js — session-switch state hygiene (drain-wait + force-send)
- **Reported:** 2026-08-12 by the area-review workflow (fe-core reviewer + skeptic verify)

## Root cause (shared)
`resetTranscript()` (app.js:2163), `closeSocket()` (:5141/:5181), and `openSession()` (:3211)
zero `state.queue` but do NOT clear two other pending-delivery pointers, so they survive a session
switch and act on the WRONG session:

### Finding A — `state.drainWaitAttempt` (message LOSS)
`queueRetryableRefusal()` reads `retried = state.drainWaitAttempt` (:5326) and only creates a
drain-wait queue row when `!retried` (:5354). Stale after a session switch (or during the 15s
ghost-release grace at :5394-5395 after a self-retry whose socket died unacked). If the user then
sends a message that gets a retryable refusal, `retried` is truthy from the orphaned attempt → the
enqueue branch is skipped, composer already cleared, bubble removed, socket closed → **text
permanently lost** (composer + queue + screen).

### Finding B — `state.forceSend` (WRONG-TARGET delivery)
`forceSend()` stashes the item in `state.forceSend` after an interrupt (:6644-6662); consumed only
by the turn-end handler `if (state.forceSend){ deliverForced(item) }` (:6390-6394) over whatever
`state.ws` is currently open. Not cleared on switch. Force-send on A (interrupt sent, turn still
running), switch to B before A's turn-end lands → the stash persists → B's next turn-end delivers
**A's text into B**, and A's intended message is lost.

## Wanted
Clear BOTH `state.drainWaitAttempt` and `state.forceSend` (and audit for any sibling pending-
delivery pointers in the same class) on every session-boundary transition — resetTranscript /
closeSocket / openSession — with any live timers (the drain-wait ghost-release, force-send
watchdog) cancelled too. Preserve the same-session behaviors: BUG-045 self-retry still works within
one session; force-send still delivers within its own session.

## Verification (§C)
happy-dom/real-shape: (A) session A mid drain-wait self-retry → switch to B → send in B →
retryable refusal → B's message is QUEUED (row created), never lost (must FAIL pre-fix: dropped);
(B) force-send in A → switch to B → send in B → turn-end delivers B's own text only, A's stash is
gone (must FAIL pre-fix: A's text injected into B). Same-session BUG-045 retry + force-send
regressions green. Anti-regressions: verify:queue, verify:resume-refusal, verify:refusal-visible,
verify:ui, typecheck, leak-gate.

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
