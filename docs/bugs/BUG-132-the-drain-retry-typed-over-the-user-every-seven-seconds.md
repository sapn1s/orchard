# BUG-132 — the drain retry typed over the user, every seven seconds

- **Status:** FIXED — the self-retry no longer touches the composer; not yet independently verified.
- **Severity:** high (the user could not use the composer at all while a drain-wait row existed)
- **Area:** composer / queue (client)
- **Reported:** 2026-08-20 by the user
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED. The user has
  verification switched off while they are blocked; this was landed unverified, deliberately and
  with their instruction.

## Symptom
Verbatim: *"something cause reload on my screen to delete my entered message for some reason, its
flickering every once in a while"*, and later that they could no longer reliably write in the input
and had composed their message in another application instead.

Nothing reloaded. The composer was being emptied under them on a 7-second cadence.

## Repro
1. Get the session into a drain-wait state — a queued row with `drainWait` set (the client enters
   this whenever the server refuses a `start` retryably, which is normal while a survivor broker
   holds a drain).
2. Type into the composer and wait.
3. Within 7 seconds the box empties. Keep typing and it empties again, indefinitely, for as long as
   the hold lasts. In the observed incident that was 46 minutes.

## Expected
The composer's contents survive anything the client does on its own initiative. A background retry
of a message the user already handed over is not permitted to touch text they have not.

## Context pack
- Files/functions in play, all `public/app.js`: `attemptDrainRetry()`, `startTurn()`,
  `rollBackPendingStart()`, `queueRetryableRefusal()`, `failDrainWaitAttempt()`.
- Related tickets: BUG-045 (the self-retry loop this rides on), FEAT-064 (the refusal payload),
  BUG-029 (the composer hand-back that the rollback performs), BUG-129 (queue durability — SUSPECTED
  at dispatch and innocent), BUG-134 (the chip that made the same hold look like a 46-minute wait).

## Diagnosis
`attemptDrainRetry()` re-sends the queued row every `DRAIN_RETRY_MS = 7000` by calling `startTurn()`.
`startTurn()` clears the composer — synchronously, before its first `await` — because in every other
caller the composer is exactly where the text came from. In this caller it is not: the text lives in
a queue row.

The code knew about the hazard and tried to handle it, in the way that cannot work:

```js
const draft = node.prompt.value;
Promise.resolve(startTurn(item.text, { … }))
  .finally(() => { if (draft && !node.prompt.value) { node.prompt.value = draft; autosize(); } });
```

The save is synchronous, the restore is a whole server round-trip later, and it is guarded on the box
still being empty. Two ways the user loses text, both of which happened:

1. They keep typing into the box that just blanked. The guard sees a non-empty box, declines, and the
   original draft is dropped.
2. The refusal arrives non-retryably first, so `rollBackPendingStart()` runs BUG-029's composer
   hand-back — `node.prompt.value = text` with the QUEUED row's text. The box now holds a message the
   user did not just type, the guard declines, and their own text is gone.

The general shape: **never save and restore across an `await` what you can simply not touch.**

## Fix
`startTurn(text, { keepComposer })`. When set, it skips the clear, and it records
`state.pendingStartKeepComposer` so the refusal path — which runs later, off the socket — can honour
it without re-deriving who started the turn. `rollBackPendingStart()` skips the hand-back for such a
start. `attemptDrainRetry()` passes it and the save/restore dance is deleted rather than repaired.

One consequence had to be handled or the fix would have caused a worse bug than it cured.
`failDrainWaitAttempt()` used to RETIRE the queue row whenever the composer was empty, precisely
because the rollback behind it would deposit the text there instead. With the composer untouched that
would have dropped the only copy, so the row is now always kept, marked dead — and BUG-129's mirror
persists it on the repaint.

## Risks
- The text of a non-retryably-refused self-retry now lives in exactly one place (the dead queue row
  and its storage mirror) instead of the composer. That is the intended design, and it was checked by
  inspection along the whole path, but it is the failure this ticket exists to prevent, so it is the
  first thing an independent pass should attack.
- `keepComposer` is a new flag on a much-used function. Every other caller is unaffected by
  construction (the parameter defaults to undefined), but the flag's lifetime spans an await and a
  socket round-trip, which is the kind of state that goes stale. It is set on every `startTurn` and
  cleared on both settle paths.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-20 — worker (dispatched emergency lane)
- **Understood:** dispatched with BUG-129's queue-persistence work (`70c815e`) named as the prime
  suspect and a revert authorised. It is innocent. The offender is the BUG-045/FEAT-064 self-retry,
  which predates today's queue storage; it only becomes visible when a drain hold lasts long enough
  for the user to try to type during it, which is what made it look like today's regression.
- **Changed:** `public/app.js` only — commit `09db10f`.
- **Verified:** `node --check`, `npm run gate` PASS (exit 0, read directly, unpiped). No behavioural
  test: the user is blocked from typing and asked for the fix in hand rather than the proof. The
  static check that matters was done — see Risks.
- **Verified-by:** nobody. An independent clean-room pass is warranted (data-loss class).
- **Still open / handoff:** the one property to test first is under Risks.
