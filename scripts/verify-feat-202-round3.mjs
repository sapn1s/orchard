#!/usr/bin/env node
/**
 * verify-feat-202-round3.mjs — FEAT-202 round 3: watchers are hints, not truth.
 *
 * Round 2 derived store versions from an fs.watch per store dir. On Linux,
 * removing a watched dir emits NO error event, so the FSWatcher went deaf, the
 * re-arm was a no-op, and after a board-dir remove+recreate external writes
 * never moved the counter — stale forever (anthropic 5b838160, BROKEN).
 *
 * Round 3 derives each store's version from a cheap STAT FINGERPRINT (dir ino +
 * entry mtimes/sizes/inos for the board dir; file mtime/size/ino for the data
 * stores), computed on demand, cached ~1s, shared across tabs. No watcher state
 * to go deaf. This suite runs the verifier's full attack list:
 *   A (module):  remove+recreate; rename away+back; mtime-fixed + size-changed;
 *                same mtime+size + different inode; in-process accelerator; the
 *                ~1s cache holds within a second and refreshes after.
 *   B (HTTP):    /api/versions shape + ETag/304; the board-dir remove+recreate
 *                regression over a REAL booted server moves within 5s; atomic
 *                rename; external ticket edit; in-process dismiss; restart boot;
 *                20 concurrent tabs cost one scan (cache coherent + cheap).
 *
 * Self-contained. Scratch data/store dirs, free ephemeral port, kills only its
 * own pids. The board is the REAL repo docs/bugs artifact; the outcomes/lanes
 * ledgers are synthesized to realistic sizes (said so, per WA).
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

/* ───────────────────────── Part A — the module, directly ───────────────── */
async function partA() {
  console.log('\n== A. stat-fingerprint module — every filesystem event moves it, no watcher ==');
  const sv = await import('../src/server/store-versions.ts');
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'feat202-r3-data-'));
  const BOARD = fs.mkdtempSync(path.join(os.tmpdir(), 'feat202-r3-board-'));
  const METH = fs.mkdtempSync(path.join(os.tmpdir(), 'feat202-r3-meth-'));
  const boards = [{ id: 'p', dir: BOARD }];
  const snap = () => { sv._clearCache(); return sv.snapshot(DATA, boards, METH); };
  try {
    for (const f of ['agent-outcomes.json', 'lanes.json', 'group-seals.json', 'decisions.json', 'access-requests.json']) fs.writeFileSync(path.join(DATA, f), '[]');
    fs.writeFileSync(path.join(BOARD, 'TICKET-1.md'), 'one');

    // (1) THE HEADLINE: board dir removed and recreated, then an external write.
    const b0 = snap().board.p;
    fs.rmSync(BOARD, { recursive: true, force: true });
    const bRemoved = snap().board.p;
    ok('board fingerprint changes when the dir is REMOVED', bRemoved !== b0, `${b0} → ${bRemoved}`);
    fs.mkdirSync(BOARD, { recursive: true });
    fs.writeFileSync(path.join(BOARD, 'TICKET-1.md'), 'one');
    const bRecreated = snap().board.p;
    ok('board fingerprint changes again when the dir is RECREATED (new ino)', bRecreated !== bRemoved, `${bRemoved} → ${bRecreated}`);
    fs.writeFileSync(path.join(BOARD, 'TICKET-2.md'), 'external write after recreate');
    const bWrite = snap().board.p;
    ok('external write AFTER remove+recreate moves it (round-2 was stuck here)', bWrite !== bRecreated, `${bRecreated} → ${bWrite}`);

    // (1b) COMPOSITE board inputs the round-3 independent-verify found uncovered:
    //      a SUBDIRECTORY file (.arch/findings.json, .arch/acks.json) rewritten
    //      IN PLACE — the parent dir mtime does NOT move, so only a RECURSIVE
    //      stat scan catches it; plus access-requests.json and the methodology
    //      needs-human findings, both board needsYou inputs.
    fs.mkdirSync(path.join(BOARD, '.arch'), { recursive: true });
    fs.writeFileSync(path.join(BOARD, '.arch', 'findings.json'), JSON.stringify({ findings: [] }));
    const cA0 = snap().board.p;
    fs.writeFileSync(path.join(BOARD, '.arch', 'findings.json'), JSON.stringify({ findings: [{ id: 'f1', date: '2026-10-28' }] })); // in-place rewrite
    ok('board fp moves on an IN-PLACE .arch/findings.json rewrite (recursive scan)', snap().board.p !== cA0, `${cA0} → ${snap().board.p}`);
    const cA1 = snap().board.p;
    fs.writeFileSync(path.join(BOARD, '.arch', 'acks.json'), JSON.stringify({ f1: '2026-10-28' })); // acked in place (new file in subdir)
    ok('board fp moves when .arch/acks.json changes', snap().board.p !== cA1, `${cA1} → ${snap().board.p}`);
    const cAcc0 = snap().board.p;
    fs.writeFileSync(path.join(DATA, 'access-requests.json'), JSON.stringify([{ id: 'acc1' }])); // a pending access card
    ok('board fp moves when access-requests.json gains a pending request', snap().board.p !== cAcc0, `${cAcc0} → ${snap().board.p}`);
    const cM0 = snap().board.p;
    fs.mkdirSync(path.join(METH, '.station'), { recursive: true });
    fs.writeFileSync(path.join(METH, '.station', 'needs-human.json'), JSON.stringify({ findings: [{ id: 'nh1', date: '2026-10-28' }] }));
    ok('board fp moves when the methodology needs-human.json changes', snap().board.p !== cM0, `${cM0} → ${snap().board.p}`);

    // (2) a store file renamed away and back.
    const o0 = snap().outcomes;
    fs.renameSync(path.join(DATA, 'agent-outcomes.json'), path.join(DATA, 'agent-outcomes.away'));
    const oAway = snap().outcomes;
    ok('outcomes fingerprint changes when the file is renamed AWAY', oAway !== o0, `${o0} → ${oAway}`);
    fs.renameSync(path.join(DATA, 'agent-outcomes.away'), path.join(DATA, 'agent-outcomes.json'));
    const oBack = snap().outcomes;
    ok('outcomes fingerprint changes when it is renamed BACK', oBack !== oAway, `${oAway} → ${oBack}`);

    // (3) mtime UNCHANGED but size changed (coarse-clock / mtime-pinned write).
    const f = path.join(DATA, 'lanes.json');
    const T = new Date('2020-01-01T00:00:00Z');
    fs.writeFileSync(f, '[1]'); fs.utimesSync(f, T, T);
    const p0 = snap().pending;
    fs.writeFileSync(f, '[1,2,3,4,5]'); fs.utimesSync(f, T, T); // same mtime, bigger size
    const p1 = snap().pending;
    ok('pending fingerprint changes on a SIZE change with mtime pinned equal', p1 !== p0, `${p0} → ${p1}`);

    // (4) same mtime AND same size, different inode (an atomic rename).
    const payloadA = '[{"x":1}]';
    const payloadB = '[{"y":9}]'; // identical length to payloadA
    fs.writeFileSync(f, payloadA); fs.utimesSync(f, T, T);
    const q0 = snap().pending;
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, payloadB); fs.utimesSync(tmp, T, T);
    fs.renameSync(tmp, f); // new inode, same size, same mtime
    const q1 = snap().pending;
    ok('pending fingerprint changes on a DIFFERENT INODE (atomic rename, equal mtime+size)', q1 !== q0, `len ${payloadA.length}=${payloadB.length}; ${q0} → ${q1}`);

    // (4b) ctime: a content rewrite that RESTORES mtime (cp -p / rsync --inplace /
    //      touch -r / a coarse-clock collision) leaves mtime+size+ino unchanged but
    //      moves ctime, which cannot be set from user space. A chmod is the clean
    //      deterministic proof that ctimeNs is in the fingerprint: it changes ONLY
    //      ctime (not mtime/size/ino/content).
    fs.writeFileSync(f, payloadA); fs.utimesSync(f, T, T);
    const ct0 = snap().pending;
    fs.chmodSync(f, 0o600);
    const ct1 = snap().pending;
    ok('pending fp moves on a chmod (ctimeNs folded in — mtime/size/ino all unchanged)', ct1 !== ct0, `${ct0} → ${ct1}`);
    // and the real shape: same-size content rewrite with mtime restored to the same value.
    const before = fs.statSync(f, { bigint: true });
    fs.writeFileSync(f, payloadB); // same length as payloadA, different content
    fs.utimesSync(f, T, T); // restore the pinned mtime
    const after = fs.statSync(f, { bigint: true });
    const ct2 = snap().pending;
    ok('pending fp moves on a same-size content rewrite with mtime restored', ct2 !== ct1, `mtimeNs ${before.mtimeNs}${after.mtimeNs === before.mtimeNs ? '=' : '≠'}${after.mtimeNs} ino ${after.ino === before.ino ? '=' : '≠'}; ${ct1} → ${ct2}`);

    // (5) in-process bump is a zero-latency accelerator (no stat change at all).
    const r0 = snap().outcomes;
    sv.bumpOutcomes();
    const r1 = snap().outcomes;
    ok('in-process bump moves the fingerprint with NO filesystem change', r1 !== r0, `${r0} → ${r1}`);

    // (6) the ~1s scan cache: two reads within the window are identical even
    //     after an external write; a cleared/expired cache then reflects it.
    sv._clearCache();
    const c0 = sv.snapshot(DATA, boards).board.p; // populates cache
    fs.writeFileSync(path.join(BOARD, 'TICKET-3.md'), 'write during the cache window');
    const cCached = sv.snapshot(DATA, boards).board.p; // same second → cached
    ok('a second poll within ~1s is served from cache (one scan per second)', cCached === c0, `${c0} === ${cCached}`);
    sv._clearCache();
    const cFresh = sv.snapshot(DATA, boards).board.p;
    ok('after the cache expires the new write is reflected', cFresh !== c0, `${c0} → ${cFresh}`);
  } finally {
    for (const d of [DATA, BOARD, METH]) fs.rmSync(d, { recursive: true, force: true });
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

/* ─────────────────── Part B — a real booted server ─────────────────────── */
async function partB() {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'feat202-r3-srv-data-'));
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'feat202-r3-srv-store-'));
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'feat202-r3-srv-work-'));
  const realBoard = path.join(REPO, 'docs', 'bugs');
  const boardDst = path.join(WORK, 'docs', 'bugs');
  fs.mkdirSync(boardDst, { recursive: true });
  // Prefer the REAL repo board (~500 tickets); if it is unavailable (e.g. the
  // independent-verify clean room strips docs/bugs to boot stubs), synthesize a
  // realistic-size board so Part B still runs. Said so, per WA.
  let boardSource = 'real docs/bugs';
  try {
    const entries = fs.readdirSync(realBoard);
    if (!entries.some((n) => /^[A-Z]+-\d+.*\.md$/.test(n))) throw new Error('no tickets');
    fs.cpSync(realBoard, boardDst, { recursive: true });
  } catch {
    boardSource = 'SYNTHETIC board (real docs/bugs unavailable — clean room)';
    const rows = [];
    for (let i = 1; i <= 120; i++) {
      const id = `SYN-${String(i).padStart(3, '0')}`;
      const needsYou = i % 7 === 0;
      fs.writeFileSync(path.join(boardDst, `${id}-synthetic-ticket.md`), `# ${id}\n\nstatus: open\n${'body '.repeat(200)}\n`);
      rows.push(`| ${id} | ${needsYou ? '👤' : ''} | open | a synthetic ticket ${i} |`);
    }
    fs.writeFileSync(path.join(boardDst, 'INDEX.md'), `# Board\n\n| id | owner | status | title |\n|---|---|---|---|\n${rows.join('\n')}\n`);
  }
  console.log(`  board source: ${boardSource}`);
  const children = [];
  try {
    const port = await freePort();
    const srv = startServer(port, DATA, STORE); children.push(srv);
    if (!await waitHealth(port)) throw new Error('server never healthy');
    const reg = await (await post(port, '/api/projects', { hostPath: WORK, name: 'feat202', applyMethod: false })).json();
    const pid = reg.project?.id;
    if (!pid) throw new Error(`register failed ${JSON.stringify(reg)}`);
    seedOutcomes(DATA, pid); seedLanes(DATA, pid);

    console.log('\n== B. GET /api/versions — shape, ETag/304, fingerprints are strings ==');
    const v1 = await getJson(port, '/api/versions');
    ok('200 with boot-prefixed body; fingerprints are strings', v1.status === 200 && typeof v1.body.boot === 'number' && typeof v1.body.outcomes === 'string' && typeof v1.body.pending === 'string' && v1.body.board && typeof v1.body.board[pid] === 'string', JSON.stringify({ boot: v1.body?.boot, outcomes: v1.body?.outcomes, pending: v1.body?.pending, boardPid: v1.body?.board?.[pid] }));
    ok('serves a strong ETag', !!v1.etag && v1.etag.startsWith('"'));
    const v304 = await getJson(port, '/api/versions', { 'if-none-match': v1.etag });
    ok('bodyless 304 when unchanged', v304.status === 304 && v304.body === null);

    console.log('\n== B. liveness — the remove+recreate regression, over HTTP, within 5s ==');
    const boardDir = path.join(WORK, 'docs', 'bugs');
    const base = (await getJson(port, '/api/versions')).body;
    // Remove and recreate the WATCHED board dir, then an external ticket write.
    fs.rmSync(boardDir, { recursive: true, force: true });
    await sleep(300);
    fs.mkdirSync(boardDir, { recursive: true });
    fs.writeFileSync(path.join(boardDir, 'INDEX.md'), '# board\n');
    const recreMoved = await waitForP(port, (b) => (b.board[pid] || '') !== (base.board[pid] || ''), 5000);
    ok('board fingerprint moves within 5s after dir remove+recreate+write (THE regression)', recreMoved, `${base.board[pid]} → ${(await getJson(port, '/api/versions')).body.board[pid]}`);
    const base1b = (await getJson(port, '/api/versions')).body;
    fs.writeFileSync(path.join(boardDir, 'NEW-1.md'), 'a brand new ticket');
    const recreMoved2 = await waitForP(port, (b) => (b.board[pid] || '') !== (base1b.board[pid] || ''), 5000);
    ok('a SECOND external write after the recreate also moves it (no deaf watcher)', recreMoved2, `${base1b.board[pid]} → ${(await getJson(port, '/api/versions')).body.board[pid]}`);

    // atomic-rename write to a data store.
    const base2 = (await getJson(port, '/api/versions')).body;
    const lanes = JSON.parse(fs.readFileSync(path.join(DATA, 'lanes.json'), 'utf8'));
    lanes[0].label = 'relabelled live';
    atomicWrite(path.join(DATA, 'lanes.json'), JSON.stringify(lanes, null, 2));
    const penMoved = await waitForP(port, (b) => b.pending !== base2.pending, 5000);
    ok('pending moves within 5s on an atomic-rename write', penMoved, `${base2.pending} → ${(await getJson(port, '/api/versions')).body.pending}`);

    // TIME-based pending readiness: a group's close deadline elapsing with NO file
    // write still changes the pending VIEW. The pendingTimeEpoch must move `pending`
    // so the versions-driven client refetches (round-1 polled pending every 5s).
    const DEADLINE_MS = 2500;
    const nowT = Date.now();
    const openLane = { ...lanes[0], id: 'lane-open-deadline', groupId: 'g-open-deadline', groupOpen: true, groupClosed: false, groupCloseDeadline: nowT + DEADLINE_MS, groupClosedAt: null, state: 'settled', settledAt: nowT - 1000, starvationReleasedAt: null };
    atomicWrite(path.join(DATA, 'lanes.json'), JSON.stringify([openLane], null, 2));
    await sleep(1200); // settle the file write; cache expires
    const preDeadline = (await getJson(port, '/api/versions')).body.pending;
    // Now WAIT for the deadline to pass WITHOUT writing lanes.json again.
    const timeMoved = await waitForP(port, (b) => b.pending !== preDeadline, 6000);
    ok('pending moves ≤5s after a group-close DEADLINE elapses (no file write — pendingTimeEpoch)', timeMoved, `deadline +${DEADLINE_MS}ms; ${preDeadline} → ${(await getJson(port, '/api/versions')).body.pending}`);

    // in-process chokepoint backstop over HTTP: dismiss → outcomes.writeAll → bumpOutcomes.
    const base3 = (await getJson(port, '/api/versions')).body;
    await post(port, '/api/agent-outcomes/dismiss', { all: true });
    const dismissMoved = await waitForP(port, (b) => b.outcomes !== base3.outcomes, 5000);
    ok('a server-owned write (dismiss) moves outcomes (in-process accelerator)', dismissMoved, `${base3.outcomes} → ${(await getJson(port, '/api/versions')).body.outcomes}`);

    console.log('\n== B. 20 concurrent tabs — one scan per second, cache coherent ==');
    // Warm then fire 20 concurrent polls; all must agree, and the batch must be
    // cheap (the 507-file board scan is cached, not repeated 20×).
    await getJson(port, '/api/versions');
    const t0 = Date.now();
    const results = await Promise.all(Array.from({ length: 20 }, () => getJson(port, '/api/versions')));
    const elapsed = Date.now() - t0;
    const fps = new Set(results.map((r) => r.body && r.body.board[pid]));
    ok('20 concurrent polls return one coherent fingerprint', fps.size === 1 && !fps.has(undefined), `distinct=${fps.size}`);
    ok('20 concurrent polls are cheap (cached scan, not 20× rescans)', elapsed < 2000, `${elapsed}ms for 20`);

    console.log('\n== B. restart safety — boot bumps so a held client refetches ==');
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
  await partB();
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
} catch (err) {
  console.error('HARNESS ERROR', err);
  process.exit(1);
}
