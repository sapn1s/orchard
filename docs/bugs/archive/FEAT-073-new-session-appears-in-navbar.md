# FEAT-073 — a newly-opened (unsent) session should appear at the top of the navbar, and drop if abandoned

- **Status:** RESOLVED (2026-08-13)
- **Area:** FE sidebar tree (app.js startNew / renderTree — pending-new-session row)
- **Reported:** 2026-08-13 by user:
  > "when i select new session in project, it currently opens new session but in navbar its not
  > visible. i wonder if it should immediately appear at top as recent, and what if i click away
  > without sending, should it stay or be removed etc, probably removed although input state if any
  > should probably save (already seems to be)."

## Symptom
Selecting "New session" opens a fresh (not-yet-sent) session in the main pane, but the sidebar
shows no row for it — there's no on-disk session/transcript until the first message, so renderTree
(which lists server-known sessions) has nothing to show. The user expects the new session to be
visible at the top while they're in it.

## Wanted (design mostly settled by the user)
1. A newly-opened, not-yet-sent session shows as a row at the TOP of its project in the sidebar
   (a "pending new" / draft row), marked as the current/open one, so it's visible while active.
2. If the user navigates away WITHOUT sending, the pending row is REMOVED (it never became a real
   session) — no orphan rows accumulating.
3. The composer DRAFT for that pending-new session is preserved (BUG-083 already keys a pending-new
   draft on `p <projectId>`), so returning to New session in that project restores the text — keep
   this behavior; removal of the row must not wipe the saved draft.
4. Once the first message is sent (the session becomes real/on-disk), it transitions to a normal
   session row (no duplicate).

## Verification (§C)
happy-dom/real-shape: startNew → a pending-new row appears at the top of the project, marked
current (must FAIL pre-fix: no row); switch away without sending → the row is gone, but the draft
(if any) is still restorable on returning to New session (BUG-083 anti-regression); send the first
message → the row becomes the real session, exactly one row (no dupe). Anti-regressions:
verify:bug-083-project-switch-state, verify:ui, verify:attention, verify:feat-070-sidebar,
verify:bug-085-sidebar-cap, typecheck, leak-gate.

## Activity log (APPEND-ONLY)
### 2026-08-13 — orchestrator
- Filed from user report. Client-only (app.js/styles). Coordinate with BUG-083 (pending-new draft
  key) and the FEAT-070/BUG-085 sidebar cap logic (the pending row is the open session → always
  visible, and sits at top).

### 2026-08-13 — worker (fix)
- Approach: a PURELY DERIVED "pending new" sidebar row — never a stored session, so there is no
  orphan to clean up and the BUG-083 draft map is never touched.
  - `public/app.js`:
    - `state.pendingNew` (projectId) — set ONLY by `startNew`, cleared by `openSession`. It gates the
      row, so a project that is merely selected (no session on screen) never sprouts a phantom row.
    - `pendingNewFor(pid)` synthesises one row (`sessionId: '__pending_new__'`, `pending: true`) for
      the current unsent New session; returns null once the session carries a sessionId/encodedDir OR
      a live station bridge (`state.stationSessionId`) — i.e. the instant the first turn starts.
    - `renderProjectGroup` prepends the pending row at the very TOP of the project's kids (above
      pinned + history) and suppresses the "no history" empty note while it is present.
    - `sessionRow` treats a `pending` row as active (`aria-current="true"`), titles it "New session —
      not sent yet", and makes it a no-op-focus click with no row menu (nothing on disk to act on).
    - `startNew` sets `state.pendingNew`, expands the owning project + kicks a background
      `loadSessions` so the real row can take over seamlessly.
  - `public/styles.css`: `.row.pending { font-style: italic; }` — a provisional/draft cue on top of
    the aria-current highlight it already wears.
- Lifecycle: navigate away unsent → `state.current` changes → next renderTree drops the row (no
  orphan); the BUG-083 pending-new draft (`p <projectId>` key) is saved by the existing
  `saveDraft(state.current)` in openSession/startNew and survives (removal never touches it). First
  message sent → station bridge live, then current+list point at the real session → `pendingNewFor`
  returns null and the real row renders once (no duplicate, the sentinel is never in any list).
- Verify (§C): new `scripts/verify-feat-073-new-session-row.mjs` (npm `verify:feat-073-new-session-row`)
  — REAL app.js in happy-dom vs a REAL server, driving REAL startNew/openSession/renderTree. The
  live SDK turn can't run in-harness (no provider), so "first message sent" drives the resulting
  client state (station bridge live, then current+list → real session), same as BUG-083's verify.
  **12/12 PASS post-fix; 7/12 pre-fix (5 must-FAIL: no pending row on startNew / at top / marked
  current / reads New session / back on return).**
- Anti-regressions: `verify:bug-083-project-switch-state` 10/10, `verify:feat-070-sidebar` 14/14,
  `verify:bug-085-sidebar-cap` 11/11, `verify:ui` 7/0, `verify:attention` 4/0, `verify:bug-086-pin-style`
  12/12, `typecheck` clean, leak-gate PASS.
- Note: `verify-bug-083-project-switch-state.mjs`'s `ownRows()` helper (its "real session rows"
  accessor) now selects `button.row:not(.pending)` so its A/B index switches skip the new derived
  row — the feature legitimately adds a top row; the helper's intent (genuine sessions) is unchanged.
- Status → RESOLVED (verified).
