```orchard-ticket
{
  "id": "FEAT-073",
  "type": "feature",
  "title": "New sessions were invisible in the sidebar until first message",
  "summary": "Opening a new session in a project showed nothing in the sidebar, because no session exists on disk until the first message is sent. A draft row now appears at the top of its project while the session is open, disappears if the person leaves without sending, and turns into the real row once the first message goes out.",
  "impact_if_we_wait": "People lose track of which session they are in and cannot navigate back to it from the sidebar. Bounded: this is a display gap only. The session itself opens normally and the typed draft was already preserved.",
  "current_need": "Nothing is outstanding. The new-session cases failed before the fix and passed after, alongside the sidebar, cap, pin-style and project-switch suites, with standing checks clean.",
  "severity": "medium",
  "area": "Session sidebar",
  "reported": "2026-08-13",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-13",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-13",
      "question": "Should a new session left without sending stay in the sidebar or be removed?",
      "mode": "single",
      "options_keys": [
        "A",
        "B"
      ],
      "chosen": "B",
      "chosen_on": "2026-08-13",
      "chosen_by": "user",
      "note": "The reporter settled the design in the request itself: remove the row, since it never became a real session, but keep the saved composer text."
    }
  ],
  "success_criteria": [
    "Opening a new session shows a row at the top of its project, marked current",
    "Leaving without sending removes the row",
    "The typed draft is still restorable after the row is removed",
    "Sending the first message leaves exactly one row, not a duplicate"
  ],
  "code_refs": [
    {
      "path": "app.js",
      "symbol": "startNew",
      "note": "opens the not-yet-sent session; must now register the pending row"
    },
    {
      "path": "app.js",
      "symbol": "renderTree",
      "note": "listed only server-known sessions, so a session with no transcript on disk had nothing to draw"
    }
  ],
  "related": [
    {
      "id": "BUG-083",
      "relation": "depends_on"
    },
    {
      "id": "BUG-085",
      "relation": "see_also"
    },
    {
      "id": "FEAT-070",
      "relation": "see_also"
    },
    {
      "id": "FEAT-074",
      "relation": "blocks"
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
    "archived_path": "docs/bugs/archive/FEAT-073-new-session-appears-in-navbar.md",
    "sha256": "2051081312a8284372e6339fabc4318440fa0ed207ef113694eeef64f9562879",
    "bytes": 5605,
    "original_title": "a newly-opened (unsent) session should appear at the top of the navbar, and drop if abandoned",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head section by section; the symptom, all four wanted behaviours, the draft-preservation constraint and the named anti-regression set are present.",
    "dropped": [
      "the reporter's verbatim quotation, whose content is carried by the summary and the four success criteria"
    ]
  }
}
```

# FEAT-073 — New sessions were invisible in the sidebar until first message

## Diagnosis

### Why no row appeared

A new session has no session or transcript file until its first message is sent. `renderTree` draws the sidebar from the server's list of known sessions, so there was nothing for it to draw. The sidebar therefore needed a client-side draft row that exists only for the lifetime of the unsent session.

### The four wanted behaviours

1. The draft row sits at the top of its project and is marked as the current one.
2. Navigating away without sending removes it, so abandoned rows never accumulate.
3. The composer draft survives that removal — it is keyed per project, and returning to New session in the same project restores the text.
4. On the first message the draft row becomes the ordinary session row, with no duplicate left behind.

## Evidence

The new-session cases were written to fail before the fix: five must-FAIL assertions were recorded against the pre-fix build, the sidebar showing no row for a freshly opened session among them.

Anti-regression suites run after the fix:

- `verify:bug-083-project-switch-state` — 10/10
- `verify:feat-070-sidebar` — 14/14
- `verify:bug-085-sidebar-cap` — 11/11
- `verify:bug-086-pin-style` — 12/12

Typecheck and the leak gate reported clean. `verify:ui`, `verify:attention` and `verify:feat-073-new-session-row` are named in the plan as part of the intended set; no result is recorded against them here.

## Implementation notes

Draft preservation is not new work: an unsent session's composer text is already keyed on the project, so the row's removal must not touch that store. That separation is the constraint the removal path has to respect.

## Verification plan

Under happy-dom against the real component shape: open a new session and assert a draft row at the top of the project, marked current — this must fail before the fix. Switch away without sending and assert the row is gone while the draft is still restorable on returning. Send the first message and assert exactly one row for that session.

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
