# BUG-290 — Scratch verify servers orphan and spin after their launcher dies

- **Status:** VERIFIED — self-defence watchdog (ppid-change + inode-identity) + SIGTERM backstop-first. Independent HOLDS run 01a1ab46 (openai, round 3), after rounds 1–2 BROKEN drove the zombie-launcher and replaced-dir fixes.
- **Severity:** high
- **Area:** server (lifecycle / scratch — `src/server/index.ts`, `scripts/lib/station-boot.mjs`)
- **Reported:** 2026-11-05 by orphan-incident lane
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
17 Orchard servers (`node <scratch>/src/server/index.ts`) booted by clean-room
verify suites (ORCHARD_SESSION=1e52191a) ran for 7–8 days after their launchers
exited, spinning at 40–80% CPU each (~7 cores, 3.6 GB), cwd deleted, parent the
systemd user manager; they ignored SIGTERM and had to be SIGKILLed after 10s.

## Root causes
1. A verify script spawns a scratch server as a child, then only kills it in a
   `finally{}`. When the launcher dies abnormally (OOM / dispatch timeout / turn
   ended), `finally` never runs and the server is reparented to the systemd user
   manager (pid 876 here — NOT pid 1, so a `ppid===1` check never catches it).
   Nothing signals it; it lives forever.
2. SIGTERM ignored: `shutdown()` armed its forced `setTimeout(process.exit)` AFTER
   `await closeAllSessions(…)`. If that await hangs (a survivable handoff / a
   container exec that wedges when cwd/data dir is gone), the backstop is never
   scheduled and SIGTERM hangs.
3. The 40–80% CPU spin is an active subsystem's loop/interval retrying against a
   vanished cwd/data dir (not reproducible on a plain idle server — a bare scratch
   server with its dirs deleted sits at ~0.7%).

## Fix (by construction)
- `src/server/harness-watchdog.ts` — a scratch server EXITS the instant its world
  is gone: launcher pid dead, or cwd/data dir deleted. Armed ONLY when
  `CLAUDE_STATION_TEST_HARNESS` is set AND `dataDirMode()==='isolated'` — the
  production server (shared data dir, no flag) is never touched. This is the
  orphan reaper AND the cure for the spin (a loop cannot spin if its process exits).
- `scripts/lib/station-boot.mjs` — `isolatedServerEnv()` injects
  `CLAUDE_STATION_TEST_HARNESS=1` + `CLAUDE_STATION_LAUNCHER_PID=<launcher pid>`,
  so all ~346 scratch suites get self-defence for free. isolatedServerEnv already
  refuses the real data dir, so a harness env can never point at the live service.
- `src/server/index.ts shutdown()` — the forced-exit timer (`CLAUDE_STATION_SHUTDOWN_FORCE_MS`,
  default 2000) is now armed FIRST, before any await, so SIGTERM always exits within ~2s.

## Deliberately NOT done — autonomous scratch reaper (see Decision)
Charter item 5 asked for an autonomous liveness-gated `scratch:sweep`. That is
exactly the design BUG-250 (VERIFIED, independent HOLDS run 1152408e) refused:
"is anything using this subtree right now?" has no sound user-space answer on a
shared filesystem — it broke twice (fuser/no-mount-scan; bind-mount-alias). The
7-core / 3.6 GB cost was the orphaned SERVERS, now fixed at the source; the leftover
dirs are ~40 KiB btrfs-EXCLUSIVE each (reflink-shared), per BUG-250. Reclaim stays
an operator action via `npm run scratch:report`.

## Context pack
- Files: `src/server/harness-watchdog.ts`, `src/server/index.ts` (import ~L31, watchdog arm ~L8336, shutdown ~L8678), `scripts/lib/station-boot.mjs` (`isolatedServerEnv`).
- Repro/verify: `node scripts/verify-bug-290-orphan-reaper.mjs`
- Related: BUG-250 (no autonomous sweep), BUG-114 (orphan bound), BUG-220/BUG-217 (data-dir lock), FEAT-015 (survivable handoff).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-11-05 — fix lane (dispatched)
- **Understood:** scratch servers spawned by verify suites outlive abnormal
  launcher death (reparent to systemd user manager, not pid 1); SIGTERM backstop
  was armed after a hangable await; the CPU spin is an active-subsystem loop on a
  vanished dir.
- **Changed:** `src/server/harness-watchdog.ts` (new), `src/server/index.ts`
  (import + watchdog arm + shutdown forced-exit-first), `scripts/lib/station-boot.mjs`
  (`isolatedServerEnv` injects harness flag + launcher pid). Unstaged (agents never git-write).
- **Verified (fixer's own run — necessary, not sufficient):**
  - MUST-FAIL (watchdog disabled = pre-fix): server SURVIVES launcher death after 3s = orphan reproduced.
  - POST-FIX: server self-reaps ~1000ms after launcher death; EXITS on cwd+data-dir deletion (pre-fix idle spin was ~0.7%, now exits).
  - SIGTERM normal case: exit in ~50ms (anti-regression). Forced-exit-first ordering proven by a synthetic hang fixture (labeled synthetic) in the suite.
  - `npx tsc --noEmit`: exit 0. `node scripts/verify-bug-290-orphan-reaper.mjs`: all PASS.
  - `scratch:report`: recorded in handoff.
- **Verified-by:** round 1 — dispatch openai run 01a1ab3c (clean-room) — VERDICT: BROKEN (see round 2).
- **Still open:** round-2 re-verify. **Symptom of a deeper design flaw?** yes → the pattern "a spawned helper outlives an abnormally-killed launcher" is general; harness-watchdog is the scratch-server instance.

### 2026-11-05 — fix lane, round 2 (re-fix after BROKEN)
- **Understood:** the independent verifier (openai run 01a1ab3c) returned BROKEN with a real
  finding: `pidAlive()` treats a ZOMBIE launcher as alive (`kill(zombiePid,0)` succeeds), so a
  reparented server kept serving ~3.3s until the launcher zombie was reaped. Legitimate gap.
- **Changed:** `src/server/harness-watchdog.ts` — added `currentPpid()` (live /proc read) and
  `launcherGone()`: the launcher is gone if we have been REPARENTED away from it (ppid changed —
  the robust Linux signal, fires the instant the parent exits, zombie or not), OR its pid is gone,
  OR it is a zombie. `worldGoneReason` now calls `launcherGone` instead of bare `pidAlive`.
- **Verified (fixer's own run):** `node scripts/verify-bug-290-orphan-reaper.mjs` → 20/20 PASS,
  including new unit assertions: `launcherGone(live-pid-that-is-not-our-parent) === true`
  (the zombie class) and `launcherGone(real-ppid) === false`. `npx tsc --noEmit` exit 0. `npm run gate` exit 0.
- **Verified-by:** round 2 — dispatch openai run 01a1ab41 (clean-room) — VERDICT: BROKEN (see round 3).

### 2026-11-05 — fix lane, round 3 (re-fix after 2nd BROKEN)
- **Understood:** verifier (openai run 01a1ab41) returned BROKEN: I checked path EXISTENCE,
  but deleting the cwd+data dir and RECREATING empty dirs at the same paths left `statSync(path)`
  succeeding while the process's real cwd was the original unlinked inode (`/proc/self/cwd` →
  "… (deleted)"). Same inode-identity issue `lanes.isWriter()` already solves for the data-dir lock.
- **Changed:** `src/server/harness-watchdog.ts` — `cwdDeleted()` (reads `/proc/self/cwd` for the
  "(deleted)" marker, the kernel's authority on the real cwd), `inodeOf()` + `dirGoneOrReplaced()`
  (inode-identity, not path existence); `startHarnessWatchdog` captures the cwd/data-dir inodes at
  boot and threads them into `worldGoneReason`.
- **Verified (fixer's own run):** `node scripts/verify-bug-290-orphan-reaper.mjs` → 29/29 PASS,
  incl. the exact round-2 attack: delete cwd+data dir then recreate empty dirs at the SAME paths →
  server still EXITS. `npx tsc --noEmit` exit 0. `npm run gate` exit 0.
- **Verified-by:** round 3 — dispatch openai run 01a1ab46-4eae-77e0-9174-20f4f2b114a1 (clean-room, mixed candidate 967930c06666) — VERDICT: **HOLDS**. The verifier independently exercised: data-dir-only deletion, cwd-only deletion, source gating + shared-dir refusal, and — strongest — a REAL hung session drain injected into the server's own `shutdown()`, confirming SIGTERM forces exit (~350ms) with the backstop armed first. Untested (verifier-noted): live shared-service runtime; the specific systemd-user-manager adopter identity.
- **Symptom of a deeper design flaw?** yes → "a spawned helper outlives an abnormally-killed launcher" is a general pattern (ARCH candidate: lifecycle ownership of spawned helpers). harness-watchdog is the scratch-server instance; not filing a separate ARCH now — noted for arch-watch.

### 2026-11-05 — dispatch openai
- **Verification recorded:** dispatch openai run 01a1ab3c-5e9e-7c43-917c-6fd8e08018cb — VERDICT: BROKEN — mixed-state candidate 6ae015c05c3f. Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-11-05 — dispatch openai
- **Verification recorded:** dispatch openai run 01a1ab41-ac1f-74d2-8ca5-8530e36308c4 — VERDICT: BROKEN — mixed-state candidate 7814343c5218. Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-11-05 — dispatch openai
- **Verification recorded:** dispatch openai run 01a1ab46-4eae-77e0-9174-20f4f2b114a1 — VERDICT: HOLDS — mixed-state candidate 967930c06666. Typed entry in verification-ledger.json; this line is an echo, not proof.
