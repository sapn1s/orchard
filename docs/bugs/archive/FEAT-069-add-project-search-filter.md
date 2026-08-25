# FEAT-069 — add-project picker needs a search/filter box for the suggestions/folder list

- **Status:** VERIFIED
- **Area:** FE add-project picker (app.js #addProjBtn / node.picker)
- **Reported:** 2026-08-13 by user:
  > "add project option, its usually a list of recommendations or folder selector, but missing
  > search option to find dir/proj name in the list"

## Symptom
The add-project picker (`#addProjBtn` → `node.picker`, app.js ~:7869-7937) shows a `scan`
suggestions list (project-name recommendations) or a browse-folders view, but there is no way to
type-to-filter the list. With many candidate dirs/projects it's a long scroll with no search.

## Wanted
1. A filter/search input at the top of the picker that live-filters the visible rows by name/path
   substring (case-insensitive) as you type — in BOTH modes (suggestions and browse-folders).
2. Keyboard: focus the filter on open; up/down moves a highlighted row; Enter adds the highlighted
   (or the sole remaining) match; Esc closes (existing Esc ladder).
3. Empty filter shows the full list (today's behavior). No match → a quiet "no match" hint.
4. Keep the existing scan/browse toggle (`#pickMode`) and the direct-path entry working.
5. Restraint: reuse the existing finder/search input styling; it's a filter, not a new surface.

## Verification (§C)
Playwright/happy-dom: open picker → type a substring → only matching rows remain (must FAIL
pre-fix: no filter input exists); Enter adds the highlighted match; clearing restores the full
list; works in both scan and browse modes. Anti-regressions: verify:addproject, verify:ui,
typecheck, leak-gate.

## Activity log (APPEND-ONLY)
### 2026-08-13 — orchestrator
- Filed from user report. Client-only (app.js/styles) → reaches users on reload, no deploy.

### 2026-08-13 — worker (FEAT-069 lane)
- Implemented. A `#pickFilter` search input sits between the picker's `<h4>` and
  `#pickList` (index.html ~:211), styled by a new `.pop .pfilter` rule that mirrors
  the sidebar finder input's look (styles.css) — reused surface, not a new one.
- app.js: `openPicker()` clears + focuses the filter on open. Every actionable
  candidate row (scan `.prow`, browse `.prow.dir`) carries `data-filter` = `name +
  path` lowercased; nav rows (here / "..") deliberately have none so they stay put.
  `applyPickFilter()` (fired on `input`, and re-run at the end of both paint
  functions) hides non-matching rows case-insensitively, drops a quiet
  `.pick-nomatch` hint when a non-empty query matches nothing, and pre-highlights
  the first/sole match. Filter keydown: ↑/↓ walk the visible set (`setPickHi`,
  `.prow.hi` = `--sunken`), Enter `.click()`s the highlighted/sole row (adds in
  scan, descends in browse), Esc falls through to the document Esc ladder. Mode
  toggle and directory navigation reset the filter so fresh contents show. The
  scan/browse toggle and the separate `#pickPath` direct-path Enter are untouched.
- VERIFY §C — new scripts/verify-feat-069-add-project-filter.mjs (+ `verify:feat069`).
  Scratch server on a free ephemeral port + scratch dataDir, headless brave scratch
  profile, killed by pid; never touched :4317.
  - Pre-fix (client changes git-stashed): 6 FAIL (no #pickFilter, no focus, no
    narrowing, no hint) then FATAL on the null input — must-FAIL proven.
  - Post-fix: 9 passed, 0 failed — filter present + focused on open; scan substring
    narrows to matches only (108→1) with the sole match highlighted; no-match hint +
    all rows hidden; clear restores (→108); Enter registers the sole match
    (server-cross-checked); browse mode narrows identically (22→1) and Enter descends
    into the needle dir.
  - Anti-regressions: verify:addproject 7/0, verify:ui 7/0, typecheck clean,
    leak-gate PASS (0 hits / 341 files).
- Status VERIFIED. Client-only → reaches users on reload, no deploy.
