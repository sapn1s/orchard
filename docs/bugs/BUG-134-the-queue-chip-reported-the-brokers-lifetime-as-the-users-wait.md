# BUG-134 — the queue chip reported the broker's lifetime as the user's wait

- **Status:** FIXED — the chip now reports the row's own age and drops the agent ids.
- **Severity:** medium (nothing was broken; the user was told, hourly, that it was)
- **Area:** dock / queue chip (client)
- **Reported:** 2026-08-20 by the user
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED. Landed unverified
  at the user's instruction while they were blocked.

## Symptom
The dock said, verbatim:

> `1 queued message · waiting on drain — held 45m59s by 2 background agents (a3d3e1022ec985f4e,
> a3ba9374904af5e4d) — retries itself; edit or discard below`

The user: *"why tf it says held 45m and mentions subagents, they have nothing to do with main agent
being in turn and waiting to drain"*. They are right, and the sentence was worse than they knew: all
three of its claims were false of their message.

## Repro
Queue a message against a session whose survivor broker has declined at least once. The chip reports
`drainHeldSince` — an epoch set at the broker's FIRST decline ever and deliberately never reset — as
though it were how long this message has waited, alongside the task ids captured at whichever refusal
happened to carry the payload.

## Expected
Say how long the USER's message has waited, and name the condition that ends the wait. Do not
attribute the wait to work that is not causing it, and do not hand the user identifiers they cannot
act on.

## Diagnosis — the wait is legitimate; only the reporting was wrong
Dispatched on the hypothesis that "busy" was conflating *the main turn is running* with *this session
has live background children*, and that delivery should key on the former only. Checked against the
live artifacts before changing anything. The hypothesis is already implemented, and it works:

- **Background agents do not block delivery.** FEAT-065 (`src/server/index.ts`) delivers a message
  into a drain-held survivor precisely while background lanes run; its gate is
  `survivor.midTurn === false`, not the background count.
- **It was firing the whole time.** `journalctl --user -u claude-station` records
  `FEAT-065: delivered the message into the drain-held survivor` **13 times in the hour that
  "held 45m59s" was on screen** — roughly every 2 to 7 minutes.
- **`midTurn` is not pinned.** Sampling the real broker status file
  (`~/.local/share/claude-station/session-hosts/h-*.json`) every 4s for two minutes showed it
  flapping: true ~70s, false ~20s, true ~50s, false. The false windows are real delivery windows, and
  `midTurnSince` matched the journal's delivery timestamps exactly — i.e. the deliveries are what open
  the turns. BUG-074's guard is holding.
- **The ids were stale as well as opaque.** The chip said 2; over the same two minutes the broker's
  own level frames reported 4, 5 and 6 lanes, with changing ids. The payload is captured at one
  refusal and never refreshed.

So the drain wait is real, bounded and short — a message goes in at the foreground turn's next pause —
and the sentence describing it was a broker-lifetime statistic wearing the user's name.

## Fix
`paintQueue()`'s `heldWhy()` in `public/app.js` now reports `Date.now() - row.composedAt` — the row's
own age, which this tab has held all along — and names what resolves the wait ("the session is
mid-reply; this retries every few seconds and goes in at its next pause"). The count and the ids are
gone.

## Not fixed here
The equivalent sentence in the server's refusal message (`src/server/index.ts`, `refuseDrainHeld`)
has the same defect: `the drain is held Ns so far by N background agents (ids)`. It is untouched
because that file was held by another lane, and because the client does not surface that string for a
retryable refusal — so nothing user-visible still says it. Worth cleaning up when the file is free.

## Open question this raised (not a defect — for someone to decide)
A message waits for the foreground turn's next pause, which in this session's usage pattern is
minutes. Injecting sooner means interleaving two turns into one CLI, which is exactly what BUG-022
exists to prevent, so the wait is not obviously wrong. But nobody has asked whether minutes is the
right number, or whether the queued message should be able to arrive at the START of the next turn
rather than waiting for a pause in this one.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-20 — worker (dispatched emergency lane)
- **Understood:** dispatched to remove a wait; found the wait working and the sentence lying. Said so
  rather than changing the delivery gate, which would have delivered into a live turn.
- **Changed:** `public/app.js` only — commit `e9efb92`.
- **Verified:** `node --check`, `npm run gate` PASS (exit 0, unpiped). Findings are from live
  artifacts, not fixtures: the real broker status file, the real service journal, a 2-minute sample of
  the real session. The rendered chip itself was not exercised in a browser (verification off).
- **Still open / handoff:** the server-side twin of the sentence, and the open question above.
