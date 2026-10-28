#!/usr/bin/env node
/**
 * verify:feat-199 (r7) — the two defects openai run 01a17fbc (BROKEN) found on
 * the r6 code:
 *
 *  (1) An off-page session whose filename STEM differs from its in-file
 *      sessionId resolves by id (canonicalSessionIndex keys by in-file id), but
 *      the transcript read then 404'd ("no session file") because the route
 *      looked the file up by FILENAME (<sessionId>.jsonl). ARCH-010: one owner —
 *      the canonical index — must resolve both.
 *
 *  (2) A failed finder full-list request latched state.searchLoaded=true with a
 *      PARTIAL corpus (loadSessions never rejects; a network blip is caught and
 *      recorded on s.error, so Promise.all settles "successfully"). The retry
 *      (guarded by searchLoaded) then never completed the corpus.
 *
 * PART A — (1) server-side, REAL scratch store + the real transcript route:
 *   MUST-FAIL probe (the r6 lookup): hist.resolveSessionFile(dir, inFileId) is
 *   null for a stem≠id file, while canonicalSessionIndex resolves it. Then the
 *   REAL server: ?session=<inFileId> returns the row, and
 *   GET /api/transcript/<dir>/<inFileId> serves the REAL transcript (not a 404).
 *
 * PART B-model — (2) pure, MUST-FAIL on the r6 loadAllSessionsFull:
 *   one project's full load errors; the r6 "await all; searchLoaded=true" latches
 *   with a partial corpus and the searchLoaded guard blocks the retry. The r7
 *   logic keeps searchLoaded false (searchLoadError true) and the retry completes.
 *
 * PART C — (2) REAL browser over a 2-project scratch store: project B's full
 *   fetch is aborted (a network blip). loadAllSessionsFull must NOT latch
 *   searchLoaded, must flag searchLoadError, and must render a retry hint. With
 *   the network restored, the next loadAllSessionsFull completes the full corpus
 *   and latches searchLoaded.
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
const SHOT_DIR = path.join(ROOT, 'tmp', 'feat-199-r7-shots');
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

/* Write a session file whose FILENAME stem may differ from its in-file id. */
function writeSessionAs(dir, stem, inFileId, { cwd, ts, title, msgs = 4 }) {
  fs.mkdirSync(dir, { recursive: true });
  const rows = [line({ type: 'user', sessionId: inFileId, cwd, timestamp: ts, version: '1.0.0', gitBranch: 'main', entrypoint: 'cli', message: { role: 'user', content: title } })];
  for (let i = 0; i < msgs; i++) {
    rows.push(line({ type: i % 2 ? 'assistant' : 'user', sessionId: inFileId, cwd, timestamp: ts, message: { role: i % 2 ? 'assistant' : 'user', model: 'claude', content: `body-${i}` } }));
  }
  const fp = path.join(dir, `${stem}.jsonl`);
  fs.writeFileSync(fp, rows.join('\n') + '\n');
  return fp;
}

/* --------------------------------------------- PART A: (1) stem≠id transcript */
async function part1() {
  console.log('\n----- PART A: (1) a file whose stem ≠ its in-file id resolves AND reads -----');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat199-r7a-'));
  const STORE = path.join(tmp, 'projects');
  const DATA = path.join(tmp, 'data');
  fs.mkdirSync(path.join(DATA, 'session-hosts'), { recursive: true });
  const hostPath = '/tmp/r7a/proj';
  const encDir = hist.encodeCwd(hostPath);
  const hostDir = path.join(STORE, encDir);

  // The defect's shape: filename stem is a RENAMED/COPIED label, the real
  // in-file id is a different uuid. The canonical index keys by the in-file id.
  const stem = 'renamed-copy-label';
  const inFileId = uuid(42);
  writeSessionAs(hostDir, stem, inFileId, { cwd: hostPath, ts: '2026-10-01T00:00:00.000Z', title: 'findme-mismatch', msgs: 6 });
  // A normal (stem==id) session too, so the project is realistic.
  writeSessionAs(hostDir, uuid(1), uuid(1), { cwd: hostPath, ts: '2026-10-02T00:00:00.000Z', title: 'normal-session', msgs: 2 });

  fs.writeFileSync(path.join(DATA, 'registry.json'), JSON.stringify({
    version: 1,
    projects: [{ id: 'proj', name: 'proj', hostPath, isolation: 'direct', settings: {}, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }],
  }, null, 2));

  // MUST-FAIL probe — the exact r6 lookup the transcript route used.
  const r6Lookup = hist.resolveSessionFile(encDir, inFileId, { root: STORE });
  if (r6Lookup === null) ok('(1) MUST-FAIL reproduced — resolveSessionFile(dir, inFileId) is null (the r6 404 path)', inFileId.slice(0, 8));
  else bad('(1) r6 filename lookup should miss for a stem≠id file', `got ${r6Lookup}`);
  const idx = hist.canonicalSessionIndex([encDir], { root: STORE });
  const byId = idx.get(inFileId);
  if (byId && byId.filePath.endsWith(`${stem}.jsonl`)) ok('(1) the canonical index DOES resolve the id → the real file', path.basename(byId.filePath));
  else bad('(1) canonicalSessionIndex resolves the in-file id', JSON.stringify([...idx.keys()]));

  // REAL server end-to-end.
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

    // The deep-link resolver returns the row keyed by the IN-FILE id.
    const rj = await (await fetch(`${BASE}/api/projects/proj/sessions?session=${encodeURIComponent(inFileId)}`)).json();
    const row = (rj.sessions ?? [])[0];
    if (row && row.sessionId === inFileId && row.encodedDir === encDir)
      ok('(1) ?session=<inFileId> resolves the row (sessionId = in-file id)', `${row.sessionId.slice(0, 8)} @ ${row.encodedDir.slice(0, 20)}`);
    else bad('(1) resolver returns the stem≠id row', JSON.stringify(rj.sessions));

    // The transcript route must now serve it by the in-file id — the r6 bug.
    const tResp = await fetch(`${BASE}/api/transcript/${encodeURIComponent(encDir)}/${encodeURIComponent(inFileId)}?tail=50`);
    const tj = await tResp.json().catch(() => null);
    if (tResp.status === 200 && tj && Array.isArray(tj.messages) && tj.messages.length >= 1 && tj.filePath?.endsWith(`${stem}.jsonl`))
      ok('(1) GET /api/transcript/<dir>/<inFileId> serves the REAL transcript (no 404)', `status=${tResp.status} msgs=${tj.messages.length} file=${path.basename(tj.filePath)}`);
    else bad('(1) transcript read by in-file id succeeds', `status=${tResp.status} body=${JSON.stringify(tj).slice(0, 200)}`);

    // Anti-regression: a normal stem==id session still reads directly.
    const nResp = await fetch(`${BASE}/api/transcript/${encodeURIComponent(encDir)}/${encodeURIComponent(uuid(1))}?tail=50`);
    const nj = await nResp.json().catch(() => null);
    if (nResp.status === 200 && nj?.messages?.length >= 1) ok('(1) anti-regression — a normal stem==id session still reads', `msgs=${nj.messages.length}`);
    else bad('(1) normal session still reads', `status=${nResp.status}`);

    // Anti-regression: a genuinely unknown id still 404s (the fallback does not fabricate).
    const unknown = uuid(999);
    const uResp = await fetch(`${BASE}/api/transcript/${encodeURIComponent(encDir)}/${encodeURIComponent(unknown)}?tail=50`);
    if (uResp.status === 404) ok('(1) anti-regression — a genuinely unknown id still 404s', `status=${uResp.status}`);
    else bad('(1) unknown id still 404s', `status=${uResp.status}`);
  } finally {
    try { process.kill(-server.pid, 'SIGKILL'); } catch { /* ignore */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* --------- PART D: (1) twin shadowing on the transcript route (IV run 5824d6f4) */
/*
 * The weaker "fall back only when resolveSessionFile MISSES" fix still let a
 * FILENAME HIT win over the canonical owner. Two real-store shapes break it:
 *  (D1) truncated stub — <X>.jsonl holds in-file id X with 1 real message, and a
 *       renamed copy holds in-file id X with 40 — the index picks the full copy,
 *       but a filename lookup serves the stub.
 *  (D2) stem collision — <Y>.jsonl holds in-file id Z, label-for-y.jsonl holds
 *       in-file id Y — opening Y by filename serves session Z's transcript.
 * The route must resolve THROUGH canonicalSessionIndex, so both agree with the list.
 */
async function part1Twins() {
  console.log('\n----- PART D: (1) twin shadowing on the transcript route (must-FAIL on the weaker fix) -----');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat199-r7d-'));
  const STORE = path.join(tmp, 'projects');
  const DATA = path.join(tmp, 'data');
  fs.mkdirSync(path.join(DATA, 'session-hosts'), { recursive: true });
  const hostPath = '/tmp/r7d/proj';
  const encDir = hist.encodeCwd(hostPath);
  const dir = path.join(STORE, encDir);

  const X = uuid(7);   // D1 twin id
  const Y = uuid(8);   // D2 requested id
  const Z = uuid(9);   // D2 id actually inside <Y>.jsonl
  // D1: a truncated stem==id stub, and the real renamed copy (more messages).
  writeSessionAs(dir, X, X, { cwd: hostPath, ts: '2026-10-01T00:00:00.000Z', title: 'X-STUB-truncated', msgs: 0 });
  writeSessionAs(dir, 'full-copy-of-x', X, { cwd: hostPath, ts: '2026-10-02T00:00:00.000Z', title: 'X-REAL-full', msgs: 40 });
  // D2: <Y>.jsonl holds id Z; label-for-y.jsonl holds id Y.
  writeSessionAs(dir, Y, Z, { cwd: hostPath, ts: '2026-10-03T00:00:00.000Z', title: 'this-is-session-Z', msgs: 4 });
  writeSessionAs(dir, 'label-for-y', Y, { cwd: hostPath, ts: '2026-10-04T00:00:00.000Z', title: 'this-is-session-Y', msgs: 6 });

  fs.writeFileSync(path.join(DATA, 'registry.json'), JSON.stringify({
    version: 1,
    projects: [{ id: 'proj', name: 'proj', hostPath, isolation: 'direct', settings: {}, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }],
  }, null, 2));

  // MUST-FAIL probe — the weaker fix's filename-first lookup picks the WRONG file.
  const fnX = hist.resolveSessionFile(encDir, X, { root: STORE });
  const canX = hist.resolveCanonicalSessionFile(encDir, X, { root: STORE });
  if (fnX && fnX.endsWith(`${X}.jsonl`) && canX && canX.endsWith('full-copy-of-x.jsonl'))
    ok('(D1) MUST-FAIL reproduced — resolveSessionFile picks the STUB <X>.jsonl; the index picks the full copy', `${path.basename(fnX)} vs ${path.basename(canX)}`);
  else bad('(D1) filename lookup should pick the stub, index the full copy', `fn=${fnX} can=${canX}`);
  const fnY = hist.resolveSessionFile(encDir, Y, { root: STORE });
  const canY = hist.resolveCanonicalSessionFile(encDir, Y, { root: STORE });
  if (fnY && fnY.endsWith(`${Y}.jsonl`) && canY && canY.endsWith('label-for-y.jsonl'))
    ok('(D2) MUST-FAIL reproduced — resolveSessionFile picks <Y>.jsonl (session Z); the index picks session Y', `${path.basename(fnY)} vs ${path.basename(canY)}`);
  else bad('(D2) filename lookup should pick the wrong session, index the right one', `fn=${fnY} can=${canY}`);

  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = isolatedServerEnv({
    PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE,
    CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0',
  }, { requireStore: true });
  const server = spawn(process.execPath, [ENTRY], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  server.stderr?.on('data', (d) => { if (process.env.VERBOSE) process.stderr.write(`  [server] ${d}`); });
  const firstText = (tj) => {
    for (const msg of tj?.messages ?? []) {
      for (const b of msg.blocks ?? []) { if (typeof b.text === 'string') return b.text; }
    }
    return null;
  };
  try {
    let up = false;
    for (let i = 0; i < 150 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(200); } }
    if (!up) throw new Error('server never healthy');

    // D1 — the transcript route must serve the canonical full copy, matching the list.
    const t1 = await (await fetch(`${BASE}/api/transcript/${encodeURIComponent(encDir)}/${encodeURIComponent(X)}?tail=100`)).json();
    if (t1.filePath?.endsWith('full-copy-of-x.jsonl') && t1.messages.length > 10)
      ok('(D1) transcript(X) serves the CANONICAL full copy (not the stub)', `file=${path.basename(t1.filePath)} msgs=${t1.messages.length}`);
    else bad('(D1) transcript route must not serve the truncated stub', `file=${t1.filePath} msgs=${t1.messages.length}`);

    // D2 — opening Y must serve session Y, not the colliding <Y>.jsonl (session Z).
    const t2 = await (await fetch(`${BASE}/api/transcript/${encodeURIComponent(encDir)}/${encodeURIComponent(Y)}?tail=100`)).json();
    const t2txt = firstText(t2);
    if (t2.filePath?.endsWith('label-for-y.jsonl') && /session-Y/.test(t2txt ?? ''))
      ok('(D2) transcript(Y) serves session Y (not the colliding <Y>.jsonl that holds Z)', `file=${path.basename(t2.filePath)} first=${JSON.stringify(t2txt)}`);
    else bad('(D2) transcript route must serve the right session for Y', `file=${t2.filePath} first=${JSON.stringify(t2txt)}`);

    // D2 — opening Z must serve <Y>.jsonl (which really holds Z).
    const t3 = await (await fetch(`${BASE}/api/transcript/${encodeURIComponent(encDir)}/${encodeURIComponent(Z)}?tail=100`)).json();
    const t3txt = firstText(t3);
    if (t3.filePath?.endsWith(`${Y}.jsonl`) && /session-Z/.test(t3txt ?? ''))
      ok('(D2) transcript(Z) serves <Y>.jsonl which really holds session Z', `file=${path.basename(t3.filePath)} first=${JSON.stringify(t3txt)}`);
    else bad('(D2) transcript route resolves Z to its real file', `file=${t3.filePath} first=${JSON.stringify(t3txt)}`);
  } finally {
    try { process.kill(-server.pid, 'SIGKILL'); } catch { /* ignore */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ------------------------------------ PART B: (2) latch model (must-FAIL on r6) */
function part2Model() {
  console.log('\n----- PART B: (2) finder full-load latch model (must-FAIL on r6) -----');
  // Two projects; project B's full load "fails" (network blip). loadSessions
  // catches the error and RESOLVES with s.error set — so Promise.all settles.
  const mkState = () => ({
    searchLoaded: false, searchLoadError: false,
    corpus: new Map(), // projectId -> count of rows loaded
  });
  // loadSessions model: succeed for A (fills corpus), fail for B unless netOk.
  const loadFull = (st, id, netOk) => {
    const s = { id, error: null };
    if (id === 'B' && !netOk) { s.error = 'net blip'; return s; }
    st.corpus.set(id, id === 'A' ? 100 : 80);
    return s;
  };

  // --- r6 logic (MUST-FAIL): unconditional latch ---
  {
    const st = mkState();
    const open1 = () => {
      if (st.searchLoaded) return;
      const results = ['A', 'B'].map((id) => loadFull(st, id, /* netOk */ false));
      void results; // r6 ignored the per-project errors
      st.searchLoaded = true; // LATCH — unconditional
    };
    open1(); // first finder open, B fails
    const partial = !st.corpus.has('B');
    // retry with network restored:
    const open2 = () => { if (st.searchLoaded) return; ['A', 'B'].map((id) => loadFull(st, id, true)); st.searchLoaded = true; };
    open2();
    const stuckPartial = st.searchLoaded && partial && !st.corpus.has('B');
    if (stuckPartial) ok('(2) MUST-FAIL reproduced — r6 latches searchLoaded with B missing, and the retry is blocked', `corpus=${[...st.corpus.keys()]}`);
    else bad('(2) r6 should latch with a partial corpus', `loaded=${st.searchLoaded} hasB=${st.corpus.has('B')}`);
  }

  // --- r7 logic (the fix): latch only on full success; retry completes ---
  {
    const st = mkState();
    const open = (netOk) => {
      if (st.searchLoaded) return;
      st.searchLoadError = false;
      const results = ['A', 'B'].map((id) => loadFull(st, id, netOk));
      const anyFailed = results.some((s) => s.error);
      st.searchLoaded = !anyFailed;
      st.searchLoadError = anyFailed;
    };
    open(false); // B fails
    const afterFail = { loaded: st.searchLoaded, err: st.searchLoadError, hasB: st.corpus.has('B') };
    open(true);  // retry, network restored
    const afterRetry = { loaded: st.searchLoaded, err: st.searchLoadError, hasB: st.corpus.has('B') };
    if (!afterFail.loaded && afterFail.err && !afterFail.hasB)
      ok('(2) r7 — a failed load does NOT latch; searchLoadError flagged, B still missing', JSON.stringify(afterFail));
    else bad('(2) r7 leaves searchLoaded false on failure', JSON.stringify(afterFail));
    if (afterRetry.loaded && !afterRetry.err && afterRetry.hasB)
      ok('(2) r7 — the next open RETRIES and completes the corpus (B now present)', JSON.stringify(afterRetry));
    else bad('(2) r7 retry completes the corpus', JSON.stringify(afterRetry));
  }
}

/* --------------------------------- PART C: (2) real browser, aborted B fetch */
async function part2Browser() {
  console.log('\n----- PART C: (2) real browser — B full fetch aborted, no latch, retry completes -----');
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { console.log('  E SKIP — playwright not installed'); return; }
  const exe = process.env.QA_BRAVE_PATH ?? '/usr/bin/brave';
  if (!fs.existsSync(exe)) { console.log(`  E SKIP — no browser at ${exe}`); return; }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat199-r7c-'));
  const STORE = path.join(tmp, 'projects');
  const DATA = path.join(tmp, 'data');
  fs.mkdirSync(path.join(DATA, 'session-hosts'), { recursive: true });
  // Realistic busy state: each project has MORE than one 60-session page, so the
  // sidebar page-1 preload does NOT already hold everything — the finder's FULL
  // fetch genuinely goes to the network (and so can be aborted). A sub-page store
  // would skip the full fetch entirely (page-1 == complete) and never exercise
  // the latch at all.
  const PAGE = 60;
  const projs = [
    { id: 'alpha', hostPath: '/tmp/r7c/alpha', token: 'alpha-sess', n: 80, offset: 100 },  // >1 page; full fetch succeeds
    { id: 'beta', hostPath: '/tmp/r7c/beta', token: 'beta-sess', n: 150, offset: 300 },     // >1 page; full fetch aborted
  ];
  const base = Date.UTC(2026, 9, 1); const DAY = 86400000;
  for (const pr of projs) {
    const dir = path.join(STORE, hist.encodeCwd(pr.hostPath));
    for (let i = 0; i < pr.n; i++) {
      const fp = writeSessionAs(dir, uuid(pr.offset + i), uuid(pr.offset + i), { cwd: pr.hostPath, ts: '2026-10-01T00:00:00.000Z', title: `${pr.token}-${String(i).padStart(3, '0')}`, msgs: 2 });
      fs.utimesSync(fp, new Date(base + (pr.n - i) * DAY), new Date(base + (pr.n - i) * DAY)); // newest = index 0
    }
  }
  fs.writeFileSync(path.join(DATA, 'registry.json'), JSON.stringify({
    version: 1,
    projects: projs.map((pr) => ({ id: pr.id, name: pr.id, hostPath: pr.hostPath, isolation: 'direct', settings: {}, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' })),
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

    // Abort beta's FULL fetch (bare /sessions, no query) — the phone-network blip.
    let blockBeta = true;
    await ctx.route('**/api/projects/beta/sessions', (route) => {
      const u = new URL(route.request().url());
      if (blockBeta && !u.search) return route.abort('failed'); // only the full (unpaginated) fetch
      return route.continue();
    });

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__station, { timeout: 20000 });
    await page.waitForSelector('.proj', { timeout: 20000 });

    // Finder open → loadAllSessionsFull with beta's full fetch failing.
    await page.evaluate(() => window.__station.loadAllSessionsFull());
    await page.waitForFunction(() => window.__station.state.searchLoading === false, { timeout: 20000 });
    const afterFail = await page.evaluate(() => {
      const st = window.__station.state;
      return {
        searchLoaded: st.searchLoaded,
        searchLoadError: st.searchLoadError,
        alpha: st.searchCorpus.get('alpha')?.size ?? 0,
        beta: st.searchCorpus.get('beta')?.size ?? 0,
      };
    });
    if (afterFail.searchLoaded === false && afterFail.searchLoadError === true)
      ok('C a failed full load does NOT latch searchLoaded (searchLoadError flagged)', JSON.stringify(afterFail));
    else bad('C failed load must not latch searchLoaded', JSON.stringify(afterFail));
    // alpha's full fetch succeeded (all 80); beta's full fetch was aborted, so
    // its corpus is left at the page-1 preload (60 of 150) — PARTIAL, not shrunk.
    if (afterFail.alpha === 80 && afterFail.beta === PAGE)
      ok('C corpus is partial (alpha full, beta stuck at page-1) and left AS IS', JSON.stringify(afterFail));
    else bad('C partial corpus left as is', JSON.stringify(afterFail));

    // The finder shows a retry hint (not a misleading "indexing" spinner).
    const hint = await page.evaluate(() => {
      document.querySelector('#finder')?.classList.add('on');
      const fi = document.querySelector('#findInput'); fi.value = 'sess'; fi.dispatchEvent(new Event('input', { bubbles: true }));
      const r = document.querySelector('.hint-retry');
      return r ? r.textContent : null;
    });
    await fs.promises.mkdir(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SHOT_DIR, 'finder-partial.png') });
    if (hint && /incomplete/i.test(hint)) ok('C the finder renders a "results may be incomplete" retry hint', JSON.stringify(hint));
    else bad('C retry hint shown on a partial load', JSON.stringify(hint));

    // Network restored → the next finder open RETRIES and completes the corpus.
    blockBeta = false;
    await page.evaluate(() => window.__station.loadAllSessionsFull());
    await page.waitForFunction(() => window.__station.state.searchLoading === false && window.__station.state.searchLoaded === true, { timeout: 20000 });
    const afterRetry = await page.evaluate(() => {
      const st = window.__station.state;
      return {
        searchLoaded: st.searchLoaded,
        searchLoadError: st.searchLoadError,
        alpha: st.searchCorpus.get('alpha')?.size ?? 0,
        beta: st.searchCorpus.get('beta')?.size ?? 0,
      };
    });
    await page.screenshot({ path: path.join(SHOT_DIR, 'finder-complete.png') });
    if (afterRetry.searchLoaded && !afterRetry.searchLoadError && afterRetry.alpha === 80 && afterRetry.beta === 150)
      ok('C the retry completes the corpus and latches searchLoaded (beta now fully loaded)', JSON.stringify(afterRetry));
    else bad('C retry completes the full corpus', JSON.stringify(afterRetry));

    console.log(`  C screenshots: ${SHOT_DIR}/{finder-partial,finder-complete}.png`);
    await ctx.close();
  } finally {
    await browser.close();
    try { process.kill(-server.pid, 'SIGKILL'); } catch { /* ignore */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function main() {
  await part1();
  await part1Twins();
  part2Model();
  await part2Browser();
  console.log(failures === 0 ? '\nPASS verify-feat-199-r7' : `\nFAIL verify-feat-199-r7 (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
