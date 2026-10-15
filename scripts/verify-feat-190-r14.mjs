#!/usr/bin/env node
/**
 * verify-feat-190-r14.mjs — PARTIAL per-repo opt-outs ({commit:false}, {push:false}) bind BEFORE
 * any scratch/fixture allowance, for the source repo, in every reachability role.
 *
 * The r13 clean-room (IV 5afbfde3, case `fixture-repo-partial-opt-out`) found that the r13 chokepoint
 * only let the FULL opt-out ({disabled:true}) bind under a scratch root. Two partial-opt-out seams
 * survived because the scratch allowance was reached BEFORE the explicit opt-out:
 *   SEAM 1 — effectiveGitPermission guarded the commit opt-out with `!scratch &&`, so a {commit:false}
 *            opt-out on a scratch SOURCE was SKIPPED: commit was allowed as 'scratch' while a push
 *            from it to a real remote refused 'repo-commit-off' — the two verbs disagreed (P4 break).
 *   SEAM 2 — the step-4 scratch→scratch early return fired BEFORE the step-5 source {push:false}
 *            check, so a {push:false} opt-out did not stop a scratch→scratch push (P4 break).
 *
 * The r14 fix: in effectiveGitPermission, (1) drop the `!scratch &&` guard on the commit opt-out so an
 * explicit {commit:false} binds for a scratch repo too, and (2) move the source {push:false} narrowing
 * AHEAD of the scratch→scratch return. Rule (P4): an explicit opt-out ({disabled} | {commit:false} |
 * {push:false}) is applied BEFORE any scratch allowance, for source and destination alike.
 *
 * Matrix: optout {disabled, commit:false, push:false} × role {scratch, own, sibling, destination-only}
 * × verb {commit, push}. The SCRATCH partial cells are MUST-FAIL against a surgically reverted
 * PRE-CHANGE (r13) copy that restores the `!scratch &&` guard and the old scratch→scratch ordering —
 * a genuine must-fail. The own/sibling/destination partial cells and all {disabled} cells were already
 * correct at r13 (scratch=false there, or {disabled} binds at step 1); they are asserted as
 * regression/consistency guards and so carry no must-fail (noted inline). Real scratch git repos.
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
const mkbare = (p) => { spawnSync('git', ['init', '-q', '--bare', p]); return p; };

/** A surgically PRE-CHANGE (r13) copy of agent-git-policy.mjs re-opening BOTH r14 seams: restore the
 * `!scratch &&` guard on the commit opt-out, and restore the old scratch→scratch-before-push-opt-out
 * ordering. Relative imports rewritten to absolute so it loads from the scratch dir. */
function writePreChangeCopy(dir) {
  let s = fs.readFileSync(path.join(LIB, 'agent-git-policy.mjs'), 'utf8');
  // SEAM 1 — restore the `!scratch &&` guard on the commit opt-out.
  const c_after = "  if (ov && ov.commit === false) return deny('repo-commit-off');";
  const c_before = "  if (!scratch && ov && ov.commit === false) return deny('repo-commit-off'); // PRE-CHANGE r14 seam 1";
  if (!s.includes(c_after)) throw new Error('seam-1 anchor not found (fix not present?)');
  s = s.replace(c_after, c_before);
  // SEAM 2 — restore the scratch→scratch return BEFORE the source {push:false} narrowing.
  const p_after = "  if (ov && ov.push === false) return { commit: true, push: false, reason: 'repo-push-off' };\n" +
    "  // ── (5) scratch→scratch push (caller sets scratch only when source AND destination are both\n" +
    "  //    scratch/fixture): store-governed → allow. ──\n" +
    "  if (scratch) return { commit: true, push: true, reason: 'scratch' };\n" +
    "  // ── (6) SOURCE-side standing push toggle (the per-grant opt-OUT; a live grant lifts it). ──\n" +
    "  let push = true; let reason = null;\n" +
    "  if (!live && pol.push === false) { push = false; reason = 'push-toggle-off'; } // standing toggle; a live grant lifts it\n" +
    "  return { commit: true, push, reason };";
  const p_before = "  if (scratch) return { commit: true, push: true, reason: 'scratch' }; // PRE-CHANGE r14 seam 2: scratch returns BEFORE the source push opt-out\n" +
    "  let push = true; let reason = null;\n" +
    "  if (ov && ov.push === false) { push = false; reason = 'repo-push-off'; }\n" +
    "  else if (!live && pol.push === false) { push = false; reason = 'push-toggle-off'; }\n" +
    "  return { commit: true, push, reason };";
  if (!s.includes(p_after)) throw new Error('seam-2 anchor not found (fix not present?)');
  s = s.replace(p_after, p_before);
  if (!s.includes('PRE-CHANGE r14 seam 1') || !s.includes('PRE-CHANGE r14 seam 2')) throw new Error('pre-change revert did not land');
  s = s.replace(/from '\.\//g, `from '${LIB}/`);
  const dst = path.join(dir, 'pre-r14.mjs');
  fs.writeFileSync(dst, s);
  return dst;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat190r14-'));           // a FIXTURE root (os.tmpdir)
const REAL = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.feat190r14-'))); // OUTSIDE any fixture root

try {
  const P = await import(path.join(LIB, 'agent-git-policy.mjs'));
  const { repoIdentityOf, grantBindingOf } = await import(path.join(LIB, 'repo-identity.mjs'));
  const PRE = await import(writePreChangeCopy(tmp));

  const { normalizeGitWrite, validatePolicyInput, describeRegisteredRepo } = P;
  const scopedPolicy = normalizeGitWrite(validatePolicyInput({ commit: true }).value); // commit+push ON
  const FIX = P.defaultFixtureRoots(); // includes os.tmpdir()

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
  const refused = (d) => !!(d && d.refusal);

  const OPTOUTS = [
    { name: 'disabled', ov: { disabled: true }, commitRefused: true, pushRefused: true, mustFailScratch: false },
    { name: 'commit:false', ov: { commit: false }, commitRefused: true, pushRefused: true, mustFailScratch: true },
    { name: 'push:false', ov: { push: false }, commitRefused: false, pushRefused: true, mustFailScratch: true },
  ];

  /* ───────── role: SCRATCH (source repo under a fixture root; push to a scratch bare remote) ───────── */
  section('SCRATCH role — the partial cells are the IV seams: MUST-FAIL vs the pre-change (r13) copy');
  for (const o of OPTOUTS) {
    const tag = o.name.replace(/[^a-z]/gi, '');
    const S = mkrepo(path.join(tmp, `scr-${tag}`), { bareRemote: mkbare(path.join(tmp, `scr-${tag}-remote.git`)) });
    const Sid = repoIdentityOf(S);
    const projects = mkSession({ [Sid.commonDir]: o.ov });
    const c = decideCommit(P, S, Sid, projects, FIX);
    const pu = decidePushInto(P, S, Sid, path.join(tmp, `scr-${tag}-remote.git`), projects, FIX);
    ok(refused(c) === o.commitRefused, `scratch ${o.name}: commit ${o.commitRefused ? 'REFUSED' : 'allowed'} (got ${refused(c) ? 'refused' : 'allowed'}${c.refusal ? ': ' + c.refusal.slice(0, 50) : ''})`);
    ok(refused(pu) === o.pushRefused, `scratch ${o.name}: scratch->scratch push ${o.pushRefused ? 'REFUSED' : 'allowed'} (got ${refused(pu) ? 'refused' : 'allowed'}${pu.refusal ? ': ' + pu.refusal.slice(0, 50) : ''})`);
    if (o.mustFailScratch) {
      // the pre-change (r13) copy lets the scratch allowance override the partial opt-out.
      const preC = decideCommit(PRE, S, Sid, projects, FIX);
      const prePu = decidePushInto(PRE, S, Sid, path.join(tmp, `scr-${tag}-remote.git`), projects, FIX);
      if (o.name === 'commit:false') {
        ok(!refused(preC), `MUST-FAIL (pre-change r13): scratch commit:false COMMIT was ALLOWED (${preC.refusal ? preC.refusal.slice(0, 40) : 'allowed'})`);
        ok(!refused(prePu), `MUST-FAIL (pre-change r13): scratch commit:false scratch->scratch PUSH was ALLOWED (${prePu.refusal ? prePu.refusal.slice(0, 40) : 'allowed'})`);
      } else { // push:false — commit allowed in both; the push is the door
        ok(!refused(prePu), `MUST-FAIL (pre-change r13): scratch push:false scratch->scratch PUSH was ALLOWED (${prePu.refusal ? prePu.refusal.slice(0, 40) : 'allowed'})`);
      }
    }
  }

  /* ───────── role: OWN (the session's own registered project repo) ───────── */
  section('OWN role — partial opt-out on the session own repo (regression; r13 already correct, no must-fail)');
  for (const o of OPTOUTS) {
    const projects = mkSession({ [Pid.commonDir]: o.ov });
    const c = decideCommit(P, PROJ, Pid, projects);
    const pu = decidePushInto(P, PROJ, Pid, 'https://example.invalid/P.git', projects);
    ok(refused(c) === o.commitRefused, `own ${o.name}: commit ${o.commitRefused ? 'REFUSED' : 'allowed'} (got ${refused(c) ? 'refused' : 'allowed'})`);
    ok(refused(pu) === o.pushRefused, `own ${o.name}: push ${o.pushRefused ? 'REFUSED' : 'allowed'} (got ${refused(pu) ? 'refused' : 'allowed'})`);
  }

  /* ───────── role: SIBLING (an unregistered real sibling repo the session also writes) ───────── */
  section('SIBLING role — partial opt-out on an unregistered real sibling (regression; no must-fail)');
  for (const o of OPTOUTS) {
    const tag = o.name.replace(/[^a-z]/gi, '');
    const S = mkrepo(path.join(REAL, `Sib-${tag}`), { bareRemote: mkbare(path.join(REAL, `Sib-${tag}-remote.git`)) });
    const Sid = repoIdentityOf(S);
    const projects = mkSession({ [Sid.commonDir]: o.ov });
    const c = decideCommit(P, S, Sid, projects);
    const pu = decidePushInto(P, S, Sid, path.join(REAL, `Sib-${tag}-remote.git`), projects);
    ok(refused(c) === o.commitRefused, `sibling ${o.name}: commit ${o.commitRefused ? 'REFUSED' : 'allowed'} (got ${refused(c) ? 'refused' : 'allowed'})`);
    ok(refused(pu) === o.pushRefused, `sibling ${o.name}: push ${o.pushRefused ? 'REFUSED' : 'allowed'} (got ${refused(pu) ? 'refused' : 'allowed'})`);
  }

  /* ───────── role: DESTINATION-ONLY (a repo reached ONLY as a push destination) ───────── */
  section('DESTINATION-ONLY role — partial opt-out on the push destination (dest override; r13 correct, no must-fail)');
  for (const o of OPTOUTS) {
    const tag = o.name.replace(/[^a-z]/gi, '');
    const D = mkrepo(path.join(REAL, `Dest-${tag}`));
    const Did = repoIdentityOf(D);
    const projects = mkSession({ [Did.commonDir]: o.ov });
    // push INTO D from the session's own repo P — the genuine destination role. A per-repo opt-out on
    // the destination (disabled | commit:false | push:false) refuses the push in every form.
    const pu = decidePushInto(P, PROJ, Pid, D, projects);
    ok(refused(pu) && /destination/i.test(pu.refusal), `destination-only ${o.name}: push INTO the opted-out destination is REFUSED (${pu.refusal ? pu.refusal.slice(0, 50) : 'allowed'})`);
  }

  /* ───────── control: a NON-opted-out scratch write is still allowed (no opt-out fabricated) ───────── */
  section('control — a non-opted-out scratch write is still allowed (store-governed; opt-out not fabricated)');
  {
    const S = mkrepo(path.join(tmp, 'ok'), { bareRemote: mkbare(path.join(tmp, 'ok-remote.git')) });
    const Sid = repoIdentityOf(S);
    const projects = mkSession(null);
    const c = decideCommit(P, S, Sid, projects, FIX);
    const pu = decidePushInto(P, S, Sid, path.join(tmp, 'ok-remote.git'), projects, FIX);
    ok(!refused(c), 'control: commit in a non-opted-out scratch repo is allowed');
    ok(!refused(pu), 'control: scratch->scratch push in a non-opted-out scratch repo is allowed');
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(REAL, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\nFEAT-190 r14 (partial opt-out × role × verb matrix): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
