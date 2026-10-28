#!/usr/bin/env node
/**
 * verify:feat-199 (r4 canonical) — the structural fix for run c44745cb (BROKEN),
 * breaks 1 & 2: ONE function owns "which file is the canonical copy of each
 * session id" (ARCH-010). The full list, the paginated page and the deep-link
 * resolver ALL read `hist.canonicalSessionIndex`; no reader re-derives the
 * tie-break. The r3 pool broke same-id cross-dir twin ties by its OWN rule
 * (host-encoded dir) while the full list kept the copy whose own cwd encodes to
 * its dir — two derivations of one fact disagreeing.
 *
 * PART A — MUST-FAIL model (the break), then the real shared index (the fix).
 *   The r3 derivations, modelled as pure tie-breaks over on-disk file facts:
 *     oldFull  = canonical-cwd, then larger          (r3 listLogicalProjectSessions)
 *     oldPool  = host-encoded-dir proxy, then larger  (r3 buildSessionCandidatePool)
 *   On two fixtures the two DISAGREE (must-FAIL reproduced):
 *     S1 host-dir copy NON-canonical + LARGER vs other-dir CANONICAL + smaller
 *     S2 host-dir 0-byte twin vs other-dir real transcript
 *   Then the REAL unified rule (`hist.canonicalSessionIndex`, and the full list
 *   `hist.listLogicalProjectSessions` that now reads it) picks the SAME copy for
 *   both fixtures: the non-empty, then canonical-cwd copy. No 0-byte/truncated
 *   twin ever beats a real transcript.
 *
 * PART B — REAL SERVER, twins across THREE dirs of one logical project. The full
 *   list, the union of every page, and the by-id deep-link resolver agree on
 *   every id AND on which copy each twin names.
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

function line(obj) { return JSON.stringify(obj); }
function writeSession(dir, stem, { sessionId, cwd, ts, pad = 0 }) {
  fs.mkdirSync(dir, { recursive: true });
  const rows = [
    line({ type: 'user', sessionId, cwd, timestamp: ts, version: '1.0.0', gitBranch: 'main', entrypoint: 'cli', message: { role: 'user', content: `hello ${stem}${'x'.repeat(pad)}` } }),
    line({ type: 'assistant', sessionId, cwd, timestamp: ts, message: { role: 'assistant', model: 'claude', content: 'hi' } }),
  ];
  fs.writeFileSync(path.join(dir, `${stem}.jsonl`), rows.join('\n') + '\n');
}
function writeEmpty(dir, stem) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${stem}.jsonl`), '');
}
// A real multi-message transcript (n user+assistant turns).
function writeReal(dir, stem, { sessionId, cwd, ts, turns = 40 }) {
  fs.mkdirSync(dir, { recursive: true });
  const rows = [];
  for (let i = 0; i < turns; i++) {
    rows.push(line({ type: 'user', sessionId, cwd, timestamp: ts, version: '1.0.0', gitBranch: 'main', entrypoint: 'cli', message: { role: 'user', content: `msg ${i}` } }));
    rows.push(line({ type: 'assistant', sessionId, cwd, timestamp: ts, message: { role: 'assistant', model: 'claude', content: `reply ${i}` } }));
  }
  fs.writeFileSync(path.join(dir, `${stem}.jsonl`), rows.join('\n') + '\n');
}
// A >0-byte truncation: only the first (user) line survived a partial copy —
// carries sessionId + cwd (so it looks canonical) but is 1 message, not the whole session.
function writeTruncated(dir, stem, { sessionId, cwd, ts }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${stem}.jsonl`), line({ type: 'user', sessionId, cwd, timestamp: ts, version: '1.0.0', message: { role: 'user', content: 'only line' } }) + '\n');
}
// A >0-byte metadata-only copy: a single non-message line carrying sessionId + cwd (0 real messages).
function writeMetaOnly(dir, stem, { sessionId, cwd, ts }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${stem}.jsonl`), line({ type: 'summary', summary: 'x', sessionId, cwd, timestamp: ts }) + '\n');
}
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

/* ------------------------------------------------- PART A: must-FAIL model */
function partA(tmp) {
  console.log('\n--- PART A: the two r3 derivations disagree (must-FAIL); the shared index agrees ---');
  const STORE = path.join(tmp, 'partA-store');
  const hostPath = '/tmp/r4a/proj';
  const otherPath = '/tmp/r4b/proj';
  const hostDir = path.join(STORE, hist.encodeCwd(hostPath));
  const otherDir = path.join(STORE, hist.encodeCwd(otherPath));
  const hostEnc = hist.encodeCwd(hostPath);
  const otherEnc = hist.encodeCwd(otherPath);

  // S1 — host copy NON-canonical (cwd=otherPath) + LARGER; other copy CANONICAL + small.
  const s1 = '00000001-0000-4000-8000-000000000000';
  writeSession(hostDir, s1, { sessionId: s1, cwd: otherPath, ts: '2026-10-10T00:00:00.000Z', pad: 5000 });
  writeSession(otherDir, s1, { sessionId: s1, cwd: otherPath, ts: '2026-10-10T00:00:00.000Z', pad: 0 });
  // S2 — host copy 0-byte twin; other copy a real transcript (canonical for otherDir).
  const s2 = '00000002-0000-4000-8000-000000000000';
  writeEmpty(hostDir, s2);
  writeReal(otherDir, s2, { sessionId: s2, cwd: otherPath, ts: '2026-10-11T00:00:00.000Z', turns: 40 });
  // S3 — host copy TRUNCATED to its first line (>0 bytes, 1 message, CANONICAL for
  //      hostDir); other copy the real 60-turn transcript (non-canonical here).
  //      The r4-first-cut (fileBytes > 0) wrongly kept the truncation — run 72b30fd7.
  const s3 = '00000003-0000-4000-8000-000000000000';
  writeTruncated(hostDir, s3, { sessionId: s3, cwd: hostPath, ts: '2026-10-12T00:00:00.000Z' });
  writeReal(otherDir, s3, { sessionId: s3, cwd: hostPath, ts: '2026-10-12T00:00:00.000Z', turns: 60 });
  // S4 — host copy METADATA-ONLY (>0 bytes, 0 messages, CANONICAL for hostDir);
  //      other copy the real transcript (non-canonical here).
  const s4 = '00000004-0000-4000-8000-000000000000';
  writeMetaOnly(hostDir, s4, { sessionId: s4, cwd: hostPath, ts: '2026-10-13T00:00:00.000Z' });
  writeReal(otherDir, s4, { sessionId: s4, cwd: hostPath, ts: '2026-10-13T00:00:00.000Z', turns: 50 });

  // Facts for each copy, straight from disk (the inputs the r3/r4-first-cut rules read).
  const fact = (dir, enc, stem) => {
    const fp = path.join(dir, `${stem}.jsonl`);
    const bytes = fs.statSync(fp).size;
    const { cwd } = hist.readSessionHeadFacts(fp);
    return { enc, bytes, cwd, canon: cwd !== null && hist.encodeCwd(cwd) === enc };
  };
  // r3 derivations as pure tie-breaks (keep A over B?).
  const oldFull = (a, b) => (a.canon && !b.canon) || (a.canon === b.canon && a.bytes > b.bytes);
  const oldPool = (a, b) => {
    const aHost = a.enc === hostEnc, bHost = b.enc === hostEnc;
    return (aHost && !bHost) || (aHost === bHost && a.bytes > b.bytes);
  };
  // r4-first-cut rule (BROKEN, run 72b30fd7): fileBytes>0, then canonical, then larger.
  const r4bytes = (a, b) => {
    const an = a.bytes > 0, bn = b.bytes > 0;
    if (an !== bn) return an;
    if (a.canon !== b.canon) return a.canon;
    return a.bytes > b.bytes;
  };

  // S1/S2 reproduce the r3 full-vs-pool disagreement (break 1 & the host-dir proxy).
  for (const [name, id] of [['S1 host-dir non-canonical larger', s1], ['S2 0-byte host twin', s2]]) {
    const h = fact(hostDir, hostEnc, id);
    const o = fact(otherDir, otherEnc, id);
    const fullKeepsHost = oldFull(h, o);
    const poolKeepsHost = oldPool(h, o);
    if (fullKeepsHost !== poolKeepsHost) ok(`${name}: r3 full vs r3 pool DISAGREE (must-FAIL reproduced)`, `full→${fullKeepsHost ? 'host' : 'other'} pool→${poolKeepsHost ? 'host' : 'other'}`);
    else bad(`${name}: r3 derivations must disagree`, `both→${fullKeepsHost ? 'host' : 'other'}`);
  }
  // S3/S4 reproduce the r4-first-cut break (run 72b30fd7): a >0-byte truncated /
  // metadata-only CANONICAL host copy wrongly wins under fileBytes>0, hiding the
  // real transcript. The must-FAIL: the bytes-rule keeps the host stub.
  for (const [name, id] of [['S3 truncated host twin', s3], ['S4 metadata-only host twin', s4]]) {
    const h = fact(hostDir, hostEnc, id);
    const o = fact(otherDir, otherEnc, id);
    const bytesKeepsHost = r4bytes(h, o);
    if (bytesKeepsHost) ok(`${name}: r4-first-cut (fileBytes>0) keeps the host STUB (must-FAIL reproduced)`, 'bytes-rule → host');
    else bad(`${name}: bytes-rule must keep the host stub`, 'bytes-rule → other');
  }

  // The fix: the ONE shared index, and the full list that reads it, keep the real
  // OTHER copy for EVERY fixture (never the host 0-byte / non-canonical / truncated
  // / metadata-only stub). Completeness (real-message count) wins, then canonical.
  const lp = hist.groupByLogicalProject(hist.listProjectDirs({ root: STORE })).find((p) => p.dirs.some((d) => d.encodedDir === hostEnc));
  for (const [name, id, minMsgs] of [['S1', s1, 2], ['S2', s2, 1], ['S3', s3, 2], ['S4', s4, 1]]) {
    const idx = hist.canonicalSessionIndex([hostEnc, otherEnc], { root: STORE });
    const chosen = idx.get(id);
    if (chosen && chosen.encodedDir === otherEnc) ok(`${name}: shared index keeps the real OTHER copy`, chosen.encodedDir);
    else bad(`${name}: shared index keeps real copy`, `kept ${chosen?.encodedDir}`);

    const row = hist.listLogicalProjectSessions(lp, { root: STORE }).find((s) => s.sessionId === id);
    if (row && row.encodedDir === otherEnc) ok(`${name}: full list shows the SAME copy as the index`, row.encodedDir);
    else bad(`${name}: full list == index copy`, `full→${row?.encodedDir}`);
    // The kept copy is the REAL transcript, not a 0/1-message stub.
    if (row && row.messageCount >= minMsgs) ok(`${name}: kept copy is the real transcript`, `${row.messageCount} msgs`);
    else bad(`${name}: kept copy is real (not a stub)`, `msgs=${row?.messageCount}`);
  }
}

/* ------------------------------------------------- PART B: live 3-dir server */
async function partB(tmp) {
  console.log('\n--- PART B: full list, page union & deep links agree over twins across 3 dirs ---');
  const STORE = path.join(tmp, 'partB-store');
  const DATA = path.join(tmp, 'partB-data');
  fs.mkdirSync(path.join(DATA, 'session-hosts'), { recursive: true });
  const p1 = '/tmp/r4d1/proj', p2 = '/tmp/r4d2/proj', p3 = '/tmp/r4d3/proj';
  const d1 = path.join(STORE, hist.encodeCwd(p1));
  const d2 = path.join(STORE, hist.encodeCwd(p2));
  const d3 = path.join(STORE, hist.encodeCwd(p3));
  const e1 = hist.encodeCwd(p1), e2 = hist.encodeCwd(p2), e3 = hist.encodeCwd(p3);
  const T = (n) => `2026-10-${String(n).padStart(2, '0')}T00:00:00.000Z`;

  // Ordinary canonical sessions in each dir (so each groups under its own path,
  // all basename 'proj' → one logical project).
  for (let i = 1; i <= 4; i++) writeSession(d1, `1000000${i}-0000-4000-8000-000000000000`, { sessionId: `1000000${i}-0000-4000-8000-000000000000`, cwd: p1, ts: T(i) });
  for (let i = 1; i <= 4; i++) writeSession(d2, `2000000${i}-0000-4000-8000-000000000000`, { sessionId: `2000000${i}-0000-4000-8000-000000000000`, cwd: p2, ts: T(i) });
  for (let i = 1; i <= 4; i++) writeSession(d3, `3000000${i}-0000-4000-8000-000000000000`, { sessionId: `3000000${i}-0000-4000-8000-000000000000`, cwd: p3, ts: T(i) });

  // Twin A: canonical in d1, non-canonical copies in d2 (small) and d3 (LARGER). → d1.
  const idA = 'aaaaaaaa-0000-4000-8000-000000000000';
  writeSession(d1, idA, { sessionId: idA, cwd: p1, ts: T(20), pad: 0 });
  writeSession(d2, idA, { sessionId: idA, cwd: p1, ts: T(20), pad: 2000 });
  writeSession(d3, idA, { sessionId: idA, cwd: p1, ts: T(20), pad: 9000 });
  // Twin B: host(d1) copy NON-canonical + LARGER; d2 copy CANONICAL + small. → d2.
  const idB = 'bbbbbbbb-0000-4000-8000-000000000000';
  writeSession(d1, idB, { sessionId: idB, cwd: p2, ts: T(21), pad: 8000 });
  writeSession(d2, idB, { sessionId: idB, cwd: p2, ts: T(21), pad: 0 });
  // Twin C: host(d1) 0-byte twin; d3 real transcript (canonical). → d3.
  const idC = 'cccccccc-0000-4000-8000-000000000000';
  writeEmpty(d1, idC);
  writeSession(d3, idC, { sessionId: idC, cwd: p3, ts: T(22), pad: 0 });
  // Twin D: host(d1) TRUNCATED canonical copy (1 msg, >0 bytes); d3 real 40-turn
  //         transcript (non-canonical). Completeness must win → d3 (run 72b30fd7).
  const idD = 'dddddddd-0000-4000-8000-000000000000';
  writeTruncated(d1, idD, { sessionId: idD, cwd: p1, ts: T(23) });
  writeReal(d3, idD, { sessionId: idD, cwd: p1, ts: T(23), turns: 40 });
  // Twin E: host(d1) METADATA-ONLY canonical copy (0 msgs, >0 bytes); d2 real
  //         transcript (non-canonical). → d2.
  const idE = 'eeeeeeee-0000-4000-8000-000000000000';
  writeMetaOnly(d1, idE, { sessionId: idE, cwd: p1, ts: T(24) });
  writeReal(d2, idE, { sessionId: idE, cwd: p1, ts: T(24), turns: 30 });

  fs.writeFileSync(path.join(DATA, 'registry.json'), JSON.stringify({
    version: 1,
    projects: [{ id: 'r4proj', name: 'proj', hostPath: p1, isolation: 'direct', settings: {}, createdAt: T(1), updatedAt: T(1) }],
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
    const get = async (qs) => (await fetch(`${BASE}/api/projects/r4proj/sessions${qs}`)).json();

    const full = await get('');
    // Walk every page via the keyset cursor.
    const pageRows = new Map();
    let cursor = null, guard = 0;
    for (;;) {
      const j = await get(`?limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      for (const s of j.sessions) pageRows.set(s.sessionId, s.encodedDir);
      cursor = j.page.cursor;
      if (!j.page.hasMore || !cursor || ++guard > 50) break;
    }
    const fullById = new Map(full.sessions.map((s) => [s.sessionId, s.encodedDir]));

    const fullIds = [...fullById.keys()].sort();
    const pageIds = [...pageRows.keys()].sort();
    if (JSON.stringify(fullIds) === JSON.stringify(pageIds)) ok('full list id set == page-union id set', `${fullIds.length} ids`);
    else bad('full == page union', `full=${fullIds.length} page=${pageIds.length} miss=${fullIds.filter((x) => !pageRows.has(x)).slice(0, 3)}`);

    // Every id resolves to the SAME copy via full list, page union and deep link.
    let allAgree = true;
    const detail = [];
    for (const id of fullIds) {
      const one = await get(`?session=${id}`);
      const deep = one.sessions[0]?.encodedDir;
      const f = fullById.get(id), p = pageRows.get(id);
      if (!(f === p && f === deep)) { allAgree = false; detail.push(`${id.slice(0, 8)}: full=${f} page=${p} deep=${deep}`); }
    }
    if (allAgree) ok('full, page union & deep link name the SAME copy for every id');
    else bad('full/page/deep agree per id', detail.slice(0, 4).join(' | '));

    // The three twins resolve to the EXPECTED canonical copy everywhere.
    for (const [id, exp, label] of [[idA, e1, 'A canonical-in-d1'], [idB, e2, 'B host non-canonical→d2'], [idC, e3, 'C 0-byte-host→d3'], [idD, e3, 'D truncated-host→d3'], [idE, e2, 'E metadata-only-host→d2']]) {
      const one = await get(`?session=${id}`);
      const deep = one.sessions[0]?.encodedDir;
      const deepMsgs = one.sessions[0]?.messageCount;
      const expOk = fullById.get(id) === exp && pageRows.get(id) === exp && deep === exp;
      // For the stub twins (C/D/E) also assert the served copy is the real one, not a 0/1-msg stub.
      const realOk = !['C', 'D', 'E'].includes(label[0]) || (deepMsgs ?? 0) >= 2;
      if (expOk && realOk) ok(`twin ${label}: full/page/deep all → ${exp === e1 ? 'd1' : exp === e2 ? 'd2' : 'd3'}`, label[0] >= 'C' ? `${deepMsgs} msgs` : '');
      else bad(`twin ${label} → expected real copy`, `full=${fullById.get(id)} page=${pageRows.get(id)} deep=${deep} exp=${exp} deepMsgs=${deepMsgs}`);
    }
    const stillUp = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false);
    if (stillUp) ok('server healthy after the run'); else bad('server healthy', 'health failed');
  } finally {
    try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
  }
}

async function main() {
  console.log('\n========== FEAT-199 r4 — one canonical index; full/page/deep agree ==========');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat199-r4-'));
  try {
    partA(tmp);
    await partB(tmp);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  }
  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`} — FEAT-199 r4 canonical\n`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
