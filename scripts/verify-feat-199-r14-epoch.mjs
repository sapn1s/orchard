/*
 * FEAT-199 r14 — the unix-epoch-boundary BROKEN (openai run 01a1aac0-6596-7641-
 * a5a1-a3dbb24a5d53). projectRecencyAt's mtime-desc early-stop used a NUMERIC
 * sentinel for "nothing found yet":
 *
 *     const bestMs = () => (best === null ? 0 : activityInstant(best) || 0);
 *     for (const st of stubs) { if (st.mtimeMs <= bestMs()) break; ... }
 *
 * A real file with mtime 0 (unix epoch) satisfies `st.mtimeMs <= 0`, so the walk
 * STOPPED before parsing it even though `best` was still null and no floor
 * existed — the whole project's recency came back null (or missed its newest
 * message), burying it from the sidebar.
 *
 * The fix: when `best === null` there is NO floor, so NEVER early-stop — always
 * parse. The floor is a null, not a number, so no mtime value can collide with
 * it. PHASE MUSTFAIL recomputes the OLD sentinel-0 algorithm standalone to prove
 * the break is real; PHASE SERVER drives the REAL server (with the fix), ONE
 * fixture project per isolated store, and asserts GET /api/projects
 * `lastActivityAt` equals that project's own full-list top row BY INSTANT.
 *
 * Fixtures: (1) epoch-mtime file with a real recent message; (2) mtime 0 with NO
 * parseable timestamps; (3) a sub-epoch/boundary mtime; (4) an all-unparseable
 * project. Each runs ALONE in its own store so the logical-project grouping
 * cannot merge a synthetic sibling into it.
 *
 * NOTE on negative mtimes: on this platform `fs.utimesSync(fp, -N, -N)` does NOT
 * produce a negative mtime — libc/Node coerce the negative seconds to a wrapped
 * far-future instant (measured ~+57y). So a genuinely-negative mtime is not
 * representable here; the `<= 0` boundary is reachable in practice via mtime
 * EXACTLY 0 (the epoch fixture). The null-floor fix handles any mtime value
 * (0, negative, or far-future) identically, since the floor is null, not 0.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { encodeCwd } from '../src/lib/session-history.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  ok ? pass++ : (fail++, failures.push(name));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 24 * 3600 * 1000;
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();
const msOf = (iso) => (iso ? Date.parse(iso) : null);
const near = (a, b, tol = 2000) => a != null && b != null && Math.abs(msOf(a) - msOf(b)) <= tol;

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
async function spawnServer(env) {
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const srv = spawn(process.execPath, [ENTRY], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'ignore', 'pipe'], detached: true,
  });
  srv.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(200); } }
  if (!up) { try { process.kill(-srv.pid); } catch {} throw new Error('server never became healthy'); }
  return { srv, BASE };
}
async function killServer(s) { if (s?.srv?.pid) { try { process.kill(-s.srv.pid); } catch {} await sleep(400); } }
function rmTree(p) { for (let i = 0; i < 5; i++) { try { fs.rmSync(p, { recursive: true, force: true }); return; } catch { } } }

function msgLine(type, iso, id, cwd, i) {
  const base = { type, sessionId: id, cwd, uuid: `${id}-u${i}`, parentUuid: i ? `${id}-u${i - 1}` : null, version: '2.0.0', gitBranch: 'main',
    message: { role: type, content: type === 'user' ? `hi ${i}` : [{ type: 'text', text: `r${i}` }], ...(type === 'assistant' ? { model: 'claude-x' } : {}) } };
  // iso === undefined ⇒ omit the timestamp field entirely (no-timestamp fixture).
  if (iso !== undefined) base.timestamp = iso;
  return JSON.stringify(base);
}
// Write a claude session into STORE/encodeCwd(cwd) and force its mtime (seconds).
function writeTs(store, cwd, id, firstIso, lastIso, mtimeSec) {
  const dir = path.join(store, encodeCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(fp, [msgLine('user', firstIso, id, cwd, 0), msgLine('assistant', lastIso, id, cwd, 1)].join('\n') + '\n');
  if (mtimeSec != null) fs.utimesSync(fp, mtimeSec, mtimeSec);
  return fp;
}

/* ---- OLD sentinel-0 algorithm, recomputed standalone to prove the must-FAIL.
   Mirrors the pre-fix projectRecencyAt walk: best=null floor is the NUMBER 0. ---- */
function lastParsedTs(fp) {
  let last = null;
  for (const ln of fs.readFileSync(fp, 'utf8').split('\n')) {
    if (!ln.trim()) continue;
    try { const o = JSON.parse(ln); if (typeof o.timestamp === 'string' && !Number.isNaN(Date.parse(o.timestamp))) last = o.timestamp; } catch {}
  }
  return last;
}
// readSessionMeta's value: parsed last timestamp, else file-mtime ISO (index line 1043).
function metaRecency(fp) {
  const ts = lastParsedTs(fp);
  if (ts) return ts;
  return new Date(fs.statSync(fp).mtimeMs).toISOString();
}
function oldSentinelRecency(storeDir) {
  const stubs = fs.readdirSync(storeDir).filter((f) => f.endsWith('.jsonl'))
    .map((f) => { const fp = path.join(storeDir, f); return { fp, mtimeMs: fs.statSync(fp).mtimeMs }; })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  let best = null;
  const bestMs = () => (best === null ? 0 : Date.parse(best) || 0); // OLD: sentinel 0
  for (const st of stubs) {
    if (st.mtimeMs <= bestMs()) break; // OLD early-stop — skips mtime<=0 files
    const r = metaRecency(st.fp);
    if (r && (best === null || Date.parse(r) > Date.parse(best))) best = r;
  }
  return best;
}
// The fixed null-floor walk, recomputed standalone (should match the server).
function newFloorRecency(storeDir) {
  const stubs = fs.readdirSync(storeDir).filter((f) => f.endsWith('.jsonl'))
    .map((f) => { const fp = path.join(storeDir, f); return { fp, mtimeMs: fs.statSync(fp).mtimeMs }; })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  let best = null;
  const floor = () => (best === null ? null : (Number.isNaN(Date.parse(best)) ? null : Date.parse(best)));
  for (const st of stubs) {
    const f = floor();
    if (f !== null && st.mtimeMs <= f) break;
    const r = metaRecency(st.fp);
    if (r && (best === null || Date.parse(r) > Date.parse(best))) best = r;
  }
  return best;
}
// The full-list top row: every file is parsed (no early-stop).
function fullListTop(storeDir) {
  const vals = fs.readdirSync(storeDir).filter((f) => f.endsWith('.jsonl'))
    .map((f) => metaRecency(path.join(storeDir, f))).filter(Boolean);
  vals.sort((a, b) => Date.parse(b) - Date.parse(a));
  return vals[0] ?? null;
}

const nowIso = new Date().toISOString();
const mk = (id, name, hostPath) => ({ id, name, hostPath, isolation: 'direct', settings: {}, createdAt: nowIso, updatedAt: nowIso });

// Run ONE fixture project alone in its own fresh store+registry; return the
// server's recency and the project's own top-row, plus the on-disk store dir.
async function soloServer(cwd, writeFiles) {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-r14-data-'));
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-r14-store-'));
  const storeDir = path.join(STORE, encodeCwd(cwd));
  fs.mkdirSync(storeDir, { recursive: true });
  writeFiles(STORE);
  fs.writeFileSync(path.join(DATA, 'registry.json'), JSON.stringify({ version: 1, projects: [mk('p-solo', 'solo', cwd)] }, null, 2));
  const s = await spawnServer({ CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE });
  try {
    const projJson = await (await fetch(`${s.BASE}/api/projects`)).json();
    const recency = projJson.projects.find((p) => p.id === 'p-solo')?.lastActivityAt ?? null;
    const sess = await (await fetch(`${s.BASE}/api/projects/p-solo/sessions`)).json();
    const topRow = sess.sessions?.[0]?.lastActivityAt ?? null;
    const rows = (sess.sessions ?? []).map((x) => ({ sid: x.sessionId, la: x.lastActivityAt }));
    return { recency, topRow, rows, storeDir };
  } finally {
    await killServer(s); rmTree(DATA); rmTree(STORE);
  }
}

async function run() {
  // ---- PHASE MUSTFAIL: prove the OLD sentinel-0 algorithm breaks (no server) ----
  console.log('\n===== PHASE MUSTFAIL — OLD sentinel-0 walk skips the mtime-0 file =====');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-r14-mf-'));
    const epochMsg = isoAgo(3 * DAY);
    const fp = path.join(tmp, 'eeee0001.jsonl');
    fs.writeFileSync(fp, [msgLine('user', isoAgo(3 * DAY + 3600e3), 'eeee0001', '/x', 0), msgLine('assistant', epochMsg, 'eeee0001', '/x', 1)].join('\n') + '\n');
    fs.utimesSync(fp, 0, 0); // mtime exactly 0 (unix epoch)
    const old = oldSentinelRecency(tmp), top = fullListTop(tmp), fixed = newFloorRecency(tmp);
    check('MUSTFAIL: OLD sentinel-0 recency != full-list top (the 3d message is skipped)', msOf(old) !== msOf(top), { oldRecency: old, fullListTop: top });
    check('MUSTFAIL: OLD recency is null — the whole project is buried off the sidebar', old === null, { oldRecency: old });
    check('MUSTFAIL: the new null-floor walk recovers the real 3d message (== full-list top)', near(fixed, top) && near(fixed, epochMsg), { fixedRecency: fixed, fullListTop: top, realMsg: epochMsg });
    rmTree(tmp);

    // Document the FS negative-mtime coercion so the "negative mtime" sub-case is honest.
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-r14-neg-'));
    const nf = path.join(tmp2, 'n.jsonl'); fs.writeFileSync(nf, 'x\n'); fs.utimesSync(nf, -86400, -86400);
    const negM = fs.statSync(nf).mtimeMs;
    check('MUSTFAIL: negative utimes is NOT representable on this FS (coerced, not < 0) — documented, so only mtime==0 exercises the <=0 boundary', negM > 0,
      { requestedSec: -86400, resultingMtimeMs: negM, note: 'libc/Node wrap negative seconds to a far-future instant; the null-floor fix handles any value regardless' });
    rmTree(tmp2);
  }

  // ---- PHASE SERVER: the fixed server agrees with the full list, per fixture ----
  console.log('\n===== PHASE SERVER — fixed server, one fixture per isolated store =====');

  // (1) epoch: ONE file, newest message 3 days ago, file mtime forced to 0.
  {
    const cwd = '/tmp/r14epoch/proj';
    const epochMsg = isoAgo(3 * DAY);
    const r = await soloServer(cwd, (store) => writeTs(store, cwd, 'eeee0001-0000-0000-0000-000000000001', isoAgo(3 * DAY + 3600e3), epochMsg, 0));
    check('SERVER epoch: recency == full-list top row (by instant)', near(r.recency, r.topRow), { recency: r.recency, top: r.topRow, rows: r.rows });
    check('SERVER epoch: recency == the real 3d message (mtime-0 file parsed, not skipped, project not buried)', near(r.recency, epochMsg), { recency: r.recency, realMsg: epochMsg });
  }

  // (2) no-timestamp, mtime 0: recency == epoch-ISO mtime fallback == full-list top.
  {
    const cwd = '/tmp/r14nots/proj';
    const r = await soloServer(cwd, (store) => writeTs(store, cwd, 'eeee0002-0000-0000-0000-000000000002', undefined, undefined, 0));
    check('SERVER no-timestamp/mtime-0: recency == full-list top row', near(r.recency, r.topRow), { recency: r.recency, top: r.topRow, rows: r.rows });
    check('SERVER no-timestamp/mtime-0: value is the epoch-ISO fallback (instant 0), project not dropped', r.recency != null && msOf(r.recency) === 0, { recency: r.recency });
  }

  // (3) boundary mtime via negative utimes (coerced to far-future on this FS):
  // the file is still parsed and its REAL message wins; recency == full-list top.
  {
    const cwd = '/tmp/r14neg/proj';
    const negMsg = isoAgo(2 * DAY);
    const r = await soloServer(cwd, (store) => writeTs(store, cwd, 'eeee0003-0000-0000-0000-000000000003', isoAgo(2 * DAY + 3600e3), negMsg, -86400));
    const diskM = fs.existsSync(r.storeDir) ? null : null; // store already torn down; value documented in MUSTFAIL
    check('SERVER boundary-mtime: recency == full-list top row (by instant)', near(r.recency, r.topRow), { recency: r.recency, top: r.topRow });
    check('SERVER boundary-mtime: recency == the real 2d message (file still parsed under null floor)', near(r.recency, negMsg), { recency: r.recency, realMsg: negMsg });
  }

  // (4) all-unparseable: no crash; recency falls back to the file mtime == full-list top.
  {
    const cwd = '/tmp/r14unpars/proj';
    let mtimeIso = null;
    const r = await soloServer(cwd, (store) => { const fp = writeTs(store, cwd, 'eeee0004-0000-0000-0000-000000000004', 'not-a-date', 'garbage-xyz', (Date.now() - 4 * DAY) / 1000); mtimeIso = new Date(fs.statSync(fp).mtimeMs).toISOString(); });
    check('SERVER all-unparseable: server did not crash; recency == full-list top', near(r.recency, r.topRow), { recency: r.recency, top: r.topRow, rows: r.rows });
    check('SERVER all-unparseable: recency falls back to the file mtime (4d ago), never a parsed-garbage value', near(r.recency, mtimeIso), { recency: r.recency, mtimeIso });
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
  if (fail) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
}
run().catch((e) => { console.error(e); process.exit(1); });
