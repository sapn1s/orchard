#!/usr/bin/env node
/**
 * verify-feat-202-correctness.mjs — FEAT-202 freshness + gate correctness.
 *
 * Proves the ETag/304 + board-cadence + proc-visibility-gate changes do NOT make
 * the UI stale and do pause the hidden-tab proc poll:
 *   1. A board change on disk (a ticket title edited in the scratch docs/bugs)
 *      shows up in state.board within one board interval — via a full 200, not a
 *      stale 304.
 *   2. A new agent outcome appended to the ledger appears in state.outcomes
 *      within one rail interval.
 *   3. The process-summary poll STOPS while the tab is hidden and catches up on
 *      return.
 *
 * Runs against the AFTER lab (src/server + public with FEAT-202 applied).
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
// Self-contained: test THIS checkout's own src/server + public (so it runs in an
// independent-verify clean room against the candidate files). FEAT202_LAB can
// point it at the A/B lab's `after/` instead.
const LAB = process.env.FEAT202_LAB || REPO;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, obs) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}\n      ${typeof obs === 'string' ? obs : JSON.stringify(obs)}`); ok ? pass++ : fail++; };

import * as net from 'node:net';
const getPort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

let srv = null, browser = null;
try {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'f202c-data-'));
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'f202c-store-'));
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'f202c-work-'));
  fs.mkdirSync(path.join(WORK, 'docs'), { recursive: true });
  fs.cpSync(path.join(REPO, 'docs', 'bugs'), path.join(WORK, 'docs', 'bugs'), { recursive: true });
  const INDEX = path.join(WORK, 'docs', 'bugs', 'INDEX.md');
  const OUTCOMES = path.join(DATA, 'agent-outcomes.json');

  const port = await getPort();
  srv = spawn(process.execPath, [path.join(LAB, 'src', 'server', 'index.ts')], {
    cwd: LAB, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch {} await sleep(250); }
  const reg = await (await fetch(`http://127.0.0.1:${port}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: WORK, name: 'f202c', applyMethod: false }) })).json();
  const pid = reg.project.id;
  // seed an initial outcome so the ledger is non-empty before the test append
  fs.writeFileSync(OUTCOMES, JSON.stringify([{ id: 'out-seed', at: Date.now() - 600000, projectId: pid, projectName: 'f202c', stationSessionId: 's0', sdkSessionId: 'k0', agentId: 'a0', row: 'agent', label: 'pre-existing outcome', description: '', kind: 'failed', detail: 'seed', providerError: null, clusterId: null, dismissedAt: null, briefedAt: null }], null, 2));

  browser = await chromium.launch({ headless: !process.env.HEADFUL, executablePath: '/usr/bin/google-chrome-stable', args: ['--no-sandbox'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  const procHits = []; // {at, status}
  const boardStatuses = [];
  const idUrl = new Map(), idStatus = new Map();
  cdp.on('Network.requestWillBeSent', (e) => idUrl.set(e.requestId, e.request.url));
  cdp.on('Network.responseReceived', (e) => {
    idStatus.set(e.requestId, e.response.status);
    const u = e.response.url;
    if (u.includes('/processes/summary')) procHits.push({ at: Date.now(), status: e.response.status });
    if (u.includes('/board')) boardStatuses.push(e.response.status);
  });

  await page.goto(`http://127.0.0.1:${port}/#/p/${pid}`, { waitUntil: 'domcontentloaded' });
  // wait for the first board to land
  await page.waitForFunction(() => window.__station?.state?.board != null, null, { timeout: 20000 });
  const hidden0 = await page.evaluate(() => document.hidden);
  check('precondition — tab is foreground (visible)', hidden0 === false, { hidden: hidden0 });

  // ── 0. CONTRACT: unchanged body returns 304 with ~0 bytes ────────────────
  // Direct HTTP on each polled endpoint: a strong ETag + an If-None-Match
  // revalidation must yield a bodyless 304 whenever the body is unchanged.
  for (const ep of [`/api/projects/${pid}/board`, `/api/agent-outcomes?projectId=${pid}&all=1&limit=200`, `/api/lanes/pending?projectId=${pid}`, '/api/processes/summary']) {
    const r1 = await fetch(`http://127.0.0.1:${port}${ep}`);
    const etag = r1.headers.get('etag');
    const body1 = await r1.text();
    const r2 = await fetch(`http://127.0.0.1:${port}${ep}`, { headers: { 'if-none-match': etag } });
    const body2 = await r2.text();
    const name = ep.split('?')[0];
    check(`contract — ${name}: serves a strong ETag`, !!etag && !/^W\//.test(etag), { etag });
    check(`contract — ${name}: unchanged body → 304 with no payload (fewer bytes)`, r1.status === 200 && r2.status === 304 && body2.length === 0 && body1.length > 0, { first: r1.status, firstBytes: body1.length, revalidate: r2.status, revalidateBytes: body2.length });
  }

  // ── 1. BOARD FRESHNESS ──────────────────────────────────────────────────
  // A real on-disk board edit: remove a needsYou ticket's INDEX row (needsYou
  // membership is driven by INDEX.md), so the board JSON genuinely changes.
  const target = await page.evaluate(() => {
    const ny = window.__station.state.board.needsYou || [];
    const t = ny.find((x) => x.kind === 'ticket' && /^[A-Z]+-\d+$/.test(x.id));
    return t ? t.id : null;
  });
  check('board test — a needsYou ticket to edit exists', !!target, { target });
  let idx = fs.readFileSync(INDEX, 'utf8');
  const before = idx;
  idx = idx.replace(new RegExp(`^\\| ${target} \\|.*$\\n`, 'm'), '');
  check('board test — INDEX.md edit changed the file', idx !== before, { changed: idx !== before, target });
  fs.writeFileSync(INDEX, idx);
  const t0 = Date.now();
  let gone = false;
  while (Date.now() - t0 < 28000) { // BOARD_POLL_MS (20s) + margin
    gone = await page.evaluate((id) => !(window.__station.state.board.needsYou || []).some((x) => x.id === id), target);
    if (gone) break;
    await sleep(500);
  }
  check('board change on disk appears in the UI within one board interval', gone, { target, seenAfterMs: Date.now() - t0, boardStatuses });
  check('board update arrived as a full 200 (not a stale 304)', boardStatuses.filter((s) => s === 200).length >= 2, { boardStatuses });

  // ── 2. OUTCOME APPEARANCE ───────────────────────────────────────────────
  const outLabel = `F202-OUTCOME-${Date.now().toString(36)}`;
  const recs = JSON.parse(fs.readFileSync(OUTCOMES, 'utf8'));
  recs.push({ id: `out-${Date.now().toString(36)}`, at: Date.now(), projectId: pid, projectName: 'f202c', stationSessionId: 's1', sdkSessionId: 'k1', agentId: 'a1', row: 'agent', label: outLabel, description: '', kind: 'killed', detail: 'a representative death', providerError: null, clusterId: null, dismissedAt: null, briefedAt: null });
  fs.writeFileSync(OUTCOMES, JSON.stringify(recs, null, 2));
  const t1 = Date.now();
  let outSeen = false;
  while (Date.now() - t1 < 12000) { // RAIL_POLL_MS (5s) + margin
    outSeen = await page.evaluate((lbl) => (window.__station.state.outcomes || []).some((o) => o.label === lbl), outLabel);
    if (outSeen) break;
    await sleep(400);
  }
  check('a new agent outcome appears in the UI within one rail interval', outSeen, { seenAfterMs: Date.now() - t1 });

  // ── 3. PROC-SUMMARY VISIBILITY GATE ─────────────────────────────────────
  // Override document.hidden so the app sees a backgrounded tab.
  await page.evaluate(() => {
    window.__fakeHidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__fakeHidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window.__fakeHidden ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const procBeforeHidden = procHits.length;
  await sleep(18000); // > PROC_POLL_MS (15s): a visible tab would have polled at least once
  const procWhileHidden = procHits.length - procBeforeHidden;
  check('process-summary poll STOPS while the tab is hidden', procWhileHidden === 0, { procRequestsWhileHidden: procWhileHidden, windowMs: 18000 });

  // return to foreground: expect an immediate catch-up proc fetch
  await page.evaluate(() => { window.__fakeHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  const t2 = Date.now();
  let caughtUp = false;
  while (Date.now() - t2 < 6000) { if (procHits.length > procBeforeHidden) { caughtUp = true; break; } await sleep(300); }
  check('process-summary catches up immediately on return to foreground', caughtUp, { procRequestsAfterReturn: procHits.length - procBeforeHidden });

  console.log(`\n${fail ? 'FAIL' : 'PASS'} total: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (err) {
  console.error('HARNESS ERROR', err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (srv) { try { process.kill(srv.pid, 'SIGTERM'); } catch {} }
}
