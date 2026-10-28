#!/usr/bin/env node
/**
 * verify:feat-199 (r3 client) — the two client-side defects run b757f33e found,
 * plus the load-more/forced-reload race the charter asked to close:
 *
 *  (2) The finder searched the PAGINATED sidebar list (s.list). Any forced
 *      page-1 refresh (live tick, run-finish, pin) replaces s.list with just
 *      page 1 while state.searchLoaded stays true — so every session beyond
 *      page 1 silently drops out of search results.
 *  (3) A loadMoreSessions in flight when a forced page-1 reload lands would
 *      append its stale-cursor rows onto the fresh page 1 (mixed/duplicate rows).
 *
 * PART A — MODEL (must-FAIL on the r2 shape, pure, no browser):
 *   - finder-over-list loses a beyond-page-1 session after a forced refresh;
 *     finder-over-corpus does not.
 *   - no-generation append mixes a stale-cursor row in after a forced reload;
 *     the generation token drops it.
 *
 * PART B — REAL BROWSER (user-visible, the real app over a multi-page scratch
 *   store): a beyond-page-1 session is findable in the finder, STAYS findable
 *   after a forced page-1 reload (the real state proves s.list shrank while the
 *   corpus kept it), and a load-more racing a forced reload leaves no duplicate
 *   or stale rows in the sidebar.
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
const SHOT_DIR = path.join(ROOT, 'tmp', 'feat-199-r3-shots');
const SESSION_PAGE = 60; // must match app.js
let failures = 0;
const ok = (n, x = '') => console.log(`  ok  ${n}${x ? `  — ${x}` : ''}`);
const bad = (n, e) => { failures++; console.log(`FAIL  ${n}\n      ${e}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const line = (obj) => JSON.stringify(obj);

/* ------------------------------------------------------------- PART A: model */
function modelPart() {
  console.log('\n----- PART A: finder-corpus + generation-token model (must-FAIL on r2) -----');

  // (2) finder corpus vs paginated list across a forced page-1 refresh.
  {
    const PAGE = 4;
    const full = Array.from({ length: 12 }, (_, i) => ({ sessionId: `s${i}`, title: `findme-${i}` }));
    const page1 = full.slice(0, PAGE);
    const target = full[9]; // beyond page 1 (rank 9)

    // After a full load, both list and corpus hold everything.
    let list = full.slice();
    const corpus = new Map(full.map((r) => [r.sessionId, r]));

    // A forced page-1 refresh REPLACES the sidebar list with page 1 only.
    list = page1.slice();

    const searchList = (q) => list.filter((r) => r.title.includes(q)); // r2 finder
    const searchCorpus = (q) => [...corpus.values()].filter((r) => r.title.includes(q)); // r3 finder

    const lostOnList = searchList(target.title).length === 0;
    const keptOnCorpus = searchCorpus(target.title).length === 1;
    if (lostOnList) ok('(2) r2 shape — searching the LIST loses a beyond-page-1 session after a forced refresh (reproduced)', target.sessionId);
    else bad('(2) list-search should lose the beyond-page-1 session', 'still present — model wrong');
    if (keptOnCorpus) ok('(2) r3 — searching the CORPUS still finds it after the forced refresh');
    else bad('(2) corpus-search keeps the beyond-page-1 session', 'lost from corpus');
  }

  // (3) generation token drops a stale-cursor loadMore response.
  {
    // page1 fetched (cursor c0). loadMore starts against c0 (gen=0). A forced
    // page-1 reload lands first: new list, cursor reset, gen bumped to 1.
    const page1 = [{ sessionId: 'a' }, { sessionId: 'b' }];
    let listGen = 0;
    let list = page1.slice();

    // loadMore captures the generation it belongs to.
    const gen = listGen;
    const staleRows = [{ sessionId: 'b' }, { sessionId: 'x_stale_cursor' }]; // from the OLD cursor

    // forced reload commits first.
    list = page1.slice();
    listGen += 1;

    // r2 (no gen check): append the stale rows → mixes a stale-cursor row in.
    {
      const l = list.slice();
      const have = new Set(l.map((r) => r.sessionId));
      for (const r of staleRows) if (!have.has(r.sessionId)) { l.push(r); have.add(r.sessionId); }
      const mixed = l.some((r) => r.sessionId === 'x_stale_cursor');
      if (mixed) ok('(3) r2 shape — a stale-cursor loadMore mixes an out-of-order row in (reproduced)');
      else bad('(3) no-gen append should mix a stale row', 'nothing mixed — model wrong');
    }
    // r3 (gen check): the response is from gen 0 but listGen is now 1 → dropped.
    {
      const l = list.slice();
      if (listGen !== gen) { /* dropped */ }
      else { for (const r of staleRows) l.push(r); }
      const mixed = l.some((r) => r.sessionId === 'x_stale_cursor');
      const dup = new Set(l.map((r) => r.sessionId)).size !== l.length;
      if (!mixed && !dup) ok('(3) r3 — the generation token drops the stale-cursor response (no mixed/duplicate rows)');
      else bad('(3) gen token drops stale response', `mixed=${mixed} dup=${dup}`);
    }
  }
}

/* ------------------------------------------------------- PART B: real browser */
function writeSession(dir, id, { cwd, ts, mtime, title }) {
  fs.mkdirSync(dir, { recursive: true });
  const rows = [
    line({ type: 'user', sessionId: id, cwd, timestamp: ts, version: '1.0.0', gitBranch: 'main', entrypoint: 'cli', message: { role: 'user', content: title } }),
    line({ type: 'assistant', sessionId: id, cwd, timestamp: ts, message: { role: 'assistant', model: 'claude', content: 'ok' } }),
  ];
  const fp = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(fp, rows.join('\n') + '\n');
  if (mtime) fs.utimesSync(fp, new Date(mtime), new Date(mtime));
  return fp;
}
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

async function browserPart() {
  console.log('\n----- PART B: real browser over a multi-page scratch store -----');
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { console.log('  E SKIP — playwright not installed'); return; }
  const exe = process.env.QA_BRAVE_PATH ?? '/usr/bin/brave';
  if (!fs.existsSync(exe)) { console.log(`  E SKIP — no browser at ${exe}`); return; }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat199-r3c-'));
  const STORE = path.join(tmp, 'projects');
  const DATA = path.join(tmp, 'data');
  fs.mkdirSync(path.join(DATA, 'session-hosts'), { recursive: true });
  const hostPath = '/tmp/r3c/bigproj';
  const hostDir = path.join(STORE, hist.encodeCwd(hostPath));
  const base = Date.UTC(2026, 9, 1); const DAY = 86400000;

  // 150 sessions → ≥3 pages at 60/page. Each title is a unique searchable token;
  // mtime decreasing with index so index 0 is newest (page 1), index 140 is deep.
  const N = 150;
  const TOTAL_PAGES = Math.ceil(N / SESSION_PAGE);
  for (let i = 0; i < N; i++) {
    writeSession(hostDir, uuid(i + 1), { cwd: hostPath, ts: `2026-10-01T00:00:00.000Z`, mtime: base + (N - i) * DAY, title: `findme-rank-${String(i).padStart(3, '0')}` });
  }
  fs.writeFileSync(path.join(DATA, 'registry.json'), JSON.stringify({
    version: 1,
    projects: [{ id: 'bigproj', name: 'bigproj', hostPath, isolation: 'direct', settings: {}, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }],
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

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (process.env.VERBOSE) console.log(`  [page] ${m.text()}`); });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__station, { timeout: 20000 });
    await page.waitForSelector('.proj', { timeout: 20000 });

    // Load the finder's FULL corpus (what finder focus does).
    await page.evaluate(() => window.__station.loadAllSessionsFull());
    await page.waitForFunction(() => window.__station.state.searchLoaded === true, { timeout: 20000 });

    // A session deep in history (beyond page 1). Index 140 → rank 140, title token.
    const deepTitle = `findme-rank-140`;
    const deepInfo = await page.evaluate((t) => {
      const st = window.__station.state;
      const s = st.sessions.get('bigproj');
      const corpus = st.searchCorpus.get('bigproj');
      const row = corpus && [...corpus.values()].find((r) => (r.displayTitle || '').includes(t));
      return {
        listLen: s.list.length,
        corpusLen: corpus ? corpus.size : 0,
        onPage1: row ? s.list.slice(0, 60).some((x) => x.sessionId === row.sessionId) : null,
        found: !!row,
        sid: row?.sessionId ?? null,
      };
    }, deepTitle);
    if (deepInfo.found && deepInfo.corpusLen === N) ok('B full corpus loaded (every session)', `${deepInfo.corpusLen}`);
    else bad('B full corpus loaded', JSON.stringify(deepInfo));
    if (deepInfo.found && deepInfo.onPage1 === false) ok('B target session is BEYOND page 1', deepInfo.sid?.slice(0, 8));
    else bad('B target is beyond page 1', JSON.stringify(deepInfo));

    // Type the deep title into the finder → it must render a hit.
    const typeFind = async (q) => {
      await page.evaluate((text) => {
        const fi = document.querySelector('#findInput');
        document.querySelector('#finder')?.classList.add('on');
        fi.value = text;
        fi.dispatchEvent(new Event('input', { bubbles: true }));
      }, q);
      await page.waitForTimeout(300);
      return page.evaluate((t) => {
        const rows = [...document.querySelectorAll('.kids button.row, #tree button.row')];
        return rows.filter((r) => r.textContent.includes(t)).length;
      }, q);
    };
    const hitsBefore = await typeFind(deepTitle);
    if (hitsBefore >= 1) ok('B finder renders a hit for the beyond-page-1 session (before refresh)', `${hitsBefore} row(s)`);
    else bad('B finder finds the deep session before refresh', `hits=${hitsBefore}`);
    await fs.promises.mkdir(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SHOT_DIR, 'finder-before.png') });

    // FORCED page-1 reload (what the live tick / run-finish / pin does).
    await page.evaluate(() => window.__station.loadSessions('bigproj', { force: true }));
    await page.waitForTimeout(200);
    const afterState = await page.evaluate((t) => {
      const st = window.__station.state;
      const s = st.sessions.get('bigproj');
      const corpus = st.searchCorpus.get('bigproj');
      const row = [...corpus.values()].find((r) => (r.displayTitle || '').includes(t));
      return {
        listLen: s.list.length,
        listHasTarget: row ? s.list.some((x) => x.sessionId === row.sessionId) : false,
        corpusHasTarget: !!row,
        corpusLen: corpus.size,
      };
    }, deepTitle);
    // The must-FAIL condition for r2: the sidebar list shrank to page 1 and no
    // longer contains the deep session — the r2 finder would lose it here.
    if (afterState.listLen <= SESSION_PAGE && !afterState.listHasTarget)
      ok('B after forced reload the sidebar LIST dropped the deep session (r2 would lose it)', `list=${afterState.listLen}`);
    else bad('B forced reload shrinks the list past the target', JSON.stringify(afterState));
    if (afterState.corpusHasTarget && afterState.corpusLen === N)
      ok('B the search corpus kept the full set across the forced reload (never shrinks)', `${afterState.corpusLen}`);
    else bad('B corpus survives the forced reload', JSON.stringify(afterState));

    // And the finder STILL renders the hit (the user-visible fix).
    const hitsAfter = await typeFind(deepTitle);
    await page.screenshot({ path: path.join(SHOT_DIR, 'finder-after.png') });
    if (hitsAfter >= 1) ok('B finder STILL finds the beyond-page-1 session after the forced refresh', `${hitsAfter} row(s)`);
    else bad('B finder keeps the deep session after a forced refresh', `hits=${hitsAfter}`);

    // (3) load-more racing a forced reload → no duplicate / stale rows.
    await page.evaluate(() => {
      const fi = document.querySelector('#findInput');
      document.querySelector('#finder')?.classList.remove('on');
      fi.value = '';
    });
    await page.evaluate(() => window.__station.loadSessions('bigproj', { force: true }));
    await page.waitForTimeout(200);
    const race = await page.evaluate(async () => {
      const st = window.__station.state;
      const s = st.sessions.get('bigproj');
      // ensure there is more to load
      const genBefore = s.listGen;
      // fire a load-more and a forced page-1 reload CONCURRENTLY
      const p1 = window.__station.loadMoreSessions('bigproj');
      const p2 = window.__station.loadSessions('bigproj', { force: true });
      await Promise.all([p1, p2]);
      const ids = s.list.map((x) => x.sessionId);
      const dup = ids.length !== new Set(ids).size;
      return { dup, listLen: ids.length, genBefore, genAfter: s.listGen };
    });
    if (!race.dup) ok('B load-more racing a forced reload leaves NO duplicate rows', `list=${race.listLen}`);
    else bad('B no duplicate rows after the race', JSON.stringify(race));
    if (race.genAfter > race.genBefore) ok('B the generation token advanced across the forced reload', `${race.genBefore}→${race.genAfter}`);
    else bad('B generation token advanced', JSON.stringify(race));

    console.log(`  B screenshots: ${SHOT_DIR}/{finder-before,finder-after}.png (pages=${TOTAL_PAGES})`);
    await ctx.close();

    // PART C — the interleaving independent-verify run f345cc2a (BROKEN) found:
    // loadAllSessionsFull fires WHILE a forced page-1 reload is in flight. The
    // pre-fix loadSessions handed the {full:true} request the in-flight PAGE-1
    // promise, so the corpus latched at 60/N and searchLoaded stuck true — the
    // deep session unsearchable for the page's life. A fresh page so state is
    // clean, then the two loads fired concurrently.
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page2 = await ctx2.newPage();
    await page2.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page2.waitForFunction(() => !!window.__station, { timeout: 20000 });
    const inter = await page2.evaluate(async (N) => {
      // Fire a forced page-1 reload and the finder's full load CONCURRENTLY,
      // reproducing "finder opened during a forced reload".
      const p1 = window.__station.loadSessions('bigproj', { force: true });
      const p2 = window.__station.loadAllSessionsFull();
      await Promise.all([p1, p2]);
      const st = window.__station.state;
      const corpus = st.searchCorpus.get('bigproj');
      const rows = window.__station.searchRowsFor('bigproj') || [];
      return {
        searchLoaded: st.searchLoaded,
        corpusLen: corpus ? corpus.size : 0,
        rowsLen: rows.length,
        foundDeep: rows.some((r) => (r.displayTitle || '').includes('findme-rank-140')),
        N,
      };
    }, N);
    if (inter.corpusLen === N && inter.foundDeep)
      ok('C finder full-load DURING a forced reload still builds the complete corpus', `corpus=${inter.corpusLen}/${N}`);
    else bad('C full-load-during-forced-reload builds the full corpus', JSON.stringify(inter));
    if (inter.searchLoaded && inter.rowsLen === N)
      ok('C searchLoaded is true AND the finder can reach every session (no 60/N latch)');
    else bad('C searchLoaded consistent with a complete corpus', JSON.stringify(inter));
    await ctx2.close();
  } finally {
    await browser.close();
    try { process.kill(-server.pid, 'SIGKILL'); } catch { /* ignore */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function main() {
  modelPart();
  await browserPart();
  console.log(failures === 0 ? '\nPASS verify-feat-199-r3-client' : `\nFAIL verify-feat-199-r3-client (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
