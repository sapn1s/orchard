# BUG-001 — Skip-permissions state wrong / resets for a followed session

- **Status:** VERIFIED
- **Severity:** medium
- **Area:** composer / permission toggle / override persistence
- **Reported:** 2026-08-03 by user

## Symptom
> "permission skipped turned off for this session idk if u reset anything … or it may be my mistake idk if bug"

User had skip-permissions ON for the session they were viewing; it showed as
OFF later, unexpectedly.

## Repro (to establish)
The session in question is driven by the user's **terminal**, and the dashboard
only file-follows it (no dashboard bridge → `state.live === false`, no
`session-init`, `state.effective === null`). Reproduce:
1. Open a session the dashboard does NOT drive (external/terminal-driven, shows
   the "written live by another process" follow state).
2. Toggle skip-permissions ON in the composer tray.
3. Reload (Ctrl+Shift+R). Observe whether the toggle state survives, and whether
   it ever meant anything for the terminal session.

## Expected
Two things must be honest:
1. The toggle state persists across reload for the SAME session (the
   `persistOverrides`/`restoreOverrides` machinery, keyed by
   `encodedDir + sessionId`, was added for exactly this — verify it also covers
   the followed-session path).
2. If the dashboard skip toggle CANNOT actually change the permission mode of a
   terminal-driven session (no bridge to send `set-permission-mode` to), the UI
   must not present it as if it did — an armed toggle that silently affects
   nothing is the app's cardinal sin. Either disable/explain it for followed
   sessions, or make it apply on the next dashboard-driven turn only, clearly.

## Diagnosis
_(subagent)_ Study: `setPermissionMode`, `toggleSkip`, `effectivePerm`,
`persistOverrides`/`restoreOverrides`, `paintPerm`, and how `openSession` +
`liveRecordFor`/`followingLive` interact for a session with no bridge.

## Fix
_(subagent)_

## Verification
_(subagent — REQUIRED)_ A real test: a followed/external session (build a
fixture like `verify-agent-summary.mjs` uses — a session file that is "live" by
mtime, drivenByDashboard:false), toggle skip, reload, assert the state is
honest. Screenshot the composer state before/after.

## Screenshots
`assets/BUG-001-*.png`

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
