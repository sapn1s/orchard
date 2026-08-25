# BUG-083 — switching projects carries the composer draft + running-agent list across, instead of per-project

- **Status:** VERIFIED — fixed 2026-08-13 (both issues; §C incl. must-FAIL-pre-fix proof + same-scope regression)
- **Area:** FE project-switch state isolation (app.js composer draft + running strip)
- **Reported:** 2026-08-13 by user (two issues, same trigger — a project switch doesn't isolate per-project UI state)

## Issue 1 — composer draft not saved per-project
Unsent text in the composer follows you to whatever project/session you switch to, rather than
being saved as a per-project (or per-session) DRAFT you can return to. Today the draft is only
preserved across a START (app.js:5617-5621, restore after startTurn) — a project switch neither
saves the outgoing draft nor restores the incoming one.
**Wanted:** on switch, save the current composer text keyed to the project/session you're leaving;
on landing, restore that target's saved draft (empty if none). Losing it silently is the failure
to avoid; carrying it into the wrong project is also wrong.

## Issue 2 — running-agent list carries across the switch
The running strip (state.snap / renderStrip) appears to show the PREVIOUS project's agents after
switching, instead of only the newly-selected project/session's. `state.snap = null` +
`renderStrip()` exist (app.js:2209/2217) but the strip still leaks — likely the snapshot isn't
re-scoped/cleared on a project switch, or the old poll result paints before the new one loads.
**Wanted:** the strip reflects ONLY the currently-selected session's running set; on switch it
clears immediately and repopulates from the new session's snapshot (never shows the old one's).
Reuse the BUG-068/072/074 running-set machinery; ARCH-001 honesty (never show another session's
work as this one's).

## Verification (§C)
happy-dom/real-shape: type a draft in project A → switch to B → A's draft is gone from the
composer AND saved; B shows B's draft (or empty); switch back to A → A's draft restored (must FAIL
pre-fix: draft carried into B). Running strip: A has a live agent → switch to B (no agents) →
strip is empty immediately, not showing A's agent (must FAIL pre-fix: A's agent visible under B).
Anti-regressions: verify:ui, verify:running-snapshot, verify:session-switch-url, verify:queue,
typecheck, leak-gate.

## Activity log (APPEND-ONLY)
### 2026-08-13 — orchestrator
- Filed from user report. Same class as BUG-079 (session-switch state hygiene). Client-only
  (app.js) → reaches users on reload, no deploy.

### 2026-08-13 — worker (fix + §C)
- Issue 1 (composer draft): added a per-key draft map `state.drafts` + helpers `draftKey`/
  `saveDraft`/`restoreDraft` (public/app.js). A real on-disk session keys on `s <encodedDir>
  <sessionId>`; a not-yet-sent "New session" keys on `p <projectId>` (one pending-new draft per
  project). Both true switch boundaries — `openSession` and `startNew` — now `saveDraft(state.current)`
  BEFORE `state.current` is reassigned, and `restoreDraft(state.current)` right after `resetTranscript()`
  (which never touched the composer, so pre-fix the text simply stayed and rode into the next
  project). Survives within the tab; not persisted to storage (ticket said optional).
- Issue 2 (running strip): root cause was NOT resetTranscript — it already nulls `state.snap` +
  `renderStrip()` (strip clears immediately, confirmed by the "immediate clear" assertion passing
  pre AND post). The leak was a running-set POLL fired under the outgoing session landing AFTER the
  switch: `pollRunning` awaits `api.sessionRunning(id)`, and on a switch to a brand-new session
  (`startNew`) all of stationSessionId/sdkSessionId/current.sessionId are null, so
  `snapshotIsForCurrent`'s "no ids → trust it" branch WAVES THROUGH the stale answer and repaints
  the old session's agents under the new one. Fix: a monotonic `state.snapScope` bumped in
  `resetTranscript()`; `pollRunning` captures it before the await and drops the answer (and the
  markSnapshotStale on a fetch error) when the scope has moved on. Reuses the BUG-034 renderer
  untouched — this only stops a switched-away poll from un-clearing the strip.
- §C — scripts/verify-bug-083-project-switch-state.mjs (real app.js in happy-dom vs a real server;
  real openSession/startNew switches via row click; the /running endpoint gated at the fetch seam so
  a poll is left in flight ACROSS the switch — `api` is a read-only module namespace, so the seam is
  fetch, not the method):
  - PRE-FIX (fix calls + scope guard stripped, test hooks kept): the 5 must-FAIL assertions FAILED —
    A's draft carried into B and was never saved; returning to A did not restore A's draft; and the
    stale poll repainted A's agent under the agent-less new session. The two invariants (immediate
    strip clear on switch; same-scope poll still applies) stayed green pre AND post.
  - POST-FIX: 10/10 PASS.
- Anti-regressions all green: verify:ui (7/0), verify:running-snapshot (47/47),
  verify:session-switch-url (7/0), verify:queue (14/0), typecheck (0), leak-gate (PASS).
- Commit: BUG-083: per-project composer draft + running strip scoped to current session.
