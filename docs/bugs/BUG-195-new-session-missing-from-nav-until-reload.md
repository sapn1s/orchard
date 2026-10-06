# BUG-195 — a new session is missing from the nav list until you reload

- **Status:** IN-PROGRESS
- **Severity:** medium
- **Area:** sidebar / composer (app.js)
- **Reported:** 2026-09-28 by user
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
User, verbatim:

> when i eg start new session in a new project, i need to reload page until it
> appears in the navigation of session list, it should be making it whenever
> session is sent message (active by user) or whatever makes sense of UX

Start a brand-new session (the pending-new composer), send the first message.
While the first turn runs, the session has NO row in the sidebar nav list. The
user reloads the page one or more times before it shows up.

## Repro
1. Open a fresh "New session" in some project (sidebar `+`, the pending-new row,
   or `startNew`).
2. Send the first message. The CLI assigns a real session id (`session-init`).
3. Look at the sidebar during the running turn: no row for this session.
4. It only appears after the turn ENDS (turn-end refetches the list) or after a
   page reload that restores the session from the URL.

## Expected
The row appears in the nav list the moment the session becomes active (its first
message is sent / `session-init` names the real id), not only after the first
turn completes or after a reload.

## Why it happens (verified by reading app.js)
The pending-new row is a DERIVED row (`pendingNewFor`, app.js:1431). It renders
only while `state.current.sessionId == null && encodedDir == null && no station
bridge`. The `session-init` handler (app.js:10917) sets
`state.current.sessionId = e.sessionId` — so `pendingNewFor` immediately returns
null and the derived pending row disappears.

At that instant the REAL session is not yet in `state.sessions.get(pid).list`:
that list was fetched by `loadSessions` at `startNew` time, BEFORE the session
existed on disk. The list is only re-fetched (`refreshCurrentProjectSessions` →
`loadSessions(force)`) at TURN-END (app.js:11425) or on a live-poll "session
ended" transition (app.js:9673) — never at session START. `visibleSessions`
renders rows from `s.list`, so with no row object in `s.list` there is nothing to
show, even though the open session would bypass the fold/cap via `alwaysIds`.

So the window between `session-init` and turn-end shows no nav row for the new
session. Reload works only because the URL carries the real session id by then,
so the fresh boot both restores `state.current.sessionId` (always-visible) AND
re-fetches `s.list` (which now contains the file).

## The fix (client-only — public/app.js)
Refresh the current project's session list at `session-init`, the same
`refreshCurrentProjectSessions()` already fired at turn-end and on the
live-poll ended-transition. `session-init` is exactly "the session is now active"
— the CLI has created the transcript file and written the session-provenance
record (so it lists as a non-folded user session, BUG-193). The open session then
has a real row in `s.list` and shows immediately via `alwaysIds`, with no reload
and without waiting for the first turn to end. Not a poll — it hangs off the
existing live event that already marks the session real.

## Context pack
- Files/functions in play:
  - `public/app.js` — `onEvent` `case 'session-init'` (~10917); `pendingNewFor`
    (1431); `refreshCurrentProjectSessions` (11552); `visibleSessions` (1759);
    `startNew` (8119).
  - `src/server/index.ts` `sessionsForProject` (283) — server list is a fresh
    disk scan, so a just-created session file is listable at session-init.
- Related tickets: BUG-193 (fold of programmatic rows — a dashboard session is
  NON-folded, so it must show), FEAT-073 (the derived pending-new row), BUG-194
  (uncommitted app.js edit in `projectHitRow`; untouched by this fix).
- Repro test: `scripts/verify-bug-195-new-session-nav.mjs` (scratch server on a
  free port + isolated Playwright; must-FAIL synthesized pre-fix state then the
  real `session-init` path).
- Known limitation / possible design fork: a NEW PROJECT (or a session) created
  OUTSIDE this tab (another tab, the CLI, a dispatch) still does not appear live —
  there is no server→client broadcast for "a project/session was created", only
  loadProjects at boot and per-project session refreshes. The in-tab UI flow
  (`addProject` → `loadProjects` → `startNew`) already surfaces a new project, so
  this ticket fixes the reported in-tab case; the cross-tab/CLI case would need a
  projects live channel and is left as a separate question.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-28 — fixing lane (round 1)
- **Understood:** the pending-new derived row vanishes the instant `session-init`
  sets `state.current.sessionId`, but the real row is not in `s.list` until a
  forced refetch that only happens at turn-end / live-poll ended — never at
  session start. So a running first turn shows no nav row; reload fixes it only
  because the URL then restores the id and the fresh boot refetches the list.
- **Changed:** `public/app.js` — added `void refreshCurrentProjectSessions();` in
  the `session-init` handler (additive; BUG-194's uncommitted edit untouched).
- **Verified:** `node scripts/verify-bug-195-new-session-nav.mjs` — 6/6 PASS
  (real server on a free port, isolated CLAUDE_STATION_DATA + CLAUDE_PROJECTS_DIR,
  real page in headless Brave via Playwright). Must-FAIL proof: with the file on
  disk AND the server listing it, the synthesized pre-fix render (set sessionId +
  renderTree, no refetch — exactly pre-fix session-init) shows 0 rows; the real
  onEvent(session-init) then shows the row as the open/always-visible session with
  no reload. Non-vacuity confirmed by removing the added line and re-running: the
  two FIXED assertions redden (4/6), restore → 6/6. `npm run gate` PASS (exit 0);
  `npm run board:check` OK — no drift.
- **Verified-by:** PENDING — independent clean-room verify warranted
  (session-lifecycle / nav-visibility, a regression-prone area: BUG-085/BUG-193
  history on the same fold/cap path).
- **Still open / handoff:** the cross-tab / CLI "new project appears live" case
  (see Known limitation) is NOT addressed; decide whether to file it.
- **Symptom of a deeper design flaw?** (pending close) — candidate: no live
  channel announces a newly-created project/session; every surface re-derives
  "what exists" from a boot-time fetch plus scattered refresh triggers. Flag for
  the closing agent.
</content>
</invoke>
