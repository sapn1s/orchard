# BUG-011 — Switching sessions from inside a subagent thread stamps a stale agent= into the new session's URL

- **Status:** VERIFIED
- **Severity:** medium
- **Area:** routing-transcript
- **Reported:** 2026-08-03 by bug-hunt workflow

## Symptom
Opening session B (sidebar click) while viewing a subagent thread of session A writes B's history entry as ?agent=<A's agent id>. Reloading or Back/Forward then shows a false 'This link names an agent thread not recorded in this session' warning and drops the user on main — the app corrupts its own link.

## Repro
1) Open session A, click into a recorded subagent thread (state.viewing=agentX, URL .../session/A?agent=agentX). 2) Click session B. openSession runs syncUrl('push') at :2701 BEFORE resetTranscript() at :2705 resets state.viewing to 'main', so currentRoute() (:4694) still reads agent=agentX and pushes .../session/B?agent=agentX. 3) Reload before any scroll (nothing replace-syncs to self-heal): applyRoute opens B, agentX not in B's agents, openSession hits :2773-2774 warning.

## Expected
Honest, correct behavior — see fix direction.

## Context pack
- Suspect file(s): public/app.js:2701 (syncUrl('push') runs before resetTranscript clears state.viewing)
- Fix direction: Reset state.viewing to 'main' (or move the syncUrl('push') to after resetTranscript) before pushing the new session's URL so a stale agent= is never captured.
- Touches: FRONTEND (public/app.js or drawer.js) — serialize with other frontend tickets
- Related: none
- Repro test: none yet — the fixing agent MUST add a verify script that FAILS on current code and passes after.

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
