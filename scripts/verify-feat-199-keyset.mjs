#!/usr/bin/env node
/**
 * verify:feat-199 (keyset) — the structural fix the independent verifier (run
 * f15d0796, BROKEN) asked for: a KEYSET cursor keyed by the TRUE sessionId.
 *
 * Two layers:
 *
 *  PART A — SLICER MODEL (must-FAIL proof). The old route sliced the recency
 *  order by OFFSET; the new route returns the rows STRICTLY AFTER a (recency,id)
 *  cursor. Modelled here as the two pure slicers over one ordered list, with a
 *  store mutation applied BETWEEN page 1 and the rest:
 *    - finding 3 (a delete between fetches): OFFSET skips a survivor; KEYSET does
 *      not. This assertion FAILS on the offset slicer and PASSES on keyset.
 *    - finding 2 (an update between fetches): OFFSET re-returns an already-shown
 *      row (a duplicate); the KEYSET below-walk is a clean partition (no dup),
 *      and the row that moved to the top is recovered by a page-1 refresh.
 *
 *  PART B — REAL SERVER. An isolated scratch server over a scratch store with
 *  file mtimes set by hand, exercising the live route:
 *    - finding 1 (stem-vs-sessionId): a file whose stem differs from its in-file
 *      id surfaces the session ONCE across the whole cursor walk (true-id pool).
 *    - finding 2 end-to-end: bump a below-cursor session to newest; a page-1
 *      re-fetch (what the sidebar does on a live update) surfaces it — it never
 *      vanishes.
 *    - finding 3 end-to-end: delete a page-1 session; the cursor walk strands no
 *      survivor.
 *    - equal mtimes across two store dirs → a stable id tiebreak, each once.
 *    - limit edge values (1, == total, > total); empty project; exactly N.
 *    - a cursor is a POSITION, not an authorisation (round-4 decision): only a
 *      MALFORMED cursor (garbage base64, wrong shape, wrong field types) → 400;
 *      a well-formed but client-fabricated cursor is ACCEPTED and just yields a
 *      different valid page (it holds no secret and grants nothing — editing it
 *      cannot reach anything a fresh walk could not). Empty cursor → first page.
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

/* ----------------------------------------------------------- PART A: model */

// ordered: [{ id, m }] sorted recency desc, id asc (the server's total order).
const offsetPage = (ordered, offset, limit) => ordered.slice(offset, offset + limit);
const keysetPage = (ordered, cursor, limit) =>
  ordered
    .filter((c) => cursor === null || c.m < cursor.m || (c.m === cursor.m && c.id > cursor.s))
    .slice(0, limit);
const reorder = (arr) => arr.slice().sort((a, b) => b.m - a.m || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

function modelPart() {
  console.log('\n----- PART A: offset-vs-keyset slicer model (must-FAIL on offset) -----');
  const LIMIT = 4;
  // 10 sessions, mtime 100..91 (newest first), stems s0..s9.
  const OLD = reorder(Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, m: 100 - i })));

  // page 1 is identical for both slicers (fetched before the mutation).
  const page1 = OLD.slice(0, LIMIT); // s0,s1,s2,s3
  const cursor = { m: page1[page1.length - 1].m, s: page1[page1.length - 1].id }; // (97, s3)

  /* finding 3 — a DELETE between fetches. */
  {
    const NEW = reorder(OLD.filter((c) => c.id !== 's1')); // delete a page-1 row
    const offUnion = new Set(page1.map((c) => c.id));
    for (let off = LIMIT; ; off += LIMIT) { const p = offsetPage(NEW, off, LIMIT); if (!p.length) break; for (const c of p) offUnion.add(c.id); }
    const ksUnion = new Set(page1.map((c) => c.id));
    let cur = cursor; for (;;) { const p = keysetPage(NEW, cur, LIMIT); if (!p.length) break; for (const c of p) ksUnion.add(c.id); cur = { m: p[p.length - 1].m, s: p[p.length - 1].id }; }
    const survivors = new Set(NEW.map((c) => c.id));
    const offMissed = [...survivors].filter((id) => !offUnion.has(id));
    const ksMissed = [...survivors].filter((id) => !ksUnion.has(id));
    // must-FAIL on offset:
    if (offMissed.length > 0) ok('finding 3 — OFFSET SKIPS a survivor after a delete (reproduced)', `lost ${offMissed.join(',')}`);
    else bad('finding 3 — offset should skip a survivor', 'offset lost nothing — model wrong');
    if (ksMissed.length === 0) ok('finding 3 — KEYSET strands NO survivor after a delete');
    else bad('finding 3 — keyset strands no survivor', `lost ${ksMissed.join(',')}`);
  }

  /* finding 2 — an UPDATE between fetches (s5 bumped to newest). */
  {
    const NEW = reorder(OLD.map((c) => (c.id === 's5' ? { id: 's5', m: 200 } : c)));
    // below-walk duplicate check: does a page re-return a page-1 row?
    const offBelow = []; for (let off = LIMIT; ; off += LIMIT) { const p = offsetPage(NEW, off, LIMIT); if (!p.length) break; offBelow.push(...p.map((c) => c.id)); }
    const ksBelow = []; let cur = cursor; for (;;) { const p = keysetPage(NEW, cur, LIMIT); if (!p.length) break; ksBelow.push(...p.map((c) => c.id)); cur = { m: p[p.length - 1].m, s: p[p.length - 1].id }; }
    const page1ids = new Set(page1.map((c) => c.id));
    const offDup = offBelow.filter((id) => page1ids.has(id));
    const ksDup = ksBelow.filter((id) => page1ids.has(id));
    if (offDup.length > 0) ok('finding 2 — OFFSET re-returns an already-shown row after an update (reproduced)', `dup ${offDup.join(',')}`);
    else bad('finding 2 — offset should duplicate after update', 'no dup — model wrong');
    if (ksDup.length === 0) ok('finding 2 — KEYSET below-walk is a clean partition (no duplicate)');
    else bad('finding 2 — keyset below-walk has no duplicate', `dup ${ksDup.join(',')}`);
    // the bumped row is recovered by a page-1 refresh (what the sidebar does).
    const freshPage1 = NEW.slice(0, LIMIT).map((c) => c.id);
    if (freshPage1.includes('s5')) ok('finding 2 — the updated row is surfaced by a page-1 refresh (never vanishes)');
    else bad('finding 2 — page-1 refresh surfaces the updated row', `page1=${freshPage1.join(',')}`);
  }
}

/* ------------------------------------------------------ PART B: real server */

function line(obj) { return JSON.stringify(obj); }
function writeSession(dir, stem, { sessionId, cwd, ts, mtime, pad = 0 }) {
  fs.mkdirSync(dir, { recursive: true });
  const rows = [
    line({ type: 'user', sessionId, cwd, timestamp: ts, version: '1.0.0', gitBranch: 'main', entrypoint: 'cli', message: { role: 'user', content: `hello ${stem}${'x'.repeat(pad)}` } }),
    line({ type: 'assistant', sessionId, cwd, timestamp: ts, message: { role: 'assistant', model: 'claude', content: 'hi' } }),
  ];
  const fp = path.join(dir, `${stem}.jsonl`);
  fs.writeFileSync(fp, rows.join('\n') + '\n');
  if (mtime) fs.utimesSync(fp, new Date(mtime), new Date(mtime));
  return fp;
}

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

async function serverPart() {
  console.log('\n----- PART B: real keyset server over a scratch store -----');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat199-ks-'));
  const STORE = path.join(tmp, 'projects');
  const DATA = path.join(tmp, 'data');
  fs.mkdirSync(path.join(DATA, 'session-hosts'), { recursive: true });

  const hostPath = '/tmp/ktX/ktproj';
  const otherPath = '/tmp/ktY/ktproj';         // same basename → same logical project
  const emptyPath = '/tmp/ktZ/ktempty';
  const hostDir = path.join(STORE, hist.encodeCwd(hostPath));
  const otherDir = path.join(STORE, hist.encodeCwd(otherPath));
  const T = (n) => `2026-10-${String(n).padStart(2, '0')}T00:00:00.000Z`;
  const base = Date.UTC(2026, 9, 1); const DAY = 86400000;

  // 10 ordinary sessions, mtime decreasing with index (uuid(1) newest).
  const stems = [];
  for (let i = 1; i <= 10; i++) {
    const id = uuid(i);
    stems.push(id);
    writeSession(hostDir, id, { sessionId: id, cwd: hostPath, ts: T(i), mtime: base + (20 - i) * DAY });
  }
  // finding 1 — a file whose STEM differs from its in-file id, colliding with uuid(5).
  const anomalyStem = 'zzzzzzzz-aaaa-4000-8000-000000000000';
  writeSession(hostDir, anomalyStem, { sessionId: uuid(5), cwd: hostPath, ts: T(5), mtime: base + 99 * DAY }); // newest file, same id as uuid(5)
  // finding 1b (anthropic run 0ebe209e) — a file whose FIRST entry is a >32 KB
  // snapshot with NO sessionId, so a cheap 16 KB/regex probe would miss the real
  // id (deeper in the head) and key by stem → a cross-page duplicate. The stem
  // differs from the in-file id, which collides with uuid(6).
  {
    const big = 'yyyyyyyy-bbbb-4000-8000-000000000000';
    const fp = path.join(hostDir, `${big}.jsonl`);
    const snapshot = line({ type: 'file-history-snapshot', timestamp: T(6), blob: 'Z'.repeat(40 * 1024) }); // no sessionId, >32 KB
    const real = line({ type: 'user', sessionId: uuid(6), cwd: hostPath, timestamp: T(6), message: { role: 'user', content: 'hi' } });
    fs.writeFileSync(fp, `${snapshot}\n${real}\n`);
    fs.utimesSync(fp, new Date(base + 98 * DAY), new Date(base + 98 * DAY));
  }
  // equal mtimes across two dirs — two DISTINCT ids sharing one mtime.
  const eqA = uuid(101); const eqB = uuid(102); const EQ = base + 50 * DAY;
  writeSession(hostDir, eqA, { sessionId: eqA, cwd: hostPath, ts: T(11), mtime: EQ });
  writeSession(otherDir, eqB, { sessionId: eqB, cwd: hostPath, ts: T(11), mtime: EQ });
  // MIXED-CASE equal-mtime trio (anthropic run 0ebe209e) — ids whose localeCompare
  // order differs from their code-unit order (a… < B… < c… by code unit, but
  // locale sorts case-insensitively). The sort tiebreak and the cursor filter
  // must use the SAME comparison, or a small-limit walk drops or doubles one.
  const mcIds = ['a0000000-cccc-4000-8000-000000000000', 'B0000000-cccc-4000-8000-000000000000', 'c0000000-cccc-4000-8000-000000000000'];
  const MC = base + 40 * DAY;
  for (const id of mcIds) writeSession(hostDir, id, { sessionId: id, cwd: hostPath, ts: T(12), mtime: MC });

  // Empty project: a registered project whose store dir has no sessions.
  fs.mkdirSync(path.join(STORE, hist.encodeCwd(emptyPath)), { recursive: true });

  fs.writeFileSync(path.join(DATA, 'registry.json'), JSON.stringify({
    version: 1,
    projects: [
      { id: 'ktproj', name: 'ktproj', hostPath, isolation: 'direct', settings: {}, createdAt: T(1), updatedAt: T(1) },
      { id: 'ktempty', name: 'ktempty', hostPath: emptyPath, isolation: 'direct', settings: {}, createdAt: T(1), updatedAt: T(1) },
    ],
  }, null, 2));

  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = isolatedServerEnv({
    PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE,
    CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0',
  }, { requireStore: true });
  const server = spawn(process.execPath, [ENTRY], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  server.stderr?.on('data', (d) => { if (process.env.VERBOSE) process.stderr.write(`  [server] ${d}`); });
  const get = async (qs) => { const r = await fetch(`${BASE}/api/projects/ktproj/sessions${qs}`); return { status: r.status, json: await r.json().catch(() => null) }; };
  const walk = async (limit) => {
    const ids = []; let cursor = null; let guard = 0; let totals = [];
    for (;;) {
      const qs = `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const { json } = await get(qs);
      for (const s of json.sessions) ids.push(s.sessionId);
      totals.push(json.page.total);
      cursor = json.page.cursor;
      if (!json.page.hasMore || !cursor || ++guard > 50) break;
    }
    return { ids, totals };
  };

  try {
    let up = false;
    for (let i = 0; i < 150 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(200); } }
    if (!up) throw new Error('server never healthy');

    // Authority: the full (unpaginated) list.
    const full = (await get('')).json;
    const fullIds = full.sessions.map((s) => s.sessionId).sort();
    const distinct = new Set(fullIds);

    /* finding 1 — stem-vs-id: the anomaly session appears exactly ONCE across a cursor walk. */
    const w = await walk(3);
    const counts = new Map(); for (const id of w.ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    const dups = [...counts.entries()].filter(([, n]) => n > 1);
    if (dups.length === 0) ok('finding 1 — cursor walk surfaces every session exactly once (true-id pool)', `${w.ids.length} rows`);
    else bad('finding 1 — no cross-page duplicate', `dups ${dups.map(([id, n]) => `${id.slice(0, 8)}×${n}`).join(',')}`);
    const walkSet = [...new Set(w.ids)].sort();
    if (JSON.stringify(walkSet) === JSON.stringify(fullIds)) ok('cursor-walk set == full set', `${walkSet.length}`);
    else bad('cursor-walk set == full set', `walk=${walkSet.length} full=${fullIds.length} miss=${fullIds.filter((x) => !walkSet.includes(x)).slice(0, 3)}`);
    if (w.totals.every((t) => t === distinct.size)) ok('page.total == distinct true-id count on every page', `${distinct.size}`);
    else bad('page.total stable == distinct count', `totals=${w.totals.join(',')} distinct=${distinct.size}`);

    /* equal mtimes across two dirs — both present once, deterministic order. */
    const haveEqA = w.ids.filter((x) => x === eqA).length;
    const haveEqB = w.ids.filter((x) => x === eqB).length;
    if (haveEqA === 1 && haveEqB === 1) ok('equal-mtime cross-dir pair: each id once (stable tiebreak)');
    else bad('equal-mtime pair each once', `eqA=${haveEqA} eqB=${haveEqB}`);
    // Re-walk and assert identical order (determinism of the tiebreak).
    const w2 = await walk(3);
    if (JSON.stringify(w.ids) === JSON.stringify(w2.ids)) ok('cursor walk is deterministic across requests');
    else bad('cursor walk deterministic', 'order differed between walks');

    // Mixed-case equal-mtime trio: a SMALL-LIMIT walk (where the cursor lands
    // exactly inside the trio) must return each of the three exactly once.
    for (const L of [1, 2]) {
      const wl = await walk(L);
      const got = mcIds.filter((id) => wl.ids.includes(id));
      const dup = mcIds.some((id) => wl.ids.filter((x) => x === id).length > 1);
      if (got.length === 3 && !dup) ok(`mixed-case equal-mtime trio: each id once at limit=${L} (comparator consistent)`);
      else bad(`mixed-case trio at limit=${L}`, `present=${got.length} dup=${dup}`);
    }

    /* limit edge values. */
    const n = distinct.size;
    const one = (await get('?limit=1')).json;
    if (one.sessions.length === 1 && one.page.hasMore === true && one.page.cursor) ok('limit=1 returns 1 row, hasMore, a cursor');
    else bad('limit=1 edge', JSON.stringify(one.page));
    const exact = (await get(`?limit=${n}`)).json;
    if (exact.sessions.length === n && exact.page.hasMore === false) ok(`limit==total (${n}) returns all, hasMore=false`);
    else bad('limit==total edge', `${exact.sessions.length}/${n} hasMore=${exact.page.hasMore}`);
    // a next page from the exact-N cursor is empty.
    const afterExact = (await get(`?limit=${n}&cursor=${encodeURIComponent(exact.page.cursor)}`)).json;
    if (afterExact.sessions.length === 0 && afterExact.page.hasMore === false) ok('page after an exact-N cursor is empty');
    else bad('page after exact-N cursor empty', `${afterExact.sessions.length} rows`);
    const over = (await get('?limit=500')).json;
    if (over.sessions.length === n && over.page.hasMore === false) ok('limit>total returns all, hasMore=false');
    else bad('limit>total edge', `${over.sessions.length}/${n}`);

    /* empty project. */
    const empty = await (await fetch(`${BASE}/api/projects/ktempty/sessions?limit=30`)).json();
    if (empty.sessions.length === 0 && empty.page.total === 0 && empty.page.hasMore === false && empty.page.cursor === null)
      ok('empty project: 0 rows, total 0, hasMore false, cursor null');
    else bad('empty project edge', JSON.stringify(empty.page));

    /* A cursor is a POSITION, not an authorisation (round-4 decision). Only a
       MALFORMED cursor → 400; a well-typed but client-fabricated cursor is a
       valid position → 200 with the rows strictly after it (no HMAC, no
       rejection of "forgery"). */
    const garbage = await get('?limit=5&cursor=not%20base64%20%21%21');
    if (garbage.status === 400) ok('garbage cursor → 400 (no crash)');
    else bad('garbage cursor → 400', `status=${garbage.status}`);
    const wrongShape = await get(`?limit=5&cursor=${encodeURIComponent(Buffer.from(JSON.stringify({ nope: 1 }), 'utf8').toString('base64url'))}`);
    if (wrongShape.status === 400) ok('valid-base64 but wrong-shape cursor → 400');
    else bad('wrong-shape cursor → 400', `status=${wrongShape.status}`);
    const forgedNum = await get(`?limit=5&cursor=${encodeURIComponent(Buffer.from(JSON.stringify({ m: 'NaN', s: 5 }), 'utf8').toString('base64url'))}`);
    if (forgedNum.status === 400) ok('cursor with wrong field types → 400');
    else bad('wrong-type cursor → 400', `status=${forgedNum.status}`);
    const emptyCursor = await get('?limit=3&cursor=');
    if (emptyCursor.status === 200 && emptyCursor.json.sessions.length === 3) ok('empty cursor → first page (200)');
    else bad('empty cursor → first page', `status=${emptyCursor.status}`);
    // A well-formed but fabricated cursor is a POSITION, accepted (round-4
    // decision): a future-dated m with a zero id → the whole list from the top;
    // and the fabricated page's rows are a subset of a fresh full walk (it can
    // reach nothing a plain walk could not).
    {
      const future = Date.now() + 10 * 365 * 86400000;
      const forged = Buffer.from(JSON.stringify({ m: future, s: '00000000-0000-0000-0000-000000000000' }), 'utf8').toString('base64url');
      const r = await get(`?limit=5&cursor=${encodeURIComponent(forged)}`);
      const walkSetArr = (await (async () => { const s = new Set(); let cur = null; let g = 0; for (;;) { const j = (await get(`?limit=50${cur ? `&cursor=${encodeURIComponent(cur)}` : ''}`)).json; for (const x of j.sessions) s.add(x.sessionId); cur = j.page.cursor; if (!j.page.hasMore || !cur || ++g > 50) break; } return s; })());
      const subset = r.status === 200 && r.json.sessions.every((x) => walkSetArr.has(x.sessionId));
      if (r.status === 200 && subset) ok('fabricated well-formed cursor → 200, a valid position (subset of a fresh walk; no 400, no secret)', `${r.json.sessions.length} rows`);
      else bad('fabricated cursor accepted as a position', `status=${r.status} subset=${subset}`);
    }
    // health: server still answers after the bad cursors (no crash).
    const stillUp = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false);
    if (stillUp) ok('server healthy after forged cursors (never crashed)');
    else bad('server healthy after forged cursors', 'health failed');

    /* finding 3 end-to-end — delete a page-1 session; cursor walk strands no survivor. */
    {
      const p1 = (await get('?limit=4')).json;
      const cursor = p1.page.cursor;
      const victim = p1.sessions[1].sessionId; // a row inside page 1
      // delete its file(s) across dirs
      for (const d of [hostDir, otherDir]) { const f = path.join(d, `${victim}.jsonl`); if (fs.existsSync(f)) fs.rmSync(f); }
      const rest = new Set(p1.sessions.map((s) => s.sessionId));
      let cur = cursor; let guard = 0;
      for (;;) { const r = (await get(`?limit=4&cursor=${encodeURIComponent(cur)}`)).json; for (const s of r.sessions) rest.add(s.sessionId); cur = r.page.cursor; if (!r.page.hasMore || !cur || ++guard > 50) break; }
      // every surviving session (full set minus victim) is reachable via page1 ∪ walk.
      const survivors = fullIds.filter((id) => id !== victim);
      const missed = survivors.filter((id) => !rest.has(id));
      if (missed.length === 0) ok('finding 3 e2e — deleting a page-1 row strands no survivor in the walk', `deleted ${victim.slice(0, 8)}`);
      else bad('finding 3 e2e — no survivor stranded', `missed ${missed.map((x) => x.slice(0, 8)).join(',')}`);
    }

    /* finding 2 end-to-end — bump a below-cursor session; a page-1 refresh surfaces it. */
    {
      const p1 = (await get('?limit=4')).json;
      const p1ids = new Set(p1.sessions.map((s) => s.sessionId));
      // find a session NOT on page 1 (below the cursor) whose host-dir file still
      // exists (finding 3 above deleted one), so the bump targets a live file.
      const freshFull = (await get('')).json;
      const below = freshFull.sessions
        .map((s) => s.sessionId)
        .find((id) => !p1ids.has(id) && fs.existsSync(path.join(hostDir, `${id}.jsonl`)));
      const f = path.join(hostDir, `${below}.jsonl`);
      const future = base + 500 * DAY; // beyond every fixture mtime → the newest of all
      fs.utimesSync(f, new Date(future), new Date(future));
      const refreshed = (await get('?limit=4')).json; // the sidebar's page-1 re-fetch
      if (refreshed.sessions.some((s) => s.sessionId === below)) ok('finding 2 e2e — an updated below-cursor session reappears on the page-1 refresh', `${below.slice(0, 8)}`);
      else bad('finding 2 e2e — updated session surfaces on refresh', `${below?.slice(0, 8)} not on refreshed page 1`);
    }
  } finally {
    try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  }
}

async function main() {
  console.log('\n========== FEAT-199 keyset cursor — findings 1/2/3 + edges ==========');
  modelPart();
  await serverPart();
  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`} — FEAT-199 keyset\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
