#!/usr/bin/env node
/*
 * ════════════════════════ FEAT-190 ROUND-14 DISPOSITION (2026-10-15) ════════════════════════
 * FEAT-190 (orchestrator decisions 2026-10-14 / 2026-10-15) DELIBERATELY REVERSED the FEAT-164
 * r2/r3 git-policy model this suite originally encoded. The authority for the NEW model is the
 * verify-feat-190*.mjs suites (verify-feat-190.mjs, -matrix, -r10/r11/r13/r14, -registry), all
 * green; THIS file is the legacy FEAT-164 release/cadence/shim suite, re-pointed to the new rules.
 *
 * The confirmed FEAT-190 rules (verified against scripts/lib/agent-git-policy.mjs this round):
 *   · A grant = ALLOWED: commit AND push default-on. A BLANK scope is SCOPED (commits directly),
 *     NEVER release. Release (soft-release) mode is an EXPLICIT opt-in only — `release.opt_in:true`;
 *     it is never derived from a blank scope, on new OR legacy records.
 *   · Cross-repo is ALLOWED by default: a granted session commits and pushes in ANOTHER real repo
 *     it works in (registered-ungranted OR unregistered). The SESSION's grant governs (the key is
 *     ALWAYS the session project), never the "target decides" model.
 *   · A DESTINATION repo vetoes a push ONLY via an EXPLICIT opt-out of an owner (release mode, a
 *     push-off toggle, or a per-repo {disabled}/{commit:false}/{push:false}). A registered-but-
 *     UNGRANTED destination (mode 'none', no overrides) does NOT veto — the push is ALLOWED.
 *   · Fixture-ness is decided by LOCATION (scratch/fixture root), NOT registration: a repo under a
 *     scratch root is store-governed (allowed under any commit grant), even in release mode. The
 *     real-repo guard bites only a NON-scratch repo.
 *   · Alias safety still holds (fail closed): a shell (!) / unresolvable / loop alias, and any
 *     non-builtin unresolved command, is REFUSED — but under FEAT-190 the refusal may come from a
 *     DIFFERENT layer/message (e.g. the git-shim "invocation layer" text). The SAFETY property (the
 *     write does NOT land; exit != 0) is load-bearing; the exact refusal MESSAGE is NOT.
 *   · The git-write-policy PUT route now requires optimistic-concurrency `revision` (FEAT-190 r3).
 *
 * PER-CLASS DISPOSITION (rewritten = re-pointed to the FEAT-190 rule; retired = scenario gone):
 *   CLASS                                   DISPOSITION   COVERING FEAT-190 TEST (for the surviving property)
 *   S0.3 blank scope → release              rewritten     verify-feat-190.mjs D2 ("blank scope ≠ release")
 *   S0.11 release-mode note                 rewritten     (release note kept; opt-in release policy)
 *   S1.1 release refuses real-repo commit   rewritten     verify-feat-190-matrix.mjs (release-on → commit refused)
 *   S1.4 unresolvable target                rewritten     fail-closed on a non-builtin command
 *   S1.10 scoped+push → own remote allowed  rewritten     verify-feat-190.mjs D3 (push to own remote allowed)
 *   S2.2 release refuses real commit (E2)   RETIRED       verify-feat-190-matrix.mjs (E2 real repo, outside fixture roots)
 *   S2.3 release explanation text (E2)      RETIRED       verify-feat-190-matrix.mjs + S0.11 (note text; message not load-bearing)
 *   X1/X3 cross-repo commit (scratch)       rewritten     verify-feat-190.mjs D3 ("cross-repo COMMIT allowed under P's grant")
 *   X1b "target decides" refusal msg        RETIRED       verify-feat-190-matrix.mjs F1 (session governs; key=session)
 *   X2 release session → scratch fixture    rewritten     verify-feat-190-r13.mjs (scratch is store-governed)
 *   X4 ungranted session cross-repo         rewritten     verify-feat-190-matrix.mjs F1 (ungranted session refused, both verbs)
 *   X5 scoped→release-owned repo refused    rewritten     verify-feat-190-matrix.mjs (release co-owner vetoes)
 *   X6 unregistered clone push into B       rewritten     verify-feat-190.mjs D3 (push to configured remote allowed)
 *   X7 push into release-mode dest refused  ADDED/kept    verify-feat-190-r13.mjs DOOR A + -matrix.mjs (release sharer vetoes)
 *   U1 cross-repo into unregistered real    rewritten     verify-feat-190.mjs D3 line 120 (unregistered Q allowed)
 *   U1b "unregistered+outside roots" refusal RETIRED      verify-feat-190.mjs D3 (cross-repo allowed — no such refusal)
 *   U3 fail-closed undeterminable target    rewritten     (fail-closed when neither cwd nor commonDir resolves)
 *   W1/W2b/W3 rewrite→B push lands          rewritten     verify-feat-190.mjs D3 / -matrix (push to resolved remote allowed)
 *   W2 pushInsteadOf-on-URL refused         rewritten     safety-only (fail closed; message relaxed)
 *   AL1/AL2/AL3 alias push into B lands     rewritten     verify-feat-190.mjs D3 (push to resolved remote allowed)
 *   AL4/AL5/AL6 shell/unresolvable/loop     rewritten     safety-only (fail closed; message relaxed)
 *   K2 release mode → read-only container   rewritten     release via explicit opt_in
 *   M2 blank note → scoped                  rewritten     verify-feat-190.mjs D2
 *   P2/P4.2/DP1/DP2/P5(.1/.2/.3) release    rewritten     release via explicit opt_in (release.opt_in:true)
 *   P4.3 blank note → scoped                rewritten     verify-feat-190.mjs D2
 *   S9.3/.6/.7/.8/.9/.10 station policy     rewritten     thread PUT `revision` (FEAT-190 r3); blank → scoped
 * Exfiltration/release-refusal coverage retained LOCALLY: X5 (commit veto), X7 + W2 + AL4/5/6
 * (push refused), cross-checked against the named FEAT-190 authority tests above.
 */
/**
 * verify-feat-164-release.mjs — FEAT-164 (2026-10-11): per-project agent git policy and
 * SOFT RELEASES. The user's decision: "default no commits, each project the user requests
 * and will inform the scoping; when undetermined scoping, use whatever is appropriate,
 * while avoiding spam to main GitHub — instead it must be like soft release versions."
 *
 * The five proofs the dispatch names, each shown as BEFORE (a named baseline) must FAIL
 * the property and AFTER must hold it — a BEFORE that holds is itself a FAIL
 * (non-vacuity):
 *   P1 an ungranted project gets no commit          (baseline: release lib with the grant check removed)
 *   P2 N verified tickets → ONE release commit       (baseline: today's per-ticket `candidate commit`)
 *   P3 an unverified ticket is excluded              (baseline: release lib with the verdict check removed)
 *   P4 push only when granted, only at a release     (baseline: the decide host WITHOUT the real-repo guard,
 *                                                     i.e. today's standing grant, lets an agent push)
 *   P5 a release whose gate fails is refused         (baseline: release lib with the checks ignored)
 * plus: policy normalisation + legacy mapping, the agent prompt note, the real-repo guard
 * through the REAL shim executable (release mode refuses real-repo writes, fixture repos
 * keep working, push judged by destination), cadence, versions + tag collision, subset
 * retry, the alarm, and atomic publish (HEAD moved / hook refused → no commit, no tag).
 *
 * Fixtures are throwaway repos under the scratch root. It needs git writes in scratch
 * repos, which an Orchard agent session refuses: run it in your terminal or confined:
 *   node scripts/confined-run.mjs -- node scripts/verify-feat-164-release.mjs
 * Exit 0 = all PASS, 1 = a FAIL, 2 = could not run here.
 */
import { spawnSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempScratch } from './lib/scratch.mjs';
import * as CS from './lib/candidate-store.mjs';
import * as R from './lib/release.mjs';
import * as P from './lib/agent-git-policy.mjs';
import * as SEAL from './lib/git-write-seal.mjs';
import { grantBindingOf, repoIdentityOf } from './lib/repo-identity.mjs';
import { installGitShim } from './lib/git-shim.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Pinned fixtures import siblings as `./x.mjs`; they resolve to the current scripts/lib, except
// the FEAT-170 lane-repo guard module (removed 2026-10-13), whose pinned round-3 bytes stand in.
const pinnedDep = (f) => pathToFileURL(f === 'shadow-guard.mjs' ? path.join(HERE, 'fixtures/feat-164/shadow-guard-r3.mjs') : path.join(HERE, 'lib', f)).href;
const CLI = path.join(HERE, 'release.mjs');
const CAND = path.join(HERE, 'candidate.mjs');

let pass = 0; let failN = 0; let retiredN = 0;
function check(name, ok, observed = '') {
  if (ok) pass++; else failN++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${observed !== '' ? `\n        observed: ${String(observed).split('\n').join('\n        ')}` : ''}`);
}
/** FEAT-190 round-14: a case whose scenario no longer exists under FEAT-190 is RETIRED, never
 * silently deleted. Not counted as pass or fail; names the superseding decision AND the specific
 * FEAT-190 test (file + case) that now covers the surviving property. */
function retired(name, { supersededBy, coveredBy }) {
  retiredN++;
  console.log(`RETIRED  ${name}\n        superseded by: ${supersededBy}\n        covered by: ${coveredBy}`);
}
function beforeAfter(name, beforeHolds, afterHolds, obsBefore = '', obsAfter = '') {
  check(`${name} — BEFORE (baseline) fails the property [must-FAIL]`, beforeHolds === false, obsBefore);
  check(`${name} — AFTER holds it`, afterHolds === true, obsAfter);
}

const dirs = [];
const cleanup = () => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } } };
function gitf(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`fixture git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const gitq = (dir, ...args) => { const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' }); return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }; };
function w(dir, rel, body, mode) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  if (mode) fs.chmodSync(p, mode);
}
const head = (dir) => gitf(dir, 'rev-parse', 'HEAD');
const tags = (dir) => gitf(dir, 'for-each-ref', '--format=%(refname:strip=2)', 'refs/tags/').split('\n').filter(Boolean);

/* ── environment probe: fixtures need git writes in scratch repos ── */
{
  const probe = mkdtempScratch('feat164-probe-'); dirs.push(probe);
  const r = spawnSync('git', ['-C', probe, 'init', '-q'], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.log('COULD NOT RUN: this environment refuses git writes even in a throwaway scratch repo (an Orchard');
    console.log('agent session). Run it confined:  node scripts/confined-run.mjs -- node scripts/verify-feat-164-release.mjs');
    cleanup();
    process.exit(2);
  }
}

/** A fresh project repo with a gate, a test, a recording pre-commit hook, and a bare "GitHub" remote. */
function fixture(name) {
  const dir = mkdtempScratch(`feat164-${name}-`); dirs.push(dir);
  const remote = `${dir}-remote.git`; dirs.push(remote);
  gitf(dir, 'init', '-q', '-b', 'main');
  gitf(dir, 'config', 'user.email', 'fixture@example.invalid');
  gitf(dir, 'config', 'user.name', 'fixture');
  gitf(dir, 'config', 'core.hooksPath', '.githooks');
  w(dir, 'package.json', JSON.stringify({ name: 'fx', private: true, scripts: { gate: 'node gate.mjs' } }, null, 2) + '\n');
  // The project's gate: must run inside a real repo, and fails when any source says BREAKS_MAIN.
  w(dir, 'gate.mjs', [
    "import { execFileSync } from 'node:child_process';",
    "import * as fs from 'node:fs';",
    "execFileSync('git', ['rev-parse', '--is-inside-work-tree']);",
    "const bad = fs.readdirSync('src').filter((f) => fs.readFileSync('src/' + f, 'utf8').includes('BREAKS_MAIN'));",
    "if (bad.length) { console.log('GATE FAIL: ' + bad.join(',')); process.exit(1); }",
    "console.log('GATE PASS');",
  ].join('\n') + '\n');
  for (const f of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) w(dir, `src/${f}.mjs`, `export const ${f} = 0;\n`);
  w(dir, 'test/t.test.mjs', "console.log('PASS t');\n");
  w(dir, '.githooks/pre-commit', '#!/bin/sh\ngit diff --cached --name-only > "$(git rev-parse --git-common-dir)/hook-saw.txt"\n[ -f "$(git rev-parse --git-common-dir)/hook-refuse" ] && exit 1\nexit 0\n', 0o755);
  w(dir, 'docs/bugs/.keep', '');
  gitf(dir, 'add', '-A');
  gitf(dir, 'commit', '-qm', 'base');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  gitf(dir, 'remote', 'add', 'origin', remote);
  gitf(dir, 'push', '-q', '-u', 'origin', 'main');
  return { dir, remote, base: head(dir) };
}

let tick = 0;
// Verdicts are recorded just after the (real-clock) freezes, so a ticket's ready time is ≈ T0.
const T0 = Date.now() + 60_000;
const verdict = (run, v, candidate) => ({ provider: 'openai', model: 'm', run_id: run, verdict: v, recorded_at: new Date(T0 + 1000 * tick++).toISOString(), ...(candidate ? { candidate } : {}) });
function ticketFile(dir, id, entries) {
  const rec = { id, type: id.startsWith('FEAT') ? 'feature' : 'bug', title: `${id} fixture title`, verification: entries };
  w(dir, `docs/bugs/${id}-fixture.md`, `\`\`\`orchard-ticket\n${JSON.stringify(rec, null, 2)}\n\`\`\`\n\n# ${id} — ${id} fixture title\n`);
}
/** Claim, edit, freeze (with a recorded check) → candidate hash. */
function freeze(dir, id, file, content, { check = 'node test/t.test.mjs' } = {}) {
  CS.claimFiles({ repo: dir, id, files: [file] });
  w(dir, file, content);
  return CS.freezeCandidate({ repo: dir, id, files: [file], checks: check ? [check] : [] }).hash;
}
function verified(dir, id, file, content, opts) {
  const h = freeze(dir, id, file, content, opts);
  ticketFile(dir, id, [verdict(`run-${id}`, 'holds', h)]);
  return h;
}
function copyRepo(fx, tag) {
  const d = mkdtempScratch(`feat164-copy-${tag}-`); dirs.push(d);
  fs.rmSync(d, { recursive: true, force: true });
  spawnSync('cp', ['-a', fx.dir, d]);
  const remote = `${d}-remote.git`; dirs.push(remote);
  spawnSync('cp', ['-a', fx.remote, remote]);
  gitf(d, 'remote', 'set-url', 'origin', remote);
  return { dir: d, remote };
}
function registry(projects) {
  const d = mkdtempScratch('feat164-data-'); dirs.push(d);
  // A fixture grant stands for one the USER saved, so it carries the one writer's seal
  // (FEAT-164 option A: an unsealed value reads as no grant; the seal suite covers that).
  const { key } = SEAL.ensureSealKey(d);
  // ...bound to the repo it is for (FEAT-164 grant binding), exactly as setGitWritePolicy stores it.
  const gw = (id, dir, v) => (v && typeof v === 'object' ? SEAL.sealGitWrite(key, { id, hostPath: dir }, { ...v, repo: grantBindingOf(dir) }) : v);
  fs.writeFileSync(path.join(d, 'registry.json'), JSON.stringify({ projects: projects.map(([id, dir, gitWrite]) => ({ id, name: id, hostPath: dir, isolation: 'direct', settings: gitWrite === undefined ? {} : { gitWrite: gw(id, dir, gitWrite) } })) }, null, 2));
  return d;
}
function cli(args, dataDir) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, CLAUDE_STATION_DATA: dataDir }, maxBuffer: 64 * 1024 * 1024 });
  let json = null; try { json = JSON.parse(r.stdout); } catch { /* not json */ }
  return { code: r.status, json, out: (r.stdout || '') + (r.stderr || '') };
}
function candCli(args, dir) {
  const r = spawnSync(process.execPath, [CAND, ...args, '--repo', dir], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
/** Import a COPY of a lib module with `edits` applied (each anchor must match exactly once). */
async function mutant(rel, edits) {
  let src = fs.readFileSync(path.join(HERE, rel), 'utf8');
  src = src.replace(/from '\.\/([^']+)'/g, (_m, f) => `from '${pathToFileURL(path.join(HERE, path.dirname(rel), f)).href}'`);
  for (const [a, b] of edits) {
    const n = src.split(a).length - 1;
    if (n !== 1) throw new Error(`mutant anchor matched ${n}x: ${a}`);
    src = src.replace(a, b);
  }
  const dir = mkdtempScratch('feat164-mutant-'); dirs.push(dir);
  const f = path.join(dir, path.basename(rel));
  fs.writeFileSync(f, src);
  return import(pathToFileURL(f).href);
}
const H = 3_600_000;

async function main() {
  /* ─────────────────────────────── S0 policy normalisation + the agent note */
  console.log('\n── S0 the one policy rule (normalizeGitWrite) and what agents are told');
  const n = P.normalizeGitWrite;
  check('S0.1 no setting → mode none (the default: no agent commits)', n(undefined).mode === 'none' && n(null).mode === 'none', n(undefined).mode);
  const leg = n({ permanent: true, grantedAt: 'x' });
  check('S0.2 MIGRATION: an existing {permanent:true} → scoped, commit + push, with the visible migrated note', leg.mode === 'scoped' && leg.push === true && leg.legacy === true && leg.scope === P.MIGRATED_SCOPE_NOTE, JSON.stringify({ mode: leg.mode, push: leg.push, scope: leg.scope }));
  // FEAT-190: release mode is an EXPLICIT opt-in (`release.opt_in:true`); a blank scope is SCOPED.
  // relPol = a genuine release-mode grant (the opt-in), used across S0/S1/S2/X as "release mode".
  const relPol = n({ commit: true, push: false, scope: null, release: { opt_in: true }, grantedAt: 'x' });
  check('S0.3 commit + blank note → SCOPED mode (FEAT-190: blank scope is no longer release)', n({ commit: true, scope: '   ' }).mode === 'scoped', n({ commit: true, scope: '   ' }).mode);
  const sc = n({ commit: true, push: true, scope: 'commit to main; push daily' });
  check('S0.4 commit + note → scoped, push as granted', sc.mode === 'scoped' && sc.push === true && sc.scope === 'commit to main; push daily', JSON.stringify({ mode: sc.mode, push: sc.push }));
  check('S0.5 push without commit → none, push false', n({ commit: false, push: true }).mode === 'none' && n({ commit: false, push: true }).push === false);
  check('S0.6 torn / wrong-typed values fail closed to none', ['x', 3, [], { commit: 'yes' }, { permanent: 'true' }].every((v) => n(v).mode === 'none'));
  check('S0.7 cadence default is the evidence-based 5 tickets / 72 h / 24 h', JSON.stringify([n(null).release.minTickets, n(null).release.maxWaitHours, n(null).release.minIntervalHours]) === '[5,72,24]', JSON.stringify(n(null).release));
  check('S0.8 cadence override is per project', n({ commit: true, release: { minTickets: 2, maxWaitHours: 12 } }).release.minTickets === 2);
  const v = P.validatePolicyInput;
  check('S0.9 settings route validation: ok shape accepted, unknown key / bad cadence / multi-line check refused',
    !!v({ commit: true, push: false, scope: null }).value && !!v({ commit: true, extra: 1 }).error && !!v({ commit: true, release: { minTickets: 0 } }).error && !!v({ commit: true, release: { checks: ['a\nb'] } }).error,
    JSON.stringify([v({ commit: true, extra: 1 }).error, v({ commit: true, release: { minTickets: 0 } }).error]));
  check('S0.10 no grant → NO prompt note (byte-identical prompts)', P.agentGitPolicyNote(n(null)) === null);
  const rn = P.agentGitPolicyNote(relPol, { orchardDir: '/o', projectId: 'fx' });
  check('S0.11b a migrated (unsaved) grant adds NO prompt note — prompts stay byte-identical', P.agentGitPolicyNote(leg) === null);
  check('S0.11 release-mode note: never commit yourself, soft releases, the cadence, no push', /SOFT RELEASES/.test(rn) && /never commit or push/.test(rn) && /at least 5 verified tickets/.test(rn) && /NOT pushed/.test(rn), rn.split('\n')[1]);
  const sn = P.agentGitPolicyNote(sc);
  check('S0.12 scoped note quotes the user\'s scope note verbatim', sn.includes('> commit to main; push daily'), sn.split('\n').slice(0, 3).join(' / '));

  /* ─────────────────────────────── S1 the target-repo guard (pure) */
  console.log('\n── S1 the target-repo guard (decideByTarget): the policy of the repo git resolves decides');
  const g = fixture('guard');
  const other = fixture('other'); // a scratch repo that is NOT registered
  // a NETWORK remote of the registered project (offline: only its URL identity matters)
  gitf(g.dir, 'remote', 'add', 'gh', 'https://github.example/me/fx.git');
  const realCommon = P.gitCommonDirOf(g.dir);
  check('S1.0 precondition: the registered repo\'s common dir resolves (not the cwd fallback)', typeof realCommon === 'string' && realCommon.endsWith(`${path.sep}.git`), realCommon);
  P._clearCommonDirCache();
  const descG = P.describeRegisteredRepo(g.dir);
  check('S1.0b a registered repo is identified by its common dir, its LOCAL bare origin and its network remote URLs',
    descG.localRemotes.includes(fs.realpathSync(g.remote)) && descG.networkRemotes.includes('github.example/me/fx'), JSON.stringify({ local: descG.localRemotes.map((d) => path.basename(d)), net: descG.networkRemotes }));
  // A live grant (standing scoped/release or timed) is bound to the repo it was given for, exactly as the
  // decide route supplies `binding` (FEAT-164 single authority: decideByTarget asks grantCoversTarget).
  // The binding records the repo's local remotes AT GRANT TIME (grantBindingOf), i.e. the fixture's origin as the user granted it.
  const projOf = (id, desc, policy, timed = false) => ({ id, name: id, ...desc, policy, timedGrantLive: timed, binding: (timed || policy?.mode !== 'none') ? { commonDir: desc.commonDir ?? null, toplevel: desc.tree ?? null, remotes: (desc.localRemotes || []).map((d) => repoIdentityOf(d)).filter((x) => x?.commonDir), networkKeys: [...(desc.networkRemotes || [])] } : null });
  const dec = (policy, argv, target, timed = false) => P.decideByTarget({ argv, target, sessionProjectId: 'fx', projects: [projOf('fx', descG, policy, timed)] }).refusal;
  // FEAT-190: fixture-ness is by LOCATION. The S1 fixtures live under the scratch root, so `dec`
  // (default fixtureRoots) sees them as SCRATCH (store-governed → commit allowed under any grant).
  // To exercise the REAL-repo guard (release mode refuses a direct commit), `decReal` passes
  // fixtureRoots:[] so the same fixture is judged as a real repo.
  const decReal = (policy, argv, target, timed = false) => P.decideByTarget({ argv, target, sessionProjectId: 'fx', projects: [projOf('fx', descG, policy, timed)], fixtureRoots: [] }).refusal;
  const tReal = { cwd: fs.realpathSync(g.dir), commonDir: realCommon };
  // FEAT-190 r10 — a push/commit resolves the SOURCE/target work-tree toplevel; a target with a
  // resolved commonDir but no toplevel is treated as bare (fail closed). Real git-target supplies it;
  // the hand-built S1 targets must too for the ALLOW cases.
  const tRealTop = { ...tReal, toplevel: fs.realpathSync(g.dir) };
  const tOther = { cwd: fs.realpathSync(other.dir), commonDir: P.gitCommonDirOf(other.dir) };
  const GH = 'git@github.example:me/fx.git'; // the same remote, scp form
  const rel = relPol; const scopedNoPush = n({ commit: true, scope: 'commits ok' }); const scopedPush = sc; const none = n(null);
  check('S1.1 release: a commit in a NON-scratch registered real repo is refused (FEAT-190: scratch is store-governed, so the guard is shown with fixtureRoots:[])', !!decReal(rel, ['commit', '-m', 'x'], tRealTop), (decReal(rel, ['commit', '-m', 'x'], tRealTop) || '').split('\n')[0]);
  check('S1.2 release: a commit in an unregistered scratch/fixture repo is left to the session grant', dec(rel, ['commit', '-m', 'x'], tOther) === null);
  check('S1.3 release: init/clone (a NEW repo) allowed', dec(rel, ['init', 'x'], { cwd: tReal.cwd, creating: true }) === null);
  check('S1.4 a non-builtin / unresolved command is refused fail-closed REGARDLESS of location (FEAT-190 alias safety: treated as a potential push)',
    !!dec(rel, ['frobnicate-xyz'], { cwd: tReal.cwd, commonDir: null }) && !!dec(rel, ['frobnicate-xyz'], { cwd: os.tmpdir(), commonDir: null }),
    `inside: ${(dec(rel, ['frobnicate-xyz'], { cwd: tReal.cwd, commonDir: null }) || '').split('\n')[0]}`);
  check('S1.5 a push to a network URL that is NO registered project\'s remote is ungranted → refused, whatever the session', !!dec(scopedPush, ['push', 'origin', 'main'], { ...tOther, push: { urls: ['git@github.com:someone/else.git'] } }));
  check('S1.6 release: push to a local, unregistered bare remote (a fixture) is allowed', dec(rel, ['push', 'origin', 'main'], { ...tOther, push: { urls: [other.remote] } }) === null);
  check('S1.7 release: push INTO the registered real repo by path, or to its local origin, is refused', !!dec(rel, ['push', 'x', 'HEAD:refs/heads/y'], { ...tOther, push: { urls: [g.dir] } }) && !!dec(rel, ['push'], { ...tOther, push: { urls: [g.remote] } }));
  check('S1.8 push with an undeterminable destination is refused (fail closed)', !!dec(rel, ['push'], { ...tOther, push: { urls: [] } }));
  check('S1.9 scoped without push: real-repo commit allowed, push to its GitHub remote refused', dec(scopedNoPush, ['commit'], tReal) === null && !!dec(scopedNoPush, ['push'], { ...tReal, push: { urls: [GH] } }));
  check('S1.10 scoped WITH push: push to its own GitHub remote allowed (matched by URL across scp/https forms)', dec(scopedPush, ['push'], { ...tRealTop, push: { urls: [GH] } }) === null && dec(scopedPush, ['push'], { ...tRealTop, push: { urls: ['https://github.example/me/fx'] } }) === null, dec(scopedPush, ['push'], { ...tRealTop, push: { urls: [GH] } }) || 'allowed');
  check('S1.11 a live 30-min grant lifts release-mode COMMITS but never a push', dec(rel, ['commit'], tReal, true) === null && !!dec(rel, ['push'], { ...tReal, push: { urls: [GH] } }, true));
  check('S1.12 the session\'s OWN ungranted project: commit left to the store\'s standard refusal; its remote push refused', dec(none, ['commit'], tReal) === null && !!dec(none, ['push'], { ...tReal, push: { urls: [GH] } }));
  check('S1.13 a target that SAYS push cannot loosen an argv push; argv push with unparsed globals stays a push', !!dec(rel, ['--weird', 'push'], { cwd: os.tmpdir(), commonDir: null, push: { urls: ['https://x/y'] } }));

  /* ─────────────────────────────── S2 E2 end-to-end through the REAL shim executable */
  console.log('\n── S2 the real shim executable + a decide host running decideByTarget (P4 agent push, real-repo commits)');
  const { resolveWriteTarget } = await import('./lib/git-target.mjs');
  // The stand-in host = /api/git-shim/decide: decideByTarget over the registered projects, then
  // the STORE's claim on the decided key (a standing grant iff that project's mode ≠ none).
  let guardOn = true; let hostPolicy = relPol; let hostProjects = null; let hostSession = 'fx'; let hostFixtureRoots; let targetOverride = null; let decideOverride = null; const decided = [];
  const host = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let b = {}; try { b = JSON.parse(body); } catch { /* */ }
      decided.push(b);
      const projects = hostProjects ?? [projOf('fx', descG, hostPolicy)];
      let reply;
      if (!guardOn) reply = { allow: true };
      else {
        const d = (decideOverride ?? P.decideByTarget)({ argv: b.argv || [], target: targetOverride ? targetOverride(b) : (b.target ?? null), sessionProjectId: hostSession, projects, ...(hostFixtureRoots ? { fixtureRoots: hostFixtureRoots } : {}) });
        const keyed = projects.find((q) => q.id === d.key);
        const storeGrant = !!keyed && (keyed.policy.mode !== 'none' || keyed.timedGrantLive);
        reply = d.refusal ? { allow: false, reason: d.refusal } : storeGrant ? { allow: true, projectKey: d.key } : { allow: false, reason: `store: no grant for ${d.key}` };
        b._key = d.key; b._allow = !!reply.allow;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((r) => host.listen(0, '127.0.0.1', r));
  const hostUrl = `http://127.0.0.1:${host.address().port}`;
  const shimBase = mkdtempScratch('feat164-shim-'); dirs.push(shimBase);
  const { env: shimEnv, realGit } = installGitShim({ ...process.env }, { baseDir: shimBase, grantKey: 'fx', hostUrl, shimAuth: 'test-auth' });
  const sgit = (cwd, ...args) => new Promise((resolve) => {
    const c = spawn('git', args, { cwd, env: shimEnv });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
  });
  const t = resolveWriteTarget(['-C', g.dir, 'commit', '-m', 'x'], process.env, { realGit, cwd: other.dir });
  check('S2.0 the shim resolves the target with the real git (-C honoured, common dir realpath)', t.commonDir === realCommon && t.verb === 'commit', JSON.stringify(t));
  const tp = resolveWriteTarget(['push', 'origin', 'main'], process.env, { realGit, cwd: other.dir });
  check('S2.0b push destination resolved from the remote name', tp.push?.urls?.[0] === other.remote, JSON.stringify(tp.push));
  const cloneDir = path.join(mkdtempScratch('feat164-clone-'), 'c'); dirs.push(path.dirname(cloneDir));
  for (const mode of ['BEFORE', 'AFTER']) {
    guardOn = mode === 'AFTER';
    const h0 = head(g.dir); const remoteMain0 = gitf(g.remote, 'rev-parse', 'main');
    const c1 = await sgit(g.dir, 'commit', '--allow-empty', '-qm', `agent spam ${mode}`);
    const realCommitted = head(g.dir) !== h0;
    fs.rmSync(cloneDir, { recursive: true, force: true });
    const c2 = await sgit(path.dirname(cloneDir), 'clone', '-q', g.dir, cloneDir);
    gitf(cloneDir, 'config', 'user.email', 'a@b.invalid'); gitf(cloneDir, 'config', 'user.name', 'a');
    const c3 = await sgit(cloneDir, 'commit', '--allow-empty', '-qm', 'in clone');
    const c4 = await sgit(cloneDir, 'push', '-q', 'origin', `HEAD:refs/heads/agent-${mode}`);
    const realGotBranch = gitq(g.dir, 'rev-parse', '--verify', '--quiet', `refs/heads/agent-${mode}`).code === 0;
    const o0 = head(other.dir);
    const c5 = await sgit(other.dir, 'commit', '--allow-empty', '-qm', 'fixture commit');
    const c6 = await sgit(other.dir, 'push', '-q', 'origin', 'main');
    const fixtureOk = c5.code === 0 && head(other.dir) !== o0 && c6.code === 0 && gitf(other.remote, 'rev-parse', 'main') === head(other.dir);
    const c7 = await sgit(g.dir, 'push', '-q', 'origin', 'HEAD:refs/heads/spam');
    const remoteGotSpam = gitq(g.remote, 'rev-parse', '--verify', '--quiet', 'refs/heads/spam').code === 0;
    const holds = !realCommitted && !realGotBranch && !remoteGotSpam && gitf(g.remote, 'rev-parse', 'main') === remoteMain0;
    const obs = `real-repo commit exit ${c1.code} (HEAD moved: ${realCommitted}); clone ${c2.code}; clone commit ${c3.code}; clone→real push exit ${c4.code} (real repo got branch: ${realGotBranch}); real→remote push exit ${c7.code} (remote got spam: ${remoteGotSpam}); fixture commit+push ok: ${fixtureOk}`;
    if (mode === 'BEFORE') { check('S2.1 P4/E2 BEFORE (decide host without the guard = today\'s standing grant): agent commits and pushes reach the real repo/remote [must-FAIL]', holds === false, obs); check('S2.1b BEFORE: fixture repos work', fixtureOk, obs); }
    else {
      // FEAT-190 RETIRED (see header). The S2 "real repo" (g.dir) and "fixture" (other.dir) both
      // live under the scratch root, so FEAT-190 classes BOTH as scratch/store-governed: a release-
      // mode session's writes to them are ALLOWED, not refused. The release-mode real-repo guard
      // exists only for a NON-scratch repo, which this suite's scratch fixtures cannot model; the
      // E2-through-the-real-shim real-repo proof lives in verify-feat-190-matrix.mjs (repos outside
      // the fixture roots). We keep S2.0/S2.0b/S2.1/S2.1b/S2.4 running the real shim E2 path.
      void holds; void fixtureOk; // the observed string is still printed below for the retirement record
      retired('S2.2 P4/E2 AFTER (release mode): real-repo commit, clone→real push and real→remote push all refused; fixture repo commit+push still work', {
        supersededBy: 'FEAT-190 (2026-10-15): fixture-ness is by LOCATION (scratch root), not registration — a scratch repo is store-governed (allowed) even in release mode; the real-repo guard bites only a NON-scratch repo. ' + obs,
        coveredBy: 'verify-feat-190-matrix.mjs (release-on toggle, repos OUTSIDE the fixture roots, E2 through the real binary: commit AND push refused with a named reason)',
      });
      retired('S2.3 the agent sees the release-mode explanation verbatim', {
        supersededBy: 'FEAT-190 (2026-10-15): a scratch fixture commit is ALLOWED in release mode, so no refusal text is emitted here; the exact refusal message is not load-bearing (header rule).',
        coveredBy: 'verify-feat-190-matrix.mjs (E2 release refusal) + S0.11 (the release-mode prompt-note text, asserted verbatim)',
      });
      check('S2.4 every decide call carried a resolved target', decided.filter((b) => b.target).length === decided.length && decided.length > 0, `${decided.filter((b) => b.target).length}/${decided.length}`);
    }
    gitf(g.dir, 'reset', '-q', '--hard', h0);
    spawnSync('git', ['-C', g.dir, 'branch', '-D', `agent-${mode}`], { encoding: 'utf8' });
    spawnSync('git', ['-C', g.remote, 'update-ref', '-d', 'refs/heads/spam'], { encoding: 'utf8' });
  }

  /* ── X cross-project (verify adb2b039 P1): the TARGET repo's policy decides, never the session's */
  console.log('\n── X cross-project writes: a scoped session in A writing into B / methodology-style repos');
  const A = fixture('projA'); const B = fixture('projB'); const M = fixture('projM');
  P._clearCommonDirCache();
  const dA = P.describeRegisteredRepo(A.dir); const dB = P.describeRegisteredRepo(B.dir); const dM = P.describeRegisteredRepo(M.dir);
  const scopedPushPol = n({ commit: true, push: true, scope: 'commit and push to main' });
  // The REAL round-1 guard bytes, pinned: it applied the SESSION's policy to any registered repo.
  const P1 = await (async () => {
    let src = fs.readFileSync(path.join(HERE, 'fixtures/feat-164/agent-git-policy-r1.mjs'), 'utf8');
    src = src.replace(/from '\.\/([^']+)'/g, (_m, f) => `from '${pinnedDep(f)}'`);
    const d = mkdtempScratch('feat164-p1-'); dirs.push(d);
    fs.writeFileSync(path.join(d, 'policy-r1.mjs'), src);
    return import(pathToFileURL(path.join(d, 'policy-r1.mjs')).href);
  })();
  const r1Host = (sessionPolicy) => (b) => {
    const prot = P1.protectedRepoDirs([A.dir, B.dir, M.dir]); const trees = [A.dir, B.dir, M.dir].map((x) => fs.realpathSync(x));
    const refusal = P1.decideRealRepoGuard({ policy: sessionPolicy, argv: b.argv || [], target: b.target ?? null, protectedDirs: prot, protectedTrees: trees, timedGrantLive: false });
    return refusal ? { allow: false, reason: refusal } : sessionPolicy.mode !== 'none' ? { allow: true } : { allow: false, reason: 'store' };
  };
  // swap the host's decision function for the BEFORE leg
  let r1 = null;
  const realHandler = host.listeners('request')[0];
  host.removeAllListeners('request');
  host.on('request', (req, res) => {
    if (!r1) return realHandler(req, res);
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => { let b = {}; try { b = JSON.parse(body); } catch { /* */ } res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(r1(b))); });
  });
  const cross = async () => {
    const hB = head(B.dir); const rB = gitf(B.remote, 'rev-parse', 'main');
    const c = await sgit(A.dir, '-C', B.dir, 'commit', '--allow-empty', '-qm', 'from session A');
    const p = await sgit(B.dir, 'push', '-q', 'origin', 'HEAD:main');
    const o = { commit: c.code, bCommitted: head(B.dir) !== hB, push: p.code, bRemoteMoved: gitf(B.remote, 'rev-parse', 'main') !== rB, msg: c.out.split('\n')[0] };
    gitf(B.dir, 'reset', '-q', '--hard', hB); spawnSync('git', ['-C', B.remote, 'update-ref', 'refs/heads/main', rB], { encoding: 'utf8' });
    return o;
  };
  // FEAT-190: the old round-1 BEFORE leg (session policy applied to a protected repo) and the new
  // behaviour BOTH let the write land, so the must-FAIL contrast is gone — asserted as a plain check.
  void r1Host; // the pinned-r1 host is no longer the contrast (kept imported for the P1 pin)
  hostSession = 'pa';
  hostProjects = [projOf('pa', dA, scopedPushPol), projOf('pb', dB, n(null)), projOf('pm', dM, n(null))];
  const xa = await cross();
  check('X1 FEAT-190: a scoped+push session in A commits AND pushes into a registered-but-UNGRANTED project B (cross-repo allowed; an ungranted destination does NOT veto)',
    xa.bCommitted && xa.bRemoteMoved && xa.commit === 0 && xa.push === 0, `now: ${JSON.stringify(xa)}`);
  retired('X1b the refusal names B and says the TARGET repo decides', {
    supersededBy: 'FEAT-190 (2026-10-14): cross-repo is ALLOWED by default and the SESSION governs (key=session), not the "target decides" model — there is no such refusal for a push into a registered-ungranted B.',
    coveredBy: 'verify-feat-190-matrix.mjs F1 (the session governs; key=sessionProjectId) + verify-feat-190.mjs D3 (cross-repo commit/push allowed under the session grant)',
  });
  // methodology-style: the session works in another registered repo; THAT repo's policy decides.
  const intoM = async () => {
    const h = head(M.dir); decided.length = 0;
    const c = await sgit(A.dir, '-C', M.dir, 'commit', '--allow-empty', '-qm', 'edit methodology');
    const o = { code: c.code, committed: head(M.dir) !== h, key: decided.at(-1)?._key ?? null };
    gitf(M.dir, 'reset', '-q', '--hard', h);
    return o;
  };
  hostProjects = [projOf('pa', dA, relPol), projOf('pb', dB, n(null)), projOf('pm', dM, scopedPushPol)];
  const m1 = await intoM();
  hostProjects = [projOf('pa', dA, scopedPushPol), projOf('pb', dB, n(null)), projOf('pm', dM, n(null))];
  const m2 = await intoM();
  hostProjects = [projOf('pa', dA, n(null)), projOf('pb', dB, n(null)), projOf('pm', dM, scopedPushPol)];
  const m3 = await intoM();
  hostProjects = [projOf('pa', dA, scopedPushPol), projOf('pb', dB, n(null)), projOf('pm', dM, relPol)];
  const m4 = await intoM();
  // FEAT-190: M is a scratch fixture, so a commit into it is STORE-governed (allowed under any
  // commit grant), and the claim key is ALWAYS the SESSION project, never the target. The SESSION's
  // grant governs: an ungranted session is refused (its store has no grant); a per-repo opt-out /
  // release mode on ANOTHER owner of M still vetoes even a scratch commit (r13/r14 chokepoint).
  check('X2 FEAT-190: a RELEASE-mode session commits into a scratch fixture (store-governed); the claim is on the SESSION (key=pa), not the target', m1.code === 0 && m1.committed && m1.key === 'pa', JSON.stringify(m1));
  check('X3 FEAT-190: a SCOPED session commits into a scratch fixture whose other owner is ungranted (store-governed → allowed; no veto)', m2.code === 0 && m2.committed && m2.key === 'pa', JSON.stringify(m2));
  check('X4 FEAT-190: an UNGRANTED session cannot commit even cross-repo — the SESSION governs and its store has no grant (deferred to the FEAT-108 store, which refuses)', m3.code !== 0 && !m3.committed, JSON.stringify(m3));
  check('X5 a SCOPED session cannot commit into a repo another owner RELEASE-manages (the release-mode owner\'s per-repo veto binds even for a scratch fixture)', m4.code !== 0 && !m4.committed, JSON.stringify(m4));
  // FEAT-190 exfiltration guard (local): a push INTO a destination whose owner EXPLICITLY opted out
  // (here: release mode on pb) is still REFUSED — the destination veto survives the reversal.
  const aTop7 = fs.realpathSync(A.dir); const aCommon7 = P.gitCommonDirOf(aTop7);
  const dpVeto = P.decidePush({ source: { commonDir: aCommon7, cwd: aTop7, toplevel: aTop7 }, url: B.remote, projects: [projOf('pa', dA, scopedPushPol), projOf('pb', dB, relPol), projOf('pm', dM, n(null))], sessionProjectId: 'pa' });
  check('X7 exfiltration guard: a push INTO a destination whose owner EXPLICITLY release-manages it is still REFUSED (FEAT-190 destination veto survives)', !!dpVeto.refusal && /destination/i.test(dpVeto.refusal), (dpVeto.refusal || 'ALLOWED').split('\n')[0]);
  // a clone of B (unregistered, scratch) pushing to B's origin: B is registered-but-UNGRANTED, which
  // does NOT veto under FEAT-190 — the push is ALLOWED (grant=allowed, cross-repo).
  hostProjects = [projOf('pa', dA, scopedPushPol), projOf('pb', dB, n(null)), projOf('pm', dM, n(null))];
  const cB = path.join(mkdtempScratch('feat164-cloneB-'), 'c'); dirs.push(path.dirname(cB));
  await sgit(path.dirname(cB), 'clone', '-q', B.remote, cB);
  gitf(cB, 'config', 'user.email', 'a@b.invalid'); gitf(cB, 'config', 'user.name', 'a');
  const cc = await sgit(cB, 'commit', '--allow-empty', '-qm', 'in clone of B');
  const rB0 = gitf(B.remote, 'rev-parse', 'main');
  const cp = await sgit(cB, 'push', '-q', 'origin', 'HEAD:main');
  const x6ok = cc.code === 0 && cp.code === 0 && gitf(B.remote, 'rev-parse', 'main') !== rB0;
  spawnSync('git', ['-C', B.remote, 'update-ref', 'refs/heads/main', rB0], { encoding: 'utf8' }); // restore B.remote main for later W/AL cases
  check('X6 FEAT-190: an unregistered clone of B commits locally AND pushes to B\'s origin — a registered-but-UNGRANTED destination does NOT veto (cross-repo push allowed)', x6ok, `clone commit ${cc.code}; push ${cp.code} (B.remote moved: ${x6ok}): ${cp.out.split('\n')[0]}`);
  /* ── U unregistered repos (coordinator correction): fixture under a scratch root → session grant;
   *     any other unregistered repo (a real checkout that is not a project) → UNGRANTED. */
  console.log('\n── U unregistered repos: a fixture under scratch vs a methodology-like real checkout');
  // A real checkout that is NOT a registered project, under HOME but outside scratch/tmp.
  // In the confined runner HOME itself sits inside /work (a fixture root there) and / is
  // read-only, so these cases inject the production roots MINUS the confined /work tree; U0b
  // asserts the production default list itself.
  const realRoot = fs.mkdtempSync(path.join(os.homedir(), 'f164-realrepo-')); dirs.push(realRoot);
  const uRoots = P.defaultFixtureRoots().filter((r) => r !== '/work');
  const U = path.join(realRoot, 'methodology');
  fs.mkdirSync(U); gitf(U, 'init', '-q', '-b', 'main'); gitf(U, 'config', 'user.email', 'u@b.invalid'); gitf(U, 'config', 'user.name', 'u');
  w(U, 'README.md', 'methodology\n'); gitf(U, 'add', '-A'); gitf(U, 'commit', '-qm', 'base');
  const Ubare = path.join(realRoot, 'methodology-origin.git');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', Ubare]); gitf(U, 'remote', 'add', 'origin', Ubare); gitf(U, 'push', '-q', 'origin', 'main');
  const roots = uRoots; const realU = fs.realpathSync(U);
  check('U0 precondition: the methodology-like repo lies outside every fixture root; scratch fixtures inside one', !roots.some((r) => realU === r || realU.startsWith(r + path.sep)) && roots.some((r) => fs.realpathSync(other.dir).startsWith(r + path.sep)), JSON.stringify({ roots, realU }));
  const dflt = P.defaultFixtureRoots();
  const rp = (x) => { try { return fs.realpathSync(x); } catch { return path.resolve(x); } };
  check('U0b the production fixture roots are exactly scratch, system tmp and the confined /work (FEAT-170 lane-repo root removed 2026-10-13)', (() => { const want = new Set([rp(mkdtempScratch('feat164-rootprobe-').replace(/\/[^/]+$/, '')), rp(os.tmpdir()), '/work']); return dflt.length === new Set(dflt).size && dflt.length === want.size && dflt.every((r) => want.has(r)); })() && !dflt.some((r) => /claude-station[\\/]shadow$/.test(r)), JSON.stringify(dflt));
  const P2 = await (async () => {
    let src = fs.readFileSync(path.join(HERE, 'fixtures/feat-164/agent-git-policy-r2.mjs'), 'utf8');
    src = src.replace(/from '\.\/([^']+)'/g, (_m, f) => `from '${pinnedDep(f)}'`);
    const d = mkdtempScratch('feat164-p2-'); dirs.push(d);
    fs.writeFileSync(path.join(d, 'policy-r2.mjs'), src);
    return import(pathToFileURL(path.join(d, 'policy-r2.mjs')).href);
  })();
  const intoU = async () => {
    const h = head(U); const r0 = gitf(Ubare, 'rev-parse', 'main');
    const c = await sgit(A.dir, '-C', U, 'commit', '--allow-empty', '-qm', 'autonomous commit into an unregistered real repo');
    const p = await sgit(U, 'push', '-q', 'origin', 'HEAD:main');
    const o = { commit: c.code, committed: head(U) !== h, push: p.code, pushed: gitf(Ubare, 'rev-parse', 'main') !== r0, msg: c.out.split('\n')[0] };
    gitf(U, 'reset', '-q', '--hard', h); spawnSync('git', ['-C', Ubare, 'update-ref', 'refs/heads/main', r0], { encoding: 'utf8' });
    return o;
  };
  const intoFixture = async () => {
    const h = head(other.dir); const r0 = gitf(other.remote, 'rev-parse', 'main');
    const c = await sgit(A.dir, '-C', other.dir, 'commit', '--allow-empty', '-qm', 'fixture commit');
    const p = await sgit(other.dir, 'push', '-q', 'origin', 'HEAD:main');
    const o = { commit: c.code, committed: head(other.dir) !== h, push: p.code, pushed: gitf(other.remote, 'rev-parse', 'main') !== r0 };
    gitf(other.dir, 'reset', '-q', '--hard', h); spawnSync('git', ['-C', other.remote, 'update-ref', 'refs/heads/main', r0], { encoding: 'utf8' });
    return o;
  };
  hostSession = 'pa'; hostProjects = [projOf('pa', dA, scopedPushPol), projOf('pb', dB, n(null)), projOf('pm', dM, n(null))];
  // BEFORE: the round-2 bytes (an unregistered repo inherited the session's grant)
  r1 = (b) => { const d = P2.decideByTarget({ argv: b.argv || [], target: b.target ?? null, sessionProjectId: 'pa', projects: hostProjects }); return d.refusal ? { allow: false, reason: d.refusal } : { allow: true }; };
  hostFixtureRoots = uRoots;
  const ub = await intoU(); const fb = await intoFixture();
  r1 = null;
  const ua = await intoU(); const fa = await intoFixture();
  void ub; // the round-2 BEFORE leg no longer contrasts (FEAT-190 allows cross-repo both ways)
  check('U1 FEAT-190: a scoped session commits AND pushes into an UNREGISTERED real repo (cross-repo is allowed by default; the session grant covers the other real repos it works in)',
    ua.committed && ua.pushed && ua.commit === 0 && ua.push === 0, `now: ${JSON.stringify(ua)}`);
  retired('U1b the refusal says the repo is unregistered and outside the fixture roots', {
    supersededBy: 'FEAT-190 (2026-10-14): a granted session commits/pushes into an unregistered real repo by default — there is no "unregistered + outside fixture roots" refusal.',
    coveredBy: 'verify-feat-190.mjs D3 line ~120 ("cross-repo COMMIT in unregistered Q is allowed under P\'s grant") + the matching push case',
  });
  check('U2 a fixture repo under the scratch root still commits and pushes to its fixture remote under the session grant (before and after)', fb.committed && fb.pushed && fa.committed && fa.pushed, `before ${JSON.stringify(fb)} / now ${JSON.stringify(fa)}`);
  const nu = P.decideByTarget({ argv: ['commit'], target: { cwd: null, commonDir: null }, sessionProjectId: 'pa', projects: hostProjects, fixtureRoots: uRoots });
  check('U3 a target that resolves to NEITHER a cwd nor a commonDir is refused (fail closed) — the surviving FEAT-190 safety property', !!nu.refusal, (nu.refusal || '').slice(0, 90));
  /* ── W push destinations through git's URL rewrites (verify 01a12c67): resolved BY GIT */
  console.log('\n── W push destination rewrites: insteadOf / pushInsteadOf / an included config');
  const SG2 = await (async () => {
    const d = mkdtempScratch('feat164-sg2-'); dirs.push(d);
    fs.copyFileSync(path.join(HERE, 'fixtures/feat-164/shadow-guard-r2.mjs'), path.join(d, 'sg-r2.mjs'));
    return import(pathToFileURL(path.join(d, 'sg-r2.mjs')).href);
  })();
  const oldResolver = (b) => SG2.resolveWriteTarget(b.argv || [], process.env, { realGit, cwd: b.target?.cwd ?? process.cwd() });
  const alias = path.join(path.dirname(fs.realpathSync(other.dir)), `f164-alias-${process.pid}`); // nonexistent, INSIDE the scratch fixture root
  const Breal = fs.realpathSync(B.remote);
  const incCfg = path.join(mkdtempScratch('feat164-inc-'), 'rewrite.cfg'); dirs.push(path.dirname(incCfg));
  fs.writeFileSync(incCfg, `[url "${Breal}"]\n\tinsteadOf = ${alias}\n`);
  const wCase = async (label, args, setup = null, teardown = null) => {
    const res = {};
    for (const leg of ['BEFORE', 'AFTER']) {
      targetOverride = leg === 'BEFORE' ? oldResolver : null;
      if (setup) setup();
      const r0 = gitf(B.remote, 'rev-parse', 'main');
      const ref = `refs/heads/w-${label}-${leg}`;
      const pr = await sgit(other.dir, ...args(ref));
      const landed = gitq(B.remote, 'rev-parse', '--verify', '--quiet', ref).code === 0;
      spawnSync('git', ['-C', B.remote, 'update-ref', '-d', ref], { encoding: 'utf8' });
      if (teardown) teardown();
      res[leg] = { exit: pr.code, landedInB: landed, mainMoved: gitf(B.remote, 'rev-parse', 'main') !== r0, msg: pr.out.split('\n')[0] };
    }
    targetOverride = null;
    return res;
  };
  // FEAT-190: B is a registered-but-UNGRANTED destination, which does NOT veto — a push git resolves
  // to B's remote is ALLOWED. The W cases that git CAN resolve (insteadOf, get-url, included config)
  // now land; the one git has NO read-only resolver for (pushInsteadOf on a URL argument) is still
  // refused fail-closed. The exact refusal MESSAGE is no longer load-bearing (header rule).
  const w1 = await wCase('insteadof', (ref) => ['-c', `url.${Breal}.insteadOf=${alias}`, 'push', '-q', alias, `HEAD:${ref}`]);
  check('W1 FEAT-190: an insteadOf path alias rewritten to a registered-but-UNGRANTED B pushes into B (allowed — an ungranted destination does not veto)',
    w1.AFTER.landedInB && w1.AFTER.exit === 0, JSON.stringify(w1.AFTER));
  const w2 = await wCase('pushinsteadof', (ref) => ['-c', `url.${Breal}.pushInsteadOf=${alias}`, 'push', '-q', alias, `HEAD:${ref}`]);
  check('W2 a pushInsteadOf alias on a URL argument has no read-only resolver → refused fail-closed, never pushed into B (FEAT-190 safety; message relaxed)',
    !w2.AFTER.landedInB && w2.AFTER.exit !== 0, JSON.stringify(w2.AFTER));
  const w2n = await wCase('pushinsteadof-named', (ref) => ['push', '-q', 'aliasr', `HEAD:${ref}`],
    () => { gitf(other.dir, 'remote', 'add', 'aliasr', alias); gitf(other.dir, 'config', `url.${Breal}.pushInsteadOf`, alias); },
    () => { gitf(other.dir, 'remote', 'remove', 'aliasr'); spawnSync('git', ['-C', other.dir, 'config', '--unset', `url.${Breal}.pushInsteadOf`]); });
  check('W2b FEAT-190: a configured remote whose push URL pushInsteadOf rewrites to a registered-ungranted B is resolved by git (get-url) and pushes into B (allowed)',
    w2n.AFTER.landedInB && w2n.AFTER.exit === 0, JSON.stringify(w2n.AFTER));
  const w3 = await wCase('include', (ref) => ['push', '-q', alias, `HEAD:${ref}`],
    () => gitf(other.dir, 'config', 'include.path', incCfg),
    () => spawnSync('git', ['-C', other.dir, 'config', '--unset', 'include.path']));
  check('W3 FEAT-190: an insteadOf from an INCLUDED config file rewritten to a registered-ungranted B pushes into B (allowed)',
    w3.AFTER.landedInB && w3.AFTER.exit === 0, JSON.stringify(w3.AFTER));
  const w4 = await sgit(other.dir, 'push', '-q', 'origin', 'HEAD:refs/heads/w4');
  check('W4 control: an ordinary fixture push (named remote, no rewrite) still works', w4.code === 0 && gitq(other.remote, 'rev-parse', '--verify', '--quiet', 'refs/heads/w4').code === 0, `exit ${w4.code} ${w4.out.split('\n')[0]}`);
  /* ── AL aliases (verify 73256821): expanded by git's own config before anything is classified */
  console.log('\n── AL aliases: -c alias, gitconfig alias, nested alias, shell (!) alias, unresolvable alias');
  const loadPinned = async (file, as) => {
    let src = fs.readFileSync(path.join(HERE, 'fixtures/feat-164', file), 'utf8');
    src = src.replace(/from '\.\/([^']+)'/g, (_m, f) => `from '${pinnedDep(f)}'`);
    const d = mkdtempScratch('feat164-pin-'); dirs.push(d);
    fs.writeFileSync(path.join(d, as), src);
    return import(pathToFileURL(path.join(d, as)).href);
  };
  const SG3 = await loadPinned('shadow-guard-r3.mjs', 'sg-r3.mjs');
  const P3 = await loadPinned('agent-git-policy-r3.mjs', 'pol-r3.mjs');
  const aCase = async (label, args, setup = null, teardown = null) => {
    const res = {};
    for (const leg of ['BEFORE', 'AFTER']) {
      targetOverride = leg === 'BEFORE' ? (b) => SG3.resolveWriteTarget(b.argv || [], process.env, { realGit, cwd: b.target?.cwd ?? process.cwd() }) : null;
      decideOverride = leg === 'BEFORE' ? P3.decideByTarget : null;
      if (setup) setup();
      decided.length = 0;
      const ref = `refs/heads/al-${label}-${leg}`;
      const pr = await sgit(other.dir, ...args(ref));
      const landed = gitq(B.remote, 'rev-parse', '--verify', '--quiet', ref).code === 0;
      spawnSync('git', ['-C', B.remote, 'update-ref', '-d', ref], { encoding: 'utf8' });
      if (teardown) teardown();
      res[leg] = { exit: pr.code, landedInB: landed, hostAllowedOuter: decided[0]?._allow ?? null, msg: pr.out.split('\n').find((l) => l.startsWith('orchard:')) ?? pr.out.split('\n')[0] };
    }
    targetOverride = null; decideOverride = null;
    return res;
  };
  // FEAT-190: git expands a HARMLESS alias (`-c`, ~/.gitconfig, nested) to a push, which then
  // resolves to B's remote; B is registered-but-UNGRANTED, which does NOT veto → the push LANDS
  // (allowed). A DANGEROUS alias (shell `!`, unresolvable, loop) is still REFUSED fail-closed before
  // it can run — the SAFETY property (did not land / exit != 0) is what holds; the exact refusal
  // MESSAGE is no longer load-bearing (it may now come from the git-shim "invocation layer").
  const landedA = (r) => r.landedInB && r.exit === 0 && r.hostAllowedOuter === true;   // allowed, landed
  const refusedA = (r) => !r.landedInB && r.exit !== 0 && r.hostAllowedOuter === false; // fail-closed, safe
  const Bp = fs.realpathSync(B.remote);
  const al_a1 = await aCase('c', (ref) => ['-c', 'alias.p=push', 'p', '-q', Bp, `HEAD:${ref}`]);
  check('AL1 FEAT-190: a `-c alias.p=push` push git expands and resolves to a registered-ungranted B LANDS (allowed)', landedA(al_a1.AFTER), JSON.stringify(al_a1.AFTER));
  const al_a2 = await aCase('gitconfig', (ref) => ['pu', '-q', Bp, `HEAD:${ref}`],
    () => gitf(other.dir, 'config', '--global', 'alias.pu', 'push'),
    () => spawnSync('git', ['config', '--global', '--unset', 'alias.pu']));
  check('AL2 FEAT-190: a ~/.gitconfig alias `pu = push` to a registered-ungranted B LANDS (allowed)', landedA(al_a2.AFTER), JSON.stringify(al_a2.AFTER));
  const al_a3 = await aCase('nested', (ref) => ['-c', 'alias.a=b', '-c', 'alias.b=c -q', '-c', 'alias.c=push', 'a', Bp, `HEAD:${ref}`]);
  check('AL3 FEAT-190: a NESTED alias a → b → c → push to a registered-ungranted B LANDS (allowed)', landedA(al_a3.AFTER), JSON.stringify(al_a3.AFTER));
  const al_a4 = await aCase('shell', (ref) => ['-c', `alias.s=!git push -q ${Bp} HEAD:${ref}`, 's']);
  check('AL4 a shell (!) alias is refused before it runs (it could push anywhere) — SAFETY: did not land, exit != 0 (message relaxed, FEAT-190)', refusedA(al_a4.AFTER), JSON.stringify(al_a4.AFTER));
  const al_a5 = await aCase('unresolvable', (ref) => ['-c', 'alias.u=push "unclosed', 'u', Bp, `HEAD:${ref}`]);
  check('AL5 an UNRESOLVABLE alias (unbalanced quote) is refused — SAFETY: did not land, exit != 0 (message relaxed, FEAT-190)', refusedA(al_a5.AFTER), JSON.stringify(al_a5.AFTER));
  const al_a6 = await aCase('loop', (ref) => ['-c', 'alias.x=y', '-c', 'alias.y=x', 'x', Bp, `HEAD:${ref}`]);
  check('AL6 an alias LOOP is unresolvable → refused — SAFETY: did not land, exit != 0 (message relaxed, FEAT-190)', refusedA(al_a6.AFTER), JSON.stringify(al_a6.AFTER));
  const al_a7 = await sgit(other.dir, '-c', 'alias.ci=commit', 'ci', '--allow-empty', '-qm', 'alias commit in a fixture');
  check('AL7 control: an alias to a harmless write in a fixture repo still works (expanded, then allowed)', al_a7.code === 0, `exit ${al_a7.code} ${al_a7.out.split('\n')[0]}`);
  hostProjects = null; hostSession = 'fx'; hostFixtureRoots = undefined;

  /* ── K containers (verify adb2b039 P4): the read-only .git overlay follows the new grant model */
  console.log('\n── K containers: gitGuardOn keys on the grant model (scoped → rw)');
  let cm = null; let cmErr = null;
  try { cm = await import(pathToFileURL(path.resolve(HERE, '..', 'src', 'server', 'container-manager.ts')).href); } catch (e) { cmErr = e.message; }
  const guard = (gw) => cm.gitGuardOn({ id: `c-${Math.random()}`, settings: gw === undefined ? {} : { gitWrite: gw } });
  if (!cm) check('K0 container-manager imports', false, cmErr);
  else {
    const savedScoped = { commit: true, push: true, scope: 'commit to main', grantedAt: 'g', grantedVia: 'dashboard' };
    const savedMigrated = { commit: true, push: true, scope: P.MIGRATED_SCOPE_NOTE, grantedAt: 'g', grantedVia: 'dashboard' };
    const oldShape = (gw) => !(gw && gw.permanent === true); // the round-1 check: keyed on `permanent`
    beforeAfter('K1 a SAVED scoped grant (and a saved migrated one) gets a writable .git in its container [must-FAIL on round 1]',
      !oldShape(savedScoped) && !oldShape(savedMigrated), guard(savedScoped) === false && guard(savedMigrated) === false,
      `round-1 check (permanent===true): guard on for scoped=${oldShape(savedScoped)}, migrated=${oldShape(savedMigrated)}`,
      `now: guard on for scoped=${guard(savedScoped)}, migrated=${guard(savedMigrated)}`);
    // FEAT-190: a blank-scope grant is SCOPED (rw), not release. Release mode is the EXPLICIT opt-in
    // (`release.opt_in:true`) → read-only container. Legacy unsaved grant → scoped (rw); no grant → ro.
    check('K2 an unsaved legacy grant → rw (scoped); an EXPLICIT release opt-in and no grant → read-only; a blank-scope grant is now rw', guard({ permanent: true }) === false && guard({ commit: true, release: { opt_in: true } }) === true && guard({ commit: true, scope: null }) === false && guard(undefined) === true && guard({ commit: false, scope: 'x' }) === true,
      JSON.stringify({ legacy: guard({ permanent: true }), releaseOptIn: guard({ commit: true, release: { opt_in: true } }), blankScope: guard({ commit: true, scope: null }), none: guard(undefined) }));
  }

  /* ── M the MIGRATION (coordinator 2026-10-11): an existing permanent grant keeps direct commits + pushes */
  console.log('\n── M migration: an EXISTING {permanent:true} grant keeps its direct-commit behaviour after the upgrade');
  // Baseline = this module's normaliser with the migration reverted to the pre-migration lines
  // (legacy → blank note, push off = release mode), synthesized from the exact prior text.
  const Pold = await mutant('lib/agent-git-policy.mjs', [
    ['  const scope = legacy ? MIGRATED_SCOPE_NOTE\n    : typeof raw.scope', '  const scope = false ? MIGRATED_SCOPE_NOTE\n    : typeof raw.scope'],
    ['    push: commit && (legacy || raw.push === true),', '    push: commit && !legacy && raw.push === true,'],
  ]);
  const legacyRaw = { permanent: true, grantedAt: '2026-10-07T23:24:05.330Z', grantedVia: 'dashboard' };
  const migRun = async (policy) => {
    guardOn = true; hostPolicy = policy;
    const h0 = head(g.dir); const r0 = gitf(g.remote, 'rev-parse', 'main');
    const c = await sgit(g.dir, 'commit', '--allow-empty', '-qm', 'agent direct commit');
    const p = await sgit(g.dir, 'push', '-q', 'origin', 'HEAD:main');
    const out = { commit: c.code, committed: head(g.dir) !== h0, push: p.code, pushed: gitf(g.remote, 'rev-parse', 'main') === head(g.dir) && head(g.dir) !== r0, msg: (c.out || p.out).split('\n')[0] };
    gitf(g.dir, 'reset', '-q', '--hard', h0);
    spawnSync('git', ['-C', g.remote, 'update-ref', 'refs/heads/main', r0], { encoding: 'utf8' });
    return out;
  };
  const migB = await migRun(Pold.normalizeGitWrite(legacyRaw));
  const ma = await migRun(n(legacyRaw));
  beforeAfter('M1 an existing permanent grant still commits AND pushes directly after the upgrade (through the real shim)',
    migB.committed && migB.pushed, ma.committed && ma.pushed && ma.commit === 0 && ma.push === 0,
    `pre-migration normaliser (legacy → release mode): ${JSON.stringify(migB)}`, `migrated: ${JSON.stringify(ma)}`);
  const mNew = await migRun(n({ commit: true, scope: '' }));
  check('M2 FEAT-190: a NEW grant with a genuinely blank note is SCOPED — it commits directly; push stays off because push was not granted (no longer release mode)', mNew.committed && !mNew.pushed, JSON.stringify(mNew));
  const saved = n({ commit: true, push: true, scope: leg.scope }); // what Save writes back from the UI draft
  check('M3 saving the migrated note unchanged keeps the same behaviour (scoped, push)', saved.mode === 'scoped' && saved.push === true && !saved.legacy, JSON.stringify({ mode: saved.mode, push: saved.push }));
  host.close();

  /* ─────────────────────────────── S3/S4/S5 P1, P2, P3 */
  console.log('\n── P2/P3 one release commit for N verified tickets; unverified excluded');
  const fx = fixture('batch');
  verified(fx.dir, 'BUG-301', 'src/a.mjs', 'export const a = 1;\n');
  verified(fx.dir, 'BUG-302', 'src/b.mjs', 'export const b = 2;\n');
  verified(fx.dir, 'FEAT-303', 'src/c.mjs', 'export const c = 3;\n');
  freeze(fx.dir, 'BUG-304', 'src/d.mjs', 'export const d = "UNVERIFIED";\n');
  ticketFile(fx.dir, 'BUG-304', []);
  const h305 = freeze(fx.dir, 'BUG-305', 'src/e.mjs', 'export const e = "LATER-BROKEN";\n');
  ticketFile(fx.dir, 'BUG-305', [verdict('run-305', 'holds', h305), verdict('run-305b', 'broken', h305)]);
  verified(fx.dir, 'BUG-306', 'src/f.mjs', 'export const f = "FROZEN";\n');
  w(fx.dir, 'src/f.mjs', 'export const f = "EDITED-AFTER-FREEZE";\n');
  const copy = copyRepo(fx, 'p2'); // the same state, for the baselines
  const copy3 = copyRepo(fx, 'p3');

  // P1 — ungranted project: no commit, by any trigger an agent or the station can use.
  console.log('\n── P1 an ungranted project gets no commit');
  const ungr = copyRepo(fx, 'p1');
  const dNone = registry([['fx', ungr.dir, undefined]]);
  const h1 = head(ungr.dir);
  const a1 = cli(['auto', 'fx', '--json'], dNone);
  const a2 = cli(['cut', 'fx', '--as-agent', '--json'], dNone);
  let libRefused = null;
  try { await R.cutRelease({ repo: ungr.dir, policy: n(null), trigger: 'agent', clock: () => T0 + 200 * H }); } catch (e) { libRefused = e.code; }
  const p1After = head(ungr.dir) === h1 && a1.json?.released === false && a2.json?.error === 'not-granted' && libRefused === 'not-granted';
  const Mgrant = await mutant('lib/release.mjs', [["  if (trigger !== 'user' && pol.mode === 'none') fail('not-granted',", "  if (false) fail('not-granted',"]]);
  const ungrB = copyRepo(fx, 'p1b');
  const hB = head(ungrB.dir);
  let mb = null; try { mb = await Mgrant.cutRelease({ repo: ungrB.dir, policy: n(null), trigger: 'agent', clock: () => T0 + 200 * H }); } catch (e) { mb = { error: e.code }; }
  beforeAfter('P1 an ungranted project gets no commit', head(ungrB.dir) === hB && !mb?.released, p1After,
    `mutant (grant check removed): released=${mb?.released} ${mb?.version ?? mb?.error ?? ''}`,
    `auto → ${a1.json?.reason}; cut --as-agent → ${a2.json?.error}; lib agent → ${libRefused}; HEAD unchanged: ${head(ungr.dir) === h1}`);

  // P2 — granted, undetermined scope: ONE release commit for the 3 verified tickets.
  // FEAT-190: release (soft-release) mode is an EXPLICIT opt-in now — `release.opt_in:true` (a blank
  // scope alone is SCOPED). The soft-release machinery (cadence, batched commit, tag) is exercised by
  // opting in, exactly as a user would to get soft releases.
  const dRel = registry([['fx', fx.dir, { commit: true, push: false, scope: null, release: { opt_in: true, minTickets: 3 }, grantedAt: 'g1' }]]);
  const plan = await R.planRelease({ repo: fx.dir, policy: n({ commit: true, release: { minTickets: 3 } }), now: T0 + H });
  check('P2.0 plan: exactly the 3 verified tickets are eligible and the release is DUE', JSON.stringify(plan.tickets.sort()) === JSON.stringify(['BUG-301', 'BUG-302', 'FEAT-303']) && plan.cadence.due, `${plan.tickets.join(',')} due=${plan.cadence.due} (${plan.cadence.why})`);
  const before = head(fx.dir); const remote0 = gitf(fx.remote, 'rev-parse', 'main');
  const cut = cli(['auto', 'fx', '--json'], dRel);
  const added = Number(gitf(fx.dir, 'rev-list', '--count', `${before}..HEAD`));
  const msg = gitf(fx.dir, 'log', '-1', '--format=%B');
  const tagType = gitq(fx.dir, 'cat-file', '-t', 'v0.1.0').out;
  const tagTarget = gitq(fx.dir, 'rev-parse', 'v0.1.0^{commit}').out;
  const show = (f) => gitq(fx.dir, 'show', `HEAD:${f}`).out;
  // Baseline: today's publisher, one `candidate commit` per ticket (integrate when HEAD moved).
  const b0 = head(copy.dir); const steps = [];
  for (const T of ['BUG-301', 'BUG-302', 'FEAT-303']) {
    if (head(copy.dir) !== b0) steps.push(`integrate ${T}:${candCli(['integrate', T], copy.dir).code}`);
    steps.push(`commit ${T}:${candCli(['commit', T], copy.dir).code}`);
  }
  const baseAdded = Number(gitf(copy.dir, 'rev-list', '--count', `${b0}..HEAD`));
  beforeAfter('P2 granted + undetermined scope: N=3 verified tickets → ONE commit, not N', baseAdded === 1, added === 1 && cut.json?.released === true,
    `today's per-ticket candidate commit: ${baseAdded} commits (${steps.join(', ')})`,
    `release.mjs auto: released=${cut.json?.released} ${cut.json?.version}; ${added} commit(s) added`);
  check('P2.1 the release carries an annotated version tag v0.1.0 on that commit', tagType === 'tag' && tagTarget === head(fx.dir), `${tagType} → ${tagTarget.slice(0, 12)}`);
  check('P2.2 changelog message: subject, one line per ticket with title + run + candidate, release + candidate trailers',
    /^Release v0\.1\.0: 3 tickets/.test(msg) && /- BUG-301 BUG-301 fixture title \(verified run run-BUG-301, candidate [0-9a-f]{12}\)/.test(msg) && /Orchard-Release: v0\.1\.0/.test(msg) && (msg.match(/^Orchard-Candidate: [0-9a-f]{64}$/gm) || []).length === 3,
    msg.split('\n').slice(0, 5).join(' | '));
  check('P2.3 the commit tree = HEAD + exactly the frozen bytes (3 files)', show('src/a.mjs').includes('a = 1') && show('src/b.mjs').includes('b = 2') && show('src/c.mjs').includes('c = 3') && gitf(fx.dir, 'diff', '--name-only', `${before}..HEAD`).split('\n').length === 3, gitf(fx.dir, 'diff', '--name-only', `${before}..HEAD`).replace(/\n/g, ','));
  check('P2.4 the repo\'s pre-commit hook (leak gate) ran on exactly the release\'s staged files', fs.readFileSync(path.join(fx.dir, '.git', 'hook-saw.txt'), 'utf8').trim().split('\n').sort().join(',') === 'src/a.mjs,src/b.mjs,src/c.mjs', fs.readFileSync(path.join(fx.dir, '.git', 'hook-saw.txt'), 'utf8').trim().replace(/\n/g, ','));
  check('P2.5 FEAT-170 sees the 3 candidates as committed (trailers + store state)', ['BUG-301', 'BUG-302', 'FEAT-303'].every((T) => CS.readTicketState(CS.repoInfo(fx.dir).store, T).state === 'committed'));
  check('P2.6 push NOT granted → the remote is untouched by the release', gitf(fx.remote, 'rev-parse', 'main') === remote0 && !gitq(fx.remote, 'rev-parse', '--verify', '--quiet', 'refs/tags/v0.1.0').out, `remote main ${gitf(fx.remote, 'rev-parse', 'main').slice(0, 12)} (was ${remote0.slice(0, 12)}); pushed: ${JSON.stringify(cut.json?.pushed)}`);

  // P3 — unverified / later-BROKEN / edited-after-freeze are excluded.
  const inRelease = (s) => msg.includes(s) || ['src/d.mjs', 'src/e.mjs', 'src/f.mjs'].some((f) => show(f).includes(s));
  const excl = Object.fromEntries((plan.excluded || []).map((x) => [x.ticket, x.reasons[0]]));
  const Mverdict = await mutant('lib/release.mjs', [['      if (!s.ok) reasons.push(s.reason);', '      if (false) reasons.push(s.reason);']]);
  const mplan = await Mverdict.planRelease({ repo: copy3.dir, policy: n({ commit: true, release: { minTickets: 3 } }), now: T0 + H });
  beforeAfter('P3 an unverified ticket (no verdict, or a later BROKEN) is excluded from the release',
    !(mplan.tickets.includes('BUG-304') || mplan.tickets.includes('BUG-305')),
    !inRelease('UNVERIFIED') && !inRelease('LATER-BROKEN') && !inRelease('FROZEN') && !msg.includes('BUG-304') && !msg.includes('BUG-305') && !msg.includes('BUG-306'),
    `mutant (verdict check removed) would ship: ${mplan.tickets.join(',')}`,
    `excluded: ${Object.entries(excl).map(([k, r]) => `${k}: ${r.slice(0, 60)}`).join(' | ')}`);
  check('P3.1 the plan names WHY each is excluded', /no verdict bound/.test(excl['BUG-304'] || '') && /BROKEN/.test(excl['BUG-305'] || '') && /CHANGED/.test(excl['BUG-306'] || ''), JSON.stringify(excl).slice(0, 300));

  /* ─────────────────────────────── P4 push only when granted, only at a release */
  console.log('\n── P4 push: only when granted, only at a release');
  const pu = fixture('push');
  verified(pu.dir, 'BUG-401', 'src/a.mjs', 'export const a = 41;\n');
  const dPush = registry([['pu', pu.dir, { commit: true, push: true, scope: null, release: { opt_in: true, minTickets: 2 }, grantedAt: 'g1' }]]);
  const r0 = gitf(pu.remote, 'rev-parse', 'main');
  const notDue = cli(['auto', 'pu', '--json'], dPush);
  check('P4.1 not due (1 < 2 tickets) → nothing committed, nothing pushed', notDue.json?.released === false && gitf(pu.remote, 'rev-parse', 'main') === r0 && head(pu.dir) === pu.base, notDue.json?.reason);
  verified(pu.dir, 'BUG-402', 'src/b.mjs', 'export const b = 42;\n');
  const pushed = cli(['auto', 'pu', '--json'], dPush);
  const rr = gitf(pu.remote, 'rev-parse', 'main');
  check('P4.2 push granted → at the release, the remote gets exactly the release commit + its tag (atomic push)', pushed.json?.released === true && pushed.json?.pushed?.ok === true && rr === head(pu.dir) && gitq(pu.remote, 'rev-parse', 'v0.1.0^{commit}').out === rr, `pushed=${JSON.stringify(pushed.json?.pushed)} remote main=${rr.slice(0, 12)} HEAD=${head(pu.dir).slice(0, 12)}`);
  const newBlank = n({ commit: true });
  check('P4.3 FEAT-190: a NEW grant with a blank note → SCOPED mode (not release); push is off because it was not granted (push derived on read only when push:true)', newBlank.mode === 'scoped' && newBlank.push === false, JSON.stringify({ mode: newBlank.mode, push: newBlank.push }));
  // FEAT-190 r8 (RESCOPE): the frozen-remote veto is GONE — a release pushes to WHATEVER remote the
  // repo has configured now (the leak gate still runs). The old "release pushes only to a destination
  // recorded at grant" ruling (verify 619c99b4) was removed; these re-pointed/new-remote pushes are
  // ALLOWED. (Covered by verify-feat-190.mjs D3 "cross-repo PUSH to a re-pointed/new remote is ALLOWED".)
  for (const [label, mutate] of [
    ['DP1 FEAT-190: a release after `git remote set-url origin <other>` pushes to the NEW remote (no frozen-remote veto)', (dir, other) => gitf(dir, 'remote', 'set-url', 'origin', other)],
    ['DP2 FEAT-190: a release whose branch now tracks a newly ADDED upstream pushes to it (no frozen-remote veto)', (dir, other) => { gitf(dir, 'remote', 'add', 'upstream', other); gitf(dir, 'config', 'branch.main.remote', 'upstream'); }],
  ]) {
    const fx2 = fixture(`dp${label.slice(2, 3)}`);
    const other = `${fx2.dir}-elsewhere.git`; dirs.push(other); gitf(path.dirname(other), 'init', '-q', '--bare', other);
    verified(fx2.dir, 'BUG-411', 'src/a.mjs', 'export const a = 411;\n');
    verified(fx2.dir, 'BUG-412', 'src/b.mjs', 'export const b = 412;\n');
    const dD = registry([['dp', fx2.dir, { commit: true, push: true, scope: null, release: { opt_in: true, minTickets: 2 }, grantedAt: 'g1' }]]); // the user's grant (release opt-in)
    mutate(fx2.dir, other);                                                                                                       // ...then the config changes
    const before = gitq(other, 'rev-parse', '--verify', '--quiet', 'refs/heads/main').out;
    const res = cli(['auto', 'dp', '--json'], dD);
    const after = gitq(other, 'rev-parse', '--verify', '--quiet', 'refs/heads/main').out;
    const tagged = !!gitq(other, 'rev-parse', '--verify', '--quiet', 'refs/tags/v0.1.0').out;
    check(label, res.json?.released === true && res.json?.pushed?.ok === true && before !== after && after === head(fx2.dir) && tagged,
      `pushed=${JSON.stringify(res.json?.pushed)?.slice(0, 300)} other main ${before || '(none)'} -> ${after || '(none)'} tag=${tagged}`);
  }

  /* ─────────────────────────────── P5 a release whose gate fails is refused */
  console.log('\n── P5 gate failure on the exact release tree');
  const gf = fixture('gate');
  verified(gf.dir, 'BUG-501', 'src/a.mjs', 'export const a = "BREAKS_MAIN";\n'); // its own test passes; the gate does not
  const gfCopy = copyRepo(gf, 'p5');
  const pol5 = n({ commit: true, release: { opt_in: true, minTickets: 1 } });
  const g0 = head(gf.dir); const gr0 = gitf(gf.remote, 'rev-parse', 'main');
  let refused = null; try { await R.cutRelease({ repo: gf.dir, policy: pol5, trigger: 'auto', clock: () => T0 }); } catch (e) { refused = e; }
  const logRefused = R.readReleaseLog(CS.repoInfo(gf.dir)).filter((e) => e.event === 'refused');
  const Mchecks = await mutant('lib/release.mjs', [
    ['      const failed = results.filter((r) => r.exit !== 0);', '      const failed = [];'],
    ["    if (!results?.length || results.some((r) => r.exit !== 0)) fail('no-checks',", "    if (false) fail('no-checks',"], // round 2's publish-point assertion
  ]);
  let mres = null; try { mres = await Mchecks.cutRelease({ repo: gfCopy.dir, policy: pol5, trigger: 'auto', clock: () => T0 }); } catch (e) { mres = { error: e.code }; }
  const brokenShipped = mres?.released === true && gitq(gfCopy.dir, 'show', 'HEAD:src/a.mjs').out.includes('BREAKS_MAIN');
  beforeAfter('P5 a release whose gate fails on the exact tree is refused (HEAD, tags, remote unchanged)', !brokenShipped,
    refused?.code === 'checks-failed' && head(gf.dir) === g0 && tags(gf.dir).length === 0 && gitf(gf.remote, 'rev-parse', 'main') === gr0 && logRefused.length === 1,
    `mutant (checks ignored): released=${mres?.released}, broken bytes on HEAD: ${brokenShipped}`,
    `refused: ${refused?.code} — ${(refused?.detail || []).join(' ').slice(0, 160)}`);
  const again5 = await R.cutRelease({ repo: gf.dir, policy: pol5, trigger: 'auto', clock: () => T0 + H });
  check('P5.1 the auto tick does not retry the same failed tree', again5.released === false && /already failed its checks/.test(again5.reason), again5.reason);
  let u2 = null; try { await R.cutRelease({ repo: gf.dir, policy: pol5, trigger: 'user', now: true }); } catch (e) { u2 = e.code; }
  const alarm = await R.releaseAlarm({ repo: gf.dir, policy: pol5 });
  check('P5.2 two failed cuts in a row raise the alarm (one Needs-You card in the station)', u2 === 'checks-failed' && typeof alarm === 'string' && /last two release cuts failed/.test(alarm), alarm);
  // Subset retry: one bad ticket does not block the good ones (review #4).
  const sb = fixture('subset');
  verified(sb.dir, 'BUG-511', 'src/a.mjs', 'export const a = 11;\n');
  verified(sb.dir, 'BUG-512', 'src/b.mjs', 'export const b = "BREAKS_MAIN";\n');
  const sub = await R.cutRelease({ repo: sb.dir, policy: pol5, trigger: 'auto', clock: () => T0 });
  check('P5.3 a failing batch is retried without its newest ticket; the passing subset ships, the breaker does not', sub.released === true && JSON.stringify(sub.tickets) === '["BUG-511"]' && !gitq(sb.dir, 'show', 'HEAD:src/b.mjs').out.includes('BREAKS_MAIN'), `released ${sub.tickets?.join(',')}; dropped ${JSON.stringify(sub.dropped)}`);

  /* ─────────────── round 2 (verify a6b600b7): a subset retry must never publish UNCHECKED */
  console.log('\n── R2 the subset retry never publishes a batch no check covers (verify a6b600b7)');
  // The REAL round-1 bytes, pinned (nothing is committed, so there is no revision to name);
  // their `./candidate-store.mjs` etc. resolve to the current scripts/lib.
  const R1 = await (async () => {
    let src = fs.readFileSync(path.join(HERE, 'fixtures/feat-164/release-r1.mjs'), 'utf8');
    src = src.replace(/from '\.\/([^']+)'/g, (_m, f) => `from '${pinnedDep(f)}'`);
    const d = mkdtempScratch('feat164-r1-'); dirs.push(d);
    fs.writeFileSync(path.join(d, 'release-r1.mjs'), src);
    return import(pathToFileURL(path.join(d, 'release-r1.mjs')).href);
  })();
  const noGate = (name) => { const f = fixture(name); fs.rmSync(path.join(f.dir, 'package.json')); return f; };
  const polNo = n({ commit: true, release: { minTickets: 1 } });
  const scenario = async (lib, name, specs) => {
    const f = noGate(name);
    for (const [id, file, check] of specs) verified(f.dir, id, file, `export const x_${id.replace('-', '_')} = 1;\n`, { check });
    let r = null; try { r = await lib.cutRelease({ repo: f.dir, policy: polNo, trigger: 'user', now: true }); } catch (e) { r = { error: e.code }; }
    const log = R.readReleaseLog(CS.repoInfo(f.dir)).filter((e) => e.event === 'release');
    return { r, moved: head(f.dir) !== f.base, tags: tags(f.dir), unchecked: log.some((e) => !e.checks?.length) };
  };
  // B: the batch's ONLY check belongs to the newest ticket, and it fails.
  const specB = [['BUG-811', 'src/a.mjs', null], ['BUG-812', 'src/b.mjs', 'node -e "process.exit(1)"']];
  const b1 = await scenario(R1, 'r2b-before', specB); const b2 = await scenario(R, 'r2b-after', specB);
  beforeAfter('R2.1 the newest ticket carried the only check and it failed → the survivor is NOT published unchecked [must-FAIL on round 1]',
    !b1.moved && !b1.unchecked, !b2.moved && b2.tags.length === 0 && b2.r?.error === 'no-checks',
    `round 1: released=${b1.r?.released} ${b1.r?.version ?? b1.r?.error} unchecked-in-log=${b1.unchecked}`, `now: ${b2.r?.error}; HEAD moved ${b2.moved}; tags [${b2.tags}]`);
  // F: two drops remove every check-carrying ticket.
  const specF = [['BUG-841', 'src/a.mjs', null], ['BUG-842', 'src/b.mjs', null], ['BUG-843', 'src/c.mjs', 'node -e "process.exit(1)"'], ['BUG-844', 'src/d.mjs', 'node -e "process.exit(1)"']];
  const f1 = await scenario(R1, 'r2f-before', specF); const f2 = await scenario(R, 'r2f-after', specF);
  beforeAfter('R2.2 two drops leave a batch no check covers → refused, never published unchecked [must-FAIL on round 1]',
    !f1.moved && !f1.unchecked, !f2.moved && f2.tags.length === 0 && f2.r?.error === 'no-checks',
    `round 1: released=${f1.r?.released} ${JSON.stringify(f1.r?.tickets)} unchecked-in-log=${f1.unchecked}`, `now: ${f2.r?.error}; HEAD moved ${f2.moved}`);
  // Control: the same F batch WITH a project gate still ships the checked survivors.
  const fg = fixture('r2f-gate');
  for (const [id, file, check] of specF) verified(fg.dir, id, file, `export const x_${id.replace('-', '_')} = 1;\n`, { check });
  const fgr = await R.cutRelease({ repo: fg.dir, policy: polNo, trigger: 'user', now: true });
  check('R2.3 control: with a project gate the survivors ship, and the log records the checks that ran', fgr.released === true && JSON.stringify(fgr.tickets) === '["BUG-841","BUG-842"]' && R.lastRelease(CS.repoInfo(fg.dir)).checks.length >= 1, `${fgr.tickets} checks=${JSON.stringify(R.lastRelease(CS.repoInfo(fg.dir)).checks)}`);

  /* ─────────────────────────────── cadence, versions, atomic publish */
  console.log('\n── cadence (default 5 tickets / 72 h / 24 h), versions, atomic publish');
  const cd = fixture('cadence');
  const def = n({ commit: true });
  verified(cd.dir, 'BUG-601', 'src/a.mjs', 'export const a = 61;\n');
  verified(cd.dir, 'BUG-602', 'src/b.mjs', 'export const b = 62;\n');
  const vAt = (h) => R.planRelease({ repo: cd.dir, policy: def, now: T0 + h * H });
  const c1 = await vAt(1); const c2 = await vAt(73);
  check('C1 2 tickets, waited 1 h → not due; waited 73 h → due', !c1.cadence.due && c2.cadence.due, `${c1.cadence.why} / ${c2.cadence.why}`);
  const nd = await R.cutRelease({ repo: cd.dir, policy: def, trigger: 'agent', clock: () => T0 + H });
  check('C2 an agent-triggered cut respects the cadence (not due → no commit)', nd.released === false && head(cd.dir) === cd.base, nd.reason);
  const forced = await R.cutRelease({ repo: cd.dir, policy: def, trigger: 'user', now: true, clock: () => T0 + H });
  check('C3 the user\'s --now skips only the cadence (2 tickets ship in one commit, v0.1.0)', forced.released === true && forced.version === 'v0.1.0' && Number(gitf(cd.dir, 'rev-list', '--count', `${cd.base}..HEAD`)) === 1, `${forced.version} ${forced.tickets?.join(',')}`);
  for (const [i, f] of [[3, 'c'], [4, 'd'], [5, 'e'], [6, 'f'], [7, 'g']]) verified(cd.dir, `BUG-60${i}`, `src/${f}.mjs`, `export const ${f} = 6${i};\n`);
  const lastAt = Date.parse(R.lastRelease(CS.repoInfo(cd.dir)).at);
  const i1 = await R.planRelease({ repo: cd.dir, policy: def, now: lastAt + 2 * H });
  const i2 = await R.planRelease({ repo: cd.dir, policy: def, now: lastAt + 25 * H });
  check('C4 5 eligible but 2 h after the last release → not due; 25 h after → due (≤1 release/day)', !i1.cadence.due && i2.cadence.due, `${i1.cadence.why} / ${i2.cadence.why}`);
  check('C5 version: BUG-only batch bumps the patch (v0.1.1)', i2.nextVersion === 'v0.1.1', i2.nextVersion);
  // tag collision: an unreachable v0.1.1 already exists → skip to v0.1.2
  const side = spawnSync('git', ['-C', cd.dir, 'commit-tree', `${cd.base}^{tree}`, '-p', cd.base, '-m', 'side'], { encoding: 'utf8' }).stdout.trim();
  gitf(cd.dir, 'tag', 'v0.1.1', side);
  const i3 = await R.planRelease({ repo: cd.dir, policy: def, now: lastAt + 25 * H });
  check('C6 a version tag that already exists (unreachable) is skipped (review #9)', i3.nextVersion === 'v0.1.2', i3.nextVersion);
  // Atomic publish: a check that moves HEAD → nothing published, no tag.
  const h0 = head(cd.dir);
  const polMove = n({ commit: true, release: { checks: ['node test/t.test.mjs', `git -C ${JSON.stringify(cd.dir)} commit --allow-empty -qm moved-during-checks`] } });
  let mv = null; try { await R.cutRelease({ repo: cd.dir, policy: polMove, trigger: 'user', now: true }); } catch (e) { mv = e.code; }
  check('C7 HEAD moved while the checks ran → refused; no release commit, no new tag', mv === 'head-moved' && !tags(cd.dir).includes('v0.1.2') && gitf(cd.dir, 'log', '-1', '--format=%s') === 'moved-during-checks' && gitf(cd.dir, 'rev-parse', 'HEAD~1') === h0, `${mv}; tags ${tags(cd.dir).join(',')}`);
  fs.writeFileSync(path.join(cd.dir, '.git', 'hook-refuse'), '');
  const h1b = head(cd.dir);
  let hk = null; try { await R.cutRelease({ repo: cd.dir, policy: def, trigger: 'user', now: true }); } catch (e) { hk = e.code; }
  check('C8 the repo\'s pre-commit hook refuses → nothing published, no tag', hk === 'hook-refused' && head(cd.dir) === h1b && !tags(cd.dir).includes('v0.1.2'), `${hk}; tags ${tags(cd.dir).join(',')}`);
  fs.rmSync(path.join(cd.dir, '.git', 'hook-refuse'));
  const ok2 = await R.cutRelease({ repo: cd.dir, policy: def, trigger: 'user', now: true });
  check('C9 then a clean cut ships the remaining 5 as ONE commit tagged v0.1.2', ok2.released && ok2.version === 'v0.1.2' && ok2.tickets.length === 5 && gitf(cd.dir, 'rev-list', '--count', `${h1b}..HEAD`) === '1', `${ok2.version} ${ok2.tickets?.join(',')}`);
  const noChk = fixture('nochecks');
  fs.rmSync(path.join(noChk.dir, 'package.json'));
  verified(noChk.dir, 'BUG-701', 'src/a.mjs', 'export const a = 71;\n', { check: null });
  let nc = null; try { await R.cutRelease({ repo: noChk.dir, policy: def, trigger: 'user', now: true }); } catch (e) { nc = e.code; }
  check('C10 zero release checks → refused (never published unchecked)', nc === 'no-checks' && head(noChk.dir) === noChk.base, nc);
  const busyInfo = CS.repoInfo(cd.dir);
  fs.writeFileSync(path.join(R.releaseDir(busyInfo), 'lock'), JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() }));
  let bz = null; try { await R.cutRelease({ repo: cd.dir, policy: def, trigger: 'user', now: true }); } catch (e) { bz = e.code; }
  fs.rmSync(path.join(R.releaseDir(busyInfo), 'lock'));
  check('C11 a second concurrent cut exits "busy"', bz === 'busy', bz);

  /* ─────────────────────────────── S9 the station: real routes on an isolated scratch server */
  console.log('\n── S9 the station routes (isolated scratch server: own data dir, free port)');
  const { isolatedServerEnv } = await import('./lib/station-boot.mjs');
  const net = await import('node:net');
  const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const BASE = `http://127.0.0.1:${port}`;
  const DATA = mkdtempScratch('feat164-station-'); dirs.push(DATA);
  const st = fixture('station');
  verified(st.dir, 'BUG-901', 'src/a.mjs', 'export const a = 901;\n');
  const env = isolatedServerEnv({ PORT: String(port), CLAUDE_STATION_DATA: DATA, ORCHARD_RELEASE_TICK: '0' });
  const server = spawn(process.execPath, ['src/server/index.ts'], { cwd: path.resolve(HERE, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let slog = ''; server.stdout.on('data', (d) => { slog += d; }); server.stderr.on('data', (d) => { slog += d; });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const j = async (m, u, body) => {
    const r = await fetch(BASE + u, { method: m, headers: body !== undefined ? { 'content-type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
    let d = null; try { d = await r.json(); } catch { /* */ }
    return { status: r.status, d };
  };
  try {
    let up = false;
    for (let i = 0; i < 240 && !up; i++) { try { up = (await fetch(`${BASE}/api/projects`)).ok; } catch { /* booting */ } if (!up) await sleep(150); }
    check('S9.0 scratch server up', up, up ? BASE : slog.slice(-600));
    const created = await j('POST', '/api/projects', { hostPath: st.dir, isolation: 'direct', applyMethod: false });
    const pid = created.d?.project?.id ?? created.d?.id;
    const pol = `/api/projects/${encodeURIComponent(pid)}/git-write-policy`;
    const relU = `/api/projects/${encodeURIComponent(pid)}/release`;
    const g0 = await j('GET', pol);
    check('S9.1 default: GET policy → mode none, "No agent commits (default)", and the release plan from the child CLI', g0.d?.policy?.mode === 'none' && g0.d?.summary === 'No agent commits (default)' && Array.isArray(g0.d?.release?.tickets), JSON.stringify({ mode: g0.d?.policy?.mode, summary: g0.d?.summary, tickets: g0.d?.release?.tickets }));
    const r403 = await j('POST', relU, {});
    check('S9.2 P1 via the station: an ungranted project\'s release route refuses (403), HEAD unchanged', r403.status === 403 && r403.d?.error === 'not-granted' && head(st.dir) === st.base, `${r403.status} ${r403.d?.error}`);
    // FEAT-190 r3 — the git-write-policy PUT route now requires the optimistic-concurrency `revision`
    // it was rendered from (GET returns it). `putPol` reads the current revision then PUTs with it.
    const putPol = async (body) => { const rev = (await j('GET', pol)).d?.revision; return j('PUT', pol, { ...body, revision: rev }); };
    const put = await putPol({ commit: true, push: false, scope: null, release: { minTickets: 1 } });
    const disk = JSON.parse(fs.readFileSync(path.join(DATA, 'registry.json'), 'utf8')).projects.find((p) => p.id === pid)?.settings?.gitWrite;
    check('S9.3 FEAT-190: PUT commit + blank note (push off) → SCOPED mode (blank scope is no longer release), stored once as the declared setting', put.status === 200 && put.d?.policy?.mode === 'scoped' && disk?.commit === true && disk?.scope === null && disk?.grantedVia === 'dashboard', JSON.stringify({ status: put.status, mode: put.d?.policy?.mode, disk }));
    const patch = await j('PATCH', `/api/projects/${encodeURIComponent(pid)}`, { gitWrite: { commit: false } });
    check('S9.4 the generic settings PATCH cannot write it (400)', patch.status === 400, patch.status);
    const bad = await j('POST', relU, { force: true });
    check('S9.5 the release route takes {} only — a force/push override is refused (400)', bad.status === 400 && bad.d?.error === 'bad-request', `${bad.status} ${bad.d?.reason}`);
    const cutR = await j('POST', relU, {});
    check('S9.6 POST {} → the station cuts ONE release commit + tag through the child CLI (outside any shim)', cutR.status === 200 && cutR.d?.released === true && cutR.d?.version === 'v0.1.0' && Number(gitf(st.dir, 'rev-list', '--count', `${st.base}..HEAD`)) === 1 && gitq(st.dir, 'cat-file', '-t', 'v0.1.0').out === 'tag', `${cutR.status} ${JSON.stringify({ released: cutR.d?.released, version: cutR.d?.version, reason: cutR.d?.reason })}`);
    const gg = await j('GET', `/api/projects/${encodeURIComponent(pid)}/git-write-grant`);
    check('S9.7 the git panel\'s GET carries the policy (mode scoped — a blank-scope grant) next to the store view (standing grant)', gg.d?.policy?.mode === 'scoped' && gg.d?.grant?.scope === 'permanent', JSON.stringify({ mode: gg.d?.policy?.mode, scope: gg.d?.grant?.scope }));
    const inv = await putPol({ commit: true, release: { minTickets: 0 } });
    check('S9.8 an invalid cadence is refused (400) and nothing changes', inv.status === 400 && (await j('GET', pol)).d?.policy?.release?.minTickets === 1, `${inv.status} ${inv.d?.error}`);
    const scoped = await putPol({ commit: true, push: true, scope: 'commit to main; push at most daily' });
    check('S9.9 a scope note → scoped mode', scoped.d?.policy?.mode === 'scoped' && scoped.d?.policy?.push === true, scoped.d?.summary);
    const del = await j('DELETE', pol);
    check('S9.10 DELETE → mode none, the note and cadence are kept for a re-grant', del.d?.policy?.mode === 'none' && del.d?.policy?.scope === 'commit to main; push at most daily', JSON.stringify({ mode: del.d?.policy?.mode, scope: del.d?.policy?.scope }));
    const legacy = await j('POST', `/api/projects/${encodeURIComponent(pid)}/git-write-grant`, { scope: 'permanent' });
    check('S9.11 the r1 "permanent" grant route now grants COMMIT through the one writer (note kept → scoped)', legacy.status === 200 && (await j('GET', pol)).d?.policy?.mode === 'scoped', legacy.status);
  } catch (e) {
    check(`S9 threw: ${e.message}`, false, slog.slice(-800));
  } finally {
    try { process.kill(server.pid, 'SIGTERM'); } catch { /* gone */ }
    await new Promise((r) => { const t = setTimeout(r, 5000); server.once('exit', () => { clearTimeout(t); r(); }); });
    try { process.kill(server.pid, 'SIGKILL'); } catch { /* gone */ }
  }

  console.log(`\nFEAT-164 release: ${pass} passed, ${failN} failed, ${retiredN} retired (FEAT-190 round-14)`);
  cleanup();
  process.exit(failN ? 1 : 0);
}

main().catch((e) => { console.log(`FAIL  suite threw: ${e?.stack || e}`); cleanup(); process.exit(1); });
