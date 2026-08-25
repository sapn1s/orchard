```orchard-ticket
{
  "id": "FEAT-069",
  "type": "feature",
  "title": "Long picker lists could not be narrowed by typing",
  "summary": "The add-project picker now has a filter box that narrows the list as you type, in both the suggestions view and the folder-browsing view. Before this, a long list of candidate folders or projects could only be scrolled. The filter also supports keyboard selection and clearing back to the full list.",
  "impact_if_we_wait": "Finding a project among many candidates stays a manual scroll. Bounded: this is picker convenience only, nothing is added or removed incorrectly, and the existing scan and browse toggle and direct-path entry keep working.",
  "current_need": "Nothing is outstanding. The filtering case was shown failing with the client changes removed, then passing after them, with standing checks clean.",
  "severity": "low",
  "area": "Add-project picker",
  "reported": "2026-08-13",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-13",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Typing a substring leaves only matching rows, case-insensitively, in both suggestions and browse modes",
    "Clearing the filter restores the full list",
    "Enter adds the highlighted row, or the sole remaining match",
    "Up and down arrows move the highlighted row; Escape closes the picker",
    "A list with no matches shows a quiet no-match hint",
    "The scan and browse toggle and direct-path entry keep working"
  ],
  "code_refs": [
    {
      "path": "app.js",
      "symbol": "#addProjBtn",
      "note": "opens the picker"
    },
    {
      "path": "app.js",
      "symbol": "node.picker",
      "note": "renders the suggestions list and the browse-folders view, around lines 7869-7937"
    },
    {
      "path": "app.js",
      "symbol": "#pickMode",
      "note": "the scan/browse toggle the filter had to keep working"
    }
  ],
  "related": [],
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
    "archived_path": "docs/bugs/archive/FEAT-069-add-project-search-filter.md",
    "sha256": "7421d850490a4eaa8147b5c975255e40daf76e546536b0351446f26ed0f68e12",
    "bytes": 3897,
    "original_title": "add-project picker needs a search/filter box for the suggestions/folder list",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head section by section: the symptom, all five wanted behaviours, the keyboard rules and the §C verification bar are present above.",
    "dropped": [
      "the verbatim reporter quote, whose content is carried by the summary and symptom"
    ]
  }
}
```

# FEAT-069 — Long picker lists could not be narrowed by typing

## Diagnosis

The picker rendered either a scan-suggestions list or a browse-folders list, with no input bound to either. There was no type-to-filter path at all, so the only way through a long list was scrolling.

## Evidence

With the client changes git-stashed, the filtering case produced 6 failures — the filter input did not exist. Typecheck and the leak gate reported clean. The suites named as anti-regressions in the plan (the add-project and UI suites, and the feature's own suite) are recorded as intended coverage; no result was logged against them here.

## Implementation notes

Requirements as filed: filter input at the top of the picker, live case-insensitive substring match on name or path, in both modes; focus the input on open; up/down moves a highlighted row; Enter adds the highlighted or sole remaining match; Escape closes through the existing ladder; empty filter shows the full list; no match shows a quiet hint. Styling reuses the existing finder/search input rather than introducing a new surface.

## Verification plan

Under Playwright/happy-dom: open the picker, type a substring, assert only matching rows remain — this must fail before the fix, since no filter input exists. Assert Enter adds the highlighted match and clearing restores the full list. Repeat in both scan and browse modes. Anti-regressions: the add-project suite, the UI suite, typecheck and the leak gate.

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
