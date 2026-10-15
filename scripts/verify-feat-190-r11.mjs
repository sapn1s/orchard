/**
 * verify-feat-190-r11.mjs — the fixture-source push door (FEAT-190 r11; IV 184b8f70).
 *
 * The door the r10 clean-room found: a BARE source repo under a scratch/fixture root, carrying
 * committed leaky history, could PUSH to a registered project's REAL remote. Two seams:
 *   (1) decidePush EXEMPTED every fixture source from the r10 one-resolved-repo invariant
 *       (`!inFixture(srcCommon)`), so a bare/redirected FIXTURE source was never checked; and
 *   (2) index.ts gated `sourceGateRepo ?? target?.hostPath ?? repoPath`, so when the bare source
 *       produced no resolved toplevel the gate scanned the CLEAN session project and PASSED while
 *       the unscanned scratch history published.
 *
 * The fix: the fixture-source exemption from the invariant applies ONLY when the push DESTINATION
 * is also scratch/fixture. A fixture source pushing to any NON-scratch remote (a network URL, or a
 * path outside the scratch roots — a real registered remote) gets the full invariant, so a bare
 * source is refused, fail closed; and index.ts gates ONLY the resolved gateRepo (no hostPath/cwd
 * substitution) — a null gateRepo fails the gate closed.
 *
 * Each refused case is also shown ALLOWED against a surgically reverted PRE-CHANGE copy of the
 * chokepoint (the r10 single-guard exemption), i.e. a genuine must-FAIL. The DOOR is also driven
 * end-to-end through the REAL /api/git-shim/decide route, and seam (2) is pinned in index.ts source.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Real git, never the session PATH shim (which blocks this script's own setup writes).
process.env.PATH = String(process.env.PATH || '').split(':').filter((p) => !/orchard-git-shim/.test(p)).join(':');

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const LIB = path.join(ROOT, 'scripts', 'lib');
// BASE (under $HOME) is the REAL area: the registered project + a real local remote live here and
// are NOT under any default fixture root. SCRATCH is a fresh dir under os.tmpdir(), which IS a
// default fixture root (defaultFixtureRoots), so the bare scratch SOURCE is classified fixture
// both in the unit tests (fixtureRoots: FIX) AND server-side in the end-to-end (default roots).
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.feat190-r11-')));
const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'f190r11-scratch-')));
const FIX = [SCRATCH]; // the fixture root for the unit tests — BASE itself is "real"

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`  FAIL: ${m}`); } };
const git = (d, ...a) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8' });

function mkworking(dir, { leak = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
  if (leak) fs.writeFileSync(path.join(dir, 'secret.md'), `path = ${os.homedir()}/projects/secret-thing/key\n`);
  else fs.writeFileSync(path.join(dir, 'f.txt'), 'hi\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init');
  return fs.realpathSync(dir);
}
function mkbare(dir, fromWorking, originUrl) {
  spawnSync('git', ['clone', '-q', '--bare', fromWorking, dir]);
  if (originUrl) git(dir, 'remote', 'set-url', 'origin', originUrl);
  return fs.realpathSync(dir);
}

/** A surgically PRE-CHANGE (r10) copy of agent-git-policy.mjs: restore the single-guard fixture
 * exemption (skip the invariant for ANY fixture source, regardless of destination). Everything
 * else (destScratch classification, deferred destination returns) is unchanged — this isolates the
 * one seam the fix closed. Relative imports rewritten to absolute so it loads from BASE. */
function writePreChangeCopy() {
  let s = fs.readFileSync(path.join(LIB, 'agent-git-policy.mjs'), 'utf8');
  const before = 'if (srcCommon && !(srcIsFixture && destScratch)) {';
  const after = 'if (srcCommon && !srcIsFixture) {'; // r10: fixture source ALWAYS exempt
  if (!s.includes(before)) throw new Error('pre-change anchor not found (fix not present?)');
  s = s.replace(before, after);
  s = s.replace(/from '\.\//g, `from '${LIB}/`);
  const dst = path.join(BASE, 'pre.mjs');
  fs.writeFileSync(dst, s);
  if (!s.includes('!srcIsFixture)')) throw new Error('pre-change copy did not revert the exemption');
  return dst;
}

try {
  const P = await import(path.join(LIB, 'agent-git-policy.mjs'));
  const GT = await import(path.join(LIB, 'git-target.mjs'));
  const RI = await import(path.join(LIB, 'repo-identity.mjs'));
  const PRE = await import(writePreChangeCopy());

  // The session project: a REAL registered repo (NOT under a fixture root), standing scoped+push.
  const PROJ = mkworking(path.join(BASE, 'project'));
  git(PROJ, 'remote', 'add', 'origin', 'https://github.com/me/proj.git');
  const sessionProjects = [{
    id: 'proj', name: 'proj', ...P.describeRegisteredRepo(PROJ),
    policy: P.normalizeGitWrite({ commit: true, push: true }), timedGrantLive: false, binding: RI.grantBindingOf(PROJ),
  }];

  // A leaky bare SOURCE under the scratch root, its origin a REAL network remote.
  const LEAK = mkworking(path.join(BASE, 'leakwork'), { leak: true });
  const SCR_BARE = mkbare(path.join(SCRATCH, 'scr.git'), LEAK, 'https://github.com/me/proj.git');
  // A real LOCAL remote OUTSIDE the scratch root (a registered-style real remote).
  const REAL_BARE = mkbare(path.join(BASE, 'real-remote.git'), LEAK, null);
  // A scratch bare DEST under the scratch root (scratch-to-scratch), and a non-leaky scratch clone.
  const DEST_BARE = mkbare(path.join(SCRATCH, 'dest.git'), LEAK, null);
  const CLEAN_WORK = mkworking(path.join(SCRATCH, 'cleanwork'));

  // Drive the real resolveWriteTarget for a `git --git-dir=<bare> push origin main` from cwd=PROJ.
  const pushViaGitDir = (gitDir, cwd = PROJ, mod = P) => {
    const argv = [`--git-dir=${gitDir}`, 'push', 'origin', 'main'];
    const target = GT.resolveWriteTarget(argv, process.env, { realGit: 'git', cwd });
    return { target, d: mod.decideByTarget({ argv, target, sessionProjectId: 'proj', projects: sessionProjects, fixtureRoots: FIX }) };
  };

  // ── 1. THE DOOR: a BARE fixture source pushing to a NETWORK (real) remote is REFUSED ──
  console.log('-- 1. bare fixture source --git-dir push → network remote --');
  {
    const r = pushViaGitDir(SCR_BARE);
    ok(r.target.commonDir && r.target.toplevel === null, `setup: the bare source resolves to commonDir in scratch, toplevel null (top=${r.target.toplevel})`);
    ok(r.d.refusal && /bare repository/i.test(r.d.refusal), `the bare fixture source → real remote is REFUSED, fail closed (refusal=${r.d.refusal ? r.d.refusal.slice(0, 60) : null})`);
    const pre = pushViaGitDir(SCR_BARE, PROJ, PRE);
    ok(pre.d.refusal === null, `MUST-FAIL(pre-change r10): the bare fixture source → real remote was ALLOWED (refusal=${pre.d.refusal})`);
  }

  // ── 2. a BARE fixture source pushing to a real LOCAL remote OUTSIDE the scratch roots: REFUSED ──
  console.log('-- 2. bare fixture source → real local remote outside scratch --');
  {
    git(SCR_BARE, 'remote', 'set-url', 'origin', REAL_BARE);
    const r = pushViaGitDir(SCR_BARE);
    ok(r.d.refusal && /bare repository/i.test(r.d.refusal), `REFUSED (refusal=${r.d.refusal ? r.d.refusal.slice(0, 50) : null})`);
    const pre = pushViaGitDir(SCR_BARE, PROJ, PRE);
    ok(pre.d.refusal === null, `MUST-FAIL(pre-change): was ALLOWED to the real local remote (refusal=${pre.d.refusal})`);
    git(SCR_BARE, 'remote', 'set-url', 'origin', 'https://github.com/me/proj.git'); // restore
  }

  // ── 3. scratch-to-scratch: a bare fixture source → a fixture bare remote is STILL ALLOWED ──
  console.log('-- 3. bare fixture source → fixture bare remote (scratch-to-scratch) still allowed --');
  {
    git(SCR_BARE, 'remote', 'set-url', 'origin', DEST_BARE);
    const r = pushViaGitDir(SCR_BARE);
    ok(r.d.refusal === null, `ALLOWED (the exemption still holds when the destination is ALSO scratch) (refusal=${r.d.refusal})`);
    git(SCR_BARE, 'remote', 'set-url', 'origin', 'https://github.com/me/proj.git'); // restore
  }

  // ── 4. a NORMAL (non-bare) fixture working source → fixture bare remote is ALLOWED ──
  //    (the invariant passes — one consistent repo — and the gate would scan the real source).
  console.log('-- 4. normal fixture working clone → fixture bare remote still allowed --');
  {
    git(CLEAN_WORK, 'remote', 'add', 'origin', DEST_BARE);
    const argv = ['push', 'origin', 'main'];
    const target = GT.resolveWriteTarget(argv, process.env, { realGit: 'git', cwd: CLEAN_WORK });
    const d = P.decideByTarget({ argv, target, sessionProjectId: 'proj', projects: sessionProjects, fixtureRoots: FIX });
    ok(d.refusal === null, `ALLOWED; gateRepo is the real source toplevel (gateRepo=${d.gateRepo})`);
    ok(d.gateRepo === CLEAN_WORK, `the leak gate scans the real fixture SOURCE work tree, not a substitute (gateRepo=${d.gateRepo})`);
  }

  // ── 5. a NORMAL non-fixture (real) source → network remote is unaffected (allowed, granted) ──
  console.log('-- 5. real source → network remote unaffected --');
  {
    const argv = ['push', 'origin', 'main'];
    const target = GT.resolveWriteTarget(argv, process.env, { realGit: 'git', cwd: PROJ });
    const d = P.decideByTarget({ argv, target, sessionProjectId: 'proj', projects: sessionProjects, fixtureRoots: FIX });
    ok(d.refusal === null, `the granted session's OWN real repo → its network remote is ALLOWED (refusal=${d.refusal})`);
    ok(d.gateRepo === PROJ, `the gate scans the real source (gateRepo=${d.gateRepo})`);
  }

  // ── 6. SOURCE PIN (seam 2): index.ts gates ONLY the resolved gateRepo, no hostPath/cwd substitute ──
  console.log('-- 6. index.ts gateRepo has no hostPath/cwd substitution --');
  {
    const idx = fs.readFileSync(path.join(ROOT, 'src', 'server', 'index.ts'), 'utf8');
    ok(/const gateRepo = sourceGateRepo;/.test(idx), 'index.ts: gateRepo is sourceGateRepo ONLY (fail closed on null)');
    ok(!/sourceGateRepo \?\? target\?\.hostPath/.test(idx), 'index.ts: the `?? target?.hostPath ?? repoPath` substitution is GONE');
  }

  // ── 7. END-TO-END through the REAL /api/git-shim/decide route: the door push is REFUSED ──
  console.log('\n-- 7. end-to-end: the door push is REFUSED through the real decide route --');
  {
    const DATA = path.join(BASE, 'data'); fs.mkdirSync(DATA, { recursive: true });
    const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    const PORT = await freePort();
    process.env.CLAUDE_STATION_DATA = DATA; process.env.PORT = String(PORT);
    process.env.CLAUDE_STATION_NO_WA_CONSOLIDATE = '1'; process.env.ORCHARD_DISPATCH_SOCK = '';
    // SCRATCH is under os.tmpdir(), a default fixture root, so the server classifies the bare
    // scratch source as fixture — the door's exemption path is live server-side.
    await import(path.join(ROOT, 'src/server/index.ts'));
    await new Promise((r) => setTimeout(r, 1500));
    const reg = await import(path.join(ROOT, 'src/server/registry.ts'));
    const sec = await import(path.join(ROOT, 'scripts/lib/git-shim-secret.mjs'));
    sec._setShimSecretForTest('r11-secret'); sec._setShimBootIdForTest('r11-boot');
    const pProj = reg.createProject({ hostPath: PROJ, name: 'proj' });
    reg.setGitWritePermanent(pProj.id, true, { via: 'test' });

    const argv = [`--git-dir=${SCR_BARE}`, 'push', 'origin', 'main'];
    const target = GT.resolveWriteTarget(argv, process.env, { realGit: 'git', cwd: PROJ });
    const r = await (await fetch(`http://127.0.0.1:${PORT}/api/git-shim/decide`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grantKey: pProj.id, argv, target, shimAuth: 'r11-secret', shimBootId: 'r11-boot' }),
    })).json();
    ok(r.allow === false, `the bare fixture source → network remote is REFUSED through the real route (allow=${r.allow} kind=${r.refusalKind})`);
    ok(r.refusalKind === 'policy' && /bare repository/i.test(r.reason || ''), `the refusal is the bare-target policy message (kind=${r.refusalKind})`);
  }

  console.log(`\nFEAT-190 r11: ${pass} passed, ${fail} failed`);
} finally {
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.exit(fail ? 1 : 0);
