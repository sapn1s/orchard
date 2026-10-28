#!/usr/bin/env node
/**
 * verify-feat-202-round2.mjs — the aggregate /api/versions poll, updated for
 * round 3 (watchers are hints, not truth).
 *
 * Round 2 shipped a watcher-based version counter that went deaf on a Linux dir
 * remove+recreate (anthropic 5b838160, BROKEN). Round 3 replaced it with a cheap
 * on-demand STAT FINGERPRINT (dir ino + entry mtime/size/ino), cached ~1s, so
 * there is no watcher state to go stale. The round-3 filesystem-event ATTACK
 * MATRIX (remove+recreate, rename-away/back, size-only, inode-only, 20-tab
 * cache) lives in verify-feat-202-round3.mjs; THIS suite is the smaller
 * server-contract regression guard it supersedes:
 *   A. the module — a fingerprint is a stable string that MOVES on any change;
 *   B. GET /api/versions — tiny ETag'd body, bodyless 304, string fingerprints;
 *   C. liveness — an on-disk store change moves the right fingerprint within 5s;
 *   D. restart — a restart bumps `boot`, the signal the client refetches on.
 *
 * Self-contained; scratch dirs, free port, kills only its own pids. The board is
 * the real repo docs/bugs; outcomes/lanes are synthesized to realistic size.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  PASS ${name}${extra ? ` — ${extra}` : ''}`); } else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); } };

function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/* ───────────────────────── Part A — the module ─────────────────────────── */
async function partA() {
  console.log('\n== A. store-versions fingerprint module (stable string, moves on any change) ==');
  const sv = await import('../src/server/store-versions.ts');
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'feat202-sv-data-'));
  const BOARD = fs.mkdtempSync(path.join(os.tmpdir(), 'feat202-sv-board-'));
  const boards = [{ id: 'proj-x', dir: BOARD }];
  const snap = () => { sv._clearCache(); return sv.snapshot(DATA, boards); };
  try {
    for (const f of ['agent-outcomes.json', 'lanes.json', 'group-seals.json', 'decisions.json']) fs.writeFileSync(path.join(DATA, f), '[]');
    fs.writeFileSync(path.join(BOARD, 'T-1.md'), 'x');

    const s0 = snap();
    ok('fingerprints are strings', typeof s0.outcomes === 'string' && typeof s0.pending === 'string' && typeof s0.board['proj-x'] === 'string');
    ok('a re-read with no change is identical', JSON.stringify(snap()) === JSON.stringify(s0));

    const o0 = snap().outcomes;
    atomicWrite(path.join(DATA, 'agent-outcomes.json'), JSON.stringify([{ id: 'a' }]));
    ok('a first atomic rename moves outcomes', snap().outcomes !== o0);
    const o1 = snap().outcomes;
    atomicWrite(path.join(DATA, 'agent-outcomes.json'), JSON.stringify([{ id: 'b' }, { id: 'c' }]));
    ok('a SECOND atomic rename STILL moves outcomes (no deaf watcher)', snap().outcomes !== o1);

    const p0 = snap().pending;
    atomicWrite(path.join(DATA, 'lanes.json'), JSON.stringify([{ id: 'l' }]));
    ok('lanes.json → pending', snap().pending !== p0);

    const b0 = snap().board['proj-x'];
    atomicWrite(path.join(DATA, 'decisions.json'), JSON.stringify([{ id: 'd' }]));
    ok('decisions.json → board (feeds needsYou)', snap().board['proj-x'] !== b0);

    const r0 = snap().outcomes;
    sv.bumpOutcomes();
    ok('the in-process bump is a zero-latency accelerator', snap().outcomes !== r0);
  } finally {
    for (const d of [DATA, BOARD]) fs.rmSync(d, { recursive: true, force: true });
  }
}

/* ───────────────────────── server boot helpers ────────────────────────── */
function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
function startServer(port, dataDir, store) {
  const child = spawn(process.execPath, [path.join(REPO, 'src', 'server', 'index.ts')], {
    cwd: REPO,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: dataDir, CLAUDE_PROJECTS_DIR: store },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (d) => { if (process.env.CS_VERBOSE) process.stderr.write(`  [srv] ${d}`); });
  return child;
}
async function waitHealth(port, ms = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* */ } await sleep(250); }
  return false;
}
const getJson = async (port, route, headers = {}) => { const r = await fetch(`http://127.0.0.1:${port}${route}`, { headers }); return { status: r.status, etag: r.headers.get('etag'), body: r.status === 304 ? null : await r.json() }; };
const post = (port, route, body) => fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function seedOutcomes(dataDir, projectId) {
  const now = Date.now();
  const recs = Array.from({ length: 50 }, (_, i) => ({
    id: `out-${(now - i * 60000).toString(36)}-${i}`, at: now - i * 60000, projectId, projectName: 'feat202',
    stationSessionId: `cs-${i}`, sdkSessionId: `sdk-${i}`, agentId: `agent-${i}`, row: i % 3 === 0 ? 'main' : 'agent',
    label: `lane ${i} — a representative worker that stopped`, description: `FEAT-${100 + i} fixing`,
    kind: ['failed', 'killed', 'provider-error', 'unknown'][i % 4], detail: `the engine reported this agent stopped (${'x'.repeat(120)})`,
    providerError: null, clusterId: null, dismissedAt: null, briefedAt: null,
  }));
  atomicWrite(path.join(dataDir, 'agent-outcomes.json'), JSON.stringify(recs, null, 2));
}
function seedLanes(dataDir, projectId) {
  const now = Date.now(), MIN = 60000;
  const records = Array.from({ length: 18 }, (_, i) => ({
    id: `lane-feat202-${String(i).padStart(2, '0')}`, projectId, projectName: 'feat202', parentSessionId: null,
    groupId: `g-${i}`, groupSize: 1, groupClosed: true, groupOpen: false, groupCloseDeadline: null,
    groupClosedAt: now - 90 * MIN, groupExtendedAt: null, label: `solo lane ${i}`, charter: 'c'.repeat(60),
    provider: 'openai', model: null, transport: 'blocking-dispatch', ticket: `FEAT-${200 + i}`, phase: 'fixing', round: '1', laneClass: 'fix',
    dispatchedAt: now - 60 * MIN, state: 'settled', settledAt: now - (5 + i) * MIN, resultPointer: null,
    resultExcerpt: 'r'.repeat(200), failureKind: null, usage: null, handoffAt: null, handoffBytes: null, handoffEvidence: null,
    acknowledgedAt: null, acknowledgedBy: null, deliveryProof: null, acknowledgementEvidence: null,
    heldReason: null, dismissedAt: null, pid: null, argvToken: `tok-${i}`, serverPid: process.pid, serverStart: null, bootId: null, reconciledAt: null, reconcileDetail: null,
  }));
  atomicWrite(path.join(dataDir, 'lanes.json'), JSON.stringify(records, null, 2));
}
async function waitForP(port, pred, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const b = (await getJson(port, '/api/versions')).body; if (pred(b)) return true; await sleep(100); }
  return pred((await getJson(port, '/api/versions')).body);
}

/* ──────────────── Parts B/C/D — a real booted server ───────────────────── */
async function partBCD() {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'feat202-r2-data-'));
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'feat202-r2-store-'));
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'feat202-r2-work-'));
  fs.mkdirSync(path.join(WORK, 'docs'), { recursive: true });
  fs.cpSync(path.join(REPO, 'docs', 'bugs'), path.join(WORK, 'docs', 'bugs'), { recursive: true });
  const children = [];
  try {
    const port = await freePort();
    const srv = startServer(port, DATA, STORE); children.push(srv);
    if (!await waitHealth(port)) throw new Error('server never healthy');
    const reg = await (await post(port, '/api/projects', { hostPath: WORK, name: 'feat202', applyMethod: false })).json();
    const pid = reg.project?.id;
    if (!pid) throw new Error(`register failed ${JSON.stringify(reg)}`);
    seedOutcomes(DATA, pid); seedLanes(DATA, pid);

    console.log('\n== B. GET /api/versions shape + ETag/304 ==');
    const v1 = await getJson(port, '/api/versions');
    ok('200 with a boot-prefixed body of string fingerprints', v1.status === 200 && typeof v1.body.boot === 'number' && v1.body.board && typeof v1.body.outcomes === 'string' && typeof v1.body.pending === 'string', JSON.stringify({ boot: v1.body?.boot, outcomes: v1.body?.outcomes, pending: v1.body?.pending }));
    ok('serves a strong ETag', !!v1.etag && v1.etag.startsWith('"'));
    ok('board carries the registered project id', pid in (v1.body.board || {}), `board keys: ${Object.keys(v1.body.board || {}).join(',')}`);
    const v304 = await getJson(port, '/api/versions', { 'if-none-match': v1.etag });
    ok('bodyless 304 when unchanged', v304.status === 304 && v304.body === null);

    console.log('\n== C. liveness — an on-disk change moves the right fingerprint within 5s ==');
    const base = (await getJson(port, '/api/versions')).body;
    const more = JSON.parse(fs.readFileSync(path.join(DATA, 'agent-outcomes.json'), 'utf8'));
    more.push({ id: 'out-live-new', at: Date.now(), projectId: pid, projectName: 'feat202', stationSessionId: 'cs-live', sdkSessionId: 'sdk-live', agentId: 'agent-live', row: 'agent', label: 'a fresh death', description: 'live', kind: 'failed', detail: 'the engine reported this agent failed', providerError: null, clusterId: null, dismissedAt: null, briefedAt: null });
    atomicWrite(path.join(DATA, 'agent-outcomes.json'), JSON.stringify(more, null, 2));
    const outMoved = await waitForP(port, (b) => b.outcomes !== base.outcomes, 5000);
    ok('outcomes fingerprint moves within 5s on an atomic-rename write', outMoved, `${base.outcomes} → ${(await getJson(port, '/api/versions')).body.outcomes}`);

    const base2 = (await getJson(port, '/api/versions')).body;
    const lanes = JSON.parse(fs.readFileSync(path.join(DATA, 'lanes.json'), 'utf8'));
    lanes[0].label = 'relabelled live';
    atomicWrite(path.join(DATA, 'lanes.json'), JSON.stringify(lanes, null, 2));
    const penMoved = await waitForP(port, (b) => b.pending !== base2.pending, 5000);
    ok('pending fingerprint moves within 5s on an atomic-rename write', penMoved, `${base2.pending} → ${(await getJson(port, '/api/versions')).body.pending}`);

    const base3 = (await getJson(port, '/api/versions')).body;
    const ticket = path.join(WORK, 'docs', 'bugs', 'INDEX.md');
    atomicWrite(ticket, fs.readFileSync(ticket, 'utf8') + `\n<!-- live-edit ${Date.now()} -->\n`);
    const boardMoved = await waitForP(port, (b) => (b.board[pid] || '') !== (base3.board[pid] || ''), 5000);
    ok('board fingerprint for the project moves within 5s on an external ticket edit', boardMoved, `${base3.board[pid]} → ${(await getJson(port, '/api/versions')).body.board[pid]}`);

    const base4 = (await getJson(port, '/api/versions')).body;
    await post(port, '/api/agent-outcomes/dismiss', { all: true });
    const dismissMoved = await waitForP(port, (b) => b.outcomes !== base4.outcomes, 5000);
    ok('a server-owned write (dismiss) moves the fingerprint (in-process accelerator)', dismissMoved, `${base4.outcomes} → ${(await getJson(port, '/api/versions')).body.outcomes}`);

    console.log('\n== D. restart safety — boot bumps so a held client refetches ==');
    const bootBefore = (await getJson(port, '/api/versions')).body.boot;
    srv.kill('SIGTERM');
    await sleep(1500);
    const port2 = await freePort();
    const srv2 = startServer(port2, DATA, STORE); children.push(srv2);
    if (!await waitHealth(port2)) throw new Error('restart never healthy');
    const bootAfter = (await getJson(port2, '/api/versions')).body.boot;
    ok('boot strictly increases across a restart (same data dir)', bootAfter > bootBefore, `${bootBefore} → ${bootAfter}`);
  } finally {
    for (const c of children) { try { process.kill(c.pid, 'SIGTERM'); } catch { /* */ } }
    await sleep(600); // let a just-restarted server stop writing before we rm its data dir
    for (const d of [DATA, STORE, WORK]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { await sleep(400); try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* scratch dir; leave it */ } } }
  }
}

try {
  await partA();
  await partBCD();
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
} catch (err) {
  console.error('HARNESS ERROR', err);
  process.exit(1);
}
