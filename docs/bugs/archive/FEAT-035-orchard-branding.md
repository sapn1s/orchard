# FEAT-035 — Orchard branding: logo / favicon / wordmark + tasteful dashboard UX touches (Fable-designed)

- **Status:** DONE — grafted-sapling mark + favicon + wordmark shipped (runtime text rename = FEAT-036)
- **Area:** claude-station UI / brand identity
- **Reported:** 2026-08-04 by user (renamed the product to "Orchard")

## Goal
Give the dashboard a distinctive, intentional visual identity as **"Orchard"** — an
SVG logo/mark, a favicon, a wordmark — and integrate it tastefully for a nicer UX.
The designing agent is the ARTIST: express freely, just stay coherent with the system.
(Product name = Orchard now; the repo/dir/service rename is separate — FEAT-036.)

## Design system (hard fences — keep it coherent)
- Greyscale + EXACTLY ONE moss/green accent (the existing `--live`). No new colours.
- Hairlines, calm, restrained, generous space. Serif for prose, mono for machine values.
- The "Orchard" concept — living / growing / tended (orchestrate → orchard) — fits the
  moss + `--live` ("alive") language. A tree / branch / leaf / orchard-row / sprout motif
  in moss on greyscale. Minimal + elegant, NOT busy or templated (read the
  `frontend-design` skill first — avoid default-look marks).

## Deliverables
- `public/favicon.svg` — Orchard mark (replaces the current dark-window+dot mark).
- An SVG logo/mark + wordmark integrated into the dashboard header + the `<title>`.
- Optional tasteful touches where they genuinely help (empty states / the "nothing
  needs you" rail / a loading moment) — restrained, don't over-decorate.

## Constraints / integration
- SURVEY the current UI first (index.html, styles.css, existing favicon.svg) to match.
- Put the mark in `public/index.html` + `public/styles.css` + new SVG asset files.
  **Do NOT touch `public/app.js`** (a sibling agent owns it) — if a JS render is truly
  needed, note it as a handoff instead.
- Verify it renders (capture a screenshot of the header + favicon), `verify:ui --offline`,
  `typecheck`. Never touch :4317; no commit.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed + dispatched to a Fable agent with creative latitude. Rename refactor = FEAT-036.

### 2026-08-04 — Fable (designer)
- **The mark:** a grafted sapling drawn in the app's own grammar — a hairline stem
  rising from a short ground line (the orchard *row*: planted, tended, not wild),
  one branch reaching, and the moss `--live` dot as the bud at its tip. The apex
  is left bare: still growing. It is literally the product — the session tree with
  one thing running. The favicon keeps the old mark's grammar (dark tile, grey
  strokes, single moss dot) so the tab reads as the same app, evolved: the
  window's rows became a living stem.
- **Wordmark:** "Orchard" in the existing serif (Charter), 14.5px/500, in the
  sidebar's top chrome next to the inline mark (currentColor strokes + `var(--live)`
  bud, so it follows the theme). Sidebar chrome regrouped: brand left, the three
  icons right. Collapsed sidebar shows the mark alone, centered.
- **One restrained touch:** the rail's "nothing needs you" ✓ is now a small moss
  leaf (pure CSS mask over the glyph app.js renders — no JS change; the ✓ stays
  in the accessibility tree).
- Files: `public/favicon.svg` (rewritten), `public/index.html` (brand markup,
  `<title>Orchard</title>`, h1 initial text), `public/styles.css` (`.brand`,
  collapsed rules, `.rail-empty .ok` leaf, header comment).
- Screenshots: `docs/bugs/assets/FEAT-035-header-light.png`, `-header-dark.png`,
  `-collapsed-dark.png`, `-rail-empty.png`, `-favicon-sizes.png` (16/32/64/128 —
  reads at 16). Real server + headless Brave/CDP on a free port; killed by pid.
- Verified: `verify:ui --offline` 3/3 PASS, `typecheck` PASS. No commit.
- **HANDOFF (app.js — sibling-owned, not touched):** app.js still says
  "Claude Station" at runtime: `document.title` template (~line 5363), the h1
  fallback (~line 2391), and the boot hint copy. Needs the FEAT-036 rename pass.
