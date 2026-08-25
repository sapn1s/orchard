```orchard-ticket
{
  "id": "FEAT-002",
  "type": "feature",
  "title": "Queued messages read as replies to answers they never saw",
  "summary": "A message typed while the assistant was still working arrived only after the reply landed, and was then read as a response to that reply. Delivered queued messages now carry a short factual note giving how long they waited and stating they predate the response. Normally typed messages get nothing.",
  "impact_if_we_wait": "Each mistimed queued message costs a wasted round-trip while the assistant answers the wrong question. Bounded: this is conversational confusion only, and no message text is lost or altered.",
  "current_need": "Nothing is outstanding. Reverting the change made the new note check fail while the other seven checks held, and restoring it turned all eight green.",
  "severity": "medium",
  "area": "Mid-turn message queue",
  "reported": "2026-08-03",
  "reported_by": "user",
  "owner": "you",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-03",
      "question": "Should the note describe each queued message, or the batch as a whole?",
      "mode": "single",
      "options_keys": [
        "per-item",
        "per-batch"
      ],
      "chosen": "per-batch",
      "chosen_on": "2026-08-03",
      "chosen_by": "agent",
      "note": "The whole queue is merged into one delivered turn, so per-item notes would describe boundaries the model no longer perceives. The choice is recorded as a comment above the note builder."
    }
  ],
  "success_criteria": [
    "A queued message delivered after a turn boundary carries a note naming how long it waited",
    "The note states the message predates the response that landed first",
    "A directly typed message carries no note",
    "One note describes the whole delivered batch, framed on the earliest message"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": "queueMessage",
      "note": "records composedAt at the exact moment of queueing"
    },
    {
      "path": "public/app.js",
      "symbol": "fmtElapsed",
      "note": "coarse \"43s\" / \"2m11s\" formatting, not a stopwatch"
    },
    {
      "path": "public/app.js",
      "symbol": "queueDeliveryNote",
      "note": "one note per batch, framed on items[0], the earliest; singular vs plural wording"
    },
    {
      "path": "public/app.js",
      "symbol": "flushQueue",
      "note": "prepends the note to the combined text before both the bubble render and the send, so UI and model read the same string"
    },
    {
      "path": "scripts/verify-queue.mjs",
      "symbol": null,
      "note": "extended with the note assertion and a third never-queued scenario"
    },
    {
      "path": "assets/FEAT-002-queue-note.png",
      "symbol": null,
      "note": "delivered bubble showing the note ahead of two queued texts, captured in the live UI"
    }
  ],
  "related": [
    {
      "id": "FEAT-031",
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
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-002-queued-message-timestamps.md",
    "sha256": "729a618563d5ef09ced8699e1454199fbbdd697ac7b51e5043c79c27a38d3a9b",
    "bytes": 7852,
    "original_title": "Compose-time note on queued messages (stale-feedback guard)",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Read against the original section by section; the motivation, the per-batch choice, the boundary-by-construction argument, the revert-and-restore proof and the screenshot are all present.",
    "dropped": [
      "the exact regular expression used in the suite assertion",
      "the subagent attribution on the design section"
    ]
  }
}
```

# FEAT-002 — Queued messages read as replies to answers they never saw

## Diagnosis

### Why timing alone was not enough
The model reasons over sentences, not raw timestamps, so the guard is a short factual sentence prepended to the delivered prompt: it states the elapsed time and that the message predates the response, and leaves the staleness judgement to the model. The app owns the queue, so compose and delivery times are exact rather than inferred.

### Why no threshold logic is needed
Queueing only happens while the session is busy, and the queue only flushes on the busy-to-idle transition. Anything that reached the queue was therefore composed mid-turn and delivered after that turn ended, so it crossed a boundary by construction. A directly typed message never enters the queue at all and structurally cannot receive a note. The "only when meaningful" condition reduces to "only messages that went through the queue".

## Evidence

The fault was seen live on 2026-08-03: a message composed at T0 was delivered at T2 and answered as if it replied to the T1 response, costing a round-trip.

The note check was proved non-vacuous. Stashing only `public/app.js` and rerunning the queue suite made the new check fail — the delivered message was observed as `user:Reply with exactly: QUEUED-ALPHA...` with no note text at all — while the other seven checks still passed. Restoring the change and rerunning gave 8/8, with the note present and the never-queued scenario passing. Typecheck was clean.

A screenshot of the live UI shows the delivered bubble carrying `[Queued 2s ago (earliest of 2 messages below), composed while the previous response was still being written — they predate that response.]` ahead of both queued texts. It was captured with an ad-hoc headless script that was not committed.

## Implementation notes

The note builder is framed on `items[0]`. Queue order is preserved, including through the unshift-back-on-send-failure retry path, so the first item is always the earliest. The same built string feeds both the transcript bubble and the outgoing prompt, keeping one source of truth for what the person sees and what the model reads.

This pairs with the already-built editable queue rows: those are the manual escape, this is the automatic net.

## Verification plan

The existing queue suite was extended rather than adding a new script. After the combined-turn assertions it fetches the transcript, locates the delivered user message containing both queued texts, and asserts the note wording is present. A third scenario waits for idle, sends a message the normal way, waits for that turn to end, and asserts the delivered message carries no note marker.

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
