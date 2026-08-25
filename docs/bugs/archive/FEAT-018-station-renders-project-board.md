# FEAT-018 — "Needs You" right-rail: decisions as interactive prompts (+ board surface)

- **Status:** DONE — first cut + FEAT-029 runtime cards (BUG-016 added live-refresh)
- **Area:** claude-station UI + server
- **Reported:** 2026-08-04 (tier 3 of FEAT-017; upgraded 2026-08-04 by user from a read-only strip to an interactive rail)

## Goal
Use the ~20% free right-side space on desktop as a **"Needs You" rail** that turns
every decision the orchestrator/agents raise into a **tracked, interactive object**
— a prompt card with a response field — instead of prose the user has to skim and
do "due diligence" on. An item is visibly UNRESOLVED until answered; answering
resolves it and records the answer durably. This is what makes "nothing important
lives only in chat" (§H) real: decisions are first-class, not buried in text.

## Design
- **Placement:** a right rail occupying the free desktop width (~20%); collapses /
  becomes a badge on narrow viewports. Greyscale + single moss accent; hairlines.
- **Needs-You cards (the core):** each open 👤 decision renders as a card with the
  question, any options (as buttons), and an **inline response field** (free text,
  or option-select). Submitting:
  - records the answer to the source ticket (append-only) + flips the item to
    resolved (leaves the rail),
  - routes the answer back to the owning session (as the user's response) so the
    orchestrator receives it — closing the loop without a chat round-trip,
  - source of truth = the board files (tickets with owner 👤) + decisions an active
    session raises; one source, rendered here.
- **Below the decisions:** the glanceable board — In-flight (🤖) and Done-today,
  per project, plus an optional cross-project rollup of ALL 👤 items so nothing
  needing the user is ever hidden. Read-only.
- **State honesty:** the rail's count = real unresolved decisions. If it's empty,
  there is genuinely nothing waiting — the UI equivalent of "✓ nothing needs you".

## How decisions get in
1. A session/agent hits a user-owned decision → emits a 👤 item (question +
   optional options) → appears as a card. (Supersedes ephemeral modal asks with a
   persistent object that survives reload/compaction.)
2. Existing 👤-owned tickets on the board.

## Server (files stay the source of truth)
- Endpoint: for a project with `docs/bugs/`, parse INDEX.md + ticket frontmatter →
  `{needsYou:[{id,title,question,options?}], inflight:[...], doneToday:[...]}`.
  Projects without `docs/bugs/` have no board (opt-in; e.g. ~ none).
- Answer POST: append the response to the ticket (append-only) + deliver it to the
  owning session; never rewrite prior ticket content.

## Verification (REQUIRED)
Real browser: seed a project with a 👤 decision item → the rail shows one unresolved
card with a response field; answering it (a) removes the card, (b) writes the answer
to the ticket, (c) delivers the answer to the session; the rail then reads empty. A
project with no 👤 items shows an empty/'nothing needs you' rail (not an error).
Narrow viewport collapses the rail. verify:ui offline + typecheck.

## Context pack
- Touches: `src/server/index.ts` (board-parse route + answer POST), `public/app.js`
  (rail render + response submit), `styles.css` (rail layout). app.js → serialize
  with other FE tickets.
- Pairs with FEAT-021 (same board snapshot injected into the session prompt — the
  machine side) and reuses answer-routing so the injected view and the rail stay in sync.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed as tier 3 of FEAT-017 (read-only board render). Files-as-source confirmed by
  user; station is a read-only viewer/aggregator of the opt-in per-project board.
### 2026-08-04 — orchestrator (user upgrade)
- User: use the free ~20% desktop right space as a Needs-You rail where decisions
  are interactive prompts with response fields, so unresolved items are truly
  tracked (state) instead of text to audit. Absorbed the old read-only "Needs-you"
  strip into this interactive design; bumped to HIGH. Human-facing half of the
  NEEDS-YOU contract; queue as the next FE build once app.js frees (after BUG-013).

### 2026-08-04 — agent (scoped first cut)
- **Understood:** build the interactive Needs-You right rail for the 👤 items that
  exist ON THE BOARD (INDEX.md owner column + ticket files). A session *raising* a
  new decision card at runtime is explicitly out of scope for this cut — noted as a
  handoff below. Files-as-source: the station is a read-only aggregator of the
  opt-in per-project `docs/bugs/`, plus one append-only write (the answer).
- **Changed (working tree, uncommitted):**
  - `src/server/board.ts` (new): `readBoard(hostPath)` parses `INDEX.md` (owner 👤 →
    needsYou, 🤖 → inflight; Done rows touched <24h → doneToday) enriched with each
    ticket's H1 title; returns `{hasBoard:false,…}` for a project with no
    `docs/bugs/` (opt-in, never an error). `appendAnswer()` writes a dated
    Activity-log entry with `fs.appendFileSync` (strictly append-only — prior
    content is never read-and-rewritten). A ticket carrying the rail's answer mark
    is treated as resolved so it leaves the rail even though INDEX still says 👤.
  - `src/server/index.ts` (+~40): `GET /api/projects/:id/board` and
    `POST /api/projects/:id/board/answer {id,answer}` — appends to the ticket, then
    delivers the answer to the first attached, idle session via the SAME
    `AgentSession.send()` path the composer uses; no session attached → just records
    (`delivered:false`). 400 on empty id/answer, honest error on unknown ticket.
  - `public/index.html` + `styles.css` (+~130) + `app.js` (+~150) + `lib/api.js`:
    a right rail using the free ~20% desktop column (greyscale + the single moss
    `--live` accent + hairlines, no new colour). Needs-you cards first (title +
    inline response field + Respond; ⌘/Ctrl-Enter submits), then read-only In-flight
    (🤖) and Done-today. Submit is optimistic (card removed at once) and reconciled
    on refresh; empty state is the quiet "✓ nothing needs you", not an error. Narrow
    viewport (<1040px) collapses the rail to a floating badge that opens it as an
    overlay.
- **Verified:**
  - `npm run verify:needs-you-rail` (new; real brave + real server, scratch project
    on a free port) — **11/11 PASS**. Proven non-vacuous: with the source changes
    git-stashed it FAILED (board route 404 → preconditions fail, no `.needs-card`,
    narrow check errors); restored → all green. PASS lines:
    (a) one unresolved card with a response field + submit for the seeded 👤 row;
    (b1) submit removes the card and the rail reconciles to empty; (b2) the answer is
    appended to the ticket file on disk as a dated entry; (b3) append-only — the
    prior log entry survives verbatim, before the new one; (c) a no-`docs/bugs/`
    project shows "✓ nothing needs you" with NO error; (d) narrow viewport →
    rail off-canvas + floating badge, and the badge re-opens it.
  - `npm run verify:ui -- --offline` — **3/3 PASS** (no rail regression on the main UI).
  - `npm run typecheck` — clean.
  - Screenshot: `docs/bugs/assets/FEAT-018-rail.png`.
- **Still open / handoff (runtime-raise decision cards):** this cut renders only
  👤 items already ON THE BOARD. The FEAT-018 design's other source — a live
  session/agent *emitting* a new 👤 decision at runtime (question + optional
  options) as a persistent object — is NOT built. Next agent: add a bridge event
  (e.g. `needs-you` / reuse the AskUserQuestion surface) that writes/updates a
  ticket (or a lightweight decision record) so it flows through the same
  `readBoard` → rail path, and route the rail's answer back over the live socket
  (this cut delivers via `AgentSession.send()` for an ATTACHED session only — a
  detached/among-many session is recorded but not yet delivered). Also: `options`
  buttons (design §Needs-You cards) and the cross-project 👤 rollup are deferred.
  Server shape already carries `owner/status/sev`; extend `BoardItem` with
  `question/options` when the raise path lands. Did NOT touch INDEX.md (orchestrator-owned).

- 2026-08-06 — privacy scrub for public release (FEAT-049, sanctioned append-only exception): private names/paths neutralized (project aliases, home paths → ~).
