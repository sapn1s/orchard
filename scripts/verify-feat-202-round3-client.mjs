#!/usr/bin/env node
/**
 * verify-feat-202-round3-client.mjs — the CLIENT half of FEAT-202 round 3.
 *
 * Two client behaviors the verifier's attack list names, driven in a REAL
 * headless browser against a REAL booted server (the user's reality):
 *
 *   1. LOST-UPDATE FIX. versionsRailCycle must advance its remembered per-store
 *      fingerprint ONLY after that store's refetch succeeds. We append a new
 *      outcome to the ledger (its fingerprint moves), then make the NEXT
 *      /api/agent-outcomes fetch FAIL. Round 2 set lastVersions = v up front, so
 *      the failed refetch stranded the store: the outcome would NEVER appear
 *      without a FURTHER server change. Round 3 must show the outcome appear on
 *      a later cycle with NO further ledger write — i.e. it retried.
 *
 *   2. FALLBACK WHEN /api/versions IS DOWN. With the versions route failing, the
 *      rail must fall back to round-1's poll-each-endpoint cadence and still
 *      surface an on-disk outcome — a versions outage never freezes the rail.
 *
 * Self-contained; scratch dirs, free port, kills only its own pids. The board is
 * the real repo docs/bugs; the outcomes ledger is synthesized (said so, per WA).
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getPort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
let pass = 0, fail = 0;
const check = (name, ok, obs) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}\n      ${typeof obs === 'string' ? obs : JSON.stringify(obs)}`); ok ? pass++ : fail++; };

let srv = null, browser = null;
try {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'f202rc-data-'));
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'f202rc-store-'));
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'f202rc-work-'));
  fs.mkdirSync(path.join(WORK, 'docs'), { recursive: true });
  fs.cpSync(path.join(REPO, 'docs', 'bugs'), path.join(WORK, 'docs', 'bugs'), { recursive: true });
  const OUTCOMES = path.join(DATA, 'agent-outcomes.json');

  const port = await getPort();
  srv = spawn(process.execPath, [path.join(REPO, 'src', 'server', 'index.ts')], {
    cwd: REPO, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch { /* */ } await sleep(250); }
  const reg = await (await fetch(`http://127.0.0.1:${port}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: WORK, name: 'f202rc', applyMethod: false }) })).json();
  const pid = reg.project.id;
  fs.writeFileSync(OUTCOMES, JSON.stringify([{ id: 'out-seed', at: Date.now() - 600000, projectId: pid, projectName: 'f202rc', stationSessionId: 's0', sdkSessionId: 'k0', agentId: 'a0', row: 'agent', label: 'pre-existing', description: '', kind: 'failed', detail: 'seed', providerError: null, clusterId: null, dismissedAt: null, briefedAt: null }], null, 2));
  // A SECOND project (B) for the project-switch pending test. Its own WORK dir.
  const WORKB = fs.mkdtempSync(path.join(os.tmpdir(), 'f202rc-workb-'));
  fs.mkdirSync(path.join(WORKB, 'docs', 'bugs'), { recursive: true });
  fs.writeFileSync(path.join(WORKB, 'docs', 'bugs', 'INDEX.md'), '# board B\n');
  const regB = await (await fetch(`http://127.0.0.1:${port}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: WORKB, name: 'f202rcB', applyMethod: false }) })).json();
  const pidB = regB.project.id;
  // One settled, group-closed (held) lane per project → each surfaces in that
  // project's /api/lanes/pending. Written ONCE so the global lanes fingerprint is
  // STILL between the switch: only the projectId filter differs.
  const LANES = path.join(DATA, 'lanes.json');
  const mkLane = (id, projectId) => ({ id, projectId, projectName: 'x', parentSessionId: null, groupId: `g-${id}`, groupSize: 1, groupClosed: true, groupOpen: false, groupCloseDeadline: null, groupClosedAt: Date.now() - 5400000, groupExtendedAt: null, label: `held lane ${id}`, charter: 'c'.repeat(40), provider: 'openai', model: null, transport: 'blocking-dispatch', ticket: 'FEAT-1', phase: 'fixing', round: '1', laneClass: 'fix', dispatchedAt: Date.now() - 3600000, state: 'settled', settledAt: Date.now() - 600000, resultPointer: null, resultExcerpt: 'r'.repeat(80), failureKind: null, usage: null, handoffAt: null, handoffBytes: null, handoffEvidence: null, acknowledgedAt: null, acknowledgedBy: null, deliveryProof: null, acknowledgementEvidence: null, heldReason: null, dismissedAt: null, pid: null, argvToken: `tok-${id}`, serverPid: process.pid, serverStart: null, bootId: null, reconciledAt: null, reconcileDetail: null });
  fs.writeFileSync(LANES, JSON.stringify([mkLane('lane-of-A', pid), mkLane('lane-of-B', pidB)], null, 2));

  const seedOutcome = (label) => {
    const recs = JSON.parse(fs.readFileSync(OUTCOMES, 'utf8'));
    recs.push({ id: `out-${Math.random().toString(36).slice(2)}`, at: Date.now(), projectId: pid, projectName: 'f202rc', stationSessionId: 's', sdkSessionId: 'k', agentId: 'a', row: 'agent', label, description: '', kind: 'killed', detail: 'a death', providerError: null, clusterId: null, dismissedAt: null, briefedAt: null });
    fs.writeFileSync(OUTCOMES, JSON.stringify(recs, null, 2));
  };
  const waitSeen = async (label, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (await page.evaluate((l) => (window.__station.state.outcomes || []).some((o) => o.label === l), label)) return true; await sleep(300); } return false; };

  browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome-stable', args: ['--no-sandbox'] });
  const ctx = await browser.newContext();
  var page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/#/p/${pid}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__station?.state?.board != null, null, { timeout: 20000 });

  // ── 0. COALESCING RACE: a `focus`-triggered outcomes fetch that was already in
  //      flight (and read the ledger BEFORE a new death was appended) must NOT let
  //      versionsRailCycle commit the newer fingerprint against those stale bytes.
  //      The fix gates the commit on the applied fetch having STARTED at/after the
  //      snapshot was read. We HOLD the first (focus) fetch and answer it with the
  //      pre-append body, append a new death, let the versions cycle JOIN the held
  //      fetch, then release it — the new death must still surface on a later cycle.
  const RACE = `RACE-${Date.now().toString(36)}`;
  const staleBody = fs.readFileSync(OUTCOMES, 'utf8'); // the ledger BEFORE the append
  let releaseHeld;
  const heldReady = new Promise((r) => { releaseHeld = r; });
  let heldOne = false;
  await page.route('**/api/agent-outcomes*', async (route) => {
    if (!heldOne) { heldOne = true; await heldReady; try { await route.fulfill({ status: 200, contentType: 'application/json', body: staleBody }); } catch { /* unrouted */ } return; }
    try { await route.continue(); } catch { /* unrouted */ }
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); // → refreshRail(true) → void refreshOutcomes() starts the held fetch
  await sleep(600);
  seedOutcome(RACE); // a new death lands WHILE the stale fetch is held
  await sleep(6500); // let a versions cycle notice outcomes changed and JOIN the held fetch
  releaseHeld(); // the held fetch resolves with the PRE-append body
  await sleep(800); // let the held fetch fully resolve before we remove the route
  await page.unroute('**/api/agent-outcomes*');
  const raceSeen = await waitSeen(RACE, 15000); // a later cycle must fetch fresh and surface it
  check('a coalesced pre-snapshot outcomes fetch does not strand a newer death (commit-gated on fetch start)', raceSeen === true, { raceSeen });
  // clear it so it does not confuse later checks
  { const recs = JSON.parse(fs.readFileSync(OUTCOMES, 'utf8')).filter((o) => o.label !== RACE); fs.writeFileSync(OUTCOMES, JSON.stringify(recs, null, 2)); await sleep(6000); }

  // ── 1. LOST-UPDATE: a transient refetch failure must NOT strand the store ──
  let failOutcomes = true;
  await page.route('**/api/agent-outcomes*', (route) => failOutcomes ? route.abort('failed') : route.continue());
  const LOST = `LOST-${Date.now().toString(36)}`;
  seedOutcome(LOST); // fingerprint moves; the refetch that detects it will fail
  const seenWhileFailing = await waitSeen(LOST, 9000); // > one versions cycle
  check('while /api/agent-outcomes fails, the new outcome is NOT shown (failure exercised)', seenWhileFailing === false, { seenWhileFailing });
  // Recover the route WITHOUT touching the ledger again. Round 2 (lastVersions=v
  // up front) would stay stranded here; round 3 must retry because the remembered
  // fingerprint was never advanced past the failed fetch.
  failOutcomes = false;
  const seenAfterRecovery = await waitSeen(LOST, 12000);
  check('after recovery (no further ledger write) the outcome appears — no stranded counter', seenAfterRecovery === true, { seenAfterRecovery });

  // ── 1b. BOARD BACKSTOP: with versions working and NOTHING changing, the board
  //        must still be refetched on the slow BOARD_POLL_MS timer, so the
  //        server-DERIVED board inputs (base-update notice, grant-rebuild items,
  //        ref-ledger alarm) that no stat fingerprint can observe are never
  //        stale with no time limit. It is cheap: the refetch is a bodyless 304
  //        when the board is unchanged.
  await page.unroute('**/api/agent-outcomes*');
  const boardMs = await page.evaluate(() => window.__station?.BOARD_POLL_MS ?? 20000).catch(() => 20000);
  const boardReqs = [];
  const onResp = (resp) => { if (resp.url().includes('/board')) boardReqs.push(resp.status()); };
  page.on('response', onResp);
  await sleep(boardMs + 6000); // one backstop interval + slack, no disk changes
  page.off('response', onResp);
  check('board is refetched on the BOARD_POLL_MS backstop while idle (derived-input safety net)', boardReqs.length >= 1, { boardReqs, boardMs });
  check('the idle backstop refetch is a cheap 304 (board unchanged)', boardReqs.length >= 1 && boardReqs.every((s) => s === 304 || s === 200) && boardReqs.includes(304), { boardReqs });

  // ── 1c. PROJECT SWITCH: /api/lanes/pending is project-scoped, but the `pending`
  //        fingerprint is GLOBAL (one lanes.json). Switching A→B without any lanes
  //        write must still refetch pending for B, or the rail shows A's held lanes
  //        on B (round 1 polled pending every 5s — the versions gate must not
  //        regress this). lanes.json is NOT touched across the switch.
  const hasA = (ids) => ids.some((id) => id.includes('lane-of-A'));
  const hasB = (ids) => ids.some((id) => id.includes('lane-of-B'));
  const pendA = await page.evaluate(() => (window.__station.state.pending || []).map((i) => i.id));
  check('on project A the rail pending shows A\'s held lane', hasA(pendA) && !hasB(pendA), { pendA });
  await page.evaluate((b) => window.__station.selectProject(b), pidB);
  let pendB = [];
  const tSwitch = Date.now();
  while (Date.now() - tSwitch < 12000) { pendB = await page.evaluate(() => (window.__station.state.pending || []).map((i) => i.id)); if (hasB(pendB)) break; await sleep(400); }
  check('after switching to B the rail pending shows B\'s held lane, not A\'s (no lanes write)', hasB(pendB) && !hasA(pendB), { pendB, afterMs: Date.now() - tSwitch });

  // ── 2. FALLBACK: /api/versions down → rail still surfaces an on-disk change ─
  // Back on project A for the fallback outcome check.
  await page.evaluate((a) => window.__station.selectProject(a), pid);
  await sleep(500);
  await page.route('**/api/versions*', (route) => route.abort('failed'));
  await sleep(500);
  const FALLBACK = `FALLBACK-${Date.now().toString(36)}`;
  seedOutcome(FALLBACK);
  const seenViaFallback = await waitSeen(FALLBACK, 12000);
  check('with /api/versions failing, the rail falls back and still surfaces the outcome', seenViaFallback === true, { seenViaFallback });

  console.log(`\n${fail ? 'FAIL' : 'PASS'} total: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (err) {
  console.error('HARNESS ERROR', err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (srv) { try { process.kill(srv.pid, 'SIGTERM'); } catch { /* */ } }
}
