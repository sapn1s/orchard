```orchard-ticket
{
  "id": "BUG-027",
  "type": "bug",
  "title": "Surviving sessions disappeared from restart health reports",
  "summary": "Restart health reporting now retains sessions that survived without reconnecting to the server. Previously, both the health endpoint and doctor reported no sessions while the session host remained alive and reachable.",
  "impact_if_we_wait": "Operators could wrongly conclude that restart destroyed active work. Bounded: this affected restart status and display-correctness, not session survival or data loss; the surviving session remained alive and reachable.",
  "current_need": "Treat the ticket as closed: the restart case failed before correction, then restart and detach suites passed with standing checks clean.",
  "severity": "medium",
  "area": "Restart health reporting",
  "reported": "2026-08-05",
  "reported_by": "user",
  "owner": "you",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-05",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Health reports a session that survived restart before any client attaches",
    "Doctor names the surviving session instead of reporting no live sessions",
    "Eager reconnection, if implemented, occurs without a client attachment",
    "Existing restart and detach behavior remains intact",
    "Type checking remains clean"
  ],
  "code_refs": [
    {
      "path": "session-host.mjs",
      "symbol": null,
      "note": "The surviving broker remained alive while the restarted server lacked an attached in-memory session."
    },
    {
      "path": "/api/health",
      "symbol": "scanSurvivingHosts",
      "note": "Health must include surviving hosts even before they are attached to the restarted server."
    }
  ],
  "related": [
    {
      "id": "BUG-029",
      "relation": "see_also"
    },
    {
      "id": "BUG-035",
      "relation": "see_also"
    },
    {
      "id": "FEAT-048",
      "relation": "blocks"
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
    "archived_path": "docs/bugs/archive/BUG-027-health-under-reports-survived-host.md",
    "sha256": "e3a1ab1801b944a72145cc195466330a1c71d59cee838c13f1e137329dd5e59a",
    "bytes": 9262,
    "original_title": "/api/health (+doctor) under-reports a survived-but-unattached session after a restart",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the archived original; the restart symptom, surviving-host diagnosis, health and doctor expectations, fix direction, bounds, and required scratch-server proof are preserved above.",
    "dropped": []
  }
}
```

# BUG-027 — Surviving sessions disappeared from restart health reports

## Diagnosis

BUG-027 exposed a gap between session survival and server attachment. After restart, the broker, resumed process, scope, socket, and metadata remained present, but health listed only attached in-memory sessions. The watched host directory therefore contained a reachable survivor that health and doctor omitted.

## Evidence

The live reproduction restarted the service and repeatedly returned `sessions: []` while one surviving host remained active and reachable. The pre-fix run, with fix hunks stashed, produced **6/14**. After correction, `verify:restart-reconnect-race` passed 10/10, `verify:restart-survives` passed 15/15, and `verify:detach` passed 7/7. Another matched tally was 14/14 without an adjacent suite name. `verify:health-survivor` was named but has no recorded result, so it is not presented as executed. Typecheck was reported clean.

## Implementation notes

Health reporting must merge surviving hosts from `scanSurvivingHosts` instead of treating absence from the in-memory session collection as death. An alive but unattached survivor must remain visible, with attachment state represented separately where applicable.

## Verification plan

On a scratch server using a free port, start a driven session, restart the server, and query health before attaching a client. Assert that the survivor appears rather than `sessions: []`, doctor names it, and any eager reconnection occurs without client attachment. Retain restart, reconnect-race, detach, and typecheck coverage.

## Migration and rollback

No stored-data migration is required. If the reporting change regresses restart behavior, revert the health merge while retaining the surviving host files and processes; rollback does not destroy the session.

## Risks

A stale host record could be mistaken for a live survivor unless the scan preserves existing liveness checks. Eager reconnection could also disturb restart races or detach behavior, which is why those suites accompany the targeted scenario.

## Activity log (APPEND-ONLY)
### 2026-08-05 — orchestrator
- Found while dogfooding the deploy restart (this session survived — broker/CLI/scope all verified
  alive — but /api/health showed sessions:[]). Filed as the inverse of BUG-024's false-alarm class.
  Server-side; a fix needs its own scratch-server deploy test and (to go live) a future :4317 restart.

### 2026-08-05 — fix agent — ROOT CAUSE + FIX — VERIFIED

**Root cause (confirmed in code, not assumed).** The FEAT-040 merge DOES exist but is a
LEFT-JOIN on in-memory sessions: `/api/health` (src/server/index.ts) called
`scanSurvivingHosts()` only to build a `hostBySession` map that it then joined
onto `liveSessions().map(...)`. A survivor host whose stationSessionId matches
no live in-memory session — the exact state after every restart, since boot's
`adoptSurvivingHosts()` (index.ts, listen callback) merely SIGTERMs the broker
and the drain can run for minutes, and NO in-memory AgentSession exists until a
client resumes — was silently dropped. So `sessions: []` + doctor "No live
sessions" while broker/CLI were alive. NOT a scan miss (scan found the host in
every repro run); purely the join direction. Note also: "re-adopt" was never
lazy-on-attach either — there is NO code path that turns a survivor into a live
bridge; re-adopt = drain+reap at boot, then normal resume-from-disk (FEAT-015's
documented SDK boundary).

**Fix.**
- `src/server/index.ts` (health route, ~lines 241-271): after the live map,
  every scanned host NOT consumed by the live join is appended to `sessions[]`
  as `{ adopted: false, state: 'surviving-unadopted', stationSessionId,
  sdkSessionId (from broker-recorded id or resumeHint), survivalConfigured:
  true, survivalScoped: isCgroupScoped(hostPid) (ground truth, per-request),
  broker: { hostPid, claudePid, state, sock, updatedAt } }`. Live entries now
  carry an explicit `adopted: true`. `survival.ts` still read only via its
  existing exports; `agent-bridge.ts` untouched.
- `scripts/station-doctor.mjs`: renders `adopted`, a distinct
  "SURVIVED a restart (broker + CLI alive, NOT adopted…)" state label, a
  trailing "⚠ N surviving session host(s) … NOT adopted" summary, and the
  empty-case line is now "No live sessions and no surviving session hosts" —
  only honest because health now surfaces survivors.
- NEW `scripts/verify-health-survivor.mjs` + `package.json`
  `"verify:health-survivor"`.

**Eager re-adopt at boot: NOT built — flagged as follow-up, deliberately.**
A boot-time live reconnection is blocked by FEAT-015's documented SDK boundary
(a fresh `query({resume})` always spawns a NEW CLI; it cannot adopt the
still-running one's stream), so "eager re-adopt" could only mean a boot-time
auto-RESUME — which would race the BUG-022 guard (resume is correctly REFUSED
while the survivor drains, verify:restart-reconnect-race) and risk a second
CLI on the same transcript, and would also start turns with no client attached
(an autonomy decision, FEAT-022 territory). The drain+reap half of re-adopt is
already eager (fires in listen()). Follow-up if wanted: after the survivor
drains out of the scan, a server-initiated resume-from-disk to pre-warm the
session — needs its own drain-aware sequencing.

**Verified (scratch only; :4317 and the real unit never touched; killed by pid /
own transient units; real service confirmed answering 200 after the runs).**
- `npm run verify:health-survivor` — deploy-shaped: scratch server as its own
  transient `--user` service (KillMode=control-group) + real driven haiku
  session mid-turn, "restart" = `systemctl --user stop` + a fresh server pid on
  a new free port over the same dataDir.
  - PRE-FIX (fix hunks stashed): **6/14 — bug REPRODUCED exactly as observed
    live**: broker+CLI alive post-restart, `/api/health` `sessions: 0`, doctor
    "No live sessions right now."
  - POST-FIX: **14/14 PASS** — health lists the survivor (adopted:false,
    surviving-unadopted, honest hostPid/claudePid/state, survivalScoped:true,
    correct sdkSessionId), doctor names it, AND the reaped survivor disappears
    afterwards (no ghost entries), marker written (no lost work).
- `npm run verify:restart-survives` — **15/15 PASS** (FEAT-015 unregressed).
- `npm run verify:detach` — **7/7 PASS** on the final run. NOTE: the
  "detached bridge closed itself at the boundary" check is FLAKY under load on
  this machine — it failed intermittently BOTH with the fix AND on stashed
  baseline code (baseline: 1 pass / 1 fail), so it is environmental timing
  (30s poll window), not a regression from this change.
- `npm run verify:restart-reconnect-race` — 9/10: all BUG-022 guard checks
  PASS; the one failing check ("original turn COMPLETED — marker") is an
  ENVIRONMENT artifact of this dev machine, root-caused via transcript capture:
  an agent-harness hook here blocks the fixture's standalone `sleep 30`
  ("Blocked: standalone sleep 30…"), so the model refuses the steps and the
  turn ends in seconds — no drain bug (the same contract PASSES in
  verify:health-survivor, whose fixture uses `python3 -c 'import time;
  time.sleep(30)'` for exactly this reason, and marker lands). Handoff: if
  reconnect-race must be green on dev boxes with that hook, switch its
  driveSlowTurn to the python sleep (not done here — other ticket's file).
- `npm run typecheck` — PASS (clean).
- Hygiene: no leftover scratch brokers/scopes/units/dirs; the one live
  `claude-station-host-*` scope belongs to the real :4317 session (real
  dataDir) and was never touched.

**Go-live note.** The fix is server-side; it takes effect on :4317 at the next
deliberate deploy restart (never mid-flight per the working agreement) — at
which point doctor during the drain window should show the orchestrator's own
session as `survivor … adopted no` instead of "No live sessions".

### 2026-08-05 — BUG-028 fix agent — flagged handoff CLOSED
- The handoff above ("switch reconnect-race's driveSlowTurn to the python
  sleep") is done as part of BUG-028's pass:
  `scripts/verify-restart-reconnect-race.mjs` now uses
  `python3 -c 'import time; time.sleep(30)'` (with a comment naming why).
  `npm run verify:restart-reconnect-race` → **10/10 PASS** on this dev box
  (previously 9/10 with the environmental "original turn COMPLETED" miss).
