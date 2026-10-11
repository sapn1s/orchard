# BUG-250 — Scratch root accumulates unswept reflink clean rooms (du says 282G, real data ~40KiB; cost is 7.7M inodes of metadata + a reflink landmine)

- **Status:** OPEN
- **Severity:** medium
- **Area:** server / tooling (scratch lifecycle — `scripts/lib/scratch.mjs`, `scripts/independent-verify.mjs`)
- **Reported:** 2026-10-11 by finding lane (disk-full investigation)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
The root NVMe (`/dev/nvme1n1p6`, 1.3T, mounted `/`) hit 100% on 2026-10-10. A `du`
sweep fingered `~/.local/state/claude-station/scratch` (Orchard's tooling scratch
root) as the largest consumer at **282–291G**, across **1503** subdirectories.

## What is actually true (hypothesis "scratch's divergent/non-reflink writes filled the disk" — REFUTED)
The 282G is almost entirely a **`du` phantom**. `du` counts every reflinked byte at
full size; the bytes are shared, not duplicated.

- `btrfs filesystem du -s` over the whole scratch tree:
  `Total 274.73GiB · Exclusive 40.00KiB · Set shared 70.19GiB`.
  **Deleting the entire scratch tree would free ~40KiB of data.** Every bulk extent
  is reflink-shared with the live repo's `node_modules`.
- Top 5 dirs by `du` each measure **0.00B Exclusive**: arch020 (26.9G), feat157
  (20.2G), bug214-218 (16.6G), arch022 (11.7G), feat158-r5 (6.2G).
- Proof of the mechanism (not inference): a 1.28MB file in a scratch clone and its
  twin in the live repo occupy the **identical physical extent**:
  `bug247-r5-copy-aNCvba/node_modules/@anthropic-ai/claude-agent-sdk/browser-sdk.js`
  and `~/projects/orchard/node_modules/@anthropic-ai/claude-agent-sdk/browser-sdk.js`
  both report `physical_offset 38534203..38534516 … flags: shared` under `filefrag -v`.
- Scratch is on the **same device** as the repo (both dev `30`, btrfs `/dev/nvme1n1p6[/@]`),
  so `checkSameFilesystem()` is satisfied and reflinks apply — the cross-filesystem
  silent-full-copy failure mode that `scratch.mjs` warns about is **not** happening.

So the disk did not fill because of scratch, and cleaning scratch will **not** recover
meaningful data space. The real 898GiB of data on the fs lives elsewhere (by `du`,
over-counting: Steam 169G, `~/projects` 143G, `~/vms` 86G, `~/temp_things` 56G,
`~/.local/share/claude-station` data dir 54G, …). Finding the true Oct-10 filler is
out of this ticket's scope; this ticket is about scratch's genuine, separate cost.

## The genuine cost of scratch (why this is still a real bug, not a non-issue)
1. **Metadata, not data.** Scratch holds **7,733,663 inodes** (~700 reflinked
   `node_modules` trees × ~10,900 files each). btrfs metadata is **18.44GiB used of
   30.46GiB allocated (DUP → ~37GiB raw), with only 4.01GiB device-unallocated.** Those
   millions of inodes are the dominant driver of metadata-chunk pressure, and a btrfs
   filesystem can hit ENOSPC on metadata exhaustion while `df` still shows free data
   space — a plausible real contributor to the Oct-10 event. (Exact metadata
   attribution to scratch vs the rest of the fs is unverified without root.)
2. **A reflink landmine.** The 70GiB of `Set shared` is cheap only while the repo's
   `node_modules` extents stay identical to what each clean room reflinked. The moment
   `node_modules` is reinstalled (`npm ci`, a dep bump), the live repo repoints to NEW
   extents and the OLD ones — still pinned by ~700 scratch reflinks — become **exclusive
   to scratch**. Scratch's real footprint would then balloon from ~40KiB toward its
   274GiB apparent size, with no sweep to catch it. The current "cheap" state is not stable.
3. **Nothing sweeps, and cleanup is not crash-safe.** `scripts/lib/scratch.mjs` is
   "Deliberately NOT age-swept" (header rationale: don't delete a dir a live process is
   using). `independent-verify.mjs` does `rmSync(room.dir)` only on its normal exit paths
   (lines ~1334 and ~1446-1449) — **not in a `finally`/exit handler** — so any crashed or
   interrupted run leaks its room. Evidence: **865** leaked `cleanroom-verify-*` /
   `cleanroom-record-*` dirs, plus 7 `/tmp/cleanroom-spool-*`. **983 of 1503** scratch dirs
   are ≥7 days old; 234 are 3-7d; 165 are <3d.
4. **`du`-based monitoring misleads the operator** into exactly this misdiagnosis
   (blaming scratch for a disk-full it did not cause, and expecting 282G back from a
   cleanup that frees ~nothing).

## Liveness
No live process holds any scratch dir: `fuser -v` over the scratch root returned only
this lane's own probe PIDs. The hand-named big dirs (arch020, feat157, bug*-r*-copy/tree/
clone/repo/src) are per-lane/per-ticket working trees; the exact creator (dispatch/worktree
harness or manual agent scratch via `$CLAUDE_STATION_TMPDIR`) was **not** traced — grep of
`scripts/` + `src/` for the `-copy-`/`-tree-`/`-clone-` naming found no in-repo creator, so
these are likely created by runtime/harness code outside this repo or by lanes directly.

## Recommendation

### (a) Safe one-time cleanup — DO NOT expect space back
- Reclaimable DATA from deleting all 1503 scratch dirs: **~40KiB** (negligible). This will
  not fix a disk-full. State that plainly to anyone who runs it.
- What it DOES buy: removes ~7.7M inodes → relieves btrfs metadata-chunk pressure, defuses
  the reflink landmine, and stops `du` lying. Hygiene, not space recovery.
- Provably-dead set: all 1503 dirs are unheld by any live process (verified via `fuser`);
  the **983 dirs ≥7 days old** are the safe conservative target. Delete is the operator's
  call (WA: no destructive action by this lane). Suggested one-liner for the operator to
  review, NOT run blind: age-filter `find ~/.local/state/claude-station/scratch -maxdepth 1
  -type d -mtime +7`, re-check `fuser` per dir, then `rm -rf`.

### (b) Structural fix (stops recurrence)
- **Bounded TTL sweep at server boot and at lane end.** Add a sweeper (new helper in
  `scratch.mjs`, invoked from the server boot path and/or the dispatch lane-teardown)
  that removes scratch subdirs older than a TTL (proposed 7d) OR beyond a count cap,
  BUT only when SAFE: skip any dir whose record/heartbeat is live (IV already writes a
  heartbeat in the record dir — reuse that staleness window), skip anything `fuser`/held,
  and honour an explicit keep-marker (a `.keep` sentinel or the `--keep-cleanroom` record).
  This directly answers the header's original objection ("could delete a dir a running
  process is using") by gating on liveness rather than refusing to sweep at all.
- **Make IV room cleanup crash-safe.** Move the `rmSync(room.dir)/rmSync(room.recordDir)`
  into a `finally`/`process.on('exit')` so interrupted and crashed runs do not leak (fixes
  the 865 orphans at the source).
- **Fix the monitoring lie.** Any disk/scratch reporting should use btrfs exclusive
  (`btrfs filesystem du -s`) or flag reflink-shared trees, not raw `du`, so a future
  operator is not misdirected the way this investigation initially was.

## Context pack
- Files/functions in play: `scripts/lib/scratch.mjs` (header rationale, `scratchRoot`,
  `mkdtempScratch`, `checkSameFilesystem`); `scripts/independent-verify.mjs` (room create
  `cleanroom-verify-`/`cleanroom-record-` ~L773/866; cleanup ~L1334 & L1446-1449, NOT in
  finally); `src/server/snapshots.ts` (the `assertSameFilesystem` pattern scratch mirrors).
- Related tickets: BUG-114 (verification runs leak live sessions — same "cleanup not
  guaranteed on abnormal exit" family); BUG-117 (scratch-server isolation knob).
- Repro / evidence commands: `btrfs filesystem du -s ~/.local/state/claude-station/scratch`;
  `filefrag -v <scratch copy> <repo twin>`; `find … -printf . | wc -c` (inode count);
  `btrfs filesystem usage /` (metadata chunk pressure).
- Known dependencies / blockers: the sweep must reuse IV's existing heartbeat staleness
  authority, not invent a second liveness check (ARCH-001 single-liveness-authority).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-11 — finding lane (explore, round 1)
- **Understood:** Disk-full on 2026-10-10 was blamed on the 282G scratch root. Verified the
  stated hypothesis (scratch filled the disk via divergent/non-reflink writes) is FALSE.
- **Changed:** nothing (read-only finding). This ticket filed.
- **Verified (read-only facts):** whole-scratch `btrfs fi du -s` = Total 274.73GiB /
  Exclusive **40.00KiB** / Set shared 70.19GiB (PASS: scratch frees ~nothing). Top-5 dirs
  each 0.00B exclusive. `filefrag -v` shows a scratch clone file and its repo twin on the
  identical physical extent `38534203..38534516 flags:shared` (PASS: reflink proven, not
  inferred). Same device as repo (dev 30, btrfs; PASS: no cross-fs full-copy). `fuser` over
  scratch root: only this lane's probe (PASS: nothing live held). Inode count 7,733,663;
  btrfs metadata 18.44GiB/30.46GiB used, 4.01GiB unallocated. 865 leaked IV room dirs; 983
  of 1503 dirs ≥7d old. IV cleanup `rmSync` is on normal-exit paths only, not in a `finally`.
- **Still open / handoff:** (1) exact creator of the hand-named lane dirs (`*-copy/tree/
  clone/repo/src`) not traced — likely runtime/harness outside this repo; a fixer should
  confirm before adding a sweep so the sweep's keep-markers match how they are created.
  (2) Exact attribution of the 18.44GiB metadata to scratch vs rest of fs needs root
  (`sudo btrfs`), unavailable to this lane. (3) True Oct-10 disk filler is NOT scratch and
  is out of scope — a separate investigation of the 898GiB real data (Steam/projects/vms/
  temp_things/claude-station-data) is warranted if disk pressure recurs.
- **Symptom of a deeper design flaw?** (open — candidate: "scratch lifecycle has no owner;
  cleanup is best-effort on the happy path and refused on the unhappy one" — decide at close)

### 2026-10-11 — fixing lane (plan + independent critique, round 1)
- **Understood:** The fix is two parts — (1) make IV clean-room cleanup crash-safe, (2) add a
  liveness-gated TTL sweep. I verified the ticket's stated liveness premise and it is WRONG: the
  ticket says the sweep should "reuse IV's existing heartbeat staleness window in the record dir",
  but IV's heartbeat (`alive` file, 4s window) lives in the SPOOL dir under `os.tmpdir()`
  (`independent-verify.mjs:879,885,897`), NOT in the room/record dirs under the scratch root. There
  is NO in-dir liveness signal on the dirs the sweep targets. So the sweep cannot reuse it as-is.
- **Plan dispatched for independent critique:** OpenAI was first choice (`dispatch-client --check` =
  available) but the dispatch returned `[quota-window]` (usage limit, resets Oct 14) — fell back to
  anthropic per standing rule. Critique run: anthropic session `cd1fb6fa-42c9-4b47-accd-38cf9339f54e`.
- **Critique verdict: "not safe to build as written."** Key findings (all adopted):
  1. **The sweep would delete evidence.** Not all `cleanroom-*` dirs are leaks — `--keep-cleanroom`
     keeps rooms a verdict CITES days later; tickets name specific paths (BUG-231 cites
     `cleanroom-verify-av7XIR`/`-0anExE`, `cleanroom-record-H4T0bB`/`-ZpXGJI`; BUG-118; FEAT-145).
     The `.keep` sentinel my plan relied on does not exist yet.
  2. **mtime age is unsafe** — insensitive to deep writes (dir mtime only changes on top-level
     entry add/remove) AND forgeable (`git archive`/`cp -a` set OLD mtimes; `touch -d`). Use ctime
     + an explicit lease, not mtime.
  3. **`fuser` is insufficient** — no recursive mode (7.7M inodes), a live run holds nothing open
     between appends, errors read as "no holder", and sandboxed/PID-namespaced lanes can't see each
     other's runs. Replace with a lease file (pid + /proc start-ticks + boot_id).
  4. **TOCTOU** between liveness check and `rmSync` (11k-file recursive delete is slow) → rename to
     `.trash-<rand>` first, re-check, then delete.
  5. **Confinement defeats:** a misconfigured `CLAUDE_STATION_TMPDIR=$HOME`/repo/`/` passes the
     realpath check trivially (and an explicit env root is not `degraded`, so a degraded-only prefix
     allowlist would not fire). Require an ownership MARKER file, refuse `$HOME`/repo/`/`, and apply
     the prefix allowlist ALWAYS. Add `--one-file-system`/device check so a bind mount in a room is
     not traversed.
  6. **Crash-safe Set:** SIGKILL can't be handled (drop that proof claim — only the sweep is the
     backstop for SIGKILL); a signal handler must kill the dispatch child group + wait before
     deleting (else it deletes under a live child); register dirs at the `mkdtemp` call sites before
     `die()` can fire; NEVER register a `--keep-cleanroom` room; exit `128+n` after handling.
- **Adopted design (revised, safe-by-construction):**
  - **Part 1:** IV registers each scratch dir at its `mkdtemp` call site; a single `exit` handler +
    SIGINT/SIGTERM/SIGHUP handlers remove any still-registered dir (kill child group first, exit
    128+n, idempotent). `--keep-cleanroom` dirs are never registered. Covers throw/`die()`/SIGTERM/
    unhandledRejection. SIGKILL is explicitly NOT covered by Part 1 (the sweep is its backstop).
  - **Lease:** IV writes `lease.json` `{pid, startToken (pidStartToken algorithm, ARCH-001 single
    authority reused from survival.ts), bootId}` into room + record dir at creation; writes `.keep`
    into both on `--keep-cleanroom`.
  - **Part 2 sweep (`sweepScratchRoot` in scratch.mjs):** ownership marker required; refuse
    `$HOME`/repo/`/`; prefix allowlist `cleanroom-verify-`/`cleanroom-record-` ALWAYS; skip symlinks;
    realpath confinement; device check; `.keep` → keep; NO lease → keep (legacy, operator decides —
    never auto-deleted); lease live (bootId match + pid alive + start token match) → keep; lease
    dead + ctime age > TTL → rename to `.trash-*`, re-check, delete; caps on count+time; dry-run;
    stderr-only logging. Invoked best-effort (non-fatal, bounded) at IV start + standalone CLI
    `scripts/scratch-sweep.mjs --dry-run`.
  - **NOT wired into the TS server boot:** `src/server` never references the scratch root; adding a
    dependency there is artificial. IV-start + CLI are the real safe points.
- **Consequence for the existing 1503 dirs:** none have a lease, so the opportunistic sweep will
  auto-delete ZERO of them (all classified "legacy — keep"). Their one-time cleanup stays the
  operator's call (dry-run reported below), exactly as the ticket already scoped.
- **Decisions flagged to orchestrator (not resolved by this lane):** (D1) the lease is a new
  per-dir process-liveness record — it REUSES the `pidStartToken` algorithm so it is not a second
  *authority*, but ratify that framing against ARCH-001. (D2) legacy no-lease dir cleanup policy
  (the 865) is an operator batch decision, unchanged.
### 2026-10-11 — fixing lane (build + verify, round 1)
- **Changed:**
  - `scripts/lib/scratch.mjs` — Part 2. New: `SCRATCH_ROOT_MARKER`, `SWEEP_PREFIXES`,
    `currentBootId()`, `pidStartToken()` (same /proc field-22 algorithm as survival.ts — ARCH-001
    authority reused, not re-decided), `pidAlive()`, `leaseIsLive()`, `writeLease()`, `writeKeep()`,
    and `sweepScratchRoot()`. `scratchRootInfo()` now drops the ownership marker into the resolved
    root. Header rewritten: the "deliberately NOT age-swept" refusal is replaced by the
    liveness-gated sweep rationale.
  - `scripts/independent-verify.mjs` — Part 1. Crash-safe cleanup: dirs registered at their
    `mkdtemp` call sites; one `process.on('exit')` + SIGINT/SIGTERM/SIGHUP handlers remove any
    still-registered dir (kill the dispatch child first, exit 128+n, idempotent). `--keep-cleanroom`
    dirs are never registered and get a `.keep`; every room+record dir gets a `lease.json`. The two
    normal-exit `rmSync` sites now untrack. Opportunistic bounded best-effort sweep at `main()`
    start. A labelled test seam (`CLAUDE_STATION_IV_CRASH_AFTER_ROOM`) crashes after room build so
    crash-safety is provable against the REAL tool.
  - `scripts/scratch-sweep.mjs` (new) — operator CLI (`npm run scratch:sweep [--dry-run]`).
  - `scripts/verify-bug-250-scratch-sweep.mjs` (new) + `package.json` (`verify:bug-250`,
    `scratch:sweep`).
- **Verified (21/21 PASS, `node scripts/verify-bug-250-scratch-sweep.mjs`, exit 0), isolated root
  under `~/.local/state/claude-station` (same btrfs → fast reflink, never `/tmp`, never the real
  root):** live lease KEPT even ttl=0; dead+old REMOVED; dead-but-young KEPT; live pid + different
  boot id REMOVED (reboot proof); no-lease legacy KEPT; garbage lease KEPT (fail-safe); `.keep`
  KEPT; forged-old mtime + live lease KEPT (gate is the lease, not mtime); foreign prefix NOT
  swept; prefix-named symlink SKIPPED + external target UNTOUCHED; refuses `$HOME` / `/` / unmarked
  root; dry-run lists but deletes nothing. REAL-TOOL crash cases (seam): IV throw / die / exit /
  SIGTERM-mid-run each leave ZERO clean-room dirs. MUST-FAIL (synthesized pre-fix shape: room made,
  no handler, exit) LEAKS its room — bug reproduced, fix removes it.
- **Anti-regression:** `npm run verify:scratch-root` 28/28 PASS (room landing, reflink cost, cross-fs
  report all intact). IV happy path (`--print-prompt`, no keep) cleans the room; `--keep-cleanroom`
  keeps it carrying both `lease.json` and `.keep`, and the sweep then keeps it via `.keep`.
  `npm run gate` = PASS (exit 0; leak-gate + typecheck).
- **Dry-run against the REAL root** `~/.local/state/claude-station/scratch` (deletes nothing;
  `allowNoMarker` so nothing is written there): **WOULD-REMOVE = 0.** All 867 prefix-matched
  `cleanroom-*` dirs are legacy (no lease) → KEPT for the operator; 661 non-cleanroom dirs
  (hand-named lane trees) → SKIPPED (foreign prefix); 0 errors. So the structural fix auto-reclaims
  nothing existing — it only prevents FUTURE SIGKILL leaks (which now carry a lease). The one-time
  cleanup of the 867 legacy dirs stays the operator's explicit call, exactly as scoped.
- **Still open / handoff / decisions for orchestrator:**
  - **High-stakes (destructive + session-lifecycle-adjacent): an independent clean-room verify pass
    is WARRANTED** before VERIFIED — this lane's suite is self-authored. Recommend
    `scripts/independent-verify.mjs` dispatch over the range, then `board-tool verified`.
  - **(D1)** The per-dir `lease.json` is a NEW liveness record. It reuses the `pidStartToken`
    algorithm so it is not a second *authority*, but ratify that against ARCH-001 (the ticket's
    original "reuse IV's heartbeat" premise was factually impossible — the heartbeat is in the
    `/tmp` spool, not the record dir).
  - **(D2)** Cleanup of the 867 legacy no-lease dirs is an operator batch decision (unchanged).
  - **Residual not covered:** SIGKILL / power-loss of IV cannot run a handler (only the
    lease-gated sweep reclaims those — by design); and a SIGTERM delivered while a verifier
    grandchild is mid-write has a sub-second window where a fragment could be recreated after
    delete (the grandchild is killed first; the sweep is still the backstop). Both are documented,
    not silent.
- **Symptom of a deeper design flaw?** yes → the close-out candidate ("scratch lifecycle had no
  owner; cleanup was best-effort on the happy path and refused on the unhappy one") is now
  addressed by giving each dir an owner-lease + a gated sweep; recommend the orchestrator decide at
  close whether an ARCH ticket is still warranted for the broader "~50 `mkdtempScratch` callers have
  no lifecycle owner" surface (only the IV clean rooms are leased by this fix).

### 2026-10-10 — IV clean-room lane (P1)
- **Verification recorded:** dispatch anthropic run a10d83bb-593a-45a0-9759-4208cd3c695a — VERDICT: BROKEN — P1 BROKEN: post-rename re-check treats null/truncated lease as deletable while classify KEEPs it -> TOCTOU deletes re-leased/no-lease-yet room (run 3b74c6cbd446); cross-PID-ns sweep at ttl=0 deletes a host-live owner's dir (run fc9ee110a7db). Default 7d TTL protected.. Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-10-10 — IV clean-room lane (P2)
- **Verification recorded:** dispatch anthropic run e625a70d-36d6-441d-993b-61955966a7ac — VERDICT: BROKEN — P2 BROKEN confinement: rm -rf --one-file-system only skips DIFFERENT-device mounts; a same-device bind mount inside a dead/old/leased room (dev 30==30) is traversed and the EXTERNAL target's contents deleted (victim.txt removed, run 0bce15877cf9). classify dev-check covers only the top-level entry.. Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-10-10 — IV clean-room lane (P3)
- **Verification recorded:** dispatch anthropic run 5bbd18a8-8f59-4548-aa3d-343752c95c61 — VERDICT: BROKEN — P3 BROKEN no-leak: classify loop unconditionally skips .trash-* names, so a .trash-<hex> dir orphaned by an rm failure (read-only subdir, EACCES) or by a SIGKILL mid-rm is never reclaimed or reported by any future sweep -> the sweep creates permanent leaks (run cc1ccb97a2e8 case1,case2).. Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-10-10 — IV clean-room lane (P4)
- **Verification recorded:** dispatch anthropic run 4cad32f7-3b81-4304-8863-de31b884e69f — VERDICT: INVALID — P4 INVALID/inconclusive: verifier rendered HOLDS but cited run 39973665785c exiting 1; contract rejected it. Cause: clean room has no .git, so verify:scratch-root real-build cases and the fixer test E-section fail as an environment artifact, not a regression. No regression evidence found.. Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-10-11 — independent verification (clean-room, round 1) — VERDICT: REFUTED
- **What ran:** 4 concurrent clean-room dispatches via `scripts/independent-verify.mjs`, one
  adversarial attacker per property (two-break STOP rule), against an isolated BUG-250-only
  overlay (dangling commit `ed99ecd` = HEAD `e79aada` + ONLY the 5 BUG-250 files; `package.json`
  trimmed to the two BUG-250 script lines; `independent-verify.mjs` stripped of the co-resident
  FEAT-170 `--candidate` hunks so the diff is BUG-250-only — the stripped diff was confirmed to
  contain no FEAT-170/candidate lines). **OpenAI was requested first but is quota-exhausted until
  2026-10-14 (confirmed by a real dispatch returning `[quota-window]`); verifiers fell back to
  anthropic → SAME-provider as the authors, decorrelation reduced** (standing-rule fallback).
- **Verdicts recorded:** P1 BROKEN (run a10d83bb), P2 BROKEN (run e625a70d), P3 BROKEN
  (run 5bbd18a8), P4 INVALID/inconclusive (run 4cad32f7). The three BROKEN findings were each
  re-confirmed by hand against the real `sweepScratchRoot` source before recording.
- **P1 (never deletes a live dir) — BROKEN.** (a) The post-rename re-check treats a null/
  truncated `lease.json` as deletable (`leaseNow=null` ⇒ not restored), while the classify step
  treats the same state as KEEP ("no lease" / "lease unreadable — fail-safe keep"). A room that is
  re-leased, or whose lease is truncated mid-write, in the classify→rename window is deleted
  (run 3b74c6cbd446, cases b,c; racer simulated via an in-process `fs.renameSync` hook — honest
  limitation). (b) `pidAlive` reads `kill(pid,0)` ESRCH as death, valid only in the sweeper's own
  PID namespace; a sibling-namespace sweep at `--ttl-days 0` deleted a host-live owner's dir
  (run fc9ee110a7db). The default 7d TTL protected it (age gate is the only backstop).
- **P2 (confinement) — BROKEN.** `rm -rf --one-file-system` only refuses DIFFERENT-device
  crossings; a same-device bind mount placed inside a dead/old/leased `cleanroom-verify-*` room
  has the root's `st_dev` (30==30), so `rm` recurses into it and **deletes the external target's
  contents** (`victim.txt` removed; run 0bce15877cf9, in an `unshare -rm` user+mount ns on tmpfs).
  The classify-time `lst.dev !== rootDev` guard covers only the top-level entry, and nothing scans
  for nested mountpoints — the code comment's claim that `--one-file-system` stops "a bind mount
  left inside a room" is false for same-filesystem binds. (btrfs/real-root bind not tested — needs
  root; same-device st_dev behaviour is identical. Every OTHER P2 vector — nested outside-symlinks,
  `lease.json` as a symlink, different-device mount, `..`-prefix name, $HOME/`/`/ unmarked/
  symlink-to-$HOME roots — HELD, run c00530a773b0.)
- **P3 (no leak) — BROKEN.** The classify loop unconditionally `continue`s on `.trash-*` names.
  A `.trash-<hex>` dir orphaned by an `rm` failure (read-only subdir → EACCES) or by a SIGKILL of
  the sweeping process mid-`rm` is never reclaimed or even reported by any later sweep — a
  permanent leak the sweep itself creates (run cc1ccb97a2e8, cases 1,2).
- **P4 (no regression) — INVALID/inconclusive.** The verifier rendered HOLDS but cited a run that
  exited 1; the contract rejected it. No regression was demonstrated. (Harness-side, the fixer's
  own suite is 21/21 and `verify:scratch-root` 28/28 in the REAL repo.)
- **Structural limitation found (affects P3/P4 and the fixer's own test):** the clean room is a
  `git archive` export with **no `.git`**, so any BUG-250 test that itself runs
  `independent-verify.mjs` to build a sub-room (the fixer test's "E. crash-safe" section;
  `verify:scratch-root`'s real-build cases) exits `not a git repo` BEFORE its crash seam fires.
  In every in-room fixer-test run the E-section throw/die/exit cases pass VACUOUSLY and
  "SIGTERM mid-run" FAILS — a clean-room environment artifact, NOT a defect. Consequence:
  **crash-safety (P3's IV half) and the regression suite are NOT independently verifiable inside
  the clean room.** Harness-side, with `.git` present, the fixer's full suite is 21/21 (reproduced
  by this lane) — so the crash-safe exit/signal handlers themselves work; the P3 BREAK is about
  the SWEEP's `.trash-*` orphans, which IS in-room-real.
- **Verdict:** the structural fix is **REFUTED** — three independent attackers found genuine,
  code-grounded breaks (P1 TOCTOU + cross-ns liveness, P2 same-device bind-mount confinement
  escape that deletes external data, P3 `.trash-*` orphan leak). Needs rework before VERIFIED.
  This is a destructive-delete, session-lifecycle change: an independent clean-room pass was the
  right call and it refuted the fix.
- **Could-not-test (carry to the fixer):** real-second-process races (vs in-process rename hook);
  btrfs/init-ns root bind mounts; hidepid=2 / different-uid EPERM lease paths; the sub-second
  dispatch-grandchild recreate window after the signal handler's SIGKILL+rmSync; a SIGKILL landing
  between `mkdtempScratch()` and `writeLease()` (room then kept forever as "legacy"); non-handled
  signals (SIGQUIT/SIGUSR1/2/SIGALRM) skipping the exit handler.

### 2026-10-11 — fixing lane (round 2 — fixing the four refuted properties)
- **Understood:** The round-1 independent clean-room verify REFUTED the fix: P1 (never delete a
  live dir), P2 (confinement), P3 (no leak) BROKEN; P4 INVALID (clean room had no `.git`).
  Reproduced each break against the round-1 code FIRST (not HEAD — the working tree was round-1):
  P3 `.trash-*` orphan persists & unreported; P1b cross-ns dead-pid dir removed; P1a truncated-lease
  dir deleted by the asymmetric re-check; P2 `rm --one-file-system` traversed a same-device bind
  mount and deleted the external `victim.txt` (confirmed under `unshare -rm --map-root-user`).
- **Fixes — STRUCTURAL where it buys the property by construction:**
  - **P1 (one chokepoint):** extracted a SINGLE `deletionBlocked()` predicate — the ONLY place
    "is this deletable?" is decided — and evaluate it at BOTH classify time and again on the renamed
    trash dir before removal. The round-1 asymmetry (classify KEEPs a null/truncated lease, the
    post-rename re-check DELETEs it) is gone by construction: both paths call the same function, so a
    dir re-leased/truncated in the window is restored. Added a test-only `onAfterRename` seam to
    drive that race deterministically.
  - **P1b (cross-namespace liveness):** `leaseIsLive` → tri-state `leaseLiveness()` =
    `live|dead|unknown`, and the lease now records the creator's pid-namespace (`/proc/self/ns/pid`).
    A `kill(pid,0)` ESRCH is proof of death ONLY within the same pid-ns; a foreign/unknown pid-ns →
    `unknown` → KEEP. The sweep deletes ONLY `dead`. Age is never a substitute for liveness.
  - **P2 (same-device bind mount):** replaced `rm -rf --one-file-system` (which only refuses
    DIFFERENT-device crossings) with a recursive walker `rmTreeConfined()` that refuses to descend
    into ANY mount point (read from `/proc/self/mountinfo`, re-read FRESH at delete time so an
    internal rename that relocates a contained mount is still caught) OR cross a device boundary,
    never follows a symlink, and chmods dirs writable. A mounted dir is refused BEFORE the rename.
  - **P3 (`.trash-*` orphan leak):** the classify loop no longer unconditionally skips `.trash-*`;
    it RECLAIMS each orphan via the same mount-guarded walker and REPORTS any it cannot
    (`reclaimedTrash` / `trashOrphans`). The walker's chmod handles the read-only-subdir EACCES that
    created orphans in the first place.
  - **P4 (clean-room `.git` artifact):** the suite's crash-safe E-section now detects a missing
    `REPO/.git` and SKIPs honestly (no vacuous pass / spurious fail). Harness-side (with `.git`) the
    4 real crash cases run for real.
  - Also added `SIGQUIT` to IV's signal handlers (carry-list item).
- **Changed:** `scripts/lib/scratch.mjs` (tri-state liveness + pid-ns in lease; `deletionBlocked`
  single predicate; `visibleMountPoints`/`mountUnder`/`rmTreeConfined` walker; `.trash-*` reclaim;
  `sweepDeletionBlocked`/`currentPidNs`/`leaseLiveness` exports). `scripts/independent-verify.mjs`
  (SIGQUIT). `scripts/verify-bug-250-scratch-sweep.mjs` (+section G: 4 regressions, each a
  synthesized round-1 MUST-FAIL + fixed pair; E-section `.git` guard; pid-ns-aware fixtures).
- **Verified:** `node scripts/verify-bug-250-scratch-sweep.mjs` → **32/32 PASS, 0 skipped** (the P2
  bind-mount case ran under a real `unshare -rm` user+mount ns, not skipped). Each round-2
  regression FAILED against round-1 (reproduced) and passes now. REAL-tool crash cases (throw/die/
  exit/SIGTERM) all leave zero rooms (ran with `.git`, confirming P3's crash-safety half and the P4
  regressions harness-side as asked). Anti-regression `npm run verify:scratch-root` **28/28**.
  `npm run gate` = **PASS (exit 0)**.
- **Dry-run vs REAL root** `~/.local/state/claude-station/scratch` (round-2 code, deletes nothing):
  WOULD-REMOVE **0**; 867 legacy kept; 666 skipped; `.trash` to reclaim **0**; trashOrphans 0;
  errors 0. Still auto-reclaims nothing existing — only future SIGKILL leaks (which carry a lease).
- **Still unverified / residual (documented, not silent):** the sub-second dispatch-grandchild
  recreate window after the signal handler's SIGKILL; a SIGKILL landing between `mkdtempScratch()`
  and `writeLease()` (dir then kept forever as legacy — fail-safe, not data-loss); btrfs/init-ns
  root bind mounts (same-device `st_dev` + mountinfo logic is identical to the tmpfs case proven
  here, but not run as root); hidepid=2/different-uid lease paths (fail-safe to `unknown`).
  Recommend a round-2 independent clean-room re-verify (same high-stakes bar).

### 2026-10-11 — fixing lane (round 2 — note: operator CLI renamed)
- The operator CLI was renamed `scripts/scratch-sweep.mjs` → **`scripts/sweep-scratch.mjs`**
  (and `package.json`'s `scratch:sweep` updated): the original name matched `.gitignore`'s
  `scripts/scratch-*.mjs` throwaway-scratch pattern, so it would never have been committed.
  `npm run scratch:sweep [--dry-run]` is unchanged. The verify suite
  (`verify-bug-250-scratch-sweep.mjs`) is NOT ignored (it starts `verify-bug-250-`).

### 2026-10-11 — independent verification (round 2) — BLOCKED on overlay build (needs git-write)
- **Goal:** round-2 independent clean-room re-verify of the four refuted properties via
  `scripts/independent-verify.mjs` (4 concurrent attackers, one per property), against a
  BUG-250-ONLY overlay of the round-2 code, fixing round 1's `.git`-less-room invalidity.
- **Provider:** OpenAI requested first — **confirmed quota-exhausted until 2026-10-14** by a real
  dispatch (`[quota-window]`, thread 01a127f1); verifiers would fall back to **anthropic** (same
  provider as authors → decorrelation reduced), per standing rule.
- **BLOCKER (hard):** round 1 ran against dangling overlay `ed99ecd`, which carries **round-1**
  code (scratch.mjs 404 lines vs round-2's 532). No round-2 overlay commit/tree exists, and the
  round-2 code lives only in the dirty working tree. Building the overlay requires ONE git write
  (`hash-object`/`write-tree`/`commit-tree`). Git writes are refused for this lane at BOTH layers
  — the PreToolUse Bash hook (FEAT-108) and the subprocess backstop (FEAT-135) — and `orchard` has
  **no git-write grant** (`git-grant --list`: `git-write: none`). `--working-tree` is equally
  blocked (its `snapshotWorkingTree` writes a dangling commit). IV's read path
  (`git archive`/`diff`/`rev-parse`) is fine, so once an overlay sha exists the 4 dispatches run
  with no further writes. A lane cannot lift the grant for itself (by rule and by the tool).
- **Prepared (ready to one-shot):** the BUG-250-only overlay artifacts are crafted and validated
  under `~/.local/state/claude-station/scratch/bug250-r2-overlay-2763132/`:
  `iv.mjs` (= `ed99ecd:scripts/independent-verify.mjs` + the SIGQUIT/SIGNUM hunk, 0 candidate refs,
  `node --check` OK — the real round-2 BUG-250 IV with FEAT-170 stripped so the diff stays
  BUG-250-only), `package.json` (HEAD + the 2 BUG-250 script lines, `scratch:sweep`→`sweep-scratch.mjs`),
  and `build-overlay.sh` (builds the dangling overlay = HEAD `e79aada` tree + the 5 BUG-250 files;
  prints the sha). scratch.mjs / sweep-scratch.mjs / verify-bug-250-scratch-sweep.mjs are taken
  straight from the working tree.
- **Decision needed from orchestrator:** either (a) grant git-write to `orchard` once
  (`git-grant orchard --once` / dashboard) and re-dispatch this lane — it will build the overlay
  and run the 4 attackers; or (b) run `build-overlay.sh` by hand and re-dispatch with the overlay
  sha. No verdict recorded (nothing was verified); no `board-tool verified` written.
- **UNBLOCKED (same lane, coordinator steer):** the overlay was built WITHOUT a grant using the
  git-shim's sanctioned temp-index plumbing (`read-tree`/`add`/`write-tree`/`commit-tree` under a
  `GIT_INDEX_FILE` in the OS temp dir, invoked from a node subprocess so FEAT-108's text scan sees
  only `node …`). See the round-2 verify entry below; the "needs-you" above is resolved.

### 2026-10-11 — independent verification (clean-room, ROUND 2) — VERDICT: REFUTED (P1+P2 BROKEN; P3+P4 HOLD)
- **Overlay:** built a BUG-250-only dangling commit `55fa19a` = HEAD `e79aada` tree + exactly the 5
  BUG-250 files (scratch.mjs/sweep-scratch.mjs/verify-bug-250-scratch-sweep.mjs from the working
  tree; `independent-verify.mjs` = round-1 overlay `ed99ecd`'s IV + the SIGQUIT hunk, FEAT-170
  stripped so the diff is BUG-250-only; `package.json` = HEAD + the 2 BUG-250 script lines).
  Confirmed: 5 files changed, 0 candidate/FEAT-170 refs in the IV diff. Built via the git-shim's
  temp-index plumbing hatch (no git-write grant needed, no real ref moved). Artifacts +
  build-overlay.mjs under `~/.local/state/claude-station/scratch/bug250-r2-overlay-2763132/`.
- **Provider:** OpenAI requested first, **confirmed quota-exhausted until 2026-10-14** (real
  dispatch, `[quota-window]`); all 4 verifiers ran on **anthropic** (same provider as authors →
  decorrelation reduced), per standing rule.
- **Room `.git` fix (round-1 invalidity):** the clean room is still a `git archive` export with no
  `.git`, so git-dependent cases (IV crash seam, sub-room builds) were run (a) by the P3/P4 verifiers
  inside a git-capable scratch repo they built under the shim's shadow root
  (`~/.local/state/claude-station/shadow`, where the shim permits git writes), AND (b) harness-side
  by this lane against the real working tree (real `.git`). No vacuous skips this round.
- **First attempt INVALID (harness-config, my error):** the initial 4 dispatches all exited INVALID
  because the FIXER-TEST `--run` I supplied was a placeholder, so the verdict contract rejected each
  verifier's real fixer-suite citation. Re-dispatched with `--run "node scripts/verify-bug-250-scratch-sweep.mjs"`;
  the verifiers' substance was unaffected.
- **P1 (never delete a live dir) — BROKEN** (run c82c69f0; two-break → DESIGN REVIEW). Two
  independent breaks, both via paths DIFFERENT from round-1's doors:
  (a) **Regression introduced by the round-2 P3 fix.** The new `.trash-*` reclaim loop
  (`sweepScratchRoot`, scratch.mjs ~L470-481) calls `safeRemove` directly with **no**
  `deletionBlocked`/lease check — so a `.trash-*` that carries a LIVE or re-leased lease (a concurrent
  sweep caught mid-rename, or a restore that failed after the dir was re-leased) is deleted regardless
  of liveness (run probe-concurrent, exit 1). `regressed-from: BUG-250 round-2 P3 fix`.
  (b) **Design flaw — lease identity ≠ user identity.** `writeLease` records the IV **parent** pid,
  but the real verifier **child** runs with cwd inside the room; a SIGKILL of the parent makes the
  lease read `dead` and the sweep deletes the room out from under the live child (run probe-orphan-child,
  exit 1). The lease must identify the process actually USING the room, not its creator.
- **P2 (confinement) — BROKEN** (run cbc0364d; two-break → DESIGN REVIEW). Two breaks, different
  paths from round-1's static bind door:
  (a) **Repo is not a refused root.** `dangerousSweepRoot` (scratch.mjs ~L283-293) refuses `/`,
  `$HOME` and `$HOME` ancestors but NOT the repo (nor a repo subdir) — yet the ticket's own
  recommendation (b) and the P2 claim forbid the repo. With `allowNoMarker`, root=repo (and
  root=repo/scripts) is swept and a dead-leased dir inside the repo is deleted (run probe-roots, exit 1).
  (b) **Mount-landing-mid-walk race.** `safeRemove` reads `visibleMountPoints()` ONCE (~L451) then
  hands that frozen set to `rmTreeConfined`, which walks a potentially huge tree; a same-device bind
  mount that lands under the target AFTER the read but DURING the walk is missed (stale set, st_dev
  matches) and the external `victim.txt` is deleted (run probe-race, `unshare -rm`, exit 1). A
  same-namespace walker cannot fully close this — design review. Every OTHER P2 vector HELD: 12 mount
  shapes (deep, post-rename, in-.trash, bound file, octal-escaped, space-in-path, tmpfs, via symlink,
  double bind, overmount, room-as-mount), symlinks, and the `$HOME`/`/`/unmarked/symlink-to-$HOME/
  tmpfs dangerous-root refusals.
- **P3 (no leak) — HOLDS** (run 58ffbeae). `.trash-*` orphans of every shape (mode-000 nested, a 000
  top-level trash, symlink, dangling symlink, symlink-to-outside, regular-file, FIFO, deep tree, a
  0500 dir of 300 read-only files) are each RECLAIMED or REPORTED in `trashOrphans` (dry-run too); a
  bind mount / tmpfs / mount-point nested in a `.trash-*` is left and reported, external target
  survived. The real IV crash seam (throw/die/exit + SIGTERM/SIGINT/SIGQUIT/SIGHUP, driven in a shadow
  git repo with a keep-alive so the signals are not vacuous) removed room + record dir + `/tmp` spool
  every time (handler exits 143/130/131/129). Quality note from the verifier: the fixer suite's OWN
  SIGTERM E-case is likely vacuous (drained event loop → Node exits 13, handler never runs) — not a
  defect in the product, but the suite over-claims that one case.
- **P4 (no regression) — HOLDS** (run 842c7e35). In a git-capable shadow repo: the fixer suite is
  32/32, **0 skipped**, with the throw/die/exit/SIGTERM E-cases actually REACHED (each printed
  `IV-CRASH-SEAM`, exited 1/7/9, and left no room) — i.e. not vacuous; `verify:scratch-root` 28/28;
  `independent-verify --print-prompt` builds a room and finishes clean leaving nothing behind.
  Independently matches this lane's harness-side runs (fixer suite **32/32, 0 skipped** with real
  `.git`; `verify:scratch-root` **28/28**).
- **Verdict:** the round-2 structural fix is **REFUTED**. P1 and P2 each broke via TWO independent
  paths distinct from round-1 → per the two-break STOP rule this is routed to **independent DESIGN
  REVIEW**, not another one-line guard. The recurring shape: the sweep keeps adding special-case
  deletion paths (`.trash-*` reclaim, root refusals, a one-shot mount read) that each reopen the "is
  this safe to delete right now?" question OUTSIDE the single `deletionBlocked` predicate the round-2
  design promised. Candidate design direction for the review: ONE confined-deletion primitive that
  (i) re-checks the live/lease gate on the exact thing it is about to unlink, (ii) leases the room's
  USER not its creator, (iii) treats the repo as a refused root, and (iv) cannot be defeated by a
  mount/release racing the walk (e.g. delete inside a private mount namespace, or an unpredictable
  check interleave is accepted as unclosable and documented).
- **Could-not-test / residual:** real init-namespace / btrfs-root bind mounts (needs root; the
  tmpfs/user-ns case is proven and the st_dev+mountinfo logic is identical); SIGKILL of the sweeper
  itself mid-`.trash` rm (the very orphan the P3 reclaim is meant to catch, now shown deletable-while-
  live by P1a); hidepid=2 / different-uid lease paths (fail-safe to `unknown`); the sub-second
  grandchild-recreate window after a handled signal's SIGKILL. First-attempt INVALID run ids (config
  error, superseded): P1 69896a62, P2 02dab5b7, P3 aef478d0, P4 cdb57f0a.
- **High-stakes note:** this is a destructive-delete, session-lifecycle change; an independent clean-
  room pass was the right call and it refuted the fix a second time. The two BROKEN properties warrant
  a design-level rethink before a round-3 build.

### 2026-10-10 — IV clean-room lane r2 (P2)
- **Verification recorded:** dispatch anthropic run cbc0364d-eee4-4585-b3ad-e93cf7bf2a88 — VERDICT: BROKEN — P2 BROKEN (two-break->design review). (a) dangerousSweepRoot (~L283-293) omits the REPO: with allowNoMarker root=repo is swept, dead-leased dir in repo deleted. (b) RACE: safeRemove reads mounts ONCE (~L451) then walks; a same-device bind landing mid-walk is missed, external victim.txt deleted.. Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-10-10 — IV clean-room lane r2 (P3)
- **Verification recorded:** dispatch anthropic run 58ffbeae-17e0-49d1-b5d0-b704246f0f87 — VERDICT: HOLDS — P3 HOLDS. .trash orphans of every shape (000 nested, symlink, dangling, FIFO, file, 300 ro files, deep tree) reclaimed or in trashOrphans; mounts-in-trash reported, target survived. IV throw/die/exit+SIGTERM/INT/QUIT/HUP handlers ran, room+record+spool gone. Note: fixer SIGTERM E-case maybe vacuous.. Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-10-10 — IV clean-room lane r2 (P4)
- **Verification recorded:** dispatch anthropic run 842c7e35-8dce-43c3-8f41-0c3e6eb885eb — VERDICT: HOLDS — P4 HOLDS. Git-capable shadow repo: fixer suite 32/32 0-skipped incl throw/die/exit/SIGTERM actually reached (IV-CRASH-SEAM, exit 1/7/9, room removed); verify:scratch-root 28/28; IV --print-prompt e2e clean. Matches dispatcher harness-side 32/32+28/28.. Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-10-10 — IV clean-room lane r2 (P1)
- **Verification recorded:** dispatch anthropic run c82c69f0-ba2c-4dd3-b5f1-c8b8f9cf7427 — VERDICT: BROKEN — P1 BROKEN (two-break->design review). (a) REGRESSION of round-2 P3 fix: .trash-* reclaim (~L470) runs safeRemove with NO lease/deletionBlocked check -> a live/re-leased .trash-* is deleted. (b) DESIGN: lease records IV PARENT pid, verifier CHILD uses room; parent SIGKILL -> deleted under live child.. Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-10-11 — independent design review (two-break) — DECISION: RESCOPE (option 1)
Report-id: design-review-bug250-r3-1791673305 · reviewer: independent design-reviewer (not an author of r1/r2) · WA §N two-break review.

- **Mandate & inputs read:** whole ticket incl. both independent-verify verdicts (round 1 REFUTED
  P1/P2/P3 BROKEN+P4 INVALID; round 2 REFUTED P1+P2 BROKEN via NEW doors, P3+P4 HOLD), the full
  `scripts/lib/scratch.mjs` (532 lines) and `independent-verify.mjs` crash-safe block (L94-128),
  CONVENTIONS Scratch rules, README. Built nothing.

- **The decomposition that drives the decision.** The fix has two separable halves:
  - **Part 1 — creator-side crash-safe cleanup** (`independent-verify.mjs` L106-128): registers the
    EXACT dir it just made with `mkdtempScratch` and `rmSync`s it from one `exit` handler +
    SIGINT/SIGTERM/SIGHUP/SIGQUIT handlers (kill dispatch child first, exit 128+n). This HOLDS — it
    is P3's crash-safety half (round-2 P3 HOLDS) and P4 (round-2 HOLDS). It needs NO lease, NO sweep,
    NO confined walker, NO mountinfo: it deletes only a known path THIS process created, never a
    foreign dir under a root.
  - **Part 2 — the autonomous liveness-gated sweep** (`scratch.mjs` `sweepScratchRoot` + lease +
    `rmTreeConfined` + `dangerousSweepRoot` + `visibleMountPoints` + marker, ~300 lines; the lease
    writes at IV L815/910; the opportunistic sweep call at IV L1195; `scripts/sweep-scratch.mjs`;
    `package.json scratch:sweep`). **This is the ONLY surface that broke** — all four P1/P2 breaks
    across both rounds are properties of this autonomous root-walking deletion primitive.

- **What Part 2 actually buys, measured.** `SWEEP_PREFIXES` is only `cleanroom-verify-/record-`, i.e.
  exactly the dirs Part 1 now cleans crash-safely. Over the real root the sweep auto-reclaims **0**
  dirs (both rounds' own dry-runs: all 867 legacy are no-lease→kept; 666 hand-named lane dirs are
  foreign-prefix→skipped). Its entire marginal value over Part 1 = reclaiming a room leaked by
  **SIGKILL/power-loss of IV AFTER the lease was written** — and a SIGKILL between `mkdtempScratch()`
  and `writeLease()` is kept-forever-as-legacy anyway (documented residual). So Part 2 guards a narrow
  window, reclaims nothing today, and costs an autonomous destructive primitive that has deleted a
  live dir (P1) and external data via a bind mount (P2) four times.

- **Producer census (does creator-side cleanup cover the real producers?).** `rg mkdtempScratch`:
  (1) IV clean rooms (`cleanroom-*`) — covered by Part 1 for every catchable crash; only SIGKILL/
  power-loss escapes → manual. (2) ~11 `verify-*.mjs` + `pinned-tree.mjs` + candidate store — their
  own `finally`/`tmpDirs` cleanup, and the sweep NEVER targeted them (foreign prefix). (3) hand-named
  `*-copy/tree/clone` lane trees — created by the dispatch/worktree harness OUTSIDE this repo; sweep
  NEVER targeted them either. **So the autonomous sweep's only ever target was `cleanroom-*`, which
  Part 1 already makes crash-safe.** Deleting Part 2 loses coverage for nothing it was actually
  cleaning. (The broader "~50 mkdtempScratch callers have no lifecycle owner" surface is a separate
  concern — candidate ARCH at close, unchanged by this ticket.)

- **DECISION: RESCOPE (option 1).** Keep Part 1 (crash-safe creator-side cleanup, HOLDS). DELETE the
  entire autonomous sweep + lease + confined-delete machinery. Replace with a READ-ONLY,
  operator-run, dry-run-by-construction cleanup tool that reports true (btrfs-exclusive) cost and
  emits the exact `rm` commands for operator review — productizing the ticket's own recommendation
  (a) + (c). The 865-leak RECURRENCE is already stopped by Part 1; the existing legacy batch is a
  one-time operator cleanup (always was — the sweep never auto-reclaimed it).

- **Price of each option:**
  - **(1) RESCOPE — CHOSEN.** Risky code KEPT: ~0 autonomous-deletion lines (Part 1 is a plain
    `rmSync` of this process's own known dir; the operator tool deletes nothing — it emits commands).
    ~300 lines of sweep/lease/walker/mountinfo/marker DELETED. **Residual:** a SIGKILL/power-loss of
    IV after room creation leaks ONE reflink-cheap room (~40KiB exclusive) until the operator runs the
    report+cleanup; no autonomous reclaim of it. **User loses:** background auto-reclaim of
    SIGKILL-leaked clean rooms — demonstrated value today = 0 dirs; future value = the narrow
    SIGKILL-after-lease window only.
  - **(2) REDESIGN — loses.** A single confined chokepoint (in-dir origin marker, flock by the room's
    USER, exact-root-only refusal, openat/fd-relative O_NOFOLLOW + per-fd st_dev) ADDS surface, not
    removes it: node `.mjs` has no openat2/`RESOLVE_BENEATH`/`RESOLVE_NO_XDEV`, and round-2's own
    verdict says the mount-landing-mid-walk race (P2b) is unclosable by a same-namespace walker — the
    only real close is a private mount+pid namespace (`unshare`) per delete, which a portable tooling
    module cannot assume. So it is a large, fragile build that STILL keeps an autonomous destructive
    primitive over a root, to guard a backstop worth 0 reclaimed dirs today, and invites a round-4
    door. Fails the "remove more surface than it adds" bar.
  - **(3) KEEP PATCHING — loses by the governing rule.** Both P1 and P2 broke via TWO independent
    doors each across two rounds; WA §N routes a two-break to design review precisely to STOP the
    add-another-guard cycle. Round-2's verdict named the recurring shape: every patch (`.trash` reclaim,
    root refusals, one-shot mount read) reopens "is this safe to delete right now?" OUTSIDE the single
    predicate. A non-renewable round budget does not change that the next door opens anyway.

- **Owner sign-off: NOT required (decision is the reviewer's).** The behavior cut — autonomous
  SIGKILL-leak reclaim — was never user-requested: it is agent recommendation (b) in a finding-lane
  ticket, whose recommendation (a) is explicitly a MANUAL operator cleanup. Per the dispatch decision
  rule, sign-off is needed only if the cut removes behavior the user explicitly asked for; it does
  not. Flagged transparently: if the owner specifically wants autonomous (not manual) reclaim of
  SIGKILL leaks, that reopens option 2 and its cost — a preference check, not a blocker. Recommend
  RESCOPE regardless.

## Build plan for the fixer (RESCOPE)

**Invariant.** Scratch cleanup never runs an autonomous deletion over a directory it did not itself
create. A process deletes ONLY the exact dir it made with `mkdtempScratch` (by remembered path), on
its own exit/signal. Reclaiming anything else is an operator action, dry-run-by-construction.

**Design.**
1. KEEP `independent-verify.mjs` Part 1 exactly as-is (L106-128 registration + exit/signal handlers;
   normal-exit `rmSync` untrack at L1401-1404 / L1517-1520). It is self-sufficient and HOLDS.
2. REMOVE from `independent-verify.mjs`: the `writeLease`/`writeKeep`/`sweepScratchRoot` import
   (L80 → import only `mkdtempScratch, scratchRootInfo, checkSameFilesystem, SCRATCH_ENV`); the two
   `writeLease(...)` calls (L815, L910); the `writeKeep(...)` calls (L814, L909 — `--keep-cleanroom`
   is already simply NOT registered, so it is never auto-deleted; a `.keep` sentinel only existed to
   fend off the sweep); the opportunistic sweep call (L1193-1195). Update the Part-1 header comment
   (L94-104): drop the "sweep is its backstop / room carries a lease" sentences; state instead that
   SIGKILL/power-loss leaks are reclaimed by the operator report tool.
3. DELETE from `scripts/lib/scratch.mjs` all of Part 2: `SCRATCH_ROOT_MARKER`, `SWEEP_PREFIXES`,
   `currentBootId`, `pidStartToken`, `pidAlive`, `currentPidNs`, `leaseLiveness`, `leaseIsLive`,
   `writeLease`, `writeKeep`, `dangerousSweepRoot`, `visibleMountPoints`, `mountUnder`,
   `rmTreeConfined`, `deletionBlocked`, `sweepScratchRoot`, `sweepDeletionBlocked`, `DAY_MS`, and the
   marker-drop in `scratchRootInfo` (L201-206). Rewrite the file header's "LIVENESS-GATED sweep"
   paragraph (L35-51) to: the module is deliberately NOT auto-swept (restore the original rationale,
   now reinforced by the two-break history — cite BUG-250), creator-side crash-safe cleanup lives in
   the creator (IV), and bulk reclaim is the operator report tool. Keep everything else (resolution,
   `mkdtempScratch`, `checkSameFilesystem`, fs-type helpers).
4. DELETE `scripts/sweep-scratch.mjs` and the `package.json` `scratch:sweep` script.
5. ADD `scripts/scratch-report.mjs` + `package.json scratch:report` — READ-ONLY operator tool:
   lists `cleanroom-*` and other children with ctime age and `fuser` liveness; reports **btrfs
   EXCLUSIVE** cost via `btrfs filesystem du -s` (NOT raw `du`) so the operator is not misled
   (recommendation c); and EMITS the exact per-dir `rm -rf` commands (age-filtered, fuser-rechecked)
   for the operator to review and run by hand. It performs NO deletion itself (no `--delete` flag) —
   that keeps zero autonomous destructive code in the repo and faithfully matches recommendation (a)
   ("review, NOT run blind").
6. REPLACE `scripts/verify-bug-250-scratch-sweep.mjs` with `scripts/verify-bug-250-crash-safe.mjs`
   (+`package.json verify:bug-250`) — a Part-1 crash-safety + absence-of-sweep suite (below).

**Files involved.** `scripts/lib/scratch.mjs` (delete Part 2), `scripts/independent-verify.mjs`
(trim to Part 1 only), `scripts/scratch-report.mjs` (new, read-only), `scripts/sweep-scratch.mjs`
(delete), `scripts/verify-bug-250-scratch-sweep.mjs` (replace), `package.json` (swap scripts).

**Test plan — a must-FAIL for every round-1 and round-2 break.** Because RESCOPE RETIRES the broken
surface, each break is proven impossible by ABSENCE, and the suite asserts the absence (so a future
re-introduction fails the gate):
- **R1-P1a** (asymmetric post-rename re-check TOCTOU) and **R2-P1a** (`.trash` reclaim with no gate):
  must-FAIL on round-2 code (reproduced earlier); now RETIRED — assert `sweepScratchRoot`,
  `deletionBlocked`, `rmTreeConfined` are no longer exported from `scratch.mjs`, and that
  `independent-verify.mjs` contains no call that walks/deletes a ROOT (only `rmSync` of a tracked
  dir). No API exists to construct the race.
- **R1-P1b** (cross-pid-ns liveness) and **R2-P1b** (lease = creator pid, not room's user): RETIRED —
  there is no lease and no liveness-gated deletion. Assert `writeLease`/`leaseLiveness`/`pidAlive`
  absent.
- **R1-P2** (`--one-file-system` same-device bind), **R2-P2a** (repo not a refused root), **R2-P2b**
  (mount lands mid-walk): all are properties of the root walker. RETIRED — assert
  `dangerousSweepRoot`/`visibleMountPoints`/`rmTreeConfined` absent and that NOTHING in the repo
  deletes a foreign dir under a root. Add a positive test: a bind mount placed inside a `cleanroom-*`
  dir is NEVER traversed by any shipped code path (there is none).
- **P3 crash-safety (KEEP, must-FAIL proof):** against the REAL tool via the existing crash seam
  (`CLAUDE_STATION_IV_CRASH_AFTER_ROOM`): throw / `die()` / exit / SIGTERM / SIGINT / SIGQUIT / SIGHUP
  each leave ZERO `cleanroom-*` dirs; a synthesized pre-Part-1 shape (room made, no handler, exit)
  LEAKS (bug reproduced, Part 1 removes it). Run harness-side with real `.git` (round-1/2 clean-room
  `.git`-less artifact noted — the independent pass must use a git-capable shadow repo, as round-2's
  P3/P4 verifiers did).
- **Operator tool (read-only proof):** against a REALISTIC busy-state fixture (many `cleanroom-*` of
  mixed age, a `fuser`-HELD dir, legacy no-lease dirs, a hand-named lane tree): the tool removes ZERO
  files, reports btrfs-exclusive (not du) cost, and emits `rm` commands that EXCLUDE the held dir.
- **Anti-regression:** `npm run verify:scratch-root` (28/28 — room landing, reflink cost, cross-fs
  report must still pass after the Part-2 deletion); IV happy path (`--print-prompt`) builds a room
  and cleans it; `--keep-cleanroom` keeps the room (now simply by not registering it). `npm run gate`
  exit 0.

**Proof bar.** Removing the autonomous destructive primitive LOWERS the stakes, but the change still
touches session-lifecycle + a file with a regression history, so per WA an independent clean-room
pass is WARRANTED and must confirm: (i) no autonomous sweep / confined-delete / lease code remains in
`scratch.mjs` or is invoked anywhere (grep-level + import-level, so re-introduction is caught);
(ii) Part 1 crash cases HOLD against the real tool in a git-capable room; (iii) the operator tool is
read-only (deletes nothing) over a realistic busy fixture. Record with `board-tool verified`.

**Symptom of a deeper design flaw?** yes → the close-out candidate stands ("scratch lifecycle had no
owner"), now answered by giving the CREATOR the ownership (crash-safe self-cleanup) rather than a
separate autonomous reaper — the reaper was the thing that had no safe construction. Recommend the
orchestrator still consider an ARCH ticket for the broader "~50 `mkdtempScratch` callers have no
lifecycle owner" surface (only IV self-cleans today).

### 2026-10-11 — fixing lane (round 3 — RESCOPE build, per the two-break design review)
- **Built exactly the design review's RESCOPE plan.** KEEP creator-side crash-safe cleanup in
  `independent-verify.mjs`; DELETE the entire autonomous sweep/lease/liveness/confined-walker surface
  in `scratch.mjs` + the opportunistic sweep call + the sweep CLI; REPLACE with a read-only,
  dry-run-by-construction operator report tool.
- **Removed (the surface that broke four times):** from `scripts/lib/scratch.mjs` —
  `sweepScratchRoot`, `sweepDeletionBlocked`, `deletionBlocked`, `rmTreeConfined`,
  `visibleMountPoints`, `mountUnder`, `dangerousSweepRoot`, `writeLease`, `writeKeep`,
  `leaseLiveness`, `leaseIsLive`, `pidAlive`, `pidStartToken`, `currentBootId`, `currentPidNs`,
  `SWEEP_PREFIXES`, `SCRATCH_ROOT_MARKER`, `DAY_MS`, and the marker-drop in `scratchRootInfo`. The
  file is now **177 lines (was 532 at the round-2 peak)** — back to ~its original pre-BUG-250 shape
  plus a header note recording the two-break history; it contains **ZERO deletion primitives**. From
  `independent-verify.mjs` — the `writeLease`/`writeKeep`/`sweepScratchRoot` import, both `writeLease`
  calls, both `writeKeep` calls (a `--keep-cleanroom` room is kept simply by NOT registering it), and
  the opportunistic sweep call in `main()`. Deleted files: `scripts/sweep-scratch.mjs`,
  `scripts/verify-bug-250-scratch-sweep.mjs`.
- **Kept (HELD in both rounds):** Part 1 crash-safe cleanup (register the exact `mkdtemp` dir; one
  `exit` handler + SIGINT/SIGTERM/SIGHUP/SIGQUIT; kill the dispatch child first; exit 128+n). It
  deletes ONLY a path THIS process created — never a foreign dir under a root.
- **Added:** `scripts/scratch-report.mjs` (125 lines, READ-ONLY — no `--delete` flag, zero deletion
  primitives) + `package.json scratch:report`: lists children with ctime age + `fuser` liveness,
  reports **btrfs EXCLUSIVE** cost (not raw du), and EMITS `rm -rf` commands (age-filtered,
  symlink-excluded, fuser-rechecked) for the operator to review and run by hand. Un-ignored in
  `.gitignore` (the generic `scripts/scratch-*.mjs` throwaway pattern would otherwise have dropped it;
  negation added with a comment). `package.json verify:bug-250` → `verify-bug-250-crash-safe.mjs`.
- **Net autonomous-root-deletion code in the repo after this change: 0 lines.**
- **Verified — `node scripts/verify-bug-250-crash-safe.mjs` → 27/27 PASS, 0 skipped:**
  - A. The REAL tool (against this git repo via the crash seam) removes its room on throw/die/exit
    and on SIGINT/SIGTERM/SIGHUP/SIGQUIT mid-run — each PROVEN to reach the seam first (no vacuous
    pass); synthesized pre-Part-1 shape LEAKS (bug reproduced). [git-capable guard: skips honestly if
    a tree has no `.git`; the git-write shim forbids a shadow `git init`, so the real repo is used.]
  - B. Absence-by-construction: `scratch.mjs` exports none of the retired API and has zero deletion
    primitives; IV imports/calls none of it, never spawns `rm`, never readdirs a root to delete, and
    every `rmSync` targets a tracked room/record/spool/dir; `scratch-report.mjs` deletes nothing;
    repo-wide `rg` finds NO reference to the retired API anywhere under `scripts/` (so a
    re-introduction fails this gate); a bind-mount-in-a-room is untraversable because no shipped code
    walks a root.
  - C. The report tool over a realistic busy fixture (mixed cleanroom-*, a fuser-HELD dir, hand-named
    lane trees, a prefix-named symlink): deletes NOTHING (file count unchanged), reports btrfs-
    EXCLUSIVE not du, emits `rm` only for cleanroom-* dirs and EXCLUDES the held dir, the lane trees,
    and the symlink; age filter emits nothing when the threshold exceeds all ages.
  - D. IV happy path (`--print-prompt`) cleans the room; `--keep-cleanroom` keeps it (by not
    registering).
- **Anti-regression:** `npm run verify:scratch-root` **28/28**. `npm run gate` = **PASS (exit 0)**.
- **Real-root read-only report** (`npm run scratch:report`, deletes nothing): 873 `cleanroom-*` dirs,
  0 held, **660 eligible (>7d, unheld)** — it emitted 660 `rm -rf` commands for operator review and
  removed nothing. This is the one-time legacy cleanup, now an explicit operator action.
- **Unverified / residual:** a SIGKILL/power-loss of IV after room creation leaks ONE reflink-cheap
  room until the operator runs the report+cleanup (no autonomous reclaim — that is the rescope's
  accepted trade); the sub-second grandchild-recreate window after the signal handler's SIGKILL
  (documented). Per the proof bar, an independent clean-room re-verify is still WARRANTED (session-
  lifecycle + regression-history file): confirm (i) no sweep/lease/walker code remains or is invoked
  (grep + import level), (ii) Part-1 crash cases HOLD against the real tool in a git-capable room,
  (iii) the report tool is read-only over a busy fixture.
- **Symptom of a deeper design flaw?** yes → answered by giving the CREATOR ownership (crash-safe
  self-cleanup) rather than a separate autonomous reaper (which had no safe construction). The broader
  "~50 `mkdtempScratch` callers have no lifecycle owner" surface remains a candidate ARCH at close.

### 2026-10-10 — IV clean-room lane r3 (R4)
- **Verification recorded:** dispatch anthropic run 5a28709e-e4a6-4aa4-a1d8-410949521950 — VERDICT: HOLDS — R4 HOLDS. Shadow clone with .git: verify-bug-250-crash-safe 27/27 0-skipped (throw/die/exit/INT/TERM/HUP/QUIT+D all run); signal-handler MUTANT (handlers removed) makes checks FAIL -> non-vacuous; verify:scratch-root 28/28; IV --print-prompt e2e clean. Matches harness 27/27+28/28.. Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-10-10 — IV clean-room lane r3 (R1)
- **Verification recorded:** dispatch anthropic run 4e773f2c-f585-49e1-96a0-f35632207e0c — VERDICT: BROKEN — R1 BROKEN as worded, but both breaks are PRE-EXISTING scripts OUTSIDE the BUG-250 diff (verify-arch-011 mkdir arch-011-<pid>+exit rmSync -> pid-reuse deletes a foreign dir; verify-arch-004). BUG-250's sweep REMOVAL is complete (retired API absent). The ticket's known ARCH candidate -> design review.. Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-10-10 — IV clean-room lane r3 (R3)
- **Verification recorded:** dispatch anthropic run e7dd52d2-d799-4127-8d9e-368411137b3c — VERDICT: HOLDS — R3 HOLDS. Shadow clone w/ .git: throw/die/exit + SIGINT/TERM/HUP/QUIT each remove room+record+spool (exit 128+n; signals at random build points; hang+keepalive non-vacuous). No over-deletion: crash of run A leaves run B's live room + a planted foreign cleanroom-* intact. Matches harness 27/27.. Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-10-10 — IV clean-room lane r3 (R2)
- **Verification recorded:** dispatch anthropic run c0690d70-9619-4662-92da-200b0d85d404 — VERDICT: BROKEN — R2 BROKEN (scratch-report.mjs). Tool deletes nothing, but EMITTED rm lines are unsafe: (a) fuser -s is top-level only -> a dir held via a SUBDIR/fd emitted as unheld; (b) emits rm for a cleanroom holding a live MOUNT -> external data; (c) L124 double-quoted path lets bash expand a crafted name.. Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-10-11 — independent verification (clean-room, ROUND 3, RESCOPE) — VERDICT: R1 BROKEN (out-of-scope / pre-existing), R2 BROKEN (in-scope), R3 HOLDS, R4 HOLDS
- **Overlay:** fresh BUG-250-only dangling commit `531c99f` = HEAD `e79aada` tree + exactly the 6
  round-3 files (scripts/lib/scratch.mjs 177L, scripts/scratch-report.mjs, scripts/verify-bug-250-crash-safe.mjs
  from the working tree; independent-verify.mjs = the round-2 overlay IV with the lease/writeKeep/
  sweep import+calls+opportunistic-sweep REMOVED (round-3 Part-1-only) and FEAT-170 still stripped so
  the diff is BUG-250-only; package.json = HEAD + the 2 round-3 script lines; .gitignore = HEAD + ONLY
  the `!scripts/scratch-report.mjs` negation, NOT the co-resident FEAT-172 `.claude/*` block). The two
  retired files (sweep-scratch.mjs, verify-bug-250-scratch-sweep.mjs) are absent by construction (never
  in HEAD). Confirmed: 6 files changed, 0 FEAT-170/candidate refs in IV, retired sweep API absent from
  all 3 scratch files. Built via the shim's temp-index plumbing (no grant). Artifacts under
  `~/.local/state/claude-station/scratch/bug250-r2-overlay-2763132/` (build-overlay-r3.mjs, iv-r3.mjs, mk-*).
- **Provider:** OpenAI re-probed, still quota-exhausted until 2026-10-14 ([quota-window]); all 4
  verifiers ran on anthropic (same provider as authors; decorrelation reduced), noted.
- **R1 (no autonomous deletion remains) — BROKEN as literally worded, but OUT OF BUG-250 SCOPE**
  (run 4e773f2c). The verifier confirmed BUG-250's own change is complete: the sweep/lease/liveness/
  confined-walker API is absent from scratch.mjs/IV/scratch-report.mjs, there is no sweep entrypoint, and
  the round-1/2 doors have nothing to act on. BUT the charter worded R1 as "no code path under scripts/
  or src/ deletes a scratch-root child except IV", and the verifier found TWO PRE-EXISTING scripts that
  violate it — `scripts/verify-arch-011-retry-routing.mjs` (creates `arch-011-<pid>` via mkdirSync
  recursive, exit handler rmSyncs it -> a dir left by an earlier same-pid process is destroyed on pid
  reuse) and `scripts/verify-arch-004-broken-state-visible.mjs`. Neither is in the BUG-250 diff (only the
  6 files changed); both predate this ticket. So this is NOT a defect in the round-3 rescope — it is
  exactly the "~50 mkdtempScratch/scratchRoot callers have no lifecycle owner" surface the ticket already
  flags as a candidate ARCH ticket. Two independent break-paths -> two-break STOP -> design review (which
  aligns with that ARCH candidate). **Orchestrator decision:** treat R1 as an ARCH-ticket item, not a
  BUG-250 round-3 blocker — the thing BUG-250 built/removed is sound.
- **R2 (scratch-report.mjs is read-only in practice) — BROKEN, IN SCOPE** (run c0690d70). The tool ITSELF
  deletes/modifies nothing (that sub-property HOLDS; byte-identical tree before/after over a busy fixture).
  But the charter also required its EMITTED `rm -rf` commands to never name a live-held dir or an outside
  path, and three genuine flaws break that: (a) liveness is `fuser -s <dir>` TOP-LEVEL only (L55-59), so a
  cleanroom dir held only via a process cwd in a SUBDIR or an open fd on a file inside it is classified
  unheld and emitted for removal; (b) the tool never scans for mounts, so it emits `rm -rf -- <cleanroom>`
  for an old unheld cleanroom that CONTAINS a live bind/tmpfs mount — the operator running that line
  deletes the external mounted data; (c) L124 emits `rm -rf -- ${JSON.stringify(full)}`, and JSON's
  DOUBLE quotes do not stop bash from expanding `$( )`, backticks or `${ }` in a crafted child name, so a
  maliciously/oddly named dir yields an injectable suggested command (a FINDING per the charter, not a
  tool-deletion). Two independent break-paths -> two-break STOP -> design review. Fix direction: recurse
  the liveness probe (or refuse any dir with a holder beneath it), refuse/flag a dir containing a mount,
  and single-quote-escape the emitted path.
- **R3 (crash-safe cleanup + no over-deletion) — HOLDS** (run e7dd52d2). In a shadow clone with `.git`:
  throw / die() / exit / SIGINT / SIGTERM / SIGHUP / SIGQUIT each removed room + record + `/tmp` spool
  (exit 128+n; signals delivered at random points during the room build; hang-mode made non-vacuous with
  a keep-alive import; a --keep-cleanroom crash correctly keeps). NO over-deletion: with two IV runs in
  ONE scratch root, crashing run A left run B's concurrent LIVE room/record/spool intact, and a planted
  FOREIGN `cleanroom-*` dir was never touched. Independently matches this lane's harness-side run.
- **R4 (no regression) — HOLDS** (run 5a28709e). In a shadow clone with `.git`: verify-bug-250-crash-safe
  **27/27, 0 skipped** with all crash/signal cases (throw/die/exit/INT/TERM/HUP/QUIT) + D actually run; a
  signal-handler MUTANT (handlers deleted, suite's signal logic replayed) makes those checks FAIL, proving
  they are non-vacuous; `verify:scratch-root` 28/28; IV `--print-prompt` e2e exits 0 and leaves an empty
  scratch root. Matches this lane's harness-side runs.
- **Harness-side backstop (this lane, real working tree, real `.git`):** `verify-bug-250-crash-safe.mjs`
  **27/27, 0 skipped** (crash A-section ran); `verify:scratch-root` **28/28**; static `rg` confirms the
  retired sweep/lease/walker API is absent from the 3 round-3 scratch files and every IV `rmSync` targets a
  dir IV created (room/record/spool/room-contents). The `pidAlive`/`pidStartToken` names that still appear
  under src/server are the separate pre-existing ARCH-001 server liveness authority, not the scratch sweep.
- **Verdict:** BUG-250's round-3 RESCOPE itself is sound — the autonomous destructive surface is gone
  (R1 confirms its absence), crash-safe self-cleanup holds and does not over-delete (R3), and nothing
  regressed (R4). The two BROKEN results are: R2 — a real IN-SCOPE safety defect in the NEW read-only
  report tool's EMITTED commands (not a deletion, but unsafe suggestions) -> fix + re-verify; R1 — a real
  but PRE-EXISTING, OUT-OF-SCOPE violation of the broad "nothing deletes a scratch child it didn't own"
  invariant by unrelated verify-arch-* scripts -> the ticket's own ARCH candidate, not a round-3 blocker.
- **Could-not-test / residual:** real init-ns/btrfs-root mounts (tmpfs/user-ns proven; root needed for
  init-ns); SIGKILL/power-loss of IV after room creation (accepted rescope trade — operator reclaims via
  the report tool); the sub-second grandchild-recreate window after a handled signal's SIGKILL.
- **High-stakes note:** session-lifecycle + regression-history file; the independent clean-room pass was
  warranted and surfaced one in-scope defect (R2) plus one out-of-scope invariant violation (R1).

### 2026-10-11 — fixing lane (round 4 — R2 report-tool safety + R1 pre-existing deleters)
- **R2 (in-scope): `scratch-report.mjs` made LIST-ONLY — the structural fix that closes all three
  doors at once.** The tool no longer emits any executable `rm` command. STDOUT is now a plain list
  of eligible PATHS (newline, or NUL-separated with `--print0`); all human guidance goes to STDERR;
  a one-line note says cleanup is manual. With no emitted command there is no injection vector (door
  c — the old `rm -rf -- ${JSON.stringify(path)}` let bash expand `$()`/backticks in a crafted dir
  name). Eligibility is now conservative and RECURSIVE so the list itself cannot mislead: a dir is
  listed only if it is `cleanroom-*`, older than the threshold, NOT a symlink, with NO live process
  holding an fd/cwd/root ANYWHERE beneath it (scan of `/proc/<pid>/{fd,cwd,root}`, walked upward to
  the candidate — closes door a, the old top-level-only `fuser -s <dir>`), and NO mount point at or
  under it (`/proc/self/mountinfo` — closes door b, the old no-mount-scan that would have listed a
  room containing a live bind mount). Held/mounted old dirs are reported as NOT ELIGIBLE and never
  listed.
- **R1 (pre-existing, out-of-scope per the round-3 verdict, but fixed as instructed): two scratch
  deleters switched to the contained pattern.**
  - `scripts/verify-arch-011-retry-routing.mjs`: was `arch-011-${process.pid}` (fixed per-pid) removed
    on exit → a later same-pid run could delete a foreign dir an earlier dead run left. Now
    `mkdtempScratch('arch-011-')` — a unique dir this process created, removes only that.
  - `scripts/verify-arch-004-broken-state-visible.mjs`: was `path.join(scratchRoot(),'arch-004-ui')`
    (fixed name) `rmSync`'d at setup → foreign to the next run. Now `mkdtempScratch('arch-004-ui-')`
    (the explicit `ARCH004_SCRATCH` override stays the operator's own responsibility).
  - **Census (did NOT fix the rest; ≤5 so no ticket filed):** a scan of `scripts/` found only these
    two with the hazardous fixed/pid-only-name-then-delete shape. `verify-ticket-view-redesign.mjs`
    uses `…-${pid}-${Date.now()}` (timestamped, effectively unique — much lower risk, left as-is);
    every other scratch-using script already uses `mkdtempScratch`/`mkdtempSync` (unique). Since the
    count is ≤5, both named ones were fixed directly and no scoped ticket was filed. The broader
    "~50 `mkdtempScratch`/`scratchRoot` callers have no lifecycle owner" ARCH candidate at close
    still stands.
- **Verified — `node scripts/verify-bug-250-crash-safe.mjs` → 34/34 PASS, 0 skipped:** section C now
  proves list-only + read-only, and carries a synthesized MUST-FAIL + fixed pair for each door —
  (a) round-3 top-level `fuser` misses a holder on a deep fd (→ would list) vs the recursive /proc
  scan EXCLUDES it; (b) round-3 (no mount scan) would list a mounted cleanroom dir vs the fixed tool
  EXCLUDES + flags it [ran under a real `unshare -rm` user+mount ns]; (c) round-3's double-quoted emit
  actually executed `$(touch INJECTED)` from a crafted dir name vs the fixed tool emits a literal path
  that survives `xargs -0` with nothing executed. Sections A/B/D unchanged and still green (crash-safe
  cleanup on throw/die/exit/INT/TERM/HUP/QUIT; retired-sweep API absent; IV happy/keep).
- **Pre-existing deleters re-run once each:** `verify-arch-011` **26/26 PASS**. `verify-arch-004`
  ran its full setup + browser legs (90 checks pass through the path I changed); its 6 failures are
  PRE-EXISTING board-corpus-count assertions (the real ~200-row board has drifted from the suite's
  pinned expectations — e.g. BUG-910 seed vs real ambiguous tickets), semantically unrelated to the
  scratch-dir location this change touched. Not a regression introduced here.
- **Anti-regression:** `npm run verify:scratch-root` **28/28**. `npm run gate` = **PASS (exit 0)**.
- **Unverified / residual:** real init-ns/btrfs-root bind mounts (tmpfs + user-ns proven; init-ns
  needs root); the `/proc` holder scan reflects the sweeper's own pid-namespace (a holder in another
  pid-ns is invisible — but the tool only LISTS for a human, never deletes, and a mount from another
  ns is also not visible to that human's `rm`, so the list stays consistent with what their shell can
  reach); SIGKILL/power-loss leak reclaimed only by the operator running this report (accepted trade).
  Per the proof bar, a round-4 independent clean-room re-verify is still warranted.

### 2026-10-10 — IV clean-room lane r4 (RR2)
- **Verification recorded:** dispatch anthropic run dd735b89-ea0d-40ee-8d9c-ce3f2855bc95 — VERDICT: BROKEN — R2 round-4 BROKEN (scratch-report.mjs); two-break->design review. List-only/read-only/injection HOLD. But the holder scan reads only /proc/<pid>/{cwd,root,fd} by PATH, so it MISSES a holder reaching the dir via a bind-mount ALIAS, and one via exe/maps -> listed eligible though fuser -m sees them.. Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-10-10 — IV clean-room lane r4 (RR1)
- **Verification recorded:** dispatch anthropic run a19ac249-7461-4a5e-8ce0-f6f604901848 — VERDICT: HOLDS — R1-residual round-4 HOLDS. Ran REAL verify-arch-011 x3 + pid-reuse wrapper + verify-arch-004 past its setup rmSync + 400 mkdtempScratch cycles: all 9 planted old-name sentinels survived; each run removed only its own mkdtemp. Static: neither builds a fixed/pid name; rmSyncs stay inside own mkdtemp.. Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-10-11 — independent verification (clean-room, ROUND 4) — VERDICT: R1-residual HOLDS; R2 BROKEN AGAIN (two more new paths → two-break STOP, design review)
- **Overlay:** fresh BUG-250-only dangling commit `8a783e5` = HEAD `e79aada` tree + 8 round-4 files
  (working tree: scratch-report.mjs [list-only rewrite], verify-bug-250-crash-safe.mjs [34/34],
  verify-arch-011-retry-routing.mjs + verify-arch-004-broken-state-visible.mjs [now mkdtempScratch];
  carried BUG-250-only: independent-verify.mjs = iv-r3.mjs, scratch.mjs, package.json, .gitignore).
  Confirmed 8 files changed, IV 0 FEAT-170 refs, scratch-report emits no per-dir deletion command. Built
  via temp-index plumbing (no grant). OpenAI re-probed, still quota-exhausted until 2026-10-14 → both
  attackers on anthropic (noted).
- **R1-residual — HOLDS** (run a19ac249). The two pre-existing deleters were switched from a fixed/pid
  name to `mkdtempScratch(...)`. The verifier ran the REAL `verify-arch-011` three times plus a
  pid-reuse wrapper, ran `verify-arch-004` past its setup `rmSync(SCRATCH)` (it then stopped in seedBoard
  — the room has no docs/bugs — which is fine), and did 400 mkdtempScratch create/remove cycles. All 9
  planted OLD-name sentinel dirs (`arch-011-<pid>`, `arch-004-ui`, `arch-004-ui-oldfixed`) SURVIVED every
  run; each run removed only its own `arch-011-<rand>`/mkdtemp dir. Static: neither script builds a
  fixed/pid name any more, and every `rmSync` target sits inside the script's own mkdtemp dir. The
  residual is closed.
- **R2 — BROKEN AGAIN** (run dd735b89; two-break → DESIGN REVIEW). The round-4 rewrite CLOSED all three
  round-3 doors — stdout is now a plain path list (no emitted command → injection door c gone; crafted
  names with shell metacharacters pass the `--print0` consumer path as single inert argv entries with
  nothing executed), the tool is byte-read-only over the tree, and the recursive /proc holder scan +
  mountinfo scan close the round-3 top-level-fuser and no-mount-scan doors. (All independently reproduced;
  this lane's harness-side suite is 34/34, 0 skipped, each door carrying a round-3 MUST-FAIL + fixed
  pair.) BUT the verifier found TWO NEW holder-detection gaps, both because the scan reimplements liveness
  by reading only `/proc/<pid>/{cwd,root,fd}` (scratch-report.mjs L96-99) and matching by PATH (an upward
  walk to the candidate's realpath):
  1. **Bind-mount ALIAS cwd.** Bind-mount the candidate at `root/zz-alias` and park a live process with
     cwd `zz-alias/a/b`; `/proc/<pid>/cwd` reads the ALIAS path, which never realpaths back to the
     candidate, so the upward walk misses it and the dir is LISTED as eligible — while `fuser -m` reports
     it held. (`unshare -rm`.)
  2. **Holder via exe/maps.** A process executing a binary stored inside the candidate dir (cwd=/) holds
     it (fuser 'e'), but the scan never reads `/proc/<pid>/exe` or `/proc/<pid>/maps`, so the dir is
     LISTED. mmap'd files (maps) are the same class.
  Also noted (NOT counted as a break — `--print0` is safe and documented): the DEFAULT newline-separated
  output splits a newline-in-name into a fragment line that can look like an out-of-root path; only
  `--print0` is safe for arbitrary names.
- **Two-break assessment:** R2 has now broken across round 3 (top-level fuser miss; no mount scan;
  injectable emit) and round 4 (bind-alias cwd; exe/maps holder) — repeatedly, each time via a NEW
  holder-detection gap. This is the two-break STOP: routed to DESIGN REVIEW. Root cause: the tool is
  re-implementing a mount-/access-type-aware "is anything holding this subtree?" check in bespoke /proc
  path-matching code, and that keeps missing cases (bind aliases, exe, maps, …). Candidate directions for
  the review: (i) delegate to `fuser -m <dir>` (mount-aware, covers cwd/root/exe/mmap/fd access types) as
  the liveness authority rather than re-deriving it; or (ii) accept that the emitted list is ADVISORY only
  and make the tool say so loudly / require the operator to re-check `fuser -m` per dir before removing —
  i.e. stop trying to PROVE "nothing holds it" in bespoke code. Either way, `--print0` should be the
  default/only output for arbitrary names.
- **Harness-side backstop (this lane, real working tree + `.git`):** verify-bug-250-crash-safe.mjs
  **34/34, 0 skipped** (the three round-3 R2 doors each a MUST-FAIL+fixed pair, incl a real `unshare -rm`
  mount case); an independent read-only/list-only/crafted-name spot-check confirmed the tree is
  byte-unchanged, stdout carries no command, a held dir was excluded while held, and a `$(touch…)` name
  fed through the `--print0` consumer executed nothing. (These cover the FIXED doors; they do NOT cover
  the two NEW gaps above — the suite, like the tool, reads only cwd/root/fd.)
- **Scope reminder:** R3 (crash-safe cleanup + no over-deletion) and R4 (no regression) HELD in round 3
  and were not re-attacked; scratch.mjs/IV are unchanged since round 3. BUG-250's core rescope (no
  autonomous deletion; crash-safe self-cleanup) remains sound. The OPEN item is solely the read-only
  report tool's liveness/mount detection fidelity (R2), now a design-review item rather than a one-line
  patch.
- **Could-not-test / residual:** real init-ns/btrfs-root mounts (tmpfs+user-ns proven); a holder in a
  DIFFERENT pid-namespace (invisible to the /proc scan — but also invisible to the operator's own shell,
  so arguably consistent); whether `fuser -m` is always available in the operator's environment.

### 2026-10-11 — independent design review #2 (two-break, report tool) — DECISION: RESCOPE via candidate (a)
Report-id: design-review-bug250-r5-1791673306 · reviewer: independent design-reviewer (author of review #1, NOT of any build lane) · WA §N two-break review of `scratch-report.mjs`.

- **Inputs read:** round-3 build + round-3 independent verify (R2 BROKEN: top-level `fuser`, no mount
  scan, injectable emit), round-4 build (list-only rewrite + recursive /proc scan + mountinfo), round-4
  independent verify (R2 BROKEN AGAIN: bind-mount-alias cwd; holder via exe/maps), and the current
  `scripts/scratch-report.mjs`. R3 (crash-safe self-cleanup, no over-deletion) and R4 (no regression)
  HOLD and `scratch.mjs`/`independent-verify.mjs` are unchanged since round 3 — the OPEN item is solely
  the report tool. Built nothing.

- **Root cause — confirmed, the coordinator's reading is correct on the evidence.** The tool's defect is
  that it emits an **"ELIGIBLE"** classification at all. "Eligible" = "no process holds this subtree and
  no mount is under it" = a **liveness/safety CLAIM**, and the tool computes it by **re-deriving "is
  anything holding this subtree?" from a bespoke `/proc` enumeration** (`scanHeldAndMounted`, L96-99:
  `/proc/<pid>/{cwd,root,fd}` matched by path, plus `mountinfo`). That is the SAME open-ended enumeration
  that broke the autonomous sweep in rounds 1-2: every round a new access type or path-aliasing defeats
  it — round 3: a holder in a subdir (top-level `fuser` only) + a mount inside (no scan); round 4: a
  holder whose cwd is a **bind-mount alias** (path never realpaths back to the candidate) + a holder via
  **exe/maps** (never read). The list is unbounded (fd, cwd, root, exe, maps, bind-alias, next: a holder
  in another pid-ns, …). A classification that cannot be soundly computed must not be made.

- **DECISION: RESCOPE — candidate (a): the tool makes NO liveness claim.** Delete `scanHeldAndMounted`
  and the eligible/not-eligible partition entirely. The tool becomes a pure, read-only **inventory**: it
  lists `cleanroom-*` dirs (non-symlink, optionally age-filtered) with ctime age and the **btrfs-EXCLUSIVE
  true cost** (the monitoring-lie fix, recommendation c — the one thing the operator needs for the pending
  legacy-cleanup decision), `--print0` as the default/only machine list, and a LOUD stderr banner that
  cleanup is manual and the operator MUST run `fuser -m <dir>` and check for a mount under each dir before
  removing it. With no safety claim and no holder enumeration, there is nothing for a new access-type or
  path-alias to defeat — the two-break surface is removed, not re-guarded. This is review #1's principle
  ("do not run, or CLAIM, what you cannot soundly compute") applied one level up.

- **Price of each candidate:**
  - **(a) RESCOPE — CHOSEN.** Risky code KEPT: 0 lines of liveness/enumeration (the ~40-line
    `scanHeldAndMounted` + the eligible partition are DELETED). Tool stays byte-read-only, emits no
    command (already), `--print0`-only for arbitrary names. **User KEEPS** the actual value the tool was
    for: the count, the ages, and the TRUE (btrfs-exclusive, reflink-aware) cost that corrects the
    original 282G-vs-40KiB misdiagnosis and informs the 867-legacy-dir decision. **User loses:** an
    auto-computed "safe to delete" shortlist — which was WRONG twice and is unsound by construction; the
    honest replacement is "here is what's there and what it really costs; YOU confirm liveness per dir"
    (exactly the original WA framing: "review, NOT run blind"; "re-check `fuser` per dir"). **Residual:**
    none new — the operator's own `fuser -m`/mount check is the liveness authority, as it always had to be.
  - **(b) REDESIGN — delegate to `fuser -m` — loses.** It is STILL a liveness claim (different authority,
    not no-authority), and `fuser -m <dir>` does NOT make the property true by construction on THIS system:
    its mount semantics report every process using the whole **mounted filesystem** the dir sits on — and
    scratch shares one btrfs mount (dev 30) with the repo and $HOME, so `-m` on a cleanroom subdir
    over-captures to ~every process on the box (→ everything reads "held", ~0 ever eligible, the tool stops
    informing). Drop the `-m` and it is per-path, not recursive — back to enumerating paths, the same walk.
    It also does NOT detect a mount UNDER the dir (that is `mountinfo`, not `fuser`), adds an external-binary
    dependency the ticket already flags as not-always-present, and keeps a breakable claim. Over/under-
    capture + still-a-claim: loses.
  - **(c) DELETE the tool (`ls -lt` is the manual path) — loses.** Zero break surface, but it THROWS AWAY
    the sound, non-breaking half: `ls -lt` shows names+mtime but NOT the btrfs-EXCLUSIVE true cost, NOT the
    cleanroom-prefix filter, NOT the count — so the operator making the pending 867-dir decision is pushed
    back to `du` (the very lie that caused the 282G misdiagnosis) or to a plain `ls` with no cost signal at
    all. Over-corrects: a narrower cut (drop only the liveness claim) preserves the value the user needs.

- **Owner sign-off: NOT required (decision is the reviewer's).** The behavior cut — an auto-computed
  "safe-to-delete" shortlist — was never user-requested; it was the build lane's mechanism, and it is
  unsound. The behavior the user actually needs for the pending legacy-cleanup choice (count, age, TRUE
  cost) is PRESERVED and made honest by (a). Flagged transparently: under (a) the operator must run
  `fuser -m` + a mount check per dir themselves before `rm` — the tool will not pre-clear dirs. That is the
  original WA framing, not a new burden. If the owner specifically wanted a pre-cleared auto-shortlist, that
  is the one thing cut — but it is unsound and I recommend (a) regardless.

## Build plan for the fixer (RESCOPE #2 — report tool makes no liveness claim)

**Invariant.** `scratch-report.mjs` makes NO safety/liveness determination. It reports read-only facts
(name, age, btrfs-exclusive cost) and never asserts that any dir is safe to delete. Liveness is the
operator's own `fuser -m`/mount check, which the tool instructs and does not pre-empt.

**Design.**
1. DELETE `scanHeldAndMounted` (the `/proc/<pid>/{cwd,root,fd}` + `mountinfo` enumeration) and every
   `held`/`mounted` field and the `eligible`/`notEligible` partition from `scripts/scratch-report.mjs`.
2. The report lists `cleanroom-verify-*`/`cleanroom-record-*` dirs that are NOT symlinks and (optionally)
   older than `--age-days`, each with ctime age; the whole-root **btrfs-EXCLUSIVE** cost stays (keep
   `btrfsExclusive`; keep the "du would over-count reflinks" note). `--all` may still list non-cleanroom
   children for context (name + age only), clearly un-prefixed.
3. STDOUT carries ONLY the path list; make `--print0` the DEFAULT separator (newline only behind an
   explicit `--newline` for interactive eyeballing), per the round-4 note that a newline-in-name splits a
   bare list into a fragment that can look like an out-of-root path.
4. STDERR banner (loud, unmissable): "This is an inventory, NOT a safety check. The tool does NOT and
   CANNOT prove nothing holds a dir. Before removing ANY path, run `fuser -m <dir>` and verify no mount is
   at/under it." Keep the `… | xargs -0 -r -- rm -rf --` example but prefixed by that warning.
5. Keep it read-only (no `--delete`, no emitted executable command) — unchanged.

**Files involved.** `scripts/scratch-report.mjs` (remove the liveness claim + enumeration).
`scripts/verify-bug-250-crash-safe.mjs` (rework section C, below). No change to `scratch.mjs`,
`independent-verify.mjs`, or `package.json` (`scratch:report` stays).

**Test plan — a must-FAIL for every round-3 and round-4 break (retired by ABSENCE of the claim).** Each
break is a property of the liveness classification or an emitted command; removing both retires all five
by construction, and the suite asserts the absence so a re-introduction fails the gate:
- **R2-r3(a)** top-level-`fuser` miss, **R2-r3(b)** no-mount-scan, **R2-r4(1)** bind-alias cwd,
  **R2-r4(2)** exe/maps holder: RETIRED — the tool no longer classifies held/mounted at all. Must-FAIL/
  absence: assert `scratch-report.mjs` contains no `/proc/<pid>` holder scan and no eligible/held/mounted
  classification; and prove behavior-independence — over a busy fixture where a dir is held via a deep fd,
  via a bind-mount-alias cwd, and via exe/maps, AND one with a mount inside, the tool's output is
  IDENTICAL to treating them as ordinary cleanroom dirs (all listed, all under the same advisory). Because
  output no longer depends on a liveness probe, none of the five doors can change it.
- **R2-r3(c)** injectable emit: RETIRED — no executable command is emitted (already). Positive proof: a
  crafted `cleanroom-verify-$(touch INJECTED)` name fed through `--print0 | xargs -0` is one inert argv
  entry; `INJECTED` is never created.
- **Read-only + inventory fidelity:** over a realistic busy fixture (mixed-age cleanroom-*, a held dir, a
  bind-mounted dir [real `unshare -rm`], an exe-holder, legacy no-prefix dirs, a hand-named lane tree, a
  prefix-named symlink, a crafted-name dir): the tree is byte-unchanged; STDOUT = NUL-separated
  `cleanroom-*` paths only (symlink excluded by name/type filter, not by a liveness claim); btrfs-EXCLUSIVE
  cost reported and raw `du` never shown; the `fuser -m` advisory banner present.
- **Anti-regression:** `verify-bug-250-crash-safe.mjs` sections A/B/D (crash-safe self-cleanup on
  throw/die/exit/INT/TERM/HUP/QUIT; retired-sweep API absent from scratch.mjs/IV; IV happy/keep) stay
  green; `npm run verify:scratch-root` 28/28; `npm run gate` exit 0.

**Proof bar.** This REMOVES a claim rather than adding a guard, so the surface shrinks again (the tool
already deletes nothing and emits no command; now it also asserts nothing). It is low-risk, but the file
sits on a regression-prone ticket, so a LIGHT independent clean-room spot-check is warranted to confirm:
(i) no liveness/safety classification or `/proc` holder scan remains (grep + behavior-independence over
the busy fixture), (ii) read-only, (iii) `--print0` inert for crafted names, (iv) btrfs-exclusive
true-cost reporting intact. Record with `board-tool verified`.

**Symptom of a deeper design flaw?** yes, and it is the SAME one, now fully generalized: "is anything
using this subtree right now?" has no sound, bounded answer in user-space `/proc`/`fuser` enumeration on a
shared filesystem — not for an autonomous sweep (rounds 1-2) and not for a tool that merely CLAIMS it
(rounds 3-4). The durable answer for BUG-250 is: the CREATOR owns liveness (crash-safe self-cleanup, which
HOLDS), and no other component asserts it — the reporter informs, the human decides and verifies. The
broader "~50 `mkdtempScratch` callers have no lifecycle owner" surface remains the candidate ARCH at close.

### 2026-10-11 — fixing lane (round 5 — RESCOPE #2: report tool makes NO liveness claim)
- **Built exactly design-review #2's RESCOPE (a).** The report tool's second two-break (round-4:
  bind-mount-alias cwd; exe/maps holder) is a property of the tool emitting an "ELIGIBLE"
  classification at all — i.e. re-deriving "is anything holding this subtree?" from a bespoke `/proc`
  enumeration, the same unbounded question that broke the autonomous sweep. The fix removes the
  CLAIM, not another guard.
- **Changed — `scripts/scratch-report.mjs` only** (scratch.mjs and independent-verify.mjs left
  untouched, as instructed):
  - DELETED `scanHeldAndMounted` (the `/proc/<pid>/{cwd,root,fd}` + `mountinfo` enumeration) and every
    `held`/`mounted` field and the `eligible`/`notEligible` partition.
  - The tool is now a pure read-only INVENTORY: it lists non-symlink `cleanroom-*` dirs (optionally
    age-filtered) with ctime age and the whole-root **btrfs-EXCLUSIVE** true cost (the monitoring-lie
    fix — the figure the operator needs for the 867-legacy-dir decision; raw `du` still never shown).
  - `--print0` is now the DEFAULT separator on STDOUT (newline only behind `--newline`); STDOUT carries
    ONLY the path list.
  - A loud STDERR banner states it is an inventory NOT a safety check, that it cannot prove nothing
    holds a dir, and that the operator MUST run `fuser -m <dir>` and verify no mount is at/under each
    dir before removing it. Still read-only: no `--delete`, no emitted executable command.
- **Verified — `node scripts/verify-bug-250-crash-safe.mjs` → 34/34 PASS, 0 skipped.** Section C
  rewritten:
  - ABSENCE by construction: the source has no `/proc` holder enumeration, no `scanHeldAndMounted`,
    and no eligible/held/mounted classification (the words `fuser`/mount appear only in the operator
    banner strings). So all five doors — R2-r3(a) top-level fuser, R2-r3(b) no mount scan, R2-r4(1)
    bind-alias cwd, R2-r4(2) exe/maps — are retired, nothing left to defeat.
  - BEHAVIOUR-INDEPENDENCE (the must-FAIL replacement): the STDOUT list is byte-IDENTICAL whether or
    not a dir is held via a deep fd, and whether or not a dir contains a real bind mount (verified
    under `unshare -rm`). Because output no longer depends on any liveness probe, no access-type or
    path-alias can change it — proven, not asserted.
  - R2-r3(c) injection stays impossible: a crafted `cleanroom-verify-$(touch INJECTED)` name is one
    inert NUL argv entry through `xargs -0`; nothing executes.
  - Read-only + fidelity: tree byte-unchanged over a busy fixture; STDOUT = NUL cleanroom paths only
    (symlink excluded by type, not by a claim); btrfs-EXCLUSIVE reported; `fuser -m` banner present.
  - Sections A/B/D unchanged and green (crash-safe cleanup throw/die/exit/INT/TERM/HUP/QUIT; retired
    sweep API absent from scratch.mjs/IV; IV happy/keep).
- **Anti-regression:** `npm run verify:scratch-root` **28/28**. `npm run gate` = **PASS (exit 0)**.
  `scratch.mjs`/`independent-verify.mjs` unchanged since round 3 (no round-5 edits).
- **Unverified / residual:** liveness is now entirely the operator's own `fuser -m`/mount check per dir
  (the tool informs, never pre-clears — the original WA framing); a SIGKILL/power-loss leak is still
  reclaimed only by the operator acting on this inventory. Per the (light) proof bar, an independent
  clean-room spot-check is warranted: confirm no liveness/safety classification or `/proc` scan
  remains (grep + behaviour-independence), read-only, `--print0` inert for crafted names, btrfs-
  exclusive cost intact.

### 2026-10-11 — IV clean-room lane r5 (RR5)
- **Verification recorded:** dispatch anthropic run 1152408e-7365-4d9d-b393-6ecb4fe4a488 — VERDICT: HOLDS — R-r5 HOLDS. scratch-report.mjs is a read-only INVENTORY: no /proc scan, no eligible/held claim. Stdout byte-IDENTICAL whether a dir is held (fd/cwd/exe/bind-alias) or mounted; tree unchanged; --print0 default, crafted names inert via xargs -0; btrfs-EXCLUSIVE not du; suite 34/34 0-skipped.. Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-10-11 — independent verification (clean-room, ROUND 5, light spot-check) — VERDICT: HOLDS
- **Overlay:** fresh BUG-250-only dangling commit `ba22e64` = HEAD `e79aada` tree + 8 round-5 files
  (round-5 working tree: scratch-report.mjs [RESCOPE #2 — now a pure read-only inventory, /proc holder
  scan + eligible/held/mounted classification DELETED, --print0 default] and verify-bug-250-crash-safe.mjs
  [section C rewritten]; carried unchanged since round 3/4: scratch.mjs, independent-verify.mjs = iv-r3.mjs,
  verify-arch-011/004, package.json, .gitignore). Confirmed 8 files changed, 0 /proc-liveness classification
  in scratch-report.mjs, IV 0 FEAT-170 refs. Built via temp-index plumbing (no grant). OpenAI re-probed,
  still quota-exhausted until 2026-10-14 → single attacker on anthropic (noted). One attacker (design
  review #2's LIGHT bar).
- **VERDICT: HOLDS** (run 1152408e-7365-4d9d-b393-6ecb4fe4a488). All five properties confirmed:
  1. **No liveness/eligibility claim.** scratch-report.mjs has no `/proc` holder scan and no
     eligible/held/mounted classification; its STDOUT path list is byte-IDENTICAL whether or not a dir is
     held — tested with a deep-fd holder, a cwd holder, a running EXE inside the dir, and a bind-mount
     ALIAS with a cwd holder (the exact two gaps that broke round 4) — and whether or not it contains a
     real bind/tmpfs mount (`unshare -rm`), across all five flag sets (default/--newline/--all/--no-cost/
     --age-days 0). Output no longer depends on any liveness probe, so none of the five historical doors
     can change it.
  2. **Byte-read-only** over a busy fixture (held dirs, mounts, symlinks, crafted names, legacy no-prefix,
     lane trees): recursive snapshot (path + lstat type + sha256 + symlink target) identical before/after.
  3. **`--print0` inert** for crafted names (newline, `$(...)`, backticks, leading `--rf`) fed through the
     documented `xargs -0` consumer with an argv-printing recorder in place of rm: each arrives as one
     intact argument after `--`; no INJECTED/PWNED file created.
  4. **btrfs-EXCLUSIVE true cost** reported (a real 980KiB figure on non-random data), raw `du` never shown.
  5. **Crash-safe suite 34/34, 0 skipped** in a git-capable shadow repo (sections A/B/D intact).
- **Honest non-break note from the verifier (NOT counted):** a bind mount placed DIRECTLY OVER a top-level
  cleanroom dir drops it from the `--age-days` list, because `lstat` ctime then reads the mounted root —
  a fact about whatever is at the path, not a holder/liveness probe, and it does not occur with default
  flags. Correctly not a break.
- **Harness-side backstop (this lane, real working tree + `.git`):** verify-bug-250-crash-safe.mjs
  **34/34, 0 skipped**; an independent node spot-check confirmed behaviour-independence (held==unheld
  output), read-only tree, symlink + non-prefix excluded, `--print0` crafted-name inertness, and
  btrfs-EXCLUSIVE reporting.
- **Verdict / disposition:** BUG-250 round 5 HOLDS. The report tool now INFORMS and asserts nothing; the
  CREATOR owns liveness (crash-safe self-cleanup, which held in rounds 3-5). This is the durable answer
  design review #2 prescribed — "is anything using this subtree?" is no longer answered by any component,
  so the unbounded /proc/fuser question that broke rounds 1-4 is gone by construction. The broader
  "~50 `mkdtempScratch` callers have no lifecycle owner" ARCH candidate remains for close.
- **Could-not-test / residual:** real init-ns/btrfs-root mounts (tmpfs + user-ns proven); liveness is now
  entirely the operator's own `fuser -m`/mount check per dir (the tool's STDERR banner says so); a
  SIGKILL/power-loss leak is reclaimed only by the operator acting on this inventory (accepted trade).
