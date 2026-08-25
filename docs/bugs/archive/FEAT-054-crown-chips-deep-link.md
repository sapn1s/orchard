# FEAT-054 — crown/topbar chips deep-link to their drawer section (scroll + brief highlight)

- **Status:** VERIFIED (2026-08-11) — drawer.open focus seam, ephemeral expand, one-shot flash + reduced-motion fallback.
- **Area:** claude-station UI — crown chips ↔ settings drawer navigation
- **Reported:** 2026-08-09 by user ("if I click on processes it opens the sidebar, just like
  everything else, instead it would be nice if it also scrolls/navigates to the specific section
  and highlights it briefly")

## Symptom / gap
Every crown chip — isolation (`○ Direct`), instructions (`▤ CLAUDE.md only`), git
(`⎇ main · 21 dirty · ↑96`), processes (`▸ :4317 … · 7 procs`), permission line, mount pills —
opens the settings drawer at its default position. The user then has to hunt for the section the
chip was about. The chip already knows exactly which section it means; that intent is discarded.

## Goal
Clicking a chip opens the drawer AND lands on the section it names: expand the section if
collapsed (Advanced is collapsed by default — Git and Running-here live there), scroll it into
view, and give it a BRIEF highlight so the eye lands (a short one-shot flash, then back to
normal — never a persistent selected state).

Mapping (from the surface audit / drawer map): isolation chip → Isolation & environment ·
instructions chip → Instructions group (or the Instructions view) · git chip → Advanced ▸ Git ·
processes chip → Advanced ▸ Running here · permission line → Model & behaviour ▸ Permission mode ·
mount pills → Access ▸ Mounts · model chip stays as-is (FEAT-042 opens the /model picker) ·
integrations chips (FEAT-051, when built) → Instructions & tools ▸ Integrations.

## Implementation notes
- `drawer.open('settings')` should accept a target (e.g. `drawer.open('settings', {focus:'git'})`)
  — one seam, not per-chip ad-hoc scrolling. Section ids/anchors already exist implicitly via
  `section()` in `public/lib/drawer.js`; give them stable ids.
- Respect the remembered open/closed state (`d.sectClosed`): a focus target may expand a section
  for this visit; do not permanently rewrite the user's collapse preferences.
- Highlight: a brief CSS animation (hairline/moss, ~1s, one-shot). Honor
  `prefers-reduced-motion` — fall back to a static brief outline, not a flash.
- Keyboard/a11y: the focused section should receive focus (or `scrollIntoView` + `tabindex=-1`
  focus) so it also works without a pointer.

## Verification (REQUIRED, user-observable)
Real browser: for EACH chip listed above, clicking it opens the drawer with the mapped section
expanded, scrolled into view (assert the section is in the viewport), and briefly highlighted
(assert the class/animation applies then clears). Collapsed-by-default Advanced sections expand
for git/processes. The user's collapse preferences are unchanged after closing the drawer.
`prefers-reduced-motion` path asserted. Must FAIL pre-change (today every chip lands at the top).
verify:ui --offline (once BUG-036 restores it) + typecheck + a Playwright spec; no regression to
plain `#cogBtn` open (lands at default position).

## Activity log (APPEND-ONLY)
### 2026-08-09 — orchestrator
- Filed from user report. Batch candidate with FEAT-051 (chips) / FEAT-053 (rail) / BUG-034 —
  same files; one coherent UI pass is likely cheaper and safer than four.

### 2026-08-11 — build agent (UI batch with FEAT-053 + FEAT-051) — built + verified
- **Changed:**
  - `public/lib/drawer.js` — THE ONE SEAM: `open(view, {focus:'git'})` (second arg may be
    the options object; a string stays `from`). `d.focus = {key, applied, at}` drives
    `applyFocus()` at the end of every `paint()`: resolves `[data-focus=<key>]` (group
    anchors) else `details[data-sect=<key>]` (sections now carry stable ids), expands every
    collapsed ancestor `details.sect` with a one-shot `ephemeralOpen` marker the toggle
    listener consumes WITHOUT recording — so a deep link never rewrites `d.sectClosed`
    (the user's collapse choices) — then scrolls into view (`smooth`, or `auto` under
    `prefers-reduced-motion`), gives the target `tabindex=-1` focus (keyboard/a11y), and
    applies a `.focus-flash` class time-bounded to ~1.4s. Because async fetches (git
    status, processes) repaint and REPLACE the flashed node, repaints within the window
    re-apply expansion + the flash REMAINDER and re-land the scroll — one visual flash,
    robust to repaints, never persistent. Cleared on close and on any focus-less open, so
    the plain cog lands at the default top. Anchors added: perms grp `permissionMode`,
    runtime grp `iso`, Access grp `mounts`, Instructions grp `instructions`, Integrations
    grp `integrations`, Git grp `git`, Running-here grp `processes`.
  - `public/app.js` — the chip wiring per the mapping table: git chip → `{focus:'git'}`,
    processes chip → `{focus:'processes'}`, seal permission chip (now role=button) AND the
    composer `#permLine` hairline → `{focus:'permissionMode'}`, mount pills (click, not
    their ×) + "+ Add mount" → `{focus:'mounts'}`, isolation popover's "Project settings"
    footer → `{focus:'iso'}` (the iso CHIP itself keeps its popover — that popover is the
    richer surface and its settings footer is the drawer path; deviation noted openly),
    FEAT-051 integration chips → `{focus:'integrations'}`. `#insBtn` unchanged: it already
    opens the Instructions VIEW, which this ticket's mapping explicitly allows. Model chip
    untouched (FEAT-042 picker).
  - `public/styles.css` — `.focus-flash` one-shot keyframe (hairline + moss, ~1.1s);
    `@media (prefers-reduced-motion: reduce)` replaces it with a static brief outline
    (same class lifecycle, so it still clears); pointer affordances on the perm chip/line.
- **Verified** — NEW `scripts/qa/FEAT-054-chip-deep-link.spec.ts` PASS (real scratch server,
  container-isolation project with a mount, a real git repo, a real process cwd'd in the
  project so the proc chip renders): for git/processes the collapsed-by-default Advanced
  section EXPANDS and the group is in-viewport with the flash applying then CLEARING; perm
  chip + permLine land on Permissions; mount pill on Access▸Mounts; popover footer on
  Isolation; PREFS PRESERVED — after a deep link expanded Advanced, a plain cog open shows
  Advanced collapsed again AND a section the user closed by hand (`instr`) stays closed
  across a later deep link elsewhere; plain cog open flashes NOTHING (no regression);
  reduced-motion emulation asserts `animation-name: none` + a real outline, still one-shot;
  the model chip still opens the /model picker, drawer closed.
  **Proven MUST-FAIL-PRE-CHANGE** (batch files stashed → no anchors/no flash → fails).
  Anti-regressions: `verify:ui -- --offline` 3/3 · `typecheck` clean · full drawer suites
  (`verify:tool-toggle` 13/13) green.
  Screenshots: `docs/bugs/assets/FEAT-054-git-landed.png`, `FEAT-054-reduced-motion.png`.
- **package.json entry for the orchestrator to add:**
  `"verify:feat-054-deeplink": "playwright test scripts/qa/FEAT-054-chip-deep-link.spec.ts"`
- **Closing assessment:** goal met via one seam, not per-chip scrolling; collapse
  preferences provably survive; reduced-motion honored. One open mapping judgment, stated:
  the isolation CHIP still opens its popover (deliberate — the popover carries the actual
  isolation actions); its settings footer carries the deep link. If the user wants the chip
  itself to skip the popover, it is a one-line change at `#isoBtn`.
