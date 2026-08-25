# BUG-032 — scroll wheel doesn't scroll the sidebar (only dragging its scrollbar works)

- **Status:** VERIFIED
- **Area:** claude-station UI — sidebar scroll behavior
- **Reported:** 2026-08-06 by user ("scroll wheel doesnt work on sidebar, only works on the actual scroll bar")

## Symptom
Hovering the sidebar (project/session list) and using the mouse wheel does nothing; the sidebar
only scrolls by grabbing its scrollbar. Expected: wheel over the sidebar scrolls the sidebar.

## Root-cause candidates (investigate, don't assume)
A wheel handler with preventDefault swallowing the event (global or on a parent), the scroll
container not being the element under the cursor (inner element with overflow hidden / wrong
overflow-y on the wrapper), CSS `overscroll-behavior`/`pointer-events` interference, or a
full-page wheel listener (e.g. for the transcript) capturing sidebar wheel events. Reproduce in
a real browser first and identify the actual swallowing/misrouting site.

## Verification (REQUIRED, user-observable)
Real browser (Playwright): seed enough projects/sessions to overflow the sidebar; dispatch wheel
events over the sidebar → its scrollTop changes; wheel over the transcript still scrolls the
transcript (no regression); narrow-viewport behavior unaffected. Must FAIL pre-fix. verify:ui
--offline + typecheck.

## Activity log (APPEND-ONLY)
### 2026-08-06 — orchestrator
- Filed from live user report. FE lane (app.js/styles.css).

### 2026-08-06 — fix agent
- **Reproduced first**, real browser: Playwright + system Brave (`playwright.config.ts`,
  already wired), a scratch server on an OS-assigned free port, ~45 seeded
  projects (revealed via the "N inactive projects" toggle so the sidebar
  genuinely overflows), and `page.mouse.wheel()` (genuine synthetic wheel
  input over CDP, not a `scrollTop` assignment). Confirmed the symptom:
  hovering the sidebar and dispatching a wheel event left `#tree.scrollTop`
  at 0; manually setting `scrollTop` worked fine (the element IS scrollable).
- **Root cause**: `public/app.js` has NO wheel listeners anywhere (grepped —
  zero `addEventListener('wheel', ...)` in the whole file) and nothing calls
  `preventDefault()` on the wheel path (instrumented capture+bubble listeners
  on `window`/`document`/`body`/`#win`/`.side`/`#tree` — all show
  `defaultPrevented: false`). The actual cause is CSS: `public/styles.css`
  `.kids` (an expanded project's own session list) carried `overflow-y: auto;
  max-height: 52vh; overscroll-behavior: contain;`. `overscroll-behavior:
  contain` does not just suppress rubber-band bounce — it blocks wheel-scroll
  **chaining** to the ancestor scroller (`#tree`) outright, and it applies the
  instant the box is "at" its own scroll boundary, which for a short/empty
  `.kids` list (every freshly created project, `scrollHeight === clientHeight`)
  is true immediately. Since `.kids` renders directly under most of the
  sidebar's clickable area (each project shows its session list), a wheel
  event almost anywhere in the sidebar landed on a `.kids` element that
  consumed it and handed nothing up to `#tree` — nothing scrolled. Confirmed
  causally: temporarily overriding `.kids { overscroll-behavior: auto }` via
  `page.addStyleTag` in the repro restored scrolling with zero other changes;
  wheel over a plain `.proj` header (never covered by `.kids`) always worked,
  isolating the fault to `.kids` specifically. Dragging the native scrollbar
  thumb is a different input path (not wheel-based), which is why it kept
  working — exactly the user's reported split symptom.
- **Fix**: `public/styles.css:1950` — removed `overscroll-behavior: contain;`
  from `.kids`. Native chaining is restored: `.kids` still scrolls internally
  first while it has its own overflow (the comment's original "don't swallow
  the sidebar" goal is unaffected — that's enforced by `max-height: 52vh`,
  not by `overscroll-behavior`), and once `.kids` has no more scroll room,
  wheel input naturally continues on to `#tree`. No JS shim added — this was
  a CSS mis-structure, not a listener to work around.
- **Verified**: `scripts/qa/BUG-032-sidebar-scroll-wheel.spec.ts` (new,
  `npm run verify:bug-032-sidebar-wheel`), real Brave via Playwright, own
  scratch server/port, seeds 45 projects + 20 needs-you tickets:
  - PASS wheel over `.kids` (the exact root-cause element) scrolls `#tree`.
  - PASS wheel over the general sidebar body scrolls `#tree`.
  - PASS wheel over the transcript (`#scroll`) still scrolls the transcript,
    and does NOT move the sidebar (no regression).
  - PASS wheel over the Needs-You rail (`#railPanel`) still scrolls it,
    unaffected by the sidebar fix.
  - PASS narrow viewport (640px): `.kids` is `display:none` there (existing
    `@media (max-width:720px)` rule), so it never sat in the wheel hit-path —
    unaffected by construction.
  - **Non-vacuous, proven both ways**: ran the spec against the pre-fix CSS
    (`git stash push -- public/styles.css`, rerun, `git stash pop`) — it FAILS
    exactly at the root-cause assertion (`expect(treeAfter).toBeGreaterThan(0)`
    → received `0`). Ran again with the fix in place — PASSES.
  - `npm run verify:ui -- --offline` × 3 — 3/3 PASS each run (no regression
    to the existing DOM/session/transcript UI check).
  - `npm run typecheck` — clean (0 errors).
  - `node --check public/app.js` — OK (app.js untouched; only CSS changed for
    this fix).
  - Screenshots: `docs/bugs/assets/BUG-032-sidebar-scrolled.png` (sidebar
    scrolled via wheel, post-fix), `docs/bugs/assets/BUG-032-narrow-viewport.png`
    (narrow-viewport collapse, unaffected).
- **Files touched**: `public/styles.css` (fix, `.kids` rule), 
  `scripts/qa/BUG-032-sidebar-scroll-wheel.spec.ts` (new verification spec),
  `package.json` (new `verify:bug-032-sidebar-wheel` script), this ticket.
  `public/app.js` and `public/index.html` were NOT touched — no wheel
  listener existed to fix and no structural change was needed.
- Status: **VERIFIED**. Nothing open; no handoff needed.
