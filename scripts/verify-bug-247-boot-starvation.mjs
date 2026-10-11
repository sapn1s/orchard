#!/usr/bin/env node
/**
 * BUG-247 — the boot runtime check must survive event-loop starvation at boot.
 *
 * On a cold reboot the synchronous half of server startup blocked the loop past
 * the async probe's 5 s `--version` deadline. When the loop resumed, the timers
 * phase ran before poll, so the expired deadline killed a child that had ALREADY
 * exited 0 (its `close` still queued) and latched bootState='failed' for the life
 * of the process ("runtime check failed: the bundled runtime did not run
 * `--version` at boot").
 *
 * Two rounds judged "loop starved vs child hung" by how late an in-loop timer
 * fired; each left a band (TWO-BREAK, WA §N):
 *   round 1 — SLACK on the deadline: a single 5.0-5.5 s block → BLOCK.
 *   round 2 — SLACK on a grace timer: a deadline-crossing block plus a 250-700 ms
 *             follow-on block in the same timers phase → BLOCK.
 * Round 3 removes the in-loop timer entirely: the probe is spawnSync with a
 * child-relative timeout (its own libuv loop, result read synchronously), so the
 * main loop's starvation cannot reach the verdict.
 *
 * Every case runs in a FRESH child process (the boot check runs once at module
 * load and latches).
 *
 *   1.  STARVE SWEEP — REAL module + REAL binary, one block after import,
 *       4900..12000 ms → admits. The sync probe completes during import, i.e.
 *       before the block, so 1/1a/1b are regression anchors for the observable;
 *       5d is the case where the probe itself runs after a block.
 *   1a. ROUND-1 BAND — 5000..5500 ms → admits.
 *   1b. ROUND-2 SHAPE — 5200 ms block + a 250/300/400/500/700 ms follow-on block
 *       driven from a timer due at the deadline → admits.
 *   1c. must-FAIL: synthesized ROUND-1 body (NOT read from HEAD) latches 'failed'
 *       in the round-1 band.
 *   1d. must-FAIL: synthesized ROUND-2 body latches 'failed' in the round-2 shape.
 *   2-5. slow (6 s), hung, exit-1, garbage stubs → fail closed in bounded time.
 *   5b. hung stub that IGNORES SIGTERM, and one whose grandchild holds stdout →
 *       still bounded at the timeout.
 *   5c. boundary: a healthy stub exiting 0 at ~4.5 s, starved 5200 ms → admits.
 *   5d. retry path: attempt 1 moves the binary's statKey, so the attempt-2 probe
 *       runs AFTER a 5200 ms starve → admits.
 *   5e. cold page cache: a copy of the REAL binary evicted with
 *       posix_fadvise(DONTNEED), starved 5200 ms → admits (importMs printed).
 *   6-7. repeated spread starvation (hung stub fails bounded; real binary admits).
 *   8.  ISOLATED scratch server (own CLAUDE_STATION_DATA, free port): GET
 *       /api/runtime shows host.runningCli populated, restartPending false,
 *       runtimeCheck.state 'ok'.
 *
 * Round 4 (the round-3 verifier's break: an OS freeze of the whole process past the
 * spawnSync timeout while the healthy child exits 0 → ETIMEDOUT → latched). A timeout
 * is now INCONCLUSIVE: refused per attempt, never latched, re-proved. Cases 2/3/5b/6
 * (slow/hung stubs) therefore expect "refused, retrying", not "latched failed".
 *   8b. scratch SERVER on a stub runtime that SIGSTOPs the server 7 s during its boot
 *       probe: /api/runtime reports 'inconclusive', then the post-listen retry → 'ok'.
 *   9.  SIGSTOP 7 s, module level: first probe inconclusive; a later admission (and,
 *       separately, the post-listen retry) re-proves and admits; the retry's
 *       BOOT_CLI_VERSION/BOOT_IDENTITY equal a first-try success's.
 *   9b. must-FAIL: synthesized ROUND-3 body latches on the same case and never heals.
 *   10. hung binary under repeated admission: always refused, bounded, never admits,
 *       admission calls stay sub-ms and the loop never freezes.
 *   11. exit-1 / garbage: 'failed' from boot, exactly one probe, never retried.
 *   12. throttle + single-flight: no probe inside the 10 s window; 100 concurrent
 *       admissions after it share ONE probe; none once ok.
 *
 * Round 5 (the round-4 verifier's break, property: identity invariant): after an
 * inconclusive boot the retry baselined the on-disk binary AT RETRY TIME, so a binary
 * swapped in place between load and retry (same SDK version) was admitted with
 * restartPending=false, where a successful boot refuses the same swap. The load-time
 * identity is now captured once by the boot sequence whatever the probe's outcome,
 * and a retry must prove exactly it (it fills in the version, never the baseline).
 *   13a. CONTROL: boot ok, then the binary is swapped → refused, restartPending.
 *   13b. ATTACK: boot inconclusive, then the binary is swapped, retry → refused,
 *        restartPending, the SAME block text as the control, BOOT_IDENTITY null.
 *   13c. must-FAIL: a synthesized ROUND-4 body (no load anchor) ADMITS that swap.
 *   13d. same binary after an inconclusive boot → admits, identity = the load hash.
 *   13e. swap BEFORE load: what was on disk at load is what gets admitted, on the
 *        inconclusive path exactly as on the success path (same identity).
 *   13f. swap then revert to the loaded bytes (fresh inode) during the inconclusive
 *        window → re-proved and admitted, as a successful boot re-admits a revert.
 *   13g. the binary is swapped DURING the boot probe (after its pre-spawn stat), on a
 *        probe that is cut short AND (control) on one that succeeds → round 6: both
 *        discard the probe of the file that is gone and prove the swapped-in file, so
 *        both admit 9.9.9 with the same identity (round 5 failed the cut-short arm
 *        closed — the r5 verifier's 'during' divergence).
 *   13h. SDK + platform package + binary all replaced (a full update) inside the
 *        inconclusive window → refused with the restart block, never admitted; rolled
 *        back to the loaded files → re-proved and admitted, as on the success path.
 *
 * Round 6 (the round-5 verifier's break, TWO-BREAK on the identity invariant): the retry
 * re-probed whatever was on disk and latched a definitive failure before comparing it to
 * LOAD_IDENTITY. Redesign: one attribution chokepoint — a probe result changes boot state
 * only if it is attributed (stat-bound across probe + hash) to LOAD_IDENTITY.
 *   14a. bad-swap CONTROL: boot ok, an exit-1 binary swapped in → restart block; rollback
 *        re-admits.
 *   14b. bad-swap ATTACK ×2: boot inconclusive, exit-1 swapped in, retries → never
 *        latched 'failed', same restart block; rollback → re-proved and admitted.
 *   14c. must-FAIL: a synthesized ROUND-5 retry (probe disk, latch, compare after) latches
 *        'failed' on the same case and the rollback never re-admits.
 *   14d. retry probe of the loaded file, then an exit-1 binary replaces it before POST
 *        → result discarded, not latched, restart block; rollback admits.
 *   14e. exit-1 binary replaces the loaded file between PRE and the spawn (so the bad
 *        file RUNS) → result discarded, not latched; rollback admits.
 *   14f. boot: good probe, then an exit-1 binary replaces it before the hash — success
 *        arm and cut-short arm both latch 'failed' on the swapped-in file (FEAT-151
 *        round 5: a non-running binary never becomes a baseline), BOOT_IDENTITY null.
 *   14g. boot: the binary is deleted during capture (success + cut-short arms) → both
 *        'failed' ("could not be read"), never admitted.
 *   14h. platform package.json disappears inside the inconclusive window → refused,
 *        never latched; restored → admitted. Control (boot ok) behaves the same.
 *
 * Round 7 (the r6 verifier's adversarial break, RESCOPED + CONTAINED by adjudication r7):
 * a NON-REGULAR file at the binary path (a FIFO renamed over it, or a symlink to a char
 * device like /dev/zero) made the old `hashFile` block or spin forever inside the hash
 * single-flight — a blocked open() cannot be cancelled and leaks a libuv pool thread, so
 * across retries the pool exhausts and every async fs/crypto op stalls (process.exit even
 * hung). Fix: `hashFile` opens O_RDONLY|O_NONBLOCK, fstats the fd, and hashes ONLY a
 * regular file (null otherwise → fail closed). A null identity must not admit and must not
 * wedge single-flight.
 *   15a. FIFO renamed over the binary: boot-inconclusive arm (and an OK-boot control) →
 *        the FIFO is never admitted, rollback to the loaded bytes re-admits, the recheck
 *        settles, and the child exits PROMPTLY (no leaked pool thread → no exit hang).
 *   15b. symlink to /dev/zero at the binary path → the hash returns null promptly (no
 *        spin), the device is never admitted, rollback re-admits, prompt exit.
 *   15c. must-FAIL: a synthesized pre-fix `hashFile` (createReadStream on the path, NOT
 *        read from HEAD) on the FIFO inconclusive arm → never re-admits and/or the child's
 *        exit hangs until the spawn timeout.
 *
 * Stubs live under a scratch root (copied src + a stub node_modules/@anthropic-ai
 * tree), so projectRoot() resolves the stub. The real tree is never touched.
 *
 * Run: node scripts/verify-bug-247-boot-starvation.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedServerEnv } from './lib/station-boot.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MODULE_REL = 'src/server/runtime/runtime-update.ts';
const SWEEP_MS = [4900, 5000, 5050, 5100, 5200, 5400, 5600, 7000, 12000];
const SWEEP_RUNS = 3;
const ROUND1_BAND_MS = [5000, 5100, 5200, 5300, 5400, 5500];
const ROUND2_FOLLOW_MS = [250, 300, 400, 500, 700];
const ROUND2_INITIAL_MS = 5200;

let pass = 0, fail = 0;
const check = (name, ok, observed) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`        observed: ${JSON.stringify(observed)}`);
};
const admitted = (r) => typeof r.cli === 'string' && r.block == null;
const latchedFailed = (r) => r.cli == null && /runtime check failed: the bundled runtime did not run/.test(r.block ?? '');
/** Round 4: a timeout is INCONCLUSIVE — refused (fail closed) with an honest reason, never latched. */
const refusedRetrying = (r) => r.cli == null && /^runtime check could not finish: `--version` timed out/.test(r.block ?? '')
  && (r.state == null || r.state === 'inconclusive');

/** Child A: import (timed), optionally starve the loop ONCE, await the boot check, report. */
const CHILD = `
const t0 = Date.now();
const rt = await import(process.env.BUG247_MODULE);
const importMs = Date.now() - t0;
const starve = Number(process.env.BUG247_STARVE_MS || 0);
const end = Date.now() + starve; while (Date.now() < end) { /* starve the loop */ }
await rt.whenRuntimeChecked();
console.log(JSON.stringify({ ms: Date.now() - t0, importMs, cli: rt.BOOT_CLI_VERSION, state: rt.runtimeCheckState?.().state, block: rt.hostSessionBlockReason() }));
`;

/** Child B: starvation SPREAD across repeated windows (block/yield/block/...). */
const CHILD_REPEAT = `
const t0 = Date.now();
const rt = await import(process.env.BUG247_MODULE);
const blockMs = Number(process.env.BUG247_BLOCK_MS || 2000);
const windows = Number(process.env.BUG247_WINDOWS || 6);
for (let w = 0; w < windows; w++) {
  const end = Date.now() + blockMs; while (Date.now() < end) { /* starve */ }
  await new Promise((r) => setTimeout(r, 20)); // let the loop breathe between windows
}
await rt.whenRuntimeChecked();
console.log(JSON.stringify({ ms: Date.now() - t0, cli: rt.BOOT_CLI_VERSION, state: rt.runtimeCheckState?.().state, block: rt.hostSessionBlockReason() }));
`;

/**
 * Child C: the ROUND-2 break shape (the r2 verifier's reproduction). A follow-on
 * busy-block is driven from a timer due at the 5 s deadline; the initial block
 * (5200 ms) keeps the loop busy past it, so on resume the deadline-side timer and
 * this follow timer run in the SAME timers phase, before poll can drain a queued close.
 */
const CHILD_FOLLOW = `
const t0 = Date.now();
const rt = await import(process.env.BUG247_MODULE);
const follow = Number(process.env.BUG247_FOLLOW_MS);
setTimeout(() => { const e = Date.now() + follow; while (Date.now() < e) {} }, 5000);
const e = Date.now() + Number(process.env.BUG247_INITIAL_MS); while (Date.now() < e) {}
await rt.whenRuntimeChecked();
console.log(JSON.stringify({ ms: Date.now() - t0, follow, cli: rt.BOOT_CLI_VERSION, block: rt.hostSessionBlockReason() }));
`;

/* ------------------------------------------------ round 4: retryable timeouts */

/**
 * A healthy stub that, on its FIRST run only, freezes its parent (the node process,
 * mid-probe) with SIGSTOP for $BUG247_STOP s via a detached waker, then exits 0 with
 * a valid version while the parent is still stopped — the round-3 verifier's
 * repro (~/.local/state/claude-station/scratch/bug247-verify-FRz7NS/repro-sigstop.mjs),
 * made once-only so a retry sees the same healthy binary unfrozen. Every run appends
 * a line to `$0.count`, so a case can count probes.
 */
const SIGSTOP_ONCE_STUB = `#!/bin/sh
echo x >> "$0.count"
if [ ! -e "$0.stopped" ]; then
  : > "$0.stopped"
  P=$PPID
  sleep 0.3
  setsid sh -c "sleep \${BUG247_STOP:-7}; kill -CONT $P" >/dev/null 2>&1 < /dev/null &
  kill -STOP $P
fi
echo "2.1.0 (Claude Code)"
exit 0
`;
/** Hangs every time (counted). */
const HANG_COUNTED_STUB = '#!/bin/sh\necho x >> "$0.count"\nexec sleep 60\n';
/** Hangs on the first run only, then a healthy 1 s probe (counted). */
const HANG_ONCE_STUB = '#!/bin/sh\necho x >> "$0.count"\nif [ ! -e "$0.hung" ]; then : > "$0.hung"; exec sleep 60; fi\nsleep 1\necho "2.1.0 (Claude Code)"\nexit 0\n';

const stubBin = (root) => path.join(root, 'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude');
const probeCount = (root) => { try { return fs.readFileSync(`${stubBin(root)}.count`, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };

/**
 * Child D: boot, then heal. mode=admission: call the admission guard every 250 ms
 * (as a user clicking would) until it admits. mode=listen: call the post-listen
 * retry once and only READ the state (no admission calls after the first).
 */
const CHILD_HEAL = `
const t0 = Date.now();
const rt = await import(process.env.BUG247_MODULE);
await rt.whenRuntimeChecked();
const blk = rt.hostSessionBlock();
const first = { ms: Date.now() - t0, state: rt.runtimeCheckState?.().state, cli: rt.BOOT_CLI_VERSION, block: blk?.reason ?? null, transient: blk?.transient ?? null };
const mode = process.env.BUG247_HEAL;
if (mode === 'listen') rt.scheduleRuntimeRecheck(Number(process.env.BUG247_DELAY || 500));
let attempts = 0, healedMs = null;
const until = Date.now() + Number(process.env.BUG247_WINDOW || 40000);
while (Date.now() < until) {
  await new Promise((r) => setTimeout(r, 250));
  if (mode === 'admission') { attempts++; if (rt.hostSessionBlockReason() == null) { healedMs = Date.now() - t0; break; } }
  else if (rt.runtimeCheckState?.().state === 'ok') { healedMs = Date.now() - t0; break; }
}
console.log(JSON.stringify({ first, healedMs, attempts, state: rt.runtimeCheckState?.().state, cli: rt.BOOT_CLI_VERSION, identity: rt.BOOT_IDENTITY, block: rt.hostSessionBlockReason() }));
`;

/** Child E: hammer the admission guard every 100 ms for a window; measure each call and the loop. */
const CHILD_HAMMER = `
const t0 = Date.now();
const rt = await import(process.env.BUG247_MODULE);
await rt.whenRuntimeChecked();
const bootMs = Date.now() - t0;
if (process.env.BUG247_SCHEDULE) rt.scheduleRuntimeRecheck(100);
let calls = 0, admitted = 0, maxCallMs = 0, maxGapMs = 0, last = Date.now();
const reasons = new Set(); const states = new Set();
const until = Date.now() + Number(process.env.BUG247_WINDOW || 35000);
while (Date.now() < until) {
  await new Promise((r) => setTimeout(r, 100));
  const now = Date.now(); maxGapMs = Math.max(maxGapMs, now - last - 100); last = now;
  const c0 = performance.now(); const reason = rt.hostSessionBlockReason(); maxCallMs = Math.max(maxCallMs, performance.now() - c0);
  calls++; if (reason == null) admitted++; else reasons.add(reason.split(':')[0]);
  states.add(rt.runtimeCheckState().state);
}
await rt.whenRuntimeRechecked();
console.log(JSON.stringify({ bootMs, calls, admitted, maxCallMs: Math.round(maxCallMs * 100) / 100, maxGapMs, reasons: [...reasons], states: [...states], finalState: rt.runtimeCheckState().state, cli: rt.BOOT_CLI_VERSION }));
`;

/** Child F: throttle + single-flight. */
const CHILD_FLIGHT = `
const t0 = Date.now();
const rt = await import(process.env.BUG247_MODULE);
const nodeFs = await import('node:fs');
const count = () => { try { return (nodeFs.readFileSync(process.env.BUG247_COUNT, 'utf8').match(/x/g) || []).length; } catch { return 0; } };
await rt.whenRuntimeChecked();
const boot = { ms: Date.now() - t0, state: rt.runtimeCheckState().state, probes: count() };
// (a) inside the 10 s throttle window: a burst of admissions spawns nothing.
for (let i = 0; i < 100; i++) rt.hostSessionBlockReason();
await new Promise((r) => setTimeout(r, 300));
const throttled = { probes: count(), state: rt.runtimeCheckState().state };
// (b) after the window: 100 concurrent admissions (sync burst + microtask burst) share ONE probe.
await new Promise((r) => setTimeout(r, 10_200));
const refusedDuring = [];
for (let i = 0; i < 50; i++) refusedDuring.push(rt.hostSessionBlockReason() != null);
await Promise.all(Array.from({ length: 50 }, () => Promise.resolve().then(() => refusedDuring.push(rt.hostSessionBlockReason() != null))));
await rt.whenRuntimeRechecked();
const after = { probes: count(), state: rt.runtimeCheckState().state, block: rt.hostSessionBlockReason(), cli: rt.BOOT_CLI_VERSION };
// (c) once ok, admissions never probe again.
for (let i = 0; i < 100; i++) rt.hostSessionBlockReason();
await new Promise((r) => setTimeout(r, 300));
console.log(JSON.stringify({ boot, throttled, refusedDuringAll: refusedDuring.every(Boolean), refusedDuringN: refusedDuring.length, after, finalProbes: count() }));
`;

/* ------------------------------------------- round 5: load-time identity anchor */

/** A DIFFERENT healthy binary (not the one present at load), same SDK/platform version. */
const SWAPPED_STUB = '#!/bin/sh\n# a DIFFERENT binary, not the one present at load\necho x >> "$0.count"\necho "9.9.9 (Claude Code)"\nexit 0\n';
/** Hangs on its first run only (so the boot proof is cut short), then healthy, no delay. */
const HANG_ONCE_FAST_STUB = '#!/bin/sh\necho x >> "$0.count"\nif [ ! -e "$0.hung" ]; then : > "$0.hung"; exec sleep 60; fi\necho "2.1.0 (Claude Code)"\nexit 0\n';
/** Like HANG_ONCE_FAST_STUB, but a DIFFERENT binary (9.9.9) — for "swap before load". */
const HANG_ONCE_SWAPPED_STUB = '#!/bin/sh\n# swapped before load\necho x >> "$0.count"\nif [ ! -e "$0.hung" ]; then : > "$0.hung"; exec sleep 60; fi\necho "9.9.9 (Claude Code)"\nexit 0\n';
/** On its FIRST run, renames a different binary over itself (a swap DURING the boot probe), then hangs. */
/** exit-1 binary (present + executable, does not run). */
const BAD_STUB = '#!/bin/sh\necho x >> "$0.count"\nexit 1\n';
/** Like SWAP_DURING_PROBE_STUB but its first probe SUCCEEDS (the success-path control for 13g). */
const SWAP_DURING_OK_STUB = '#!/bin/sh\necho x >> "$0.count"\nif [ ! -e "$0.hung" ]; then : > "$0.hung"; printf \'#!/bin/sh\\necho "9.9.9 (Claude Code)"\\nexit 0\\n\' > "$0.new"; chmod 755 "$0.new"; mv "$0.new" "$0"; fi\necho "2.1.0 (Claude Code)"\nexit 0\n';
/** Boot-probe stubs whose FIRST run replaces the file (with an exit-1 binary, or deletes it), then either succeeds or hangs. */
const bootReplaceStub = (action, hang) => `#!/bin/sh\nif [ ! -e "$0.first" ]; then : > "$0.first"; ${action === 'bad' ? `printf '#!/bin/sh\\nexit 1\\n' > "$0.new"; chmod 755 "$0.new"; mv "$0.new" "$0"` : 'rm -f "$0"'}; ${hang ? 'exec sleep 60' : 'echo "2.1.0 (Claude Code)"; exit 0'}; fi\necho "2.1.0 (Claude Code)"\nexit 0\n`;
/** Hangs on its first run (cut-short boot); on its SECOND run (the retry) replaces itself with an exit-1 binary, then either finishes healthy (post) or execs the bad file (pre-spawn). */
const retryReplaceStub = (variant) => `#!/bin/sh\necho x >> "$0.count"\nif [ ! -e "$0.hung" ]; then : > "$0.hung"; exec sleep 60; fi\nif [ ! -e "$0.swapped" ]; then : > "$0.swapped"; printf '#!/bin/sh\\nexit 1\\n' > "$0.new"; chmod 755 "$0.new"; mv "$0.new" "$0"; ${variant === 'pre-spawn' ? 'exec "$0"' : ':'}; fi\necho "2.1.0 (Claude Code)"\nexit 0\n`;
const SWAP_DURING_PROBE_STUB = '#!/bin/sh\necho x >> "$0.count"\nif [ ! -e "$0.hung" ]; then : > "$0.hung"; printf \'#!/bin/sh\\necho "9.9.9 (Claude Code)"\\nexit 0\\n\' > "$0.new"; chmod 755 "$0.new"; mv "$0.new" "$0"; exec sleep 60; fi\necho "2.1.0 (Claude Code)"\nexit 0\n';

/**
 * Child G: hash the binary as it is at load, import, await the boot check, then
 * (BUG247_SWAP=1) rename a different binary over it as npm does, optionally
 * (BUG247_REVERT=1) rename the ORIGINAL bytes back once a retry has seen the swap,
 * schedule the post-listen retry, and poll the admission guard until it admits or
 * the window ends. Reports everything the identity invariant is judged on.
 */
const CHILD_SWAP = `
const fs = await import('node:fs');
const crypto = await import('node:crypto');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const bin = process.env.BUG247_BIN;
const original = fs.readFileSync(bin);
const loadHash = sha(bin);
const rt = await import(process.env.BUG247_MODULE);
await rt.whenRuntimeChecked();
const boot = { state: rt.runtimeCheckState().state, cli: rt.BOOT_CLI_VERSION };
const renameOver = (bytes) => { const tmp = bin + '.new'; fs.writeFileSync(tmp, bytes, { mode: 0o755 }); fs.renameSync(tmp, bin); };
if (process.env.BUG247_SWAP === '1') renameOver(process.env.BUG247_SWAPPED);
rt.scheduleRuntimeRecheck(100);
let sawSwapBlock = null;
const until = Date.now() + Number(process.env.BUG247_WINDOW || 8000);
let reverted = false;
while (Date.now() < until) {
  await new Promise((r) => setTimeout(r, 250));
  await rt.whenRuntimeRechecked();
  const b = rt.hostSessionBlock();
  if (b == null) break;
  if (process.env.BUG247_REVERT === '1' && !reverted && !b.transient) { sawSwapBlock = b; renameOver(original); reverted = true; }
}
await rt.whenRuntimeSettled();
const b = rt.hostSessionBlock();
console.log(JSON.stringify({ boot, final: rt.runtimeCheckState(), cli: rt.BOOT_CLI_VERSION, admitted: b == null, block: b?.reason ?? null, transient: b?.transient ?? null,
  restartPending: rt.isRuntimeUpdatePending(), bootIdentity: rt.BOOT_IDENTITY, loadHash, diskHash: sha(bin), sawSwapBlock }));
`;

/** Child I: delete the platform package.json after boot, retry, then restore it and poll until admitted. */
const CHILD_META = `
const fs = await import('node:fs');
const p = process.env.BUG247_PLATPKG; const orig = fs.readFileSync(p);
const rt = await import(process.env.BUG247_MODULE);
await rt.whenRuntimeChecked();
const boot = rt.runtimeCheckState().state;
fs.rmSync(p);
rt.scheduleRuntimeRecheck(50);
await new Promise((r) => setTimeout(r, 400)); await rt.whenRuntimeRechecked(); await rt.whenRuntimeSettled();
const gb = rt.hostSessionBlock();
const gone = { state: rt.runtimeCheckState().state, block: gb?.reason ?? null, transient: gb?.transient ?? null };
fs.writeFileSync(p + '.n', orig); fs.renameSync(p + '.n', p);
let healedMs = null; const t1 = Date.now();
while (Date.now() - t1 < 25000) { await new Promise((r) => setTimeout(r, 250)); await rt.whenRuntimeRechecked(); if (rt.hostSessionBlock() == null) { healedMs = Date.now() - t1; break; } }
console.log(JSON.stringify({ boot, gone, healedMs, final: rt.runtimeCheckState().state, cli: rt.BOOT_CLI_VERSION }));
`;

/** Child H: inconclusive boot, then a full update (SDK + platform package + binary) lands, then it is rolled back. */
const CHILD_UPDATE = `
const fs = await import('node:fs'); const path = await import('node:path');
const sdk = process.env.BUG247_SDK, plat = process.env.BUG247_PLAT, bin = path.join(plat, 'claude');
const orig = { s: fs.readFileSync(path.join(sdk, 'package.json')), p: fs.readFileSync(path.join(plat, 'package.json')), b: fs.readFileSync(bin) };
const put = (f, d, m) => { fs.writeFileSync(f + '.n', d, m ? { mode: m } : undefined); fs.renameSync(f + '.n', f); };
const rt = await import(process.env.BUG247_MODULE);
await rt.whenRuntimeChecked();
const boot = rt.runtimeCheckState().state;
put(path.join(sdk, 'package.json'), JSON.stringify({ version: '0.0.2' }));
put(path.join(plat, 'package.json'), JSON.stringify({ version: '0.0.2' }));
put(bin, '#!/bin/sh\\necho "2.2.0 (Claude Code)"\\nexit 0\\n', 0o755);
rt.scheduleRuntimeRecheck(50);
let everAdmitted = false;
for (let i = 0; i < 16; i++) { await new Promise((r) => setTimeout(r, 250)); await rt.whenRuntimeRechecked(); if (rt.hostSessionBlock() == null) everAdmitted = true; }
const upd = rt.hostSessionBlock();
const afterUpdate = { state: rt.runtimeCheckState().state, cli: rt.BOOT_CLI_VERSION, block: upd?.reason ?? null, transient: upd?.transient ?? null, restartPending: rt.isRuntimeUpdatePending() };
put(path.join(sdk, 'package.json'), orig.s); put(path.join(plat, 'package.json'), orig.p); put(bin, orig.b, 0o755);
let healedMs = null; const t1 = Date.now();
while (Date.now() - t1 < 25000) { await new Promise((r) => setTimeout(r, 250)); await rt.whenRuntimeRechecked(); if (rt.hostSessionBlock() == null) { healedMs = Date.now() - t1; break; } }
console.log(JSON.stringify({ boot, everAdmitted, afterUpdate, healedMs, final: rt.runtimeCheckState().state, cli: rt.BOOT_CLI_VERSION, restartPending: rt.isRuntimeUpdatePending() }));
`;

/**
 * The ROUND-4 identity semantics, synthesized from the current source (NOT read from
 * HEAD or a backup): no load-time anchor — a retry's proof becomes the baseline, and
 * admission never compares disk to the load-time identity while unproven. Throws if
 * an anchor is missing, so a rename cannot turn the must-FAIL case into a no-op.
 */
const RETRY_CALL = 'const o = await proveLoadedAgain();\n      if (o) applyProof(o);';
function withRound4Identity(src) {
  const edits = [
    [RETRY_CALL, "const o = await proveRuntime(probeVersionAsync, 'when re-checked');\n      if (o.kind !== 'failed') LOAD_IDENTITY = o.identity;\n      applyProof(o);"],
    ['BOOT_IDENTITY = LOAD_IDENTITY;', 'BOOT_IDENTITY = o.identity;'],
    ['    if (LOAD_IDENTITY) {\n      const swapped = diskVsBaseline(LOAD_IDENTITY);', '    if (false) {\n      const swapped = diskVsBaseline(LOAD_IDENTITY!);'],
  ];
  let out = src;
  for (const [from, to] of edits) {
    if (out.split(from).length !== 2) throw new Error(`round-4 synthesis anchor not found exactly once: ${from.slice(0, 60)}`);
    out = out.replace(from, to);
  }
  return out;
}

/**
 * The ROUND-5 retry, synthesized from the current source (NOT read from HEAD or a
 * backup): the retry re-proves WHATEVER is on disk with the boot proof, latches a
 * definitive failure, and only compares an ok result to LOAD_IDENTITY afterwards.
 * Throws if the anchor is missing.
 */
function withRound5Retry(src) {
  if (src.split(RETRY_CALL).length !== 2) throw new Error('round-5 synthesis anchor (retry call) not found exactly once');
  return src.replace(RETRY_CALL, "const o = await proveRuntime(probeVersionAsync, 'when re-checked');\n      if (o.kind === 'ok' && !sameIdentity(o.identity, LOAD_IDENTITY!)) { inconclusiveReason = 'not the loaded binary'; } else applyProof(o);");
}

function runChild(modulePath, env, src = CHILD) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], {
    env: { ...process.env, BUG247_MODULE: pathToFileURL(modulePath).href, ...env },
    encoding: 'utf8',
    timeout: 90_000,
  });
  const line = (r.stdout || '').trim().split('\n').filter(Boolean).at(-1);
  try { return JSON.parse(line); }
  catch { return { error: `child produced no result (status=${r.status} signal=${r.signal})`, stderr: (r.stderr || '').slice(-400) }; }
}

/**
 * The ROUND-1 probe, synthesized (NOT read from HEAD): a verdict straight from the
 * deadline fire, re-arming only when the deadline fired `late > SLACK_MS`.
 */
const ROUND1_PROBE = `function legacyProbe(bin: string, timeoutMs = 5_000): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | null) => { if (!done) { done = true; resolve(v); } };
    const SLACK_MS = 500;
    const MAX_REARMS = 5;
    try {
      const c = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let rearms = 0;
      let expected = Date.now() + timeoutMs;
      let to: ReturnType<typeof setTimeout>;
      const onTimeout = () => {
        const late = Date.now() - expected;
        if (late > SLACK_MS && rearms < MAX_REARMS) {
          rearms++;
          expected = Date.now() + timeoutMs;
          to = setTimeout(onTimeout, timeoutMs);
          return;
        }
        try { c.kill('SIGKILL'); } catch { /* */ }
        finish(null);
      };
      to = setTimeout(onTimeout, timeoutMs);
      c.stdout.on('data', (d) => { out += String(d); });
      c.stderr.on('data', (d) => { out += String(d); });
      c.on('error', () => { clearTimeout(to); finish(null); });
      c.on('close', (code) => {
        clearTimeout(to);
        const m = out.match(/(\\d+\\.\\d+\\.\\d+[-.\\w]*)/);
        finish(code === 0 && m ? m[1]! : null);
      });
    } catch {
      finish(null);
    }
  });
}
`;

/**
 * The ROUND-2 probe, synthesized (NOT read from HEAD): never decides from the
 * deadline, opens a GRACE window, and decides from the grace timer's lateness.
 */
const ROUND2_PROBE = `function legacyProbe(bin: string, timeoutMs = 5_000): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | null) => { if (!done) { done = true; resolve(v); } };
    const GRACE_MS = 250;
    const SLACK_MS = 500;
    const MAX_REARMS = 5;
    const HARD_CAP_MS = 4 * timeoutMs;
    try {
      const c = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      const startedAt = Date.now();
      let rearms = 0;
      let expectedGrace = 0;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const killAndFail = () => { try { c.kill('SIGKILL'); } catch { /* */ } finish(null); };
      const armGrace = () => { expectedGrace = Date.now() + GRACE_MS; graceTimer = setTimeout(onGrace, GRACE_MS); };
      function onGrace(): void {
        if (done) return;
        const late = Date.now() - expectedGrace;
        if (late <= SLACK_MS) { killAndFail(); return; }
        if (rearms < MAX_REARMS && Date.now() - startedAt < HARD_CAP_MS) { rearms++; armGrace(); return; }
        killAndFail();
      }
      const onDeadline = () => { if (!done) armGrace(); };
      const deadline = setTimeout(onDeadline, timeoutMs);
      const clearAll = () => { clearTimeout(deadline); if (graceTimer) clearTimeout(graceTimer); };
      c.stdout.on('data', (d) => { out += String(d); });
      c.stderr.on('data', (d) => { out += String(d); });
      c.on('error', () => { clearAll(); finish(null); });
      c.on('close', (code) => {
        clearAll();
        const m = out.match(/(\\d+\\.\\d+\\.\\d+[-.\\w]*)/);
        finish(code === 0 && m ? m[1]! : null);
      });
    } catch {
      finish(null);
    }
  });
}
`;

/**
 * A SYNTHESIZED pre-fix module: replace the round-4 classified probe with a legacy
 * body that returns `string | null`, adapted so `null` means a definitive failure —
 * exactly the pre-round-4 semantics, where any null (a timeout included) latched
 * 'failed'. `body` declares `function legacyProbe(...)`; async bodies are awaited by
 * proveRuntime's `await probe(bin)`. Throws loudly if an anchor is missing, so a
 * rename cannot silently turn the must-FAIL cases into no-ops.
 */
function withLegacyProbe(src, body) {
  const start = src.indexOf('function probeVersionSync(');
  if (start < 0) throw new Error('probeVersionSync not found in runtime-update.ts');
  const end = src.indexOf('\n}\n', start);
  if (end < 0) throw new Error('end of probeVersionSync not found');
  const call = "proveRuntime(probeVersionSync, 'at boot')";
  if (src.split(call).length !== 2) throw new Error('boot call site of probeVersionSync not found exactly once');
  const adapter = `${body.trimEnd()}
async function probeVersionSync(bin: string): Promise<ProbeOutcome> {
  const v = await legacyProbe(bin);
  return v ? { kind: 'ok', version: v } : { kind: 'failed', reason: 'legacy probe returned null' };
}`;
  return src.slice(0, start) + adapter + src.slice(end + 2);
}

/** The ROUND-3 probe, synthesized (NOT read from HEAD): spawnSync, null on any error. */
const ROUND3_PROBE = `function legacyProbe(bin: string, timeoutMs = 5_000): string | null {
  try {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
    const m = (String(r.stdout ?? '') + String(r.stderr ?? '')).match(/(\\d+\\.\\d+\\.\\d+[-.\\w]*)/);
    return !r.error && r.status === 0 && m ? m[1]! : null;
  } catch {
    return null;
  }
}
`;

/**
 * The ROUND-6 `hashFile`, synthesized from the current source (NOT read from HEAD or a
 * backup): the pre-fix body that streams straight from the PATH with no non-blocking open
 * + fstat regular-file guard, so a FIFO blocks (and leaks a libuv pool thread) and a char
 * device spins. Guarded on the FIX anchor, so a rename that drops the fix can never turn
 * the must-FAIL (15c) into a silent no-op.
 */
function withLegacyHashFile(src) {
  if (!src.includes('fs.constants.O_RDONLY | fs.constants.O_NONBLOCK')) {
    throw new Error('legacy-hashFile synthesis anchor (O_NONBLOCK open) not found — refusing a no-op must-FAIL');
  }
  const start = src.indexOf('function hashFile(p: string): Promise<string | null> {');
  if (start < 0) throw new Error('hashFile not found in runtime-update.ts');
  const end = src.indexOf('\n}\n', start);
  if (end < 0) throw new Error('end of hashFile not found');
  const legacy = `function hashFile(p: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const h = createHash('sha256');
      const s = fs.createReadStream(p);
      s.on('error', () => resolve(null));
      s.on('data', (d) => h.update(d as Buffer));
      s.on('end', () => resolve(h.digest('hex')));
    } catch {
      resolve(null);
    }
  });
}`;
  return src.slice(0, start) + legacy + src.slice(end + 2);
}

/**
 * Child G (round 7): after the boot check, rename a NON-REGULAR node over the binary (a
 * FIFO, or a symlink to /dev/zero), observe admission across a short window, roll the
 * loaded bytes back (fresh inode, as npm does), then wait for re-admission. Finally
 * print and process.exit(0) — a LEAKED libuv pool thread (a blocked open) hangs the exit,
 * which the parent catches as an elapsed ~= spawn timeout.
 */
const CHILD_NODE = `
const fs = await import('node:fs');
const cp = await import('node:child_process');
const bin = process.env.BUG247_BIN;
const kind = process.env.BUG247_NODE_KIND; // 'fifo' | 'devzero'
const original = fs.readFileSync(bin);
const rt = await import(process.env.BUG247_MODULE);
await rt.whenRuntimeChecked();
const boot = rt.runtimeCheckState().state;
if (kind === 'fifo') {
  const fifo = bin + '.fifo';
  cp.execFileSync('mkfifo', ['-m', '755', fifo]);
  fs.renameSync(fifo, bin);
} else {
  fs.rmSync(bin);
  fs.symlinkSync('/dev/zero', bin);
}
rt.scheduleRuntimeRecheck(50);
const during = [];
for (let i = 0; i < 6; i++) { await new Promise((r) => setTimeout(r, 250)); const b = rt.hostSessionBlock(); during.push(b ? (b.transient ? 'T' : 'P') : 'ADMITTED'); }
// rollback to the loaded bytes (fresh inode, as npm does)
fs.writeFileSync(bin + '.n', original, { mode: 0o755 }); fs.renameSync(bin + '.n', bin);
let healedMs = null; const t1 = Date.now(); let last = null;
while (Date.now() - t1 < 20000) {
  await new Promise((r) => setTimeout(r, 250));
  const b = rt.hostSessionBlock(); last = b;
  if (b == null) { healedMs = Date.now() - t1; break; }
}
const recheckSettled = await Promise.race([rt.whenRuntimeRechecked().then(() => true), new Promise((r) => setTimeout(() => r(false), 2000))]);
console.log(JSON.stringify({ boot, during: [...new Set(during)], healedMs, final: rt.runtimeCheckState().state, cli: rt.BOOT_CLI_VERSION, recheckSettled, lastBlock: last?.reason ?? null }));
process.exit(0);
`;

/**
 * A scratch root: the module + its one import copied under <root>/src, and a
 * node_modules/@anthropic-ai tree that is either a symlink to the real one or a
 * stub SDK + platform package whose `claude` is the given shell script.
 */
function mkRoot(label, { moduleSrc, stubScript, binCopy = false }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `bug247-${label}-`));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(root, 'package.json'));
  fs.mkdirSync(path.join(root, 'src/lib'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'src/lib/paths.ts'), path.join(root, 'src/lib/paths.ts'));
  fs.mkdirSync(path.join(root, 'src/server/runtime'), { recursive: true });
  fs.writeFileSync(path.join(root, MODULE_REL), moduleSrc);
  if (binCopy) {
    const scope = path.join(root, 'node_modules/@anthropic-ai');
    const realScope = path.join(ROOT, 'node_modules/@anthropic-ai');
    fs.mkdirSync(path.join(scope, 'claude-agent-sdk'), { recursive: true });
    fs.copyFileSync(path.join(realScope, 'claude-agent-sdk/package.json'), path.join(scope, 'claude-agent-sdk/package.json'));
    const plat = path.join(scope, 'claude-agent-sdk-linux-x64');
    fs.mkdirSync(plat, { recursive: true });
    fs.copyFileSync(path.join(realScope, 'claude-agent-sdk-linux-x64/package.json'), path.join(plat, 'package.json'));
    fs.copyFileSync(path.join(realScope, 'claude-agent-sdk-linux-x64/claude'), path.join(plat, 'claude'));
    fs.chmodSync(path.join(plat, 'claude'), 0o755);
  } else if (stubScript == null) {
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'));
  } else {
    const scope = path.join(root, 'node_modules/@anthropic-ai');
    fs.mkdirSync(path.join(scope, 'claude-agent-sdk'), { recursive: true });
    fs.writeFileSync(path.join(scope, 'claude-agent-sdk/package.json'), JSON.stringify({ version: '0.0.1' }));
    const plat = path.join(scope, 'claude-agent-sdk-linux-x64');
    fs.mkdirSync(plat, { recursive: true });
    fs.writeFileSync(path.join(plat, 'package.json'), JSON.stringify({ version: '0.0.1' }));
    fs.writeFileSync(path.join(plat, 'claude'), stubScript, { mode: 0o755 });
  }
  return root;
}

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

/** Boot an ISOLATED scratch server (own data dir, free port) and read GET /api/runtime. */
async function scratchServerRuntime() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'bug247-srv-data-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'bug247-srv-proj-'));
  const port = await freePort();
  const env = isolatedServerEnv(
    { PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: data, CLAUDE_PROJECTS_DIR: proj },
    { requireStore: true },
  );
  const t0 = Date.now();
  const child = spawn(process.execPath, [path.join(ROOT, 'src/server/index.ts')], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    let healthyAt = null;
    while (Date.now() - t0 < 60_000) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) { healthyAt = Date.now() - t0; break; } } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (healthyAt == null) return { error: 'scratch server never became healthy', port };
    // The boot check is async (the hash streams); poll until it settles.
    let host = null;
    for (let i = 0; i < 50; i++) {
      const j = await (await fetch(`http://127.0.0.1:${port}/api/runtime`)).json();
      host = j.host;
      if (host?.runningCli != null || host?.restartPending === false) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    return { port, pid: child.pid, healthyAt, runningCli: host?.runningCli ?? null, installedCli: host?.installedCli ?? null, restartPending: host?.restartPending, runtimeCheck: host?.runtimeCheck };
  } finally {
    try { child.kill('SIGKILL'); } catch { /* */ }
    for (const d of [data, proj]) fs.rmSync(d, { recursive: true, force: true });
  }
}

/**
 * A scratch SERVER tree whose bundled runtime is a stub: src/ is COPIED (projectRoot()
 * is derived from src/lib/paths.ts's own location, and ESM resolves symlinks to their
 * real path), every other top-level entry and every node_modules package is a symlink
 * to the real one, except the platform package, which is a real dir holding the real
 * package.json (so its version still matches the SDK's) and the stub `claude`.
 */
function mkServerRoot(label, stubScript) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `bug247-${label}-`));
  for (const name of fs.readdirSync(ROOT)) {
    if (name === 'src' || name === 'node_modules' || name === '.git') continue;
    fs.symlinkSync(path.join(ROOT, name), path.join(root, name));
  }
  fs.cpSync(path.join(ROOT, 'src'), path.join(root, 'src'), { recursive: true });
  const nm = path.join(root, 'node_modules');
  fs.mkdirSync(nm);
  for (const name of fs.readdirSync(path.join(ROOT, 'node_modules'))) {
    if (name === '@anthropic-ai') continue;
    fs.symlinkSync(path.join(ROOT, 'node_modules', name), path.join(nm, name));
  }
  const scope = path.join(nm, '@anthropic-ai');
  fs.mkdirSync(scope);
  for (const name of fs.readdirSync(path.join(ROOT, 'node_modules/@anthropic-ai'))) {
    if (name === 'claude-agent-sdk-linux-x64') continue;
    fs.symlinkSync(path.join(ROOT, 'node_modules/@anthropic-ai', name), path.join(scope, name));
  }
  const plat = path.join(scope, 'claude-agent-sdk-linux-x64');
  fs.mkdirSync(plat);
  fs.copyFileSync(path.join(ROOT, 'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/package.json'), path.join(plat, 'package.json'));
  fs.writeFileSync(path.join(plat, 'claude'), stubScript, { mode: 0o755 });
  return root;
}

/**
 * Boot an ISOLATED scratch server from a stub-runtime tree (the stub freezes the
 * server process for 7 s during its boot probe, once) and sample GET /api/runtime
 * every 250 ms after it is healthy. Does NOT call any admission path, so a heal can
 * only come from the post-listen retry.
 */
async function scratchServerStubRuntime(root) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'bug247-srv4-data-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'bug247-srv4-proj-'));
  const port = await freePort();
  const env = isolatedServerEnv(
    { PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: data, CLAUDE_PROJECTS_DIR: proj, BUG247_STOP: '7' },
    { requireStore: true },
  );
  const t0 = Date.now();
  const child = spawn(process.execPath, [path.join(root, 'src/server/index.ts')], { cwd: root, env, stdio: ['ignore', 'ignore', 'ignore'] });
  const samples = [];
  try {
    let healthyAt = null;
    while (Date.now() - t0 < 60_000) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) { healthyAt = Date.now() - t0; break; } } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (healthyAt == null) return { error: 'scratch server never became healthy', port };
    while (Date.now() - t0 < healthyAt + 20_000) {
      const j = await (await fetch(`http://127.0.0.1:${port}/api/runtime`)).json();
      const h = j.host ?? {};
      const smp = { at: Date.now() - t0, state: h.runtimeCheck?.state, reason: h.runtimeCheck?.reason ?? null, runningCli: h.runningCli, restartPending: h.restartPending };
      if (!samples.length || samples.at(-1).state !== smp.state) samples.push(smp);
      if (smp.state === 'ok') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    return { port, pid: child.pid, healthyAt, samples };
  } finally {
    try { child.kill('SIGKILL'); } catch { /* */ }
    for (const d of [data, proj]) fs.rmSync(d, { recursive: true, force: true });
  }
}

const realSrc = fs.readFileSync(path.join(ROOT, MODULE_REL), 'utf8');
const roots = [];

console.log('BUG-247 — boot runtime check under event-loop starvation\n');
try {
  console.log(`1. STARVE SWEEP — REAL module + REAL binary, ${SWEEP_RUNS} fresh processes each`);
  console.log('   (the sync probe finishes during import, before the starve: these are regression anchors;');
  console.log('    5d is the case where the probe runs after a starve.)');
  console.log(`   spans (ms): ${SWEEP_MS.join(', ')}`);
  for (const starve of SWEEP_MS) {
    for (let i = 1; i <= SWEEP_RUNS; i++) {
      const r = runChild(path.join(ROOT, MODULE_REL), { BUG247_STARVE_MS: String(starve) });
      check(`starve ${starve} ms run ${i}: version obtained, host sessions admitted`, admitted(r), r);
    }
  }

  console.log('\n1a. ROUND-1 BAND — single block 5000..5500 ms, REAL module + REAL binary');
  for (const starve of ROUND1_BAND_MS) {
    const r = runChild(path.join(ROOT, MODULE_REL), { BUG247_STARVE_MS: String(starve) });
    check(`round-1 band: starve ${starve} ms admits`, admitted(r), r);
  }

  console.log(`\n1b. ROUND-2 SHAPE — ${ROUND2_INITIAL_MS} ms block + follow-on block at the deadline, REAL module + REAL binary`);
  for (const follow of ROUND2_FOLLOW_MS) {
    const r = runChild(path.join(ROOT, MODULE_REL), { BUG247_INITIAL_MS: String(ROUND2_INITIAL_MS), BUG247_FOLLOW_MS: String(follow) }, CHILD_FOLLOW);
    check(`round-2 shape: follow-on ${follow} ms admits`, admitted(r), r);
  }

  console.log('\n1c. must-FAIL: synthesized ROUND-1 body latches in the round-1 band (REAL binary)');
  {
    const root = mkRoot('round1', { moduleSrc: withLegacyProbe(realSrc, ROUND1_PROBE), stubScript: null });
    roots.push(root);
    for (const starve of [5100, 5200, 5400]) {
      const r = runChild(path.join(root, MODULE_REL), { BUG247_STARVE_MS: String(starve) });
      check(`round-1 body latches "runtime check failed" at starve ${starve} ms`, latchedFailed(r), r);
    }
  }

  console.log('\n1d. must-FAIL: synthesized ROUND-2 body latches in the round-2 shape (REAL binary)');
  {
    const root = mkRoot('round2', { moduleSrc: withLegacyProbe(realSrc, ROUND2_PROBE), stubScript: null });
    roots.push(root);
    for (const follow of ROUND2_FOLLOW_MS) {
      const r = runChild(path.join(root, MODULE_REL), { BUG247_INITIAL_MS: String(ROUND2_INITIAL_MS), BUG247_FOLLOW_MS: String(follow) }, CHILD_FOLLOW);
      check(`round-2 body latches "runtime check failed" at follow-on ${follow} ms`, latchedFailed(r), r);
    }
  }

  const stubCase = (label, script, name, bound, want = latchedFailed) => {
    const root = mkRoot(label, { moduleSrc: realSrc, stubScript: script });
    roots.push(root);
    const r = runChild(path.join(root, MODULE_REL), { BUG247_STARVE_MS: '0' });
    check(name, want(r) && bound(r.ms), r);
  };

  console.log('\n2. genuinely slow child: sleeps 6 s then prints a version, NO starvation');
  stubCase('slow6', '#!/bin/sh\nsleep 6\necho "2.1.0 (Claude Code)"\nexit 0\n',
    'slow (6 s) child is refused (inconclusive, retrying) at the 5 s timeout (~5.0 s, not 6 s)', (ms) => ms >= 4_800 && ms < 6_000, refusedRetrying);

  console.log('\n3. stub binary that hangs (sleep 60), no starvation');
  stubCase('hang', '#!/bin/sh\nexec sleep 60\n',
    'hung binary is refused (inconclusive, retrying) at about the timeout (not 60 s)', (ms) => ms >= 4_800 && ms < 7_000, refusedRetrying);

  console.log('\n4. stub binary that exits 1');
  stubCase('exit1', '#!/bin/sh\necho "2.1.0 (Claude Code)"\nexit 1\n', 'non-zero exit fails closed', (ms) => ms < 3_000);

  console.log('\n5. stub binary that prints garbage and exits 0');
  stubCase('garbage', '#!/bin/sh\necho "not a version"\nexit 0\n', 'garbage output fails closed', (ms) => ms < 3_000);

  console.log('\n5b. hostile hangs stay bounded');
  stubCase('ignore-term', "#!/bin/sh\ntrap '' TERM\nsleep 60\n",
    'hung binary that ignores SIGTERM is still refused at about the timeout (SIGKILL)', (ms) => ms >= 4_800 && ms < 7_000, refusedRetrying);
  stubCase('grandchild', '#!/bin/sh\nsleep 60 &\nsleep 60\n',
    'hung binary whose grandchild holds stdout is still refused at about the timeout', (ms) => ms >= 4_800 && ms < 7_000, refusedRetrying);

  console.log('\n5c. boundary: a healthy stub that exits 0 at ~4.5 s, starved 5200 ms after import');
  {
    const root = mkRoot('slow45', { moduleSrc: realSrc, stubScript: '#!/bin/sh\nsleep 4.5\necho "2.1.0 (Claude Code)"\nexit 0\n' });
    roots.push(root);
    const r = runChild(path.join(root, MODULE_REL), { BUG247_STARVE_MS: '5200' });
    check('4.5 s child admits under starvation (no residual main-loop deadline)', admitted(r), r);
  }

  console.log('\n5d. retry path: attempt 1 moves the binary statKey, so attempt 2 probes AFTER the starve');
  {
    const root = mkRoot('retry', { moduleSrc: realSrc, stubScript: '#!/bin/sh\nif [ ! -e "$0.done" ]; then : > "$0.done"; touch "$0"; fi\necho "2.1.0 (Claude Code)"\nexit 0\n' });
    roots.push(root);
    const r = runChild(path.join(root, MODULE_REL), { BUG247_STARVE_MS: '5200' });
    const marker = fs.existsSync(path.join(root, 'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude.done'));
    check('retry-path probe after a 5200 ms starve admits (attempt 1 did move the statKey)', admitted(r) && marker, { ...r, attempt1Touched: marker });
  }

  console.log('\n5e. cold page cache: a copy of the REAL binary evicted with posix_fadvise(DONTNEED), starved 5200 ms');
  {
    const root = mkRoot('cold', { moduleSrc: realSrc, binCopy: true });
    roots.push(root);
    const bin = path.join(root, 'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude');
    for (let i = 1; i <= 2; i++) {
      const ev = spawnSync('python3', ['-c', 'import os,sys\nfd=os.open(sys.argv[1],os.O_RDONLY)\nos.fsync(fd)\nos.posix_fadvise(fd,0,0,os.POSIX_FADV_DONTNEED)\nos.close(fd)', bin], { encoding: 'utf8' });
      const r = runChild(path.join(root, MODULE_REL), { BUG247_STARVE_MS: '5200' });
      check(`cold-cache run ${i}: version obtained, admitted (importMs = sync probe cost incl. page-in)`, ev.status === 0 && admitted(r), { ...r, evicted: ev.status === 0 });
    }
  }

  console.log('\n6. repeated starvation spread across windows (hung stub) — bounded fail, no hang');
  {
    const root = mkRoot('repeat-hang', { moduleSrc: realSrc, stubScript: '#!/bin/sh\nexec sleep 60\n' });
    roots.push(root);
    const r = runChild(path.join(root, MODULE_REL), { BUG247_BLOCK_MS: '2000', BUG247_WINDOWS: '8' }, CHILD_REPEAT);
    check('hung binary under spread starvation is refused in bounded time (< 30 s)', refusedRetrying(r) && r.ms < 30_000, r);
  }

  console.log('\n7. repeated starvation spread across windows (REAL binary) — admits, no hang');
  {
    const r = runChild(path.join(ROOT, MODULE_REL), { BUG247_BLOCK_MS: '2000', BUG247_WINDOWS: '5' }, CHILD_REPEAT);
    check('real binary under spread starvation obtains a version, no block', admitted(r), r);
  }

  console.log('\n9. ROUND 4 — OS freeze (SIGSTOP 7 s) of the parent mid-probe while the healthy child exits 0');
  console.log('   (the round-3 verifier\'s break; the first probe is INCONCLUSIVE, then a retry admits)');
  const sha256 = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  for (let i = 1; i <= 3; i++) {
    const root = mkRoot(`sigstop-adm${i}`, { moduleSrc: realSrc, stubScript: SIGSTOP_ONCE_STUB });
    roots.push(root);
    const r = runChild(path.join(root, MODULE_REL), { BUG247_HEAL: 'admission', BUG247_STOP: '7' }, CHILD_HEAL);
    const okFirst = r.first?.state === 'inconclusive' && r.first?.cli == null && r.first?.transient === true
      && /^runtime check could not finish: `--version` timed out/.test(r.first?.block ?? '') && r.first.ms >= 6_500;
    const healed = r.healedMs != null && r.state === 'ok' && r.cli === '2.1.0' && r.block == null
      && r.identity?.hash === sha256(stubBin(root)) && r.identity?.sdkVersion === '0.0.1' && r.identity?.platVersion === '0.0.1';
    check(`run ${i}: first probe inconclusive (refused, honest reason, transient); a later ADMISSION re-proves and admits with BOOT_IDENTITY set`, okFirst && healed && probeCount(root) === 2, { ...r, probes: probeCount(root) });
  }
  for (let i = 1; i <= 2; i++) {
    const root = mkRoot(`sigstop-listen${i}`, { moduleSrc: realSrc, stubScript: SIGSTOP_ONCE_STUB });
    roots.push(root);
    const r = runChild(path.join(root, MODULE_REL), { BUG247_HEAL: 'listen', BUG247_DELAY: '500', BUG247_STOP: '7' }, CHILD_HEAL);
    const healed = r.first?.state === 'inconclusive' && r.healedMs != null && r.healedMs - r.first.ms < 4_000
      && r.cli === '2.1.0' && r.block == null && r.identity?.hash === sha256(stubBin(root));
    check(`run ${i}: the post-listen retry (no admission needed) heals within seconds`, healed && probeCount(root) === 2, { ...r, probes: probeCount(root) });
  }
  {
    // A first-try success on the same stub, for the "exactly as a first try" comparison.
    const root = mkRoot('sigstop-firsttry', { moduleSrc: realSrc, stubScript: SIGSTOP_ONCE_STUB });
    roots.push(root);
    fs.writeFileSync(`${stubBin(root)}.stopped`, '');
    const first = runChild(path.join(root, MODULE_REL), { BUG247_HEAL: 'listen', BUG247_WINDOW: '0' }, CHILD_HEAL);
    const root2 = mkRoot('sigstop-retry', { moduleSrc: realSrc, stubScript: SIGSTOP_ONCE_STUB });
    roots.push(root2);
    const retried = runChild(path.join(root2, MODULE_REL), { BUG247_HEAL: 'listen', BUG247_DELAY: '200', BUG247_STOP: '7' }, CHILD_HEAL);
    check('a retry success sets BOOT_CLI_VERSION / BOOT_IDENTITY exactly as a first-try success does',
      first.first?.state === 'ok' && retried.state === 'ok' && first.cli === retried.cli
      && JSON.stringify(first.identity) === JSON.stringify(retried.identity), { firstTry: { cli: first.cli, identity: first.identity }, retry: { cli: retried.cli, identity: retried.identity } });
  }

  console.log('\n9b. must-FAIL: synthesized ROUND-3 body (spawnSync, any null latches) on the same SIGSTOP case');
  for (let i = 1; i <= 2; i++) {
    const root = mkRoot(`round3-${i}`, { moduleSrc: withLegacyProbe(realSrc, ROUND3_PROBE), stubScript: SIGSTOP_ONCE_STUB });
    roots.push(root);
    const r = runChild(path.join(root, MODULE_REL), { BUG247_HEAL: 'admission', BUG247_STOP: '7', BUG247_WINDOW: '13000' }, CHILD_HEAL);
    check(`round-3 body run ${i}: latches "runtime check failed" and NEVER heals, though the binary is healthy`,
      r.first?.cli == null && /runtime check failed: the bundled runtime did not run/.test(r.first?.block ?? '') && r.healedMs == null && r.cli == null, { ...r, probes: probeCount(root) });
  }

  console.log('\n10. hung binary under repeated admission: refused every time, bounded, never admits, never freezes the loop');
  {
    const root = mkRoot('hammer-hang', { moduleSrc: realSrc, stubScript: HANG_COUNTED_STUB });
    roots.push(root);
    const r = runChild(path.join(root, MODULE_REL), { BUG247_WINDOW: '35000', BUG247_SCHEDULE: '1' }, CHILD_HAMMER);
    const probes = probeCount(root);
    // boot (~5 s) + the post-listen retry + throttled admission retries (≥10 s gap after each 5 s probe)
    check('every admission refused with the honest "could not finish" reason; state never ok',
      r.calls > 200 && r.admitted === 0 && r.reasons?.length === 1 && r.reasons[0] === 'runtime check could not finish'
      && !r.states?.includes('ok') && r.finalState === 'inconclusive' && r.cli == null, r);
    check('bounded: boot proof ~5 s, each admission call < 20 ms, no loop freeze (async re-probe), 2..5 probes in 35 s',
      r.bootMs < 7_000 && r.maxCallMs < 20 && r.maxGapMs < 500 && probes >= 2 && probes <= 5, { ...r, probes });
  }

  console.log('\n11. definitive failures latch permanently: no re-probe, ever');
  for (const [label, script] of [['exit1-perm', '#!/bin/sh\necho x >> "$0.count"\necho "2.1.0 (Claude Code)"\nexit 1\n'], ['garbage-perm', '#!/bin/sh\necho x >> "$0.count"\necho "not a version"\nexit 0\n']]) {
    const root = mkRoot(label, { moduleSrc: realSrc, stubScript: script });
    roots.push(root);
    const r = runChild(path.join(root, MODULE_REL), { BUG247_WINDOW: '12000', BUG247_SCHEDULE: '1' }, CHILD_HAMMER);
    check(`${label}: 'failed' from boot, every admission refused for 12 s, exactly 1 probe (no retry)`,
      r.finalState === 'failed' && r.states?.length === 1 && r.states[0] === 'failed' && r.admitted === 0
      && r.reasons?.[0] === 'runtime check failed' && probeCount(root) === 1, { ...r, probes: probeCount(root) });
  }

  console.log('\n12. throttle + single-flight');
  {
    const root = mkRoot('flight', { moduleSrc: realSrc, stubScript: HANG_ONCE_STUB });
    roots.push(root);
    const r = runChild(path.join(root, MODULE_REL), { BUG247_COUNT: `${stubBin(root)}.count` }, CHILD_FLIGHT);
    check('boot proof inconclusive (1 probe); 100 admissions inside the 10 s window spawn no probe',
      r.boot?.state === 'inconclusive' && r.boot?.probes === 1 && r.throttled?.probes === 1, r);
    check('100 concurrent admissions after the window spawn exactly ONE probe, are all refused while it runs, then it admits',
      r.after?.probes === 2 && r.refusedDuringAll === true && r.refusedDuringN === 100 && r.after?.state === 'ok' && r.after?.block == null && r.after?.cli === '2.1.0', r);
    check('once ok, further admissions never probe again', r.finalProbes === 2, r);
  }

  console.log('\n13. ROUND 5 — identity invariant: a retry after an inconclusive boot never re-baselines');
  const swapRun = (label, { src = realSrc, script, swap = true, revert = false, before = null, window = '8000', swapped = SWAPPED_STUB }) => {
    const root = mkRoot(label, { moduleSrc: src, stubScript: script });
    roots.push(root);
    if (before != null) { const b = stubBin(root); fs.writeFileSync(`${b}.pre`, before, { mode: 0o755 }); fs.renameSync(`${b}.pre`, b); }
    return runChild(path.join(root, MODULE_REL), { BUG247_BIN: stubBin(root), BUG247_SWAP: swap ? '1' : '0', BUG247_REVERT: revert ? '1' : '0', BUG247_SWAPPED: swapped, BUG247_WINDOW: window }, CHILD_SWAP);
  };
  const SWAP_BLOCK = /^the Claude host runtime changed on disk \(the bundled CLI binary changed on disk\) and Orchard must be restarted/;
  const control = swapRun('r5-control', { script: '#!/bin/sh\necho "2.1.0 (Claude Code)"\nexit 0\n' });
  check('13a CONTROL: boot ok, then binary swapped → refused, restartPending true, identity = load hash',
    control.boot?.state === 'ok' && control.admitted === false && control.restartPending === true && control.transient === false
    && SWAP_BLOCK.test(control.block ?? '') && control.bootIdentity?.hash === control.loadHash && control.diskHash !== control.loadHash, control);
  for (let i = 1; i <= 3; i++) {
    const r = swapRun(`r5-attack${i}`, { script: HANG_ONCE_FAST_STUB });
    check(`13b ATTACK run ${i}: boot inconclusive, binary swapped, retry → refused, restartPending true, same block as CONTROL, nothing baselined`,
      r.boot?.state === 'inconclusive' && r.admitted === false && r.restartPending === true && r.transient === false
      && r.block === control.block && r.cli == null && r.bootIdentity == null && r.final?.state === 'inconclusive' && r.diskHash !== r.loadHash, r);
  }
  for (let i = 1; i <= 2; i++) {
    const r = swapRun(`r5-round4-${i}`, { src: withRound4Identity(realSrc), script: HANG_ONCE_FAST_STUB });
    check(`13c must-FAIL run ${i}: synthesized ROUND-4 body ADMITS the swapped binary (cli 9.9.9, restartPending false, identity = swapped hash)`,
      r.boot?.state === 'inconclusive' && r.admitted === true && r.cli === '9.9.9' && r.restartPending === false
      && r.bootIdentity?.hash === r.diskHash && r.bootIdentity?.hash !== r.loadHash, r);
  }
  for (let i = 1; i <= 2; i++) {
    const r = swapRun(`r5-same${i}`, { script: HANG_ONCE_FAST_STUB, swap: false });
    check(`13d run ${i}: same binary after an inconclusive boot → admits, cli 2.1.0, BOOT_IDENTITY hash = load hash`,
      r.boot?.state === 'inconclusive' && r.admitted === true && r.restartPending === false && r.cli === '2.1.0'
      && r.bootIdentity?.hash === r.loadHash && r.final?.state === 'ok', r);
  }
  {
    // Swap BEFORE load: the binary at load is the 9.9.9 one. Success path and
    // inconclusive path must both admit exactly what was there at load.
    const succ = swapRun('r5-before-ok', { script: HANG_ONCE_FAST_STUB, before: SWAPPED_STUB, swap: false });
    const inc = swapRun('r5-before-inc', { script: HANG_ONCE_FAST_STUB, before: HANG_ONCE_SWAPPED_STUB, swap: false });
    check('13e swap before load: success path admits the load-time binary (9.9.9, identity = load hash)',
      succ.boot?.state === 'ok' && succ.admitted === true && succ.cli === '9.9.9' && succ.bootIdentity?.hash === succ.loadHash, succ);
    check('13e swap before load: inconclusive path admits the same load-time binary (9.9.9, identity = load hash)',
      inc.boot?.state === 'inconclusive' && inc.admitted === true && inc.cli === '9.9.9' && inc.bootIdentity?.hash === inc.loadHash
      && inc.bootIdentity?.sdkVersion === succ.bootIdentity?.sdkVersion && inc.bootIdentity?.platVersion === succ.bootIdentity?.platVersion, inc);
  }
  {
    const r = swapRun('r5-revert', { script: HANG_ONCE_FAST_STUB, revert: true, window: '25000' });
    check('13f swap then revert to the loaded bytes (fresh inode) while inconclusive → swap refused (restart block), revert re-proved and admitted',
      r.boot?.state === 'inconclusive' && SWAP_BLOCK.test(r.sawSwapBlock?.reason ?? '') && r.sawSwapBlock?.transient === false
      && r.admitted === true && r.cli === '2.1.0' && r.bootIdentity?.hash === r.loadHash && r.diskHash === r.loadHash, r);
  }
  {
    // Round 6 changed this expectation (r5 failed the cut-short arm closed — the r5
    // verifier's 'during' divergence): both arms now settle on the swapped-in file.
    const ctl = swapRun('r6-during-ok', { script: SWAP_DURING_OK_STUB, swap: false, window: '3000' });
    const r = swapRun('r5-during', { script: SWAP_DURING_PROBE_STUB, swap: false, window: '3000' });
    check('13g binary swapped DURING the cut-short boot probe → the gone file\'s probe is discarded, the swapped-in file is proved and admitted (9.9.9), identical to the success-path control',
      ctl.boot?.state === 'ok' && ctl.admitted === true && ctl.cli === '9.9.9' && ctl.bootIdentity?.hash === ctl.diskHash
      && r.admitted === true && r.cli === '9.9.9' && r.restartPending === false && r.bootIdentity?.hash === r.diskHash
      && r.bootIdentity?.hash === ctl.bootIdentity?.hash && r.bootIdentity?.hash !== r.loadHash, { control: ctl, attack: r });
  }

  {
    const root = mkRoot('r5-update', { moduleSrc: realSrc, stubScript: HANG_ONCE_FAST_STUB });
    roots.push(root);
    const scope = path.join(root, 'node_modules/@anthropic-ai');
    const r = runChild(path.join(root, MODULE_REL), { BUG247_SDK: path.join(scope, 'claude-agent-sdk'), BUG247_PLAT: path.join(scope, 'claude-agent-sdk-linux-x64') }, CHILD_UPDATE);
    check('13h full update (SDK + platform + binary) inside the inconclusive window → never admitted, restart block (SDK 0.0.1 → 0.0.2), restartPending',
      r.boot === 'inconclusive' && r.everAdmitted === false && r.afterUpdate?.restartPending === true && r.afterUpdate?.transient === false
      && /^the Claude host runtime changed on disk \(SDK 0\.0\.1 → 0\.0\.2; CLI package 0\.0\.1 → 0\.0\.2\)/.test(r.afterUpdate?.block ?? '') && r.afterUpdate?.cli == null, r);
    check('13h then rolled back to the loaded files → re-proved and admitted (cli 2.1.0), as a successful boot re-admits a rollback',
      r.healedMs != null && r.final === 'ok' && r.cli === '2.1.0' && r.restartPending === false, r);
  }

  console.log('\n14. ROUND 6 — attribution: only a result attributed to LOAD_IDENTITY changes boot state');
  const OK_STUB = '#!/bin/sh\necho x >> "$0.count"\necho "2.1.0 (Claude Code)"\nexit 0\n';
  const recovered = (r) => r.admitted === true && r.cli === '2.1.0' && r.final?.state === 'ok' && r.bootIdentity?.hash === r.loadHash && r.diskHash === r.loadHash;
  {
    const c = swapRun('r6-badswap-ok', { script: OK_STUB, swapped: BAD_STUB, revert: true, window: '25000' });
    check('14a bad-swap CONTROL: boot ok, exit-1 binary swapped in → restart block (non-transient); rollback re-admits',
      c.boot?.state === 'ok' && SWAP_BLOCK.test(c.sawSwapBlock?.reason ?? '') && c.sawSwapBlock?.transient === false && recovered(c), c);
    for (let i = 1; i <= 2; i++) {
      const r = swapRun(`r6-badswap-inc${i}`, { script: HANG_ONCE_FAST_STUB, swapped: BAD_STUB, revert: true, window: '25000' });
      check(`14b bad-swap ATTACK run ${i}: boot inconclusive, exit-1 swapped in → never latched, same restart block as CONTROL; rollback re-proved and admitted`,
        r.boot?.state === 'inconclusive' && r.sawSwapBlock?.reason === c.sawSwapBlock?.reason && r.sawSwapBlock?.transient === false && recovered(r), r);
    }
    for (let i = 1; i <= 2; i++) {
      const r = swapRun(`r6-round5-${i}`, { src: withRound5Retry(realSrc), script: HANG_ONCE_FAST_STUB, swapped: BAD_STUB, revert: true, window: '25000' });
      check(`14c must-FAIL run ${i}: synthesized ROUND-5 retry latches 'failed' on the swapped-in exit-1 binary; rollback never re-admits`,
        r.boot?.state === 'inconclusive' && r.final?.state === 'failed' && /did not run \`--version\` when re-checked \(exit status 1\)/.test(r.sawSwapBlock?.reason ?? '')
        && r.admitted === false && r.diskHash === r.loadHash, r);
    }
  }
  for (const [tag, variant] of [['14d', 'post'], ['14e', 'pre-spawn']]) {
    const r = swapRun(`r6-retry-${variant}`, { script: retryReplaceStub(variant), swap: false, revert: true, window: '25000' });
    check(`${tag} exit-1 binary replaces the loaded file ${variant === 'post' ? 'after the retry probe, before POST' : 'between PRE and the spawn (the bad file runs)'} → discarded, never latched, restart block; rollback admits`,
      r.boot?.state === 'inconclusive' && SWAP_BLOCK.test(r.sawSwapBlock?.reason ?? '') && r.sawSwapBlock?.transient === false && recovered(r), r);
  }
  for (const action of ['bad', 'delete']) {
    const arms = [false, true].map((hang) => {
      const root = mkRoot(`r6-boot-${action}-${hang ? 'inc' : 'ok'}`, { moduleSrc: realSrc, stubScript: bootReplaceStub(action, hang) });
      roots.push(root);
      return runChild(path.join(root, MODULE_REL), {});
    });
    const want = action === 'bad' ? /^runtime check failed: the bundled runtime did not run \`--version\` at boot \(exit status 1\)/ : /^runtime check failed: the bundled runtime binary could not be read/;
    check(`${action === 'bad' ? '14f good boot probe, exit-1 binary swapped in before the hash' : '14g binary deleted during boot capture'}: success arm and cut-short arm both latch 'failed' with the same reason, never baselined`,
      arms.every((a) => a.state === 'failed' && a.cli == null && want.test(a.block ?? '')) && arms[0].block === arms[1].block, arms);
  }
  {
    const arms = [OK_STUB, HANG_ONCE_FAST_STUB].map((script, i) => {
      const root = mkRoot(`r6-meta-${i}`, { moduleSrc: realSrc, stubScript: script });
      roots.push(root);
      return runChild(path.join(root, MODULE_REL), { BUG247_PLATPKG: path.join(root, 'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/package.json') }, CHILD_META);
    });
    const [c, r] = arms;
    check('14h platform package.json gone inside the window: refused non-transiently on both arms, never latched; restored → both admit',
      c.boot === 'ok' && r.boot === 'inconclusive' && c.gone?.transient === false && r.gone?.transient === false && r.gone?.state === 'inconclusive'
      && c.gone?.block === r.gone?.block && c.healedMs != null && r.healedMs != null && r.final === 'ok' && r.cli === '2.1.0', arms);
  }

  console.log('\n15. ROUND 7 — a non-regular file at the binary path: never admitted, never leaks a pool thread');
  const PROMPT_EXIT_MS = 45_000; // a clean process.exit is well under this; a leaked open hangs to the 90 s spawn timeout
  const runNode = (label, { moduleSrc, stubScript, kind }) => {
    const root = mkRoot(label, { moduleSrc, stubScript });
    roots.push(root);
    const bin = stubBin(root);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD_NODE], {
      env: { ...process.env, BUG247_MODULE: pathToFileURL(path.join(root, MODULE_REL)).href, BUG247_BIN: bin, BUG247_NODE_KIND: kind },
      encoding: 'utf8', timeout: 90_000,
    });
    const elapsedMs = Date.now() - t0;
    const line = (r.stdout || '').trim().split('\n').filter(Boolean).at(-1);
    let out; try { out = JSON.parse(line); } catch { out = { error: `no result status=${r.status} signal=${r.signal}`, stderr: (r.stderr || '').slice(-400) }; }
    return { ...out, elapsedMs, timedOut: r.signal != null || elapsedMs >= 89_000 };
  };
  const OK_NODE_STUB = '#!/bin/sh\necho "2.1.0 (Claude Code)"\nexit 0\n';
  {
    const c = runNode('r7-fifo-ok', { moduleSrc: realSrc, stubScript: OK_NODE_STUB, kind: 'fifo' });
    check('15a FIFO over the binary (boot OK): never admitted while the FIFO sits there, rollback re-admits (cli 2.1.0), recheck settles, prompt exit (no leaked pool thread)',
      c.boot === 'ok' && !c.during.includes('ADMITTED') && c.healedMs != null && c.final === 'ok' && c.cli === '2.1.0'
      && c.recheckSettled === true && !c.timedOut && c.elapsedMs < PROMPT_EXIT_MS, c);
    const a = runNode('r7-fifo-inc', { moduleSrc: realSrc, stubScript: HANG_ONCE_FAST_STUB, kind: 'fifo' });
    check('15a FIFO over the binary (boot INCONCLUSIVE): never admitted, rollback re-admits (cli 2.1.0), recheck settles, prompt exit',
      a.boot === 'inconclusive' && !a.during.includes('ADMITTED') && a.healedMs != null && a.final === 'ok' && a.cli === '2.1.0'
      && a.recheckSettled === true && !a.timedOut && a.elapsedMs < PROMPT_EXIT_MS, a);
  }
  {
    const d = runNode('r7-devzero', { moduleSrc: realSrc, stubScript: OK_NODE_STUB, kind: 'devzero' });
    check('15b symlink to /dev/zero at the binary path: hash returns null promptly (no spin), device never admitted, rollback re-admits, prompt exit',
      d.boot === 'ok' && !d.during.includes('ADMITTED') && d.healedMs != null && d.final === 'ok' && d.cli === '2.1.0'
      && !d.timedOut && d.elapsedMs < PROMPT_EXIT_MS, d);
  }
  {
    const m = runNode('r7-legacy-fifo', { moduleSrc: withLegacyHashFile(realSrc), stubScript: HANG_ONCE_FAST_STUB, kind: 'fifo' });
    check('15c must-FAIL: synthesized pre-fix hashFile on the FIFO inconclusive arm → never re-admits and/or the child exit hangs to the spawn timeout',
      m.boot === 'inconclusive' && (m.healedMs == null || m.timedOut || m.elapsedMs >= PROMPT_EXIT_MS), m);
  }

  console.log('\n8. ISOLATED scratch server — GET /api/runtime (own CLAUDE_STATION_DATA, free port)');
  {
    const r = await scratchServerRuntime();
    check('host.runningCli populated and restartPending false (no host-session block)',
      typeof r.runningCli === 'string' && r.restartPending === false && r.runtimeCheck?.state === 'ok', r);
  }
  console.log('\n8b. ISOLATED scratch server, stub runtime that freezes the server 7 s during its boot probe (once)');
  {
    const root = mkServerRoot('srv4', SIGSTOP_ONCE_STUB);
    roots.push(root);
    const r = await scratchServerStubRuntime(root);
    const first = r.samples?.[0];
    const last = r.samples?.at(-1);
    check('GET /api/runtime first reports state "inconclusive" with the timeout reason, runningCli null, restartPending true',
      first?.state === 'inconclusive' && /timed out after 5 s/.test(first?.reason ?? '') && first?.runningCli == null && first?.restartPending === true, r);
    // GET /api/runtime itself consults the admission guard (restartPending), but a
    // guard-triggered re-proof is throttled to >=10 s after the boot proof ended; the
    // post-listen retry fires ~3 s after listen. Healing well inside that window shows
    // the post-listen retry did it. (Probe counts are not usable here: the route's
    // installedCli runs `--version` on every GET.)
    check('then the post-listen retry turns it "ok" within ~3 s of listen (before any throttled guard retry could): runningCli set, restartPending false',
      last?.state === 'ok' && last?.runningCli === '2.1.0' && last?.restartPending === false && last.at < r.healthyAt + 7_000, r);
  }
} finally {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
