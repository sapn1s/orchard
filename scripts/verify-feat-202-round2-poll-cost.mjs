#!/usr/bin/env node
/**
 * verify-feat-202-round2-poll-cost.mjs — FEAT-202 round 2 A/B request-count.
 *
 * ONE scratch server (the WORKING TREE, round-2 code) with realistic-sized data,
 * driven by TWO real headless-Chromium foreground tabs:
 *   • round2  — the tab reaches /api/versions and runs the versions-driven cycle.
 *   • round1  — the tab's /api/versions is intercepted and 404'd, so the SAME
 *               client falls into its round-1 poll-each-endpoint fallback. This
 *               isolates exactly the request-count delta this change introduces,
 *               on identical code and identical data.
 *
 * Also drives a LIVENESS check on the round2 tab: an on-disk atomic-rename write
 * to agent-outcomes.json must make the tab issue a fresh GET /api/agent-outcomes
 * (a real 200 refetch, not a skipped poll) within 5s — the versions poll noticing
 * the change and refetching only that store.
 *
 * Request counts come from the CDP Network domain (a 304 fires loadingFailed, not
 * loadingFinished, so requestfinished/sizes() miss it — count on Network events).
 *
 * Env: WINDOW_MS (default 600000 = 10 min), HEADFUL=1 to watch.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
// FEAT202_ROOT lets this run against a scratch lab copy of the tree (server +
// public) — used while the working-tree public/app.js is held by a sibling
// lane's file lock, so the round-2 client can still be driven end-to-end.
const ROOT = process.env.FEAT202_ROOT || REPO;
const WINDOW_MS = Number(process.env.WINDOW_MS || 600000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const servers = new Set();

function freePort() { return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }
function startServer(port, dataDir, store) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: dataDir, CLAUDE_PROJECTS_DIR: store }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (d) => { if (process.env.CS_VERBOSE) process.stderr.write(`  [srv] ${d}`); });
  servers.add(child); return child;
}
async function waitHealth(port, ms = 45000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* */ } await sleep(250); } return false; }
const post = (port, route, body) => fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
function atomicWrite(file, data) { const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`; fs.writeFileSync(tmp, data); fs.renameSync(tmp, file); }

function seedOutcomes(dataDir, projectId) {
  const now = Date.now();
  const recs = Array.from({ length: 50 }, (_, i) => ({
    id: `out-${(now - i * 60000).toString(36)}-${i}`, at: now - i * 60000, projectId, projectName: 'feat202', stationSessionId: `cs-${i}`, sdkSessionId: `sdk-${i}`, agentId: `agent-${i}`, row: i % 3 === 0 ? 'main' : 'agent',
    label: `lane ${i} — a representative worker that stopped`, description: `FEAT-${100 + i} fixing`, kind: ['failed', 'killed', 'provider-error', 'unknown'][i % 4],
    detail: `the engine reported this agent stopped (${'x'.repeat(120)})`, providerError: null, clusterId: null, dismissedAt: null, briefedAt: null,
  }));
  atomicWrite(path.join(dataDir, 'agent-outcomes.json'), JSON.stringify(recs, null, 2));
}
function seedLanes(dataDir, projectId) {
  const now = Date.now(), MIN = 60000;
  const records = Array.from({ length: 18 }, (_, i) => ({
    id: `lane-feat202-${String(i).padStart(2, '0')}`, projectId, projectName: 'feat202', parentSessionId: null, groupId: `g-${i}`, groupSize: 1, groupClosed: true, groupOpen: false, groupCloseDeadline: null,
    groupClosedAt: now - 90 * MIN, groupExtendedAt: null, label: `solo lane ${i}`, charter: 'c'.repeat(60), provider: 'openai', model: null, transport: 'blocking-dispatch', ticket: `FEAT-${200 + i}`, phase: 'fixing', round: '1', laneClass: 'fix',
    dispatchedAt: now - 60 * MIN, state: 'settled', settledAt: now - (5 + i) * MIN, resultPointer: null, resultExcerpt: 'r'.repeat(200), failureKind: null, usage: null, handoffAt: null, handoffBytes: null, handoffEvidence: null,
    acknowledgedAt: null, acknowledgedBy: null, deliveryProof: null, acknowledgementEvidence: null, heldReason: null, dismissedAt: null, pid: null, argvToken: `tok-${i}`, serverPid: process.pid, serverStart: null, bootId: null, reconciledAt: null, reconcileDetail: null,
  }));
  atomicWrite(path.join(dataDir, 'lanes.json'), JSON.stringify(records, null, 2));
}

function classify(pathname) {
  if (/\/versions$/.test(pathname)) return 'versions';
  if (/\/board$/.test(pathname)) return 'board';
  if (/\/agent-outcomes$/.test(pathname)) return 'agent-outcomes';
  if (/\/lanes\/pending$/.test(pathname)) return 'lanes-pending';
  if (/\/processes\/summary$/.test(pathname)) return 'processes-summary';
  return null;
}

const stats = {};
function record(label, endpoint, status, bytes) {
  stats[label] ??= {}; const e = (stats[label][endpoint] ??= { count: 0, bytes: 0, s200: 0, s304: 0 });
  e.count++; e.bytes += bytes; if (status === 304) e.s304++; else if (status === 200) e.s200++;
}
async function attach(browser, port, pid, label, { block404Versions = false } = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  if (block404Versions) await page.route('**/api/versions', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not found"}' }));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  const pend = new Map();
  cdp.on('Network.requestWillBeSent', (e) => { pend.set(e.requestId, { url: e.request.url, status: 0, bytes: 0 }); });
  cdp.on('Network.responseReceived', (e) => { const r = pend.get(e.requestId); if (r) { r.status = e.response.status; r.bytes = e.response.encodedDataLength || 0; } });
  const finalize = (id, finalBytes) => {
    const r = pend.get(id); pend.delete(id); if (!r || !r.url) return;
    try { const u = new URL(r.url); if (u.port !== String(port)) return; const ep = classify(u.pathname); if (!ep) return; record(label, ep, r.status, finalBytes != null ? finalBytes : r.bytes); } catch { /* */ }
  };
  cdp.on('Network.loadingFinished', (e) => finalize(e.requestId, e.encodedDataLength));
  cdp.on('Network.loadingFailed', (e) => finalize(e.requestId, null));
  await page.goto(`http://127.0.0.1:${port}/#/p/${pid}`, { waitUntil: 'domcontentloaded' });
  if (await page.evaluate(() => document.hidden)) throw new Error(`${label}: tab hidden — not a foreground measurement`);
  return { ctx, page };
}

const rate = (n, ms) => Math.round((n / ms) * 3600000);
function report() {
  for (const label of Object.keys(stats)) {
    console.log(`\n== ${label} (window ${Math.round(WINDOW_MS / 1000)}s) ==`);
    let tReq = 0, tBytes = 0; const eps = stats[label];
    for (const ep of Object.keys(eps).sort()) { const e = eps[ep]; tReq += e.count; tBytes += e.bytes; const r = e.count ? Math.round((e.s304 / e.count) * 100) : 0; console.log(`  ${ep.padEnd(20)} req/hr=${String(rate(e.count, WINDOW_MS)).padStart(5)} bytes/hr=${String(rate(e.bytes, WINDOW_MS)).padStart(9)} 304=${r}% (n=${e.count} 200=${e.s200} 304=${e.s304})`); }
    console.log(`  ${'TOTAL'.padEnd(20)} req/hr=${String(rate(tReq, WINDOW_MS)).padStart(5)} bytes/hr=${String(rate(tBytes, WINDOW_MS)).padStart(9)}`);
  }
}

let browser = null;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'feat202-r2pc-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'feat202-r2pc-store-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'feat202-r2pc-work-'));
try {
  fs.mkdirSync(path.join(WORK, 'docs'), { recursive: true });
  fs.cpSync(path.join(REPO, 'docs', 'bugs'), path.join(WORK, 'docs', 'bugs'), { recursive: true });
  const port = await freePort();
  startServer(port, DATA, STORE);
  if (!await waitHealth(port)) throw new Error('server never healthy');
  const reg = await (await post(port, '/api/projects', { hostPath: WORK, name: 'feat202', applyMethod: false })).json();
  const pid = reg.project?.id; if (!pid) throw new Error(`register failed ${JSON.stringify(reg)}`);
  seedOutcomes(DATA, pid); seedLanes(DATA, pid);
  console.log(`server :${port} project ${pid} — real board, synthetic outcomes(50)/lanes(18)`);

  browser = await chromium.launch({ headless: !process.env.HEADFUL, executablePath: '/usr/bin/google-chrome-stable', args: ['--no-sandbox'] });
  const t2 = await attach(browser, port, pid, 'round2');
  const t1 = await attach(browser, port, pid, 'round1', { block404Versions: true });

  // LIVENESS: after steady state, an on-disk atomic-rename write must make the
  // round2 tab issue a fresh 200 GET /api/agent-outcomes within 5s.
  await sleep(8000);
  const base = stats.round2?.['agent-outcomes']?.s200 ?? 0;
  const recs = JSON.parse(fs.readFileSync(path.join(DATA, 'agent-outcomes.json'), 'utf8'));
  recs.push({ id: 'out-live', at: Date.now(), projectId: pid, projectName: 'feat202', stationSessionId: 'cs-live', sdkSessionId: 'sdk-live', agentId: 'agent-live', row: 'agent', label: 'a fresh death appeared', description: 'live', kind: 'failed', detail: 'the engine reported this agent failed', providerError: null, clusterId: null, dismissedAt: null, briefedAt: null });
  const tEdit = Date.now();
  atomicWrite(path.join(DATA, 'agent-outcomes.json'), JSON.stringify(recs, null, 2));
  let livenessMs = null;
  while (Date.now() - tEdit < 7000) { if ((stats.round2?.['agent-outcomes']?.s200 ?? 0) > base) { livenessMs = Date.now() - tEdit; break; } await sleep(100); }
  console.log(`\nLIVENESS: round2 tab refetched agent-outcomes ${livenessMs == null ? 'NOT within 7s (FAIL)' : `${livenessMs}ms after the on-disk change (${livenessMs <= 5000 ? 'within 5s PASS' : '>5s'})`}`);

  console.log(`measuring for ${Math.round(WINDOW_MS / 1000)}s ...`);
  await sleep(WINDOW_MS);
  await t2.ctx.close(); await t1.ctx.close();
  report();
  console.log('\nDONE');
} catch (err) {
  console.error('HARNESS ERROR', err); process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const s of servers) { try { process.kill(s.pid, 'SIGTERM'); } catch { /* */ } }
  for (const d of [DATA, STORE, WORK]) fs.rmSync(d, { recursive: true, force: true });
}
