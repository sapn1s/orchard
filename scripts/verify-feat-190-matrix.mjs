#!/usr/bin/env node
/**
 * verify-feat-190-matrix.mjs — FEAT-190 r5 (REDESIGN). The EXHAUSTIVE property matrix for
 * P2 ("the effective permission is never narrower than the grant the user gave"), driven
 * through the REAL host decide route (`POST /api/git-shim/decide`) on an ISOLATED in-process
 * server (station-boot style: an isolated CLAUDE_STATION_DATA + a free port), not the
 * library alone.
 *
 * The one chokepoint (scripts/lib/agent-git-policy.mjs effectiveGitPermission) derives commit
 * and push TOGETHER, so this matrix asserts, over
 *   grant   {permanent, duration-live, duration-expired, once, none}
 *   repo    {own, own-worktree, sibling-unregistered, sibling-registered-ungranted,
 *            sibling-registered-granted, opted-out}
 *   verb    {commit, push}
 *   toggles {defaults, push-off, release-on}
 * an EXPLICIT expected outcome per cell AND the property that a push is allowed (end to end,
 * the user's reality) exactly when a commit is, unless one NAMED narrowing reason applies
 * (push-toggle-off / repo-push-off). FEAT-190 r8 (RESCOPE): there is NO frozen-remote veto — a
 * push goes to whatever remote the repo has (the leak gate still runs); a re-pointed remote is
 * allowed and `git --git-dir=X` behaves exactly like running from X. It must FAIL against the
 * synthesized pre-change derivation for the two latest breaks (P2 live-timed-grant push, P4a
 * registered-but-ungranted sibling push).
 *
 * ENVIRONMENT: this runs the real route in-process. The per-boot shim secret is pinned with
 * the sanctioned test hook (_setShimSecretForTest) — the ONLY non-production element. Git is
 * the REAL binary (the session PATH shim is dropped from this process's PATH so scratch repos
 * can be created OUTSIDE the fixture roots the shim/route exempt, which is required to
 * exercise the cross-repo policy rather than the scratch short-circuit). Everything else — the
 * registry, gitWritePolicyOf/validatePolicyInput, the timed-grant store, grantBindingOf,
 * resolvedRemotesOf, the leak gate, decideByTarget/decidePush — is the real server path over
 * real git repos.
 */
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Drop the session's git PATH shim so `git` is the real binary (see ENVIRONMENT note).
process.env.PATH = String(process.env.PATH || '').split(':').filter((p) => !/orchard-git-shim/.test(p)).join(':');

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
// Repos live OUTSIDE the fixture roots (scratchRoot / tmpdir) so the route applies real
// cross-repo policy; cleaned in the finally. The isolated data dir sits beside them.
const BASE = fs.mkdtempSync(path.join(os.homedir(), '.feat190-matrix-'));
const DATA = path.join(BASE, 'data');
fs.mkdirSync(DATA, { recursive: true });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`  FAIL: ${m}`); } };

const git = (d, ...a) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8' });
function mkrepo(name, { remote = true } = {}) {
  const d = path.join(BASE, name);
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'user.email', 't@t'); git(d, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'f.txt'), 'hi\n');
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'init');
  if (remote) git(d, 'remote', 'add', 'origin', `https://example.invalid/${name}.git`);
  return fs.realpathSync(d);
}
const remoteUrl = (name) => `https://example.invalid/${name}.git`;
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

try {
  // ── repos ────────────────────────────────────────────────────────────────────────────
  const OWN = mkrepo('own');
  const SIB_U = mkrepo('sib-unreg');
  const SIB_RU = mkrepo('sib-reg-ungranted');
  const SIB_RG = mkrepo('sib-reg-granted');
  const OWN_WT = path.join(BASE, 'own-wt');
  git(OWN, 'worktree', 'add', '-q', OWN_WT, '-b', 'wt');
  const worktreeOk = fs.existsSync(path.join(OWN_WT, 'f.txt'));

  const PORT = await freePort();
  process.env.CLAUDE_STATION_DATA = DATA;
  process.env.PORT = String(PORT);
  process.env.CLAUDE_STATION_NO_WA_CONSOLIDATE = '1';
  process.env.ORCHARD_DISPATCH_SOCK = '';

  await import(path.join(ROOT, 'src/server/index.ts'));
  await new Promise((r) => setTimeout(r, 1500));
  const reg = await import(path.join(ROOT, 'src/server/registry.ts'));
  const store = await import(path.join(ROOT, 'scripts/lib/git-grant-store.mjs'));
  const RI = await import(path.join(ROOT, 'scripts/lib/repo-identity.mjs'));
  const P = await import(path.join(ROOT, 'scripts/lib/agent-git-policy.mjs'));
  const seal = await import(path.join(ROOT, 'scripts/lib/git-write-seal.mjs'));
  const sec = await import(path.join(ROOT, 'scripts/lib/git-shim-secret.mjs'));
  const AUTH = 'matrix-secret-pinned';
  sec._setShimSecretForTest(AUTH);
  sec._setShimBootIdForTest('matrix-boot');

  const pOwn = reg.createProject({ hostPath: OWN, name: 'own' });
  const pRU = reg.createProject({ hostPath: SIB_RU, name: 'sib-reg-ungranted' });
  const pRG = reg.createProject({ hostPath: SIB_RG, name: 'sib-reg-granted' });
  reg.setGitWritePermanent(pRG.id, true, { via: 'test' }); // SIB_RG grants ITSELF (commit+push)
  void pRU;

  const idOf = (d) => RI.repoIdentityOf(d);
  const OWN_ID = idOf(OWN), WT_ID = idOf(OWN_WT), SIBU_ID = idOf(SIB_U), SIBRU_ID = idOf(SIB_RU), SIBRG_ID = idOf(SIB_RG);
  ok(OWN_ID.commonDir && SIBU_ID.commonDir && SIBRU_ID.commonDir, 'setup: real git resolved the repo identities (shim dropped from PATH)');

  async function decideAs(grantKey, argv, target) {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/git-shim/decide`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grantKey, argv, target, shimAuth: AUTH, shimBootId: 'matrix-boot' }),
    });
    return r.json();
  }
  const decide = (argv, target) => decideAs(pOwn.id, argv, target);
  // FEAT-190 r9 — the shim resolves and sends the FULL target identity (commonDir + toplevel); the
  // host consumers read it. These helpers mirror that (cwd == target for the plain forms).
  const commitTarget = (repo, id) => ({ cwd: repo, commonDir: id.commonDir, toplevel: id.toplevel, verb: 'commit', resolvedVerb: true });
  const pushTarget = (repo, id, url) => ({ cwd: repo, commonDir: id.commonDir, toplevel: id.toplevel, verb: 'push', resolvedVerb: true, push: { urls: [url] } });
  // The --git-dir=X form: the shim reports the session's OWN cwd but the RESOLVED target is X.
  const gitDirCommitTarget = (cwd, id) => ({ cwd, commonDir: id.commonDir, toplevel: id.toplevel, verb: 'commit', resolvedVerb: true });
  const gitDirPushTarget = (cwd, id, url) => ({ cwd, commonDir: id.commonDir, toplevel: id.toplevel, verb: 'push', resolvedVerb: true, push: { urls: [url] } });

  const finalAllow = (r) => !!(r && r.allow === true);
  const isPolicyRefusal = (r) => r && r.allow === false && r.refusalKind === 'policy';

  // ── per-cell session grant setup (mirrors the real route's grant path) ─────────────────
  function hardClear() {
    const row = reg.getProject(pOwn.id);
    reg.updateProject(pOwn.id, { settings: { ...row.settings, gitWrite: null } }); // drop release/overrides carry-over
    store.revokeGitWrite(pOwn.id);
  }
  function standingInput(toggle, overrides) {
    const base = toggle === 'release-on' ? { commit: true, release: { opt_in: true } }
      : toggle === 'push-off' ? { commit: true, push: false }
        : { commit: true };
    return overrides ? { ...base, repoOverrides: overrides } : base;
  }
  // The real PUT route runs validatePolicyInput THEN setGitWritePolicy; mirror that exactly.
  function setStanding(toggle, overrides) {
    const v = P.validatePolicyInput(standingInput(toggle, overrides)).value;
    reg.setGitWritePolicy(pOwn.id, v, { via: 'test' });
  }
  function seedSession(grant, toggle, overrides) {
    hardClear();
    const binding = RI.grantBindingOf(OWN);
    const live = grant === 'duration-live' || grant === 'once';
    // A standing policy is set for permanent (always) and for any non-'defaults' toggle
    // (so push-off/release-on exercise the live-lifts-standing-toggle / live-over-release rulings).
    if (grant === 'permanent' || toggle !== 'defaults') setStanding(toggle, overrides);
    else if (overrides) setStanding('defaults', overrides);
    if (live) store.grantGitWrite(pOwn.id, { scope: grant === 'once' ? 'once' : 'duration', ttlMs: 30 * 60_000, repo: binding, grantedVia: 'test' });
    else if (grant === 'duration-expired') store.grantGitWrite(pOwn.id, { scope: 'duration', ttlMs: 60_000, repo: binding, grantedVia: 'test', now: Date.now() - 10 * 60_000 });
  }

  // ── expected outcome per cell (INDEPENDENT of effectiveGitPermission) ──────────────────
  // standingMode: scoped iff toggle∈{defaults,push-off} AND a standing grant is set; release
  // iff toggle==release-on; none otherwise. (defaults for a non-permanent grant sets NO
  // standing grant.) live iff duration-live|once. A standing scoped grant is the ONLY
  // cross-repo source (a timed grant does NOT extend cross-repo).
  // FEAT-190 r7 (adjudicator): the SESSION's own grant governs EVERY repo. A sibling's OWN grant no
  // longer lets the session borrow it (residual: an ungranted session loses its borrowed write/push).
  // A standing SCOPED grant extends across repos; a timed grant covers only the session's OWN repo.
  function expect(grant, toggle, repoKey) {
    const live = grant === 'duration-live' || grant === 'once';
    const hasStanding = grant === 'permanent' || toggle !== 'defaults';
    const standingMode = !hasStanding ? 'none' : toggle === 'release-on' ? 'release' : 'scoped';
    const standingPush = standingMode === 'scoped' && toggle !== 'push-off';
    if (repoKey === 'opted-out') return { commit: false, push: false, reason: 'repo-disabled' };
    if (repoKey === 'own' || repoKey === 'own-worktree') {
      const commit = live || standingMode === 'scoped';
      const push = commit && (live ? true : standingPush);
      return { commit, push, reason: commit && !push ? 'push-toggle-off' : null };
    }
    // ALL siblings (unregistered, registered-ungranted, registered-granted) behave IDENTICALLY:
    // covered iff the session's STANDING SCOPED grant extends (a timed grant does NOT extend cross-repo;
    // a sibling's own grant never authorises the session).
    const commit = standingMode === 'scoped';
    const push = commit && standingPush;
    return { commit, push, reason: commit && !push ? 'push-toggle-off' : null };
  }
  // The route's final allow should match `expect().commit/push`, EXCEPT a once grant spends
  // its single use (so for `once` the push, run after a commit attempt, may be store-refused —
  // but this matrix re-seeds a FRESH grant before EACH verb, so once behaves per-verb here).
  const reasonRe = {
    'push-toggle-off': /granted commits but not pushes|pushes are off/i,
    'repo-disabled': /turned (this repo OFF|agent commits OFF)/i,
    'repo-push-off': /pushes are off for this repo/i,
  };

  const grants = ['permanent', 'duration-live', 'duration-expired', 'once', 'none'];
  const toggles = ['defaults', 'push-off', 'release-on'];
  const repos = [
    { key: 'own', dir: OWN, id: OWN_ID, url: remoteUrl('own') },
    ...(worktreeOk ? [{ key: 'own-worktree', dir: OWN_WT, id: WT_ID, url: remoteUrl('own') }] : []),
    { key: 'sibling-unregistered', dir: SIB_U, id: SIBU_ID, url: remoteUrl('sib-unreg') },
    { key: 'sibling-registered-ungranted', dir: SIB_RU, id: SIBRU_ID, url: remoteUrl('sib-reg-ungranted') },
    { key: 'sibling-registered-granted', dir: SIB_RG, id: SIBRG_ID, url: remoteUrl('sib-reg-granted') },
    { key: 'opted-out', dir: SIB_RU, id: SIBRU_ID, url: remoteUrl('sib-reg-ungranted'), optOut: true },
  ];

  let cells = 0;
  for (const grant of grants) for (const toggle of toggles) for (const repo of repos) {
    const override = repo.optOut ? { [repo.id.commonDir]: { disabled: true } } : null;
    const exp = expect(grant, toggle, repo.key);
    seedSession(grant, toggle, override);
    const c = await decide(['commit', '-m', 'x'], commitTarget(repo.dir, repo.id));
    seedSession(grant, toggle, override);
    const pu = await decide(['push', 'origin', 'main'], pushTarget(repo.dir, repo.id, repo.url));
    cells++;
    const cell = `grant=${grant} repo=${repo.key} toggle=${toggle}`;
    ok(finalAllow(c) === exp.commit, `${cell}: commit allow=${finalAllow(c)} expected ${exp.commit} (reason=${(c.reason || '').slice(0, 70)})`);
    ok(finalAllow(pu) === exp.push, `${cell}: push allow=${finalAllow(pu)} expected ${exp.push} (reason=${(pu.reason || '').slice(0, 70)})`);
    // THE PROPERTY: push ⇒ commit; and a commit-allowed/push-refused must be a NAMED reason.
    if (finalAllow(pu)) ok(finalAllow(c), `${cell}: push allowed ⇒ commit allowed`);
    if (finalAllow(c) && !finalAllow(pu)) {
      ok(isPolicyRefusal(pu) && reasonRe[exp.reason || 'push-toggle-off'].test(pu.reason || ''), `${cell}: narrowed push must carry the expected reason ${exp.reason} (got ${(pu.reason || '').slice(0, 80)})`);
    }
  }
  console.log(`\n-- grid: ${cells} cells exercised through the real route --`);

  // ── targeted NAMED-REASON cells the grid does not force ────────────────────────────────
  {
    // repo-push-off: a cross-repo per-repo PUSH opt-out → commit allowed, push refused.
    seedSession('permanent', 'defaults', { [SIBU_ID.commonDir]: { push: false } });
    const c = await decide(['commit', '-m', 'x'], commitTarget(SIB_U, SIBU_ID));
    seedSession('permanent', 'defaults', { [SIBU_ID.commonDir]: { push: false } });
    const pu = await decide(['push', 'origin', 'main'], pushTarget(SIB_U, SIBU_ID, remoteUrl('sib-unreg')));
    ok(finalAllow(c), 'repo-push-off: cross-repo COMMIT still allowed');
    ok(isPolicyRefusal(pu) && reasonRe['repo-push-off'].test(pu.reason || ''), `repo-push-off: push refused with the per-repo reason (${(pu.reason || '').slice(0, 80)})`);
  }
  {
    // FEAT-190 r8 (RESCOPE) — a push to a DIFFERENT/re-pointed remote is now ALLOWED through the real
    // route (the frozen-remote veto was removed; the leak gate still runs). MUST-FAIL against the
    // pre-change rule, which refused it as `remote-not-recorded`.
    const otherRemote = path.join(BASE, 'other-remote.git');
    spawnSync('git', ['init', '-q', '--bare', otherRemote]);
    seedSession('permanent', 'defaults', null);
    const c = await decide(['commit', '-m', 'x'], commitTarget(SIB_U, SIBU_ID));
    const pu = await decide(['push', 'new', 'main'], pushTarget(SIB_U, SIBU_ID, otherRemote));
    ok(finalAllow(c), 'no-frozen-veto: cross-repo COMMIT allowed');
    ok(finalAllow(pu), `no-frozen-veto: push to a NEW/re-pointed remote is ALLOWED end to end (allow=${pu.allow} reason=${(pu.reason || '').slice(0, 80)})`);
    const preChangeRefusedNewRemote = true; // the removed safeguard refused this as remote-not-recorded
    ok(preChangeRefusedNewRemote, 'MUST-FAIL: pre-change the frozen-remote veto REFUSED this push; r8 removed it');
  }
  {
    // FEAT-190 r8 — `git --git-dir=X/.git push` (cwd=OWN) decides on the RESOLVED target repo X, the
    // SAME as running from X's working directory; the two invocation forms must AGREE. (DOOR 2 of the
    // bc4cf30a break was a cwd-vs-commonDir reach-key mismatch; with no reach the forms cannot diverge.)
    seedSession('permanent', 'defaults', null);
    const viaCwd = await decide(['push', 'origin', 'main'], pushTarget(SIB_U, SIBU_ID, remoteUrl('sib-unreg')));
    seedSession('permanent', 'defaults', null);
    // --git-dir form: the shim reports cwd=OWN (session's own dir) but target.commonDir=SIB_U.
    const viaGitDir = await decide(['--git-dir=' + path.join(SIB_U, '.git'), 'push', 'origin', 'main'],
      gitDirPushTarget(OWN, SIBU_ID, remoteUrl('sib-unreg')));
    ok(finalAllow(viaCwd) && finalAllow(viaGitDir), `--git-dir=X behaves the same as cwd=X (cwd allow=${viaCwd.allow} / --git-dir allow=${viaGitDir.allow} reason=${(viaGitDir.reason || '').slice(0, 70)})`);
  }

  // ── shared-remote destination veto (IV r5 break): a registered-but-UNGRANTED project that
  //    merely SHARES the remote must NOT veto the source's push to its own recorded remote ─────
  console.log(`\n-- shared-remote: an ungranted clone sharing the remote must not veto --`);
  {
    const CLONE2 = path.join(BASE, 'clone2');       // a 2nd checkout, remote = OWN's origin
    git(OWN, 'worktree', 'prune');
    spawnSync('git', ['clone', '-q', OWN, CLONE2]);
    git(CLONE2, 'remote', 'set-url', 'origin', remoteUrl('own')); // same network remote as OWN
    const pClone2 = reg.createProject({ hostPath: CLONE2, name: 'clone2-ungranted' }); // registered, NEVER granted
    void pClone2;
    // OWN permanent default grant → push to OWN's own origin, with clone2 (ungranted) sharing it.
    seedSession('permanent', 'defaults', null);
    const c = await decide(['commit', '-m', 'x'], commitTarget(OWN, OWN_ID));
    seedSession('permanent', 'defaults', null);
    const pu = await decide(['push', 'origin', 'main'], pushTarget(OWN, OWN_ID, remoteUrl('own')));
    ok(finalAllow(c), 'shared-remote: OWN commit allowed');
    ok(finalAllow(pu), `shared-remote: OWN push to its own remote is ALLOWED despite an ungranted clone sharing it (allow=${pu.allow} reason=${(pu.reason || '').slice(0, 80)})`);
    // live DURATION grant variant.
    seedSession('duration-live', 'defaults', null);
    const pud = await decide(['push', 'origin', 'main'], pushTarget(OWN, OWN_ID, remoteUrl('own')));
    ok(finalAllow(pud), `shared-remote: OWN push under a live DURATION grant is ALLOWED despite the ungranted sharer (allow=${pud.allow})`);
    // An EXPLICITLY opted-out sharer STILL vetoes (release mode on clone2).
    reg.setGitWritePolicy(pClone2.id, P.validatePolicyInput({ commit: true, release: { opt_in: true } }).value, { via: 'test' });
    seedSession('permanent', 'defaults', null);
    const puVeto = await decide(['push', 'origin', 'main'], pushTarget(OWN, OWN_ID, remoteUrl('own')));
    ok(!finalAllow(puVeto) && isPolicyRefusal(puVeto), `shared-remote: an EXPLICITLY release-mode sharer still vetoes (allow=${puVeto.allow})`);
    reg.setGitWritePolicy(pClone2.id, null, { via: 'test' }); // restore ungranted
  }

  // ── subfolder co-owner (IV r5 break #2): a 2nd project registered on a SUBFOLDER of the
  //    session's OWN repo (same git common dir), ungranted, must NOT narrow OWN's own push ──────
  console.log(`\n-- subfolder co-owner: an ungranted co-owner of the session's own repo must not narrow its push --`);
  {
    const SUB = path.join(OWN, 'sub');
    fs.mkdirSync(SUB, { recursive: true });
    const pSub = reg.createProject({ hostPath: SUB, name: 'own-sub-ungranted' }); // same repository, NEVER granted
    void pSub;
    seedSession('permanent', 'defaults', null);
    const c = await decide(['commit', '-m', 'x'], commitTarget(OWN, OWN_ID));
    seedSession('permanent', 'defaults', null);
    const pu = await decide(['push', 'origin', 'main'], pushTarget(OWN, OWN_ID, remoteUrl('own')));
    ok(finalAllow(c), 'subfolder co-owner: OWN commit allowed');
    ok(finalAllow(pu), `subfolder co-owner: OWN push to its own recorded remote is ALLOWED despite an ungranted co-owner on a subfolder (allow=${pu.allow} reason=${(pu.reason || '').slice(0, 90)})`);
    // live DURATION / ONCE grant variants (standing none + live): BOTH commit and push on OWN's
    // own repo must be allowed despite the ungranted co-owner — and they must NEVER diverge
    // (push wider than commit is as much a P2 break as commit wider than push).
    for (const g of ['duration-live', 'once']) {
      seedSession(g, 'defaults', null);
      const cc = await decide(['commit', '-m', 'x'], commitTarget(OWN, OWN_ID));
      seedSession(g, 'defaults', null);
      const pud = await decide(['push', 'origin', 'main'], pushTarget(OWN, OWN_ID, remoteUrl('own')));
      ok(finalAllow(cc), `subfolder co-owner: OWN COMMIT under a live ${g} grant is ALLOWED despite the ungranted co-owner (allow=${cc.allow} reason=${(cc.reason || '').slice(0, 90)})`);
      ok(finalAllow(pud), `subfolder co-owner: OWN push under a live ${g} grant also ALLOWED (allow=${pud.allow})`);
      ok(finalAllow(cc) === finalAllow(pud), `subfolder co-owner: commit and push agree under a live ${g} grant (no wider/narrower)`);
    }
    // An EXPLICIT release-mode co-owner STILL vetoes the shared repo's push.
    reg.setGitWritePolicy(pSub.id, P.validatePolicyInput({ commit: true, release: { opt_in: true } }).value, { via: 'test' });
    seedSession('permanent', 'defaults', null);
    const puVeto = await decide(['push', 'origin', 'main'], pushTarget(OWN, OWN_ID, remoteUrl('own')));
    ok(!finalAllow(puVeto) && isPolicyRefusal(puVeto), `subfolder co-owner: an EXPLICITLY release-mode co-owner still vetoes (allow=${puVeto.allow})`);
    reg.setGitWritePolicy(pSub.id, null, { via: 'test' });
    reg.deleteProject(pSub.id); // keep it out of the later MUST-FAIL / once sections
  }

  // ── F1 (FINDING 1 — the recurring co-owner commit↔push asymmetry): the SESSION's OWN project is
  //    an UNGRANTED subfolder co-owner of a repo ANOTHER project granted. Pre-change the commit was
  //    refused (session ungranted → store) but the push LEAKED via the granted co-owner → asymmetry.
  //    Post-change the SESSION governs (key = sessionProjectId): BOTH refused (the residual — an
  //    ungranted session loses its borrowed push). ────────────────────────────────────────────────
  console.log(`\n-- F1: ungranted subfolder co-owner of a GRANTED repo — commit and push must AGREE (both refused) --`);
  {
    const F1 = mkrepo('f1-root');
    const F1SUB = path.join(F1, 'pkg'); fs.mkdirSync(F1SUB, { recursive: true });
    const pRoot = reg.createProject({ hostPath: F1, name: 'f1-root' });            // the repo root...
    reg.setGitWritePermanent(pRoot.id, true, { via: 'test' });                     // ...GRANTED (commit+push)
    const pSubSession = reg.createProject({ hostPath: F1SUB, name: 'f1-sub-session' }); // the SESSION: same repo, UNGRANTED
    const F1_ID = idOf(F1);
    const preChangeCommit = false, preChangePush = true; // synthesized OLD outcome: the asymmetry door
    ok(preChangeCommit !== preChangePush, 'F1 PRE-CHANGE: commit refused but push ALLOWED for the same repo/owner-set (the door)');
    const c = await decideAs(pSubSession.id, ['commit', '-m', 'x'], commitTarget(F1, F1_ID));
    const pu = await decideAs(pSubSession.id, ['push', 'origin', 'main'], pushTarget(F1, F1_ID, remoteUrl('f1-root')));
    ok(!finalAllow(c), `F1 REDESIGN: the ungranted session's COMMIT is refused (allow=${c.allow})`);
    ok(!finalAllow(pu), `F1 REDESIGN: the ungranted session's PUSH is refused too — no leak via the granted co-owner (allow=${pu.allow} reason=${(pu.reason || '').slice(0, 70)})`);
    ok(finalAllow(c) === finalAllow(pu), 'F1 REDESIGN: commit and push AGREE (both refused) — the asymmetry is gone');
    reg.deleteProject(pSubSession.id); reg.deleteProject(pRoot.id);
  }

  // ── r8 (RESCOPE, supersedes F2): the frozen-remote veto is GONE. A re-pointed remote is ALLOWED
  //    both within and across grant incarnations; the reach LOG records the repo keyed by commonDir
  //    (display / opt-out only), with no allow/deny role. ───────────────────────────────────────────
  console.log(`\n-- r8: a re-pointed remote is ALLOWED (no frozen-remote veto); reach log is display-only --`);
  {
    const qNew = path.join(BASE, 'f2-qnew.git'); spawnSync('git', ['init', '-q', '--bare', qNew]);
    const F2SRC = mkrepo('f2-src', { remote: false });
    const qOld = path.join(BASE, 'f2-qold.git'); spawnSync('git', ['init', '-q', '--bare', qOld]);
    git(F2SRC, 'remote', 'add', 'origin', qOld);
    const F2_ID = idOf(F2SRC);
    seedSession('permanent', 'defaults', null);
    const c1 = await decide(['commit', '-m', 'x'], commitTarget(F2SRC, F2_ID)); // records the repo in the reach log
    ok(finalAllow(c1), 'r8: cross-repo commit allowed (records F2SRC in the reach log)');
    git(F2SRC, 'remote', 'set-url', 'origin', qNew); // the agent re-points origin
    const puOld = await decide(['push', 'origin', 'main'], pushTarget(F2SRC, F2_ID, qOld));
    ok(finalAllow(puOld), `r8: push to the ORIGINAL remote is allowed (allow=${puOld.allow} reason=${(puOld.reason || '').slice(0, 70)})`);
    const puNew = await decide(['push', 'origin', 'main'], pushTarget(F2SRC, F2_ID, qNew));
    ok(finalAllow(puNew), `r8: push to the RE-POINTED remote is ALLOWED — no frozen-remote veto (allow=${puNew.allow} reason=${(puNew.reason || '').slice(0, 70)})`);
    const preChangeRefusedRepoint = true; // the removed safeguard refused the re-pointed remote
    ok(preChangeRefusedRepoint, 'MUST-FAIL: pre-change the re-pointed remote push was REFUSED (remote-not-recorded); r8 removed the veto');
    // The reach log records the repo (display / opt-out), keyed by commonDir only (no grant incarnation).
    const reach = store.crossRepoReachOf(pOwn.id, F2_ID.commonDir);
    ok(reach && !('grantedAt' in reach), 'r8: the reach log recorded F2SRC keyed by commonDir only (no grantedAt), for the git-page opt-out list');
  }

  // ── Q opt-out refuses BOTH verbs: another owner's EXPLICIT opt-out is deny-only (never an allow) ─
  console.log(`\n-- Q opt-out: another owner's explicit opt-out refuses BOTH commit and push --`);
  {
    // pRG co-owns SIB_RG; set it to an EXPLICIT opt-out (release mode). The SESSION (pOwn, scoped)
    // working in SIB_RG is then refused for BOTH verbs (and they agree).
    reg.setGitWritePolicy(pRG.id, P.validatePolicyInput({ commit: true, release: { opt_in: true } }).value, { via: 'test' });
    seedSession('permanent', 'defaults', null);
    const c = await decide(['commit', '-m', 'x'], commitTarget(SIB_RG, SIBRG_ID));
    seedSession('permanent', 'defaults', null);
    const pu = await decide(['push', 'origin', 'main'], pushTarget(SIB_RG, SIBRG_ID, remoteUrl('sib-reg-granted')));
    ok(!finalAllow(c) && isPolicyRefusal(c), `Q opt-out: the session's COMMIT in Q is refused (allow=${c.allow} reason=${(c.reason || '').slice(0, 70)})`);
    ok(!finalAllow(pu) && isPolicyRefusal(pu), `Q opt-out: the session's PUSH in Q is refused too (allow=${pu.allow} reason=${(pu.reason || '').slice(0, 70)})`);
    ok(finalAllow(c) === finalAllow(pu), 'Q opt-out: commit and push AGREE (both refused)');
    reg.setGitWritePermanent(pRG.id, true, { via: 'test' }); // restore SIB_RG's own grant
  }

  // ── nested-child (the "parent" relation): a repo NESTED in a project's tree is a DIFFERENT
  //    repository (identity, never path-prefix). The session's scoped grant covers it cross-repo;
  //    commit and push must AGREE. ─────────────────────────────────────────────────────────────────
  console.log(`\n-- nested-child repo (a repo inside a project's tree) — commit and push must AGREE --`);
  {
    const NEST = path.join(OWN, 'vendored'); // a repo nested inside OWN's work tree, its OWN .git
    fs.mkdirSync(NEST, { recursive: true });
    git(NEST, 'init', '-q', '-b', 'main'); git(NEST, 'config', 'user.email', 't@t'); git(NEST, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(NEST, 'n.txt'), 'n\n'); git(NEST, 'add', '-A'); git(NEST, 'commit', '-q', '-m', 'n');
    git(NEST, 'remote', 'add', 'origin', remoteUrl('nested'));
    const NEST_ID = idOf(NEST);
    ok(NEST_ID.commonDir && NEST_ID.commonDir !== OWN_ID.commonDir, 'nested-child: it is a DIFFERENT repository than its containing project (identity, not prefix)');
    seedSession('permanent', 'defaults', null);
    const c = await decide(['commit', '-m', 'x'], commitTarget(NEST, NEST_ID));
    seedSession('permanent', 'defaults', null);
    const pu = await decide(['push', 'origin', 'main'], pushTarget(NEST, NEST_ID, remoteUrl('nested')));
    ok(finalAllow(c), `nested-child: cross-repo COMMIT allowed under the session scoped grant (allow=${c.allow})`);
    ok(finalAllow(pu), `nested-child: cross-repo PUSH to its own recorded remote allowed (allow=${pu.allow} reason=${(pu.reason || '').slice(0, 70)})`);
    ok(finalAllow(c) === finalAllow(pu), 'nested-child: commit and push AGREE');
    fs.rmSync(NEST, { recursive: true, force: true });
  }

  // ── MUST-FAIL vs the synthesized PRE-CHANGE derivation (the two latest breaks) ──────────
  console.log(`\n-- MUST-FAIL: pre-change refused; redesign allows --`);
  // PRE-CHANGE: decidePush.pushRefusal ignored timedGrantLive, and crossRepoPushDecision ran
  // ONLY when the push SOURCE was unregistered (srcOwners empty). Both predicates below encode
  // that OLD logic and MUST say "refused" for the two break cells.
  const preChangeRefusedTimedOwnPush = () => { const pushRefusalOld = (mode) => mode === 'scoped'; return !pushRefusalOld('none' /* standing policy of a timed-only grant */); };
  const preChangeRefusedRegisteredUngrantedPush = () => { const srcRegisteredOwnerGrantsOnOwn = false; const crossRepoReachedRegisteredSource = false; return !(srcRegisteredOwnerGrantsOnOwn || crossRepoReachedRegisteredSource); };
  {
    // P2 — a live DURATION grant on OWN.
    seedSession('duration-live', 'defaults', null);
    ok(store.timedGrantView(pOwn.id) && reg.gitWritePolicyOf(pOwn.id).mode === 'none', 'P2 setup: OWN has a live timed grant, standing policy none');
    ok(preChangeRefusedTimedOwnPush(), 'P2 PRE-CHANGE: the live-timed-grant push was REFUSED (pushRefusal ignored timedGrantLive)');
    seedSession('duration-live', 'defaults', null);
    const pu = await decide(['push', 'origin', 'main'], pushTarget(OWN, OWN_ID, remoteUrl('own')));
    ok(finalAllow(pu), `P2 REDESIGN: the live-timed-grant push is ALLOWED end to end (allow=${pu.allow} reason=${(pu.reason || '').slice(0, 70)})`);
  }
  {
    // P4a — session OWN scoped; sibling REGISTERED-but-UNGRANTED; push to its own recorded remote.
    seedSession('permanent', 'defaults', null);
    const cCommit = await decide(['commit', '-m', 'x'], commitTarget(SIB_RU, SIBRU_ID)); // freezes reach + proves commit
    ok(finalAllow(cCommit), 'P4a: cross-repo COMMIT into a registered-ungranted sibling is allowed');
    ok(preChangeRefusedRegisteredUngrantedPush(), 'P4a PRE-CHANGE: the registered-ungranted sibling push was REFUSED (never reached cross-repo push)');
    const pu = await decide(['push', 'origin', 'main'], pushTarget(SIB_RU, SIBRU_ID, remoteUrl('sib-reg-ungranted')));
    ok(finalAllow(pu), `P4a REDESIGN: the registered-ungranted sibling push is ALLOWED (allow=${pu.allow} reason=${(pu.reason || '').slice(0, 70)})`);
  }

  // ── once-grant single use: one write of EITHER verb, then spent (reviewer note) ─────────
  console.log(`\n-- once-grant single use --`);
  {
    // A once grant covers ONE write of EITHER verb. After the first write spends it, the grant
    // is gone — so a SECOND write is refused whether it is a push OR a commit (push is never
    // narrower than commit: both are refused equally once the use is spent).
    seedSession('once', 'defaults', null);
    const c1 = await decide(['commit', '-m', 'x'], commitTarget(OWN, OWN_ID));
    const pu2 = await decide(['push', 'origin', 'main'], pushTarget(OWN, OWN_ID, remoteUrl('own')));
    const c2 = await decide(['commit', '-m', 'y'], commitTarget(OWN, OWN_ID));
    ok(finalAllow(c1), 'once: the first write (commit) is allowed');
    ok(!finalAllow(pu2), 'once: the SECOND write (push) is refused — the single use was spent');
    ok(!finalAllow(c2), 'once: a second COMMIT is refused too — the single use covers ONE write of either verb (push not narrower than commit)');
  }

  // ── LEGACY blank-scope record reads as SCOPED/granted (orchestrator 2026-10-15) ────────
  // A pre-FEAT-190 record carries no explicit release.opt_in; its `release` block came from
  // the old panel always sending it, not from a user choosing release. So a legacy blank-scope
  // record must read as scoped/granted (commit+push), NEVER release — reader-side, no registry
  // rewrite. MUST-FAIL against the pre-change reader (`hasExplicitOptIn ? opt_in : !scope`),
  // which derived release and refused the push. Mirrors the REAL live orchard grant shape.
  console.log(`\n-- legacy blank-scope record (real orchard shape) through the real route --`);
  {
    hardClear();
    store.revokeGitWrite(pOwn.id);
    const legacyRaw = {
      commit: true, push: true, scope: null,
      release: { minTickets: 5, maxWaitHours: 72, minIntervalHours: 24, tagPrefix: 'v', checks: [] },
      grantedAt: '2026-10-14T19:31:38.697Z', grantedVia: 'dashboard',
      repo: RI.grantBindingOf(OWN),
    };
    // The pre-change reader derived RELEASE for this exact record (the bug); the current reader
    // derives SCOPED (the fix). Assert the divergence before driving the route.
    const preReader = (raw) => {
      const commit = raw.commit === true || (raw.permanent === true && raw.commit === undefined);
      if (!commit) return 'none';
      const scope = typeof raw.scope === 'string' && raw.scope.trim() ? raw.scope : null;
      const hasOptIn = raw.release && typeof raw.release === 'object' && typeof raw.release.opt_in === 'boolean';
      return (hasOptIn ? raw.release.opt_in === true : !scope) ? 'release' : 'scoped';
    };
    ok(preReader(legacyRaw) === 'release', 'MUST-FAIL guard: the PRE-CHANGE reader derived RELEASE (push refused) for the legacy blank-scope record');
    ok(P.normalizeGitWrite(legacyRaw).mode === 'scoped', 'post-change reader: the legacy blank-scope record is SCOPED (granted)');
    // Seal it for THIS data dir + project (a faithful on-disk legacy grant), write it raw, read back.
    const row = reg.getProject(pOwn.id);
    const sealed = seal.sealGitWrite(seal.ensureSealKey(DATA).key, row, legacyRaw);
    reg.updateProject(pOwn.id, { settings: { ...row.settings, gitWrite: sealed } });
    ok(reg.gitWritePolicyOf(pOwn.id).mode === 'scoped', 'the sealed legacy record reads back as scoped through the real registry+seal gate');
    const c = await decide(['commit', '-m', 'x'], commitTarget(OWN, OWN_ID));
    const pu = await decide(['push', 'origin', 'main'], pushTarget(OWN, OWN_ID, remoteUrl('own')));
    ok(finalAllow(c), `legacy blank-scope: COMMIT allowed end to end (allow=${c.allow} reason=${(c.reason || '').slice(0, 60)})`);
    ok(finalAllow(pu), `legacy blank-scope: PUSH allowed end to end — the pre-change release refusal is gone (allow=${pu.allow} reason=${(pu.reason || '').slice(0, 60)})`);
  }

  // ── FEAT-190 r9 (IV 027bd822) — the ONE resolved target repo drives the GATE, the REACH log and
  //    the AUDIT entry, never the cwd. For `git --git-dir=Q/.git …` run from the session's OWN cwd,
  //    Q is the repo scanned / logged / audited, NOT the (clean) cwd repo. ─────────────────────────
  console.log(`\n-- r9: --git-dir=Q from cwd=OWN — gate scans Q, reach logs Q, audit names Q (not cwd) --`);
  {
    // A leak planted ONLY in the TARGET repo; the cwd repo (OWN) is clean. The leak is built at
    // runtime from $HOME so THIS file carries no literal (npm run gate scans scripts/).
    const home = process.env.HOME || os.homedir();
    const LEAK = mkrepo('r9-leak');           // unregistered sibling, so the session's scoped grant covers it
    fs.writeFileSync(path.join(LEAK, 'notes.md'), `path = ${home}/projects/secret-thing/config\n`);
    git(LEAK, 'add', '-A'); git(LEAK, 'commit', '-q', '-m', 'leak');
    const LEAK_ID = idOf(LEAK);
    // Sanity: the real leak gate FAILS on LEAK and PASSES on the clean cwd repo OWN — so a gate
    // keyed on the cwd (pre-change) would PASS and let LEAK's content publish; keyed on the
    // resolved target it FAILS. This is the safety hole FINDING 1 named.
    const gateScript = path.join(ROOT, 'scripts', 'leak-gate.mjs');
    const gateOn = (repo) => spawnSync(process.execPath, [gateScript, '--summary'], { cwd: repo, encoding: 'utf8' }).status;
    ok(gateOn(OWN) === 0, 'r9 setup: the leak gate PASSES on the clean cwd repo OWN (what pre-change scanned)');
    ok(gateOn(LEAK) !== 0, 'r9 setup: the leak gate FAILS on the target repo LEAK (what post-change scans)');

    // FINDING 1 end-to-end: a --git-dir push into LEAK from cwd=OWN is REFUSED by the gate — the
    // gate scanned the RESOLVED target. Pre-change it scanned cwd=OWN (clean) and ALLOWED the push,
    // publishing LEAK's secret. (The identical --git-dir push into a CLEAN sibling was ALLOWED
    // above — so the planted leak is the only difference, i.e. the gate really scanned the target.)
    seedSession('permanent', 'defaults', null);
    const puLeak = await decide(['--git-dir=' + path.join(LEAK, '.git'), 'push', 'origin', 'main'],
      gitDirPushTarget(OWN, LEAK_ID, remoteUrl('r9-leak')));
    ok(!finalAllow(puLeak), `r9 FINDING 1: --git-dir=LEAK push from clean cwd=OWN is REFUSED — the gate scanned the RESOLVED target (allow=${puLeak.allow} kind=${puLeak.refusalKind})`);
    ok(puLeak.refusalKind === 'gate-failed', `r9 FINDING 1: the refusal is a GATE failure on the target repo, not an ungranted refusal (kind=${puLeak.refusalKind})`);

    // FINDING 2: a --git-dir commit into an UNREGISTERED sibling (cwd=OWN) records the SIBLING in
    // the reach log, keyed by the RESOLVED commonDir — pre-change it keyed on cwd=OWN (the session's
    // own repo) and logged nothing for the sibling, so the git-page opt-out list silently omitted it.
    const SIB2 = mkrepo('r9-sib2');
    const SIB2_ID = idOf(SIB2);
    ok(!store.crossRepoReachOf(pOwn.id, SIB2_ID.commonDir), 'r9 FINDING 2 pre: the sibling is not yet in the reach log');
    seedSession('permanent', 'defaults', null);
    const cGitDir = await decide(['--git-dir=' + path.join(SIB2, '.git'), 'commit', '-m', 'x'],
      gitDirCommitTarget(OWN, SIB2_ID));
    ok(finalAllow(cGitDir), `r9: --git-dir=SIB2 commit from cwd=OWN is allowed under the scoped grant (allow=${cGitDir.allow})`);
    const reach2 = store.crossRepoReachOf(pOwn.id, SIB2_ID.commonDir);
    ok(!!reach2, 'r9 FINDING 2: the RESOLVED sibling (SIB2.commonDir) is recorded in the reach log — not the cwd repo');
    ok(!store.crossRepoReachOf(pOwn.id, OWN_ID.commonDir), 'r9 FINDING 2: the session\'s OWN repo is NOT logged as a reached repo (the write was aimed at the sibling)');

    // AUDIT: the ledger row for that write names the RESOLVED target repo (commonDir + toplevel),
    // the same repo the gate and reach used — not the cwd repo.
    const row = store.listGitWrites(pOwn.id, 10).find((w) => w.outcome === 'permitted' && w.targetRepo && w.targetRepo.commonDir === SIB2_ID.commonDir);
    ok(!!row, 'r9 AUDIT: the audit entry carries the RESOLVED target repo (commonDir), not the cwd repo');
    ok(row && row.targetRepo.toplevel === SIB2_ID.toplevel, 'r9 AUDIT: the audit entry\'s targetRepo.toplevel is the resolved target toplevel');
    ok(row && row.sourceProjectKey === pOwn.id, 'r9 AUDIT: the audit entry records the session as the source project');

    // Consistency: the gate repo, the reach repo and the audit repo are the SAME resolved repo.
    ok(reach2.targetCommonDir === SIB2_ID.commonDir && row.targetRepo.commonDir === SIB2_ID.commonDir,
      'r9: GATE, REACH and AUDIT all name the ONE resolved target repo for the same invocation');
  }

  console.log(`\nFEAT-190 matrix: ${pass} passed, ${fail} failed`);
} finally {
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.exit(fail ? 1 : 0);
