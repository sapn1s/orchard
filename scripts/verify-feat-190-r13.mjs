#!/usr/bin/env node
/**
 * verify-feat-190-r13.mjs — the two r12-IV doors, closed by moving BOTH decisions INTO the ONE
 * chokepoint (effectiveGitPermission).
 *
 * The r12 clean-room (IV ebe93a04) found two allow/deny decisions made OUTSIDE effectiveGitPermission,
 * so a per-repo opt-out stopped only one of commit/push:
 *   DOOR A — decidePush's destination veto loop IGNORED the session's OWN repoOverrides for the
 *            DESTINATION repo, so a push INTO a `disabled:true` repo from the session's own repo was
 *            ALLOWED (only OTHER registered owners could veto; an unregistered destination had none).
 *   DOOR B — decideByTarget SHORT-CIRCUITED on `inFixture(where)` before the chokepoint, so a commit
 *            in a session-opted-out repo UNDER A FIXTURE ROOT (os.tmpdir()) was ALLOWED while a push
 *            from the same repo was REFUSED — the verbs disagreed for the same opted-out repo.
 *
 * The fix (r13): effectiveGitPermission takes the SOURCE and (for a push) the DESTINATION repo and
 * applies the per-repo opt-outs to BOTH; fixture/scratch status is an INPUT it considers (a named
 * allow on scratch→scratch) that NEVER overrides an explicit opt-out. decideByTarget/decidePush
 * resolve inputs, call the chokepoint, and render — no allow/deny of their own.
 *
 * Each door is a MUST-FAIL against a SURGICALLY reverted PRE-CHANGE copy (door A: the destination's
 * session opt-out dropped; door B: the inFixture short-circuit restored) — a genuine must-fail.
 * Plus the full opt-out matrix: an opted-out repo refuses BOTH verbs in EVERY reachability role
 * {own, sibling, fixture, destination-only}. Real scratch git repos; cleaned in a finally.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.PATH = String(process.env.PATH || '').split(':').filter((p) => !/orchard-git-shim/.test(p)).join(':');

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const LIB = path.join(ROOT, 'scripts', 'lib');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error(`  FAIL: ${m}`); } };
const section = (s) => console.log(`\n== ${s} ==`);

const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
function mkrepo(dir, { bareRemote = null } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'hi\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init');
  if (bareRemote) git(dir, 'remote', 'add', 'origin', bareRemote);
  return fs.realpathSync(dir);
}

/** A surgically PRE-CHANGE copy of agent-git-policy.mjs re-opening ONE door at a time:
 *   door 'A' — drop the session's OWN repoOverride for the destination (restore door A); and
 *   door 'B' — restore decideByTarget's inFixture short-circuit before the chokepoint (restore door B).
 * Relative imports rewritten to absolute so it loads from the scratch dir. */
function writePreChangeCopy(dir, door) {
  let s = fs.readFileSync(path.join(LIB, 'agent-git-policy.mjs'), 'utf8');
  if (door === 'A') {
    const before = "const own = (commonDir && session && session.policy && session.policy.repoOverrides) ? session.policy.repoOverrides[commonDir] : null;";
    const after = "const own = null; // PRE-CHANGE door A: the destination's own-session opt-out is ignored";
    if (!s.includes(before)) throw new Error('door-A anchor not found (fix not present?)');
    s = s.replace(before, after);
    if (!s.includes('PRE-CHANGE door A')) throw new Error('door-A revert did not land');
  } else if (door === 'B') {
    const before = "const scratch = inFixture(where);";
    const after = "if (inFixture(where)) { const gr0 = targetToplevelOf(t, tgt); return { refusal: null, key: sessionProjectId, ...(gr0 ? { gateRepo: gr0 } : {}) }; }\n  const scratch = false; // PRE-CHANGE door B: fixture short-circuit returned allowed before the chokepoint";
    if (!s.includes(before)) throw new Error('door-B anchor not found (fix not present?)');
    s = s.replace(before, after);
    if (!s.includes('PRE-CHANGE door B')) throw new Error('door-B revert did not land');
  }
  s = s.replace(/from '\.\//g, `from '${LIB}/`);
  const dst = path.join(dir, `pre-${door}.mjs`);
  fs.writeFileSync(dst, s);
  return dst;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat190r13-'));
// A "real" area OUTSIDE any fixture root, for the own/sibling/destination repos.
const REAL = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.feat190r13-')));

try {
  const P = await import(path.join(LIB, 'agent-git-policy.mjs'));
  const { repoIdentityOf, resolvedRemotesOf, grantBindingOf } = await import(path.join(LIB, 'repo-identity.mjs'));
  const PRE_A = await import(writePreChangeCopy(tmp, 'A'));
  const PRE_B = await import(writePreChangeCopy(tmp, 'B'));

  const { normalizeGitWrite, validatePolicyInput, describeRegisteredRepo } = P;
  const scopedPolicy = normalizeGitWrite(validatePolicyInput({ commit: true }).value); // commit+push ON

  // The session project P (registered, scoped+push). repoOverrides is set per-case.
  const PROJ = mkrepo(path.join(REAL, 'P'));
  const Pid = repoIdentityOf(PROJ);
  const mkSession = (repoOverrides) => [{
    id: 'P', name: 'P', ...describeRegisteredRepo(PROJ),
    policy: repoOverrides ? { ...scopedPolicy, repoOverrides } : scopedPolicy,
    timedGrantLive: false, binding: grantBindingOf(PROJ),
  }];

  const commitTarget = (repo, id) => ({ cwd: repo, commonDir: id.commonDir, toplevel: id.toplevel, verb: 'commit', resolvedVerb: true });
  const pushTarget = (repo, id, url) => ({ cwd: repo, commonDir: id.commonDir, toplevel: id.toplevel, verb: 'push', resolvedVerb: true, push: { urls: [url] } });
  const decideCommit = (mod, repo, id, projects, fixtureRoots = []) => mod.decideByTarget({ argv: ['commit', '-m', 'x'], target: commitTarget(repo, id), sessionProjectId: 'P', projects, fixtureRoots });
  const decidePushInto = (mod, srcRepo, srcId, url, projects, fixtureRoots = []) => mod.decideByTarget({ argv: ['push', url, 'main'], target: pushTarget(srcRepo, srcId, url), sessionProjectId: 'P', projects, fixtureRoots });

  /* ───────────────────────── DOOR A: push INTO an opted-out destination ───────────────────────── */
  section('DOOR A — a push INTO a session-opted-out DESTINATION repo (from the session\'s own repo) is REFUSED');
  {
    const Q = mkrepo(path.join(REAL, 'Qa'));                 // the destination repo, unregistered
    const Qid = repoIdentityOf(Q);
    const projects = mkSession({ [Qid.commonDir]: { disabled: true } }); // the session turned Q OFF
    // Push FROM the session's own repo P INTO Q as a local-path destination.
    const d = decidePushInto(P, PROJ, Pid, Q, projects);
    ok(!!d.refusal && /destination/i.test(d.refusal), `the push INTO the opted-out destination Q is REFUSED (${d.refusal ? d.refusal.slice(0, 70) : 'allowed'})`);
    // MUST-FAIL: the pre-change copy (door A open) ALLOWS it.
    const pre = decidePushInto(PRE_A, PROJ, Pid, Q, projects);
    ok(pre.refusal === null, `MUST-FAIL (pre-change door A): the push INTO the opted-out destination was ALLOWED (${pre.refusal ? pre.refusal.slice(0, 60) : 'allowed'})`);
    // And a commit in the session's OWN repo P is still allowed (the opt-out is on Q, the destination only).
    const c = decideCommit(P, PROJ, Pid, projects);
    ok(!c.refusal, 'a commit in the session\'s own repo P is still allowed (the opt-out names only the destination Q)');
  }

  /* ───────────────────────── DOOR B: commit in an opted-out FIXTURE repo ───────────────────────── */
  section('DOOR B — a commit in a session-opted-out repo UNDER A FIXTURE ROOT is REFUSED (verbs agree)');
  {
    const QT = mkrepo(path.join(tmp, 'Qb'), { bareRemote: path.join(tmp, 'Qb-remote.git') }); // under os.tmpdir() = a fixture root
    spawnSync('git', ['init', '-q', '--bare', path.join(tmp, 'Qb-remote.git')]);
    const QTid = repoIdentityOf(QT);
    const projects = mkSession({ [QTid.commonDir]: { disabled: true } });
    const FIX = P.defaultFixtureRoots(); // includes os.tmpdir()
    const c = decideCommit(P, QT, QTid, projects, FIX);
    ok(!!c.refusal, `the COMMIT in the opted-out fixture repo QT is REFUSED (${c.refusal ? c.refusal.slice(0, 70) : 'allowed'})`);
    const pu = decidePushInto(P, QT, QTid, path.join(tmp, 'Qb-remote.git'), projects, FIX);
    ok(!!pu.refusal, `the PUSH from the opted-out fixture repo QT is REFUSED too (${pu.refusal ? pu.refusal.slice(0, 70) : 'allowed'})`);
    ok(!!c.refusal === !!pu.refusal, 'DOOR B: commit and push AGREE for the opted-out fixture repo (both refused)');
    // MUST-FAIL: the pre-change copy (door B open) ALLOWS the commit while the push is refused — the asymmetry.
    const preC = decideCommit(PRE_B, QT, QTid, projects, FIX);
    ok(preC.refusal === null, `MUST-FAIL (pre-change door B): the commit in the opted-out fixture repo was ALLOWED (${preC.refusal ? preC.refusal.slice(0, 60) : 'allowed'})`);
    const prePu = decidePushInto(PRE_B, QT, QTid, path.join(tmp, 'Qb-remote.git'), projects, FIX);
    ok(!!prePu.refusal, 'MUST-FAIL (pre-change door B): the push from the same repo WAS already refused — the pre-change verbs DISAGREED');
    ok((preC.refusal === null) !== (!!prePu.refusal === false), 'MUST-FAIL (pre-change door B): commit allowed but push refused — the door');
  }

  /* ─────── opt-out × {own, sibling, fixture, destination-only} × {commit, push}: BOTH refused ─────── */
  section('opt-out matrix — an opted-out repo refuses BOTH commit and push in EVERY reachability role');
  const FIX = P.defaultFixtureRoots();
  // own: the session's OWN project repo turned off.
  {
    const projects = mkSession({ [Pid.commonDir]: { disabled: true } });
    const c = decideCommit(P, PROJ, Pid, projects);
    const pu = decidePushInto(P, PROJ, Pid, 'https://example.invalid/P.git', projects);
    ok(!!c.refusal, 'own: commit in the opted-out OWN repo is refused');
    ok(!!pu.refusal, 'own: push from the opted-out OWN repo is refused');
  }
  // sibling: an unregistered sibling (real area) turned off.
  {
    const S = mkrepo(path.join(REAL, 'Sib'), { bareRemote: path.join(REAL, 'Sib-remote.git') });
    spawnSync('git', ['init', '-q', '--bare', path.join(REAL, 'Sib-remote.git')]);
    const Sid = repoIdentityOf(S);
    const projects = mkSession({ [Sid.commonDir]: { disabled: true } });
    const c = decideCommit(P, S, Sid, projects);
    const pu = decidePushInto(P, S, Sid, path.join(REAL, 'Sib-remote.git'), projects);
    ok(!!c.refusal, 'sibling: commit in the opted-out sibling is refused');
    ok(!!pu.refusal, 'sibling: push from the opted-out sibling is refused');
  }
  // fixture: a repo under a fixture root turned off (same as door B, asserted as a matrix cell).
  {
    const F = mkrepo(path.join(tmp, 'FixRepo'), { bareRemote: path.join(tmp, 'FixRepo-remote.git') });
    spawnSync('git', ['init', '-q', '--bare', path.join(tmp, 'FixRepo-remote.git')]);
    const Fid = repoIdentityOf(F);
    const projects = mkSession({ [Fid.commonDir]: { disabled: true } });
    const c = decideCommit(P, F, Fid, projects, FIX);
    const pu = decidePushInto(P, F, Fid, path.join(tmp, 'FixRepo-remote.git'), projects, FIX);
    ok(!!c.refusal, 'fixture: commit in the opted-out fixture repo is refused');
    ok(!!pu.refusal, 'fixture: push from the opted-out fixture repo is refused');
  }
  // destination-only: a repo reached ONLY as a push destination (door A), plus a direct commit into it.
  {
    const D = mkrepo(path.join(REAL, 'Dest'));
    const Did = repoIdentityOf(D);
    const projects = mkSession({ [Did.commonDir]: { disabled: true } });
    // commit targeting D directly (the repo itself) is refused...
    const c = decideCommit(P, D, Did, projects);
    ok(!!c.refusal, 'destination-only: a commit targeting the opted-out repo is refused');
    // ...and a push INTO D from the session's own repo P is refused (door A).
    const pu = decidePushInto(P, PROJ, Pid, D, projects);
    ok(!!pu.refusal && /destination/i.test(pu.refusal), 'destination-only: a push INTO the opted-out repo (from the own repo) is refused');
  }

  /* ───── control: a NON-opted-out scratch→scratch write is still ALLOWED (scratch is store-governed) ───── */
  section('control — scratch is store-governed: a non-opted-out fixture write is still allowed (opt-out never fabricated)');
  {
    const F = mkrepo(path.join(tmp, 'okScratch'), { bareRemote: path.join(tmp, 'okScratch-remote.git') });
    spawnSync('git', ['init', '-q', '--bare', path.join(tmp, 'okScratch-remote.git')]);
    const Fid = repoIdentityOf(F);
    const projects = mkSession(null); // no overrides
    const c = decideCommit(P, F, Fid, projects, FIX);
    ok(!c.refusal, 'control: a commit in a non-opted-out fixture repo is allowed (store-governed)');
    const pu = decidePushInto(P, F, Fid, path.join(tmp, 'okScratch-remote.git'), projects, FIX);
    ok(!pu.refusal, 'control: a scratch→scratch push in a non-opted-out fixture repo is allowed');
  }
  void resolvedRemotesOf;
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(REAL, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\nFEAT-190 r13 (two doors + opt-out matrix): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
