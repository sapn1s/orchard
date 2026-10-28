#!/usr/bin/env node
/**
 * verify:feat-199 (r3 deep-link) — the off-page deep-link break the independent
 * verifier found in run b757f33e (BROKEN):
 *
 *   sessionByIdForProject resolved by FILENAME (resolveSessionFile maps
 *   id → `<id>.jsonl`), so a deep link to a session whose file STEM differs from
 *   its in-file sessionId returned null — the exact session the paginated list
 *   shows (keyed by the TRUE in-file id) could not be opened by id.
 *
 * The r3 fix routes the resolver through the SAME true-id index the list pool
 * builds (buildSessionCandidatePool). This exercises the live route over a
 * scratch store:
 *
 *   - LONE stem≠id file: a file named <weird>.jsonl whose in-file id is uuid(A).
 *     Deep link ?session=uuid(A) must return that row. (must-FAIL on r2: null.)
 *   - TAIL-recovered id behind a >256 KB first entry: a file whose first JSONL
 *     entry is a huge snapshot with NO sessionId; the id lives in the tail, and
 *     the stem ≠ the id. Deep link by the real id must resolve. (must-FAIL on r2.)
 *   - SAME-ID TWINS: two files, same in-file id, in two store dirs. The deep
 *     link must return the SAME copy (encodedDir) the paginated list shows for
 *     that id — one resolver, one derivation.
 *   - the common case (stem == id) still resolves, and a genuinely unknown id
 *     returns 0 rows (not a crash).
 *
 * No port 4317, no live host, no writes outside the scratch dirs.
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
const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const line = (obj) => JSON.stringify(obj);

function writeSession(dir, stem, { sessionId, cwd, ts, mtime, firstBlobBytes = 0 }) {
  fs.mkdirSync(dir, { recursive: true });
  const rows = [];
  if (firstBlobBytes > 0) {
    // A huge FIRST entry with NO top-level sessionId (a file-history snapshot);
    // the real id lands later, so it is only recoverable from the tail sample.
    rows.push(line({ type: 'file-history-snapshot', timestamp: ts, blob: 'Z'.repeat(firstBlobBytes) }));
  }
  rows.push(line({ type: 'user', sessionId, cwd, timestamp: ts, version: '1.0.0', gitBranch: 'main', entrypoint: 'cli', message: { role: 'user', content: `hello ${stem}` } }));
  rows.push(line({ type: 'assistant', sessionId, cwd, timestamp: ts, message: { role: 'assistant', model: 'claude', content: 'hi' } }));
  const fp = path.join(dir, `${stem}.jsonl`);
  fs.writeFileSync(fp, rows.join('\n') + '\n');
  if (mtime) fs.utimesSync(fp, new Date(mtime), new Date(mtime));
  return fp;
}

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat199-r3-'));
  const STORE = path.join(tmp, 'projects');
  const DATA = path.join(tmp, 'data');
  fs.mkdirSync(path.join(DATA, 'session-hosts'), { recursive: true });

  const hostPath = '/tmp/r3X/r3proj';
  const otherPath = '/tmp/r3Y/r3proj'; // same basename → same logical project
  const hostDir = path.join(STORE, hist.encodeCwd(hostPath));
  const otherDir = path.join(STORE, hist.encodeCwd(otherPath));
  const T = (n) => `2026-10-${String(n).padStart(2, '0')}T00:00:00.000Z`;
  const base = Date.UTC(2026, 9, 1); const DAY = 86400000;

  // Ordinary sessions (stem == id).
  for (let i = 1; i <= 6; i++) {
    writeSession(hostDir, uuid(i), { sessionId: uuid(i), cwd: hostPath, ts: T(i), mtime: base + (30 - i) * DAY });
  }
  // (a) LONE stem≠id file.
  const loneId = uuid(50);
  writeSession(hostDir, 'renamed-stem-xxxx', { sessionId: loneId, cwd: hostPath, ts: T(7), mtime: base + 40 * DAY });
  // (b) TAIL-recovered id behind a >256 KB first entry, stem ≠ id.
  const tailId = uuid(60);
  writeSession(hostDir, 'bigfirst-stem-yyy', { sessionId: tailId, cwd: hostPath, ts: T(8), mtime: base + 41 * DAY, firstBlobBytes: 300 * 1024 });
  // (c) SAME-ID TWINS across two dirs. The hostDir copy is CANONICAL (its own
  //     cwd encodes to its dir) and SMALLER; the other-dir copy is NON-canonical
  //     (carries the host cwd) and LARGER. The canonical-cwd copy wins over the
  //     larger one (FEAT-199 r4: the single shared index owns this rule), so the
  //     full list, the page and the resolver must ALL return the hostDir copy.
  const twinId = uuid(70);
  writeSession(hostDir, twinId, { sessionId: twinId, cwd: hostPath, ts: T(9), mtime: base + 42 * DAY });
  writeSession(otherDir, twinId, { sessionId: twinId, cwd: hostPath, ts: T(9), mtime: base + 42 * DAY, firstBlobBytes: 100 * 1024 });

  fs.writeFileSync(path.join(DATA, 'registry.json'), JSON.stringify({
    version: 1,
    projects: [{ id: 'r3proj', name: 'r3proj', hostPath, isolation: 'direct', settings: {}, createdAt: T(1), updatedAt: T(1) }],
  }, null, 2));

  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = isolatedServerEnv({
    PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE,
    CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0',
  }, { requireStore: true });
  const server = spawn(process.execPath, [ENTRY], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  server.stderr?.on('data', (d) => { if (process.env.VERBOSE) process.stderr.write(`  [server] ${d}`); });
  const getSession = async (id) => {
    const r = await fetch(`${BASE}/api/projects/r3proj/sessions?session=${encodeURIComponent(id)}`);
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  try {
    let up = false;
    for (let i = 0; i < 150 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(200); } }
    if (!up) throw new Error('server never healthy');

    // The PAGINATED list (what the sidebar actually shows post-FEAT-199) — the
    // authority for which copy/row a given id maps to. Both it and the deep-link
    // resolver read the one shared candidate pool, so they must agree.
    const full = (await (await fetch(`${BASE}/api/projects/r3proj/sessions?limit=500`)).json());
    const listById = new Map(full.sessions.map((s) => [s.sessionId, s]));

    // (a) LONE stem≠id.
    {
      const r = await getSession(loneId);
      const row = r.json?.sessions?.[0];
      if (r.status === 200 && row && row.sessionId === loneId) ok('deep link to a lone stem≠id file resolves by true id', `stem renamed-stem-xxxx → ${loneId.slice(0, 8)}`);
      else bad('lone stem≠id deep link resolves', `status=${r.status} rows=${r.json?.sessions?.length ?? 0}`);
      if (listById.has(loneId)) ok('the lone stem≠id session is in the list too (list/open agree)');
      else bad('lone stem≠id in list', 'not listed');
    }

    // (b) TAIL-recovered id behind a >256 KB first entry.
    {
      const r = await getSession(tailId);
      const row = r.json?.sessions?.[0];
      if (r.status === 200 && row && row.sessionId === tailId) ok('deep link to a tail-recovered id (>256 KB first entry, stem≠id) resolves', `${tailId.slice(0, 8)}`);
      else bad('tail-recovered id deep link resolves', `status=${r.status} rows=${r.json?.sessions?.length ?? 0}`);
    }

    // (c) SAME-ID TWINS — resolver returns the copy the list shows.
    {
      const r = await getSession(twinId);
      const row = r.json?.sessions?.[0];
      const listed = listById.get(twinId);
      if (row && listed && row.encodedDir === listed.encodedDir) ok('same-id twin: deep link returns the SAME copy the list shows', `dir ${row.encodedDir?.slice(-12)}`);
      else bad('same-id twin resolver == list copy', `open=${row?.encodedDir} list=${listed?.encodedDir}`);
      if (row && row.encodedDir === hist.encodeCwd(hostPath)) ok('same-id twin: canonical (host-encoded) copy chosen');
      else bad('same-id twin canonical copy', `got ${row?.encodedDir}`);
    }

    // common case (stem == id) still resolves.
    {
      const r = await getSession(uuid(1));
      if (r.status === 200 && r.json?.sessions?.[0]?.sessionId === uuid(1)) ok('common case (stem == id) still resolves');
      else bad('stem==id resolves', `status=${r.status}`);
    }

    // unknown id → 0 rows, not a crash.
    {
      const r = await getSession(uuid(999));
      if (r.status === 200 && (r.json?.sessions?.length ?? 0) === 0) ok('unknown id → 0 rows (no crash)');
      else bad('unknown id → 0 rows', `status=${r.status} rows=${r.json?.sessions?.length}`);
      const healthy = await fetch(`${BASE}/api/health`).then((x) => x.ok).catch(() => false);
      if (healthy) ok('server healthy after an unknown-id deep link');
      else bad('server healthy', 'health failed');
    }
  } finally {
    try { process.kill(-server.pid, 'SIGKILL'); } catch { /* ignore */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(failures === 0 ? '\nPASS verify-feat-199-r3-deeplink' : `\nFAIL verify-feat-199-r3-deeplink (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
