#!/usr/bin/env node
/**
 * FEAT-164 — ONE grant authority by REPO IDENTITY (coordinator ruling after verify 1659cb7f).
 *
 * The breaks: decision points matched a grant to a target by PATH PREFIX, so a repo nested
 * inside granted project A (one level below A's container bind root; or a path the release
 * CLI was pointed at) was treated as A. Now every grant decision asks
 * scripts/lib/repo-identity.mjs grantCoversTarget(bound, target), which resolves the TARGET's
 * repository identity (git common dir; realpath for a non-repo) and compares it with the
 * identity the grant was given for. No prefix match decides a grant anywhere.
 *
 * Parts: [I] the authority itself; [S] the shim-decide guard; [R] the release CLI (break 2,
 * through the real CLI); [C] the container mount plan (break 1, the submodule, the granted
 * repo, the capped discovery failing closed); [G] no path-prefix match left in a grant decision.
 *
 *   node scripts/confined-run.mjs --no-git -- node scripts/verify-feat-164-identity.mjs
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mkdtempScratch } from './lib/scratch.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  PASS ${name}`); return; }
  fail++;
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 500)}`}`);
}
let retired = 0;
// FEAT-190 (r7/r8, orchestrator decision 2026-10-14) REVERSED the FEAT-164 push/write adjudication
// this suite was written for. A case whose SCENARIO no longer exists under FEAT-190 is RETIRED here
// (counts as neither pass nor fail) with a one-line note naming the superseding decision and the
// FEAT-190 test that now covers the surviving invariant. See the section headers for the per-model map.
function retire(name, note) { retired++; console.log(`  RETIRED ${name} — ${note}`); }
const RUN = mkdtempScratch('f164id-');
const DATA = path.join(RUN, 'data');
fs.mkdirSync(DATA, { recursive: true });
process.env.CLAUDE_STATION_DATA = DATA;

const gitEnv = (() => { const e = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.invalid' }; for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete e[k]; return e; })();
const git = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'protocol.file.allow=always', '-c', 'init.defaultBranch=main', ...a], { cwd, encoding: 'utf8', env: gitEnv }); if (r.status !== 0) throw new Error(`git ${a.join(' ')} in ${cwd}: ${r.stderr}`); return r.stdout.trim(); };
const mkrepo = (dir) => { fs.mkdirSync(dir, { recursive: true }); git(dir, 'init', '-q'); fs.writeFileSync(path.join(dir, 'f'), dir); git(dir, 'add', 'f'); git(dir, 'commit', '-qm', 'init'); return fs.realpathSync(dir); };

try {
  const A = mkrepo(path.join(RUN, 'a'));                        // the GRANTED repo
  const N = mkrepo(path.join(A, 'nested'));                     // break 1+2: unregistered repo one level below A
  const DEEP = mkrepo(path.join(A, 'deep', 'x', 'y'));          // nested three levels down
  const SRC = mkrepo(path.join(RUN, 'sub-src'));
  git(A, 'submodule', 'add', '-q', SRC, 'sub');                 // submodule-style: A/sub/.git is a gitfile → A/.git/modules/sub
  git(A, 'commit', '-qm', 'add sub');
  const SUB = path.join(A, 'sub');
  const WT = path.join(RUN, 'a-wt'); git(A, 'worktree', 'add', '-q', WT); // a linked worktree IS A's repository
  const PLAIN = path.join(RUN, 'plain'); fs.mkdirSync(PLAIN);    // a non-repo project dir

  const RI = await import('./lib/repo-identity.mjs');
  const bound = RI.repoIdentityOf(A);

  /* ═══ I — the authority ═══ */
  console.log('\n[I] grantCoversTarget: identity, never prefix');
  check('I1 the granted repo itself (and a subdir of its work tree) is covered', RI.grantCoversTarget(bound, A) && RI.grantCoversTarget(bound, path.join(A, 'deep')), bound);
  check('I2 a repo nested inside A is NOT covered', !RI.grantCoversTarget(bound, N) && !RI.grantCoversTarget(bound, DEEP));
  check('I3 a submodule-style repo (gitfile → A/.git/modules/sub) is NOT covered', !RI.grantCoversTarget(bound, SUB) && RI.repoIdentityOf(SUB)?.commonDir?.startsWith(path.join(A, '.git', 'modules')), RI.repoIdentityOf(SUB));
  check('I4 a linked worktree of A is covered (same repository)', RI.grantCoversTarget(bound, WT));
  check('I5 a non-repo dir is covered only by a grant for exactly that dir', RI.grantCoversTarget(RI.repoIdentityOf(PLAIN), PLAIN) && !RI.grantCoversTarget(RI.repoIdentityOf(PLAIN), path.join(RUN)) && !RI.grantCoversTarget(null, A));

  /* ═══ P — the identity cache: no spawn storm on hot paths, and never stale ═══ */
  console.log('\n[P] repoIdentityOf cache (FEAT-175 e2e regression: uncached git spawns starved the server)');
  const COUNT = path.join(RUN, 'git-count');
  const GITW = path.join(RUN, 'gitw'); fs.writeFileSync(GITW, `#!/bin/sh\necho x >> ${JSON.stringify(COUNT)}\nexec git "$@"\n`, { mode: 0o755 });
  const spawns = () => { try { return fs.readFileSync(COUNT, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
  RI._clearRepoIdentityCache?.();
  const s0 = spawns(); for (let i = 0; i < 50; i++) RI.repoIdentityOf(A, { git: GITW });
  check('P1 50 identity reads of an unchanged repo spawn git once (2 rev-parse), not 100 times', spawns() - s0 === 2, { spawns: spawns() - s0 });
  const SUBD = path.join(A, 'later'); fs.mkdirSync(SUBD);
  const before = RI.repoIdentityOf(SUBD, { git: GITW });
  git(SUBD, 'init', '-q');
  const after = RI.repoIdentityOf(SUBD, { git: GITW });
  check('P2 a cached subdir that later becomes its own repo (git init) re-resolves: no stale answer', before?.commonDir === bound.commonDir && after?.commonDir === fs.realpathSync(path.join(SUBD, '.git')), { before, after });
  const GF = path.join(RUN, 'gf'); fs.mkdirSync(GF);
  fs.writeFileSync(path.join(GF, '.git'), `gitdir: ${path.join(A, '.git', 'modules', 'sub')}\n`);
  const gf1 = RI.repoIdentityOf(GF, { git: GITW });
  fs.writeFileSync(path.join(GF, '.git'), `gitdir: ${path.join(N, '.git')}\n`);
  const gf2 = RI.repoIdentityOf(GF, { git: GITW });
  check('P3 a rewritten gitfile (.git → another gitdir) re-resolves to the new repository', gf1?.commonDir !== gf2?.commonDir && gf2?.commonDir === fs.realpathSync(path.join(N, '.git')), { gf1, gf2 });
  const s1 = spawns(); for (let i = 0; i < 100; i++) for (const d of [A, N, DEEP, SUB, WT]) RI.grantCoversTarget(bound, d, { git: GITW });
  const warm = spawns() - s1;
  const s2 = spawns(); for (let i = 0; i < 100; i++) for (const d of [A, N, DEEP, SUB, WT]) RI.grantCoversTarget(bound, d, { git: GITW });
  check('P4 the hot path (grantCoversTarget over 5 repos ×100) spawns nothing once warm', spawns() - s2 === 0 && warm <= 10, { warm, after: spawns() - s2 });

  /* ═══ S — the shim-decide guard ═══ */
  console.log('\n[S] decideByTarget (the /api/git-shim/decide guard)');
  const P = await import('./lib/agent-git-policy.mjs');
  const scoped = P.normalizeGitWrite({ commit: true, push: false, scope: 'scoped probe' });
  const projA = { id: 'pa', name: 'pa', ...P.describeRegisteredRepo(A), policy: scoped, timedGrantLive: false, binding: bound };
  // fixtureRoots: [] — the fixture dirs here model REAL repos (no scratch exemption).
  const dec = (target, projects = [projA]) => P.decideByTarget({ argv: ['commit', '-m', 'x'], target, sessionProjectId: 'pa', projects, fixtureRoots: [] });
  // FEAT-190 r9/r10 — carry the RESOLVED toplevel (the shim gets it from `git rev-parse
  // --show-toplevel`); without it a real repo reads as bare/no-work-tree and the r10 one-resolved-repo
  // invariant refuses before the policy is reached. These are normal working checkouts.
  const tOf = (dir) => ({ cwd: dir, commonDir: RI.repoIdentityOf(dir)?.commonDir ?? null, toplevel: fs.realpathSync(dir), verb: 'commit', resolvedVerb: true });
  check('S1 granted work is unaffected: a commit in A is allowed', dec(tOf(A)).refusal === null, dec(tOf(A)));
  // S2/S3 REWRITTEN to the FEAT-190 r7 CROSS-REPO rule (superseding FEAT-164's "no project owns it →
  // refused"). FEAT-190 success criterion 3: "a granted session commits and pushes in ANOTHER repo it
  // works in by default." So a scoped grant's commit in a real repo nested inside A (N), or in the
  // submodule-style repo (SUB), is ALLOWED by the session's OWN grant (the leak gate scans that repo).
  // The surviving deny — an EXPLICIT per-repo opt-out, or no session grant at all — is covered by
  // verify-feat-190-matrix (cross-repo commit allowed; Q opt-out deny-only; F1 ungranted both-refused).
  check('S2 FEAT-190 cross-repo: a scoped session\'s commit in a real repo nested inside A is allowed by its own grant', dec(tOf(N)).refusal === null && dec(tOf(N)).key === 'pa', dec(tOf(N)));
  check('S3 FEAT-190 cross-repo: a scoped session\'s commit in the submodule-style repo is allowed by its own grant', dec(tOf(SUB)).refusal === null && dec(tOf(SUB)).key === 'pa', dec(tOf(SUB)));
  check('S4 a commit in A\'s linked worktree is allowed (same repository)', dec(tOf(WT)).refusal === null, dec(tOf(WT)));
  retire('S5 a live grant bound to ANOTHER repo does not cover A (the binding decides)',
    'FEAT-190 r7 — the WRITE decision (governingGrant) keys ownership on the session\'s RESOLVED repo identity (commonDir/tree), not a stored `binding` field, and a granted session covers other repos cross-repo anyway; the seal/binding-voiding on a re-pointed hostPath lives in the grant-READ layer, covered by verify-feat-164-self-grant [H1/B/M] and verify-feat-164-permanent-git-grant.');

  /* ═══ PU — pushes (adjudicated after verify 95027178) ═══ */
  console.log('\n[PU] push destinations by identity; local remotes only as recorded at grant time');
  const ORIGIN = path.join(RUN, 'a-origin.git'); git(RUN, 'clone', '-q', '--bare', A, ORIGIN);
  const Q = path.join(RUN, 'q.git'); git(RUN, 'init', '-q', '--bare', Q);          // registered, UNGRANTED
  const NB = path.join(A, 'nb.git'); git(A, 'init', '-q', '--bare', NB);           // bare repo nested in A
  git(A, 'remote', 'add', 'origin', ORIGIN); git(A, 'remote', 'add', 'q', Q);
  RI._clearRepoIdentityCache?.(); P._clearCommonDirCache(); // A's description was cached before its remotes existed
  const pushBinding = RI.grantBindingOf(A);                                        // what the user's grant records NOW
  const scopedPush = P.normalizeGitWrite({ commit: true, push: true, scope: 'push probe' });
  const mk = () => [
    { id: 'pa', name: 'pa', ...P.describeRegisteredRepo(A), policy: scopedPush, timedGrantLive: false, binding: pushBinding },
    { id: 'pq', name: 'pq', ...P.describeRegisteredRepo(Q), policy: P.normalizeGitWrite(null), timedGrantLive: false, binding: null },
  ];
  // `roots` undefined = the DEFAULT fixture roots: everything here sits under the scratch root, as in the verifier's setup.
  // FEAT-190 r9/r10 — a real push carries its RESOLVED source toplevel (the shim gets it from
  // `git rev-parse --show-toplevel`, git-target.mjs:182-184); without it the source reads as a
  // bare / no-work-tree repo and the r10 one-resolved-repo invariant refuses (same stale-fixture
  // shape the r14 verify-feat-190-ui fix corrected). These sources are normal working checkouts.
  const push = (urls, projects = mk(), roots = []) => P.decideByTarget({ argv: ['push'], target: { cwd: A, commonDir: fs.realpathSync(path.join(A, '.git')), toplevel: fs.realpathSync(A), verb: 'push', resolvedVerb: true, push: { urls } }, sessionProjectId: 'pa', projects, ...(roots ? { fixtureRoots: roots } : {}) });
  check('PU0 setup: the grant recorded A\'s local origin (and q) as remotes at grant time', pushBinding?.remotes?.some((r) => r.commonDir === fs.realpathSync(ORIGIN)) && mk()[0].localRemotes.length === 2, { pushBinding, live: mk()[0].localRemotes });
  // ── FEAT-190 r8 (RESCOPE) SUPERSEDES the "recorded remotes only / frozen-remote veto" model the
  //    rest of [PU] asserted. A granted repo now pushes to WHATEVER remote it has — recorded, added,
  //    re-pointed, nested-bare, or a network URL no project lists — the leak gate on the SOURCE is the
  //    protection, not a destination whitelist. The surviving deny is an EXPLICIT per-repo opt-out
  //    (deny-only). Authoritative FEAT-190 coverage: verify-feat-190-matrix ("push to a NEW/re-pointed
  //    remote is ALLOWED end to end", shared-remote non-veto, Q opt-out deny-only) + [DP] below. ──
  git(A, 'remote', 'add', 'nb', NB); P._clearCommonDirCache();
  check('PU1 FEAT-190: a granted push into a bare repo nested in A (a live remote added after the grant) is ALLOWED (no frozen-remote veto; gate scans the source)', push([NB]).refusal === null && push([`file://${NB}`]).refusal === null && push([NB], mk(), undefined).refusal === null, push([NB], mk(), undefined));
  git(A, 'remote', 'remove', 'nb'); P._clearCommonDirCache();
  const qa = push([Q]), qb = push([Q], mk().reverse()), qc = push([Q], mk(), undefined), qd = push([Q], mk().reverse(), undefined);
  check('PU2 FEAT-190 cross-repo: a granted session\'s push into a registered-but-ungranted (not opted-out) Q is ALLOWED, keyed to the SESSION (pa), whatever the registry order', [qa, qb, qc, qd].every((x) => x.refusal === null && x.key === 'pa'), [qa, qb, qc, qd].map((x) => `${x.key}:${(x.refusal ?? 'ALLOWED').slice(0, 60)}`));
  check('PU3 the local origin recorded at grant time is allowed (granted work unaffected)', push([ORIGIN]).refusal === null && push([`file://${ORIGIN}`]).refusal === null, push([ORIGIN]));
  const R2 = path.join(RUN, 'r2.git'); git(RUN, 'init', '-q', '--bare', R2);
  git(A, 'remote', 'set-url', 'origin', R2); P._clearCommonDirCache();            // the agent repoints origin
  check('PU4 FEAT-190: once origin is repointed (live config), a push to the new destination is ALLOWED (r8 removed the frozen-remote veto)', push([R2]).refusal === null, push([R2]));
  git(A, 'remote', 'set-url', 'origin', ORIGIN); P._clearCommonDirCache();
  const LATE = path.join(RUN, 'late.git'); git(RUN, 'init', '-q', '--bare', LATE); git(A, 'remote', 'add', 'late', LATE); P._clearCommonDirCache();
  check('PU6 FEAT-190: a local remote added AFTER the grant (live config) is ALLOWED (no recorded-remotes whitelist)', push([LATE]).refusal === null, push([LATE]));
  check('PU7 FEAT-190: a push to a network URL no project lists is ALLOWED for a granted session (the gate scans the source)', push(['https://example.invalid/x.git']).refusal === null, push(['https://example.invalid/x.git']));

  /* ═══ UR — ONE remote parser (adjudicated after verify e5d8ca9e) ═══ */
  console.log('\n[UR] parseRemote: %20 file URLs, network variants, scp forms, unparseable input');
  const { parseRemote } = await import('./lib/remote-url.mjs');
  const QS = path.join(RUN, 'q space.git'); git(RUN, 'init', '-q', '--bare', QS);  // registered, UNGRANTED, a space in its path
  const QURL = 'https://github.com/me/q.git';
  git(QS, 'config', 'remote.origin.url', QURL);                                        // Q's network remote
  const FXS = mkrepo(path.join(RUN, 'fixture-src'));                                   // an UNREGISTERED scratch source repo
  const AURL = 'https://github.com/me/a.git';
  git(A, 'remote', 'add', 'gh', AURL); P._clearCommonDirCache();
  const projU = () => [
    { id: 'pa', name: 'pa', ...P.describeRegisteredRepo(A), policy: scopedPush, timedGrantLive: false, binding: RI.grantBindingOf(A) },
    { id: 'pq2', name: 'pq2', ...P.describeRegisteredRepo(QS), policy: P.normalizeGitWrite(null), timedGrantLive: false, binding: null },
  ];
  const pushFrom = (src, urls, roots) => P.decideByTarget({ argv: ['push'], target: { cwd: src, commonDir: fs.realpathSync(path.join(src, '.git')), toplevel: fs.realpathSync(src), verb: 'push', resolvedVerb: true, push: { urls } }, sessionProjectId: 'pa', projects: projU(), ...(roots ? { fixtureRoots: roots } : {}) });
  const fileQ = `file://${QS.split('/').map(encodeURIComponent).join('/')}`;
  const u1 = pushFrom(FXS, [fileQ]);
  // UR1/UR2 REWRITTEN to FEAT-190 r7/r8 (no cross-project destination veto; the surviving deny is an
  // EXPLICIT per-repo opt-out, verify-feat-190-matrix). UR1: a push from an unregistered SCRATCH source
  // is store-governed (the %20-encoded file:// destination still parses), and the ungranted-not-opted-out
  // destination Q no longer vetoes → ALLOWED. The parser-correctness coverage (%20, variants) stays below.
  check('UR1 FEAT-190: a %20 file:// push from an unregistered scratch source into ungranted (not opted-out) Q is store-governed and ALLOWED', /%20/.test(fileQ) && u1.refusal === null, { fileQ, u1: u1.refusal?.slice(0, 140) ?? 'ALLOWED' });
  const variants = ['HTTPS://GitHub.COM/Me/Q.git', 'https://github.com//me//q.git', 'https://github.com/me/q', 'https://github.com/me/q/', 'https://github.com/me/q.git/', 'git@github.com:me/q.git', 'ssh://git@GITHUB.com:22/me//Q.GIT/', 'https://github.com/me/q%2Egit'];
  const vres = variants.map((v) => {
    git(A, 'remote', 'add', 'qv', v); P._clearCommonDirCache();   // A lists the VARIANT; Q lists the canonical URL
    const d = pushFrom(A, [v]);
    git(A, 'remote', 'remove', 'qv'); P._clearCommonDirCache();
    return { v, key: d.key, refused: !!d.refusal };
  });
  check('UR2 FEAT-190: case / // / .git / trailing-slash / scp / encoded variants of Q\'s remote are all ALLOWED for the granted session A (no cross-project veto; the variants still resolve, but Q no longer vetoes)', vres.every((x) => !x.refused && x.key === 'pa'), vres.filter((x) => !(!x.refused && x.key === 'pa')));
  const scp = ['git@github.com:me/q.git', 'github.com:me/q', 'user@[::1]:me/q', '[::1]:me/q'].map((u) => parseRemote(u));
  check('UR3 scp-like forms parse by git\'s colon-before-slash rule; a slash before the colon is a local path', scp.every((x) => x?.kind === 'network') && scp[0].key === 'github.com/me/q' && parseRemote('./x:y', { base: '/b' })?.kind === 'local' && parseRemote('dir/x:y', { base: '/b' })?.path === '/b/dir/x:y', scp);
  const badUrls = ['file://host/tmp/q.git', 'file://localhost/tmp/q.git', `file://${QS}%00`, 'ext::sh -c touch', 'https://github.com/%zz', '', 'https:///nohost'];
  const badRes = badUrls.map((u) => ({ u, parsed: parseRemote(u), refused: !!pushFrom(A, [u]).refusal }));
  check('UR4 unparseable / refused forms (file host, localhost, NUL, ext::, bad %, empty, no host) parse to null and the push is refused', badRes.every((x) => x.parsed === null && x.refused), badRes.filter((x) => !(x.parsed === null && x.refused)));
  const FB = path.join(RUN, 'fixture-bare.git'); git(RUN, 'init', '-q', '--bare', FB);
  const u4b = pushFrom(FXS, [`file://${FB}%00`]);
  check('UR4b an unparseable file:// URL (encoded NUL) from an unregistered scratch source is refused, not waved through as scratch space', !!u4b.refusal, u4b.refusal?.slice(0, 120) ?? 'ALLOWED');
  const okA = ['https://github.com/me/a.git', 'HTTPS://github.com/ME/A', 'git@github.com:me/a.git'].map((u) => pushFrom(A, [u]));
  check('UR5 a granted remote is still allowed (A scoped+push to its own GitHub remote, in any spelling) and its recorded local origin too', okA.every((d) => d.refusal === null && d.key === 'pa') && pushFrom(A, [`file://${ORIGIN}`]).refusal === null, okA.map((d) => d.refusal?.slice(0, 80) ?? 'ok'));

  /* ═══ NK — veto keys through git's resolution; network destinations recorded at grant (verify 45e78a71) ═══ */
  console.log('\n[NK] veto keys = git-resolved remotes; network pushes only to keys recorded at grant time');
  const mkQ = (name, cfg) => { const d = path.join(RUN, `${name}.git`); git(RUN, 'init', '-q', '--bare', d); for (const [k, v] of cfg) git(d, 'config', k, v); return d; };
  const Q3 = mkQ('q3', [['url.https://github.com/.insteadOf', 'gh:'], ['remote.origin.url', 'gh:me/q3.git']]);                         // shorthand
  const Q4 = mkQ('q4', [['url.https://github.com/.pushInsteadOf', 'ghp:'], ['remote.origin.url', 'ghp:me/q4.git']]); // pushInsteadOf (git rewrites only the push URL)
  const Q5 = mkQ('q5', [['url.https://github.com/me/.insteadOf', 'https://mirror.invalid/me/'], ['remote.origin.url', 'https://mirror.invalid/me/q5']]); // insteadOf rewrite
  // The verifier's shape: A ITSELF lists the expanded URLs (so A, granted scoped+push, "owns" them too); only
  // Q's veto can refuse, and on the old code Q's unexpanded config string never matched.
  for (const [n, u] of [['x3', 'https://github.com/me/q3.git'], ['x4', 'https://github.com/me/q4.git'], ['x5', 'https://github.com/me/q5']]) git(A, 'remote', 'add', n, u);
  P._clearCommonDirCache();
  const none = P.normalizeGitWrite(null);
  let grantA = RI.grantBindingOf(A);                                              // the user's grant on A, NOW
  const projNK = () => [
    { id: 'pa', name: 'pa', ...P.describeRegisteredRepo(A), policy: scopedPush, timedGrantLive: false, binding: grantA },
    ...[['pq3', Q3], ['pq4', Q4], ['pq5', Q5]].map(([id, d]) => ({ id, name: id, ...P.describeRegisteredRepo(d), policy: none, timedGrantLive: false, binding: null })),
  ];
  const pushNK = (urls) => P.decideByTarget({ argv: ['push'], target: { cwd: A, commonDir: fs.realpathSync(path.join(A, '.git')), toplevel: fs.realpathSync(A), verb: 'push', resolvedVerb: true, push: { urls } }, sessionProjectId: 'pa', projects: projNK() });
  // ── NK1-3, NK5-6 REWRITTEN to FEAT-190 r7/r8. The FEAT-164 "network destinations only as recorded at
  //    grant time + another project's veto" model is gone: a granted session pushes to any network remote
  //    its config resolves to (recorded, added, or re-pointed), and an ungranted-not-opted-out co-owner Q
  //    does not veto. The insteadOf/pushInsteadOf/mirror SPELLINGS still resolve to the canonical URL
  //    (that resolution is real and exercised here) — the change is only that resolution no longer gates a
  //    veto. Authoritative deny coverage: verify-feat-190-matrix (Q opt-out deny-only; no-frozen-veto). ──
  const v3 = pushNK(['https://github.com/me/q3.git']), v4 = pushNK(['https://github.com/me/q4.git']), v5 = pushNK(['https://github.com/me/q5']);
  check('NK1 FEAT-190: a granted push to the canonical URL Q lists via an insteadOf SHORTHAND (gh:me/q3.git) is ALLOWED (no cross-project veto), keyed to pa', v3.refusal === null && v3.key === 'pa', v3.refusal?.slice(0, 100) ?? 'ALLOWED');
  check('NK2 FEAT-190: a granted push under a pushInsteadOf spelling (ghp:me/q4.git) is ALLOWED, keyed to pa', v4.refusal === null && v4.key === 'pa', v4.refusal?.slice(0, 100) ?? 'ALLOWED');
  check('NK3 FEAT-190: a granted push under an insteadOf rewrite of a full URL (mirror → github) is ALLOWED, keyed to pa', v5.refusal === null && v5.key === 'pa', v5.refusal?.slice(0, 100) ?? 'ALLOWED');
  const rec = pushNK(['https://github.com/me/a.git']);
  check('NK4 a network remote recorded at grant time is allowed', rec.refusal === null && rec.key === 'pa', rec.refusal?.slice(0, 120));
  git(A, 'remote', 'add', 'newer', 'https://github.com/me/newer.git'); P._clearCommonDirCache();
  const added = pushNK(['https://github.com/me/newer.git']);
  check('NK5 FEAT-190: a network remote ADDED after the grant is ALLOWED (r8 removed the recorded-remotes whitelist; the gate scans the source)', added.refusal === null && added.key === 'pa', added.refusal?.slice(0, 220) ?? 'ALLOWED');
  git(A, 'remote', 'set-url', 'gh', 'https://github.com/me/a2.git'); P._clearCommonDirCache();
  const repointed = pushNK(['https://github.com/me/a2.git']);
  check('NK6 FEAT-190: a network remote REPOINTED after the grant is ALLOWED (no frozen-remote veto)', repointed.refusal === null && repointed.key === 'pa', repointed.refusal?.slice(0, 160) ?? 'ALLOWED');
  grantA = RI.grantBindingOf(A);                                                  // the user re-grants
  const reG = [pushNK(['https://github.com/me/newer.git']), pushNK(['https://github.com/me/a2.git'])];
  check('NK7 a re-grant picks up the new and the repointed remote', reG.every((d) => d.refusal === null && d.key === 'pa'), reG.map((d) => d.refusal?.slice(0, 80) ?? 'ok'));
  git(A, 'remote', 'remove', 'newer'); git(A, 'remote', 'set-url', 'gh', AURL);
  for (const n of ['x3', 'x4', 'x5']) git(A, 'remote', 'remove', n);
  P._clearCommonDirCache();

  /* ═══ DP — ONE push authority: the SOURCE grant decides, the gate scans the source (verify 619c99b4) ═══ */
  console.log('\n[DP] decidePush: source grant + recorded destination + destination veto; gate scans the source');
  const SRCU = mkrepo(path.join(RUN, 'src-ungranted'));                        // registered, NO grant
  const BG = mkrepo(path.join(RUN, 'b-granted')); const BGO = path.join(RUN, 'b-granted-origin.git'); git(RUN, 'clone', '-q', '--bare', BG, BGO); git(BG, 'remote', 'add', 'origin', BGO);
  // (A is NOT given B's origin as a remote: then A would be a live-remote claimant and its own missing grant would
  // veto B's pushes there too, a fail-closed side effect. Here the refusal must come from A's SOURCE grant.)
  P._clearCommonDirCache();
  const projDP = () => [
    { id: 'pu', name: 'pu', ...P.describeRegisteredRepo(SRCU), policy: P.normalizeGitWrite(null), timedGrantLive: false, binding: null },
    { id: 'pb', name: 'pb', ...P.describeRegisteredRepo(BG), policy: scopedPush, timedGrantLive: false, binding: RI.grantBindingOf(BG) },
  ];
  const pushFromSrc = (src, session, urls) => P.decideByTarget({ argv: ['push'], target: { cwd: src, commonDir: fs.realpathSync(path.join(src, '.git')), toplevel: fs.realpathSync(src), verb: 'push', resolvedVerb: true, push: { urls } }, sessionProjectId: session, projects: projDP() });
  const d3a = pushFromSrc(SRCU, 'pu', [BGO]), d3b = pushFromSrc(SRCU, 'pu', [BG]), d3c = pushFromSrc(SRCU, 'pu', [`file://${BGO}`]);
  check('DP3 UNGRANTED A pushing into granted B (its origin by path, its repo by path, file://) is refused by A\'s missing grant', [d3a, d3b, d3c].every((d) => !!d.refusal && d.key === 'pu'), [d3a, d3b, d3c].map((d) => `${d.key}:${(d.refusal ?? 'ALLOWED').slice(0, 70)}`));
  const d4 = pushFromSrc(SRCU, 'pu', [BGO]);
  const d5 = pushFromSrc(BG, 'pb', [BGO]);
  check('DP4 the leak gate scans the SOURCE: gateRepo is the repo being pushed from (A), never the destination (B)', d4.gateRepo === SRCU && d5.gateRepo === BG, { d4: d4.gateRepo, d5: d5.gateRepo });
  check('DP5 normal granted push still works: granted B to its recorded origin is allowed, keyed to B', d5.refusal === null && d5.key === 'pb', d5.refusal?.slice(0, 120));
  const idxSrc = fs.readFileSync(path.join(ROOT, 'src/server/index.ts'), 'utf8');
  // FEAT-190 r11 STRENGTHENED this: the gate now scans ONLY the repo the decision resolved
  // (`const gateRepo = sourceGateRepo;`) — the old `?? target?.hostPath ?? repoPath` host fallback that
  // gated the session's OWN repo for a null gateRepo was removed (fail closed). Anchor updated to match.
  check('DP4b the decide route gates a push on the source (sourceGateRepo from decidePush is the gate, no host fallback)', /const gateRepo = sourceGateRepo;/.test(idxSrc) && /sourceGateRepo = typeof d\.gateRepo === 'string'/.test(idxSrc));
  const polSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/agent-git-policy.mjs'), 'utf8');
  const relSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/release.mjs'), 'utf8');
  const pushBranch = polSrc.slice(polSrc.indexOf('  if (PUSH_VERBS.has(verb)) {'), polSrc.indexOf('  if (t?.creating === true) {'));
  check('DP6 one push authority: the shim\'s push branch and release.mjs both call decidePush, and the shim branch decides nothing itself', /decidePush\(/.test(pushBranch) && !/ownersOf|grantCovers|pushRefusal/.test(pushBranch) && /decidePush\(\{ source: \{ cwd: info\.top/.test(relSrc));

  /* ═══ R — the release CLI (break 2) ═══ */
  console.log('\n[R] release CLI: a cut aimed at a repo nested inside granted A');
  const SEAL = await import('./lib/git-write-seal.mjs');
  const { key } = SEAL.ensureSealKey(DATA);
  const gwA = SEAL.sealGitWrite(key, { id: 'pa', hostPath: A }, { commit: true, push: true, scope: 'release probe', grantedAt: 'g', grantedVia: 'dashboard', repo: bound });
  fs.writeFileSync(path.join(DATA, 'registry.json'), JSON.stringify({ version: 1, projects: [{ id: 'pa', name: 'pa', hostPath: A, isolation: 'direct', settings: { gitWrite: gwA } }] }, null, 2));
  const cli = (...a) => { const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'release.mjs'), ...a, '--json'], { encoding: 'utf8', env: { ...process.env, CLAUDE_STATION_DATA: DATA } }); let j = null; try { j = JSON.parse(r.stdout); } catch { /* */ } return { code: r.status, j, out: `${r.stdout}${r.stderr}`.slice(0, 400) }; };
  const polA = cli('policy', A); const polN = cli('policy', N); const polSub = cli('policy', SUB);
  check('R1 granted repo unaffected: `policy <A>` resolves project pa, scoped', polA.j?.project === 'pa' && polA.j?.policy?.mode === 'scoped', polA.out);
  check('R2 `policy <A/nested>` resolves NO project and no grant (was A\'s by prefix)', polN.j?.project === null && polN.j?.policy?.mode === 'none', polN.out);
  check('R3 `policy <A/sub>` (submodule-style) resolves no project and no grant', polSub.j?.project === null && polSub.j?.policy?.mode === 'none', polSub.out);
  const headN = git(N, 'rev-parse', 'HEAD'); const tagsN = git(N, 'tag', '-l');
  const cutN = cli('cut', N, '--as-agent', '--now');
  check('R4 `cut <A/nested> --as-agent` is refused not-granted; the nested repo\'s HEAD and tags are unchanged', cutN.code === 1 && /not-granted|not granted/.test(cutN.out) && git(N, 'rev-parse', 'HEAD') === headN && git(N, 'tag', '-l') === tagsN, cutN.out);

  /* ═══ C — the container mount plan (break 1) ═══ */
  console.log('\n[C] container plan: nested .git under a granted bind root');
  fs.writeFileSync(path.join(DATA, 'registry.json'), JSON.stringify({ version: 1, projects: [] }, null, 2));
  const cm = await import('../src/server/container-manager.ts');
  const DEV_PIN = { pinned: 'dev', skipped: [], deferred: null };
  const proj = (gitWrite) => ({ id: 'pa', name: 'pa', hostPath: A, isolation: 'container', createdAt: new Date().toISOString(), settings: { tools: { serena: false, playwright: false }, browser: { enabled: false }, mounts: [], container: { gpu: 'off', base: DEV_PIN }, ...(gitWrite ? { gitWrite } : {}) } });
  const granted = proj({ commit: true, push: false, scope: 'container probe', repo: bound });
  const guards = (p) => cm.desiredBinds(p).filter((b) => b.why === cm.GIT_GUARD_WHY).map((b) => b.hostPath);
  const real = (d) => fs.realpathSync(d);
  cm._setGitGuardDiscoveryForTest(null);
  const g = guards(granted);
  check('C1 the unregistered repo one level below the granted bind root gets a read-only .git', g.includes(real(path.join(N, '.git'))), g);
  check('C2 the submodule-style repo\'s gitdir (A/.git/modules/sub) is overlaid read-only', g.includes(real(path.join(A, '.git', 'modules', 'sub'))), g);
  check('C3 a repo nested three levels down is overlaid read-only (capped walk, not depth 1)', g.includes(real(path.join(DEEP, '.git'))), g);
  check('C4 the granted repo itself is unaffected: A/.git is NOT overlaid', !g.includes(real(path.join(A, '.git'))), g);
  const rep = cm.gitGuardDiscoveryOf(granted);
  check('C5 the plan reports a complete discovery and the grant applied', rep && rep.truncated.length === 0 && rep.grantApplied === true, rep);
  const gNone = guards(proj(null));
  check('C6 control: without a grant A/.git is overlaid too', gNone.includes(real(path.join(A, '.git'))), gNone);
  check('C7 a grant bound to ANOTHER repo opens nothing (A/.git overlaid)', guards(proj({ commit: true, push: false, scope: 's', repo: RI.repoIdentityOf(N) })).includes(real(path.join(A, '.git'))));
  cm._setGitGuardDiscoveryForTest({ maxDepth: 2 });
  const gT = guards(granted); const repT = cm.gitGuardDiscoveryOf(granted);
  check('C8 a nested repo beyond the depth cap FAILS CLOSED: the plan says truncated, the grant is not applied, A/.git is read-only', !!repT && repT.truncated.length > 0 && repT.grantApplied === false && gT.includes(real(path.join(A, '.git'))) && !gT.includes(real(path.join(DEEP, '.git'))), { repT, gT });
  cm._setGitGuardDiscoveryForTest({ maxDirs: 3 });
  const repB = cm.gitGuardDiscoveryOf(granted);
  check('C9 the directory budget fails closed the same way', !!repB && repB.truncated.some((t) => /more than 3 directories/.test(t)) && repB.grantApplied === false, repB);
  cm._setGitGuardDiscoveryForTest(null);
  // verify 6efa2e34 — an ORDINARY node_modules deeper than the cap must not truncate (the default caps, no test hook).
  const NM = path.join(A, 'node_modules', ...Array.from({ length: 11 }, (_, i) => `p${i}/node_modules`).join('/').split('/'));
  fs.mkdirSync(NM, { recursive: true }); fs.writeFileSync(path.join(NM, 'index.js'), '');
  const nmDepth = path.relative(A, NM).split(path.sep).length;
  cm._setGitGuardDiscoveryForTest(null);
  const repNM = cm.gitGuardDiscoveryOf(granted); const gNM = guards(granted);
  check(`C10 a ${nmDepth}-level-deep node_modules does not truncate discovery: grant applied, A/.git writable, nested repos still overlaid`, nmDepth >= 12 && !!repNM && repNM.truncated.length === 0 && repNM.grantApplied === true && !gNM.includes(real(path.join(A, '.git'))) && gNM.includes(real(path.join(N, '.git'))) && gNM.includes(real(path.join(A, '.git', 'modules', 'sub'))) && gNM.includes(real(path.join(DEEP, '.git'))), { nmDepth, repNM });
  const DISTR = mkrepo(path.join(A, 'dist'));
  cm._setGitGuardDiscoveryForTest(null);
  check('C11 a repo AT a pruned name (dist/) is still found and overlaid read-only (only its contents are not walked)', guards(granted).includes(real(path.join(DISTR, '.git'))));
  fs.rmSync(DISTR, { recursive: true, force: true });
  const DEEPPLAIN = path.join(A, ...Array.from({ length: 12 }, (_, i) => `d${i}`));
  fs.mkdirSync(DEEPPLAIN, { recursive: true });
  cm._setGitGuardDiscoveryForTest(null);
  const repDeep = cm.gitGuardDiscoveryOf(granted);
  check('C12 a truly unreachable depth (12 plain, non-pruned levels) still FAILS CLOSED with the default caps', !!repDeep && repDeep.truncated.some((t) => /deeper than 8 levels/.test(t)) && repDeep.grantApplied === false && guards(granted).includes(real(path.join(A, '.git'))), repDeep);
  fs.rmSync(path.join(A, 'd0'), { recursive: true, force: true }); fs.rmSync(path.join(A, 'node_modules'), { recursive: true, force: true });
  cm._setGitGuardDiscoveryForTest(null);

  /* ═══ G — no path-prefix match decides a grant ═══ */
  console.log('\n[G] rg: no path-prefix match left in a grant decision');
  // In-process scan (the confined runner has no rg); the same pattern is shown with rg on the host.
  const PREFIX = String.raw`startsWith\([^)]*(path\.sep|'/'|"/"|\+ ?'/')|insideOrEqual\(|isInsideDir\(`;
  const rg = (pat, files) => { const re = new RegExp(pat); const out = []; for (const f of files) fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach((l, i) => { if (re.test(l)) out.push(`${f}:${i + 1}:${l.trim()}`); }); return out; };
  check('G0 the scan is not vacuous: it finds the known mount-geometry hits in container-manager', rg(PREFIX, ['src/server/container-manager.ts']).length >= 3);
  const pure = ['scripts/lib/repo-identity.mjs', 'scripts/lib/release.mjs', 'scripts/lib/git-write-seal.mjs', 'scripts/lib/git-grant-store.mjs'];
  const hitsPure = rg(PREFIX, pure);
  check('G1 repo-identity / release / seal / store: no path-prefix match at all', hitsPure.length === 0, hitsPure);
  const hitsPol = rg(PREFIX, ['scripts/lib/agent-git-policy.mjs']).filter((l) => !/const insideOrEqual = /.test(l));
  check('G2 agent-git-policy: the ONLY prefix use is the fixture-root classification of UNREGISTERED scratch space (never a project grant)', hitsPol.length >= 1 && hitsPol.every((l) => /const inFixture = .*fixtureRoots\.some\(\(r\) => insideOrEqual\(r, p\)\)/.test(l)), hitsPol);
  const cmSrc = fs.readFileSync(path.join(ROOT, 'src/server/container-manager.ts'), 'utf8');
  const fnBody = (name) => { const i = cmSrc.indexOf(`function ${name}(`); const j = cmSrc.indexOf('\n}\n', i); return i < 0 ? '' : cmSrc.slice(i, j); };
  const decisionFns = ['repoWriteGranted', 'gitGuardOn', 'standingGitWriteOpen', 'containerGrantBinding'];
  const bad = decisionFns.filter((f) => !fnBody(f) || /startsWith\(|isInsideDir\(|insideOrEqual\(/.test(fnBody(f)));
  check('G3 container plan: the grant decision functions use no prefix match (isInsideDir only places overlays inside a bind)', bad.length === 0 && /grantCoversTarget\(containerGrantBinding\(project\)/.test(fnBody('repoWriteGranted')), bad);
} catch (e) {
  check(`suite threw: ${e.stack?.split('\n').slice(0, 4).join(' | ')}`, false);
} finally {
  fs.rmSync(RUN, { recursive: true, force: true });
}
console.log(`\nFEAT-164 identity: ${pass} passed, ${fail} failed, ${retired} retired (FEAT-190-superseded)`);
process.exit(fail ? 1 : 0);
