#!/usr/bin/env node
/**
 * FEAT-175 — END-TO-END proof that a container project's container follows its git-write grant, but never
 * under live work. Runs a REAL scratch Orchard server on the FEAT-158 sandbox daemon, with a fake in-container
 * CLI (scripts/fixtures/feat-175/fake-container-cli.mjs) through the ORCHARD_TEST_CONTAINER_CLI seam, and
 * drives real WS/outbox paths. The decision logic is proved in verify-feat-175-grant-rebuild-unit.mjs (42/0).
 *
 *   npm run sandbox:docker -- up && eval "$(npm run -s sandbox:docker -- env)"
 *   node scripts/verify-feat-175-grant-rebuild.mjs [--tree <dir>] [--only P1,P2] [--no-shots]
 *
 * `--tree <dir>` runs the scratch SERVER from another checkout (for the must-FAIL on HEAD: export HEAD with
 *   `git archive HEAD | tar -x -C <tmp>` and symlink node_modules into it). The fixtures/helpers always come
 *   from THIS tree. Each MF-marked property FAILs on a pre-FEAT-175 tree (no reconciler).
 *
 * ISOLATION: assertIsolatedDocker FIRST (refuses the host daemon, takes the sandbox lock). The server's docker
 * goes through a pass-through shim (CLAUDE_STATION_DOCKER) that can inject ONE `docker create` failure for a
 * named container (P5). We act only on containers/images OUR scratch data dir owns (owner label), cleaned up at
 * the end. No host daemon, no live service/port/data dir, no pkill, no git writes.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

import { assertIsolatedDocker } from './lib/docker-sandbox.mjs';
import { isolatedServerEnv } from './lib/station-boot.mjs';
import { ownerKeyFor, removeOwnedContainer } from './lib/owned-docker.mjs';

const { target: TARGET } = assertIsolatedDocker('verify-feat-175-grant-rebuild');

const REPO = path.resolve(import.meta.dirname, '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const SRC_TREE = arg('--tree') ? path.resolve(arg('--tree')) : REPO;
const ONLY = arg('--only') ? new Set(arg('--only').split(',')) : null;
const want = (id) => !ONLY || ONLY.has(id);
const DO_SHOTS = !process.argv.includes('--no-shots');
const SHOTS = '/tmp/feat175-shots';
const CLI_VERSION = '9.9.175-feat175';
// How long to wait for a reconciler-driven rebuild. Default 240s (a real idle-session reap drains ~120s).
// On a pre-FEAT-175 tree no rebuild ever comes, so the MF run sets this low to prove absence quickly.
const REBUILD_WAIT = Number(process.env.F175_REBUILD_WAIT_MS) || 240_000;
const FAKE_CLI = path.join(REPO, 'scripts', 'fixtures', 'feat-175', 'fake-container-cli.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const mfLines = [];
function check(name, ok, obs, { mf = false } = {}) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${mf ? '(MF) ' : ''}${name}\n        observed: ${typeof obs === 'string' ? obs : JSON.stringify(obs)}`);
  ok ? pass++ : fail++;
  if (mf) mfLines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  return ok;
}

/* ------------------------------------------------------------------ scratch dirs + docker shim */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feat175-e2e-'));
const DATA = path.join(TMP, 'data');
const HOME = path.join(TMP, 'home');
const WORK = path.join(TMP, 'work');
for (const d of [DATA, WORK, path.join(HOME, '.claude', 'projects')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(HOME, '.claude', '.credentials.json'), '{}\n');

// P5: the shim fails `docker create` for a container whose name is written in this flag file, once per presence.
const FAIL_FLAG = path.join(TMP, 'fail-create');
// r2: the shim makes `docker inspect` of the container named here fail like an unreachable daemon.
const FAIL_INSPECT = path.join(TMP, 'fail-inspect');
const SHIM = path.join(TMP, 'docker-shim');
fs.writeFileSync(SHIM, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const FLAG = ${JSON.stringify(FAIL_FLAG)};
const argv = process.argv.slice(2);
const FI = ${JSON.stringify(FAIL_INSPECT)};
if (argv[0] === 'inspect') {
  let n = '';
  try { n = fs.readFileSync(FI, 'utf8').trim(); } catch {}
  if (n && argv.includes(n)) { process.stderr.write('Cannot connect to the Docker daemon (FEAT-175 injected)\\n'); process.exit(1); }
}
if (argv[0] === 'create') {
  let name = '';
  try { name = fs.readFileSync(FLAG, 'utf8').trim(); } catch {}
  if (name && argv.some((a) => a === name || a.startsWith(name + '-') || a.startsWith(name + '.'))) {
    process.stderr.write('FEAT-175 injected docker create failure for ' + name + '\\n');
    process.exit(1);
  }
}
const child = spawn('docker', argv, { stdio: ['inherit', 'pipe', 'pipe'] });
child.stdout.on('data', (d) => process.stdout.write(d));
child.stderr.on('data', (d) => process.stderr.write(d));
process.stdout.on('error', () => process.exit(1));
child.on('close', (c) => process.stdout.write('', () => process.exit(c ?? 1)));
child.on('error', (e) => { process.stderr.write(String(e.message)); process.exit(127); });
`);
fs.chmodSync(SHIM, 0o755);

/* ------------------------------------------------------------------ docker helpers (direct, real daemon) */
const dkEnv = { ...process.env, DOCKER_HOST: TARGET };
const dk = (args, timeout = 120_000) => { const r = spawnSync('docker', args, { encoding: 'utf8', env: dkEnv, timeout }); return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }; };
const cidOf = (name) => { const r = dk(['inspect', name, '--format', '{{.Id}}']); return r.code === 0 ? r.out : null; };
const startedAtOf = (name) => { const r = dk(['inspect', name, '--format', '{{.State.StartedAt}}']); return r.code === 0 ? Date.parse(r.out) : null; };
/** touch+rm a probe file in <workdir>/.git inside the container: exit 0 = writable, non-zero (EROFS) = read-only. */
function gitWritable(container, workdir) {
  const r = dk(['exec', container, 'sh', '-c', `touch ${workdir}/.git/feat175-probe && rm ${workdir}/.git/feat175-probe`], 20_000);
  return { writable: r.code === 0, detail: r.code === 0 ? 'touch+rm ok' : (r.err || `exit ${r.code}`).slice(0, 120) };
}

/* ------------------------------------------------------------------ server boot */
let base = '', serverLog = '', serverProc = null;
const createdContainers = new Set();
async function freePort() { return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }
async function boot() {
  const port = await freePort();
  const env = isolatedServerEnv({
    PORT: String(port), CLAUDE_STATION_DATA: DATA, DOCKER_HOST: TARGET, CLAUDE_STATION_DOCKER: SHIM,
    HOME, CLAUDE_PROJECTS_DIR: path.join(HOME, '.claude', 'projects'), ORCHARD_DISPATCH_SOCK: '',
    ORCHARD_TEST_CONTAINER_CLI: FAKE_CLI, ORCHARD_TEST_CONTAINER_CLI_VERSION: CLI_VERSION,
    CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0',
  });
  const proc = spawn(process.execPath, [path.join(SRC_TREE, 'src', 'server', 'index.ts')], { cwd: SRC_TREE, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (d) => { serverLog = (serverLog + d).slice(-60000); });
  proc.stderr.on('data', (d) => { serverLog = (serverLog + d).slice(-60000); });
  serverProc = proc;
  // If this suite is killed (a verifier timeout), its scratch server must not outlive it holding the sandbox lock.
  spawn(process.execPath, ['-e', `const p=${process.pid},c=${proc.pid};setInterval(()=>{try{process.kill(c,0)}catch{process.exit(0)}try{process.kill(p,0)}catch{try{process.kill(c,'SIGKILL')}catch{}process.exit(0)}},1000)`], { detached: true, stdio: 'ignore' }).unref();
  base = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let i = 0; i < 200 && !healthy; i++) { try { const r = await fetch(`${base}/api/health`); if (r.ok) healthy = true; } catch { /* */ } if (proc.exitCode !== null) throw new Error(`server exited early (${proc.exitCode}): ${serverLog.slice(-2000)}`); if (!healthy) await sleep(250); }
  if (!healthy) throw new Error(`server never healthy: ${serverLog.slice(-2000)}`);
  for (let i = 0; i < 240 && !/base-pin migration (done|skipped)/.test(serverLog); i++) await sleep(250);
}

/** Stop the scratch server (only ours) and wait for it to exit. */
async function stopServer() {
  if (!serverProc || serverProc.exitCode !== null) return;
  try { process.kill(serverProc.pid, 'SIGTERM'); } catch { /* */ }
  for (let i = 0; i < 100 && serverProc.exitCode === null; i++) await sleep(200);
  if (serverProc.exitCode === null) { try { process.kill(serverProc.pid, 'SIGKILL'); } catch { /* */ } await sleep(500); }
}
async function api(p, method = 'GET', body) {
  const r = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* */ }
  return { status: r.status, body: j };
}
const statusOf = async (pid) => (await api(`/api/projects/${pid}/container/status`)).body;
async function health() { try { return await (await fetch(`${base}/api/health`)).json(); } catch { return null; } }
async function sdkIdFor(station) {
  const h = await health();
  return (h?.sessions ?? []).find((s) => s.stationSessionId === station)?.sdkSessionId ?? null;
}

/* ------------------------------------------------------------------ WS client */
function openWs() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${base.split(':')[2]}/ws`);
    const events = [];
    ws.on('message', (raw) => { try { events.push({ at: Date.now(), ...JSON.parse(String(raw)) }); } catch { /* */ } });
    ws.once('open', () => res({ ws, events, send: (o) => ws.send(JSON.stringify(o)), close: () => { try { ws.close(); } catch { /* */ } } }));
    ws.once('error', rej);
    ws.on('error', () => { /* dropped */ });
  });
}
async function waitFor(pred, ms = 60_000, every = 250) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await pred(); if (v) return v; await sleep(every); } return null; }
const waitEv = (c, pred, ms = 90_000) => waitFor(() => c.events.find(pred), ms);

/* ------------------------------------------------------------------ project + session helpers */
function makeGitRepo(name) {
  const dir = path.join(WORK, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  // A minimal real .git directory, built by hand: agent `git init/add/commit` are blocked by the git-write
  // guard hook, and a plain directory is all the BUG-244 overlay oracle (gitDirsOf/isGitDirItself) needs —
  // HEAD + objects/ + refs/ make it a git dir. Verified in-process: no grant → read-only overlay; grant → gone.
  const gd = path.join(dir, '.git');
  fs.mkdirSync(path.join(gd, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(gd, 'refs', 'heads'), { recursive: true });
  fs.mkdirSync(path.join(gd, 'refs', 'tags'), { recursive: true });
  fs.writeFileSync(path.join(gd, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(gd, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n');
  return dir;
}
async function registerProject(name) {
  const dir = makeGitRepo(name);
  const r = await api('/api/projects', 'POST', { hostPath: dir, name: `f175-${name}`, isolation: 'container', settings: { container: { gpu: 'off' }, tools: { serena: false, playwright: false, openaiDispatch: false } } });
  const id = r.body?.project?.id;
  if (!id) throw new Error(`register ${name} failed: ${JSON.stringify(r)}`);
  const st = await statusOf(id);
  const cname = st?.containerName || `claude-station-${id}`;
  createdContainers.add(cname);
  return { id, dir, cname, hostPath: dir };
}
/** Start a session; wait for the start ack and the sdkSessionId. */
async function startSession(projectId, prompt, extra = {}) {
  const c = await openWs();
  c.send({ type: 'start', projectId, prompt, ...extra, overrides: { permissionMode: 'default', ...(extra.overrides ?? {}) } });
  const ack = await waitEv(c, (e) => (e.t === 'ack' && e.of === 'start'), 180_000);
  if (!ack) { c.close(); throw new Error(`start never acked for ${projectId}: ${JSON.stringify(c.events.slice(-6))}`); }
  const station = ack.stationSessionId;
  const sdk = await waitFor(() => sdkIdFor(station), 60_000);
  return { c, station, sdk };
}
const grant = (pid, body) => api(`/api/projects/${pid}/git-write-grant`, 'POST', body);
const revoke = (pid) => api(`/api/projects/${pid}/git-write-grant`, 'DELETE');
// FEAT-164 resolved model: a STANDING grant opens the container .git only in mode 'scoped' (commit + a scope
// note) via the policy route; release mode (commit, no note) keeps it read-only by design.
const scopedGrant = (pid, note) => api(`/api/projects/${pid}/git-write-policy`, 'PUT', { commit: true, push: false, scope: note });
const releaseGrant = (pid) => api(`/api/projects/${pid}/git-write-grant`, 'POST', { scope: 'permanent' });
const revokePolicy = (pid) => api(`/api/projects/${pid}/git-write-policy`, 'DELETE');
/** The client's queueRefusedSend path: POST /api/outbox for a session (keyed on its sdkSessionId). */
const outboxPost = (sdk, projectId, text, origin = 'direct') => api('/api/outbox', 'POST', { session: sdk, project: projectId, nonce: `n-${crypto.randomUUID()}`, text, origin });
const outboxGet = async (sdk) => (await api(`/api/outbox?session=${encodeURIComponent(sdk)}`)).body;

const recvTexts = (dir) => { try { return fs.readFileSync(path.join(dir, '.feat175-received.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
/** Make an EXISTING container writable via an idle loosening rebuild (duration grant), returning its id. */
async function makeWritable(p, minutes) {
  const idle = await startSession(p.id, 'hello');
  await waitEv(idle.c, (e) => e.t === 'result' || e.t === 'ack', 30_000);
  await sleep(1500);
  const c0 = cidOf(p.cname);
  const g = await grant(p.id, { scope: 'duration', minutes });
  const id = await waitFor(async () => { const x = cidOf(p.cname); return x && x !== c0 && gitWritable(p.cname, `/workspace/${p.id}`).writable ? x : null; }, REBUILD_WAIT);
  idle.c.close();
  return { id, grant: g.body?.grant };
}
/* ------------------------------------------------------------------ cleanup */
let OWNER = '';
async function cleanup() {
  if (serverProc && serverProc.exitCode === null) { try { process.kill(serverProc.pid, 'SIGTERM'); } catch { /* */ } for (let i = 0; i < 40 && serverProc.exitCode === null; i++) await sleep(200); if (serverProc.exitCode === null) { try { process.kill(serverProc.pid, 'SIGKILL'); } catch { /* */ } } }
  try { OWNER = OWNER || (await ownerKeyFor(DATA)); } catch { /* */ }
  for (const n of createdContainers) { try { removeOwnedContainer(n, OWNER); } catch { /* */ } }
  // Sweep any container/image OUR data dir owns (smoke/rtbuild leftovers), filtered strictly to our owner key.
  if (/^[0-9a-f]{16}$/.test(OWNER)) {
    for (const id of dk(['ps', '-aq', '--filter', `label=claude-station.owner=${OWNER}`]).out.split('\n').filter(Boolean)) dk(['rm', '-f', '-v', id]);
    for (const id of dk(['images', '-q', '--filter', `label=claude-station.owner=${OWNER}`]).out.split('\n').filter(Boolean)) dk(['image', 'rm', '-f', id]);
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
}

/* ================================================================== PROPERTIES */
async function P1s() {
  console.log('\n--- P1s (MF): a SCOPED grant during a LIVE turn never recreates until idle, then recreates writable');
  const p = await registerProject('p1s');
  const s = await startSession(p.id, '[[sleep:25000]]');
  const c0 = cidOf(p.cname);
  const g0 = gitWritable(p.cname, `/workspace/${p.id}`);
  check('P1s baseline: .git is read-only (BUG-244 overlay) and a turn is running', !g0.writable && !!(await statusOf(p.id)), `writable=${g0.writable} (${g0.detail})`, { mf: true });
  // While the turn is busy, grant a SCOPED standing policy (commit + a scope note) — the FEAT-164 shape that opens
  // the container .git (release-mode permanent would NOT; see P1r).
  const gr = await scopedGrant(p.id, 'FEAT-175 e2e: agent may commit here');
  check('P1s scoped grant accepted (mode scoped)', gr.status === 200, `status=${gr.status} summary=${JSON.stringify(gr.body?.summary)}`);
  let samples = [];
  for (let i = 0; i < 4; i++) { const st = await statusOf(p.id); samples.push({ id: cidOf(p.cname) === c0, ro: !gitWritable(p.cname, `/workspace/${p.id}`).writable, phase: st?.grantRebuild?.phase ?? null }); await sleep(2500); }
  check('P1s while the turn runs: container id unchanged, .git still read-only, grantRebuild pending', samples.every((x) => x.id && x.ro && x.phase === 'pending'), JSON.stringify(samples), { mf: true });
  const recreated = await waitFor(async () => { const id = cidOf(p.cname); return id && id !== c0 && gitWritable(p.cname, `/workspace/${p.id}`).writable ? id : null; }, REBUILD_WAIT);
  const closed = s.c.events.find((e) => e.t === 'session-closed');
  check('P1s after idle: the container is RECREATED (new id) and .git is writable', !!recreated && recreated !== c0, `c0=${(c0 ?? '').slice(0, 12)} c1=${(recreated ?? '').slice(0, 12)}`, { mf: true });
  check('P1s the tab received session-closed {resumable:true}', closed?.resumable === true, JSON.stringify(closed ?? null), { mf: true });
  s.c.close();
}

async function P1r() {
  console.log('\n--- P1r: a RELEASE-mode permanent grant (commit, NO scope note) causes NO recreate — .git stays read-only by design (FEAT-164)');
  const p = await registerProject('p1r');
  const s = await startSession(p.id, 'hello');
  await waitEv(s.c, (e) => e.t === 'result' || e.t === 'ack', 30_000);
  await sleep(1500);
  const c0 = cidOf(p.cname);
  const g = await releaseGrant(p.id);
  await sleep(12_000); // several reconciler ticks
  const st = await statusOf(p.id);
  const writable = gitWritable(p.cname, `/workspace/${p.id}`).writable;
  check('P1r release-mode grant: no recreate, .git stays read-only, no grant rebuild pending (release never opens the container)',
    g.status === 200 && cidOf(p.cname) === c0 && !writable && (st?.grantRebuild ?? null) === null,
    `grantStatus=${g.status} unchanged=${cidOf(p.cname) === c0} writable=${writable} grantRebuild=${JSON.stringify(st?.grantRebuild ?? null)}`);
  s.c.close();
}

async function PCORE() {
  console.log('\n--- PCORE: hold + outbox + tightening machinery via the WORKING (duration) trigger (P1-P4 essence)');
  const p = await registerProject('pcore');
  // 0) an idle session, so the container exists for a loosening rebuild to act on.
  const idle = await startSession(p.id, 'hello');
  await waitEv(idle.c, (e) => e.t === 'result' || e.t === 'ack', 30_000);
  await sleep(1500);
  const c0 = cidOf(p.cname);
  // 1) loosening rebuild while idle: a duration grant makes .git writable (idle session reaped+resumable).
  await grant(p.id, { scope: 'duration', minutes: 6 });
  const writable = await waitFor(async () => { const id = cidOf(p.cname); return id && id !== c0 && gitWritable(p.cname, `/workspace/${p.id}`).writable ? id : null; }, REBUILD_WAIT);
  check('PCORE loosening: a duration grant recreated the EXISTING container writable while idle', !!c0 && !!writable && writable !== c0, `c0=${(c0 ?? '').slice(0, 12)} writable=${(writable ?? '').slice(0, 12)}`);
  idle.c.close();
  // 2) start a BUSY turn, then REVOKE (tightening) → pending + holds while the turn runs.
  const s = await startSession(p.id, '[[sleep:45000]]');
  await sleep(1500);
  await revoke(p.id);
  const pend = await waitFor(async () => { const gr = (await statusOf(p.id))?.grantRebuild; return gr && gr.phase === 'pending' && gr.tightens ? gr : null; }, 30_000);
  check('PCORE tightening: revoke while a turn runs → grantRebuild pending, tightens, holds', !!pend && pend.holds === true, JSON.stringify(pend));
  const cDuringBusy = cidOf(p.cname);
  const writDuringBusy = gitWritable(p.cname, `/workspace/${p.id}`).writable;
  check('PCORE during the busy turn: container unchanged and .git still WRITABLE (over-run; work in flight is never cut)', cDuringBusy === writable && writDuringBusy, `unchanged=${cDuringBusy === writable} writable=${writDuringBusy}`);
  // 3) three WS sends to the busy session are each refused retryably; collect ALL refusals BEFORE enqueuing
  //    (once a row is in the outbox, further sends correctly return 'outbox-pending' — BUG-217 — not rebuild-hold).
  const msgs = ['PCORE-MSG-1', 'PCORE-MSG-2', 'PCORE-MSG-3', 'PCORE-MSG-4-direct'];
  const refusals = [];
  for (let i = 0; i < 3; i++) {
    const sendId = `sid-${i}-${crypto.randomUUID()}`;
    s.c.send({ type: 'send', prompt: msgs[i], sendId });
    const err = await waitEv(s.c, (e) => e.t === 'error' && e.of === 'send' && e.sendId === sendId, 15_000);
    refusals.push(err?.code);
  }
  // now enqueue all four the way the client's queueRefusedSend does (POST /api/outbox), in order.
  for (const m of msgs) await outboxPost(s.sdk, p.id, m, 'direct');
  check('PCORE the 3 WS sends during the hold were refused retryably with code rebuild-hold', refusals.every((c) => c === 'rebuild-hold'), JSON.stringify(refusals));
  const ob = await outboxGet(s.sdk);
  check('PCORE the 4 queued messages are in the outbox with a rebuild hold', (ob?.rows?.length ?? 0) === 4 && ob?.hold?.kind === 'rebuild', `rows=${ob?.rows?.length} hold=${JSON.stringify(ob?.hold)}`);
  // 4) turn ends → reap + recreate read-only; outbox delivers the 4 in order, once each, on the NEW container.
  const roAgain = await waitFor(async () => { const id = cidOf(p.cname); return id && id !== writable && !gitWritable(p.cname, `/workspace/${p.id}`).writable ? id : null; }, REBUILD_WAIT);
  const newStartedAt = startedAtOf(p.cname);
  check('PCORE after the turn ends: recreated read-only again (tightening applied, new id)', !!roAgain && roAgain !== writable, `writable=${(writable ?? '').slice(0, 12)} ro=${(roAgain ?? '').slice(0, 12)}`);
  // Wait on the SERVER's own delivered signal (the outbox) first, then read the fake's received log (which the
  // resumed CLI, running on the NEW container, appends to the bind-mounted project dir).
  const obAfter = await waitFor(async () => { const v = await outboxGet(s.sdk); return (v?.rows?.length ?? 99) === 0 && (v?.recent ?? []).filter((r) => r.state === 'delivered').length >= 4 ? v : null; }, 180_000);
  const delivered = (obAfter?.recent ?? []).filter((r) => r.state === 'delivered').length;
  check('PCORE GET /api/outbox shows all 4 rows delivered (none still queued)', !!obAfter && delivered >= 4, `queued=${obAfter?.rows?.length} deliveredRecent=${delivered}`);
  // The outbox delivers the queued rows to the resumed session; they may arrive batched into one resume prompt
  // (with per-message "[msg N/4 …]" headers) or as separate frames. Extract the ordered markers either way.
  const received = await waitFor(() => { try { const rows = fs.readFileSync(path.join(p.dir, '.feat175-received.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); const got = rows.filter((r) => /PCORE-MSG/.test(r.text)); const markers = got.flatMap((r) => r.text.match(/PCORE-MSG-[\w-]+/g) ?? []); return markers.length >= 4 ? { got, markers } : null; } catch { return null; } }, 90_000);
  const order = received?.markers ?? [];
  const once = new Set(order).size === order.length;
  check('PCORE the queued messages were delivered to the resumed session in order, exactly once', JSON.stringify(order) === JSON.stringify(msgs) && once, JSON.stringify(order));
  const afterNew = (received?.got ?? []).every((r) => newStartedAt && Date.parse(r.at) >= newStartedAt - 1500);
  check('PCORE none were delivered before the NEW container existed (delivery timestamp >= its StartedAt)', !!received && afterNew, `startedAt=${new Date(newStartedAt || 0).toISOString()} deliveredAt=${received?.got?.map((r) => r.at).join(',')}`);
  // over-run logged
  let applied = null, pendingEv = null;
  try { const log = fs.readFileSync(path.join(DATA, 'grant-rebuild.log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.projectId === p.id); applied = log.find((x) => x.event === 'applied' && x.tightens); pendingEv = log.find((x) => x.event === 'pending' && x.tightens); } catch { /* */ }
  check('PCORE the over-run is logged: a pending(tightens) event and an applied event with overrunMs > 0', !!pendingEv && !!applied && applied.overrunMs > 0, `pending=${!!pendingEv} applied.overrunMs=${applied?.overrunMs}`);
  s.c.close();
}


async function P3P9() {
  console.log('\n--- P3 (MF): a NEW session start during a tightening hold waits (no ack, no lease) and runs on the NEW container; P9 (MF): an abandoned waiting start runs nothing');
  const p = await registerProject('p3');
  const w = await makeWritable(p, 10);
  check('P3 setup: container made writable by an idle duration grant', !!w.id, String(w.id ?? '').slice(0, 12));
  const busy = await startSession(p.id, '[[sleep:40000]]');
  await sleep(1500);
  await revoke(p.id);
  await waitFor(async () => (await statusOf(p.id))?.grantRebuild?.phase === 'pending', 30_000);
  const a = await openWs();
  a.send({ type: 'start', projectId: p.id, prompt: 'P3-NEW-SESSION-PROMPT', overrides: { permissionMode: 'default' } });
  const b = await openWs();
  b.send({ type: 'start', projectId: p.id, prompt: 'P9-ABANDONED-PROMPT', overrides: { permissionMode: 'default' } });
  const waiting = await waitEv(a, (e) => e.t === 'status' && /^waiting: /.test(e.status ?? ''), 20_000);
  await sleep(4000);
  check('P3 while held: the new start shows "waiting: …" and is NOT acked', !!waiting && !a.events.some((e) => e.t === 'ack' && e.of === 'start'), `waiting=${JSON.stringify(waiting?.status?.slice(0, 120) ?? null)} acked=${a.events.some((e) => e.t === 'ack' && e.of === 'start')}`, { mf: true });
  check('P3 while held: the new prompt reached no CLI', !recvTexts(p.dir).some((r) => /P3-NEW-SESSION-PROMPT/.test(r.text)), recvTexts(p.dir).map((r) => r.text.slice(0, 40)));
  b.close(); // P9: abandon the second waiting start
  const ack = await waitEv(a, (e) => e.t === 'ack' && e.of === 'start', REBUILD_WAIT + 60_000);
  const cNew = cidOf(p.cname);
  const startedNew = startedAtOf(p.cname);
  check('P3 after the rebuild: the start completes on the NEW read-only container', !!ack && cNew !== w.id && !gitWritable(p.cname, `/workspace/${p.id}`).writable, `acked=${!!ack} old=${String(w.id).slice(0, 12)} new=${String(cNew).slice(0, 12)}`, { mf: true });
  const got = await waitFor(() => recvTexts(p.dir).find((r) => /P3-NEW-SESSION-PROMPT/.test(r.text)), 30_000);
  check('P3 its prompt ran after the new container started', !!got && Date.parse(got.at) >= startedNew - 1500, `at=${got?.at} startedAt=${new Date(startedNew || 0).toISOString()}`);
  await sleep(8000);
  check('P9 the abandoned start ran nothing (its prompt never reached a CLI)', !recvTexts(p.dir).some((r) => /P9-ABANDONED-PROMPT/.test(r.text)), recvTexts(p.dir).map((r) => r.text.slice(0, 40)), { mf: true });
  a.close(); busy.c.close();
}

async function P4() {
  console.log('\n--- P4 (MF): a duration grant EXPIRING with a turn in flight waits for idle, then flips the container back read-only');
  const p = await registerProject('p4');
  const w = await makeWritable(p, 4);
  const exp = Date.parse(w.grant?.expiresAt ?? "") || 0; // the grant view carries an ISO string
  check('P4 setup: writable container under a 4-minute grant', !!w.id && exp > Date.now(), `id=${String(w.id).slice(0, 12)} expiresInMs=${exp - Date.now()}`);
  const remain = Math.max(0, exp - Date.now());
  const s = await startSession(p.id, `[[sleep:${remain + 45000}]]`);
  await waitFor(() => Date.now() > exp + 6000 ? true : null, remain + 30_000, 1000);
  const st = (await statusOf(p.id))?.grantRebuild;
  check('P4 after expiry with the turn still running: pending, tightening, holding; container unchanged and still writable (logged over-run)', st?.phase === 'pending' && st?.tightens === true && st?.holds === true && cidOf(p.cname) === w.id && gitWritable(p.cname, `/workspace/${p.id}`).writable, `grantRebuild=${JSON.stringify(st)} unchanged=${cidOf(p.cname) === w.id}`, { mf: true });
  const ro = await waitFor(async () => { const x = cidOf(p.cname); return x && x !== w.id && !gitWritable(p.cname, `/workspace/${p.id}`).writable ? x : null; }, REBUILD_WAIT + 60_000);
  check('P4 after the turn ends: recreated with a read-only .git', !!ro, String(ro ?? '').slice(0, 12), { mf: true });
  // 'applied' is written once recreate() returns, a moment after the new container is visible: wait for it.
  const applied = await waitFor(() => { try { return fs.readFileSync(path.join(DATA, 'grant-rebuild.log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((x) => x.projectId === p.id && x.event === 'applied' && x.tightens) ?? null; } catch { return null; } }, 30_000);
  check('P4 the over-run past expiry is logged with its duration', !!applied && applied.overrunMs > 0, JSON.stringify(applied));
  s.c.close();
}

async function P5() {
  console.log('\n--- P5 (MF): a FAILED rebuild loses no input, is on Needs-You, and a retry delivers the rows in order');
  const p = await registerProject('p5');
  const w = await makeWritable(p, 10);
  const s = await startSession(p.id, '[[sleep:20000]]');
  await sleep(1500);
  await revoke(p.id);
  await waitFor(async () => (await statusOf(p.id))?.grantRebuild?.phase === 'pending', 30_000);
  const msgs = ['P5-MSG-1', 'P5-MSG-2', 'P5-MSG-3'];
  for (const m of msgs) await outboxPost(s.sdk, p.id, m, 'queued');
  fs.writeFileSync(FAIL_FLAG, p.cname);
  const failed = await waitFor(async () => { const g = (await statusOf(p.id))?.grantRebuild; return g?.phase === 'failed' ? g : null; }, REBUILD_WAIT);
  check('P5 the injected create failure surfaces as phase failed (holds kept)', !!failed && failed.holds === true, JSON.stringify(failed), { mf: true });
  const board = (await api(`/api/projects/${p.id}/board`)).body;
  const card = (board?.needsYou ?? []).find((x) => x.grantRebuild);
  check('P5 Needs-You carries the failed-rebuild card with Retry now', !!card && card.grantRebuild.actions.some((a) => a.id === 'retry'), JSON.stringify(card ? { title: card.title, actions: card.grantRebuild.actions } : null), { mf: true });
  const ob = await outboxGet(s.sdk);
  check('P5 the 3 rows are still queued (not failed, not discarded, not delivered)', (ob?.rows ?? []).filter((r) => r.state === 'queued').length === 3, JSON.stringify((ob?.rows ?? []).map((r) => r.state)), { mf: true });
  check('P5 nothing reached a CLI meanwhile', !recvTexts(p.dir).some((r) => /P5-MSG/.test(r.text)), recvTexts(p.dir).map((r) => r.text.slice(0, 30)));
  fs.rmSync(FAIL_FLAG, { force: true });
  const rr = await api(`/api/projects/${p.id}/container/grant-rebuild`, 'POST', {});
  check('P5 Retry now accepted', rr.status === 200, `status=${rr.status}`);
  const ro = await waitFor(async () => { const x = cidOf(p.cname); return x && x !== w.id && !gitWritable(p.cname, `/workspace/${p.id}`).writable && !(await statusOf(p.id))?.grantRebuild ? x : null; }, REBUILD_WAIT);
  check('P5 the retry recreated the container read-only and cleared the state', !!ro, String(ro ?? '').slice(0, 12));
  const got = await waitFor(() => { const m = recvTexts(p.dir).flatMap((r) => r.text.match(/P5-MSG-\d/g) ?? []); return m.length >= 3 ? m : null; }, 120_000);
  check('P5 after the retry the rows were delivered in order, exactly once', JSON.stringify(got) === JSON.stringify(msgs), JSON.stringify(got));
  s.c.close();
}

async function P6() {
  console.log('\n--- P6: a LOOSENING grant holds nothing while pending — another idle session still takes a message at once');
  const p = await registerProject('p6');
  const idle = await startSession(p.id, 'hello-idle');
  const busy = await startSession(p.id, '[[sleep:120000]]');
  await waitEv(idle.c, (e) => e.t === 'result', 30_000);
  await sleep(1000);
  await scopedGrant(p.id, 'FEAT-175 P6');
  await waitFor(async () => (await statusOf(p.id))?.grantRebuild?.phase === 'pending', 30_000);
  const before = (await statusOf(p.id))?.grantRebuild;
  const sendId = `p6-${crypto.randomUUID()}`;
  idle.c.send({ type: 'send', prompt: 'P6-DELIVERED-NOW', sendId });
  const r = await waitEv(idle.c, (e) => (e.t === 'ack' || e.t === 'error') && e.sendId === sendId, 15_000);
  check('P6 precondition: a loosening rebuild is pending (blocked by the busy session) right before the send', before?.phase === 'pending' && before?.tightens === false && before?.holds === false, JSON.stringify(before));
  check('P6 the send to the idle session during a loosening pending is delivered (not held)', r?.t === 'ack' && r.delivered === true, JSON.stringify(r));
  busy.c.close(); idle.c.close();
}

async function PD1() {
  console.log('\n--- PD1 (MF): docker UNREADABLE when a grant is revoked — a message to an idle session on the writable container is held, never delivered there; delivered after docker answers and the container is read-only');
  const p = await registerProject('pd1');
  const w = await makeWritable(p, 15);
  const idle = await startSession(p.id, 'hello');
  await waitEv(idle.c, (e) => e.t === 'result', 30_000);
  await sleep(1500);
  fs.writeFileSync(FAIL_INSPECT, p.cname);
  await revoke(p.id);
  await sleep(8000); // several reconciler ticks with docker unreadable
  const sendId = `pd1-${crypto.randomUUID()}`;
  idle.c.send({ type: 'send', prompt: 'PD1-MSG', sendId });
  const r = await waitEv(idle.c, (e) => (e.t === 'ack' || e.t === 'error') && e.sendId === sendId, 15_000);
  check('PD1 docker unreadable + revoked: the send is refused rebuild-hold (not delivered to the writable container)', r?.t === 'error' && r.code === 'rebuild-hold', JSON.stringify(r), { mf: true });
  await sleep(2500);
  check('PD1 …and it reached no CLI', !recvTexts(p.dir).some((x) => /PD1-MSG/.test(x.text)), recvTexts(p.dir).map((x) => x.text.slice(0, 30)), { mf: true });
  if (r?.t === 'error') await outboxPost(idle.sdk, p.id, 'PD1-MSG', 'direct');
  await sleep(2 * 60_000 + 6000);
  const board = (await api(`/api/projects/${p.id}/board`)).body;
  const card = (board?.needsYou ?? []).find((x) => x.grantRebuild && /cannot read/.test(x.title));
  check('PD1 unknown for > 2 min: a Needs-You card says so', !!card, JSON.stringify((board?.needsYou ?? []).map((x) => x.title)), { mf: true });
  fs.rmSync(FAIL_INSPECT, { force: true });
  const ro = await waitFor(async () => { const x = cidOf(p.cname); return x && x !== w.id && !gitWritable(p.cname, `/workspace/${p.id}`).writable ? x : null; }, REBUILD_WAIT);
  const startedNew = startedAtOf(p.cname);
  check('PD1 docker back: recreated read-only', !!ro, String(ro ?? '').slice(0, 12));
  const got = await waitFor(() => recvTexts(p.dir).find((x) => /PD1-MSG/.test(x.text)), 120_000);
  check('PD1 the held message is delivered once, after the read-only container started', !!got && Date.parse(got.at) >= startedNew - 1500 && recvTexts(p.dir).filter((x) => /PD1-MSG/.test(x.text)).length === 1, `at=${got?.at} startedAt=${new Date(startedNew || 0).toISOString()}`);
  idle.c.close();
}

async function PR1() {
  console.log('\n--- PR1: a RESTART with a revoke pending (and docker unreadable at boot) — the first start after boot never runs on the writable container');
  const p = await registerProject('pr1');
  const w = await makeWritable(p, 15);
  const busy = await startSession(p.id, '[[sleep:300000]]');
  await sleep(1500);
  await revoke(p.id);
  await waitFor(async () => (await statusOf(p.id))?.grantRebuild?.phase === 'pending', 30_000);
  busy.c.close();
  fs.writeFileSync(FAIL_INSPECT, p.cname);   // docker unreadable for this container across the restart
  await stopServer();
  await boot();
  check('PR1 precondition: after the restart the old container is still the writable one', cidOf(p.cname) === w.id && gitWritable(p.cname, `/workspace/${p.id}`).writable, String(cidOf(p.cname)).slice(0, 12));
  const st = (await statusOf(p.id))?.grantRebuild;
  check('PR1 boot + docker unreadable: the project is HELD (state unknown, grant read-only)', st?.holds === true, JSON.stringify(st), { mf: true });
  const a = await openWs();
  a.send({ type: 'start', projectId: p.id, prompt: 'PR1-AFTER-RESTART', overrides: { permissionMode: 'default' } });
  await sleep(6000);
  check('PR1 a start right after the restart did not run while held', !recvTexts(p.dir).some((x) => /PR1-AFTER-RESTART/.test(x.text)), recvTexts(p.dir).map((x) => x.text.slice(0, 30)), { mf: true });
  fs.rmSync(FAIL_INSPECT, { force: true });
  const ro = await waitFor(async () => { const x = cidOf(p.cname); return x && x !== w.id && !gitWritable(p.cname, `/workspace/${p.id}`).writable ? x : null; }, REBUILD_WAIT + 120_000);
  const startedNew = startedAtOf(p.cname);
  check('PR1 docker back: recreated read-only', !!ro, String(ro ?? '').slice(0, 12), { mf: true });
  const got = await waitFor(() => recvTexts(p.dir).find((x) => /PR1-AFTER-RESTART/.test(x.text)), 120_000);
  check('PR1 the start then ran on the read-only container', !!got && Date.parse(got.at) >= startedNew - 1500, `at=${got?.at} startedAt=${new Date(startedNew || 0).toISOString()}`, { mf: true });
  a.close();
}

async function PE1() {
  console.log('\n--- PE1: a duration grant that EXPIRES WHILE THE SERVER IS DOWN — the container is read-only before any turn runs after boot');
  const p = await registerProject('pe1');
  const w = await makeWritable(p, 1);
  check('PE1 precondition: writable under a 1-minute grant', !!w.id, String(w.id ?? '').slice(0, 12));
  await stopServer();
  const exp = Date.parse(w.grant?.expiresAt ?? '') || Date.now();
  await sleep(Math.max(0, exp - Date.now()) + 5000);
  await boot();
  const a = await openWs();
  a.send({ type: 'start', projectId: p.id, prompt: 'PE1-AFTER-BOOT', overrides: { permissionMode: 'default' } });
  const ro = await waitFor(async () => { const x = cidOf(p.cname); return x && x !== w.id && !gitWritable(p.cname, `/workspace/${p.id}`).writable ? x : null; }, REBUILD_WAIT);
  const startedNew = startedAtOf(p.cname);
  check('PE1 after boot: recreated read-only with no session asking', !!ro, String(ro ?? '').slice(0, 12));
  const got = await waitFor(() => recvTexts(p.dir).find((x) => /PE1-AFTER-BOOT/.test(x.text)), 120_000);
  check('PE1 the first start after boot ran only on the read-only container', !!got && Date.parse(got.at) >= startedNew - 1500, `at=${got?.at} startedAt=${new Date(startedNew || 0).toISOString()}`);
  a.close();
}

async function P8() {
  console.log('\n--- P8: a once grant causes NO recreate and the grant response carries a containerNote');
  const p = await registerProject('p8');
  const s = await startSession(p.id, 'hello');
  await waitEv(s.c, (e) => e.t === 'result' || e.t === 'ack', 30_000);
  await sleep(1500);
  const c0 = cidOf(p.cname);
  const g = await grant(p.id, { scope: 'once' });
  check('P8 the once-grant response carries the container note (a once grant cannot reach the container)', g.status === 200 && /one-time grant cannot reach this project's container/.test(g.body?.containerNote ?? ''), `note=${JSON.stringify(g.body?.containerNote)}`);
  await sleep(10_000); // several reconciler ticks
  const st = await statusOf(p.id);
  check('P8 no recreate: the container id is unchanged and no grant rebuild is pending', cidOf(p.cname) === c0 && (st?.grantRebuild ?? null) === null, `unchanged=${cidOf(p.cname) === c0} grantRebuild=${JSON.stringify(st?.grantRebuild ?? null)}`);
  s.c.close();
}

async function SHOTS_RUN() {
  console.log('\n--- SHOTS: capture the pending drawer line, outbox dock and Needs-You card (both themes; best-effort)');
  fs.mkdirSync(SHOTS, { recursive: true });
  const shotPaths = [];
  const p = await registerProject('shots');
  const idle = await startSession(p.id, 'hello');
  await waitEv(idle.c, (e) => e.t === 'result' || e.t === 'ack', 30_000);
  await sleep(1500);
  const c0 = cidOf(p.cname);
  await grant(p.id, { scope: 'duration', minutes: 15 });
  const writable = await waitFor(async () => { const id = cidOf(p.cname); return id && id !== c0 && gitWritable(p.cname, `/workspace/${p.id}`).writable ? id : null; }, REBUILD_WAIT);
  idle.c.close();
  if (!writable) { check('SHOTS could not reach a writable container (skipping shots)', false, 'no rebuild'); return; }
  const s = await startSession(p.id, '[[sleep:220000]]');
  await sleep(1500);
  await revoke(p.id);
  await waitFor(async () => { const gr = (await statusOf(p.id))?.grantRebuild; return gr && gr.phase === 'pending' && gr.tightens ? gr : null; }, 30_000);
  // queue a couple of held messages for the dock
  for (const m of ['held message A', 'held message B']) { const sendId = `sh-${crypto.randomUUID()}`; s.c.send({ type: 'send', prompt: m, sendId }); await waitEv(s.c, (e) => e.t === 'error' && e.sendId === sendId, 10_000); }
  for (const m of ['held message A', 'held message B']) await outboxPost(s.sdk, p.id, m, 'direct');
  const { chromium } = await import('playwright');
  const brave = process.env.QA_BRAVE_PATH || '/usr/bin/brave';
  const browser = await chromium.launch({ headless: true, executablePath: brave });
  const grab = async (tag, theme, open, assertSel) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: theme });
    await page.addInitScript((t) => { try { localStorage.setItem('cs.theme', t); } catch { /* */ } }, theme);
    try {
      await page.goto(`${base}/#/project/${encodeURIComponent(p.id)}`, { waitUntil: 'load' });
      await sleep(3500);
      await open(page);
      await sleep(1500);
      const f = path.join(SHOTS, `feat175-${tag}-${theme}.png`);
      await page.screenshot({ path: f, fullPage: true });
      const visText = await page.locator(assertSel).allTextContents().catch(() => []);
      shotPaths.push(f);
      check(`SHOTS ${tag} (${theme}): FEAT-175 UI text visible`, fs.existsSync(f) && visText.join(' ').length > 0, `${f} (${fs.existsSync(f) ? fs.statSync(f).size : 0}b) text=${JSON.stringify(visText.join(' | ').slice(0, 200))}`);
    } catch (e) { check(`SHOTS ${tag} (${theme})`, false, String(e).slice(0, 140)); } finally { await page.close(); }
  };
  // (a) the drawer's container block: open Settings → Isolation & environment → the "Rebuild for git grant pending" line.
  const openDrawer = async (page) => {
    try { await page.locator('#cogBtn').click({ timeout: 8000 }); } catch { /* */ }
    try { await page.getByText('Isolation & environment', { exact: false }).first().click({ timeout: 8000 }); } catch { /* */ }
    try { await page.locator('.grant-rebuild').first().waitFor({ state: 'visible', timeout: 10000 }); } catch { /* */ }
    try { await page.locator('.grant-rebuild').first().scrollIntoViewIfNeeded(); } catch { /* */ }
  };
  try {
    for (const theme of ['light', 'dark']) await grab('pending-drawer', theme, openDrawer, '.grant-rebuild');
    // Now force a FAILED rebuild for the Needs-You card: inject a docker create failure and force over the work.
    fs.writeFileSync(FAIL_FLAG, p.cname);
    await api(`/api/projects/${p.id}/container/grant-rebuild?force=1`, 'POST', {});
    await waitFor(async () => (await statusOf(p.id))?.grantRebuild?.phase === 'failed', 120_000);
    const openCard = async (page) => {
      // the rail focus card; click to mount/expand the Needs-You answer card (do NOT open settings — it overlaps the rail)
      try { await page.locator('.rs-focus-open, .tc[data-id*="grant-rebuild"]').first().click({ timeout: 8000 }); } catch { /* */ }
      try { await page.locator('.needs-card').first().waitFor({ state: 'visible', timeout: 10000 }); } catch { /* */ }
      try { await page.locator('.needs-card').first().scrollIntoViewIfNeeded(); } catch { /* */ }
    };
    for (const theme of ['light', 'dark']) await grab('failed-needsyou', theme, openCard, '.needs-card, .rs-focus');
    fs.rmSync(FAIL_FLAG, { force: true });
  } finally { await browser.close(); s.c.close(); }
  console.log(`    [shots] ${shotPaths.join('\n    [shots] ')}`);
}

/* ------------------------------------------------------------------ runner */
async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log(`FEAT-175 end-to-end\n  tree under test: ${SRC_TREE}\n  sandbox: ${TARGET}\n`);
  await boot();
  try { OWNER = await ownerKeyFor(DATA); } catch { /* */ }
  const steps = { P1s, P1r, PCORE, P3P9, P4, P5, P6, P8, PD1, PR1, PE1, SHOTS: SHOTS_RUN };
  for (const [id, fn] of Object.entries(steps)) {
    if (id === 'SHOTS' && !DO_SHOTS) continue;
    if (want(id)) { try { await fn(); } catch (e) { check(`${id} crashed`, false, String(e?.stack ?? e)); } }
  }
}

for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { console.log(`  FAIL  suite interrupted (${sig})`); void cleanup().finally(() => process.exit(1)); });

main()
  .catch((e) => { console.log(`  FAIL  suite crashed: ${e?.stack ?? e}\n  log tail: ${serverLog.slice(-1500)}`); fail++; })
  .finally(async () => { if (process.env.F175_DUMP_LOG) console.log(`--- server log tail ---\n${serverLog.slice(-8000)}`); await cleanup(); console.log(`\n${pass} passed, ${fail} failed`); if (mfLines.length) console.log(`must-FAIL checks:\n  ${mfLines.join('\n  ')}`); process.exit(fail ? 1 : 0); });
