# FEAT-002 — Compose-time note on queued messages (stale-feedback guard)

- **Status:** VERIFIED
- **Severity:** medium
- **Area:** composer / mid-turn queue
- **Reported:** 2026-08-03 by user (discussed, agreed in principle)

## Symptom / motivation
A message queued at T0 while Claude works delivers at T2, after Claude's T1
response. Claude then reads it as a reply to T1 when it was actually composed
before T1 existed — temporal confusion (observed live, cost a round-trip). The
model reasons over sentences, not raw ISO timestamps, so the fix is a short
FACTUAL note prepended to the delivered prompt, letting the model judge
staleness.

## Expected
When a queued message crosses at least one turn boundary before delivery,
prepend a bracketed, clearly-non-user note to the delivered prompt, e.g.:
`[Queued 2m11s ago, composed while the previous response was still being written
— it predates that response.]`
- Only when meaningful (queued across a boundary; a normally-typed message gets
  nothing).
- Factual timing only, NOT a judgment ("may be stale") — the app knows the
  timing, the model does the semantics.
- Truthful: claude-station owns the queue, so compose/deliver times are exact.
- Pairs with the already-built editable queue rows (manual escape) as the
  automatic net.

## Diagnosis / design
_(subagent)_ The queue already tracks each item (`state.queue`,
`queueMessage`/`flushQueue`, combined-delivery). Add a compose `Date` per item;
in `flushQueue`, when composing the combined prompt, prepend the note for items
that waited across a boundary. Consider per-item vs per-batch framing (the batch
now delivers together — one note for the batch is likely cleanest).

## Fix
`public/app.js`:
- `queueMessage(text)` now records `composedAt: Date.now()` on each queued
  item (the app owns the queue, so this is the exact compose moment — no
  guessing).
- New `fmtElapsed(ms)` — coarse `"43s"` / `"2m11s"` formatting for the note;
  not a stopwatch, just enough for the model to judge staleness.
- New `queueDeliveryNote(items)` builds ONE note per delivered batch, framed
  around the EARLIEST item's `composedAt` (queue order is preserved,
  including through the unshift-back-on-send-failure retry path in
  `flushQueue`, so `items[0]` is always the earliest). Singular vs plural
  wording depending on `items.length`.
- `flushQueue()` prepends `queueDeliveryNote(items)` to the combined text
  before both the `youBubble` render and the `send({ type: 'send', prompt })`
  call — so the note is visible in the UI transcript AND is what the model
  actually reads (same string, one source of truth).

**Per-batch, not per-item** (explicit choice, recorded in a comment above
`queueDeliveryNote`): `flushQueue` already merges the whole queued batch into
ONE combined turn — a note per item would describe turn boundaries the model
no longer perceives as separate, since they all arrive as one user message.

**Why every queued item is guaranteed to have crossed a boundary** (also
recorded as a comment in the code, so it doesn't need re-deriving): `queueMessage`
is only ever called while `state.busy === true` (see `submit()` — the
`if (state.busy)` branch — and the re-attach path). `flushQueue` only ever
runs off the `busy → false` transition (`queueMicrotask(flushQueue)` inside
`setBusy`). So anything that reaches `state.queue` was, by construction,
composed mid-turn and delivered only after that turn ended — i.e. it always
crossed at least one boundary. A directly-typed message (the `else` branch of
`submit()`) never calls `queueMessage` at all, so it structurally cannot get
a note. This means the "only when meaningful" condition from the ticket
reduces to "only messages that went through the queue," which is exactly
what the code now does — no extra threshold logic needed.

## Verification
Extended `scripts/verify-queue.mjs` (existing `npm run verify:queue`, no new
script needed):
- New check after the existing combined-turn assertions: fetches the
  transcript, finds the delivered `user:` message containing both queued
  texts, and asserts it matches
  `/^user:\[Queued \d+[ms].*composed while the previous response was still being written.*predate/`.
- New third scenario (`=== queue: a normally-sent (never queued) message
  gets NO note ===`): waits for idle, sends a message the normal way (Claude
  is NOT busy, so it never enters the queue), waits for that turn to finish,
  and asserts the delivered `user:` message does NOT contain `[Queued`.

Proved the test is not vacuous: reverted `public/app.js` only
(`git stash push -- public/app.js`), reran `npm run verify:queue` — the new
note check FAILed (`observed: user:Reply with exactly: QUEUED-ALPHA...`, no
note text at all) while the other 7 checks still passed. Restored the fix
(`git stash pop`) and reran — all 8 passed, note text present, normal-send
check also passed on the new code.

## Screenshots
`assets/FEAT-002-queue-note.png` — the delivered bubble showing
`[Queued 2s ago (earliest of 2 messages below), composed while the previous
response was still being written — they predate that response.]` ahead of
the two queued texts, in the live app UI (headless brave, ad-hoc capture
script, not committed).

## Activity log (append-only)

### 2026-08-04 — subagent (build + verify)
**Understood:** queued items already tracked in `state.queue`
(`queueMessage`/`flushQueue`, combined-delivery, `public/app.js`); need a
compose timestamp per item and a note prepended to the delivered combined
prompt when (and only when) the batch crossed a turn boundary. Confirmed via
`submit()` that `queueMessage` is ONLY called while `state.busy === true`,
and `flushQueue` only runs off the `busy → false` transition
(`queueMicrotask(flushQueue)` in `setBusy`) — so every item that ever reaches
`state.queue` crossed a boundary by construction; a directly-typed message
never touches `queueMessage` at all. This collapses "only when meaningful"
into "only for queued deliveries," so no extra threshold/heuristic logic was
needed.

**Changed** (`public/app.js` only, per scope):
- `queueMessage`: added `composedAt: Date.now()` per item.
- Added `fmtElapsed(ms)` and `queueDeliveryNote(items)`.
- `flushQueue`: prepends `queueDeliveryNote(items)` to the combined text
  before both the bubble render and the `send()` call.
- **Choice recorded:** ONE note per BATCH (not per item), framed around the
  earliest item's `composedAt` — matches the existing combined-turn delivery
  design (see comments above `queueDeliveryNote` in app.js for the full
  reasoning).

Also extended `scripts/verify-queue.mjs` (existing `verify:queue` npm
script — no new script/npm entry needed) with: (1) a regex assertion that
the delivered queued-batch transcript message starts with the compose-time
note, and (2) a new third scenario proving a normally-sent (never-queued)
message gets NO note.

**Verified:**
- `PASS` — reverted `public/app.js` only, ran `npm run verify:queue`: the
  new note-check FAILed as expected (7 passed, 1 failed — the delivered
  message had no `[Queued` prefix), all pre-existing checks still passed.
  Restored the fix.
- `PASS` — `npm run verify:queue` on the fixed code: 8 passed, 0 failed
  (ran twice for stability, both clean).
- `PASS` — `npm run verify:ui -- --offline`: 3 passed, 0 failed.
- `PASS` — `npm run typecheck`: clean, no errors.
- Screenshot captured: `docs/bugs/assets/FEAT-002-queue-note.png` (ad-hoc
  CDP script in `/tmp`, deleted after use — not part of the repo).

**Status:** VERIFIED. Nothing open; no handoff needed. Files touched:
`public/app.js`, `scripts/verify-queue.mjs`,
`docs/bugs/FEAT-002-queued-message-timestamps.md`,
`docs/bugs/assets/FEAT-002-queue-note.png`. Did not touch `drawer.js`,
`INDEX.md`, or commit anything (per scope/rules).
