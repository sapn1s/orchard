```orchard-ticket
{
  "id": "FEAT-112",
  "type": "feature",
  "title": "Per-project service sidecars (Redis/Mongo reachable from the session)",
  "summary": "A containerised session cannot verify against a real Redis/Mongo, so every verdict degrades to \"the code looks right\". This lets a project declare the services it needs; Orchard brings them up on a per-project Docker network, reachable by hostname from inside the session. Project-scoped lifecycle, labelled data volumes, loud bounded failures, and an agent-propose/user-approve path an agent cannot self-apply.",
  "impact_if_we_wait": "A containerised agent can build code but cannot run it against a real API or database, so end-to-end verification is impossible and every verdict collapses to \"the code looks right\" — the exact failure the whole verification method exists to eliminate.",
  "current_need": "Let a project declare the services it needs and have Orchard bring them up reachable-by-name from inside the session container, with no elevated capability, no orphaned containers, loud specific failures, and an agent-propose/user-approve path that an agent cannot self-apply.",
  "severity": "medium",
  "area": "Container/services lifecycle + settings UI",
  "reported": "2026-08-28",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-08-28",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A project declares services (name/image/env/dataPath); they come up on a per-project Docker network at that hostname when a session starts",
    "Something INSIDE the session container connects to a declared service with a real client call (not a port probe) — proven with +PONG from redis",
    "A service that fails to start fails session start loudly and specifically; an unreachable registry is bounded by a pull timeout and never hangs",
    "No orphaned containers, networks or volumes after a session ends, the container is stopped, or the project is deleted — checked with real docker",
    "Data survives a container rebuild (named volume) and never lands in the user’s repo",
    "An agent can PROPOSE a service set on the rail (FEAT-108 shape) but only the user’s Allow writes it — the agent cannot self-apply",
    "Services declared and edited in the same settings drawer that carries mounts/limits/the socket toggle; off by default so idle projects cost nothing"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "FEAT-108",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "plan+review",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": false,
    "Implementation notes": false,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": null,
    "sha256": null,
    "original_title": null,
    "migrated_on": null,
    "migrated_by": null,
    "confirmation": "Authored directly in the record format through scripts/board-tool.mjs. There is no legacy original.",
    "dropped": []
  }
}
```

# FEAT-112 — Per-project service sidecars (Redis/Mongo reachable from the session)

## What this is

A containerised session cannot verify anything end to end when the project needs
a real Redis/Mongo: none is installed, none is installable inside the sandbox, and
the Docker socket is (correctly) refused as host-root-equivalent. So every verdict
degrades to "the code looks right". This adds **per-project service sidecars**: a
project declares the services it needs, and Orchard brings those containers up on a
per-project Docker network alongside the session container, reachable from inside
the session by hostname over embedded DNS. Standard dev-container model — no
elevated capability, isolation boundary intact.

## Design decisions (and why)

- **Lifecycle — project-scoped, mirrors the session container.** The session
  container here is per-project and long-lived (reused across sessions), so
  services follow it: brought up lazily at session start (`ensureServices`, before
  the session container is ensured, so the network exists to join) and torn down
  wherever the session container is — Stop / Remove / project-delete / orphan sweep.
  Nothing is left running that an existing teardown point does not also remove;
  that is the no-orphans guarantee. Health-gating session start on service
  *readiness* is deliberately out of scope — we gate on the container reaching
  "running", not on Redis accepting connections, and say so.
- **Naming/networking.** Network `claude-station-net-<projectId>`; each sidecar
  `claude-station-svc-<projectId>-<name>` with `--network-alias <name>`. The
  session container joins post-hoc via `docker network connect` (idempotent) — no
  change to the contended container-manager create path or its drift logic. Names
  carry the project id, so `redis` in project A never collides with project B.
- **Data.** A service with `dataPath` gets a per-project named Docker VOLUME
  (`claude-station-vol-<projectId>-<name>`) mounted there. It lives in Docker
  storage, NEVER the user's repo, and SURVIVES a container rebuild. Only
  project-delete / orphan-reap / an explicit purge removes it (Stop/Remove keep it).
- **Failure is loud and bounded.** A declared service that will not start FAILS the
  session start with a `ServiceError` naming the service + image + docker's stderr —
  an agent silently getting no Redis is worse than a clear refusal. The image pull
  is bounded by a timeout (default 120s, env-overridable) so an unreachable registry
  cannot hang session start; on timeout it is aborted and said specifically.
- **Resource cost.** Services are OFF by default (empty array) — a project pays
  nothing until it declares one. Deleting a row reconciles the running container
  away on the next `ensureServices`; Stop/Remove on the container tears them all
  down. So thirteen idle projects hold zero service containers.
- **Agent proposes, never applies.** Reuses the FEAT-108 request/approve shape
  exactly: `POST /api/sessions/:sid/services-request` raises an INERT decision on
  the Needs-You rail and writes NO settings; only the USER answering "Allow" on the
  board answer route writes the proposed services into the project. Structural, not
  a runtime check — the request route has no apply path.

## Changed (unstaged — the user commits by hand)

- `src/server/service-manager.ts` (NEW): the whole lifecycle — `ensureServices`
  (reconcile: create network, (re)create drifted/absent sidecars, restart stopped,
  remove deleted), `connectSessionToServices`, `teardownServices`,
  `reapOrphanServiceInfra`, a bounded image pull, ServiceError, naming/label/volume
  helpers. Duplicates a small docker-spawn helper on purpose to avoid an import cycle.
- `src/server/registry.ts`: `ServiceSpec`/`ServiceEnvVar` types, `services?` on
  `ProjectSettings`, `servicesOf()` accessor (defaults filled once, per CONVENTIONS).
- `src/server/validate.ts`: `validateServices()` (exported; the same dialect the
  agent-propose route uses) + `services` in the settings whitelist.
- `src/server/agent-bridge.ts`: `ensureServices` before + `connectSessionToServices`
  after `ensureContainer` in `startSession`; a service failure is a fatal, specific
  session-start refusal.
- `src/server/index.ts`: teardown on container Stop/Remove and project-delete;
  network+volume reap in the orphan route; the `services-request` agent route; the
  apply-on-Allow in the board answer route; the `services` marker on the board feed.
- `src/server/decisions.ts`, `src/server/board.ts`: the `services` payload/marker.
- `public/lib/drawer.js`: the "Services" settings section (repeatable rows + add form).
- `public/app.js`, `public/styles.css`: the 🧩 services-request rail card + accent.
- `scripts/verify-feat-112-services.mjs` (NEW): the end-to-end proof.

## Verified (fixer's own run — necessary, not sufficient)

`node scripts/verify-feat-112-services.mjs` → **ALL PASS 17/0** against real docker:

- **The claim (real connect from inside):** a node RESP client run INSIDE the
  session container reaches `redis` by name and gets `+PONG`. Must-FAIL baseline in
  the same run: BEFORE the network join the identical probe fails with
  `getaddrinfo ENOTFOUND redis` — proving the join is what makes it reachable.
- **Failure paths:** a bad image tag throws `pull-failed` naming the service+image
  (fast); an unreachable registry (`10.255.255.1:5000/...`) is ABORTED by the
  bounded timeout at ~4s (knob lowered for the test) and does not hang.
- **Cleanup:** after `teardownServices`, real `docker ps -a` / `network ls` /
  `volume ls` show nothing of ours; `reapOrphanServiceInfra` removes an orphan's
  network + volumes + containers.
- **Agent cannot self-apply:** `services-request` 400s without a live session; a
  raised proposal leaves project settings with NO services (inert); only the USER
  "Allow" on the answer route applies them; "Decline" writes nothing.

`npm run gate` → exit 0 (leak-gate + typecheck), read unpiped.

UI: a real-browser both-theme screenshot pass of the drawer Services section and
the rail card was captured and reviewed (paths in the activity log).

## Out of scope this round (stated, not forgotten)

Service health-gating of session start (we gate on "running", not "ready");
persistence policy beyond the named-volume default; multi-project sharing of one
service. The git-panel fetch-with-no-timeout hang is a separate concern (BUG-162)
and untouched — this feature's own pull IS bounded.

## Still open / handoff

HIGH-STAKES (session lifecycle + new container/network/volume infrastructure):
warrants an independent clean-room verify pass before VERIFIED — the fixer wrote
the fixture, so a gap the fixer never imagined is invisible to it. The app.js rail
card is a minimal hunk in a contended file; the load-bearing security property was
proven at the route level, not just the render.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-28 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-28 — independent verifier (clean-room round 1) — VERDICT: BROKEN in 3 of 6 areas

Scratch resources only (`t-f112*` prefix), removed by name; the user's containers,
networks and volumes were never touched. Final `docker ps -a/network ls/volume ls`
match the pre-run baseline exactly (12 networks, 14 volume lines; the user's own
unrelated redis/mongo containers and all `claude-station-*` sessions intact).

**(i) The fixer's proof reproduced, once, unmodified.**
`node scripts/verify-feat-112-services.mjs` → `ALL PASS — 17 passed, 0 failed`,
including `GOT:+PONG` from inside the session container and the must-FAIL baseline
`ERR:getaddrinfo ENOTFOUND redis` before the join. The demonstration is real.

**(ii) Adversarial cases the fixture does not cover.** Harness:
`~/scratch/f112/attack{,2,3,4}.mjs`, `crash.mjs` (scratch, not committed).

1. **ISOLATION — BROKEN. Cross-project data disclosure through a name collision.**
   A project id is `slugify(name)` and both the container and the volume name are
   `<prefix>-<projectId>-<serviceName>` joined by `-`, so two different projects
   collide whenever the concatenations agree. Project **"web api"** with service
   **`db`** and project **"web"** with service **`api-db`** both produce
   `claude-station-svc-…-web-api-db` / `claude-station-vol-…-web-api-db`.
   `ensureVolume` uses `docker volume create`, which SUCCEEDS on an existing name
   (labels are not re-checked), so project Y silently adopts project X's volume:
   ```
   collide? true
   X wrote its secret. Now the user Stops project X (teardown keeps volumes, by design).
   X volume still present: "claude-station-vol-t-f112-5bob-web-api-db"
   Now an UNRELATED project Y starts a session:
      [services] service "api-db" (redis:7-alpine) running as claude-station-svc-t-f112-5bob-web-api-db
      project Y reads key "secret" from ITS OWN redis -> "PROJECT_X_PRIVATE_DATA"
   ```
   This falsifies "Names carry the project id, so `redis` in project A never
   collides with project B". If X's sidecar is still running, Y instead gets a
   confusing `create-failed: Conflict. The container name … is already in use` —
   i.e. an unexplainable session-start refusal — but the volume was already
   adopted by then. Fix shape: separate the two ids with a character the DNS-label
   service name cannot contain, or append a hash of `(projectId, serviceName)`.
   Runtime network isolation itself is fine (see 5).

2. **LIFECYCLE — BROKEN. A service that starts and then exits passes silently on
   the next session start.** `createAndStartService` reads `.State.Running` back;
   the "already exists, not running → `docker start`" branch in `ensureServices`
   does not. `docker start` exits 0 for a container that dies a moment later:
   ```
   first ensureServices  -> THREW not-running: service "redis" exited immediately after start …
   container state after first ensure: exited
   second ensureServices -> RESOLVED — session start would PROCEED
   container state after second ensure: exited
   ```
   So the loud refusal is not sticky: session 1 fails correctly, session 2 starts
   with no service and no warning — "an agent silently getting no Redis", the exact
   outcome the design says is worse than a clear refusal.

3. **LIFECYCLE — BROKEN. Two session starts racing `ensureServices` on one project
   spuriously refuse a session.** Both racers see no container and both `docker
   create` the same name:
   ```
   racer 0: fulfilled
   racer 1: rejected — create-failed: service "redis": could not create container from redis:7-alpine
   ```
   The network-create path handles this race ("already exists" tolerated); the
   container path does not. A second session opened while the first is starting
   dies with a docker name-conflict message.

4. **LIFECYCLE — BROKEN. `Rebuild` is a claimed teardown/rejoin point that is not
   wired.** `service-manager.ts` line 21 says services are torn down "on
   Stop/Remove/**Rebuild** of the container"; `index.ts` wires `stop` and `remove`
   only, and `cm.rebuildContainer` (rm + re-create by the same name) is followed by
   no `connectSessionToServices`. Observed:
   ```
   before rebuild, probe redis: GOT:"+PONG"
   networks of the rebuilt container: bridge
   service containers still running: claude-station-svc-…-redis
   after rebuild,  probe redis: ERR:getaddrinfo ENOTFOUND redis
   ```
   The sidecars keep running, detached, and nothing rejoins until the next
   `startSession`. Anything using the container outside a session start (forced
   rebuild under a live session, terminal/exec, browser work) sees "redis worked,
   then stopped resolving". Also note that ending a session tears nothing down —
   sidecars run until the container is Stopped — so "thirteen idle projects hold
   zero service containers" holds only for projects whose containers are stopped.

5. **ISOLATION (runtime) — CONFIRMED.** Project A's session container resolves
   `redis` to A's sidecar and cannot reach B's even by raw IP (docker's
   inter-bridge isolation, not just naming):
   ```
   project B redis IP: 172.23.0.2
   A session -> hostname "redis": GOT:"$9\r\nPROJECT_A"
   A session -> B redis by RAW IP: TIMEOUT (exit 3)
   ```

6. **PULL BOUNDING — CONFIRMED (with a comment that is wrong).** Against the REAL
   Docker Hub (not the blackhole IP the fixture uses) with a 2s bound and an image
   not present locally: `pull-timeout after 2086ms`; the image had NOT arrived at
   t+5s/t+30s/t+60s and no container was left — the daemon does cancel when the
   CLI dies. The code comment claims it kills "the whole process group", but the
   child is spawned without `detached`, so `process.kill(child.pid)` kills one
   process, not a group. Behaviour is correct; the justification is not.

7. **SELF-APPLY — CONFIRMED.** The request route has no apply path, and the apply
   route is not reachable from where an agent runs: from a container created the
   way `container-manager` creates one (`--add-host host.docker.internal:host-gateway`),
   `POST http://host.docker.internal:<port>/api/projects/x/board/answer` →
   `ERR:ECONNREFUSED`, and via the service network's gateway IP → `ECONNREFUSED`
   (the server binds 127.0.0.1). Raising a proposal writes no settings; only the
   user's Allow applies. No second path found.

8. **DATA — CONFIRMED (except for 1).** `SET`+`SAVE`, Stop-style teardown
   (`removeVolumes:false`) keeps `claude-station-vol-…-redis`, re-ensure returns
   `"yes"`; a purge removes it. Label-scoped `removeProjectVolumes` means one
   project's purge cannot delete another's volume — but see 1, where a colliding
   project's DELETE would destroy the volume the other is using.

9. **CLEANUP on crash — nit, not a break.** SIGKILL of the process mid-`ensureServices`
   leaves a running sidecar + network + volume for a project whose session never
   started; `reapOrphanServiceInfra` deliberately skips known projects
   (`{"networks":[],"volumes":[]}`), so nothing automatic removes it — only a Stop/Remove
   the user has no obvious reason to press. Recoverable, bounded per project.

**(iii) Could not test.** A genuinely live `startSession` end to end (the user has
live sessions on the real service; the constraint forbade touching it), so the
agent-bridge ordering was read, not run; the `services-request` route from a real
live session (the fixture stubs it at 400/no-session); a registry that accepts the
connection and then streams slowly, or an image legitimately pulling for minutes —
only "unreachable" and "real Docker Hub, cancelled" were exercised; the drawer UI
and rail card (no visual pass in this round); project-delete with a live session.

**Verdict per area** — lifecycle **BROKEN** (2, 3, 4), isolation **BROKEN** (1;
runtime networking itself confirmed), cleanup **CONFIRMED** with the crash nit (9),
pull bounding **CONFIRMED**, self-apply **CONFIRMED**, data **CONFIRMED** except
through the collision in (1).

### 2026-08-28 — fixer (round 2) — the four clean-room defects fixed

All four defects from clean-room round 1 fixed in `src/server/service-manager.ts`
and `src/server/index.ts`; cleanup, pull bounding, self-apply and data-survival
left untouched (they held under attack). Verified against real Docker; scratch
resources only (`t-f112*` prefix), removed by name — final `docker` counts match
the pre-run baseline exactly (networks 11, volumes 13, containers 48; no `t-f112`
or `feat112` residue).

1. **Cross-project data disclosure (defect 1) — FIXED, two ways.**
   - *Naming.* `serviceContainerName`/`volumeName` now append a `pairTag` =
     `sha1(projectId + NUL + serviceName)[:12]`. NUL cannot occur in either
     field (projectId is slugify -> `[a-z0-9-]`; serviceName is
     `[a-z][a-z0-9-]{0,30}`), so `projectId + NUL + serviceName` is an INJECTIVE
     encoding of the pair — distinct pairs -> distinct hash inputs -> distinct
     tags, by construction. The readable prefix may still flatten (`web-api`+`db`
     and `web`+`api-db` both read `…-web-api-db-`), but the tags differ
     (`…-d61e92f11943` vs `…-5a8b09cb337c`). Test `naming.mjs`: 72 pairs incl. many
     flattening-equal -> 72 distinct names, the exact ticket pair `collide? false`.
   - *Adoption hole.* `ensureVolume` now `volume inspect`s first: it reuses a
     volume only when its `claude-station.project`/`.service` labels match; any
     other owner (or an unlabelled stray) throws `volume-conflict` loudly instead
     of `docker volume create` silently adopting it. Proven independently
     (`adopt.mjs`: a pre-planted foreign-labelled volume under the exact name ->
     THREW `volume-conflict`, not adopted).
   - *Old-scheme volumes.* A volume created under the pre-tag name
     (`claude-station-vol-<pid>-<svc>`) no longer matches the new tagged name, so
     `ensureServices` creates a fresh empty volume and the old one is abandoned as
     an orphan (its labels are intact, so project-delete / orphan-reap still reaps
     it; the crash-orphan case in nit 9 still applies). For this UNRELEASED feature
     that means any service data written under the buggy scheme is left behind, not
     migrated — acceptable, and called out here rather than hidden.
   - *attack4 (decisive):* project Y now reads `""` from its own redis, not
     `PROJECT_X_PRIVATE_DATA`; *attack3:* `collide? false`, Y mounts an empty
     `/data`, Y teardown leaves X's container+volume intact.

2. **Exited-service silent pass (defect 2) — FIXED.** Extracted
   `assertServiceRunning(name, spec)` (re-inspect `.State.Running`, throw
   `not-running` with the container's log tail) and called it on the
   `docker start`-an-existing branch in `ensureServices` too, not only in
   `createAndStartService`. `attack.mjs` ATTACK 1: first AND second
   `ensureServices` now both THROW `not-running` — the refusal is sticky.

3. **Create race (defect 3) — FIXED.** `createAndStartService` now tolerates a
   name conflict (`already in use|already exists|Conflict`) on `docker create` the
   same way the network path tolerates "already exists": the tagged name is unique
   to this (project, service) pair, so a clash can only be a concurrent starter of
   the SAME service — fall through to `start` + `assertServiceRunning` on the
   peer's container. `attack.mjs` ATTACK 2: both racers `fulfilled`, one container.

4. **Rebuild drops the network (defect 4) — FIXED.** The `index.ts` `rebuild`
   container route now calls `svc.connectSessionToServices(project.id)` after
   `cm.rebuildContainer` (a rejoin failure is surfaced as `st.serviceRejoin`, not a
   500); the sibling `start` route got the same rejoin because `ensureContainer`
   also recreates on drift. `rebuild.mjs`: rebuilt container was `bridge`-only,
   then `bridge,claude-station-net-…` after the route rejoin, probe `+PONG` again.

**Idle-teardown claim — corrected, not code-changed (decision).** The design
decision text "So thirteen idle projects hold zero service containers" is only true
for projects whose CONTAINER is stopped. Services deliberately mirror the
per-project, long-lived SESSION CONTAINER (reused across sessions), not an
individual session — so ending a session correctly tears nothing down, and a
project left with a running container keeps its sidecars until Stop/Remove. Making
session-end tear services down would contradict the whole container-reuse design.
The honest claim is: **"idle projects whose containers are stopped hold zero
service containers; a project whose container is still running keeps its declared
sidecars until Stop/Remove."** No code change; this entry is the correction.

**Crash-orphan reconcile (lower priority) — NOT done, on purpose.** Reconciling
known projects against their declared services inside the orphan sweep would risk
tearing down the sidecars of a project that is between sessions with its container
still up (they are supposed to persist), and cannot cheaply distinguish that from a
true crash-orphan. Bounded at one set per project and recoverable via Stop/Remove;
`ensureServices` already reconciles drift/deletion on the next session start. Left
as a known nit rather than a risky sweep change.

**Non-vacuity.** A genuinely healthy service still starts (17-check suite: `+PONG`
from inside the container); a genuinely broken one still refuses loudly (bad tag ->
`pull-failed`, exited container -> `not-running`). Fixer's 17-check suite: ALL PASS
17/0. `npm run gate` -> exit 0 (leak-gate + check-nul + typecheck), read unpiped.

HIGH-STAKES (session lifecycle + cross-project isolation + data): an independent
clean-room verify pass is still warranted before VERIFIED — the fixer wrote these
harnesses, so a gap the fixer never imagined is invisible to them; the rebuild and
race proofs exercise the mechanism `index.ts` calls, but a live end-to-end
`startSession`/rebuild through the real HTTP route was not run here.
