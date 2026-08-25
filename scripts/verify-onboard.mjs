#!/usr/bin/env node
/**
 * verify-onboard.mjs — proves scripts/onboard.mjs (FEAT-038) actually does
 * what it claims, in a throwaway TEMP project dir (never touches the real
 * repo's own docs/bugs, never touches :4317 — this test spawns no server).
 *
 * (a) fresh run creates docs/bugs/{README,INDEX,TEMPLATE}.md, CLAUDE.md,
 *     docs/CONVENTIONS.md, and a working scripts/board.mjs + board:check /
 *     board:gen npm scripts wired into the target's package.json.
 * (b) the copied board:check actually works (exit 0 on the fresh, ticket-
 *     less board it just scaffolded).
 * (c) re-running onboard on the SAME dir is a safe no-op: every artifact
 *     reports "exists" (not re-created), and — the real idempotency bar —
 *     a hand-edited CLAUDE.md is NOT clobbered by the second run.
 * (d) re-running does not duplicate the board:check/board:gen npm script
 *     keys or corrupt package.json.
 * (e) --no-board skips the docs/bugs scaffold entirely (opt-out honored).
 * (f) --force-board-tool re-syncs a diverged copied board.mjs back to this
 *     repo's source; a plain re-run (no flag) leaves a diverged copy alone.
 *
 * Run: node scripts/verify-onboard.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const onboardScript = path.join(repoRoot, 'scripts', 'onboard.mjs');
const boardScript = path.join(repoRoot, 'scripts', 'board.mjs');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) {
    console.log(`PASS: ${label}`);
    pass++;
  } else {
    console.log(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
    fail++;
  }
}

function runOnboard(targetDir, extraArgs = []) {
  try {
    const out = execFileSync('node', [onboardScript, targetDir, ...extraArgs], {
      encoding: 'utf8',
      cwd: repoRoot,
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

function runBoardCheck(dir) {
  try {
    const out = execFileSync('node', [path.join(dir, 'scripts', 'board.mjs'), 'check', `--dir=${path.join(dir, 'docs', 'bugs')}`], {
      encoding: 'utf8',
      cwd: dir,
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-verify-'));

try {
  // -------------------------------------------------------------------
  // (a)-(d): full onboard, on a target that already has a package.json
  // (the realistic case — an existing project being onboarded).
  // -------------------------------------------------------------------
  const projDir = path.join(tmpRoot, 'scratch-project');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(
    path.join(projDir, 'package.json'),
    JSON.stringify({ name: 'scratch-project', version: '0.0.0', scripts: {} }, null, 2) + '\n'
  );

  const first = runOnboard(projDir);
  check('(a) first onboard run exits 0', first.code === 0, first.out);

  const bugsDir = path.join(projDir, 'docs', 'bugs');
  const expectFiles = [
    path.join(bugsDir, 'README.md'),
    path.join(bugsDir, 'INDEX.md'),
    path.join(bugsDir, 'TEMPLATE.md'),
    path.join(projDir, 'CLAUDE.md'),
    path.join(projDir, 'docs', 'CONVENTIONS.md'),
    path.join(projDir, 'scripts', 'board.mjs'),
  ];
  for (const f of expectFiles) {
    check(`(a) created: ${path.relative(projDir, f)}`, fs.existsSync(f));
  }

  const claudeMdText = fs.readFileSync(path.join(projDir, 'CLAUDE.md'), 'utf8');
  check(
    '(a) CLAUDE.md points at the shared Working Agreement',
    claudeMdText.includes('WORKING_AGREEMENT') && claudeMdText.includes('docs/CONVENTIONS.md'),
    claudeMdText.slice(0, 200)
  );

  const readmeText = fs.readFileSync(path.join(bugsDir, 'README.md'), 'utf8');
  check('(a) docs/bugs/README.md carries the append-only discipline', readmeText.includes('APPEND-ONLY') || readmeText.includes('append-only'));

  const indexText = fs.readFileSync(path.join(bugsDir, 'INDEX.md'), 'utf8');
  check('(a) docs/bugs/INDEX.md has Open + Done tables', indexText.includes('## Open') && indexText.includes('## Done'));

  const boardCopyText = fs.readFileSync(path.join(projDir, 'scripts', 'board.mjs'), 'utf8');
  const boardSourceText = fs.readFileSync(boardScript, 'utf8');
  check('(a) copied board.mjs is byte-identical to source', boardCopyText === boardSourceText);

  const pkgAfterFirst = JSON.parse(fs.readFileSync(path.join(projDir, 'package.json'), 'utf8'));
  check(
    '(a) package.json wired with board:check + board:gen',
    pkgAfterFirst.scripts['board:check'] === 'node scripts/board.mjs check' &&
      pkgAfterFirst.scripts['board:gen'] === 'node scripts/board.mjs gen'
  );

  // (b) the copied guard actually works
  const boardCheckResult = runBoardCheck(projDir);
  check('(b) copied board:check passes on the freshly scaffolded (ticket-less) board', boardCheckResult.code === 0, boardCheckResult.out);

  // -------------------------------------------------------------------
  // (c) idempotent re-run: hand-edit CLAUDE.md, re-run, assert untouched.
  // -------------------------------------------------------------------
  const customMarker = '\n<!-- LOCAL EDIT: do not clobber -->\n';
  fs.appendFileSync(path.join(projDir, 'CLAUDE.md'), customMarker);
  const claudeMdBeforeRerun = fs.readFileSync(path.join(projDir, 'CLAUDE.md'), 'utf8');

  const second = runOnboard(projDir);
  check('(c) second onboard run exits 0', second.code === 0, second.out);
  check('(c) all artifacts report exists, not created', /EXISTS/.test(second.out) && !/CREATED\s+docs\/bugs/.test(second.out), second.out);

  const claudeMdAfterRerun = fs.readFileSync(path.join(projDir, 'CLAUDE.md'), 'utf8');
  check('(c) hand-edited CLAUDE.md is NOT clobbered by re-run', claudeMdAfterRerun === claudeMdBeforeRerun);

  // -------------------------------------------------------------------
  // (d) no duplicate/corrupted npm script keys after two runs.
  // -------------------------------------------------------------------
  const pkgAfterSecond = JSON.parse(fs.readFileSync(path.join(projDir, 'package.json'), 'utf8'));
  const scriptKeys = Object.keys(pkgAfterSecond.scripts);
  const boardCheckOccurrences = scriptKeys.filter((k) => k === 'board:check').length;
  check('(d) exactly one board:check key after two runs (no duplication)', boardCheckOccurrences === 1, JSON.stringify(scriptKeys));
  check(
    '(d) package.json still valid JSON with original fields intact',
    pkgAfterSecond.name === 'scratch-project' && pkgAfterSecond.version === '0.0.0'
  );

  // Re-running board:check after the re-run should still be clean too.
  const boardCheckAgain = runBoardCheck(projDir);
  check('(d) board:check still passes after re-run', boardCheckAgain.code === 0, boardCheckAgain.out);

  // -------------------------------------------------------------------
  // (e) --no-board opts out of the ticket board scaffold entirely.
  // -------------------------------------------------------------------
  const noBoardDir = path.join(tmpRoot, 'scratch-no-board');
  fs.mkdirSync(noBoardDir, { recursive: true });
  const noBoardRun = runOnboard(noBoardDir, ['--no-board']);
  check('(e) --no-board run exits 0', noBoardRun.code === 0, noBoardRun.out);
  check('(e) docs/bugs NOT created with --no-board', !fs.existsSync(path.join(noBoardDir, 'docs', 'bugs', 'README.md')));
  check('(e) CLAUDE.md still created with --no-board (WA pointer is independent of the board)', fs.existsSync(path.join(noBoardDir, 'CLAUDE.md')));

  // -------------------------------------------------------------------
  // (f) --force-board-tool re-syncs a diverged copy; a plain re-run doesn't.
  // -------------------------------------------------------------------
  const boardCopyPath = path.join(projDir, 'scripts', 'board.mjs');
  fs.appendFileSync(boardCopyPath, '\n// LOCAL DIVERGENCE\n');
  const divergedText = fs.readFileSync(boardCopyPath, 'utf8');

  const plainRerun = runOnboard(projDir);
  check('(f) plain re-run exits 0', plainRerun.code === 0, plainRerun.out);
  check(
    '(f) plain re-run leaves a diverged board.mjs copy alone',
    fs.readFileSync(boardCopyPath, 'utf8') === divergedText
  );

  const forcedRerun = runOnboard(projDir, ['--force-board-tool']);
  check('(f) --force-board-tool run exits 0', forcedRerun.code === 0, forcedRerun.out);
  check(
    '(f) --force-board-tool re-syncs the copy back to source',
    fs.readFileSync(boardCopyPath, 'utf8') === boardSourceText
  );

  // -------------------------------------------------------------------
  // (g) FEAT-044 follow-up — --wa-pointer: opt-in append to a
  // PRE-EXISTING CLAUDE.md only, never touching a fresh onboard-authored
  // one, absent without the flag, and idempotent (no duplicate section).
  // -------------------------------------------------------------------
  const preexistDir = path.join(tmpRoot, 'scratch-preexisting-claudemd');
  fs.mkdirSync(preexistDir, { recursive: true });
  const ownClaudeMd = '# CLAUDE.md\n\nThis repo has its own agent rules already.\n';
  fs.writeFileSync(path.join(preexistDir, 'CLAUDE.md'), ownClaudeMd);

  // Without the flag: byte-identical to a plain run (no pointer appended).
  const noFlagRun = runOnboard(preexistDir);
  check('(g) run without --wa-pointer exits 0', noFlagRun.code === 0, noFlagRun.out);
  const claudeMdNoFlag = fs.readFileSync(path.join(preexistDir, 'CLAUDE.md'), 'utf8');
  check(
    '(g) without --wa-pointer, pre-existing CLAUDE.md is byte-identical (no pointer appended)',
    claudeMdNoFlag === ownClaudeMd,
    claudeMdNoFlag
  );

  // With the flag: appends once.
  const withFlagRun = runOnboard(preexistDir, ['--wa-pointer']);
  check('(g) run with --wa-pointer exits 0', withFlagRun.code === 0, withFlagRun.out);
  const claudeMdWithFlag = fs.readFileSync(path.join(preexistDir, 'CLAUDE.md'), 'utf8');
  check(
    '(g) --wa-pointer appends a WA-pointer section to the pre-existing CLAUDE.md',
    claudeMdWithFlag.startsWith(ownClaudeMd) && claudeMdWithFlag.includes('orchard:wa-pointer:start') && claudeMdWithFlag.includes('WORKING_AGREEMENT'),
    claudeMdWithFlag
  );
  check(
    '(g) --wa-pointer never rewrote the original content (still a byte-for-byte prefix)',
    claudeMdWithFlag.startsWith(ownClaudeMd)
  );

  // Idempotent: re-run with the flag again does not duplicate the section.
  const withFlagRerun = runOnboard(preexistDir, ['--wa-pointer']);
  check('(g) second --wa-pointer run exits 0', withFlagRerun.code === 0, withFlagRerun.out);
  const claudeMdAfterPointerRerun = fs.readFileSync(path.join(preexistDir, 'CLAUDE.md'), 'utf8');
  const markerCount = (claudeMdAfterPointerRerun.match(/orchard:wa-pointer:start/g) ?? []).length;
  check('(g) re-running --wa-pointer is idempotent (exactly one marker, no duplicate section)', markerCount === 1, markerCount);
  check('(g) re-running --wa-pointer leaves content byte-identical to the first append', claudeMdAfterPointerRerun === claudeMdWithFlag);

  // A FRESH onboard-authored CLAUDE.md (no pre-existing file) already
  // contains the full pointer inline — --wa-pointer must NOT double it up.
  const freshDir = path.join(tmpRoot, 'scratch-fresh-claudemd');
  fs.mkdirSync(freshDir, { recursive: true });
  const freshRun = runOnboard(freshDir, ['--wa-pointer']);
  check('(g) --wa-pointer on a dir with no pre-existing CLAUDE.md exits 0', freshRun.code === 0, freshRun.out);
  const freshClaudeMd = fs.readFileSync(path.join(freshDir, 'CLAUDE.md'), 'utf8');
  check(
    '(g) fresh onboard-authored CLAUDE.md is not double-appended by --wa-pointer',
    (freshClaudeMd.match(/orchard:wa-pointer:start/g) ?? []).length === 0
  );
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
