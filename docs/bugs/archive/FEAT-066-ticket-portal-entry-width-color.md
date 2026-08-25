# FEAT-066 — ticket portal: reachable from the UI, real width, and readable color hierarchy

- **Status:** VERIFIED / DONE (2026-08-12) — topbar+rail board entries, wide two-zone detail, restrained status color language; suites green, must-FAILs proven, screenshots landed. Client-only (public/*) → reaches users on plain reload, no deploy.
- **Area:** FE (app.js/styles) — ticket portal (FEAT-063 follow-up)
- **Reported:** 2026-08-12 by user:
  > "no option to open it from anywhere in ui unless we have ticket link or manual url"
  > "it could utilize more width … currently its all one column makes the whole thing extremely long"
  > "ik we have minimal colors in our main interface, but ticket system might use some coloring …
  > currently visually hard to read ALL INFO IS LIKE ONE GREY column"

## Wanted
1. **Entry points:** a persistent affordance to open #/tickets — at minimum a topbar item (near
   the crown/chips) visible in every project with a board; plausibly also from the board rail
   header ("open board →"). Deep links keep working; back returns to where you were.
2. **Width:** the portal should use the viewport. List: the table already spans, keep it. Detail:
   two-zone layout on wide screens — metadata/summary sidebar (or top strip becoming a right
   sidebar) + main content column for description/activity; activity entries can wrap into the
   full width. One column remains acceptable below ~900px.
3. **Color (restrained, purposeful — not a theme change):** status gets a small color language
   (open=neutral, in-progress/🤖=blue-ish, needs-you=amber, verified/done=green, high-sev=red
   accent) applied to the status/sev tags and detail state badge; section headings in the detail
   view get visual weight (size/spacing, hairline separators); activity-log entry headers
   distinguished from body text. Respect the existing palette philosophy: tint the TAGS, not the
   page — the main interface's minimalism stays.

## Verification (§C)
Playwright: topbar entry visible + navigates to #/tickets and back (must FAIL pre-fix: no such
element); wide-viewport detail renders two zones (layout assertion) vs narrow one-column; status
tags carry distinct computed colors per class (open vs needs-you vs done differ; must FAIL
pre-fix: identical grey). Screenshots into docs/bugs/assets/ (before/after, list + detail, wide +
narrow). Anti-regressions: verify:tickets 29/29, verify:feat-063-tracker, verify:feat-053-rail
(modal reuse), verify:ui, typecheck, leak-gate.

## Activity log (APPEND-ONLY)
### 2026-08-12 — orchestrator
- Filed from user feedback on the FEAT-063 revamp — structure landed, but it's unreachable,
  needlessly narrow, and tonally flat. Dispatching FE worker.

### 2026-08-12 — FE worker (built + verified)
- **Read** frontend-design skill first; held the brief's restraint — TINT THE TAGS, not the page.
  Greyscale+moss minimalism of the main interface is untouched; every colour lives on ticket
  tags/badges only, and is a palette-derived token, dark-theme aware.
- **(1) Entry points — reachable from anywhere.** Two persistent affordances, shown ONLY when the
  current project has a board (opt-in; no docs/bugs/ → no dead link):
  - `#boardBtn` — a plain nav pill in the crown chips (`public/index.html` seal), "▤ Board <open>",
    the open count (needs+queued+in-flight) a quiet mono cue.
  - `#railBoardLink` — "Open board →" in the rail-head (the rail is "now", this opens the archive).
  Both call `navTickets(pid, null)` (pushState) so BACK returns to the session view exactly as it
  was — the ticket route is a cover, never a teardown. Both keep ctrl/cmd-click new-tab (real href).
  Wired in `paintBoardEntry(b)` off `renderRail()` — `public/app.js`.
- **(2) Width — two-zone wide detail.** `#tvDetail .tv-doc:not(.tv-new)` becomes a CSS grid at
  ≥900px: a full-width content column (title/document/activity/note-form, max 1180px) + a metadata
  SIDEBAR on the right (left-hairline, stacked k/v, sticky). Below 900px the block is inert and the
  base single-column stacking (metadata strip on top) holds. Scoped to the route detail — the
  FEAT-053 compact modal and the new-ticket form keep their single column. Activity entries wrap
  into the full content width. `public/styles.css`.
- **(3) Colour — a small status language + hierarchy.** `ticketStatusKind(t)` → open (neutral) /
  needs (amber) / prog (blue) / done (green); high-sev → brick-red accent. Applied to the list
  `.c-status` tag, the detail state `.d-badge`, and the status word — text + hairline (+ faint wash
  on the badge), never a filled pill. Tokens `--st-prog/-needs/-done/-high` defined in all three
  theme blocks (light / prefers-dark / explicit dark+light); the old hardcoded `#B0703C` sev colour
  folded into `--st-high`. Section headings got weight + hairline separators; the activity-entry
  headers stay mono/bordered/distinct from body. `public/app.js` + `public/styles.css`.
- **Verified** (scratch servers on OS-assigned free ports, headless Chromium, killed by pid, never
  :4317):
  - NEW `verify:feat-066` (`scripts/qa/FEAT-066-portal-entry-width-color.spec.ts`) — 3/3 PASS:
    (1) topbar pill visible→opens #/tickets→Back returns + rail link present; (2) wide detail = meta
    sidebar RIGHT of content, narrow = one column stacked; (3) open/needs/prog/done status tags
    compute 4 DISTINCT colours + tinted Done badge.
  - **Proven MUST-FAIL pre-fix:** with `public/*` + `package.json` `git stash`ed, all 3 fail
    outright (no `#boardBtn`; sidebar not beside content at wide; the 4 status tags one identical
    grey) → restored → 3/3 PASS.
  - Anti-regressions: `verify:tickets` 30/30 · `verify:feat-063-tracker` 1/1 · `verify:feat-053-rail`
    1/1 (modal reuse intact) · `verify:ui` 7/7 · `typecheck` clean · `leak-gate` PASS.
- **Screenshots** (`docs/bugs/assets/`): before/after pairs —
  `FEAT-066-before-session.png`/`-after-session.png` (no entry → Board pill + rail link),
  `FEAT-066-before-list.png`/`-after-list.png` (flat grey → status colour language),
  `FEAT-066-before-detail-wide.png`/`-after-detail-wide.png` (one 820px column → two zones),
  `FEAT-066-before-detail-narrow.png`/`-after-detail-narrow.png` (one column preserved <900px).
  Spec's own: `FEAT-066-list.png`, `FEAT-066-detail-wide.png`, `FEAT-066-detail-narrow.png`.
- Client-only change (`public/app.js` · `public/styles.css` · `public/index.html`) → reaches users
  on a plain browser reload; NO server deploy needed. Status → VERIFIED / DONE per the honesty rule.
