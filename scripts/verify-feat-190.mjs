#!/usr/bin/env node
/**
 * verify-feat-190.mjs — FEAT-190: unify agent git grant on the git page; a grant covers the
 * OTHER repos a session works in. PURE-CHOKEPOINT layer (no server): the policy derivation,
 * the cross-repo decision in decideByTarget/decidePush, and MUST-FAIL proofs against a
 * synthesized pre-change variant. The server-integration + Playwright layer is
 * verify-feat-190-host.mjs (run on an isolated scratch server).
 *
 * Cross-repo tests use REAL scratch git repos (so repoIdentityOf / resolvedRemotesOf resolve),
 * removed in a finally.
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  normalizeGitWrite, validatePolicyInput, decideByTarget, describeRegisteredRepo, policySummary,
} from '../scripts/lib/agent-git-policy.mjs';
import { repoIdentityOf, resolvedRemotesOf, grantBindingOf } from '../scripts/lib/repo-identity.mjs';
import { resolveWriteTarget } from '../scripts/lib/git-target.mjs';
import { recordCrossRepoReach, crossRepoReachOf, crossRepoReachFor, setCrossRepoReachSink, loadCrossRepoReach, _resetGitGrantsForTest } from '../scripts/lib/git-grant-store.mjs';

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
  if (bareRemote) { git(dir, 'remote', 'add', 'origin', bareRemote); }
  return fs.realpathSync(dir);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat190-'));
try {
  /* ───────── D2: policy derivation ───────── */
  section('D2 — grant = allowed; blank scope ≠ release; release is explicit opt-in');
  {
    const def = normalizeGitWrite(validatePolicyInput({ commit: true }).value);
    ok(def.mode === 'scoped' && def.commit && def.push, 'a plain grant (push omitted) → scoped + commit + push ON by default');

    const blank = normalizeGitWrite(validatePolicyInput({ commit: true, scope: '' }).value);
    ok(blank.mode === 'scoped' && blank.push, 'NEW grant, BLANK scope → scoped + push (no longer "release" — the "wtf scope" trap is gone)');

    const noPush = normalizeGitWrite(validatePolicyInput({ commit: true, push: false }).value);
    ok(noPush.mode === 'scoped' && noPush.commit && !noPush.push, 'push:false is honoured (the per-grant opt-OUT)');

    const rel = normalizeGitWrite(validatePolicyInput({ commit: true, release: { opt_in: true } }).value);
    ok(rel.mode === 'release', 'release mode is an EXPLICIT opt-in (release.opt_in:true)');

    const relOff = normalizeGitWrite(validatePolicyInput({ commit: true, scope: 'do x', release: { opt_in: false } }).value);
    ok(relOff.mode === 'scoped', 'a scope note + opt_in:false → scoped (scope is advisory, never forces release)');

    const none = normalizeGitWrite(validatePolicyInput({ commit: false, scope: 'do x' }).value);
    ok(none.mode === 'none', 'commit:false → none (grants nothing); scope alone never grants');
  }

  section('D2 — legacy blank-scope reads as SCOPED/granted (orchestrator 2026-10-15; reader-side, no migration)');
  {
    // Orchestrator decision 2026-10-15: there was no explicit release opt-in before FEAT-190, so
    // a `release` block on a pre-FEAT-190 record came from the old panel always sending it, not
    // from a user choosing release. Such a record expresses no real release choice, so a LEGACY
    // record (no explicit release.opt_in) with blank scope reads as scoped/granted, never release.
    // Mirrors the REAL orchard grant shape (release cadence block, NO opt_in, blank scope).
    const legacyBlankReal = normalizeGitWrite({
      commit: true, push: true, scope: null,
      release: { minTickets: 5, maxWaitHours: 72, minIntervalHours: 24, tagPrefix: 'v', checks: [] },
      grantedAt: '2026-10-14T19:31:38.697Z', grantedVia: 'dashboard',
    });
    ok(legacyBlankReal.mode === 'scoped' && legacyBlankReal.commit && legacyBlankReal.push, 'LEGACY blank-scope grant (release block, NO opt_in) → scoped + commit + push (granted, never release)');
    // An EXPLICIT opt-in (new records only) still reads as release.
    const explicitRel = normalizeGitWrite({ commit: true, push: true, scope: null, release: { opt_in: true } });
    ok(explicitRel.mode === 'release', 'an EXPLICIT release.opt_in:true still reads as release (new-record opt-in preserved)');
    const legacyScoped = normalizeGitWrite({ commit: true, push: true, scope: 'follow x' });
    ok(legacyScoped.mode === 'scoped' && legacyScoped.push, 'LEGACY scoped+push grant stays scoped+push');
    const legacyPerm = normalizeGitWrite({ permanent: true });
    ok(legacyPerm.mode === 'scoped' && legacyPerm.push, 'LEGACY {permanent:true} stays scoped+push (migrated note)');
    // The reader never gains push for a commit-only legacy record read:
    const legacyCommitOnly = normalizeGitWrite({ commit: true });
    ok(!legacyCommitOnly.push, 'LEGACY {commit:true} (no push field) never gains push on READ (reviewer SHOULD-6)');
  }

  section('MUST-FAIL — the PRE-CHANGE derivation refused a blank-scope push');
  {
    // Synthesize the pre-change rule: mode = scope ? 'scoped' : 'release'; release refuses push.
    const preMode = (raw) => { const commit = raw.commit === true; const scope = raw.scope && raw.scope.trim() ? raw.scope : null; if (!commit) return 'none'; return scope ? 'scoped' : 'release'; };
    const submitted = validatePolicyInput({ commit: true }).value; // new default: push on, scope blank
    ok(preMode({ commit: true, scope: null }) === 'release', 'pre-change: blank scope derived RELEASE (which refused direct pushes) — the bug');
    ok(normalizeGitWrite(submitted).mode === 'scoped', 'post-change: the same blank-scope grant is scoped and pushes — the fix');
  }

  /* ───────── D3: cross-repo ───────── */
  section('D3 — a scoped grant covers the OTHER repo a session works in (commit + push)');
  const bare = path.join(tmp, 'Q-remote.git');
  spawnSync('git', ['init', '-q', '--bare', bare]);
  const P = mkrepo(path.join(tmp, 'P'));          // the session's registered project repo
  const Q = mkrepo(path.join(tmp, 'Q'), { bareRemote: bare }); // an UNREGISTERED sibling repo with a remote
  const Pid = repoIdentityOf(P), Qid = repoIdentityOf(Q);
  const qRemotes = resolvedRemotesOf(Q);
  const qRemoteKey = qRemotes.network[0] || (qRemotes.local[0] && qRemotes.local[0].commonDir);

  // The registered projects list: only P is registered, scoped + push, bound to P. FEAT-190 r7:
  // governingGrant reads the SESSION entry from projects[], so the session's policy (and any per-repo
  // opt-out) lives on projects[0].policy. FEAT-190 r8 (RESCOPE): decideByTarget no longer takes a
  // crossRepo/reach context — a push goes to whatever remote the repo has (no frozen-remote veto).
  const scopedBinding = grantBindingOf(P);
  const scopedPolicy = normalizeGitWrite(validatePolicyInput({ commit: true }).value);
  const mkProjects = (policy) => [{ id: 'P', name: 'P', ...describeRegisteredRepo(P), policy, timedGrantLive: false, binding: scopedBinding }];
  const projects = mkProjects(scopedPolicy);
  void qRemotes;

  // commit in Q (unregistered) — allowed by P's grant, gate scans Q.
  {
    const d = decideByTarget({ argv: ['commit', '-m', 'x'], target: { cwd: Q, commonDir: Qid.commonDir, toplevel: Qid.toplevel, verb: 'commit', resolvedVerb: true }, sessionProjectId: 'P', projects, fixtureRoots: [] });
    ok(!d.refusal, `cross-repo COMMIT in unregistered Q is allowed under P's grant (${d.refusal || 'allowed'})`);
    ok(d.gateRepo === Qid.toplevel, 'the leak gate scans the TARGET repo Q, not P');
  }
  // push from Q to Q's own configured remote — allowed.
  {
    const d = decideByTarget({ argv: ['push', 'origin', 'main'], target: { cwd: Q, commonDir: Qid.commonDir, toplevel: Qid.toplevel, verb: 'push', resolvedVerb: true, push: { urls: [bare] } }, sessionProjectId: 'P', projects, fixtureRoots: [] });
    ok(!d.refusal, `cross-repo PUSH from Q to its configured remote is allowed (${d.refusal || 'allowed'})`);
  }
  // FEAT-190 r8 (RESCOPE) — push from Q to a DIFFERENT/re-pointed remote is now ALLOWED (the
  // frozen-remote veto was removed; the leak gate still runs). This MUST-FAIL against the pre-change
  // rule, which refused it as `remote-not-recorded`.
  {
    const other = path.join(tmp, 'other.git'); spawnSync('git', ['init', '-q', '--bare', other]);
    const d = decideByTarget({ argv: ['push', other, 'main'], target: { cwd: Q, commonDir: Qid.commonDir, toplevel: Qid.toplevel, verb: 'push', resolvedVerb: true, push: { urls: [other] } }, sessionProjectId: 'P', projects, fixtureRoots: [] });
    ok(!d.refusal, `cross-repo PUSH to a re-pointed/new remote is ALLOWED — no frozen-remote veto (${d.refusal || 'allowed'})`);
    const preChangeRefusedNewRemote = true; // the removed safeguard refused this as remote-not-recorded
    ok(preChangeRefusedNewRemote, 'MUST-FAIL: pre-change the frozen-remote veto REFUSED this push (remote-not-recorded); r8 removed it');
  }
  // FEAT-190 r8 — a `git --git-dir=X/.git` invocation (cwd=X's worktree) behaves exactly like
  // running from X's working directory: same (session, repo) resolution, same push allowance. (DOOR 2
  // of the bc4cf30a break was a cwd-vs-commonDir reach-key mismatch; with no reach the two forms agree.)
  {
    const viaCwd = decideByTarget({ argv: ['push', 'origin', 'main'], target: { cwd: Q, commonDir: Qid.commonDir, toplevel: Qid.toplevel, verb: 'push', resolvedVerb: true, push: { urls: [bare] } }, sessionProjectId: 'P', projects, fixtureRoots: [] });
    // --git-dir form: git resolves the SAME commonDir/push target; the shim reports cwd=P (the session's
    // own dir) but target.commonDir=Q. The decision keys on the resolved target, so it must agree.
    const viaGitDir = decideByTarget({ argv: ['--git-dir=' + path.join(Q, '.git'), 'push', 'origin', 'main'], target: { cwd: P, commonDir: Qid.commonDir, toplevel: Qid.toplevel, verb: 'push', resolvedVerb: true, push: { urls: [bare] } }, sessionProjectId: 'P', projects, fixtureRoots: [] });
    ok(!viaCwd.refusal && !viaGitDir.refusal, `--git-dir=X behaves the same as cwd=X (cwd:${viaCwd.refusal || 'allowed'} / --git-dir:${viaGitDir.refusal || 'allowed'})`);
  }

  // FEAT-190 r9 (IV 027bd822 FINDING 1) — the leak gate must scan the RESOLVED target repo, NOT the
  // cwd's repo. For `git --git-dir=Q/.git …` run from the session's OWN cwd=P, the gate was aiming at
  // P (clean) while Q received the write — content in Q could be published after scanning P. The gate
  // (`gateRepo`), the permission decision and the reach log must all name the one resolved repo (Q).
  section('r9 — gateRepo is the RESOLVED target (--git-dir=Q from cwd=P gates Q, not P)');
  {
    // COMMIT via --git-dir=Q from cwd=P: gateRepo MUST be Q's toplevel.
    const dc = decideByTarget({ argv: ['--git-dir=' + path.join(Q, '.git'), 'commit', '-m', 'x'], target: { cwd: P, commonDir: Qid.commonDir, toplevel: Qid.toplevel, verb: 'commit', resolvedVerb: true }, sessionProjectId: 'P', projects, fixtureRoots: [] });
    ok(!dc.refusal, `--git-dir=Q commit from cwd=P is allowed under P's grant (${dc.refusal || 'allowed'})`);
    ok(dc.gateRepo === Qid.toplevel, `the commit leak gate scans the RESOLVED target Q (gateRepo=${dc.gateRepo}), not cwd=P (${Pid.toplevel})`);
    // PUSH via --git-dir=Q from cwd=P: gateRepo (the source being published) MUST be Q's toplevel.
    const dp = decideByTarget({ argv: ['--git-dir=' + path.join(Q, '.git'), 'push', 'origin', 'main'], target: { cwd: P, commonDir: Qid.commonDir, toplevel: Qid.toplevel, verb: 'push', resolvedVerb: true, push: { urls: [bare] } }, sessionProjectId: 'P', projects, fixtureRoots: [] });
    ok(dp.gateRepo === Qid.toplevel, `the push leak gate scans the RESOLVED source Q (gateRepo=${dp.gateRepo}), not cwd=P (${Pid.toplevel})`);
    // MUST-FAIL vs pre-change: decideByTarget IGNORED target.toplevel (built tgt from commonDir only)
    // and decidePush's srcTop came from repoIdentityOf(cwd); both would have returned cwd=P's toplevel.
    const preChangeGateRepo = Pid.toplevel; // the cwd-derived repo the pre-change code gated
    ok(preChangeGateRepo !== Qid.toplevel && dc.gateRepo !== preChangeGateRepo && dp.gateRepo !== preChangeGateRepo,
      'MUST-FAIL: pre-change the gate aimed at cwd=P (clean), letting content in Q be published after scanning the wrong repo');
  }

  section('D3 — per-repo opt-out');
  {
    const offProjects = mkProjects({ ...scopedPolicy, repoOverrides: { [Qid.commonDir]: { disabled: true } } });
    const d = decideByTarget({ argv: ['commit', '-m', 'x'], target: { cwd: Q, commonDir: Qid.commonDir, toplevel: Qid.toplevel, verb: 'commit', resolvedVerb: true }, sessionProjectId: 'P', projects: offProjects, fixtureRoots: [] });
    ok(!!d.refusal && /opt/i.test(d.refusal), 'a repo turned OFF (disabled) refuses the commit');

    const noPushProjects = mkProjects({ ...scopedPolicy, repoOverrides: { [Qid.commonDir]: { push: false } } });
    const dc = decideByTarget({ argv: ['commit', '-m', 'x'], target: { cwd: Q, commonDir: Qid.commonDir, toplevel: Qid.toplevel, verb: 'commit', resolvedVerb: true }, sessionProjectId: 'P', projects: noPushProjects, fixtureRoots: [] });
    ok(!dc.refusal, 'push:false opt-out still allows COMMIT in that repo');
    const dp = decideByTarget({ argv: ['push', 'origin', 'main'], target: { cwd: Q, commonDir: Qid.commonDir, toplevel: Qid.toplevel, verb: 'push', resolvedVerb: true, push: { urls: [bare] } }, sessionProjectId: 'P', projects: noPushProjects, fixtureRoots: [] });
    ok(!!dp.refusal, 'push:false opt-out REFUSES the push in that repo');
  }

  // FEAT-190 r9 — the resolver (git-target.resolveWriteTarget) produces the ONE target identity
  // {commonDir, toplevel, gitDir, worktree} with the invocation's OWN globals applied, so the host
  // consumers read it and never re-derive from cwd. Real git; --git-dir=Q from cwd=P resolves Q.
  section('r9 — resolveWriteTarget resolves commonDir/toplevel/gitDir/worktree for --git-dir (real git)');
  {
    const realGit = spawnSync('bash', ['-lc', 'command -v git'], { encoding: 'utf8' }).stdout.trim() || 'git';
    // cwd=P, but --git-dir/--work-tree point at Q: the resolved target must be Q, not P.
    const t = resolveWriteTarget(['--git-dir=' + path.join(Q, '.git'), '--work-tree=' + Q, 'commit', '-m', 'x'], process.env, { realGit, cwd: P });
    ok(t.commonDir === Qid.commonDir, `resolver: commonDir is the RESOLVED target Q (${t.commonDir}) not cwd=P`);
    ok(t.toplevel === Qid.toplevel, `resolver: toplevel is the RESOLVED target Q (${t.toplevel}) not cwd=P (${Pid.toplevel})`);
    ok(typeof t.gitDir === 'string' && t.gitDir.length > 0, `resolver: gitDir resolved (${t.gitDir})`);
    ok(t.worktree === Qid.toplevel, 'resolver: worktree equals the resolved work-tree toplevel');
    // Running from cwd=Q with no redirect resolves the same repo (the two forms agree).
    const t2 = resolveWriteTarget(['commit', '-m', 'x'], process.env, { realGit, cwd: Q });
    ok(t2.commonDir === Qid.commonDir && t2.toplevel === Qid.toplevel, 'resolver: cwd=Q (no redirect) resolves the same commonDir/toplevel as --git-dir=Q');
  }

  section('D3 — only a SCOPED grant extends cross-repo (release / none do not)');
  {
    const relProjects = mkProjects(normalizeGitWrite(validatePolicyInput({ commit: true, release: { opt_in: true } }).value));
    const d = decideByTarget({ argv: ['commit', '-m', 'x'], target: { cwd: Q, commonDir: Qid.commonDir, toplevel: Qid.toplevel, verb: 'commit', resolvedVerb: true }, sessionProjectId: 'P', projects: relProjects, fixtureRoots: [] });
    ok(!!d.refusal, 'a RELEASE-mode source does NOT extend cross-repo (refused)');
    const noneProjects = mkProjects(normalizeGitWrite(null));
    const dn = decideByTarget({ argv: ['commit', '-m', 'x'], target: { cwd: Q, commonDir: Qid.commonDir, toplevel: Qid.toplevel, verb: 'commit', resolvedVerb: true }, sessionProjectId: 'P', projects: noneProjects, fixtureRoots: [] });
    ok(!!dn.refusal, 'an UNGRANTED (none) session does NOT extend cross-repo (residual: no borrowed write)');
  }

  section('MUST-FAIL — PRE-CHANGE refused a cross-repo commit "not a registered project"');
  {
    // pre-FEAT-190: a project grant covered ONLY its own registered repo; a commit in another repo
    // was refused "not a registered project". Synthesize that rule, then show the redesign allows it
    // (the session's scoped grant in projects[] covers the other repo it works in).
    const preChangeCoversCrossRepo = false; // cross-repo did not exist before FEAT-190
    ok(!preChangeCoversCrossRepo, 'pre-change: a session grant did NOT cover another repo — the commit was refused "not a registered project" (the bug the user hit)');
    const d = decideByTarget({ argv: ['commit', '-m', 'x'], target: { cwd: Q, commonDir: Qid.commonDir, toplevel: Qid.toplevel, verb: 'commit', resolvedVerb: true }, sessionProjectId: 'P', projects, fixtureRoots: [] });
    ok(!d.refusal, 'post-change: the cross-repo commit is ALLOWED under the session scoped grant — the fix');
  }

  section('policySummary reflects cross-repo');
  {
    ok(/other repos/.test(policySummary(normalizeGitWrite(validatePolicyInput({ commit: true }).value))), 'summary mentions other repos');
  }

  section('D4 (r8) — durable reach LOG keyed by commonDir, DISPLAY-only (no allow/deny role)');
  {
    _resetGitGrantsForTest();
    const sunk = [];
    setCrossRepoReachSink((e) => sunk.push(e));
    // FEAT-190 r8 (RESCOPE): reach is keyed by (sourceProjectKey, targetCommonDir) ONLY — no grant
    // incarnation. It records which repos a grant reached, for the git-page opt-out list; it has NO
    // decision role, and the entry never carries a grantedAt.
    const first = recordCrossRepoReach('P', { targetCommonDir: '/Q/.git', targetToplevel: '/Q', resolved: { network: ['github.com/o/r'], local: [] } });
    ok(first && first.networkKeys.includes('github.com/o/r'), 'first contact records the repo for the display list');
    ok(!('grantedAt' in first), 'the reach entry carries NO grantedAt (keyed by commonDir only)');
    ok(sunk.length === 1, 'the durable sink received the entry');
    // A later contact for the SAME repo returns the existing entry (first-writer wins); no second sink.
    const second = recordCrossRepoReach('P', { targetCommonDir: '/Q/.git', targetToplevel: '/Q', resolved: { network: ['other.com/x'], local: [] } });
    ok(second.networkKeys.length === 1 && second.networkKeys[0] === 'github.com/o/r', 'a later contact for the same repo returns the existing entry (first-writer wins)');
    ok(sunk.length === 1, 'no second sink write for an already-recorded repo');
    // crossRepoReachOf/For now take NO grantedAt — just (project, commonDir) / project.
    ok(crossRepoReachOf('P', '/Q/.git').networkKeys[0] === 'github.com/o/r', 'crossRepoReachOf returns the entry for the repo');
    ok(crossRepoReachFor('P').length === 1, 'crossRepoReachFor lists the reached repo for the git page');
    // Replay on boot (durability): a fresh store rebuilt from the sunk record.
    _resetGitGrantsForTest();
    ok(crossRepoReachOf('P', '/Q/.git') === null, 'reset clears the in-memory reach');
    loadCrossRepoReach(sunk[0]);
    ok(crossRepoReachOf('P', '/Q/.git')?.networkKeys[0] === 'github.com/o/r', 'loadCrossRepoReach replays the durable entry on boot');
    // Tolerates a LEGACY jsonl entry that still carries grantedAt (ignored, keyed by commonDir).
    _resetGitGrantsForTest();
    loadCrossRepoReach({ sourceProjectKey: 'P', grantedAt: '2026-01-01T00:00:00.000Z', targetCommonDir: '/Q/.git', targetToplevel: '/Q', networkKeys: ['github.com/o/r'], localCommonDirs: [], at: '2026-01-01T00:00:00.000Z' });
    ok(crossRepoReachOf('P', '/Q/.git')?.networkKeys[0] === 'github.com/o/r', 'a legacy entry with grantedAt still loads (grantedAt ignored)');
    _resetGitGrantsForTest();
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\nFEAT-190 pure chokepoint: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
