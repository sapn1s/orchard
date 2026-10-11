#!/usr/bin/env node
/**
 * verify-bug-240-temp-index.mjs — BUG-240 live-hole fix (FEAT-134 temp-index exception).
 *
 * The FEAT-135 shim allows snapshot plumbing (read-tree/add/write-tree/commit-tree)
 * without a grant when GIT_INDEX_FILE is a throwaway index under the OS temp dir.
 * The old test was a prefix check on path.resolve(GIT_INDEX_FILE), so:
 *   H1  a temp-dir SYMLINK to a real repo's index passed, and `git add` wrote the
 *       real index through it (the repo here lives OUTSIDE tmp, like a production repo);
 *   H2  a repo living under tmp passed with its OWN index;
 *   H3  a RELATIVE GIT_INDEX_FILE was resolved against the shim's cwd, but git
 *       resolves it after `-C` (onto a symlink to the real index);
 *   H4  a linked worktree's index (…/.git/worktrees/<w>/index) under tmp passed.
 * Each probe asserts on the TARGET index bytes, not just the exit code.
 *
 *   node scripts/verify-bug-240-temp-index.mjs        # current shim: holes CLOSED, snapshots still work
 *   node scripts/verify-bug-240-temp-index.mjs --pre  # pinned pre-change shim: holes OPEN (must-FAIL-before)
 *
 * Fixture repos are built with real git directly (CONVENTIONS: fixture repos built
 * by a verify script). The probes go through a freshly installed shim with NO host
 * grant, so an allow can only come from the temp-index exception under test.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempScratch } from './lib/scratch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRE = process.argv.includes('--pre');
const MOD = PRE ? path.join(HERE, 'fixtures', 'bug-240', 'pre-git-shim.mjs') : path.join(HERE, 'lib', 'git-shim.mjs');
const { installGitShim } = await import(pathToFileURL(MOD).href);

let pass = 0, fail = 0;
const failed = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failed.push(name); console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
};

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bug240-idx-')));
const OUT = fs.realpathSync(mkdtempScratch('bug240-idx-out-')); // outside tmp, like a real project
const baseEnv = { ...process.env };
for (const k of Object.keys(baseEnv)) if (k.startsWith('GIT_')) delete baseEnv[k];
const prior = baseEnv.ORCHARD_GIT_SHIM_DIR;
baseEnv.PATH = (baseEnv.PATH ?? '').split(path.delimiter).filter((p) => p && p !== prior && !/orchard-git-shim-/.test(p)).join(path.delimiter);
delete baseEnv.ORCHARD_GIT_SHIM_DIR;
Object.assign(baseEnv, { GIT_AUTHOR_NAME: 'v', GIT_AUTHOR_EMAIL: 'verify@example.invalid', GIT_COMMITTER_NAME: 'v', GIT_COMMITTER_EMAIL: 'verify@example.invalid', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(TMP, 'gitconfig') });
fs.writeFileSync(path.join(TMP, 'gitconfig'), '[init]\n\tdefaultBranch = main\n');
const REALGIT = spawnSync('which', ['git'], { encoding: 'utf8', env: baseEnv }).stdout.trim();
const shim = installGitShim(baseEnv, { baseDir: TMP });

const RAW = (args, cwd = TMP) => spawnSync(REALGIT, args, { cwd, env: baseEnv, encoding: 'utf8' });
const SHIMMED = (args, env = {}, cwd = TMP) => {
  const r = spawnSync('git', args, { cwd, env: { ...shim.env, ...env }, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};
const mkRepo = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  RAW(['init', '-q', dir]);
  fs.writeFileSync(path.join(dir, 'f.txt'), 'f\n');
  RAW(['-C', dir, 'add', 'f.txt']); RAW(['-C', dir, 'commit', '-q', '-m', 'base']);
  return dir;
};
const fp = (file) => { try { const st = fs.statSync(file); return `${st.mtimeMs}:${crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')}`; } catch { return 'absent'; } };

const Q = mkRepo(path.join(OUT, 'Q'));      // a real-looking repo outside tmp
const P = mkRepo(path.join(TMP, 'P'));      // a repo living under tmp
const W = path.join(TMP, 'pw');             // a linked worktree of P under tmp
RAW(['-C', P, 'worktree', 'add', '-q', '-b', 'w', W]);

console.log(`\n=== temp-index holes ${PRE ? '(PRE-CHANGE: must be OPEN)' : '(must be CLOSED)'} ===`);
function probe(name, target, run) {
  const before = fp(target);
  const r = run();
  const changed = fp(target) !== before;
  if (PRE) check(`[pre] ${name} — hole OPEN (real index written)`, changed, `exit=${r.code} ${r.out.slice(0, 200)}`);
  else check(`${name} — refused, real index unchanged`, !changed && r.code !== 0 && /refused at the invocation layer/.test(r.out), `exit=${r.code} changed=${changed} ${r.out.slice(0, 200)}`);
}
const LNK = path.join(TMP, 'idx-link');
fs.symlinkSync(path.join(Q, '.git', 'index'), LNK);
fs.writeFileSync(path.join(Q, 'h1.txt'), 'h1\n');
probe('H1 GIT_INDEX_FILE = temp-dir symlink to an outside repo\'s index', path.join(Q, '.git', 'index'),
  () => SHIMMED(['-C', Q, 'add', 'h1.txt'], { GIT_INDEX_FILE: LNK }));
fs.writeFileSync(path.join(P, 'h2.txt'), 'h2\n');
probe('H2 GIT_INDEX_FILE = the own index of a repo living under tmp', path.join(P, '.git', 'index'),
  () => SHIMMED(['-C', P, 'add', 'h2.txt'], { GIT_INDEX_FILE: path.join(P, '.git', 'index') }));
fs.symlinkSync(path.join(Q, '.git', 'index'), path.join(Q, 'rel-idx'));
fs.writeFileSync(path.join(Q, 'h3.txt'), 'h3\n');
probe('H3 RELATIVE GIT_INDEX_FILE resolved after -C onto a symlink to the real index', path.join(Q, '.git', 'index'),
  () => SHIMMED(['-C', Q, 'add', 'h3.txt'], { GIT_INDEX_FILE: 'rel-idx' }, TMP));
fs.writeFileSync(path.join(W, 'h4.txt'), 'h4\n');
const WIDX = path.join(P, '.git', 'worktrees', 'pw', 'index');
probe('H4 GIT_INDEX_FILE = a linked worktree\'s real index under tmp', WIDX,
  () => SHIMMED(['-C', W, 'add', 'h4.txt'], { GIT_INDEX_FILE: WIDX }));

if (!PRE) {
  console.log('\n=== sanctioned throwaway indexes still work ===');
  // snapshotWorkingTree (tree-snapshot.mjs) through the shim, against the outside repo.
  const qIdx = fp(path.join(Q, '.git', 'index'));
  const qHead = RAW(['-C', Q, 'rev-parse', 'HEAD']).stdout.trim();
  const snap = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { snapshotWorkingTree } from ${JSON.stringify(pathToFileURL(path.join(HERE, 'lib', 'tree-snapshot.mjs')).href)}; const s = snapshotWorkingTree(${JSON.stringify(Q)}); console.log(s.tree);`],
    { env: shim.env, encoding: 'utf8' });
  check('snapshotWorkingTree succeeds with the shim on PATH', snap.status === 0 && /^[0-9a-f]{40}/.test(snap.stdout.trim()), (snap.stderr || '').slice(0, 300));
  check('…and leaves the repo\'s real index and HEAD untouched', fp(path.join(Q, '.git', 'index')) === qIdx && RAW(['-C', Q, 'rev-parse', 'HEAD']).stdout.trim() === qHead);
  // candidate-store shape: an index file inside a fresh mkdtemp dir.
  const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchard-candidate-commit-'));
  const tree = RAW(['-C', Q, 'rev-parse', 'HEAD^{tree}']).stdout.trim();
  const r = SHIMMED(['-C', Q, 'read-tree', tree], { GIT_INDEX_FILE: path.join(cdir, 'index') });
  check('candidate-store shape (mkdtemp dir/index) read-tree allowed', r.code === 0, r.out.slice(0, 200));
  fs.rmSync(cdir, { recursive: true, force: true });
  const rel = SHIMMED(['-C', Q, 'read-tree', tree], { GIT_INDEX_FILE: 'x-idx' });
  check('a RELATIVE temp index is refused (it resolves after -C)', rel.code !== 0);
}

for (const d of [TMP, OUT]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
console.log(`\n${pass}/${pass + fail} checks passed${PRE ? ' (pre-change mode)' : ''}`);
if (fail) console.log(`FAILED: ${failed.join(' | ')}`);
process.exit(fail ? 1 : 0);
