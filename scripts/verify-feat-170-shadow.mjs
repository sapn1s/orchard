#!/usr/bin/env node
/**
 * verify-feat-170-shadow.mjs — FEAT-170 shadow-repo pilot, persistent suite.
 *
 * Four proofs, each shown BEFORE (the ACTUAL baseline this repo has today) and AFTER:
 *   P1  two lanes editing one file concurrently land without silent loss; an overlap is
 *       refused loudly with the shared tree byte-identical.          baseline: shared tree
 *   P2  an agent's shadow commit / reset / branch -D / rebase / gc never alters the real
 *       repo (full inventory: type, mode, link target, sha256).      baseline: today's shim
 *       refuses every lane write (no git space at all). The redirect attacks are
 *       ACCEPTANCE tests on the new rule; a NEGATIVE CONTROL (a naive cwd-keyed allow,
 *       the design the refutation rejected) shows each attack is real.
 *   P3  the BUG-224 revert is prevented (stale cp inside a lane; a pre-fix copy after
 *       the seed already holds the fix → REVERTS-FOREIGN).           baseline: shared tree
 *   P4  a promotion commits exactly the landed bytes, as git stores them (filters
 *       applied), and only those paths; two tickets in one file promote as one group.
 *                                                                    baseline: today's candidate freeze from live
 * Plus: undo (unland), interrupted landing + recover, a concurrent writer during the
 * swap, eligibility refusals, and the metrics report.
 *
 * Fixture repos are created with the REAL git (absolute path); every agent-side call
 * goes through `git` on PATH = the installed FEAT-135 shim with a test shadow root and
 * NO host (so any write the shadow rule does not allow fails closed). Needs git writes
 * in scratch repos: run it in scripts/confined-run.mjs (or the Docker sandbox); inside
 * an agent session it exits 2 (COULD NOT RUN). Exit 0 = all PASS.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installGitShim } from './lib/git-shim.mjs';
import * as CS from './lib/candidate-store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHADOW = path.join(HERE, 'shadow.mjs');
const CAND = path.join(HERE, 'candidate.mjs');

let pass = 0; let failN = 0;
function check(name, ok, detail = '') {
  if (ok) pass++; else failN++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `\n        ${String(detail).split('\n').join('\n        ')}` : ''}`);
}
function beforeAfter(name, beforeHolds, afterHolds, detail = '') {
  check(`${name} — BEFORE (today) fails the property [must-FAIL]`, beforeHolds === false, detail);
  check(`${name} — AFTER (shadow pilot) holds it`, afterHolds === true, detail);
}
const sha = (b) => createHash('sha256').update(b).digest('hex');

const REAL_GIT = (() => {
  const r = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: { ...process.env, PATH: (process.env.PATH || '').split(':').filter((p) => p !== process.env.ORCHARD_GIT_SHIM_DIR).join(':') } });
  return r.stdout.trim() || '/usr/bin/git';
})();
const S = fs.mkdtempSync(path.join(os.tmpdir(), 'f170-shadow-'));
const HOME = path.join(S, 'home'); fs.mkdirSync(HOME);
const fx = (dir, ...args) => {
  const r = spawnSync(REAL_GIT, ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, HOME, GIT_CONFIG_NOSYSTEM: '1' } });
  if (r.status !== 0) throw new Error(`fixture git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
{
  const probe = path.join(S, 'probe'); fs.mkdirSync(probe);
  const r = spawnSync(REAL_GIT, ['-C', probe, 'init', '-q'], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.log('COULD NOT RUN: git writes are refused here even in a scratch repo (an Orchard agent session).');
    console.log('  Run it confined:  node scripts/confined-run.mjs -- node scripts/verify-feat-170-shadow.mjs');
    process.exit(2);
  }
}
const w = (dir, rel, body, mode) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); if (mode) fs.chmodSync(p, mode); };
const rd = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

/** Full inventory of a directory tree (including .git): rel → type:mode:size:sha256 | link target. */
function inventory(dir) {
  const out = new Map(); const stack = [''];
  while (stack.length) {
    const rel = stack.pop(); const abs = path.join(dir, rel);
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name; const p = path.join(dir, r);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out.set(r, `link:${fs.readlinkSync(p)}`);
      else if (st.isDirectory()) { out.set(r, `dir:${(st.mode & 0o7777).toString(8)}`); stack.push(r); }
      else out.set(r, `file:${(st.mode & 0o7777).toString(8)}:${st.size}:${sha(fs.readFileSync(p))}`);
    }
  }
  return out;
}
function invDiff(a, b) {
  const d = [];
  for (const [k, v] of a) if (b.get(k) !== v) d.push(`${k}: ${v} → ${b.get(k) ?? '(gone)'}`);
  for (const k of b.keys()) if (!a.has(k)) d.push(`${k}: (new) ${b.get(k)}`);
  return d;
}

const ROOT = path.join(S, 'shadow');
const shimNew = installGitShim({ ...process.env, HOME }, { shadowRoot: ROOT, baseDir: S });
const shimOld = installGitShim({ ...process.env, HOME }, { shadowRoot: null, baseDir: S }); // today's shim
const ROOT_REAL = shimNew.shadowRoot;
const agentEnv = { ...shimNew.env, HOME, ORCHARD_SHADOW_ROOT: ROOT_REAL, ORCHARD_SHADOW_TEST_IN_CONTAINER: '1', ORCHARD_SHADOW_REGISTRY: path.join(S, 'registry.json'), GIT_CONFIG_NOSYSTEM: '1' };
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']) delete agentEnv[k];
const oldEnv = { ...shimOld.env, HOME, GIT_CONFIG_NOSYSTEM: '1' };

function sh(args, { env = agentEnv, extra = {}, cwd = S } = {}) {
  const r = spawnSync(process.execPath, [SHADOW, ...args], { cwd, encoding: 'utf8', env: { ...env, ...extra } });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
function ag(cwd, args, { env = agentEnv, extra = {}, input } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...env, ...extra }, input });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
const lane = (T, repo) => JSON.parse(fs.readFileSync(path.join(ROOT_REAL, fs.readdirSync(ROOT_REAL).find((d) => fs.existsSync(path.join(ROOT_REAL, d, 'lanes', `${T}.json`)) && JSON.parse(fs.readFileSync(path.join(ROOT_REAL, d, 'lanes', `${T}.json`), 'utf8')).top === fs.realpathSync(repo)), 'lanes', `${T}.json`), 'utf8')).laneDir;

const APP = ['function one() {', '  return 1;', '}', '', 'function two() {', '  return 2;', '}', '', 'function three() {', '  return 3;', '}', ''].join('\n');
let nreal = 0;
function makeReal(files = { 'app.js': APP, 'lib/util.js': 'export const u = 1;\n' }, { dirty = {} } = {}) {
  const dir = path.join(S, `real-${++nreal}`); fs.mkdirSync(dir);
  fx(dir, 'init', '-q', '-b', 'main');
  fx(dir, 'config', 'user.name', 'fixture'); fx(dir, 'config', 'user.email', 'f@x.invalid'); fx(dir, 'config', 'commit.gpgsign', 'false');
  for (const [k, v] of Object.entries(files)) w(dir, k, v);
  fx(dir, 'add', '-A'); fx(dir, 'commit', '-qm', 'base');
  for (const [k, v] of Object.entries(dirty)) w(dir, k, v);
  return fs.realpathSync(dir);
}
const edit = (s, from, to) => { if (!s.includes(from)) throw new Error(`fixture edit: ${from} not found`); return s.replace(from, to); };

/* ════════════════════════════════════════════ P1 concurrent same-file */
console.log('\n── P1 two lanes, one file, concurrently');
{
  // BEFORE: today's shared tree. Both lanes read app.js, each writes its whole file (Write tool).
  const real = makeReal();
  const t0 = rd(real, 'app.js');
  const aVer = edit(t0, '  return 1;', '  return 100; // FEAT-901');
  const bVer = edit(t0, '  return 3;', '  return 300; // FEAT-902');
  w(real, 'app.js', aVer); w(real, 'app.js', bVer);
  const before = rd(real, 'app.js');
  const beforeHolds = before.includes('FEAT-901') && before.includes('FEAT-902');

  // AFTER: each ticket in its own lane, both land.
  const r2 = makeReal();
  const nA = sh(['lane-new', 'FEAT-901', '--repo', r2]); const nB = sh(['lane-new', 'FEAT-902', '--repo', r2]); const nC = sh(['lane-new', 'FEAT-903', '--repo', r2]);
  check('P1 lane-new makes three lanes from the live shared tree', nA.code === 0 && nB.code === 0 && nC.code === 0, nA.out + nB.out + nC.out);
  const LA = lane('FEAT-901', r2); const LB = lane('FEAT-902', r2); const LC = lane('FEAT-903', r2);
  w(LA, 'app.js', edit(rd(LA, 'app.js'), '  return 1;', '  return 100; // FEAT-901'));
  w(LB, 'app.js', edit(rd(LB, 'app.js'), '  return 3;', '  return 300; // FEAT-902'));
  w(LC, 'app.js', edit(rd(LC, 'app.js'), '  return 1;', '  return -1; // FEAT-903 conflicting'));
  const cA = sh(['run', 'FEAT-901', '--repo', r2, '--', 'commit', '-qam', 'A']);
  const cB = ag(LB, ['commit', '-qam', 'B']); // plain `git` typed in the lane dir (the Codex-lane form)
  const cC = sh(['run', 'FEAT-903', '--', 'commit', '-qam', 'C'], { cwd: LC }); // from inside the lane, no --repo
  check('P1 lanes commit freely in their own repos (shim allows: resolved into the shadow root)', cA.code === 0 && cB.code === 0 && cC.code === 0, cA.out + cB.out + cC.out);
  const lA = sh(['land', 'FEAT-901', '--repo', r2]);
  const lB = sh(['land', 'FEAT-902', '--repo', r2]);
  const after = rd(r2, 'app.js');
  beforeAfter('P1 both concurrent edits to app.js survive', beforeHolds, lA.code === 0 && lB.code === 0 && after.includes('FEAT-901') && after.includes('FEAT-902') && /merged/.test(lB.out), `${lA.out}\n${lB.out}\n${after}`);
  const invPre = inventory(r2);
  const lC = sh(['land', 'FEAT-903', '--repo', r2]);
  const d = invDiff(invPre, inventory(r2));
  check('P1 an OVERLAPPING edit is refused loudly (exit 3, OVERLAP, file named)', lC.code === 3 && /OVERLAP/.test(lC.out) && /app\.js/.test(lC.out), lC.out);
  check('P1 the refused landing wrote nothing (full inventory of the shared tree + .git identical)', d.length === 0, d.join('\n'));
  // Resolve in the lane: sync, fix the conflict, commit, land.
  const sy = sh(['sync', 'FEAT-903', '--repo', r2]);
  check('P1 sync brings the shared tree into the lane and reports the conflict there (exit 3)', sy.code === 3 && /CONFLICT/.test(sy.out), sy.out);
  // A resolution that REWRITES the other ticket's line is a removal of foreign work: loud.
  w(LC, 'app.js', rd(r2, 'app.js').replace('  return 100; // FEAT-901', '  return -1; // FEAT-903 overrides FEAT-901'));
  const ad0 = ag(LC, ['add', 'app.js']); const cm0 = ag(LC, ['commit', '-q', '--no-edit']);
  const lC1 = sh(['land', 'FEAT-903', '--repo', r2]);
  check('P1 a conflict resolution that rewrites another ticket\'s landed line is refused (REVERTS-FOREIGN) unless --allow-revert', ad0.code === 0 && cm0.code === 0 && lC1.code === 3 && /REVERTS-FOREIGN/.test(lC1.out) && /FEAT-901/.test(lC1.out), lC1.out);
  // The keeping resolution: both lines stay.
  w(LC, 'app.js', rd(r2, 'app.js').replace('  return 100; // FEAT-901', '  return 100; // FEAT-901\n  // FEAT-903: agreed with FEAT-901'));
  const cm = ag(LC, ['commit', '-qam', 'keep both']); const ad = cm;
  const lC2 = sh(['land', 'FEAT-903', '--repo', r2]);
  const fin = rd(r2, 'app.js');
  check('P1 after sync + resolve + commit in the lane, it lands and keeps both other tickets\' edits', ad.code === 0 && cm.code === 0 && lC2.code === 0 && fin.includes('FEAT-903: agreed') && fin.includes('FEAT-901') && fin.includes('FEAT-902'), `${ad.out}${cm.out}${lC2.out}\n${fin}`);

  // undo
  const invBeforeUndo = inventory(r2);
  const un = sh(['unland', 'FEAT-903', '--repo', r2]);
  check('UNDO unland restores the pre-landing bytes of the last landing', un.code === 0 && rd(r2, 'app.js') === after, un.out);
  const re = sh(['land', 'FEAT-903', '--repo', r2]);
  check('UNDO the same lane lands again after an unland', re.code === 0 && invDiff(invBeforeUndo, inventory(r2)).filter((x) => !x.startsWith('.git')).length === 0, re.out);
  w(r2, 'app.js', `${rd(r2, 'app.js')}// a later hand edit\n`);
  const un2 = sh(['unland', 'FEAT-903', '--repo', r2]);
  check('UNDO unland refuses (exit 3) when the file changed after the landing, and restores nothing', un2.code === 3 && rd(r2, 'app.js').endsWith('// a later hand edit\n'), un2.out);
}

/* ════════════════════════════════════════════ P2 real repo untouched */
console.log('\n── P2 shadow git never alters the real repo');
{
  const real = makeReal(undefined, { dirty: { 'app.js': `${APP}// uncommitted shared-tree line\n` } });
  const n = sh(['lane-new', 'FEAT-911', '--repo', real]);
  const L = lane('FEAT-911', real);
  // BEFORE: today's shim refuses every write in the lane — agents have no git space.
  w(L, 'x.txt', 'x\n');
  const oldAdd = ag(L, ['add', 'x.txt'], { env: oldEnv });
  const oldCommit = ag(L, ['commit', '-qam', 'x'], { env: oldEnv });
  const beforeCap = oldAdd.code === 0 && oldCommit.code === 0;
  const realInv0 = inventory(real);
  // AFTER: the ordinary destructive lane ops all run.
  const ops = [
    ['add', 'x.txt'], ['commit', '-qm', 'x'], ['branch', 'tmp'], ['checkout', '-q', 'tmp'], ['commit', '-q', '--allow-empty', '-m', 'y'],
    ['checkout', '-q', 'lane'], ['rebase', '-q', 'tmp'], ['branch', '-D', 'tmp'], ['reset', '-q', '--hard', 'HEAD~1'], ['clean', '-fdx'],
    ['stash', 'list'], ['tag', 't1'], ['reflog', 'expire', '--expire=now', '--all'], ['gc', '-q', '--prune=now'], ['config', 'core.abbrev', '9'],
  ];
  const res = ops.map((o) => ({ o, r: ag(L, o) }));
  const bad = res.filter((x) => x.r.code !== 0);
  beforeAfter('P2 a lane can commit / branch / rebase / branch -D / reset --hard / clean / gc in its own repo', beforeCap, n.code === 0 && bad.length === 0, bad.map((x) => `${x.o.join(' ')}: ${x.r.out}`).join('\n') + oldCommit.out);

  // Redirect attacks — each must be REFUSED by the shim (acceptance).
  const A = path.join(ROOT_REAL, 'attacks'); fs.mkdirSync(A, { recursive: true });
  const mk = (name) => { const d = path.join(A, name); fs.mkdirSync(d, { recursive: true }); return d; };
  const laneFixture = (name) => { const d = mk(name); fx(d, 'init', '-q'); fx(d, 'config', 'user.name', 'a'); fx(d, 'config', 'user.email', 'a@a.invalid'); w(d, 'f', 'f\n'); fx(d, 'add', 'f'); fx(d, 'commit', '-qm', 'f'); return d; };
  const realGitDir = path.join(real, '.git');
  const attacks = [];
  const atk = (name, fn) => { try { attacks.push({ name, ...fn() }); } catch (e) { attacks.push({ name, code: -1, out: `fixture error ${e.message}` }); } };
  atk('gitfile pointing at the real .git', () => { const d = mk('a1'); w(d, '.git', `gitdir: ${realGitDir}\n`); return ag(d, ['commit', '-q', '--allow-empty', '-m', 'pwn']); });
  atk('GIT_DIR env = real .git', () => ag(L, ['commit', '-q', '--allow-empty', '-m', 'pwn'], { extra: { GIT_DIR: realGitDir } }));
  atk('--git-dir / --work-tree = real', () => ag(L, [`--git-dir=${realGitDir}`, `--work-tree=${real}`, 'commit', '-q', '--allow-empty', '-m', 'pwn']));
  atk('core.worktree in lane config = real tree', () => { const d = laneFixture('a4'); fx(d, 'config', 'core.worktree', real); return ag(d, ['reset', '-q', '--hard']); });
  atk('GIT_WORK_TREE env = real tree', () => ag(L, ['checkout', '-f', '-q', 'HEAD', '--', '.'], { extra: { GIT_WORK_TREE: real } }));
  atk('commondir file pointing at the real .git', () => {
    const d = mk('a5'); const gd = path.join(A, 'a5-gd'); fs.mkdirSync(gd, { recursive: true });
    w(gd, 'commondir', `${realGitDir}\n`); w(gd, 'HEAD', 'ref: refs/heads/main\n'); w(gd, 'gitdir', `${path.join(d, '.git')}\n`);
    w(d, '.git', `gitdir: ${gd}\n`); return ag(d, ['commit', '-q', '--allow-empty', '-m', 'pwn']);
  });
  atk('objects dir symlinked to the real objects', () => { const d = laneFixture('a6'); fs.rmSync(path.join(d, '.git', 'objects'), { recursive: true }); fs.symlinkSync(path.join(realGitDir, 'objects'), path.join(d, '.git', 'objects')); return ag(d, ['gc', '-q', '--prune=now']); });
  atk('refs/heads symlinked to the real refs', () => { const d = laneFixture('a7'); const head = fx(d, 'rev-parse', 'HEAD'); const rh = path.join(d, '.git', 'refs', 'heads'); fs.rmSync(rh, { recursive: true }); fs.symlinkSync(path.join(realGitDir, 'refs', 'heads'), rh); return ag(d, ['update-ref', 'refs/heads/main', head]); });
  atk('GIT_INDEX_FILE = real index', () => ag(L, ['add', '-A'], { extra: { GIT_INDEX_FILE: path.join(realGitDir, 'index') } }));
  atk('worktree add into the real tree', () => ag(L, ['worktree', 'add', path.join(real, 'wt')]));
  atk('config --global', () => ag(L, ['config', '--global', 'core.hooksPath', '/tmp/evil']));
  atk('apply --build-fake-ancestor=real index', () => { w(L, 'p.diff', ''); return ag(L, ['apply', `--build-fake-ancestor=${path.join(realGitDir, 'index')}`, 'p.diff']); });
  atk('read-tree --index-output=real index', () => ag(L, ['read-tree', `--index-output=${path.join(realGitDir, 'index')}`, 'HEAD']));
  atk('alternates file at the real objects', () => { const d = laneFixture('a14'); w(d, '.git/objects/info/alternates', `${path.join(realGitDir, 'objects')}\n`); return ag(d, ['repack', '-a', '-d', '-q']); });
  atk('push to the real repo', () => ag(L, ['push', real, 'HEAD:refs/heads/pwn']));
  atk('init with GIT_DIR = real .git', () => { const d = mk('a16'); return ag(d, ['init', '-q'], { extra: { GIT_DIR: realGitDir } }); });
  atk('init over a .git symlinked to the real one', () => { const d = mk('a17'); fs.symlinkSync(realGitDir, path.join(d, '.git')); return ag(d, ['init', '-q']); });
  atk('lane config hard-linked to the real config', () => { const d = laneFixture('a18'); fs.rmSync(path.join(d, '.git', 'config')); fs.linkSync(path.join(realGitDir, 'config'), path.join(d, '.git', 'config')); return ag(d, ['config', 'user.name', 'pwn']); });
  atk('a real-repo commit with cwd = the real tree', () => ag(real, ['commit', '-q', '--allow-empty', '-m', 'pwn']));
  atk('fetch into the lane (not in the pilot verb list)', () => ag(L, ['fetch', real]));
  const allowed = attacks.filter((a) => a.code === 0);
  // -c core.worktree=<real> from inside a lane: git itself resolves the lane (the shim asks git), so it runs there.
  const cw = ag(L, ['-c', `core.worktree=${real}`, 'checkout', '-f', '-q', 'HEAD', '--', '.']);
  check('P2 -c core.worktree=<real> run from a lane is resolved by git to the lane itself and executes there (no real-repo effect; checked by the inventory below)', cw.code === 0, cw.out);
  check(`P2 all ${attacks.length} redirect attacks are REFUSED by the shim`, allowed.length === 0, allowed.map((a) => `${a.name}: exit 0 ${a.out}`).join('\n'));
  check('P2 the refusal is the shim\'s loud refusal, not an incidental git error', attacks.filter((a) => /git write refused at the invocation layer/.test(a.out)).length === attacks.length,
    attacks.filter((a) => !/git write refused at the invocation layer/.test(a.out)).map((a) => `${a.name}: ${a.out.slice(0, 160)}`).join('\n'));
  const d = invDiff(realInv0, inventory(real));
  check('P2 the real repo (every file in .git and the work tree: type, mode, size, sha256) is byte-identical after all lane ops + attacks', d.length === 0, d.join('\n'));
  check('P2 no global git config was written', !fs.existsSync(path.join(HOME, '.gitconfig')));

  // NEGATIVE CONTROL — a naive allow keyed on the cwd being under the root (the rejected design).
  const copy = makeReal(undefined, { dirty: { 'app.js': `${APP}// uncommitted shared-tree line\n` } });
  const copyGit = path.join(copy, '.git');
  const naive = (cwd, args, extra = {}) => (fs.realpathSync(cwd).startsWith(ROOT_REAL + path.sep) ? spawnSync(REAL_GIT, args, { cwd, encoding: 'utf8', env: { ...agentEnv, ...extra } }) : { status: 1 });
  const ctl = [];
  const ctlRun = (name, fn) => { const i0 = inventory(copy); fn(); ctl.push({ name, changed: invDiff(i0, inventory(copy)).length > 0 }); };
  ctlRun('gitfile', () => { const dd = mk('c1'); w(dd, '.git', `gitdir: ${copyGit}\n`); naive(dd, ['commit', '-q', '--allow-empty', '-m', 'pwn']); });
  ctlRun('GIT_DIR', () => naive(L, ['commit', '-q', '--allow-empty', '-m', 'pwn'], { GIT_DIR: copyGit }));
  ctlRun('--git-dir', () => naive(L, [`--git-dir=${copyGit}`, `--work-tree=${copy}`, 'commit', '-q', '--allow-empty', '-m', 'pwn']));
  ctlRun('core.worktree', () => { const dd = laneFixture('c4'); fx(dd, 'config', 'core.worktree', copy); naive(dd, ['reset', '-q', '--hard']); });
  ctlRun('refs symlink', () => { const dd = laneFixture('c7'); const head = fx(dd, 'rev-parse', 'HEAD'); const rh = path.join(dd, '.git', 'refs', 'heads'); fs.rmSync(rh, { recursive: true }); fs.symlinkSync(path.join(copyGit, 'refs', 'heads'), rh); naive(dd, ['update-ref', 'refs/heads/main', head]); });
  ctlRun('GIT_INDEX_FILE', () => naive(L, ['add', '-A'], { GIT_INDEX_FILE: path.join(copyGit, 'index') }));
  check('P2 NEGATIVE CONTROL: under a naive cwd-keyed allow, every one of these attacks DOES alter a real repo (the attacks are real)', ctl.every((c) => c.changed), ctl.filter((c) => !c.changed).map((c) => c.name).join(', '));

  // A shadow root swapped for a symlink turns every shadow allow off.
  const R2 = path.join(S, 'root2'); const shim2 = installGitShim({ ...process.env, HOME }, { shadowRoot: R2, baseDir: S });
  const env2 = { ...shim2.env, HOME, ORCHARD_SHADOW_ROOT: shim2.shadowRoot, ORCHARD_SHADOW_TEST_IN_CONTAINER: '1' };
  const l2 = path.join(shim2.shadowRoot, 'l'); fs.mkdirSync(l2);
  const okBefore = ag(l2, ['init', '-q'], { env: env2 }).code === 0;
  fs.renameSync(shim2.shadowRoot, `${shim2.shadowRoot}-moved`); fs.symlinkSync(real, shim2.shadowRoot);
  const pwn = ag(path.join(shim2.shadowRoot), ['commit', '-q', '--allow-empty', '-m', 'pwn'], { env: env2 });
  check('P2 a shadow root replaced by a symlink to a real repo allows nothing (and the real repo is untouched)', okBefore && pwn.code !== 0 && invDiff(realInv0, inventory(real)).length === 0, pwn.out);
}

/* ════════════════════════════════════════════ P3 BUG-224 */
console.log('\n── P3 the BUG-224 revert');
{
  const FIX = '  return 2; // FEAT-921 fix';
  // BEFORE: shared tree. Lane Y backs up app.js at its start; lane X lands a fix; Y restores its backup.
  const real = makeReal();
  const backup = rd(real, 'app.js');
  w(real, 'app.js', edit(rd(real, 'app.js'), '  return 2;', FIX));
  w(real, 'app.js', backup);
  const beforeHolds = rd(real, 'app.js').includes(FIX);

  // AFTER (a): Y's lane is seeded BEFORE X's fix; Y restores its own start copy inside the lane and changes another file.
  const r2 = makeReal();
  sh(['lane-new', 'FEAT-922', '--repo', r2]);
  const LY = lane('FEAT-922', r2); const yBackup = rd(LY, 'app.js');
  sh(['lane-new', 'FEAT-921', '--repo', r2]); const LX = lane('FEAT-921', r2);
  w(LX, 'app.js', edit(rd(LX, 'app.js'), '  return 2;', FIX)); ag(LX, ['commit', '-qam', 'fix']);
  const lx = sh(['land', 'FEAT-921', '--repo', r2]);
  w(LY, 'app.js', yBackup); w(LY, 'lib/util.js', 'export const u = 2; // FEAT-922\n'); ag(LY, ['commit', '-qam', 'y']);
  const ly = sh(['land', 'FEAT-922', '--repo', r2]);
  beforeAfter('P3 a stale whole-file restore does not revert a landed fix', beforeHolds, lx.code === 0 && ly.code === 0 && rd(r2, 'app.js').includes(FIX) && rd(r2, 'lib/util.js').includes('FEAT-922'), `${lx.out}${ly.out}`);

  // AFTER (b): Z is seeded AFTER the fix landed (the seed holds it) and copies the pre-fix bytes from the real HEAD.
  sh(['lane-new', 'FEAT-923', '--repo', r2]); const LZ = lane('FEAT-923', r2);
  const headCopy = spawnSync('git', ['-C', r2, 'show', 'HEAD:app.js'], { encoding: 'utf8', env: agentEnv }).stdout;
  w(LZ, 'app.js', headCopy); ag(LZ, ['commit', '-qam', 'restore from HEAD']);
  const inv0 = inventory(r2);
  const lz = sh(['land', 'FEAT-923', '--repo', r2]);
  check('P3 copying the pre-fix bytes over a fix that is in the seed is refused (exit 3, REVERTS-FOREIGN)', lz.code === 3 && /REVERTS-FOREIGN/.test(lz.out) && /FEAT-921 fix/.test(lz.out), lz.out);
  check('P3 … and nothing was written', invDiff(inv0, inventory(r2)).length === 0 && rd(r2, 'app.js').includes(FIX));
  const lz2 = sh(['land', 'FEAT-923', '--repo', r2, '--allow-revert', 'app.js']);
  check('P3 a deliberate revert lands only with --allow-revert, and it is recorded', lz2.code === 0 && !rd(r2, 'app.js').includes(FIX) && /"allowRevert":\["app.js"\]/.test(fs.readFileSync(path.join(path.dirname(path.dirname(LZ)), 'landings', 'FEAT-923.jsonl'), 'utf8')), lz2.out);
  // No false positive: a ticket iterating on its OWN landed line.
  sh(['unland', 'FEAT-923', '--repo', r2]);
  w(LX, 'app.js', edit(rd(LX, 'app.js'), FIX, '  return 2; // FEAT-921 fix v2')); ag(LX, ['commit', '-qam', 'fix v2']);
  const lx2 = sh(['land', 'FEAT-921', '--repo', r2]);
  check('P3 no false positive: a ticket changing its own earlier-landed line lands', lx2.code === 0 && rd(r2, 'app.js').includes('fix v2'), lx2.out);
}

/* ════════════════════════════════════════════ V exact landed-state protection (verify 6f369176) */
console.log('\n── V a landing never changes bytes another ticket landed (exact, verify 6f369176)');
{
  const real = makeReal({ 'sym.txt': 'a\nb\n', 'bin.dat': '\0header\nline1\nline2\n', 'del.txt': 'keep\nremove me\nkeep2\n', 'other.txt': 'o\n' });
  const landAs = (T, f) => { sh(['lane-new', T, '--repo', real]); const L = lane(T, real); f(L); ag(L, ['add', '-A']); ag(L, ['commit', '-qm', T]); return sh(['land', T, '--repo', real]); };
  const o1 = landAs('FEAT-961', (L) => w(L, 'sym.txt', 'a\n});\nb\n'));
  const o2 = landAs('FEAT-963', (L) => w(L, 'bin.dat', '\0header\nline1 FEAT-963\nline2\n'));
  const o3 = landAs('FEAT-965', (L) => w(L, 'del.txt', 'keep\nkeep2\n'));
  check('V setup: three tickets land (a punctuation-only line, a NUL-byte file, a deletion)', o1.code === 0 && o2.code === 0 && o3.code === 0, o1.out + o2.out + o3.out);
  const inv0 = inventory(real);
  const v1 = landAs('FEAT-962', (L) => w(L, 'sym.txt', 'a\nb\n'));
  check('V1 removing another ticket\'s landed punctuation-only line `});` is refused (exit 3), nothing written', v1.code === 3 && /REVERTS-FOREIGN/.test(v1.out) && rd(real, 'sym.txt') === 'a\n});\nb\n', v1.out);
  const v2 = landAs('FEAT-964', (L) => w(L, 'bin.dat', '\0header\nline1\nline2\n'));
  check('V2 reverting another ticket\'s landed change in a file with a NUL byte is refused (exit 3), nothing written', v2.code === 3 && /REVERTS-FOREIGN/.test(v2.out) && rd(real, 'bin.dat') === '\0header\nline1 FEAT-963\nline2\n', v2.out);
  const v3 = landAs('FEAT-966', (L) => w(L, 'del.txt', 'keep\nremove me\nkeep2\n'));
  check('V3 resurrecting a line another ticket\'s landing deleted (stale restore) is refused (exit 3), nothing written', v3.code === 3 && /REVERTS-FOREIGN/.test(v3.out) && rd(real, 'del.txt') === 'keep\nkeep2\n', v3.out);
  check('V the three refused landings left the shared tree byte-identical (full inventory)', invDiff(inv0, inventory(real)).filter((x) => !x.startsWith('.git/orchard-candidates')).length === 0);
  const ok = landAs('FEAT-967', (L) => { w(L, 'del.txt', 'keep\nkeep2 FEAT-967\n'); w(L, 'sym.txt', 'a\n});\nb FEAT-967\n'); w(L, 'bin.dat', '\0header\nline1 FEAT-963\nline2 FEAT-967\n'); });
  check('V no false refusal: edits beside other tickets\' landed bytes (keeping them exactly) land', ok.code === 0 && rd(real, 'del.txt') === 'keep\nkeep2 FEAT-967\n' && rd(real, 'sym.txt') === 'a\n});\nb FEAT-967\n', ok.out);
  // verify faa119a9: the file mode another ticket SET is part of its landed hunk, also for a file it created.
  const m1 = landAs('FEAT-971', (L) => w(L, 'bin/tool.sh', '#!/bin/sh\necho tool\n', 0o755));
  const m2 = landAs('FEAT-972', (L) => fs.chmodSync(path.join(L, 'bin/tool.sh'), 0o644));
  check('V4 stripping the exec bit of a file another ticket created and landed is refused (exit 3); the mode stays 755',
    m1.code === 0 && m2.code === 3 && /REVERTS-FOREIGN/.test(m2.out) && (fs.statSync(path.join(real, 'bin/tool.sh')).mode & 0o111) !== 0, m1.out + m2.out);
}

/* ════════════════════════════════════════════ P4 promotion = landed bytes */
console.log('\n── P4 promotion commits exactly the landed bytes');
const ticketWithVerdict = (dir, id, hashes) => {
  const rec = { id, type: 'feature', title: `${id} fixture`, verification: hashes.map((h, i) => ({ provider: 'openai', model: 'm', run_id: `run-${id}-${i}`, verdict: 'holds', recorded_at: new Date(Date.UTC(2026, 9, 8, 12, 0, i)).toISOString(), candidate: h })) };
  w(dir, `docs/bugs/${id}-fixture.md`, `\`\`\`orchard-ticket\n${JSON.stringify(rec, null, 2)}\n\`\`\`\n\n# ${id}\n`);
};
const userEnv = { ...process.env, HOME, GIT_CONFIG_NOSYSTEM: '1' }; // the user's own terminal: no shim
const cand = (dir, args, env = userEnv) => { const r = spawnSync(process.execPath, [CAND, ...args, '--repo', dir], { encoding: 'utf8', env }); return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }; };
const landedPost = (repo, T) => {
  const base = path.dirname(path.dirname(lane(T, repo)));
  const recs = fs.readFileSync(path.join(base, 'landings', `${T}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.paths);
  const m = new Map(); for (const r of recs) for (const p of r.paths) m.set(p.path, p.post ? fs.readFileSync(path.join(base, 'objects', p.post.sha)) : null);
  return m;
};
const blobOf = (repo, rev, p) => spawnSync(REAL_GIT, ['-C', repo, 'rev-parse', `${rev}:${p}`], { encoding: 'utf8' }).stdout.trim();
const hashAsStored = (repo, p, bytes) => spawnSync(REAL_GIT, ['-C', repo, 'hash-object', `--path=${p}`, '--stdin'], { encoding: 'utf8', input: bytes }).stdout.trim();
const rawBlob = (bytes) => spawnSync(REAL_GIT, ['hash-object', '--no-filters', '--stdin'], { encoding: 'utf8', input: bytes }).stdout.trim();
{
  // BEFORE: today's candidate path straight from the live tree, after a foreign edit to a landed file.
  const real = makeReal({ 'app.js': APP, '.gitattributes': '*.txt text eol=lf\n' });
  sh(['lane-new', 'FEAT-931', '--repo', real]); const L = lane('FEAT-931', real);
  w(L, 'app.js', edit(rd(L, 'app.js'), '  return 1;', '  return 1; // FEAT-931')); ag(L, ['commit', '-qam', 'x']);
  sh(['land', 'FEAT-931', '--repo', real]);
  const landed = landedPost(real, 'FEAT-931');
  w(real, 'app.js', `${rd(real, 'app.js')}// foreign edit after landing\n`);
  cand(real, ['freeze', '--id', 'FEAT-931', '--files', 'app.js', '--accept-foreign', 'app.js'], agentEnv);
  ticketWithVerdict(real, 'FEAT-931', [CS.readTicketState(CS.repoInfo(real).store, 'FEAT-931').open]);
  const cm = cand(real, ['commit', 'FEAT-931']);
  const beforeHolds = cm.code === 0 && blobOf(real, 'HEAD', 'app.js') === hashAsStored(real, 'app.js', landed.get('app.js'));

  // AFTER: shadow freeze refuses the post-land edit; the clean path commits the landed bytes.
  const r2 = makeReal({ 'app.js': APP, '.gitattributes': '*.txt text eol=lf\n', 'bin/run.sh': '#!/bin/sh\necho run\n' });
  sh(['lane-new', 'FEAT-932', '--repo', r2]); const L2 = lane('FEAT-932', r2);
  w(L2, 'app.js', edit(rd(L2, 'app.js'), '  return 1;', '  return 1; // FEAT-932'));
  fs.chmodSync(path.join(L2, 'bin/run.sh'), 0o755);
  fs.symlinkSync('app.js', path.join(L2, 'app-link.js'));
  w(L2, 'new/added.txt', 'brand\r\nnew FEAT-932\r\n');
  ag(L2, ['add', '-A']); ag(L2, ['commit', '-qm', 'y']);
  const l2 = sh(['land', 'FEAT-932', '--repo', r2]);
  const landed2 = landedPost(r2, 'FEAT-932');
  check('P4 a landing writes bytes, exec bits, symlinks and new files exactly', l2.code === 0 && fs.lstatSync(path.join(r2, 'app-link.js')).isSymbolicLink() && (fs.statSync(path.join(r2, 'bin/run.sh')).mode & 0o111) !== 0 && rd(r2, 'new/added.txt') === 'brand\r\nnew FEAT-932\r\n', l2.out);
  w(r2, 'app.js', `${rd(r2, 'app.js')}// foreign edit after landing\n`);
  const f1 = sh(['freeze', 'FEAT-932', '--repo', r2]);
  check('P4 shadow freeze refuses (exit 3) when a landed file changed after landing', f1.code === 3 && /changed in the shared tree after/.test(f1.out), f1.out);
  w(r2, 'app.js', landed2.get('app.js'));
  const f2 = sh(['freeze', 'FEAT-932', '--repo', r2, '--json']);
  let hash2 = null; try { hash2 = JSON.parse(f2.out.slice(f2.out.indexOf('{'))).hash; } catch { /* */ }
  check('P4 shadow freeze makes a FEAT-170 candidate of exactly the landed files', f2.code === 0 && !!hash2, f2.out);
  ticketWithVerdict(r2, 'FEAT-932', [hash2]);
  const agentCommit = cand(r2, ['commit', 'FEAT-932'], agentEnv);
  check('P4 an AGENT cannot promote: candidate commit under the shim publishes nothing (publish-refused)', agentCommit.code !== 0 && /refused/.test(agentCommit.out) && blobOf(r2, 'HEAD', 'app.js') === blobOf(r2, 'HEAD~0', 'app.js') && spawnSync(REAL_GIT, ['-C', r2, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).stdout.trim() === '1', agentCommit.out);
  const ucm = cand(r2, ['commit', 'FEAT-932']);
  const paths = [...landed2.keys()];
  const exact = paths.every((p) => blobOf(r2, 'HEAD', p) === hashAsStored(r2, p, landed2.get(p)));
  const changedSet = spawnSync(REAL_GIT, ['-C', r2, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD~1', 'HEAD'], { encoding: 'utf8' }).stdout.trim().split('\n').sort();
  beforeAfter('P4 the commit holds exactly the landed bytes (as git stores them, filters applied)', beforeHolds, ucm.code === 0 && exact, `${cm.out}\n${ucm.out}`);
  check('P4 … and changes exactly the landed paths, nothing else', JSON.stringify(changedSet) === JSON.stringify([...paths].sort()), `${changedSet} vs ${paths}`);
  check('P4 raw-byte identity where the repo has no filter (app.js), filter-normalised where it has one (new/added.txt CRLF → LF)',
    blobOf(r2, 'HEAD', 'app.js') === rawBlob(landed2.get('app.js')) && blobOf(r2, 'HEAD', 'new/added.txt') !== rawBlob(landed2.get('new/added.txt')) && blobOf(r2, 'HEAD', 'new/added.txt') === hashAsStored(r2, 'new/added.txt', landed2.get('new/added.txt')));
  // The check-to-capture gap: freezeCandidate refuses captured bytes that are not the expected ones.
  let gap = null;
  try { CS.freezeCandidate({ repo: r2, id: 'FEAT-933', files: ['app.js'], acceptForeign: ['app.js'], expect: new Map([['app.js', { sha256: '0'.repeat(64), mode: '100644' }]]) }); } catch (e) { gap = e.code; }
  check('P4 freezeCandidate(expect) refuses captured bytes that differ from the expected landed bytes (nothing frozen)', gap === 'not-expected' && !CS.readTicketState(CS.repoInfo(r2).store, 'FEAT-933').open);

  // Two tickets, one file: promote as one FEAT-170 group.
  const r3 = makeReal();
  sh(['lane-new', 'FEAT-941', '--repo', r3]); sh(['lane-new', 'FEAT-942', '--repo', r3]);
  const LA = lane('FEAT-941', r3); const LB = lane('FEAT-942', r3);
  w(LA, 'app.js', edit(rd(LA, 'app.js'), '  return 1;', '  return 1; // FEAT-941')); ag(LA, ['commit', '-qam', 'a']);
  w(LB, 'app.js', edit(rd(LB, 'app.js'), '  return 3;', '  return 3; // FEAT-942')); w(LB, 'lib/util.js', 'export const u = 942;\n'); ag(LB, ['commit', '-qam', 'b']);
  sh(['land', 'FEAT-941', '--repo', r3]); const lb = sh(['land', 'FEAT-942', '--repo', r3]);
  const fb = sh(['freeze', 'FEAT-942', '--repo', r3]);
  check('P4 group: the second ticket into a shared file is told the order (freeze FEAT-941 first, then --depends-on)', fb.code === 3 && /Freeze FEAT-941 first/.test(fb.out) && /--depends-on FEAT-941/.test(fb.out), `${lb.out}\n${fb.out}`);
  const fa = sh(['freeze', 'FEAT-941', '--repo', r3, '--json']);
  const fb2 = sh(['freeze', 'FEAT-942', '--repo', r3, '--depends-on', 'FEAT-941', '--json']);
  let gh = null; try { gh = JSON.parse(fb2.out.slice(fb2.out.indexOf('{'))).hash; } catch { /* */ }
  ticketWithVerdict(r3, 'FEAT-941', [gh]); ticketWithVerdict(r3, 'FEAT-942', [gh]);
  const gcm = cand(r3, ['commit', 'FEAT-942']);
  const lastApp = landedPost(r3, 'FEAT-942').get('app.js');
  check('P4 group: one commit holds both tickets\' landed bytes (app.js = the latest landing, util.js = FEAT-942\'s)', fa.code === 0 && fb2.code === 0 && gcm.code === 0 && blobOf(r3, 'HEAD', 'app.js') === hashAsStored(r3, 'app.js', lastApp) && rd(r3, 'app.js').includes('FEAT-941') && rd(r3, 'app.js').includes('FEAT-942'), `${fa.out}\n${fb2.out}\n${gcm.out}`);
}

/* ════════════════════════════════════════════ crash, race, eligibility, metrics */
console.log('\n── interrupted landing, concurrent writer, eligibility, metrics');
{
  const real = makeReal({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
  sh(['lane-new', 'FEAT-951', '--repo', real]); const L = lane('FEAT-951', real);
  for (const f of ['a', 'b', 'c']) w(L, `${f}.txt`, `${f} FEAT-951\n`);
  ag(L, ['commit', '-qam', 'abc']);
  const inv0 = inventory(real);
  const crash = sh(['land', 'FEAT-951', '--repo', real], { extra: { ORCHARD_SHADOW_TEST_CRASH_AFTER: '2' } });
  const half = rd(real, 'a.txt').includes('FEAT-951') && !rd(real, 'c.txt').includes('FEAT-951');
  const blocked = sh(['land', 'FEAT-951', '--repo', real]);
  const inv = sh(['inventory', '--repo', real]);
  check('CRASH a landing killed mid-way leaves a pending journal that blocks further landings (exit 4) and shows in inventory', crash.code === 9 && half && blocked.code === 4 && /interrupted/.test(blocked.out) && /INTERRUPTED/.test(inv.out), `${crash.code} ${blocked.out} ${inv.out}`);
  const rec = sh(['recover', '--repo', real]);
  // (the FEAT-170 candidate store under .git/orchard-candidates is the sanctioned claim written at land; excluded by name)
  const dRec = invDiff(inv0, inventory(real)).filter((x) => !x.startsWith('.git/orchard-candidates'));
  check('CRASH recover puts the shared tree back exactly (full inventory incl. permission bits) and the landing can then run', rec.code === 0 && dRec.length === 0 && sh(['land', 'FEAT-951', '--repo', real]).code === 0, rec.out + dRec.join('\n'));

  const r2 = makeReal({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  sh(['lane-new', 'FEAT-952', '--repo', r2]); const L2 = lane('FEAT-952', r2);
  w(L2, 'a.txt', 'a FEAT-952\n'); w(L2, 'b.txt', 'b FEAT-952\n'); ag(L2, ['commit', '-qam', 'ab']);
  const race = sh(['land', 'FEAT-952', '--repo', r2], { extra: { ORCHARD_SHADOW_TEST_PRESWAP_WRITE: 'a.txt=a by a concurrent writer\n' } });
  const stray = fs.readdirSync(r2).filter((n) => n.includes('orchard-'));
  check('RACE a write that lands between the plan and the swap is detected (exit 4); the writer\'s bytes survive; nothing else changed; no stray files',
    race.code === 4 && rd(r2, 'a.txt') === 'a by a concurrent writer\n' && rd(r2, 'b.txt') === 'b\n' && stray.length === 0, `${race.out} stray=${stray}`);

  const reg = path.join(S, 'registry.json');
  const r3 = makeReal();
  fs.writeFileSync(reg, JSON.stringify({ version: 1, projects: [{ id: 'boxed', hostPath: r3, isolation: 'container' }] }));
  const c = sh(['lane-new', 'FEAT-953', '--repo', r3]);
  check('ELIGIBILITY a registered container project is refused (pilot refused, no protection claimed)', c.code !== 0 && /container project/.test(c.out), c.out);
  const inC = sh(['lane-new', 'FEAT-954', '--repo', r3], { extra: { ORCHARD_SHADOW_TEST_IN_CONTAINER: '0' } });
  check('ELIGIBILITY inside a container the CLI refuses (exit 2)', !fs.existsSync('/.dockerenv') || (inC.code === 2 && /inside a container/.test(inC.out)), inC.out);
  const nog = path.join(S, 'nogit'); fs.mkdirSync(nog);
  const ng = sh(['lane-new', 'FEAT-955', '--repo', nog]);
  check('ELIGIBILITY a non-git project is refused', ng.code !== 0 && /not a git repository/.test(ng.out), ng.out);

  // Verify 0b8d47da: a project with no commit has no line provenance → the pilot refuses it (before: land silently dropped a landed line).
  const nh = path.join(S, 'nohead'); fs.mkdirSync(nh); fx(nh, 'init', '-q'); w(nh, 'f.txt', 'A\nB\n');
  const nhNew = sh(['lane-new', 'FEAT-956', '--repo', nh]);
  check('ELIGIBILITY a project with no commit yet is refused (no provenance for REVERTS-FOREIGN; verify 0b8d47da)', nhNew.code !== 0 && /no commit yet/.test(nhNew.out), nhNew.out);
  const m = sh(['metrics', '--repo', path.join(S, 'real-2'), '--json']);
  let mj = null; try { mj = JSON.parse(m.out); } catch { /* */ }
  check('METRICS conflict rate, resolution chain, setup cost per lane and foreign-edit incidents are reported for the P1 project',
    !!mj && mj.conflictRate.refusedOverlap === 1 && mj.conflictRate.attempts >= 4 && mj.resolution.resolved === 1 && mj.resolution.oneSync === 1
    && mj.setupCost.lanes === 3 && mj.setupCost.medianMs > 0 && mj.foreignEdits.mergedClean >= 1 && mj.loss.reportedSilentLoss === 0, m.out);
  const mt = sh(['metrics', '--repo', path.join(S, 'real-2')]);
  check('METRICS the human report names all three metrics and says no report ≠ zero loss', /conflict rate/.test(mt.out) && /setup cost per lane/.test(mt.out) && /foreign-edit incidents/.test(mt.out) && /NO report is not proof/.test(mt.out), mt.out);
  const ret = sh(['retire', '--repo', path.join(S, 'real-2')]);
  check('RETIRE refuses while landed work is uncommitted, and names the unland commands', ret.code === 3 && /unland FEAT-90/.test(ret.out), ret.out);
}

console.log(`\n${failN === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${failN} failed`);
try { fs.rmSync(S, { recursive: true, force: true }); } catch { /* */ }
process.exit(failN === 0 ? 0 : 1);
