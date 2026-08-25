#!/usr/bin/env node
/**
 * verify-gatekeeper.mjs — FEAT-050 verification (§C, non-vacuous).
 *
 *   node scripts/verify-gatekeeper.mjs
 *   GATEKEEPER_LIVE=1 node scripts/verify-gatekeeper.mjs   # + one REAL cheap
 *       reviewer dispatch (default: anthropic/haiku; override with
 *       GATEKEEPER_LIVE_PROVIDER / GATEKEEPER_LIVE_MODEL)
 *
 * Everything runs in SCRATCH mkdtemp repos + a SCRATCH bare remote — nothing
 * global is touched, no :4317, children killed by pid only.
 *
 * Deterministic matrix (via the --fake-reviewer seam):
 *   1  planted bug regression        → BLOCK, finding named
 *   2  planted private-token leak    → BLOCK via mechanical leak-gate,
 *      reviewers skipped (deterministic short-circuit)
 *   3  planted deploy-mismatch vs a seeded docs/DEPLOY-CONTEXT.md → BLOCK;
 *      the fake only fires if the seeded context text was actually INJECTED
 *      into the reviewer prompt, so this also proves the injection path
 *   4  clean commit                  → PASS + probabilistic-bounds disclaimer
 *   5  diff size-cap                 → honest truncation note in the verdict
 *   6  empty range                   → trivial PASS
 *   7  typecheck-if-present          → failing `npm run typecheck` BLOCKs;
 *      absent script → honest SKIPPED note
 *   8  reviewer failure / unparseable output → fail-closed BLOCK
 *   9  pre-push hook: install (idempotent), a BLOCK genuinely refuses
 *      `git push` (remote ref unchanged), a PASS lets it through (remote ref
 *      advances), uninstall (idempotent), foreign hook never clobbered
 *  10  onboard --deploy-context stub: opt-in, created, idempotent
 *  11  MUST-FAIL (non-vacuity): a stubbed always-exit-0 gate lets the
 *      planted-leak commit through → the leak check FAILS against the stub,
 *      proving the suite cannot pass vacuously
 *
 * The planted leak token is assembled from split parts (same trick as
 * leak-gate.mjs itself) so THIS file never trips claude-station's own gate.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const GATE = path.join(ROOT, 'scripts', 'gatekeeper.mjs');
const ONBOARD = path.join(ROOT, 'scripts', 'onboard.mjs');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${String(observed).split('\n').slice(0, 6).join(' | ').slice(0, 400)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

function sh(cmd, args, cwd, env = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '' };
}
const git = (cwd, ...a) => sh('git', a, cwd);
const runGate = (args, cwd = ROOT, env = {}, gatePath = GATE) => sh(process.execPath, [gatePath, ...args], cwd, env);

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'gate@test.local');
  git(dir, 'config', 'user.name', 'gate-test');
  return dir;
}
function commitAll(dir, msg) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD').stdout.trim();
}

// Planted leak token, split so this file passes claude-station's own gate.
const LEAK_TOKEN = '/home/' + 'sa' + 'p' + '/secret-notes.txt';

const FAKE_REVIEWER = `#!/usr/bin/env node
// Deterministic fake reviewer (FEAT-050 --fake-reviewer seam test double).
// argv[2] = review class; full reviewer prompt arrives on stdin.
let buf = '';
process.stdin.on('data', (d) => { buf += d; });
process.stdin.on('end', () => {
  const cls = process.argv[2];
  const findings = [];
  if (cls === 'correctness' && buf.includes('PLANTED_REGRESSION_MARKER')) {
    findings.push('FINDING: app.js validate() now unconditionally returns true — planted bug regression');
  }
  // Only fires when the SEEDED deploy-context text was actually injected into
  // the prompt AND the diff hardcodes the path prod lacks — proves injection.
  if (cls === 'deploy' && buf.includes('prod has NO /opt/local-cache') && buf.includes('/opt/local-cache/state')) {
    findings.push('FINDING: app.js hardcodes /opt/local-cache, which docs/DEPLOY-CONTEXT.md declares absent in prod');
  }
  if (findings.length) { console.log('VERDICT: BLOCK'); for (const f of findings) console.log(f); }
  else console.log('VERDICT: PASS');
});
`;

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-gatekeeper-'));
  const fake = path.join(scratch, 'fake-reviewer.mjs');
  fs.writeFileSync(fake, FAKE_REVIEWER);
  const FAKE_ARGS = ['--fake-reviewer', fake];

  /* ================= repo A: the deterministic verdict matrix ============ */
  const A = initRepo(path.join(scratch, 'repo-a'));
  fs.mkdirSync(path.join(A, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(A, 'docs', 'DEPLOY-CONTEXT.md'),
    '# Deploy context (seeded fixture)\n\nprod has NO /opt/local-cache directory.\nprod listens ONLY on :8080 behind nginx.\nLOCAL_DEV_DB is NOT set in prod.\n');
  fs.writeFileSync(path.join(A, 'app.js'), 'export function validate(x) {\n  return typeof x === "string" && x.length > 0;\n}\n');
  const c0 = commitAll(A, 'base: clean app');

  console.log('\n[1] planted bug regression → BLOCK with named finding');
  fs.writeFileSync(path.join(A, 'app.js'), 'export function validate(x) {\n  // PLANTED_REGRESSION_MARKER\n  return true;\n}\n');
  commitAll(A, 'refactor validate');
  let r = runGate(['--repo', A, '--range', `${c0}..HEAD`, ...FAKE_ARGS]);
  check('regression commit → exit 1 + GATEKEEPER: BLOCK', r.code === 1 && r.out.includes('GATEKEEPER: BLOCK'), `exit ${r.code}`);
  check('regression finding named verbatim', r.out.includes('planted bug regression'), r.out.split('\n').find((l) => l.includes('FINDING')) ?? '(no FINDING line)');
  git(A, 'reset', '--hard', c0);

  console.log('\n[2] planted private-token leak → mechanical leak-gate BLOCK, reviewers skipped');
  fs.writeFileSync(path.join(A, 'notes.md'), `debug notes live in ${LEAK_TOKEN}\n`);
  commitAll(A, 'add notes');
  r = runGate(['--repo', A, '--range', `${c0}..HEAD`, ...FAKE_ARGS]);
  check('leak commit → exit 1 + BLOCK', r.code === 1 && r.out.includes('GATEKEEPER: BLOCK'), `exit ${r.code}`);
  check('leak-gate hit named (file:line + token class)', /notes\.md:1: \[home path\]/.test(r.out), r.out.split('\n').find((l) => l.includes('notes.md')) ?? '(no hit line)');
  check('LLM reviewers skipped on mechanical fail', r.out.includes('LLM reviewers were SKIPPED'), 'skip note ' + (r.out.includes('SKIPPED') ? 'present' : 'absent'));
  const leakHead = git(A, 'rev-parse', 'HEAD').stdout.trim();

  console.log('\n[11] MUST-FAIL: stubbed gate lets the planted-leak commit through → check fails');
  const stub = path.join(scratch, 'stub-gate.mjs');
  fs.writeFileSync(stub, 'console.log("GATEKEEPER: PASS"); process.exit(0);\n');
  const rs = runGate(['--repo', A, '--range', `${c0}..${leakHead}`, ...FAKE_ARGS], ROOT, {}, stub);
  const leakCheckPassesAgainst = (res) => res.code === 1 && /\[home path\]/.test(res.out);
  check('real gate: leak check passes (BLOCK observed)', leakCheckPassesAgainst(r), `exit ${r.code}`);
  check('stubbed gate: leak check FAILS as required (leak sails through, exit 0)', !leakCheckPassesAgainst(rs) && rs.code === 0, `stub exit ${rs.code}, output: ${rs.out.trim()}`);
  git(A, 'reset', '--hard', c0);

  console.log('\n[3] deploy-mismatch vs seeded DEPLOY-CONTEXT.md → BLOCK (proves context injection)');
  fs.writeFileSync(path.join(A, 'app.js'), 'export function validate(x) {\n  return typeof x === "string" && x.length > 0;\n}\nexport const CACHE = "/opt/local-cache/state";\n');
  commitAll(A, 'add cache path');
  r = runGate(['--repo', A, '--range', `${c0}..HEAD`, ...FAKE_ARGS]);
  check('deploy-mismatch commit → exit 1 + BLOCK', r.code === 1 && r.out.includes('GATEKEEPER: BLOCK'), `exit ${r.code}`);
  check('deploy finding names the mismatch (fires only if DEPLOY-CONTEXT text was injected)', r.out.includes('docs/DEPLOY-CONTEXT.md declares absent in prod'), r.out.split('\n').find((l) => l.includes('FINDING')) ?? '(no FINDING line)');
  git(A, 'reset', '--hard', c0);

  console.log('\n[4] clean commit → PASS + probabilistic-bounds disclaimer');
  fs.writeFileSync(path.join(A, 'README.md'), '# fixture app\n\nA harmless doc change.\n');
  commitAll(A, 'docs: add readme');
  r = runGate(['--repo', A, '--range', `${c0}..HEAD`, ...FAKE_ARGS]);
  check('clean commit → exit 0 + GATEKEEPER: PASS', r.code === 0 && r.out.includes('GATEKEEPER: PASS'), `exit ${r.code}`);
  check('bounds disclaimer printed (probabilistic, no guarantee)', r.out.includes('cannot') && r.out.includes('guarantee the absence of problems'), 'disclaimer ' + (r.out.includes('guarantee') ? 'present' : 'absent'));
  check('typecheck honestly SKIPPED (repo has no typecheck script)', r.out.includes('declares no `typecheck` npm script'), 'skip note ' + (r.out.includes('declares no') ? 'present' : 'absent'));
  const cleanHead = git(A, 'rev-parse', 'HEAD').stdout.trim();

  console.log('\n[5] diff size-cap → honest truncation note');
  fs.writeFileSync(path.join(A, 'big.txt'), 'harmless filler line\n'.repeat(3000));
  commitAll(A, 'add big harmless file');
  r = runGate(['--repo', A, '--range', `${cleanHead}..HEAD`, '--max-diff-bytes', '500', ...FAKE_ARGS]);
  check('big diff still PASSes (content harmless)', r.code === 0, `exit ${r.code}`);
  check('truncation note names shown/full byte counts', /TRUNCATED to 500 of \d+ bytes/.test(r.out), r.out.split('\n').find((l) => l.includes('TRUNCATED')) ?? '(no truncation line)');

  console.log('\n[6] empty range → trivial PASS');
  r = runGate(['--repo', A, '--range', 'HEAD..HEAD', ...FAKE_ARGS]);
  check('empty range → exit 0 + trivial PASS note', r.code === 0 && r.out.includes('PASS (trivial)'), `exit ${r.code}`);

  console.log('\n[8] reviewer failure / unparseable output → fail-closed BLOCK');
  const badFake = path.join(scratch, 'fake-crash.mjs');
  fs.writeFileSync(badFake, 'process.stdin.resume(); process.stdin.on("end", () => process.exit(3));\n');
  r = runGate(['--repo', A, '--range', `${c0}..${cleanHead}`, '--classes', 'correctness', '--fake-reviewer', badFake]);
  check('crashing reviewer → BLOCK naming the failure', r.code === 1 && r.out.includes('reviewer dispatch exited 3'), `exit ${r.code}`);
  const noVerdictFake = path.join(scratch, 'fake-noverdict.mjs');
  fs.writeFileSync(noVerdictFake, 'process.stdin.resume(); process.stdin.on("end", () => { console.log("looks fine to me!"); });\n');
  r = runGate(['--repo', A, '--range', `${c0}..${cleanHead}`, '--classes', 'correctness', '--fake-reviewer', noVerdictFake]);
  check('no-VERDICT reviewer output → fail-closed BLOCK', r.code === 1 && r.out.includes('no VERDICT line'), `exit ${r.code}`);

  /* ================= repo C: typecheck-if-present ======================== */
  console.log('\n[7] typecheck-if-present: failing `npm run typecheck` BLOCKs');
  const C = initRepo(path.join(scratch, 'repo-c'));
  fs.writeFileSync(path.join(C, 'lib.js'), 'export const ok = 1;\n');
  fs.writeFileSync(path.join(C, 'package.json'), JSON.stringify({
    name: 'gate-fixture-c', private: true,
    scripts: { typecheck: 'node -e "console.error(\'lib.js(1,14): error TS2322: planted type error\'); process.exit(1)"' },
  }, null, 2));
  const cc0 = commitAll(C, 'base');
  fs.writeFileSync(path.join(C, 'lib.js'), 'export const ok = 2;\n');
  commitAll(C, 'bump');
  r = runGate(['--repo', C, '--range', `${cc0}..HEAD`, ...FAKE_ARGS]);
  check('failing typecheck → exit 1 + BLOCK with the verbatim error', r.code === 1 && r.out.includes('planted type error'), `exit ${r.code}`);

  /* ================= repo B: pre-push hook, scratch bare remote ========== */
  console.log('\n[9] pre-push hook against a scratch bare remote');
  const bare = path.join(scratch, 'remote.git');
  sh('git', ['init', '--bare', '-b', 'main', bare], scratch);
  const B = initRepo(path.join(scratch, 'repo-b'));
  fs.mkdirSync(path.join(B, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(B, 'docs', 'DEPLOY-CONTEXT.md'), 'prod has NO /opt/local-cache directory.\n');
  fs.writeFileSync(path.join(B, 'app.js'), 'export const v = 1;\n');
  const b0 = commitAll(B, 'base');
  git(B, 'remote', 'add', 'origin', bare);

  r = runGate(['--install-hook', '--repo', B]);
  const hookFile = path.join(B, '.git', 'hooks', 'pre-push');
  check('hook installed + executable + marked', r.code === 0 && fs.existsSync(hookFile) && (fs.statSync(hookFile).mode & 0o100) !== 0 && fs.readFileSync(hookFile, 'utf8').includes('FEAT-050'), r.out.trim());
  r = runGate(['--install-hook', '--repo', B]);
  check('re-install idempotent (identical, not duplicated)', r.code === 0 && r.out.includes('already installed (identical)'), r.out.trim());

  // First push is the new-branch case (remote sha = zeros): clean → allowed.
  const HOOK_ENV = { GATEKEEPER_ARGS: `--fake-reviewer ${fake}` };
  r = sh('git', ['push', '-u', 'origin', 'main'], B, HOOK_ENV);
  check('initial clean push allowed through hook (new-branch range)', r.code === 0 && sh('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/main'], scratch).stdout.trim() === b0, `exit ${r.code}`);

  fs.writeFileSync(path.join(B, 'app.js'), 'export const v = 2; // PLANTED_REGRESSION_MARKER\n');
  commitAll(B, 'bad change');
  r = sh('git', ['push', 'origin', 'main'], B, HOOK_ENV);
  const remoteAfterBad = sh('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/main'], scratch).stdout.trim();
  check('BLOCK genuinely refuses `git push` (exit nonzero, remote ref unchanged)', r.code !== 0 && remoteAfterBad === b0, `push exit ${r.code}, remote at ${remoteAfterBad.slice(0, 8)} (base ${b0.slice(0, 8)})`);
  check('push refusal shows the named finding', r.out.includes('planted bug regression'), r.out.split('\n').find((l) => l.includes('FINDING')) ?? '(no FINDING line)');

  git(B, 'reset', '--hard', b0);
  fs.writeFileSync(path.join(B, 'README.md'), '# fixture b\n');
  const b1 = commitAll(B, 'good change');
  r = sh('git', ['push', 'origin', 'main'], B, HOOK_ENV);
  const remoteAfterGood = sh('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/main'], scratch).stdout.trim();
  check('PASS lets `git push` through (remote ref advances)', r.code === 0 && remoteAfterGood === b1, `push exit ${r.code}, remote at ${remoteAfterGood.slice(0, 8)}`);

  r = runGate(['--uninstall-hook', '--repo', B]);
  check('uninstall removes the hook', r.code === 0 && !fs.existsSync(hookFile), r.out.trim());
  r = runGate(['--uninstall-hook', '--repo', B]);
  check('re-uninstall is a no-op (exit 0)', r.code === 0 && r.out.includes('no-op'), r.out.trim());
  fs.writeFileSync(hookFile, '#!/bin/sh\n# someone else\'s hook\nexit 0\n');
  r = runGate(['--install-hook', '--repo', B]);
  check('foreign pre-push hook never clobbered (install refuses)', r.code !== 0 && r.out.includes('refusing') && fs.readFileSync(hookFile, 'utf8').includes("someone else"), `exit ${r.code}`);
  const ru = runGate(['--uninstall-hook', '--repo', B]);
  check('foreign pre-push hook never removed (uninstall refuses)', ru.code !== 0 && fs.existsSync(hookFile), `exit ${ru.code}`);

  /* ================= [10] onboard --deploy-context stub ================== */
  console.log('\n[10] onboard --deploy-context stub (opt-in, idempotent)');
  const E1 = path.join(scratch, 'onboard-with-flag');
  const E2 = path.join(scratch, 'onboard-without-flag');
  fs.mkdirSync(E1); fs.mkdirSync(E2);
  r = sh(process.execPath, [ONBOARD, E1, '--no-board', '--deploy-context'], ROOT);
  const stubPath = path.join(E1, 'docs', 'DEPLOY-CONTEXT.md');
  check('stub created with flag', r.code === 0 && fs.existsSync(stubPath) && fs.readFileSync(stubPath, 'utf8').includes('gatekeeper'), r.out.split('\n').find((l) => l.includes('DEPLOY-CONTEXT')) ?? '(no report line)');
  const before = fs.readFileSync(stubPath, 'utf8');
  r = sh(process.execPath, [ONBOARD, E1, '--no-board', '--deploy-context'], ROOT);
  check('re-run idempotent (exists, byte-untouched)', r.code === 0 && /DEPLOY-CONTEXT.*exists/.test(r.out) && fs.readFileSync(stubPath, 'utf8') === before, r.out.split('\n').find((l) => l.includes('DEPLOY-CONTEXT')) ?? '(no report line)');
  r = sh(process.execPath, [ONBOARD, E2, '--no-board'], ROOT);
  check('without flag: no stub (opt-in)', r.code === 0 && !fs.existsSync(path.join(E2, 'docs', 'DEPLOY-CONTEXT.md')), 'stub absent');

  /* ================= optional LIVE run (one real cheap dispatch) ========= */
  if (process.env.GATEKEEPER_LIVE === '1') {
    const provider = process.env.GATEKEEPER_LIVE_PROVIDER || 'anthropic';
    const model = process.env.GATEKEEPER_LIVE_MODEL || (provider === 'anthropic' ? 'haiku' : '');
    console.log(`\n[live] ONE real reviewer dispatch (${provider}${model ? `/${model}` : ''}, single class — modest spend)`);
    r = runGate([
      '--repo', A, '--range', `${c0}..${cleanHead}`, '--classes', 'correctness',
      '--reviewer-provider', provider, ...(model ? ['--model', model] : []), '--timeout-min', '5',
    ]);
    check('live: real reviewer produced a parsed verdict on the clean commit', (r.code === 0 && r.out.includes('GATEKEEPER: PASS')) || (r.code === 1 && r.out.includes('GATEKEEPER: BLOCK')), `exit ${r.code}: ${r.out.split('\n').find((l) => l.startsWith('GATEKEEPER'))}`);
    check('live: clean doc-only commit PASSed', r.code === 0, `exit ${r.code}`);
  } else {
    console.log('\n[live] SKIPPED — set GATEKEEPER_LIVE=1 for one real cheap reviewer dispatch');
  }

  /* ================= summary ============================================ */
  console.log(`\nverify-gatekeeper: ${pass} PASS, ${fail} FAIL${fail ? ` — failed: ${failures.join('; ')}` : ''}`);
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

await main();
