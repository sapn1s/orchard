# BUG-130 — The dock promised one-per-turn delivery the queue had already stopped doing

- **Status:** VERIFIED (pending independent verify — see handoff)
- **Severity:** low
- **Area:** composer / mid-turn send queue (`public/app.js`)
- **Reported:** (long ago) by user; worked 2026-08-20
- **Verification-class:** trivial (a UI copy string; the delivery behaviour it
  describes was not changed, and is proven unchanged by the full `verify:queue`
  suite in a real browser against real turns)

## Symptom

User, verbatim: *"message drains one by one, even tho i already queued 2
messages, why not send both same turn"*.

## Repro

Queue two messages while the assistant is working. The dock's queue box shows:

> `2 queued messages · Claude is working — delivers at the next pause, one per turn`

## Expected

The label describes what the queue actually does.

## Diagnosis — the behaviour was already right; the label was the bug

The hypothesis on dispatch was that batching was half-built. It is not: it is
fully built and has been since FEAT-002, extended by FEAT-031 Part B.
`flushQueue()` takes every live row, joins them into ONE prompt as segments —
each with its own `[msg i/N · queued Ns ago …]` header — and delivers them as a
single turn. Verified live before changing anything: `npm run verify:queue`
(real Brave, real haiku turns, transcript read off disk) reported **14 passed, 0
failed**, including *"the two queued messages delivered as ONE combined bubble
(not two turns)"* and *"both queued texts reached the model in ONE combined
turn"*.

The one thing still describing the pre-FEAT-002 world was the dock label the
user is looking at while they wait — and a `paintQueue()` docstring
(*"dequeue ONE message into its own turn, like the CLI does"*) that had been
stale for as long. The user was reading a promise of the old bug and reported
the old bug. Nothing else in the UI states the delivery rule, so the label was
the whole of the user's evidence.

On "two distinct user messages": the wire carries `{type:'send', prompt: string}`
and the server does `session.send(cmd.prompt)` — one string, one turn. Splitting
a batch into two SDK user messages would mean two turns, which IS the reported
bug. The segment headers are how the boundary stays legible inside one turn;
deliberately not changed.

## Changed

- `public/app.js` — the busy-state dock label is count-aware:
  `these deliver together at the next pause, as one turn` for a batch of ≥2,
  `delivers at the next pause` for one. Stale `flushQueue` docstring corrected.
- `scripts/verify-queue.mjs` — new assertion on the real dock label, plus its
  own in-band must-FAIL against a *synthesized* pre-change string (not `HEAD`,
  which becomes the fixed state the moment this lands).

## Context pack
- Files/functions in play: `public/app.js` — `paintQueue()` (the label),
  `flushQueue()` (the batching, unchanged), `queueItemNote()`.
- Related tickets: FEAT-002 (batched delivery + compose-time note), FEAT-031
  Part B (per-item segments — the change this label was never updated for),
  BUG-129 (queue durability; same file, concurrent lane, no design conflict).
- Repro test: `npm run verify:queue`.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-20 — worker
- **Understood:** verified the hypothesis before touching code, and it was
  wrong in the useful direction — batching exists and works end to end. Read
  `flushQueue`, the `'send'` case in `src/server/index.ts`, and FEAT-031's log.
- **Changed:** `public/app.js` (dock label + docstring), `scripts/verify-queue.mjs`
  (assertion + must-FAIL). Commit: see below.
- **Verified:** `npm run verify:queue` — **15 passed, 0 failed** (was 14/14
  before the change, i.e. no regression in the 14 pre-existing checks). Real
  Brave headless, own server on a free port with its own `CLAUDE_STATION_DATA`,
  real Claude turns, transcript asserted on disk. New line:
  `PASS  the dock label for a 2-message batch says they deliver TOGETHER, not "one per turn"` —
  `observed: {"label":"2 queued messages · Claude is working — these deliver together at the next pause, as one turn","preChangeLabelStillFails":true}`.
  `npm run gate` exit 0.
- **Still open / handoff:** none for the fix. `Verification-class: trivial` is
  claimed on the grounds that the only behavioural code path (`flushQueue`) was
  not touched — if a reviewer disagrees with that classification, the
  independent pass to run is `verify:queue` in a clean room.
- **Symptom of a deeper design flaw?** No new ARCH. Worth one sentence though:
  the defect is a UI string that outlived two feature tickets which changed the
  behaviour it describes, and neither ticket's verification looked at the copy.
  That is the same shape as BUG-107's stale-image class, one layer up.
