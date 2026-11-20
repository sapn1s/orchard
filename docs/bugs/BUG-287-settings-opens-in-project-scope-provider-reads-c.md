```orchard-ticket
{
  "id": "BUG-287",
  "type": "bug",
  "title": "Settings opens in project scope: Provider reads Claude for OpenAI session",
  "summary": "Opening Settings on an OpenAI (Codex) session shows Provider = Claude with no lock, while the session, model chip and transcript are all OpenAI. The drawer defaults to the \"This project\" lens and never switches to \"This session\" when opened from a session, so Provider renders the project default instead of the real pinned engine. The session itself is correct.",
  "impact_if_we_wait": "Every session whose engine differs from the project default shows a contradictory Provider in Settings, reading as a misconfiguration the user cannot act on. Recurs on each such session.",
  "current_need": "Default the Settings lens to \"This session\" when the drawer opens while a session is in view, so the panel shows the real pinned engine (ARCH-010). Verify on scratch with an openai and a claude session.",
  "severity": "medium",
  "area": "ui/settings",
  "reported": "2026-10-29",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-11-19",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Opening Settings from an OpenAI session shows Provider = OpenAI Codex (locked) without flipping the lens",
    "Opening Settings from a Claude session shows Provider = Claude",
    "Opening Settings with no session in view still defaults to the project lens and is switchable",
    "The provider shown always matches the model catalog and the session real engine"
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "03efe51f-cc40-42fa-808e-3d803b91cc47",
      "verdict": "invalid",
      "verdict_on": "2026-11-19",
      "recorded_at": "2026-11-19T15:12:09.900Z",
      "author": "verify lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Contract INVALID (re-cited run). Reply said BROKEN: foreign dock (A session open, B selected) opened B Settings on session lens showing A engine. Lane reproduced it (must-FAIL) and fixed getSessionId in app.js; re-verifying."
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "6e3df793-6a2c-42be-bc72-5813b39812bf",
      "verdict": "broken",
      "verdict_on": "2026-11-19",
      "recorded_at": "2026-11-19T15:14:35.349Z",
      "author": "verify lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "8e627f5ac373b5d9e1d81413a935a31f35fcc25fb58dc7ad088b7ab5fbe399d3",
      "verify_mode": "mixed-state",
      "note": "Default lens + foreign-dock default fixed. BREAK: under a foreign dock (A docked, B selected) the user can still click This session in B Settings and see A engine + Continue button acting on A (drawer sessionOk=!!project(), sessionEngine has no foreign check). Pre-existing path; needs a design call."
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "a90d1190-efd8-44ed-b23c-1eb9dec431e5",
      "verdict": "broken",
      "verdict_on": "2026-11-19",
      "recorded_at": "2026-11-19T15:58:08.082Z",
      "author": "lane BUG-289/BUG-287 r2",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "5f25a59184169482afe0ce3403f4280b3642597e61f8a410f497d78d641bcc6e",
      "verify_mode": "mixed-state",
      "note": "Fixer suite 9/0 held; adversarial: drawer open on A session lens, then B selected underneath -> repaint/repaintLive kept scope=session showing A engine + Continue under B (coercion only in open()). Fixed in paint(); re-verifying."
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "8340b17d-1451-4038-ba78-8b662759c534",
      "verdict": "holds",
      "verdict_on": "2026-11-19",
      "recorded_at": "2026-11-19T16:06:29.709Z",
      "author": "lane BUG-289/BUG-287 r2",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "b0868c528c06b06c5ef19d9c5a60f5acf0b8edf13c5e51d683b50c81050a36c4",
      "verify_mode": "mixed-state",
      "note": "x"
    }
  ],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": false,
    "Implementation notes": false,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": null,
    "sha256": null,
    "original_title": null,
    "migrated_on": null,
    "migrated_by": null,
    "confirmation": "Authored directly in the record format through scripts/board-tool.mjs. There is no legacy original.",
    "dropped": []
  }
}
```

# BUG-287 — Settings opens in project scope: Provider reads Claude for OpenAI session

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-29 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-29 — worker (BUG-287 fixing r1)
- **Note:** Root cause (read-only, live): the session engine is correct everywhere — /api/transcript returns lockedProvider:openai for 019ff078, and the client sessionEngine() = {engine:openai, source:pinned}. The panel only LOOKED wrong because the Settings drawer defaults to the "This project" lens and never switched to "This session" when opened over a session, so the Provider control rendered the PROJECT default (anthropic=Claude), switchable, while the model chip/transcript were all OpenAI. Flipping the lens to "This session" already showed OpenAI Codex locked.

  Fix: public/app.js createDrawer ctx gains getSessionId (reads state.current.sessionId); public/lib/drawer.js open() — when no explicit scope is requested and the open is not machine-scope, the lens follows what is on screen: a session in view => "This session", else "This project". Machine opens keep their own routing (lens hidden).

  Verified on the REAL OpenAI session 019ff078 via the live app (reloaded with the edited JS, window.__station): plain drawer.open("settings") now yields scope=session and the Provider segment shows OpenAI Codex pressed + both buttons disabled (locked with the pin explanation). MUST-FAIL captured pre-fix in the same session: the same plain open yielded scope=project with Claude pressed + enabled (the reported contradiction). Remaining criteria (claude session -> Claude locked; no-session view -> project scope, switchable) follow from the one-line rule and will be covered by the FEAT-120 scratch Playwright run. Independent clean-room verify still warranted (bundled with the FEAT-120 switch-action verify).

### 2026-11-19 — verify lane
- **Verification recorded:** dispatch anthropic run 03efe51f-cc40-42fa-808e-3d803b91cc47 — VERDICT: INVALID — Contract INVALID (re-cited run). Reply said BROKEN: foreign dock (A session open, B selected) opened B Settings on session lens showing A engine. Lane reproduced it (must-FAIL) and fixed getSessionId in app.js; re-verifying.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-11-19 — verify lane
- **Note:** Lane r1 (2026-11-19). Original user request (session 0022d8a4, 2026-10-29): "this session when i opens ettings it shows as selected provider being claude, but everything elsed points to openai and no option to switch"; the switch half is FEAT-120 (committed 862cf7e). Probe /tmp/lane287/probe-287.mjs: scratch server with the REAL OpenAI transcript 019ff078 and the REAL Claude transcript 954811be copied in, headless brave, project default anthropic AND openai. Pre-fix drawer.js (BUG-287 line removed): 4 FAIL, OpenAI session reads Claude unlocked (the reported symptom). Post-fix 15/0. IV run 03efe51f (OpenAI quota -> Anthropic) found a foreign-dock break: A session docked, Settings for project B via sidebar opened on the session lens showing A engine (violates criteria 3/4). Reproduced in the probe (must-FAIL: scope=session, OpenAI Codex locked under B). Fix: public/app.js getSessionId returns null when dockIsForeign(). After: probe 17/0, BUG-296 31/0, BUG-292 27/0, BUG-196 provider-lock 60/60, gate PASS exit 0. BUG-106 crossproject suite FATAL at sidebar session-row render (before any drawer open, unrelated to getSessionId) - environmental/pre-existing, not counted.

### 2026-11-19 — verify lane
- **Verification recorded:** dispatch anthropic run 6e3df793-6a2c-42be-bc72-5813b39812bf — VERDICT: BROKEN — mixed-state candidate 8e627f5ac373 — Default lens + foreign-dock default fixed. BREAK: under a foreign dock (A docked, B selected) the user can still click This session in B Settings and see A engine + Continue button acting on A (drawer sessionOk=!!project(), sessionEngine has no foreign check). Pre-existing path; needs a design call.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-11-19 — verify lane
- **Note:** IV r2 6e3df793 (Anthropic; OpenAI quota) BROKEN on a path beyond the lane fix: with A docked and B selected, B Settings now opens on the project lens (fixed), but the This session lens stays enabled (drawer.js paintChrome sessionOk = !!project()) and clicking it paints A pinned engine plus a Continue-on-Claude button that acts on A, under B name (app.js sessionEngine reads state.current.sessionId with no foreign-dock check). Pre-existing (BUG-106/BUG-198 class), not introduced by BUG-287. Not fixed in-lane: needs 2 files and a design call on what the session lens means under a foreign dock (disable it, or treat it as a pending-new session of B; sessionEngine also feeds the docked composer, so blanking it there risks BUG-196 surfaces). Original display defect (criteria 1-3 for in-view sessions) holds on real transcripts. Stopped per charter.

### 2026-11-19 — lane BUG-289/BUG-287 r2
- **Verification recorded:** dispatch anthropic run a90d1190-efd8-44ed-b23c-1eb9dec431e5 — VERDICT: BROKEN — mixed-state candidate 5f25a5918416 — Fixer suite 9/0 held; adversarial: drawer open on A session lens, then B selected underneath -> repaint/repaintLive kept scope=session showing A engine + Continue under B (coercion only in open()). Fixed in paint(); re-verifying.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-11-19 — lane BUG-289/BUG-287 r2
- **Note:** Round 2 lane. INTENT (tested the "design call" claim): user words (0022d8a4) "it shows as selected provider being claude, but everything elsed points to openai" = Settings must agree with what is on screen. The drawer header names project B; the hint "Writing to this session only" means a session OF B; BUG-106 + r2 getSessionId already rule a foreign dock is not B session, and the override bag is A (BUG-198). So intent decides it: disable the session lens under a foreign dock. Not a user decision. CHANGE: public/app.js ctx.getForeignDockOwner() (A name when dockIsForeign()); public/lib/drawer.js paintChrome disables This session with a title naming the real owner, open() and (r3, after IV a90d1190 BROKEN: drawer already open when B gets selected underneath) paint() coerce scope session->project under a foreign dock. TEST: scripts/verify-bug-287-foreign-lens.mjs, real scratch server + REAL transcripts 019ff078 (OpenAI) / 954811be (Claude), headless Playwright chromium: MODE=pre 7/5 (must-FAIL), after 12/0. Visual: scratch lane-289-287-r2/shots/foreign-lens.png + open-then-foreign.png (projB, This project, Provider Claude, This session greyed); PRE shots show OpenAI Codex + Continue-on-Claude under projB. Anti-regressions after r3: BUG-296 31/0, BUG-292 27/0, BUG-196 provider-lock 60/60, BUG-198 23/25 identical to baseline without my hunks (X2/X3 pre-existing); BUG-106 crossproject FATAL environmental/pre-existing. Gate exit 0. IV r3 run pending at time of writing (see verification[]).

### 2026-11-19 — lane BUG-289/BUG-287 r2
- **Verification recorded:** dispatch anthropic run 8340b17d-1451-4038-ba78-8b662759c534 — VERDICT: HOLDS — mixed-state candidate b0868c528c06 — x. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-11-19 — lane BUG-289/BUG-287 r2
- **Note:** IV r3 run 8340b17d HOLDS (candidate b0868c528c06; OpenAI quota -> Anthropic fallback, decorrelation reduced). Its verification[] note reads "x" by lane error (a diagnostic re-run of the verified verb after a refusal); this entry is the real note. Fixer 12/0; adversarial open-then-select-B with no explicit repaint held. Untested by IV: real sidebar click under the inert modal, editor view, phone layout. Nit seen by IV: over a pending-new A dock, B lens title says the open session belongs to p287 although no session exists yet.
