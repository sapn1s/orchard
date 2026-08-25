```orchard-ticket
{
  "id": "BUG-004",
  "type": "bug",
  "title": "Reloading replaced live conversation with an old agent summary",
  "summary": "Reloaded sessions now remain live during quiet periods when their bridge is still connected. Previously, historical agent activity appeared at the conversation tail and made an ongoing session look finished. Tests covered summary placement, live reload behavior, and the user interface.",
  "impact_if_we_wait": "A regression would make ongoing sessions appear finished after reload, confusing people about current activity. Bounded: this affects conversation display correctness, not transcript data or session execution.",
  "current_need": "Treat the ticket as closed: the idle live-session case passed with a real turn, all targeted checks passed, and type checking stayed clean.",
  "severity": "high",
  "area": "Live conversation display",
  "reported": "2026-08-03",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Reloading an idle session with a connected bridge preserves its live presentation",
    "Historical agent summaries do not appear at the streaming tail of live sessions",
    "Live state remains accurate when recent file activity is absent"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": "openSession",
      "note": "Checks live session state before appending recorded agent activity."
    },
    {
      "path": "public/app.js",
      "symbol": "liveRecordFor",
      "note": "Combines recent file activity with connected bridge presence."
    },
    {
      "path": "public/app.js",
      "symbol": "loadRecordedAgents",
      "note": "Loads historical agent activity for transcript rendering."
    },
    {
      "path": "public/app.js",
      "symbol": "refreshLive",
      "note": "Refreshes live state used by conversation following."
    },
    {
      "path": "src/server/watcher.ts",
      "symbol": "liveSessions",
      "note": "Provides file-activity-based liveness within the configured window."
    },
    {
      "path": "src/server/index.ts",
      "symbol": null,
      "note": "Exposes live bridge sessions independently of file modification time."
    }
  ],
  "related": [
    {
      "id": "BUG-014",
      "relation": "see_also"
    },
    {
      "id": "BUG-017",
      "relation": "see_also"
    },
    {
      "id": "BUG-020",
      "relation": "see_also"
    },
    {
      "id": "BUG-030",
      "relation": "see_also"
    },
    {
      "id": "BUG-033",
      "relation": "see_also"
    },
    {
      "id": "DEPLOY-003",
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
    "archived_path": "docs/bugs/archive/BUG-004-reload-shows-agent-summary.md",
    "sha256": "7ca77fe29ba568cd5029bfb91fe0fbdf840a044e6f5f9480c2dba734026c15a4",
    "bytes": 9056,
    "original_title": "Reloading shows the \"agents ran\" summary instead of the live conversation",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the supplied ticket and extracted evidence; the symptom, idle-bridge cause, implemented liveness rule, deployment caveat, and executed checks are preserved.",
    "dropped": [
      "The specific historical sub-agent task shown during reproduction"
    ]
  }
}
```

# BUG-004 — Reloading replaced live conversation with an old agent summary

## Diagnosis

Reload handling treated recent transcript file activity as the decisive signal of liveness. A connected session could be quiet for more than 30 seconds, fall outside that window, and receive its historical agent stack at the current tail. The display then resembled completed history despite the bridge remaining active.

## Evidence

`verify:agent-summary`, `verify:reload-live`, and `verify:ui` each passed 3/3. The bridge-connected but file-idle case was exercised with a real turn, and `typecheck` was clean. `verify:agent-summary-bridge` was named in the record, but no execution result was recorded for it.

## Implementation notes

`openSession` now determines liveness from the union of recent file activity and a matching live bridge before adding the recorded-agent stack. Bridge presence comes from the sessions endpoint by session identifier, independently of transcript modification time.

## Verification plan

Keep coverage for reloading a bridge-connected session after more than 30 seconds without transcript writes. Confirm the session remains busy or following and historical agent activity stays out of the streaming tail.

## Migration and rollback

Deployment checks must confirm the running service exposes the bridge fields expected by the client. An older service on port 4317 previously invalidated assumptions made during earlier attempts.

## Risks

A stale bridge record could keep a completed session looking live. A missing bridge record could restore the original symptom during quiet periods.

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
