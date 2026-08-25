# BUG-013 — After a budget stop, the composer stays enabled and paints 'delivered' bubbles for messages the server rejects

- **Status:** VERIFIED
- **Severity:** medium
- **Area:** bridge-sessions / budget stop
- **Reported:** 2026-08-03 by bug-hunt workflow

## Symptom
Once a session hits maxBudgetUsd, every further sent message is silently dropped: a 'you' bubble appears as if delivered and the button spins, but Claude never receives it. Only a red toast and a 4s watchdog release hint at failure; the phantom bubble stays in the transcript.

## Repro
1) Start a session with a small maxBudgetUsd. 2) A turn pushes totalCostUsd over budget: result handler sets budgetStopped=true and emits a NON-fatal error but does not close the session or set client-visible locked state (app.js has zero budget/budgetStopped handling); turn-end already set busy=false so the composer is enabled. 3) Send a message: submit() hits state.live && !busy, appends youBubble, setBusy(true), send({type:'send'}). 4) Server AgentSession.send() throws 'session stopped: budget exceeded' (agent-bridge.ts:562); ws outer catch emits {t:'error',fatal:false}, no delivered ack. 5) Client arms 4s watchdog, releases busy with a toast, but never removes the youBubble.

## Expected
Honest, correct behavior — see fix direction.

## Context pack
- Suspect file(s): src/server/agent-bridge.ts:562 (send throws) + public/app.js:4098 (youBubble painted before ack)
- Fix direction: Propagate a budgetStopped/locked state to the client and lock the composer after a budget stop; also roll back the optimistic youBubble when a send is rejected (as the mid-turn-queue path already does).
- Touches: FRONTEND (public/app.js or drawer.js) — serialize with other frontend tickets
- Related: none
- Repro test: none yet — the fixing agent MUST add a verify script that FAILS on current code and passes after.

## Activity log (APPEND-ONLY)

### 2026-08-03 — bug-hunt (read-only hunter)
- **Understood:** Once a session hits maxBudgetUsd, every further sent message is silently dropped: a 'you' bubble appears as if delivered and the button spins, but Claude never receives it. Only a red toast and a 4s watchdog release hint at failure; the phantom bubble stays in the transcript.
- **Verified:** diagnosis traced against source (see Repro); NOT yet reproduced with a running test.
- **Handoff:** Propagate a budgetStopped/locked state to the client and lock the composer after a budget stop; also roll back the optimistic youBubble when a send is rejected (as the mid-turn-queue path already does).

### 2026-08-04 — fixing agent (BUG-013)
- **Understood:** confirmed the exact trace from the hunter: `AgentSession.send()` throws `'session stopped: budget exceeded'` (src/server/agent-bridge.ts:570, was ~562 before other edits shifted lines), the result handler flips `budgetStopped=true` and emits a non-fatal `{t:'error'}` with no client-visible flag (agent-bridge.ts ~1093-1104, was ~ the same area), `turn-end` already cleared `busy`, and app.js had zero handling for the budget case — a second send painted an optimistic `.you` bubble that server rejection could never undo. Note for future agents: `rg`/`grep` on `agent-bridge.ts` without `-a` silently reports NO matches — the file contains a legitimate `/\x00/g` regex literal (null-byte strip) that trips grep's binary-file heuristic. Always `grep -a` or `rg -a` on this file.
- **Changed** (server, in scope — did NOT touch src/server/index.ts, which was out of scope for this ticket):
  - `src/server/events.ts`: added optional `budgetStopped?: boolean` to the `{t:'error'}` variant of `StationEvent`. This is the ONE flag that means "this session will never send again" (not `fatal` — the session/transcript stay readable, only sends are refused).
  - `src/server/agent-bridge.ts`:
    - the budget-stop emission in the `result` handler now sets `budgetStopped: true` on the error event.
    - `replayPending()` (the BUG-008 reattach hook, already called by index.ts after every reattach handshake) now ALSO re-emits the budget-stop error if `this.budgetStopped` is true, so a page reload / second-tab reattach to an already budget-stopped session is told immediately, instead of showing an enabled composer that `send()` will unconditionally throw on. This was necessary because `index.ts` (out of scope) is the only place `attach()`/`replayPending()` are called from, so the re-notification had to live inside the already-open `replayPending()` hook in the in-scope file.
    - Left `send()`'s throw message (`'session stopped: budget exceeded'`) unchanged — index.ts's generic ws catch turns it into `{t:'error', fatal:false}` with no flag (since I could not touch index.ts's `case 'send'` to check `budgetStopped` proactively). The client matches this exact literal string as a fallback signal (see below) — belt-and-braces alongside the authoritative `budgetStopped:true` flag.
  - `public/app.js`:
    - `state.budgetLocked` / `state.budgetLockReason` / `state.pendingSend` added.
    - a `.frozen`-styled lock banner (`node.budgetLocked`, reusing the existing CSS class the `#dropped`/`#frozen` panels use) is built and inserted into the DOM entirely from JS (no index.html edit — out of scope) right after the `#dropped` panel.
    - `paintComposerFor`: when `state.budgetLocked` and the thread isn't an agent thread, hides `#box` and shows the lock banner with the server's reason text — outranks every other composer state (windows-frozen, history-gap) and survives thread switches/repaints (only `closeSocket()`/a fresh `connect()` clears it).
    - `onEvent`'s `'error'` case: new `isBudgetStop(e)` helper matches either the `budgetStopped:true` flag or the literal throw-message fallback; on match it latches `state.budgetLocked`, rolls back any in-flight optimistic bubble (`rollBackPendingSend()`), releases busy, fails the queue, and repaints the composer.
    - `submit()`: refuses at the source if `state.budgetLocked` (before painting anything); otherwise tracks the bubble it just painted in `state.pendingSend` so a race (send fired just before the lock latched) can still be rolled back and its text handed back to the composer instead of losing it.
    - `state.pendingSend` is cleared (without touching the DOM) on every settle path that means the turn actually landed or the ambiguity resolved without a budget rejection: `turn-end`, `session-closed`, the busy watchdog timeout, and on `connect()`/reconnect.
- **Verified:**
  - `npm run typecheck` — PASS (clean).
  - `npm run verify:ui -- --offline` — PASS (3/3).
  - `node scripts/verify-queue.mjs` (anti-regression — shares `setBusy`/`submit`/error-handling code paths) — PASS (8/8).
  - `node scripts/verify-reattach-approval.mjs` (anti-regression — shares `replayPending()`) — PASS (11/11).
  - New `scripts/verify-budget-stop.mjs` (`npm run verify:budget-stop`), real Brave (headless, CDP) + real server + one real cheap haiku turn against `maxBudgetUsd: 0.000001` so the first turn's real cost already trips the stop:
    - PASS the client latches `state.budgetLocked` after the budget-stop event
    - PASS the composer box is hidden and a visible lock banner with a reason takes its place
    - PASS no new "you" bubble is added when a send is attempted anyway (real-user path: type + Enter on the still-live-but-hidden `#prompt`)
    - PASS the composer never ends up stuck busy/spinning for the refused send
    - PASS the refused text never reaches the model / never lands in the on-disk transcript
    - 5/5 passed.
  - **Confirmed the test is load-bearing**: `git stash`ed all four fix files (keeping the new verify script + its npm-script line unstashed... actually ran the script directly with `node` since package.json was also stashed) and reran against pre-fix code — it FAILED exactly as expected: `state.budgetLocked` never latches (times out), then a hard `TypeError: Cannot read properties of null (reading 'hidden')` because `#budgetLocked` doesn't exist pre-fix. Then `git stash pop` restored the fix; reran clean — 5/5 PASS again.
- **Scope discipline:** did not touch `src/server/index.ts`, `public/lib/drawer.js`, or `INDEX.md`, per the assignment. The `case 'send'` handler in index.ts still turns a budget-rejected `session.send()` throw into a plain `{fatal:false}` error with no flag — the client-side fallback string-match on the literal throw message covers this without needing that file. A follow-up agent WITH index.ts in scope could tighten this further (check `session.budgetStopped` proactively in the `'send'` case and answer with an explicit ack + flag instead of relying on the generic catch), but it is not required for correctness — verified end-to-end above.
- **Status:** VERIFIED — closing the loop on this ticket.
