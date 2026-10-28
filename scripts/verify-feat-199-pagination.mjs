#!/usr/bin/env node
/**
 * verify:feat-199 — the session list loads its first page fast, loses no
 * sessions, and keeps search + deep links working.
 *
 * Tested against the USER'S REAL store (read-only): the busiest real project,
 * `trading-volume` (2.6 k sessions, a 2.0 GB store dir). The scratch server's
 * DATA dir is isolated (its own registry seeded with that one project row); only
 * the READER is pointed at the real `~/.claude/projects`, and every request here
 * is a read-only GET, so nothing in the real store is mutated.
 *
 * Proves:
 *  A. COLD first-page time ≪ cold full-list time (the lever), on fresh boots.
 *  B. UNION-EQUIVALENCE — the union of all paged ids === the full list's ids
 *     (no session lost by pagination), and page.total matches.
 *  C. DEEP LINK by id — an OLD session, far off the first page, resolves via
 *     ?session=<id> (one file parsed), returning that exact row.
 *  D. WARM payload shrinks (first page vs full).
 *  E. BROWSER — first session row paints; "N more" reveals older rows the first
 *     page did not carry; a deep link to an old session opens it. Desktop +
 *     phone-width screenshots for the visual check. (Skipped with a notice if
 *     no headless browser is available.)
 *
 * No port 4317, no live host, no writes outside the scratch DATA dir.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { isolatedServerEnv } from './lib/station-boot.mjs';
import * as hist from '../src/lib/session-history.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const REAL_STORE = path.join(os.homedir(), '.claude', 'projects');
const REAL_REG = path.join(os.homedir(), '.local', 'share', 'claude-station', 'registry.json');
const PROJECT_ID = 'trading-volume';
const SHOT_DIR = path.join(os.tmpdir(), `feat199-shots-${process.pid}`);

let failures = 0;
const ok = (n, extra = '') => console.log(`  ok  ${n}${extra ? `  — ${extra}` : ''}`);
const bad = (n, e) => { failures++; console.log(`FAIL  ${n}\n      ${e}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

function seedDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat199-data-'));
  fs.mkdirSync(path.join(dir, 'session-hosts'), { recursive: true });
  const reg = JSON.parse(fs.readFileSync(REAL_REG, 'utf8'));
  const row = (reg.projects ?? reg).find((p) => p.id === PROJECT_ID);
  if (!row) throw new Error(`no ${PROJECT_ID} in real registry`);
  fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify({ version: reg.version ?? 1, projects: [row] }, null, 2));
  return dir;
}

async function boot(dataDir) {
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = isolatedServerEnv({
    PORT: String(PORT), HOST: '127.0.0.1',
    CLAUDE_STATION_DATA: dataDir, CLAUDE_PROJECTS_DIR: REAL_STORE,
    CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0',
  }, { requireStore: true });
  const server = spawn(process.execPath, [ENTRY], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  server.stderr?.on('data', (d) => { if (process.env.VERBOSE) process.stderr.write(`  [server] ${d}`); });
  let up = false;
  for (let i = 0; i < 150 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(200); } }
  if (!up) { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* */ } throw new Error('server never healthy'); }
  return { server, BASE, PORT };
}
const kill = (s) => { if (s?.pid) { try { process.kill(-s.pid, 'SIGKILL'); } catch { /* gone */ } } };

async function timed(url) {
  const t = performance.now();
  const r = await fetch(url);
  const body = await r.text();
  return { ms: performance.now() - t, bytes: body.length, json: JSON.parse(body) };
}

async function main() {
  console.log('\n========== FEAT-199 — paginated session list (real store: trading-volume) ==========');
  // Derive the project's store dir from the registry (no hardcoded host path).
  let storeDir = null;
  try {
    const reg = JSON.parse(fs.readFileSync(REAL_REG, 'utf8'));
    const row = (reg.projects ?? reg).find((p) => p.id === PROJECT_ID);
    if (row) storeDir = hist.encodeCwd(row.hostPath);
  } catch { /* no registry — skip below */ }
  if (!storeDir || !fs.existsSync(path.join(REAL_STORE, storeDir))) {
    console.log(`  SKIP — the real ${PROJECT_ID} store dir is absent on this machine.`);
    return;
  }
  const dataA = seedDataDir();

  /* ---- A. COLD first-page vs cold full, each on a FRESH boot (empty caches) */
  let coldPageMs, coldFullMs, firstPage;
  {
    const { server, BASE } = await boot(dataA);
    try {
      const page = await timed(`${BASE}/api/projects/${PROJECT_ID}/sessions?limit=60`); // FIRST request = cold
      coldPageMs = page.ms; firstPage = page.json;
    } finally { kill(server); }
  }
  {
    const { server, BASE } = await boot(seedDataDir());
    try {
      const full = await timed(`${BASE}/api/projects/${PROJECT_ID}/sessions`); // FIRST request = cold
      coldFullMs = full.ms;
    } finally { kill(server); }
  }
  console.log(`\n  COLD full list : ${coldFullMs.toFixed(0)} ms   (before — unpaginated)`);
  console.log(`  COLD first page: ${coldPageMs.toFixed(0)} ms   (after  — ?limit=60)`);
  if (coldPageMs < coldFullMs * 0.5) ok('A cold first page is >2x faster than the cold full list', `${coldFullMs.toFixed(0)}ms → ${coldPageMs.toFixed(0)}ms`);
  else bad('A cold first page is >2x faster than the cold full list', `full ${coldFullMs.toFixed(0)}ms vs page ${coldPageMs.toFixed(0)}ms`);

  /* ---- Warm server for the remaining content/behaviour checks */
  const { server, BASE } = await boot(dataA);
  try {
    // Full list (warm), the authority the paged union is compared against.
    const full = await timed(`${BASE}/api/projects/${PROJECT_ID}/sessions`);
    const fullIds = new Set(full.json.sessions.map((s) => `${s.encodedDir}\0${s.sessionId}`));
    const fullBySid = new Map(full.json.sessions.map((s) => [s.sessionId, s]));
    console.log(`\n  full list: ${full.json.sessions.length} sessions, ${(full.bytes / 1024).toFixed(0)} KB (warm ${full.ms.toFixed(0)}ms)`);

    /* ---- D. warm payload shrinks */
    const pageWarm = await timed(`${BASE}/api/projects/${PROJECT_ID}/sessions?limit=60`);
    console.log(`  first page: ${pageWarm.json.sessions.length} sessions, ${(pageWarm.bytes / 1024).toFixed(0)} KB (warm ${pageWarm.ms.toFixed(0)}ms), page=${JSON.stringify(pageWarm.json.page)}`);
    if (pageWarm.bytes < full.bytes / 5) ok('D first-page payload is far smaller than the full payload', `${(full.bytes / 1024).toFixed(0)}KB → ${(pageWarm.bytes / 1024).toFixed(0)}KB`);
    else bad('D first-page payload is far smaller', `${full.bytes} vs ${pageWarm.bytes}`);

    /* ---- B. union-equivalence: page through everything via the KEYSET cursor */
    const pagedIds = new Set();
    let cursor = null; const STEP = 500; let guard = 0; let lastPage = null;
    for (;;) {
      const qs = `limit=${STEP}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const r = await (await fetch(`${BASE}/api/projects/${PROJECT_ID}/sessions?${qs}`)).json();
      lastPage = r.page;
      for (const s of r.sessions) pagedIds.add(`${s.encodedDir}\0${s.sessionId}`);
      cursor = r.page?.cursor ?? null;
      if (!r.page?.hasMore || !cursor || ++guard > 50) break;
    }
    const missing = [...fullIds].filter((k) => !pagedIds.has(k));
    const extra = [...pagedIds].filter((k) => !fullIds.has(k));
    if (missing.length === 0) ok('B union of all pages loses NO session from the full list', `${pagedIds.size} paged vs ${fullIds.size} full`);
    else bad('B union of all pages loses no session', `${missing.length} missing, e.g. ${missing.slice(0, 2).join(', ')}`);
    if (extra.length === 0) ok('B pagination introduces no session the full list lacks');
    else bad('B pagination introduces no phantom session', `${extra.length} extra, e.g. ${extra.slice(0, 2)}`);
    if (lastPage && lastPage.total === fullIds.size) ok('B page.total equals the full session count', String(lastPage.total));
    else bad('B page.total equals full count', `total=${lastPage?.total} full=${fullIds.size}`);

    /* ---- C. deep link by id for an OLD, off-first-page session */
    const ordered = full.json.sessions; // server returns recency-ordered
    const oldOne = ordered[Math.min(ordered.length - 1, 2000)]; // deep in history
    const onFirstPage = pageWarm.json.sessions.some((s) => s.sessionId === oldOne.sessionId);
    const one = await (await fetch(`${BASE}/api/projects/${PROJECT_ID}/sessions?session=${encodeURIComponent(oldOne.sessionId)}`)).json();
    const got = one.sessions?.[0];
    if (got && got.sessionId === oldOne.sessionId && !onFirstPage) ok('C an OLD off-first-page session resolves by ?session=<id>', `${oldOne.sessionId.slice(0, 8)} (rank ~${ordered.indexOf(oldOne)})`);
    else bad('C off-page session resolves by id', `got=${got?.sessionId} onFirstPage=${onFirstPage}`);
    // and its meta matches the full-list row (same displayTitle)
    if (got && fullBySid.get(got.sessionId)?.displayTitle === got.displayTitle) ok('C the by-id row matches the full-list row (title)');
    else bad('C by-id row matches full-list row', `${got?.displayTitle} vs ${fullBySid.get(got?.sessionId)?.displayTitle}`);

    /* ---- E. browser: first paint, older reachable, deep link opens */
    await browserChecks(BASE, ordered, pageWarm.json.sessions);
  } finally {
    kill(server);
  }

  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`} — FEAT-199\n`);
  process.exit(failures === 0 ? 0 : 1);
}

async function browserChecks(BASE, ordered, firstPageRows) {
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { console.log('\n  E SKIP — playwright not installed'); return; }
  const exe = process.env.QA_BRAVE_PATH ?? '/usr/bin/brave';
  if (!fs.existsSync(exe)) { console.log(`\n  E SKIP — no browser at ${exe}`); return; }
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();

    // First-visible-list time: navigate, ensure the project is expanded, wait
    // for a row. (A lone project auto-expands; otherwise click its header once.)
    const t = performance.now();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.proj', { timeout: 20000 });
    const head = page.locator('.proj', { hasText: 'trading_volume' }).first();
    if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
    await page.waitForFunction(() => document.querySelectorAll('.kids button.row').length > 0, { timeout: 20000 });
    const paintMs = performance.now() - t;
    console.log(`\n  E browser: first session row visible in ${paintMs.toFixed(0)} ms (cold-ish warm server)`);
    ok('E a session row paints in the real browser', `${paintMs.toFixed(0)}ms`);

    await page.screenshot({ path: path.join(SHOT_DIR, 'desktop.png') });

    // Older reachable: count rows, click every visible "N more" a few times,
    // assert the row count grows beyond the first screenful.
    let before = await rowCount(page);
    for (let i = 0; i < 6; i++) {
      const more = page.locator('.kids button.more:not(.less)').first();
      if (!(await more.count())) break;
      await more.click().catch(() => {});
      await page.waitForTimeout(500);
    }
    const after = await rowCount(page);
    if (after > before) ok('E "N more" reveals additional session rows (older reachable)', `${before} → ${after} rows`);
    else bad('E "N more" reveals more rows', `${before} → ${after}`);

    // Deep link to an OLD session opens it.
    const old = ordered[Math.min(ordered.length - 1, 2000)];
    const hash = `#/project/${PROJECT_ID}/session/${old.sessionId}?dir=${old.encodedDir}`;
    await page.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' });
    const opened = await page.waitForFunction(
      (sid) => location.hash.includes(sid) && !document.body.innerText.includes('not here'),
      old.sessionId, { timeout: 20000 },
    ).then(() => true).catch(() => false);
    await page.screenshot({ path: path.join(SHOT_DIR, 'deeplink.png') });
    if (opened) ok('E a deep link to an OLD off-page session opens (no "not here")', old.sessionId.slice(0, 8));
    else bad('E deep link to an old session opens', `hash=${await page.evaluate(() => location.hash)}`);

    // Phone width visual (a screenshot convenience, NOT a contract assertion —
    // at 390px the project list can sit behind the responsive drawer, so a
    // hidden `.proj` here is a layout state, not a pagination defect; never let
    // it crash the otherwise-green real-store suite).
    try {
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForSelector('.proj', { timeout: 15000, state: 'attached' });
      const ph = page.locator('.proj', { hasText: 'trading_volume' }).first();
      if ((await ph.getAttribute('aria-expanded')) !== 'true') await ph.click().catch(() => {});
      await page.waitForTimeout(1000);
      await page.screenshot({ path: path.join(SHOT_DIR, 'phone.png') });
      console.log(`  E screenshots: ${SHOT_DIR}/{desktop,deeplink,phone}.png`);
    } catch (e) {
      console.log(`  (phone-width screenshot skipped: ${(e && e.message || e).toString().split('\n')[0]})`);
    }
    await ctx.close();
  } finally {
    await browser.close();
  }
}

async function rowCount(page) {
  return page.evaluate(() => document.querySelectorAll('.kids button.row').length);
}

main().catch((e) => { console.error(e); process.exit(1); });
