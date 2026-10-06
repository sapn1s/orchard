```orchard-ticket
{
  "id": "BUG-216",
  "type": "bug",
  "title": "Cleaning up one Orchard server removed other servers’ live containers",
  "summary": "A test server’s orphan cleanup force-removed 44 containers it had not created. Six were live projects, three of them running, and 38 were other test runs’. It counted as orphaned anything its own registry did not list. Now each server labels what it creates and removes only its own. Unlabelled older objects are reported, never removed.",
  "impact_if_we_wait": "Any scratch or test server that runs cleanup can wipe the live server’s containers again, and with them any service data volumes. Workspaces and transcripts are host mounts, so they survived this time; container-only state did not.",
  "current_need": "Review the round-3 HOLDS verdict and restart Orchard to deploy; decide whether per-project-id names get an ARCH ticket.",
  "severity": "high",
  "area": "container cleanup ownership",
  "reported": "2026-09-29",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "in_progress",
  "human_action": "review",
  "updated": "2026-09-29",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "One server’s cleanup never removes or alters a container, network or volume that a server on another data dir created.",
    "Objects without an owner label are reported and never removed automatically.",
    "A server still removes its own real orphans, including service networks and data volumes.",
    "Proven on an isolated Docker daemon with a must-FAIL against a pinned pre-fix snapshot.",
    "One ownership authority for containers, networks, volumes, builders and images."
  ],
  "code_refs": [
    {
      "path": "src/server/instance-owner.ts"
    },
    {
      "path": "src/server/container-manager.ts"
    },
    {
      "path": "src/server/service-manager.ts"
    },
    {
      "path": "src/server/index.ts"
    },
    {
      "path": "src/server/project-builder.ts"
    },
    {
      "path": "scripts/verify-bug-216-sweep-ownership.mjs"
    }
  ],
  "related": [
    {
      "id": "ARCH-020",
      "relation": "see_also"
    },
    {
      "id": "ARCH-010",
      "relation": "see_also"
    },
    {
      "id": "FEAT-112",
      "relation": "see_also"
    },
    {
      "id": "BUG-214",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": false,
    "Implementation notes": false,
    "Verification plan": true,
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

# BUG-216 — Cleaning up one Orchard server removed other servers’ live containers

## Symptom

On 2026-09-29, between 23:10 and 23:13 local time, a verifier checking ARCH-020 called the "remove orphan containers" action on its own scratch Orchard server. That server force-removed 44 containers on the host that it had not created. Six belonged to live registered projects of the main Orchard server, and three of those were running (P1, the GPU research project; P2; P3, a bot). The other 38 were other test lanes' containers. The verifier noticed and stopped itself.

## Damage assessment (read-only, 2026-09-29/30)

Evidence: `~/.local/state/claude-station/scratch/arch020/v2-evidence/` (`ps-before.txt` / `ps-now.txt`, `vol-before.txt`); the verifier transcript `a0461cac-2213-40a7-b9bd-7c479c704f84` places the call between 20:10:43Z and 20:14:00Z.

| project | container at the incident | session in flight? | lost | recovers how |
|---|---|---|---|---|
| P1 (GPU research) | running, up ~1 h (recreated ~22:00) | **no.** The last transcript write was 17:00. `results/4676.log` was last written 17:02, and the lane's subagent transcript ends mid-wait at 17:02. That run had already ended six hours earlier. | only the container's writable layer (anything written outside the mounts, e.g. /tmp, pip installs made at runtime). Deps are baked into its image. | Next session start recreates it. `ensureContainer` → no container → `createAndStart`. Image `claude-station-project-<P1>:df-3b3725556c4e` is still present. The live build record says `succeeded` for that hash, so no rebuild is expected. If the deployed hash differs, the worst case is a ~17 min rebuild like the 21:33 one. |
| P2 | running, up 22 h | no. The last transcript write was 2026-09-29 01:35. | writable layer only | next session start (base image present) |
| P3 (bot) | running, up ~27 min | no. It was idle: the last turn ended 23:01:26, 10 minutes earlier. The user had switched the project to direct at 23:00:47, so this container was left over. | writable layer, including that session's completed background-task output files under the container's /tmp | the project is now direct, so no container is needed |
| P4 | exited (2 days) | no | writable layer | next session start |
| P5 (website) | exited (3 weeks) | no | writable layer | next session start |
| claude-station (orchard) | exited (8 weeks), stale | no. The project is direct. | nothing needed | not needed |

- **Transcripts and history are intact.** Every project's per-project container store lives on a host bind mount (`~/.claude/projects/-workspace-<id>`). Run through the server's own history readers, all six still list their sessions: orchard 309, P1 (GPU research) 2, P2 3, P5 (website) 4, P3 (bot) 6, P4 1.
- **Workspaces are intact.** They are host bind mounts.
- **Volumes:** `vol-before.txt` against the current list shows none removed. No Orchard service volumes existed on the host.
- **The 38 lane containers** were test fixtures (`b34-run-*`, `bug157-*`, `adv-fixture`, ...). Any lane still using one will fail its next container call and recreate it.

## Root cause

The creator never declared who owns a container, so the sweep worked it out. It treated anything labelled `claude-station=1` whose `claude-station.project` is not in THIS server's registry as an orphan (`findOrphanContainers`). On one shared Docker daemon, every other Orchard server's projects are also "not in my registry". A scratch server's registry is nearly empty, so it saw nearly everything as an orphan. The service-infra reap (`reapOrphanServiceInfra`) had the same shape, and it reaches service DATA volumes. The must-FAIL run below shows the pre-fix code deleting another server's redis data volume.

The same data-loss path was also armed inside a suite. `verify-feat-112-services.mjs` calls `reapOrphanServiceInfra(new Set())` against the daemon it runs on. Pre-fix, that meant every service network and volume on the host.

## Fix (ARCH-010: declared by the creator, read by the sweeper)

- `src/server/instance-owner.ts` (new) is the one ownership authority. `ownerKey()` is a hash of the data dir's realpath. It is byte-identical to ARCH-020's `dataKey()`, which now returns it, so builders, images, containers, networks and volumes share one owner key. It also defines `LABEL_OWNER = claude-station.owner` and `ownershipOf() -> own | foreign | unlabelled`.
- Every Orchard-created container, network and volume carries the owner label:
  - the session container (`createArgs`) and the smoke container;
  - the service network, the service volume and the service container.
- The owner label is not part of drift, so deploying this recreates no live container.
- The sweep removes only `own` objects of unregistered projects. Unlabelled (pre-label) containers, networks and volumes come back as `unowned`: reported, never removed. `removeContainerByName` re-reads the label at removal time and refuses anything that is not `own`.
- Route response: GET `{orphans, unowned, builders}`, POST `{removed, unowned, builders, serviceInfra:{networks, volumes, unowned}}`. `orphans` keeps its shape.

## Residual (not fixed here, recorded so it is not rediscovered)

- **Legacy objects of the live server** carry no owner label until they are recreated for some other reason. Until then even the live server's own real orphans are only reported. That is the safe direction, by design.
- **Names still derive from the project id alone.** That covers `claude-station-<id>`, the service network and the service volume. Two instances that register the same project id therefore share a container NAME. Project delete, service teardown and `ensureServices` act by name or project label, not by owner. A scratch server that reuses a live id and deletes it can still remove the live object. That is the same class on a different path (the ARCH-020 verifier found its image-delete twin).
- Label forgery by someone with daemon access is out of scope (daemon access = root), as in ARCH-020.

## Verification plan

- `scripts/verify-bug-216-sweep-ownership.mjs` REFUSES to run unless `DOCKER_HOST` points to a daemon whose ID differs from the host daemon's. It uses docker-in-docker.
- The scenario is synthetic but mirrors the incident's mixed state:
  - two real Orchard servers on different data dirs;
  - B has a running container, a stopped container and a redis service (network + data volume);
  - A has a kept project and a project dropped from its registry (with a service);
  - three legacy containers and one legacy service volume, labelled exactly as the pre-fix code did.
- A must remove its own orphans and nothing else, with container ids and states unchanged.
- The must-FAIL anchor is a pinned snapshot of the pre-fix tree (sha256 recorded), not HEAD.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-29 — worker
- **fixing, round 1:** - **Understood.** The sweep inferred ownership ("labelled and not in MY registry") instead of reading a declaration. That confirms the charter's hypothesis. The service-infra reap has the same shape and reaches data volumes. ARCH-020's `dataKey()` already scoped builders and images by data dir, so I used it as the one authority rather than adding a second.
  - **Damage assessment:** see the table in the body. It is read-only and done from the evidence dir, the transcripts, the build record and the server's own history readers.
    - No session was in flight in any of the six projects.
    - Nothing on host mounts was lost. No volume was lost.
    - What was lost is each container's writable layer.
    - The live server recreates the missing containers at the next session start (`doEnsure`: no container → `createAndStart`). I recreated nothing myself.
  - **Changed (uncommitted, no git writes):**
    - `src/server/instance-owner.ts` (new)
    - `src/server/container-manager.ts`
    - `src/server/service-manager.ts`
    - `src/server/index.ts` (orphans route)
    - `src/server/project-builder.ts` (`dataKey()` → `ownerKey()`)
    - `scripts/verify-bug-216-sweep-ownership.mjs` (new)
    - The FEAT-157 INDEX owner cell was set 👤 → — through `board-tool update --owner=unassigned`.
  - **Isolation:**
    - Every test that removes anything ran on a docker-in-docker daemon: container `orchard-bug216-dind`, loopback TCP, daemon id `08af7429…`, seeded with `docker save | docker load`.
    - The suite refuses to run unless `DOCKER_HOST`'s daemon id differs from the host's.
    - I compared host `docker ps -a` before and after each must-FAIL run: 0 host containers went missing (the unrelated self-restarting plugin swarm excluded).
  - **Must-FAIL:** anchored to a snapshot of the pre-fix tree, `~/.local/state/claude-station/scratch/bug216/prefix`, with sha256 in `prefix.sha256`. It is not HEAD.
    - The round-1 suite (12 checks) failed 8. The pre-fix sweep removed:
      - all of B's containers (running, stopped, service);
      - B's redis **data volume**;
      - the 3 legacy containers.
    - B's sweep in turn removed A's kept project.
  - **Self-verify round 1:** 12/12 on the fixed tree. The `dataKey()` equivalence unit check is 5/5: identical to the pre-fix formula for 3 data dirs, different dirs give different keys, and the classes are correct.
  - **Clean room round 1** (anthropic `claude-opus-5-5`, `scripts/dispatch.mjs --cwd <room>`, session `a392feeb-8a68-4c1e-a0a9-932a9d02a6cf`, report `~/.local/state/claude-station/scratch/bug216/verify-r1.out`). Confinement:
    - The room excluded `docs/bugs` and my suite.
    - A `docker` wrapper on PATH forced every call, including those from the servers it booted, to the dind daemon and refused `-H`/`--context`.
    - The charter forbade the host daemon, port 4317 and any server it did not start.
    - It confirmed the wrapper and daemon id first. It sent nothing to 4317 and left dind clean.
  - **Round 1 verdict: BROKEN.**
    - HOLDS: its own mixed-state sweeps, an empty-registry server (the incident's shape: 0 removed), data-dir aliasing (symlink, `..`, trailing slash, relative), and builder/container owner agreement.
    - BROKEN:
      - **E2.** B registered the same project id as A's orphan and adopted A's redis, network and volume (by name, owner never checked). A's sweep then destroyed B's live data.
      - **E3.** B's project delete of a same-id project removed A's running container, redis, network and data volume.
      - **E4c.** The owner label was checked, then `rm -f <name>` ran by name. A same-named container created in between was removed.
    - All three are the residual I had written into the body: names derive from the project id, and paths other than the sweep act by name. So I fixed them in this round rather than filing them.
  - **Round-2 changes:**
    - A foreign-owned object is never reused, recreated, stopped or removed:
      - `refuseForeign` in `doEnsure` (including the `-next` name), `removeContainer` and `stopContainer`;
      - `refuseForeignService` in `ensureNetwork`, `ensureVolume` and `ensureServices`;
      - `teardownServices`, `removeNetwork` and `removeProjectVolumes` skip foreign objects.
    - Removal acts on the inspected ID. The reap re-reads each network/volume owner immediately before removing it.
    - Found by my own suite's detail line: `docker inspect --format '{{index .Labels "k"}}'` prints `<no value>` for a missing label, and `ownershipOf` had classed that as **foreign**. That would have made the live server refuse to reuse its own pre-label service networks and volumes. Fixed.
    - `removeContainerByName` no longer reports `removed:true` when `rm -f` found nothing.
  - **Self-verify round 2:**
    - `verify-bug-216-sweep-ownership.mjs` **18/18** on dind. The new checks cover E2a/E2b, E3, the E4c race (a delaying docker shim), and legacy-network reuse.
    - Pre-fix snapshot: **13 FAIL / 18**. The 5 passes are the precondition, the 2 positive controls, the kept project, and legacy reuse (expected).
    - Constructed variant with only the `<no value>` fix reverted: fails exactly the legacy-reuse and reason checks (16/18).
  - **Anti-regressions (dind):**
    - `verify-feat-112-services` 17/17 (twice).
    - `verify-feat-155-image-env-policy` 14/15. The same check fails identically on the pre-fix snapshot on dind, so it is environmental.
  - **Could not run on the isolated daemon.** They are not run on the host, per charter:
    - `verify-feat-155-prebuilt-lockdown`: its container-start check passed; it then reads the container PID from host `/proc`, which dind's PID namespace hides.
    - `verify-feat-157-base-recreate-under-live`, `verify-feat-155-workspace-root`, `verify-feat-145-container-account`, `verify-bug-107-image-staleness`: GPU `auto` → `--gpus all` fails with no CDI vendor on dind. A fake CDI spec was tried and refused ("AMD CDI spec not found").
    - `verify-container.mjs` needs a live Claude session turn.
    - `verify-arch-020-builder-isolation`: real buildkit builds. `dataKey()` equivalence covers the one line touched.
  - `npm run gate`: exit 0 (twice).
  - **regressed-from:** none in the ticket sense. The sweep predates this board's owner labels. The incident was reached through the ARCH-020 round-2 verifier charter.

### 2026-09-29 — worker
- **fixing, rounds 2-3:** - **Clean room round 2** (session `9a49f80e-3c3f-4f4a-b509-66941c5d4ae2`, report `~/.local/state/claude-station/scratch/bug216/verify-r2.out`). Same confinement: fresh room, `docker` wrapper forced to dind, no `docs/bugs`, no suite.
    - **BROKEN** on service paths:
      - **R2a.** Joining the session to its service network had no owner check, so A's container joined B's same-id network and got `+PONG` from B's redis.
      - **R2b.** `ensureServices` refused outright on B's leftover same-id sidecars, so a scratch server could block a live project's sessions.
      - **R2c.** Concurrent same-id creation adopted the other side's objects in 13 of 16 races, through three non-atomic points:
        - `network create` answering "already exists";
        - `volume create` succeeding on an existing name;
        - "name already in use" followed by `start <name>`.
        - That ended in data loss through the other instance's sweep.
    - HOLDS: the sweep itself, aliasing, builders.
  - **Round-3 changes (service-manager, container-manager):**
    - `connectSessionToServices` reads the network owner and does nothing for a foreign network.
    - `ensureServices` ignores foreign service containers. It never adopts, restarts or removes them. It refuses only when a name it must create is held by a foreign object.
    - Every create reads the owner back afterwards and refuses anything not its own: network, volume, service container.
    - Service containers and the session container are started by the ID the create returned.
    - Removed the now-unused `networkExists`.
  - **Self-verify:** `verify-bug-216-sweep-ownership.mjs` is **22/22** on dind. New checks:
    - R2a/R2b: B's same-id redis survives A's no-services ensure, and A does not join B's network.
    - R2c: 10 real concurrent same-id races. Winners alternated A/B; `adopted=0`, `bothOk=0`.
    - Must-FAIL:
      - Pre-fix snapshot: **FAILURES 7/22 passing**, `adopted=10`. Pre-fix, A's no-services ensure also **deleted B's redis and network**.
      - Constructed variant with only the R2a/R2b fixes reverted: fails exactly those 2 checks (20/22).
      - Host `docker ps -a` diff across the must-FAIL runs: 0 missing.
  - **Anti-regression:** `verify-feat-112-services` 17/17 on dind. `npm run gate` exit 0.
  - **Clean room round 3** (session `0b0c48bd-c20b-4837-a918-adb66ac56309`, report `~/.local/state/claude-station/scratch/bug216/verify-r3.out`): **HOLDS**, 10/10 attacks.
    - Three live servers plus a fourth on a not-yet-existing dir under a symlinked parent.
    - Same-id on both sides in both directions: start, stop, rebuild, remove, ensureServices, connect, teardown, DELETE. Canaries in both redis survived.
    - Empty-registry sweep: `removed:[]`, legacy reported.
    - Non-vacuity: both sides swept their own orphans, including network and volume.
    - 8 natural races.
    - Forced check→create windows through an interposer, for network, volume, service container and session container.
    - Name swap between list and removal; a label-less container.
  - **Verified-by:** dispatch anthropic `claude-opus-5-5` run `0b0c48bd-c20b-4837-a918-adb66ac56309` (clean-room round 3, HOLDS). It exercised cases my suite does not: forced create windows via a docker interposer, same-id in both directions with data canaries, stop/rebuild on a foreign id, and a boot on a not-yet-existing symlinked data dir. Rounds 1 (`a392feeb-…`) and 2 (`9a49f80e-…`) were BROKEN and are fixed above.
  - **Residual (from round 3, not breaks):**
    - An unlabelled network with the role label but no project label is never reported.
    - A few same-instance calls still go by name: restarting a stopped own container in `doEnsure`, the swap-failure restart, builder `rm`/`start`. None can reach a foreign object without the accepted legacy residual.
    - `rebuild` on a foreign same-id project runs the image build before refusing. Images are outside this ticket; ARCH-020 scopes them.
    - **Legacy (unlabelled) objects are still treated as the local instance's** by the reuse and delete paths. Until the live server's containers are recreated with labels, a scratch server that registers a live project's id can still act on them. The live server itself runs pre-label code until restarted, so it keeps creating unlabelled objects until then.
    - Not tested by anyone: the real session-start path through the CLI (the same function sequence was driven directly), and Dockerfile-project `-next` swaps with real builds.
  - **Symptom of a deeper design flaw?** Yes, not filed. Container, network and volume NAMES derive from the project id alone, on a daemon every Orchard instance shares. This fix makes a name collision refuse instead of destroy, but the collision itself remains. It is the same shared-daemon class as ARCH-020. An ARCH ticket (instance-scoped names, with a migration for live containers) is the orchestrator's call; this ticket did not migrate anything.
  - **Changed files (uncommitted):**
    - `src/server/instance-owner.ts` (new)
    - `src/server/container-manager.ts`
    - `src/server/service-manager.ts`
    - `src/server/index.ts`
    - `src/server/project-builder.ts`
    - `scripts/verify-bug-216-sweep-ownership.mjs` (new)
    - `docs/bugs/BUG-216-*.md`
    - `docs/bugs/INDEX.md` (FEAT-157 owner cell, BUG-216 row)
  - **Scratch:** `~/.local/state/claude-station/scratch/bug216/` holds the pre-fix snapshot, variants, rooms, reports and run outputs.
    - The dind container `orchard-bug216-dind` is still running and holds no Orchard objects. Remove it with `docker rm -f orchard-bug216-dind` when no longer needed. I leave that to you because it sits on the host daemon.
  - **Deploy:** needs an Orchard restart (not done). The owner label is not part of drift, so the restart recreates no live container.

### 2026-09-30 — worker
- **Note:** **Cleanup (by the ARCH-020 verifying lane):** `orchard-bug216-dind` was removed with its data volume after confirming it held nothing but seeded images and that lane's own test volumes (0 containers, no live connections). ARCH-020 round 2 re-ran `verify-bug-216-sweep-ownership.mjs` on an isolated daemon: 22/22.
