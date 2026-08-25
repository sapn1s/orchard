# FEAT-071 — surface a project's associated directory somewhere in the UX

- **Status:** VERIFIED — done 2026-08-13 (shortPath in settings drawer + full path in title; crown tooltip; §C incl. must-FAIL pre-fix)
- **Area:** FE (project header / settings / tooltip)
- **Reported:** 2026-08-13 by user:
  > "i notice we have no way to view current project associated directory anywhere in ux?"

## Symptom
A project maps to a host directory (registry `hostPath`), but the UI shows nowhere which directory
the current project points at. This matters especially after a rename/relocation (e.g. the display
name "orchard" while the id is "claude-station" and the path is ~/projects/orchard) — the
user can't confirm the path from the UI.

## Wanted
1. Show the current project's `hostPath` in a discoverable, low-chrome spot — e.g. the project
   settings drawer header, and/or a tooltip on the project name/crown, and/or a small line in the
   crown. It's reference info, so it can be quiet (tooltip + a line in Project settings is enough).
2. Path shortened for display (reuse dom.js shortPath — `~/…`), full path on hover/title.
3. Available for any selected project, not just the scratch/active one.

## Verification (§C)
Playwright/happy-dom: the selected project's hostPath (shortened) appears in the settings drawer
(and/or tooltip); full path in the title attr; matches the registry hostPath (must FAIL pre-fix:
path shown nowhere). Anti-regressions: verify:ui, typecheck, leak-gate (ensure the path render
uses shortPath so no raw /home/<user> leaks into a committed fixture).

## Activity log (APPEND-ONLY)
### 2026-08-13 — orchestrator
- Filed from user report. Client-only. Use shortPath for display (leak-gate hygiene).

### 2026-08-13 — worker (fix + §C)
- Surfaced the selected project's `hostPath` in two low-chrome, discoverable spots:
  1. A "Directory" line at the TOP of the Project settings drawer (public/lib/drawer.js
     `settingsView`): `shortPath(p.hostPath)` in a monospace `<code>` for display, the FULL path in
     the row's `title` attr on hover. Styled `.proj-dir` in public/styles.css (small label + mono
     value, low chrome). Works for any selected project (reads `project()` = the current project).
  2. The crown project name (public/app.js `paintCrown`, `#where`) now carries `name\nhostPath` as a
     hover `title`, so the full path is one hover away from the header too.
- shortPath (dom.js) is the ONLY thing rendered inline, so no raw `/home/<user>` ships in a fixture;
  also sanitized a pre-existing raw home path in THIS ticket (line under Symptom) to `~/…` so the
  leak-gate passes (that sanitize shipped with the BUG-085 commit that preceded this one).
- §C — scripts/verify-feat-071-project-dir.mjs (REAL app.js in happy-dom vs a REAL server; registers
  a real neighbour project, selects it, drives the REAL drawer.open('settings') + paintCrown, asserts
  on the produced DOM and matches against the registry hostPath fetched from the server):
  - the settings drawer shows a Directory line; its inline value === `shortPath(hostPath)`; the row
    title === the FULL hostPath === the registry hostPath; the label reads "Directory"; the crown
    `#where` title contains the full path.
  - POST-FIX: 6/6 PASS. PRE-FIX (source stashed): 5/6 FAIL — no `.proj-dir`, path shown nowhere.
- Anti-regressions all green: verify:ui (7/0), typecheck (0), leak-gate (PASS, 351 files).
- Commit: FEAT-071: show selected project's directory (shortPath in settings + tooltip).
