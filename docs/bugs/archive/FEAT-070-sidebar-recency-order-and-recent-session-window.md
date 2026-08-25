# FEAT-070 — sidebar: order projects by recency (with optional alpha sort) + default sessions to a recency window, not a flat 6

- **Status:** VERIFIED — fixed 2026-08-13 (issues 3+4; §C incl. must-FAIL-pre-fix proof + churn-stability regression)
- **Area:** FE sidebar tree (app.js renderTree — project ordering + per-project session cap)
- **Reported:** 2026-08-13 by user

## Issue 3 — projects ordered by name, not recency
The left-nav projects are ordered by name; the user wants **most-recently-worked projects at the
top** (by lastActivityAt desc). NOTE: there is a DOCUMENTED prior decision against recency-ordering
projects (app.js:177 — "by recency was tried on paper and rejected: 4 active projects would…").
The agent MUST read that rationale and reconcile: the concern was likely reorder-churn/jitter as
active projects shuffle. Resolution the user offered: **default to recency, but add a sort toggle
(recency ↔ alphabetical)** so both are available and the churn concern is opt-out-able. Implement
recency-default + an alpha toggle; if the churn rationale is real, mitigate (e.g. stable order
within a session, only re-sort on explicit refresh) and document.

## Issue 4 — per-project sessions default to a flat 6 regardless of age
A project shows up to 6 sessions before "N more" (the row cap), but those 6 can span 2 days to 3
weeks — cluttering the sidebar with stale sessions. Sessions are already recency-sorted
(app.js:521,733). Wanted: default the visible set to a RECENCY WINDOW (only sessions within the
last N) AND keep the ≤6 cap — so an inactive project collapses to few/none by default and only
genuinely-recent sessions stay in view; older ones fold under "N more" (existing affordance).
- Pick a sensible default window (candidates: 24h / 3d / 1 week — agent chooses, ~1 week is a
  reasonable default that keeps a normal week's work visible) AND expose it as a user setting
  (Appearance/sidebar settings) if cheap; otherwise a well-chosen constant + note the setting as a
  follow-up.
- Pins/active/attention sessions always stay visible regardless of the window (existing pin logic).

## Verification (§C)
Playwright/happy-dom: projects render recency-desc by default; the sort toggle flips to alpha and
back (must FAIL pre-fix: name-only order, no toggle). Sessions: a project with sessions spanning
weeks shows only those within the window (≤6) by default, older under "N more"; a pinned/active
old session stays visible (must FAIL pre-fix: flat 6 regardless of age). Anti-regressions:
verify:ui, verify:attention, verify:sidebar/tree specs if any, typecheck, leak-gate.

## Activity log (APPEND-ONLY)
### 2026-08-13 — orchestrator
- Filed from user report. Client-only (app.js/styles) → reaches users on reload, no deploy.
  Read app.js:177's recency-rejection rationale before implementing issue 3.

### 2026-08-13 — worker (fix + §C)
- Reconciled with app.js:177: that rationale rejected auto-EXPAND by recency (it rebuilt the
  wall-of-sessions the cap prevents) — a DIFFERENT concern from ordering, but it names the real risk
  here: reorder-churn/jitter as an active project shuffles to the top under the user. Resolution per
  the user's offer: recency is the default, an alpha toggle is one click away, and the order is
  CAPTURED stable within a session (`state.projOrder`), re-sorted only on an explicit refresh
  (loadProjects) or a sort flip — never on a plain render. So a background lastActivityAt bump does
  not reshuffle the sidebar mid-work; it re-sorts when asked.
- Issue 3 (public/app.js + index.html + styles.css): `state.projSort` ('recency'|'alpha',
  persisted to localStorage `cs.projSort`, default recency) + `resortProjects()`/`orderedProjects()`
  (a project that appeared since the last capture floats to the front by the live sort, so a new one
  is never lost at the end). `renderTree` now iterates `orderedProjects()`. A small low-chrome
  `#projSort` toggle in the sidebar head (`.sortbar`) flips recency↔alpha via `toggleProjSort` and
  names the active mode ("Recent"/"A–Z").
- Issue 4 (visibleSessions): the default per-project view is now a RECENCY WINDOW —
  `RECENT_WINDOW_DAYS = 7` (a documented constant; exposing it as an Appearance/sidebar setting is a
  cheap self-contained follow-up, noted here) — applied UNDER the existing ≤6 cap. A single
  recency-ordered pass keeps within-window sessions up to the cap and folds older ones under the
  existing "N more"; the first "N more" click lifts the window (`s.windowed=false`) and reveals them,
  re-armed on re-expand. Pinned sessions keep their always-on block; `isAlwaysVisible` (the open
  session + `isAttentionSession`, mirroring `unseenCount`'s 24h baseline) forces active/attention
  sessions in regardless of age, without spending the cap budget — so an old pinned/attention session
  never gets folded away.
- §C — scripts/verify-feat-070-sidebar.mjs (real app.js in happy-dom vs a real server; drives the
  real resortProjects/toggleProjSort/renderTree over controlled project + session state and asserts
  on the DOM the real tree produced):
  - PRE-FIX (renderTree reverted to raw `state.projects`; visibleSessions reverted to the flat
    slice — exports kept): 7 assertions FAILED — projects rendered in name order not recency and the
    flip-back did nothing; the attention-old session was cut by the flat 6, plain-old sessions
    cluttered the default view, and "N more" mis-counted. The invariants (alpha-order coincidence,
    labels, within-window recents, pinned-old, N-more-lift, ≤6 cap) stayed green pre AND post.
  - POST-FIX: 14/14 PASS (incl. the churn-stability regression: a background bump does not reshuffle;
    an explicit resort does).
- Anti-regressions all green: verify:ui (7/0), verify:attention (4/0), typecheck (0),
  leak-gate (PASS).
- Commit: FEAT-070: sidebar recency ordering (+alpha toggle) + recent-session window.
