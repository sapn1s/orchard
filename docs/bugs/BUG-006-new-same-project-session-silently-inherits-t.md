```orchard-ticket
{
  "id": "BUG-006",
  "type": "bug",
  "title": "New sessions inherited earlier session settings",
  "summary": "New sessions in the same project now begin with project defaults. Previously, model, effort, budget, and tool permissions silently carried over from the preceding session; only the permission mode reset.",
  "impact_if_we_wait": "People could unknowingly start sessions with unintended cost, capability, or model settings. Bounded: this affected new-session configuration within one project, not stored project defaults or user data.",
  "current_need": "Keep the ticket closed: the override reset is in place, and type checking completed cleanly.",
  "severity": "high",
  "area": "New session settings",
  "reported": "2026-08-03",
  "reported_by": "bug-hunt workflow",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [
    {
      "asked_on": null,
      "question": "Should a new same-project session retain previous session overrides or restore project defaults?",
      "mode": "single",
      "options_keys": [
        "A",
        "B"
      ],
      "chosen": "B",
      "chosen_on": null,
      "chosen_by": "agent",
      "note": "The whole session override map was cleared so every new session begins from project defaults."
    }
  ],
  "success_criteria": [
    "A new same-project session begins with project-default model, effort, budget, and tool permissions",
    "The new-session payload contains no overrides inherited from the preceding session",
    "Permission mode continues to reset when a new session starts"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": "startNew",
      "note": "Previously removed only permissionMode before starting a session."
    },
    {
      "path": "public/app.js",
      "symbol": "selectProject",
      "note": "Cleared all overrides only when the selected project changed."
    },
    {
      "path": "public/app.js",
      "symbol": "effectiveModel",
      "note": "Read the inherited model override and exposed it as the effective model."
    },
    {
      "path": "public/app.js",
      "symbol": "sessionOverrides",
      "note": "Placed inherited overrides into the new-session start payload."
    },
    {
      "path": "public/app.js",
      "symbol": "persistOverrides",
      "note": "Persisted inherited overrides after the new session received its identifier."
    }
  ],
  "related": [
    {
      "id": "BUG-015",
      "relation": "see_also"
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
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-006-new-same-project-session-silently-inherits-t.md",
    "sha256": "363c0f179bcb2f9085a439884e2991aba791edc8c01a5b69a4668e1edbbc5d79",
    "bytes": 6707,
    "original_title": "New same-project session silently inherits the previous session's model/effort/budget overrides",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the supplied ticket: the symptom, source trace, affected settings, reset contract, fix direction, scope, and recorded checks are preserved.",
    "dropped": []
  }
}
```

# BUG-006 — New sessions inherited earlier session settings

## Diagnosis

Starting another session in the same project did not trigger the full override reset performed when switching projects. `startNew` deleted only `state.overrides.permissionMode`, leaving model, effort, budget, and tool overrides available to the new session. Those values then affected the interface, entered the start payload, and were persisted under the new session identifier.

## Evidence

The source trace showed `selectProject` clearing overrides only when the project identifier changed, while `startNew` removed only `permissionMode`. Consequently, an existing model override remained visible through `effectiveModel`, marked the model button as set, and entered the payload through `sessionOverrides`. Type checking completed cleanly. The record names `verify:new-session-overrides`, `verify:overrides`, and `verify:ui` without recording outcomes for those suites.

## Implementation notes

Clear the complete `state.overrides` map when starting a new session, matching the reset used for a project change. This prevents model, effort, maximum budget, allowed-tool, and disallowed-tool values from crossing the session boundary.

## Verification plan

Start with non-default model, effort, budget, and tool settings, then create another session in the same project. Confirm the interface shows project defaults, the start payload omits inherited overrides, and the new session does not persist them. Exercise project switching and permission-mode reset for regressions.

## Migration and rollback

No data migration is required because the change affects construction of future sessions. Rollback restores the earlier reset behavior but also restores silent override inheritance.

## Risks

Code that intentionally relied on same-project sessions inheriting temporary overrides would change behavior. The stated contract requires project defaults, so such reliance would reflect the defect rather than supported behavior.

## Activity log (APPEND-ONLY)

### 2026-08-03 — bug-hunt (read-only hunter)
- **Understood:** Clicking "+" (New session) on the SAME project starts a session that still carries the prior session's model/effort/maxBudgetUsd/allowedTools/disallowedTools override. The model button shows "set" and the start payload applies it, violating the code's own contract that a new session starts from the project default. Only permissionMode is honestly reset.
- **Verified:** diagnosis traced against source (see Repro); NOT yet reproduced with a running test.
- **Handoff:** In startNew, clear the whole state.overrides map (as selectProject does on project change), not just permissionMode, so a new session always begins at project default.

### 2026-08-04 — fixing agent
- **Understood:** confirmed the hunter's trace against current source (line numbers shifted slightly to ~2872 `selectProject` / ~2880 `startNew`, but the bug is identical): `startNew` deleted only `state.overrides.permissionMode`, so `model`/`effort`/`maxBudgetUsd`/`allowedTools`/`disallowedTools` survived a same-project "+"-click into the new session, got embedded in `sessionOverrides()`'s start payload, and once session-init named the new id, `persistOverrides()` wrote the leak into the new session's own persisted-override entry.
- **Changed:** `public/app.js`
  - `startNew` (was ~app.js:2880): replaced `delete state.overrides.permissionMode;` with a full-map clear — `for (const k of Object.keys(state.overrides)) delete state.overrides[k];` — matching the comment above `OVR_KEY` (line ~270: "startNew still starts clean, always") and mirroring how `selectProject` already clears on project change.
  - Also call `paintModelBtn()` and `paintModelPop()` right after `paintCrown()` in `startNew`, so the model button stops reading "set" and the popover's radio state repaints immediately — `paintCrown()` alone only repaints the permission chip (`paintPerm()`), not the model affordance.
  - Exposed `persistOverrides`, `paintModelBtn`, `paintModelPop`, `sessionOverrides` on `window.__station` (was only `state, drawer, api, loadSessions, renderTree, onEvent, startTurn, viewAgent, showThread, backToMain, applyAppend, refreshLive, menu, visibleSessions, rowTitle`) purely so a verify script can arm/inspect overrides through the app's real functions instead of poking `state` directly and skipping the paint/persist contract.
  - Checked every caller of `startNew` (sidebar `+` click, session-delete-of-current fallback at ~line 1296, `#newBtn` click, and `applyRoute`'s "route names a project but no session" branch) — none relies on `startNew` preserving any override; all four are cases where an honest, un-overridden new session is exactly the correct behavior.
  - Did NOT touch `public/lib/drawer.js` — another agent had it in flight; no drawer.js change was needed for this fix.
- **Added:** `scripts/verify-new-session-overrides.mjs` + `verify:new-session-overrides` npm script (spawns its own scratch server on a free port + headless brave, never touches :4317). It opens a real fixture session, arms `state.overrides = { model: 'haiku', effort: 'high', allowedTools: ['Bash'] }` through the app's own `persistOverrides`/`paintModelBtn` (same functions the model popover's click handler calls), clicks the sidebar "+" on the SAME project, and asserts: new session has `sessionId === null`, `state.overrides` is `{}`, `#modelBtn.dataset.set !== 'true'`, and `sessionOverrides()` (the literal start-payload builder) returns `undefined`/empty.
- **Verified:**
  - Confirmed the test FAILS on the pre-fix behavior: temporarily reverted `startNew`'s override-clear to `delete state.overrides.permissionMode;` only (test file's own `TEMP-REVERT-FOR-VERIFY` comment, since reverted back) → `node scripts/verify-new-session-overrides.mjs` → **3 FAIL** (`state.overrides` leaked `{"model":"haiku","effort":"high","allowedTools":["Bash"]}`, model button still `set:"true"`, `sessionOverrides()` returned the same leaked object).
  - After restoring the real fix: `npm run verify:new-session-overrides` → **PASS — 5 passed, 0 failed**.
  - `npm run verify:overrides` → **4 passed, 1 failed** — the 1 failure ("armed-not-live shows an explicit PENDING state") is PRE-EXISTING: reproduced identically on a clean `git stash` of my changes (i.e., present on `main` before this fix), unrelated to BUG-006/startNew, not a regression I introduced. The BUG-006-relevant case in that same suite ("startNew: toggle off, no permissionMode override") PASSES.
  - `npm run verify:ui -- --offline` → **PASS — 3 passed, 0 failed**.
  - `npm run typecheck` → **PASS** (no errors).
- **Scope check:** edited only `public/app.js`, `scripts/verify-new-session-overrides.mjs` (new), `package.json` (added the npm script), and this ticket. Did not edit `INDEX.md`. Did not touch `public/lib/drawer.js`. Did not commit.
