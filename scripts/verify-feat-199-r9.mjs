#!/usr/bin/env node
/**
 * verify:feat-199 (r9) — the end-of-walk reconcile is UNCONDITIONAL and BY ID,
 * and a failed reconcile is retried (never a silent latch). Fixes the two gaps
 * independent run 6567f228 found in the r8 count-guarded reconcile:
 *
 *   BREAK 1 — equal-count / different-members. The r8 guard reconciles ONLY when
 *     the exhausted union is SHORT of the server's total. A DELETE of an
 *     already-shown row (the client keeps a GHOST) PLUS a stranded off-page bump
 *     (a below-head / above-cursor append `newer` cannot see — future-dated
 *     head) keep the union COUNT equal to the new total while the MEMBERS
 *     differ, so the guard never fires: the bumped row stays lost, the ghost
 *     stays. r9 reconciles unconditionally against the authoritative full list
 *     (adds the stranded row, drops the ghost) → union == full BY ID.
 *
 *   BREAK 2 — a failed reconcile was swallowed and never retried, silently
 *     latching a possibly-incomplete list. r9 flags `listIncomplete` (a visible
 *     "list may be incomplete — retry" hint), schedules a backoff retry, and the
 *     retry (or the hint button) recovers to the full set.
 *
 * PART A — pure model: the r8 count-guarded walk STRANDS the break-1 row while
 *   its union count equals the total (MUST-FAIL); r9's unconditional reconcile
 *   recovers it. The r8 silent latch never retries a failed reconcile
 *   (MUST-FAIL); r9's flag + backoff retry recovers.
 *
 * PART B — REAL headless browser over busy 150-session stores (>2 pages), an
 *   external append with NO live tick:
 *   (E1) future-dated head + DELETE an already-shown row + BUMP an off-page row
 *        below the head mark → union == full BY ID (added present, deleted gone,
 *        no dup) even though the count stayed equal (the r8 guard-miss shape).
 *   (E2) the authoritative full-list reconcile FAILS during the walk → the list
 *        is flagged incomplete (not silently latched) and the union is short;
 *        restore the server + retry → union == full and the flag clears.
 *
 * No port 4317, no live host, no writes outside scratch dirs. Browser parts SKIP
 * (not FAIL) when no brave/playwright is present.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { isolatedServerEnv } from './lib/station-boot.mjs';
import * as hist from '../src/lib/session-history.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const SHOT_DIR = path.join(ROOT, 'tmp', 'feat-199-r9-shots');
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

/* --------------------------------------------- PART A: pure reconcile model */
function partA() {
  console.log('\n----- PART A: pure model — r8 count guard misses equal-count/diff-members + never retries; r9 fixes both -----');
  const cmpId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const N = 10, LIMIT = 3;
  const base = () => Array.from({ length: N }, (_, i) => ({ sessionId: `s${String(i).padStart(2, '0')}`, m: 1000 - i * 10 }));
  const order = (p) => p.slice().sort((a, b) => b.m - a.m || cmpId(a.sessionId, b.sessionId));
  const afterCursor = (p, c) => order(p).filter((x) => c === null || x.m < c.m || (x.m === c.m && cmpId(x.sessionId, c.s) > 0));
  const newerThanMark = (p, mk) => order(p).filter((x) => x.m > mk.m || (x.m === mk.m && cmpId(x.sessionId, mk.s) < 0));

  // ---- BREAK 1: delete an already-shown row (ghost) + strand an off-page bump,
  //      so the union COUNT equals the total but the MEMBERS differ. ----
  // mode: 'r8' = reconcile ONLY when client.size < total (the missed guard);
  //       'r9' = reconcile ALWAYS on hasMore=false (by id).
  function walkEqualCount(mode) {
    const pool0 = base();
    const page1 = afterCursor(pool0, null).slice(0, LIMIT);   // s00,s01,s02 — now in hand
    const client = new Map(page1.map((x) => [x.sessionId, x]));
    const head = order(pool0)[0];                             // high-water mark m=1000 (future-ish head stands in)
    let cursor = { m: page1.at(-1).m, s: page1.at(-1).sessionId }; // s02 @ 980
    // EXTERNAL, no tick: DELETE s01 (already shown → stays as a ghost in client)
    // and BUMP off-page s07 to 985 (above the cursor 980, BELOW the head 1000 →
    // `newer` cannot see it).
    let pool = pool0.filter((x) => x.sessionId !== 's01').map((x) => (x.sessionId === 's07' ? { ...x, m: 985 } : x));
    const total = pool.length; // server-declared distinct total (= 9)
    for (let guard = 0; guard < 50; guard++) {
      const rest = afterCursor(pool, cursor);
      const page = rest.slice(0, LIMIT);
      for (const r of page) client.set(r.sessionId, r);
      for (const r of newerThanMark(pool, head)) client.set(r.sessionId, r); // below-mark bump invisible here
      const hasMore = rest.length > page.length;
      if (page.length) cursor = { m: page.at(-1).m, s: page.at(-1).sessionId };
      if (!hasMore) {
        if (mode === 'r8') { if (client.size < total) for (const r of order(pool)) client.set(r.sessionId, r); }
        else { client.clear(); for (const r of order(pool)) client.set(r.sessionId, r); } // r9: unconditional, by id
        break;
      }
    }
    return { client, total };
  }

  const g8 = walkEqualCount('r8');
  const full = new Set(['s00', 's02', 's03', 's04', 's05', 's06', 's07', 's08', 's09']);
  const sameSet = (m) => m.size === full.size && [...full].every((id) => m.has(id)) && [...m.keys()].every((id) => full.has(id));
  if (g8.client.size === g8.total && !g8.client.has('s07') && g8.client.has('s01'))
    ok('A BREAK-1 MUST-FAIL reproduced — r8 guard misses (union count == total, but s07 lost + s01 ghost)', `size=${g8.client.size} total=${g8.total}`);
  else bad('A r8 count guard should miss the equal-count/diff-members case', `size=${g8.client.size} total=${g8.total} hasS07=${g8.client.has('s07')} ghostS01=${g8.client.has('s01')}`);
  const g9 = walkEqualCount('r9');
  if (sameSet(g9.client)) ok('A r9 unconditional by-id reconcile — union == full set (s07 added, s01 ghost dropped)', `size=${g9.client.size}`);
  else bad('A r9 reconcile must equal the full set by id', `members=${[...g9.client.keys()].join(',')}`);

  // ---- BREAK 2: a failed reconcile. r8 calls once and silently swallows (no
  //      retry, no flag); r9 flags incomplete + retries with backoff. ----
  function reconcileWithFailures(mode, failFirst) {
    // The authoritative set is the full 9; a failing fetch throws.
    let calls = 0;
    const fetchFull = () => { calls++; if (calls <= failFirst) throw new Error('offline'); return [...full]; };
    const state = { list: new Set(['s00', 's02', 's03', 's04']), incomplete: false }; // a short union after a stranded walk
    const reconcile = () => { const authoritative = fetchFull(); state.list = new Set(authoritative); };
    if (mode === 'r8') {
      // r8: one attempt in a swallow-all try; on failure nothing is flagged or retried.
      try { reconcile(); } catch { /* swallowed — silent latch */ }
    } else {
      // r9: flag on failure + retry (backoff elided; drive the loop deterministically).
      const attempt = () => { try { reconcile(); state.incomplete = false; } catch { state.incomplete = true; } };
      attempt();
      for (let i = 0; i < 10 && state.incomplete; i++) attempt(); // backoff retries
    }
    return { state, calls };
  }
  const r8fail = reconcileWithFailures('r8', 1);
  if (r8fail.state.list.size === 4 && r8fail.state.incomplete === false && r8fail.calls === 1)
    ok('A BREAK-2 MUST-FAIL reproduced — r8 swallows the failed reconcile, no retry, no flag (silent latch)', `list=${r8fail.state.list.size} calls=${r8fail.calls}`);
  else bad('A r8 should silently latch on a failed reconcile', JSON.stringify({ size: r8fail.state.list.size, incomplete: r8fail.state.incomplete, calls: r8fail.calls }));
  const r9fail = reconcileWithFailures('r9', 2);
  if (sameSet(r9fail.state.list) && r9fail.state.incomplete === false && r9fail.calls === 3)
    ok('A r9 flags incomplete then the backoff retry recovers the full set', `calls=${r9fail.calls} list=${r9fail.state.list.size}`);
  else bad('A r9 retry must recover after transient failures', JSON.stringify({ size: r9fail.state.list.size, incomplete: r9fail.state.incomplete, calls: r9fail.calls }));
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
function externalAppend(fp, inFileId, cwd, at) {
  const iso = new Date(at).toISOString();
  fs.appendFileSync(fp, line({ type: 'user', sessionId: inFileId, cwd, timestamp: iso, message: { role: 'user', content: `external-append ${iso}` } }) + '\n');
  fs.utimesSync(fp, new Date(at), new Date(at));
}
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat199-r9-'));
  const STORE = path.join(tmp, 'projects');
  const DATA = path.join(tmp, 'data');
  fs.mkdirSync(path.join(DATA, 'session-hosts'), { recursive: true });
  const base = Date.UTC(2026, 0, 1); const DAY = 86400000;

  const projs = [
    { id: 'eqcount', hostPath: '/tmp/r9/eqcount', n: 150, offset: 1000, futureHeadDays: 400 }, // E1 delete+bump, equal count
    { id: 'failretry', hostPath: '/tmp/r9/failretry', n: 150, offset: 2000, futureHeadDays: 400 }, // E2 reconcile fails then retries
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

/* Load page 1, run a mutation, then exhaust "More"; report page-1 + final union. */
async function driveProject(page, pid, mutate) {
  await page.evaluate((id) => window.__station.loadSessions(id), pid);
  const afterPage1 = await page.evaluate((id) => {
    const s = window.__station.state.sessions.get(id);
    return { len: s?.list?.length ?? 0, hasMore: s?.serverHasMore === true, head: s?.serverHead ?? null };
  }, pid);
  await mutate();
  const union = await page.evaluate(async (id) => {
    const st = window.__station;
    for (let guard = 0; guard < 50; guard++) {
      const s = st.state.sessions.get(id);
      if (!s || s.serverHasMore !== true) break;
      await st.loadMoreSessions(id);
    }
    const s = st.state.sessions.get(id);
    const ids = (s.list || []).map((x) => x.sessionId);
    return { ids, len: ids.length, distinct: new Set(ids).size, total: s.serverTotal, hasMore: s.serverHasMore, incomplete: s.listIncomplete === true };
  }, pid);
  return { afterPage1, union };
}

/* ---------------------------------------------- PART B: real browser scenarios */
async function partB() {
  console.log('\n----- PART B: real headless browser — equal-count/diff-members + failed-reconcile retry -----');
  const ran = await withBrowser(async ({ browser, BASE, built, base, DAY }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (process.env.VERBOSE) console.log(`  [page] ${m.text()}`); });
    // No live tick for any project.
    await ctx.route('**/api/sessions/live', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessions: [] }) }));

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__station, { timeout: 20000 });
    await page.waitForSelector('.proj', { timeout: 20000 });

    const bumpTime = base + 200 * DAY; // above the page-1 cursor, below the future head (base+400d)

    // ---- E1 equal-count / different-members (the r8 guard-miss shape) ----
    {
      const pr = built.eqcount;
      const gone = pr.files.find((f) => f.idx === 4);    // on page 1 → becomes a ghost after delete
      const victim = pr.files.find((f) => f.idx === 140); // off-page → bumped below the future head
      const { afterPage1, union } = await driveProject(page, 'eqcount', async () => {
        fs.rmSync(gone.fp, { force: true });
        externalAppend(victim.fp, victim.id, '/tmp/r9/eqcount', bumpTime);
      });
      // The guard-miss shape: total dropped to 149 and a naive count-guarded union
      // would also have been 149 (ghost retained, bump lost) → guard never fires.
      const okShape = union.len === 149 && union.distinct === 149 && union.total === 149
        && union.ids.includes(victim.id) && !union.ids.includes(gone.id) && !union.incomplete;
      if (okShape)
        ok('E1 future-head delete+bump (equal-count/diff-members) — union == full BY ID (bump present, ghost gone, no dup)', `len=${union.len} total=${union.total} head=${afterPage1.head ? 'set' : 'null'}`);
      else bad('E1 unconditional reconcile must yield the full set by id', `len=${union.len} distinct=${union.distinct} total=${union.total} hasVictim=${union.ids.includes(victim.id)} hasGone=${union.ids.includes(gone.id)} incomplete=${union.incomplete}`);
    }

    // ---- E2 the authoritative full-list reconcile FAILS, then a retry recovers ----
    {
      const pr = built.failretry;
      const victim = pr.files.find((f) => f.idx === 140); // off-page, below-head bump — only the reconcile can recover it
      // Fail ONLY the no-query full-list reconcile fetch (leave paging intact).
      const reconcileGlob = '**/api/projects/failretry/sessions**';
      await ctx.route(reconcileGlob, (route) => {
        const u = new URL(route.request().url());
        if (!u.searchParams.has('limit') && !u.searchParams.has('session')) return route.abort('failed');
        return route.continue();
      });
      const { union } = await driveProject(page, 'failretry', async () => {
        externalAppend(victim.fp, victim.id, '/tmp/r9/failretry', bumpTime);
      });
      if (union.len === 149 && union.incomplete === true && !union.ids.includes(victim.id))
        ok('E2 MUST-NOT-LATCH — a failed reconcile flags the list incomplete (hint shown), union short, NOT silent', `len=${union.len} incomplete=true`);
      else bad('E2 a failed reconcile must flag incomplete, not silently latch', `len=${union.len} incomplete=${union.incomplete} hasVictim=${union.ids.includes(victim.id)}`);
      // The visible hint renders in the DOM (the project group must be expanded
      // for its session list — and therefore the hint — to paint).
      await page.evaluate((id) => { window.__station.state.expanded.add(id); window.__station.renderTree(); }, 'failretry');
      const hintShown = await page.evaluate(() => !!document.querySelector('.hint-row.list-incomplete'));
      if (hintShown) ok('E2 the "list may be incomplete — retry" hint is rendered'); else bad('E2 incomplete hint must render', 'no .list-incomplete');
      // Restore the server + retry → recover to the full set.
      await ctx.unroute(reconcileGlob);
      const after = await page.evaluate(async (id) => {
        const st = window.__station;
        await st.retryListReconcile(id);
        const s = st.state.sessions.get(id);
        const ids = (s.list || []).map((x) => x.sessionId);
        return { ids, len: ids.length, distinct: new Set(ids).size, total: s.serverTotal, incomplete: s.listIncomplete === true };
      }, 'failretry');
      if (after.len === 150 && after.distinct === 150 && after.ids.includes(victim.id) && after.incomplete === false)
        ok('E2 retry after restore — union == full (150/150), the flag clears', `len=${after.len} incomplete=false`);
      else bad('E2 retry must recover the full set and clear the flag', JSON.stringify(after));
    }

    await fs.promises.mkdir(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SHOT_DIR, 'r9-final.png') });
    console.log(`  screenshot: ${SHOT_DIR}/r9-final.png`);
    await ctx.close();
  });
  if (!ran) console.log('  (PART B skipped — no browser)');
}

async function main() {
  partA();
  await partB();
  console.log(failures === 0 ? '\nPASS verify-feat-199-r9' : `\nFAIL verify-feat-199-r9 (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
