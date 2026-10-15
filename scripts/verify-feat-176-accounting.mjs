#!/usr/bin/env node
/**
 * verify-feat-176-accounting.mjs — FEAT-176's recovery property, checked against REAL
 * transcripts: every file a lane wrote inside the project with Write, Edit, MultiEdit,
 * NotebookEdit or fileChange (by an INDEPENDENT parse of the transcript here, not the
 * library's) is stored exactly, rebuilt by replay, recorded as deleted, or named
 * unrecoverable WITH a reason — none silently missing. Shell-only files are counted too.
 *
 * Read-only on the transcripts and the repo; the snapshot store is a scratch data dir.
 *   node scripts/verify-feat-176-accounting.mjs [--repo <dir>] [--projects <transcript dir>] [--days 30] [--limit N]
 * Host-run (it needs the real transcript store); no git writes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as LS from './lib/lane-snapshot.mjs';
import { classifyMutation } from './lib/file-lock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const REPO = fs.realpathSync(arg('--repo', path.resolve(HERE, '..')));
const PROJ = arg('--projects', path.join(os.homedir(), '.claude', 'projects', REPO.replace(/[^A-Za-z0-9]/g, '-')));
const DAYS = Number(arg('--days', '30')); const LIMIT = Number(arg('--limit', '0'));
if (!fs.existsSync(PROJ)) { console.log(`COULD NOT RUN: no transcript store at ${PROJ}`); process.exit(2); }
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'f176-acc-'));
const env = { ...process.env, CLAUDE_STATION_DATA: DATA, ORCHARD_LANE_SNAPSHOT_REPARSE_MS: '0', ORCHARD_LANE_SNAPSHOT_DAYS: String(DAYS + 30), ORCHARD_LANE_SNAPSHOT_MAX_MANIFESTS: '100000', ORCHARD_LANE_SNAPSHOT_MAX_STORE_BYTES: String(64 * 1024 ** 3) };

/** Independent parse: successful write-tool calls' in-project paths. */
function expectedPaths(t) {
  const uses = []; const errs = new Set();
  for (const line of fs.readFileSync(t, 'utf8').split('\n')) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    const c = j?.message?.content; if (!Array.isArray(c)) continue;
    for (const b of c) { if (b?.type === 'tool_use') uses.push({ b, cwd: j.cwd || REPO }); else if (b?.type === 'tool_result' && b.is_error) errs.add(b.tool_use_id); }
  }
  const out = new Map();
  const add = (p, cwd, rec) => { if (typeof p !== 'string' || !p || /[$`*?]/.test(p)) return; const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p); const rel = path.relative(REPO, abs); if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) { let real = abs; try { real = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); } catch { /* */ } const rr = path.relative(REPO, real); if (!rr.startsWith('..') && !path.isAbsolute(rr)) { const k = rel.split(path.sep).join('/'); out.set(k, out.get(k) || rec); } } };
  for (const { b, cwd } of uses) {
    if (errs.has(b.id)) continue; const i = b.input || {};
    if (['Write', 'Edit', 'MultiEdit'].includes(b.name)) add(i.file_path, cwd, true);
    else if (b.name === 'NotebookEdit') add(i.notebook_path, cwd, true);
    else if (b.name === 'fileChange') for (const ch of i.changes || []) add(ch?.path, cwd, true);
    else if (b.name === 'Bash' && typeof i.command === 'string') { const r = classifyMutation({ toolName: 'Bash', toolInput: { command: i.command } }); for (const p of r?.paths || []) add(p, cwd, false); }
  }
  return out;
}

const since = Date.now() - DAYS * 864e5;
let files = [];
for (const s of fs.readdirSync(PROJ)) { const d = path.join(PROJ, s, 'subagents'); let l; try { l = fs.readdirSync(d); } catch { continue; } for (const f of l) if (/^agent-.*\.jsonl$/.test(f)) { const p = path.join(d, f); if (fs.statSync(p).mtimeMs >= since) files.push(p); } }
if (LIMIT) files = files.slice(0, LIMIT);
let lanes = 0, expectedTotal = 0, missing = [], dup = [], badOutcome = 0;
const t0 = Date.now();
for (const t of files) {
  const laneId = path.basename(t, '.jsonl').slice(6);
  const exp = expectedPaths(t);
  await LS.takeSnapshot({ v: 1, top: REPO, lanes: [{ laneId, source: 'claude-subagent', transcripts: [t], endedAt: Date.now() }] }, { env });
  if (exp.size) { lanes++; expectedTotal += exp.size; }
}
const res = LS.checkRepo({ top: REPO, env, account: true });
if (res.unavailable) { console.log(`FAIL: check unavailable: ${res.unavailable}`); process.exit(1); }
const by = new Map();
for (const e of res.entries) { const k = `${e.laneId}\0${e.path}`; if (!by.has(k)) by.set(k, []); by.get(k).push(e); }
const GUARANTEED = new Set(['rebuilt', 'unverified', 'deleted', 'unrecoverable']);
const SHELL = new Set(['shell-copy', 'shell-gone', 'shell-skipped']);
const dist = {}; let recoverableFiles = 0, shellFiles = 0, noReason = [], wrongClass = [];
for (const t of files) {
  const laneId = path.basename(t, '.jsonl').slice(6);
  for (const [p, rec] of expectedPaths(t)) {
    const es = by.get(`${laneId}\0${p}`) || [];
    if (es.length === 0) { missing.push(`${laneId} ${p}`); continue; }
    if (es.length > 1) dup.push(`${laneId} ${p} x${es.length}`);
    const e = es[0];
    dist[e.recovery] = (dist[e.recovery] || 0) + 1;
    if (rec) { recoverableFiles++; if (!GUARANTEED.has(e.recovery)) wrongClass.push(`${laneId} ${p} ${e.recovery}`); if (e.recovery === 'unrecoverable' && !e.reason) noReason.push(`${laneId} ${p}`); }
    else { shellFiles++; if (!SHELL.has(e.recovery)) wrongClass.push(`${laneId} ${p} ${e.recovery} (shell-only)`); }
  }
}
const manifestEntries = LS.readManifests(LS.storeDirFor(REPO, env)).reduce((a2, m) => a2 + (m.files || []).length, 0);
const errLog = (() => { try { return fs.readFileSync(path.join(DATA, 'lane-snapshots', 'errors.log'), 'utf8').split('\n').filter(Boolean); } catch { return []; } })();
console.log(JSON.stringify({ transcripts: files.length, lanesThatWrote: lanes, expectedFiles: expectedTotal, recoverableToolFiles: recoverableFiles, shellOnlyFiles: shellFiles, manifestEntries, recovery: dist, missing: missing.length, duplicated: dup.length, wrongClass: wrongClass.length, unrecoverableWithoutReason: noReason.length, takeErrors: errLog.length, seconds: Math.round((Date.now() - t0) / 1000) }));
{ const tool = {}; for (const t of files) { const laneId = path.basename(t, '.jsonl').slice(6); for (const [p, rec] of expectedPaths(t)) { if (!rec) continue; const e = (by.get(`${laneId}\0${p}`) || [])[0]; if (e) tool[e.recovery] = (tool[e.recovery] || 0) + 1; } }
  const tot = Object.values(tool).reduce((a2, b2) => a2 + b2, 0); console.log(`COVERAGE of ${tot} Write/Edit/MultiEdit/NotebookEdit/fileChange files: ` + Object.entries(tool).map(([k, v]) => `${k} ${v} (${(100 * v / tot).toFixed(0)}%)`).join(', ')); }
let pass = 0, fail = 0;
const check = (n, ok, o) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : `\n        observed: ${JSON.stringify(o).slice(0, 1500)}`}`); };
check('non-vacuity: real transcripts with writes were processed', lanes > 0 && recoverableFiles > 0, { lanes, recoverableFiles });
check('every independently-parsed in-project written file has a manifest entry (none missing)', missing.length === 0, missing.slice(0, 20));
check('no file has two entries for one lane', dup.length === 0, dup.slice(0, 20));
check('every Write/Edit/MultiEdit/NotebookEdit/fileChange file is rebuilt (exact), unverified, deleted or unrecoverable', wrongClass.length === 0, wrongClass.slice(0, 20));
check('every unrecoverable file carries a reason', noReason.length === 0, noReason.slice(0, 20));
check('manifest entries equal the expected files (nothing extra, nothing filtered)', manifestEntries === expectedTotal, { manifestEntries, expectedTotal });
check('no snapshot take failed', errLog.length === 0, errLog.slice(0, 5));
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
fs.rmSync(DATA, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
