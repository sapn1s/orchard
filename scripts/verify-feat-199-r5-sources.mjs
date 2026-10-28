#!/usr/bin/env node
/**
 * verify:feat-199 (r5 sources) — the structural fix for run 0675f242 (BROKEN).
 *
 * r4 unified the canonical-copy choice for twins that both live INSIDE the
 * logical group (same basename → listLogicalProjectSessions saw them). But the
 * full list (`sessionsForProject`) still ran `canonicalSessionIndex` over the
 * GROUP dirs only and then merged the CONTAINER store, the PAST-PATH dirs and
 * the Orchard-owned dirs with its OWN first-seen-wins dedupe. Those sources sit
 * OUTSIDE the group, so a same-id twin that spanned the group↔non-group boundary
 * was chosen by TWO different derivations: the full list kept the group copy
 * (first-seen), while the page and the deep link read the COMPLETE index and
 * kept the real transcript. Result: the full list could serve a truncated /
 * metadata-only / 0-byte HOST stub while the page and the deep link served the
 * real PAST-DIR or CONTAINER transcript.
 *
 * PART A — MUST-FAIL from the r4 code. `r4FullList` re-implements the r4
 *   `sessionsForProject` claude merge EXACTLY (canonicalSessionIndex over the
 *   group dirs, then first-seen-wins merge of the container + past dirs). On a
 *   host-stub-vs-real-past twin it returns the 1-message stub (the break). The
 *   r5 complete index (`canonicalSessionIndex([group, container, past])`) keeps
 *   the real transcript (the fix).
 *
 * PART B — REAL SERVER. One project with a PAST-PATH store (different basename,
 *   NOT grouped), a CONTAINER store, Orchard-owned and native-codex sources.
 *   Host stubs in the GROUP dir twin real transcripts in every non-group source.
 *   The full list, the union of every keyset page and the ?session= deep link
 *   agree on every id AND serve the REAL transcript for every stub-shadowed id.
 *   Plus a symlinked twin, a missing-cwd twin and extreme cursor values.
 *
 * No port 4317, no live host, no writes outside the scratch dirs.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { isolatedServerEnv } from './lib/station-boot.mjs';
import * as hist from '../src/lib/session-history.ts';
import * as cm from '../src/server/container-manager.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
let failures = 0;
const ok = (n, x = '') => console.log(`  ok  ${n}${x ? `  — ${x}` : ''}`);
const bad = (n, e) => { failures++; console.log(`FAIL  ${n}\n      ${e}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (o) => JSON.stringify(o);

function writeReal(dir, stem, { sessionId, cwd, ts, turns = 40 }) {
  fs.mkdirSync(dir, { recursive: true });
  const rows = [];
  for (let i = 0; i < turns; i++) {
    rows.push(line({ type: 'user', sessionId, cwd, timestamp: ts, version: '1.0.0', gitBranch: 'main', entrypoint: 'cli', message: { role: 'user', content: `msg ${i}` } }));
    rows.push(line({ type: 'assistant', sessionId, cwd, timestamp: ts, message: { role: 'assistant', model: 'claude', content: `reply ${i}` } }));
  }
  fs.writeFileSync(path.join(dir, `${stem}.jsonl`), rows.join('\n') + '\n');
}
function writeOrdinary(dir, stem, { sessionId, cwd, ts }) {
  writeReal(dir, stem, { sessionId, cwd, ts, turns: 2 });
}
// A LARGE real transcript whose byte size exceeds readSessionMeta's head+tail
// sample budget, so its messageCount is a SAMPLED LOWER BOUND (statsExact=false).
// Big message bodies so 256 KB head + 256 KB tail captures only a few of the
// `turns` messages — the undercount run 459a68fa exploited.
function writeLargeReal(dir, stem, { sessionId, cwd, ts, turns = 120, bodyKB = 48 }) {
  fs.mkdirSync(dir, { recursive: true });
  const body = 'x'.repeat(bodyKB * 1024);
  const rows = [];
  for (let i = 0; i < turns; i++) {
    rows.push(line({ type: 'user', sessionId, cwd, timestamp: ts, version: '1.0.0', gitBranch: 'main', entrypoint: 'cli', message: { role: 'user', content: `msg ${i} ${body}` } }));
    rows.push(line({ type: 'assistant', sessionId, cwd, timestamp: ts, message: { role: 'assistant', model: 'claude', content: `reply ${i} ${body}` } }));
  }
  fs.writeFileSync(path.join(dir, `${stem}.jsonl`), rows.join('\n') + '\n');
}
// A truncated PREFIX just over the sample budget: ~29 lines fully counted
// (statsExact ~ true over its own small body), FEWER bytes than the whole.
function writeLargeTruncated(dir, stem, { sessionId, cwd, ts, lines = 29, bodyKB = 18 }) {
  fs.mkdirSync(dir, { recursive: true });
  const body = 'x'.repeat(bodyKB * 1024);
  const rows = [];
  for (let i = 0; i < lines; i++) {
    rows.push(line({ type: i % 2 === 0 ? 'user' : 'assistant', sessionId, cwd, timestamp: ts, version: '1.0.0', message: { role: i % 2 === 0 ? 'user' : 'assistant', content: `frag ${i} ${body}` } }));
  }
  fs.writeFileSync(path.join(dir, `${stem}.jsonl`), rows.join('\n') + '\n');
}
function writeTruncated(dir, stem, { sessionId, cwd, ts }) {
  fs.mkdirSync(dir, { recursive: true });
  // 1 message, >0 bytes, carries sessionId+cwd so it LOOKS canonical.
  fs.writeFileSync(path.join(dir, `${stem}.jsonl`), line({ type: 'user', sessionId, cwd, timestamp: ts, version: '1.0.0', message: { role: 'user', content: 'only line' } }) + '\n');
}
function writeMetaOnly(dir, stem, { sessionId, cwd, ts }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${stem}.jsonl`), line({ type: 'summary', summary: 'x', sessionId, cwd, timestamp: ts }) + '\n');
}
function writeEmpty(dir, stem) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${stem}.jsonl`), '');
}
// A stub with NO cwd field at all (missing-cwd twin): canon=false, still >0 bytes/1 msg.
function writeNoCwd(dir, stem, { sessionId, ts }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${stem}.jsonl`), line({ type: 'user', sessionId, timestamp: ts, version: '1.0.0', message: { role: 'user', content: 'no cwd' } }) + '\n');
}
function writeNativeRollout(sessionsRoot, { sessionId, cwd, ts }) {
  const d = new Date(ts);
  const dir = path.join(sessionsRoot, String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const fileTs = ts.replace(/[:.]/g, '-');
  const rows = [
    line({ type: 'session_meta', payload: { session_id: sessionId, id: sessionId, timestamp: ts, cwd, originator: 'codex-tui', cli_version: '0.147.0', model_provider: 'openai' } }),
    line({ type: 'event_msg', payload: { type: 'user_message', message: 'native hello' } }),
    line({ type: 'event_msg', payload: { type: 'agent_message', message: 'native reply' } }),
  ];
  fs.writeFileSync(path.join(dir, `rollout-${fileTs}-${sessionId}.jsonl`), rows.join('\n') + '\n');
}
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

/* --- PART A: the r4 full-list merge served the stub; the complete index does not --- */
function partA(tmp) {
  console.log('\n--- PART A: r4 full-list first-seen merge serves the host stub (must-FAIL); complete index serves the real copy ---');
  const STORE = path.join(tmp, 'A-store');
  const curPath = '/tmp/r5a/current/proj';          // GROUP dir (basename "proj")
  const pastPath = '/tmp/r5a/old/legacy-archive';   // NON-group (basename "legacy-archive")
  const hostDir = path.join(STORE, hist.encodeCwd(curPath));
  const pastDir = path.join(STORE, hist.encodeCwd(pastPath));
  const hostEnc = hist.encodeCwd(curPath);
  const pastEnc = hist.encodeCwd(pastPath);

  // An ordinary session so the current path forms a logical group.
  writeOrdinary(hostDir, 'base', { sessionId: '0000base-0000-4000-8000-000000000000', cwd: curPath, ts: '2026-10-01T00:00:00.000Z' });
  // The twin: a TRUNCATED stub in the GROUP host dir, the REAL 60-turn transcript
  // stranded in the non-group PAST dir (records the pre-rename cwd).
  const idX = 'ffffffff-0000-4000-8000-000000000000';
  writeTruncated(hostDir, idX, { sessionId: idX, cwd: curPath, ts: '2026-10-05T00:00:00.000Z' });
  writeReal(pastDir, idX, { sessionId: idX, cwd: pastPath, ts: '2026-10-05T00:00:00.000Z', turns: 60 });

  const CPDIR = { CLAUDE_PROJECTS_DIR: STORE };
  const withStore = (fn) => { const prev = process.env.CLAUDE_PROJECTS_DIR; process.env.CLAUDE_PROJECTS_DIR = STORE; try { return fn(); } finally { if (prev === undefined) delete process.env.CLAUDE_PROJECTS_DIR; else process.env.CLAUDE_PROJECTS_DIR = prev; hist.clearSessionCache?.(); } };
  void CPDIR;

  withStore(() => {
    hist.clearSessionCache?.();
    // The logical group as the server computes it (only the current path groups).
    const logical = hist.groupByLogicalProject(hist.listProjectDirs()).find((lp) => lp.dirs.some((d) => d.encodedDir === hostEnc));
    if (!logical) { bad('PART A precondition: logical group found', 'none'); return; }
    const groupDirs = logical.dirs;
    const groupEncs = groupDirs.map((d) => d.encodedDir);
    if (groupEncs.includes(pastEnc)) { bad('PART A precondition: past dir is OUTSIDE the group', `grouped=${groupEncs}`); return; }
    ok('past-path dir is OUTSIDE the logical group (different basename)', pastEnc);

    // r4 sessionsForProject claude merge, re-implemented faithfully.
    const r4FullList = () => {
      const sessions = hist.listLogicalProjectSessions({ ...logical, dirs: groupDirs });
      for (const d of [pastEnc]) { // the pastDirs first-seen merge
        if (groupEncs.includes(d)) continue;
        let extra = [];
        try { extra = hist.listSessions(d); } catch { extra = []; }
        if (!extra.length) continue;
        const seen = new Set(sessions.map((s) => s.sessionId));
        for (const s of extra) if (!seen.has(s.sessionId)) sessions.push(s);
      }
      return sessions;
    };
    const r4 = r4FullList();
    const r4Row = r4.find((s) => s.sessionId === idX);
    if (r4Row && r4Row.messageCount <= 1 && r4Row.encodedDir === hostEnc) ok('MUST-FAIL: r4 full-list merge served the 1-msg HOST stub', `msgs=${r4Row.messageCount} dir=host`);
    else bad('MUST-FAIL expected r4 to serve the host stub', `row=${JSON.stringify(r4Row && { d: r4Row.encodedDir, m: r4Row.messageCount })}`);

    // r5 complete index.
    const idx = hist.canonicalSessionIndex([hostEnc, pastEnc]);
    const win = idx.get(idX);
    if (win && win.encodedDir === pastEnc) ok('FIX: complete canonicalSessionIndex keeps the REAL past-dir transcript', `dir=past bytes=${win.fileBytes}`);
    else bad('FIX expected complete index → past dir', `win=${JSON.stringify(win && { d: win.encodedDir })}`);
    hist.clearSessionCache?.();
  });
}

/* --- PART B: real server over every non-group source pair --- */
async function partB(tmp) {
  console.log('\n--- PART B: real server — full list, page union & deep link agree over twins across host/past/container/orchard/native ---');
  const STORE = path.join(tmp, 'B-store');
  const DATA = path.join(tmp, 'B-data');
  const CODEX = path.join(tmp, 'B-codex');
  const CODEX_SESSIONS = path.join(CODEX, 'sessions');
  fs.mkdirSync(path.join(DATA, 'session-hosts'), { recursive: true });
  fs.mkdirSync(CODEX_SESSIONS, { recursive: true });

  const PID = 'r5proj';
  const curPath = '/tmp/r5b/current/proj';
  const pastPath = '/tmp/r5b/old/legacy-archive';   // non-group basename
  const hostEnc = hist.encodeCwd(curPath);
  const pastEnc = hist.encodeCwd(pastPath);
  const containerEnc = cm.containerStoreDirName({ id: PID });   // -workspace-r5proj
  const containerAddr = cm.containerStoreAddressOfDir(containerEnc); // /workspace/r5proj
  const hostDir = path.join(STORE, hostEnc);
  const pastDir = path.join(STORE, pastEnc);
  const containerDir = path.join(STORE, containerEnc);
  const orchardDir = path.join(DATA, 'transcripts', 'openai', hostEnc);
  const T = (n) => `2026-10-${String(n).padStart(2, '0')}T00:00:00.000Z`;

  // Base sessions so the current path forms a group and pages have >1 row.
  for (let i = 1; i <= 3; i++) writeOrdinary(hostDir, `1000000${i}-0000-4000-8000-000000000000`, { sessionId: `1000000${i}-0000-4000-8000-000000000000`, cwd: curPath, ts: T(i) });

  // Twin P: host(group) TRUNCATED stub vs PAST real 60-turn. → past (real).
  const idP = 'aaaa0001-0000-4000-8000-000000000000';
  writeTruncated(hostDir, idP, { sessionId: idP, cwd: curPath, ts: T(10) });
  writeReal(pastDir, idP, { sessionId: idP, cwd: pastPath, ts: T(10), turns: 60 });

  // Twin K: host(group) METADATA-ONLY stub vs CONTAINER real 50-turn. → container.
  const idK = 'aaaa0002-0000-4000-8000-000000000000';
  writeMetaOnly(hostDir, idK, { sessionId: idK, cwd: curPath, ts: T(11) });
  writeReal(containerDir, idK, { sessionId: idK, cwd: containerAddr, ts: T(11), turns: 50 });

  // Twin E0: host(group) 0-BYTE stub vs PAST real 45-turn. → past.
  const idE0 = 'aaaa0003-0000-4000-8000-000000000000';
  writeEmpty(hostDir, idE0);
  writeReal(pastDir, idE0, { sessionId: idE0, cwd: pastPath, ts: T(12), turns: 45 });

  // Twin 3W (three-way): host 0-byte + container TRUNCATED(1) + PAST real 70. → past.
  const id3 = 'aaaa0004-0000-4000-8000-000000000000';
  writeEmpty(hostDir, id3);
  writeTruncated(containerDir, id3, { sessionId: id3, cwd: containerAddr, ts: T(13) });
  writeReal(pastDir, id3, { sessionId: id3, cwd: pastPath, ts: T(13), turns: 70 });

  // Twin PC: PAST truncated(1) vs CONTAINER real 40 (neither in group). → container.
  const idPC = 'aaaa0005-0000-4000-8000-000000000000';
  writeTruncated(pastDir, idPC, { sessionId: idPC, cwd: pastPath, ts: T(14) });
  writeReal(containerDir, idPC, { sessionId: idPC, cwd: containerAddr, ts: T(14), turns: 40 });

  // Twin NC: host(group) MISSING-CWD stub vs PAST real 35. → past (canon=false can't save a stub).
  const idNC = 'aaaa0006-0000-4000-8000-000000000000';
  writeNoCwd(hostDir, idNC, { sessionId: idNC, ts: T(15) });
  writeReal(pastDir, idNC, { sessionId: idNC, cwd: pastPath, ts: T(15), turns: 35 });

  // Twin BIG (run 459a68fa): host(group) LARGE TRUNCATED prefix (fully counted,
  // few msgs) vs PAST LARGE real transcript (sampled, undercounted messageCount).
  // Completeness must fall back to file size when a count is sampled → past.
  const idBig = 'aaaa0007-0000-4000-8000-000000000000';
  writeLargeTruncated(hostDir, idBig, { sessionId: idBig, cwd: curPath, ts: T(19) });
  writeLargeReal(pastDir, idBig, { sessionId: idBig, cwd: pastPath, ts: T(19), turns: 120 });

  // Orchard-owned real session (no claude twin): must appear once in full & page.
  const idO = 'bbbb0001-0000-4000-8000-000000000000';
  writeReal(orchardDir, idO, { sessionId: idO, cwd: curPath, ts: T(16), turns: 20 });

  // Native-codex real session matched to the host cwd: must appear once in full & page.
  const idN = 'cccc0001-0000-4000-8000-000000000000';
  writeNativeRollout(CODEX_SESSIONS, { sessionId: idN, cwd: curPath, ts: T(17) });

  // Symlinked twin: host real file + a past-dir symlink pointing at it (same id).
  // Served once (one id), full/page/deep agree.
  const idSym = 'dddd0001-0000-4000-8000-000000000000';
  writeReal(hostDir, idSym, { sessionId: idSym, cwd: curPath, ts: T(18), turns: 25 });
  fs.mkdirSync(pastDir, { recursive: true });
  try { fs.symlinkSync(path.join(hostDir, `${idSym}.jsonl`), path.join(pastDir, `${idSym}.jsonl`)); } catch { /* fs without symlink — skip */ }

  fs.writeFileSync(path.join(STORE, '.gitkeep'), '');
  fs.writeFileSync(path.join(DATA, 'registry.json'), JSON.stringify({
    version: 1,
    projects: [{ id: PID, name: 'proj', hostPath: curPath, isolation: 'direct', pastPaths: [pastPath], settings: {}, createdAt: T(1), updatedAt: T(1) }],
  }, null, 2));

  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = isolatedServerEnv({
    PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE, CODEX_HOME: CODEX,
    CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0',
  }, { requireStore: true });
  const server = spawn(process.execPath, [ENTRY], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  server.stderr?.on('data', (d) => { if (process.env.VERBOSE) process.stderr.write(`  [server] ${d}`); });
  try {
    let up = false;
    for (let i = 0; i < 150 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(200); } }
    if (!up) throw new Error('server never healthy');
    const get = async (qs) => (await fetch(`${BASE}/api/projects/${PID}/sessions${qs}`)).json();

    const full = await get('');
    const fullById = new Map(full.sessions.map((s) => [s.sessionId, s]));

    // Walk every page via the keyset cursor.
    const pageRows = new Map();
    let cursor = null, guard = 0;
    for (;;) {
      const j = await get(`?limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      for (const s of j.sessions) pageRows.set(s.sessionId, s);
      cursor = j.page.cursor;
      if (!j.page.hasMore || !cursor || ++guard > 60) break;
    }

    const fullIds = [...fullById.keys()].sort();
    const pageIds = [...pageRows.keys()].sort();
    if (JSON.stringify(fullIds) === JSON.stringify(pageIds)) ok('full list id set == page-union id set', `${fullIds.length} ids`);
    else bad('full == page union', `full=${fullIds.length} page=${pageIds.length} miss=${fullIds.filter((x) => !pageRows.has(x)).slice(0, 5)}`);

    // Every id resolves to the SAME copy (dir) via full list, page union and deep link.
    let allAgree = true; const detail = [];
    for (const id of fullIds) {
      const one = await get(`?session=${id}`);
      const deep = one.sessions[0]?.encodedDir;
      const f = fullById.get(id)?.encodedDir, p = pageRows.get(id)?.encodedDir;
      if (!(f === p && f === deep)) { allAgree = false; detail.push(`${id.slice(0, 8)}: full=${f} page=${p} deep=${deep}`); }
    }
    if (allAgree) ok('full, page union & deep link name the SAME copy for every id'); else bad('full/page/deep agree per id', detail.slice(0, 6).join(' | '));

    // Each stub-shadowed twin is served as the REAL transcript everywhere.
    const expect = [
      [idP, pastEnc, 'P host-trunc→past', 60],
      [idK, containerEnc, 'K host-meta→container', 50],
      [idE0, pastEnc, 'E0 host-0byte→past', 45],
      [id3, pastEnc, '3W host0/container-trunc→past', 70],
      [idPC, containerEnc, 'PC past-trunc→container', 40],
      [idNC, pastEnc, 'NC host-nocwd→past', 35],
    ];
    for (const [id, exp, label, turns] of expect) {
      const one = await get(`?session=${id}`);
      const deep = one.sessions[0];
      const dirOk = fullById.get(id)?.encodedDir === exp && pageRows.get(id)?.encodedDir === exp && deep?.encodedDir === exp;
      const realOk = (deep?.messageCount ?? 0) >= turns; // real transcript, not the 0/1-msg stub
      if (dirOk && realOk) ok(`twin ${label}: full/page/deep → real transcript`, `${deep.messageCount} msgs`);
      else bad(`twin ${label} → expected real copy in ${exp}`, `full=${fullById.get(id)?.encodedDir} page=${pageRows.get(id)?.encodedDir} deep=${deep?.encodedDir} msgs=${deep?.messageCount}`);
    }

    // Twin BIG: a sampled (undercounted) real transcript must still beat a fully
    // counted truncated prefix. Served copy is the past LARGE real everywhere.
    {
      const one = await get(`?session=${idBig}`);
      const deep = one.sessions[0];
      const dirOk = fullById.get(idBig)?.encodedDir === pastEnc && pageRows.get(idBig)?.encodedDir === pastEnc && deep?.encodedDir === pastEnc;
      if (dirOk) ok('twin BIG sampled-real beats fully-counted truncated prefix (run 459a68fa)', `→ past, ${deep?.messageCount}+ msgs (sampled)`);
      else bad('twin BIG → expected past large real', `full=${fullById.get(idBig)?.encodedDir} page=${pageRows.get(idBig)?.encodedDir} deep=${deep?.encodedDir}`);
    }

    // Orchard-owned + native rows present exactly once, same in full & page.
    for (const [id, label] of [[idO, 'orchard-owned'], [idN, 'native-codex'], [idSym, 'symlinked twin']]) {
      const inFull = fullById.has(id); const inPage = pageRows.has(id);
      if (inFull && inPage) ok(`${label} present once in full & page`, fullById.get(id)?.encodedDir);
      else bad(`${label} present in both`, `full=${inFull} page=${inPage}`);
    }

    // Extreme cursor values: well-formed but absurd → a valid (empty-or-subset) page, never a crash.
    for (const [m, s, label] of [[1e308, 'zzzzzzzz', 'm=1e308'], [8.64e15, 'z'.repeat(400), 'huge m + huge s'], [-1, 'aaaa0001-0000-4000-8000-000000000000', 'negative m']]) {
      const tok = Buffer.from(JSON.stringify({ m, s }), 'utf8').toString('base64url');
      const r = await fetch(`${BASE}/api/projects/${PID}/sessions?limit=4&cursor=${encodeURIComponent(tok)}`);
      const j = await r.json().catch(() => null);
      if (r.status === 200 && j && Array.isArray(j.sessions)) ok(`extreme cursor ${label} → 200, valid page`, `${j.sessions.length} rows`);
      else bad(`extreme cursor ${label} → 200`, `status=${r.status}`);
    }
    // Malformed cursor → 400.
    {
      const r = await fetch(`${BASE}/api/projects/${PID}/sessions?limit=4&cursor=%%%not-base64%%%`);
      if (r.status === 400) ok('malformed cursor → 400'); else bad('malformed cursor → 400', `status=${r.status}`);
    }

    const stillUp = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false);
    if (stillUp) ok('server healthy after the run'); else bad('server healthy', 'health failed');
  } finally {
    try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
  }
}

async function main() {
  console.log('\n========== FEAT-199 r5 — one canonical index across ALL sources (host/past/container/orchard/native) ==========');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat199-r5-'));
  try {
    partA(tmp);
    await partB(tmp);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  }
  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`} — FEAT-199 r5 sources\n`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
