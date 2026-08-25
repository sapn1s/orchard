```orchard-ticket
{
  "id": "BUG-011",
  "type": "bug",
  "title": "Session switches carried the previous thread into navigation",
  "summary": "Switching sessions now clears the previously viewed agent thread before recording the destination URL. Previously, browser navigation could reopen the new session with an unrelated agent reference, show a false warning, and return the user to the main transcript.",
  "impact_if_we_wait": "Browser history can reopen the wrong transcript view and show a false warning. Bounded: this affects navigation and display-correctness, not session data loss or transcript contents.",
  "current_need": "Keep BUG-011 closed: typecheck ran clean after the session-switch routing correction.",
  "severity": "medium",
  "area": "Session navigation",
  "reported": "2026-08-03",
  "reported_by": "bug-hunt workflow",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Switching sessions from an agent thread records the destination without the previous agent reference",
    "Reloading the destination session does not show a false missing-agent warning",
    "Back and Forward restore the correct session view"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": "openSession",
      "note": "Previously pushed the destination URL before clearing the viewed agent thread near lines 2701 and 2705"
    },
    {
      "path": "public/app.js",
      "symbol": "currentRoute",
      "note": "Read the stale viewed agent near line 4694 while constructing the destination route"
    },
    {
      "path": "public/app.js",
      "symbol": "applyRoute",
      "note": "The stale agent reference triggered the missing-agent warning near lines 2773–2774"
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
    "archived_path": "docs/bugs/archive/BUG-011-switching-sessions-from-inside-a-subagent-th.md",
    "sha256": "46ef4a494c5b5a64c939454e51d3d852116735b2ec2a1d884f581a37b72fe237",
    "bytes": 6287,
    "original_title": "Switching sessions from inside a subagent thread stamps a stale agent= into the new session's URL",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the supplied original; the symptom, reproduction order, affected routing symbols, correction direction, frontend coordination, and required regression coverage remain present.",
    "dropped": []
  }
}
```

# BUG-011 — Session switches carried the previous thread into navigation

## Diagnosis

While session A displayed a subagent thread, `openSession` pushed session B's URL before `resetTranscript` changed `state.viewing` to `main`. `currentRoute` therefore copied A's agent identifier into B's history entry. Reloading that entry made `applyRoute` reject the unrelated agent and return to B's main transcript.

## Evidence

The reproduction followed a sidebar switch from session A's recorded agent thread to session B, then a reload before any replacement URL sync. The resulting route named A's agent under B and produced the false missing-agent warning. The standing `typecheck` check was reported clean. `verify:session-switch-url`, `verify:ui`, `verify:routing`, and `verify:agent-summary` were named without recorded outcomes.

## Implementation notes

Clear the viewed agent thread before pushing the destination session URL, or push the URL only after transcript reset. Frontend changes must be serialized with other work touching `public/app.js` or `drawer.js`.

## Verification plan

Exercise the original sidebar-switch reproduction with a check that fails when session B inherits session A's agent reference. Reload and use Back and Forward to confirm the destination remains on its main transcript without a false warning.

## Risks

Changing URL synchronization order can affect browser-history behavior during session switches. Preserve correct Back and Forward navigation while preventing stale agent references.

## Activity log (APPEND-ONLY)

### 2026-08-03 — bug-hunt (read-only hunter)
- **Understood:** Opening session B (sidebar click) while viewing a subagent thread of session A writes B's history entry as ?agent=<A's agent id>. Reloading or Back/Forward then shows a false 'This link names an agent thread not recorded in this session' warning and drops the user on main — the app corrupts its own link.
- **Verified:** diagnosis traced against source (see Repro); NOT yet reproduced with a running test.
- **Handoff:** Reset state.viewing to 'main' (or move the syncUrl('push') to after resetTranscript) before pushing the new session's URL so a stale agent= is never captured.

### 2026-08-04 — fixing agent (app.js)
- **Understood:** Confirmed the trace against current source (line numbers shifted
  since the hunt, code is equivalent): `openSession()` (public/app.js:2730) still
  called `syncUrl('push')` (now :2744) BEFORE `resetTranscript()` (:2748) reset
  `state.viewing`, so `currentRoute()` (:4764) read the outgoing session's
  `state.viewing` and the `history.pushState()` call for the NEW session carried
  a stale `agent=<A's agentId>`.
  IMPORTANT correction to the original diagnosis: this defect is **masked at
  runtime** by an existing, unrelated mechanism — `resetTranscript()` ends by
  calling `showThread('main')`, which itself does `syncUrl('replace')`
  (app.js:2293, comment: "thread switches move within one session — never a
  history entry"). Because `openSession` runs `push` then `resetTranscript()`
  synchronously in the same tick (no `await` in between), the bad push is
  immediately replaced in-place before control ever returns to the browser —
  confirmed empirically by monkey-patching `history.pushState`/`replaceState`
  and logging both calls: `push(B?agent=agentX)` followed instantly by
  `replace(B)` (no agent). So a plain reload-after-click test PASSES even on
  the unfixed code — that is NOT proof of no bug, it is proof the self-heal
  works for the synchronous path. The literal defect (the push argument
  itself carrying the stale id) is still real and still worth eliminating:
  it's fragile (depends on `resetTranscript` staying synchronous and always
  reaching `showThread`), and the ticket's own fix direction is exactly this.
- **Changed:** `public/app.js` — in `openSession()`, added `state.viewing =
  'main';` immediately before the `syncUrl('push')` call (right after
  `state.forkFrom = null;`), so `currentRoute()` at push-time never sees a
  leftover agent id from the previous session. `resetTranscript()`'s own
  reset of `state.viewing` (a few lines later) becomes a no-op re-assignment,
  harmless. Did not touch drawer.js or INDEX.md.
- **Verified:**
  - Added `scripts/verify-session-switch-url.mjs` (+ `verify:session-switch-url`
    npm script) — real Brave/CDP, real server, synthetic project with session A
    (one recorded subagent) and session B (plain). Checks: (1) entering A's
    subagent thread puts `?agent=` in the URL; (2) **the raw
    `history.pushState()` call itself**, captured via monkey-patch — not just
    the settled/self-healed hash — carries NO `agent=` when clicking session
    B's sidebar row from inside A's subagent thread (this is the check that
    actually distinguishes fixed from unfixed; a check on settled `location.hash`
    alone is worthless here, self-heal already fixes that in both cases); (3)
    `state.viewing` is `'main'` after switching; (4) reloading B's URL lands on
    B's main thread with no false "not recorded in this session" warning; (5) a
    GENUINE `?agent=<id>` deep-link into a session that HAS that agent still
    opens the agent thread (regression guard for legitimate deep-links).
  - PASS (fixed code): `npm run verify:session-switch-url` → 7 passed, 0 failed.
  - FAIL (confirmed pre-fix, via `git stash push -- public/app.js` then running
    the script directly): 6 passed, 1 failed — the `pushState` capture check
    failed with `observed: ["...session/B...&agent=agentA001xyz"]`, i.e. the
    push itself carried the stale id, exactly as diagnosed.
  - PASS `npm run verify:ui -- --offline` → 3 passed, 0 failed.
  - PASS `npm run verify:routing` → 11 passed, 0 failed (same-file anti-regression
    suite — push/replace/reload/back/deep-restore all still correct).
  - PASS `npm run verify:agent-summary` → 3 passed, 0 failed (subagent/viewAgent
    path anti-regression).
  - PASS `npm run typecheck` → clean.
- **Status:** VERIFIED. Fix is a minimal, targeted hardening at the exact spot
  the original diagnosis named; anti-regression suites for the same file all
  green.
