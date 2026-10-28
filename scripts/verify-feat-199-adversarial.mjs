#!/usr/bin/env node
/**
 * verify:feat-199 (adversarial) — the paginated list matches the full list's
 * session SET on hostile store shapes the independent verifier (run dd92b8e5)
 * flagged, built as SYNTHETIC fixtures (not the real store):
 *
 *  F1 — a file whose stem differs from its in-file sessionId. The full path
 *       dedupes on the in-file id; the page keys stubs by stem. The page must
 *       still surface the session ONCE, never twice (post-parse sessionId dedupe).
 *  F2 — the same session copied into two dirs of one logical project, where the
 *       host copy is CANONICAL (its cwd encodes to its dir) and the other copy is
 *       a non-canonical, larger copy. The full path keeps the canonical (host)
 *       copy; the page must keep the SAME copy, not the larger one.
 *
 * Boots an isolated scratch server whose reader points at a scratch store built
 * here. No real store, no port 4317, no live host, no writes outside scratch.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { isolatedServerEnv } from './lib/station-boot.mjs';
import * as hist from '../src/lib/session-history.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
let failures = 0;
const ok = (n, x = '') => console.log(`  ok  ${n}${x ? `  — ${x}` : ''}`);
const bad = (n, e) => { failures++; console.log(`FAIL  ${n}\n      ${e}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function line(obj) { return JSON.stringify(obj); }
function writeSession(dir, stem, { sessionId, cwd, ts, pad = 0 }) {
  fs.mkdirSync(dir, { recursive: true });
  const rows = [
    line({ type: 'user', sessionId, cwd, timestamp: ts, version: '1.0.0', gitBranch: 'main', entrypoint: 'cli', message: { role: 'user', content: `hello ${stem}${'x'.repeat(pad)}` } }),
    line({ type: 'assistant', sessionId, cwd, timestamp: ts, message: { role: 'assistant', model: 'claude', content: 'hi' } }),
  ];
  fs.writeFileSync(path.join(dir, `${stem}.jsonl`), rows.join('\n') + '\n');
}

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

async function main() {
  console.log('\n========== FEAT-199 adversarial — paged SET == full SET on hostile stores ==========');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat199-adv-'));
  const STORE = path.join(tmp, 'projects');
  const DATA = path.join(tmp, 'data');
  fs.mkdirSync(path.join(DATA, 'session-hosts'), { recursive: true });

  const hostPath = '/tmp/advX/advproj';               // basename: advproj
  const otherPath = '/tmp/advY/advproj';              // same basename → same logical project
  const hostDir = path.join(STORE, hist.encodeCwd(hostPath));
  const otherDir = path.join(STORE, hist.encodeCwd(otherPath));
  const T = (n) => `2026-10-${String(n).padStart(2, '0')}T00:00:00.000Z`;

  // Six ordinary sessions in the host dir (stem === in-file id).
  for (let i = 1; i <= 6; i++) writeSession(hostDir, `0000000${i}-0000-4000-8000-000000000000`.slice(0, 36), { sessionId: `0000000${i}-0000-4000-8000-000000000000`.slice(0, 36), cwd: hostPath, ts: T(i) });
  // F1 — a file whose STEM differs from its in-file sessionId, colliding with 00000003.
  const collideId = '00000003-0000-4000-8000-000000000000';
  writeSession(hostDir, 'zzzzzzzz-aaaa-4000-8000-000000000000', { sessionId: collideId, cwd: hostPath, ts: T(3) });
  // F2 — session 0050 in BOTH dirs: host copy CANONICAL (cwd encodes to its dir),
  // SMALL; other copy NON-canonical (carries the host cwd) and LARGER.
  const dupId = '00000050-0000-4000-8000-000000000000';
  writeSession(hostDir, dupId, { sessionId: dupId, cwd: hostPath, ts: T(20), pad: 0 });
  writeSession(otherDir, dupId, { sessionId: dupId, cwd: hostPath, ts: T(20), pad: 5000 }); // non-canonical + larger

  fs.writeFileSync(path.join(DATA, 'registry.json'), JSON.stringify({
    version: 1,
    projects: [{ id: 'advproj', name: 'advproj', hostPath, isolation: 'direct', settings: {}, createdAt: T(1), updatedAt: T(1) }],
  }, null, 2));

  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = isolatedServerEnv({
    PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE,
    CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0',
  }, { requireStore: true });
  const server = spawn(process.execPath, [ENTRY], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  server.stderr?.on('data', (d) => { if (process.env.VERBOSE) process.stderr.write(`  [server] ${d}`); });
  try {
    let up = false;
    for (let i = 0; i < 150 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(200); } }
    if (!up) throw new Error('server never healthy');

    const full = await (await fetch(`${BASE}/api/projects/advproj/sessions`)).json();
    const paged = await (await fetch(`${BASE}/api/projects/advproj/sessions?limit=500`)).json();
    const fullBy = full.sessions.map((s) => `${s.encodedDir}\0${s.sessionId}`).sort();
    const pagedBy = paged.sessions.map((s) => `${s.encodedDir}\0${s.sessionId}`).sort();
    const fullSids = full.sessions.map((s) => s.sessionId).sort();
    const pagedSids = paged.sessions.map((s) => s.sessionId).sort();

    console.log(`  full: ${full.sessions.length} rows   paged: ${paged.sessions.length} rows   page=${JSON.stringify(paged.page)}`);

    // No duplicate sessionId in the page (F1).
    const dupInPage = pagedSids.filter((x, i) => pagedSids[i - 1] === x);
    if (dupInPage.length === 0) ok('F1 no duplicate sessionId in the paged list');
    else bad('F1 no duplicate sessionId', `dup ${dupInPage[0]}`);

    // Same session id SET as the full list.
    if (JSON.stringify(fullSids) === JSON.stringify(pagedSids)) ok('paged sessionId set == full sessionId set', `${fullSids.length} ids`);
    else bad('paged sessionId set == full', `full=${fullSids.length} paged=${pagedSids.length}`);

    // Same (encodedDir, sessionId) union — the copy kept for the cross-dir dup matches (F2).
    if (JSON.stringify(fullBy) === JSON.stringify(pagedBy)) ok('F2 paged (dir,id) union == full union (same copy kept)');
    else bad('F2 (dir,id) union matches full', `missing ${fullBy.filter((k) => !pagedBy.includes(k))}, extra ${pagedBy.filter((k) => !fullBy.includes(k))}`);

    // page.total counts DISTINCT true sessionIds — the pool is keyed on the
    // in-file id (readSessionIdHead), so the pathological stem-vs-id file (F1)
    // collapses into its real session and total == full EXACTLY, even on this
    // hostile store.
    if (paged.page?.total === full.sessions.length) ok('page.total == distinct true-id count (== full)', `${paged.page?.total}`);
    else bad('page.total == full count', `total=${paged.page?.total} full=${full.sessions.length}`);

    // The dup's kept dir is the CANONICAL host dir (not the larger other copy).
    const dupRow = paged.sessions.find((s) => s.sessionId === dupId);
    if (dupRow && dupRow.encodedDir === hist.encodeCwd(hostPath)) ok('F2 cross-dir dup keeps the canonical host copy', dupRow.encodedDir);
    else bad('F2 dup keeps canonical host copy', `kept ${dupRow?.encodedDir}`);
  } finally {
    try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  }

  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`} — FEAT-199 adversarial\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
