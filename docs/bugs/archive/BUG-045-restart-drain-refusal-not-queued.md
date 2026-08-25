# BUG-045 — restart-drain refusal bounces the message to the composer instead of queueing + auto-retrying

- **Status:** VERIFIED (2026-08-11 — fix agent; client-only fix, pre-fix FAIL proven 8/13 + 5/7; awaiting deploy)
- **Area:** UI (app.js send/refusal path) + server (retryable refusal contract)
- **Reported:** 2026-08-11 by user, live right after a deploy:
  > "app.js:367 [station] this session is still finishing its previous turn after a server
  > restart (broker pid … alive (broker state draining)) — try resuming again in a few seconds"
  > "your message is kept in the composer — press Enter to try again in a moment"
  > — after restart, does not even let me submit message … it's not being queued even

## Symptom
After a server restart while the session's previous turn is still draining (FEAT-015 survivor),
sending a message is REFUSED with `retryable:true`; BUG-029's rollback correctly returns the text
to the composer. But that's where it stops: the user must sit there mashing Enter until the drain
finishes. Nothing queues it, nothing retries it, and if the draining turn is long (an orchestrator
turn can run many minutes) the session is effectively write-locked with a message the user already
decided to send.

## Why the current behavior exists (do not regress it)
The refusal itself is PRINCIPLED — BUG-033's liveness gate refuses to race a second CLI onto a
transcript that cannot be proven finished (BUG-022). Keeping the text (BUG-029) was the fix for
losing it outright. The gap is purely UX: a retryable refusal is treated as a terminal one.

## Wanted
1. On a `retryable:true` refusal, the client should QUEUE the message (same queue the busy path
   uses) with a visible "waiting for the previous turn to finish draining" chip — not bounce it
   to the composer.
2. The client retries automatically: on the next liveness/snapshot transition of that session
   (drain settled → busy:false or bridge re-verified), flush the queue. A slow poll fallback
   (e.g. every 5–10 s while a retryable-refused message is queued) covers missed events.
3. If the retry is refused NON-retryably, fall back to today's composer-return behavior with the
   honest reason.
4. Composer stays usable: user can edit/cancel the queued message (existing queue affordances).

## Verification (§C)
Extend/reuse `verify-resume-refusal.mjs` (real-shape): restart with a draining survivor, send →
message is queued (not composer-bounced), drain completes → message auto-delivers exactly once,
no double-send, no loss. Anti-regression: BUG-029 (non-retryable refusal still returns text),
BUG-022 (no second CLI raced onto a draining transcript), verify:queue, verify:ui.

## Activity log (APPEND-ONLY)
### 2026-08-11 — orchestrator
- Filed from the user's live report immediately after the pid-3989993 deploy. The refusal fired
  exactly as designed (BUG-033 gate, drain was real — orchestrator turn was mid-flight), but the
  user experience is "the dashboard won't take my message and won't tell me when it will".

### 2026-08-11 — fix agent (VERIFIED)
- **Root cause confirmed:** purely client-side, exactly as filed. The server already tags both
  pre-ack retryable refusals `retryable:true` (`src/server/index.ts:2583` survivor-drain guard,
  `:2461` frameless drop) — but `app.js`'s `case 'error'` treated retryable identically to
  terminal: `rollBackPendingStart()` + "press Enter to try again". Nothing queued, nothing
  retried; a long drain write-locked the session. **Server untouched** (BUG-033 gate and BUG-022
  no-second-CLI invariant intact — every retry below is a full `start` the gate re-judges).
- **Fix map (public/app.js, client-only):**
  - `:6068-6072` — the `error` branch splits on `e.retryable`: retryable → `queueRetryableRefusal()`;
    non-retryable → `failDrainWaitAttempt()` + `rollBackPendingStart()` (BUG-029 composer-return kept).
  - `:5009-5046 queueRetryableRefusal()` — BUG-029's rollback minus the composer hand-back; the text
    becomes a row in the EXISTING busy-path queue, flagged `drainWait` (+ its resume id/project);
    first refusal creates the row, a re-refused self-retry keeps the same row (no duplicates). Marks
    the closing socket dead synchronously (`state.ws=null/live=false`) so the `setBusy(false)` flush
    microtask cannot push the row into the dying socket (double-delivery window found during
    verification, closed here).
  - `:5053-5088 armDrainWaitRetry/attemptDrainRetry` — slow-poll fallback every 7s (spec: 5-10s),
    4.5s min-gap, ghost-attempt release at 15s; retry = full `startTurn` over the SAME resume,
    composer draft preserved around it.
  - `:4832-4835` (in `refreshLive`) — the liveness-transition trigger: the moment the draining
    session leaves the live set, retry immediately (the transition IS "drain settled").
  - `:5091-5101 settleDrainWaitDelivery()` — exactly-once retirement: the row leaves the queue ONLY
    on the retry's `start` ack (fresh ack `:5664`, idle reattach `:5653`); busy reattach `:5640-5648`
    converts the row to a normal queue item instead of `queueMessage`-doubling it.
  - `:6220-6222` (flushQueue) — an in-flight retry's row is excluded from the boundary flush
    (the other half of exactly-once).
  - `:5108-5117 failDrainWaitAttempt()` — non-retryable re-refusal falls back to composer-return
    when the composer is free, else the row stays marked dead (text never lost, never in two
    live places).
  - `:6158-6165, :6180-6186` (paintQueue) — the visible chip: "waiting for the previous turn to
    finish draining — retries itself; edit or discard below", per-row "waiting on drain" +
    `.drain-wait` class. Rows keep ALL existing queue affordances (edit textarea, Discard).
  - `:113-117` — three new state fields (`drainWaitTimer/Attempt/LastTry`).
- **Verification (§C, real-shape):**
  - `scripts/verify-resume-refusal.mjs` (extended, happy-dom + real server + planted alive
    survivor): **PRE-FIX 5/13 (8 FAIL** — no queue row, no chip, composer bounce, retry never
    armed/fires, row not editable — with #fine literally showing the reported "kept in the
    composer — press Enter" line**); POST-FIX 13/13**, incl. self-retry round-trip against the
    still-draining survivor with exactly ONE row kept, edit-reaches-delivery, Discard cancels,
    and the BUG-029 anti-regression (non-retryable → composer, queues nothing).
  - `scripts/verify-refusal-visible.mjs` (extended, real brave + real haiku turns): **PRE-FIX
    (ALIVE scenario) 2/7 (5 FAIL** — no chip/queue, and after the drain cleared the message
    NEVER delivered: 0 transcript turns, 0 on-disk user messages**); POST-FIX 19/19** — ALIVE:
    drain clears → queued message delivers ITSELF (no Enter) as exactly ONE turn (DOM count 1,
    on-disk store 1 user message); STALE anti-regression intact; FRAMELESS: auto-retry resumes
    and the ENGINE received exactly ONE turn carrying the message (fixture input log,
    `CODEX_FAKE_INPUT_LOG` + `CODEX_FAKE_EXPECT_RESUME` so the fixture accepts the resume).
  - `verify:queue` **14/14** · `verify:ui` **7/7** · `typecheck` clean · `leak-gate` PASS.
  - Note: `verify:queue`'s per-item-note regex was anchored at `^user:[msg 1/…` and flaked when a
    FEAT-057 "[station] While you were away…" outcomes briefing (server-side, `outcomes.ts`,
    untouched) was prepended — the assertion now tolerates that optional block; the per-item
    notes are still matched exactly.
- **Deploy:** NOT deployed — client-only change in `public/app.js`; lands on :4317 with the next
  deploy + a page reload. Do not restart the service for this ticket alone.
