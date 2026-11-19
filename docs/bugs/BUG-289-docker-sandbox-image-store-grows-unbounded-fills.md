```orchard-ticket
{
  "id": "BUG-289",
  "type": "bug",
  "title": "Docker sandbox image store grows unbounded, fills the SSD",
  "summary": "The Orchard Docker sandbox had grown to ~120 GB of old images on the SSD (765 dangling plus 160+ claude-station-rt and orchard-confined-run images, most weeks old) because nothing ever removed superseded images. The leak crowded a nearly-full SSD.",
  "impact_if_we_wait": "The sandbox store keeps growing ~2.6-2.9 GB per rt/confined build with no ceiling, eventually exhausting the SSD and stalling every session and verify suite that needs the sandbox.",
  "current_need": "none; optional: user may still run the HDD relocation (see 2026-11-05 entry).",
  "severity": "high",
  "area": "docker-sandbox",
  "reported": "2026-11-03",
  "reported_by": "worker (fix lane)",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-11-19",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Sandbox image store is bounded: a prune removes unused images/build cache older than N days and runs on every `up`.",
    "confined-run and rt images are reused across runs with identical inputs (no per-run growth).",
    "The dind data-root is relocatable onto another filesystem via ORCHARD_DOCKER_SANDBOX_DATA, with an fs-suitability check that stops rather than building a broken sandbox.",
    "Live prune reclaimed the accumulated ~120 GB; gate passes."
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "0a421f57-115b-4ca6-b6f9-a8209777615b",
      "verdict": "broken",
      "verdict_on": "2026-11-03",
      "recorded_at": "2026-11-03T12:54:24.640Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "687494f47cda4a3f6113593225ba4f3d83b4ab546cf48891e44e440f6252d522",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "b5d18c60-f64e-4e4f-98ae-63a89bb84a0a",
      "verdict": "holds",
      "verdict_on": "2026-11-03",
      "recorded_at": "2026-11-03T13:28:00.316Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "3a130f7a8fabe8aa8185f6623ba85f620feccef61aac859ee8b59d317b687ac6",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "e72517bd-4875-4cfa-9d9b-8d86e92d3096",
      "verdict": "holds",
      "verdict_on": "2026-11-05",
      "recorded_at": "2026-11-05T06:35:32.925Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "4a55c714e07080cde6a6062078c646c60240cec57f2718a20a32b4d3f06fb117",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a1b796-989e-77a2-b6d5-83b824ba4f0d",
      "verdict": "broken",
      "verdict_on": "2026-11-07",
      "recorded_at": "2026-11-07T19:58:22.177Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs"
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "e4400899-2770-4b91-bb6e-ec8f4af8f4be",
      "verdict": "broken",
      "verdict_on": "2026-11-19",
      "recorded_at": "2026-11-19T15:13:37.862Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "d1963fec165e17761b78e7a4c3f4f4d766ef52cd600e2ac219ac34ac7e4e7b35",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a1f45e-e887-7663-922b-136ce32c27d7",
      "verdict": "broken",
      "verdict_on": "2026-11-19",
      "recorded_at": "2026-11-19T15:15:41.265Z",
      "author": "lane BUG-289/FEAT-201/BUG-217",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "b1ff98f9232c588b7d079fbc290851c6226fe1c0def70a9ba63bae83bbd22c85",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a1f460-ee38-7621-8adf-f809ac6ae1e1",
      "verdict": "broken",
      "verdict_on": "2026-11-19",
      "recorded_at": "2026-11-19T15:19:23.183Z",
      "author": "lane BUG-289/FEAT-201/BUG-217",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "19cc32084f6f955cea8477f1698345b6b7faf09fff5d95f7dfcf83a2a226ac77",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a1f464-f4d3-7ff0-bb23-0f13efd757c3",
      "verdict": "holds",
      "verdict_on": "2026-11-19",
      "recorded_at": "2026-11-19T15:29:39.648Z",
      "author": "lane BUG-289/FEAT-201/BUG-217",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "5e1c59d3e134ebc832d1580671a0e2e3828a07764074695edc211037baa35f8f",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a1f479-a79b-7ce0-92be-172d036e1895",
      "verdict": "holds",
      "verdict_on": "2026-11-19",
      "recorded_at": "2026-11-19T15:54:46.327Z",
      "author": "lane BUG-289/BUG-287 r2",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "10c326d00ce96ab2fcde4ded3dd64e1b6a1107b9a6a38dbb1c3c26bfe5e826e6",
      "verify_mode": "mixed-state",
      "note": "Unknown free-space reading now fails CLOSED (keeps images, WARNING logged + counted); real 0 still prunes; byte cap unchanged."
    }
  ],
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

# Docker sandbox image store grows unbounded, fills the SSD

## Context pack

- `scripts/lib/docker-sandbox.mjs` — the sandbox daemon lib; owns paths, the isolation guard, and now `sandboxDataRoot()` (data-root relocation) + fs-suitability checks.
- `scripts/docker-sandbox.mjs` — the `up|status|reset|prune|down` CLI.
- `scripts/lib/confined-run.mjs` — confined runner; already reuses run images by content hash (`depsKey`), so it is NOT the growth source; its reaper removes containers only.
- The 120 GB lives INSIDE the host-daemon named volume `orchard-docker-sandbox-data` (driver local, label `orchard.docker-sandbox=1`), mounted at `/var/lib/docker` in the dind container, backed on `/` (btrfs SSD).

## What was wrong

Nothing bounded the sandbox daemon's image store. `container-manager.pruneSupersededImages()` only removes images of the CURRENT owner-key/shape, so `claude-station-rt:*` and `orchard-confined-run:*` images from prior builds/keys/times accumulate forever; dangling (`<none>`) layers from untagged superseded builds were never collected. Measured: 995 images / 150.1 GB (120.1 GB reclaimable), 765 of them dangling.

## Activity log (append-only)

### 2026-11-03 — worker (fix lane)

**Understood:** sandbox daemon store at 150 GB / 120 GB reclaimable on a 89%-full SSD. Ownership confirmed: volume `orchard-docker-sandbox-data`, code paths above. `/backups` (the requested relocation target) does not exist on this host; the real roomy HDD is `/mnt/backup` (ext4, 7.3 TB, 5.7 TB free).

**Changed (unstaged):**
- `scripts/lib/docker-sandbox.mjs`: added `sandboxDataRoot()`, `detectFsType()`, `freeBytesAt()`, `DIND_OK_FS`, and `ORCHARD_DOCKER_SANDBOX_DATA` / `ORCHARD_DOCKER_SANDBOX_DATA_BASE` env. Resolver prefers a suitable `<base>/orchard-docker-sandbox` (base default `/backups`), else falls back to today's volume with a visible warning; an explicit path on an unusable fs (ntfs/exfat/vfat) THROWS so `up` stops rather than building a broken sandbox.
- `scripts/docker-sandbox.mjs`: `up` resolves the data-root and creates the named volume BIND-BACKED (`--opt type=none,o=bind,device=<dir>`) when a dir is chosen — name+label unchanged, so every FEAT-158 ownership check still holds; warns when an existing volume's backing differs (relocation needs `down --purge`). Added `prune` verb (sandbox-only, guarded by the isolation check + daemon lock exactly like `reset`; removes UNUSED images + build cache older than N days, default 7) and runs it on every `up` (`--no-prune`/`--prune-days N`). `status` now reports the resolved data-root and the current volume backing.

**Verified:**
- Resolver unit tests against REAL filesystems (btrfs `/`, ext4 `/mnt/backup`, vfat `/boot`): default→volume+warning; explicit `/mnt/backup`→bind; relative→throw; explicit vfat→throw; base `/mnt/backup`→bind. All as designed.
- confined-run reuse: ran `confined-run.mjs` twice on the live tree — `orchard-confined-run:*` image count held at 80 both runs (reuse by content hash, no growth). PASS.
- Leak-stopper, LIVE on the sandbox: `sandbox:docker -- prune --days 7` reclaimed **109.8 GB images + 5.4 GB build cache**; sandbox images 150.1 GB→36.7 GB; host SSD free 147 G→189 G (net +42 G under concurrent load), sandbox host volume 183 G→71 G (−112 G). Exit 0.
- `npm run gate`: PASS (exit 0) — leak-gate + typecheck.

**Not done (handed to the user/orchestrator):** the live host-daemon RELOCATION to `/mnt/backup` was NOT executed. This lane runs inside a lane (host `up`/`down` refuse by design) and the sandbox is live/shared (`--restart unless-stopped`); swapping a 120 GB volume out from under in-flight work is a `live` hard-stop. Procedure once the sandbox is idle: `npm run sandbox:docker -- down --purge` (removes only the labelled `orchard-docker-sandbox-data` volume — allowed), then `ORCHARD_DOCKER_SANDBOX_DATA=/mnt/backup/orchard-docker-sandbox npm run sandbox:docker -- up` (recreates empty on the HDD; images rebuild on demand). `/backups` does not exist, so confirm `/mnt/backup` is the intended HDD.

**High-stakes:** `docker-sandbox.mjs` is security-critical (host-daemon isolation). An independent clean-room verify pass is warranted before landing.

**Symptom of a deeper design flaw?** no — a missing retention/GC step, now added; owner-scoped `pruneSupersededImages` could later be unified with the age-based sandbox prune but that is not required to close this.

### 2026-11-03 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run 0a421f57-115b-4ca6-b6f9-a8209777615b — VERDICT: BROKEN — mixed-state candidate 687494f47cda. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-11-03 — worker (fix lane, round 2)

**Fixing the BROKEN verdict (0a421f57) + hardening by construction.** regressed-from: BUG-289 round 1 (the fs-suitability check this fix replaces was introduced there; the data-root resolver has no prior ticket).

**Must-FAIL reproduced on round-1 code (both breaks):** a dangling symlink to a not-yet-existing vfat path was ACCEPTED as btrfs (existsSync treated the symlink target as missing, so the fs check ran on the symlink's parent); an explicit path whose fs was undetectable (findmnt absent from PATH) was ACCEPTED as fsType 'unknown'. Proofs in `/tmp` scratch, both confirmed ACCEPTED before the fix.

**Changed (unstaged):**
- `scripts/lib/docker-sandbox.mjs`: rewrote the resolver to fail CLOSED on an ALLOWLIST (ext4/xfs/btrfs). New `resolveDataPath()` resolves the path KERNEL-STYLE, component by component, following every symlink (incl. dangling), never collapsing `..` lexically before symlinks are expanded, and REFUSING a symlink loop or any non-ENOENT lstat error (EACCES etc.). New single grader `gradeStoreDir()` that BOTH explicit and base mode funnel through: refuses relative/undetectable-fs/non-allowlisted-fs, and requires the resolved store dir to be a DEDICATED dir named `orchard-docker-sandbox` so the bind `device=` can never be the host daemon's data-root (`/var/lib/docker`), `/`, or any shared/system path. Returns the RESOLVED path as `dir` (what is graded == what `device=`/`mkdir` use). Base mode: a relative base or a store subdir that escapes via symlink falls back SAFELY to the volume (never a cwd-relative or escaped bind). `SANDBOX_DATA_DIRNAME` export added; `resolveDataPath` exported.
- `scripts/docker-sandbox.mjs`: tightened `prune`'s TOCTOU to match `reset` — it now connects ONCE (`pinnedDocker`), proves `info.ID === targetId` on that connection, and issues every prune (`POST /images/prune` with `dangling=false`+`until`, `POST /build/prune`, `GET /system/df`) over that SAME socket, so a swapped socket cannot redirect a prune to the host daemon. `pruneSandbox` is now async; both callers (`up`, the `prune` verb) await it.

**Verified:**
- `scripts/verify-bug-289-resolver.mjs` (enriched to 23 cases): both round-1 breaks closed; dangling symlink / symlink-to-symlink / symlink-loop / `..`-after-symlink / `..`-after-missing-component / EACCES-hidden symlink all REFUSED; findmnt-absent REFUSED (never 'unknown'); `/var/lib/docker`, `/`, `/etc`, bare `/mnt/backup` REFUSED (dedicated-dirname); base-mode symlink-to-host-path and relative base fall back to volume; `/mnt/backup/orchard-docker-sandbox` ext4 ACCEPTED. 23/23.
- Pinned `prune` path exercised LIVE against the running sandbox daemon with a 100-year `--days` (reclaims nothing): GET /info + ID re-check + POST prunes + df over one pinned socket, exit 0. (Note: the live sandbox store has regrown to ~320 GB — the relocation/live-prune handoff from round 1 is still pending.)
- `npm run gate`: PASS (exit 0).
- Independent clean-room verify on the working-tree files (`--mixed`, both files frozen): openai PREFERRED but quota-exhausted until 2026-11-04, so anthropic fallback (documented). Four successive rounds each surfaced a real hole — lexical `..`, unresolved returned `dir`, base-only grading, EACCES-as-absent, `..`-past-missing, host-data-root/`/` destinations, base-mode escape + relative base — each fixed by construction; final run **HOLDS** (anthropic run b5d18c60-f64e-4e4f-98ae-63a89bb84a0a, mixed-state candidate 3a130f7a8fab), fail=0.

**Still UNTESTED (live-daemon, out of this lane's reach):** prune leaving in-use images alone and the `until` filter semantics on a real store; prune racing a guarded suite / lock held by another holder. Minor latent note (pre-existing, shared with `reset`): `acquireDaemonLock` times out via `process.exit(3)`, which `up`'s best-effort try/catch around the on-up prune cannot catch — under lock contention `up` could exit before printing its DOCKER_HOST export. Not a contract break; flag for a possible follow-up.

### 2026-11-03 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run b5d18c60-f64e-4e4f-98ae-63a89bb84a0a — VERDICT: HOLDS — mixed-state candidate 3a130f7a8fab. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-11-05 — worker (relocation lane) — BLOCKED, relocation still not executed

**Task:** run the live relocation of the sandbox store to the HDD (`/mnt/backup`) now that the user approved it. Could not execute: TWO independent walls, each on its own sufficient to stop this lane.

**Wall 1 — lane-refusal by design (the charter's declared stop condition).** This process inherits `ORCHARD_LANE_DOCKER=unix://~/.local/state/claude-station/docker-sandbox/run/docker.sock` (confirmed via `printenv`; `DOCKER_HOST` is the same). `inheritedLaneDocker()` classifies that as `kind:'sandbox'` (valid absolute unix path, not a well-known host socket), so `IN_LANE === true` in `scripts/docker-sandbox.mjs`. Therefore:
  - `down`/`down --purge` → `laneRefuses('down')` HARD-REFUSES (exit 2). Exact text (reproduced from source `laneRefuses`, line ~388; NOT run live — see Wall 2; home path shown as `~`): `REFUSED: sandbox:docker down acts on the HOST daemon, and this process inherits ORCHARD_LANE_DOCKER=unix://~/.local/state/claude-station/docker-sandbox/run/docker.sock (it runs inside a lane whose daemon was decided at launch). The live server starts the sandbox when it launches a session. To manage it from here anyway, opt out explicitly (logged): eval "$(npm run -s sandbox:docker -- host-env '<reason>')"`
  - `up` → `laneRefuses('up')`: since the declared daemon answers (socket present), it only re-prints the export line and does NOT manage/recreate the volume — so `up` from a lane cannot recreate the store on the HDD either.
  Charter instruction for this case: report the exact refusal and STOP; do NOT bypass with the `host-env` opt-out. Honoured — not bypassed.

**Wall 2 — `npm run sandbox:docker` is permission-gated in this session.** Every `npm run sandbox:docker -- …` invocation (`env`, `status`) hit `ORCHARD PERMISSION TIMEOUT` (nobody answered within 30 min; a timeout, not a refusal). So even the read-only `env`/`status` preconditions could not be collected here, and running `down`/`up` was impossible regardless of Wall 1. (Plain `grep`/`df`/`ls`/`printenv`/`sed` ran fine; `npm` and the `env` builtin are the gated ones.)

**Diagnostics gathered without the gated tooling:**
- SSD `/` (nvme, btrfs): 1.3T total, 1.1T used, **138G free (89%)**. HDD `/mnt/backup` (sda1, ext4): 7.3T total, **5.6T free (24%)**. (`df -h`.)
- Sandbox daemon is LIVE: socket `…/docker-sandbox/run/docker.sock` present (srw-rw----, owned root plus the invoking user's group, dated Oct 25). Could not read the in-sandbox container list (`docker ps`) or the store size: `env`/npm gated, and the host volume dir `/var/lib/docker/volumes/` is root-only (no passwordless sudo). Per the round-2 note the live store had regrown to ~320 GB; not re-measured this lane.

**Persistence (step 3) — recommended, NOT applied (unverifiable from a lane; security-critical file).** The durable config the code reads is `DEFAULT_SANDBOX_DATA_BASE` in `scripts/lib/docker-sandbox.mjs` (currently `'/backups'`, which does NOT exist on this host, so base-mode always falls back to the volume). To make the HDD the no-env-var default: change that constant to `'/mnt/backup'` — base mode then auto-selects `/mnt/backup/orchard-docker-sandbox` and `status` with no env var shows the HDD data-root. Alternative without a code edit: set `ORCHARD_DOCKER_SANDBOX_DATA_BASE=/mnt/backup` persistently in the live server's launch environment. Either way `/backups` should stop being the default since it is absent here.

**Hand-off — must be run by a NON-lane context** (the user's own bare shell with no `ORCHARD_LANE_DOCKER`, or the live server which is the top-level sandbox owner), once the sandbox is idle (no running containers, no lane holding the daemon lock):
  1. `npm run sandbox:docker -- status` / `docker ps` — confirm nothing running.
  2. `npm run sandbox:docker -- down --purge` (removes only the labelled `orchard-docker-sandbox-data` volume — the sole host-daemon object this may touch).
  3. `ORCHARD_DOCKER_SANDBOX_DATA=/mnt/backup/orchard-docker-sandbox npm run sandbox:docker -- up` (recreates empty, bind-backed on the HDD; images rebuild on demand).
  4. Make persistent per step 3 above; confirm `npm run sandbox:docker -- status` (no env var) shows `dataRoot.resolved = /mnt/backup/orchard-docker-sandbox (ext4)`.
  5. Smoke: one small container in the new sandbox + one `npm run confined -- node -e "console.log(1)"`.
  6. Confirm the old SSD volume is gone and record `df -h /` before/after.

### 2026-11-05 — explore lane (OpenAI independent consult on the HDD relocation + prune policy)

**Consult:** OpenAI (codex default), thread 01a1aa25-b9a2-7ba2-be07-83ab70860724, 2026-11-05 (same brief as FEAT-199). Asked it to recommend AND refute the author's "move to HDD now, keep 7-day prune." Transcript: the dispatch transcripts dir, `openai/<encoded-project-dir>/01a1aa25-b9a2-7ba2-be07-83ab70860724.jsonl`.

**OpenAI's recommendation:** Prefer a BOUNDED SSD store; treat the HDD as an emergency fallback, NOT the retention policy. It refutes the author's lean.

**On HDD dind performance (Q1):** estimates only, not measured on this machine — uncached small random HDD ops ~50-200x slower than NVMe; whole workloads ~2-10x slower for cold unpack/build, worse for metadata-heavy concurrent short containers (exactly the verify-suite shape). Docker explicitly recommends fast storage for OverlayFS. Verdict: moving an UNCONTROLLED store buys capacity while potentially slowing EVERY build — a likely false economy. Must benchmark cold build / warm rebuild / concurrent short-container startup (suite elapsed + p95 startup) before committing. Mitigation it endorses: keep the ACTIVE overlay store on SSD, put exported caches / registry blobs on HDD — but do NOT improvise an OverlayFS directory split (the extracted layers ARE the small-file/metadata hotspot).

**On the 7-day prune (Q2 — REFUTED as too lax):** a 7-day age prune cannot constrain one-day growth; pruning only on `up` leaves long-running activity unbounded. Recommended policy: BYTES + minimum-free-space as the PRIMARY bound (high/low watermarks), age as ordinary retention, COUNT only as a secondary guard (shared layers make count/summed-size poor disk bounds). Run cleanup periodically AND after substantial work, not only at startup; under pressure evict eligible unused objects regardless of the 7-day age. Protect active jobs + their deps with leases; if protected usage exhausts budget, REFUSE new work rather than delete it (GC alone is not a hard capacity guarantee). Can use BuildKit space-based GC but that bounds build cache only, not images/writable-layers/logs/volumes.
  - Concrete prune-implementation check it flagged: Docker image `until` filter = CREATION age, not last-use age; and an image a PENDING job will need may have no container yet, so "in-use containers protect their images" does not protect not-yet-started work.

**On `down --purge` risk (Q3 — REFUTED as under-guarded):** a non-lane shell does NOT establish exclusivity — needs a maintenance lock + drained sessions. Removing the outer dind volume can destroy inner containers, inner volumes and writable-layer OUTPUTS, not just rebuildable images — verify those are disposable first. Validate exact daemon/volume identity, and verify `/mnt/backup` is actually MOUNTED (fs-type allowlist alone does not prove the intended disk is present). Expect a cold-cache rebuild spike after.

**What it AGREED with:** space is the acute problem and the fail-closed fs allowlist is sound; a move is acceptable IF the protected working set can't fit on SSD with safe headroom OR representative HDD benchmarks meet an agreed latency budget — then move but KEEP byte/free-space controls.

**Net for the orchestrator:** OpenAI would NOT ship "HDD + 7-day prune" as the plan. Recommended concrete actions: (1) add a byte/free-space watermark bound (primary) + run prune after substantial work, not only on `up`; (2) benchmark HDD dind (cold build / concurrent short containers) before relocating — prefer keeping the active store on SSD with aggressive size-based GC; (3) before `down --purge`: confirm drained sessions + maintenance lock, confirm no non-rebuildable inner volumes/outputs, and assert `/mnt/backup` is mounted; (4) fix/verify that the prune's `until` is creation-age and won't reap an image a queued job needs.

### 2026-11-05 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run e72517bd-4875-4cfa-9d9b-8d86e92d3096 — VERDICT: HOLDS — mixed-state candidate 4a55c714e070. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-11-05 — worker (fix lane, round 3) — size-watermark bound, after-work + down hardening

**Implemented the orchestrator's decision (keep the store on the SSD but BOUNDED; HDD stays optional).** regressed-from: BUG-289 round 1/2 (replaced the age-only on-`up` prune this round; the relocation resolver from round 1/2 is extended, not replaced).

**Changed (unstaged):**
- `scripts/lib/docker-sandbox.mjs`: new `pruneSandboxToCap(env, opts)` — bounds the store BY BYTES (`LayersSize` dedup images + NON-`Shared` build cache) under a cap (default 40 GB, `ORCHARD_DOCKER_SANDBOX_CAP_GB`) AND a host free-space FLOOR (default 50 GB, `ORCHARD_DOCKER_SANDBOX_FLOOR_GB`); evicts UNUSED images least-recently-TAGGED/used first (`Metadata.LastTagTime`, else `Created`), never age-only. Protects: images used by any container running/stopped; images tagged within a 10-min recency window (the pending-job gap the in-use check cannot see); and everything behind the daemon lock. Cheap UNLOCKED precheck measures first; takes the lock + deletes ONLY when over budget. Removal is ATOMIC by image-id: `force=0` delete (409s, keeping the image with NO untag, for a container ref or a dependent child image), escalating to `force=1` ONLY when the daemon says the sole obstacle is "referenced in multiple repositories" (a multi-tag unused image). Same isolation guard + daemon lock + pinned-connection `info.ID` re-check as `reset`. `pinnedDocker` moved to the lib (shared by reset/prune/cap-prune). Base-mode now resolves the base with `resolveDataPath` (kernel realpath) BEFORE `path.join`. Root guard adds `sensitiveStoreMatch` (lstat dev+ino) so a bind-mount/hardlink that IS `/var/lib/docker` or `/` is refused beyond the basename check. `mountTargetOf` added.
- `scripts/docker-sandbox.mjs`: `up` runs the cap-prune after preload (emits the `DOCKER_HOST` export FIRST so a lock-contention `exit 3` cannot swallow it); the `prune` verb defaults to the cap-prune (`--cap-gb`/`--floor-gb`, both `--f N` and `--f=N`), `--days N` still runs the legacy age prune but now REFUSES any value that rounds to a <1 h window (0, -0, 0.01, 1e-9, '', non-numeric, negative — none may become an age-0 "prune everything"). `down --purge` hardened: takes the lock, REFUSES if any container runs inside the sandbox daemon (pinned, id-re-checked; fails CLOSED if the running container's daemon is unreachable), and when the volume is bind-backed to a custom data-root asserts that dir is a REAL separate mount (findmnt target ≠ `/`) BEFORE and AFTER removal. `storeFreeBytesFn` measures the floor on the store's host fs (bind dir, or the host data-root's mountpoint; Infinity on any error — fail safe).
- `scripts/lib/confined-run.mjs`: after each run (the reaper path) spawns the sandbox CLI `prune` as a SHORT-LIVED, DETACHED child with `ORCHARD_DOCKER_LOCK` STRIPPED — so it acquires the lock FRESH (never re-enters a lock-holding caller's lock to prune concurrently), never holds the lock for a long-lived host's lifetime, and a lock-contention `exit 3` kills only the child, never the run. Best-effort.
- `scripts/verify-bug-289-cap-prune.mjs` (new): Part A resolver/identity guards vs real filesystems; Part C the real over-cap live sandbox (eviction under cap, in-use kept incl. a pinned oldest image, LRU modulo conflict-skips, recency, dedup measure).

**Verified:**
- must-FAIL: a 365-day age prune reclaimed 0 GB — age cannot bound size; store stayed ~48 GB over the 40 GB cap. The new cap-prune then brought it under.
- LIVE cap-prune on the real sandbox: store **46.9 GB → 39.3 GB** under the default 40 GB cap (16 unused images + 3.9 GB build cache reclaimed), all in-use images kept, a pinned oldest-unused image kept, LRU order (modulo one force=0 conflict-skip), recency respected. Repeated runs at smaller caps reclaimed further (39.3→34.4→30.7→~22 GB; the store had regrown to ~320 GB sum / ~34 GB dedup at lane start). Direct proofs: multi-tag unused image evicted atomically via force=1; in-use multi-tag image KEPT with all tags intact (no untag); free-space reading of 0 treated as Infinity (no eviction on a bad reading); lock held by another → cap-prune waits then exits 3, deletes nothing; isolation refused for unset/host `DOCKER_HOST`; `--days` edge values all exit 64.
- `scripts/verify-bug-289-cap-prune.mjs` 15/15; `scripts/verify-bug-289-resolver.mjs` 23/23 (no regression).
- `npm run gate`: leak-gate PASSES. typecheck FAILS only on `src/server/orchard-transcripts.ts` (386 uncommitted insertions from another lane in this mixed tree) — ZERO errors in BUG-289's four files; not caused by this change.
- Independent verify: six rounds. OpenAI was quota-exhausted every round (try-again windows), so each fell back to ANTHROPIC (cross-provider decorrelation reduced). Five BROKEN rounds surfaced 11 real findings — all fixed: on-prune doc flag; lock held for host lifetime + exit-3 killing confined runs (→ detached child); free-space 0-as-full (→ Infinity); build-cache `Shared` double-count (→ dedup); multi-tag un-evictable (→ atomic force=1); `--days` sub-hour/`-0`/`=`-form; detached-child lock RE-ENTRY (→ strip `ORCHARD_DOCKER_LOCK`); `sandboxRunningCount` fail-open (→ fail closed). Final run **e72517bd-4875-4cfa-9d9b-8d86e92d3096 HOLDS**, zero findings, mixed-state candidate 4a55c714e070.

**Still UNTESTED (out of a lane's reach, judged from code by the verifier):** `down --purge`'s refusals (no-running-containers, bind-mount before/after) cannot be driven from inside a lane (`down` hard-refuses there and would wreck the shared store); a socket swapped in the microsecond between force=0's 409 and force=1 on a multi-tag image (narrow, lock-free-confined-run only, recency+in-use base images make it near-impossible).

**High-stakes (security + session-lifecycle + data-loss-adjacent):** `docker-sandbox.mjs` is host-daemon-isolation critical. The charter asked for an OpenAI, no-fallback independent verify; OpenAI quota was exhausted across all six attempts, so the final HOLDS is an ANTHROPIC fallback (author anthropic too → reduced decorrelation). An OpenAI cross-provider clean-room pass remains WARRANTED when quota resets.

### 2026-11-07 — dispatch openai
- **Verification recorded:** dispatch openai run 01a1b796-989e-77a2-b6d5-83b824ba4f0d — VERDICT: BROKEN. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-11-19 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run e4400899-2770-4b91-bb6e-ec8f4af8f4be — VERDICT: BROKEN — mixed-state candidate d1963fec165e. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-11-19 — lane BUG-289/FEAT-201/BUG-217
- **Verification recorded:** dispatch openai run 01a1f45e-e887-7663-922b-136ce32c27d7 — VERDICT: BROKEN — mixed-state candidate b1ff98f9232c. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-11-19 — lane BUG-289/FEAT-201/BUG-217
- **Verification recorded:** dispatch openai run 01a1f460-ee38-7621-8adf-f809ac6ae1e1 — VERDICT: BROKEN — mixed-state candidate 19cc32084f6f. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-11-19 — lane BUG-289/FEAT-201/BUG-217
- **Verification recorded:** dispatch openai run 01a1f464-f4d3-7ff0-bb23-0f13efd757c3 — VERDICT: HOLDS — mixed-state candidate 5e1c59d3e134. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-11-19 — worker (BUG-289/FEAT-201/BUG-217 lane)
- **fix verified, done:** Free-space fix: a real zero is now told apart from a measurement error. Independent verify HOLDS: openai 01a1f464-f4d3-7ff0-bb23-0f13efd757c3, candidate 5e1c59d3e134.

  INTENT: the ticket was agent-filed (worker fix lane, 2026-11-03). Its only user-stated input on record is the user's approval of the HDD relocation (the 2026-11-05 entry above). This lane neither dropped nor changed that. Relocation stays optional per triage; the orchestrator chose the bounded-SSD cap. No transcript turn with a narrower user acceptance test was found (searched the orchard transcripts 2026-10-31..11-04).

  CHANGE: scripts/lib/docker-sandbox.mjs exports classifyFreeBytes(fn), which returns one of three states:
  - measured: includes a real 0, which fires the floor;
  - unknown: a throw, null, NaN, a negative, a promise or thenable, or a tampered promise. The floor treats it as 0 and prunes (fail-safe, per the orchestrator 2026-11-07);
  - disabled: the parameter itself is null, so the cap applies only.
  Logs show "free unknown (could not measure; …)", never "0.0GB", for a failed reading. Every unknown reading during the prune is logged and counted in summary.unknownFreeReadings, even when a later reading recovers.
  scripts/docker-sandbox.mjs storeFreeBytesFn now treats a non-zero `docker info` exit, or non-absolute output, as unknown. It sits on top of the uncommitted 2026-11-07 hunks: freeBytesAt returns null on error, the guarded CLI switch, and the base-mode volume fallback.

  PROOF (new scripts/verify-bug-289-floor-zero.mjs runs against a fake Docker API in a child process; it is synthetic because the live store is about 29.7 GB, under the cap):
  - must-FAIL, pinned ef7d2c0: 5/10. A zero-free reading deleted 0 of 3, reproducing 01a1b796.
  - As-found tree: 11/4.
  - Mid-prune unknown before its hunk: 24/2.
  - Discovery exit-1 before its hunk: 27/2.
  - After: 29/0.
  - Anti-regressions: verify-bug-289-resolver 23/0. verify-bug-289-cap-prune 39/2. Both failures are environmental (C-store-starts-over-cap and C-reclaimed-something need a store over 40 GB) and identical to the pre-change baseline.

  IV ROUNDS THIS LANE:
  - anthropic e4400899: BROKEN (tampered-species promise threw synchronously). Fixed.
  - openai 01a1f45e: BROKEN (unknown mid-prune readings not logged). Fixed.
  - openai 01a1f460: BROKEN (discovery exit status ignored). Fixed.
  - openai 01a1f464: HOLDS.

  The prior lane's 8 rounds on 2026-11-07 were never recorded here.

  RESIDUAL (declared out of scope in the requirement, which is agent-written; the user never asked for it): a deliberately broken Promise species can leave one unhandled rejection; the prune is still correct.

  DECISION FOR USER: the unknown→prune policy replaces the earlier contract 1e (unknown→keep).

  HIGH-STAKES: docker-sandbox is host-isolation critical. The verify was clean-room and cross-provider, so a further skeptic is optional.

### 2026-11-19 — lane BUG-289/BUG-287 r2
- **Verification recorded:** dispatch openai run 01a1f479-a79b-7ce0-92be-172d036e1895 — VERDICT: HOLDS — mixed-state candidate 10c326d00ce9 — Unknown free-space reading now fails CLOSED (keeps images, WARNING logged + counted); real 0 still prunes; byte cap unchanged.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-11-19 — lane BUG-289/BUG-287 r2
- **Note:** Round r2 (2026-11-19): unknown free-space reading changed from PRUNE to FAIL CLOSED. regressed-from: BUG-289 2026-11-07 orchestrator policy (unknown->prune), which replaced contract 1e (unknown->keep).

  INTENT (searched transcripts): the user's own words, 2026-11-03 session 1e52191a: move the sandbox to the HDD instead of filling the low-space SSD, and prune unused images older than a few days. On 2026-11-05 the user approved the HDD move. No user turn asks for pruning when the reading fails. The unknown->prune rule was the orchestrator's (its 2026-11-07 dispatch said "treat it as below the floor (prune) or refuse"). So deleting on a measurement error is not user-backed, and it now fails closed.

  CHANGE: in scripts/lib/docker-sandbox.mjs, classifyFreeBytes now returns unknown with bytes Infinity, so the floor cannot fire on it. over() fires the floor only when the reading's state is measured. Every unknown reading, at precheck or mid-prune, logs "WARNING: free space unknown (could not be measured); the free-space floor is NOT enforced ..." and is counted in summary.unknownFreeReadings. The final line says "stopped (cap met; free space unknown ...)" rather than "under budget". A real 0 still prunes. The byte cap is a real /system/df measurement, so it still evicts. In scripts/docker-sandbox.mjs only comments changed. Tests updated: verify-bug-289-floor-zero.mjs and verify-bug-289-cap-prune.mjs.

  PROOF (synthetic fake Docker API; the live store is 30.9 GB, under the cap):
  - must-FAIL on the as-found tree with the new expectations: floor-zero 21/11. An unknown reading deleted 3/3; a throw deleted 3/3; nothing was logged as a WARNING.
  - After the change: floor-zero 32/0. Real zero deletes 3/3. Unknown deletes 0/3 with a WARNING. A throw deletes 0/3. A real 0 then unknown mid-prune deletes 1/3 and stops. Unknown with the store over the cap deletes 2/3, down to the cap.
  - Anti-regressions: resolver 23/0. cap-prune 39/2, the same two environmental C-* failures as the baseline (they need a store over the cap).
  - IV: openai 01a1f479-a79b-7ce0-92be-172d036e1895 HOLDS, mixed candidate 10c326d00ce9, cross-provider. Its adversarial run tried 14 invalid readings at 4 measurement boundaries with protected images. UNTESTED: a real full disk, and live over-cap reclamation.

  HIGH-STAKES: docker-sandbox is critical to host isolation, and this change only REMOVES a delete path. The IV was clean-room and cross-provider; no further skeptic is needed.
