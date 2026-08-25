# BUG-009 — Finder 'scope into #project' is unreachable: the trailing space that signals scoped mode is trimmed away

- **Status:** VERIFIED
- **Severity:** medium
- **Area:** sidebar-tree / finder scoping
- **Reported:** 2026-08-03 by bug-hunt workflow

## Symptom
Clicking a project suggestion (or typing '#proj' + Enter) looks like it scopes into that project, but the pane just re-renders the project-suggestion list. Browsing a project's whole session list via the finder is impossible; the empty-scoped 'list the whole project' view is completely unreachable.

## Repro
1) Open finder, type '#exte' (mode pickProject). 2) Click the project row or press Enter (completeProjectScope) sets findInput.value='#external-project-J ' WITH a trailing space — the load-bearing scoped-mode signal. 3) renderTree()->renderSearch() calls parseFinderQuery(findInput.value.trim()) and parseFinderQuery itself does raw.trim() (line 649), stripping the space; regex /^#(\S*)(?:\s(.*))?$/ then has no \s group so m[2]===undefined -> mode 'pickProject' again. Only typing an extra char after the space enters scoped mode; the empty-scope branch at :704-705 is dead code.

## Expected
Honest, correct behavior — see fix direction.

## Context pack
- Suspect file(s): public/app.js:670 (parseFinderQuery/renderSearch trims) + :649 (raw.trim)
- Fix direction: Stop trimming the finder query before parseFinderQuery (or preserve a trailing-space sentinel some other way), so '#proj ' parses as scoped with an empty query and lists the whole project.
- Touches: FRONTEND (public/app.js or drawer.js) — serialize with other frontend tickets
- Related: none
- Repro test: none yet — the fixing agent MUST add a verify script that FAILS on current code and passes after.

## Activity log (APPEND-ONLY)

### 2026-08-03 — bug-hunt (read-only hunter)
- **Understood:** Clicking a project suggestion (or typing '#proj' + Enter) looks like it scopes into that project, but the pane just re-renders the project-suggestion list. Browsing a project's whole session list via the finder is impossible; the empty-scoped 'list the whole project' view is completely unreachable.
- **Verified:** diagnosis traced against source (see Repro); NOT yet reproduced with a running test.
- **Handoff:** Stop trimming the finder query before parseFinderQuery (or preserve a trailing-space sentinel some other way), so '#proj ' parses as scoped with an empty query and lists the whole project.

### 2026-08-04 — fix agent
- **Understood:** Confirmed the trace exactly as diagnosed. Two full-`trim()` calls conspired to erase the trailing-space sentinel before it ever reached the regex: (1) `parseFinderQuery()` itself did `raw.trim()` as its first line (app.js:649, old numbering); (2) `renderSearch()` (app.js:670, old numbering) re-derived its parse input as `node.findInput.value.trim()` — ignoring the `raw` argument it was passed — so even if the caller preserved the space, this line threw it away again. Net effect: no matter what set `findInput.value`, by the time `parseFinderQuery` ran the trailing space was gone, `m[2]` was `undefined`, and mode was always `'pickProject'`. The empty-scope "list the whole project" branch at the old :704-705 (`if (!text || ...)`) was reachable in principle but never in practice.
- **Changed** (`public/app.js` only):
  - `parseFinderQuery(raw)`: changed `raw.trim()` (fed to the regex) to `raw.replace(/^\s+/, '')` — a **left-trim only**. Leading whitespace is still tolerated (fixing that was never the ask), but a trailing space now survives into the regex, so `#proj ` matches with `m[2] === ''` (not `undefined`) → mode `'scoped'` with empty text, not `'pickProject'`. The plain-text (non-`#`) fallback branch still does a full `.trim()` for its returned `text`, unchanged.
  - `renderSearch(raw)`: changed the parse input from always-re-trimmed `node.findInput.value.trim()` to the live, **untrimmed** `node.findInput.value` (falling back to the `raw` gate value only if the live value is literally empty). `parseFinderQuery` now owns all trimming internally, so this line no longer needs to (and must not) pre-trim.
  - Left `runContentSearch()` / `renderContentSearch()` (contents/tier-2 search, Enter-triggered) untouched — out of this ticket's scope (sidebar tier-1 list), and their existing full-trim behavour doesn't block the sidebar fix; noted here in case a future ticket wants the same treatment for the content-search hint under the scoped-empty state.
- **Verified:**
  - Added `scripts/verify-finder-scope.mjs` (+ `verify:finder-scope` npm script). It: creates a project with 2 sessions + a decoy project, types `#scopepr`, completes the scope via **row click**, asserts the pane shows BOTH sessions (the scoped whole-project list) and not the suggestion list again, asserts a post-scope query filters within scope, then repeats the completion check via the **Enter key** path (`completeProjectScope()`), and checks no decoy-project leakage.
  - Confirmed FAILS on pre-fix code: `git stash push -- public/app.js` (reverting only the fix, script stayed) → `npm run verify:finder-scope` → **5 passed, 2 failed** (both the click-path and Enter-path "scoped whole-project list is reached" assertions failed, exactly the reported symptom — pane kept re-showing the 1-project suggestion list). `git stash pop` restored the fix.
  - PASS `npm run verify:finder-scope` (post-fix): **7 passed, 0 failed**.
  - PASS `npm run verify:finder` (pre-existing finder suite, anti-regression — same file touched): **5 passed, 0 failed**.
  - PASS `npm run verify:ui -- --offline`: **3 passed, 0 failed** (boot, real sessions + transcript render).
  - PASS `npm run typecheck`: clean, no errors.
  - No stray processes/ports left behind (scratch server + headless brave spawned on a free port, killed by pid in the script's `finally`); verified `ps aux` post-run shows none.
- **Status → VERIFIED.** Scope held to `public/app.js` + `scripts/verify-finder-scope.mjs` + `package.json` + this ticket, as instructed. Did not touch `drawer.js` or `INDEX.md`.
