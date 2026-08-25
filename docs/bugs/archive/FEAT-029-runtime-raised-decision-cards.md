# FEAT-029 — Runtime-raised decision cards (a live session emits a 👤 decision → rail card → answer routes back)

- **Status:** VERIFIED
- **Area:** claude-station bridge + Needs-You rail
- **Reported:** 2026-08-04 (the explicit FEAT-018 first-cut handoff)
- **Related:** FEAT-018 (rail + answer POST), FEAT-021 (board injection)

## Problem
The rail (FEAT-018) only renders 👤 items that already exist ON THE BOARD. The other
half of the design: a RUNNING session/orchestrator hits a decision that's genuinely
the user's, and it should become a **persistent, tracked rail card** (question +
optional options) — instead of an ephemeral modal or chat text that scrolls away.
Answering the card routes the answer back to the SPECIFIC session that raised it.

## Design
- **Raise:** an endpoint/bridge message a session can call — `POST
  /api/sessions/:sid/needs-you {question, options?}` — that persists a lightweight
  decision record (JSON) tagged with the raising `sessionId` + project. Persistent
  (survives reload/compaction), not ephemeral.
- **Surface:** the rail merges these decision records with the board's 👤 tickets
  (extend `board.ts` or a sibling reader) → they appear as cards with the question +
  option buttons + free-text field.
- **Answer & route back:** reuse FEAT-018's answer path, but deliver to the
  RAISING session specifically (by the record's sessionId) over its live socket,
  then mark the record resolved (leaves the rail). If that session is gone, keep the
  answer recorded.
- Keep the answer append-only where a ticket is involved; decision records are their
  own small store.

## Verification (REQUIRED)
Real browser + real server: a session raises a decision via the API → a card appears
in the rail with the question + options; answering it (a) delivers the answer to the
raising session, (b) resolves/removes the card, (c) the record persists across a
reload until answered. Must FAIL before the code. verify:ui offline + typecheck.

## Context pack
- Touches: `src/server/index.ts` (raise endpoint), a decisions store, `board.ts`
  (merge into the rail feed), `src/server/agent-bridge.ts`/`events.ts` (deliver to
  the raising session), `public/app.js` (render options buttons if not already).
- app.js → serialize with other FE tickets (none in flight now).

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
