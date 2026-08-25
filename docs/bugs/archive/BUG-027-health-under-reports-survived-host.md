# BUG-027 — /api/health (+doctor) under-reports a survived-but-unattached session after a restart

- **Status:** VERIFIED
- **Area:** server — FEAT-015 re-adopt + FEAT-040 /api/health self-report
- **Reported:** 2026-08-05 (found by DOGFOODING a real deploy restart of :4317 this session)

## Symptom (observed live)
After `systemctl --user restart claude-station` (server pid 1859 → 42996), a session that
genuinely SURVIVED in its own scope — broker `session-host.mjs` (pid 7089) + `claude --resume`
(pid 7096) alive, `claude-station-host-…scope` active-running, `<key>.sock`/`.json` present in
`session-hosts/` — is reported by `GET /api/health` as **`sessions: []`** (and `npm run doctor`
prints "No live sessions right now"). `watches:1` shows the server IS watching the hostsDir, but
it does not surface the survivor. Persists across repeated polls (not re-adopt lag).

## Why it matters
FEAT-040 exists so the system self-reports survival GROUND TRUTH instead of a human hand-guessing
(the failure that produced BUG-024). This is the INVERSE false signal: after the exact event the
tool is meant to illuminate (a restart), `doctor` says "nothing survived" while the session is
alive and reachable. A user (or I) checking "did my work survive the restart?" would be told NO
and could wrongly conclude the session/agents were lost. Same class of "degraded state reads as
broken" the state-legibility work targets.

## Root cause (to confirm, don't assume)
Re-adopt appears to be LAZY — the server reconnects to a surviving broker only when a client
attaches to that session; before any attach there is no in-memory session object, so `/api/health`
(which lists live in-memory sessions) shows []. FEAT-040's design note said health joins live
sessions against `scanSurvivingHosts()` — verify whether that merge exists and why the survivor
is dropped (never merged? filtered when un-adopted? scan not finding it despite the .sock?).

## Fix direction (decide in the fix)
Either (preferred) **eagerly re-adopt surviving hosts on server boot** (the session is alive; the
server should reconnect immediately so the live UI shows it again after a restart without a manual
reload), AND/OR make `/api/health` + `doctor` **always surface survivors from `scanSurvivingHosts()`**
with an explicit `adopted: true|false` so an un-adopted-but-alive survivor is visible, never
reported as absent. The self-report must not say "no sessions" when a scoped survivor is on disk.

## Verification (REQUIRED)
Real deploy-style test on a SCRATCH server (free port, never :4317): start a driven session, restart
the scratch server, and assert `/api/health` reports the survivor (adopted or flagged) — NOT `[]` —
and that `doctor` names it. Must FAIL on current code (reproduce the `sessions:[]`). If eager
re-adopt is implemented, assert the session is reconnected without a client attach. typecheck.

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
