```orchard-ticket
{
  "id": "BUG-083",
  "type": "bug",
  "title": "Project switches mixed drafts and running agents",
  "summary": "Project switches now preserve each project's composer draft and immediately clear the previous project's running agents. Returning restores the saved draft, while the selected project repopulates its own running list. Pre-fix cases failed as required, corrected behavior passed, and standing checks stayed clean.",
  "impact_if_we_wait": "People could send text in the wrong project, lose an unsent draft, or mistake another project's agents for current work. Bounded: this affects draft handling and display correctness, not submitted messages, stored project data, or agent execution.",
  "current_need": "Treat the ticket as closed: the pre-fix cases failed, corrected behavior passed, and standing checks stayed clean.",
  "severity": "not_recorded",
  "area": "Project switch state",
  "reported": "2026-08-13",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-13",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Switching projects saves the outgoing composer draft under its project or session",
    "The selected project's saved draft appears after switching back",
    "A project without a saved draft shows an empty composer",
    "The running-agent list clears immediately when switching projects",
    "Only the selected session's running agents appear after its snapshot loads"
  ],
  "code_refs": [
    {
      "path": "app.js",
      "symbol": "startTurn",
      "note": "Draft restoration previously covered starting a turn but not switching projects."
    },
    {
      "path": "app.js",
      "symbol": "state.snap",
      "note": "The running snapshot must be cleared and scoped when the selected project changes."
    },
    {
      "path": "app.js",
      "symbol": "renderStrip",
      "note": "Repaints the running-agent list after clearing the previous project's snapshot."
    }
  ],
  "related": [
    {
      "id": "ARCH-001",
      "relation": "see_also"
    },
    {
      "id": "ARCH-005",
      "relation": "recurrence_of"
    },
    {
      "id": "BUG-068",
      "relation": "see_also"
    },
    {
      "id": "BUG-072",
      "relation": "see_also"
    },
    {
      "id": "BUG-074",
      "relation": "see_also"
    },
    {
      "id": "BUG-087",
      "relation": "recurrence_of"
    },
    {
      "id": "BUG-106",
      "relation": "see_also"
    },
    {
      "id": "FEAT-073",
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
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-083-project-switch-leaks-draft-and-running-list.md",
    "sha256": "b40fa0c7b5f834af887f84bf91af35005f5b763d37261a2003442b7355933f54",
    "bytes": 5226,
    "original_title": "switching projects carries the composer draft + running-agent list across, instead of per-project",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the supplied original; both switch defects, intended isolation, implementation surfaces, related tickets, and recorded proof remain represented.",
    "dropped": []
  }
}
```

# BUG-083 — Project switches mixed drafts and running agents

## Diagnosis

Project switching neither saved the outgoing composer draft nor restored the incoming project's draft. The running strip could also retain the previous snapshot or repaint from an old poll result before the newly selected session loaded.

## Evidence

The pre-fix proof removed the fix calls and scope guard while keeping the test hooks; all 5 required cases then failed. `verify:running-snapshot` completed 47/47 passing, and another recorded tally was 10/10 without an adjacent suite name. `typecheck` and `leak-gate` were clean. `verify:ui`, `verify:session-switch-url`, `verify:queue`, and `verify:bug-083-project-switch-state` were named without recorded results.

## Implementation notes

On a project switch, save the outgoing composer text under the project or session being left, then restore the selected target's saved draft or an empty value. Clear `state.snap` and call `renderStrip` immediately, then accept only the selected session's snapshot when repopulating the running strip.

## Verification plan

Type a draft in project A, switch to B, and confirm A's text is absent while B shows its own draft or an empty composer. Switch back and confirm A's draft returns. With an agent running in A, switch to an idle B and confirm the strip clears immediately and never paints A's agent under B.

## Risks

Late poll results must not repaint agents from the project just left. Draft keys must use the same project or session identity throughout saving and restoration to prevent cross-project text leakage.

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
