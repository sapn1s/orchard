# BUG-025 — Needs-You rail renders a contextless answerable card for a bare 👤 ticket (title only, no question)

- **Status:** VERIFIED
- **Severity:** med (undermines the rail's whole point — a "needs you" that asks nothing)
- **Area:** Needs-You rail (FEAT-018) vs runtime decisions (FEAT-029)
- **Reported:** 2026-08-04 by user

## Symptom
A ticket marked owner **👤** shows in the rail as a card with just the ticket TITLE + a
blank "Your response…" field — it asks NOTHING, so the only sensible reply is "ok". The
user can't tell what they're responding to. Owner-👤 is board STATUS ("user-owned"), not a
question; the FEAT-018 first cut wrongly made every 👤 ticket an ANSWERABLE card.

## Expected
A card is answerable ONLY when it carries a real QUESTION (± options) — i.e. a
runtime-raised decision (FEAT-029: `POST /needs-you {question, options?}`) or a ticket with
an explicit `Question:` field. A bare 👤 ticket (no question) should render as **read-only
board status** (a "needs your attention" chip linking to the ticket), NOT an answer box.

## Fix direction
- `readBoard()` / the rail: separate **answerable decisions** (have a `question`) from
  **👤 status items** (no question). Only decisions get a response field. 👤-status items
  render as a read-only "attention" row that links to the ticket (or opens it), no textarea.
- Optionally: support an explicit `## Question` block in a ticket → becomes an answerable
  card with that text (so a genuinely-user-owned ticket CAN pose its ask).
- Orchestrator discipline (already corrected): don't mark a ticket 👤 to mean "a decision is
  inside" — raise a real decision (question+options) or ask in chat.

## Verification (§C user-observable)
Real browser: a 👤 ticket with NO question renders as a read-only attention row (no response
box); a runtime decision (FEAT-029, with a question) renders an answer field; a ticket with an
explicit `## Question` renders that question + a field. Must fail on current code (bare 👤 shows
an answer box). verify:ui offline + typecheck.

## Context pack
- Touches: `public/app.js` (rail card render) + `src/server/board.ts` (mark which items are
  answerable). Pairs with FEAT-029 (the real question-bearing path). app.js → serialize FE.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed from user. Root: FEAT-018 made every 👤 ticket answerable; a 👤 ticket has no
  question. Also un-marked FEAT-039's spurious 👤 owner (it was board-status, not an ask).

### 2026-08-04 — agent (fixed + verified)
- **Understood:** 👤 is board STATUS, not a question. Split "answerable" from
  "status" at the source (`readBoard`), so a bare 👤 ticket never reaches the rail
  with a fake response field.
- **Changed (working tree, uncommitted):**
  - `src/server/board.ts`: new `ticketQuestion(dir,id)` parses an explicit
    `## Question` section out of a ticket file — the prose becomes `question`,
    any `- bullet`/`* bullet` lines immediately under it become `options`
    (mirrors a FEAT-029 runtime decision's shape). `readBoard()` now sets
    `item.kind='ticket'` + `item.file` (absolute path to the ticket) for every
    👤 row, and only sets `item.question`/`item.options` when `ticketQuestion`
    finds a `## Question` section. A bare 👤 ticket (no such section) still
    enters `board.needsYou` (it's genuinely open/user-owned) but carries no
    `question` — that's the signal the rail uses to distinguish status from ask.
    `BoardItem` interface doc updated to state the contract explicitly.
  - `public/app.js`: `needsCard(it)` now branches on `!it.question` FIRST →
    `needsStatusRow(it)`, a new read-only render: `.needs-card.status` with
    `data-kind="status"`, the ticket id/sev/title, and a `file://`-linked
    "Open ticket" anchor (`it.file`) — no `<textarea>`, nothing to submit. For
    an answerable card (decision OR ticket-with-`## Question`), if the ticket's
    parsed `question` text differs from its H1 `title`, a new `.nc-question`
    line shows it explicitly (so the card visibly asks something, not just
    displays the ticket title). FEAT-029 decision cards are untouched — the
    server already sets `question`==`title` for those, so the new branch and
    the extra `.nc-question` line never fire for `kind:'decision'`.
  - No changes to `src/server/index.ts` / `agent-bridge.ts` / `templates.ts`
    (other agents' scope) — the merge of runtime decisions into `needsYou`
    (FEAT-029) already sets `kind:'decision'` + `question`, so it flows through
    the SAME `if (!it.question)` branch unaffected.
- **Verified (all real, no mocking):**
  - `npm run verify:needs-you-rail` (extended; CDP + real brave + real server) —
    **17/17 PASS**. Seeded BOTH a `## Question`-bearing 👤 ticket (BUG-701, 2
    bullet options) and a bare 👤 STATUS ticket (BUG-703, no `## Question`) in
    the same project. Checks: the bare ticket's board item carries no
    `question`; the questioned ticket's rail card has the response field +
    both option buttons + the parsed question text; the bare ticket's card is
    `data-kind="status"` with NO textarea and a real `<a>` "open ticket" href;
    answering the questioned ticket removes ONLY that card (status card
    untouched) and append-only writes the answer to disk; a no-board project
    still shows the quiet empty state; narrow-viewport collapse still works.
    **Proven NON-VACUOUS**: git-stashed `board.ts`+`app.js` → 5/17 FAIL
    (bare ticket rendered `kind:'ticket'` WITH a textarea — the exact bug;
    the questioned ticket showed no parsed question/options) — restored, all
    green. Also fixed a pre-existing false-positive in this script's "no
    board" check: a freshly-registered project has no `lastActivityAt` so the
    sidebar's recency split (`isActiveProject`) folds it under a collapsed
    "N inactive projects" row — `clickProj` now expands that row when a
    direct match isn't found, and the check now asserts the click actually
    landed (`state.current.projectId`) instead of just polling for an empty
    rail (which could accidentally read empty because the click silently
    failed and the PREVIOUS project's rail happened to be empty too).
  - NEW `scripts/qa/BUG-025-needs-you-question.spec.ts` (Playwright + real
    brave + real server, `npm run verify:bug-025-question`) — **1/1 PASS**,
    also proven non-vacuous (stash → fails at the exact `question`/read-only
    assertions, same failure mode as above). Covers the same (a)/(b) shape
    end-to-end via Playwright locators, plus append-only + "unrelated card
    untouched" checks. Screenshot: `docs/bugs/assets/BUG-025-status-row.png`
    (BUG-901 renders as a read-only "👤 board status — no question raised" row
    with an "Open ticket" link, no textarea, after BUG-902's `## Question`
    card was answered and removed).
  - `npm run verify:runtime-decision` (FEAT-029 anti-regression, real haiku
    session) — **16/16 PASS**, unaffected: a raised decision still surfaces
    with `kind:'decision'`+`question`+`options`, answers still route back to
    the raising session, still persist across reload.
  - `npm run verify:ui -- --offline` — **3/3 PASS**. `npm run typecheck` — clean.
  - `package.json`: added `verify:bug-025-question` (runs the new spec directly);
    it also runs under `npm run qa:sweep` since it lives in `scripts/qa/`.
- **Scope discipline:** touched only `src/server/board.ts`, `public/app.js`,
  `scripts/verify-needs-you-rail.mjs` (extended), `scripts/qa/BUG-025-needs-you-question.spec.ts`
  (new), `package.json`, and this ticket. Did not touch `survival.ts`/`index.ts`/
  `templates.ts`. Did not commit (working tree only). Did not edit `INDEX.md`.
- **Still open / deferred:** the status row's "Open ticket" link uses a
  `file://` href to the ticket's absolute path — some browsers block
  navigation from an `http:` page to `file:` for security, so it may not
  always open in-tab depending on browser/flags; it is still a real,
  inspectable affordance (visible href, correct path) and is not required to
  navigate for this ticket's fix (the bug was the phantom answer box, not
  ticket navigation). A future ticket could add a small server route to
  stream a ticket's markdown into a drawer instead, if that's wanted.
