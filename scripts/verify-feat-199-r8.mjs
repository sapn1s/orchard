#!/usr/bin/env node
/**
 * verify:feat-199 (r8) — an EXTERNAL append that fires NO Orchard live tick (a
 * CLI outside Orchard appending to a session file) bumps an OFF-PAGE session
 * ABOVE the already-consumed keyset cursor. The r7 cursor walk returns only rows
 * STRICTLY AFTER the cursor, so the bumped row — which jumped from below the
 * cursor to above it — is in neither a later page nor page 1 (no live tick fires
 * to refresh page 1). After exhausting "More" the union was 149 of 150 (openai
 * run 01a17fdd, BROKEN).
 *
 * The r8 fix: every load-more carries the client's high-water mark (the newest
 * row it saw on the first page, `headCursor`); the server returns, alongside the
 * page, any rows NEWER than that mark; the client merges them at the top deduped
 * by sessionId; and on hasMore=false the client does one final newer-than-mark
 * merge. Page-1 refresh is unchanged.
 *
 * PART A — pure model: the r7 walk (rows-after-cursor only) STRANDS the bumped
 *   off-page row (union 9 of 10); the r8 walk (+ newer-than-mark + final merge)
 *   recovers it (union 10 of 10). MUST-FAIL is the r7 column.
 *
 * PART B — REAL headless browser over a busy 150-session store (>2 pages):
 *   (B1) MUST-FAIL — with the server's `newer`/`headCursor` STRIPPED from every
 *        paginated response (the r7 contract), an external append to an off-page
 *        session + exhausting "More" yields union 149/150, the bumped row absent.
 *   (B2) FIX — the SAME flow with the real (unstripped) responses: union 150/150,
 *        the bumped row present and not doubled.
 *
 * PART C — REAL browser, the round-8 proof matrix over fresh busy stores:
 *   (C1) several external updates mid-scroll → all present, union full.
 *   (C2) an update to a session ALREADY SHOWN (in page 1) → present once, no dup.
 *   (C3) a DELETE plus an UPDATE together → union == full (one fewer), the updated
 *        row present, the deleted row gone, no dup.
 *
 * Defensive (round-8 brief): PART A also runs the equal-mtime / id-tiebreak at the
 * mark boundary so the "newer than mark" filter and the cursor filter agree on the
 * SAME boundary row (the comparator that r2→r7 kept fighting).
 *
 * No port 4317, no live host, no writes outside the scratch dirs. Browser parts
 * SKIP (not FAIL) when no brave/playwright is present.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { isolatedServerEnv } from './lib/station-boot.mjs';
import * as hist from '../src/lib/session-history.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const SHOT_DIR = path.join(ROOT, 'tmp', 'feat-199-r8-shots');
let failures = 0;
const ok = (n, x = '') => console.log(`  ok  ${n}${x ? `  — ${x}` : ''}`);
const bad = (n, e) => { failures++; console.log(`FAIL  ${n}\n      ${e}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const line = (obj) => JSON.stringify(obj);

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

/* ------------------------------------------------- PART A: pure keyset model */
function partA() {
  console.log('\n----- PART A: keyset-walk model — r7 strands a bumped off-page row, r8 recovers it -----');
  const cmpId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  // 10 sessions, mtime desc: s00 newest (1000) .. s09 oldest (910). limit 3.
  const N = 10, LIMIT = 3;
  const base = () => Array.from({ length: N }, (_, i) => ({ sessionId: `s${String(i).padStart(2, '0')}`, m: 1000 - i * 10 }));
  const order = (p) => p.slice().sort((a, b) => b.m - a.m || cmpId(a.sessionId, b.sessionId));
  const afterCursor = (p, c) => order(p).filter((x) => c === null || x.m < c.m || (x.m === c.m && cmpId(x.sessionId, c.s) > 0));
  const newerThanMark = (p, mk) => order(p).filter((x) => x.m > mk.m || (x.m === mk.m && cmpId(x.sessionId, mk.s) < 0));

  // bumpTo: the recency s07 is moved to by an external append.
  //   2000 → above the head mark (common append at real-now, normal head).
  //    985 → ABOVE the consumed cursor (980=s02) but BELOW the head mark (1000):
  //          the future/clock-skewed-head case the independent verify found
  //          (run b75a6a71, D1/D1b). `newer` cannot see it; the full reconcile can.
  function walk(mode, bumpTo) {
    const pool0 = base();
    const page1 = afterCursor(pool0, null).slice(0, LIMIT);        // s00,s01,s02
    const client = new Map(page1.map((x) => [x.sessionId, x]));
    const head = order(pool0)[0];                                   // high-water mark = newest seen
    let cursor = { m: page1.at(-1).m, s: page1.at(-1).sessionId };  // s02
    // EXTERNAL append (no tick): off-page s07 bumped.
    const pool = pool0.map((x) => (x.sessionId === 's07' ? { ...x, m: bumpTo } : x));
    const total = pool.length; // server-declared distinct-id total
    for (let guard = 0; guard < 50; guard++) {
      const rest = afterCursor(pool, cursor);
      const page = rest.slice(0, LIMIT);
      for (const r of page) client.set(r.sessionId, r);
      if (mode !== 'r7') for (const r of newerThanMark(pool, head)) client.set(r.sessionId, r);
      const hasMore = rest.length > page.length;
      if (page.length) cursor = { m: page.at(-1).m, s: page.at(-1).sessionId };
      if (!hasMore) {
        // (r8) count-guarded full reconcile: if the union is short of total, take
        // the authoritative complete set. r8newer (newer only) does NOT reconcile.
        if (mode === 'r8' && client.size < total) for (const r of order(pool)) client.set(r.sessionId, r);
        break;
      }
    }
    return client;
  }

  // Scenario 1 — common append above the head mark.
  const r7 = walk('r7', 2000);
  if (r7.size === N - 1 && !r7.has('s07'))
    ok('A MUST-FAIL reproduced — r7 walk strands the bumped off-page row (s07)', `union ${r7.size}/${N}`);
  else bad('A r7 walk should strand s07', `size=${r7.size} hasS07=${r7.has('s07')}`);
  const r8 = walk('r8', 2000);
  if (r8.size === N && r8.has('s07')) ok('A r8 recovers an above-mark bump via newer-than-mark', `union ${r8.size}/${N}`);
  else bad('A r8 must recover s07 (above-mark)', `size=${r8.size} hasS07=${r8.has('s07')}`);
  if (new Set([...r8.keys()]).size === r8.size) ok('A r8 union has no duplicate ids', `${r8.size} distinct`);
  else bad('A r8 union deduped', `${r8.size}`);

  // Scenario 2 — the IV's case: bump ABOVE the cursor but BELOW the head mark.
  const r8newerOnly = walk('r8newer', 985);
  if (r8newerOnly.size === N - 1 && !r8newerOnly.has('s07'))
    ok('A MUST-FAIL reproduced — newer-than-mark ALONE strands an above-cursor/below-mark bump (IV D1/D1b)', `union ${r8newerOnly.size}/${N}`);
  else bad('A newer-only should strand the below-mark bump', `size=${r8newerOnly.size} hasS07=${r8newerOnly.has('s07')}`);
  const r8full = walk('r8', 985);
  if (r8full.size === N && r8full.has('s07'))
    ok('A r8 count-guarded full reconcile recovers the below-mark bump', `union ${r8full.size}/${N}`);
  else bad('A r8 reconcile must recover the below-mark bump', `size=${r8full.size} hasS07=${r8full.has('s07')}`);

  // Defensive: the newer-than-mark filter and the cursor filter use the SAME
  // code-unit id comparator, so an equal-mtime boundary row is on exactly ONE
  // side of each — never double-counted, never dropped.
  const mk = { m: 1000, s: 's05' };       // equal mtime as a boundary
  const twins = [
    { sessionId: 's03', m: 1000 }, { sessionId: 's05', m: 1000 }, { sessionId: 's07', m: 1000 },
  ];
  const newer = newerThanMark(twins, mk).map((x) => x.sessionId);   // ids < s05 at equal mtime: s03
  const notNewer = twins.filter((x) => !(x.m > mk.m || (x.m === mk.m && cmpId(x.sessionId, mk.s) < 0))).map((x) => x.sessionId);
  if (JSON.stringify(newer) === JSON.stringify(['s03']) && notNewer.includes('s05') && notNewer.includes('s07'))
    ok('A defensive — equal-mtime id tiebreak partitions the boundary cleanly', `newer=${newer} rest=${notNewer}`);
  else bad('A equal-mtime boundary partition', `newer=${newer} rest=${notNewer}`);
}

/* --------------------------------------------------- store + append helpers */
function writeSessionAs(dir, stem, inFileId, { cwd, ts, title, msgs = 4 }) {
  fs.mkdirSync(dir, { recursive: true });
  const rows = [line({ type: 'user', sessionId: inFileId, cwd, timestamp: ts, version: '1.0.0', gitBranch: 'main', entrypoint: 'cli', message: { role: 'user', content: title } })];
  for (let i = 0; i < msgs; i++) rows.push(line({ type: i % 2 ? 'assistant' : 'user', sessionId: inFileId, cwd, timestamp: ts, message: { role: i % 2 ? 'assistant' : 'user', model: 'claude', content: `body-${i}` } }));
  const fp = path.join(dir, `${stem}.jsonl`);
  fs.writeFileSync(fp, rows.join('\n') + '\n');
  return fp;
}
/* An EXTERNAL process appends a new user message and the file mtime moves to
 * `at`. No Orchard event is emitted (the test fires no live tick). */
function externalAppend(fp, inFileId, cwd, at) {
  const iso = new Date(at).toISOString();
  fs.appendFileSync(fp, line({ type: 'user', sessionId: inFileId, cwd, timestamp: iso, message: { role: 'user', content: `external-append ${iso}` } }) + '\n');
  fs.utimesSync(fp, new Date(at), new Date(at));
}

/* Build a project with `n` sessions, mtime desc (index 0 newest). When
 * `futureHeadDays` is set, index 0 (page-1 newest) gets a far-FUTURE mtime — the
 * clock-skewed / future-dated head the IV found (run b75a6a71): a normal append
 * at a real "current" time then sorts BELOW the head mark. */
function buildProject(STORE, pr, base, DAY) {
  const dir = path.join(STORE, hist.encodeCwd(pr.hostPath));
  const files = [];
  for (let i = 0; i < pr.n; i++) {
    const id = uuid(pr.offset + i);
    let at = base + (pr.n - i) * DAY;
    if (i === 0 && pr.futureHeadDays) at = base + pr.futureHeadDays * DAY; // skewed head
    const fp = writeSessionAs(dir, id, id, { cwd: pr.hostPath, ts: new Date(at).toISOString(), title: `${pr.id}-${String(i).padStart(3, '0')}`, msgs: 4 });
    fs.utimesSync(fp, new Date(at), new Date(at));
    files.push({ id, fp, idx: i });
  }
  return { dir, files };
}

/* ------------------------------------------------------ browser scaffolding */
async function withBrowser(fn) {
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { console.log('  E SKIP — playwright not installed'); return false; }
  const exe = process.env.QA_BRAVE_PATH ?? '/usr/bin/brave';
  if (!fs.existsSync(exe)) { console.log(`  E SKIP — no browser at ${exe}`); return false; }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat199-r8-'));
  const STORE = path.join(tmp, 'projects');
  const DATA = path.join(tmp, 'data');
  fs.mkdirSync(path.join(DATA, 'session-hosts'), { recursive: true });
  const base = Date.UTC(2026, 0, 1); const DAY = 86400000;

  // Four independent projects, each >2 pages (150) so the full set is never on
  // page 1 and the off-page bump is genuinely off-page.
  const projs = [
    { id: 'repro', hostPath: '/tmp/r8/repro', n: 150, offset: 1000 },  // B1 full r7 contract (strip newer + block reconcile)
    { id: 'fix', hostPath: '/tmp/r8/fix', n: 150, offset: 2000 },      // B2 single off-page bump (newer catches it)
    { id: 'multi', hostPath: '/tmp/r8/multi', n: 150, offset: 3000 },  // C1 several bumps
    { id: 'shown', hostPath: '/tmp/r8/shown', n: 150, offset: 4000 },  // C2 bump an in-page-1 row
    { id: 'del', hostPath: '/tmp/r8/del', n: 150, offset: 5000 },      // C3 delete + update
    { id: 'skewFail', hostPath: '/tmp/r8/skewFail', n: 150, offset: 6000, futureHeadDays: 400 }, // D1 must-FAIL (reconcile blocked)
    { id: 'skew', hostPath: '/tmp/r8/skew', n: 150, offset: 7000, futureHeadDays: 400 },         // D1 fix (reconcile recovers)
  ];
  const built = {};
  for (const pr of projs) built[pr.id] = buildProject(STORE, pr, base, DAY);
  fs.writeFileSync(path.join(DATA, 'registry.json'), JSON.stringify({
    version: 1,
    projects: projs.map((pr) => ({ id: pr.id, name: pr.id, hostPath: pr.hostPath, isolation: 'direct', settings: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })),
  }, null, 2));

  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = isolatedServerEnv({
    PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE,
    CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0',
  }, { requireStore: true });
  const server = spawn(process.execPath, [ENTRY], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  server.stderr?.on('data', (d) => { if (process.env.VERBOSE) process.stderr.write(`  [server] ${d}`); });
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    let up = false;
    for (let i = 0; i < 150 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(200); } }
    if (!up) throw new Error('server never healthy');
    await fn({ browser, BASE, built, base, DAY });
  } finally {
    await browser.close();
    try { process.kill(-server.pid, 'SIGKILL'); } catch { /* ignore */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return true;
}

/* Load page 1, then run an on-disk mutation, then exhaust "More"; return union. */
async function driveProject(page, pid, mutate) {
  await page.evaluate((id) => window.__station.loadSessions(id), pid);
  const afterPage1 = await page.evaluate((id) => {
    const s = window.__station.state.sessions.get(id);
    return { len: s?.list?.length ?? 0, hasMore: s?.serverHasMore === true, head: s?.serverHead ?? null };
  }, pid);
  await mutate(); // external, no tick
  const union = await page.evaluate(async (id) => {
    const st = window.__station;
    for (let guard = 0; guard < 50; guard++) {
      const s = st.state.sessions.get(id);
      if (!s || s.serverHasMore !== true) break;
      await st.loadMoreSessions(id);
    }
    const s = st.state.sessions.get(id);
    const ids = (s.list || []).map((x) => x.sessionId);
    return { ids, len: ids.length, distinct: new Set(ids).size, total: s.serverTotal, hasMore: s.serverHasMore };
  }, pid);
  return { afterPage1, union };
}

/* ---------------------------------------------- PART B + C: real browser run */
async function partBC() {
  console.log('\n----- PART B + C: real headless browser, external append with NO live tick -----');
  const ran = await withBrowser(async ({ browser, BASE, built, base, DAY }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (process.env.VERBOSE) console.log(`  [page] ${m.text()}`); });

    // Guarantee "no live tick": the live route is always empty for this run, so
    // refreshLive never forces a page-1 reload that would mask the stranding.
    await ctx.route('**/api/sessions/live', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessions: [] }) }));

    // B1 — reproduce the FULL r7 contract for the repro project: strip `newer` +
    // `page.headCursor` from paginated responses (no high-water mark at all) AND
    // block the count-guarded full reconcile (the no-query full-list fetch). With
    // neither mechanism, the stranded off-page bump stays lost (149/150).
    await ctx.route('**/api/projects/repro/sessions**', async (route) => {
      const u = new URL(route.request().url());
      if (!u.searchParams.has('limit') && !u.searchParams.has('session')) return route.abort('failed'); // block reconcile
      if (!u.searchParams.has('limit')) return route.continue();
      const resp = await route.fetch();
      const j = await resp.json();
      delete j.newer;
      if (j.page) delete j.page.headCursor;
      return route.fulfill({ response: resp, contentType: 'application/json', body: JSON.stringify(j) });
    });
    // D1 must-FAIL — the skew head case with the reconcile BLOCKED: `newer` alone
    // cannot see a bump above the cursor but below the (future) head mark, so the
    // union stays 149/150. (The `skew` project leaves the reconcile intact.)
    await ctx.route('**/api/projects/skewFail/sessions**', (route) => {
      const u = new URL(route.request().url());
      if (!u.searchParams.has('limit') && !u.searchParams.has('session')) return route.abort('failed'); // block reconcile only
      return route.continue();
    });

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__station, { timeout: 20000 });
    await page.waitForSelector('.proj', { timeout: 20000 });

    const bumpTime = base + 200 * DAY; // strictly newer than every seeded mtime

    // ---- B1 MUST-FAIL (newer stripped): bump an off-page row, union 149/150 ----
    {
      const pr = built.repro;
      const victim = pr.files.find((f) => f.idx === 140); // deep off-page
      const { afterPage1, union } = await driveProject(page, 'repro', async () => {
        externalAppend(victim.fp, victim.id, '/tmp/r8/repro', bumpTime);
      });
      if (afterPage1.head === null) ok('B1 the stripped responses carry NO head mark (r7 contract)', `page1 len=${afterPage1.len}`);
      else bad('B1 headCursor should be stripped', JSON.stringify(afterPage1));
      if (union.len === 149 && union.total === 150 && !union.ids.includes(victim.id))
        ok('B1 MUST-FAIL reproduced — union 149/150, the bumped off-page row is STRANDED', `len=${union.len} total=${union.total} victim=${victim.id.slice(0, 8)} absent`);
      else bad('B1 r7 should strand the bumped row (149/150)', `len=${union.len} total=${union.total} hasVictim=${union.ids.includes(victim.id)}`);
    }

    // ---- B2 FIX (real responses): same flow, union 150/150, present once ----
    {
      const pr = built.fix;
      const victim = pr.files.find((f) => f.idx === 138);
      const { afterPage1, union } = await driveProject(page, 'fix', async () => {
        externalAppend(victim.fp, victim.id, '/tmp/r8/fix', bumpTime);
      });
      if (afterPage1.head) ok('B2 the first page carries a head high-water mark', `head present`);
      else bad('B2 first page must carry headCursor', JSON.stringify(afterPage1));
      if (union.len === 150 && union.distinct === 150 && union.ids.includes(victim.id) && union.total === 150)
        ok('B2 FIX — union 150/150, the externally-bumped off-page row is recovered (no dup)', `len=${union.len} distinct=${union.distinct} victim present`);
      else bad('B2 fix must recover the bumped row to 150/150', `len=${union.len} distinct=${union.distinct} hasVictim=${union.ids.includes(victim.id)} total=${union.total}`);
      // It should be the NEWEST row now (bumped above everything).
      const top = union.ids[0];
      if (top === victim.id) ok('B2 the bumped row sorts to the top (newest recency)', `top=${top.slice(0, 8)}`);
      else bad('B2 bumped row should be newest', `top=${top}`);
    }

    // ---- C1 several external updates mid-scroll ----
    {
      const pr = built.multi;
      const victims = [pr.files.find((f) => f.idx === 120), pr.files.find((f) => f.idx === 135), pr.files.find((f) => f.idx === 148)];
      const { union } = await driveProject(page, 'multi', async () => {
        victims.forEach((v, k) => externalAppend(v.fp, v.id, '/tmp/r8/multi', bumpTime + k * 1000));
      });
      const allPresent = victims.every((v) => union.ids.includes(v.id));
      if (union.len === 150 && union.distinct === 150 && allPresent)
        ok('C1 several external updates mid-scroll — all present, union full, no dup', `len=${union.len} distinct=${union.distinct}`);
      else bad('C1 several updates must all be present', `len=${union.len} distinct=${union.distinct} allPresent=${allPresent}`);
    }

    // ---- C2 an update to a session ALREADY SHOWN (page-1 row) — no dup ----
    {
      const pr = built.shown;
      const victim = pr.files.find((f) => f.idx === 4); // on page 1 already
      const { union } = await driveProject(page, 'shown', async () => {
        externalAppend(victim.fp, victim.id, '/tmp/r8/shown', bumpTime);
      });
      const count = union.ids.filter((x) => x === victim.id).length;
      if (union.len === 150 && union.distinct === 150 && count === 1)
        ok('C2 update to an already-shown row — present exactly once (no duplicate)', `len=${union.len} occurrences=${count}`);
      else bad('C2 already-shown update must not duplicate', `len=${union.len} distinct=${union.distinct} occurrences=${count}`);
    }

    // ---- C3 a DELETE plus an UPDATE together ----
    {
      const pr = built.del;
      const gone = pr.files.find((f) => f.idx === 130);
      const updated = pr.files.find((f) => f.idx === 145);
      const { union } = await driveProject(page, 'del', async () => {
        fs.rmSync(gone.fp, { force: true });
        externalAppend(updated.fp, updated.id, '/tmp/r8/del', bumpTime);
      });
      const okShape = union.len === 149 && union.distinct === 149 && union.total === 149
        && union.ids.includes(updated.id) && !union.ids.includes(gone.id);
      if (okShape)
        ok('C3 delete + update together — union == full (149), updated present, deleted gone, no dup', `len=${union.len} total=${union.total}`);
      else bad('C3 delete+update union must be 149 with the right members', `len=${union.len} distinct=${union.distinct} total=${union.total} hasUpdated=${union.ids.includes(updated.id)} hasGone=${union.ids.includes(gone.id)}`);
    }

    // ---- D1 the IV's skew case: page-1 head is FUTURE-dated, append at a real
    // "current" time sorts ABOVE the cursor but BELOW the head mark, so `newer`
    // cannot see it (run b75a6a71). MUST-FAIL with the reconcile blocked, FIXED
    // with it intact. The bump time is below the future head (base+400d). ----
    {
      // must-FAIL — reconcile blocked for skewFail
      const pr = built.skewFail;
      const victim = pr.files.find((f) => f.idx === 140);
      const { union } = await driveProject(page, 'skewFail', async () => {
        externalAppend(victim.fp, victim.id, '/tmp/r8/skewFail', bumpTime); // base+200d < head base+400d
      });
      if (union.len === 149 && union.total === 150 && !union.ids.includes(victim.id))
        ok('D1 MUST-FAIL reproduced — future head + reconcile blocked: below-mark bump stranded (149/150)', `len=${union.len} total=${union.total}`);
      else bad('D1 skew must strand the below-mark bump when reconcile is blocked', `len=${union.len} total=${union.total} hasVictim=${union.ids.includes(victim.id)}`);
    }
    {
      // fix — reconcile intact for skew
      const pr = built.skew;
      const victim = pr.files.find((f) => f.idx === 140);
      const { union } = await driveProject(page, 'skew', async () => {
        externalAppend(victim.fp, victim.id, '/tmp/r8/skew', bumpTime);
      });
      if (union.len === 150 && union.distinct === 150 && union.ids.includes(victim.id) && union.total === 150)
        ok('D1 FIX — future head: the count-guarded full reconcile recovers the below-mark bump (150/150)', `len=${union.len} distinct=${union.distinct}`);
      else bad('D1 reconcile must recover the below-mark bump', `len=${union.len} distinct=${union.distinct} hasVictim=${union.ids.includes(victim.id)} total=${union.total}`);
    }

    await fs.promises.mkdir(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SHOT_DIR, 'r8-final.png') });
    console.log(`  screenshot: ${SHOT_DIR}/r8-final.png`);
    await ctx.close();
  });
  if (!ran) console.log('  (PART B + C skipped — no browser)');
}

async function main() {
  partA();
  await partBC();
  console.log(failures === 0 ? '\nPASS verify-feat-199-r8' : `\nFAIL verify-feat-199-r8 (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
