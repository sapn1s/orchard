```orchard-ticket
{
  "id": "BUG-010",
  "type": "bug",
  "title": "Session settings hid edits and changed the next session",
  "summary": "Session-scoped settings now display pending edits and let the revert control track local overrides. Previously, live rows appeared unchanged while silently saving those edits for the next session. The standing typecheck completed cleanly.",
  "impact_if_we_wait": "The old behavior could launch the next session with settings the user never saw applied. Bounded: this affected settings display and next-session configuration, not stored user data or the active session.",
  "current_need": "Keep the completed correction closed: typecheck ran clean; the named session, interface, memory, process, and override suites were only proposed.",
  "severity": "medium",
  "area": "Session settings",
  "reported": "2026-08-03",
  "reported_by": "bug-hunt workflow",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Session-scoped rows immediately display edits made while a session is running",
    "Edited rows lose their inherited marker and show a working revert control",
    "Reverting removes the pending override and restores the effective value",
    "The next session receives only overrides still visible in session settings"
  ],
  "code_refs": [
    {
      "path": "public/lib/drawer.js",
      "symbol": "val",
      "note": "Previously read the active effective value without layering pending session overrides"
    },
    {
      "path": "public/lib/drawer.js",
      "symbol": "overriddenNow",
      "note": "Controls inherited markers and revert visibility for pending overrides"
    },
    {
      "path": "public/lib/drawer.js",
      "symbol": "put",
      "note": "Writes edits to the session override stack"
    },
    {
      "path": "public/lib/drawer.js",
      "symbol": null,
      "note": "Row rebuilding was identified around lines 174 and 207"
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
    "archived_path": "docs/bugs/archive/BUG-010-this-session--settings-rows-are-inert-while.md",
    "sha256": "e5b050cc5deefae6569f4d9220ee8b59f769000c76ece4584e645c9af257a4de",
    "bytes": 7862,
    "original_title": "'This session' settings rows are inert while a session is live (and silently mis-set the next session)",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared line by line against archived BUG-010; the symptom, next-session effect, diagnosis, correction direction, code references, and recorded check remain present.",
    "dropped": []
  }
}
```

# BUG-010 — Session settings hid edits and changed the next session

## Diagnosis

While a session was active, `val()` rebuilt each row from `live.effective`. It ignored a newly written value in `ctx.overrides`. `overriddenNow()` likewise failed to recognize the pending local override, leaving the inherited marker visible and the revert control ineffective. Session creation later consumed the hidden override.

## Evidence

Cycling Model, Effort, Spend cap, or Permission mode left the displayed value unchanged. Allowed and Disallowed tools snapped back on blur. Starting another session then applied the silently stored override. After correction, the standing `typecheck` was reported clean.

## Implementation notes

In This session scope, layer pending `ctx.overrides` over `live.effective` when reading values and determining whether a field is overridden. Keep the frontend change serialized with other frontend work.

## Verification plan

The suites `verify:session-scope`, `verify:ui`, `verify:memories`, `verify:processes`, and `verify:overrides` were named without recorded results, so they must not be treated as executed runs. Exercise edits and reverts during a live session, then confirm the next session receives only visible remaining overrides.

## Migration and rollback

No data migration is required. Rollback can restore the earlier drawer value resolution, but doing so restores the misleading display and hidden next-session override behavior.

## Risks

Incorrect override layering could hide inherited values, preserve a reverted override, or change settings outside This session scope.

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
