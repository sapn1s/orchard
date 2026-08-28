#!/usr/bin/env node
/**
 * FEAT-106 commit 3 — "readers route through the resolver".
 *
 * Proves every board / conventions / deploy-context / stop-hook READER finds a
 * project's artifacts in BOTH layouts — legacy (docs/, scripts/) and the
 * consolidated `.orchard/` — and that a legacy project behaves EXACTLY as before
 * (this commit is a behaviour no-op; onboard still writes the legacy layout).
 *
 * Fixtures are REALISTIC: each board is a byte copy of this repo's real
 * docs/bugs (244 tickets, a busy mixed-state board), placed at docs/bugs for the
 * legacy host and at .orchard/bugs for the flat host, so the reader must ROUTE
 * to the right directory and parse a real board — not a two-ticket toy.
 *
 * Must-FAIL: run this file with the pre-change server modules restored and the
 * flat-layout assertions (2b/3b/5b/6b) FAIL — see the lane's log for the recipe.
 *
 * Scratch only (under $HOME/scratch); no server, no :4317, no git writes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const REAL_BUGS = path.join(REPO, 'docs', 'bugs');
const REAL_HOOK = path.join(REPO, 'scripts', 'hooks', 'response-format-gate.mjs');
const REAL_BOARD_TOOL = path.join(REPO, 'scripts', 'board.mjs');

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const imp = (rel) => import(url.pathToFileURL(path.join(REPO, rel)).href);
const board = await imp('src/server/board.ts');
const wiring = await imp('src/server/wiring.ts');
const templates = await imp('src/server/templates.ts');
const runtime = await imp('src/server/runtime/claude-runtime.ts');
const fleet = await imp('scripts/fleet-sync.mjs');
const bp = await imp('scripts/lib/board-path.mjs');

const SCRATCH = path.join(os.homedir(), 'scratch');
fs.mkdirSync(SCRATCH, { recursive: true });
const tmp = fs.mkdtempSync(path.join(SCRATCH, 'feat106-readers-'));

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}
function writeFile(abs, body) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, body); }

/** Build a host with the real board at boardRel and matching conventions /
 *  deploy-context / stop-hook / board-tool / settings at the given rels. */
function buildHost(name, { boardRel, convRel, deployRel, hookRel, toolRel, extraConfig }) {
  const host = path.join(tmp, name);
  fs.mkdirSync(host, { recursive: true });
  copyDir(REAL_BUGS, path.join(host, boardRel));
  writeFile(path.join(host, convRel), '# Local conventions\nProject rule X.\n');
  writeFile(path.join(host, deployRel), '# Deploy context\nprod: somewhere.\n');
  fs.mkdirSync(path.dirname(path.join(host, hookRel)), { recursive: true });
  fs.copyFileSync(REAL_HOOK, path.join(host, hookRel));
  fs.mkdirSync(path.dirname(path.join(host, toolRel)), { recursive: true });
  fs.copyFileSync(REAL_BOARD_TOOL, path.join(host, toolRel));
  // package.json with a board:check script so the drift-guard check is not gated
  // on a missing script value.
  writeFile(path.join(host, 'package.json'), JSON.stringify({ name, scripts: { 'board:check': `node ${toolRel} check` } }, null, 2));
  writeFile(path.join(host, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `node ${hookRel}` }] }] } }, null, 2));
  if (extraConfig) writeFile(path.join(host, '.orchard', 'config.json'), JSON.stringify(extraConfig, null, 2));
  return host;
}

const legacy = buildHost('legacy', {
  boardRel: 'docs/bugs', convRel: 'docs/CONVENTIONS.md', deployRel: 'docs/DEPLOY-CONTEXT.md',
  hookRel: 'scripts/hooks/response-format-gate.mjs', toolRel: 'scripts/board.mjs',
});
const flat = buildHost('flat', {
  boardRel: '.orchard/bugs', convRel: '.orchard/CONVENTIONS.md', deployRel: '.orchard/DEPLOY-CONTEXT.md',
  hookRel: '.orchard/hooks/response-format-gate.mjs', toolRel: '.orchard/board.mjs',
});
// adopt-only: declared board via config.json pointing back at legacy docs/bugs
// (a project that adopted .orchard/ for config but has not moved its board).
const adopt = buildHost('adopt', {
  boardRel: 'docs/bugs', convRel: 'docs/CONVENTIONS.md', deployRel: 'docs/DEPLOY-CONTEXT.md',
  hookRel: 'scripts/hooks/response-format-gate.mjs', toolRel: 'scripts/board.mjs',
  extraConfig: { board: 'docs/bugs', layoutVersion: 1 },
});
// a host that was never onboarded — no board of any kind.
const none = path.join(tmp, 'none'); fs.mkdirSync(none, { recursive: true });

const projectOf = (host, id) => ({
  id, name: id, hostPath: host, isolation: 'shared',
  settings: { instructions: [], toolSettings: {} }, createdAt: '', updatedAt: '',
});

console.log('=== 1. resolvers name the right layout ===');
check('1a boardDir(legacy) → docs/bugs', board.boardDir(legacy) === path.join(legacy, 'docs', 'bugs'), board.boardDir(legacy));
check('1b boardDir(flat) → .orchard/bugs', board.boardDir(flat) === path.join(flat, '.orchard', 'bugs'), board.boardDir(flat));
check('1c boardDir(adopt/declared) → docs/bugs', board.boardDir(adopt) === path.join(adopt, 'docs', 'bugs'), board.boardDir(adopt));
check('1d boardLayout legacy/flat/adopt/none', [bp.boardLayout(legacy), bp.boardLayout(flat), bp.boardLayout(adopt), bp.boardLayout(none)].join(',') === 'legacy,orchard,declared,none',
  [bp.boardLayout(legacy), bp.boardLayout(flat), bp.boardLayout(adopt), bp.boardLayout(none)].join(','));
check('1e resolveDeployContextFile flat → .orchard', bp.resolveDeployContextFile(flat) === path.join(flat, '.orchard', 'DEPLOY-CONTEXT.md'));
check('1f resolveConventionsFile legacy → docs', bp.resolveConventionsFile(legacy) === path.join(legacy, 'docs', 'CONVENTIONS.md'));

console.log('=== 2. readBoard routes to the right dir; identical content ⇒ identical board (E, module level) ===');
const bLegacy = board.readBoard(legacy);
const bFlat = board.readBoard(flat);
const idsOf = (b) => [...(b.needsYou ?? []), ...(b.inflight ?? []), ...(b.answeredAwaiting ?? []), ...(b.queued ?? []), ...(b.doneToday ?? [])].map((i) => i.id).sort();
check('2a legacy board has content (hasBoard, non-empty lanes)', bLegacy.hasBoard && idsOf(bLegacy).length > 0);
check('2b flat board reads from .orchard/bugs and matches legacy exactly', bFlat.hasBoard && JSON.stringify(idsOf(bFlat)) === JSON.stringify(idsOf(bLegacy)),
  `legacy=${idsOf(bLegacy).length} flat=${idsOf(bFlat).length}`);
// Normalise the per-item `file` (absolute path, legitimately layout-specific)
// to its basename, then everything else — title, status, options, rank — must be
// byte-identical: same tickets, same parse, different directory.
const normBoard = (b) => JSON.parse(JSON.stringify(b), (k, v) => (k === 'file' && typeof v === 'string' ? path.basename(v) : v));
check('2c full board projection identical across layouts (bar the resolved file path)',
  JSON.stringify(normBoard(bFlat)) === JSON.stringify(normBoard(bLegacy)));

console.log('=== 3. wiringStatus reports methodology present in both layouts ===');
const keyState = (st, key) => st.checks.find((c) => c.key === key)?.state;
const wLegacy = wiring.wiringStatus(projectOf(legacy, 'L'));
const wFlat = wiring.wiringStatus(projectOf(flat, 'F'));
check('3a legacy: board/drift-guard/conventions all ok',
  keyState(wLegacy, 'board') === 'ok' && keyState(wLegacy, 'drift-guard') === 'ok' && keyState(wLegacy, 'conventions') === 'ok',
  `board=${keyState(wLegacy, 'board')} guard=${keyState(wLegacy, 'drift-guard')} conv=${keyState(wLegacy, 'conventions')}`);
check('3b flat: board/drift-guard/conventions all ok (NOT partial)',
  keyState(wFlat, 'board') === 'ok' && keyState(wFlat, 'drift-guard') === 'ok' && keyState(wFlat, 'conventions') === 'ok',
  `board=${keyState(wFlat, 'board')} guard=${keyState(wFlat, 'drift-guard')} conv=${keyState(wFlat, 'conventions')}`);
check('3c flat detail names .orchard path, not docs/bugs',
  /\.orchard\/bugs/.test(wFlat.checks.find((c) => c.key === 'board').detail));

console.log('=== 4. fleet planSweep keeps every layout in scope; only true no-board is skipped (F) ===');
const projects = [projectOf(flat, 'migrated'), projectOf(adopt, 'adopt-only'), projectOf(legacy, 'untouched'), projectOf(none, 'no-board')];
const plan = fleet.planSweep(projects, {});
const actionOf = (id) => plan.find((p) => p.id === id)?.action;
check('4a migrated (.orchard/bugs) planned sync', actionOf('migrated') === 'sync');
check('4b adopt-only (declared) planned sync', actionOf('adopt-only') === 'sync');
check('4c untouched (docs/bugs) planned sync', actionOf('untouched') === 'sync');
check('4d no-board skipped, none of the onboarded skipped', actionOf('no-board') === 'skip' && plan.filter((p) => p.action === 'skip').length === 1);

console.log('=== 5. localConventionsSection resolves + names the right path ===');
const cLegacy = templates.localConventionsSection(legacy);
const cFlat = templates.localConventionsSection(flat);
check('5a legacy conventions injected, names docs/CONVENTIONS.md', !!cLegacy && cLegacy.includes('docs/CONVENTIONS.md'));
check('5b flat conventions injected, names .orchard/CONVENTIONS.md', !!cFlat && cFlat.includes('.orchard/CONVENTIONS.md'), String(cFlat).slice(0, 120));

console.log('=== 6. ensureCurrentStopHook wired in both layouts ===');
const hLegacy = runtime.ensureCurrentStopHook(legacy, { warn: () => {} });
const hFlat = runtime.ensureCurrentStopHook(flat, { warn: () => {} });
check('6a legacy: wired, hook present (not not-onboarded)', hLegacy.wiring === 'wired' && hLegacy.hook !== 'not-onboarded', JSON.stringify(hLegacy));
check('6b flat: wired, hook present (not not-onboarded)', hFlat.wiring === 'wired' && hFlat.hook !== 'not-onboarded', JSON.stringify(hFlat));

console.log('=== 7. board snapshot footer names the resolved path ===');
const snapLegacy = board.boardStateSection(legacy);
const snapFlat = board.boardStateSection(flat);
check('7a legacy snapshot footer says docs/bugs/', !!snapLegacy && snapLegacy.includes('from docs/bugs/'));
check('7b flat snapshot footer says .orchard/bugs/', !!snapFlat && snapFlat.includes('from .orchard/bugs/'), String(snapFlat).split('\n')[2]);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* leave scratch */ }
process.exit(fail === 0 ? 0 : 1);
