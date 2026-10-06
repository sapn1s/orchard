#!/usr/bin/env node
/**
 * verify-feat-106-onboard-orchard-layout.mjs — FEAT-106 stage 3 (producer
 * cutover). Proves scripts/onboard.mjs now WRITES the consolidated `.orchard/`
 * layout, and that its GUARDED cleanup of the legacy scattered layout removes
 * ONLY what Orchard provably wrote, keeps user-modified files, is dry-run by
 * default, backs up before deleting, and is idempotent.
 *
 * Everything runs in throwaway temp dirs under the OS temp root — NEVER against
 * any real repo on this machine.
 *
 * Sections:
 *   A. FRESH onboard writes the full `.orchard/` layout; NO public/ in target.
 *   B. UPGRADE of a legacy target: board declared IN PLACE (user tickets
 *      untouched, never relocated), CONVENTIONS content migrated, package.json +
 *      Stop-hook re-pointed (a customized script kept), cleanup is DRY-RUN.
 *   C. USER-MODIFIED old file SURVIVES --migrate; a matching legacy file is
 *      removed + backed up; a public/ holding a non-Orchard file is kept whole.
 *   D. IDEMPOTENT: a second onboard is all-exists; a second --migrate removes
 *      nothing new; the Stop hook is not duplicated.
 *   E. The real produced `.orchard/` hook + lib closure imports cleanly (the
 *      flatten's relative imports resolve in the real tree).
 *   F. MUST-FAIL — the PINNED pre-change onboard (a fixed commit, not a moving
 *      HEAD) writes the LEGACY layout and FAILS every new-layout assertion.
 *
 * Run: node scripts/verify-feat-106-onboard-orchard-layout.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const onboardScript = path.join(repoRoot, 'scripts', 'onboard.mjs');

// A FIXED, named revision of onboard.mjs from BEFORE this stage — the legacy
// scattered-layout producer. Pinned to a SHA (not HEAD) so committing this
// stage cannot turn the must-FAIL baseline into the fixed state (CONVENTIONS:
// "a must-FAIL proof must not be anchored to a moving baseline").
const PRECHANGE_REV = 'b637ba72c36c8f14630fa9ab7e575cbbb5b80412';

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { console.log(`PASS: ${label}`); pass++; }
  else { console.log(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
}

function runOnboard(script, targetDir, extraArgs = []) {
  try {
    const out = execFileSync('node', [script, targetDir, ...extraArgs], { encoding: 'utf8', cwd: repoRoot });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

/** Build a realistic LEGACY-layout onboarded target (scattered files, a live
 *  board with a user ticket, a filled-in CONVENTIONS, a customized npm script,
 *  a diverged tool copy, a public/ that also holds a real user file). */
function buildLegacyTarget(root) {
  const P = path.join(root, 'legacy-proj');
  fs.mkdirSync(path.join(P, 'docs', 'bugs', 'assets'), { recursive: true });
  fs.mkdirSync(path.join(P, 'scripts', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(P, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(P, 'public', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(P, '.claude'), { recursive: true });
  // Live board with a user-authored ticket.
  fs.writeFileSync(path.join(P, 'docs', 'bugs', 'README.md'), '# Bug tracker\nAPPEND-ONLY\n');
  fs.writeFileSync(path.join(P, 'docs', 'bugs', 'INDEX.md'), '# Board\n## Open\n## Done\n');
  fs.writeFileSync(path.join(P, 'docs', 'bugs', 'BUG-001-example.md'), 'USER TICKET CONTENT — must never be touched\n');
  // Filled-in local conventions (user content).
  fs.writeFileSync(path.join(P, 'docs', 'CONVENTIONS.md'), '# Project Conventions (local)\n\nMY REAL RULE: never touch port 9999.\n');
  // Legacy tool copies: board.mjs matches source (removable); arch-watch diverged (kept).
  const cp = (rel, dest) => fs.copyFileSync(path.join(repoRoot, rel), path.join(P, dest));
  cp('scripts/board.mjs', 'scripts/board.mjs');
  cp('scripts/gate.mjs', 'scripts/gate.mjs');
  cp('scripts/leak-gate.mjs', 'scripts/leak-gate.mjs');
  cp('scripts/check-nul.mjs', 'scripts/check-nul.mjs');
  cp('scripts/arch-watch.mjs', 'scripts/arch-watch.mjs');
  fs.appendFileSync(path.join(P, 'scripts', 'arch-watch.mjs'), '\n// USER LOCAL EDIT\n');
  cp('scripts/hooks/response-format-gate.mjs', 'scripts/hooks/response-format-gate.mjs');
  for (const f of ['verdict-contract', 'ticket-schema', 'board-path', 'readability', 'structure', 'format-metrics', 'leak-tokens']) {
    cp(`scripts/lib/${f}.mjs`, `scripts/lib/${f}.mjs`);
  }
  for (const f of ['response-blocks', 'digest', 'dom', 'route']) cp(`public/lib/${f}.js`, `public/lib/${f}.js`);
  // public/ also holds a real user file → the whole dir must be KEPT on cleanup.
  fs.writeFileSync(path.join(P, 'public', 'index.html'), '<html>real app</html>\n');
  // package.json: two legacy values + one customized + an unrelated script.
  fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({
    name: 'legacy-proj', version: '1.0.0',
    scripts: {
      'board:check': 'node scripts/board.mjs check',
      'board:gen': 'node scripts/board.mjs gen',
      'arch:watch': 'MY CUSTOM arch watch',
      test: 'vitest',
    },
  }, null, 2) + '\n');
  // .claude/settings.json with the legacy Stop-hook command + an unrelated key.
  fs.writeFileSync(path.join(P, '.claude', 'settings.json'), JSON.stringify({
    $schema: 'x', env: { FOO: 'bar' },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/scripts/hooks/response-format-gate.mjs"', timeout: 5 }] }] },
  }, null, 2) + '\n');
  return P;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feat106-onboard-'));
let prechangeScript = null;

try {
  // =====================================================================
  // A. FRESH onboard → full `.orchard/` layout, no public/.
  // =====================================================================
  const fresh = path.join(tmpRoot, 'fresh');
  fs.mkdirSync(fresh, { recursive: true });
  fs.writeFileSync(path.join(fresh, 'package.json'), JSON.stringify({ name: 'fresh', version: '0.0.0', scripts: {} }, null, 2) + '\n');
  const a = runOnboard(onboardScript, fresh);
  check('A fresh onboard exits 0', a.code === 0, a.out);
  for (const rel of ['.orchard/bugs/README.md', '.orchard/bugs/INDEX.md', '.orchard/config.json', '.orchard/.gitignore', '.orchard/CONVENTIONS.md', '.orchard/board.mjs', '.orchard/arch-watch.mjs', '.orchard/gate.mjs', '.orchard/leak-gate.mjs', '.orchard/check-nul.mjs', '.orchard/hooks/response-format-gate.mjs', '.orchard/lib/board-path.mjs', '.orchard/lib/digest.js', '.orchard/lib/dom.js', '.orchard/lib/response-blocks.js', '.orchard/lib/leak-tokens.mjs', 'CLAUDE.md']) {
    check(`A ${rel} written`, fs.existsSync(path.join(fresh, rel)));
  }
  check('A NO public/ written to a fresh target (the deploy-leak this ticket exists to stop)', !fs.existsSync(path.join(fresh, 'public')));
  check('A NO scattered scripts/board.mjs (all tools under .orchard/)', !fs.existsSync(path.join(fresh, 'scripts', 'board.mjs')));
  const freshCfg = JSON.parse(fs.readFileSync(path.join(fresh, '.orchard', 'config.json'), 'utf8'));
  check('A config.json declares board=.orchard/bugs + layoutVersion', freshCfg.board === '.orchard/bugs' && typeof freshCfg.layoutVersion === 'number', JSON.stringify(freshCfg));
  const freshPkg = JSON.parse(fs.readFileSync(path.join(fresh, 'package.json'), 'utf8'));
  check('A package.json values point at .orchard/', freshPkg.scripts['board:check'] === 'node .orchard/board.mjs check' && freshPkg.scripts['gate'] === 'node .orchard/gate.mjs');
  // The produced board tool runs from .orchard/ (its ./lib/* imports resolve).
  const bc = execFileSync('node', [path.join(fresh, '.orchard', 'board.mjs'), 'check', `--dir=${path.join(fresh, '.orchard', 'bugs')}`], { encoding: 'utf8', cwd: fresh });
  check('A produced .orchard/board.mjs check runs green (resolves ./lib in flat layout)', /OK — no drift/.test(bc), bc);
  check('A copied .orchard/board.mjs is byte-identical to source', fs.readFileSync(path.join(fresh, '.orchard', 'board.mjs')).equals(fs.readFileSync(path.join(repoRoot, 'scripts', 'board.mjs'))));

  // =====================================================================
  // B. UPGRADE of a legacy target — dry-run cleanup, board declared in place.
  // =====================================================================
  const P = buildLegacyTarget(tmpRoot);
  const ticketBefore = fs.readFileSync(path.join(P, 'docs', 'bugs', 'BUG-001-example.md'), 'utf8');
  const b = runOnboard(onboardScript, P);
  check('B upgrade onboard exits 0', b.code === 0, b.out);
  check('B legacy board NOT relocated (.orchard/bugs not created)', !fs.existsSync(path.join(P, '.orchard', 'bugs')));
  check('B user ticket in docs/bugs untouched', fs.readFileSync(path.join(P, 'docs', 'bugs', 'BUG-001-example.md'), 'utf8') === ticketBefore);
  const upCfg = JSON.parse(fs.readFileSync(path.join(P, '.orchard', 'config.json'), 'utf8'));
  check('B config.json declares the legacy board IN PLACE (board=docs/bugs)', upCfg.board === 'docs/bugs', JSON.stringify(upCfg));
  check('B user CONVENTIONS content migrated into .orchard/CONVENTIONS.md', /port 9999/.test(fs.readFileSync(path.join(P, '.orchard', 'CONVENTIONS.md'), 'utf8')));
  const upPkg = JSON.parse(fs.readFileSync(path.join(P, 'package.json'), 'utf8'));
  check('B package.json legacy values re-pointed to .orchard/', upPkg.scripts['board:check'] === 'node .orchard/board.mjs check' && upPkg.scripts['board:gen'] === 'node .orchard/board.mjs gen');
  check('B customized npm script left untouched', upPkg.scripts['arch:watch'] === 'MY CUSTOM arch watch');
  check('B unrelated npm script left untouched', upPkg.scripts['test'] === 'vitest');
  const upSettings = fs.readFileSync(path.join(P, '.claude', 'settings.json'), 'utf8');
  check('B Stop-hook command re-pointed to .orchard/hooks', upSettings.includes('.orchard/hooks/response-format-gate.mjs') && !upSettings.includes('scripts/hooks/response-format-gate.mjs'));
  check('B unrelated settings key preserved', /"FOO": ?"bar"/.test(upSettings));
  check('B cleanup is DRY-RUN by default (nothing removed yet)', fs.existsSync(path.join(P, 'scripts', 'board.mjs')) && /would remove/.test(b.out), b.out);
  check('B dry-run REPORTS the diverged arch-watch as KEPT (not removable)', /KEPT[\s\S]*scripts\/arch-watch\.mjs/.test(b.out), b.out);

  // =====================================================================
  // C. --migrate: user-modified survives, matching removed + backed up, public kept.
  // =====================================================================
  const divergedArchBefore = fs.readFileSync(path.join(P, 'scripts', 'arch-watch.mjs'), 'utf8');
  const m = runOnboard(onboardScript, P, ['--migrate']);
  check('C --migrate exits 0', m.code === 0, m.out);
  check('C matching legacy scripts/board.mjs REMOVED', !fs.existsSync(path.join(P, 'scripts', 'board.mjs')));
  check('C user-modified scripts/arch-watch.mjs SURVIVES', fs.existsSync(path.join(P, 'scripts', 'arch-watch.mjs')) && fs.readFileSync(path.join(P, 'scripts', 'arch-watch.mjs'), 'utf8') === divergedArchBefore);
  check('C public/ (holds a user index.html) KEPT WHOLE', fs.existsSync(path.join(P, 'public', 'index.html')) && fs.existsSync(path.join(P, 'public', 'lib', 'dom.js')));
  const backups = fs.readdirSync(path.join(P, '.orchard')).filter((n) => n.startsWith('.legacy-backup-'));
  check('C a backup dir was created before deletion (reversible)', backups.length === 1, JSON.stringify(backups));
  check('C the removed board.mjs was backed up', backups.length === 1 && fs.existsSync(path.join(P, '.orchard', backups[0], 'scripts', 'board.mjs')));
  check('C legacy docs/bugs board STILL present (never in the delete set)', fs.existsSync(path.join(P, 'docs', 'bugs', 'BUG-001-example.md')));

  // =====================================================================
  // D. IDEMPOTENT.
  // =====================================================================
  const d2 = runOnboard(onboardScript, P, ['--migrate']);
  check('D second --migrate exits 0', d2.code === 0, d2.out);
  check('D second --migrate removes nothing new (no REMOVED lines)', !/REMOVED/.test(d2.out), d2.out);
  const settingsD = JSON.parse(fs.readFileSync(path.join(P, '.claude', 'settings.json'), 'utf8'));
  const stopEntries = settingsD.hooks.Stop.reduce((n, g) => n + (Array.isArray(g.hooks) ? g.hooks.length : 0), 0);
  check('D Stop hook not duplicated across runs (exactly one entry)', stopEntries === 1, String(stopEntries));
  const freshRerun = runOnboard(onboardScript, fresh);
  check('D fresh re-run is all-exists (no CREATED for .orchard/bugs)', freshRerun.code === 0 && !/CREATED\s+\.orchard\/bugs/.test(freshRerun.out), freshRerun.out);

  // =====================================================================
  // E. The produced flat `.orchard/lib` closure + hook import cleanly.
  // =====================================================================
  const libUrl = (n) => pathToFileURL(path.join(fresh, '.orchard', 'lib', n)).href;
  try {
    const digest = await import(libUrl('digest.js'));
    const blocks = await import(libUrl('response-blocks.js'));
    const bp = await import(libUrl('board-path.mjs'));
    await import(libUrl('readability.mjs'));
    await import(libUrl('format-metrics.mjs'));
    // Importing the hook resolves its static `../lib/*` imports against .orchard/lib.
    await import(pathToFileURL(path.join(fresh, '.orchard', 'hooks', 'response-format-gate.mjs')).href);
    check('E flat .orchard/lib closure + hook import without a resolution error', typeof digest.parseDigest === 'function' && typeof blocks.parseResponseBlocks === 'function' && typeof bp.resolveBoardDir === 'function');
  } catch (e) {
    check('E flat .orchard/lib closure + hook import without a resolution error', false, e.message);
  }

  // =====================================================================
  // F. MUST-FAIL — the pinned pre-change onboard writes LEGACY, fails new bar.
  // =====================================================================
  let prechangeSrc = null;
  try {
    prechangeSrc = execFileSync('git', ['show', `${PRECHANGE_REV}:scripts/onboard.mjs`], { encoding: 'utf8', cwd: repoRoot });
  } catch (e) {
    check('F pinned pre-change onboard is retrievable', false, e.message);
  }
  if (prechangeSrc) {
    // Place it inside scripts/ so its `path.resolve(__dirname,'..')` repoRoot
    // points at the real repo (it copies sources from there). It imports only
    // node builtins at that revision, so it runs standalone.
    prechangeScript = path.join(repoRoot, 'scripts', `.feat106-prechange-${process.pid}.mjs`);
    fs.writeFileSync(prechangeScript, prechangeSrc);
    const preTarget = path.join(tmpRoot, 'prechange');
    fs.mkdirSync(preTarget, { recursive: true });
    fs.writeFileSync(path.join(preTarget, 'package.json'), JSON.stringify({ name: 'pre', version: '0', scripts: {} }, null, 2) + '\n');
    const pre = runOnboard(prechangeScript, preTarget);
    check('F pinned pre-change onboard runs', pre.code === 0, pre.out);
    // The whole point: the pre-change producer does NOT satisfy the new bar.
    const newBarHolds =
      fs.existsSync(path.join(preTarget, '.orchard', 'board.mjs')) &&
      !fs.existsSync(path.join(preTarget, 'public')) &&
      JSON.parse(fs.readFileSync(path.join(preTarget, 'package.json'), 'utf8')).scripts['board:check'] === 'node .orchard/board.mjs check';
    check('F MUST-FAIL: pre-change onboard FAILS the new-layout bar (writes legacy scripts/board.mjs + public/lib, no .orchard/)', !newBarHolds,
      `orchardBoard=${fs.existsSync(path.join(preTarget, '.orchard', 'board.mjs'))} publicWritten=${fs.existsSync(path.join(preTarget, 'public'))}`);
    // And concretely, it wrote the legacy layout this stage removes.
    check('F pre-change onboard wrote legacy scripts/board.mjs (the thing this stage moves)', fs.existsSync(path.join(preTarget, 'scripts', 'board.mjs')));
    check('F pre-change onboard wrote public/lib/*.js (the deploy leak this stage stops)', fs.existsSync(path.join(preTarget, 'public', 'lib', 'dom.js')));
  }
} finally {
  if (prechangeScript) { try { fs.rmSync(prechangeScript); } catch { /* ignore */ } }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
