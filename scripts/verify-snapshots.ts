/**
 * Verification harness for the reflink snapshot store.
 *
 * Design rules (docs/prompts/WORKING_AGREEMENT.v2.md §C): every check prints the
 * value it OBSERVED, preconditions are asserted before the thing they guard, and
 * no success branch can fire on empty/missing input.
 *
 * Everything runs against THROWAWAY trees under ~/.cache/cs-snapverify-*. The
 * user's real projects are never touched. `/tmp` is deliberately used for ONE
 * check only — it is tmpfs on this machine, which makes it a free, genuine
 * negative test for the cross-filesystem refusal.
 *
 *   node scripts/verify-snapshots.ts             # everything except the live session
 *   node scripts/verify-snapshots.ts --live      # also start a real session (uses the model)
 *   node scripts/verify-snapshots.ts --big       # also the multi-GB extent-sharing proof
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import WebSocket from 'ws';

import * as snaps from '../src/server/snapshots.ts';
import type { Project } from '../src/server/registry.ts';
import { validateProjectPatch } from '../src/server/validate.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
/**
 * Port is chosen at RUN TIME from a free one, not hard-coded.
 *
 * HONEST PROVENANCE: this harness originally hard-coded 4319 and asserted
 * "the server is up" by fetching /api/health. Another process on this machine
 * (a parallel agent's UI mock, which proxies the real station) already owned
 * 4319 — so the precondition passed against SOMEONE ELSE'S SERVER and every
 * snapshot route came back 404. The bug was in the check, not the code under
 * test. Both halves are fixed: pick a free port, and prove identity below.
 */
let PORT = 0;
let BASE = '';
const LIVE = process.argv.includes('--live');
const BIG = process.argv.includes('--big');

/** Scratch root on BTRFS (~/.cache), because /tmp is tmpfs and cannot reflink. */
const SCRATCH = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'cs-snapverify-'));
const DATA = path.join(SCRATCH, 'data');
fs.mkdirSync(DATA, { recursive: true });
process.env.CLAUDE_STATION_DATA = DATA;

let pass = 0;
let fail = 0;
const failures: string[] = [];
const timings: string[] = [];

function check(name: string, ok: boolean, observed: unknown): void {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}\n        observed: ${line}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL  ${name}\n        observed: ${line}`);
  }
}
function section(t: string): void {
  console.log(`\n=== ${t} ===`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------- helpers */

/** Ask the kernel for a port nobody is using, then hand it to the server. */
async function freePort(): Promise<number> {
  const net = await import('node:net');
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => resolve(p));
    });
  });
}

function sh(cmd: string, args: string[]): { out: string; code: number } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, code: r.status ?? -1 };
}

/** Exact allocated data bytes on the btrfs filesystem. */
function btrfsDataUsed(): number {
  sh('sync', []);
  sh('btrfs', ['filesystem', 'sync', os.homedir()]);
  const { out } = sh('btrfs', ['filesystem', 'df', '-b', os.homedir()]);
  const m = out.match(/Data,\s*\w+:\s*total=\d+,\s*used=(\d+)/);
  return m ? Number(m[1]) : NaN;
}

/** Physical extent offsets of a file — identical lists prove shared extents. */
function extentsOf(file: string): string[] {
  const { out } = sh('filefrag', ['-v', file]);
  const rows: string[] = [];
  for (const line of out.split('\n')) {
    // "   0:        0..    2047:      12345..     14392:   2048:"
    const m = line.match(/^\s*\d+:\s*\d+\.\.\s*\d+:\s*(\d+)\.\.\s*(\d+):\s*(\d+):/);
    if (m) rows.push(`${m[1]}-${m[2]}:${m[3]}`);
  }
  return rows;
}

/** Recursive checksum of a tree: path + mode + content for every entry. */
function treeDigest(root: string, skip: Set<string> = new Set()): { digest: string; files: number } {
  const h = crypto.createHash('sha256');
  let files = 0;
  const walk = (rel: string): void => {
    const abs = rel === '' ? root : path.join(root, rel);
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      const childAbs = path.join(abs, e.name);
      if (e.isDirectory()) {
        h.update(`D\0${childRel}\0${(fs.statSync(childAbs).mode & 0o7777).toString(8)}\n`);
        walk(childRel);
      } else if (e.isSymbolicLink()) {
        h.update(`L\0${childRel}\0${fs.readlinkSync(childAbs)}\n`);
        files++;
      } else {
        const st = fs.lstatSync(childAbs);
        h.update(`F\0${childRel}\0${(st.mode & 0o7777).toString(8)}\0`);
        h.update(fs.readFileSync(childAbs));
        h.update('\n');
        files++;
      }
    }
  };
  walk('');
  return { digest: h.digest('hex'), files };
}

function makeProject(id: string, hostPath: string, isolation: Project['isolation'] = 'direct', settings: Partial<Project['settings']> = {}): Project {
  const now = new Date().toISOString();
  return {
    id,
    name: id,
    hostPath,
    isolation,
    settings: {
      model: null, effort: null, maxBudgetUsd: null, permissionMode: 'default',
      allowedTools: [], disallowedTools: [], mounts: [], instructions: [],
      ...settings,
    } as Project['settings'],
    createdAt: now,
    updatedAt: now,
  };
}

/** A realistic-ish source tree: git, src files, and an optional huge node_modules. */
function buildTree(root: string, opts: { srcFiles: number; nodeModulesFiles: number; bigBytes?: number }): void {
  fs.mkdirSync(path.join(root, '.git', 'objects', 'ab'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(root, '.git', 'objects', 'ab', 'cdef'), crypto.randomBytes(4096));
  fs.mkdirSync(path.join(root, 'src', 'server'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
  for (let i = 0; i < opts.srcFiles; i++) {
    const sub = i % 2 ? 'server' : 'lib';
    fs.writeFileSync(path.join(root, 'src', sub, `f${i}.ts`), `// file ${i}\n${'x'.repeat(200 + (i % 500))}\n`);
  }
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"scratch"}\n');
  fs.symlinkSync('./package.json', path.join(root, 'pkg-link'));
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'bundle.js'), 'x'.repeat(100_000));
  if (opts.nodeModulesFiles > 0) {
    for (let p = 0; p < 40; p++) {
      const pkg = path.join(root, 'node_modules', `pkg-${p}`, 'lib');
      fs.mkdirSync(pkg, { recursive: true });
      const per = Math.ceil(opts.nodeModulesFiles / 40);
      for (let i = 0; i < per; i++) fs.writeFileSync(path.join(pkg, `m${i}.js`), `module.exports=${i};\n`);
    }
    // A NESTED node_modules, so the prefix-dir pruning is exercised, not just
    // the trivial top-level case.
    const nested = path.join(root, 'packages', 'inner', 'node_modules', 'dep');
    fs.mkdirSync(nested, { recursive: true });
    for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(nested, `n${i}.js`), `//${i}\n`);
    fs.writeFileSync(path.join(root, 'packages', 'inner', 'index.js'), 'ok\n');
  }
  if (opts.bigBytes) {
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    const f = path.join(root, 'assets', 'big.bin');
    // Incompressible, so btrfs cannot make the space measurement lie.
    const chunk = crypto.randomBytes(8 * 1024 * 1024);
    const fd = fs.openSync(f, 'w');
    for (let w = 0; w < opts.bigBytes; w += chunk.length) fs.writeSync(fd, chunk);
    fs.closeSync(fd);
  }
}

/* ============================================================ 1. mechanism */

async function s1Mechanism(): Promise<void> {
  section('1. reflink mechanism, exclusions, and cost');

  const proj = path.join(SCRATCH, 'p1');
  fs.mkdirSync(proj, { recursive: true });
  buildTree(proj, { srcFiles: 400, nodeModulesFiles: 20_000 });

  const total = treeDigest(proj).files;
  check('precondition: throwaway tree built with a large node_modules', total > 20_000, `${total} files under ${proj}`);

  const p = makeProject('p1', proj);

  // --- with the default exclusions
  const t0 = Date.now();
  const withExcl = snaps.create(p, { reason: 'manual', label: 'with exclusions' });
  const msExcl = Date.now() - t0;

  // --- without any exclusions (the justification for having them)
  const t1 = Date.now();
  const noExcl = snaps.create(p, { reason: 'manual', label: 'no exclusions', exclude: [], dedupe: false });
  const msNone = Date.now() - t1;

  timings.push(`realistic tree (${total} files, of which ${total - withExcl.meta.fileCount} excluded):`);
  timings.push(`  WITH default exclusions : ${msExcl} ms, ${withExcl.meta.fileCount} files, ${withExcl.meta.cpInvocations} cp fork(s)`);
  timings.push(`  WITHOUT exclusions      : ${msNone} ms, ${noExcl.meta.fileCount} files, ${noExcl.meta.cpInvocations} cp fork(s)`);
  timings.push(`  speedup from exclusions : ${(msNone / Math.max(1, msExcl)).toFixed(1)}x`);

  check(
    'exclusions cut the file count',
    withExcl.meta.fileCount < noExcl.meta.fileCount / 2,
    `${withExcl.meta.fileCount} files with exclusions vs ${noExcl.meta.fileCount} without`,
  );
  check(
    'exclusions cut the wall time',
    msExcl < msNone,
    `${msExcl} ms with exclusions vs ${msNone} ms without (${(msNone / Math.max(1, msExcl)).toFixed(1)}x)`,
  );
  check(
    'cp fork count stays proportional to exclusions, not to tree size',
    withExcl.meta.cpInvocations < 20,
    `${withExcl.meta.cpInvocations} cp invocation(s) for a ${total}-file tree`,
  );

  const tree = snaps.snapshotTree('p1', withExcl.meta.id);
  check('.git IS captured (never excluded)', fs.existsSync(path.join(tree, '.git', 'HEAD')), `${path.join(tree, '.git', 'HEAD')} exists`);
  check('node_modules is NOT captured', !fs.existsSync(path.join(tree, 'node_modules')), `node_modules present in snapshot: ${fs.existsSync(path.join(tree, 'node_modules'))}`);
  check(
    'NESTED node_modules is also skipped',
    !fs.existsSync(path.join(tree, 'packages', 'inner', 'node_modules')) && fs.existsSync(path.join(tree, 'packages', 'inner', 'index.js')),
    `nested skipped, sibling index.js kept: ${fs.existsSync(path.join(tree, 'packages', 'inner', 'index.js'))}`,
  );
  check('dist is excluded by default', !fs.existsSync(path.join(tree, 'dist')), `dist in snapshot: ${fs.existsSync(path.join(tree, 'dist'))}`);
  check(
    'excludedFound reports the real paths that were skipped',
    withExcl.meta.excludedFound.includes('node_modules') && withExcl.meta.excludedFound.includes('packages/inner/node_modules'),
    JSON.stringify(withExcl.meta.excludedFound),
  );
  check('symlinks preserved as symlinks', fs.lstatSync(path.join(tree, 'pkg-link')).isSymbolicLink(), `pkg-link -> ${fs.readlinkSync(path.join(tree, 'pkg-link'))}`);

  // Content fidelity of the captured subset.
  const skip = new Set(withExcl.meta.exclusions);
  const a = treeDigest(proj, skip);
  const b = treeDigest(tree, skip);
  check('snapshot is byte-identical to the source (excluded dirs aside)', a.digest === b.digest, `source ${a.digest.slice(0, 16)}… (${a.files} files) vs snapshot ${b.digest.slice(0, 16)}… (${b.files} files)`);

  // --- extent sharing, proven directly
  const big = path.join(proj, 'shared.bin');
  fs.writeFileSync(big, crypto.randomBytes(32 * 1024 * 1024));
  const shared = snaps.create(p, { reason: 'manual', label: 'extent proof', dedupe: false });
  const copy = path.join(snaps.snapshotTree('p1', shared.meta.id), 'shared.bin');
  const eOrig = extentsOf(big);
  const eCopy = extentsOf(copy);
  check('precondition: filefrag reported extents for both files', eOrig.length > 0 && eCopy.length > 0, `orig ${eOrig.length} extent(s), copy ${eCopy.length} extent(s)`);
  check(
    'reflink genuinely SHARES extents (identical physical offsets)',
    eOrig.length > 0 && JSON.stringify(eOrig) === JSON.stringify(eCopy),
    `first 3 physical extents — orig ${JSON.stringify(eOrig.slice(0, 3))} / copy ${JSON.stringify(eCopy.slice(0, 3))}`,
  );

  snaps.remove('p1', noExcl.meta.id);
  snaps.remove('p1', shared.meta.id);
  fs.rmSync(big, { force: true });
}

/* ====================================================== 2. space, at scale */

async function s2Space(): Promise<void> {
  section('2. real disk consumption of a multi-GB snapshot');
  if (!BIG) {
    console.log('  SKIPPED (pass --big to run the multi-GB extent-sharing measurement)');
    return;
  }
  const proj = path.join(SCRATCH, 'p2');
  fs.mkdirSync(proj, { recursive: true });
  buildTree(proj, { srcFiles: 50, nodeModulesFiles: 0, bigBytes: 2 * 1024 * 1024 * 1024 });
  const apparent = Number(sh('du', ['-sb', '--apparent-size', proj]).out.split(/\s+/)[0]);
  check('precondition: multi-GB throwaway tree exists', apparent > 2e9, `${(apparent / 1e9).toFixed(2)} GB apparent at ${proj}`);

  const p = makeProject('p2', proj);
  const before = btrfsDataUsed();
  check('precondition: btrfs data usage readable', Number.isFinite(before), `${(before / 1e9).toFixed(3)} GB allocated before`);
  const t0 = Date.now();
  const r = snaps.create(p, { reason: 'manual' });
  const ms = Date.now() - t0;
  const after = btrfsDataUsed();
  const delta = after - before;

  timings.push(`multi-GB tree: ${(apparent / 1e9).toFixed(2)} GB apparent captured in ${ms} ms`);
  check(
    'a 2 GB snapshot consumes ~0 additional bytes',
    delta < 100e6,
    `btrfs allocated data grew by ${(delta / 1e6).toFixed(1)} MB for a ${(r.meta.sizeBytes / 1e9).toFixed(2)} GB apparent snapshot ` +
      `(${((delta / r.meta.sizeBytes) * 100).toFixed(3)}% of apparent)`,
  );
  check('and it was near-instant', ms < 5000, `${ms} ms for ${(apparent / 1e9).toFixed(2)} GB`);
  fs.rmSync(proj, { recursive: true, force: true });
  fs.rmSync(snaps.projectSnapshotDir('p2'), { recursive: true, force: true });
}

/* ========================================================= 3. restore */

async function s3Restore(): Promise<void> {
  section('3. restore fidelity, pre-restore undo, and what is NOT recovered');

  const proj = path.join(SCRATCH, 'p3');
  fs.mkdirSync(proj, { recursive: true });
  buildTree(proj, { srcFiles: 120, nodeModulesFiles: 400 });
  const p = makeProject('p3', proj);

  const skip = new Set(['node_modules', 'dist']);
  const before = treeDigest(proj, skip);
  check('precondition: source tree digested before any damage', before.files > 100, `${before.files} files, digest ${before.digest.slice(0, 16)}…`);

  const snap = snaps.create(p, { reason: 'session-start', sessionId: 'cs-fake' });
  check('session-start snapshot created', !!snaps.get('p3', snap.meta.id), `${snap.meta.id}, ${snap.meta.fileCount} files, ${snap.meta.durationMs} ms`);

  // --- destroy things, the way a bad `rm -rf` would
  fs.rmSync(path.join(proj, 'src', 'server'), { recursive: true, force: true });
  fs.rmSync(path.join(proj, '.git'), { recursive: true, force: true });
  fs.rmSync(path.join(proj, 'package.json'), { force: true });
  fs.writeFileSync(path.join(proj, 'src', 'lib', 'f0.ts'), 'CORRUPTED\n');
  fs.writeFileSync(path.join(proj, 'BRAND-NEW.txt'), 'created after the snapshot\n');
  const damaged = treeDigest(proj, skip);
  check(
    'precondition: the tree really was damaged (rm -rf of a subdir AND .git)',
    damaged.digest !== before.digest && !fs.existsSync(path.join(proj, '.git')) && !fs.existsSync(path.join(proj, 'src', 'server')),
    `digest now ${damaged.digest.slice(0, 16)}… (${damaged.files} files), .git gone: ${!fs.existsSync(path.join(proj, '.git'))}`,
  );

  // node_modules must survive untouched — record it to prove that.
  const nmBefore = treeDigest(path.join(proj, 'node_modules'));

  const report = snaps.restore(p, snap.meta.id);
  const after = treeDigest(proj, skip);

  check('restore recovers the tree BYTE-IDENTICALLY', after.digest === before.digest, `before ${before.digest.slice(0, 16)}… (${before.files} files) / after ${after.digest.slice(0, 16)}… (${after.files} files)`);
  check('the rm -rf’d .git is back', fs.existsSync(path.join(proj, '.git', 'HEAD')), `.git/HEAD exists: ${fs.existsSync(path.join(proj, '.git', 'HEAD'))}`);
  check('the rm -rf’d src/server is back', fs.existsSync(path.join(proj, 'src', 'server')), `${fs.readdirSync(path.join(proj, 'src', 'server')).length} files restored under src/server`);
  check(
    'a file created AFTER the snapshot is removed, and reported as removed',
    !fs.existsSync(path.join(proj, 'BRAND-NEW.txt')) && report.removed.includes('BRAND-NEW.txt'),
    `removed = ${JSON.stringify(report.removed)}`,
  );
  const nmAfter = treeDigest(path.join(proj, 'node_modules'));
  check(
    'excluded node_modules left EXACTLY as it was (not restored, not deleted)',
    nmBefore.digest === nmAfter.digest && report.preservedExcluded.includes('node_modules'),
    `node_modules digest unchanged (${nmAfter.files} files); preservedExcluded = ${JSON.stringify(report.preservedExcluded)}`,
  );
  check('report names the pre-restore undo point', !!snaps.get('p3', report.preRestoreSnapshotId), `preRestoreSnapshotId = ${report.preRestoreSnapshotId}`);

  // --- undo the undo
  const undo = snaps.restore(p, report.preRestoreSnapshotId);
  const undone = treeDigest(proj, skip);
  check(
    'restoring the pre-restore snapshot returns the DAMAGED state (undo the undo)',
    undone.digest === damaged.digest,
    `damaged ${damaged.digest.slice(0, 16)}… / after undo ${undone.digest.slice(0, 16)}…`,
  );
  check('and BRAND-NEW.txt came back with it', fs.existsSync(path.join(proj, 'BRAND-NEW.txt')), `exists: ${fs.existsSync(path.join(proj, 'BRAND-NEW.txt'))}`);
  check('the undo itself made its own undo point', !!snaps.get('p3', undo.preRestoreSnapshotId), `${undo.preRestoreSnapshotId}`);

  // Back to good, for the timing note.
  const t0 = Date.now();
  snaps.restore(p, snap.meta.id);
  timings.push(`restore of a ${snap.meta.fileCount}-file tree (incl. its pre-restore snapshot): ${Date.now() - t0} ms`);
  check('final state is the good tree again', treeDigest(proj, skip).digest === before.digest, `digest ${treeDigest(proj, skip).digest.slice(0, 16)}…`);
}

/* ========================= 3b. restore at the keep limit (BUG-007) ========= */

/**
 * REGRESSION for BUG-007. A project AT its keep limit, restoring the OLDEST
 * snapshot. The restore takes a pre-restore snapshot first, which publishes an
 * extra entry and then prunes back to `keep`. The list is newest-first, so the
 * OLDEST = the restore target is the first thing prune would delete — and its
 * tree is exactly what restore is about to read. On the unfixed code the target
 * vanishes and restore dies with 'stage-failed' (a no-op restore that destroys
 * its own backup). This section FAILS on that code and passes once the target
 * is protected from the pre-restore prune.
 */
async function s3bRestoreAtKeepLimit(): Promise<void> {
  section('3b. restoring the OLDEST snapshot while AT the keep limit (BUG-007)');

  const KEEP = 3;
  const proj = path.join(SCRATCH, 'p3b');
  fs.mkdirSync(proj, { recursive: true });
  buildTree(proj, { srcFiles: 20, nodeModulesFiles: 0 });
  // keep is read via snapshotSettingsOf(project) inside create/prune.
  const skip = new Set(['node_modules', 'dist']);
  const p = makeProject('p3b', proj, 'direct', { snapshots: { enabled: null, keep: KEEP, exclude: [...skip] } });

  // Fill to EXACTLY the keep limit, each snapshot a genuinely distinct state.
  const ids: string[] = [];
  for (let i = 0; i < KEEP; i++) {
    fs.writeFileSync(path.join(proj, `state-${i}.txt`), `state ${i}\n`);
    const r = snaps.create(p, { reason: 'manual', label: `state ${i}`, dedupe: false });
    ids.push(r.meta.id);
    await sleep(3); // distinct createdAt so newest-first ordering is unambiguous
  }
  const listed = snaps.list('p3b');
  check(
    `precondition: project is AT the keep limit (${KEEP} snapshots, newest-first)`,
    listed.length === KEEP && ids.length === KEEP,
    `${listed.length} snapshots; ids oldest→newest ${JSON.stringify(ids)}`,
  );

  // The OLDEST snapshot is the restore target — the one prune would evict.
  const targetId = ids[0];
  check(
    'precondition: the target is the OLDEST (last in the newest-first list)',
    listed[listed.length - 1].id === targetId,
    `list tail = ${listed[listed.length - 1].id}, target = ${targetId}`,
  );
  const targetTree = snaps.snapshotTree('p3b', targetId);
  const targetBefore = treeDigest(targetTree);
  check(
    'precondition: the target snapshot tree is readable and digested',
    targetBefore.files > 0 && fs.existsSync(targetTree),
    `${targetBefore.files} files, digest ${targetBefore.digest.slice(0, 16)}…`,
  );

  // The act under test: restore the oldest while at the limit.
  let report: snaps.RestoreReport | null = null;
  let restoreErr: Error | null = null;
  try {
    report = snaps.restore(p, targetId);
  } catch (err) {
    restoreErr = err as Error;
  }

  // (a) it SUCCEEDS. Unfixed code throws SnapshotError('stage-failed').
  check(
    '(a) restoring the oldest snapshot at the keep limit SUCCEEDS',
    report !== null && restoreErr === null,
    restoreErr
      ? `restore threw ${(restoreErr as snaps.SnapshotError).code ?? ''}: ${restoreErr.message.slice(0, 140)}`
      : `restored ${report?.restored.length} top-level entries, undo point ${report?.preRestoreSnapshotId}`,
  );

  // (b) the target snapshot still exists and its tree is byte-intact.
  const targetMeta = snaps.get('p3b', targetId);
  const targetTreeStillThere = fs.existsSync(targetTree);
  const targetAfter = targetTreeStillThere ? treeDigest(targetTree) : { digest: 'MISSING', files: 0 };
  check(
    '(b) the target snapshot still exists after the restore',
    !!targetMeta && targetTreeStillThere,
    `meta present: ${!!targetMeta}, tree present: ${targetTreeStillThere} at ${targetTree}`,
  );
  check(
    '(b) the target snapshot tree is byte-identical to before (not clobbered)',
    targetAfter.digest === targetBefore.digest,
    `before ${targetBefore.digest.slice(0, 16)}… (${targetBefore.files} files) / after ${targetAfter.digest.slice(0, 16)}… (${targetAfter.files} files)`,
  );

  // (c) no snapshot silently lost: every id we made is still listed, plus the
  //     one pre-restore snapshot that restore is entitled to add.
  const afterIds = new Set(snaps.list('p3b').map((m) => m.id));
  const survivors = ids.filter((id) => afterIds.has(id));
  check(
    '(c) every pre-existing snapshot survived the restore (none silently pruned away)',
    survivors.length === ids.length,
    `${survivors.length}/${ids.length} originals survive; lost = ${JSON.stringify(ids.filter((id) => !afterIds.has(id)))}`,
  );
  check(
    '(c) and the project tree now matches the restored (oldest) snapshot',
    report !== null && treeDigest(proj, skip).digest === treeDigest(targetTree, skip).digest,
    `project digest ${treeDigest(proj, skip).digest.slice(0, 16)}… vs target ${treeDigest(targetTree, skip).digest.slice(0, 16)}…`,
  );

  fs.rmSync(proj, { recursive: true, force: true });
  fs.rmSync(snaps.projectSnapshotDir('p3b'), { recursive: true, force: true });
}

/* ============================================ 4. failure modes / hygiene */

async function s4Failures(): Promise<void> {
  section('4. loud failures, dedupe, prune');

  // --- cross-filesystem: project on btrfs, store on tmpfs
  const proj = path.join(SCRATCH, 'p4');
  fs.mkdirSync(proj, { recursive: true });
  buildTree(proj, { srcFiles: 5, nodeModulesFiles: 0 });
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-snapverify-tmpfs-'));
  check('precondition: /tmp really is a non-reflink filesystem', snaps.fsTypeOf(tmpData) !== 'btrfs', `fsType(${tmpData}) = ${snaps.fsTypeOf(tmpData)}`);

  const realData = process.env.CLAUDE_STATION_DATA;
  process.env.CLAUDE_STATION_DATA = tmpData;
  let crossErr: snaps.SnapshotError | null = null;
  try {
    snaps.create(makeProject('p4', proj), { reason: 'manual' });
  } catch (err) {
    crossErr = err instanceof snaps.SnapshotError ? err : null;
  }
  process.env.CLAUDE_STATION_DATA = realData;
  check(
    'cross-filesystem store FAILS LOUDLY with the real reason (no silent full copy)',
    crossErr?.code === 'cross-filesystem' && /DIFFERENT filesystems/.test(crossErr.message),
    crossErr ? `code=${crossErr.code}: ${crossErr.message.slice(0, 170)}…` : 'NO ERROR RAISED — it silently succeeded',
  );
  check(
    'and it says explicitly that nothing was copied',
    !!crossErr && /No copy was made/i.test(crossErr.message),
    crossErr ? `message contains the no-copy statement: ${/No copy was made/i.test(crossErr.message)}` : 'n/a',
  );
  const leaked = fs.readdirSync(tmpData);
  check('nothing was written to the doomed store', leaked.length === 0 || !leaked.includes('snapshots'), `entries in ${tmpData}: ${JSON.stringify(leaked)}`);
  fs.rmSync(tmpData, { recursive: true, force: true });

  // --- non-reflink SOURCE (project on tmpfs, store on btrfs) also refuses
  const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-snapverify-src-'));
  buildTree(tmpProj, { srcFiles: 3, nodeModulesFiles: 0 });
  let srcErr: snaps.SnapshotError | null = null;
  try {
    snaps.create(makeProject('p4b', tmpProj), { reason: 'manual' });
  } catch (err) {
    srcErr = err instanceof snaps.SnapshotError ? err : null;
  }
  check(
    'a project on a non-reflink filesystem also fails loudly',
    srcErr !== null && (srcErr.code === 'cross-filesystem' || srcErr.code === 'reflink-unsupported'),
    srcErr ? `code=${srcErr.code}: ${srcErr.message.slice(0, 140)}…` : 'NO ERROR RAISED',
  );
  fs.rmSync(tmpProj, { recursive: true, force: true });
  fs.rmSync(snaps.projectSnapshotDir('p4b'), { recursive: true, force: true });

  // --- store inside the project
  const parentProj = path.dirname(DATA);
  let insideErr: snaps.SnapshotError | null = null;
  try {
    snaps.create(makeProject('p4c', parentProj), { reason: 'manual' });
  } catch (err) {
    insideErr = err instanceof snaps.SnapshotError ? err : null;
  }
  check(
    'a store INSIDE the project is refused (would snapshot itself)',
    insideErr?.code === 'store-inside-project',
    insideErr ? `code=${insideErr.code}: ${insideErr.message.slice(0, 130)}…` : 'NO ERROR RAISED',
  );

  // --- dedupe
  const p = makeProject('p4', proj);
  const first = snaps.create(p, { reason: 'manual', dedupe: false });
  const second = snaps.create(p, { reason: 'session-start', sessionId: 'x', dedupe: true });
  check('an unchanged tree dedupes instead of copying again', second.deduped && second.meta.id === first.meta.id, `deduped=${second.deduped}, id=${second.meta.id} (same as ${first.meta.id})`);
  fs.writeFileSync(path.join(proj, 'changed.txt'), 'now different\n');
  const third = snaps.create(p, { reason: 'session-start', sessionId: 'y', dedupe: true });
  check('a changed tree does NOT dedupe', !third.deduped && third.meta.id !== first.meta.id, `deduped=${third.deduped}, new id=${third.meta.id}`);

  // --- prune
  for (let i = 0; i < 8; i++) {
    fs.writeFileSync(path.join(proj, `bump-${i}.txt`), `${i}\n`);
    snaps.create(p, { reason: 'manual', label: `n${i}`, keep: 100 });
    await sleep(2); // distinct createdAt ordering
  }
  const beforePrune = snaps.list('p4');
  check('precondition: more snapshots than the keep limit exist', beforePrune.length > 3, `${beforePrune.length} snapshots before prune`);
  const removed = snaps.prune('p4', 3);
  const afterPrune = snaps.list('p4');
  const expectNewest = beforePrune.slice(0, 3).map((m) => m.id);
  check('prune keeps exactly `keep`', afterPrune.length === 3, `${afterPrune.length} remain (asked for 3), removed ${removed.length}`);
  check('prune keeps the NEWEST ones', JSON.stringify(afterPrune.map((m) => m.id)) === JSON.stringify(expectNewest), `kept ${JSON.stringify(afterPrune.map((m) => m.id))}`);

  // --- a failed snapshot must not break session start
  const bad = makeProject('p4d', path.join(SCRATCH, 'does-not-exist'), 'container');
  const errs: string[] = [];
  const r = snaps.snapshotOnSessionStart(bad, 'cs-test', { onError: (m) => errs.push(m) });
  check(
    'snapshotOnSessionStart reports "failed" instead of throwing',
    r.status === 'failed' && r.meta === null && errs.length === 1,
    `status=${r.status}, code=${r.code}, reported: ${errs[0]?.split('\n')[0]?.slice(0, 110)}…`,
  );
  check('and it says the session is proceeding without a restore point', /starting anyway/i.test(errs[0] ?? ''), `${(errs[0] ?? '').split('\n')[1] ?? ''}`);
  // The distinction the UI has to render. Observed in verify:ui: a `direct`
  // project with snapshots off was announced as "the start snapshot failed".
  const offProj = makeProject('p4e', proj, 'direct');
  const off = snaps.snapshotOnSessionStart(offProj, 'cs-test');
  check(
    '"snapshots disabled" is a DIFFERENT status from "snapshot failed"',
    off.status === 'disabled' && off.status !== r.status,
    `direct project -> status=${off.status}, reason=${off.reason}`,
  );
  const onProj = makeProject('p4f', proj, 'container');
  check("and container isolation auto-enables it", snaps.snapshotOnSessionStart(onProj, 'cs-test').status !== 'disabled', `container project -> status=${snaps.snapshotOnSessionStart(onProj, 'cs-test2').status}`);

  // --- settings validation goes through the ONE validator
  const cases: [string, unknown, boolean][] = [
    ['keep + exclude accepted', { snapshots: { keep: 5, exclude: ['node_modules'] } }, true],
    ['enabled:null (auto) accepted', { snapshots: { enabled: null } }, true],
    ['.git in exclude rejected', { snapshots: { exclude: ['.git'] } }, false],
    ['a path in exclude rejected', { snapshots: { exclude: ['a/b'] } }, false],
    ['keep:0 rejected', { snapshots: { keep: 0 } }, false],
    ['unknown snapshots field rejected', { snapshots: { nope: 1 } }, false],
    ['enabled as a string rejected', { snapshots: { enabled: 'yes' } }, false],
  ];
  for (const [name, body, shouldPass] of cases) {
    let ok = false;
    let msg = '';
    try {
      validateProjectPatch(body);
      ok = true;
    } catch (e) {
      msg = (e as Error).message;
    }
    check(`validator: ${name}`, ok === shouldPass, ok ? 'accepted' : `rejected: ${msg.slice(0, 100)}`);
  }
}

/* ============================================================ 5. HTTP API */

let server: ChildProcess | null = null;

async function req(method: string, p: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(BASE + p, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function s5Http(): Promise<void> {
  section('5. HTTP endpoints (the contract the UI codes against)');

  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let health: any = null;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) { health = await r.json(); break; }
    } catch { /* not yet */ }
    await sleep(100);
  }
  /*
   * IDENTITY, not liveness. `pid` and `dataDir` come from THIS server's own
   * /api/health, so a stranger answering on the port cannot satisfy this.
   */
  const mine = !!health && health.pid === server.pid && health.dataDir === DATA;
  check(
    'precondition: the server answering is OUR server (pid + dataDir match)',
    mine,
    health ? `health.pid=${health.pid} (spawned ${server.pid}), health.dataDir=${health.dataDir} (expected ${DATA})` : 'no /api/health response at all',
  );
  if (!mine) {
    console.log('  ABORTING section 5: refusing to run checks against a server that is not the one under test.');
    return;
  }

  const proj = path.join(SCRATCH, 'p5');
  fs.mkdirSync(proj, { recursive: true });
  buildTree(proj, { srcFiles: 30, nodeModulesFiles: 300 });

  const created = await req('POST', '/api/projects', { hostPath: proj, name: 'snapverify', isolation: 'container' });
  check('precondition: throwaway project registered', created.status === 201, `status ${created.status}, id ${created.body?.project?.id}`);
  const pid = created.body.project.id;

  const empty = await req('GET', `/api/projects/${pid}/snapshots`);
  check('GET snapshots on a fresh project returns an empty list + resolved settings', empty.status === 200 && Array.isArray(empty.body.snapshots) && empty.body.snapshots.length === 0, `status ${empty.status}, ${empty.body.snapshots?.length} snapshots, settings ${JSON.stringify(empty.body.settings)}`);
  check(
    "isolation 'container' resolves snapshots to enabled by default",
    empty.body.settings?.enabled === true && empty.body.settings?.source === 'auto-container',
    `enabled=${empty.body.settings?.enabled}, source=${empty.body.settings?.source}, keep=${empty.body.settings?.keep}`,
  );

  const made = await req('POST', `/api/projects/${pid}/snapshots`, { label: 'from the API' });
  check('POST snapshots takes one now', made.status === 201 && !!made.body.snapshot?.id, `status ${made.status}, ${JSON.stringify(made.body.snapshot)}`);
  const snapId = made.body.snapshot.id;

  const listed = await req('GET', `/api/projects/${pid}/snapshots`);
  const row = listed.body.snapshots[0];
  const CONTRACT = ['id', 'sessionId', 'createdAt', 'reason', 'label', 'fileCount', 'sizeBytes', 'durationMs'];
  check(
    'every field of the documented UI contract is present',
    CONTRACT.every((k) => k in row),
    `missing: ${JSON.stringify(CONTRACT.filter((k) => !(k in row)))}; row = ${JSON.stringify(row)}`,
  );

  // direct isolation must default to OFF
  await req('PATCH', `/api/projects/${pid}`, { isolation: 'direct' });
  const asDirect = await req('GET', `/api/projects/${pid}/snapshots`);
  check("isolation 'direct' resolves snapshots to disabled by default", asDirect.body.settings.enabled === false && asDirect.body.settings.source === 'auto-off', `enabled=${asDirect.body.settings.enabled}, source=${asDirect.body.settings.source}`);
  await req('PATCH', `/api/projects/${pid}`, { snapshots: { enabled: true } });
  const optedIn = await req('GET', `/api/projects/${pid}/snapshots`);
  check("'direct' can opt in explicitly", optedIn.body.settings.enabled === true && optedIn.body.settings.source === 'project', `enabled=${optedIn.body.settings.enabled}, source=${optedIn.body.settings.source}`);
  check(
    'partial PATCH did not drop sibling snapshot settings',
    optedIn.body.settings.keep === 10 && optedIn.body.settings.exclude.includes('node_modules'),
    `keep=${optedIn.body.settings.keep}, exclude has ${optedIn.body.settings.exclude.length} entries`,
  );

  const badPatch = await req('PATCH', `/api/projects/${pid}`, { snapshots: { exclude: ['.git'] } });
  check('PATCH rejecting .git comes back as a 400 with the reason', badPatch.status === 400 && /\.git/.test(badPatch.body.error), `status ${badPatch.status}: ${badPatch.body.error?.slice(0, 110)}`);

  // restore via the API
  fs.rmSync(path.join(proj, 'src'), { recursive: true, force: true });
  const restored = await req('POST', `/api/projects/${pid}/snapshots/${snapId}/restore`);
  check('POST restore succeeds and recreates the deleted dir', restored.status === 200 && fs.existsSync(path.join(proj, 'src')), `status ${restored.status}, src/ back: ${fs.existsSync(path.join(proj, 'src'))}`);
  check(
    'the restore response tells the truth about what it did NOT recover',
    Array.isArray(restored.body.preservedExcluded) && typeof restored.body.note === 'string' && /Excluded directories were NOT captured/.test(restored.body.note),
    `note: ${restored.body.note?.slice(0, 190)}…`,
  );
  check('restore reports its pre-restore undo point', !!restored.body.preRestoreSnapshotId, `${restored.body.preRestoreSnapshotId}`);

  const del = await req('DELETE', `/api/projects/${pid}/snapshots/${snapId}`);
  check('DELETE removes a snapshot', del.status === 200 && del.body.deleted === snapId, `status ${del.status}, ${JSON.stringify(del.body)}`);
  const gone = await req('POST', `/api/projects/${pid}/snapshots/${snapId}/restore`);
  check('restoring a deleted snapshot 404s', gone.status === 404, `status ${gone.status}: ${gone.body.error?.slice(0, 90)}`);
  const traversal = await req('DELETE', `/api/projects/${pid}/snapshots/..%2F..%2Fregistry.json`);
  check('path traversal in a snapshot id is refused', traversal.status >= 400 && fs.existsSync(path.join(DATA, 'registry.json')), `status ${traversal.status}, registry.json intact: ${fs.existsSync(path.join(DATA, 'registry.json'))}`);

  await req('DELETE', `/api/projects/${pid}`);
}

/* ================================================ 6. live-session refusal */

async function s6Live(): Promise<void> {
  section('6. 409 while a session is live, and ?force=1 casualties');
  if (!LIVE) {
    console.log('  SKIPPED (pass --live to start a real session and prove the 409). UNVERIFIED without it.');
    return;
  }
  const proj = path.join(SCRATCH, 'p6');
  fs.mkdirSync(proj, { recursive: true });
  buildTree(proj, { srcFiles: 10, nodeModulesFiles: 0 });
  const created = await req('POST', '/api/projects', { hostPath: proj, name: 'snapverify-live', isolation: 'direct', snapshots: { enabled: true } });
  const pid = created.body.project.id;

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const events: any[] = [];
  let ack: any = null;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for session-init')), 120_000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'start', projectId: pid, prompt: 'Reply with exactly: READY. Do not use any tools.' })));
    ws.on('message', (raw) => {
      const e = JSON.parse(String(raw));
      events.push(e);
      if (e.t === 'ack' && e.of === 'start') ack = e;
      if (e.t === 'session-init') { clearTimeout(timer); resolve(); }
      if (e.t === 'error' && e.fatal) { clearTimeout(timer); reject(new Error(e.message)); }
    });
    ws.on('error', reject);
  });

  check('precondition: a real session is live on the project', !!ack, `stationSessionId=${ack?.stationSessionId}`);
  check(
    'the session-start snapshot was taken automatically',
    !!ack?.startSnapshotId && ack?.startSnapshotStatus === 'taken',
    `startSnapshotId=${ack?.startSnapshotId}, status=${ack?.startSnapshotStatus}; status lines: ${events.filter((e) => e.t === 'status' && /snapshot/.test(e.status)).map((e) => e.status).join(' | ')}`,
  );
  const auto = await req('GET', `/api/projects/${pid}/snapshots`);
  const sessionStart = auto.body.snapshots.find((s: any) => s.reason === 'session-start');
  check('it is listed with reason "session-start"', !!sessionStart, `${JSON.stringify(sessionStart)}`);
  check('and the SDK session id was back-filled onto it', !!sessionStart?.sdkSessionId, `sdkSessionId=${sessionStart?.sdkSessionId}`);

  const refused = await req('POST', `/api/projects/${pid}/snapshots/${sessionStart.id}/restore`);
  check('restore is REFUSED with 409 while a session is live', refused.status === 409 && refused.body.code === 'live-sessions', `status ${refused.status}, code ${refused.body.code}`);
  check(
    'the 409 names the sessions and the disruption',
    Array.isArray(refused.body.liveSessions) && refused.body.liveSessions.length === 1 && typeof refused.body.liveSessions[0].disruption === 'string',
    JSON.stringify(refused.body.liveSessions),
  );

  const forced = await req('POST', `/api/projects/${pid}/snapshots/${sessionStart.id}/restore?force=1`);
  check('?force=1 proceeds', forced.status === 200, `status ${forced.status}`);
  check(
    '?force=1 reports exactly what it disrupted',
    Array.isArray(forced.body.forcedOverLiveSessions) && forced.body.forcedOverLiveSessions.length === 1,
    JSON.stringify(forced.body.forcedOverLiveSessions),
  );

  ws.send(JSON.stringify({ type: 'close' }));
  ws.close();
  await sleep(500);
  await req('DELETE', `/api/projects/${pid}?force=1`);
}

/* ---------------------------------------------------------------- driver */

async function main(): Promise<void> {
  console.log(`scratch: ${SCRATCH}  (btrfs: ${snaps.fsTypeOf(SCRATCH)})`);
  await s1Mechanism();
  await s2Space();
  await s3Restore();
  await s3bRestoreAtKeepLimit();
  await s4Failures();
  await s5Http();
  await s6Live();
}

main()
  .catch((err) => {
    fail++;
    console.error(`\nHARNESS ERROR: ${(err as Error).stack}`);
  })
  .finally(async () => {
    if (server?.pid) {
      try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ }
      await sleep(800);
      try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
    }
    console.log('\n--- measured timings ---');
    for (const t of timings) console.log(`  ${t}`);
    const mode = `${BIG ? 'with' : 'WITHOUT'} --big, ${LIVE ? 'with' : 'WITHOUT'} --live`;
    console.log(`\n================ ${pass} passed, ${fail} failed, ${pass + fail} checks ran [${mode}] ================`);
    if (!LIVE) console.log('NOTE: section 6 (live-session 409 / force casualties / auto session-start snapshot) did NOT run.');
    if (!BIG) console.log('NOTE: section 2 (multi-GB space measurement) did NOT run.');
    if (fail) console.log(`failed: ${failures.join(', ')}`);
    // Hermetic: everything this harness made lives under SCRATCH.
    fs.rmSync(SCRATCH, { recursive: true, force: true });
    console.log(`(scratch removed: ${SCRATCH}, still present: ${fs.existsSync(SCRATCH)})`);
    process.exit(fail ? 1 : 0);
  });
