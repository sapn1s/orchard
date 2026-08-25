```orchard-ticket
{
  "id": "BUG-001",
  "type": "bug",
  "title": "Skip-permissions resets for followed sessions",
  "summary": "A followed session unexpectedly showed skip-permissions as off after previously being on. The completed work addressed persistence and honest presentation when the dashboard cannot change a terminal-driven session. Type checking ran cleanly; the named behavior suites have no recorded results.",
  "impact_if_we_wait": "A recurrence could mislead users about whether permissions are being skipped. Bounded: this affects permission-control display and override persistence for followed sessions, not session data or terminal-controlled permission state.",
  "current_need": "Treat the work as complete: type checking ran cleanly, while the named behavior suites were mentioned without recorded results.",
  "severity": "medium",
  "area": "Followed session permissions",
  "reported": "2026-08-03",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Skip-permissions remains consistent after reloading the same followed session",
    "The composer does not imply control over a terminal-driven session when no dashboard bridge exists",
    "A followed-session test confirms the displayed state before and after reload"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "FEAT-005",
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
    "Migration and rollback": false,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-001-skip-perms-followed-session.md",
    "sha256": "fe523656f2804aeb9f165c54de297ccf3ff54bd670d4b312be338747ff04ef9f",
    "bytes": 6543,
    "original_title": "Skip-permissions state wrong / resets for a followed session",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the archived ticket; the symptom, followed-session conditions, persistence requirement, honest-display requirement, investigation targets, and requested test remain represented.",
    "dropped": []
  }
}
```

# BUG-001 — Skip-permissions resets for followed sessions

## Diagnosis

For a terminal-driven session, the dashboard only follows the session file. There is no dashboard bridge, `state.live` is false, no `session-init` occurs, and `state.effective` is null. The relevant investigation covered `setPermissionMode`, `toggleSkip`, `effectivePerm`, `persistOverrides`, `restoreOverrides`, `paintPerm`, `openSession`, `liveRecordFor`, and `followingLive`.

## Evidence

The user reported the unexpected state on 2026-08-03. Type checking was reported clean. `verify:agent-summary`, `verify:skip-perms-followed`, `verify:overrides`, and `verify:ui` were named, but no execution results were recorded.

## Implementation notes

Overrides are keyed by `encodedDir + sessionId` and should persist for the same session. When no bridge can send `set-permission-mode`, the composer must not present an armed toggle as immediately effective. The recorded alternatives were disabling the control with an explanation or applying it clearly to the next dashboard-driven turn.

## Verification plan

Create a live-by-mtime followed-session fixture with `drivenByDashboard:false`. Toggle skip-permissions, reload, and assert that persistence and displayed effectiveness are honest. Capture the composer before and after using `assets/BUG-001-*.png`.

## Risks

Persisting an override without explaining its limited effect could preserve a misleading state. Disabling the control too broadly could prevent valid configuration for a later dashboard-driven turn.

## Activity log (append-only)

### 2026-08-04 — subagent (app.js)
**Understood:** the two requirements — (1) armed skip/plan state must survive
reload for the SAME followed session, keyed by `encodedDir+sessionId`; (2) the
toggle must never claim a live effect it cannot have on a terminal-driven,
no-bridge session.

**Found (before writing any fix):** both were **already implemented** on `main`
— `state.followingExternal` (set in `openSession` at the point `liveRecordFor`
resolves `drivenByDashboard:false`, public/app.js ~L2842-2851) plus the
`external` branch in `paintPerm()` (~L1524-1568) and the `scope` branch in
`setPermissionMode()`'s not-live path (~L1622-1628) together implement exactly
the "apply-next-turn, clearly honest" option this ticket recommends as
fallback: the toggle arms `state.overrides.permissionMode`, calls
`persistOverrides()` unconditionally (not gated on live/bridge status), and
every surface — button title, `data-external` attr, seal chip text/title, and
the toast from `setPermissionMode` — says "armed; applies ONLY if you take
over this session from the dashboard", never "confirmed"/a bare "from next
send" that would imply the running terminal session changed. `resetTranscript`
clears `followingExternal` per session-switch and `openSession` re-derives it
fresh from the live liveness check on every open (including a real reload),
so nothing goes stale.
I traced this to `ce884c7` (armed-pending chip) + `fac75a9` (the
`followingExternal` honesty layer, bundled oddly into a "Bug tracker v2" doc
commit) — both already on `main` before this ticket was dispatched. No app.js
edit was needed; this ticket's job became verification-only, per the WORKING
AGREEMENT rule that a check that never actually exercises the bug is worse
than none.

**Changed:** no app.js code (none was needed — see above). Added
`scripts/verify-skip-perms-followed.mjs` (+ `npm run verify:skip-perms-followed`
in `package.json`) — real Brave/CDP browser test against a FOLLOWED/external
fixture (session file "live" purely by mtime recency, `drivenByDashboard:false`,
no bridge — same pattern as `verify-agent-summary.mjs`). It arms the toggle,
asserts every honesty surface (title, `data-external`, seal chip + its title,
toast), reloads (full `Page.navigate`, equivalent to Ctrl+Shift+R for this
hash-routed SPA) and re-asserts persistence + continued honesty, then disarms
and re-asserts that persists too. Screenshots →
`docs/bugs/assets/BUG-001-followed-{before,armed,after-reload}.png`.

**Verified:**
- Proved the test is not vacuous: temporarily checked out `public/app.js` as of
  `dedfc72` (the commit immediately before `fac75a9` introduced
  `followingExternal`) and re-ran the new script — **3 passed, 5 failed**,
  reproducing exactly the bug this ticket describes (chip said "from next
  send", toast said "applies when this session starts", no `data-external`,
  `followingExternal` never became true). Restored `public/app.js` from a
  pre-copy afterward; `git diff --stat public/app.js` confirmed byte-identical
  restore (no diff).
- `npm run verify:skip-perms-followed` → **8 passed, 0 failed** (current code).
- `npm run verify:overrides` → **4 passed, 1 failed** — the 1 failure is the
  pre-existing, independently-tracked `BUG-015` ("armed-not-live … from next
  send" chip-text assertion is stale now that an armed-but-recently-written
  fixture session can read as external-live by mtime) — confirmed unrelated to
  this ticket: no app.js diff exists from my work, and BUG-015 predates this
  session per its own log. Not a regression I introduced.
- `npm run verify:ui -- --offline` → **3 passed, 0 failed**.
- `npm run typecheck` → clean, no errors.

**Honesty decision:** kept the existing "apply-next-turn, clearly marked"
design (ticket's fallback option) rather than switching to disable+explain —
it was already implemented, tested now-passing, and disabling would be a
regression (arming a takeover for later is strictly more useful than a
disabled control, and every surface already says plainly that it only takes
effect on takeover).

**Status:** VERIFIED. Nothing open for this ticket. `BUG-015` remains open
separately for the pre-existing chip-text/mtime interaction.
