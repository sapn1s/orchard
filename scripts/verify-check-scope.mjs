/**
 * FEAT-039 — scope-check verification.
 *
 *   node scripts/verify-check-scope.mjs
 *
 * Non-vacuous by construction: plants a deliberately-misfiled rule in a
 * scratch "shared WA" (a project-specific rule) and in a scratch "local doc"
 * (a universal-sounding rule), asserts `check-scope.mjs` flags BOTH — then
 * re-runs against a clean pair of fixtures and asserts it reports clean with
 * exit code 0. A checker that always says "clean" would pass the clean case
 * but fail the planted case; a checker that always flags would fail the
 * clean case — only a real heuristic passes both halves.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-scope-'));
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-scope-onboard-'));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

async function main() {
  const { checkScope, scanLocalDoc } = await import(path.join(ROOT, 'scripts', 'check-scope.mjs'));

  // ---------------------------------------------------- 1. planted misfile
  const dirtyWA = path.join(TMP, 'DIRTY_WA.md');
  fs.writeFileSync(dirtyWA, [
    '# Working Agreement',
    '',
    '## A. Build to production confidence',
    '- Never merge without tests passing.',
    '- The external-project-a Django admin panel must stay on port :8912 in dev.',
    '',
  ].join('\n'));

  const dirtyLocal = path.join(TMP, 'DIRTY_CONVENTIONS.md');
  fs.writeFileSync(dirtyLocal, [
    '# Project Conventions',
    '',
    '- This project uses the internal `widget-sync` CLI for deploys.',
    '- Every project must run its full test suite before any commit.',
    '',
  ].join('\n'));

  const dirtyReport = checkScope({ waPath: dirtyWA, localPaths: [dirtyLocal] });
  check('planted project-specific line in the shared WA is flagged',
    dirtyReport.waFindings.some((f) => f.line.includes('external-project-a')), dirtyReport.waFindings);
  check('planted universal-sounding line in the local doc is flagged',
    dirtyReport.localDocs.some((d) => d.file === dirtyLocal && d.findings.some((f) => f.line.includes('Every project'))),
    dirtyReport.localDocs);
  check('a dirty pair is reported NOT clean', dirtyReport.clean === false, dirtyReport.clean);

  // CLI exit code mirrors the programmatic report.
  let cliFailed = false;
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'check-scope.mjs'), '--wa', dirtyWA, '--local', dirtyLocal], { stdio: 'pipe' });
  } catch (err) {
    cliFailed = err.status === 1;
  }
  check('CLI exits 1 on a dirty pair', cliFailed, cliFailed);

  // ------------------------------------------------------------ 2. clean pair
  const cleanWA = path.join(TMP, 'CLEAN_WA.md');
  fs.writeFileSync(cleanWA, [
    '# Working Agreement',
    '',
    '## A. Build to production confidence',
    '- Verification is the deliverable, not the code.',
    '- Never claim done without running the relevant checks.',
    '',
  ].join('\n'));

  const cleanLocal = path.join(TMP, 'CLEAN_CONVENTIONS.md');
  fs.writeFileSync(cleanLocal, [
    '# Project Conventions (local)',
    '',
    '- This service ships a Go binary; run `go vet` before opening a PR.',
    '- The staging DB migration script lives at `tools/migrate.sh`.',
    '',
  ].join('\n'));

  const cleanReport = checkScope({ waPath: cleanWA, localPaths: [cleanLocal] });
  check('a clean shared WA has no findings', cleanReport.waFindings.length === 0, cleanReport.waFindings);
  check('a clean local doc has no findings', cleanReport.localDocs.length === 0, cleanReport.localDocs);
  check('a clean pair is reported clean', cleanReport.clean === true, cleanReport.clean);

  let cliOk = false;
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'check-scope.mjs'), '--wa', cleanWA, '--local', cleanLocal], { stdio: 'pipe' });
    cliOk = true;
  } catch {
    cliOk = false;
  }
  check('CLI exits 0 on a clean pair', cliOk, cliOk);

  // ---------------------------------------------- 3. real repo WA stays clean
  // Anti-noise regression: the heuristic must not flag the repo's own real
  // shared WA (docs/prompts/WORKING_AGREEMENT.v2.md) — a checker that's noisy
  // on the doc it's meant to protect would get ignored in practice.
  const { DEFAULT_WA_PATH } = await import(path.join(ROOT, 'scripts', 'check-scope.mjs'));
  const realReport = checkScope({ waPath: DEFAULT_WA_PATH, localPaths: [] });
  check('the REAL repo shared WA is not flagged by the heuristic (no false-positive noise)',
    realReport.waFindings.length === 0, realReport.waFindings);

  // ------------------------------------------- 4. onboard-stub false positive
  // FEAT-044's "Multi-consumer WA observations" found that onboard.mjs's OWN
  // CONVENTIONS.md stub preamble tripped the `every-project` heuristic on
  // EVERY onboarded repo (L4: "applies to every project, not just this
  // one…"). Fixed by rewording the stub in onboard.mjs (simpler + safer than
  // teaching check-scope.mjs to special-case the stub's boilerplate, which
  // would need to special-case exact wording and risks masking a REAL leak
  // that happens to reuse that wording). Prove: (a) the OLD wording used to
  // trip it (so this test is non-vacuous, not just "nothing trips"), (b) a
  // freshly onboarded scratch repo's stub does NOT trip it now, (c) a REAL
  // universal-sounding leak still trips — the detector itself is unweakened.
  const OLD_STUB_PREAMBLE = [
    '# Project Conventions (local)',
    '',
    'Project-specific rules for THIS project only. Anything universal — applies to',
    'every project, not just this one — belongs in the shared Working Agreement',
    'instead.',
    '',
  ].join('\n');
  const oldStubFindings = scanLocalDoc(OLD_STUB_PREAMBLE);
  check('sanity: the OLD (pre-fix) stub wording DID trip every-project (proves this test is non-vacuous)',
    oldStubFindings.some((f) => f.patternId === 'every-project'), oldStubFindings);

  const { onboard } = await import(path.join(ROOT, 'scripts', 'onboard.mjs'));
  const onboardedDir = path.join(SCRATCH, 'onboarded-project');
  fs.mkdirSync(onboardedDir, { recursive: true });
  onboard(onboardedDir, {});
  const stubPath = path.join(onboardedDir, 'docs', 'CONVENTIONS.md');
  const stubReport = checkScope({ waPath: DEFAULT_WA_PATH, localPaths: [stubPath] });
  check('a freshly onboarded repo\'s docs/CONVENTIONS.md stub is NOT flagged (false positive fixed)',
    !stubReport.localDocs.some((d) => d.file === stubPath), stubReport.localDocs);

  // A REAL universal-sounding leak must still trip the SAME heuristic (the
  // fix must not have weakened the pattern itself).
  fs.appendFileSync(stubPath, '\nEvery project must vendor its own lockfile.\n');
  const leakedReport = checkScope({ waPath: DEFAULT_WA_PATH, localPaths: [stubPath] });
  check('a REAL universal-sounding leak appended to that same stub still trips the detector',
    leakedReport.localDocs.some((d) => d.file === stubPath && d.findings.some((f) => f.patternId === 'every-project')),
    leakedReport.localDocs);

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});
