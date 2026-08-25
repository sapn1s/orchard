```orchard-ticket
{
  "id": "BUG-009",
  "type": "bug",
  "title": "Project-wide session browsing was unreachable from Finder",
  "summary": "Finder now enters a selected project and can show its complete session list. Previously, selecting a project returned people to the project suggestions because the scoped-mode signal was removed while parsing.",
  "impact_if_we_wait": "People cannot browse every session within a project through Finder and must add search text. Bounded: this affects navigation and display correctness, not session data or project contents.",
  "current_need": "Treat the ticket as closed: the trailing-space signal is preserved, and the standing typecheck completed cleanly.",
  "severity": "medium",
  "area": "Finder project scoping",
  "reported": "2026-08-03",
  "reported_by": "bug-hunt workflow",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Selecting a project enters scoped mode with an empty search",
    "Finder lists the selected project's complete session list",
    "Adding search text after the project scope still filters sessions"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": "parseFinderQuery",
      "note": "BUG-009 arose when trimming removed the trailing-space scoped-mode signal."
    },
    {
      "path": "public/app.js",
      "symbol": "renderSearch",
      "note": "Previously trimmed the finder value before parsing."
    },
    {
      "path": "public/app.js",
      "symbol": "completeProjectScope",
      "note": "Writes the selected project followed by the trailing-space signal."
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
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-009-finder--scope-into--project--is-unreachable.md",
    "sha256": "f89fcb06f4d518b82d037310a47d61db9a0f0caa4f6ca59b848c85528d78b0f5",
    "bytes": 6091,
    "original_title": "Finder 'scope into #project' is unreachable: the trailing space that signals scoped mode is trimmed away",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the archived ticket text; the symptom, parser diagnosis, scoped-mode signal, expected behavior, frontend location, and recorded checks are preserved.",
    "dropped": []
  }
}
```

# BUG-009 — Project-wide session browsing was unreachable from Finder

## Diagnosis

`completeProjectScope` placed a trailing space after the selected project. `renderSearch` trimmed the value before calling `parseFinderQuery`, which trimmed it again. The parser therefore saw no scoped-query group and returned to project selection. The empty scoped branch was unreachable.

## Evidence

Selecting a project previously redrew the project suggestions instead of listing that project's sessions. Adding any character after the trailing space entered scoped mode. The standing `typecheck` check was reported clean. `verify:finder-scope`, `verify:finder`, and `verify:ui` were named without recorded results.

## Implementation notes

Preserve the trailing-space signal when passing finder input to `parseFinderQuery`, or retain equivalent information without trimming it away. Frontend changes must be serialized with other frontend tickets.

## Verification plan

Select a project by clicking its suggestion and by pressing Enter. Confirm both paths show the complete project session list with an empty query, then confirm additional text filters that scoped list.

## Risks

Changing trimming behavior may preserve unintended whitespace in ordinary finder searches unless scoped parsing distinguishes the trailing signal from user-entered padding.

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
