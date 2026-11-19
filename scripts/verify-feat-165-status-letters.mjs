#!/usr/bin/env node
/**
 * FEAT-165 regression guard — the per-file STATUS LETTER in the git popover.
 *
 *   node scripts/verify-feat-165-status-letters.mjs
 *
 * The r1 independent verifier (run 8faf47b6, 2026-10-11) found git.ts's
 * `changeType` preferred the WORKTREE code over the INDEX code, so a file staged
 * as an add then further edited ("AM") rendered as "modified" and a staged rename
 * then edited ("RM") rendered as "modified" — both wrong. The browser suite
 * (verify-feat-163-165-git-bar.mjs) could not catch it: the real checkouts it
 * reads happen to carry no AM/RM paths. This builds a SYNTHETIC scratch repo in
 * exactly those states and drives the REAL /git/changes endpoint on an isolated
 * scratch server, asserting the type each path resolves to.
 *
 * SYNTHETIC fixture (disclosed): a throwaway git repo under the system tmpdir —
 * the only way to pin AM/RM/D/A/U states deterministically. Needs REAL git on
 * PATH: run outside the agent git-shim (strip the /tmp/orchard-git-shim-* dir
 * from PATH), since building the fixture calls `git init/add/mv/rm`.
 */
import { spawnSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { isolatedServerEnv } from './lib/station-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const GIT = process.env.F165_GIT ?? '/usr/bin/git';
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f165-letters-'));
const g = (...a) => { const r = spawnSync(GIT, ['-C', repo, ...a], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout; };

g('init', '-b', 'main');
g('config', 'user.email', 'verify@example.test'); g('config', 'user.name', 'verify');
const baseline = {
  'keep.txt': 'keep-unique-aaa\n',
  'stage_mod.txt': 'stagemod-unique-bbb\n',
  'ren_src.txt': 'rename-me-unique-ccc\n'.repeat(5),
  'del.txt': 'delete-me-unique-ddd\n'.repeat(5),
};
for (const [f, c] of Object.entries(baseline)) fs.writeFileSync(path.join(repo, f), c);
g('add', '.'); g('commit', '-m', 'base');

// AM — staged add then worktree-modify → ADDED
fs.writeFileSync(path.join(repo, 'new.txt'), 'x\n'); g('add', 'new.txt');
fs.appendFileSync(path.join(repo, 'new.txt'), 'more\n');
// RM — staged rename then worktree-modify → RENAMED
g('mv', 'ren_src.txt', 'ren_dst.txt'); fs.appendFileSync(path.join(repo, 'ren_dst.txt'), 'extra\n');
// A  — staged add clean → ADDED
fs.writeFileSync(path.join(repo, 'add2.txt'), 'y\n'); g('add', 'add2.txt');
// M  — staged modify → MODIFIED
fs.appendFileSync(path.join(repo, 'stage_mod.txt'), 'z\n'); g('add', 'stage_mod.txt');
// M  — unstaged modify → MODIFIED
fs.appendFileSync(path.join(repo, 'keep.txt'), 'q\n');
// D  — staged delete → DELETED
g('rm', 'del.txt');
// U  — untracked → UNTRACKED
fs.writeFileSync(path.join(repo, 'untracked.txt'), 'u\n');

const expect = {
  'new.txt': 'added', 'ren_dst.txt': 'renamed', 'add2.txt': 'added',
  'stage_mod.txt': 'modified', 'keep.txt': 'modified', 'del.txt': 'deleted', 'untracked.txt': 'untracked',
};

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const PORT = await freePort();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f165-letters-data-'));
const env = isolatedServerEnv({ PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_STATION_NO_WA_CONSOLIDATE: '1' });
const server = spawn(process.execPath, ['src/server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
const log = []; server.stdout.on('data', (d) => log.push(String(d))); server.stderr.on('data', (d) => log.push(String(d)));
const BASE = `http://127.0.0.1:${PORT}`;
let up = false;
for (let i = 0; i < 200; i++) { try { const r = await fetch(`${BASE}/api/projects`); if (r.ok) { up = true; break; } } catch { /* booting */ } await new Promise((r) => setTimeout(r, 150)); }
if (!up) { console.error(`scratch server did not come up:\n${log.join('').slice(-2000)}`); process.exit(2); }

let fail = 0;
try {
  const reg = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: repo, isolation: 'direct', applyMethod: false }) })).json();
  const id = reg?.project?.id ?? reg?.id;
  const cr = await (await fetch(`${BASE}/api/projects/${encodeURIComponent(id)}/git/changes`)).json();
  const got = {}; for (const c of cr.changes) got[c.path] = c.type;
  console.log('porcelain:\n' + g('-c', 'core.quotepath=false', 'status', '--porcelain=v1').trim());
  console.log('\nfile                 expected    got');
  for (const [f, e] of Object.entries(expect)) {
    const ok = got[f] === e; if (!ok) fail++;
    console.log(`${f.padEnd(20)} ${e.padEnd(11)} ${(got[f] ?? '(missing)')}  ${ok ? 'PASS' : 'FAIL'}`);
  }
  // oldPath carried through on the rename.
  const renRow = cr.changes.find((c) => c.path === 'ren_dst.txt');
  const oldOk = renRow && renRow.oldPath === 'ren_src.txt';
  if (!oldOk) fail++;
  console.log(`rename oldPath=ren_src.txt${' '.repeat(0)}            ${renRow?.oldPath ?? '(none)'}  ${oldOk ? 'PASS' : 'FAIL'}`);
} finally {
  try { process.kill(server.pid, 'SIGTERM'); } catch { /* gone */ }
  fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(DATA, { recursive: true, force: true });
}
console.log(`\nFEAT-165 status letters: ${Object.keys(expect).length + 1 - fail} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
