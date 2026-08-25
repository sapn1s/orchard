```orchard-ticket
{
  "id": "FEAT-054",
  "type": "feature",
  "title": "Status chips opened settings without landing on their section",
  "summary": "Clicking a status chip used to open the settings panel at the top, leaving people to hunt for the setting the chip named. Chips now open the panel on their own section, expanding it for the visit, scrolling it into view and flashing it once. Reduced-motion users get a static outline instead.",
  "impact_if_we_wait": "None outstanding; the navigation shipped and the collapse preferences people set are left untouched. Bounded from the start: this was a navigation convenience, never a correctness or data problem.",
  "current_need": "Nothing is outstanding. The interface and toggle suites both ran clean alongside standing type checks after the chip navigation landed.",
  "severity": "low",
  "area": "Settings panel navigation",
  "reported": "2026-08-09",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-11",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Clicking each chip opens the settings panel scrolled to the section that chip names",
    "A section collapsed by default expands for the visit only",
    "The section flashes once and returns to its normal appearance",
    "Collapse preferences are unchanged after the panel is closed",
    "Reduced-motion users see a static outline rather than a flash",
    "Opening settings from the gear button still lands at the default position"
  ],
  "code_refs": [
    {
      "path": "public/lib/drawer.js",
      "symbol": "section()",
      "note": "sections gained stable ids so a focus target can address them"
    },
    {
      "path": "public/lib/drawer.js",
      "symbol": "drawer.open",
      "note": "accepts a focus target, e.g. open('settings', {focus:'git'}) — one seam instead of per-chip scrolling"
    },
    {
      "path": "public/lib/drawer.js",
      "symbol": "d.sectClosed",
      "note": "remembered collapse state; a focus target expands ephemerally rather than rewriting it"
    }
  ],
  "related": [
    {
      "id": "BUG-036",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-042",
      "relation": "see_also"
    },
    {
      "id": "FEAT-051",
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
    "archived_path": "docs/bugs/archive/FEAT-054-crown-chips-deep-link.md",
    "sha256": "567b388782c6040507e6fba16d348bcb604b0c002cd312b8be9998dad9e3ef98",
    "bytes": 7603,
    "original_title": "crown/topbar chips deep-link to their drawer section (scroll + brief highlight)",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Read against the original head: the chip-to-section mapping, the single focus seam, the ephemeral expand, the one-shot flash and the reduced-motion and keyboard paths are all present.",
    "dropped": [
      "the verbatim wording of the user's original request, which the summary and diagnosis carry",
      "the parenthetical example chip labels such as the git and processes chip text"
    ]
  }
}
```

# FEAT-054 — Status chips opened settings without landing on their section

## Diagnosis

Every chip in the crown row — isolation, instructions, git, processes, the permission line and the mount pills — called the drawer open at its default position. The chip already knew which section it referred to, and that intent was thrown away at the call site.

## Evidence

Before the change every chip landed at the top of the drawer. Git and Running-here sit under Advanced, which is collapsed by default, so those two chips left the target section not merely unscrolled but hidden.

## Implementation notes

The mapping is: isolation chip to Isolation & environment; instructions chip to the Instructions group; git chip to Advanced then Git; processes chip to Advanced then Running here; the permission line to Model & behaviour then Permission mode; mount pills to Access then Mounts. The model chip is unchanged because it opens the model picker. Integration chips join the same mapping when they are built. Focus moves to the section itself, via scroll plus a `tabindex=-1` focus if needed, so the navigation works from the keyboard. The highlight is a one-shot animation of roughly a second, with a static outline under `prefers-reduced-motion`.

## Verification plan

In a real browser, click each chip and assert the mapped section is expanded, inside the viewport, and carries the highlight class which then clears. Confirm the collapsed-by-default Advanced sections expand for git and processes, and that collapse preferences survive closing the drawer. Assert the reduced-motion path. The check must fail before the change, since every chip lands at the top. The plain gear button must still open at the default position. `verify:ui --offline` was gated on BUG-036 restoring it.

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
