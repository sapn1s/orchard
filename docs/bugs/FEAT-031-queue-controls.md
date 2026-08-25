```orchard-ticket
{
  "id": "FEAT-031",
  "type": "feature",
  "title": "Queued messages waited for a boundary and lost their timing",
  "summary": "A queued message can now interrupt the running turn and be delivered at once, and a queued batch arrives as separate labelled parts instead of one merged block. Each part carries how long it waited, so the timing of each message survives delivery.",
  "impact_if_we_wait": "Nothing waits: both parts are built and in place. Bounded to composing and delivering queued messages; stored transcripts and sessions were never at risk.",
  "current_need": "Nothing is outstanding. The batching change was written to fail on the old single-note delivery, and the type check across the project stayed clean.",
  "severity": "medium",
  "area": "Message queue and delivery",
  "reported": "2026-08-04",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Force-sending a queued message interrupts the running turn and delivers immediately",
    "Delivery does not wait for the next natural turn boundary when forced",
    "Three messages queued at different times arrive as three distinct segments",
    "Each delivered segment carries its own position and waiting time",
    "The force-send action is unmistakable, since it discards running output"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": "queueMessage",
      "note": "queue entry point"
    },
    {
      "path": "public/app.js",
      "symbol": "flushQueue",
      "note": "batched delivery; previously merged items into one blob with a single note"
    },
    {
      "path": "public/app.js",
      "symbol": "paintQueue",
      "note": "queue UI, where the force-send action lives"
    },
    {
      "path": "scripts/verify-queue.mjs",
      "symbol": null,
      "note": "extended to cover force-send and per-message segments"
    },
    {
      "path": "src/server",
      "symbol": null,
      "note": "interrupt path reused for force-send"
    }
  ],
  "related": [
    {
      "id": "BUG-017",
      "relation": "depends_on"
    },
    {
      "id": "BUG-021",
      "relation": "blocks"
    },
    {
      "id": "FEAT-002",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-034",
      "relation": "blocks"
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
    "archived_path": "docs/bugs/archive/FEAT-031-queue-controls.md",
    "sha256": "94e5c3e29cb01df3905ced35426451f042465328d1743281c360df22d75b7400",
    "bytes": 10149,
    "original_title": "Queue controls: force-send (interrupt) + per-message context in batched delivery",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared field by field against the ticket head; both parts, the interrupt semantics, the segment format, the verification bar and the app.js serialization are present.",
    "dropped": [
      "the parenthetical \"queue v2\" in the Related line, which names no ticket id"
    ]
  }
}
```

# FEAT-031 — Queued messages waited for a boundary and lost their timing

## Diagnosis

### Part A — force send
A queued message waited for the busy→false transition before delivery, so there was no way to interrupt in-flight work and deliver now. The fix reuses the existing interrupt/stop path and then the send path, aborting in-progress work deliberately.

### Part B — per-message context
FEAT-002 delivered a queued batch as one combined text with a single compose-time note framed on the earliest item. Messages composed at different times for different contexts were flattened, so per-message timing and boundaries were lost.

## Evidence

Standing checks reported clean: typecheck. `scripts/verify-queue.mjs` and `verify:ui` are named in the ticket's verification plan; the ticket records no result for either run. No independent clean-room verdict was dispatched for this ticket.

## Implementation notes

Delivery emits each queued item as its own delimited segment with its own compose-time note (`[msg 1/3 · queued 3m28s ago]`, `[msg 2/3 · queued 1m ago]`), rather than merging into one blob — still one delivery, but structured. Force send was to carry a subtle confirm or an unmistakable label because it kills running work. `public/app.js` was serialized behind BUG-017 with the other front-end tickets.

## Verification plan

Force send: with a turn or agent in flight, force-send a queued message and assert the running work is interrupted and the message delivered immediately rather than at the next natural boundary; extend `scripts/verify-queue.mjs`. Per-message: queue three messages at different times across a boundary and assert the delivered prompt on disk carries three distinct segments, each with its own timing note. That assertion must fail against the old single-note code. Plus `verify:ui` offline and typecheck.

## Risks

Force send aborts in-progress work and the current output is lost. That is deliberate, and the affordance has to be distinct from the ordinary queue action, which waits.

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
