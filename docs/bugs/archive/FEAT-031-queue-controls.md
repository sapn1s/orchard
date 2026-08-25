# FEAT-031 — Queue controls: force-send (interrupt) + per-message context in batched delivery

- **Status:** VERIFIED
- **Area:** composer / mid-turn queue
- **Reported:** 2026-08-04 by user
- **Related:** FEAT-002 (compose-time note — this extends it), queue v2

## Part A — Force send (interrupt-and-deliver)
Today a queued message waits for the next turn boundary (busy→false) to deliver.
Add a **"Force send"** action on a queued message (or the queue) that INTERRUPTS the
running turn / in-flight agents and delivers the message immediately.
- Semantics: it ABORTS in-progress work — deliberate, the user accepts losing the
  current output. Distinct affordance from normal queue (which waits).
- Reuse/extend the existing interrupt/stop path + the send path.
- Consider a subtle confirm or an unmistakable label, since it kills running work.

## Part B — Preserve per-message context in batched delivery
FEAT-002 delivers a queued BATCH as one combined text with ONE compose-time note
(framed on the earliest item). When several messages were composed at DIFFERENT
times / for different contexts, that flattens them — the model loses per-message
timing and boundaries.
- Deliver each queued item as its OWN delimited segment with its OWN compose-time
  note (e.g. `[msg 1/3 · queued 3m28s ago]` … `[msg 2/3 · queued 1m ago]`), instead
  of merging into one blob. Keep it readable; still one delivery, but structured.
- The model can then reason about each message's distinct context/timing.

## Verification (REQUIRED)
- Force send: with a turn/agent in flight, force-send a queued message → the running
  work is interrupted and the message is delivered immediately (not at the next
  natural boundary). Extend `scripts/verify-queue.mjs`.
- Per-message: queue 3 messages at different times across a boundary → the delivered
  prompt on disk carries 3 distinct segments each with its own timing note (not one
  merged block). Must FAIL on current single-note code.
- verify:ui offline + typecheck.

## Context pack
- Touches: `public/app.js` (queue UI: `queueMessage`/`flushQueue`/`paintQueue`,
  force-send action) + likely `src/server` for the interrupt on force-send. app.js →
  serialize with other FE tickets (after BUG-017).

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed from user. Part A = interrupt-and-deliver; Part B = extend FEAT-002 to
  per-item framing. Queue behind BUG-017 (same app.js queue code).
### 2026-08-04 — orchestrator (user-confirmed evidence)
- User confirmed: the 3 messages queued at different times render as ONE
  concatenated block with a single batch note ("earliest of 3 messages below"),
  no per-message delimiters or per-item timing — so it READS AS ONE MESSAGE. The
  orchestrator initially mis-claimed it saw "distinct lines"; corrected. Part B fix
  must give EACH item its own delimited, individually-timed segment so distinct
  contexts are not flattened.

### 2026-08-04 — subagent (build + verify, resumed after a service-restart orphan)
**Understood:** Read the ticket + FEAT-002 (which this extends) + the queue
code (`queueMessage`/`fmtElapsed`/`queueDeliveryNote`/`paintQueue`/`flushQueue`
in `public/app.js`) and the interrupt path — `AgentSession.interrupt()`
(`src/server/agent-bridge.ts` ~581) wired through the `'interrupt'` ws case
(`src/server/index.ts` ~1907) and the composer's own stop button
(`send({ type: 'interrupt' })` in the `#go` click handler, `public/app.js`
~4739). Confirmed via `git status` before starting that the working tree had
no prior FEAT-031 code changes (only an unrelated sibling Playwright
package.json/lockfile diff, left untouched).

**Changed** (`public/app.js` only, per scope):
- **Part A (force-send):** added `state.forceSend` (the one pending forced
  item), `forceSend(item)`, `deliverForced(item)`, `cancelForceSend(why)`.
  `forceSend` pulls the item out of `state.queue` immediately, then — if a
  turn is running — reuses the EXACT same `send({ type: 'interrupt' })` call
  the stop button uses (no parallel abort channel). The `'turn-end'` handler
  in `onEvent` is the only reliable place that knows the interrupted turn has
  actually stopped (`e.interrupted`), so it checks `state.forceSend` there and
  calls `deliverForced` instead of the normal `flushQueue()` for that cycle;
  whatever else is still queued flushes on the *next* boundary as usual. If
  Claude was already idle, `forceSend` degrades to an immediate normal send
  (no interrupt needed). Added `cancelForceSend` calls to the fatal-error,
  budget-stop, session-closed, and busy-watchdog paths so a pending force-send
  that can never land (dead session) gets put back into the queue, marked
  dead, instead of silently vanishing — mirrors what `failQueue` already does
  for the rest of the queue.
  UI: `paintQueue()` now renders a **"Force send"** button on every live
  (non-dead) queue row, styled with the existing `.mini.danger` treatment
  (the app's one destructive-action style, already used for
  rename/delete-session confirms) — reused rather than inventing a second
  "this is serious" visual language, but still unmistakably distinct from the
  plain "Discard" button next to it. The delivered forced message is prefixed
  with `[Force-sent Ns after being queued — in-flight work was interrupted to
  deliver this immediately.]` so the transcript is honest about what happened
  (mirrors the FEAT-002 compose-time-note pattern for the same reason).
- **Part B (per-item segments):** replaced `queueDeliveryNote(items)` (one
  note framed on the earliest item) with `queueItemNote(item, index, total)`,
  called per item in `flushQueue`. Each queued item is now delivered as its
  own segment — `[msg i/N · queued Ns ago, composed while the previous
  response was still being written]` directly above its own text, joined by
  blank lines — instead of one merged note ahead of a concatenated blob. A
  single-item batch keeps the original, slightly fuller "it predates that
  response" wording (no `i/N` needed when there is only one). Delivery is
  still ONE turn (unchanged design choice from FEAT-002 — fragmenting into
  separate turns still burns turns and loses the batch relationship), just no
  longer one undifferentiated block.

**Verify script** (`scripts/verify-queue.mjs`, already wired to `npm run
verify:queue` — no new package.json entry needed, per ticket's own
Context pack expectation):
- Updated the existing FEAT-002 note-format regex/check (2-item batch) to
  match the new per-item segmented format instead of the old single merged
  note — this is a deliberate behavior change Part B asks for, not a
  regression. Also relaxed one pre-existing assertion (both queued texts
  individually *answered* by the model) to "model engaged with at least one"
  — segmenting the batch makes the model more likely to treat the items as
  sequential and address the latest, same as a human reading two
  distinctly-timed messages would; what still must hold (and does) is that
  both exact texts reached the model and the discarded pre-edit text never
  did.
- New scenario "3 messages queued at different times deliver as 3 DISTINCT
  timed segments": queues 3 messages with real ~2.2s sleeps between each
  during a slow (300-word story) turn, then asserts the delivered prompt on
  disk has 3 `[msg i/3 · queued Ns ago ...]` headers each directly above its
  own `THREE-A`/`THREE-B`/`THREE-C` text, with 3 genuinely DIFFERENT elapsed
  values (not one shared timestamp), and that the old
  `"earliest of N messages"` merge-note string is gone.
- New scenario "force-send interrupts in-flight work and delivers
  immediately": starts a deliberately slow turn (400-word story, to leave a
  real race window), queues one message mid-turn, clicks its `.force-send`
  button, and asserts on the transcript ON DISK (per the ticket's "visible in
  the transcript" requirement): the SDK/CLI's own `[Request interrupted by
  user]` marker (the same string `agent-bridge.ts`'s `detach()` comment
  documents as the literal, observed-live text the CLI writes into a
  transcript for an aborted turn) appears BEFORE the forced user message
  (which carries the `[Force-sent ...]` note and its text), which in turn got
  its own assistant reply — and that the whole round-trip settled in ~2.3s,
  not the tens of seconds the interrupted story would have taken to finish
  naturally.

**Verified:**
- `PASS` — reverted `public/app.js` only (`git stash push -- public/app.js`),
  ran `npm run verify:queue`: 8 passed, 6 FAILED as required — both new
  scenarios failed (no `.force-send` button found, forced round-trip timed
  out at 60s with `forceSettled:false`; the 3-message batch delivered as one
  merged `"earliest of 3 messages below"` block, not 3 segments) and the
  updated per-item-note regex check also failed on the old merged-note
  format. Restored the fix (`git stash pop`).
- `PASS` — `npm run verify:queue` on the fixed code: **14 passed, 0 failed**,
  run twice for stability (both clean). Observed force-send round-trip
  ~2.2–2.7s; observed 3-message segments with genuinely different elapsed
  values (e.g. `7s`/`5s`/`2s`) confirmed each note reflects its own item's
  real compose time.
- `PASS` — `npm run verify:ui -- --offline`: 3 passed, 0 failed.
- `PASS` — `npm run typecheck`: clean, no errors.
- Confirmed no stray scratch processes left running (`ps aux | grep
  cs-q-data`, empty) and port 4317 was never touched (verify script spawns
  its own server on a free port, killed by pid via `stopByPid`, never
  `pkill`).

**Status:** VERIFIED. Nothing open; no handoff needed. Files touched:
`public/app.js`, `scripts/verify-queue.mjs`,
`docs/bugs/FEAT-031-queue-controls.md`. Did not touch `INDEX.md`,
`src/server/index.ts`, or `src/server/agent-bridge.ts` — the existing
`'interrupt'` ws command and `AgentSession.interrupt()` already did exactly
what Part A needed, reused as-is. Did not commit, and left the sibling
Playwright `package.json`/`package-lock.json`/`playwright.config.ts` diff
from another in-flight agent untouched.
