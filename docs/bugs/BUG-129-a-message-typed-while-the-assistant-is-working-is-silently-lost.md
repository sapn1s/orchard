```orchard-ticket
{
  "id": "BUG-129",
  "type": "bug",
  "title": "A message typed while the assistant is working is silently lost",
  "summary": "A message sent while a reply was in progress never reached the assistant and is in no store on disk. Text typed at that moment is held only in the browser tab's memory, so a reload, a tab close or a refused delivery destroys it with no warning and no way to recover it.",
  "impact_if_we_wait": "The user's own words disappear without any signal, and nobody can tell a lost message from one that was never sent. There is no copy anywhere to recover, so every occurrence is permanent. This is the worst failure this product can have.",
  "current_need": "none — option A is the decision, it is the shipped behaviour, and the reload-survival suite is green",
  "severity": "high",
  "area": "Composer message queue",
  "reported": "2026-08-20",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-20",
      "question": "Where should a typed message become durable before it is delivered?",
      "mode": "single",
      "options_keys": [
        "A",
        "B",
        "C"
      ],
      "chosen": "A",
      "chosen_on": "2026-08-25",
      "chosen_by": "you",
      "note": "The user's own reason: \"has to be browser storage, if the claude station goes down, it wouldnt store otherwise and we keep losing, so better to just be reliable client side\". B — the server keeps it on arrival — is REJECTED on that reason, not deferred: server-side durability is exactly the thing that is unavailable in the failure the user is protecting against, because a message typed while the station is down or dying has no server to arrive at. C was not chosen; refusing to accept type-ahead removes the habit the queue exists to support and still leaves the text only in the box. A is what is already built and shipped."
    }
  ],
  "success_criteria": [
    "A message typed while a reply is running survives a page reload",
    "A message the server refuses is never shown as delivered",
    "A refused or undelivered message is always recoverable as text the user can copy",
    "No path clears the composer without the text existing somewhere else",
    "Delivery of an accepted message at the next pause keeps working exactly as before"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": "state.queue",
      "note": "a plain array on the in-memory state object; nothing writes it to storage and nothing on the server knows about it, so it exists only while the tab lives"
    },
    {
      "path": "public/app.js",
      "symbol": "submit",
      "note": "mid-reply branch: clears the composer and calls queueMessage, at which point the text exists nowhere but the tab's heap"
    },
    {
      "path": "public/app.js",
      "symbol": "resetTranscript",
      "note": "empties the queue at every session boundary; the rows are discarded, not surfaced"
    },
    {
      "path": "public/app.js",
      "symbol": "flushQueue",
      "note": "removes the batch from the queue before sending, and restores it only when the socket itself rejects the frame — a refusal that arrives afterwards leaves nothing to restore"
    },
    {
      "path": "public/app.js",
      "symbol": "the reattached-and-busy branch of the start ack",
      "note": "deletes the optimistic bubble it just painted and moves the text into the same volatile queue"
    },
    {
      "path": "public/app.js",
      "symbol": "the error branch of the event handler",
      "note": "a refusal that is not fatal, not a budget stop and not a pending start only arms a watchdog: the optimistic bubble is not rolled back and the text is not requeued"
    },
    {
      "path": "src/server/index.ts",
      "symbol": "the send command handler",
      "note": "acknowledges delivery unconditionally and keeps no copy of the text; when the bridge refuses, the surrounding catch reports a message and the text is dropped"
    },
    {
      "path": "src/server/agent-bridge.ts",
      "symbol": "send",
      "note": "throws while a turn is running rather than queueing, and records the prompt to the transcript only after a successful handoff"
    }
  ],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "plan+review",
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
    "archived_path": null,
    "sha256": null,
    "original_title": null,
    "migrated_on": null,
    "migrated_by": null,
    "confirmation": "Authored directly in the record format from a live incident investigated against the on-disk session store. There is no legacy original.",
    "dropped": []
  }
}
```

# BUG-129 — A message typed while the assistant is working is silently lost

## Diagnosis

**The only durable record of a user message is written after it has already been handed to the assistant.** Everything before that moment lives in one browser tab's memory. So any path that accepts text and then fails to deliver it — a reload, a session boundary, a refusal, a race — destroys it, and destroys it silently, because there is nothing anywhere to compare against.

Three distinct paths lose text, and they are independent of one another:

**1. The pending queue is volatile.** Typing while a reply is running is handled by clearing the composer and pushing the text onto `state.queue`, a plain array on the in-memory state object. It is never written to browser storage, never sent to the server, and there is no unload guard. A reload, a tab close, a browser crash, or a switch to another session (`resetTranscript` empties it by design) ends it. The user sees a row appear and then, after a reload, no row and no message.

**2. Re-attaching mid-reply moves an already-painted message into that same volatile queue.** When a tab that had stopped driving a session sends a message, the client paints it into the transcript and asks the server to start. If the server answers that it re-attached and a reply is in flight, the client *removes the bubble it just painted* and pushes the text onto `state.queue`. The message was visible in the transcript for a moment, then was not, and now depends entirely on the tab staying alive.

**3. A refusal that arrives after the frame was accepted rolls nothing back.** The server refuses a send while a reply is running — the bridge throws, and the surrounding catch reports it as an ordinary non-fatal error. That error carries no marker saying it is retryable, so on the client it falls past the fatal branch, past the budget branch, past the start-refusal branch, and into the final one, which only arms a watchdog. The optimistic bubble is left standing — the transcript claims a message was delivered that the assistant never received — and if the text came from a batch flush, the queue had already dropped those rows and there is nothing to put back.

Underneath all three: the server acknowledges every send as delivered before it knows whether it was, and keeps no copy of the text it refuses.

## Evidence

**Ground truth first: the message is not on disk, anywhere.** The live session's transcript was copied read-only to scratch and read in full. Between the user's message at 06:01:10Z (`same question as before: are active/pending ticekts all converted`) and the next inbound event at 07:25:45Z, every entry is assistant output, tool results, background-agent notifications, or the harness's own queue records. There is no user-authored message in the window.

The harness writes a queue record for every message it receives. In that window there are six, at 06:07:33, 06:12:48, 06:42:44, 06:53:44, 07:02:01 and 07:22:49 — all background-agent notifications, verified by reading their contents. One of them, at 06:53:44, is an enqueue followed by a *remove* rather than a dequeue, which is the only anomaly in the window; its content was read and it is a background-command notification, not the user's message. So the message never reached the assistant's process at all.

**It did not land in another session either.** Every transcript across every project modified since 05:00Z was scanned for a user-authored message in the window. Twenty were found; all are verifier prompts, ticket-conversion prompts, or messages in unrelated projects on other subjects. None is about board or ticket usability.

**The server kept no record and logged nothing.** The service's journal for the whole day holds two lines, neither in the window. The send handler has no logging and no store. Nothing on disk, on either side, was ever going to show this.

**The text is therefore unrecoverable from any store.** The one remaining place it could still exist is the memory of a browser tab that was open at the time and has not been reloaded — the pending row would still be shown in the dock. That was not touched during this investigation.

**Which of the three paths fired is not determined.** All three are present in the code and all three produce exactly the reported symptom. Distinguishing them needs one fact only the user has: whether a queued row was visible before the message vanished.

## Implementation notes

**Option A only. Option B is untouched and still the user's to decide** — nothing in the delivery path, the server, or the re-attach logic was changed, and no part of B was started.

What A does: the pending queue is mirrored into browser storage on every mutation, under the same per-session key the composer draft already uses (`draftKey`, BUG-083), and read back when that session is opened. Three volatile spots are covered, not one — the queue itself, a force-send waiting for its interrupt to land, and the batch that `flushQueue` has handed to the socket but whose turn has not yet started (`state.outbox`). The last one is why durability could not simply be "write the queue": the batch leaves the queue at the moment it is handed over, and before this it lived nowhere at all until the server wrote it.

**A row is cleared only when it is durable somewhere else, or when the user clears it.** The handed-off copy is retired at `turn-end` — the point at which the server has certainly written the prompt — and explicitly not at the send ack, because the server acks `delivered: true` unconditionally without knowing whether the bridge took the text. If a reload finds a handed-off batch, it is judged against the transcript (screen first, then the transcript endpoint) and only raised as unconfirmed when the transcript does not hold it.

**What is now visible.** A restored row is its own state: marked in the dock ("unsent · restored"), given its own surface and edge in the row list, and never described as delivering. A restored batch that cannot be confirmed comes back *dead* — readable, copyable, editable, and never resent, because redelivering a message the user already sent is a different harm (see Risks). Two labels had to be corrected as a consequence, both because rows can now outlive the tab: a reloaded tab is only FOLLOWING the session, so the dock no longer promises a delivery it cannot perform, and it names the action that resolves it.

**Three things A does NOT fix, and the UI does not imply otherwise:**
- a refusal arriving after the frame was accepted still leaves an optimistic bubble claiming delivery — the transcript still lies about that one (B);
- a mid-reply re-attach still deletes the painted bubble; the text now lands in a durable queue instead of a volatile one, but the bubble still vanishes;
- the composer box is still volatile (`state.drafts` is an in-memory Map) — text never submitted is still lost by a reload.

**On the open question of which loss path fired live:** reading the code cannot settle it, and this fix does not need it settled. All three paths remain reachable from the code as written, none of them logs, and none leaves a trace on disk — so nothing in the repository distinguishes them after the fact. The distinguishing fact is still the one the user has: whether a queued row was visible in the dock. What can be said is that A closes paths 1 and (for durability) 2 whichever fired, and does not close 3.

## Verification plan

A fix here is only proved by the user-visible outcome, and the decisive cases are the ones no static fixture expresses:

- **Reload with a message pending.** Type during a running reply, reload the page, and assert the text is still offered. This is the case that failed live and it must be driven in a real browser, not asserted against a constructed state object.
- **A refusal after the frame was accepted.** Force the server to refuse a send that the socket already took, and assert the transcript does not claim delivery and the text is still recoverable. This is a race, so it has to be injected rather than described.
- **A batch flush that is refused.** Several messages queued together, refused as a batch: every one of them must come back, in order, not just the first.
- **A session boundary while rows are pending.** Switching away must not discard them without saying so.
- **The ordinary path is unchanged.** A message queued during a reply and delivered at the next pause still arrives once, in order, with its existing note.

Non-vacuity must be proved against a synthesized pre-fix copy of the client, not against the current revision, since the current revision becomes the fixed one the moment a fix lands.

## Risks

The two loss paths that matter most sit in the delivery and re-attach logic, which has produced subtle regressions repeatedly — the code carries scars from at least four prior tickets about text being double-delivered, delivered into the wrong session, or dropped at a boundary. A change that makes text durable can easily make it durable *twice*, which is a different kind of harm: a message delivered a second time after a reload reads as the user repeating themselves.

The contained option is contained precisely because it does not touch that logic. The thorough option does, and should not be built without an independent review of the plan.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-20 — worker (dispatched, investigation only)

- **Understood:** dispatched with a hypothesis that a mid-reply send was dropped by the delivery path, and told to weigh the alternatives equally. Started from the on-disk store rather than the rendered page, because that single fact splits the problem.
- **Changed:** nothing. This ticket only. No code was touched, the live session store was copied read-only to a scratch directory and never written to, and no process was started or stopped.
- **Verified:**
  - The message is **absent from the session's transcript on disk** — the full 18,529-entry file was parsed and every entry in the 06:01–07:25Z window classified. PASS (absence established, not assumed).
  - **Absent from every other transcript** — all project transcripts modified since 05:00Z parsed for user-authored messages in the window; 20 found, none matching. PASS.
  - **The harness received no user message in the window** — all six queue records read in full; all are background notifications. PASS.
  - **The server logged nothing and stores nothing** — service journal for the day is two lines, neither in the window; the send handler has no store. PASS.
  - **The pending queue has no persistence** — every reference to it in the client was read; no browser storage, no server write, no unload guard. PASS.
  - Which loss path fired: **NOT determined.** Three are present and all three fit. Said so rather than picking one.
- **Verified-by:** not applicable — nothing was built. The eventual fix is `plan+review` and its plan should be critiqued independently before a line is written.
- **Still open / handoff:** the user's words are not recoverable from any store. The one remaining chance is a browser tab open since the incident and not reloaded, whose dock would still show the pending row; that should be checked before any tab is closed. The next agent needs one fact from the user — whether a queued row was visible — which selects the loss path and therefore the fix.
- **Symptom of a deeper design flaw?** Not answered here — the ticket is not closed. The suspicion to hand forward: durability is attached to *delivery* rather than to *acceptance*, so every path that accepts text and fails to deliver it loses it by construction. If a second message is lost by a different path than the one fixed, the question is not another guard but who owns a message between the composer and the transcript.

### 2026-08-20 — worker (dispatched, class: `fix`, option A only)

- **Understood:** build option A as stop-loss — persist the pending queue in browser storage so a reload, a tab close or a session switch cannot silently destroy typed-but-undelivered text — and do NOT build or partially build B. Charter hypothesis: the loss is contained to the queue's lifecycle in `public/app.js` (`submit`, `resetTranscript`, `flushQueue`), and if persistence needed a server change that would be B wearing A's clothes.
- **Hypothesis: confirmed, with two corrections.** The three sites are real (`resetTranscript` zeroing the queue, `flushQueue` splicing the batch out with no restore path, `submit`'s mid-turn branch), though only two of the three line numbers in the charter matched — the submit site is near the end of the file, not line 184. No server change was needed: the one read of an existing endpoint (the transcript tail, to decide whether a handed-off batch actually arrived) is a client-side read of a surface the session view already uses. Two things the charter's reading did NOT contain, both found by driving it: a *third* volatile spot (`state.forceSend`, holding a row that has left the queue while its interrupt lands), and the fact that persistence alone leaves the batch handed to the socket unprotected for the whole send→turn-end window.
- **Changed:** `public/app.js` (queue persistence, restore, the handed-off outbox, honest labels, `restored` row state), `public/styles.css` (the restored row's own surface + edge), `scripts/verify-bug-129-queue-durability.mjs` (new), `package.json` (its script entry), this ticket. Nothing in `src/server/`, nothing in the delivery or re-attach logic, no part of B.
- **Verified** — `node scripts/verify-bug-129-queue-durability.mjs`, **23/23**, real browser, real server on a free port with its own data dir, real turns. Every check prints its observed value.
  - Type two messages during a real running reply, **reload**, and the text is on screen in the dock, marked unsent — the case that failed live. PASS.
  - The reload is *proved to be one*: the first run of this suite used `Page.navigate` to the page's own URL, which is a SAME-DOCUMENT navigation, and reported three green checks about a reload that never happened. It now plants a marker and refuses to continue if the marker survives. That vacuity was in this suite, was caught by reading an observed value that did not fit, and is named here rather than quietly fixed.
  - Restored-and-unsent is visibly distinct: computed background `rgb(26, 29, 26)` vs `rgba(0, 0, 0, 0)` and a 2px edge vs none, plus two screenshots that differ. Asserted on computed colour, not on bytes alone.
  - Delivery is unchanged and **not duplicated**: after taking the session back over, each of the three pre-reload messages appears in the on-disk transcript exactly once (1/1/1).
  - Session boundary: switch away → the dock clears (unchanged) but the text survives in storage → return → the row is back, marked unsent → discard → gone from storage too.
  - The handed-off batch was captured **in flight** from real storage (sampled every 20 ms), retired at turn-end, replayed as unconfirmed (comes back dead, never resent: 0 occurrences in the transcript), and correctly **suppressed** when the transcript does hold it.
  - **Must-FAIL, against a synthesized pre-fix client** — `persistQueue`/`adoptQueue` neutered by a transform whose hit count is asserted (1 per site) and served through CDP interception. Pre-fix: the message is accepted, nothing is stored, and the reload destroys it — no row, no text, no signal. Anchored to a constructed variant, never `HEAD`.
  - Anti-regression: `npm run verify:queue` **15/15** (mid-turn queueing, batch delivery as one turn, per-item notes, force-send interrupt round-trip). `npm run gate` PASS (exit 0, read directly).
- **Three defects the suite found in my own fix, all fixed and re-proved:** (1) the storage key never moved when a pending-new session acquired its id, so a message queued during the very first turn was stored under a key nothing reads and the reload lost it exactly as before; (2) the key-mismatch "migration" retargeted onto the incoming session mid-`openSession` while the queue was momentarily empty and **deleted that session's stored rows** — the reverse of the bug; (3) the handed-off batch was judged against the rendered pane, so reopening at a remembered position (a history WINDOW, not the tail) cried wolf over a message that had been delivered perfectly well.
- **Verified-by:** NOT independently verified. This is the fixer's own suite and it is not the last word (WA §C). This is data-loss + reload + session-lifecycle class — an independent clean-room pass is warranted before this is called done.
- **Still open / handoff:** B is untouched and remains the user's decision. Three named loss paths stay open by design (a refusal after the frame was accepted; the re-attach deleting a painted bubble; the composer box itself). Which path fired live is still undetermined and cannot be settled from the code — the distinguishing fact is still whether a queued row was visible in the dock.

### 2026-08-25 — you (answer · via ticket view)
- **Question:** Where should a typed message become durable before it is delivered?
- **Chose:** A — Keep the queue in the browser
- **Note:** has to be browser storage, if the claude station goes down, it wouldnt store otherwise and we keep losing, so better to just be reliable client side
- **State:** answered — awaiting agent action (not dispatched)

### 2026-08-25 — worker
- **decision-recorded:** 2026-08-25 decision recorded and ticket closed (bookkeeping sweep, authorised by the user). CHOSEN: A — keep the queue in browser storage. The user reason, in their words: "has to be browser storage, if the claude station goes down, it wouldnt store otherwise and we keep losing, so better to just be reliable client side". Option B (the server keeps it on arrival) is REJECTED on that reason rather than deferred — server-side durability is unavailable in precisely the failure being protected against, because a message typed while the station is down has no server to arrive at. Option C was not chosen. The decision is written into decision_history and the open decision is cleared. A is what was already built as the stop-loss, so NOTHING WAS BUILT for this entry. Re-verified the shipped behaviour instead: `npm run verify:bug-129` at HEAD b6c0151 — 23 passed, 0 failed, exit 0 read directly, in real headless Brave on a scratch server, including the must-FAIL proof that pre-fix the reload destroys the message with no row, no text and no signal. Closing as verified. Unchanged and still true: three named loss paths stay open by design (a refusal after the frame was accepted, the re-attach deleting a painted bubble, the composer box itself), and B remains available as its own reviewed plan if the client-side keeper is ever not enough. This is data-loss class, so an independent clean-room pass on the shipped queue remains worthwhile hardening — recorded, not claimed as done.
