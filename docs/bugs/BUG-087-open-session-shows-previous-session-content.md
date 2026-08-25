```orchard-ticket
{
  "id": "BUG-087",
  "type": "bug",
  "title": "Opened sessions showed the previous session’s transcript",
  "summary": "Session opening now replaces the previous transcript and prevents late loads from repainting it. The pre-fix mismatch was reproduced, corrected behavior passed, and project-switch coverage and standing checks stayed clean.",
  "impact_if_we_wait": "People could read one session’s transcript under another session’s title and act on the wrong context. Bounded: this affected display correctness during session opening, not stored transcripts or other user data.",
  "current_need": "Treat the ticket as closed: the mismatch failed before correction, the repaired behavior passed, and standing checks stayed clean.",
  "severity": "not_recorded",
  "area": "Session transcript loading",
  "reported": "2026-08-13",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-13",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Opening any session displays that session’s transcript",
    "The session header and transcript always identify the same session",
    "Late transcript loads from the previous session cannot repaint the content pane",
    "Opening through add-project loads the selected session’s transcript"
  ],
  "code_refs": [
    {
      "path": "app.js",
      "symbol": "openSession",
      "note": "Session-opening path associated with the stale transcript"
    },
    {
      "path": "app.js",
      "symbol": "renderMessages",
      "note": "Renders the transcript content pane"
    }
  ],
  "related": [
    {
      "id": "BUG-083",
      "relation": "recurrence_of"
    },
    {
      "id": "FEAT-074",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [
    "BUG-083"
  ],
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
    "archived_path": "docs/bugs/archive/BUG-087-open-session-shows-previous-session-content.md",
    "sha256": "841a47f8cf10e10703ddf77011cacbbd7418c16139d31e35d70b0ac5e22c5a2e",
    "bytes": 5468,
    "original_title": "opening a session shows the PREVIOUSLY-viewed session's transcript, not the one opened (header/content mismatch)",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the supplied ticket; the symptom, affected open paths, race diagnosis, required behavior, relationship, and recorded execution evidence are preserved.",
    "dropped": []
  }
}
```

# BUG-087 — Opened sessions showed the previous session’s transcript

## Diagnosis

Opening a target session updated its header before the message pane replaced the outgoing transcript. A missed reload or an unguarded late fetch could therefore paint session A’s content beneath session B’s title. The repaired path clears outgoing content and rejects transcript results scoped to an earlier session.

## Evidence

The recorded proof reproduced the header/content mismatch before correction and exercised an un-raced session open afterward. `verify:bug-083-project-switch-state` completed 10/10 passing. Another recorded run completed 6/6, but its adjacent suite name was absent. `typecheck` and `leak-gate` were reported clean. `verify:reload-live`, `verify:session-switch-url`, `verify:ui`, and `verify:bug-087-stale-transcript` were named without recorded results.

## Implementation notes

Clear the outgoing transcript immediately when opening another session. Scope each transcript request to its target session, and discard results whose scope no longer matches. Apply the same behavior to add-project, sidebar selection, and new-session paths.

## Verification plan

Show session A’s content, then open session B through add-project or selection and assert that only B’s transcript appears beneath B’s header. Delay A’s transcript response until after switching to B and assert that it is discarded.

## Risks

An incomplete scope guard could preserve the normal switch behavior while still allowing a delayed prior request to repaint the pane.

## Activity log (APPEND-ONLY)
### 2026-08-13 — orchestrator
- Filed from user report. Client-only. Same stale-content class as BUG-083; likely a transcript
  load/scope issue on the open path. QUEUED behind the FEAT-073/BUG-086 app.js agent (same file).

### 2026-08-13 — worker (fix + §C)
- ROOT CAUSE (cited): the reported trigger is the add-project open path. `addProject`
  (public/app.js:8425) set the header/title to a New session (`state.current = {…}`, and
  `paintCrown()`/`renderTree()`) but — unlike `openSession`/`startNew` — NEVER reset the message
  pane. `resetTranscript()` is what does `clear(node.panes)` + a fresh `newThread('main')`; without
  it the pane kept the PREVIOUSLY-viewed session's transcript, so the header said "New session" while
  the content was the old session (exactly the "content of last viewed session" the user reported).
  The transcript panes are rebuilt per open (`newThread` at app.js:2351 creates a NEW `paneEl` each
  time), so the pure openSession→openSession fetch race is already self-protecting (a stale fetch
  paints into a now-detached pane) — the observable defect was the MISSING reset on the add-project
  path, plus the sibling scope guard the ticket asked for as belt-and-suspenders.
- FIX (public/app.js):
  1. Add-project now resets the pane. `addProject` saves the outgoing draft, `closeSocket()` +
     `followCurrent()` (drop the old session's live socket/watch), `resetTranscript()` (clear +
     rebuild the pane), and un-hides the composer — so header and content agree and the outgoing
     transcript clears immediately on this open path, like every other boundary.
  2. `state.txScope` — a monotonic token bumped in `resetTranscript()` alongside `snapScope`
     (BUG-083's running-strip sibling, now for the message pane). `openSession` captures it right
     after `resetTranscript()` and DROPS its transcript answer (`if (scope !== state.txScope) return;`)
     both at the fetch-resolved seam and in the catch — so a late transcript fetch from the prior
     session can never paint under the newly-opened session, even on a path that reuses the pane.
- §C — scripts/verify-bug-087-stale-transcript.mjs (npm `verify:bug-087-stale-transcript`): REAL
  app.js in happy-dom vs a REAL server; session A's transcript is stubbed with a unique marker and
  gated at the fetch seam so it can be left IN FLIGHT across a REAL `addProject` switch (a fresh temp
  dir the server registers).
  - POST-FIX: 6/6 PASS.
  - PRE-FIX (the addProject reset + the txScope guard stripped, the addProject export kept so the
    harness runs): the 2 must-FAIL assertions FAILED — after add-project the pane still showed A's
    transcript (stale content under the new header), and a late in-flight A fetch repainted it. The
    regression (a normal un-raced open still paints its own content) stayed green pre AND post.
- Anti-regressions all green: verify:bug-083-project-switch-state (10/10), verify:reload-live (3/0),
  verify:session-switch-url (7/0), verify:ui (7/0), typecheck (0), leak-gate (PASS).
- Status → VERIFIED. Commit: "BUG-087: transcript pane scoped to the opened session (stale fetch dropped)".
