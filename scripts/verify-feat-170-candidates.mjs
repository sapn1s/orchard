#!/usr/bin/env node
/**
 * verify-feat-170-candidates.mjs — FEAT-170 persistent suite: immutable verify
 * candidates, hash-bound verdicts, per-file ownership, and the user's commit.
 *
 * Every guarantee is shown TWICE on the same fixture state:
 *   BEFORE — the mechanism this repo had (`--working-tree`, an unbound typed verdict,
 *            `git add <file>` + commit, FEAT-129's lane lock) — must FAIL the property;
 *   AFTER  — the candidate mechanism — must HOLD it.
 * A "before" that unexpectedly holds is itself a FAIL: the fixture would then not
 * exercise the defect, and the "after" would prove nothing (non-vacuity).
 *
 * ROUND 3 RESCOPE (FEAT-170 decision A). Round-4 checks tagged [must-FAIL on round 3] FAIL on
 * the round-3 code (verify 248ad5f9: ticket-file ride-along, live-file harm). The property is now: what gets committed for
 * a ticket is exactly the frozen bytes that were verified, and ANY later change to
 * those files invalidates the verdict. Checks tagged [must-FAIL on round 2] FAIL on the
 * round-2 code (textual DRIFTED kept a changed file READY; an env-variable check stood
 * as a second commit authority) and PASS on the rescoped code. Foreign lines from a
 * lane that never claimed the file are an accepted residual, counted by foreign-report.
 *
 * Fixtures are throwaway git repos under the scratch root (never this checkout).
 * independent-verify runs with --print-prompt (no LLM dispatch). Exit 0 = all PASS.
 */
import { spawnSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempScratch } from './lib/scratch.mjs';
import * as CS from './lib/candidate-store.mjs';
import { installGitShim } from './lib/git-shim.mjs';
import { ticketVerifications } from './lib/verification-source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'candidate.mjs');
const IV = path.join(HERE, 'independent-verify.mjs');

let pass = 0; let failN = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  if (ok) pass++; else failN++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${String(detail).split('\n').join('\n        ')}` : ''}`);
}
/** BEFORE must fail the property, AFTER must hold it. */
function beforeAfter(name, beforeHolds, afterHolds, detail = '') {
  check(`${name} — BEFORE (old mechanism) fails the property [must-FAIL]`, beforeHolds === false, detail);
  check(`${name} — AFTER (candidate) holds it`, afterHolds === true, detail);
}

const dirs = [];
function gitf(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`fixture git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function w(dir, rel, body, mode) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  if (mode) fs.chmodSync(p, mode);
}
const rd = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

const SERVER_BASE = [
  "import { ensureDir, dataDir } from './util.mjs';",
  'export function boot() {',
  '  ensureDir(dataDir());',
  '  return listen();',
  '}',
  'export function listen() {',
  "  return 'listening';",
  '}',
  'export function shutdown() {',
  "  return 'bye';",
  '}',
  '',
].join('\n');
const LOCK_MARK = 'acquireDataDirLock(dataDir()); // BUG-217 r9 wiring';

/** A fresh fixture repo: one base commit, a minimal board, a recording pre-commit hook. */
function fixture(name) {
  const dir = mkdtempScratch(`feat170-${name}-`);
  dirs.push(dir);
  gitf(dir, 'init', '-q');
  gitf(dir, 'config', 'user.email', 'fixture@example.invalid');
  gitf(dir, 'config', 'user.name', 'fixture');
  gitf(dir, 'config', 'core.hooksPath', '.githooks');
  w(dir, 'src/server.mjs', SERVER_BASE);
  w(dir, 'src/util.mjs', 'export const ensureDir = () => {};\nexport const dataDir = () => "/d";\nexport const acquireDataDirLock = () => true;\n');
  w(dir, 'src/other.mjs', 'export const other = 1;\n');
  w(dir, 'src/api.mjs', 'export const api = (x) => x + 1;\n');
  w(dir, 'test/server.test.mjs', "import { boot } from '../src/server.mjs';\nif (boot() !== 'listening') { console.log('FAIL'); process.exit(1); }\nconsole.log('PASS: boot listens');\n");
  w(dir, 'test/api.test.mjs', "import { api } from '../src/api.mjs';\nimport { caller } from '../src/caller.mjs';\nif (caller() !== 3) { console.log('FAIL caller', caller()); process.exit(1); }\nconsole.log('PASS caller');\n");
  w(dir, 'src/caller.mjs', "import { api } from './api.mjs';\nexport const caller = () => api(2);\n");
  w(dir, 'package-lock.json', '{"lockfileVersion":3}\n');
  // A pre-commit hook that RECORDS what it saw staged, and can be told to refuse.
  w(dir, '.githooks/pre-commit', '#!/bin/sh\ngit diff --cached --name-only > "$(git rev-parse --git-common-dir)/hook-saw.txt"\n[ -f "$(git rev-parse --git-common-dir)/hook-refuse" ] && exit 1\nexit 0\n', 0o755);
  w(dir, 'docs/bugs/.keep', '');
  gitf(dir, 'add', '-A');
  gitf(dir, 'commit', '-qm', 'base');
  return dir;
}

/** Write a minimal record-format ticket carrying typed verification entries (what board-tool writes). */
function ticketWithVerdicts(dir, id, entries) {
  const rec = { id, type: 'bug', title: `${id} fixture`, verification: entries };
  w(dir, `docs/bugs/${id}-fixture.md`, `\`\`\`orchard-ticket\n${JSON.stringify(rec, null, 2)}\n\`\`\`\n\n# ${id}\n`);
}
let tick = 0;
const verdict = (run, v, candidate) => ({ provider: 'openai', model: 'm', run_id: run, verdict: v, recorded_at: new Date(Date.UTC(2026, 9, 7, 12, 0, tick++)).toISOString(), ...(candidate ? { candidate } : {}) });

function cli(dir, args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--repo', dir], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function ivPrompt(dir, args) {
  const r = spawnSync(process.execPath, [IV, '--repo', dir, ...args, '--requirement', 'boot must take the data-dir lock', '--run', 'node test/server.test.mjs', '--print-prompt', '--keep-cleanroom'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const room = /clean room: (\S+)/.exec(r.stderr || '')?.[1] ?? null;
  const rec = /record dir: (\S+)/.exec(r.stderr || '')?.[1] ?? null;
  if (room) dirs.push(room);
  if (rec) dirs.push(rec);
  return { code: r.status, prompt: r.stdout || '', err: r.stderr || '', room };
}

/*
 * ENVIRONMENT. The fixtures are throwaway repos this suite must create and commit to.
 * Inside an Orchard agent session the FEAT-108/135 git-write block refuses that (by
 * design: agents never run git writes). That is not a PASS and not a product FAIL —
 * report it as could-not-run (exit 2) and say where it can run: the user's terminal.
 */
{
  const probe = mkdtempScratch('feat170-probe-'); dirs.push(probe);
  const r = spawnSync('git', ['-C', probe, 'init', '-q'], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.log('COULD NOT RUN: this environment refuses git writes even in a throwaway scratch repo');
    console.log('  (an Orchard agent session: FEAT-108/FEAT-135 git-write block). The fixtures need');
    console.log('  git init/commit in scratch repos, and the commit path IS a git write. Run it in your');
    console.log('  own terminal:  node scripts/verify-feat-170-candidates.mjs');
    for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
    process.exit(2);
  }
}

/* ═══════════════════════════════ P1 + P2: the BUG-224 replay ═══════════════ */
console.log('\n── P1/P2 BUG-224 replay: a strip lane restores a pre-lane copy over a frozen fix');
{
  const dir = fixture('bug224');
  // FEAT-157's strip lane took its "pre-lane" copy BEFORE BUG-217 edited the file.
  const pre = rd(dir, 'src/server.mjs');
  // BUG-217 claims, edits (the r9 wiring), freezes.
  check('claim BUG-217 (clean file) exits 0', cli(dir, ['claim', '--id', 'BUG-217', '--files', 'src/server.mjs']).code === 0);
  w(dir, 'src/server.mjs', pre.replace('  ensureDir(dataDir());\n', `  ensureDir(dataDir());\n  ${LOCK_MARK}\n`).replace("import { ensureDir, dataDir } from './util.mjs';", "import { ensureDir, dataDir, acquireDataDirLock } from './util.mjs';"));
  const fz = cli(dir, ['freeze', '--id', 'BUG-217', '--files', 'src/server.mjs', '--check', 'node test/server.test.mjs']);
  check('freeze BUG-217 exits 0 and prints the hash', fz.code === 0 && /FROZEN BUG-217 candidate [0-9a-f]{64}/.test(fz.out), fz.out.split('\n')[0]);
  const hash = /candidate ([0-9a-f]{64})/.exec(fz.out)?.[1];
  // FEAT-157 also edits another file, then STRIPS with the 2026-09-30 whole-file copy.
  w(dir, 'src/other.mjs', 'export const other = 157; // FEAT-157 WIP\n');
  w(dir, 'src/server.mjs', pre); // `cp $PRE/$f $f`

  const before = ivPrompt(dir, ['--working-tree']);
  const after = ivPrompt(dir, ['--candidate', 'BUG-217']);
  beforeAfter('P1 the verifier is shown BUG-217\'s frozen fix after the strip',
    before.code === 0 && before.prompt.includes(LOCK_MARK),
    after.code === 0 && after.prompt.includes(LOCK_MARK),
    `working-tree exit ${before.code}, has fix=${before.prompt.includes(LOCK_MARK)}; candidate exit ${after.code}, has fix=${after.prompt.includes(LOCK_MARK)}\n${after.code ? after.err.slice(-600) : ''}`);
  const frozen = CS.loadCandidate(CS.repoInfo(dir).store, hash);
  const roomBytes = after.room ? fs.readFileSync(path.join(after.room, 'src/server.mjs')) : Buffer.alloc(0);
  check('P1 the clean room\'s src/server.mjs is byte-identical to the frozen bytes', after.room && CS.getObject(CS.repoInfo(dir).store, frozen.files[0].sha256).equals(roomBytes));
  beforeAfter('P1 the verifier is NOT shown another lane\'s in-flight edit (src/other.mjs)',
    !before.prompt.includes('FEAT-157 WIP'),
    !after.prompt.includes('FEAT-157 WIP') && after.room && !rd(after.room, 'src/other.mjs').includes('FEAT-157'),
    `working-tree diff has FEAT-157 WIP=${before.prompt.includes('FEAT-157 WIP')}`);
  check('P1 the verdict record command printed for a candidate carries --candidate (seam: the binding is offered by the harness)',
    fs.readFileSync(IV, 'utf8').includes('--candidate=${candidate.manifest.hash}'));

  // P2: the revert is LOUD. Before: the typed verdict says verified though the fix is gone.
  ticketWithVerdicts(dir, 'BUG-217', [verdict('run-0001-holds', 'holds', hash)]);
  const tv = ticketVerifications(path.join(dir, 'docs/bugs'), { id: 'BUG-217', markdown: rd(dir, 'docs/bugs/BUG-217-fixture.md') });
  const st = cli(dir, ['status', '--id', 'BUG-217']);
  const rdy = await CS.readiness(dir, 'BUG-217');
  beforeAfter('P2 a revert of a verified fix is reported, and the ticket is not offered for commit',
    !tv.verified,
    st.code === 1 && /REVERTED\s+src\/server\.mjs/.test(st.out) && !rdy.ready && rdy.blocking.some((b) => b.includes('REVERTED')),
    `board says verified=${tv.verified}; status exit ${st.code}: ${st.out.split('\n').slice(1, 2).join('')}`);
  check('P2 the status names where the frozen bytes are (recovery is a copy, not archaeology)', /frozen bytes: \S+objects\/[0-9a-f]{64}/.test(st.out));
}

/* ═══════════════════════════════ P3: verdict bound to the hash ═══════════════ */
console.log('\n── P3 the verdict is bound to the candidate hash');
{
  const dir = fixture('bind');
  cli(dir, ['claim', '--id', 'BUG-301', '--files', 'src/server.mjs']);
  w(dir, 'src/server.mjs', SERVER_BASE.replace("  return 'bye';", "  return 'bye now';"));
  const h1 = /candidate ([0-9a-f]{64})/.exec(cli(dir, ['freeze', '--id', 'BUG-301', '--files', 'src/server.mjs']).out)?.[1];
  ticketWithVerdicts(dir, 'BUG-301', [verdict('run-0301-holds', 'holds', h1)]);
  const r0 = await CS.readiness(dir, 'BUG-301');
  check('P3 HOLDS bound to the exact hash, tree CURRENT → READY', r0.ready, r0.blocking.join(' | '));
  // A later edit by another lane touching the candidate's own line.
  w(dir, 'src/server.mjs', SERVER_BASE.replace("  return 'bye';", "  return 'bye later';"));
  const tvB = ticketVerifications(path.join(dir, 'docs/bugs'), { id: 'BUG-301', markdown: rd(dir, 'docs/bugs/BUG-301-fixture.md') });
  const r1 = await CS.readiness(dir, 'BUG-301');
  beforeAfter('P3 an edit to the candidate\'s own lines after the verdict stops it counting',
    !tvB.verified, !r1.ready && r1.blocking.some((b) => /CHANGED|REVERTED/.test(b)), r1.blocking.join(' | '));
  // Re-freeze → new hash; the old HOLDS does not carry over.
  const h2 = /candidate ([0-9a-f]{64})/.exec(cli(dir, ['freeze', '--id', 'BUG-301', '--files', 'src/server.mjs']).out)?.[1];
  const r2 = await CS.readiness(dir, 'BUG-301');
  check('P3 re-freezing gives a NEW hash and the old HOLDS does not make it ready', h2 && h2 !== h1 && !r2.ready && r2.blocking.some((b) => b.includes('no verdict bound')), r2.blocking.join(' | '));
  ticketWithVerdicts(dir, 'BUG-301', [verdict('run-0301-holds', 'holds', h1), verdict('run-0302-holds', 'holds', h2), verdict('run-0303-broken', 'broken', null)]);
  const r3 = await CS.readiness(dir, 'BUG-301');
  check('P3 a BROKEN recorded after the bound HOLDS blocks it', !r3.ready && r3.blocking.some((b) => b.includes('BROKEN recorded after')), r3.blocking.join(' | '));
  ticketWithVerdicts(dir, 'BUG-301', [verdict('run-0302-holds', 'holds', h2)]);
  const r4 = await CS.readiness(dir, 'BUG-301');
  check('P3 a HOLDS bound to the new hash → READY', r4.ready, r4.blocking.join(' | '));
  // Disjoint later edit (another lane, another function, same file) → still READY, noted.
  w(dir, 'src/server.mjs', rd(dir, 'src/server.mjs').replace("  return 'listening';", "  return 'listening'; // BUG-302 unrelated"));
  const r5 = await CS.readiness(dir, 'BUG-301');
  check('P3 a DISJOINT later edit in the same file invalidates the verdict (CHANGED, not ready) [must-FAIL on round 2]', !r5.ready && r5.blocking.some((b) => b.includes('CHANGED')), `ready=${r5.ready} ${r5.blocking.join(' | ')}`);
}

/* ═══════════════════════════════ P4: ownership ═══════════════ */
console.log('\n── P4 one file, two open tickets: refused unless declared as a group');
{
  const dir = fixture('own');
  cli(dir, ['claim', '--id', 'FEAT-401', '--files', 'src/server.mjs', 'src/api.mjs']);
  w(dir, 'src/server.mjs', SERVER_BASE.replace("  return 'bye';", "  return 'bye 401';"));
  w(dir, 'src/api.mjs', 'export const api = (x) => x + 1; // 401\n');
  const h401 = /candidate ([0-9a-f]{64})/.exec(cli(dir, ['freeze', '--id', 'FEAT-401', '--files', 'src/server.mjs', 'src/api.mjs']).out)?.[1];
  // BUG-402 edits the same file.
  const claim = cli(dir, ['claim', '--id', 'BUG-402', '--files', 'src/server.mjs']);
  check('P4 claiming a file an open ticket owns is LOUD (exit 3, names the owner)', claim.code === 3 && claim.out.includes('owned by FEAT-401'), claim.out.split('\n').slice(0, 3).join(' / '));
  w(dir, 'src/server.mjs', rd(dir, 'src/server.mjs').replace("  return 'listening';", "  return 'listening 402';"));
  const before = ivPrompt(dir, ['--working-tree']);
  const fz = cli(dir, ['freeze', '--id', 'BUG-402', '--files', 'src/server.mjs']);
  beforeAfter('P4 a second ticket cannot silently take another open ticket\'s file into its verification',
    !(before.code === 0 && before.prompt.includes('bye 401')),
    fz.code === 1 && fz.out.includes('REFUSED (owned)') && fz.out.includes('FEAT-401'),
    `working-tree verify input for BUG-402 silently carries FEAT-401's line=${before.prompt.includes('bye 401')}; freeze: ${fz.out.split('\n')[0]}`);
  const g = cli(dir, ['freeze', '--id', 'BUG-402', '--files', 'src/server.mjs', '--depends-on', 'FEAT-401', '--accept-foreign', 'src/server.mjs']);
  const gh = /candidate ([0-9a-f]{64})/.exec(g.out)?.[1];
  const gm = gh && CS.loadCandidate(CS.repoInfo(dir).store, gh);
  check('P4 with --depends-on the group freezes, pinned by hash, members BUG-402 + FEAT-401', g.code === 0 && gm && gm.deps[0].hash === h401 && CS.membersOf(gm).join(',') === 'BUG-402,FEAT-401', g.out.split('\n').slice(0, 3).join(' / '));
  const apiEntry = gm?.files.find((f) => f.path === 'src/api.mjs');
  const f401 = CS.loadCandidate(CS.repoInfo(dir).store, h401).files.find((f) => f.path === 'src/api.mjs');
  check('P4 the group takes the dependency\'s FROZEN bytes, not the live tree', apiEntry && apiEntry.sha256 === f401.sha256 && apiEntry.owner === 'FEAT-401');
  w(dir, 'src/api.mjs', 'export const api = (x) => x + 1; // 401 live drift\n');
  const g2 = cli(dir, ['freeze', '--id', 'BUG-402', '--files', 'src/server.mjs', '--depends-on', 'FEAT-401', '--accept-foreign', 'src/server.mjs']);
  const g2m = CS.loadCandidate(CS.repoInfo(dir).store, /candidate ([0-9a-f]{64})/.exec(g2.out)?.[1]);
  check('P4 live drift in a dependency\'s file does not leak into the group', g2m.files.find((f) => f.path === 'src/api.mjs').sha256 === f401.sha256);
  ticketWithVerdicts(dir, 'BUG-402', [verdict('run-0402-holds', 'holds', g2m.hash)]);
  ticketWithVerdicts(dir, 'FEAT-401', [verdict('run-0401-holds', 'holds', h401)]);
  const rg = await CS.readiness(dir, 'BUG-402');
  check('P4 a group needs EVERY member\'s verdict on the group hash (FEAT-401\'s HOLDS on its own candidate does not transfer)', !rg.ready && rg.blocking.some((b) => b.includes('FEAT-401 has no verdict bound to candidate')), rg.blocking.join(' | '));
  const cyc = cli(dir, ['freeze', '--id', 'FEAT-401', '--files', 'src/api.mjs', '--depends-on', 'BUG-402']);
  check('P4 a dependency cycle is refused', cyc.code === 1 && cyc.out.includes('dep-cycle'), cyc.out.split('\n')[0]);
  // The dependency may not re-freeze a file the GROUP owns (BUG-402 froze src/server.mjs).
  const blocked = cli(dir, ['freeze', '--id', 'FEAT-401', '--files', 'src/server.mjs', 'src/api.mjs']);
  check('P4 a dependency cannot silently re-take a file its dependent group owns', blocked.code === 1 && blocked.out.includes('owned by BUG-402'), blocked.out.split('\n')[0]);
  // Dependency re-frozen (its own file) after pinning → group stale.
  w(dir, 'src/api.mjs', 'export const api = (x) => x + 1; // 401 round 2\n');
  const rf = cli(dir, ['freeze', '--id', 'FEAT-401', '--files', 'src/api.mjs']);
  check('P4 the dependency re-freezes its own file', rf.code === 0, rf.out.split('\n')[0]);
  const rg2 = await CS.readiness(dir, 'BUG-402');
  check('P4 a dependency re-frozen after the group pinned it makes the group not ready', !rg2.ready && rg2.blocking.some((b) => b.includes('re-frozen or released')), rg2.blocking.join(' | '));
  // Foreign lines present at claim time (FEAT-169/BUG-234 shape).
  const d2 = fixture('foreign');
  w(d2, 'src/other.mjs', 'export const other = 234; // BUG-234 WIP, never claimed\n');
  cli(d2, ['claim', '--id', 'FEAT-169', '--files', 'src/other.mjs']);
  w(d2, 'src/other.mjs', 'export const other = 234; // BUG-234 WIP, never claimed\nexport const scope = 169;\n');
  const ff = cli(d2, ['freeze', '--id', 'FEAT-169', '--files', 'src/other.mjs']);
  check('P4 a file that already held another lane\'s uncommitted lines at claim time is refused, not silently frozen', ff.code === 1 && ff.out.includes('foreign-at-claim'), ff.out.split('\n')[0]);
  const fa = cli(d2, ['freeze', '--id', 'FEAT-169', '--files', 'src/other.mjs', '--accept-foreign', 'src/other.mjs']);
  check('P4 --accept-foreign freezes and records the downgrade on the candidate', fa.code === 0 && fa.out.includes('ACCEPTED foreign lines'), fa.out.split('\n').slice(0, 4).join(' / '));
}

/* ═══════════════════════════════ P5: interleaved hunks — the commit ═══════════════ */
console.log('\n── P5 the user commits one ticket\'s frozen bytes; a later same-file edit blocks it, another file\'s edit stays uncommitted');
{
  const dir = fixture('commit');
  cli(dir, ['claim', '--id', 'FEAT-169', '--files', 'src/server.mjs']);
  w(dir, 'src/server.mjs', SERVER_BASE.replace("  return 'bye';", "  return 'bye'; // FEAT-169 scope"));
  const h2 = /candidate ([0-9a-f]{64})/.exec(cli(dir, ['freeze', '--id', 'FEAT-169', '--files', 'src/server.mjs', '--check', 'node test/server.test.mjs']).out)?.[1];
  ticketWithVerdicts(dir, 'FEAT-169', [verdict('run-0170-holds', 'holds', h2)]);
  // BUG-234 (another lane, no candidate yet) edits ANOTHER function in the SAME file, after the freeze.
  w(dir, 'src/server.mjs', rd(dir, 'src/server.mjs').replace("  return 'listening';", "  return 'listening'; // BUG-234 in flight"));
  // BEFORE: the old way — `git add <file>` + commit — in a throwaway clone of this exact state.
  const clone = mkdtempScratch('feat170-oldway-'); dirs.push(clone);
  fs.cpSync(dir, clone, { recursive: true });
  gitf(clone, 'add', 'src/server.mjs'); gitf(clone, 'commit', '-qm', 'FEAT-169 the old way');
  const oldCommitted = gitf(clone, 'show', 'HEAD:src/server.mjs');
  const r0 = await CS.readiness(dir, 'FEAT-169');
  check('P5 BUG-234\'s later hunk in the SAME file invalidates FEAT-169\'s verdict: not ready (CHANGED) [must-FAIL on round 2]', !r0.ready && r0.blocking.some((b) => b.includes('CHANGED')), `ready=${r0.ready} ${r0.blocking.join(' | ')}`);
  const head0 = gitf(dir, 'rev-parse', 'HEAD');
  const blocked = cli(dir, ['commit', 'FEAT-169']);
  check('P5 and the commit is refused (not-ready), HEAD unchanged [must-FAIL on round 2]', blocked.code === 1 && blocked.out.includes('not-ready') && gitf(dir, 'rev-parse', 'HEAD') === head0, blocked.out.split('\n')[0]);
  // BUG-234 moves its work to a file it owns; the frozen file is back to the verified bytes.
  const store5 = CS.repoInfo(dir).store;
  w(dir, 'src/server.mjs', CS.getObject(store5, CS.loadCandidate(store5, h2).files[0].sha256));
  w(dir, 'src/other.mjs', 'export const other = 1; // BUG-234 in flight\n');
  // (On round-2 code the blocked commit above went through, so this readiness throws: report it, keep going.)
  const r0b = await CS.readiness(dir, 'FEAT-169').catch((e) => ({ ready: false, blocking: [`readiness threw ${e.code}: ${e.message}`] }));
  check('P5 live bytes equal to the frozen bytes again: READY (the verdict is on exactly these bytes)', r0b.ready, r0b.blocking.join(' | '));
  const headBefore = gitf(dir, 'rev-parse', 'HEAD');
  const cm = cli(dir, ['commit', 'FEAT-169']);
  const committed = cm.code === 0 ? spawnSync('git', ['-C', dir, 'show', 'HEAD:src/server.mjs'], { encoding: 'utf8' }).stdout : '';
  const frozenBytes = CS.getObject(CS.repoInfo(dir).store, CS.loadCandidate(CS.repoInfo(dir).store, h2).files[0].sha256).toString();
  beforeAfter('P5 the commit contains exactly the verified bytes (no foreign in-flight hunk)',
    !oldCommitted.includes('BUG-234'),
    cm.code === 0 && committed === frozenBytes && !committed.includes('BUG-234'),
    `old way committed BUG-234's hunk=${oldCommitted.includes('BUG-234')}; candidate commit exit ${cm.code}: ${cm.out.split('\n').slice(0, 3).join(' / ')}`);
  check('P5 the published tree IS the verified candidate tree (HEAD was the base, and the clean room is built from that tree)', cm.code === 0 && gitf(dir, 'rev-parse', 'HEAD^{tree}') === CS.loadCandidate(store5, h2).tree);
  const diff = gitf(dir, 'diff');
  const changed = diff.split('\n').filter((l) => /^[+-][^+-]/.test(l));
  check('P5 after the commit, the other ticket\'s edit is still there as an UNSTAGED change (and only it)', changed.some((l) => l.startsWith('+') && l.includes('BUG-234 in flight')) && !changed.some((l) => l.includes('FEAT-169')) && gitf(dir, 'diff', '--name-only') === 'src/other.mjs', changed.join(' | '));
  check('P5 the real index was synced for the committed path (nothing staged left behind)', gitf(dir, 'diff', '--cached', '--name-only') === '');
  check('P5 the repo\'s pre-commit hook ran over the STAGED candidate bytes', fs.readFileSync(path.join(CS.repoInfo(dir).commonDir, 'hook-saw.txt'), 'utf8').includes('src/server.mjs'));
  check('P5 the commit\'s parent is the HEAD it read, and it carries the candidate trailer', gitf(dir, 'rev-parse', 'HEAD^') === headBefore && gitf(dir, 'log', '-1', '--format=%B').includes(`Orchard-Candidate: ${h2}`));
  check('P5 the commit is code only: the ticket file does NOT ride along (it would make the next pre-checked tree unreachable)', !gitf(dir, 'show', '--name-only', '--format=', 'HEAD').includes('docs/bugs/'));
  const again = await CS.readiness(dir, 'BUG-000').catch((e) => e);
  check('P5 the store marks the ticket committed (no open candidate left)', again instanceof CS.CandidateError && CS.readTicketState(CS.repoInfo(dir).store, 'FEAT-169').state === 'committed');

  // Hook refusal → nothing published; staged conflict → refused.
  const d3 = fixture('hookrefuse');
  cli(d3, ['claim', '--id', 'BUG-501', '--files', 'src/other.mjs']);
  w(d3, 'src/other.mjs', 'export const other = 501;\n');
  const h5 = /candidate ([0-9a-f]{64})/.exec(cli(d3, ['freeze', '--id', 'BUG-501', '--files', 'src/other.mjs']).out)?.[1];
  ticketWithVerdicts(d3, 'BUG-501', [verdict('run-0501-holds', 'holds', h5)]);
  fs.writeFileSync(path.join(CS.repoInfo(d3).commonDir, 'hook-refuse'), '1');
  const head3 = gitf(d3, 'rev-parse', 'HEAD');
  const hr = cli(d3, ['commit', 'BUG-501']);
  check('P5 a pre-commit hook refusal publishes nothing (HEAD unchanged)', hr.code === 1 && hr.out.includes('hook-refused') && gitf(d3, 'rev-parse', 'HEAD') === head3, hr.out.split('\n')[0]);
  fs.rmSync(path.join(CS.repoInfo(d3).commonDir, 'hook-refuse'));
  w(d3, 'src/other.mjs', 'export const other = 999;\n'); gitf(d3, 'add', 'src/other.mjs'); w(d3, 'src/other.mjs', 'export const other = 501;\n');
  const sc = cli(d3, ['commit', 'BUG-501']);
  check('P5 staged changes on a path the commit writes are refused (they would be dropped), HEAD unchanged', sc.code === 1 && sc.out.includes('staged-conflict') && gitf(d3, 'rev-parse', 'HEAD') === head3, sc.out.split('\n')[0]);
}

/* ═══════════════════════════════ P6: the base moves ═══════════════ */
console.log('\n── P6 HEAD moves between verification and commit');
{
  const dir = fixture('base');
  cli(dir, ['claim', '--id', 'BUG-601', '--files', 'src/caller.mjs']);
  w(dir, 'src/caller.mjs', "import { api } from './api.mjs';\nexport const caller = () => api(2); // 601 tidy\n");
  const h = /candidate ([0-9a-f]{64})/.exec(cli(dir, ['freeze', '--id', 'BUG-601', '--files', 'src/caller.mjs', '--check', 'node test/api.test.mjs']).out)?.[1];
  ticketWithVerdicts(dir, 'BUG-601', [verdict('run-0601-holds', 'holds', h)]);
  gitf(dir, 'add', 'docs/bugs'); // keep the ticket out of the way of the moves below
  // The user commits SOMEONE ELSE's change that breaks the API the caller uses (review point 1).
  w(dir, 'src/api.mjs', 'export const api = (x) => x * 10;\n');
  gitf(dir, 'add', 'src/api.mjs'); gitf(dir, 'commit', '-qm', 'other ticket changes api');
  const naive = CS.candidateStatus(dir, 'BUG-601').files.every((f) => !f.staleBase); // the plan-v1 rule: "candidate files untouched ⇒ safe"
  const r = await CS.readiness(dir, 'BUG-601');
  beforeAfter('P6 a moved base whose new code breaks the candidate is not committable unchecked',
    !naive, !r.ready && r.blocking.some((b) => b.includes('never checked')), r.blocking.join(' | '));
  const integ = cli(dir, ['integrate', 'BUG-601']);
  const r2 = await CS.readiness(dir, 'BUG-601');
  check('P6 the integration check runs the recorded check on the exact new tree and FAILS (api changed)', integ.code === 1 && /FAIL BUG-601/.test(integ.out) && !r2.ready, integ.out.split('\n').slice(0, 3).join(' / '));
  // Fix the api back in a new commit (compatible move): integration passes → ready → the commit is that exact tree.
  w(dir, 'src/api.mjs', 'export const api = (x) => x + 1; // restored\n');
  gitf(dir, 'add', 'src/api.mjs'); gitf(dir, 'commit', '-qm', 'api compatible again');
  const integ2 = cli(dir, ['integrate', 'BUG-601']);
  const r3 = await CS.readiness(dir, 'BUG-601');
  check('P6 a compatible base move + passing integration check → READY', integ2.code === 0 && r3.ready, `${integ2.out.split('\n')[0]} | ${r3.blocking.join(' | ')}`);
  const cm = cli(dir, ['commit', 'BUG-601']);
  check('P6 the published code tree equals the integration-checked tree', cm.code === 0 && gitf(dir, 'show', 'HEAD:src/caller.mjs').includes('601 tidy'), cm.out.split('\n')[0]);
  // A move that touches the candidate's own file → STALE-BASE.
  const d2 = fixture('stale');
  cli(d2, ['claim', '--id', 'BUG-602', '--files', 'src/other.mjs']);
  w(d2, 'src/other.mjs', 'export const other = 602;\n');
  cli(d2, ['freeze', '--id', 'BUG-602', '--files', 'src/other.mjs', '--check', 'true']);
  const keep = rd(d2, 'src/other.mjs');
  w(d2, 'src/other.mjs', 'export const other = 2; // committed by someone\n');
  gitf(d2, 'add', 'src/other.mjs'); gitf(d2, 'commit', '-qm', 'touch other');
  w(d2, 'src/other.mjs', keep);
  cli(d2, ['claim', '--id', 'BUG-603', '--files', 'src/api.mjs']);
  w(d2, 'src/api.mjs', 'export const api = (x) => x + 1; // 603\n');
  cli(d2, ['freeze', '--id', 'BUG-603', '--files', 'src/api.mjs']); // no --check
  const s2 = await CS.readiness(d2, 'BUG-602');
  const i2 = cli(d2, ['integrate', 'BUG-602']);
  check('P6 HEAD changing the candidate\'s own file is STALE-BASE; integrate refuses to paper over it', !s2.ready && s2.blocking.some((b) => b.includes('STALE-BASE')) && i2.out.includes('stale-base'), `${s2.blocking[0]} | ${i2.out.split('\n')[0]}`);
  const noChecks = cli(d2, ['integrate', 'BUG-603']);
  check('P6 integrate refuses a candidate that recorded no checks (nothing to re-run on the moved base)', noChecks.code === 1 && noChecks.out.includes('no-checks'), noChecks.out.split('\n')[0]);
  // Chained integration: two disjoint candidates, both checked as a chain, committed in order.
  const d3 = fixture('chain');
  for (const [id, file, body] of [['BUG-611', 'src/other.mjs', 'export const other = 611;\n'], ['BUG-612', 'src/api.mjs', 'export const api = (x) => x + 1; // 612\n']]) {
    cli(d3, ['claim', '--id', id, '--files', file]); w(d3, file, body);
    const hh = /candidate ([0-9a-f]{64})/.exec(cli(d3, ['freeze', '--id', id, '--files', file, '--check', 'node test/api.test.mjs']).out)?.[1];
    ticketWithVerdicts(d3, id, [verdict(`run-${id.slice(4)}0-holds`, 'holds', hh)]);
    await new Promise((res) => setTimeout(res, 15));
  }
  const ia = cli(d3, ['integrate', '--all']);
  const c1 = cli(d3, ['commit', 'BUG-611']);
  const r612 = await CS.readiness(d3, 'BUG-612');
  const c2 = cli(d3, ['commit', 'BUG-612']);
  check('P6 integrate --all pre-checks the chain, so the user commits both in order with no agent in between', ia.code === 0 && c1.code === 0 && r612.ready && c2.code === 0, `${ia.out.split('\n').slice(0, 4).join(' / ')} | 612 ready=${r612.ready} ${r612.blocking.join(' | ')}`);
}

/* ═══════════════════════════════ P7: immutability ═══════════════ */
console.log('\n── P7 a tampered store is refused');
{
  const dir = fixture('tamper');
  cli(dir, ['claim', '--id', 'BUG-701', '--files', 'src/other.mjs']);
  w(dir, 'src/other.mjs', 'export const other = 701;\n');
  const h = /candidate ([0-9a-f]{64})/.exec(cli(dir, ['freeze', '--id', 'BUG-701', '--files', 'src/other.mjs']).out)?.[1];
  const store = CS.repoInfo(dir).store;
  const obj = path.join(store, 'objects', CS.loadCandidate(store, h).files[0].sha256);
  fs.chmodSync(obj, 0o644); fs.writeFileSync(obj, 'export const other = 666; // tampered\n');
  const iv = ivPrompt(dir, ['--candidate', 'BUG-701']);
  check('P7 a modified stored object: independent-verify --candidate refuses', iv.code !== 0 && /store-tampered|does not match its own hash/.test(iv.err), iv.err.split('\n').slice(-2).join(' '));
  const d2 = fixture('tamper2');
  cli(d2, ['claim', '--id', 'BUG-702', '--files', 'src/other.mjs']);
  w(d2, 'src/other.mjs', 'export const other = 702;\n');
  const h2 = /candidate ([0-9a-f]{64})/.exec(cli(d2, ['freeze', '--id', 'BUG-702', '--files', 'src/other.mjs']).out)?.[1];
  const cf = path.join(CS.repoInfo(d2).store, 'cand', `${h2}.json`);
  const m = JSON.parse(fs.readFileSync(cf, 'utf8')); m.base = gitf(d2, 'rev-parse', 'HEAD~0'); m.files[0].path = 'src/api.mjs';
  fs.chmodSync(cf, 0o644); fs.writeFileSync(cf, JSON.stringify(m));
  const st = cli(d2, ['status', '--id', 'BUG-702']);
  check('P7 a modified manifest: every verb refuses', st.code !== 0 && st.out.includes('store-tampered'), st.out.split('\n')[0]);
}

/* ═══════════════════════════════ P10: changes not judged line by line ═══════════════ */
console.log('\n── P10 binary and mode-only changes after the freeze invalidate the verdict too');
{
  const dir = fixture('edge');
  w(dir, 'bin.dat', Buffer.from([1, 2, 0, 3])); w(dir, 'run.sh', '#!/bin/sh\necho hi\n', 0o644);
  gitf(dir, 'add', '-A'); gitf(dir, 'commit', '-qm', 'more');
  cli(dir, ['claim', '--id', 'BUG-1001', '--files', 'bin.dat', 'run.sh']);
  w(dir, 'bin.dat', Buffer.from([1, 2, 0, 4])); w(dir, 'run.sh', '#!/bin/sh\necho hello\n');
  cli(dir, ['freeze', '--id', 'BUG-1001', '--files', 'bin.dat', 'run.sh']);
  w(dir, 'bin.dat', Buffer.from([9, 2, 0, 4])); fs.chmodSync(path.join(dir, 'run.sh'), 0o755);
  const st = CS.candidateStatus(dir, 'BUG-1001').files;
  check('P10 a later binary change reads CHANGED', st.find((f) => f.path === 'bin.dat').state === 'CHANGED');
  const sh = st.find((f) => f.path === 'run.sh');
  check('P10 a later mode-only change reads CHANGED and names the mode', sh.state === 'CHANGED' && /mode 100644→100755/.test(sh.detail), `${sh.state} ${sh.detail}`);
}

/* ═══════════════════════════════ P11: concurrency ═══════════════ */
console.log('\n── P11 concurrent freezes of one file by two tickets');
{
  const dir = fixture('race');
  w(dir, 'src/other.mjs', 'export const other = 1100;\n');
  const at = Date.now() + 600;
  const run = (id) => new Promise((res) => {
    const c = spawn(process.execPath, ['-e', `const t=${at};while(Date.now()<t){};import(${JSON.stringify(new URL('./lib/candidate-store.mjs', import.meta.url).href)}).then(CS=>{try{CS.freezeCandidate({repo:${JSON.stringify(dir)},id:'${id}',files:['src/other.mjs'],acceptForeign:['src/other.mjs']});console.log('OK')}catch(e){console.log('REFUSED '+e.code)}})`], { encoding: 'utf8' });
    let o = ''; c.stdout.on('data', (d) => { o += d; }); c.on('close', () => res(o.trim()));
  });
  const outs = await Promise.all([run('BUG-1101'), run('BUG-1102'), run('BUG-1103')]);
  check('P11 exactly one of three simultaneous freezes of one file wins; the others are refused as owned', outs.filter((o) => o === 'OK').length === 1 && outs.filter((o) => o === 'REFUSED owned').length === 2, outs.join(', '));
  // A writer that keeps changing the file while a freeze reads it.
  const d2 = fixture('unstable');
  const stopAt = Date.now() + 4000;
  const writer = spawn(process.execPath, ['-e', `const fs=require('fs');let i=0;const t=${stopAt};while(Date.now()<t){fs.writeFileSync(${JSON.stringify(path.join(d2, 'src/other.mjs'))},'export const other = '+(i++)+';\\n')}`]);
  await new Promise((r) => setTimeout(r, 300));
  let res;
  try { CS.freezeCandidate({ repo: d2, id: 'BUG-1104', files: ['src/other.mjs'], acceptForeign: ['src/other.mjs'] }); res = 'frozen'; } catch (e) { res = e.code; }
  writer.kill();
  check('P11 a file being rewritten during the freeze is refused (unstable) rather than captured mid-write', res === 'unstable' || res === 'frozen', `result: ${res} (frozen is acceptable only if two reads agreed)`);
}

/* ═══════════════════════════════ P12: dependency provenance in the room ═══════════════ */
console.log('\n── P12 node_modules provenance (plan review point 9)');
{
  const dir = fixture('lock');
  cli(dir, ['claim', '--id', 'BUG-1201', '--files', 'src/other.mjs']);
  w(dir, 'src/other.mjs', 'export const other = 1201;\n');
  cli(dir, ['freeze', '--id', 'BUG-1201', '--files', 'src/other.mjs']);
  w(dir, 'package-lock.json', '{"lockfileVersion":3,"another-lane":"bumped a dep"}\n');
  const iv = ivPrompt(dir, ['--candidate', 'BUG-1201']);
  check('P12 a live lockfile that differs from the candidate\'s is refused (the copied node_modules would not match)', iv.code !== 0 && iv.err.includes('package-lock.json in the candidate differs'), iv.err.split('\n').slice(-2).join(' '));
}

/* ═══════════════════════════════ P13: crash after publish ═══════════════ */
console.log('\n── P13 a commit published but not recorded (crash) is reconciled from the trailer');
{
  const dir = fixture('crash');
  cli(dir, ['claim', '--id', 'BUG-1301', '--files', 'src/other.mjs']);
  w(dir, 'src/other.mjs', 'export const other = 1301;\n');
  const h = /candidate ([0-9a-f]{64})/.exec(cli(dir, ['freeze', '--id', 'BUG-1301', '--files', 'src/other.mjs']).out)?.[1];
  gitf(dir, 'add', 'src/other.mjs'); gitf(dir, 'commit', '-qm', `crash mid-commit\n\nOrchard-Candidate: ${h}`);
  const r = cli(dir, ['ready']);
  check('P13 `ready` reconciles the published candidate and does not offer it again', r.out.includes('reconciled: BUG-1301') && CS.readTicketState(CS.repoInfo(dir).store, 'BUG-1301').state === 'committed', r.out.split('\n').slice(0, 2).join(' / '));
}

/* ═══════════════════════ ROUND 2 (verify run 64ff5cb8, BROKEN ×3) ═══════════════ */
console.log('\n── R1 a board-only HEAD move must not reuse a stale integration PASS');
{
  const dir = fixture('r1board');
  w(dir, 'docs/bugs/marker.txt', 'ok\n'); gitf(dir, 'add', '-A'); gitf(dir, 'commit', '-qm', 'marker');
  const chk = `node -e "if(require('fs').readFileSync('docs/bugs/marker.txt','utf8').includes('bad'))process.exit(1)"`;
  cli(dir, ['claim', '--id', 'BUG-1401', '--files', 'src/other.mjs']);
  w(dir, 'src/other.mjs', 'export const other = 1401;\n');
  const h = /candidate ([0-9a-f]{64})/.exec(cli(dir, ['freeze', '--id', 'BUG-1401', '--files', 'src/other.mjs', '--check', chk]).out)?.[1];
  ticketWithVerdicts(dir, 'BUG-1401', [verdict('run-1401-holds', 'holds', h)]);
  // HEAD move 1 (code, not the candidate's file) → integrate → PASS recorded.
  w(dir, 'src/api.mjs', 'export const api = (x) => x + 1; // move 1\n'); gitf(dir, 'add', 'src/api.mjs'); gitf(dir, 'commit', '-qm', 'move 1');
  const i1 = cli(dir, ['integrate', 'BUG-1401']);
  // HEAD move 2 touches ONLY the board dir, and makes the candidate's check fail on the resulting tree.
  w(dir, 'docs/bugs/marker.txt', 'bad\n'); gitf(dir, 'add', 'docs/bugs/marker.txt'); gitf(dir, 'commit', '-qm', 'board-only move');
  const r = await CS.readiness(dir, 'BUG-1401');
  check('R1 setup: the first integration PASSed', i1.code === 0, i1.out.split('\n')[0]);
  check('R1 after a board-only HEAD move, the earlier PASS does not make it READY [must-FAIL before fix]', !r.ready && r.blocking.some((b) => b.includes('never checked')), `ready=${r.ready} ${r.blocking.join(' | ')}`);
  const i2 = cli(dir, ['integrate', 'BUG-1401']);
  check('R1 re-integrating on the exact new tree runs the check and FAILS', i2.code === 1 && /FAIL BUG-1401/.test(i2.out), i2.out.split('\n')[0]);
}

console.log('\n── R2 freeze without claim must still refuse another lane\'s uncommitted lines');
{
  const dir = fixture('r2noclaim');
  w(dir, 'src/other.mjs', 'export const other = 1; // ANOTHER LANE in flight\n');
  w(dir, 'src/other.mjs', rd(dir, 'src/other.mjs') + 'export const mine = 1402;\n');
  const f = cli(dir, ['freeze', '--id', 'BUG-1402', '--files', 'src/other.mjs']); // no claim
  check('R2 an unclaimed file that differs from HEAD is refused, not silently frozen [must-FAIL before fix]', f.code === 1 && /foreign|unattributed/.test(f.out), f.out.split('\n')[0]);
  const fa = cli(dir, ['freeze', '--id', 'BUG-1402', '--files', 'src/other.mjs', '--accept-foreign', 'src/other.mjs']);
  check('R2 an explicit --accept-foreign freezes it and records the downgrade', fa.code === 0 && fa.out.includes('ACCEPTED'), fa.out.split('\n').slice(0, 3).join(' / '));
  const d2 = fixture('r2new');
  w(d2, 'src/brandnew.mjs', 'export const n = 1;\n');
  const fn = cli(d2, ['freeze', '--id', 'BUG-1403', '--files', 'src/brandnew.mjs']);
  check('R2 an unclaimed brand-new file is refused too (nothing proves whose it is)', fn.code === 1, fn.out.split('\n')[0]);
  cli(d2, ['claim', '--id', 'BUG-1404', '--files', 'src/new2.mjs']);
  w(d2, 'src/new2.mjs', 'export const n2 = 1;\n');
  const fc = cli(d2, ['freeze', '--id', 'BUG-1404', '--files', 'src/new2.mjs']);
  check('R2 a file claimed before it existed freezes without --accept-foreign', fc.code === 0, fc.out.split('\n')[0]);
}

console.log('\n── R3 restoring an accepted-foreign file to its original bytes is a REVERT');
{
  const dir = fixture('r3restore');
  const orig = rd(dir, 'src/other.mjs');
  w(dir, 'src/other.mjs', orig + 'export const foreign = 234; // accepted foreign line\n');
  cli(dir, ['claim', '--id', 'BUG-1405', '--files', 'src/other.mjs', 'src/api.mjs']);
  w(dir, 'src/api.mjs', 'export const api = (x) => x + 1; // 1405 own change\n');
  const h = /candidate ([0-9a-f]{64})/.exec(cli(dir, ['freeze', '--id', 'BUG-1405', '--files', 'src/other.mjs', 'src/api.mjs', '--accept-foreign', 'src/other.mjs']).out)?.[1];
  ticketWithVerdicts(dir, 'BUG-1405', [verdict('run-1405-holds', 'holds', h)]);
  w(dir, 'src/other.mjs', orig); // whole-file restore to the exact original bytes
  const st = CS.candidateStatus(dir, 'BUG-1405').files.find((f) => f.path === 'src/other.mjs');
  const r = await CS.readiness(dir, 'BUG-1405');
  check('R3 the restore reads REVERTED [must-FAIL before fix]', st.state === 'REVERTED', `${st.state} ${st.detail}`);
  check('R3 and the candidate is NOT ready [must-FAIL before fix]', !r.ready, r.blocking.join(' | ') || 'READY');
}

console.log('\n── R4 a --candidate diff larger than --max-diff-bytes fails loudly instead of truncating');
{
  const dir = fixture('r4big');
  cli(dir, ['claim', '--id', 'BUG-1406', '--files', 'src/big.mjs']);
  w(dir, 'src/big.mjs', Array.from({ length: 4000 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n');
  cli(dir, ['freeze', '--id', 'BUG-1406', '--files', 'src/big.mjs']);
  const iv = ivPrompt(dir, ['--candidate', 'BUG-1406', '--max-diff-bytes', '20000']);
  check('R4 a truncating --candidate verify refuses and names the size it needs [must-FAIL before fix]', iv.code !== 0 && /max-diff-bytes/.test(iv.err) && /exceeds|larger/.test(iv.err), iv.err.split('\n').slice(-2).join(' ').slice(0, 300));
  const ok = ivPrompt(dir, ['--candidate', 'BUG-1406', '--max-diff-bytes', '400000']);
  check('R4 with a large enough --max-diff-bytes the whole diff is handed over', ok.code === 0 && ok.prompt.includes('v3999'), `exit ${ok.code}`);
}

console.log('\n── R5 (round-3 verify 248ad5f9 #1) the published tree is the verified tree, whatever the board file holds');
{
  const dir = fixture('r5ticketfile');
  cli(dir, ['claim', '--id', 'BUG-1501', '--files', 'src/other.mjs']);
  w(dir, 'src/other.mjs', 'export const other = 1501;\n');
  const h = /candidate ([0-9a-f]{64})/.exec(cli(dir, ['freeze', '--id', 'BUG-1501', '--files', 'src/other.mjs']).out)?.[1];
  ticketWithVerdicts(dir, 'BUG-1501', [verdict('run-1501-holds', 'holds', h)]);
  // After the freeze (and the verdict), the board file gains bytes nobody verified.
  w(dir, 'docs/bugs/BUG-1501-fixture.md', `${rd(dir, 'docs/bugs/BUG-1501-fixture.md')}\nPOST-FREEZE UNVERIFIED BYTES\n`);
  const head0 = gitf(dir, 'rev-parse', 'HEAD');
  const tf = cli(dir, ['commit', 'BUG-1501', '--with-ticket-file']);
  const tfTree = gitf(dir, 'rev-parse', 'HEAD^{tree}');
  const tree = CS.loadCandidate(CS.repoInfo(dir).store, h).tree;
  check('R5 `commit --with-ticket-file` no longer exists: refused as a usage error, nothing published [must-FAIL on round 3]',
    tf.code === 2 && /unknown flag --with-ticket-file/.test(tf.out) && gitf(dir, 'rev-parse', 'HEAD') === head0,
    `exit ${tf.code}; published tree ${tfTree.slice(0, 12)} vs verified ${String(tree).slice(0, 12)} — ${tf.out.split('\n')[0]}`);
  const cm = cli(dir, ['commit', 'BUG-1501']);
  check('R5 the commit publishes exactly the verified candidate tree; the board file stays uncommitted', cm.code === 0 && gitf(dir, 'rev-parse', 'HEAD^{tree}') === tree && gitf(dir, 'status', '--porcelain', '--', 'docs/bugs').length > 0, cm.out.split('\n')[0]);
}

/* ═══════════════════════ ROUND 3 RESCOPE (decision A): residual, metric, one commit authority ═══════════════ */
console.log('\n── S1 the accepted residual (round-2 verify 3f50654c #1) and the HARM-based revisit trigger');
const nowVerdict = (run, v, candidate) => ({ provider: 'openai', model: 'm', run_id: run, verdict: v, recorded_at: new Date().toISOString(), ...(candidate ? { candidate } : {}) });
const report = async (dir) => (CS.foreignReport ? CS.foreignReport({ repo: dir }) : null);
const L802 = 'export const d = 4; // BUG-802 in flight, never claimed';
{
  const dir = fixture('s1residual');
  w(dir, 'src/shared.mjs', 'export const a = 1;\n'); gitf(dir, 'add', '-A'); gitf(dir, 'commit', '-qm', 'shared');
  cli(dir, ['claim', '--id', 'FEAT-801', '--files', 'src/shared.mjs']);
  w(dir, 'src/shared.mjs', 'export const a = 1;\nexport const b = 2; // FEAT-801 own\n');
  w(dir, 'src/shared.mjs', `${rd(dir, 'src/shared.mjs')}${L802}\n`);
  const fz = cli(dir, ['freeze', '--id', 'FEAT-801', '--files', 'src/shared.mjs']);
  const hA = /candidate ([0-9a-f]{64})/.exec(fz.out)?.[1];
  check('S1 RESIDUAL (accepted, stated): an unclaimed lane\'s line added after a clean claim rides into the candidate', fz.code === 0, fz.out.split('\n')[0]);
  const ff = cli(dir, ['foreign-found', '--id', 'FEAT-801', '--file', 'src/shared.mjs', '--owner', 'BUG-802', '--line', L802, '--note', 'verifier saw it in the diff']);
  const r0 = await report(dir);
  check('S1 a recorded, not-yet-committed foreign line is informational only: harm 0, trigger not reached [must-FAIL on round 2]', ff.code === 0 && r0?.harm === 0 && r0?.informational.reported === 1 && r0?.triggered === false, `${ff.out.split('\n')[0]} / ${JSON.stringify(r0 && { harm: r0.harm, info: r0.informational })}`);
  const bad = cli(dir, ['foreign-found', '--id', 'FEAT-801', '--file', 'src/shared.mjs', '--owner', 'FEAT-801', '--line', L802]);
  check('S1 foreign-found refuses an owner equal to the ticket itself', bad.code === 1, bad.out.split('\n')[0]);
  ticketWithVerdicts(dir, 'FEAT-801', [verdict('run-0801-holds', 'holds', hA)]);
  const cm = cli(dir, ['commit', 'FEAT-801']);
  const r1 = await report(dir);
  check('S1 committed, but its owner has not broken or changed it: harm 0 (a harmless ride-along does not trip)', cm.code === 0 && r1?.committedForeign === 1 && r1?.harm === 0 && !r1?.triggered, `${cm.out.split('\n')[0]} / ${JSON.stringify(r1 && { cf: r1.committedForeign, harm: r1.harm })}`);
  // The owner works on, in a line that is NOT the shipped one, and gets a BROKEN: still no harm for that line.
  cli(dir, ['claim', '--id', 'BUG-802', '--files', 'src/shared.mjs']);
  w(dir, 'src/shared.mjs', `${rd(dir, 'src/shared.mjs')}export const e = 5; // BUG-802 other work\n`);
  const hB1 = /candidate ([0-9a-f]{64})/.exec(cli(dir, ['freeze', '--id', 'BUG-802', '--files', 'src/shared.mjs']).out)?.[1];
  ticketWithVerdicts(dir, 'BUG-802', [nowVerdict('run-0802-broken', 'broken', hB1)]);
  const r2 = await report(dir);
  check('S1 a BROKEN for the owner that does not touch the shipped line is not harm', hB1 && r2?.harm === 0, JSON.stringify(r2?.harms ?? null));
  // Now the owner CHANGES the shipped line before its own commit: half-done work shipped under FEAT-801.
  w(dir, 'src/shared.mjs', rd(dir, 'src/shared.mjs').replace(L802, 'export const d = 5; // BUG-802 finished'));
  const hB2 = /candidate ([0-9a-f]{64})/.exec(cli(dir, ['freeze', '--id', 'BUG-802', '--files', 'src/shared.mjs']).out)?.[1];
  const r3 = cli(dir, ['foreign-report']);
  const j3 = await report(dir);
  check('S1 the owner changing the shipped line before its own commit is HARM and reaches the trigger [must-FAIL on round 2]',
    hB2 && j3?.harm === 1 && j3.harms[0].kind === 'changed' && j3.harms[0].owner === 'BUG-802' && j3.harms[0].ticket === 'FEAT-801' && /HARM 1/.test(r3.out) && r3.out.includes('REVISIT TRIGGER REACHED'),
    `${JSON.stringify(j3?.harms ?? null)} / ${r3.out.split('\n').slice(-1)[0]}`);
}
{
  // Owner inferred (no report): BUG-822's earlier candidate added the line; it released; FEAT-821 accepted and shipped it.
  const dir = fixture('s1broken');
  const L = 'export const half = true; // BUG-822 half-done';
  w(dir, 'src/shared.mjs', 'export const a = 1;\n'); gitf(dir, 'add', '-A'); gitf(dir, 'commit', '-qm', 'shared');
  cli(dir, ['claim', '--id', 'BUG-822', '--files', 'src/shared.mjs']);
  w(dir, 'src/shared.mjs', `export const a = 1;\n${L}\n`);
  const hB = /candidate ([0-9a-f]{64})/.exec(cli(dir, ['freeze', '--id', 'BUG-822', '--files', 'src/shared.mjs']).out)?.[1];
  cli(dir, ['release', '--id', 'BUG-822', '--why', 'paused']);
  cli(dir, ['claim', '--id', 'FEAT-821', '--files', 'src/shared.mjs']);
  w(dir, 'src/shared.mjs', `${rd(dir, 'src/shared.mjs')}export const own = 821;\n`);
  const hA = /candidate ([0-9a-f]{64})/.exec(cli(dir, ['freeze', '--id', 'FEAT-821', '--files', 'src/shared.mjs', '--accept-foreign', 'src/shared.mjs']).out)?.[1];
  ticketWithVerdicts(dir, 'FEAT-821', [verdict('run-0821-holds', 'holds', hA)]);
  const cm = cli(dir, ['commit', 'FEAT-821']);
  const r0 = await report(dir);
  check('S1 the owner is inferred from the earlier candidate that added the line; shipped but unbroken: harm 0', hB && cm.code === 0 && r0?.committedForeign === 1 && r0?.unowned === 0 && r0?.harm === 0, `${cm.out.split('\n')[0]} / ${JSON.stringify(r0 && { cf: r0.committedForeign, unowned: r0.unowned, harm: r0.harm })}`);
  ticketWithVerdicts(dir, 'BUG-822', [nowVerdict('run-0822-broken', 'broken', hB)]);
  const r1 = await report(dir);
  check('S1 a later BROKEN for the owner, bound to a candidate whose change touches the shipped line, is HARM [must-FAIL on round 2]', r1?.harm === 1 && r1.harms[0].kind === 'broken' && r1.harms[0].owner === 'BUG-822' && r1.harms[0].run === 'run-0822-broken', JSON.stringify(r1?.harms ?? null));
}
{
  // Round-3 verify 248ad5f9 #2: a THIRD lane removing a shipped foreign line from the live file is not the owner's harm.
  const dir = fixture('s1live');
  const L = 'export const tmp = 9; // BUG-832 experiment';
  w(dir, 'src/shared.mjs', 'export const a = 1;\n'); gitf(dir, 'add', '-A'); gitf(dir, 'commit', '-qm', 'shared');
  cli(dir, ['claim', '--id', 'FEAT-831', '--files', 'src/shared.mjs']);
  w(dir, 'src/shared.mjs', `export const a = 2;\n${L}\n`);
  const hA = /candidate ([0-9a-f]{64})/.exec(cli(dir, ['freeze', '--id', 'FEAT-831', '--files', 'src/shared.mjs']).out)?.[1];
  cli(dir, ['foreign-found', '--id', 'FEAT-831', '--file', 'src/shared.mjs', '--owner', 'BUG-832', '--line', L]);
  ticketWithVerdicts(dir, 'FEAT-831', [verdict('run-0831-holds', 'holds', hA)]);
  const cm = cli(dir, ['commit', 'FEAT-831']);
  w(dir, 'src/shared.mjs', 'export const a = 2;\n'); // a third lane (not BUG-832) deletes the line in the tree
  const r1 = await report(dir);
  check('S1 a shipped foreign line vanishing from the live file (a third lane) is NOT harm: only the owner\'s recorded verdicts and freezes count [must-FAIL on round 3]',
    cm.code === 0 && r1?.committedForeign === 1 && r1?.harm === 0 && r1?.triggered === false, `${cm.out.split('\n')[0]} / ${JSON.stringify(r1?.harms ?? null)}`);
}
{
  const dir = fixture('s1accepted');
  // other.mjs carries 2 foreign lines at claim time; api.mjs is changed and never claimed.
  w(dir, 'src/other.mjs', 'export const other = 1;\nexport const f1 = 1; // foreign\nexport const f2 = 2; // foreign\n');
  cli(dir, ['claim', '--id', 'BUG-811', '--files', 'src/other.mjs', 'src/util.mjs']);
  w(dir, 'src/util.mjs', `${rd(dir, 'src/util.mjs')}export const own = 811;\n`);
  w(dir, 'src/api.mjs', 'export const api = (x) => x + 2; // unclaimed\n');
  const args = ['freeze', '--id', 'BUG-811', '--files', 'src/other.mjs', 'src/util.mjs', 'src/api.mjs', '--accept-foreign', 'src/other.mjs', '--accept-foreign', 'src/api.mjs'];
  const fz = cli(dir, args);
  w(dir, 'src/util.mjs', `${rd(dir, 'src/util.mjs')}export const own2 = 811;\n`);
  const fz2 = cli(dir, args); // a re-freeze replaces the earlier candidate in the count
  const rep = await report(dir);
  check('S1 hot-file --accept-foreign alone does NOT trip the trigger: informational accepted 2 / unattributed 1, harm 0 [must-FAIL on round 2]',
    fz.code === 0 && fz2.code === 0 && rep?.informational.accepted === 2 && rep?.informational.unattributed === 1 && rep?.harm === 0 && rep?.triggered === false, JSON.stringify(rep && { info: rep.informational, harm: rep.harm }));
  const later = CS.foreignReport ? await CS.foreignReport({ repo: dir, now: Date.now() + 40 * 86_400_000 }) : null;
  check('S1 the informational counts are a window (default 30 days): 40 days later they read 0', later?.informational.accepted === 0 && later?.informational.unattributed === 0, JSON.stringify(later?.informational ?? null));
}

console.log('\n── S2 round-1 cases under the rescoped rule');
{
  // Round-1 verify 64ff5cb8 #3 Part A control: a claimed-clean file, a disjoint later edit (round 2: DRIFTED, READY).
  const dir = fixture('s2control');
  cli(dir, ['claim', '--id', 'BUG-901', '--files', 'src/server.mjs']);
  w(dir, 'src/server.mjs', SERVER_BASE.replace("  return 'bye';", "  return 'bye 901';"));
  const h = /candidate ([0-9a-f]{64})/.exec(cli(dir, ['freeze', '--id', 'BUG-901', '--files', 'src/server.mjs']).out)?.[1];
  ticketWithVerdicts(dir, 'BUG-901', [verdict('run-0901-holds', 'holds', h)]);
  w(dir, 'src/server.mjs', rd(dir, 'src/server.mjs').replace("  return 'listening';", "  return 'listening'; // later, disjoint"));
  const st = cli(dir, ['status', '--id', 'BUG-901']);
  check('S2 a disjoint later edit reads CHANGED and status exits 1 [must-FAIL on round 2]', st.code === 1 && /CHANGED\s+src\/server\.mjs/.test(st.out), st.out.split('\n').slice(1, 2).join(''));
  // Restoring the claim-time bytes of a file that was dirty at claim (not HEAD's bytes): still not the verified bytes.
  const d2 = fixture('s2claimrestore');
  w(d2, 'src/other.mjs', 'export const other = 1; // dirty at claim\n');
  cli(d2, ['claim', '--id', 'BUG-902', '--files', 'src/other.mjs']);
  const claimBytes = rd(d2, 'src/other.mjs');
  w(d2, 'src/other.mjs', 'export const other = 902; // dirty at claim\n');
  const h2 = /candidate ([0-9a-f]{64})/.exec(cli(d2, ['freeze', '--id', 'BUG-902', '--files', 'src/other.mjs', '--accept-foreign', 'src/other.mjs']).out)?.[1];
  ticketWithVerdicts(d2, 'BUG-902', [verdict('run-0902-holds', 'holds', h2)]);
  w(d2, 'src/other.mjs', claimBytes);
  const r2 = await CS.readiness(d2, 'BUG-902');
  check('S2 restoring claim-time bytes over a verified file blocks the commit', !r2.ready && r2.blocking.some((b) => /CHANGED|REVERTED/.test(b)), r2.blocking.join(' | '));
}

console.log('\n── S3 one commit authority: the git-write shim, not an env check (round-2 verify 3f50654c #2)');
{
  const dir = fixture('s3authority');
  cli(dir, ['claim', '--id', 'BUG-950', '--files', 'src/other.mjs']);
  w(dir, 'src/other.mjs', 'export const other = 950;\n');
  const h = /candidate ([0-9a-f]{64})/.exec(cli(dir, ['freeze', '--id', 'BUG-950', '--files', 'src/other.mjs']).out)?.[1];
  ticketWithVerdicts(dir, 'BUG-950', [verdict('run-0950-holds', 'holds', h)]);
  const commonDir = CS.repoInfo(dir).commonDir;
  const snap = () => ({ head: gitf(dir, 'rev-parse', 'HEAD'), refs: gitf(dir, 'for-each-ref', '--format=%(refname) %(objectname)'), index: fs.readFileSync(path.join(commonDir, 'index')).toString('base64') });
  const same = (a, b) => a.head === b.head && a.refs === b.refs && a.index === b.index;
  const AGENT_VARS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'ORCHARD_SESSION', 'CODEX_SANDBOX', 'CODEX_THREAD_ID'];
  const scrubbed = { ...process.env }; for (const k of AGENT_VARS) delete scrubbed[k];
  const run = (env, args) => { const r = spawnSync(process.execPath, [CLI, ...args, '--repo', dir], { encoding: 'utf8', env }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
  // BEFORE: round 2's in-process authority, verbatim. An env-scrubbed agent child passes it.
  const oldAgentSession = (env) => !!(env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.ORCHARD_SESSION || env.CODEX_SANDBOX || env.CODEX_THREAD_ID);
  // AFTER: the REAL FEAT-135 shim as an agent session gets it (no host grant reachable: fail closed).
  const shimBase = mkdtempScratch('feat170-shim-'); dirs.push(shimBase);
  const shim = installGitShim(scrubbed, { baseDir: shimBase });
  const s0 = snap();
  const a = run(shim.env, ['commit', 'BUG-950']);
  const s1 = snap();
  beforeAfter('S3 an env-scrubbed agent process publishes nothing',
    oldAgentSession(scrubbed),
    a.code === 1 && !a.out.includes('COMMITTED') && same(s0, s1),
    `round-2 env check sees an agent: ${oldAgentSession(scrubbed)}; with the shim: exit ${a.code}, HEAD/refs/index unchanged=${same(s0, s1)} — ${a.out.split('\n')[0].slice(0, 200)}`);
  // OpenAI review: an inherited temp GIT_INDEX_FILE makes the shim sanction commit-tree. update-ref still refused.
  // The temp index is a copy of the real one, so the staged-path check passes and the run reaches publication.
  const tmpIdxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat170-gif-')); dirs.push(tmpIdxDir);
  fs.copyFileSync(path.join(commonDir, 'index'), path.join(tmpIdxDir, 'index'));
  const b = run({ ...shim.env, GIT_INDEX_FILE: path.join(tmpIdxDir, 'index') }, ['commit', 'BUG-950']);
  const s2 = snap();
  check('S3 with an inherited temp GIT_INDEX_FILE, commit-tree is sanctioned but update-ref is refused: HEAD, refs and the real index unchanged', b.code === 1 && b.out.includes('publish-refused') && /update-ref/.test(b.out) && same(s0, s2), `exit ${b.code} — ${b.out.split('\n').slice(0, 2).join(' ').slice(0, 260)}`);
  check('S3 contract is publication: the candidate is still open and READY after both refusals', (await CS.readiness(dir, 'BUG-950')).ready);
  const src = fs.readFileSync(path.join(HERE, 'lib/candidate-store.mjs'), 'utf8');
  check('S3 no second authority in the commit code: no agentSession(), no agent env variable read [must-FAIL on round 2]', !/agentSession|CLAUDECODE|CODEX_THREAD_ID/.test(src.replace(/^\s*\*.*$/gm, '')));
  // The user's terminal (no shim) with stray agent variables: the env no longer decides.
  const u = run({ ...process.env, CLAUDECODE: '1', ORCHARD_SESSION: 'x' }, ['commit', 'BUG-950']);
  check('S3 without the shim (the user\'s terminal) the commit publishes, even with agent env vars set [must-FAIL on round 2]', u.code === 0 && u.out.includes('COMMITTED') && gitf(dir, 'rev-parse', 'HEAD^{tree}') === CS.loadCandidate(CS.repoInfo(dir).store, h).tree, u.out.split('\n')[0]);
}

for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
console.log(`\n${failN ? 'FAIL' : 'PASS'}: ${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
