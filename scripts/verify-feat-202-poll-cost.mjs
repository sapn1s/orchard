#!/usr/bin/env node
/**
 * verify-feat-202-poll-cost.mjs — FEAT-202 before/after poll-cost measurement.
 *
 * Boots TWO scratch servers from an A/B lab (before = no ETag + 5s board poll;
 * after = ETag/304 + 20s board cadence + deduped outcomes + visibility-gated
 * proc summary), each serving its own copy of src/server + public. Each gets its
 * OWN scratch data dir seeded with realistic-sized data (the REAL repo docs/bugs
 * board, a ~50-record outcomes ledger, an ~18-lane pending ledger). Drives each
 * with ONE real headless-Chromium foreground tab (project selected) and records
 * every network response's status + on-the-wire body size via request.sizes().
 *
 * Prints per-endpoint req/hr, bytes/hr and the 304 ratio for before and after.
 * Not part of the gate; run directly. Honest about what is synthetic: outcomes
 * and pending ledgers are synthesized to the ticket's measured sizes; the board
 * is the real docs/bugs artifact.
 *
 * Env: WINDOW_MS (default 600000), HEADFUL=1 to watch.
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
const LAB = process.env.FEAT202_LAB || path.join(os.homedir(), '.local/state/claude-station/scratch/feat202-lab');
const WINDOW_MS = Number(process.env.WINDOW_MS || 600000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
const servers = new Set();
function startServer(labDir, port, dataDir, store) {
  const child = spawn(process.execPath, [path.join(labDir, 'src', 'server', 'index.ts')], {
    cwd: labDir,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: dataDir, CLAUDE_PROJECTS_DIR: store },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (d) => { if (process.env.CS_VERBOSE) process.stderr.write(`  [${port}] ${d}`); });
  servers.add(child);
  return child;
}
async function waitHealth(port, ms = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* not up */ }
    await sleep(250);
  }
  return false;
}
const post = (port, route, body) => fetch(`http://127.0.0.1:${port}${route}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

function seedOutcomes(dataDir, projectId) {
  const now = Date.now();
  const kinds = ['failed', 'killed', 'provider-error', 'unknown'];
  const recs = Array.from({ length: 50 }, (_, i) => ({
    id: `out-${(now - i * 60000).toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: now - i * 60000,
    projectId, projectName: 'feat202',
    stationSessionId: `cs-seed-${i}`, sdkSessionId: `sdk-seed-${i}`,
    agentId: `agent-${i}`, row: i % 3 === 0 ? 'main' : 'agent',
    label: `lane ${i} — a representative worker that stopped`,
    description: `ticket FEAT-${100 + i} phase=fixing round=${(i % 3) + 1} class=fix`,
    kind: kinds[i % kinds.length],
    detail: `the engine reported this agent ${kinds[i % kinds.length]}; the turn it belonged to then failed with a representative cause carrying enough prose to match the real ~19KB ledger body observed in the ticket inventory (${'x'.repeat(120)})`,
    providerError: i % 4 === 2 ? { provider: 'anthropic', kind: 'usage-limit', detail: 'weekly window exhausted' } : null,
    clusterId: null, dismissedAt: null, briefedAt: null,
  }));
  fs.writeFileSync(path.join(dataDir, 'agent-outcomes.json'), JSON.stringify(recs, null, 2));
}
function seedLanes(dataDir, projectId) {
  const now = Date.now(), MIN = 60000;
  const lane = (i) => {
    const id = `lane-feat202-${String(i).padStart(2, '0')}`;
    const dir = path.join(dataDir, 'lanes', id);
    fs.mkdirSync(dir, { recursive: true });
    const text = `RESULT BODY of lane ${i}\n${'.'.repeat(400)}\nthe useful part of a settled lane result, long enough to resemble a real handoff`;
    const ptr = path.join(dir, 'result.txt');
    fs.writeFileSync(ptr, text);
    return {
      id, projectId, projectName: 'feat202', parentSessionId: null,
      groupId: `g-solo-${i}`, groupSize: 1, groupClosed: true, groupOpen: false,
      groupCloseDeadline: null, groupClosedAt: now - 90 * MIN, groupExtendedAt: null,
      label: `solo lane ${i} — a representative held result`, charter: 'c'.repeat(60),
      provider: 'openai', model: null, transport: 'blocking-dispatch',
      ticket: `FEAT-${200 + i}`, phase: 'fixing', round: '1', laneClass: 'fix',
      dispatchedAt: now - 60 * MIN, state: 'settled', settledAt: now - (5 + i) * MIN,
      resultPointer: ptr, resultExcerpt: text.slice(0, 200), failureKind: null, usage: null,
      handoffAt: null, handoffBytes: null, handoffEvidence: null,
      acknowledgedAt: null, acknowledgedBy: null, deliveryProof: null, acknowledgementEvidence: null,
      heldReason: null, dismissedAt: null, pid: null, argvToken: `tok-${id}`,
      serverPid: process.pid, serverStart: null, bootId: null, reconciledAt: null, reconcileDetail: null,
    };
  };
  const records = Array.from({ length: 18 }, (_, i) => lane(i));
  fs.writeFileSync(path.join(dataDir, 'lanes.json'), JSON.stringify(records, null, 2));
}

function classify(pathname) {
  if (/\/board$/.test(pathname)) return 'board';
  if (/\/agent-outcomes$/.test(pathname)) return 'agent-outcomes';
  if (/\/lanes\/pending$/.test(pathname)) return 'lanes-pending';
  if (/\/processes\/summary$/.test(pathname)) return 'processes-summary';
  return null;
}

async function runArm(label, labDir, workDir) {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), `feat202-${label}-data-`));
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), `feat202-${label}-store-`));
  const port = await freePort();
  startServer(labDir, port, DATA, STORE);
  if (!await waitHealth(port)) throw new Error(`${label}: server never healthy`);
  const reg = await (await post(port, '/api/projects', { hostPath: workDir, name: 'feat202', applyMethod: false })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`${label}: register failed ${JSON.stringify(reg)}`);
  seedOutcomes(DATA, pid);
  seedLanes(DATA, pid);
  return { label, port, pid, DATA };
}

const stats = {}; // label -> endpoint -> {count, bytes, s200, s304, bodyMax}
function record(label, endpoint, status, bodyBytes) {
  stats[label] ??= {};
  const e = (stats[label][endpoint] ??= { count: 0, bytes: 0, s200: 0, s304: 0, bodyMax: 0 });
  e.count++; e.bytes += bodyBytes;
  if (status === 304) e.s304++; else if (status === 200) { e.s200++; e.bodyMax = Math.max(e.bodyMax, bodyBytes); }
}

async function attach(browser, arm) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // CDP ground truth: `requestfinished`/`sizes()` does NOT reliably surface 304
  // revalidations, so the status + true on-the-wire byte count come from the
  // Network domain. `encodedDataLength` is the real transfer size (headers +
  // encoded body); a 304 is ~a couple hundred header bytes, a 200 is the gzipped
  // payload.
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  // A 200 fires requestWillBeSent → responseReceived → loadingFinished; a 304
  // fires requestWillBeSent → responseReceived → loadingFailed (NOT finished).
  // So the status + header-byte count come from responseReceived, and the final
  // wire-byte total from whichever terminal event fires.
  const pend = new Map(); // requestId -> { url, status, bytes }
  cdp.on('Network.requestWillBeSent', (e) => { pend.set(e.requestId, { url: e.request.url, status: 0, bytes: 0 }); });
  cdp.on('Network.responseReceived', (e) => {
    const r = pend.get(e.requestId); if (!r) return;
    r.status = e.response.status; r.bytes = e.response.encodedDataLength || 0;
  });
  const finalize = (requestId, finalBytes) => {
    const r = pend.get(requestId); pend.delete(requestId);
    if (!r || !r.url) return;
    try {
      const u = new URL(r.url);
      if (u.port !== String(arm.port)) return;
      const ep = classify(u.pathname);
      if (!ep) return;
      record(arm.label, ep, r.status, finalBytes != null ? finalBytes : r.bytes);
    } catch { /* ignore */ }
  };
  cdp.on('Network.loadingFinished', (e) => finalize(e.requestId, e.encodedDataLength));
  cdp.on('Network.loadingFailed', (e) => finalize(e.requestId, null));
  await page.goto(`http://127.0.0.1:${arm.port}/#/p/${arm.pid}`, { waitUntil: 'domcontentloaded' });
  // Confirm the tab counts as a FOREGROUND tab (the whole measurement premise).
  const hidden = await page.evaluate(() => document.hidden);
  if (hidden) throw new Error(`${arm.label}: tab reports hidden — not a foreground measurement`);
  return { ctx, page };
}

const rate = (n, ms) => Math.round((n / ms) * 3600000);
function report() {
  for (const label of Object.keys(stats)) {
    console.log(`\n== ${label} (window ${Math.round(WINDOW_MS / 1000)}s) ==`);
    let tReq = 0, tBytes = 0;
    const eps = stats[label];
    for (const ep of Object.keys(eps).sort()) {
      const e = eps[ep];
      tReq += e.count; tBytes += e.bytes;
      const ratio = e.count ? Math.round((e.s304 / e.count) * 100) : 0;
      console.log(`  ${ep.padEnd(20)} req/hr=${String(rate(e.count, WINDOW_MS)).padStart(5)} bytes/hr=${String(rate(e.bytes, WINDOW_MS)).padStart(9)} 304=${ratio}% (count=${e.count} 200=${e.s200} 304=${e.s304} bodyMax=${e.bodyMax})`);
    }
    console.log(`  ${'TOTAL'.padEnd(20)} req/hr=${String(rate(tReq, WINDOW_MS)).padStart(5)} bytes/hr=${String(rate(tBytes, WINDOW_MS)).padStart(9)}`);
  }
}

let browser = null;
try {
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'feat202-work-'));
  fs.mkdirSync(path.join(WORK, 'docs'), { recursive: true });
  fs.cpSync(path.join(REPO, 'docs', 'bugs'), path.join(WORK, 'docs', 'bugs'), { recursive: true });
  console.log(`seeded realistic board from real docs/bugs into ${WORK}`);

  const before = await runArm('before', path.join(LAB, 'before'), WORK);
  const after = await runArm('after', path.join(LAB, 'after'), WORK);
  console.log(`before :${before.port}  after :${after.port}  project ${before.pid}/${after.pid}`);

  browser = await chromium.launch({
    headless: !process.env.HEADFUL,
    executablePath: '/usr/bin/google-chrome-stable',
    args: ['--no-sandbox'],
  });
  const tb = await attach(browser, before);
  const ta = await attach(browser, after);

  console.log(`measuring for ${Math.round(WINDOW_MS / 1000)}s ...`);
  await sleep(WINDOW_MS);

  await tb.ctx.close(); await ta.ctx.close();
  report();
  console.log('\nDONE');
} catch (err) {
  console.error('HARNESS ERROR', err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const s of servers) { try { process.kill(s.pid, 'SIGTERM'); } catch {} }
}
