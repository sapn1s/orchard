```orchard-ticket
{
  "id": "FEAT-158",
  "type": "feature",
  "title": "one standing isolated Docker sandbox that every lane reuses for container tests",
  "summary": "Each lane that tests container cleanup builds its own docker-in-docker daemon, which is slow and easy to get wrong, and one mistake already removed live containers on the host. One long-lived sandbox daemon with warm image caches, a one-line command to point a test at it, and a guard that refuses destructive suites on the host daemon.",
  "impact_if_we_wait": "Every container-touching lane keeps spending minutes on its own daemon and image copies, and a destructive suite run without the right variable still reaches the host daemon that runs live projects.",
  "current_need": "Verified: c and d re-attacked to HOLDS on the final code (rounds 7 and 10); a and b HOLDS from round 4. Open: BUG-218 (base-image prune ownership) and the documented lock/path limits.",
  "severity": "medium",
  "area": "test isolation for container work",
  "reported": "2026-09-29",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-09-30",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "npm run sandbox:docker -- up is idempotent and brings a warm sandbox to a running test container in seconds",
    "a destructive suite refuses to run when its effective daemon is the host daemon, and prints why",
    "an existing destructive suite passes unchanged inside the sandbox",
    "no host container, network or volume is removed by building, using, resetting or stopping the sandbox"
  ],
  "code_refs": [
    {
      "path": "scripts/docker-sandbox.mjs"
    },
    {
      "path": "scripts/lib/docker-sandbox.mjs"
    },
    {
      "path": "scripts/verify-bug-216-sweep-ownership.mjs"
    },
    {
      "path": "scripts/verify-feat-112-services.mjs"
    }
  ],
  "related": [
    {
      "id": "BUG-216",
      "relation": "see_also"
    },
    {
      "id": "ARCH-020",
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

# FEAT-158 — one standing isolated Docker sandbox that every lane reuses for container tests

## Problem

BUG-216 happened because a verifier ran a destructive action against the host Docker daemon, which also runs the live projects. Its fix lane, and the ARCH-020 lane after it, each built a private docker-in-docker daemon by hand and copied images into it. That costs minutes per lane, and the safety depends on each lane remembering to set the right variable.

## Design

- One long-lived `docker:dind` container, `orchard-docker-sandbox`, with a named volume for its image store and build cache, so images and layers survive restarts.
- The daemon listens on a Unix socket under the Orchard state dir (no TCP port), owned by the user's group.
- Orchard's own base image and the common fixture images are copied in once from the host.
- `npm run sandbox:docker -- up|status|env|reset|down`. `env` prints the `DOCKER_HOST` export line.
- One shared guard (`scripts/lib/docker-sandbox.mjs`) that destructive suites call first. It compares daemon IDs and refuses when the daemon the suite would reach is the host one.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-29 — worker
- **fixing, round 1:** **fixing, round 1:**
  - **Hypothesis checked first. It holds.**
    - Every Orchard docker call goes through `CLAUDE_STATION_DOCKER ?? 'docker'` (container-manager, service-manager, project-builder), and child processes inherit `DOCKER_HOST`. So a server or suite is pointed at another daemon by `DOCKER_HOST` alone, with no code change.
    - What was missing was not a knob but a shared guard and a shared daemon. BUG-216's suite had the only guard, inline. `verify-feat-112-services` had none, yet it calls `reapOrphanServiceInfra(new Set())`, which treats every service network and volume on the daemon as an orphan.
    - Scripts that need things dind cannot give (host `/proc` PIDs, GPU CDI; see BUG-216's could-not-run list) are unchanged by this. The sandbox does not fix them.
  - **Built:**
    - `scripts/docker-sandbox.mjs`: `npm run sandbox:docker -- up|status|env|reset|down [--purge]`.
      - One `docker:29-dind` container (official image, pinned to the host's engine major), `orchard-docker-sandbox`, labelled `orchard.docker-sandbox=1`. It carries no `claude-station` label, so no Orchard sweep sees it.
      - `/var/lib/docker` sits on the named volume `orchard-docker-sandbox-data`, so images and build cache are warm across restarts. The daemon ID also persists.
      - The API is a Unix socket at `~/.local/state/claude-station/docker-sandbox/run/docker.sock`, mode 0660, group = the user's gid. There is no TCP port.
      - `/tmp`, the scratch root and the repo (read-only) are mounted at the same paths, so bind mounts resolve.
      - `up` preloads Orchard's base image for this tree (tag computed by `imageNameFor`) plus busybox, alpine, redis:7-alpine and the untagged base. It uses `docker save` from the host, which is read-only there.
      - `reset` removes containers, custom networks and volumes inside the sandbox. It keeps images and `buildx_buildkit_*_state` volumes, which are build cache.
      - `down` keeps the volume; `--purge` drops it. On the host it acts only on the labelled container and on its own volume, and it refuses a same-named container without the label.
    - `scripts/lib/docker-sandbox.mjs`: the paths and the guard `assertIsolatedDocker()`.
      - It compares daemon IDs through the same `docker` and env the suite uses, and refuses by default.
      - Refusal cases: `DOCKER_HOST` unset, a `CLAUDE_STATION_DOCKER` shim, an unreadable target, an unreadable host id, or the host id itself.
      - `HOST_DOCKER_ID` (printed by `env`) stands in when a room masks the host socket.
    - Wired into `verify-bug-216-sweep-ownership.mjs` (replacing its inline guard, which has the same semantics) and `verify-feat-112-services.mjs`. No assertion changed.
    - `scripts/verify-feat-158-docker-sandbox.mjs` (new), `package.json` (`sandbox:docker`), and a section in `docs/CONVENTIONS.md`.
  - **Timings** (from `up` to a running container on Orchard's 3.1 GB base image):
    - Cold, no volume: **22.1 s**. Of that, 0.6 s is daemon ready and 21 s is preload.
    - Warm, after `down` with the volume kept: **2.5 s**.
    - `up` on a running sandbox: 0.4 s.
  - **Guard proof** (observed output):
    - `REFUSED: verify-bug-216-sweep-ownership removes Docker objects and must not run against the host daemon. DOCKER_HOST=unix:///var/run/docker.sock IS the host daemon (id 3cdcf1c8-be4).`
    - The same refusal for `/run/docker.sock` and a `../` path, and on feat-112. Unset `DOCKER_HOST` and a set shim each refuse with their own reason. All exit 2.
  - **Verified** (all on the sandbox, final state after a purge and a cold rebuild):
    - `verify-feat-158-docker-sandbox` **25/25**. The guard matrix has 11 rows, including a symlink to the host socket and host masking with and without `HOST_DOCKER_ID`.
    - Must-FAIL: two constructed broken guards are graded by the same matrix. "No guard", which is feat-112 before this change, gets 9 rows wrong. "String compare on DOCKER_HOST" gets 7 wrong.
    - Also covered: sandbox shape, warm down/up, idempotent `up`, and `reset` keeping images.
    - `verify-bug-216-sweep-ownership` **22/22**. `verify-feat-112-services` **17/17**. `verify-bug-146-conventions-inject` 18/18. `npm run gate` exit 0.
  - **Host daemon untouched.** `docker ps -a`, excluding the self-restarting `*-plugin.1.*` swarm churn: 66 before, 67 after. 0 missing; the 1 added is the sandbox. Volumes: 35 → 36, 0 missing, the 1 added is its volume. Networks: 11 → 11. `orchard-bug216-dind` and `orchard-a020-dind2` were not touched. Evidence is in `~/.local/state/claude-station/scratch/feat-sandbox/`.
  - **Residual, not built:**
    - There is no lock, so two lanes running destructive suites in the sandbox at once can collide. BUG-216's suite already refuses a non-empty claude-station world, and `reset` or `verify-feat-158` (which cycles the container) will disrupt another lane mid-run. CONVENTIONS says to run one at a time. An `flock` on a lockfile is the next step if lanes actually overlap.
    - Mounted host `/tmp` and the scratch root are writable from sandbox containers. That is a file-safety limit, not a daemon one.
    - The other suites that remove only their own named objects are not wired. The guard was added only where a suite sweeps or reaps by class.
  - **Risk bucket:** a test-infrastructure safety guard, and the data-loss class of BUG-216. An independent clean-room pass against the guard (for other ways of reaching the host daemon) is warranted before VERIFIED.

### 2026-09-30 — worker
- **Note:** - **fixing, round 2:**
    - **Lock design:** I chose a lock over per-lane namespaces. A per-lane label prefix is not cheap: BUG-216's and feat-112's sweeps act by class across the whole daemon, so a prefix would not isolate them.
      - The lock is a kernel `flock` on `.orchard-docker.lock` beside the daemon's socket, so every lane shares it whatever its XDG_STATE_HOME or HOME. For tcp:// daemons it falls back to an id-keyed lock under the state dir. There is no other fallback; a lock that cannot be opened refuses (exit 3).
      - It is held by a watcher (`flock -x … node -e <watcher>`). The watcher tracks the holder and every descendant it has seen (pid + start time), so `kill -9` of a suite does not free the daemon while its server child is still working, and no stale lock is left.
      - Re-entry for our own children needs an ancestor pid equal to the `.info` pid (file mode 0600), a matching random token, and the lock held at that moment.
      - A waiter prints `WAITING … held by <who> (pid, since)`. It exits 3 with `TIMED OUT` after ORCHARD_DOCKER_LOCK_TIMEOUT seconds (default 1800; values outside 0–1e7 or non-numeric are refused).
      - The guard, `reset`, `down` and a restarting `up` all take this lock. The CLI finds it through the sandbox container's run-dir mount, not through the caller's state dir.
    - **Guard fixes** (property a):
      - Must-FAIL, reproduced before the fix: with `docker context use` pointing at the sandbox and `DOCKER_HOST=unix:///var/run/docker.sock`, the round-1 guard returned `ok:true` while the target was the host (`3cdcf1c8`).
        - Host env now pins `DOCKER_CONTEXT=default`.
        - The host-id set is now the default context, each well-known host socket addressed directly (incl. `/run/user/<uid>/docker.sock`), and HOST_DOCKER_ID.
      - DOCKER_HOST now has to match an allowlist, `^(unix:///\S+|tcp://[^\s/]+/?)$`. A unix path is resolved with the kernel's realpath (`realpathSync.native`) in the guard's own process, checked, returned, and written back into DOCKER_HOST, so the suite and its children all use that pinned path.
      - tcp:// is refused while any proxy env var is set.
      - This replaced three spelling rules, each broken in turn: a relative path, `/proc/self/cwd/..`, and leading whitespace.
    - **CLI fixes** (property c):
      - `docker inspect` output is parsed as JSON.
      - The container counts as ours only if it has the label AND an exact official dind image.
      - Every operation acts on the inspected ID and re-inspects after taking the lock.
      - The volume is created with label `orchard.docker-sandbox=1`. `up` refuses an unlabelled volume and re-checks after `create` and after `run`. `down --purge` removes only a labelled volume.
      - A symlinked or foreign-owned run dir is refused.
      - `up` creates the lock file, using `docker exec` if the run dir comes back owned by root.
      - Migration: I ran `down --purge` + `up` on the real sandbox, so its volume is now labelled.
    - **Unguarded destructive suites** (property d): 12 suites removed `claude-station-<fixed slug>` containers or project images without an owner check. They cannot all move into the sandbox (GPU, host `/proc`), so they now go through the new `scripts/lib/owned-docker.mjs`, which removes only objects carrying this run's owner key (BUG-216 `claude-station.owner` / `dockerfile-data`), by ID.
      - Suites changed: verify-container, verify-bug-157-container-close-live-work, verify-bug-157-container-scripted-kill, verify-browser, verify-arch-007-lazy-browser, verify-feat-gpu-env-mem, verify-feat-155-container-ui, verify-feat-155-dockerfile-ui, verify-feat-155-dockerfile, verify-feat-155-image-env-policy, verify-feat-155-prebuilt-lockdown, verify-oom.
      - verify-oom also checks the owner label before running its memory bomb and kill loop.
    - **Filed BUG-218:** the server's `pruneSupersededImages` removes other instances' and other uids' base images, and any scratch server that builds a base image can trigger it. Whether base images are a shared cache or owned per instance is an architecture decision, so I filed it rather than fixing it.
    - **Known limits, documented in CONVENTIONS:**
      - Host `/tmp` and scratch are writable from the sandbox, including sockets there.
      - The guard does not stop a hostile docker binary or a lying proxy.
      - HOST_DOCKER_ID is trusted when the host socket is masked.
      - A lane that bind-mounts only the socket FILE, or reaches the daemon over tcp://, gets a different lock.
      - A worker that detaches itself (setsid or a double fork) is not waited for.
    - **Independent verification:** separate-process clean-room attackers, one per property, dispatched concurrently. They ran in bwrap jails (no network except an allowlisted API proxy; real host socket, shared sandbox, other dinds and :4317 masked). Each jail's `/run/docker.sock` was a private fake-host dind holding decoy "live project" objects.
      - Verified-by: anthropic claude-opus-5-5, round 2:
        - a `0ef923ae-fabb-46d3-b24d-19c4ff3afcc7` BROKEN (relative path)
        - b `65cc672f-167c-46ee-a19a-399c77f2a078` BROKEN (XDG-keyed lock, kill -9 with children, spoof, /tmp fallback)
        - c `3032e873-bc99-40f8-bee5-2d3193953668` BROKEN (purge of a foreign volume, name swap)
        - d `e97be55f-1910-47ca-98a2-b0a2118adade` BROKEN (9 fixed-name rm suites)
      - Round 2b:
        - a `2c7cb880-4aa9-4548-b565-f32ad01ee882` BROKEN (/proc/self/cwd)
        - b `79a8559f-cbcc-4b82-803f-228c63018ad6` BROKEN (socket-file bind, late or detached children: now documented limits)
        - c `2e61e46b-b390-41c2-b3aa-465ec9400b2c` BROKEN (volume race, label with `|`, loose image regex)
        - d `41208e2f-e6ca-4a39-b29d-147ce1934b2f` BROKEN (3 more suites)
      - Round 3:
        - a `7b157f60-165a-435b-a0fa-a8db2ec1a758` BROKEN (whitespace)
        - b `ff731951-4891-43a6-b9aa-816df90ce01b` BROKEN (per-XDG fallback)
        - c `ac389150-2886-41ba-b68b-69216ac9e02f` hostile-only (volume swap between check and run, symlinked run dir: both fixed anyway)
        - d `f7d8d9c7-238e-429c-888a-e404b600d37f` BROKEN (verify-oom exec into a foreign container, now fixed; image prune → BUG-218)
      - Round 4, re-attacking only a and b:
        - a `315eb4df-8cda-42a8-ae83-2242499b015e` HOLDS (one hostile tcp+proxy case, now refused)
        - b `28592cdc-0740-4542-849f-fb6aa56d4656` HOLDS
      - c and d were not re-attacked after their round-3 fixes:
        - c's findings were hostile-class.
        - d's remaining item is BUG-218.
      - No attacker lost an original decoy in any round. Evidence is in `scratch/feat158-r2/att/<a-d>/ev-*`.
    - **Self-verified** on the real sandbox, final code: `verify-feat-158-docker-sandbox` **43/43**. New rows cover:
      - the context bypass, relative and whitespace forms, and `/proc/self/cwd` pinning;
      - a foreign down/reset waiting, including from another XDG_STATE_HOME;
      - a spoofed token, an invalid timeout, and kill -9 release (329 ms);
      - kill -9 with a live child: the lock was held until the child ended, 4.8 s.
      - Must-FAIL: the round-1 guard is graded by the same matrix and gets 5 rows wrong.
      - Other suites: `verify-bug-216` 22/22, `verify-feat-112` 17/17, `verify-bug-146-conventions-inject` 18/18. That last one failed 16/18 midway, because my CONVENTIONS text pushed the injected region past its 26000-char cap; the detail now sits outside the region, which is 25320 chars. `npm run gate` exit 0.
      - An owner-scoped removal probe in the sandbox left the foreign and the unlabelled container alone and removed the owned one.
    - **Host daemon:** counted with `docker ps -a`, excluding `*-plugin.1.*` swarm churn.
      - Containers: 67 before, 75 after. **0 missing.** The sandbox was recreated under a new ID. The 8 new containers are `claude-station-{bug150,bug150a,bug149,bug129,queue,reload}-fixture` and `bug153-{a,b}-fixed`, created 00:20–00:25Z by another process, not this lane: their data dirs sit under the real `/tmp`, while every attacker jail had a private `/tmp` and `TMPDIR` inside its own attack dir. They were left untouched.
      - Volumes: 36 → 36. Networks: 11 → 11.
      - `orchard-bug216-dind` and `orchard-a020-dind2` were untouched. The fake-host dinds and the gateway were removed when I finished.
    - **Risk bucket:** safety infrastructure against data loss. The round-4 HOLDS verdicts are on the final code for a and b only. Re-attacking c and d on the final code is optional.

### 2026-09-30 — worker
- **Note:** - **Correction to the entry above:** the round-1 guard gets **6** matrix rows wrong, not 5. They are the two context rows, the relative path, the leading space, the trailing newline, and a false refusal of the sandbox when the current context points at it (`verify-feat-158-docker-sandbox.final.log`).

### 2026-09-30 — worker
- **Note:** - **verifying, round 5 (re-attack of c and d on the final code, then fix-and-re-attack until HOLDS):**
    - **Room:** built as in rounds 2–4, fresh under `scratch/feat158-r5/att/` (bwrap jail, network via an allowlisted API proxy, real host socket, shared sandbox and other dinds masked; each jail's `/run/docker.sock` is a private fake-host dind with decoys). Attacker input was the requirement (CONVENTIONS sections), the diff (`att/<x>/input/feat158.diff`), how to run, and the tests; from round 6 on also the previous attackers' own findings. Never the fixer's reports.
    - **Round 5** (concurrent): c `610cc076-5668-4bca-8ce9-64b4e3b4bb6a` BROKEN; d `4384c68a-3274-482b-90b0-28dbc1280a32` BROKEN.
      - c, all HOSTILE: `reset` sent its deletes to the host after the run-dir socket was swapped for a symlink to `/run/docker.sock` after the guard's check (all fake-host decoys lost); `down` removed a labelled container whose image was busybox retagged `docker:29-dind`; `down --purge` removed a foreign volume swapped in after its early check; `up` let dockerd write into a volume swapped in before `docker run`. ACCIDENTAL SAFE-FAIL: concurrent `up` + `down --purge` wedged every later verb on an unlabelled volume.
      - d, ACCIDENTAL HARM: `verify-feat-155-dockerfile` force-removed the fixed name `f155-attack-nolockdown`; host-side suites' scratch servers on fixed project ids recreated or deleted an UNLABELLED same-named container (`claude-station-oom-fixture`, `-ctest`). SAFE-FAIL: `verify-bug-157-container-scripted-kill` crashed (import inside a template string); a `-next` leak.
    - **Fixes** (regressed-from: BUG-216 for the adoption rule; FEAT-158 round 2–3 for the CLI):
      - `scripts/docker-sandbox.mjs`: `reset` checks the daemon id and removes over ONE pinned API connection (a swap after connect cannot redirect it); `inspectOurs` also requires the sandbox shape (privileged, our labelled volume on /var/lib/docker, the run-dir bind); a creating `up` takes the lock, re-checks the run dir after it, and does `create` → check the attached volume → `start` (a referenced volume cannot be removed); `down --purge` reads volume ownership after the container is gone and locks even with no container; the restart path checks the run dir; the lock-file fallback execs by verified id.
      - `src/server/instance-owner.ts` `mayActOn()`: an ISOLATED instance (explicit `CLAUDE_STATION_DATA`, i.e. every scratch server) never reuses, recreates, stops or removes an unlabelled object; the shared live instance keeps adopting its legacy ones. Used by `refuseForeign` (container-manager) and every service-manager act path; sweeps still report unlabelled objects under `unowned`.
      - `src/server/container-manager.ts` `validateCandidate`: the smoke container is inspected, exec'd and removed by the id `docker run` returned. `src/server/project-builder.ts`: `ensureBuilder` removes by the inspected id; `stopBuilder` stops only this data dir's builder, by id.
      - `scripts/lib/owned-docker.mjs`: `refuseTakenName()` (suites stop before their scratch server touches a taken name); an owner key must be 16 hex. `scripts/lib/builder-cleanup.mjs`: removes by listed id.
      - Suites: `refuseTakenName` wired into the 12 host-side suites; per-run random names/tags (feat-155-dockerfile, feat-151, feat-155-prebuilt-lockdown, feat-155-image-env-policy, feat-157); owner-scoped or by-created-id cleanup in feat-155-dockerfile, feat-155-workspace-root, feat-145-container-account, feat-151, bug-107, feat-157, arch-020; scripted-kill import moved to the top.
      - `scripts/verify-bug-216-sweep-ownership.mjs`: the legacy-network row now asserts both halves — an isolated instance refuses the pre-label network, and the SHARED instance (data dir via XDG_DATA_HOME, no CLAUDE_STATION_DATA) still reuses it (22 → 23 rows).
      - CONVENTIONS "Known limit" paragraph gains the residuals below.
    - **Re-attack rounds** (anthropic `claude-opus-5-5`, separate process, clean room, own fake host each):
      - Round 6: c `53821061-8ea8-43b3-ac01-9516dcf94b92` BROKEN (HOSTILE: a sandbox tenant flipped the dind's container-private socket to an honest host proxy — the round-5 `docker exec` design, replaced by the pinned connection; restart path bound a symlinked run dir; shape forgeable on a foreign volume; lock fallback exec by name). d `dd7882af-8632-4838-85c6-864870c3462b` BROKEN (ACCIDENTAL: `verify-feat-155-workspace-root` and project DELETE paths removed unlabelled same-id containers, service containers, volumes and networks; refusals followed by a `finally` DELETE) → fixed at the source by `mayActOn`.
      - Round 7: c `6c21946d-4c75-46dc-b60e-7f45534143f4` **HOLDS** (all SAFE-FAIL; decoys byte-identical). d `c4f1a5a5-8c7c-4d71-8326-c3fd32876ee9` BROKEN, HOSTILE only (arch-020 and feat-157 cleanup bare-removed a planted container under a runtime-learnt per-run id).
      - Round 8: d `02eca9c5-3be1-40d2-902b-f257ba687e08` BROKEN, HOSTILE only (feat-145, feat-151, bug-107, arch-020 mid-run, feat-155-dockerfile and the server smoke container removed by name).
      - Round 9: d `a5cf7fa0-9708-44b4-bfc2-06fd7adc4c95` BROKEN, HOSTILE only (arch-020 took the id of a name's holder when its own `create` failed; project-builder rm/stop by name); two COSMETIC.
      - Round 10: d `0a2689b7-0bf0-4ab0-834b-70d3b8d8fc35` **HOLDS** (static sweep of every removal in `scripts/` plus server act paths; dynamic owner/guard probes; decoys 5/3/5 identical).
      - Final code = the round-7 c room and the round-10 d room, byte-for-byte (`cmp` of every changed file).
    - **Verified-by:** dispatch anthropic `claude-opus-5-5` run `6c21946d-4c75-46dc-b60e-7f45534143f4` (property c, HOLDS) and run `0a2689b7-0bf0-4ab0-834b-70d3b8d8fc35` (property d, HOLDS), plus round-4 a `315eb4df-8cda-42a8-ae83-2242499b015e` and b `28592cdc-0740-4542-849f-fb6aa56d4656` (HOLDS, on the round-4 code; `scripts/lib/docker-sandbox.mjs` then gained the tcp+proxy refusal and has not changed since round 5 began, so the round-7 c and round-10 d rooms carry the final guard and lock).
    - **Must-FAIL, executed on my own fake host before each fix:** the round-5 reset racer against the pre-fix CLI removed "6 containers, 2 networks, 4 volumes" (all decoys) and against the fix removed none (3/3 iterations); a rename-flip of the real socket to a host proxy during 40 resets removed "30 containers, 2 networks, 4 volumes" from the host on the old code, and on the pinned code 12 resets refused on the connection-id check, 1 cleared 30 containers inside the sandbox, host unchanged. Reverting `mayActOn` to the old rule lost 7 planted containers, 2 networks and a volume (`verify-feat-155-workspace-root`, `scripted-kill`); with it, 0 lost. Evidence: `att/f/ev/`, `att/f/t*.sh`.
    - **Self-verified (real sandbox, final code):** `verify-feat-158-docker-sandbox` 43/43; `verify-bug-216-sweep-ownership` 23/23; `verify-feat-112-services` 17/17; `verify-bug-146-conventions-inject` 18/18; `npm run gate` exit 0. `verify-arch-020-builder-isolation` is 9/12 in dind both before and after the `validateCandidate` change (host `/proc` needed; could not run it on the real host).
    - **Accepted limits (documented in CONVENTIONS, not fixed):** a socket-only bind mount or `tcp://` gets a different lock; a self-detaching worker is not waited for; replacing the socket after a SUITE's guard check (reset is immune); a same-uid run-dir path swap between `up`'s check and dockerd's bind; `down --purge`'s last-check→`volume rm` window; image removal by tag after an owner listing, and per-run image tags removed by name; a lying proxy / hostile docker binary; HOST_DOCKER_ID trusted when masked. BUG-218 (server base-image prune) stays open.
    - **Host daemon** (`scratch/feat158-r5/host/`): containers 94 → 92, volumes 36 → 34, networks 11 → 11. The 2 missing containers are `orchard-a020-dind2` and `orchard-bug216-dind`, and the 2 missing volumes their data volumes: removed by the ARCH-020 verifying lane (its log, 04:38), not by this lane. The sandbox was recreated under a new id by the self-test. My 14 fake-host dinds leaked 14 anonymous volumes (one each); matched by creation time with 0 users and removed. Nothing else changed.
    - **Risk bucket:** data-loss safety infrastructure plus a server ownership change (`mayActOn`) in BUG-216's regression-prone files. The round-7 c and round-10 d verdicts are the independent passes. Behaviour change to note: a non-default instance started with an explicit `CLAUDE_STATION_DATA` now refuses its own pre-label containers.
    - **Symptom of a deeper design flaw?** Yes, and handled: ownership adoption of unlabelled objects was decided per instance nowhere; it is now declared once at `instance-owner.ts` (`mayActOn`). No new ARCH filed.

### 2026-09-30 — worker
- **Note:** - **Verified-by:** dispatch anthropic/claude-opus-5-5 run 6c21946d-4c75-46dc-b60e-7f45534143f4 (clean-room, property c, round 7) — VERDICT: HOLDS
  - **Verified-by:** dispatch anthropic/claude-opus-5-5 run 0a2689b7-0bf0-4ab0-834b-70d3b8d8fc35 (clean-room, property d, round 10) — VERDICT: HOLDS
  - (Canonical form of the Verified-by lines in the entry above, so board:check can read them.)
