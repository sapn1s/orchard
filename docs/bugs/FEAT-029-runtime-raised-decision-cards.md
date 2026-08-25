```orchard-ticket
{
  "id": "FEAT-029",
  "type": "feature",
  "title": "Live sessions could not raise a decision for the user to answer",
  "summary": "A running session that hits a genuinely human choice can now post a question, with optional answer buttons, and it appears as a tracked card alongside board-raised items. The answer goes back to the session that asked, the card clears, and the record survives a reload until it is answered. Both the interface suite and the rail suite pass.",
  "impact_if_we_wait": "Nothing is pending. Before this, a session's question could only reach a person as chat text that scrolled away or a modal that vanished on reload, so the answer was lost rather than tracked.",
  "current_need": "Nothing is outstanding. A session raises a question, the card appears and is answered back to the raising session, and the interface and rail checks both came back clean alongside typechecking.",
  "severity": "medium",
  "area": "Needs-You rail",
  "reported": "2026-08-04",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A session posts a question and a card appears in the rail with its options",
    "Answering the card delivers the answer to the session that raised it",
    "Answering resolves the record and removes the card from the rail",
    "The record survives a page reload until it is answered",
    "If the raising session is gone, the answer is still recorded"
  ],
  "code_refs": [
    {
      "path": "src/server/index.ts",
      "symbol": null,
      "note": "raise endpoint POST /api/sessions/:sid/needs-you {question, options?}"
    },
    {
      "path": "src/server/board.ts",
      "symbol": null,
      "note": "merges decision records with the board's 👤 tickets; board injection itself is FEAT-021"
    },
    {
      "path": "src/server/agent-bridge.ts",
      "symbol": null,
      "note": "delivers the answer to the raising session over its live socket"
    },
    {
      "path": "src/server/events.ts",
      "symbol": null,
      "note": "live-socket delivery path for the answer"
    },
    {
      "path": "public/app.js",
      "symbol": null,
      "note": "renders the question, option buttons and free-text field"
    }
  ],
  "related": [
    {
      "id": "BUG-016",
      "relation": "blocks"
    },
    {
      "id": "BUG-025",
      "relation": "see_also"
    },
    {
      "id": "FEAT-018",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-018",
      "relation": "see_also"
    },
    {
      "id": "FEAT-021",
      "relation": "see_also"
    },
    {
      "id": "FEAT-067",
      "relation": "see_also"
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
    "archived_path": "docs/bugs/archive/FEAT-029-runtime-raised-decision-cards.md",
    "sha256": "8138b9ca9cffc939ef4edc6a9048fa207b7b1dfb9c21ac1df975971dbfba7e4e",
    "bytes": 6633,
    "original_title": "Runtime-raised decision cards (a live session emits a 👤 decision → rail card → answer routes back)",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared clause by clause against the original head: the raise endpoint, the persistent record, the rail merge, the route-back-and-resolve behaviour and the browser bar are all present.",
    "dropped": [
      "the note that no other front-end ticket was in flight, which was a scheduling remark about editing the front-end file"
    ]
  }
}
```

# FEAT-029 — Live sessions could not raise a decision for the user to answer

## Diagnosis

### The half that was missing

The rail built by FEAT-018 rendered only 👤 items that already existed on the board. Nothing let a running session or orchestrator originate a decision of its own. Such a question could only surface as a modal or as chat text, neither of which is persistent or tracked, and neither of which knows how to route an answer back to the specific session that asked.

## Evidence

### What ran

The interface suite passed 3/3 and the Needs-You rail suite passed 11/11. A further tally of 16/16 is recorded without an adjacent suite name. Typechecking stayed clean. A runtime-decision suite is named in the plan but no result for it is recorded.

## Implementation notes

### Shape of the store and the routing

A session raises a decision by posting a question and optional options to a per-session endpoint. That persists a lightweight JSON decision record tagged with the raising session id and the project, so it survives reload and compaction. The rail reads those records and merges them into the same feed as the board's 👤 tickets, rendering the question with option buttons and a free-text field.

The answer path from FEAT-018 is reused, but delivery is addressed to the raising session over its live socket, after which the record is marked resolved and leaves the rail. If that session no longer exists, the answer is still recorded rather than dropped. Where a ticket is involved, answers stay append-only; the decision records are their own small store.

## Verification plan

### The bar that was set

Real browser against a real server: a session raises a decision through the API, a card appears in the rail with the question and its options, answering it delivers to the raising session, resolves and removes the card, and the record persists across a reload until answered. The check had to fail before the code existed. Offline interface checks and typechecking alongside.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed from the FEAT-018 handoff; dispatched as the flagship completion.

### 2026-08-04 — agent (built + verified)
- **Understood:** complete the FEAT-018 handoff — a RUNNING session raises a
  decision that becomes a PERSISTENT, tracked Needs-You rail card (question +
  optional options), and the user's answer routes back to that SPECIFIC session
  over its live bridge (`AgentSession.send()`), then the record is resolved so it
  leaves the rail. Reused FEAT-018's `readBoard`/rail/answer path end-to-end.
- **Changed (working tree, uncommitted):**
  - `src/server/decisions.ts` (NEW): the lightweight decision store — a JSON
    ledger at `$CLAUDE_STATION_DATA/decisions.json`, written with `writeAtomic`
    (crash-safe). `raise({projectId,sessionId,sdkSessionId,question,options})` →
    persisted record (id `dec-<t>-<rand>`); `listOpenForProject`, `get`,
    `resolve(id,answer,delivered)`. Persistent, NOT ephemeral — survives reload /
    restart / compaction until answered.
  - `src/server/index.ts`: (1) `POST /api/sessions/:sid/needs-you {question,
    options?}` — `:sid` resolves EITHER a station id (`getSession`) OR an SDK id
    (`liveSessions().find(sdkSessionId)`), mirroring the subagent route; 400 on an
    empty question, a non-array `options`, or an unknown/dead session; 201 with the
    record id. (2) `GET .../board` now MERGES the project's open decision records
    into `needsYou` in FRONT of the board's 👤 tickets (tagged `kind:'decision'`
    with `question`/`options`). (3) `POST .../board/answer` detects a decision id
    and routes the answer back to the raising session (`getSession(rec.sessionId)`
    ?? sdk-id fallback) via `send()`, then `resolve()`s the record; a gone/closed
    session records `delivered:false` and does NOT crash. Ticket answers keep the
    existing append-only path untouched.
  - `src/server/board.ts`: `BoardItem` extended with optional
    `kind`/`question`/`options` (absent === `'ticket'`); no behavioural change to
    the ticket reader.
  - `public/app.js` (`needsCard`): renders a decision card — `👤 decision` label,
    the question, option buttons when `it.options` (click = submit that option),
    and the free-text field still works. Answers via the SAME `api.answerBoard`
    (the server disambiguates by id), so no new client endpoint. `public/styles.css`:
    `.needs-card.decision` + `.nc-opts`/`.nc-opt` — greyscale + the existing moss
    `--live` accent only, no new colour.
- **Verified:**
  - `npm run verify:runtime-decision` (NEW; real brave + real server on a scratch
    free port, one real haiku session) — **16/16 PASS**. Proven NON-VACUOUS: with
    the four source files git-stashed the raise route 404s and the flow fails
    6/13 (raise → 404, no card, FATAL); restored → all green. PASS lines:
    (d1) empty question → 400; (d2) unknown session → 400;
    (a) raise → 201 + record → card in the rail with the question + BOTH option
    buttons + a free-text field, and the board feed carries it as `kind:decision`;
    (b) clicking an option removed the card, the record recorded `delivered:true`,
    and the option text landed in the RAISING session's transcript as a user
    message (`user:Ship now`) — routed back over the live bridge;
    (c) an unanswered decision PERSISTED across a full page reload (store-backed,
    not DOM); after the reload closed the idle session, a free-text answer was
    still RECORDED (`delivered:false`) with the server staying healthy — no crash.
  - `npm run verify:needs-you-rail` — **11/11 PASS** (no regression on the board
    ticket rail / append-only / empty state / narrow collapse).
  - `npm run verify:ui -- --offline` — **3/3 PASS**. `npm run typecheck` — clean.
  - Screenshot: `docs/bugs/assets/FEAT-029-runtime-card.png` (a live runtime
    decision card with option buttons in the rail).
- **Still open / deferred:** the cross-project 👤 rollup (FEAT-018 design) is still
  deferred. A session currently learns its own id out-of-band to call the raise
  endpoint; a first-class bridge command (`needs-you` over the ws) so a session
  raises without knowing its HTTP id is a natural follow-up. Did NOT touch INDEX.md
  (orchestrator-owned).
