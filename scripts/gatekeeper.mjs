#!/usr/bin/env node
/**
 * gatekeeper.mjs — FEAT-050: independent commit gatekeeper. A fresh-context
 * LLM verifier that judges a commit range BEFORE it is auto-pushed/deployed.
 *
 * Independence is the whole point: every invocation starts from NOTHING but
 * the range's diff + commit messages + the target repo's declared deploy
 * context (docs/DEPLOY-CONTEXT.md). It never sees the authoring session's
 * conversation state, so an author-session blind spot does not carry over.
 *
 *   node scripts/gatekeeper.mjs [--repo <dir>] [--range <A..B | rev>]
 *     [--author-provider anthropic|openai] [--reviewer-provider anthropic|openai]
 *     [--model <m>] [--classes correctness,security,deploy,consumer]
 *     [--max-diff-bytes <n>] [--timeout-min <n>] [--fake-reviewer <script>]
 *   node scripts/gatekeeper.mjs --install-hook   [--repo <dir>]
 *   node scripts/gatekeeper.mjs --uninstall-hook [--repo <dir>]
 *
 * Pipeline per run:
 *   1. MECHANICAL pre-steps (deterministic, run first, fail-closed):
 *      - scripts/leak-gate.mjs (FEAT-049) against the target repo's tree;
 *      - the target repo's own `npm run typecheck` IF its package.json
 *        declares one (skipped with an honest note otherwise).
 *      A mechanical failure BLOCKs immediately and SKIPS the LLM reviewers
 *      (no tokens spent on a commit that already failed deterministically).
 *   2. N REVIEWER dispatches — one-shot fresh-context runs through
 *      scripts/dispatch.mjs (FEAT-043: provider-routable, BUG-031 error
 *      taxonomy, read-only sandbox). One dispatch per review class, each with
 *      a class-specific prompt: correctness/regressions, security,
 *      deploy-mismatch (vs docs/DEPLOY-CONTEXT.md), consumer/API impact.
 *      Provider defaults to the OTHER provider than --author-provider
 *      (cross-provider decorrelation — ROUTING.md rule; default assumes the
 *      author was anthropic → reviewers go to openai). Both overridable.
 *   3. VERDICT: structured PASS/BLOCK with the reviewers' findings VERBATIM
 *      (BUG-031-style honesty — never a bare "failed"). Exit 0 = PASS,
 *      1 = BLOCK, 2 = usage/infra error, so any pipeline can consume it.
 *
 * Fail-closed contract: a reviewer dispatch that errors (quota, auth,
 * timeout…) or returns unparseable output counts as BLOCK with the failure
 * named — an unreviewable commit is not a passed commit.
 *
 * HONEST BOUNDS (also printed in every verdict): LLM review is
 * probabilistic. The gate REDUCES risk; it cannot guarantee the absence of
 * problems. Only the mechanical pre-steps are deterministic. The diff shown
 * to reviewers is size-capped (--max-diff-bytes, default 60000 bytes); when
 * truncated the verdict says so, because a verdict over a partial diff only
 * covers what was shown.
 *
 * Range semantics: `A..B` reviews exactly that range. A single rev R (the
 * new-branch push case, where the remote sha is all zeros) reviews every
 * commit reachable from R that no remote-tracking ref has — diffed from the
 * oldest such commit's parent (or the empty tree for a root commit). An
 * empty range is a trivial PASS ("nothing to review").
 *
 * --install-hook writes an opt-in per-repo .git/hooks/pre-push that runs
 * this gate on each outgoing ref's range; git refuses the push on BLOCK.
 * Idempotent (re-install re-syncs our own hook), refuses to clobber a
 * foreign hook, and --uninstall-hook removes exactly ours. The hook honors
 * $GATEKEEPER_ARGS for extra flags (e.g. --fake-reviewer in tests, or
 * --reviewer-provider/--model overrides).
 *
 * --fake-reviewer <script> is the deterministic test seam: instead of a
 * dispatch, `node <script> <class>` is spawned with the full reviewer prompt
 * on stdin; its stdout is parsed exactly like a real reviewer's answer.
 *
 * Scope: the gate only JUDGES. Pushing/deploying stays outside it.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
// FEAT-106 — resolve the deploy-context doc (legacy docs/DEPLOY-CONTEXT.md or
// consolidated .orchard/DEPLOY-CONTEXT.md) for the repo under review.
import { resolveDeployContextFile } from './lib/board-path.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DISPATCH = path.join(ROOT, 'scripts', 'dispatch.mjs');
const LEAK_GATE = path.join(ROOT, 'scripts', 'leak-gate.mjs');
const SELF = path.join(ROOT, 'scripts', 'gatekeeper.mjs');
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // git's well-known empty tree

const HOOK_MARKER = '# orchard-gatekeeper pre-push hook (FEAT-050)';

const USAGE = `usage: node scripts/gatekeeper.mjs [--repo <dir>] [--range <A..B|rev>]
         [--author-provider anthropic|openai] [--reviewer-provider anthropic|openai]
         [--model <m>] [--classes correctness,security,deploy,consumer]
         [--max-diff-bytes <n>] [--timeout-min <n>] [--fake-reviewer <script>]
       node scripts/gatekeeper.mjs --install-hook | --uninstall-hook [--repo <dir>]`;

function die(msg, code = 2) {
  process.stderr.write(`gatekeeper: ${msg}\n`);
  process.exit(code);
}

/* ------------------------------------------------------------------- args */

const CLASS_NAMES = ['correctness', 'security', 'deploy', 'consumer'];

const argv = process.argv.slice(2);
const opts = {
  repo: process.cwd(),
  range: null,
  authorProvider: 'anthropic',
  reviewerProvider: null, // default: the OTHER provider than the author
  model: null,
  classes: CLASS_NAMES,
  maxDiffBytes: 60_000,
  timeoutMin: 10,
  fakeReviewer: null,
  installHook: false,
  uninstallHook: false,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const take = () => {
    if (i + 1 >= argv.length) die(`${a} needs a value\n${USAGE}`);
    return argv[++i];
  };
  if (a === '--repo') opts.repo = path.resolve(take());
  else if (a === '--range') opts.range = take();
  else if (a === '--author-provider') opts.authorProvider = take();
  else if (a === '--reviewer-provider') opts.reviewerProvider = take();
  else if (a === '--model') opts.model = take();
  else if (a === '--classes') opts.classes = take().split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--max-diff-bytes') opts.maxDiffBytes = Number(take());
  else if (a === '--timeout-min') opts.timeoutMin = Number(take());
  else if (a === '--fake-reviewer') opts.fakeReviewer = path.resolve(take());
  else if (a === '--install-hook') opts.installHook = true;
  else if (a === '--uninstall-hook') opts.uninstallHook = true;
  else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
  else die(`unknown argument ${a}\n${USAGE}`);
}
for (const p of ['authorProvider']) {
  if (opts[p] !== 'anthropic' && opts[p] !== 'openai') die(`--author-provider must be anthropic|openai (got ${opts[p]})`);
}
if (opts.reviewerProvider !== null && opts.reviewerProvider !== 'anthropic' && opts.reviewerProvider !== 'openai') {
  die(`--reviewer-provider must be anthropic|openai (got ${opts.reviewerProvider})`);
}
if (!opts.reviewerProvider) opts.reviewerProvider = opts.authorProvider === 'anthropic' ? 'openai' : 'anthropic';
for (const c of opts.classes) {
  if (!CLASS_NAMES.includes(c)) die(`unknown review class '${c}' (known: ${CLASS_NAMES.join(', ')})`);
}
if (!Number.isFinite(opts.maxDiffBytes) || opts.maxDiffBytes <= 0) die('--max-diff-bytes must be a positive number');
if (!Number.isFinite(opts.timeoutMin) || opts.timeoutMin <= 0) die('--timeout-min must be a positive number');

/* -------------------------------------------------------------- git utils */

function git(repo, ...args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
function gitOk(repo, ...args) {
  const r = git(repo, ...args);
  if (r.code !== 0) die(`git ${args.join(' ')} failed in ${repo}: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}

/** Resolve --range into {base, head, commits[]} or null when empty. */
function resolveRange(repo, range) {
  if (range && range.includes('..')) {
    const [base, head] = range.split(/\.{2,3}/);
    const commits = gitOk(repo, 'rev-list', `${base}..${head}`).trim().split('\n').filter(Boolean);
    return commits.length ? { base, head, commits } : null;
  }
  // Single rev (or default HEAD): everything reachable that no remote has.
  const head = range || 'HEAD';
  const commits = gitOk(repo, 'rev-list', head, '--not', '--remotes').trim().split('\n').filter(Boolean);
  if (!commits.length) return null;
  const oldest = commits[commits.length - 1];
  const parent = git(repo, 'rev-parse', '--verify', '--quiet', `${oldest}^`);
  const base = parent.code === 0 ? parent.stdout.trim() : EMPTY_TREE;
  return { base, head, commits };
}

/* ------------------------------------------------------- hook install/rm */

function hookPath(repo) {
  const gitDir = gitOk(repo, 'rev-parse', '--git-dir').trim();
  return path.join(path.isAbsolute(gitDir) ? gitDir : path.join(repo, gitDir), 'hooks', 'pre-push');
}

function hookScript() {
  return `#!/bin/sh
${HOOK_MARKER}
# Installed by: node ${SELF} --install-hook
# Remove with:  node ${SELF} --uninstall-hook --repo <this repo>
# Runs the FEAT-050 independent gatekeeper on every outgoing ref's commit
# range; git refuses the push when the gate BLOCKs (nonzero exit).
# Extra flags (e.g. --fake-reviewer for tests, --reviewer-provider/--model)
# can be passed via the GATEKEEPER_ARGS environment variable.
zero=0000000000000000000000000000000000000000
status=0
while read local_ref local_sha remote_ref remote_sha; do
  [ "$local_sha" = "$zero" ] && continue # deleting a remote ref: nothing to review
  if [ "$remote_sha" = "$zero" ]; then
    range="$local_sha" # new remote ref: gatekeeper reviews what no remote has
  else
    range="$remote_sha..$local_sha"
  fi
  node "${SELF}" --repo "$(git rev-parse --show-toplevel)" --range "$range" $GATEKEEPER_ARGS || status=1
done
exit $status
`;
}

function installHook(repo) {
  const file = hookPath(repo);
  const wanted = hookScript();
  if (fs.existsSync(file)) {
    const cur = fs.readFileSync(file, 'utf8');
    if (!cur.includes(HOOK_MARKER)) {
      die(`refusing to overwrite an existing non-gatekeeper pre-push hook at ${file} — remove/merge it manually`, 2);
    }
    if (cur === wanted) {
      console.log(`gatekeeper hook: already installed (identical) — ${file}`);
      return;
    }
    fs.writeFileSync(file, wanted, { mode: 0o755 });
    console.log(`gatekeeper hook: re-synced existing gatekeeper hook — ${file}`);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, wanted, { mode: 0o755 });
  console.log(`gatekeeper hook: installed — ${file}`);
}

function uninstallHook(repo) {
  const file = hookPath(repo);
  if (!fs.existsSync(file)) {
    console.log(`gatekeeper hook: nothing installed at ${file} (no-op)`);
    return;
  }
  const cur = fs.readFileSync(file, 'utf8');
  if (!cur.includes(HOOK_MARKER)) {
    die(`pre-push hook at ${file} is not the gatekeeper's — refusing to remove it`, 2);
  }
  fs.unlinkSync(file);
  console.log(`gatekeeper hook: removed — ${file}`);
}

/* ------------------------------------------------------ mechanical steps */

function runNode(script, args, cwd, extraEnv = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...extraEnv },
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function mechanicalSteps(repo) {
  const results = [];

  // 1. leak gate (FEAT-049) — deterministic private-token scan of the repo tree.
  const leak = runNode(LEAK_GATE, [], repo);
  results.push({
    name: 'leak-gate (scripts/leak-gate.mjs)',
    ok: leak.code === 0,
    detail: (leak.code === 0 ? leak.stdout : `${leak.stderr}${leak.stdout}`).trim(),
  });

  // 2. typecheck, if the target repo declares one.
  const pkgPath = path.join(repo, 'package.json');
  let typecheck = null;
  try { typecheck = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))?.scripts?.typecheck ?? null; } catch { /* no/bad package.json */ }
  if (typecheck) {
    const r = spawnSync('npm', ['run', '--silent', 'typecheck'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const code = r.status ?? 1;
    results.push({
      name: `typecheck (npm run typecheck: ${typecheck})`,
      ok: code === 0,
      detail: code === 0 ? 'clean' : `exit ${code}\n${(r.stdout + r.stderr).trim()}`.trim(),
    });
  } else {
    results.push({ name: 'typecheck', ok: true, detail: 'SKIPPED — target repo declares no `typecheck` npm script (nothing mechanical to run)' });
  }
  return results;
}

/* ---------------------------------------------------------- reviewer run */

const CLASS_PROMPTS = {
  correctness: `You are an independent CORRECTNESS reviewer for a commit that is about to be pushed/deployed. You have NO context beyond what is in this message — that is deliberate. Hunt for: logic bugs, regressions of existing behavior, broken edge cases, off-by-ones, error paths that now silently swallow, dead/unreachable code the diff introduces.`,
  security: `You are an independent SECURITY reviewer for a commit that is about to be pushed/deployed. You have NO context beyond what is in this message — that is deliberate. Hunt for: leaked secrets/tokens/credentials/private paths, injection (shell/SQL/path), unsafe deserialization or eval, permission/authz weakening, unsafe defaults, data exposure in logs or error messages.`,
  deploy: `You are an independent DEPLOYMENT-MISMATCH reviewer for a commit that is about to be pushed/deployed. You have NO context beyond what is in this message — that is deliberate. The DEPLOY CONTEXT section below declares what the production/public environment ACTUALLY looks like. Hunt for changes that assume the author's LOCAL setup: hardcoded local paths/ports/hosts, env vars prod does not set, services/files prod does not have, anything that works on the author's machine but contradicts the declared deploy context.`,
  consumer: `You are an independent CONSUMER-IMPACT reviewer for a commit that is about to be pushed/deployed. You have NO context beyond what is in this message — that is deliberate. Hunt for breaking changes to anything external code may depend on: changed/removed public APIs, CLI flags, output formats, file formats, exit codes, config keys, wire protocols — and renames/removals without a migration note.`,
};

function buildPrompt(cls, ctx) {
  return `${CLASS_PROMPTS[cls]}

RESPONSE CONTRACT — respond in EXACTLY this format, nothing before the verdict line:
VERDICT: PASS
or
VERDICT: BLOCK
FINDING: <one line per concrete finding — name the file/hunk and the problem>
Only BLOCK for concrete, named problems in the diff below. Style nits are not findings.

=== DEPLOY CONTEXT (what production actually looks like) ===
${ctx.deployContext}

=== COMMITS UNDER REVIEW (${ctx.commits.length}) ===
${ctx.messages}

=== DIFF ===${ctx.truncated ? `\n[NOTE: diff TRUNCATED at ${ctx.diff.length} of ${ctx.fullDiffBytes} bytes — you are seeing a partial diff; judge only what is shown]` : ''}
${ctx.diff}`;
}

/** Run one reviewer; resolves { cls, verdict: 'PASS'|'BLOCK', findings[], raw, failure } */
function runReviewer(cls, prompt) {
  return new Promise((resolve) => {
    let child;
    if (opts.fakeReviewer) {
      child = spawn(process.execPath, [opts.fakeReviewer, cls], { stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.write(prompt);
      child.stdin.end();
    } else {
      child = spawn(process.execPath, [
        DISPATCH,
        '--provider', opts.reviewerProvider,
        ...(opts.model ? ['--model', opts.model] : []),
        '--cwd', opts.repo,
        '--sandbox', 'read-only',
        '--timeout-min', String(opts.timeoutMin),
        '--', prompt,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    }
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.once('error', (err) => resolve({ cls, verdict: 'BLOCK', findings: [], raw: '', failure: `reviewer process not runnable: ${err.message}` }));
    child.once('exit', (code) => {
      if (code !== 0) {
        // Fail-closed: an unreviewable commit is not a passed commit. Surface
        // dispatch's own BUG-031 taxonomy line verbatim.
        const taxLine = stderr.split('\n').find((l) => l.includes('dispatch failed [')) ?? stderr.trim().split('\n').pop() ?? '';
        resolve({ cls, verdict: 'BLOCK', findings: [], raw: stdout, failure: `reviewer dispatch exited ${code}: ${taxLine.trim() || 'no error detail'}` });
        return;
      }
      const m = stdout.match(/^\s*VERDICT:\s*(PASS|BLOCK)\s*$/m);
      if (!m) {
        resolve({ cls, verdict: 'BLOCK', findings: [], raw: stdout, failure: `reviewer output had no VERDICT line (fail-closed); raw output follows:\n${stdout.trim().slice(0, 2000)}` });
        return;
      }
      const findings = stdout.split('\n').filter((l) => /^\s*FINDING:/.test(l)).map((l) => l.trim());
      resolve({ cls, verdict: m[1], findings, raw: stdout, failure: null });
    });
  });
}

/* -------------------------------------------------------------- main run */

const BOUNDS_DISCLAIMER =
  'NOTE (honest bounds): LLM review is probabilistic — this gate REDUCES risk, it cannot\n' +
  'guarantee the absence of problems. Only the mechanical pre-steps (leak-gate, typecheck)\n' +
  'are deterministic. Treat PASS as "no problems found", never as "no problems exist".';

async function main() {
  if (opts.installHook && opts.uninstallHook) die('--install-hook and --uninstall-hook are mutually exclusive');
  if (opts.installHook) { installHook(opts.repo); return; }
  if (opts.uninstallHook) { uninstallHook(opts.repo); return; }

  if (git(opts.repo, 'rev-parse', '--git-dir').code !== 0) die(`not a git repo: ${opts.repo}`);
  const repo = gitOk(opts.repo, 'rev-parse', '--show-toplevel').trim();
  opts.repo = repo;

  const range = resolveRange(repo, opts.range);
  if (!range) {
    console.log(`GATEKEEPER: PASS (trivial) — range ${opts.range ?? 'HEAD vs remotes'} contains no commits to review.`);
    console.log(BOUNDS_DISCLAIMER);
    process.exit(0);
  }

  console.log(`gatekeeper — repo ${repo}`);
  console.log(`  range: ${range.base === EMPTY_TREE ? '(empty tree)' : range.base.slice(0, 12)}..${range.head.length >= 40 ? range.head.slice(0, 12) : range.head} (${range.commits.length} commit${range.commits.length === 1 ? '' : 's'})`);
  console.log(`  reviewers: ${opts.classes.join(', ')} via ${opts.fakeReviewer ? `FAKE (${opts.fakeReviewer})` : `${opts.reviewerProvider}${opts.model ? `/${opts.model}` : ''} (author-provider ${opts.authorProvider} → cross-provider review)`}`);

  /* mechanical pre-steps */
  console.log('\n[mechanical pre-steps]');
  const mech = mechanicalSteps(repo);
  let mechFailed = false;
  for (const m of mech) {
    console.log(`  ${m.ok ? 'ok  ' : 'FAIL'}  ${m.name}`);
    if (!m.ok) {
      mechFailed = true;
      for (const line of m.detail.split('\n')) console.log(`        ${line}`);
    } else if (m.detail.startsWith('SKIPPED')) {
      console.log(`        ${m.detail}`);
    }
  }
  if (mechFailed) {
    console.log('\nGATEKEEPER: BLOCK');
    console.log('Mechanical pre-step failed (deterministic) — LLM reviewers were SKIPPED (no tokens');
    console.log('spent on a commit that already failed a deterministic check). Findings above, verbatim.');
    console.log(`\n${BOUNDS_DISCLAIMER}`);
    process.exit(1);
  }

  /* gather review material */
  const fullDiff = gitOk(repo, 'diff', range.base, range.head);
  const messages = gitOk(repo, 'log', '--format=%h %s%n%b', `${range.base === EMPTY_TREE ? '' : range.base + '..'}${range.head}`).trim();
  const truncated = Buffer.byteLength(fullDiff, 'utf8') > opts.maxDiffBytes;
  const diff = truncated ? fullDiff.slice(0, opts.maxDiffBytes) : fullDiff;

  const deployCtxPath = resolveDeployContextFile(repo);
  const deployCtxRel = path.relative(repo, deployCtxPath).split(path.sep).join('/');
  const deployContext = fs.existsSync(deployCtxPath)
    ? fs.readFileSync(deployCtxPath, 'utf8')
    : `(This repo declares NO ${deployCtxRel} — the production environment is UNDECLARED. Deployment assumptions cannot be checked against a known prod setup; flag any change that only works with a specific local setup.)`;

  if (truncated) {
    console.log(`\n  NOTE: diff truncated to ${opts.maxDiffBytes} of ${Buffer.byteLength(fullDiff, 'utf8')} bytes for reviewers — the verdict below covers ONLY the shown portion.`);
  }

  /* reviewer dispatches (sequential — modest, predictable token spend) */
  console.log('\n[reviewers]');
  const ctx = { deployContext, commits: range.commits, messages, diff, truncated, fullDiffBytes: Buffer.byteLength(fullDiff, 'utf8') };
  const results = [];
  for (const cls of opts.classes) {
    process.stdout.write(`  ${cls}… `);
    const r = await runReviewer(cls, buildPrompt(cls, ctx));
    results.push(r);
    console.log(r.failure ? 'FAILED (counts as BLOCK)' : r.verdict);
  }

  /* verdict */
  const blocked = results.filter((r) => r.verdict === 'BLOCK');
  console.log(`\nGATEKEEPER: ${blocked.length ? 'BLOCK' : 'PASS'}`);
  for (const r of results) {
    if (r.verdict === 'PASS') { console.log(`  [${r.cls}] PASS`); continue; }
    console.log(`  [${r.cls}] BLOCK`);
    if (r.failure) console.log(`    ${r.failure.split('\n').join('\n    ')}`);
    for (const f of r.findings) console.log(`    ${f}`);
    if (!r.failure && !r.findings.length) console.log(`    (reviewer BLOCKed without FINDING lines; raw output:)\n    ${r.raw.trim().split('\n').join('\n    ')}`);
  }
  if (truncated) console.log(`  [diff] TRUNCATED to ${opts.maxDiffBytes} of ${ctx.fullDiffBytes} bytes — verdict covers only the shown portion.`);
  console.log(`\n${BOUNDS_DISCLAIMER}`);
  process.exit(blocked.length ? 1 : 0);
}

await main();
