#!/usr/bin/env node
/**
 * verify-scratch-root.mjs — proof for the configurable scratch root
 * (scripts/lib/scratch.mjs) and for independent-verify.mjs using it.
 *
 * What is being proven, in the order it matters:
 *   A. RESOLUTION. One knob ($CLAUDE_STATION_TMPDIR), a PERSISTENT default
 *      under XDG state, and $TMPDIR / the system temp dir only as an explicitly
 *      DEGRADED last resort.
 *   B. THE BOUNDARY. `cp --reflink=auto` does not fail across a filesystem
 *      boundary — it silently does a full byte copy and exits 0. So the boundary
 *      is checked, in the shape src/server/snapshots.ts checks it, and the
 *      violation is REPORTED with both devices and both filesystem types.
 *   C. THE NUMBER. The same real 374 MB `node_modules`, copied both ways, timed.
 *      A same-filesystem requirement asserted without a number is a preference.
 *   D. THE REAL TOOL. independent-verify.mjs building a clean room over THIS
 *      repo — not a fixture — landing in the configured root, and reporting the
 *      cross-filesystem case rather than being quietly slow.
 *
 * The must-FAIL anchor is SYNTHESIZED, never `git show HEAD:` (docs/CONVENTIONS.md:
 * a baseline that names the thing being changed stops failing the moment the fix
 * lands): the pre-fix expression is written out literally here, and shown to put
 * the clean room in the boot-wiped location.
 *
 * Scratch: this script's own directories live under the scratch root and
 * /dev/shm, never in the repo. Nothing it spawns outlives it.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SCRATCH_MOD = path.join(HERE, 'lib', 'scratch.mjs');

let pass = 0, fail = 0, skip = 0;
const failures = [], skips = [];
function check(name, ok, observed) {
  const o = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${(o ?? '').slice(0, 500)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
function skipped(name, why) {
  console.log(`  SKIP  ${name}\n        ${why}`);
  skip++; skips.push(name);
}
function section(t) { console.log(`\n${t}\n${'-'.repeat(t.length)}`); }

const cleanup = [];
function rmLater(d) { cleanup.push(d); return d; }

/**
 * Resolve the module in a CHILD process with a chosen environment. The module
 * caches its answer per process, and the whole point is the environment, so the
 * only honest way to test resolution is a fresh process per case.
 */
function resolveIn(env) {
  const r = spawnSync(process.execPath, ['-e', `
    import(${JSON.stringify(SCRATCH_MOD)}).then((m) => {
      try { console.log(JSON.stringify({ ok: true, info: m.scratchRootInfo(), envName: m.SCRATCH_ENV })); }
      catch (e) { console.log(JSON.stringify({ ok: false, error: String(e && e.message || e) })); }
    });
  `], { encoding: 'utf8', env: { ...process.env, ...env } });
  try { return JSON.parse((r.stdout ?? '').trim()); }
  catch { return { ok: false, error: `child produced no JSON (exit ${r.status}): ${(r.stderr ?? '').slice(0, 300)}` }; }
}

/* ============================================ A. resolution and precedence */

section('A. resolution — one knob, a persistent default, a DEGRADED last resort');

const clearEnv = { CLAUDE_STATION_TMPDIR: undefined, XDG_STATE_HOME: undefined, TMPDIR: undefined };

{
  const d = resolveIn(clearEnv);
  check('the DEFAULT scratch root is persistent XDG state, not the boot-wiped temp dir',
    d.ok && !d.info.degraded && /[/\\]\.local[/\\]state[/\\]claude-station[/\\]scratch$/.test(d.info.dir)
      && !d.info.dir.startsWith(os.tmpdir() + path.sep) && d.info.dir !== os.tmpdir(),
    d.ok ? `${d.info.dir} (source ${d.info.source}, degraded=${d.info.degraded}); os.tmpdir()=${os.tmpdir()}` : d.error);

  check('the env knob is named for the existing CLAUDE_STATION_* convention',
    d.ok && d.envName === 'CLAUDE_STATION_TMPDIR', d.ok ? d.envName : d.error);

  // Not the scratch PROJECT dir knob — a different thing that already exists.
  const paths = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'paths.ts'), 'utf8');
  check('the knob does not collide with CLAUDE_STATION_SCRATCH_DIR (the scratch PROJECT dir, src/lib/paths.ts)',
    paths.includes('CLAUDE_STATION_SCRATCH_DIR') && d.envName !== 'CLAUDE_STATION_SCRATCH_DIR',
    `paths.ts owns CLAUDE_STATION_SCRATCH_DIR; tooling knob is ${d.envName}`);
}

{
  const want = rmLater(fs.mkdtempSync(path.join(os.homedir(), '.cache', 'vsr-knob-')));
  const d = resolveIn({ ...clearEnv, CLAUDE_STATION_TMPDIR: want });
  check('$CLAUDE_STATION_TMPDIR wins over everything else',
    d.ok && d.info.dir === want && d.info.source === '$CLAUDE_STATION_TMPDIR' && !d.info.degraded,
    d.ok ? `${d.info.dir} (${d.info.source})` : d.error);
}

{
  const want = rmLater(fs.mkdtempSync(path.join(os.homedir(), '.cache', 'vsr-xdg-')));
  const d = resolveIn({ ...clearEnv, XDG_STATE_HOME: want });
  check('$XDG_STATE_HOME is honoured for the default location',
    d.ok && d.info.dir === path.join(want, 'claude-station', 'scratch') && !d.info.degraded,
    d.ok ? `${d.info.dir} (${d.info.source})` : d.error);
}

// An UNUSABLE candidate that fails FAST and cannot be created: an ordinary FILE
// used as a directory (ENOTDIR). Deliberately not a /proc path — `mkdirSync`
// recursive under /proc/self HANGS in this kernel rather than returning EACCES,
// which is a lovely way to make a test suite look like an infinite loop.
const BLOCKED = rmLater(fs.mkdtempSync(path.join(os.homedir(), '.cache', 'vsr-blocked-'))) + '/not-a-dir';
fs.mkdirSync(path.dirname(BLOCKED), { recursive: true });
fs.writeFileSync(BLOCKED, 'this is a file, so mkdir under it is ENOTDIR\n');

{
  // Make the persistent candidate unusable, and only then should TMPDIR appear —
  // and it must be flagged as a degradation, not chosen silently.
  const tdir = rmLater(fs.mkdtempSync(path.join(os.homedir(), '.cache', 'vsr-tmpdir-')));
  const d = resolveIn({ ...clearEnv, XDG_STATE_HOME: BLOCKED, TMPDIR: tdir });
  check('$TMPDIR is the fallback when the persistent root is unusable — and is reported as DEGRADED',
    d.ok && d.info.dir === tdir && d.info.source === '$TMPDIR' && d.info.degraded === true && d.info.tried.length === 1,
    d.ok ? `${d.info.dir} (${d.info.source}, degraded=${d.info.degraded}, tried=${d.info.tried.length})` : d.error);

  const d2 = resolveIn({ ...clearEnv, XDG_STATE_HOME: BLOCKED });
  check('with no $TMPDIR either, the system temp dir is the final fallback, also DEGRADED',
    d2.ok && d2.info.dir === os.tmpdir() && d2.info.degraded === true,
    d2.ok ? `${d2.info.dir} (${d2.info.source}, degraded=${d2.info.degraded})` : d2.error);
}

{
  // Non-vacuity for the whole resolver: when NOTHING is usable it must throw,
  // not invent a path. (TMPDIR and the system temp dir both forced unusable.)
  const r = spawnSync(process.execPath, ['-e', `
    import(${JSON.stringify(SCRATCH_MOD)}).then((m) => {
      try { m.scratchRootInfo(); console.log('NO-THROW'); } catch (e) { console.log('THREW: ' + e.message.split('\\n')[0]); }
    });
  `], { encoding: 'utf8', env: { ...process.env, CLAUDE_STATION_TMPDIR: undefined, XDG_STATE_HOME: BLOCKED, TMPDIR: BLOCKED } });
  const out = (r.stdout ?? '').trim();
  // os.tmpdir() reads TMPDIR, so blocking TMPDIR removes BOTH last resorts and
  // the resolver has genuinely nowhere left to go.
  check('a resolver with no usable candidate at all THROWS rather than returning a fictional path',
    out.startsWith('THREW:'), out.slice(0, 300));
}

/* ============================ B. the filesystem boundary, and how it reports */

section('B. the boundary — cross-filesystem is DETECTED and reported, not silent');

const scratch = await import(SCRATCH_MOD);
const NM = path.join(ROOT, 'node_modules');
const SHM = fs.existsSync('/dev/shm') ? '/dev/shm' : null;

{
  const same = scratch.checkSameFilesystem(NM, scratch.scratchRoot());
  check('same filesystem: reported OK, naming the device and the filesystem type',
    same.ok && /device \d+ \[[a-z0-9]+\]/.test(same.message) && /reflink/i.test(same.message),
    same.message);
}

if (!SHM) skipped('cross-filesystem detection', '/dev/shm is absent — no second filesystem to test against');
else {
  const devNm = fs.statSync(NM).dev, devShm = fs.statSync(SHM).dev;
  if (devNm === devShm) skipped('cross-filesystem detection', `/dev/shm is on the SAME device (${devShm}) as the repo`);
  else {
    const cross = scratch.checkSameFilesystem(NM, path.join(SHM, 'vsr-does-not-exist-yet', 'deeper'));
    check('cross filesystem: DETECTED, and the report names BOTH devices and BOTH filesystem types',
      cross.ok === false && cross.message.includes(String(devNm)) && cross.message.includes(String(devShm))
        && /btrfs|xfs|ext4/.test(cross.message) && /tmpfs/.test(cross.message),
      cross.message);
    check('the report says WHAT is lost (a silent full copy) and NAMES the knob that fixes it',
      cross.ok === false && /silently/i.test(cross.message) && cross.message.includes('CLAUDE_STATION_TMPDIR')
        && /full size/i.test(cross.message),
      cross.message);
    check('the preflight measures the nearest EXISTING ancestor and creates nothing',
      !fs.existsSync(path.join(SHM, 'vsr-does-not-exist-yet')), `${SHM}/vsr-does-not-exist-yet absent after the check`);
    // Precedent conformance: the same shape as the snapshot store's preflight.
    const snaps = fs.readFileSync(path.join(ROOT, 'src', 'server', 'snapshots.ts'), 'utf8');
    check('it follows the snapshot store\'s precedent (device + fsType + "Fix by pointing …")',
      /they are on DIFFERENT filesystems/.test(snaps) && /Fix by pointing/.test(snaps) && /Fix by pointing/.test(cross.message),
      'snapshots.ts assertSameFilesystem shape reused');
  }
}

/* ================================================ C. the number, both ways */

section('C. the number — the same real node_modules copied both ways');

const duMb = (d) => Math.round(Number((spawnSync('du', ['-sk', d], { encoding: 'utf8' }).stdout ?? '0').split(/\s/)[0] || 0) / 1024);
const timedCopy = (dest, mode) => {
  const t0 = Date.now();
  const r = spawnSync('cp', ['-a', `--reflink=${mode}`, NM, dest], { encoding: 'utf8' });
  return { ms: Date.now() - t0, status: r.status ?? 1, stderr: (r.stderr ?? '').slice(0, 200) };
};
/**
 * MEASURING A REFLINK IS NOT `du`. `du` sums each file's allocated blocks and
 * knows nothing about extents shared with another file, so a perfect reflink
 * copy reads as 100% of the original (observed here: 373 MB "consumed" for a
 * copy that cost nothing). The instrument that actually sees it is the
 * FILESYSTEM's free space: statfs before and after. Noise from other processes
 * on a 611 GB-free volume is small against 374 MB, and the comparison is
 * reflink-vs-real on the SAME filesystem, so any drift hits both arms.
 */
const freeBytes = (p) => {
  // btrfs delays allocation: without a filesystem sync the free-space counter
  // has not moved yet and BOTH arms read as 0 MB. `sync -f` commits the
  // transaction for that one filesystem before the reading is taken.
  spawnSync('sync', ['-f', p], { encoding: 'utf8' });
  const st = fs.statfsSync(p);
  return st.bavail * st.bsize;
};

let sameMs = null, crossMs = null, realMs = null;
if (!fs.existsSync(NM)) skipped('copy cost measurement', 'node_modules is absent');
else {
  const apparentMb = Math.round(Number((spawnSync('du', ['-sk', '--apparent-size', NM], { encoding: 'utf8' }).stdout ?? '0').split(/\s/)[0] || 0) / 1024);

  const reflinkDir = rmLater(fs.mkdtempSync(path.join(scratch.scratchRoot(), 'vsr-reflink-')));
  const f0 = freeBytes(reflinkDir);
  const same = timedCopy(path.join(reflinkDir, 'node_modules'), 'auto');
  const reflinkCostMb = Math.round((f0 - freeBytes(reflinkDir)) / 1048576);
  sameMs = same.ms;
  check('same-filesystem copy of the REAL node_modules succeeds',
    same.status === 0, `exit=${same.status} in ${same.ms}ms ${same.stderr}`);

  const realDir = rmLater(fs.mkdtempSync(path.join(scratch.scratchRoot(), 'vsr-real-')));
  const f1 = freeBytes(realDir);
  const real = timedCopy(path.join(realDir, 'node_modules'), 'never');
  const realCostMb = Math.round((f1 - freeBytes(realDir)) / 1048576);
  realMs = real.ms;
  check('a forced REAL copy of the same tree also succeeds (the control arm)',
    real.status === 0, `exit=${real.status} in ${real.ms}ms ${real.stderr}`);

  check('the reflink copy costs a small fraction of the disk a real copy costs',
    same.status === 0 && real.status === 0 && realCostMb > 100 && reflinkCostMb < realCostMb * 0.25,
    `tree is ${apparentMb}MB apparent; --reflink=auto consumed ${reflinkCostMb}MB of filesystem free space in ${same.ms}ms, --reflink=never consumed ${realCostMb}MB in ${real.ms}ms`);
  check('…and `du` CANNOT see that — the naive instrument reads a reflink as a full copy',
    duMb(path.join(reflinkDir, 'node_modules')) > apparentMb * 0.9,
    `du -sk on the reflink copy reports ${duMb(path.join(reflinkDir, 'node_modules'))}MB (it sums allocated blocks, blind to shared extents); statfs says ${reflinkCostMb}MB`);

  if (!SHM || fs.statSync(NM).dev === fs.statSync(SHM).dev) {
    skipped('cross-filesystem copy cost', 'no second filesystem available');
  } else {
    const crossDir = rmLater(fs.mkdtempSync(path.join(SHM, 'vsr-cross-')));
    const cross = timedCopy(path.join(crossDir, 'node_modules'), 'auto');
    crossMs = cross.ms;
    // THE POINT: exit 0. `--reflink=auto` does not complain across a boundary.
    check('THE SILENT FAILURE: the cross-filesystem copy also exits 0 — nothing warns you',
      cross.status === 0, `exit=${cross.status} ${cross.stderr}`);
    // NOT asserted: "cross-filesystem is slower". The only second filesystem on
    // this machine is tmpfs — i.e. RAM — which can beat a reflink on wall clock
    // (observed: 370ms vs 424ms) while still costing 373MB of memory. The claim
    // that survives on any destination is the one asserted: the boundary
    // silently COSTS THE COPY ITS REFLINK, and the price is paid in full bytes.
    check('…but crossing the boundary costs the copy its reflink — a full real copy at the destination',
      cross.status === 0 && duMb(path.join(crossDir, 'node_modules')) > apparentMb * 0.9,
      `cross-fs --reflink=auto: exit ${cross.status}, ${duMb(path.join(crossDir, 'node_modules'))}MB written to ${SHM} in ${cross.ms}ms (tmpfs is RAM, so its wall clock is NOT a fair proxy for a second disk; the disk COST is the invariant)`);
  }
}

/* ===================================== D. the real tool over the real repo */

section('D. independent-verify.mjs over THIS repo — not a fixture');

/** The pre-fix expression, written out literally so the anchor cannot move. */
{
  const preFix = rmLater(fs.mkdtempSync(path.join(os.tmpdir(), 'cleanroom-verify-')));
  check('MUST-FAIL ANCHOR: the pre-fix expression puts the clean room in the boot-wiped temp dir',
    preFix.startsWith(os.tmpdir() + path.sep) && !preFix.startsWith(scratch.scratchRoot()),
    `pre-fix mkdtempSync(join(os.tmpdir(),'cleanroom-verify-')) -> ${preFix}; scratch root is ${scratch.scratchRoot()}`);
  const tmpfiles = '/etc/tmpfiles.d/tmp.conf';
  check('…and that location really is boot-wiped by system policy on this machine',
    fs.existsSync(tmpfiles) && /^\s*[DR][!=+~-]*\s+\/tmp\b/m.test(fs.readFileSync(tmpfiles, 'utf8')),
    fs.existsSync(tmpfiles) ? fs.readFileSync(tmpfiles, 'utf8').split('\n').filter((l) => l.includes('/tmp')).join(' | ').slice(0, 200) : `${tmpfiles} absent`);
}

const runIV = (env) => spawnSync(process.execPath, [
  path.join(HERE, 'independent-verify.mjs'),
  '--repo', ROOT, '--requirement', 'scratch-root probe (no dispatch is made)',
  '--print-prompt', '--keep-cleanroom',
], { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });

const roomsOf = (stderr) => ({
  scratch: /scratch root: (\S+)/.exec(stderr)?.[1] ?? null,
  room: /clean room: (\S+)/.exec(stderr)?.[1] ?? null,
  record: /record dir: (\S+)/.exec(stderr)?.[1] ?? null,
  modules: /node_modules: ([^\n]+)/.exec(stderr)?.[1] ?? null,
  fsline: stderr.split('\n').find((l) => /filesystem/i.test(l)) ?? null,
});

{
  const r = runIV({});
  const g = roomsOf(r.stderr ?? '');
  if (g.room) { rmLater(g.room); rmLater(g.record); }
  check('a REAL clean-room build lands under the configured scratch root, not /tmp',
    r.status === 0 && !!g.room && g.room.startsWith(scratch.scratchRoot() + path.sep)
      && !g.room.startsWith(os.tmpdir() + path.sep),
    `exit=${r.status} room=${g.room} record=${g.record} scratchRoot=${scratch.scratchRoot()}`);
  check('the record dir (manifest.jsonl + <id>.out — the CITED evidence) moves with it',
    !!g.record && g.record.startsWith(scratch.scratchRoot() + path.sep), String(g.record));
  check('the real node_modules still reflink-copies there, and the tool prints the cost',
    /cp -a --reflink=auto/.test(g.modules ?? '') && /in \d+ms/.test(g.modules ?? ''), String(g.modules));
  check('and the same-filesystem status is REPORTED on the run\'s own output',
    !!g.fsline && /same filesystem/.test(g.fsline), String(g.fsline));
  // The room is real: the export actually happened.
  check('the room is a genuine export (package.json present, contamination stripped)',
    !!g.room && fs.existsSync(path.join(g.room, 'package.json')) && !fs.existsSync(path.join(g.room, 'docs', 'bugs')),
    g.room ? `package.json=${fs.existsSync(path.join(g.room, 'package.json'))} docs/bugs=${fs.existsSync(path.join(g.room, 'docs', 'bugs'))}` : 'no room');
}

if (!SHM || fs.statSync(NM).dev === fs.statSync(SHM).dev) {
  skipped('cross-filesystem configuration is reported by the real tool', 'no second filesystem available');
} else {
  const knob = rmLater(fs.mkdtempSync(path.join(SHM, 'vsr-iv-cross-')));
  const r = runIV({ CLAUDE_STATION_TMPDIR: knob });
  const g = roomsOf(r.stderr ?? '');
  if (g.room) { rmLater(g.room); rmLater(g.record); }
  check('pointing the knob at another filesystem is DETECTED and reported, not silently slow',
    r.status === 0 && !!g.fsline && /DIFFERENT FILESYSTEM/.test(g.fsline)
      && g.fsline.includes('CLAUDE_STATION_TMPDIR'),
    String(g.fsline));
  check('…and the run still completes (a slower copy is worth a loud line, not a refusal to verify)',
    r.status === 0 && !!g.room && g.room.startsWith(knob + path.sep), `exit=${r.status} room=${g.room}`);
}

/* ==================================================================== end */

for (const d of cleanup) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }

section('summary');
console.log(`  PASS ${pass}  FAIL ${fail}  SKIP ${skip}`);
if (sameMs !== null) console.log(`  copy cost: same-filesystem reflink ${sameMs}ms; forced real copy (same fs) ${realMs}ms${crossMs !== null ? `; cross-filesystem ${crossMs}ms` : ''}`);
if (failures.length) console.log(`  failures: ${failures.join(', ')}`);
if (skips.length) console.log(`  skipped: ${skips.join(', ')}`);
process.exit(fail ? 1 : 0);
