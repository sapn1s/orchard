#!/usr/bin/env node
/**
 * verify-feat-176-lane-snapshot.mjs — FEAT-176 (rescoped: RECOVERY is the guarantee).
 *   "Every file a lane wrote in the project with Write, Edit, MultiEdit, NotebookEdit or
 *    fileChange is either stored exactly, rebuilt by replaying its recorded edits, or named
 *    as unrecoverable with a reason. `lane-snapshot restore <lane|ticket>` writes the bytes
 *    back after backing up the live file. Taking a snapshot never delays a stop or changes
 *    a permission."
 * UNIT: P1 the 09-30 copy overwritten after AND before the snapshot; P2 a part-overwritten
 *   copy is UNVERIFIED (--force) — break (a); P7 path confinement — break (b); P3 delete then recreate; P4 a
 *   gitignored file; P5 over the cap is named unrecoverable (file and count caps); P6 undoing
 *   a restore; R4 retention; the trigger never waits; accounting; store damage. Real-transcript
 *   accounting is scripts/verify-feat-176-accounting.mjs.
 * SCRATCH SERVER: R1 the 09-30 replay through the real bridge (+ must-FAIL on a synthesized
 *   pre-change bridge); R2 a failing or hanging snapshot never delays the stop; R3 permission
 *   decisions unchanged (Task stays DENY).
 * Run in the confined runner (its fixture repos need their own version-control writes):
 *   node scripts/confined-run.mjs -- node scripts/verify-feat-176-lane-snapshot.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedServerEnv, isolatedStoreEnv } from './lib/station-boot.mjs';
import * as LS from './lib/lane-snapshot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLI = path.join(ROOT, 'scripts', 'lane-snapshot.mjs');
let pass = 0; let failN = 0;
const check = (name, ok, observed = '') => {
  if (ok) pass++; else failN++;
  const o = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${o ? `\n        observed: ${o.slice(0, 1200)}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const S = fs.mkdtempSync(path.join(os.tmpdir(), 'f176-'));
const REAL_GIT = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim() || '/usr/bin/git';
const fx = (dir, ...a) => { const r = spawnSync(REAL_GIT, ['-C', dir, ...a], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(`fixture git ${a.join(' ')}: ${r.stderr}`); return r.stdout; };
{ const probe = path.join(S, 'probe'); fs.mkdirSync(probe); if (spawnSync(REAL_GIT, ['-C', probe, 'init', '-q']).status !== 0) { console.log('COULD NOT RUN: git writes refused; run: node scripts/confined-run.mjs -- node scripts/verify-feat-176-lane-snapshot.mjs'); process.exit(2); } }

let repoN = 0;
function mkRepo(files, { git = true } = {}) {
  const dir = path.join(S, `repo${++repoN}`); fs.mkdirSync(dir, { recursive: true });
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  if (git) { fx(dir, 'init', '-q', '-b', 'main'); fx(dir, 'config', 'user.name', 'f'); fx(dir, 'config', 'user.email', 'f@x.invalid'); fx(dir, 'config', 'commit.gpgsign', 'false'); fx(dir, 'add', '-A'); fx(dir, 'commit', '-qm', 'base'); }
  return fs.realpathSync(dir);
}
let dataN = 0;
const mkEnv = (extra = {}) => ({ ...process.env, CLAUDE_STATION_DATA: path.join(S, `data${++dataN}`), ORCHARD_LANE_SNAPSHOT_REPARSE_MS: '0', ...extra });
let txN = 0;
/** A transcript: entries are [kind, ...]; tool_use ids are generated. */
function transcript(cwd, calls) {
  const f = path.join(S, `tx${++txN}`, `agent-x${txN}.jsonl`); fs.mkdirSync(path.dirname(f), { recursive: true });
  const lines = [];
  for (const c of calls) {
    const id = `toolu_${txN}_${lines.length}`;
    lines.push({ cwd: c.cwd || cwd, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: c.name, input: c.input }] } });
    lines.push({ cwd: c.cwd || cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: c.error ? 'error' : 'ok', ...(c.error ? { is_error: true } : {}) }] } });
  }
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}
const edit = (file, oldS, newS) => ({ name: 'Edit', input: { file_path: file, old_string: oldS, new_string: newS } });
/** Do an Edit on disk exactly as the tool would, and return its transcript call. */
function doEdit(file, oldS, newS) { const t = fs.readFileSync(file, 'utf8'); if (!t.includes(oldS)) throw new Error(`fixture edit: ${oldS} not in ${file}`); fs.writeFileSync(file, t.replace(oldS, newS)); return edit(file, oldS, newS); }
async function take(top, env, lane, extra = {}) { return LS.takeSnapshot({ v: 1, top, ...extra, lanes: [{ source: 'claude-subagent', status: 'completed', endedAt: Date.now(), ...lane }] }, { env }); }

const BASE_INDEX = ['// src/server/index.ts', 'import { ensureDir } from "./paths";', 'export function boot() {', '  ensureDir(dataDir());', '  startServer();', '}', ''].join('\n');
const LANE_HUNK = ['  // BUG-217 r9: lock the data DIRECTORY inode', '  const lock = lockDataDirectory(dataDir());', '  if (lock.drifted) process.exit(75);'].join('\n');

try {
  const cliCheck = (top, env, ...extra) => spawnSync(process.execPath, [CLI, 'check', '--repo', top, ...extra], { encoding: 'utf8', env });
  const cliRestore = (top, env, sel, ...extra) => spawnSync(process.execPath, [CLI, 'restore', sel, '--repo', top, ...extra], { encoding: 'utf8', env });
  const entryOf = (top, env, laneId, rel) => LS.readManifests(LS.storeDirFor(top, env)).find((m) => m.laneId === laneId)?.files?.find((x) => x.path === rel);

  /* ── U1 attribution ─────────────────────────────────────────────────── */
  {
    const top = mkRepo({ 'a.txt': 'alpha line here\n', 'n.ipynb': '{}\n', 'c.txt': 'gamma line\n' });
    const t = transcript(top, [
      { name: 'Write', input: { file_path: path.join(top, 'w.txt'), content: 'written whole file\n' } },
      edit(path.join(top, 'a.txt'), 'alpha', 'ALPHA'),
      { name: 'MultiEdit', input: { file_path: path.join(top, 'm.txt'), edits: [{ old_string: 'x', new_string: 'y' }] } },
      { name: 'NotebookEdit', input: { notebook_path: path.join(top, 'n.ipynb'), new_source: 'x' } },
      { name: 'fileChange', input: { changes: [{ path: path.join(top, 'codex.txt'), kind: { type: 'add' }, diff: 'from codex\n' }] } },
      { name: 'Bash', input: { command: 'cp /tmp/x c.txt' } },
      { name: 'Bash', input: { command: 'git checkout -- .' } },
      { name: 'Bash', input: { command: 'cp /tmp/y "$TARGET"' } },
      { name: 'Edit', input: { file_path: path.join(top, 'failed.txt'), old_string: 'a', new_string: 'b' }, error: true },
      { name: 'Bash', input: { command: 'npm test' } },
    ]);
    const r = await LS.extractWrites([t], { defaultCwd: top });
    const rels = [...r.files.keys()].map((p) => path.relative(top, p)).sort();
    check('U1 every successful write tool is attributed; a failed Edit and read-only commands are not', JSON.stringify(rels) === JSON.stringify(['a.txt', 'c.txt', 'codex.txt', 'm.txt', 'n.ipynb', 'w.txt']), rels);
    check('U1 tree-wide and unresolved shell writes are recorded as unattributed (residual)', r.unattributed.some((u) => u.reason === 'tree-wide') && r.unattributed.some((u) => u.reason === 'unresolved-target'), r.unattributed);
  }

  /* ── P1 the 09-30 copy: overwritten AFTER the snapshot, and BEFORE it ─── */
  {
    // after: an Edit lane, copy intact at lane end → stored; foreign cp later → restore exact
    const top = mkRepo({ 'src/server/index.ts': BASE_INDEX });
    const env = mkEnv();
    const f = path.join(top, 'src/server/index.ts');
    const pre = fs.readFileSync(f);
    const call = doEdit(f, '  ensureDir(dataDir());\n', `  ensureDir(dataDir());\n${LANE_HUNK}\n`);
    const laneBytes = fs.readFileSync(f);
    await take(top, env, { laneId: 'A930', ticket: ['BUG-217'], transcripts: [transcript(top, [call])] });
    check('P1a Edit-only lane: no replay base, so the lane-end copy is kept as UNVERIFIED', entryOf(top, env, 'A930', 'src/server/index.ts')?.recovery === 'unverified', entryOf(top, env, 'A930', 'src/server/index.ts'));
    fs.writeFileSync(f, pre); // the foreign cp, after the snapshot
    const c = cliCheck(top, env);
    check('P1a check warns (best-effort) naming file, lane and ticket', c.status === 1 && /src\/server\/index\.ts/.test(c.stdout) && /A930/.test(c.stdout) && /BUG-217/.test(c.stdout), c.stdout.slice(0, 400));
    const r0 = cliRestore(top, env, 'BUG-217');
    check('P1a restore without --force refuses the UNVERIFIED copy and writes nothing', r0.status === 1 && /UNVERIFIED/.test(r0.stdout) && sha(fs.readFileSync(f)) === sha(pre), r0.stdout.slice(0, 300));
    const r = cliRestore(top, env, 'BUG-217', '--force');
    check('P1a restore --force writes the copy and labels it UNVERIFIED', r.status === 0 && /RESTORED \(UNVERIFIED/.test(r.stdout) && sha(fs.readFileSync(f)) === sha(laneBytes), r.stdout.slice(0, 300));
    // before, Write-based lane: the copy is clobbered before the snapshot; replay rebuilds the exact bytes
    const top2 = mkRepo({ 'src/server/index.ts': BASE_INDEX });
    const env2 = mkEnv();
    const f2 = path.join(top2, 'src/server/index.ts');
    const pre2 = fs.readFileSync(f2, 'utf8');
    const content = pre2.replace('  ensureDir(dataDir());\n', `  ensureDir(dataDir());\n${LANE_HUNK}\n`);
    fs.writeFileSync(f2, content);
    const e2 = doEdit(f2, '  startServer();', '  startServer(); // BUG-217 r9');
    const laneBytes2 = fs.readFileSync(f2);
    fs.writeFileSync(f2, pre2); // foreign cp BEFORE the snapshot
    await take(top2, env2, { laneId: 'B930', ticket: ['BUG-217'], transcripts: [transcript(top2, [{ name: 'Write', input: { file_path: f2, content } }, e2])] });
    const e = entryOf(top2, env2, 'B930', 'src/server/index.ts');
    check('P1b Write+Edit lane, copy clobbered before the snapshot: rebuilt from the transcript (copyMatches false)', e?.recovery === 'rebuilt' && e.copyMatches === false, e);
    const r2 = cliRestore(top2, env2, 'BUG-217');
    check('P1b restore (no --force) writes the replayed bytes exactly, labelled exact', r2.status === 0 && /RESTORED \(exact/.test(r2.stdout) && sha(fs.readFileSync(f2)) === sha(laneBytes2), r2.stdout.slice(0, 300));
    // before, Edit-only lane: no replay base, copy lacks the edit → named unrecoverable with a reason (never the clobber)
    const top3 = mkRepo({ 'src/server/index.ts': BASE_INDEX });
    const env3 = mkEnv();
    const f3 = path.join(top3, 'src/server/index.ts');
    const pre3 = fs.readFileSync(f3);
    const c3 = doEdit(f3, '  ensureDir(dataDir());\n', `  ensureDir(dataDir());\n${LANE_HUNK}\n`);
    fs.writeFileSync(f3, pre3);
    await take(top3, env3, { laneId: 'C930', ticket: ['BUG-217'], transcripts: [transcript(top3, [c3])] });
    const e3 = entryOf(top3, env3, 'C930', 'src/server/index.ts');
    check('P1c Edit-only lane, copy clobbered before the snapshot: the (foreign) copy is only UNVERIFIED, never exact', e3?.recovery === 'unverified' && /UNVERIFIED/.test(e3.reason), e3);
    const r3 = cliRestore(top3, env3, 'BUG-217');
    check('P1c restore without --force refuses it, writes nothing, exits non-zero', r3.status === 1 && /--force/.test(r3.stdout) && sha(fs.readFileSync(f3)) === sha(pre3), r3.stdout.slice(0, 300));
  }

  /* ── P2 break (a) of verify 01a12d74: a SHORT deletion reverted before the snapshot ── */
  {
    const top = mkRepo({ 'guard.ts': 'export function run() {\n  unsafe();\n  safe();\n}\n' });
    const env = mkEnv();
    const f = path.join(top, 'guard.ts');
    const pre = fs.readFileSync(f);
    const d1 = doEdit(f, '  unsafe();\n', '');
    fs.writeFileSync(f, pre); // foreign revert BEFORE the snapshot: unsafe(); is back
    await take(top, env, { laneId: 'SHORT', ticket: ['BUG-8'], transcripts: [transcript(top, [d1])] });
    const e = entryOf(top, env, 'SHORT', 'guard.ts');
    check('P2 (a) the reverted copy is never classed exact or trusted: UNVERIFIED [must-FAIL on v4: stored]', e?.recovery === 'unverified', e);
    const r = cliRestore(top, env, 'BUG-8');
    check('P2 (a) restore without --force refuses (does not resurrect unsafe(); as the lane\'s work) [must-FAIL on v4: restored]', r.status === 1 && !/RESTORED/.test(r.stdout) && /UNVERIFIED/.test(r.stdout), r.stdout.slice(0, 300));
  }

  /* ── P3 delete then recreate ───────────────────────────────────────────── */
  {
    const top = mkRepo({ 'old.ts': 'export const old = 1;\n' });
    const env = mkEnv();
    const f = path.join(top, 'old.ts');
    fs.rmSync(f);
    const content = 'export const recreated = "by the lane";\n';
    fs.writeFileSync(f, content);
    await take(top, env, { laneId: 'DR', ticket: ['FEAT-3'], transcripts: [transcript(top, [{ name: 'fileChange', input: { changes: [{ path: f, kind: { type: 'delete' } }] } }, { name: 'Write', input: { file_path: f, content } }])] });
    check('P3 delete then recreate: the final state is the recreated file, rebuilt from the transcript', entryOf(top, env, 'DR', 'old.ts')?.recovery === 'rebuilt', entryOf(top, env, 'DR', 'old.ts'));
    fs.rmSync(f);
    const r = cliRestore(top, env, 'FEAT-3');
    check('P3 … and restore brings the recreated file back exactly', r.status === 0 && fs.readFileSync(f, 'utf8') === content, r.stdout.slice(0, 300));
    const top2 = mkRepo({ 'gone.ts': 'export const g = 1;\n' });
    const env2 = mkEnv();
    const g = path.join(top2, 'gone.ts');
    fs.rmSync(g);
    await take(top2, env2, { laneId: 'DD', ticket: ['FEAT-4'], transcripts: [transcript(top2, [{ name: 'fileChange', input: { changes: [{ path: g, kind: { type: 'delete' } }] } }])] });
    fs.writeFileSync(g, 'export const g = 1;\n');
    const c = cliCheck(top2, env2);
    const r2 = cliRestore(top2, env2, 'FEAT-4');
    check('P3 a file the lane deleted coming back: warned (file-recreated); restore never deletes it', c.status === 1 && /file-recreated/.test(c.stdout) && fs.existsSync(g) && /never deletes/.test(r2.stdout), { c: c.stdout.slice(0, 200), r: r2.stdout.slice(0, 200) });
  }

  /* ── P4 a gitignored file ──────────────────────────────────────────────── */
  {
    const top = mkRepo({ '.gitignore': '.env\n', 'app.ts': 'x\n' });
    const env = mkEnv();
    const f = path.join(top, '.env');
    const content = 'API_BASE=https://internal.example\nFEATURE_FLAG_NEW_LOCK=1\n';
    fs.writeFileSync(f, content);
    await take(top, env, { laneId: 'IGN', ticket: ['BUG-218'], transcripts: [transcript(top, [{ name: 'Write', input: { file_path: f, content } }])] });
    check('P4 a gitignored file the lane wrote is kept (rebuilt) [must-FAIL on round 2: filtered]', entryOf(top, env, 'IGN', '.env')?.recovery === 'rebuilt', entryOf(top, env, 'IGN', '.env'));
    fs.writeFileSync(f, 'API_BASE=https://internal.example\n');
    const r = cliRestore(top, env, 'BUG-218');
    check('P4 … and restore brings it back exactly', r.status === 0 && fs.readFileSync(f, 'utf8') === content, r.stdout.slice(0, 300));
  }

  /* ── P5 over the cap: named unrecoverable ─────────────────────────────── */
  {
    const big = 'export const blob = "' + 'x'.repeat(4000) + '";\n';
    const top = mkRepo({ 'bundle.ts': big });
    const env = mkEnv({ ORCHARD_LANE_SNAPSHOT_MAX_FILE: '1024' });
    const f = path.join(top, 'bundle.ts');
    const call = doEdit(f, 'export const blob', 'export const laneLine = 1;\nexport const blob');
    const w = 'y'.repeat(3000);
    await take(top, env, { laneId: 'BIG', ticket: ['BUG-9'], transcripts: [transcript(top, [call, { name: 'Write', input: { file_path: path.join(top, 'gen.txt'), content: w } }])] });
    const e = entryOf(top, env, 'BIG', 'bundle.ts'); const e2 = entryOf(top, env, 'BIG', 'gen.txt');
    check('P5 an over-cap copy and an over-cap replay are both named unrecoverable with the cap as the reason, no bytes kept', e?.recovery === 'unrecoverable' && /file cap/.test(e.reason) && !e.sha256 && e2?.recovery === 'unrecoverable' && /file cap/.test(e2.reason), { e, e2 });
    const r = cliRestore(top, env, 'BUG-9');
    check('P5 restore names both UNRECOVERABLE with the reason (exit 1)', r.status === 1 && (r.stdout.match(/UNRECOVERABLE/g) || []).length === 2, r.stdout.slice(0, 400));
    // the 400-file cap counts replayed files too [must-FAIL on v3: 01a12d69 #3]
    const top2 = mkRepo({ 'k.txt': 'k\n' });
    const env2 = mkEnv({ ORCHARD_LANE_SNAPSHOT_MAX_FILES: '3' });
    const calls = [1, 2, 3, 4, 5].map((i) => ({ name: 'Write', input: { file_path: path.join(top2, `f${i}.txt`), content: `file ${i}\n` } }));
    await take(top2, env2, { laneId: 'CAP', transcripts: [transcript(top2, calls)] });
    const ms = LS.readManifests(LS.storeDirFor(top2, env2))[0].files;
    check('P5 the file-count cap holds for replayed files: 3 kept, the rest named unrecoverable', ms.filter((x) => x.recovery === 'rebuilt').length === 3 && ms.filter((x) => x.recovery === 'unrecoverable' && /file lane cap/.test(x.reason)).length === 2, ms.map((x) => [x.path, x.recovery]));
  }

  /* ── P6 undoing a restore ──────────────────────────────────────────────── */
  {
    const top = mkRepo({ 'u.ts': 'export const u = 0;\n' });
    const env = mkEnv();
    const f = path.join(top, 'u.ts');
    const uContent = 'export const u = 0;\nexport const laneU = "lane";\n';
    fs.writeFileSync(f, uContent);
    const call = { name: 'Write', input: { file_path: f, content: uContent } }; // a Write lane: exact
    const laneBytes = fs.readFileSync(f);
    await take(top, env, { laneId: 'UND', ticket: ['FEAT-6'], transcripts: [transcript(top, [call])] });
    const later = Buffer.from('export const u = 0;\nexport const laneU = "lane";\n// a later legitimate edit\n');
    fs.writeFileSync(f, later);
    const r = await LS.restore({ top, selector: 'FEAT-6', env });
    check('P6 restore overwrote the live file with the lane bytes and backed the live bytes up first', r.ok && !!r.backup && sha(fs.readFileSync(f)) === sha(laneBytes), r);
    const u = cliRestore(top, env, r.backup);
    check('P6 the printed undo restores the overwritten bytes exactly', u.status === 0 && sha(fs.readFileSync(f)) === sha(later), u.stdout.slice(0, 300));
    // restore safety: symlinked live path / escaping parent refused
    fs.rmSync(f); fs.symlinkSync(path.join(top, '.git', 'HEAD'), f);
    const r2 = await LS.restore({ top, selector: 'UND', env });
    check('P6 a live symlink is refused, never followed', r2.plan.some((p) => p.action === 'refuse') && fs.lstatSync(f).isSymbolicLink(), r2.plan);
  }

  /* ── P7 break (b) of verify 01a12d74: restore writes only real paths in the project ── */
  {
    const mkLane = async () => {
      const top = mkRepo({ 'k.txt': 'k\n' });
      const env = mkEnv();
      const f = path.join(top, 'dir/sub/f.txt'); const content = 'lane wrote this\n';
      fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content);
      await take(top, env, { laneId: 'PATH', ticket: ['BUG-11'], transcripts: [transcript(top, [{ name: 'Write', input: { file_path: f, content } }])] });
      return { top, env, f, content };
    };
    const outsideDir = () => { const d = fs.mkdtempSync(path.join(S, 'outside-')); return d; };
    const listAll = (d) => { const out = []; const walk = (p) => { for (const n of fs.readdirSync(p)) { const q = path.join(p, n); out.push(path.relative(d, q)); if (fs.lstatSync(q).isDirectory()) walk(q); } }; walk(d); return out; };
    // missing parent under a symlinked ancestor
    let t = await mkLane(); let out = outsideDir();
    fs.rmSync(path.join(t.top, 'dir'), { recursive: true }); fs.symlinkSync(out, path.join(t.top, 'dir'));
    let r = cliRestore(t.top, t.env, 'BUG-11');
    check('P7 (b) a missing parent under a symlinked ancestor is refused; nothing is created outside the project [must-FAIL on v4]', r.status === 1 && /symlink/.test(r.stdout) && listAll(out).length === 0, { out: r.stdout.slice(0, 300), outside: listAll(out) });
    // the immediate parent is a symlink to outside
    t = await mkLane(); out = outsideDir();
    fs.rmSync(path.join(t.top, 'dir/sub'), { recursive: true }); fs.symlinkSync(out, path.join(t.top, 'dir/sub'));
    r = cliRestore(t.top, t.env, 'BUG-11');
    check('P7 a symlinked immediate parent is refused; nothing written outside', r.status === 1 && /symlink/.test(r.stdout) && listAll(out).length === 0, { out: r.stdout.slice(0, 300), outside: listAll(out) });
    // a symlinked parent that points INSIDE the project is refused too (no symlinked component at all)
    t = await mkLane();
    fs.mkdirSync(path.join(t.top, 'real'), { recursive: true });
    fs.rmSync(path.join(t.top, 'dir'), { recursive: true }); fs.symlinkSync(path.join(t.top, 'real'), path.join(t.top, 'dir'));
    r = cliRestore(t.top, t.env, 'BUG-11');
    check('P7 a symlinked component pointing inside the project is refused as well', r.status === 1 && /symlink/.test(r.stdout) && !fs.existsSync(path.join(t.top, 'real/sub')), r.stdout.slice(0, 300));
    // control: a plainly missing real parent is created and the bytes are written
    t = await mkLane();
    fs.rmSync(path.join(t.top, 'dir'), { recursive: true });
    r = cliRestore(t.top, t.env, 'BUG-11');
    check('P7 control: a missing REAL parent chain is created as real directories and restored exactly', r.status === 0 && fs.readFileSync(t.f, 'utf8') === t.content && !fs.lstatSync(path.join(t.top, 'dir')).isSymbolicLink(), r.stdout.slice(0, 300));
  }

  /* ── R4 retention ──────────────────────────────────────────────────────── */
  {
    const top = mkRepo({ 'p.ts': 'export const p = 0;\n' });
    const env = mkEnv({ ORCHARD_LANE_SNAPSHOT_DAYS: '14', ORCHARD_LANE_SNAPSHOT_MAX_MANIFESTS: '3', ORCHARD_LANE_SNAPSHOT_GRACE_MS: '3600000' });
    const dir = LS.storeDirFor(top, env);
    const f = path.join(top, 'p.ts');
    const now = Date.now();
    for (let i = 0; i < 6; i++) {
      const call = doEdit(f, `export const p = ${i};\n`, `export const p = ${i + 1};\n`);
      await take(top, env, { laneId: `P${i}`, transcripts: [transcript(top, [call])], endedAt: i === 0 ? now - 20 * 864e5 : now - (6 - i) * 1000 });
    }
    const ms = LS.readManifests(dir).map((m) => m.laneId);
    check('R4 retention: the manifest older than 14 days and those beyond the newest 3 were pruned', JSON.stringify(ms) === JSON.stringify(['P3', 'P4', 'P5']), ms);
    const referenced = new Set(LS.readManifests(dir).flatMap((m) => m.files.map((x) => x.sha256)));
    const orphan = fs.readdirSync(path.join(dir, 'objects')).filter((o) => !referenced.has(o));
    check('R4 unreferenced objects inside the grace window are kept', orphan.length >= 1, { orphan: orphan.length });
    const old = new Date(now - 2 * 3600_000);
    for (const o of fs.readdirSync(path.join(dir, 'objects'))) fs.utimesSync(path.join(dir, 'objects', o), old, old);
    const sentinel = path.join(LS.storeRoot(env), 'not-ours.txt'); fs.writeFileSync(sentinel, 'keep');
    const pr = await LS.prune(dir, { env });
    const after = fs.readdirSync(path.join(dir, 'objects'));
    check('R4 old unreferenced objects collected; referenced ones kept; nothing outside the store touched', orphan.every((o) => !after.includes(o)) && [...referenced].every((o) => after.includes(o)) && fs.existsSync(sentinel) && fs.existsSync(f), { pr, after: after.length });
    await LS.prune(dir, { env: { ...env, ORCHARD_LANE_SNAPSHOT_MAX_STORE_BYTES: '1' } });
    check('R4 the byte ceiling prunes oldest manifests first', LS.readManifests(dir).length === 0);
  }

  /* ── trigger never waits ──────────────────────────────────────────────── */
  {
    const top = mkRepo({ 'h.ts': 'export const h = 0;\n' });
    const call = doEdit(path.join(top, 'h.ts'), 'export const h = 0;\n', 'export const h = 1;\n');
    const spec = { v: 1, top, lanes: [{ laneId: 'H', source: 'claude-subagent', transcripts: [transcript(top, [call])] }] };
    let t0 = Date.now();
    const started = LS.spawnLaneSnapshot(spec, { env: mkEnv({ ORCHARD_LANE_SNAPSHOT_FAULT: 'hang', ORCHARD_LANE_SNAPSHOT_FAULT_MS: '4000' }) });
    check('U8 spawnLaneSnapshot returns at once while its child hangs', started === true && Date.now() - t0 < 300, { ms: Date.now() - t0 });
    t0 = Date.now(); await LS.takeSnapshot(spec, { env: mkEnv({ ORCHARD_LANE_SNAPSHOT_FAULT: 'hang', ORCHARD_LANE_SNAPSHOT_FAULT_MS: '1500' }) });
    check('U8 [must-FAIL, synthesized] the same work done inline blocks for the whole hang', Date.now() - t0 >= 1400, { ms: Date.now() - t0 });
    const warns = []; t0 = Date.now();
    LS.spawnLaneSnapshot(spec, { env: mkEnv({ ORCHARD_LANE_SNAPSHOT_NODE: path.join(S, 'no-such-node') }), warn: (m) => warns.push(m) });
    const badMs = Date.now() - t0; await sleep(400);
    check('U8 a spawn that cannot start returns at once and only warns', badMs < 300 && warns.some((w) => /could not start/.test(w)), { badMs, warns });
  }

  /* ── accounting (fixture) ──────────────────────────────────────────────── */
  {
    const top = mkRepo({ 'a.ts': 'export const a = 1;\n', '.gitignore': 'tmp/\n', 'old.ts': 'o\n' });
    const env = mkEnv();
    const e1 = doEdit(path.join(top, 'a.ts'), 'export const a = 1;\n', 'export const a = 2;\n');
    fs.mkdirSync(path.join(top, 'tmp'), { recursive: true }); fs.writeFileSync(path.join(top, 'tmp/x.log'), 'log line one\n');
    fs.rmSync(path.join(top, 'old.ts'));
    await take(top, env, { laneId: 'ACC', transcripts: [transcript(top, [e1, { name: 'Write', input: { file_path: path.join(top, 'tmp/x.log'), content: 'log line one\n' } },
      { name: 'Bash', input: { command: 'echo hi > out.txt' } }, { name: 'Write', input: { file_path: path.join(S, 'outside-project.txt'), content: 'outside' } },
      { name: 'fileChange', input: { changes: [{ path: path.join(top, 'old.ts'), kind: { type: 'delete' } }] } }])] });
    const r = LS.checkRepo({ top, env, account: true });
    const got = Object.fromEntries((r.entries || []).map((e) => [e.path, e.recovery]));
    check('U23 every in-project write has one recovery class; outside-project write counted', JSON.stringify(got) === JSON.stringify({ 'a.ts': 'unverified', 'tmp/x.log': 'rebuilt', 'out.txt': 'shell-gone', 'old.ts': 'deleted' }) && LS.readManifests(LS.storeDirFor(top, env))[0].outsideProject === 1, got);
  }

  /* ── store damage stays loud ───────────────────────────────────────────── */
  {
    const top = mkRepo({ 'd.ts': 'export const d = 0;\n' });
    const env = mkEnv();
    const call = doEdit(path.join(top, 'd.ts'), 'export const d = 0;\n', 'export const d = 1;\n');
    await take(top, env, { laneId: 'DMG', transcripts: [transcript(top, [call])] });
    const dir = LS.storeDirFor(top, env);
    const mf = path.join(dir, 'snaps', fs.readdirSync(path.join(dir, 'snaps'))[0]);
    fs.chmodSync(mf, 0o644); fs.writeFileSync(mf, '{"trunc');
    const c = cliCheck(top, env);
    check('U15 a damaged manifest is reported, never read as clean', c.status === 1 && /manifest-damaged/.test(c.stdout), c.stdout.slice(0, 300));
  }

  /* ── scratch server ─────────────────────────────────────────────────── */
  await serverPart();
} catch (e) {
  check('ran to completion', false, e?.stack || String(e));
}

async function serverPart() {
  const FAKE = path.join(S, 'fake-cli.mjs');
  fs.writeFileSync(FAKE, `#!/usr/bin/env node
import * as fs from 'node:fs'; import * as path from 'node:path'; import * as readline from 'node:readline';
if (process.argv.includes('--version')) { process.stdout.write('9.9.9 (Claude Code)\\n'); process.exit(0); }
const SID = 'fake176-' + process.pid; const say = (o) => { try { process.stdout.write(JSON.stringify(o) + '\\n'); } catch {} };
const rec = (o) => fs.appendFileSync(process.env.FAKE_RESULTS, JSON.stringify(o) + '\\n');
const hookIds = {}; let seq = 0; const pending = new Map();
function callHook(event, extra) { const cb = hookIds[event]; if (!cb) return Promise.resolve({ unregistered: true }); const id = 'f176-' + (++seq);
  const p = new Promise((r) => pending.set(id, r));
  say({ type: 'control_request', request_id: id, request: { subtype: 'hook_callback', callback_id: cb, tool_use_id: extra.tool_use_id, input: { hook_event_name: event, session_id: SID, transcript_path: '', cwd: process.cwd(), ...extra } } });
  return Promise.race([p, new Promise((r) => setTimeout(() => r({ timeout: true }), 120000))]); }
let n = 0; let inited = false;
async function turn(text) {
  if (!inited) { say({ type: 'system', subtype: 'init', session_id: SID, cwd: process.cwd(), model: 'haiku', tools: [], slash_commands: [], mcp_servers: [] }); inited = true; }
  let m = /\\[\\[tool\\]\\](.*)$/s.exec(text);
  if (m) { const spec = JSON.parse(m[1]); const resp = await callHook('PreToolUse', { tool_name: spec.tool, tool_input: spec.input, tool_use_id: 'toolu_f_' + (++n), ...(spec.agent_id ? { agent_id: spec.agent_id } : {}) });
    const h = resp && resp.response && resp.response.hookSpecificOutput;
    rec({ tag: spec.tag, decision: h ? h.permissionDecision || null : null, reason: h ? (h.permissionDecisionReason || '').slice(0, 200) : null, updatedInput: h ? h.updatedInput || null : null }); }
  m = /\\[\\[lane\\]\\](.*)$/s.exec(text);
  if (m) {
    const L = JSON.parse(m[1]); const tu = 'toolu_task_' + L.laneId;
    const prompt = 'Dispatch: ticket=' + L.ticket + ' phase=fixing class=fix\\n\\nFix it.';
    say({ type: 'assistant', session_id: SID, message: { model: 'claude-haiku-4-5', content: [{ type: 'tool_use', id: tu, name: 'Task', input: { description: 'lane ' + L.laneId, subagent_type: 'worker', prompt } }] } });
    say({ type: 'system', subtype: 'task_started', task_id: L.laneId, tool_use_id: tu, task_type: 'local_agent', description: 'lane ' + L.laneId, subagent_type: 'worker', prompt });
    const t = fs.readFileSync(L.file, 'utf8'); fs.writeFileSync(L.file, t.replace(L.old, L.new));
    const txDir = path.join(process.env.CLAUDE_PROJECTS_DIR, process.cwd().replace(/[^A-Za-z0-9]/g, '-'), SID, 'subagents'); fs.mkdirSync(txDir, { recursive: true });
    const eid = 'toolu_edit_' + L.laneId;
    fs.writeFileSync(path.join(txDir, 'agent-' + L.laneId + '.jsonl'), [
      { agentId: L.laneId, cwd: process.cwd(), timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: eid, name: 'Edit', input: { file_path: L.file, old_string: L.old, new_string: L.new } }] } },
      { agentId: L.laneId, cwd: process.cwd(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: eid, content: 'ok' }] } },
    ].map((x) => JSON.stringify(x)).join('\\n') + '\\n');
    const s0 = Date.now(); const sr = await callHook('SubagentStop', { agent_id: L.laneId, agent_transcript_path: path.join(txDir, 'agent-' + L.laneId + '.jsonl'), agent_type: 'worker', stop_hook_active: false, last_assistant_message: 'done' });
    rec({ tag: 'substop', laneId: L.laneId, ms: Date.now() - s0, unregistered: !!sr.unregistered, timeout: !!sr.timeout, decision: sr && sr.response ? (sr.response.decision || 'allow') : null });
    rec({ tag: 'tn', laneId: L.laneId, at: Date.now() });
    say({ type: 'system', subtype: 'task_notification', task_id: L.laneId, status: 'completed', message: 'done' });
    say({ type: 'user', session_id: SID, message: { content: [{ type: 'tool_result', tool_use_id: tu, content: 'lane done' }] } });
  }
  say({ type: 'assistant', session_id: SID, message: { model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'ok' }] } });
  say({ type: 'result', subtype: 'success', total_cost_usd: 0, session_id: SID }); }
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => { let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type === 'control_request') { if (m.request && m.request.subtype === 'initialize') { for (const [ev, ms] of Object.entries(m.request.hooks || {})) { const cb = ms && ms[0] && ms[0].hookCallbackIds && ms[0].hookCallbackIds[0]; if (cb) hookIds[ev] = cb; }
      say({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { commands: [], models: [], account: {}, hooks_applied: true } } }); return; }
    say({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }); return; }
  if (m.type === 'control_response') { const r = pending.get(m.response && m.response.request_id); if (r) { pending.delete(m.response.request_id); r(m.response); } return; }
  if (m.type === 'user') { const c = m.message && m.message.content; void turn(Array.isArray(c) ? c.map((b) => (b && b.text) || '').join('') : String(c || '')); } });
rl.on('close', () => process.exit(0)); process.stdin.resume();
`);

  // A synthesized PRE-CHANGE server: the same tree with the bridge's three trigger calls removed.
  const PRE = path.join(S, 'prechange');
  fs.mkdirSync(PRE);
  spawnSync('cp', ['-a', path.join(ROOT, 'src'), path.join(PRE, 'src')]);
  for (const e of fs.readdirSync(ROOT)) if (e !== 'src' && e !== '.git') fs.symlinkSync(path.join(ROOT, e), path.join(PRE, e));
  const bridgeP = path.join(PRE, 'src/server/agent-bridge.ts');
  const lines = fs.readFileSync(bridgeP, 'utf8').split('\n');
  const stripped = lines.filter((l) => !/this\.#laneEnded\(/.test(l) || /#laneEnded\(lanes:/.test(l));
  fs.writeFileSync(bridgeP, stripped.join('\n'));
  check('synthesized pre-change bridge: exactly the three trigger calls removed', lines.length - stripped.length === 3, { removed: lines.length - stripped.length });

  const boot = async (label, root, extraEnv) => {
    const PORT = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    const W = path.join(S, `srv-${label}`); fs.mkdirSync(W);
    const DATA = path.join(W, 'data'); const results = path.join(W, 'results.jsonl');
    const store = isolatedStoreEnv(path.join(W, 'store'), { alsoReader: true });
    const env = isolatedServerEnv({ PORT: String(PORT), CLAUDE_STATION_DATA: DATA, ...store,
      CLAUDE_STATION_CLAUDE_BIN: FAKE, CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0', CLAUDE_STATION_SURVIVE: '0', XDG_STATE_HOME: path.join(W, 'state'), FAKE_RESULTS: results, ORCHARD_LANE_SNAPSHOT_REPARSE_MS: '300', ...extraEnv });
    const srv = spawn(process.execPath, [path.join(root, 'src', 'server', 'index.ts')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
    const BASE = `http://127.0.0.1:${PORT}`;
    let up = false;
    for (let i = 0; i < 300 && !up; i++) { try { up = (await fetch(`${BASE}/api/projects`)).ok; } catch { /* */ } if (!up) await sleep(150); }
    if (!up) throw new Error(`${label}: server never booted\n${log.slice(-800)}`);
    const repo = mkRepo({ 'src/server/index.ts': BASE_INDEX });
    const reg = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: repo, name: `f176-${label}`, isolation: 'direct', applyMethod: false }) })).json();
    const projectId = reg.project?.id; if (!projectId) throw new Error(`${label}: register failed ${JSON.stringify(reg)}`);
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`); const events = [];
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (e) => { try { const ev = JSON.parse(String(e.data)); ev._at = Date.now(); events.push(ev); } catch { /* */ } };
    const readJsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
    let started = false;
    for (let k = 0; k < 40 && !started; k++) {
      const seen = events.length;
      ws.send(JSON.stringify({ type: 'start', projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' }, prompt: 'hi' }));
      let pend = false;
      for (let i = 0; i < 60; i++) { await sleep(100); const sl = events.slice(seen); if (sl.some((e) => e.code === 'runtime-check-pending')) { pend = true; break; } if (sl.some((e) => e.t === 'turn-end')) { started = true; break; } }
      if (!pend && !started) { for (let i = 0; i < 100 && !events.slice(seen).some((e) => e.t === 'turn-end'); i++) await sleep(100); started = events.slice(seen).some((e) => e.t === 'turn-end'); break; }
      if (pend) await sleep(1500);
    }
    if (!started) throw new Error(`${label}: first turn never ended\n${log.slice(-800)}`);
    const send = async (prompt, wantTag) => {
      const b = readJsonl(results).length; const te = events.filter((e) => e.t === 'turn-end').length;
      ws.send(JSON.stringify({ type: 'send', prompt }));
      for (let i = 0; i < 600; i++) { await sleep(100); if (events.filter((e) => e.t === 'turn-end').length > te && (!wantTag || readJsonl(results).slice(b).some((r) => r.tag === wantTag))) break; }
      return readJsonl(results).slice(b);
    };
    const lane = async (laneId, ticket, oldS, newS) => {
      const recs = await send(`[[lane]]${JSON.stringify({ laneId, ticket, file: path.join(repo, 'src/server/index.ts'), old: oldS, new: newS })}`, 'tn');
      const tn = recs.find((r) => r.tag === 'tn'); const sub = recs.find((r) => r.tag === 'substop');
      let done = null; for (let i = 0; i < 100 && !done; i++) { done = events.find((e) => e.t === 'agent-completed' && e.agent?.agentId === laneId); if (!done) await sleep(50); }
      return { tn, sub, completedLatency: done && tn ? done._at - tn.at : null, done: !!done };
    };
    const tool = async (tag, toolName, input, agentId) => (await send(`[[tool]]${JSON.stringify({ tag, tool: toolName, input, ...(agentId ? { agent_id: agentId } : {}) })}`, tag)).find((r) => r.tag === tag) ?? { error: 'timeout' };
    const close = async () => { try { ws.close(); } catch { /* */ } try { srv.kill('SIGTERM'); } catch { /* */ } await sleep(400); try { srv.kill('SIGKILL'); } catch { /* */ } };
    return { label, repo, DATA, env, lane, tool, send, close, log: () => log, events };
  };
  const OLD = '  ensureDir(dataDir());\n';
  const NEW = `  ensureDir(dataDir());\n${LANE_HUNK}\n`;
  const storeEnvOf = (s) => ({ ...process.env, CLAUDE_STATION_DATA: s.DATA });
  const waitManifest = async (s, laneId, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = LS.readManifests(LS.storeDirFor(s.repo, storeEnvOf(s))).find((x) => x.laneId === laneId); if (m) return m; await sleep(100); } return null; };
  const cli = (s, ...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8', env: storeEnvOf(s) });

  const servers = [];
  try {
    /* R1 — the 09-30 replay on the live-code server */
    const A = await boot('main', ROOT, {}); servers.push(A);
    const f = path.join(A.repo, 'src/server/index.ts');
    const pre = fs.readFileSync(f); fs.writeFileSync(path.join(S, 'prelane-index.ts'), pre);
    const la = await A.lane('a0f35b679776e1e5c', 'BUG-217', OLD, NEW);
    const laneBytes = fs.readFileSync(f);
    check('R1 non-vacuity: the fake lane really edited the file and the bridge saw it end', la.done && laneBytes.includes('lockDataDirectory'), la);
    const m = await waitManifest(A, 'a0f35b679776e1e5c');
    check('R1 the lane end produced a snapshot with the file, the lane id and its declared ticket', !!m && m.files.some((x) => x.path === 'src/server/index.ts' && x.sha256 === sha(laneBytes)) && m.ticket.includes('BUG-217'), m && { ticket: m.ticket, files: m.files.map((x) => [x.path, x.sha256?.slice(0, 12), x.atSnapshot]) });
    spawnSync('cp', [path.join(S, 'prelane-index.ts'), f]); // the foreign cp, after the lane finished
    let c = cli(A, 'check', '--repo', A.repo);
    check('R1 check fires (exit 1) and names the file, the lane and BUG-217', c.status === 1 && /src\/server\/index\.ts/.test(c.stdout) && /a0f35b679776e1e5c/.test(c.stdout) && /BUG-217/.test(c.stdout), { status: c.status, out: c.stdout.slice(0, 900) });
    const iv = spawnSync(process.execPath, [path.join(ROOT, 'scripts/independent-verify.mjs'), '--requirement', 'x', '--repo', A.repo, '--range', 'no-such-rev-f176'], { encoding: 'utf8', env: storeEnvOf(A) });
    check('R1 independent-verify prints the warning before it builds anything', /LANE WORK CHANGED\?/.test(iv.stderr) && /src\/server\/index\.ts/.test(iv.stderr), iv.stderr.slice(0, 600));
    // The hook's own command line (whole tree: a file reverted to HEAD is never staged)
    const hookLine = fs.readFileSync(path.join(ROOT, '.githooks/pre-commit'), 'utf8').split('\n').find((l) => /lane-snapshot\.mjs" check/.test(l)) || '';
    check('R1 the pre-commit hook checks the whole tree, warn-only, bounded and failure-proof', /--warn \|\| true$/.test(hookLine.trim()) && !/--staged/.test(hookLine) && /^timeout 15 /.test(hookLine.trim()), hookLine);
    const hk = cli(A, 'check', '--repo', A.repo, '--warn');
    const staged = spawnSync(REAL_GIT, ['-C', A.repo, 'diff', '--cached', '--name-only'], { encoding: 'utf8' }).stdout.trim();
    check('R1 the pre-commit warning prints for the reverted file even though nothing about it is staged, and never refuses (exit 0)', hk.status === 0 && /LANE WORK CHANGED\?/.test(hk.stderr) && staged === '', { status: hk.status, staged, err: hk.stderr.slice(0, 300) });
    const fr = spawnSync(process.execPath, [path.join(ROOT, 'scripts/candidate.mjs'), 'freeze', '--id', 'BUG-217', '--repo', A.repo, '--files', 'src/server/index.ts'], { encoding: 'utf8', env: storeEnvOf(A) });
    check('R1 candidate freeze prints the warning first (warning only)', /LANE WORK CHANGED\?/.test(fr.stderr), { status: fr.status, err: fr.stderr.slice(0, 400) });
    const rs = cli(A, 'restore', 'BUG-217', '--repo', A.repo, '--force'); // an Edit-only lane: UNVERIFIED copy
    const back = fs.readFileSync(f);
    check('R1 one command (--force, labelled UNVERIFIED) restores the lane\'s bytes (sha256 equal)', rs.status === 0 && sha(back) === sha(laneBytes), { status: rs.status, out: rs.stdout.slice(0, 500), live: sha(back).slice(0, 12), lane: sha(laneBytes).slice(0, 12) });
    c = cli(A, 'check', '--repo', A.repo);
    check('R1 after the restore, check is clean again', c.status === 0, c.stdout.slice(0, 300));

    /* R3 — permission decisions with snapshots on, right after a lane end */
    const a3task = await A.tool('task', 'Task', { description: 'fix', subagent_type: 'worker', prompt: 'Dispatch: ticket=BUG-217 phase=fixing class=fix\n\nx' });
    const a3agent = await A.tool('agent', 'Agent', { description: 'fix', subagent_type: 'worker', prompt: 'Dispatch: ticket=BUG-217 phase=fixing class=fix\n\nx' });
    const a3write = await A.tool('write', 'Write', { file_path: path.join(A.repo, 'src/new.ts'), content: 'x' }, 'lanew1');
    const a2 = await A.lane('lane2', 'BUG-217', 'startServer();', 'startServer(); // lane2');

    /* control: snapshots disabled (timing + decision baseline) */
    const C = await boot('control', ROOT, { ORCHARD_LANE_SNAPSHOT: '0' }); servers.push(C);
    const lc = await C.lane('lanec', 'BUG-217', OLD, NEW);
    const lc2 = await C.lane('lanec2', 'BUG-217', 'startServer();', 'startServer(); // c2');
    const c3task = await C.tool('task', 'Task', { description: 'fix', subagent_type: 'worker', prompt: 'Dispatch: ticket=BUG-217 phase=fixing class=fix\n\nx' });
    const c3agent = await C.tool('agent', 'Agent', { description: 'fix', subagent_type: 'worker', prompt: 'Dispatch: ticket=BUG-217 phase=fixing class=fix\n\nx' });
    const c3write = await C.tool('write', 'Write', { file_path: path.join(C.repo, 'src/new.ts'), content: 'x' }, 'lanew1');
    check('R3 control non-vacuity: snapshots disabled wrote no store', !fs.existsSync(path.join(C.DATA, 'lane-snapshots')) || LS.readManifests(LS.storeDirFor(C.repo, storeEnvOf(C))).length === 0, {});
    check('R3 a Task call in an orchestrator-profile session stays DENY with snapshots on', a3task.decision === 'deny' && c3task.decision === 'deny', { on: a3task, off: c3task });
    const sameDec = (x, y) => x.decision === y.decision && JSON.stringify(x.updatedInput) === JSON.stringify(y.updatedInput);
    check('R3 the Agent decision is identical with snapshots on and off', !a3agent.error && sameDec(a3agent, c3agent), { on: a3agent, off: c3agent });
    check('R3 a lane\'s Write decision is identical with snapshots on and off', !a3write.error && sameDec(a3write, c3write), { on: a3write, off: c3write });
    const rt = fs.readFileSync(path.join(ROOT, 'src/server/runtime/claude-runtime.ts'), 'utf8');
    check('R3 source pin: claude-runtime.ts (the hooks and the profile) has no reference to lane snapshots', !/lane-snapshot|laneEnded|spawnLaneSnapshot|FEAT-176/.test(rt), {});

    /* R1 must-FAIL: the synthesized pre-change bridge */
    const B = await boot('prechange', PRE, {}); servers.push(B);
    const lb = await B.lane('laneb', 'BUG-217', OLD, NEW);
    await sleep(1500);
    const fb = path.join(B.repo, 'src/server/index.ts');
    spawnSync('cp', [path.join(S, 'prelane-index.ts'), fb]);
    const cb = cli(B, 'check', '--repo', B.repo);
    const rb = cli(B, 'restore', 'BUG-217', '--repo', B.repo);
    check('R1 [must-FAIL on the pre-change bridge] no snapshot: check stays clean and restore has nothing — the 09-30 loss is silent', lb.done && cb.status === 0 && rb.status !== 0, { lane: lb.done, check: cb.status, restore: rb.stdout.slice(0, 200) });

    /* R2 — the stop is not delayed or blocked when the snapshot fails */
    const lim = (x) => x != null;
    const D = await boot('spawnfail', ROOT, { ORCHARD_LANE_SNAPSHOT_NODE: path.join(S, 'no-such-node-binary') }); servers.push(D);
    const ld = await D.lane('laned', 'BUG-217', OLD, NEW);
    await sleep(500);
    const ld2 = await D.send('next turn after a failed snapshot spawn');
    const E = await boot('throw', ROOT, { ORCHARD_LANE_SNAPSHOT_FAULT: 'throw' }); servers.push(E);
    const le = await E.lane('lanee', 'BUG-217', OLD, NEW);
    const F = await boot('hang', ROOT, { ORCHARD_LANE_SNAPSHOT_FAULT: 'hang', ORCHARD_LANE_SNAPSHOT_FAULT_MS: '20000' }); servers.push(F);
    const lf = await F.lane('lanef', 'BUG-217', OLD, NEW);
    const lf2 = await F.lane('lanef2', 'BUG-217', 'startServer();', 'startServer(); // f2');
    const ctlLat = Math.max(lc.completedLatency ?? 0, lc2.completedLatency ?? 0);
    const ctlSub = Math.max(lc.sub?.ms ?? 0, lc2.sub?.ms ?? 0);
    const rows = { control: [lc, lc2], on: [la, a2], spawnfail: [ld], throw: [le], hang: [lf, lf2] };
    const summary = Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.map((x) => ({ done: x.done, completedMs: x.completedLatency, subagentStopMs: x.sub?.ms, subDecision: x.sub?.decision }))]));
    console.log(`        R2 latencies: ${JSON.stringify(summary)}`);
    const allRuns = [la, a2, ld, le, lf, lf2];
    check('R2 non-vacuity: the SubagentStop hook is registered and answered in every run (allow)', [...allRuns, lc, lc2].every((x) => x.sub && !x.sub.unregistered && !x.sub.timeout && x.sub.decision === 'allow'), summary);
    check('R2 every lane end was processed (agent-completed) under spawn failure, a throwing child and a hanging child', [ld, le, lf, lf2].every((x) => x.done && lim(x.completedLatency)), summary);
    const slack = 400;
    check(`R2 terminal frame → agent-completed stays within the control's latency + ${slack} ms in every failure mode`, allRuns.every((x) => x.completedLatency <= ctlLat + slack), { ctlLat, summary });
    check(`R2 SubagentStop answers within the control's latency + ${slack} ms in every failure mode (the stop is not delayed)`, allRuns.every((x) => x.sub.ms <= ctlSub + slack), { ctlSub, summary });
    check('R2 spawn failure: the server warns and the session\'s next turn still runs', /lane snapshot could not start/.test(D.log()) && ld2.length >= 0 && D.events.filter((e) => e.t === 'turn-end').length >= 3, { log: D.log().match(/.*lane snapshot.*/g), turns: D.events.filter((e) => e.t === 'turn-end').length });
    let errLog = ''; for (let i = 0; i < 40 && !/injected fault/.test(errLog); i++) { try { errLog = fs.readFileSync(path.join(E.DATA, 'lane-snapshots', 'errors.log'), 'utf8'); } catch { /* */ } if (!/injected fault/.test(errLog)) await sleep(150); }
    check('R2 a throwing snapshot child is logged to errors.log and ignored', /injected fault/.test(errLog), errLog.slice(0, 300));
    check('R2 a hanging snapshot child (20 s) did not hold the second lane or its turn', lf2.done && F.events.filter((e) => e.t === 'turn-end').length >= 3, { turns: F.events.filter((e) => e.t === 'turn-end').length });
  } finally {
    for (const s of servers) await s.close();
    // hanging snapshot children are detached: kill the ones this suite started (by their spec dir)
    const ps = spawnSync('pgrep', ['-f', `lane-snapshot.mjs take`], { encoding: 'utf8' });
    for (const pid of String(ps.stdout || '').split('\n').filter(Boolean)) {
      try { const cmd = fs.readFileSync(`/proc/${pid}/environ`, 'utf8'); if (cmd.includes(S)) process.kill(Number(pid), 'SIGKILL'); } catch { /* not ours / gone */ }
    }
  }
}

console.log(`\n${failN === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${failN} failed`);
try { fs.rmSync(S, { recursive: true, force: true }); } catch { /* */ }
process.exit(failN === 0 ? 0 : 1);
