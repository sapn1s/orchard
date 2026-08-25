# BUG-029 — resume refused while a survivor drains loses the typed message + toggles the banner

- **Status:** VERIFIED — fixed by emergency kitty session (verify:resume-refusal 5/5, 4/5 FAIL pre-fix); committed by orchestrator; FE half live on reload, retryable flag lands with next :4317 restart
- **Severity:** high (silent message loss)
- **Area:** composer / bridge (app.js resume path) — state honesty
- **Reported:** 2026-08-05 by user ("messages i send briefly appear as if main agent working then main disappears with no response … toggles from 'this session is still finishing its previous turn after a server restart …' to 'Direct · full access to this machine' and if i reload page my msg is gone too")

## Symptom (observed live)
Sending into a resumed session: the "you" bubble flashes and the session shows busy, then the
busy state vanishes with no reply, the status banner flip-flops between the survivor-guard error
and the idle "Direct · full access to this machine" label, and a reload drops the typed message
entirely.

## Root cause
`startTurn()` (resume path) paints an OPTIMISTIC "you" bubble, clears the composer, `setBusy(true)`,
opens a WS and sends `start`. When a prior server's FEAT-015 survivor broker is still draining the
SAME transcript, the server correctly refuses with the BUG-022 guard error
(`index.ts:~2050`, `fatal:false`): "this session is still finishing its previous turn after a
server restart — try resuming again in a few seconds".

The client's `case 'error'` (`app.js:~4735`) does not recognise a PRE-TURN (never-acked) refusal:
- not `fatal`, not a budget stop → falls to `armBusyWatchdog()`, a 4s timer that then says
  "…no turn is running, composer released" and `setBusy(false)`. That 4s flip IS the toggling
  banner the user sees.
- the optimistic bubble is never rolled back and was never persisted to disk (the turn never
  started) → gone on reload.
- the composer was already cleared → the typed text is lost (it lives only in `state.pendingStart`,
  which is reclaimed ONLY on a mid-turn reattach, never here).
- retry re-uses the now-open-but-session-less socket (`state.live` was set true by `connect()`),
  so `submit()` takes the LIVE path and the server answers "no session on this socket"
  (`index.ts:2107`) — compounding the toggle.

## Expected
A retryable pre-turn refusal must: keep the typed message (hand it back to the composer), remove
the phantom optimistic bubble, release busy IMMEDIATELY (no misleading 4s "composer released"),
and arm the next Enter to cleanly re-attempt the SAME resume.

## Fix
- SERVER (`index.ts`): tag the survivor-guard error `retryable: true` so the client can key on a
  flag, not a string.
- CLIENT (`app.js`):
  - stash the resume target in `state.pendingStartResume` alongside `state.pendingStart` in
    `startTurn()`.
  - in `case 'error'`, before the watchdog branch: if `state.pendingStart != null` (a start awaiting
    its `ack` was refused → the turn never began), `rollBackPendingStart()` — pull the last main
    `.you` bubble, restore the text to the composer, tear down the half-open socket
    (`closingOnPurpose`), arm `state.resumeOnNextSend`, `setBusy(false)`, honest status.

## Context pack
- Files/functions: `public/app.js` — `submit()`, `startTurn()` (~5076), `case 'error'` (~4735),
  `armBusyWatchdog()` (~4122), `rollBackPendingSend()` (~4106), `connect()` (~3713),
  `case 'ack' of 'start'` (~4425, clears `pendingStart`). `src/server/index.ts` — survivor guard
  (~2048), `send` no-session (~2107).
- Related tickets: BUG-022 (the guard this trips), FEAT-040 (state legibility), BUG-027/028
  (post-restart state-honesty siblings).
- Repro test: `npm run verify:ui` (offline) — drive a resume whose start is refused `fatal:false`.

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
