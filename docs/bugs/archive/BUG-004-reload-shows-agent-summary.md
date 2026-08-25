# BUG-004 — Reloading shows the "agents ran" summary instead of the live conversation

- **Status:** VERIFIED (attempt 4 — liveness is now the UNION of mtime + live bridge; bridge-idle case proven with a real turn)
- **Severity:** high
- **Area:** transcript rendering / live detection / openSession
- **Reported:** 2026-08-03 by user

## Symptom
> "if i reload page it shows summary of what agents ran instead of as if continuing the convo"

On reload, the historical "N agents ran in this session" stack is rendered at
the current tail — a turn-1 sub-agent ("Fix stale Example-App permissionMode")
appears as if it just finished, and the session reads as ended history rather
than a live conversation still in progress.

## Repro
1. A session that IS still live (its bridge is on 4317 — currently claude-station
   itself owns this session; the launching terminal has been closed).
2. Be idle for >30s (thinking, between writes to the jsonl).
3. Reload the page. The agent summary appears at the tail; not treated as live.

## Expected
A still-running session, on reopen, must reflect that it is live (busy/following)
and NOT dump the historical agent summary into the streaming tail.

## Context pack
- Files/functions: `public/app.js` — `openSession` (the `liveRecordFor` gate
  before the agent block), `liveRecordFor`, `loadRecordedAgents`/`ranStack`
  (appends into `claudeBody`), `refreshLive`, `state.followingLive`.
- Server: `/api/sessions/live` (`watcher.liveSessions(windowMs)` — MTIME based,
  `LIVE_WINDOW_MS = 30_000`) vs `/api/sessions` (lists live BRIDGES by
  `sdkSessionId`, independent of mtime). `src/server/watcher.ts`,
  `src/server/index.ts`.
- Related: DEPLOY-003 (server on 4317 is stale — some earlier attempts assumed
  server fields the running process never sends).
- Repro test: `npm run verify:agent-summary` (external-session fixture). It
  passes, but does NOT cover the "bridge-driven but mtime-idle" case — see
  handoff.

## Activity log (APPEND-ONLY)

### 2026-08-03 — attempt 1 (commit 9c44048)
- **Understood:** `loadRecordedAgents` appends the summary into `claudeBody`,
  which on a live session is the streaming turn.
- **Changed:** gated the summary on the session being a **busy** dashboard
  bridge (`/api/sessions/live` `busy` field).
- **Verified:** verify:reload-live passed (a busy dashboard session).
- **Why it fell short:** the running server on 4317 is old and never sends the
  `busy` field, so the gate never fired in the user's environment.

### 2026-08-03 — attempt 2 (commit affe6e2)
- **Changed:** gated on `drivenByDashboard` (a field every server version sends)
  instead of `busy`.
- **Why it fell short:** the session was driven by the user's TERMINAL then, so
  `drivenByDashboard` was false — the gate skipped it.

### 2026-08-03 — attempt 3 (commit c50af3f)
- **Understood:** the session is external (terminal-driven, file-followed).
- **Changed:** gated on mere presence in the live list (`liveRecordFor` returns
  any record for the sessionId), regardless of `drivenByDashboard`/`busy`.
  Added `verify:agent-summary` (external fixture, idle vs freshly-touched).
- **Verified:** verify:agent-summary 3/3, verify:reload-live 3/3, verify:ui 3/3.
- **Why it STILL falls short (attempt-4 insight):** `/api/sessions/live` is
  MTIME-based (`LIVE_WINDOW_MS = 30s`). The session is now owned by
  claude-station's bridge (terminal closed, `liveBridges: 1`), but when idle
  >30s the jsonl isn't written, so the session drops out of the mtime "live"
  list → `liveRecordFor` returns null → summary shows. The fixture touches the
  file to now, so it never exercised the idle case.

### <next agent — HANDOFF>
- **Try:** detect liveness via the live **BRIDGE**, not mtime. `/api/sessions`
  lists all live bridges by `sdkSessionId` regardless of file recency (and
  `/api/health` exposes `liveBridges`). In `liveRecordFor` (or a new helper),
  treat the session as live if a bridge exists for its sdk id, OR it is in the
  mtime live list — union of both signals. A bridge-driven-but-idle session must
  count as live.
- **Also cover:** widen `verify:agent-summary` (or a new test) with the
  bridge-driven-idle case — a session with a live bridge but a STALE file mtime
  must still suppress the summary. This is the case all 3 prior attempts missed.
- **Watch:** don't over-suppress — a genuinely finished/idle session (no bridge,
  stale file) MUST still show the summary (that's the review view). Keep
  verify:agent-summary's "idle session shows summary" assertion green.

### 2026-08-04 — attempt 4 (VERIFIED) — union of mtime + live bridge
- **Understood:** implemented the handoff. `/api/sessions/live` is mtime-based
  (`LIVE_WINDOW_MS = 30s`); a session still owned by claude-station's own bridge
  but idle >30s (not writing its jsonl) drops out of that list, so `liveRecordFor`
  returned null and `openSession` treated it as finished history → dumped the
  "N agents ran" summary into the streaming tail. The bridge registry
  (`/api/sessions`, live bridges by `sdkSessionId`, see agent-bridge.ts
  `liveSessions()` = `!closed`) is mtime-independent and is the missing signal.
  Also learned: a DETACHED idle bridge self-closes ~3s after its turn ends
  (agent-bridge.ts ~L1080), but an ATTACHED idle bridge stays open — which is
  what makes an honest bridge-idle test constructible.
- **Changed (working tree, not committed):**
  - `public/lib/api.js` — new `liveBridges()` helper: `GET /api/sessions` →
    `[{ sdkSessionId, stationSessionId, busy }]` (null when route absent).
  - `public/app.js` `liveRecordFor` — liveness is now the UNION: return the mtime
    record if present (authoritative, already carries drivenByDashboard/busy),
    ELSE if a live bridge exists for the sdk id return a synthetic live record
    `{ drivenByDashboard: true, busy: bridge.busy }` (a bridge IS this dashboard's
    server owning the session → reattachable framing). Neither signal → null →
    summary still shows (review view preserved).
  - `public/app.js` `refreshLive` — the follow-teardown was ALSO mtime-blind: it
    flipped `followingLive` off for any followed session not `drivenByDashboard&&busy`
    in the mtime list, which tore down the live/following state for a bridge-idle
    session ~1 tick after open. Now it only declares the run over when NEITHER the
    mtime list (busy) NOR a live bridge owns the session (on error it keeps
    following rather than falsely finish).
  - `scripts/verify-agent-summary-bridge.mjs` (new) + `package.json`
    `verify:agent-summary-bridge` — the case all 3 prior attempts missed, built
    honestly: Tab A starts a REAL cheap-haiku turn (real bridge + real sdk id) and
    stays ATTACHED so the bridge lingers idle; a recorded sub-agent is injected so
    a summary CAN render; the jsonl mtime is aged to 120s (API-asserted OUT of the
    mtime live list, still IN the bridge list); Tab B reopens the session and must
    suppress the summary via the bridge half of the union.
- **Verified (all on scratch servers/free ports; port 4317 untouched):**
  - `npm run verify:agent-summary-bridge` → **5 passed, 0 failed** — incl.
    `precondition: the idle session has DROPPED OUT of the mtime live list`,
    `precondition: a LIVE BRIDGE still owns this session`,
    `BRIDGE-IDLE, STALE-FILE session does NOT get the historical agent summary dumped in`
    (`ranStacks:0`), and `reflected as live/following (bridge detected via UNION;
    survives refreshLive teardown)` (`followingLive:true`).
  - `npm run verify:agent-summary` → **3 passed, 0 failed** — the
    anti-over-suppression guard stays green (idle session STILL shows the summary;
    external-live still suppressed).
  - `npm run verify:reload-live` → **3 passed, 0 failed** — the refreshLive change
    did not regress the mid-turn reload; still `flips to idle honestly once the run
    finishes`.
  - `npm run verify:ui -- --offline` → **3 passed, 0 failed**.
  - `npm run typecheck` → clean.
  - Screenshot: `docs/bugs/assets/BUG-004-after.png` — reopened bridge-idle session
    shows the live PONG conversation with NO stray "agents ran" summary.
- **Note on the assertion:** the transient "still running — following live" `#fine`
  line is overwritten within a poll by the idle project repaint (bridge not busy),
  so the test asserts the DURABLE signal `state.followingLive === true` — which is
  set ONLY in openSession's `liveRec.drivenByDashboard` branch, i.e. it is proof
  the bridge was detected as live AND framed as reattachable.
- **Still open / handoff:** none for this symptom. Sibling BUG-014 (deep-index
  restore injects the summary via the `th.gap` path) is a DIFFERENT code path and
  is out of scope here — its own ticket. Not committed (per rules); orchestrator
  reviews the diff + this evidence.

- 2026-08-06 — privacy scrub for public release (FEAT-049, sanctioned append-only exception): private names/paths neutralized (project aliases, home paths → ~).
