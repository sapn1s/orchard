# BUG-010 — 'This session' settings rows are inert while a session is live (and silently mis-set the next session)

- **Status:** VERIFIED
- **Severity:** medium
- **Area:** drawer-settings / session-scope overrides
- **Reported:** 2026-08-03 by bug-hunt workflow

## Symptom
With the settings drawer in 'This session' scope while a session runs, cycling Model/Effort/Spend cap/Permission mode or typing into Allowed/Disallowed tools shows no change — rows keep their value and 'inherited' tag, tool inputs snap back on blur. The control looks live but appears dead, yet the value IS written to the session-override stack, so the NEXT session silently launches with an override the user never saw themselves set.

## Repro
1) Attach to a session so state.effective is populated. 2) Open cog drawer, toggle scope to 'This session'. 3) Cycle Model or type a tool + blur. Display never changes because paint rebuilds each row from val('model') which returns l.effective.model; if live.overridden didn't already include the field the row still reads 'inherited', and the revert arrow (shown only when live.overridden includes it) does nothing since isOvr stays true after delete ctx.overrides[field]. 4) Start a new session from the project -> sessionOverrides()/startTemplateIds pick up the silently-recorded ctx.overrides.

## Expected
Honest, correct behavior — see fix direction.

## Context pack
- Suspect file(s): public/lib/drawer.js:123 (val) / :118 (overriddenNow) / :131 (put) / :174 & :207 (row rebuild)
- Fix direction: In 'This session' scope, have val()/overriddenNow read from the pending ctx.overrides layered over live.effective (not raw live.effective), so rows reflect just-made edits and the revert arrow tracks local overrides.
- Touches: FRONTEND (public/app.js or drawer.js) — serialize with other frontend tickets
- Related: none
- Repro test: none yet — the fixing agent MUST add a verify script that FAILS on current code and passes after.

## Activity log (APPEND-ONLY)

### 2026-08-03 — bug-hunt (read-only hunter)
- **Understood:** With the settings drawer in 'This session' scope while a session runs, cycling Model/Effort/Spend cap/Permission mode or typing into Allowed/Disallowed tools shows no change — rows keep their value and 'inherited' tag, tool inputs snap back on blur. The control looks live but appears dead, yet the value IS written to the session-override stack, so the NEXT session silently launches with an override the user never saw themselves set.
- **Verified:** diagnosis traced against source (see Repro); NOT yet reproduced with a running test.
- **Handoff:** In 'This session' scope, have val()/overriddenNow read from the pending ctx.overrides layered over live.effective (not raw live.effective), so rows reflect just-made edits and the revert arrow tracks local overrides.

### 2026-08-04 — fixing agent (drawer.js only)
- **Understood:** confirmed the root cause exactly as diagnosed. `val(field)` checked `live.effective` BEFORE `ctx.overrides`, so once a session was live and its effective-config report included a field (which it always does for the WIRED_IN_SESSION fields), a fresh local edit written into `ctx.overrides` by `put()` was invisible on repaint — `val()` kept returning the stale server-reported value. `overriddenNow(field)` had the same ordering bug: it checked `live.overridden` (the server's own report) before `field in ctx.overrides`, so a brand-new local edit that hadn't yet round-tripped through a real session restart didn't flip the "inherited" tag to "overridden", and the revert button (only rendered when `isOvr` is true) never appeared for it — which is exactly the "revert arrow does nothing" symptom, because there was no revert arrow to click.
- **Changed:** `public/lib/drawer.js` only (per scope constraint — did NOT touch `public/app.js`; another agent was working on it, and no app.js change was needed).
  - `overriddenNow(field)`: now returns `true` immediately if `field in ctx.overrides` (a local edit always wins for the tag), and only falls back to `live.overridden.includes(field)` when there is no pending local edit.
  - `val(field)`: now returns `ctx.overrides[field]` immediately if present (pending local edit wins for display), and only falls back to `live.effective[field]`, then to `base(field)`.
  - The existing revert handler (`delete ctx.overrides[field]; paint()`) was already correct in shape — it just needed `overriddenNow`/`val` to actually notice the deletion, which they now do.
  - Left the bottom-of-view "Live session is running with X overridden…" note (drawer.js ~343-357) untouched — it already reads `live().overridden` deliberately, since that note is specifically about what the CURRENT running process was spawned with, not about pending edits.
  - Known residual edge case, NOT hit by this ticket's repro and left as-is: if a field is ALREADY in `live.overridden` (i.e. the running session was itself started with that override) and the user has made no local edit yet, `overriddenNow` still falls back to `live.overridden`, so the row shows "overridden" or with a revert button whose click (`delete ctx.overrides[field]`, a no-op since the key was never set) does nothing to the display for THIS row's tag — the live session genuinely can't un-apply an already-running override. It DOES still work correctly for the thing that matters (the NEXT session): clicking revert leaves `ctx.overrides[field]` absent, so a subsequent session start won't carry the override. If this residual is worth polishing (making the tag itself explain "session is running with the project default was overridden — reverting affects only the next session"), it's a follow-up, not required by this ticket's symptom.
- **Verified:**
  - Added `scripts/verify-session-scope.mjs` (+ `npm run verify:session-scope`) — real headless brave via CDP, a genuinely live session (project default model patched to `haiku`, one cheap `startTurn('Reply with exactly the word: ok')` so `state.effective.effective` is populated by the real server ack, not faked). Opens the drawer, switches to "This session" scope, cycles the Model row twice (haiku → inherit → opus) and separately types into "Allowed tools" + blurs.
    - Confirmed the test **FAILS on pre-fix code**: row stuck at `{"tag":"inherited","txt":"haiku","hasRevert":false}` after the cycle clicks (no revert affordance ever renders, so the follow-up revert step throws `Cannot read properties of null (reading 'click')` — reproduces "the revert arrow does nothing" as "there is no revert arrow").
    - `npm run verify:session-scope` → **10 passed, 0 failed** on the fixed code.
    - `npm run verify:ui -- --offline` → **3 passed, 0 failed**.
    - `npm run typecheck` → clean, no errors.
    - Anti-regression on other drawer-touching suites: `npm run verify:memories` → 11 passed, 0 failed; `npm run verify:processes` → 9 passed, 0 failed.
    - `npm run verify:overrides` → 4 passed, **1 pre-existing failure** ("armed-not-live shows an explicit PENDING state" expects chip text "from next send", observed "skips prompts · if you take over"). Verified this failure is **NOT caused by this fix**: it reproduces identically with `public/lib/drawer.js` reverted to its committed (pre-fix) state, and also reproduces with `public/app.js` reverted to its last-committed state (i.e. before the other in-flight agent's uncommitted WIP) — so it predates and is independent of both this ticket's change and the concurrent app.js work. Not investigated further; out of this ticket's scope (app.js/permission-mode chip wording, not session-scope drawer rows).
- **Did I touch app.js:** No. The fix is entirely within `public/lib/drawer.js` (`val`/`overriddenNow`); the existing revert-button wiring in `row()` needed no change.
- **Status → VERIFIED.**
