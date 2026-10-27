#!/usr/bin/env node
/**
 * verify-bug-273-iv-infra.mjs — proof for the three INFRASTRUCTURE causes that
 * waste independent-verify rounds (BUG-273), as RE-SCOPED in r3 (the technical
 * adjudicator's adopted spec, after the r2 P3 "containment" framing + the shell-text
 * advisory both proved brittle):
 *
 *   P1 validateRunForms — the r2 shell-TEXT advisories (double `--`, env prefix) and
 *      their tokeniser are DELETED: `canonCmd`/`sameCmd` (verdict-contract.mjs,
 *      BUG-066) is the single citation-identity authority, and a quote-attached
 *      `--flag="a -- b"` made the double-`--` advisory CRY WOLF. The ONLY hard check
 *      kept is `>1 --run` (an array-length test); the ONLY advisory kept is the
 *      plain-substring `npm run confined` note (git-write-fixture suites still need
 *      confined). A legit quoted arg carrying `--` is now accepted with NO warning.
 *   P2 providerAbortKind — RESTRUCTURED (r4, after the fallback property broke
 *      TWICE on stderr reconstruction). The dispatcher OWNS the failure kind and
 *      writes a TYPED value to --meta-out on EVERY openai branch (dispatch.mjs);
 *      providerAbortKind now reads `meta.failureKind` ONLY and never scrapes the
 *      dispatch child's shared stderr (which also carries the verifier's own
 *      taxonomy-laden reasoning — the ARCH-010 root cause of r2/r3). It fails
 *      CLOSED: a local kind, the retired placeholder, an absent/unreadable meta,
 *      or an unknown kind all yield null ⇒ no fallback. The owner-side write is
 *      proven by driving the REAL scripts/dispatch.mjs with a stubbed provider
 *      (proveDispatchWritesTypedKind). C2 (canonCmd quoted-whitespace) is OUT OF
 *      SCOPE → BUG-276.
 *   P3 buildRoomGitEnv — RESCOPED from "containment" to DECORRELATION + seed
 *      hermeticity (NOT an exfiltration boundary). A live `codex sandbox -c
 *      sandbox_mode=workspace-write` read test (BUG-273 r3 adjudication entry) proved
 *      the verifier can read the live repo by ABSOLUTE PATH and via `git -C <repo>`,
 *      so env-steering (GIT_*, PATH, HOME/XDG) is OUT OF SCOPE and NOT defended. What
 *      IS enforceable and tested here: a room-rooted plain `git show HEAD:<stripped>`
 *      (no `-C`, dispatch env built by buildRoomGitEnv) sees the room's inert stub,
 *      not real-repo history leaked via inherited GIT_DIR (honest-case hygiene); and
 *      the seeded commit is built from ONLY the stripped tree (seed hermeticity), so
 *      a CLEAN read of HEAD:<stripped> never serves real prose.
 *   (The r1 cause-3 `.git` SEEDING behaviour — proveCause3Seed — is retained as an
 *    anti-regression.)
 *
 * BUG-273 r7 (P3/seed): the r6 seed fed exported file NAMES to `git add
 * --pathspec-from-file` WITHOUT GIT_LITERAL_PATHSPECS, so a name beginning with
 * pathspec magic was interpreted, not taken literally — `:(exclude)x`/`:!x` were read
 * as EXCLUDE filters and SILENTLY dropped from the commit, and a `:/`-leading or
 * `:(glob)` name matched nothing and ABORTED the whole add (ok=false). It also walked
 * with a STRING readdir, so an invalid-UTF-8 filename decoded to U+FFFD and lost its
 * bytes. The fix sets GIT_LITERAL_PATHSPECS=1 in the seed's room-set git env (survives
 * the GIT* scrub because it is layered via buildRoomGitEnv's `extra`) and walks with a
 * BUFFER-accurate readdir. The pre-r7 anchor (preR6SeedScratchGit, the r6 shipped seed
 * written out literally) reddens the attack suite; the real seed commits every
 * adversarial name verbatim. Attack list proven against REAL git (r7 dispatch log):
 * `:(exclude)x`, `:!x`, `:/x`, `:(glob)*`, `*`, `?`, `[ab]`, a backslash, a leading
 * `-`, a newline, invalid-UTF-8 bytes, a very long path, a stray nested `.git` (never
 * committed), plus the whole r6 list (ignored files, nested .gitignore, hostile HOME,
 * symlink, stub served, node_modules absent, status clean).
 *
 * MUST-FAIL ANCHOR — synthesized from the PRE-fix behaviour, NOT anchored to HEAD
 * (docs/CONVENTIONS.md: a baseline that names the thing being changed stops
 * failing the moment the fix lands). The pre-fix code is written out literally
 * here — the old shell-text advisory validator (r2 shellTokens, incl. the
 * quote-attached false positive), the old scrape-through classifier, the old
 * `...process.env` env spread — and the SAME r3 assertions are run against it, so
 * the suite reddens on the pre-fix code and passes on the shipped exports.
 *
 * For P3 the assertions run against the REAL repo's git objects: a hostile parent
 * env (GIT_DIR=<real .git>, GIT_ALTERNATE_OBJECT_DIRECTORIES=<real objects>) is set
 * while the room is seeded and read, so the pre-fix `...process.env` spread lets a
 * room-rooted `git show HEAD:<stripped>` resurrect this repo's real WORKING_AGREEMENT
 * prose (inherited GIT_DIR steering the read), and buildRoomGitEnv genuinely blocks
 * it. (A verifier that itself passes `git -C <realrepo>` or an absolute path is NOT
 * tested — it is out of scope; see the sandbox read test cited above.)
 *
 * Scratch: every dir this script makes lives under the OS temp root and is removed
 * in a finally; git objects are built via the sanctioned temp-index plumbing the
 * shim permits (no `git init`/`commit` against any real repo). The hostile GIT_*
 * env is set and RESTORED inside the P3 helper, never leaking to the other proofs.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateRunForms, providerAbortKind, seedScratchGit, buildRoomGitEnv,
} from './independent-verify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const o = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${(o ?? '').slice(0, 400)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
function section(t) { console.log(`\n${t}\n${'-'.repeat(t.length)}`); }

const cleanup = [];
function tmp(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); cleanup.push(d); return d; }

/* ============================================================== PRE-fix ==== */
// The pre-r3 (r2) behaviour, written out literally, tagged so the SAME r3
// assertions below can grade it.
const PROVIDER_ABORT_KINDS = new Set([
  'quota-window', 'rate-limited', 'overloaded', 'auth-expired', 'model-unavailable', 'network', 'internal',
]);
const PRE_RUN_ENV_PREFIX_RE = /^\s*(?:env\s+)?[A-Za-z_][A-Za-z0-9_]*=/;
// pre-r3 (= r2) validateRunForms: the shell-text advisories r3 DELETES. It emits
// `severity:'warning'` for a double-`--` and an env prefix, using the r2 quote-aware
// `shellTokens` splitter — which still MIS-counts a quote-ATTACHED arg like
// `--flag="a -- b"` (the `\S+` branch swallows `--flag="a`, then sees the mid-quote
// ` -- ` as a bare separator → sepCount 2 → a false double-`--` advisory). The r3
// assertions below demand NO warning for those forms, so this reddens the suite.
function preShellTokens(s) {
  const toks = [];
  const re = /"(?:\\.|[^"\\])*"|'[^']*'|\S+/g;
  let m;
  while ((m = re.exec(String(s)))) toks.push(m[0]);
  return toks;
}
function preValidateRunForms(runs) {
  const problems = [];
  if (runs.length > 1) problems.push({ severity: 'error', why: 'EXACTLY ONE FIXER-TEST' });
  for (const r of runs) {
    const s = String(r);
    const toks = preShellTokens(s);
    const sepCount = toks.filter((t) => t === '--').length;
    const isConfined = /\b(?:npm\s+run\s+confined|confined-run(?:\.mjs)?)\b/.test(s);
    if (isConfined) problems.push({ severity: 'warning', why: 'confined wrapper' });
    else if (sepCount >= 2) problems.push({ severity: 'warning', why: 'double --' });
    if (PRE_RUN_ENV_PREFIX_RE.test(s)) problems.push({ severity: 'warning', why: 'env prefix' });
  }
  return problems;
}
// pre-r4 providerAbortKind = the r2/r3 SHIPPED code: it short-circuits on an
// explicit non-placeholder meta kind, but when meta is ABSENT or is the openai
// `see stderr taxonomy line` PLACEHOLDER it SCRAPES the dispatch child's shared
// stderr (which also carries the verifier's own taxonomy-laden reasoning) with a
// first-match `.find`. That scrape is the P2 defect r4 removes: a placeholder
// meta whose stderr quotes `[rate-limited]` ahead of the real terminal `[timeout]`
// (r3), and an absent meta that must fail closed (r4), both wrongly return a
// provider kind here — so this reddens the r4 assertions below.
const PRE_OPENAI_STDERR_PLACEHOLDER = 'see stderr taxonomy line';
function preProviderAbortKind({ code, meta, stderr } = {}) {
  if (code === 0) return null;
  const fromMeta = meta?.failureKind;
  if (typeof fromMeta === 'string' && fromMeta !== PRE_OPENAI_STDERR_PLACEHOLDER) {
    return PROVIDER_ABORT_KINDS.has(fromMeta) ? fromMeta : null;
  }
  const line = String(stderr ?? '').split('\n').find((l) => l.includes('dispatch failed ['));
  const m = line && /dispatch failed \[([a-z-]+)\]/.exec(line);
  if (m && PROVIDER_ABORT_KINDS.has(m[1])) return m[1];
  return null;
}
// pre-r2 room git env: the `...process.env` spread (plus the handful of GIT_*
// overrides a caller added) — it leaks every inherited GIT_* name.
const preBuildRoomGitEnv = (extra = {}) => ({ ...process.env, ...extra });

// pre-r6 seedScratchGit: the SHIPPED (6b5d754) seed, written out literally, with the
// ONE line r6 changes — `git add -A` instead of the explicit force-added file list.
// `-A` HONOURS .gitignore / nested .gitignore / info/exclude / core.excludesFile, so
// an exported-but-ignored TRACKED file is silently dropped from the synthetic HEAD
// while the seed still reports ok — exactly the r5 INVALID. Everything else (the
// skeleton, the temp-index plumbing, buildRoomGitEnv, the HEAD-resolve check) is
// byte-identical to the shipped code so the attack suite grades ONLY the add step.
function preSeedScratchGit(dir) {
  try {
    const gitDir = path.join(dir, '.git');
    if (fs.existsSync(gitDir)) return { ok: false, error: '.git already present' };
    fs.mkdirSync(path.join(gitDir, 'objects', 'info'), { recursive: true });
    fs.mkdirSync(path.join(gitDir, 'objects', 'pack'), { recursive: true });
    fs.mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true });
    fs.mkdirSync(path.join(gitDir, 'refs', 'tags'), { recursive: true });
    fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(gitDir, 'config'),
      '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = false\n');
    fs.writeFileSync(path.join(gitDir, 'info', 'exclude'), '/node_modules/\n');
    const idxTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-gitidx-pre-'));
    const env = buildRoomGitEnv({
      GIT_DIR: gitDir, GIT_WORK_TREE: dir, GIT_INDEX_FILE: path.join(idxTmp, 'index'),
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'independent-verify', GIT_AUTHOR_EMAIL: 'verify@example.invalid',
      GIT_COMMITTER_NAME: 'independent-verify', GIT_COMMITTER_EMAIL: 'verify@example.invalid',
    });
    const g = (args) => spawnSync('git', args, { encoding: 'utf8', env });
    try {
      const add = g(['add', '-A']); // <-- the r6 defect: ignore rules subtract from HEAD
      if ((add.status ?? 1) !== 0) return { ok: false, error: `git add: ${(add.stderr || '').trim().slice(0, 200)}` };
      const wt = g(['write-tree']);
      if ((wt.status ?? 1) !== 0) return { ok: false, error: `write-tree: ${(wt.stderr || '').trim()}` };
      const ct = g(['commit-tree', wt.stdout.trim(), '-m', 'clean-room base (synthetic — independent-verify)']);
      if ((ct.status ?? 1) !== 0) return { ok: false, error: `commit-tree: ${(ct.stderr || '').trim()}` };
      const commit = ct.stdout.trim();
      fs.copyFileSync(path.join(idxTmp, 'index'), path.join(gitDir, 'index'));
      fs.writeFileSync(path.join(gitDir, 'refs', 'heads', 'main'), commit + '\n');
      const head = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: buildRoomGitEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }) });
      if ((head.status ?? 1) !== 0 || head.stdout.trim() !== commit) return { ok: false, error: `HEAD resolve: ${(head.stderr || '').trim()}` };
      return { ok: true, head: commit, error: null };
    } finally { try { fs.rmSync(idxTmp, { recursive: true, force: true }); } catch { /* best effort */ } }
  } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
}

// pre-r7 seedScratchGit: the r6 SHIPPED (e11e6af) seed written out literally — the
// STRING walk + `git add -f --pathspec-from-file=- --pathspec-file-nul` with NO
// GIT_LITERAL_PATHSPECS. `--pathspec-file-nul` fixes SPLITTING but NOT pathspec MAGIC,
// so a magic-prefixed exported name is read as a pathspec: `:(exclude)x`/`:!x` become
// EXCLUDE filters (seed reports ok but the file is SILENTLY absent from HEAD), and a
// `:/`-leading or `:(glob)` name matches nothing and ABORTS the whole add (ok=false).
// The string walk ALSO mangles an invalid-UTF-8 name to U+FFFD → wrong bytes → loss.
// The r7 attack suite grades exactly these; everything else is byte-identical to the
// shipped code so the proof isolates the add step.
function preR6SeedScratchGit(dir) {
  try {
    const gitDir = path.join(dir, '.git');
    if (fs.existsSync(gitDir)) return { ok: false, error: '.git already present' };
    fs.mkdirSync(path.join(gitDir, 'objects', 'info'), { recursive: true });
    fs.mkdirSync(path.join(gitDir, 'objects', 'pack'), { recursive: true });
    fs.mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true });
    fs.mkdirSync(path.join(gitDir, 'refs', 'tags'), { recursive: true });
    fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(gitDir, 'config'),
      '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = false\n');
    fs.writeFileSync(path.join(gitDir, 'info', 'exclude'), '/node_modules/\n');
    const idxTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-gitidx-pre6-'));
    const env = buildRoomGitEnv({ // <-- NO GIT_LITERAL_PATHSPECS: the r6 defect
      GIT_DIR: gitDir, GIT_WORK_TREE: dir, GIT_INDEX_FILE: path.join(idxTmp, 'index'),
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'independent-verify', GIT_AUTHOR_EMAIL: 'verify@example.invalid',
      GIT_COMMITTER_NAME: 'independent-verify', GIT_COMMITTER_EMAIL: 'verify@example.invalid',
    });
    const g = (args, extra = {}) => spawnSync('git', args, { encoding: 'utf8', env, ...extra });
    try {
      const relFiles = []; // STRING walk (mangles invalid-UTF-8 bytes to U+FFFD)
      (function walk(relDir) {
        let ents;
        try { ents = fs.readdirSync(relDir ? path.join(dir, ...relDir.split('/')) : dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          const rel = relDir ? `${relDir}/${e.name}` : e.name;
          if (!relDir && (e.name === '.git' || e.name === 'node_modules')) continue;
          if (e.isSymbolicLink()) { relFiles.push(rel); continue; }
          if (e.isDirectory()) { walk(rel); continue; }
          relFiles.push(rel);
        }
      })('');
      const add = relFiles.length === 0
        ? { status: 0 }
        : g(['add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: relFiles.join('\0') });
      if ((add.status ?? 1) !== 0) return { ok: false, error: `git add: ${(add.stderr || '').trim().slice(0, 200)}` };
      const wt = g(['write-tree']);
      if ((wt.status ?? 1) !== 0) return { ok: false, error: `write-tree: ${(wt.stderr || '').trim()}` };
      const ct = g(['commit-tree', wt.stdout.trim(), '-m', 'clean-room base (synthetic — independent-verify)']);
      if ((ct.status ?? 1) !== 0) return { ok: false, error: `commit-tree: ${(ct.stderr || '').trim()}` };
      const commit = ct.stdout.trim();
      fs.copyFileSync(path.join(idxTmp, 'index'), path.join(gitDir, 'index'));
      fs.writeFileSync(path.join(gitDir, 'refs', 'heads', 'main'), commit + '\n');
      const head = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: buildRoomGitEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }) });
      if ((head.status ?? 1) !== 0 || head.stdout.trim() !== commit) return { ok: false, error: `HEAD resolve: ${(head.stderr || '').trim()}` };
      return { ok: true, head: commit, error: null };
    } finally { try { fs.rmSync(idxTmp, { recursive: true, force: true }); } catch { /* best effort */ } }
  } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
}

/* ============================================================ CAUSE 1 ==== */
// r3 contract: the ONLY hard error is `>1 --run`; the ONLY advisory is the plain
// `npm run confined` note; the deleted double-`--`/env-prefix advisories now emit
// NOTHING, and a quote-attached `--flag="a -- b"` raises NO false warning.
const P1_CASES = [
  { name: '>1 --run → HARD error (exactly one FIXER-TEST)', runs: ['node a.mjs', 'node b.mjs'], wantError: true },
  { name: 'confined wrap → accepted, with the KEPT advisory', runs: ['npm run confined -- -- node scripts/verify-x.mjs'], wantError: false, wantWarning: true },
  { name: 'confined-run.mjs wrap → accepted, with the KEPT advisory', runs: ['node /o/scripts/confined-run.mjs -- node scripts/verify-x.mjs'], wantError: false, wantWarning: true },
  // r3 must-FAIL: the double-`--` advisory is DELETED, so two unquoted `--`
  // separators now raise NO warning (pre-fix r2 warned → reddens).
  { name: 'two -- separators (unquoted) → accepted, NO warning (advisory deleted)', runs: ['foo -- bar -- node s.mjs'], wantError: false, wantWarning: false },
  // r3 must-FAIL: the env-prefix advisory is DELETED (canonCmd/sameCmd is the
  // authority), so an env-prefixed command now raises NO warning (pre-fix warned).
  { name: 'env-prefixed command → accepted, NO warning (advisory deleted; canonCmd is authority)', runs: ['FOO=1 node scripts/verify-x.mjs'], wantError: false, wantWarning: false },
  // r3 must-FAIL (charter): a legit QUOTED arg carrying `--` is accepted with NO
  // warning. The quote-ATTACHED form below is the exact false positive the
  // adjudicator reproduced against the real export (`--grep="a -- b"`).
  { name: 'quoted arg containing two -- → accepted, NO warning', runs: ['node scripts/verify-x.mjs --grep "a -- b -- c"'], wantError: false, wantWarning: false },
  { name: 'quote-ATTACHED arg carrying -- (--flag="a -- b") → accepted, NO warning', runs: ['node scripts/verify-x.mjs --grep="a -- b" -- extra'], wantError: false, wantWarning: false },
  { name: 'env assignment after && → not flagged (canonCmd is authority)', runs: ['node a.mjs && BAR=1 node b.mjs'], wantError: false, wantWarning: false },
  { name: 'plain node suite → clean', runs: ['node scripts/verify-x.mjs'], wantError: false, wantWarning: false },
  { name: 'single -- passthrough (legit) → clean', runs: ['node scripts/verify-x.mjs -- --leg=unit'], wantError: false, wantWarning: false },
  { name: 'npm run (not confined) → clean', runs: ['npm run verify:x'], wantError: false, wantWarning: false },
];

function proveCause1(validate, label) {
  section(`CAUSE 1 / P1 — validateRunForms [${label}]`);
  for (const c of P1_CASES) {
    const probs = validate(c.runs);
    const errs = probs.filter((p) => p.severity === 'error');
    const warns = probs.filter((p) => p.severity === 'warning');
    check(`${c.name} — error=${c.wantError}`, (errs.length > 0) === c.wantError, `errors=${errs.length} warnings=${warns.length}`);
    if ('wantWarning' in c) check(`${c.name} — warning=${c.wantWarning}`, (warns.length > 0) === c.wantWarning, `errors=${errs.length} warnings=${warns.length}`);
  }
  // A kept hard reject still prints an actionable why; a warning still prints a fix.
  const multi = validate(['node a.mjs', 'node b.mjs']);
  check('>1 --run names the one-FIXER-TEST rule', /FIXER-TEST/.test(multi.map((p) => p.why).join(' ')), multi[0]?.why);
}

/* ============================================================ CAUSE 2 ==== */
// r4 contract: providerAbortKind reads `meta.failureKind` ONLY — the dispatcher
// OWNS the kind and writes a TYPED value on every failure branch (proven at the
// dispatch level by proveDispatchWritesTypedKind below), so stderr is never
// scraped. A fallback fires iff meta carries a PROVIDER kind; everything else
// (local kinds, the old placeholder, absent/unreadable meta, unknown kinds,
// and any exit-0 verdict) fails CLOSED → null → no fallback. The `stderr` field
// in these cases is DELIBERATELY provider-looking: a correct r4 classifier must
// ignore it entirely.
// BUG-273 r5 (P2): the real providerAbortKind now ALSO requires meta.nonce to
// match the nonce THIS invocation passed, so every genuine-abort case carries a
// matching nonce (meta.nonce === in.nonce). The pre-r5 anchor (preR5…) ignores
// the nonce, so it still returns the kind here (these are not its reddeners —
// the nonce reddeners live in R5_NONCE_CASES below).
const AN = 'nonce-match-1';
const ABORT_CASES = {
  'openai quota-window (meta, nonce match)': { in: { code: 1, meta: { failureKind: 'quota-window', nonce: AN }, nonce: AN }, expect: 'quota-window' },
  // charter r4 case (b): an explicit provider meta kind yields a fallback.
  'openai rate-limited (meta, nonce match)': { in: { code: 1, meta: { failureKind: 'rate-limited', nonce: AN }, nonce: AN }, expect: 'rate-limited' },
  'openai overloaded (meta, nonce match)': { in: { code: 1, meta: { failureKind: 'overloaded', nonce: AN }, nonce: AN }, expect: 'overloaded' },
  'openai auth-expired (meta, nonce match)': { in: { code: 1, meta: { failureKind: 'auth-expired', nonce: AN }, nonce: AN }, expect: 'auth-expired' },
  'openai model-unavailable (meta, nonce match)': { in: { code: 1, meta: { failureKind: 'model-unavailable', nonce: AN }, nonce: AN }, expect: 'model-unavailable' },
  'openai network (meta, nonce match)': { in: { code: 1, meta: { failureKind: 'network', nonce: AN }, nonce: AN }, expect: 'network' },
  'openai cyber/moderation → internal (meta, nonce match)': { in: { code: 1, meta: { failureKind: 'internal', nonce: AN }, nonce: AN }, expect: 'internal' },
};
const NO_FALLBACK_CASES = {
  // exit-0 is a verdict, never an abort — even with a provider meta kind + matching nonce.
  'a VERDICT (exit 0) is never an abort': { code: 0, meta: { failureKind: 'quota-window', nonce: AN }, nonce: AN },
  // LOCAL meta kinds are not a provider reason → no fallback (nonce MATCHES, so it
  // is the KIND gate that rejects, not the nonce gate).
  'local timeout meta → NO fallback': { code: 1, meta: { failureKind: 'timeout', nonce: AN }, nonce: AN },
  'local transport meta → NO fallback': { code: 1, meta: { failureKind: 'transport', nonce: AN }, nonce: AN },
  'local sandbox-preflight meta → NO fallback': { code: 1, meta: { failureKind: 'sandbox-preflight', nonce: AN }, nonce: AN },
  'local interrupted meta → NO fallback (interrupt is local)': { code: 1, meta: { failureKind: 'interrupted', nonce: AN }, nonce: AN },
  // charter r4 case (a): meta=timeout decides ALONE; a provider-looking stderr
  // substring must NOT fire the fallback (the r2 confound). Holds on pre-r4 too
  // (it short-circuited local meta) — a regression guard, not a reddener.
  'local timeout meta + provider-looking stderr → NO fallback (stderr ignored)': { code: 1, meta: { failureKind: 'timeout', nonce: AN }, nonce: AN, stderr: 'dispatch failed [rate-limited] (provider openai): 429' },
  // charter r4 case (c) — THE r3 BREAK: the old placeholder meta, with stderr
  // quoting `[rate-limited]` AHEAD of the real terminal `[timeout]`. Pre-r4
  // scraped the first match → `rate-limited` (reddens); r4+ ignores stderr → null.
  'placeholder meta + [rate-limited] ahead of [timeout] on stderr → NO fallback': { code: 1, meta: { failureKind: 'see stderr taxonomy line', nonce: AN }, nonce: AN, stderr: 'dispatch failed [rate-limited] (retry 1/3)\ndispatch failed [timeout] (provider openai): no completion' },
  // charter r4 case (d) — FAIL CLOSED: meta absent entirely (dispatch died before
  // writing). Pre-r4 scraped the provider-looking stderr (reddens); r4+ → null.
  'absent meta + provider-looking stderr → NO fallback (fail closed)': { code: 1, nonce: AN, stderr: 'dispatch failed [quota-window] (provider openai): weekly limit' },
  // meta present but unreadable/null (JSON.parse failed upstream) — also closed.
  'null meta + provider-looking stderr → NO fallback (fail closed)': { code: 1, meta: null, nonce: AN, stderr: 'dispatch failed [overloaded] (provider openai)' },
  // an unknown/garbage meta kind is not a known provider reason → null.
  'unknown meta kind → NO fallback': { code: 1, meta: { failureKind: 'bananas', nonce: AN }, nonce: AN },

  // ---- BUG-273 r5 (P2): the THIRD break — STALE meta on a reused path --------
  // The r4 reader honoured any PRESENT meta's provider kind and failed closed only
  // on ABSENT meta. A prior run's meta left on a reused path (crash before THIS run
  // wrote) is present-but-stale: r4 (= the pre-anchor here, which ignores the nonce)
  // returns its provider kind and fires a WRONG fallback (reddens); r5 rejects it on
  // the nonce mismatch → null.
  'r5 STALE provider meta (old nonce ≠ this run) → NO fallback': { code: 1, meta: { failureKind: 'rate-limited', nonce: 'stale-prior-run' }, nonce: 'this-run-nonce' },
  // A meta with NO nonce field at all (an old-format / unstamped file) also fails
  // closed — a present kind without a matching stamp is never honoured.
  'r5 unstamped meta + provider kind (no nonce field) → NO fallback': { code: 1, meta: { failureKind: 'overloaded' }, nonce: 'this-run-nonce' },
  // The init-invalidate record dispatch.mjs writes first: current nonce, null kind.
  // A crash AFTER init but before the terminal write leaves exactly this → null.
  'r5 init-invalidate meta (current nonce, failureKind null) → NO fallback': { code: 1, meta: { failureKind: null, nonce: 'this-run-nonce' }, nonce: 'this-run-nonce' },
};

function proveCause2(classify, label) {
  section(`CAUSE 2 / P2 — providerAbortKind [${label}]`);
  for (const [name, c] of Object.entries(ABORT_CASES)) {
    const got = classify(c.in);
    check(`falls back on: ${name}`, got === c.expect, `got ${JSON.stringify(got)}, want ${JSON.stringify(c.expect)}`);
  }
  for (const [name, input] of Object.entries(NO_FALLBACK_CASES)) {
    const got = classify(input);
    check(`does NOT fall back: ${name}`, got === null, `got ${JSON.stringify(got)}, want null`);
  }
}

/* ============================================================ CAUSE 3 ==== */
// A REALISTIC post-strip exported tree: code + package.json + a copied
// node_modules + vrun.mjs; the methodology/board has ALREADY been stripped, so it
// is ABSENT. Mirrors what buildCleanroom hands to seedScratchGit.
function buildExportedTree() {
  const dir = tmp('iv-room-');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'suite.mjs'), 'export const ok = true;\n');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'dist/\n');
  fs.writeFileSync(path.join(dir, 'vrun.mjs'), '// harness recorder client\n');
  fs.mkdirSync(path.join(dir, 'node_modules', 'leftpad'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'leftpad', 'index.js'), 'module.exports=1;\n');
  return dir;
}

function gitRead(dir, args) {
  return spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
}

// r1 anti-regression: the .git SEEDING behaviour itself.
function proveCause3Seed() {
  section('CAUSE 3 (r1) — seedScratchGit seeds a hermetic scratch .git');
  const preRoom = buildExportedTree();
  const preProbe = gitRead(preRoom, ['rev-parse', 'HEAD']);
  check('PRE: a git harness FAILS in a room with no .git',
    (preProbe.status ?? 1) !== 0 && /not a git repository/i.test(preProbe.stderr || ''),
    `exit ${preProbe.status}: ${(preProbe.stderr || '').trim().slice(0, 80)}`);

  const room = buildExportedTree();
  const r = seedScratchGit(room);
  check('seedScratchGit reports ok', r.ok, JSON.stringify(r));
  if (!r.ok) return;

  const head = gitRead(room, ['rev-parse', 'HEAD']);
  check('git rev-parse HEAD resolves', (head.status ?? 1) === 0 && head.stdout.trim() === r.head, `${head.stdout.trim()} (exit ${head.status})`);
  const topl = gitRead(room, ['rev-parse', '--show-toplevel']);
  const roomReal = fs.realpathSync(room);
  check('toplevel is INSIDE the room (containment)', (topl.status ?? 1) === 0 && fs.realpathSync(topl.stdout.trim()) === roomReal, topl.stdout.trim());
  const status = gitRead(room, ['status', '--porcelain']);
  check('git status works and the tree is clean', (status.status ?? 1) === 0 && status.stdout.trim() === '', `exit ${status.status}, dirty: ${JSON.stringify(status.stdout.trim())}`);
  const log = gitRead(room, ['log', '--format=%an <%ae>', '-1']);
  check('committed by the SYNTHETIC identity', log.stdout.trim() === 'independent-verify <verify@example.invalid>', log.stdout.trim());
  const remote = gitRead(room, ['remote', '-v']);
  check('NO remote (can never reach the real repo)', (remote.stdout || '').trim() === '', JSON.stringify(remote.stdout.trim()));
  const lsFiles = gitRead(room, ['ls-files']);
  const tracked = lsFiles.stdout.trim().split('\n').filter(Boolean);
  check('code/vrun committed, node_modules EXCLUDED', tracked.includes('scripts/suite.mjs') && tracked.includes('vrun.mjs') && !tracked.some((f) => f.startsWith('node_modules/')), tracked.join(','));
  const showStripped = gitRead(room, ['show', 'HEAD:docs/prompts/METHODOLOGY.md']);
  check('a stripped file is NOT recoverable via git show HEAD:', (showStripped.status ?? 1) !== 0, `exit ${showStripped.status}: ${(showStripped.stderr || '').trim().slice(0, 80)}`);
  const again = seedScratchGit(room);
  check('re-seeding a room that already has .git is refused', !again.ok, JSON.stringify(again));
}

/* ---- r6: the seed commits EXACTLY the exported file set (the r5 INVALID class) ----
 * A REALISTIC post-strip room that exercises the whole verifier attack list in one
 * tree: tracked-but-ignored files (root + a nested .gitignore), a leading-dash name,
 * spaces + unicode paths, an empty dir, a committed symlink, a stripped inert stub,
 * a `*.xf`-ignoring HOME gitconfig (the "excludesFile may still be read" worry), and
 * the live-copy node_modules. `git add -A` (pre-r6) HONOURS every ignore source, so
 * the ignored-but-exported files vanish from HEAD though the seed reports ok — the
 * r5 `git show HEAD:<file>` 128. The r6 force-added explicit file set cannot be
 * subtracted by any ignore rule. The STRIPPED_STUB const is defined below; this fn
 * only runs from main() after the module has fully loaded. */
function buildAttackRoom() {
  const dir = tmp('iv-room-attack-');
  const w = (rel, body) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
  // real code + root .gitignore that ALSO matches two exported, tracked paths
  w('package.json', '{"name":"x","version":"1.0.0"}\n');
  w('.gitignore', 'secret.env\ndist/\n');
  w('secret.env', 'API_KEY=273\n');              // tracked-but-ignored (root rule)
  w('dist/bundle.js', 'built\n');                // tracked-but-ignored (ignored dir)
  // nested .gitignore ignoring an exported, tracked sibling
  w('pkg/.gitignore', '*.log\n');
  w('pkg/app.mjs', 'export const x = 1;\n');
  w('pkg/debug.log', 'noise\n');                 // tracked-but-ignored (nested rule)
  // adversarial path shapes
  w('-dashfile.txt', 'leading dash\n');          // name starts with '-'
  w('a file with spaces.txt', 'spaces\n');       // spaces
  w('café/münchen.txt', 'unicode\n');  // unicode dir + file
  w('thing.xf', 'would match a HOME excludesFile *.xf\n'); // core.excludesFile target
  // BUG-273 r7 — PATHSPEC-MAGIC + adversarial-byte names (the newest BROKEN verdict).
  // A non-literal `git add <name>` reads these as magic, NOT as literal paths:
  // `:(exclude)x`/`:!x` are read as EXCLUDE filters (silent drop from HEAD), while
  // `:/x` and `:(glob)star` match nothing and ABORT the whole add. The wildcard /
  // backslash / newline / long / invalid-UTF-8 names stress the byte-accurate walk and
  // `--pathspec-file-nul`. GIT_LITERAL_PATHSPECS=1 + the Buffer walk commit them all
  // verbatim. (Proven against real git in the r7 dispatch log.)
  w(':(exclude)x', 'magic exclude\n');           // read as an exclude filter pre-fix → silent drop
  w(':!x', 'magic bang-exclude\n');              // :! is shorthand exclude → silent drop
  w(':/x', 'leading colon-slash\n');             // dir ':' + file 'x' → rel ':/x' → ABORTS the add pre-fix
  w(':(glob)star', 'magic glob\n');              // :(glob) magic → matches nothing → ABORTS pre-fix
  w('*', 'literal asterisk\n');
  w('?', 'literal question\n');
  w('[ab]', 'literal bracket\n');
  w('back\\slash', 'literal backslash\n');       // a backslash in the name
  w('name\nwith\nnewline', 'literal newline\n'); // --pathspec-file-nul must not re-split on the newline
  w('deep/' + 'a'.repeat(200) + '.txt', 'very long path component\n');
  // a genuinely INVALID-UTF-8 filename (a 0xff byte) via a Buffer path: a STRING walk
  // decodes it to U+FFFD and feeds git the wrong bytes → silent loss. The Buffer walk
  // round-trips the exact bytes. (fs string paths can't express this, so write raw.)
  fs.writeFileSync(Buffer.concat([Buffer.from(dir + '/'), Buffer.from([0x62, 0xff, 0x62])]), 'invalid utf8 name\n');
  // a STRAY exported .git directory (nested) — git must NEVER commit anything under it.
  fs.mkdirSync(path.join(dir, 'nested', '.git'), { recursive: true });
  w('nested/.git/config', '[core]\n');
  w('nested/real.txt', 'kept beside the stray .git\n');
  fs.mkdirSync(path.join(dir, 'emptydir'), { recursive: true }); // empty dir (git can't track one)
  fs.symlinkSync('pkg/app.mjs', path.join(dir, 'link.txt'));     // committed symlink (never followed)
  // a stripped prose file replaced by the inert boot stub (must serve the stub, not real prose)
  w('docs/prompts/METHODOLOGY.md', STRIPPED_STUB);
  // the live-tree node_modules copy (must stay untracked)
  w('node_modules/leftpad/index.js', 'module.exports=1;\n');
  w('node_modules/leftpad/package.json', '{"name":"leftpad"}\n');
  return dir;
}

// A HOME holding a gitconfig whose core.excludesFile ignores *.xf — the "HOME may
// still point at a gitconfig with excludesFile" worry. The seed pins
// GIT_CONFIG_GLOBAL=/dev/null, so this must NOT reach the seed's add; we set it live
// across the seed call to PROVE it cannot matter.
function hostileExcludesHome() {
  const home = tmp('iv-hostile-home-');
  fs.writeFileSync(path.join(home, 'xf.excludes'), '*.xf\n');
  fs.writeFileSync(path.join(home, '.gitconfig'), `[core]\n\texcludesFile = ${path.join(home, 'xf.excludes')}\n`);
  return home;
}

function proveExportedFileSet(seed, label) {
  section(`CAUSE 3 / r6 — the seed commits EXACTLY the exported file set [${label}]`);
  const room = buildAttackRoom();
  // Seed under a HOSTILE HOME gitconfig (excludesFile ignores *.xf) to prove the
  // seed's /dev/null config pin makes a HOME/global excludesFile unreadable.
  const savedHome = process.env.HOME, savedXdg = process.env.XDG_CONFIG_HOME;
  const home = hostileExcludesHome();
  process.env.HOME = home; delete process.env.XDG_CONFIG_HOME;
  let r;
  try { r = seed(room); } finally { process.env.HOME = savedHome; if (savedXdg !== undefined) process.env.XDG_CONFIG_HOME = savedXdg; }
  check('seed reports ok despite the adversarial tree', r.ok, JSON.stringify(r));
  if (!r.ok) return;

  // HEAD's real tree, NUL-delimited so odd names are never quoted/split.
  const lt = gitRead(room, ['ls-tree', '-r', '-z', '--name-only', 'HEAD']);
  const head = new Set(lt.stdout.split('\0').filter(Boolean));
  const inHead = (p) => head.has(p);
  const show = (p) => gitRead(room, ['show', `HEAD:${p}`]);

  // --- the attack list, one check per item ---
  check('[tracked-but-ignored root] secret.env committed to HEAD', inHead('secret.env') && show('secret.env').stdout === 'API_KEY=273\n', [...head].join(','));
  check('[ignored directory] dist/bundle.js committed to HEAD', inHead('dist/bundle.js'), [...head].join(','));
  check('[nested .gitignore] pkg/debug.log committed to HEAD', inHead('pkg/debug.log') && show('pkg/debug.log').stdout === 'noise\n', [...head].join(','));
  check('[.gitignore files themselves] root + nested committed', inHead('.gitignore') && inHead('pkg/.gitignore'), [...head].join(','));
  check('[HOME/global excludesFile cannot matter] thing.xf committed', inHead('thing.xf'), [...head].join(','));
  check('[leading-dash name] -dashfile.txt committed to HEAD', inHead('-dashfile.txt') && show('-dashfile.txt').stdout === 'leading dash\n', [...head].join(','));
  check('[spaces in path] "a file with spaces.txt" committed', inHead('a file with spaces.txt'), [...head].join(','));
  check('[unicode in path] café/münchen.txt committed', inHead('café/münchen.txt'), [...head].join(','));
  check('[empty dir] not in HEAD (git cannot track one), seed still ok', ![...head].some((p) => p === 'emptydir' || p.startsWith('emptydir/')), [...head].join(','));
  const ltl = gitRead(room, ['ls-tree', '-r', 'HEAD', '--', 'link.txt']);
  check('[symlink] committed AS a symlink (mode 120000), target not followed', ltl.stdout.startsWith('120000 ') && show('link.txt').stdout === 'pkg/app.mjs', ltl.stdout.trim());
  const stub = show('docs/prompts/METHODOLOGY.md');
  check('[stripped stub served] HEAD:<stripped> is the inert stub, not real prose', (stub.status ?? 1) === 0 && stub.stdout === STRIPPED_STUB && !/working agreement/i.test(stub.stdout), JSON.stringify(stub.stdout.slice(0, 60)));
  check('[node_modules absent] no HEAD path under node_modules/', ![...head].some((p) => p.startsWith('node_modules/')), [...head].filter((p) => p.startsWith('node_modules/')).join(',') || '(none)');

  // --- BUG-273 r7: pathspec-magic + adversarial-byte items, one check per item ---
  check('[magic :(exclude)x] committed VERBATIM (not read as an exclude filter)', inHead(':(exclude)x') && show(':(exclude)x').stdout === 'magic exclude\n', [...head].filter((p) => p.startsWith(':')).join(','));
  check('[magic :!x] committed VERBATIM (not read as a bang-exclude)', inHead(':!x') && show(':!x').stdout === 'magic bang-exclude\n', [...head].filter((p) => p.startsWith(':')).join(','));
  check('[leading :/x] committed VERBATIM (did NOT abort the add)', inHead(':/x') && show(':/x').stdout === 'leading colon-slash\n', [...head].filter((p) => p.startsWith(':')).join(','));
  check('[magic :(glob)star] committed VERBATIM (did NOT abort the add)', inHead(':(glob)star') && show(':(glob)star').stdout === 'magic glob\n', [...head].filter((p) => p.startsWith(':')).join(','));
  check('[wildcard * ? [ab]] committed VERBATIM', inHead('*') && inHead('?') && inHead('[ab]'), [...head].filter((p) => ['*', '?', '[ab]'].includes(p)).join(','));
  check('[backslash in name] back\\slash committed', inHead('back\\slash'), [...head].filter((p) => p.includes('\\')).join(',') || '(none)');
  check('[newline in name] committed without re-splitting on the newline', inHead('name\nwith\nnewline'), JSON.stringify([...head].find((p) => p.includes('\n')) ?? null));
  check('[very long path] deep/<200×a>.txt committed', inHead('deep/' + 'a'.repeat(200) + '.txt'), '(path len ' + ('deep/' + 'a'.repeat(200) + '.txt').length + ')');
  // invalid-UTF-8: read HEAD byte-accurately (the utf8 `head` set above mangles it).
  const ltb = spawnSync('git', ['-C', room, 'ls-tree', '-r', '-z', '--name-only', 'HEAD'], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  const headBufs = []; { const b = ltb.stdout ?? Buffer.alloc(0); let s = 0; for (let i = 0; i < b.length; i++) { if (b[i] === 0) { headBufs.push(b.subarray(s, i)); s = i + 1; } } if (s < b.length) headBufs.push(b.subarray(s)); }
  const badBuf = Buffer.from([0x62, 0xff, 0x62]);
  check('[invalid-UTF-8 name] exact bytes (b<0xff>b) committed to HEAD', headBufs.some((h) => h.equals(badBuf)), headBufs.map((h) => h.toString('latin1')).filter((x) => x.includes('\xff')).join(',') || '(absent)');
  check('[stray nested .git] nothing under nested/.git committed, sibling kept', ![...head].some((p) => p === 'nested/.git/config' || p.startsWith('nested/.git/')) && inHead('nested/real.txt'), [...head].filter((p) => p.includes('.git') || p.startsWith('nested/')).join(',') || '(none)');

  const status = gitRead(room, ['status', '--porcelain']);
  check('[git status clean] after the seed', (status.status ?? 1) === 0 && status.stdout.trim() === '', `exit ${status.status}, dirty: ${JSON.stringify(status.stdout.trim().slice(0, 120))}`);
}

/* ---- r7: exclude-magic names SILENTLY DROP without literal pathspecs -------------
 * The INSIDIOUS half of the newest BROKEN verdict (the other half is the `:/`-leading
 * ABORT the comprehensive attack room covers). A room with ONLY plain files plus
 * `:(exclude)x` / `:!x`: these magic prefixes trigger NO error, so the pre-r7 seed
 * reports ok=true — but git read them as EXCLUDE filters, so the files are SILENTLY
 * absent from HEAD, and the verifier's later `git show HEAD::(exclude)x` dies 128 (the
 * INVALID class this ticket keeps re-breaking on). The post-fix seed commits them
 * verbatim. Run against BOTH the pre-r7 anchor (reddens: ok but missing) and the real
 * seed (green). */
function buildSilentDropRoom() {
  const dir = tmp('iv-room-silentdrop-');
  const w = (rel, body) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
  w('package.json', '{"name":"x","version":"1.0.0"}\n');
  w('normal.txt', 'plainly kept\n');
  w(':(exclude)x', 'must be committed verbatim, not read as an exclude\n');
  w(':!x', 'must be committed verbatim, not read as a bang-exclude\n');
  return dir;
}
function provePathspecMagicSilentDrop(seed, label) {
  section(`BUG-273 r7 — exclude-magic names SILENTLY DROP without literal pathspecs [${label}]`);
  const room = buildSilentDropRoom();
  const r = seed(room);
  // The pre-fix seed reports ok (no abort on an exclude filter) yet drops the files;
  // if a future pre-fix variant aborted instead, the ok check still reddens.
  check(`[${label}] seed reports ok (no error — exclude magic is silent)`, r.ok, JSON.stringify(r));
  if (!r.ok) return;
  const lt = gitRead(room, ['ls-tree', '-r', '-z', '--name-only', 'HEAD']);
  const head = new Set(lt.stdout.split('\0').filter(Boolean));
  const show = (p) => gitRead(room, ['show', `HEAD:${p}`]);
  check(`[${label}] :(exclude)x committed verbatim (NOT silently dropped)`, head.has(':(exclude)x') && (show(':(exclude)x').status ?? 1) === 0, [...head].join(','));
  check(`[${label}] :!x committed verbatim (NOT silently dropped)`, head.has(':!x') && (show(':!x').status ?? 1) === 0, [...head].join(','));
  check(`[${label}] plain sibling normal.txt still committed`, head.has('normal.txt'), [...head].join(','));
}

/* ------- P3 (r3 RESCOPE): seed hermeticity + honest-case decorrelation hygiene --
 * NOT a containment/exfiltration boundary. The adjudicator ran the REAL verifier
 * sandbox (`codex sandbox -c sandbox_mode=workspace-write`, cwd a scratch room) and
 * proved `cat <repo>/docs/prompts/WORKING_AGREEMENT.v4.md` and
 * `git -C <repo> show HEAD:<stripped>` BOTH return the real prose (reads are open;
 * only writes are jailed) — so a verifier reaching the live repo by absolute path or
 * `git -C <realrepo>`, or steering its own GIT_* / PATH / HOME, is OUT OF SCOPE and NOT
 * tested here. This proof covers ONLY what buildRoomGitEnv can actually enforce:
 *   (1) seed hermeticity — the room's commit is built from ONLY the stripped tree,
 *       so a CLEAN read of `git show HEAD:<stripped>` serves the inert stub even when
 *       the room was seeded under a hostile parent GIT_ALTERNATE/GIT_DIR; and
 *   (2) honest-case hygiene — a room-rooted plain `git show HEAD:<stripped>` / `git
 *       rev-parse --show-toplevel` run under the VERIFIER dispatch env (built by
 *       buildEnv) sees the room, not real-repo history leaked via inherited GIT_DIR.
 * buildEnv is the dispatch-env builder under test: the pre-fix `...process.env`
 * spread lets inherited GIT_DIR steer a room-rooted read to the real repo; the
 * chokepoint strips it. */
function realRepoFacts() {
  const cleanEnv = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const gd = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8', env: cleanEnv });
  const strippedPath = 'docs/prompts/WORKING_AGREEMENT.v4.md';
  const blob = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', `HEAD:${strippedPath}`], { encoding: 'utf8', env: cleanEnv });
  if ((gd.status ?? 1) !== 0 || (blob.status ?? 1) !== 0) return null;
  const gitDir = gd.stdout.trim();
  const stat = fs.existsSync(gitDir) && fs.statSync(gitDir).isDirectory();
  if (!stat) return null; // a worktree .git file — skip (not this repo's shape)
  return { gitDir, objects: path.join(gitDir, 'objects'), strippedPath, blob: blob.stdout.trim() };
}

// The clean-room stub that REPLACES a stripped prose file (mirrors buildCleanroom's
// boot seeding). It must NOT contain the real prose's marker ("working agreement").
const STRIPPED_STUB = '<!-- inert clean-room boot stub (BUG-273); real prose stripped -->\n';
function buildStrippedRoomTree(strippedPath) {
  const dir = buildExportedTree();
  const full = path.join(dir, strippedPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, STRIPPED_STUB);
  return dir;
}

function proveCause3Hermeticity(buildEnv, label, facts) {
  section(`CAUSE 3 / P3 — seed hermeticity + honest-case env hygiene [${label}]`);
  if (!facts) { check(`P3 [${label}] — real-repo facts available`, false, 'SKIP: could not read real .git dir/blob'); return; }

  const room = buildStrippedRoomTree(facts.strippedPath);
  // Seed under a HOSTILE parent env (GIT_DIR=<real .git>, GIT_ALTERNATE=<real
  // objects>). seedScratchGit always routes through the real buildRoomGitEnv, so a
  // POST-FIX property is that it seeds a hermetic commit DESPITE the hostile parent.
  const saved = {};
  for (const k of ['GIT_DIR', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) saved[k] = process.env[k];
  process.env.GIT_DIR = facts.gitDir;
  process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = facts.objects;
  try {
    const seed = seedScratchGit(room);
    check(`[${label}] seedScratchGit succeeds despite inherited GIT_DIR/GIT_ALTERNATE`, seed.ok, JSON.stringify(seed));

    // (1) SEED HERMETICITY — read with a TOTALLY CLEAN env (no GIT_*): the committed
    // object at the stripped path must be the inert stub, proving no real blob seeped
    // into the room's commit. (Passes both pre/post: the seed is always hermetic.)
    const clean = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    const cleanShow = spawnSync('git', ['-C', room, 'show', `HEAD:${facts.strippedPath}`], { encoding: 'utf8', env: clean });
    const cleanOk = (cleanShow.status ?? 1) === 0 && cleanShow.stdout === STRIPPED_STUB && !/working agreement/i.test(cleanShow.stdout);
    check(`[${label}] seed hermeticity: a CLEAN git show HEAD:<stripped> is the inert stub`, cleanOk, `exit ${cleanShow.status}: ${JSON.stringify(cleanShow.stdout.slice(0, 60))}`);

    // (2) HONEST-CASE HYGIENE — the VERIFIER dispatch env (built by buildEnv) must
    // leave a room-rooted read seeing the ROOM, not real-repo history inherited via
    // GIT_DIR. The pre-fix spread leaks GIT_DIR → the read resurrects real prose.
    const env = buildEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
    const roomReal = fs.realpathSync(room);

    const show = spawnSync('git', ['-C', room, 'show', `HEAD:${facts.strippedPath}`], { encoding: 'utf8', env });
    const leaked = (show.status ?? 1) === 0 && /working agreement/i.test(show.stdout);
    check(`[${label}] room-rooted git show HEAD:<stripped> is NOT steered to real prose by inherited GIT_DIR`, !leaked,
      `exit ${show.status}, ${leaked ? 'LEAKED real prose: ' + show.stdout.trim().slice(0, 60) : JSON.stringify(show.stdout.slice(0, 60)) || (show.stderr || '').trim().slice(0, 80)}`);

    const topl = spawnSync('git', ['-C', room, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', env });
    const toplOk = (topl.status ?? 1) === 0 && fs.realpathSync(topl.stdout.trim()) === roomReal;
    check(`[${label}] room-rooted rev-parse --show-toplevel is the ROOM, not the real repo`, toplOk, `toplevel=${topl.stdout.trim()} (exit ${topl.status})`);
  } finally {
    for (const k of ['GIT_DIR', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

// Direct unit assertion on the chokepoint: no inherited GIT_* survives, non-git
// env does, and `extra` wins.
function proveBuildRoomGitEnvUnit() {
  section('P3 unit — buildRoomGitEnv drops ALL inherited GIT_*, keeps non-git');
  const saved = {};
  const gitNames = ['GIT_DIR', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE', 'GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'];
  for (const k of [...gitNames, 'GITHUB_USER']) saved[k] = process.env[k];
  for (const k of gitNames) process.env[k] = '/real/leak';
  process.env.GITHUB_USER = 'keep-me'; // NOT a GIT_* name — must survive
  try {
    const env = buildRoomGitEnv({ GIT_DIR: '/room/.git', ORCHARD_LANE_SNAPSHOT: '0' });
    check('no inherited GIT_* name leaks through (except overridden GIT_DIR)',
      gitNames.filter((k) => k !== 'GIT_DIR').every((k) => env[k] === undefined) && env.GIT_DIR === '/room/.git',
      JSON.stringify(gitNames.map((k) => `${k}=${env[k]}`)));
    check('extra wins and non-git env (GITHUB_USER, PATH) is preserved',
      env.ORCHARD_LANE_SNAPSHOT === '0' && env.GITHUB_USER === 'keep-me' && env.PATH === process.env.PATH,
      `ORCHARD_LANE_SNAPSHOT=${env.ORCHARD_LANE_SNAPSHOT} GITHUB_USER=${env.GITHUB_USER}`);
  } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

/* ===================================================== DISPATCH (owner) ==== */
// r4 (P2) proof at the OWNER: dispatch.mjs's openai result loop must write a
// TYPED failureKind to --meta-out for EVERY failure branch (the fix that lets
// providerAbortKind read meta alone), never the old `see stderr taxonomy line`
// placeholder. Driven by running the REAL scripts/dispatch.mjs --provider openai
// in a subprocess with the CodexRuntime + sandbox-preflight dynamic imports
// stubbed via a module LOAD hook — so the real result loop (lines ~643-689),
// writeMeta, and the branch kinds are exercised, not re-implemented here. Node 24
// strips the .ts imports natively, so dispatch.mjs runs under plain node.
const DISPATCH = path.resolve(REPO_ROOT, 'scripts', 'dispatch.mjs');
const CODEX_STUB = `
export function detectCodex() { return { status: 'connected', command: 'codex' }; }
export class CodexRuntime {
  start() {
    // BUG-273 r5: simulate a crash AFTER dispatch's init-invalidate meta write
    // (module top-level, already run) but BEFORE the openai result loop's terminal
    // writeMeta. rt.start() runs outside the try/catch, so throwing here crashes the
    // process with the init record (nonce + failureKind:null) left on disk.
    if (process.env.STUB_CODEX_SCENARIO === 'crash-before-write') throw new Error('stub crash before terminal writeMeta');
  }
  async interrupt() {}
  close() {}
  classifyProviderError() {
    // Only the explicit provider-error scenario yields a typed provider kind;
    // every other failure scenario leaves classification to the result branch.
    return process.env.STUB_CODEX_SCENARIO === 'provider-rate-limited'
      ? { kind: 'rate-limited', retryable: true, detail: '429 from stub' } : null;
  }
  async *messages() {
    const s = process.env.STUB_CODEX_SCENARIO;
    yield { type: 'system', subtype: 'init', session_id: 'stub-sess-1' };
    if (s === 'transport') throw new Error('stub transport death');
    if (s === 'success') {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'VERDICT here' }] } };
      yield { type: 'result', is_error: false, usage: { total: 1 } };
      return;
    }
    if (s === 'provider-rate-limited' || s === 'provider-internal') { yield { type: 'result', is_error: true, result: 'boom' }; return; }
    if (s === 'interrupted') { yield { type: 'result', is_error: false, subtype: 'interrupted' }; return; }
    if (s === 'no-final-text') { yield { type: 'result', is_error: false }; return; }
  }
}
`;
const PREFLIGHT_STUB = `
export async function preflightCodexSandbox() { return { ok: true, version: 'stub-0', mode: 'read-only', cached: true }; }
export function formatPreflightFailure() { return 'stub preflight failure (unused)'; }
`;
const HOOKS_SRC = `
export async function load(url, context, nextLoad) {
  if (url.endsWith('/scripts/lib/codex-sandbox-preflight.mjs'))
    return { format: 'module', shortCircuit: true, source: ${JSON.stringify(PREFLIGHT_STUB)} };
  if (url.endsWith('/src/server/runtime/codex-runtime.ts'))
    return { format: 'module', shortCircuit: true, source: ${JSON.stringify(CODEX_STUB)} };
  return nextLoad(url, context);
}
`;

const DISPATCH_SCENARIOS = [
  { scenario: 'provider-rate-limited', wantKind: 'rate-limited', wantExit: 1, why: 'is_error branch carries the classified provider kind' },
  { scenario: 'provider-internal', wantKind: 'internal', wantExit: 1, why: 'is_error with no classification → internal' },
  { scenario: 'interrupted', wantKind: 'interrupted', wantExit: 1, why: 'subtype:interrupted branch' },
  { scenario: 'no-final-text', wantKind: 'internal', wantExit: 1, why: 'completed but no assistant message → internal' },
  { scenario: 'transport', wantKind: 'transport', wantExit: 1, why: 'messages() threw → transport catch' },
  { scenario: 'success', wantKind: null, wantExit: 0, why: 'exit 0 → failureKind null' },
];

function proveDispatchWritesTypedKind() {
  section('DISPATCH (owner) — dispatch.mjs writes a TYPED failureKind per openai branch');

  // Cheap guard: the placeholder string must be gone from the shipped source.
  const src = fs.readFileSync(DISPATCH, 'utf8');
  check('placeholder string removed from dispatch.mjs source', !src.includes('see stderr taxonomy line'),
    src.includes('see stderr taxonomy line') ? 'placeholder STILL present' : 'absent');

  const work = tmp('iv-dispatch-');
  const hooksFile = path.join(work, 'hooks.mjs');
  const registerFile = path.join(work, 'register.mjs');
  const cwdDir = path.join(work, 'cwd'); fs.mkdirSync(cwdDir, { recursive: true });
  const dataDir = path.join(work, 'data'); fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(hooksFile, HOOKS_SRC);
  fs.writeFileSync(registerFile, `import { register } from 'node:module';\nregister(${JSON.stringify('file://' + hooksFile)}, ${JSON.stringify('file://' + registerFile)});\n`);

  for (const c of DISPATCH_SCENARIOS) {
    const meta = path.join(work, `meta-${c.scenario}.json`);
    const r = spawnSync(process.execPath, ['--import', registerFile, DISPATCH,
      '--provider', 'openai', '--cwd', cwdDir, '--meta-out', meta, 'do the task'], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, STUB_CODEX_SCENARIO: c.scenario, CLAUDE_STATION_DATA: dataDir, ORCHARD_LANE_SNAPSHOT: '0' },
    });
    let m = null;
    try { m = JSON.parse(fs.readFileSync(meta, 'utf8')); } catch { /* reported below */ }
    const got = m ? m.failureKind : '(no meta written)';
    const okExit = (r.status ?? -1) === c.wantExit;
    const okKind = m && m.failureKind === c.wantKind;
    check(`[${c.scenario}] meta.failureKind = ${JSON.stringify(c.wantKind)} (${c.why})`, Boolean(okKind),
      `failureKind=${JSON.stringify(got)} exit=${r.status} ${(r.stderr || '').split('\\n').find((l) => l.includes('dispatch failed')) || ''}`.slice(0, 200));
    check(`[${c.scenario}] exit code = ${c.wantExit}`, okExit, `exit=${r.status}`);
    if (m) check(`[${c.scenario}] meta.failureKind is NOT the placeholder`, m.failureKind !== 'see stderr taxonomy line', JSON.stringify(m.failureKind));
  }
}

/* ============================== DISPATCH (owner, r5 freshness) ============ */
// r5 (P2 third break): dispatch.mjs makes meta-out freshness true BY CONSTRUCTION
// — it stamps a caller-supplied nonce into EVERY write and, as the first action
// once --meta-out is resolved, writes an init-invalidate record {nonce, exitCode:
// null, failureKind:null} that overwrites any stale file. The reader honours a
// failureKind ONLY when meta.nonce matches the nonce this invocation passed.
// These four charter cases are driven against the REAL scripts/dispatch.mjs (the
// same stub seam as proveDispatchWritesTypedKind) feeding the REAL providerAbortKind.
function proveDispatchFreshnessEndToEnd() {
  section('DISPATCH (owner, r5) — meta-out init-invalidate + nonce freshness vs the REAL dispatch.mjs');

  const work = tmp('iv-dispatch-r5-');
  const hooksFile = path.join(work, 'hooks.mjs');
  const registerFile = path.join(work, 'register.mjs');
  const cwdDir = path.join(work, 'cwd'); fs.mkdirSync(cwdDir, { recursive: true });
  const dataDir = path.join(work, 'data'); fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(hooksFile, HOOKS_SRC);
  fs.writeFileSync(registerFile, `import { register } from 'node:module';\nregister(${JSON.stringify('file://' + hooksFile)}, ${JSON.stringify('file://' + registerFile)});\n`);

  const run = (scenario, metaName, metaNonce, preseed) => {
    const meta = path.join(work, metaName);
    if (preseed !== undefined) fs.writeFileSync(meta, preseed);
    const args = ['--import', registerFile, DISPATCH, '--provider', 'openai', '--cwd', cwdDir, '--meta-out', meta];
    if (metaNonce != null) args.push('--meta-nonce', metaNonce);
    args.push('--', 'do the task');
    const r = spawnSync(process.execPath, args, {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, STUB_CODEX_SCENARIO: scenario, CLAUDE_STATION_DATA: dataDir, ORCHARD_LANE_SNAPSHOT: '0' },
    });
    let m = null, raw = null;
    try { raw = fs.readFileSync(meta, 'utf8'); m = JSON.parse(raw); } catch { /* reported by caller */ }
    return { r, meta, m, raw };
  };

  // charter case 4 — a GENUINE rate-limited abort with the MATCHING nonce → fallback once.
  {
    const NONCE = 'run-genuine-rl';
    const { r, m } = run('provider-rate-limited', 'meta-genuine.json', NONCE);
    check('[genuine rate-limited] dispatch stamped THIS run nonce + typed kind',
      Boolean(m && m.nonce === NONCE && m.failureKind === 'rate-limited'), JSON.stringify(m && { nonce: m.nonce, failureKind: m.failureKind }));
    const got = providerAbortKind({ code: r.status, meta: m, nonce: NONCE });
    check('[genuine rate-limited] providerAbortKind → fallback (rate-limited), once', got === 'rate-limited', `got ${JSON.stringify(got)}`);
  }

  // charter case 1 — a REUSED meta path holding a stale rate-limited, then a crash
  // BEFORE the terminal write. The init-invalidate overwrites the stale file with
  // {THIS run's nonce, failureKind:null}; the crash leaves that record ⇒ null.
  {
    const STALE = JSON.stringify({ provider: 'openai', nonce: 'prior-run-nonce', failureKind: 'rate-limited', exitCode: 1 }) + '\n';
    const NONCE = 'run-after-stale';
    const { r, m } = run('crash-before-write', 'meta-reused.json', NONCE, STALE);
    check('[stale+crash] dispatch crashed before the terminal write (nonzero exit)', (r.status ?? 0) !== 0, `exit=${r.status}`);
    check('[stale+crash] init-invalidate OVERWROTE the stale rate-limited (kind null, nonce = THIS run)',
      Boolean(m && m.failureKind === null && m.nonce === NONCE), JSON.stringify(m && { nonce: m.nonce, failureKind: m.failureKind }));
    const got = providerAbortKind({ code: r.status, meta: m, nonce: NONCE });
    check('[stale+crash] providerAbortKind → null (no wrong fallback on a local crash)', got === null, `got ${JSON.stringify(got)}`);
  }

  // charter case 3 — a NONCE MISMATCH. dispatch stamps a genuine provider abort with
  // nonce-A; a reader expecting a different nonce must NOT honour it.
  {
    const { r, m } = run('provider-rate-limited', 'meta-mismatch.json', 'nonce-A');
    check('[nonce mismatch] dispatch stamped nonce-A with a provider kind', Boolean(m && m.nonce === 'nonce-A' && m.failureKind === 'rate-limited'), JSON.stringify(m && { nonce: m.nonce, failureKind: m.failureKind }));
    const wrong = providerAbortKind({ code: r.status, meta: m, nonce: 'nonce-B' });
    check('[nonce mismatch] reader expecting nonce-B → null (rejects another run\'s meta)', wrong === null, `got ${JSON.stringify(wrong)}`);
    const right = providerAbortKind({ code: r.status, meta: m, nonce: 'nonce-A' });
    check('[nonce mismatch] same meta read with nonce-A → rate-limited (round-trips)', right === 'rate-limited', `got ${JSON.stringify(right)}`);
  }

  // charter case 2 — a TRUNCATED / PARTIAL meta (a concurrent writer caught mid-write;
  // disk full). Take the REAL valid meta dispatch just wrote and truncate it at several
  // byte offsets; each must JSON.parse-fail ⇒ meta null ⇒ null (mirrors runDispatch's
  // done() try/catch). A timing race is proven by grading truncations, not shapes.
  {
    const NONCE = 'run-truncate';
    const { m, raw } = run('provider-rate-limited', 'meta-full.json', NONCE);
    check('[truncation] the full valid meta is honoured (baseline)', providerAbortKind({ code: 1, meta: m, nonce: NONCE }) === 'rate-limited', JSON.stringify(m && m.failureKind));
    const full = raw ?? '';
    // Genuine partial writes: every offset is STRICTLY INSIDE the object (up to but
    // not including the final `}`), so each prefix is unparseable JSON — NOT the
    // complete-record-minus-trailing-newline, which is a valid full write.
    const closeBrace = full.lastIndexOf('}');
    const offsets = [0, 1, Math.floor(full.length / 3), Math.floor(full.length / 2), Math.floor(full.length * 0.8), closeBrace];
    let allClosed = true; const detail = [];
    for (const off of offsets) {
      let pm = null; try { pm = JSON.parse(full.slice(0, off)); } catch { pm = null; }
      const got = providerAbortKind({ code: 1, meta: pm, nonce: NONCE });
      if (got !== null) { allClosed = false; detail.push(`off=${off}→${got}`); }
    }
    check(`[truncation] every partial-write offset fails closed → null (${offsets.length} offsets inside the object)`, allClosed, allClosed ? `all ${offsets.length} null` : detail.join('; '));
  }
}

/* =============================================================== run ===== */
try {
  const facts = realRepoFacts();

  console.log('\n######## MUST-FAIL: synthesized PRE-fix (r2) behaviour (expected to FAIL) ########');
  const preStart = fail;
  proveCause1(preValidateRunForms, 'PRE-fix r2 shell-text advisory validator');
  proveCause2(preProviderAbortKind, 'PRE-fix scrape-through classifier');
  proveCause3Hermeticity(preBuildRoomGitEnv, 'PRE-fix ...process.env spread', facts);
  proveExportedFileSet(preSeedScratchGit, 'PRE-fix r6 git add -A');
  proveExportedFileSet(preR6SeedScratchGit, 'PRE-fix r7 string-walk + non-literal pathspecs');
  provePathspecMagicSilentDrop(preR6SeedScratchGit, 'PRE-fix r7 non-literal pathspecs');
  const preFailures = fail - preStart;
  console.log(`\n  PRE-fix produced ${preFailures} failure(s) — a must-FAIL proof is only real if this is > 0.`);
  const preOk = preFailures > 0;
  // Reset the counters: the pre-fix failures are EXPECTED, not real failures.
  pass = 0; fail = 0; failures.length = 0;

  console.log('\n######## POST-FIX: the real exported functions (expected to PASS) ########');
  proveCause1(validateRunForms, 'POST-FIX real');
  proveCause2(providerAbortKind, 'POST-FIX real');
  proveCause3Seed();
  proveExportedFileSet(seedScratchGit, 'POST-FIX real');
  provePathspecMagicSilentDrop(seedScratchGit, 'POST-FIX real');
  proveBuildRoomGitEnvUnit();
  proveCause3Hermeticity(buildRoomGitEnv, 'POST-FIX real', facts);
  proveDispatchWritesTypedKind();
  proveDispatchFreshnessEndToEnd();

  check('MUST-FAIL anchor held (pre-fix code reddened the suite)', preOk, `pre-fix failures: ${preFailures}`);

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  if (fail) { console.log('FAILURES:\n  - ' + failures.join('\n  - ')); process.exitCode = 1; }
} finally {
  for (const d of cleanup) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}
