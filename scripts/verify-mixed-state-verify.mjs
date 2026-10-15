#!/usr/bin/env node
/**
 * verify-mixed-state-verify.mjs — independent-verify's MIXED-STATE mode
 * (`--ticket T`, candidate-store `freezeMixed`), the BUG-255 shape:
 *
 *   A ticket's files also carry OTHER open tickets' uncommitted hunks, so a clean
 *   candidate freeze refuses (`owned` / `foreign-at-claim`) and the verify could not
 *   start. The mixed-state mode freezes the files AS THEY ARE (whole tree as the room),
 *   takes no ownership, DISCLOSES the foreign hunks naming each owner where known, and
 *   binds the verdict to the content hash.
 *
 * Proofs (each BEFORE must FAIL the property, AFTER must hold it):
 *   M1 a ticket whose files carry other tickets' hunks now verifies, where before it refused;
 *   M2 the foreign hunks are disclosed to the verifier (owner named; the ticket's own hunk is not);
 *   M3 a later edit to any frozen file invalidates the verdict;
 *   M4 the verdict record shows which mode was used (read from the candidate, not a flag);
 *   M5 the clean-diff path is unchanged (same prompt as --candidate; no disclosure; still committable).
 *
 * Fixtures are scratch git repos (git init/commit), so inside an agent session run it
 * in the confined runner:  npm run confined -- -- node scripts/verify-mixed-state-verify.mjs
 * Exit 0 = all PASS, 1 = a FAIL, 2 = could not run.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempScratch } from './lib/scratch.mjs';
import * as CS from './lib/candidate-store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'candidate.mjs');
const IV = path.join(HERE, 'independent-verify.mjs');
const BT = path.join(HERE, 'board-tool.mjs');

let pass = 0; let failN = 0;
function check(name, ok, detail = '') {
  if (ok) pass++; else failN++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${String(detail).split('\n').join('\n        ')}` : ''}`);
}
function beforeAfter(name, beforeHolds, afterHolds, detail = '') {
  check(`${name} — BEFORE fails the property [must-FAIL]`, beforeHolds === false, detail);
  check(`${name} — AFTER holds it`, afterHolds === true, detail);
}
const dirs = [];
function gitf(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`fixture git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function w(dir, rel, body) { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); }
const rd = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
function cli(dir, args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--repo', dir], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function iv(dir, args) {
  const r = spawnSync(process.execPath, [IV, '--repo', dir, ...args, '--requirement', 'boot must take the data-dir lock', '--run', 'node test/server.test.mjs', '--print-prompt', '--keep-cleanroom'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const room = /clean room: (\S+)/.exec(r.stderr || '')?.[1] ?? null;
  const rec = /record dir: (\S+)/.exec(r.stderr || '')?.[1] ?? null;
  if (room) dirs.push(room);
  if (rec) dirs.push(rec);
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(rec, 'room-manifest.json'), 'utf8')); } catch { /* none */ }
  return { code: r.status, prompt: r.stdout || '', err: r.stderr || '', room, manifest };
}
const section = (p) => { const a = p.indexOf('=== MIXED STATE'); return a < 0 ? '' : p.slice(a, p.indexOf('=== THE DIFF UNDER TEST', a)); };

const BASE = [
  "import { ensureDir, dataDir } from './util.mjs';",
  'export function boot() {',
  '  ensureDir(dataDir());',
  '  return listen();',
  '}',
  'export function listen() {',
  "  return 'listening';",
  '}',
  '',
  '',
  '',
  '',
  'export function shutdown() {',
  "  return 'bye';",
  '}',
  '',
].join('\n');

function fixture(name) {
  const dir = mkdtempScratch(`mixedverify-${name}-`);
  dirs.push(dir);
  gitf(dir, 'init', '-q');
  gitf(dir, 'config', 'user.email', 'fixture@example.invalid');
  gitf(dir, 'config', 'user.name', 'fixture');
  w(dir, 'src/server.mjs', BASE);
  w(dir, 'src/util.mjs', 'export const ensureDir = () => {};\nexport const dataDir = () => "/d";\nexport const acquireDataDirLock = () => true;\n');
  w(dir, 'src/api.mjs', 'export const api = (x) => x + 1;\n');
  w(dir, 'test/server.test.mjs', "import { boot } from '../src/server.mjs';\nif (boot() !== 'listening') { console.log('FAIL'); process.exit(1); }\nconsole.log('PASS');\n");
  w(dir, 'package-lock.json', '{"lockfileVersion":3}\n');
  w(dir, '.gitignore', 'ignored/\n');
  w(dir, 'docs/bugs/INDEX.md', '# Board\n\n## Open\n\n| ID | Title | Owner | Status | Sev |\n|----|-------|-------|--------|-----|\n\n## Done\n\n| ID | Title | Commit |\n|----|-------|--------|\n\n## Shipped earlier (pre-tracker)\nNothing.\n');
  gitf(dir, 'add', '-A');
  gitf(dir, 'commit', '-qm', 'base');
  return dir;
}

{ // could-not-run probe (agent session git-write block)
  const probe = mkdtempScratch('mixedverify-probe-'); dirs.push(probe);
  if (spawnSync('git', ['-C', probe, 'init', '-q']).status !== 0) {
    console.log('COULD NOT RUN: git writes refused even in a scratch repo; run it confined:');
    console.log('  npm run confined -- -- node scripts/verify-mixed-state-verify.mjs');
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    process.exit(2);
  }
}

const FOREIGN = "  return 'bye!'; // FEAT-901 shutdown change";
const PRECLAIM = "  return 'listening on port'; // BUG-903 unclaimed edit";
const OWN = '  acquireDataDirLock(dataDir()); // BUG-902 lock wiring';

/* The BUG-255 shape: FEAT-901 owns server.mjs (open candidate) and created an untracked
 * companion; BUG-903 edited the same file without any claim; then BUG-902 claims it
 * (dirty) and adds its own fix. */
function bug255Shape(name) {
  const dir = fixture(name);
  cli(dir, ['claim', '--id', 'FEAT-901', '--files', 'src/server.mjs', 'src/companion.mjs']);
  w(dir, 'src/server.mjs', BASE.replace("  return 'bye';", FOREIGN));
  w(dir, 'src/companion.mjs', 'export const companion = 901;\n'); // untracked, FEAT-901's
  const f = cli(dir, ['freeze', '--id', 'FEAT-901', '--files', 'src/server.mjs', 'src/companion.mjs']);
  if (f.code !== 0) throw new Error(`fixture FEAT-901 freeze: ${f.out}`);
  w(dir, 'src/server.mjs', rd(dir, 'src/server.mjs').replace("  return 'listening';", PRECLAIM));
  cli(dir, ['claim', '--id', 'BUG-902', '--files', 'src/server.mjs']);
  w(dir, 'src/server.mjs', rd(dir, 'src/server.mjs')
    .replace('  ensureDir(dataDir());\n', `  ensureDir(dataDir());\n${OWN}\n`)
    .replace("import { ensureDir, dataDir } from './util.mjs';", "import { ensureDir, dataDir, acquireDataDirLock } from './util.mjs';"));
  return dir;
}

/* ═══════════ M1: verifies where before it refused ═══════════ */
console.log('\n── M1 a ticket whose files carry other tickets\' uncommitted hunks now verifies');
let M = null;
{
  const dir = bug255Shape('m1');
  const fz = cli(dir, ['freeze', '--id', 'BUG-902', '--files', 'src/server.mjs']);
  const old = iv(dir, ['--candidate', 'BUG-902']);
  const ownersJson = () => JSON.stringify([...CS.ownersByPath(CS.repoInfo(dir).store)].sort());
  const ownersBefore = ownersJson();
  const after = iv(dir, ['--ticket', 'BUG-902', '--files', 'src/server.mjs']);
  const ownersAfter = ownersJson();
  M = { dir, after };
  beforeAfter('M1 verify of BUG-902 starts (clean freeze + --candidate is the BEFORE path)',
    fz.code === 0 && old.code === 0,
    after.code === 0 && /MIXED-STATE for BUG-902/.test(after.err) && after.prompt.includes('=== THE DIFF UNDER TEST'),
    `before: freeze exit ${fz.code} (${(fz.out.match(/owned|foreign-at-claim|belong to another open ticket/) || ['?'])[0]}), --candidate exit ${old.code}; after: exit ${after.code} ${after.err.split('\n').find((l) => /mode/.test(l)) || after.err.split('\n').slice(-3).join(' ')}`);
  check('M1 the BEFORE refusal is the ownership one (not some other failure)', /belong to another open ticket|owned/.test(fz.out), fz.out.split('\n')[0]);
  check('M1 the room is the real mixed state: FEAT-901\'s untracked companion is in it', !!after.room && fs.existsSync(path.join(after.room, 'src/companion.mjs')));
  check('M1 the room holds the frozen ticket file byte-for-byte', !!after.room && fs.readFileSync(path.join(after.room, 'src/server.mjs'), 'utf8') === rd(dir, 'src/server.mjs'));
  check('M1 the diff is limited to the ticket\'s files (companion.mjs is in the room, not in the diff)', !/diff --git a\/src\/companion\.mjs/.test(after.prompt) && /diff --git a\/src\/server\.mjs/.test(after.prompt));
  const st = CS.readTicketState(CS.repoInfo(dir).store, 'BUG-902');
  check('M1 no ownership taken: BUG-902 still has no open candidate after the mixed freeze', st.open === null || st.open === undefined, JSON.stringify({ open: st.open, state: st.state }));
  check('M1 no one else is blocked: the store\'s ownership map is byte-identical before and after the mixed freeze', ownersBefore === ownersAfter && ownersAfter.includes('FEAT-901'), ownersAfter.slice(0, 200));
}

/* ═══════════ M2: disclosure ═══════════ */
console.log('\n── M2 the foreign hunks are disclosed to the verifier');
{
  const { dir, after } = M;
  const wt = iv(dir, ['--working-tree']);
  const sec = section(after.prompt);
  const lines = rd(dir, 'src/server.mjs').split('\n');
  const ln = (needle) => lines.findIndex((l) => l === needle) + 1;
  const fLine = ln(FOREIGN); const pLine = ln(PRECLAIM); const oLine = ln(OWN);
  beforeAfter('M2 the verifier is told which hunks are FEAT-901\'s',
    /FEAT-901/.test(wt.prompt) && /MIXED STATE/.test(wt.prompt),
    new RegExp(`src/server\\.mjs line ${fLine} .*NOT this change: FEAT-901`).test(sec),
    `--working-tree prompt mentions FEAT-901: ${/FEAT-901/.test(wt.prompt)}; mixed disclosure:\n${sec.split('\n').filter((l) => /^ {2}src/.test(l)).join('\n')}`);
  check('M2 the hunk present before BUG-902 claimed the file is disclosed (owner unknown)', new RegExp(`src/server\\.mjs line ${pLine} .*owner unknown.*already present when BUG-902 claimed`).test(sec));
  check('M2 the ticket\'s OWN hunk is NOT disclosed as foreign', !new RegExp(`src/server\\.mjs (line ${oLine}|lines ${oLine - 1}-)`).test(sec) && /2 not attributed to any other ticket/.test(sec), sec.split('\n').filter((l) => /^ {2}src/.test(l)).join('\n'));
  check('M2 the disclosure carries ticket ids and ranges only (no ticket prose)', !/fixture|title|summary/i.test(sec.replace(/frozen change|frozen copy/g, '')));
  check('M2 the disclosure is recorded in the room manifest the verdict cites', after.manifest?.candidate?.mode === 'mixed-state' && after.manifest?.candidate?.disclosure?.hunks?.some((h) => h.owners.includes('FEAT-901')));
}

/* ═══════════ M3: a later edit invalidates ═══════════ */
console.log('\n── M3 a later edit to any frozen file invalidates the verdict');
{
  const { dir, after } = M;
  const h = after.manifest?.candidate?.hash;
  const s0 = CS.candidateStatus(dir, h);
  const wt = iv(dir, ['--working-tree']);
  beforeAfter('M3 the verdict is bound to a content hash a later edit can invalidate (BEFORE: the --working-tree / hand scratch-copy verify)',
    !!wt.manifest?.candidate?.hash,
    !!h && /^[0-9a-f]{64}$/.test(h) && !!CS.loadCandidate(CS.repoInfo(dir).store, h),
    `working-tree room manifest candidate: ${JSON.stringify(wt.manifest?.candidate ?? null)}; mixed: ${String(h).slice(0, 12)}`);
  check('M3 right after the freeze every frozen file is CURRENT (the verdict covers them)', s0.files.every((f) => f.state === 'CURRENT'), s0.files.map((f) => `${f.path}:${f.state}`).join(' '));
  // A CO-OWNER (FEAT-901) edits its own hunk in the shared file — not BUG-902's lines.
  w(dir, 'src/server.mjs', rd(dir, 'src/server.mjs').replace("  return 'bye!';", "  return 'goodbye';"));
  const s1 = CS.candidateStatus(dir, h);
  const st = cli(dir, ['status', '--candidate', h]);
  check('M3 a co-owner\'s edit of a frozen file makes it CHANGED and `candidate status` fails', s1.files.some((f) => f.state === 'CHANGED') && st.code === 1, st.out.split('\n').slice(0, 2).join(' | '));
  const again = iv(dir, ['--ticket', 'BUG-902', '--files', 'src/server.mjs']);
  const h2 = again.manifest?.candidate?.hash;
  check('M3 the edited state is a NEW candidate hash (a verdict on the old one cannot carry over)', !!h2 && h2 !== h, `${String(h).slice(0, 12)} → ${String(h2).slice(0, 12)}`);
  const r = await CS.readiness(dir, h);
  check('M3 a mixed candidate is never offered for commit', r.ready === false && r.blocking.some((b) => /MIXED-STATE/.test(b)));
  const cm = cli(dir, ['commit', h]);
  check('M3 `candidate commit` of a mixed candidate refuses', cm.code !== 0 && /not ready|MIXED/.test(cm.out), cm.out.split('\n')[0]);
  w(dir, 'src/server.mjs', rd(dir, 'src/server.mjs').replace("  return 'goodbye';", "  return 'bye!';"));
}

/* ═══════════ M4: the verdict record shows the mode ═══════════ */
console.log('\n── M4 the verdict record shows which mode was used');
{
  const dir = M.dir;
  const h = M.after.manifest.candidate.hash;
  const bt = (args) => { const r = spawnSync(process.execPath, [BT, ...args], { encoding: 'utf8', env: { ...process.env, ORCHARD_BOARD_TOOL_ROOT: dir } }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
  const filed = bt(['file', `--json=${JSON.stringify({
    type: 'bug', title: 'Fixture ticket for the mixed state verify suite',
    summary: 'A throwaway ticket inside a scratch repository, used to record a verdict bound to a mixed-state candidate.',
    impact_if_we_wait: 'Nothing; the scratch repository is deleted when the suite finishes.',
    current_need: 'Nothing. It is a fixture.', severity: 'low', area: 'board tooling', reported_by: 'mixed verify suite',
    success_criteria: ['A verdict records its mode'], verification_class: 'fix',
    body: '## Diagnosis\n\nFixture.\n',
  })}`]);
  let id = null; try { id = JSON.parse(filed.out).id; } catch { /* below */ }
  check('M4 fixture ticket filed in the scratch board', !!id, filed.out.slice(0, 300));
  const v = bt(['verified', `--id=${id}`, '--provider=openai', '--model=m', '--run=01a1aaaa-0000-7000-8000-000000000001', '--verdict=HOLDS', `--candidate=${h}`]);
  const file = fs.readdirSync(path.join(dir, 'docs/bugs')).find((n) => n.startsWith(`${id}-`));
  const text = file ? rd(dir, `docs/bugs/${file}`) : '';
  const rec = (() => { try { return JSON.parse(/```orchard-ticket\n([\s\S]*?)\n```/.exec(text)[1]); } catch { return null; } })();
  const e = rec?.verification?.at(-1);
  check('M4 the typed entry is bound to the mixed candidate and says verify_mode "mixed-state"', v.code === 0 && e?.candidate === h && e?.verify_mode === 'mixed-state', v.out.slice(0, 300));
  check('M4 the Activity-log echo names the mode too', /mixed-state candidate/.test(text));
  // the clean path's record says so as well
  const dir2 = fixture('m4clean');
  cli(dir2, ['claim', '--id', 'BUG-904', '--files', 'src/api.mjs']);
  w(dir2, 'src/api.mjs', 'export const api = (x) => x + 2;\n');
  const fz = cli(dir2, ['freeze', '--id', 'BUG-904', '--files', 'src/api.mjs']);
  const hc = /candidate ([0-9a-f]{64})/.exec(fz.out)?.[1];
  const bt2 = (args) => { const r = spawnSync(process.execPath, [BT, ...args], { encoding: 'utf8', env: { ...process.env, ORCHARD_BOARD_TOOL_ROOT: dir2 } }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
  let id2 = null; try { id2 = JSON.parse(bt2(['file', filed.out ? `--json=${JSON.stringify({ type: 'bug', title: 'Fixture ticket for the clean path record', summary: 'A throwaway ticket inside a scratch repository, used to record a verdict bound to a clean candidate.', impact_if_we_wait: 'Nothing; the scratch repository is deleted when the suite finishes.', current_need: 'Nothing. It is a fixture.', severity: 'low', area: 'board tooling', reported_by: 'mixed verify suite', success_criteria: ['A verdict records its mode'], verification_class: 'fix', body: '## Diagnosis\n\nFixture.\n' })}` : '']).out).id; } catch { /* */ }
  const v2 = bt2(['verified', `--id=${id2}`, '--provider=openai', '--model=m', '--run=01a1aaaa-0000-7000-8000-000000000002', '--verdict=HOLDS', `--candidate=${hc}`]);
  const f2 = fs.readdirSync(path.join(dir2, 'docs/bugs')).find((n) => n.startsWith(`${id2}-`));
  const e2 = (() => { try { return JSON.parse(/```orchard-ticket\n([\s\S]*?)\n```/.exec(rd(dir2, `docs/bugs/${f2}`))[1]).verification.at(-1); } catch { return null; } })();
  check('M4 a clean-candidate verdict records verify_mode "clean-candidate"', v2.code === 0 && e2?.verify_mode === 'clean-candidate', v2.out.slice(0, 300));
}

/* ═══════════ M5: clean path unchanged ═══════════ */
console.log('\n── M5 the clean-diff path is unchanged');
{
  const dir = fixture('m5');
  cli(dir, ['claim', '--id', 'BUG-905', '--files', 'src/server.mjs']);
  w(dir, 'src/server.mjs', BASE.replace('  ensureDir(dataDir());\n', `  ensureDir(dataDir());\n${OWN}\n`));
  const fz = cli(dir, ['freeze', '--id', 'BUG-905', '--files', 'src/server.mjs']);
  const hc = /candidate ([0-9a-f]{64})/.exec(fz.out)?.[1];
  const viaCand = iv(dir, ['--candidate', 'BUG-905']);
  const viaTicket = iv(dir, ['--ticket', 'BUG-905']);
  const norm = (p, room) => p.split(room).join('<ROOM>');
  check('M5 --ticket on a ticket with a CURRENT clean candidate takes the clean path', viaTicket.code === 0 && /clean candidate [0-9a-f]{12} for BUG-905/.test(viaTicket.err) && viaTicket.manifest?.candidate?.hash === hc && viaTicket.manifest?.candidate?.mode === 'clean-candidate');
  check('M5 its prompt is byte-identical to --candidate\'s (modulo the room path), with no disclosure section', norm(viaTicket.prompt, viaTicket.room) === norm(viaCand.prompt, viaCand.room) && !/=== MIXED STATE/.test(viaCand.prompt));
  const m = CS.loadCandidate(CS.repoInfo(dir).store, hc);
  check('M5 a clean candidate carries no mode field and keeps its v2 identity hash', m.mode === undefined && CS.candidateHash(m) === hc);
  // A clean, frozen ticket with the file later CHANGED: --ticket falls back to mixed, the clean candidate is untouched.
  w(dir, 'src/server.mjs', `${rd(dir, 'src/server.mjs')}// later\n`);
  const fb = iv(dir, ['--ticket', 'BUG-905']);
  check('M5 when the clean candidate is no longer CURRENT, --ticket falls back to mixed state and says why', fb.code === 0 && /MIXED-STATE for BUG-905 — no clean diff \(src\/server\.mjs: CHANGED\)/.test(fb.err), fb.err.split('\n').find((l) => /mode/.test(l)));
  check('M5 ...and the clean candidate stays the ticket\'s open candidate', CS.readTicketState(CS.repoInfo(dir).store, 'BUG-905').open === hc);
  // --mixed forces it; a gitignored file is refused loudly.
  w(dir, 'ignored/x.mjs', 'x\n');
  const ig = iv(dir, ['--ticket', 'BUG-905', '--mixed', '--files', 'ignored/x.mjs']);
  check('M5 a gitignored ticket file is refused (the room could not carry it)', ig.code !== 0 && /ignores it/.test(ig.err), ig.err.split('\n').slice(-2).join(' '));
  const same = iv(dir, ['--ticket', 'BUG-905', '--mixed', '--files', 'src/api.mjs']);
  check('M5 a mixed freeze of files identical to HEAD refuses (nothing to verify)', same.code !== 0 && /no-change|nothing to verify|none of the files differs/.test(same.err), same.err.split('\n').slice(-1)[0]);
}

for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
console.log(`\n${failN ? 'FAIL' : 'PASS'}: ${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
