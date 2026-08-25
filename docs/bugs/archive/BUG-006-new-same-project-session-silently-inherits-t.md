# BUG-006 — New same-project session silently inherits the previous session's model/effort/budget overrides

- **Status:** VERIFIED
- **Severity:** high
- **Area:** composer-perms / per-session overrides
- **Reported:** 2026-08-03 by bug-hunt workflow

## Symptom
Clicking "+" (New session) on the SAME project starts a session that still carries the prior session's model/effort/maxBudgetUsd/allowedTools/disallowedTools override. The model button shows "set" and the start payload applies it, violating the code's own contract that a new session starts from the project default. Only permissionMode is honestly reset.

## Repro
Verified in source. 1) In a session of project P, pick model=haiku -> state.overrides.model='haiku'. 2) Click sidebar "+" -> startNew(p.id) (app.js:2846). 3) selectProject clears overrides ONLY when projectId changes (app.js:2839-2841); same project => no clear. 4) startNew deletes only state.overrides.permissionMode (app.js:2851). 5) state.overrides.model still 'haiku' => effectiveModel returns haiku, modelBtn.dataset.set=true, sessionOverrides() puts model='haiku' into the start payload; once session-init names the new id, persistOverrides writes the leaked override to it.

## Expected
Honest, correct behavior — see fix direction.

## Context pack
- Suspect file(s): public/app.js:2846 (startNew) + :2839 (selectProject clears only on project change)
- Fix direction: In startNew, clear the whole state.overrides map (as selectProject does on project change), not just permissionMode, so a new session always begins at project default.
- Touches: FRONTEND (public/app.js or drawer.js) — serialize with other frontend tickets
- Related: none
- Repro test: none yet — the fixing agent MUST add a verify script that FAILS on current code and passes after.

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
