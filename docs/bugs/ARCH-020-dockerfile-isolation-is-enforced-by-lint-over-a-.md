```orchard-ticket
{
  "id": "ARCH-020",
  "type": "architecture",
  "title": "Dockerfile isolation is enforced by lint over a shared build daemon",
  "summary": "Project Dockerfiles build on the host's shared Docker/BuildKit daemon, so its local image store and global layer cache are visible to every project. Each isolation property — no cross-project cache sharing, no build-context escape, no reading another project's local images — is therefore enforced only by a lint rule over Dockerfile text, which clean-room rounds broke eight times.",
  "impact_if_we_wait": "The lint converged only after eight consecutive clean-room rounds each found a new evasion (quoted flags, ARG/ENV scope, COPY/WORKDIR keys, COPY --link). The enumeration is open: any new BuildKit flag or cache-keying path is a fresh bypass until someone notices, so a ninth is no less likely.",
  "current_need": "Clean-room round 5 HOLDS (cosmetics only) on an isolated daemon; review and restart Orchard to deploy.",
  "severity": "medium",
  "area": "container build isolation",
  "reported": "2026-09-29",
  "reported_by": "agent",
  "owner": "you",
  "work_state": "in_progress",
  "human_action": "review",
  "updated": "2026-09-30",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-09-29",
      "question": "Should project Dockerfile isolation be enforced structurally by a per-project builder, or kept as a lint over the shared daemon's build text?",
      "mode": "single",
      "options_keys": [
        "A",
        "B",
        "C"
      ],
      "chosen": "A",
      "chosen_on": "2026-09-29",
      "chosen_by": "user",
      "note": "Decision: A (user, 2026-09-29). Build a per-project rootless BuildKit builder; simplify the text rules that existed only for cross-project isolation; keep the run-time lockdown rules. Option B is the fallback if rootless BuildKit is not workable on this host."
    }
  ],
  "success_criteria": [
    "No project's build can read the daemon's local image store or another project's cached layers, proven by a probe, not by a Dockerfile text rule.",
    "A build cannot escape its own context or read a foreign local image even with a BuildKit flag the lint never anticipated.",
    "Removing the current lint rules does not reintroduce any of the eight clean-room breaks, because the isolation no longer depends on them.",
    "If C is chosen, the open-enumeration risk is recorded as an accepted, explicit choice rather than an unexamined default."
  ],
  "code_refs": [
    {
      "path": "src/server/project-dockerfile.ts"
    },
    {
      "path": "src/server/container-manager.ts"
    }
  ],
  "related": [],
  "recurrence_evidence": [
    "FEAT-155"
  ],
  "verification": [],
  "verification_class": "arch",
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

# ARCH-020 — Dockerfile isolation is enforced by lint over a shared build daemon

## Violated invariant

**A project's Dockerfile build can read nothing outside its own build context and Orchard's base image — no other project's cached layers, no other local image, and no daemon-global cache — and this must hold for any Dockerfile a project can write, not only the shapes a lint rule anticipated.**

That is one testable sentence: give two projects builds that would collide (same content, a foreign image reference, a shared cache mount) and the daemon must keep them apart regardless of how the Dockerfile is written.

## The design that produces this class

Project Dockerfiles are built by handing text to the **host's single shared Docker/BuildKit daemon** (`container-manager.ts` shells out to `docker build`). That daemon owns one local image store and one global layer cache, both visible to every build it runs. So the isolation the invariant demands is not a property of where the build runs — every project runs in the same place — it can only be reconstructed by controlling **what text reaches the daemon**.

That is exactly what `project-dockerfile.ts` does: it canonicalises the Dockerfile, lints it (flag allow-list, ONBUILD/heredoc/`# syntax` refusal, image-reference refusal), and injects a per-project cache-scope step so BuildKit's content-addressed cache keys diverge between projects. Every isolation property is therefore enforced by a **rule over Dockerfile text**, and a rule over text is only as complete as the author's model of how BuildKit reads that text. The assumption that keeps turning out false: *"the canonical text we linted is the text BuildKit will act on."* BuildKit strips quotes and backslashes from flag words, keys COPY/WORKDIR on content, and lets `COPY --link` build off-scope — none of which the text, read literally, revealed.

## Why local patches did not hold

Each clean-room round broke a *different* text rule over the *same* shared-daemon design — the signature of a class, not eight separate bugs:

- **P9 — quoted flag words.** BuildKit's `extractBuilderFlags` unquotes before reading the flag name, so `RUN --mo"u"nt=…`, `--netw"o"rk`, `COPY --fr"o"m` passed a literal-text lint and executed. Patched: refuse flag words containing a quote or backslash. Left reachable: every *other* way BuildKit's parse differs from the literal text.
- **P10 (×4) — cache-key scope.** (a) The shared build cache leaked across projects (identical RUN → `CACHED` in a second project). Patched with a `--build-arg` scope → (b) an `ENV` in a stage **shadowed** the ARG → patched with a tmpfs `--mount` scope → (c) **COPY/WORKDIR** key on content, not the RUN environment, so they still shared layers and leaked mtimes → patched by rooting every stage with a per-project `COPY --from` scope step → (d) **`COPY --link`** builds on scratch and merges, so its key never chains on that scope step → patched by turning the flag lint into an allow-list.

Every patch was individually correct and each closed the exact break it was shown. The failure recurred anyway, four times on the single P10 property alone, because the enforcement surface — Dockerfile text interpreted by a shared daemon — is unbounded in a way the patches are not. That is the honest test the ARCH template names: correct patches, recurring failure ⟹ the design, not the patch, is wrong.

## Options considered

See the structured decision block for the priced options. In summary: **A** a per-project rootless BuildKit daemon with its own cache and image store (isolation structural, most expensive); **B** a sandboxed one-shot builder per build (structural, no standing daemon, but every build is cold); **C** keep the lint over the shared daemon (cheapest, cache-fast, but the evasion enumeration stays open).

## Migration path

Landable, one step at a time, keeping the shared-daemon path working until the new one is proven:

1. **Introduce a `buildBackend` seam** in `container-manager.ts`/`project-dockerfile.ts` — one authority (ARCH-010) for "how a project image is produced" — with today's shared-daemon path as the default implementation. No behaviour change; the lint stays as defence in depth.
2. **Add the chosen isolated backend** (A: a per-project rootless BuildKit instance keyed on the project's build-record identity; B: a disposable buildctl invocation) behind the seam, off by default, opt-in per project.
3. **Run the eight clean-room breaks against the isolated backend with the lint rules disabled.** They must all fail to reproduce structurally — that is the proof the isolation no longer depends on the text rules.
4. **Flip the default** once green; keep the lint as a thin sanity layer, not the load-bearing boundary. Rollback at any step is reverting the default, since the shared-daemon path is never removed until step 4 holds.

## Proof bar — what would make the new design right

A probe, run against the isolated backend **with every current lint rule turned off**, that reproduces each of the eight clean-room breaks and shows all eight now fail structurally: no cross-project `CACHED`, no leaked mtime/nonce, no foreign local image readable, no context escape via any BuildKit flag (quoted or not, `--link` included). A test that only passes because the lint is still on proves nothing — the lint is the thing being retired. **What would falsify the redesign:** if isolating the builder costs more (cold multi-GB ML rebuilds, per-project daemon supervision) than the residual risk of the converged lint, C was the right call and this ticket should record that.

## Accepted residual (out of the threat model)

An actor with **Docker daemon access already equals host root** and can pre-create a local image under a project's tag (`claude-station-project-<id>:df-<hash>`) that Orchard then runs without a rebuild. This is the same class as round 8's accepted TOCTOU residual; a label check does not help because labels are forgeable with docker access. It is **deliberately out of scope** — the threat model is a project's own Dockerfile text against other projects on the same host, not an actor who already owns the daemon. Recorded here so it is not rediscovered as a novelty.

## Context pack

- Enforcement lives in `src/server/project-dockerfile.ts` (`lintFlagWords`, `ALLOWED_FLAGS`, `scopedBuildText`, `cacheScope`, ONBUILD/`--`/`orchard-*` refusals) and `src/server/container-manager.ts` (the shared-daemon `docker build` call and the per-project scope context).
- Full recurrence record: FEAT-155 activity log, rounds 9–14 (runs `451aa88a`, `143c1a3a`, `ac8ddf26`, `a329d179`, `a919d9b5` BROKEN; `08cef3b3` HOLDS). The round tally and each break are in the round-14 entry.
- Suites that encode the eight breaks today: `scripts/verify-feat-155-dockerfile.mjs` (71 checks).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-29 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-09-29 — worker (fixing, round 1)
- **Decision: A (user, 2026-09-29).** Recorded in `decision_history`; the open decision is cleared, so the INDEX owner cell leaves 👤.
- **Hypothesis confirmed** on this host: `moby/buildkit:v0.33.0-rootless` (Docker Hub, pinned by digest) runs as an unprivileged container (seccomp/apparmor/systempaths unconfined, the documented rootless deployment); worker = oci executor, process sandbox, overlayfs. buildx drives it through a `remote` driver (`docker-container://<name>`). A `FROM <local-only image>` fails with `pull access denied`. Nothing blocked A, so option B was not needed.
- **Plan review** (OpenAI via `dispatch-client.mjs`; transcripts `01a0ee7b-72fe-73e1-8207-7dd3dab606ab`, `01a0ee7d-903f-76b3-b6e2-06fd98a4eeb6`): **REJECT twice**. Adopted:
  - The builder names nothing on the host. It exports an OCI layout; Orchard checks it (regular files only, exactly one manifest, every blob's size and digest), writes its own index, and `docker load`s only the referenced blobs.
  - The data dir is part of the builder name.
  - Builds are serialised per project, at most 2 run at once, and there is a disk preflight (25 GiB).
  - Memory/CPU/pids limits on the builder.
  - Adoption checks the full config and fails closed on foreign names.
  - A length-prefixed rebuild key that includes the builder digest.
  - Declined, with reasons:
    - **Build egress policy.** The session container has the same bridge reach, so a network rule is a separate decision.
    - **Cross-process locks.** One server owns a data dir, as it does for every other state file.
    - **Resolved-digest recording.** Deferred.
- **Built:**
  - `src/server/project-builder.ts` (new): the builder lifecycle, the import check and the locks.
  - `container-manager.ts`:
    - builds on the project's builder;
    - each build gets its own reflinked copy of the base layout;
    - promotion happens only if the record generation and repo are unchanged;
    - `removeProjectBuildState`, and the orphan-builder sweep.
  - `project-dockerfile.ts`:
    - **all text rules removed** (linter, canonicaliser, flag allow-list, image-ref ban, ONBUILD/ADD/heredoc/`# syntax` refusals, cache-scope injection);
    - `dockerfileHash` v2;
    - `generation` and `LABEL_DF_DATA`;
    - `forgetBuildRecord`.
  - `index.ts`: project delete removes the builder, its volume, its images and its record; `/containers/orphans` also lists and removes builders.
  - Suites: `verify-arch-020-builder-isolation.mjs` (new), `lib/builder-cleanup.mjs` (new), `verify-feat-155-dockerfile.mjs` reworked, and a cleanup line in `verify-feat-155-dockerfile-ui.mjs`.
- **Proof, executed** (`verify-arch-020-builder-isolation.mjs`, **19/19**; synthetic throwaway repos). BEFORE is the shared daemon with Orchard's old flags and the text rules off. **MUST-FAIL: 5/5 leaks reproduce.**
  - Same RUN nonce in both projects.
  - The ENV-shadow nonce is shared.
  - COPY mtime: B gets A's `1111111111`.
  - COPY --link mtime is shared.
  - B reads A's cache-mount poison.
  - Local-image reads were already blocked before, by `--pull`. Stated honestly: no before/after difference there.
  - AFTER, through a scratch Orchard with two projects:
    - different nonces, no CACHED step;
    - each image keeps its own mtimes (COPY and COPY --link);
    - B sees `none` from the shared cache-mount id;
    - warm control: own cache reused (nonce unchanged, CACHED);
    - FROM / `COPY --fr"o"m` / `RUN --mount from=` a local image fail, and the secret is in no image or log;
    - ADD on the host loopback gets connection refused;
    - builders are per project, stopped, adopted (same id across builds), and mount only their own volume;
    - crash staging is swept;
    - a squatter is refused and not removed, on build AND on delete;
    - another data dir's delete leaves this one's images;
    - delete removes the builder, volume, images and record;
    - the victim image tags keep their ids.
  - Three further must-FAIL runs, each against a constructed pre-fix variant that was restored afterwards:
    - builder recreated every build (`systempaths` is not echoed in SecurityOpt);
    - delete removed a squatter (found by the verifier);
    - a scratch data dir's delete removed another data dir's same-id images (found by the verifier).
  - Egress observation only: builder network = session network = bridge.
- **Anti-regressions:** `verify-feat-155-dockerfile` 66/66 (71 before: 9 lint unit checks and 3 live refusal checks retired, and 7 structural checks added; the unit layer is 17/17), `dockerfile-ui` 9/9, `prebuilt-lockdown` 25/25, `image-env-policy` 15/15, `gpu-env-mem` 25/25, `bug-107` 23/23, `workspace-root` 80/80, `container-ui` 9/9. `npm run gate` exit 0.
- **Real artifact:** `<proj>`'s real `Dockerfile.orchard` was built in-process with a scratch data dir and another id (on the code before the last three fixes).
  - Cold: 1371 s, dominated by downloading torch at about 3 MB/s from download.pytorch.org (the host measured the same speed).
  - Warm forced rebuild: 56 s. Today it takes about 7 s; every build now pays the OCI export, digest check and `docker load` of a 5.2 GB image.
  - In the image: torch 2.11.0+cu128, `cc`, Python.h, CLI 2.1.281.
  - Builder cache 22.6 GB.
  - Cleanup removed the builder, volume and image.
- **Clean room** (anthropic `claude-opus-5-5` via `scripts/dispatch.mjs --cwd <room>`). Codex `workspace-write` was measured to deny the docker socket, so an OpenAI verifier could not run a build.
  - Round 1, run `47059bf4-f449-4456-ac6c-14dbba95fc33`: **INCONCLUSIVE**, because node was not allowed (my dispatch omitted `--allow-tools`). From reading the code it raised the delete-squatter suspicion, which was confirmed and fixed.
  - Round 2, run `a0461cac-2213-40a7-b9bd-7c479c704f84`: **no verdict, stopped by an INCIDENT.** The verifier POSTed `/api/containers/orphans` on its scratch server. The container half of that sweep (pre-existing, not data-dir scoped: every `claude-station=1` container whose project is not in THIS registry) **force-removed 44 containers it did not create**. That included the containers of 6 live registered projects (3 running, among them `<proj>`, whose image the other lane was building) and 38 other lanes' test containers.
    - My charter listed that endpoint as something to test, without scoping it. That is my error.
    - I did not recreate anything. The live server recreates a project's container at its next session start. Anything only in those containers' writable layers is gone, and sessions running in them were killed.
    - Before that point its B6 cases all HELD: squatters on the orphan/delete paths, a second data dir, id re-use on another repo.
    - It also found that delete removed same-id df images built by another data dir (fixed, see above).
    - Evidence (the before/after container lists): `~/.local/state/claude-station/scratch/arch020/v2-evidence/`.
  - No `Verified-by`. The harm class is security + lifecycle, so the rounds have not converged.
- **Needs you:**
  - (1) the incident: check the affected projects and other lanes;
  - (2) whether the orphan container sweep should be scoped to its own data dir (pre-existing; suggest a BUG ticket);
  - (3) another clean-room round, with a charter that forbids `/api/containers/orphans` POST;
  - (4) an Orchard restart to deploy.
  - Disk: about 23 GB per Dockerfile project's builder cache; old dockerd build cache from earlier project builds can be pruned by you.
- **Residual:**
  - a builder left running by a server crash is stopped only at that project's next build;
  - builder compromise still trusts the buildx receiver and the dockerd importer;
  - no build egress policy (same reach as the session);
  - a warm rebuild of a large image is slower (export and load).
- **Symptom of a deeper design flaw?** Yes, a separate one: the container orphan sweep decides ownership by "not in my registry" on a shared daemon. That is the same shared-daemon class as this ticket, now for containers.
- **regressed-from:** none. The incident comes from a pre-existing sweep, reached through my charter.
- **Changed (uncommitted, no git writes):**
  - `src/server/project-builder.ts` (new)
  - `src/server/container-manager.ts`
  - `src/server/project-dockerfile.ts`
  - `src/server/index.ts`
  - `scripts/verify-arch-020-builder-isolation.mjs` (new)
  - `scripts/lib/builder-cleanup.mjs` (new)
  - `scripts/verify-feat-155-dockerfile.mjs`
  - `scripts/verify-feat-155-dockerfile-ui.mjs`
  - this ticket
  - INDEX (owner cell)

### 2026-09-30 — worker
- **Note:** **verifying, round 2 (clean room on top of BUG-216):**
  - **Isolation (hard rule).** Every build, container and sweep in this round, mine and the verifier's, ran on a docker-in-docker daemon, never the host daemon. The confinement is OS-level, not a wrapper: `~/.local/state/claude-station/scratch/arch020/r2v/jail/jail.sh`.
    - It is a bwrap jail with its own user, pid, net, ipc and uts namespaces, and a read-only `/`.
    - `/run/docker.sock` is masked with /dev/null. `/run/user/1000` (dbus, ssh-agent) and the system bus are masked.
    - Its only network is loopback. Docker goes through a unix-socket gateway to the dind daemon only. The API goes through a CONNECT proxy allowlisted to Anthropic hosts plus `auth.docker.io` (the build client's anonymous Docker Hub token).
    - Probed from inside: the host socket was refused (`curl --unix-socket` rc 7, `/usr/bin/docker -H unix:///var/run/docker.sock` cannot connect), port 4317 was unreachable, `umount` of the mask was denied, host pids could not be signalled, and the repo was read-only.
    - The dind is `orchard-a020-dind2` (id `0fe4e688…`, started with `--pid=host`). It sees the home dir (`~`) read-only and the room plus `~/.claude` read-write, so the stale-file-bind drift check and host `/proc` reads behave as on a real host. On a plain dind every keep-last-good check failed on spurious drift; that is an environment artifact, and the pre-BUG-216 snapshot showed the same.
    - **The jail caught a suite hazard.** `verify-arch-020-builder-isolation.mjs`'s BEFORE builds dropped `DOCKER_HOST` from their env, so on any dind setup they would have built on the HOST daemon. Fixed: the env now keeps `DOCKER_HOST`.
  - **Host `docker ps -a`**, snapshotted before and after every run (31 diffs, `r2v/ev/host-*.txt`, `missing-*.txt`):
    - 94 at the start, 97 at the end. **0 containers went missing that this lane could have touched.**
    - Every missing id falls in one of two groups:
      - self-restarting swarm `*-plugin.1.*` tasks;
      - FEAT-158's own dind containers (`f158att-*-host`, `orchard-docker-sandbox`), which that lane recreated with the same names.
    - The jail has no route to the host daemon at all.
  - **Clean-room rounds** (anthropic `claude-opus-5-5` via `scripts/dispatch.mjs --cwd <room>`, run inside the jail). Each room was a fresh copy of the tree without `.git`, `docs/` or ambient instruction files, plus the ARCH-020+BUG-216 diff. The input was the property list, how to run things and the fixer's suites; no fixer reports.
    - **Round 3, run `40242f82-7adc-480d-97ac-71b6600c3761`: BROKEN** (it first ended its turn with its suites in the background, and was resumed with a foreground-only rule).
      - The break: P1/P2 across data dirs. Two Orchards with the same project id on the same repo computed the same `claude-station-project-<id>:df-<hash>`. The second one's `ensureDockerfileImage` returned early on "the tag exists", then ran the FIRST one's image: the first builder's cache-mount sentinel was inside it, and its `dockerfile-data` label was the first server's key.
    - **Round 4, run `ae77029f-58f3-4819-9def-7772791e0048`: INCONCLUSIVE.** P1, P2, P4 and P5 held, including the round-3 repro. Its own P3 probe was cut off before it ran.
    - **Round 5, run `ae9775f9-b558-467b-841d-35fee15531ff`: HOLDS, cosmetics only.**
      - 42 P3 probe builds on two servers: every spelling of a local marker image, another project's df image as FROM, COPY --from or mount (same server and across servers), `# syntax=` pointing at a local image or `orchard-base`, and named contexts. Result: `leaks=0 foreignChanges=0`.
      - 14 hand-made OCI layouts fed to `checkOciLayout` and `importCheckedLayout`: multi-manifest, nested index and tag-carrying shapes were refused, and the rest were imported only as the project's own `cand-` tag.
      - Spot checks of P1, P2, P4 and P5 held. The suite passed 21/0.
  - **Fix (round 3 finding):**
    - `dockerfileHash` hashes the owning data dir's key (`owner: dataKey()`).
    - `isOwnProjectImage` also requires `claude-station.dockerfile-data` = this data dir's key.
    - `ensureDockerfileImage` returns early only for an own image (it used to accept any existing tag).
    - Status `built` uses the same test.
    - `pruneProjectImages` (and its dangling prune) filter on this data dir's label, so a same-id image of another data dir is never pruned.
    - The hash change costs nothing extra: ARCH-020 is not deployed and has already moved every tag to v2.
  - **Must-FAIL.** New suite checks "P1 across data dirs …" and "P4 across data dirs …" (a second real scratch server, same id, same repo, after the first one's build).
    - On the pre-fix code: **FAIL**, `data3 = dataA`, the second server ran the first's image id (`r2v/ev/mf2-*.out`).
    - After the fix: PASS (`fix1-*`, `final-*`).
  - **Cosmetic, fixed:** the suite's squatter containers are removed with `-v` (they had left 2 anonymous volumes behind per run). Not fixed: an empty `FROM scratch` final image is refused with "not a single-image manifest", which is misleading.
  - **Suites on the isolated daemon (after the fix):**
    - Passed:
      - `verify-arch-020-builder-isolation` **21/21** (19 before, plus the 2 new checks);
      - `verify-bug-216-sweep-ownership` **22/22**;
      - `verify-feat-155-image-env-policy` 15/15;
      - `verify-feat-155-dockerfile-ui` 9/9 (brave `--no-sandbox` inside the jail only).
    - Environment-limited, counted as neither pass nor fail:
      - `verify-feat-155-dockerfile` **64/66**. The 2 fails read a ROOT process uid from host `/proc` through the jail's user mapping (shows 65534): the MUST-FAIL baseline and "no process runs as root". The other lockdown checks pass (PID1 1000:1000, zero caps).
      - `verify-feat-155-prebuilt-lockdown` 24/25, the same `/proc` limit.
      - `verify-feat-155-container-ui` 6/9: the UI sets GPU on, and the dind has no CDI vendor.
    - Not run: `verify-feat-155-workspace-root` (GPU auto), for the same reason.
  - `npm run gate` exit 0. `board:check`: see below.
  - **Verified-by:** dispatch anthropic `claude-opus-5-5` run `ae9775f9-b558-467b-841d-35fee15531ff` (clean-room round 5, HOLDS, cosmetics only), run in an OS-level jail on an isolated dind daemon. Rounds 3 (`40242f82-…`, BROKEN, fixed above) and 4 (`ae77029f-…`, INCONCLUSIVE on P3) preceded it.
  - **Observed, not in scope:**
    - An Orchard server prunes the legacy `claude-station-base:u1000-g1000` tag on the daemon it runs on. This is the existing BUG-107 reclaim.
    - The orphan sweep removes an orphaned project's builder but not its df image (the documented scope).
  - **regressed-from:** none. The cross-data-dir tag collision was introduced by this ticket's own round-1 image naming. BUG-216 had scoped containers, networks and volumes by owner, but not df image tags.
  - **Changed this round (uncommitted, no git writes):**
    - `src/server/container-manager.ts`
    - `src/server/project-dockerfile.ts`
    - `scripts/verify-arch-020-builder-isolation.mjs`
    - `scripts/verify-feat-155-dockerfile.mjs` (the hash unit check now covers the owner)
    - `scripts/verify-bug-216-sweep-ownership.mjs`: my `HOST_DOCKER_ID` fallback was superseded by FEAT-158's shared guard, which that lane edited concurrently.
    - this ticket
  - **Cleanup:** `orchard-a020-dind` (mine, superseded) was removed together with its data volume; see the next entry for the rest. Evidence and rooms are in `~/.local/state/claude-station/scratch/arch020/r2v/`.
  - **Needs you:** review, then an Orchard restart to deploy (ARCH-020 and BUG-216 together). Not done here.

### 2026-09-30 — worker
- **Note:** **Cleanup (round 2):** removed the scratch dind containers `orchard-a020-dind2` (this lane) and `orchard-bug216-dind` (BUG-216's), each with its data volume, after confirming both held only the seeded base, redis, busybox and buildkit images and this lane's anonymous test volumes: 0 containers, no live connections. Host `docker ps -a`: 97 before, 95 after; exactly those 2 went missing (`r2v/ev/missing-dind-rm.txt`). The jail gateway exits with each jail run, and none is left running.
