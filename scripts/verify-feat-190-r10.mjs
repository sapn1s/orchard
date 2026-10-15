/**
 * verify-feat-190-r10.mjs — the ONE-resolved-repo invariant (FEAT-190 r10).
 *
 * The property under repair: for ONE gated publish write (commit/push/send-pack) every consumer —
 * the permission decision, the leak gate, the cross-repo reach log and the audit entry — must act
 * on the SAME repo. r8/r9 kept breaking on invocation forms where cwd ≠ the resolved target
 * (--git-dir, --work-tree, GIT_DIR/GIT_WORK_TREE, core.worktree config-injection, bare, linked
 * worktree). r10 refuses, fail-closed, any form that splits git's repository from its work tree
 * (via ANY channel) or targets a bare repo; cwd / -C / a linked worktree / a CONSISTENT
 * --git-dir+--work-tree all pass and leave the consumers on one repo.
 *
 * Unlike verify-feat-190-matrix.mjs (which hand-builds `target` objects and so can only exercise
 * CONSISTENT redirects), this drives the REAL `resolveWriteTarget` with real invocation forms
 * (argv globals AND env), so a true git-dir≠work-tree split is actually produced — the gap the
 * independent reviewer named (a hand-built target would never catch the core.worktree channel).
 * Each refused form is also shown ALLOWED (or gated at the wrong repo) against a surgically
 * reverted PRE-CHANGE copy of the chokepoint, i.e. a genuine must-FAIL. FINDING 1 (own linked
 * worktree) is also proven end-to-end through the REAL /api/git-shim/decide route + real leak gate.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Real git, never the session PATH shim.
process.env.PATH = String(process.env.PATH || '').split(':').filter((p) => !/orchard-git-shim/.test(p)).join(':');

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const LIB = path.join(ROOT, 'scripts', 'lib');
const BASE = fs.mkdtempSync(path.join(os.homedir(), '.feat190-r10-'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`  FAIL: ${m}`); } };
const git = (d, ...a) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8' });

function mkrepo(name) {
  const d = path.join(BASE, name);
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'user.email', 't@t'); git(d, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'f.txt'), 'hi\n');
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'init');
  git(d, 'remote', 'add', 'origin', `https://example.invalid/${name}.git`);
  return fs.realpathSync(d);
}

/** A surgically PRE-CHANGE copy of agent-git-policy.mjs: the r10 invariant removed and the two
 * cwd/ownsRepo fallbacks restored (r9 behaviour). Relative imports rewritten to absolute so it
 * loads from BASE. This is the real pre-change code the must-FAIL cases run against. */
function writePreChangeCopy() {
  let s = fs.readFileSync(path.join(LIB, 'agent-git-policy.mjs'), 'utf8');
  // decideByTarget: drop the invariant block.
  s = s.replace(/\n  \/\/ FEAT-190 r10 — the ONE-resolved-repo invariant:[\s\S]*?\n  }\n(?=  \/\/ A real repo:)/, '\n');
  // decideByTarget: restore the ownsRepo→null gate fallback.
  s = s.replace('    const gateRepo = targetToplevelOf(t, tgt);\n    return { refusal: null, key: sessionProjectId, ...(gateRepo ? { gateRepo } : {}) };',
    '    const gateRepo = gg.ownsRepo ? null : targetToplevelOf(t, tgt);\n    return { refusal: null, key: sessionProjectId, ...(gateRepo ? { gateRepo } : {}) };');
  // decidePush: restore the srcTop cwd fallback and drop its invariant block.
  s = s.replace("  const srcTop = (source && typeof source.toplevel === 'string' && source.toplevel) || null;",
    "  const srcTop = (source && typeof source.toplevel === 'string' && source.toplevel) || cwdId?.toplevel || cwd || null;");
  s = s.replace(/\n  \/\/ FEAT-190 r10 — the ONE-resolved-repo invariant on the SOURCE[\s\S]*?\n  }\n(?=  const session =)/, '\n');
  s = s.replace(/from '\.\//g, `from '${LIB}/`);
  const dst = path.join(BASE, 'pre.mjs');
  fs.writeFileSync(dst, s);
  // sanity: both reverts landed.
  if (s.includes('resolvedRepoRefusal({ commonDir: tgt.commonDir')) throw new Error('pre-change copy still has the decideByTarget invariant');
  if (!s.includes('gg.ownsRepo ? null : targetToplevelOf')) throw new Error('pre-change copy did not restore the ownsRepo gate fallback');
  return dst;
}

try {
  const P = await import(path.join(LIB, 'agent-git-policy.mjs'));
  const GT = await import(path.join(LIB, 'git-target.mjs'));
  const RI = await import(path.join(LIB, 'repo-identity.mjs'));
  const PRE = await import(writePreChangeCopy());

  const OWN = mkrepo('own');
  const SIB = mkrepo('sib');            // a real sibling repo (its own commonDir)
  const BARE = path.join(BASE, 'bare.git'); spawnSync('git', ['init', '-q', '--bare', BARE]);
  const ELSE = path.join(BASE, 'elsewhere'); fs.mkdirSync(ELSE, { recursive: true }); // a non-repo dir for core.worktree
  const OWN_WT = path.join(BASE, 'own-wt');
  git(OWN, 'worktree', 'add', '-q', OWN_WT, '-b', 'wt');
  const worktreeOk = fs.existsSync(path.join(OWN_WT, 'f.txt'));

  // The session project: a standing SCOPED grant (commit + push) on OWN.
  const sessionProjects = [{
    id: 'own', name: 'own', ...P.describeRegisteredRepo(OWN),
    policy: P.normalizeGitWrite({ commit: true, push: true }), timedGrantLive: false, binding: RI.grantBindingOf(OWN),
  }];
  const decide = (argv, env = process.env, cwd = OWN, mod = P) => {
    const target = GT.resolveWriteTarget(argv, env, { realGit: 'git', cwd });
    return { target, d: mod.decideByTarget({ argv, target, sessionProjectId: 'own', projects: sessionProjects, fixtureRoots: [] }) };
  };
  const allowed = (r) => r.d.refusal === null;
  const envWith = (extra) => ({ ...process.env, ...extra });

  // ── ALLOWED forms: cwd / -C / linked worktree / CONSISTENT --git-dir+--work-tree ──────────
  console.log('\n-- allowed forms (one resolved repo; consumers agree) --');
  {
    const cwdC = decide(['commit', '-m', 'x'], process.env, OWN);
    ok(allowed(cwdC), `cwd commit allowed (reason=${(cwdC.d.refusal || '').slice(0, 50)})`);
    ok(cwdC.d.gateRepo === OWN || cwdC.d.gateRepo === undefined || cwdC.d.gateRepo === fs.realpathSync(OWN),
      `cwd commit gates OWN (gateRepo=${cwdC.d.gateRepo})`);

    const dashC = decide(['-C', OWN, 'commit', '-m', 'x'], process.env, BASE);
    ok(allowed(dashC), `-C OWN commit allowed (reason=${(dashC.d.refusal || '').slice(0, 50)})`);

    if (worktreeOk) {
      const wtC = decide(['commit', '-m', 'x'], process.env, OWN_WT);
      ok(allowed(wtC), `linked-worktree commit allowed (reason=${(wtC.d.refusal || '').slice(0, 50)})`);
      // FEAT-190 r10 FIX (c): the gate scans the RESOLVED worktree toplevel, NOT the main worktree.
      ok(wtC.d.gateRepo === OWN_WT || wtC.d.gateRepo === fs.realpathSync(OWN_WT),
        `linked-worktree commit gates the WORKTREE toplevel, not the main repo (gateRepo=${wtC.d.gateRepo})`);
      // MUST-FAIL: pre-change nulled gateRepo for an ownsRepo worktree → the host fell back to the
      // registered MAIN worktree (IV 4f6c97c8 FINDING 1).
      const wtPre = decide(['commit', '-m', 'x'], process.env, OWN_WT, PRE);
      ok(wtPre.d.gateRepo == null, `MUST-FAIL: pre-change gated NULL (→ main worktree) for the linked-worktree commit (gateRepo=${wtPre.d.gateRepo})`);
    }

    // CONSISTENT redirect: git-dir and work-tree both point at OWN → equivalent to cwd=OWN.
    const consist = decide(['--git-dir=' + path.join(OWN, '.git'), '--work-tree=' + OWN, 'commit', '-m', 'x'], process.env, BASE);
    ok(allowed(consist), `consistent --git-dir+--work-tree=OWN commit allowed (reason=${(consist.d.refusal || '').slice(0, 50)})`);
    ok(consist.target.commonDir && consist.target.toplevel, 'consistent redirect resolved both commonDir and toplevel');
  }

  // ── REFUSED forms: a git-dir≠work-tree split (any channel) or a bare target ───────────────
  console.log('\n-- refused forms (split / bare: consumers would diverge) --');
  const isRedirect = (r) => r.d.refusal && /points git's repository and working tree at DIFFERENT/.test(r.d.refusal);
  const isBare = (r) => r.d.refusal && /bare repository/.test(r.d.refusal);
  {
    // SPLIT via --git-dir alone (no --work-tree): git uses cwd=OWN as the work tree while the repo
    // is SIB → the gate would scan OWN (clean) while the commit lands in SIB.
    const gd = decide(['--git-dir=' + path.join(SIB, '.git'), 'commit', '-m', 'x'], process.env, OWN);
    ok(gd.target.commonDir && gd.target.toplevel && fs.realpathSync(gd.target.commonDir) !== fs.realpathSync(path.join(fs.realpathSync(gd.target.toplevel), '.git')),
      `setup: --git-dir=SIB from cwd=OWN really splits (commonDir=${path.basename(path.dirname(gd.target.commonDir || ''))} toplevel=${path.basename(gd.target.toplevel || '')})`);
    ok(isRedirect(gd), `--git-dir=SIB (cwd=OWN) split REFUSED with the redirect message (reason=${(gd.d.refusal || '').split('\n')[0].slice(0, 60)})`);
    ok(allowed(decide(['--git-dir=' + path.join(SIB, '.git'), 'commit', '-m', 'x'], process.env, OWN, PRE)),
      'MUST-FAIL: pre-change ALLOWED the --git-dir=SIB split (no invariant)');

    // SPLIT via the --work-tree flag (the direct flag form).
    const wt = decide(['--work-tree=' + ELSE, 'commit', '-m', 'x'], process.env, OWN);
    ok(wt.target.toplevel && fs.realpathSync(wt.target.toplevel) === fs.realpathSync(ELSE),
      `setup: --work-tree=ELSE really redirects the work tree (toplevel=${path.basename(wt.target.toplevel || '')})`);
    ok(isRedirect(wt), `--work-tree=ELSE split REFUSED (reason=${(wt.d.refusal || '').split('\n')[0].slice(0, 60)})`);
    ok(allowed(decide(['--work-tree=' + ELSE, 'commit', '-m', 'x'], process.env, OWN, PRE)),
      'MUST-FAIL: pre-change ALLOWED the --work-tree split');

    // REFUTES reviewer MUST-FIX 1: git DELIBERATELY IGNORES core.worktree supplied via `-c`,
    // `--config-env` and the GIT_CONFIG_* env (a git safety measure — it is honoured ONLY from the
    // repo's own config file or GIT_WORK_TREE). Verified live (git 2.5x): each resolves the work
    // tree to OWN, NOT ELSE, so there is no split and the write is correctly ALLOWED. The invariant
    // still structurally backstops the forms that CAN split (--work-tree / GIT_WORK_TREE, above).
    for (const [label, argv, env] of [
      ['-c core.worktree', ['-c', 'core.worktree=' + ELSE, 'commit', '-m', 'x'], process.env],
      ['--config-env core.worktree', ['--config-env=core.worktree=CW', 'commit', '-m', 'x'], envWith({ CW: ELSE })],
      ['GIT_CONFIG_* core.worktree', ['commit', '-m', 'x'], envWith({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: ELSE })],
    ]) {
      const r = decide(argv, env, OWN);
      ok(r.target.toplevel && fs.realpathSync(r.target.toplevel) === fs.realpathSync(OWN),
        `${label}: git IGNORES it for worktree discovery (toplevel resolves to OWN, not ELSE) — not a redirect channel`);
      ok(allowed(r), `${label}: correctly ALLOWED (no split; git ignored the injected core.worktree)`);
    }

    // SPLIT via GIT_WORK_TREE env.
    const gwt = decide(['commit', '-m', 'x'], envWith({ GIT_WORK_TREE: ELSE }), OWN);
    ok(isRedirect(gwt), `GIT_WORK_TREE=ELSE env split REFUSED (reason=${(gwt.d.refusal || '').split('\n')[0].slice(0, 60)})`);
    ok(allowed(decide(['commit', '-m', 'x'], envWith({ GIT_WORK_TREE: ELSE }), OWN, PRE)),
      'MUST-FAIL: pre-change ALLOWED the GIT_WORK_TREE env split');

    // BARE target via --git-dir.
    const bd = decide(['--git-dir=' + BARE, 'commit', '-m', 'x'], process.env, OWN);
    ok(bd.target.commonDir && !bd.target.toplevel, `setup: bare --git-dir=BARE resolves commonDir but NO toplevel (toplevel=${bd.target.toplevel})`);
    ok(isBare(bd), `bare --git-dir=BARE commit REFUSED as bare (reason=${(bd.d.refusal || '').split('\n')[0].slice(0, 60)})`);
    ok(allowed(decide(['--git-dir=' + BARE, 'commit', '-m', 'x'], process.env, OWN, PRE)),
      'MUST-FAIL: pre-change ALLOWED the bare-repo commit');

    // BARE target via GIT_DIR env.
    const bde = decide(['commit', '-m', 'x'], envWith({ GIT_DIR: BARE }), OWN);
    ok(isBare(bde), `GIT_DIR=BARE env commit REFUSED as bare (reason=${(bde.d.refusal || '').split('\n')[0].slice(0, 60)})`);

    // BARE target PUSH via --git-dir (IV 4f6c97c8 FINDING 2: pre-change gated cwd=OWN, not the bare target).
    const bp = decide(['--git-dir=' + BARE, 'push', 'origin', 'main'], process.env, OWN);
    ok(bp.d.refusal, `bare --git-dir=BARE push REFUSED (reason=${(bp.d.refusal || '').split('\n')[0].slice(0, 60)})`);
    const bpPre = decide(['--git-dir=' + BARE, 'push', 'origin', 'main'], process.env, OWN, PRE);
    ok(bpPre.d.gateRepo && (bpPre.d.gateRepo === OWN || bpPre.d.gateRepo === fs.realpathSync(OWN)),
      `MUST-FAIL: pre-change gated the cwd repo OWN for the bare --git-dir push (gateRepo=${bpPre.d.gateRepo})`);
  }

  // ── FINDING 1 end-to-end: a leak staged ONLY in a linked worktree is caught by the gate ──
  // Driven through the REAL /api/git-shim/decide route + the real leak gate on an isolated server,
  // because a gate failure only materialises server-side.
  console.log('\n-- FINDING 1 end-to-end: linked-worktree leak caught by the gate (real route) --');
  if (worktreeOk) {
    const DATA = path.join(BASE, 'data'); fs.mkdirSync(DATA, { recursive: true });
    const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    const PORT = await freePort();
    process.env.CLAUDE_STATION_DATA = DATA; process.env.PORT = String(PORT);
    process.env.CLAUDE_STATION_NO_WA_CONSOLIDATE = '1'; process.env.ORCHARD_DISPATCH_SOCK = '';
    await import(path.join(ROOT, 'src/server/index.ts'));
    await new Promise((r) => setTimeout(r, 1500));
    const reg = await import(path.join(ROOT, 'src/server/registry.ts'));
    const sec = await import(path.join(ROOT, 'scripts/lib/git-shim-secret.mjs'));
    sec._setShimSecretForTest('r10-secret'); sec._setShimBootIdForTest('r10-boot');
    const pOwn = reg.createProject({ hostPath: OWN, name: 'own' });
    reg.setGitWritePermanent(pOwn.id, true, { via: 'test' });

    // Plant a leak ONLY in the linked worktree; the main worktree stays clean. Built from $HOME at
    // runtime so this file carries no literal secret (npm run gate scans scripts/).
    const home = process.env.HOME || os.homedir();
    fs.writeFileSync(path.join(OWN_WT, 'leak.md'), `path = ${home}/projects/secret-thing/config\n`);
    const gateScript = path.join(ROOT, 'scripts', 'leak-gate.mjs');
    const gateOn = (repo) => spawnSync(process.execPath, [gateScript, '--summary'], { cwd: repo, encoding: 'utf8' }).status;
    ok(gateOn(OWN) === 0, 'setup: the gate PASSES on the clean MAIN worktree (what pre-change scanned)');
    ok(gateOn(OWN_WT) !== 0, 'setup: the gate FAILS on the linked worktree carrying the leak (what post-change scans)');

    const WT_ID = RI.repoIdentityOf(OWN_WT);
    const decideRoute = async (argv, target) => (await fetch(`http://127.0.0.1:${PORT}/api/git-shim/decide`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grantKey: pOwn.id, argv, target, shimAuth: 'r10-secret', shimBootId: 'r10-boot' }),
    })).json();
    // The real resolved target for `git commit` from cwd=OWN_WT (commonDir shared with OWN, toplevel=OWN_WT).
    const wtTarget = GT.resolveWriteTarget(['commit', '-m', 'x'], process.env, { realGit: 'git', cwd: OWN_WT });
    const r = await decideRoute(['commit', '-m', 'x'], wtTarget);
    ok(r.allow === false, `FINDING 1: a commit from the linked worktree carrying the leak is REFUSED (allow=${r.allow} kind=${r.refusalKind})`);
    ok(r.refusalKind === 'gate-failed', `FINDING 1: the refusal is a GATE failure on the worktree, not an ungranted refusal (kind=${r.refusalKind})`);
    void WT_ID;
  }

  console.log(`\nFEAT-190 r10: ${pass} passed, ${fail} failed`);
} finally {
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.exit(fail ? 1 : 0);
