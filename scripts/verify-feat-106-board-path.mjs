#!/usr/bin/env node
/**
 * FEAT-106 commit 1 — the board-path resolver.
 *
 *   node scripts/verify-feat-106-board-path.mjs
 *
 * Proves the ONE thing the whole consolidation rests on: a single resolver that
 * reads the new `.orchard/` layout AND the legacy scattered one, WITHOUT ever
 * moving or re-pointing Orchard's own board. The last is not assumed — it is
 * asserted against the REAL repo this file lives in (A-block below).
 *
 * Scratch fixtures are synthetic (there is no real onboarded `.orchard/` target
 * yet — that is commit 3), and say so; the Orchard checks use the real tree.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveOrchardDir, resolveConfigFile, readOrchardConfig,
  resolveBoardDir, boardLayout,
  resolveLibDir, resolveConventionsFile, resolveDeployContextFile, resolveStopHookFile,
} from './lib/board-path.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRATCH_ROOT = process.env.ORCHARD_SCRATCH?.trim()
  ? path.resolve(process.env.ORCHARD_SCRATCH)
  : os.tmpdir();
fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
const SCRATCH = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'feat106-'));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && observed !== undefined) console.log(`        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

/** Build a synthetic host tree from a spec of relative paths -> contents (or dir markers). */
function mkHost(name, entries) {
  const host = path.join(SCRATCH, name);
  fs.mkdirSync(host, { recursive: true });
  for (const [rel, content] of Object.entries(entries)) {
    const p = path.join(host, rel);
    if (content === '<dir>') { fs.mkdirSync(p, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return host;
}

// ── A. ORCHARD'S OWN BOARD IS UNTOUCHED (real repo, the hard constraint) ──────
console.log('\n=== A. Orchard\'s own tree resolves to its LEGACY paths, unmoved ===');
check('A1 resolveBoardDir(<orchard>) === <orchard>/docs/bugs',
  resolveBoardDir(ROOT) === path.join(ROOT, 'docs', 'bugs'), resolveBoardDir(ROOT));
check('A2 boardLayout(<orchard>) === "legacy" (repo has no .orchard/)',
  boardLayout(ROOT) === 'legacy', boardLayout(ROOT));
check('A3 the resolved board dir actually exists and holds INDEX.md',
  fs.existsSync(path.join(resolveBoardDir(ROOT), 'INDEX.md')), resolveBoardDir(ROOT));
check('A4 Orchard has NO .orchard/ dir (protection is by construction)',
  !fs.existsSync(resolveOrchardDir(ROOT)), resolveOrchardDir(ROOT));
check('A5 resolveConventionsFile(<orchard>) falls through to docs/CONVENTIONS.md',
  resolveConventionsFile(ROOT) === path.join(ROOT, 'docs', 'CONVENTIONS.md'), resolveConventionsFile(ROOT));
check('A6 resolveStopHookFile(<orchard>) falls through to scripts/hooks/response-format-gate.mjs',
  resolveStopHookFile(ROOT) === path.join(ROOT, 'scripts', 'hooks', 'response-format-gate.mjs'), resolveStopHookFile(ROOT));
check('A7 resolveLibDir(<orchard>) falls through to scripts/lib',
  resolveLibDir(ROOT) === path.join(ROOT, 'scripts', 'lib'), resolveLibDir(ROOT));

// ── B. LEGACY layout (synthetic: docs/bugs, no .orchard) ──────────────────────
console.log('\n=== B. legacy layout (synthetic) ===');
const legacy = mkHost('legacy', {
  'docs/bugs': '<dir>',
  'docs/CONVENTIONS.md': '# conv\n',
  'scripts/lib': '<dir>',
});
check('B1 resolveBoardDir -> docs/bugs', resolveBoardDir(legacy) === path.join(legacy, 'docs', 'bugs'), resolveBoardDir(legacy));
check('B2 boardLayout -> "legacy"', boardLayout(legacy) === 'legacy', boardLayout(legacy));
check('B3 resolveConventionsFile -> docs/CONVENTIONS.md',
  resolveConventionsFile(legacy) === path.join(legacy, 'docs', 'CONVENTIONS.md'), resolveConventionsFile(legacy));

// ── C. DISCOVERED layout (.orchard/bugs exists, no config) ────────────────────
console.log('\n=== C. discovered .orchard layout (synthetic) ===');
const disc = mkHost('discovered', {
  '.orchard/bugs': '<dir>',
  '.orchard/lib': '<dir>',
  '.orchard/CONVENTIONS.md': '# conv\n',
  '.orchard/DEPLOY-CONTEXT.md': '# deploy\n',
  '.orchard/hooks/response-format-gate.mjs': '// hook\n',
  // A legacy path also present, to prove .orchard WINS.
  'docs/bugs': '<dir>',
  'scripts/lib': '<dir>',
});
check('C1 resolveBoardDir -> .orchard/bugs (wins over docs/bugs)',
  resolveBoardDir(disc) === path.join(disc, '.orchard', 'bugs'), resolveBoardDir(disc));
check('C2 boardLayout -> "orchard"', boardLayout(disc) === 'orchard', boardLayout(disc));
check('C3 resolveLibDir -> .orchard/lib (wins over scripts/lib)',
  resolveLibDir(disc) === path.join(disc, '.orchard', 'lib'), resolveLibDir(disc));
check('C4 resolveConventionsFile -> .orchard/CONVENTIONS.md',
  resolveConventionsFile(disc) === path.join(disc, '.orchard', 'CONVENTIONS.md'), resolveConventionsFile(disc));
check('C5 resolveDeployContextFile -> .orchard/DEPLOY-CONTEXT.md',
  resolveDeployContextFile(disc) === path.join(disc, '.orchard', 'DEPLOY-CONTEXT.md'), resolveDeployContextFile(disc));
check('C6 resolveStopHookFile -> .orchard/hooks/response-format-gate.mjs',
  resolveStopHookFile(disc) === path.join(disc, '.orchard', 'hooks', 'response-format-gate.mjs'), resolveStopHookFile(disc));

// ── D. DECLARED layout (config.json names the board) ──────────────────────────
console.log('\n=== D. declared board via config.json (synthetic) ===');
const decl = mkHost('declared', {
  '.orchard/config.json': JSON.stringify({ layoutVersion: 1, board: '.orchard/tickets' }),
  '.orchard/tickets': '<dir>',
  '.orchard/bugs': '<dir>', // present but NOT declared — the declaration must win
});
check('D1 resolveBoardDir -> declared .orchard/tickets (wins over .orchard/bugs)',
  resolveBoardDir(decl) === path.join(decl, '.orchard', 'tickets'), resolveBoardDir(decl));
check('D2 boardLayout -> "declared"', boardLayout(decl) === 'declared', boardLayout(decl));
check('D3 readOrchardConfig returns the parsed object', readOrchardConfig(decl)?.layoutVersion === 1, readOrchardConfig(decl));
check('D4 resolveConfigFile points at .orchard/config.json',
  resolveConfigFile(decl) === path.join(decl, '.orchard', 'config.json'), resolveConfigFile(decl));
// A declaration pointing OUTSIDE the conventional spot still resolves host-relative.
const declOut = mkHost('declared-elsewhere', {
  '.orchard/config.json': JSON.stringify({ board: 'docs/issues' }),
  'docs/issues': '<dir>',
});
check('D5 a declared host-relative board outside .orchard resolves correctly',
  resolveBoardDir(declOut) === path.join(declOut, 'docs', 'issues'), resolveBoardDir(declOut));

// ── E. NONE + degraded-config robustness ──────────────────────────────────────
console.log('\n=== E. empty / broken config never wedges, falls through ===');
const none = mkHost('none', {});
check('E1 boardLayout -> "none" for an empty host', boardLayout(none) === 'none', boardLayout(none));
check('E2 resolveBoardDir still names the legacy path for an empty host',
  resolveBoardDir(none) === path.join(none, 'docs', 'bugs'), resolveBoardDir(none));
const broken = mkHost('broken-config', {
  '.orchard/config.json': '{ this is not json',
  '.orchard/bugs': '<dir>',
});
check('E3 malformed config.json is ignored, discovered .orchard/bugs used instead',
  resolveBoardDir(broken) === path.join(broken, '.orchard', 'bugs') && boardLayout(broken) === 'orchard',
  { board: resolveBoardDir(broken), layout: boardLayout(broken) });
const emptyBoard = mkHost('empty-board-decl', {
  '.orchard/config.json': JSON.stringify({ board: '   ' }),
  'docs/bugs': '<dir>',
});
check('E4 a blank/whitespace board declaration is treated as no declaration',
  resolveBoardDir(emptyBoard) === path.join(emptyBoard, 'docs', 'bugs') && boardLayout(emptyBoard) === 'legacy',
  { board: resolveBoardDir(emptyBoard), layout: boardLayout(emptyBoard) });
const arrayCfg = mkHost('array-config', { '.orchard/config.json': '[1,2,3]', 'docs/bugs': '<dir>' });
check('E5 a config.json that is a JSON array is not treated as an object',
  readOrchardConfig(arrayCfg) === null && boardLayout(arrayCfg) === 'legacy', boardLayout(arrayCfg));

// ── F. wrong-type candidate does not shadow a real legacy path ────────────────
console.log('\n=== F. a .orchard candidate of the WRONG type is not honoured ===');
const wrongType = mkHost('wrong-type', {
  '.orchard/CONVENTIONS.md': '<dir>', // a DIRECTORY where a file is expected
  'docs/CONVENTIONS.md': '# real\n',
});
check('F1 resolveConventionsFile skips a .orchard/CONVENTIONS.md that is a directory',
  resolveConventionsFile(wrongType) === path.join(wrongType, 'docs', 'CONVENTIONS.md'), resolveConventionsFile(wrongType));
const libFile = mkHost('lib-as-file', {
  '.orchard/lib': 'not a dir\n', // a FILE where a dir is expected
  'scripts/lib': '<dir>',
});
check('F2 resolveLibDir skips a .orchard/lib that is a file',
  resolveLibDir(libFile) === path.join(libFile, 'scripts', 'lib'), resolveLibDir(libFile));

// ── G. input guarding ─────────────────────────────────────────────────────────
console.log('\n=== G. invalid input is rejected, not silently mishandled ===');
for (const bad of [null, undefined, '', '   ', 42, {}]) {
  let threw = false;
  try { resolveBoardDir(bad); } catch { threw = true; }
  check(`G resolveBoardDir(${JSON.stringify(bad)}) throws TypeError`, threw, { input: bad });
}

// ── cleanup + summary ─────────────────────────────────────────────────────────
try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
if (failures.length) console.log('  failed:', failures.join(' | '));
process.exit(fail === 0 ? 0 : 1);
