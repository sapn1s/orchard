# FEAT-147 — Search can't find a project by name to start work in it

- **Status:** IN-PROGRESS — fix built and self-verified in a real browser; needs an independent clean-room pass before VERIFIED.
- **Severity:** medium
- **Area:** sidebar (finder / global search)
- **Reported:** 2026-09-21 by user
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
User, verbatim (private project name redacted as `<project>`): "ux change:
navbar search, top results actually must also include project names, since eg i
want to start new session in '<project>' id have to find it somehow in our
session list which is scrollable, so ya thats expected that i can easily find it
without needing to look through all sessions".

Typing a project's name into the finder returned only session-title and message
hits. To reach a project (e.g. to start a new session in it) the user had to
scroll the sidebar or already know the `#name` scope grammar — the plain-text
search never surfaced the project itself.

## Repro
1. Open the finder (search button in the sidebar header).
2. Type a project-name substring that no session title contains (e.g. `acme`
   when the only `acme`-titled sessions live in a different project, or the exact
   project name `acme-bot`).
3. Before: results show a "Sessions" section and a "Messages" section only; the
   project you were trying to reach is nowhere in the list.

## Expected
Plain-text search also surfaces PROJECTS, ranked above session hits, clearly
labelled as projects, and selecting one takes you to that project so you can
start a new session — without inventing a new affordance.

## Context pack (grows — the "where to look", so no agent cold-starts)
- Files/functions in play:
  - `public/app.js` — `renderSearch()` (the finder result renderer);
    `parseFinderQuery()` (plain / pickProject / scoped modes; the `#`-scope
    grammar is UNTOUCHED); new helpers `projMatchRank()`, `projectHitRow()`,
    `closeFinder()`, `revealProject()`; `renderProjectGroup()` now stamps
    `group.dataset.pid` so a hit can scroll the group into view; reuses existing
    `selectProject()` and `startNew()`.
  - `public/styles.css` — new `.row.hit .plus` rule (mirrors `.proj .plus`, the
    sidebar header's own + button; hover-revealed, same custom properties).
- The only NEW behaviour is a "Projects" section in `pq.mode === 'plain'` search;
  session-title search, message/content search (tier 2), and the `#` project
  scope picker are unchanged.
- Related tickets: BUG-009 (finder trailing-space sentinel — preserved),
  verify:search harness (`scripts/verify-search.mjs`).
- Repro test: `npm run verify:search` (existing; anti-regression). Manual
  browser proof recorded in the Activity log below.
- Known dependencies / blockers: none.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-21 — worker (Opus 4.8), dispatched FEAT-147 fixing round 1
- **Understood:** the finder's plain-text path (`renderSearch`, `pq.mode ===
  'plain'`) indexed session titles + message contents only. Projects were
  reachable solely through the `#name` scope grammar (pickProject mode), which
  the user did not know and should not have to. Confirmed the app already has a
  first-class "open/select a project" affordance (`selectProject`) and a "new
  session in this project" affordance (`startNew`, the sidebar header's `+`), so
  the fix reuses them rather than inventing navigation.
- **Changed:**
  - `public/app.js`: added a "Projects" section to plain-mode `renderSearch()`,
    rendered ABOVE the "Sessions" section so a direct project-name match is not
    buried under session hits. Matches ranked exact → prefix → substring
    (`projMatchRank`), then by recency. New `projectHitRow()` mirrors the sidebar
    project header: clicking the row opens the project (expand + `selectProject`
    + close finder + scroll into view via `revealProject`); the hover-revealed
    `+` starts a new session in it (`startNew`). `closeFinder()` resets the
    finder so a navigating hit lands on the normal tree. `renderProjectGroup()`
    stamps `group.dataset.pid` as the scroll anchor. (unstaged; no commit sha.)
  - `public/styles.css`: `.row.hit .plus` rule mirroring `.proj .plus` (same
    custom properties, hover-reveal) so the + reads identically to the sidebar's.
- **Verified (fixer's own run — necessary, not sufficient):**
  - `npm run gate` → PASS (leak-gate + check-nul + typecheck), exit 0.
  - `npm run verify:search` → 12 passed, 0 failed (anti-regression: content
    search classification, locate, param validation, and the existing UI
    click-through all still green).
  - Real browser via Playwright MCP against a realistic-state fixture (5
    projects with generic names, several sessions each; scratch server on an
    ephemeral port, own dataDir). Typing a project substring: a "Projects"
    section rendered FIRST with the two matching projects (each with a + button),
    then "Sessions" (a session whose title also matched), then "Messages" —
    proving projects rank above sessions and are labelled. Typing an exact
    project name that matched 0 session titles and 0 messages STILL surfaced the
    project — the user's exact scenario. Clicking the `+` on the project → URL
    `#/project/<id>`, finder closed, input cleared, a fresh "New session" docked
    in that project. Clicking the row body → finder closed, input cleared, the
    project expanded/revealed in the sidebar.
  - Could NOT test: keyboard arrow-key traversal of results — the finder has no
    arrow-key result navigation today (only Enter, which completes a `#` scope or
    runs content search); nothing to preserve there, and Enter behaviour is
    unchanged. Did not exercise the empty-query and `#`-scope-picker paths in the
    browser beyond confirming their code path is untouched.
- **Verified-by:** PENDING — independent clean-room pass required before VERIFIED
  (search/finder is a regression-prone surface). Fixer id ≠ verifier id.
- **Still open / handoff:** independent verify should cover a case the fixer's
  fixture did not: mixed ranking when a project name AND many session titles both
  match the same substring (does the project still sit above sessions?), and the
  `#`-scope picker still completing on Enter after this change.
- **Symptom of a deeper design flaw?** (answered on close)
