#!/usr/bin/env node
/**
 * BUG-216 — the orphan sweep removes only what THIS Orchard instance created.
 *
 * Incident: a scratch server's `POST /api/containers/orphans` force-removed 44
 * containers across the host (6 live projects', 38 other lanes'), because the
 * sweep called "labelled claude-station=1 and not in MY registry" an orphan.
 *
 * THIS SUITE REMOVES CONTAINERS, so it REFUSES to run against the host daemon.
 * Point it at an isolated daemon with DOCKER_HOST. The standing sandbox (FEAT-158):
 *
 *   npm run sandbox:docker -- up && eval "$(npm run -s sandbox:docker -- env)"
 *   node scripts/verify-bug-216-sweep-ownership.mjs
 *
 * or a private docker-in-docker, e.g.
 *
 *   docker run -d --privileged --name orchard-bug216-dind -e DOCKER_TLS_CERTDIR= \
 *     -p 127.0.0.1::2375 docker:29-dind dockerd --host=tcp://0.0.0.0:2375 --tls=false
 *   docker save busybox:latest redis:7-alpine | DOCKER_HOST=tcp://127.0.0.1:<port> docker load
 *   DOCKER_HOST=tcp://127.0.0.1:<port> node scripts/verify-bug-216-sweep-ownership.mjs [--tree <dir>]
 *
 * The guard compares daemon IDs: the target must NOT be the daemon `docker`
 * reaches with DOCKER_HOST unset. CLAUDE_STATION_DOCKER must be unset (a shim
 * would still reach the host daemon).
 *
 * `--tree <dir>` runs the servers from another checkout (the must-FAIL run uses
 * a snapshot of the pre-fix tree taken before the fix was written).
 *
 * Scenario — synthetic, modelled on the incident's mixed state: two Orchard
 * servers A and B on different data dirs share one daemon. B has a running
 * project, a stopped project and a project with a redis service (network +
 * data volume). A has a kept project and a project it lost from its registry
 * (with a service), i.e. real orphans. Three pre-label ("legacy") containers and
 * one legacy service volume exist, labelled exactly as the pre-fix code wrote
 * them. A sweeps. Its own orphans must go; everything else must stay, byte for
 * byte (same container ids, same state).
 */
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempScratch } from './lib/scratch.mjs';
import { isolatedServerEnv } from './lib/station-boot.mjs';
import { assertIsolatedDocker } from './lib/docker-sandbox.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ti = process.argv.indexOf('--tree');
const TREE = ti > 0 ? path.resolve(process.argv[ti + 1]) : REPO;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ the guard */
// FEAT-158: the shared guard (daemon-id comparison; refuses unset DOCKER_HOST,
// a CLAUDE_STATION_DOCKER shim, an unreadable id, or the host daemon itself).
const { target: TARGET } = assertIsolatedDocker('verify-bug-216-sweep-ownership');
console.log(`tree=${TREE}`);

// Every docker call below goes to the isolated daemon (process.env carries DOCKER_HOST).
const d = (args) => {
  const r = spawnSync('docker', args, { encoding: 'utf8', env: process.env });
  return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
};
// Belt and braces: this run starts from an EMPTY claude-station world on the isolated daemon.
const preexisting = d(['ps', '-aq', '--filter', 'label=claude-station=1']).out;
if (preexisting) { console.error('REFUSED: the isolated daemon already has claude-station containers; use a fresh one.'); process.exit(2); }

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
}

async function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

const servers = [];
/** dataDir -> the server currently holding it (ARCH-022 / BUG-220: one process per data dir may act). */
const holding = new Map();
async function boot(label, dataDir) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(TREE, 'src', 'server', 'index.ts')], {
    cwd: TREE, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: isolatedServerEnv({ PORT: String(port), CLAUDE_STATION_DATA: dataDir, DOCKER_HOST: TARGET }),
  });
  let errTail = '';
  child.stderr.on('data', (x) => { errTail = (errTail + x).slice(-2000); });
  child.stdout.on('data', () => {});
  servers.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) { try { await fetch(`${base}/api/health`); const sv = { label, base, child, dataDir }; holding.set(dataDir, sv); return sv; } catch { await sleep(250); } }
  throw new Error(`server ${label} never became healthy: ${errTail}`);
}
async function stop(s) {
  if (holding.get(s.dataDir) === s) holding.delete(s.dataDir);
  try { process.kill(-s.child.pid, 'SIGTERM'); } catch { /* gone */ }
  for (let i = 0; i < 20 && s.child.exitCode === null; i++) await sleep(150);
  try { process.kill(-s.child.pid, 'SIGKILL'); } catch { /* gone */ }
}
async function api(s, p, method = 'GET', body) {
  const r = await fetch(s.base + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* */ }
  return { status: r.status, body: j };
}

const ROOT = mkdtempScratch('bug216-');
const NONCE = Math.random().toString(36).slice(2, 8);
const createdIds = [];
const mkWork = (n) => { const w = path.join(ROOT, 'work', n); fs.mkdirSync(w, { recursive: true }); fs.writeFileSync(path.join(w, 'README.md'), `${n}\n`); return w; };
const REDIS = { name: 'cache', image: 'redis:7-alpine', env: [], dataPath: '/data' };

async function mkProject(s, name, { services } = {}) {
  const settings = { container: { image: 'busybox:latest', gpu: 'off' } }; // the isolated daemon has no GPU
  if (services) settings.services = services;
  name = `${name}-${NONCE}`;
  const c = await api(s, '/api/projects', 'POST', { hostPath: mkWork(`${s.label}-${name}`), name, isolation: 'container', settings });
  if (c.status !== 201) throw new Error(`${s.label}: create ${name} failed: ${c.status} ${JSON.stringify(c.body).slice(0, 400)}`);
  const id = c.body.project.id;
  createdIds.push(id);
  const st = await api(s, `/api/projects/${id}/container/start`, 'POST');
  if (st.status !== 200) throw new Error(`${s.label}: start ${id} failed: ${st.status} ${JSON.stringify(st.body).slice(0, 600)}`);
  return id;
}
/** Register a project under an EXACT name (so the id can collide with another instance's), without starting it. */
async function registerAs(s, exactName, { services } = {}) {
  const settings = { container: { image: 'busybox:latest', gpu: 'off' } };
  if (services) settings.services = services;
  const c = await api(s, '/api/projects', 'POST', { hostPath: mkWork(`${s.label}-dup-${exactName}`), name: exactName, isolation: 'container', settings });
  if (c.status !== 201) throw new Error(`${s.label}: create ${exactName} failed: ${c.status} ${JSON.stringify(c.body).slice(0, 300)}`);
  createdIds.push(c.body.project.id);
  return c.body.project.id;
}
/*
 * ARCH-022: a helper acting "as instance X" is a second process on X's data dir. Since ARCH-022 that
 * process may mutate nothing while X's server holds the dir (BUG-220, enforced at every mutation), so
 * the helper runs with X's server DOWN, boots the lifecycle authority (a real claim, boot recovery) and
 * runs its body inside an operation of the project it acts on. X's server is then booted again (same
 * data dir, new port; the handle the suite holds is updated in place).
 */
const AUTH_PRELUDE = `const lc = await import(${JSON.stringify(path.join(TREE, 'src', 'server', 'lifecycle.ts'))}).catch(() => null);
if (lc) await lc.bootForTests();
const OP = (pid, fn) => (lc ? lc.runOp(pid, 'maintain', async () => fn()) : Promise.resolve().then(fn));`;
async function asDown(dataDir, fn) {
  const sv = holding.get(dataDir);
  if (sv) await stop(sv);
  try { return await fn(); } finally {
    if (sv) { const n = await boot(sv.label, dataDir); Object.assign(sv, n); holding.set(dataDir, sv); }
  }
}
/** Run a snippet against TREE's real modules as the instance on `dataDir` (async; resolves {ok, out}). */
function asInstance(dataDir, body, pid) { return asDown(dataDir, () => runAs(dataDir, body, pid)); }
function runAs(dataDir, body, pid) {
  const code = `${AUTH_PRELUDE}
const svc = await import(${JSON.stringify(path.join(TREE, 'src', 'server', 'service-manager.ts'))});
try { await OP(${JSON.stringify(pid)}, async () => { ${body} ; }); console.log('RESULT-OK'); } catch (e) { console.log('RESULT-ERR ' + (e.code ?? '') + ' ' + String(e.message).split('\\n')[0]); }`;
  return new Promise((res) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: TREE, env: { ...process.env, CLAUDE_STATION_DATA: dataDir, DOCKER_HOST: TARGET }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; c.stdout.on('data', (x) => { out += x; }); c.stderr.on('data', (x) => { out += x; });
    c.on('exit', () => res({ ok: /RESULT-OK/.test(out), out: (out.match(/RESULT-(OK|ERR.*)/) ?? [''])[0] }));
  });
}
// ARCH-022: the key a server on `dataDir` stamps is the identity DECLARED in that dir (written once; declared
// here if the dir has none yet, exactly the identity the server then binds to).
const keyOf = (dataDir) => execFileSync(process.execPath, ['--input-type=module', '-e', `const o = await import(${JSON.stringify(path.join(TREE, 'src', 'server', 'instance-owner.ts'))}).catch(() => null); const fs = await import('node:fs'); fs.mkdirSync(${JSON.stringify(dataDir)}, { recursive: true }); console.log(o ? (o.identityOf ? (o.identityOf(${JSON.stringify(dataDir)}, { create: true })?.id ?? '') : o.ownerKey()) : '')`], { cwd: TREE, env: { ...process.env, CLAUDE_STATION_DATA: dataDir }, encoding: 'utf8' }).trim();
/** Service infra through the REAL service-manager code of TREE, as that data dir's instance. */
// FEAT-158 round 6 / BUG-219 / ARCH-022: `shared` runs it as the DECLARED live instance (its data dir carries the user's live marker, no CLAUDE_STATION_DATA; the data dir comes from
// XDG_DATA_HOME, pointed at scratch) — the only kind that still adopts pre-label objects (mayActOn).
function ensureServicesAs(dataDir, projectId, { shared = false } = {}) {
  return asDown(dataDir, () => ensureServicesNow(dataDir, projectId, { shared }));
}
function ensureServicesNow(dataDir, projectId, { shared = false } = {}) {
  // ARCH-022: the live instance is the one whose data dir the USER declared (its marker); the helper declares it.
  if (shared) {
    const liveDir = path.join(dataDir, 'claude-station');
    fs.mkdirSync(liveDir, { recursive: true });
    if (fs.existsSync(path.join(TREE, 'scripts', 'orchard-live-instance.mjs'))) {
      execFileSync(process.execPath, ['--no-warnings', path.join(TREE, 'scripts', 'orchard-live-instance.mjs'), 'declare', '--data-dir', liveDir], { cwd: TREE, stdio: 'pipe' });
    }
  }
  const code = `${AUTH_PRELUDE}
const svc = await import(${JSON.stringify(path.join(TREE, 'src', 'server', 'service-manager.ts'))});
await OP(${JSON.stringify(projectId)}, () => svc.ensureServices({ id: ${JSON.stringify(projectId)}, isolation: 'container', settings: { services: [${JSON.stringify(REDIS)}] } }));`;
  execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: TREE, stdio: 'pipe', timeout: 120_000,
    env: shared
      ? (({ CLAUDE_STATION_DATA: _drop, ...rest }) => ({ ...rest, XDG_DATA_HOME: dataDir, DOCKER_HOST: TARGET }))(process.env)
      : { ...process.env, CLAUDE_STATION_DATA: dataDir, DOCKER_HOST: TARGET },
  });
}
const snap = () => {
  const m = new Map();
  for (const l of d(['ps', '-a', '--filter', 'label=claude-station=1', '--format', '{{.Names}}\t{{.ID}}\t{{.State}}']).out.split('\n').filter(Boolean)) {
    const [n, id, st] = l.split('\t'); m.set(n, `${id} ${st}`);
  }
  return m;
};
const vols = () => new Set(d(['volume', 'ls', '--filter', 'label=claude-station=1', '--format', '{{.Name}}']).out.split('\n').filter(Boolean));
const nets = () => new Set(d(['network', 'ls', '--filter', 'label=claude-station=1', '--format', '{{.Name}}']).out.split('\n').filter(Boolean));

try {
  const DA = path.join(ROOT, 'data-A'); const DB = path.join(ROOT, 'data-B');
  fs.mkdirSync(DA); fs.mkdirSync(DB);
  let A = await boot('A', DA);
  const B = await boot('B', DB);

  console.log('\n=== setup: realistic mixed state on one shared (isolated) daemon ===');
  const bLive = await mkProject(B, 'b-live');
  const bStopped = await mkProject(B, 'b-stopped');
  await api(B, `/api/projects/${bStopped}/container/stop`, 'POST');
  const bSvc = await mkProject(B, 'b-svc');
  await ensureServicesAs(DB, bSvc);
  const aKeep = await mkProject(A, 'a-keep');
  const aGone = await mkProject(A, 'a-gone');
  await ensureServicesAs(DA, aGone);
  // Legacy: labelled EXACTLY as the pre-fix code labelled containers/service volumes (no owner label).
  for (const [n, run] of [['legacy-run', true], ['legacy-idle', true], ['legacy-exited', false]]) {
    d(['run', '-d', '--name', `claude-station-${n}`, '--label', 'claude-station=1', '--label', `claude-station.project=${n}`, 'busybox:latest', 'sleep', '3600']);
    if (!run) d(['stop', '-t', '0', `claude-station-${n}`]);
  }
  d(['volume', 'create', '--label', 'claude-station=1', '--label', 'claude-station.project=legacy-svc', '--label', 'claude-station.role=service', '--label', 'claude-station.service=db', 'claude-station-legacy-svc-db']);

  // A loses a-gone from its registry (hand edit / crash) — its containers are A's REAL orphans.
  await stop(A);
  const regFile = path.join(DA, 'registry.json');
  const reg = JSON.parse(fs.readFileSync(regFile, 'utf8'));
  const list = Array.isArray(reg) ? reg : reg.projects;
  const kept = list.filter((p) => p.id !== aGone);
  if (Array.isArray(reg)) fs.writeFileSync(regFile, JSON.stringify(kept, null, 2)); else { reg.projects = kept; fs.writeFileSync(regFile, JSON.stringify(reg, null, 2)); }
  A = await boot('A', DA);

  const before = snap(); const volsBefore = vols(); const netsBefore = nets();
  const aGoneC = `claude-station-${aGone}`;
  const aGoneSvc = [...before.keys()].filter((n) => n.includes(aGone) && n !== aGoneC);
  const foreign = [...before.keys()].filter((n) => n.includes(bLive) || n.includes(bStopped) || n.includes(bSvc));
  const legacy = [...before.keys()].filter((n) => n.startsWith('claude-station-legacy-'));
  console.log(`  containers=${before.size} (A orphan: ${aGoneC} + ${aGoneSvc.length} service; B: ${foreign.length}; legacy: ${legacy.length}) volumes=${volsBefore.size} networks=${netsBefore.size}`);
  check('PRECONDITION: the mixed state exists (A orphan + its service, 3+ B containers incl. a service, 3 legacy, A kept)',
    before.has(aGoneC) && aGoneSvc.length >= 1 && foreign.length >= 4 && legacy.length === 3 && before.has(`claude-station-${aKeep}`),
    [...before.entries()].map(([n, v]) => `${n}=${v}`).join(' '));

  console.log('\n=== E2a (verifier round 1): B registers the SAME id as A\'s orphan and tries to use it ===');
  const bDup = await registerAs(B, aGone.replace(/-[a-z0-9]+$/, '') + '-' + NONCE);
  const dupStart = await api(B, `/api/projects/${bDup}/container/start`, 'POST');
  let dupSvcErr = '';
  try { await ensureServicesAs(DB, bDup); } catch (e) { dupSvcErr = String(e.stderr ?? e.message); }
  const afterDup = snap(); const volsDup = vols(); const netsDup = nets();
  check('B\'s container start on an id whose container A owns is REFUSED and A\'s container is not recreated',
    bDup === aGone && dupStart.status !== 200 && afterDup.get(aGoneC) === before.get(aGoneC),
    `id=${bDup} status=${dupStart.status} body=${JSON.stringify(dupStart.body).slice(0, 240)} A's container ${before.get(aGoneC)} -> ${afterDup.get(aGoneC)}`);
  check('B\'s service ensure on that id REFUSES to adopt A\'s redis/network/volume, and changes nothing',
    /foreign-owner|another Orchard instance/.test(dupSvcErr) && [...before.keys()].every((n) => afterDup.get(n) === before.get(n)) &&
      volsDup.size === volsBefore.size && netsDup.size === netsBefore.size,
    `err=${dupSvcErr.split('\n').find((l) => /Error/.test(l))?.slice(0, 200) ?? '(none)'}`);

  console.log('\n=== A lists, then sweeps ===');
  const g = await api(A, '/api/containers/orphans');
  const listed = (g.body?.orphans ?? []).map((o) => o.name).sort();
  check('A GET lists exactly its own orphan containers (a-gone + its service), none of B\'s or legacy',
    g.status === 200 && listed.length === 1 + aGoneSvc.length && listed.includes(aGoneC) && aGoneSvc.every((n) => listed.includes(n)),
    `orphans=${JSON.stringify(listed)}`);
  const unownedListed = (g.body?.unowned ?? []).map((o) => o.name).sort();
  check('A GET REPORTS the 3 legacy (unlabelled) containers under `unowned`',
    legacy.every((n) => unownedListed.includes(n)) && unownedListed.length === legacy.length, `unowned=${JSON.stringify(unownedListed)}`);

  const p = await api(A, '/api/containers/orphans', 'POST');
  const after = snap(); const volsAfter = vols(); const netsAfter = nets();
  check('POSITIVE CONTROL: A\'s own orphan container is removed', p.status === 200 && !after.has(aGoneC), `status=${p.status} removed=${JSON.stringify(p.body?.removed)}`);
  check('POSITIVE CONTROL: A\'s own orphan service container, network and data volume are removed',
    aGoneSvc.every((n) => !after.has(n)) && ![...netsAfter].some((n) => n.includes(aGone)) && ![...volsAfter].some((n) => n.includes(aGone)),
    `serviceInfra=${JSON.stringify(p.body?.serviceInfra)}`);
  check('A\'s registered project container is untouched', after.get(`claude-station-${aKeep}`) === before.get(`claude-station-${aKeep}`));
  const bChanged = foreign.filter((n) => after.get(n) !== before.get(n));
  check('EVERY one of B\'s containers survives with the same id and state (running, stopped, service)', bChanged.length === 0,
    `changed/removed: ${JSON.stringify(bChanged.map((n) => `${n}: ${before.get(n)} -> ${after.get(n) ?? 'GONE'}`))}`);
  check('B\'s service network and data volume survive',
    [...netsBefore].filter((n) => n.includes(bSvc)).every((n) => netsAfter.has(n)) && [...volsBefore].filter((n) => n.includes(bSvc)).every((n) => volsAfter.has(n)) &&
      [...volsBefore].some((n) => n.includes(bSvc)),
    `B vols before=${JSON.stringify([...volsBefore].filter((n) => n.includes(bSvc)))} after=${JSON.stringify([...volsAfter].filter((n) => n.includes(bSvc)))}`);
  const legChanged = legacy.filter((n) => after.get(n) !== before.get(n));
  check('the 3 legacy (unlabelled) containers are NOT removed', legChanged.length === 0, `changed: ${JSON.stringify(legChanged)}`);
  check('the legacy service volume is NOT removed, and is reported under serviceInfra.unowned',
    volsAfter.has('claude-station-legacy-svc-db') && (p.body?.serviceInfra?.unowned?.volumes ?? []).includes('claude-station-legacy-svc-db'),
    `unowned=${JSON.stringify(p.body?.serviceInfra?.unowned)}`);

  console.log('\n=== E2b: once A\'s orphan is gone, B uses that id; A sweeping again leaves B\'s objects alone ===');
  const dupStart2 = await api(B, `/api/projects/${bDup}/container/start`, 'POST');
  await ensureServicesAs(DB, bDup);
  const bDupObjs = snap();
  const bDupNames = [...bDupObjs.keys()].filter((n) => n.includes(bDup));
  const pA2 = await api(A, '/api/containers/orphans', 'POST');
  const afterA2 = snap();
  check('B now runs its own container + redis under that id, and A\'s second sweep leaves them (and B\'s data volume) alone',
    dupStart2.status === 200 && bDupNames.length >= 2 && bDupNames.every((n) => afterA2.get(n) === bDupObjs.get(n)) && [...vols()].some((v) => v.includes(bDup)),
    `start=${dupStart2.status} B objs=${JSON.stringify(bDupNames)} A POST=${JSON.stringify(pA2.body?.removed)} ${JSON.stringify(pA2.body?.serviceInfra)}`);

  console.log('\n=== B sweeps too (nothing of A\'s, nothing legacy) ===');
  const before2 = snap();
  const pb = await api(B, '/api/containers/orphans', 'POST');
  const after2 = snap();
  const changed2 = [...before2.keys()].filter((n) => after2.get(n) !== before2.get(n));
  check('B\'s sweep (it has no orphans) removes nothing at all', pb.status === 200 && changed2.length === 0 && (pb.body?.removed ?? []).length === 0,
    `removed=${JSON.stringify(pb.body?.removed)} changed=${JSON.stringify(changed2)}`);

  console.log('\n=== E3 (verifier round 1): B registers the SAME id as A\'s LIVE project and deletes it ===');
  await ensureServicesAs(DA, aKeep);
  const liveBefore = snap(); const volsLive = [...vols()].filter((v) => v.includes(aKeep)); const netsLive = [...nets()].filter((n) => n.includes(aKeep));
  const aKeepObjs = [...liveBefore.keys()].filter((n) => n.includes(aKeep));
  const bClash = await registerAs(B, aKeep.replace(/-[a-z0-9]+$/, '') + '-' + NONCE, { services: [REDIS] });
  const del = await api(B, `/api/projects/${bClash}`, 'DELETE');
  const liveAfter = snap();
  check('B\'s DELETE of a same-id project leaves A\'s running container, redis, network and data volume untouched',
    bClash === aKeep && aKeepObjs.length >= 2 && aKeepObjs.every((n) => liveAfter.get(n) === liveBefore.get(n)) &&
      volsLive.length >= 1 && volsLive.every((v) => vols().has(v)) && netsLive.every((n) => nets().has(n)),
    `id=${bClash} del=${del.status} container=${JSON.stringify(del.body?.container)} A objs=${JSON.stringify(aKeepObjs.map((n) => `${n}: ${liveBefore.get(n)} -> ${liveAfter.get(n) ?? 'GONE'}`))}`);

  console.log('\n=== R2a/R2b (verifier round 2): B left service objects under A\'s id; A declares no services ===');
  const aPlain = await mkProject(A, 'a-plain');
  const bPlain = await registerAs(B, aPlain.replace(/-[a-z0-9]+$/, '') + '-' + NONCE);
  const bSvcUp = await asInstance(DB, `await svc.ensureServices({ id: ${JSON.stringify(bPlain)}, isolation: 'container', settings: { services: [${JSON.stringify(REDIS)}] } })`, bPlain);
  const members = d(['network', 'inspect', `claude-station-net-${aPlain}`, '--format', '{{range .Containers}}{{.Name}} {{end}}']).out;
  const bRedis = () => d(['ps', '-a', '--filter', `label=claude-station.project=${bPlain}`, '--filter', 'label=claude-station.role=service', '--format', '{{.ID}} {{.State}}']).out;
  const bRedisBefore = bRedis();
  check('PRECONDITION: B\'s same-id redis + network exist', bPlain === aPlain && bSvcUp.ok && members.length > 0 && bRedisBefore.includes('running'), `B=${bSvcUp.out} members=${members} redis=${bRedisBefore}`);
  const aEnsure = await asInstance(DA, `await svc.ensureServices({ id: ${JSON.stringify(aPlain)}, isolation: 'container', settings: { services: [] } })`, aPlain);
  const aConnect = await asInstance(DA, `svc.connectSessionToServices(${JSON.stringify(aPlain)})`, aPlain);
  check('A (no services declared) starts its session despite B\'s leftover same-id service objects, and leaves B\'s redis + network alone',
    aEnsure.ok && bRedis() === bRedisBefore && nets().has(`claude-station-net-${aPlain}`), `${aEnsure.out} B redis ${bRedisBefore} -> ${bRedis() || 'GONE'}`);
  check('A\'s session container does NOT join B\'s same-id service network', aConnect.ok && !members.split(' ').includes(`claude-station-${aPlain}`) &&
    !d(['network', 'inspect', `claude-station-net-${aPlain}`, '--format', '{{range .Containers}}{{.Name}} {{end}}']).out.split(' ').includes(`claude-station-${aPlain}`),
    `connect=${aConnect.out} members after=${d(['network', 'inspect', `claude-station-net-${aPlain}`, '--format', '{{range .Containers}}{{.Name}} {{end}}']).out}`);

  console.log('\n=== R2c (verifier round 2): A and B create services for the SAME id at the same moment, 10 times ===');
  const kA = keyOf(DA), kB = keyOf(DB);
  let adopted = 0, bothOk = 0; const races = [];
  await asDown(DA, () => asDown(DB, async () => {
  for (let i = 0; i < 10; i++) {
    const rid = `race2-${i}-${NONCE}`;
    const spec = `{ id: ${JSON.stringify(rid)}, isolation: 'container', settings: { services: [${JSON.stringify(REDIS)}] } }`;
    const [ra, rb] = await Promise.all([runAs(DA, `await svc.ensureServices(${spec})`, rid), runAs(DB, `await svc.ensureServices(${spec})`, rid)]);
    const ctr = d(['ps', '-a', '--filter', `label=claude-station.project=${rid}`, '--filter', 'label=claude-station.role=service', '--format', '{{.Names}}']).out.split('\n').filter(Boolean)[0] ?? '';
    const cOwner = ctr ? d(['inspect', ctr, '--format', '{{index .Config.Labels "claude-station.owner"}}']).out : '';
    const nOwner = d(['network', 'inspect', `claude-station-net-${rid}`, '--format', '{{index .Labels "claude-station.owner"}}']).out;
    const volName = ctr ? d(['inspect', ctr, '--format', '{{range .Mounts}}{{.Name}}{{end}}']).out : '';
    const vOwner = volName ? d(['volume', 'inspect', volName, '--format', '{{index .Labels "claude-station.owner"}}']).out : '';
    for (const [ok, k] of [[ra.ok, kA], [rb.ok, kB]]) if (ok && (!k || cOwner !== k || nOwner !== k || vOwner !== k)) adopted++;
    if (ra.ok && rb.ok) bothOk++;
    races.push(`${i}:A=${ra.ok ? 'ok' : 'refused'} B=${rb.ok ? 'ok' : 'refused'} c=${cOwner.slice(0, 4)} n=${nOwner.slice(0, 4)} v=${vOwner.slice(0, 4)}`);
    const ids = d(['ps', '-aq', '--filter', `label=claude-station.project=${rid}`]).out.split('\n').filter(Boolean);
    if (ids.length) d(['rm', '-f', ...ids]);
    d(['network', 'rm', `claude-station-net-${rid}`]);
    for (const v of d(['volume', 'ls', '-q', '--filter', `label=claude-station.project=${rid}`]).out.split('\n').filter(Boolean)) d(['volume', 'rm', '-f', v]);
  }
  }));
  check('no instance that reports success is using a service container, network or data volume the OTHER instance created (10 races)',
    adopted === 0 && bothOk === 0, `adopted=${adopted} bothOk=${bothOk} (A=${kA.slice(0, 4)} B=${kB.slice(0, 4)}) ${races.join(' | ')}`);

  console.log('\n=== E4c (verifier round 1): a same-named container appears between the owner check and the removal ===');
  // A delaying docker shim: on `rm`, it signals and sleeps, so the suite can swap the container underneath.
  const SHIM = path.join(ROOT, 'docker-delay-shim');
  const MARK = path.join(ROOT, 'rm-seen');
  fs.writeFileSync(SHIM, `#!/bin/sh\nif [ "$1" = rm ]; then : > ${JSON.stringify(MARK)}; sleep 5; fi\nexec docker "$@"\n`);
  fs.chmodSync(SHIM, 0o755);
  const raceName = `claude-station-race-${NONCE}`;
  const ownKey = execFileSync(process.execPath, ['--input-type=module', '-e', `const o = await import(${JSON.stringify(path.join(TREE, 'src', 'server', 'instance-owner.ts'))}).catch(() => null); console.log(o ? o.ownerKey() : '')`], { cwd: TREE, env: { ...process.env, CLAUDE_STATION_DATA: DA }, encoding: 'utf8' }).trim();
  d(['run', '-d', '--name', raceName, '--label', 'claude-station=1', '--label', `claude-station.project=race-${NONCE}`, ...(ownKey ? ['--label', `claude-station.owner=${ownKey}`] : []), 'busybox:latest', 'sleep', '3600']);
  const aSv = holding.get(DA); if (aSv) await stop(aSv); // ARCH-022: one process per data dir
  const racer = spawn(process.execPath, ['--input-type=module', '-e', `${AUTH_PRELUDE}
const cm = await import(${JSON.stringify(path.join(TREE, 'src', 'server', 'container-manager.ts'))}); console.log(JSON.stringify(await OP(${JSON.stringify(`race-${NONCE}`)}, () => cm.removeContainerByName(${JSON.stringify(raceName)}))));`],
    { cwd: TREE, env: { ...process.env, CLAUDE_STATION_DATA: DA, CLAUDE_STATION_DOCKER: SHIM }, stdio: ['ignore', 'pipe', 'pipe'] });
  let racerOut = ''; racer.stdout.on('data', (x) => { racerOut += x; }); racer.stderr.on('data', (x) => { racerOut += x; });
  for (let i = 0; i < 100 && !fs.existsSync(MARK); i++) await sleep(100);
  const sawRm = fs.existsSync(MARK);
  d(['rm', '-f', raceName]); // A's own container goes away in the window…
  d(['run', '-d', '--name', raceName, '--label', 'claude-station=1', '--label', `claude-station.project=race-${NONCE}`, '--label', 'claude-station.owner=someone-else-0000', 'busybox:latest', 'sleep', '3600']); // …and another instance's takes its name
  const victimId = d(['inspect', raceName, '--format', '{{.Id}}']).out;
  await new Promise((r) => racer.on('exit', r));
  if (aSv) { const n = await boot(aSv.label, DA); Object.assign(aSv, n); holding.set(DA, aSv); }
  const survivor = d(['inspect', raceName, '--format', '{{.Id}}']).out;
  check('removal acts on the container that was CHECKED: a same-named container created in the window survives',
    sawRm && victimId && survivor === victimId && !/"removed":true/.test(racerOut), `sawRm=${sawRm} victim=${victimId.slice(0, 12)} after=${survivor.slice(0, 12) || 'GONE'} result=${racerOut.trim().slice(0, 200)}`);

  console.log('\n=== legacy compatibility: an UNLABELLED service network is still reused (not mistaken for foreign) ===');
  const legacyPid = `legacy-net-${NONCE}`;
  d(['network', 'create', '--label', 'claude-station=1', '--label', `claude-station.project=${legacyPid}`, '--label', 'claude-station.role=network', `claude-station-net-${legacyPid}`]);
  const legacyNetId = d(['network', 'inspect', `claude-station-net-${legacyPid}`, '--format', '{{.Id}}']).out;
  // FEAT-158 round 6: a scratch (isolated) instance adopts nothing unlabelled; only the shared one does.
  let isoErr = '';
  try { await ensureServicesAs(DA, legacyPid); } catch (e) { isoErr = String(e.stderr ?? e.message); }
  check('an ISOLATED instance (scratch server) refuses the pre-label network and starts nothing on it',
    /foreign-owner|isolated instance|another Orchard instance/.test(isoErr) && d(['network', 'inspect', `claude-station-net-${legacyPid}`, '--format', '{{.Id}}']).out === legacyNetId &&
      ![...snap().keys()].some((n) => n.includes(legacyPid)), `err=${isoErr.split('\n').find((l) => /Error/.test(l))?.slice(0, 200) ?? '(none)'}`);
  let legacyErr = '';
  try { await ensureServicesAs(path.join(ROOT, 'xdg-shared'), legacyPid, { shared: true }); } catch (e) { legacyErr = String(e.stderr ?? e.message).split('\n').find((l) => /Error/.test(l)) ?? 'error'; }
  check('the SHARED instance: ensureServices on a project whose pre-label network exists reuses that network and starts its service',
    !legacyErr && d(['network', 'inspect', `claude-station-net-${legacyPid}`, '--format', '{{.Id}}']).out === legacyNetId &&
      [...snap().keys()].some((n) => n.includes(legacyPid)), `err=${legacyErr || '(none)'}`);

  console.log('\n=== removal re-checks the label (defence in depth) ===');
  const code = `${AUTH_PRELUDE}
const cm = await import(${JSON.stringify(path.join(TREE, 'src', 'server', 'container-manager.ts'))});
console.log(JSON.stringify([await OP(${JSON.stringify(bLive)}, () => cm.removeContainerByName(${JSON.stringify(`claude-station-${bLive}`)})), await OP('legacy-run', () => cm.removeContainerByName('claude-station-legacy-run'))]));`;
  let direct = null;
  const aSv2 = holding.get(DA); if (aSv2) await stop(aSv2); // ARCH-022: one process per data dir
  try { direct = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: TREE, env: { ...process.env, CLAUDE_STATION_DATA: DA, DOCKER_HOST: TARGET }, encoding: 'utf8', timeout: 60_000 }).trim().split('\n').pop()); } catch (e) { direct = String(e.message).slice(0, 300); }
  if (aSv2) { const n = await boot(aSv2.label, DA); Object.assign(aSv2, n); holding.set(DA, aSv2); }
  const after3 = snap();
  check('removeContainerByName called as A on B\'s live container and on a legacy one refuses both, each for its own reason',
    after3.get(`claude-station-${bLive}`) === before.get(`claude-station-${bLive}`) && after3.get('claude-station-legacy-run') === before.get('claude-station-legacy-run') &&
      Array.isArray(direct) && /another Orchard instance/.test(direct[0]?.detail ?? '') && /missing/.test(direct[1]?.detail ?? ''),
    `result=${JSON.stringify(direct)}`);
} catch (err) {
  fail++;
  console.error(`\nHARNESS ERROR: ${err.stack}`);
} finally {
  for (const s of servers) { try { process.kill(-s.pid, 'SIGTERM'); } catch { /* */ } }
  await sleep(800);
  for (const s of servers) { try { process.kill(-s.pid, 'SIGKILL'); } catch { /* */ } }
  // Clean the ISOLATED daemon only (process.env carries DOCKER_HOST; the guard proved it is not the host).
  const left = d(['ps', '-aq', '--filter', 'label=claude-station=1']).out.split('\n').filter(Boolean);
  if (left.length) d(['rm', '-f', ...left]);
  for (const n of d(['network', 'ls', '-q', '--filter', 'label=claude-station=1']).out.split('\n').filter(Boolean)) d(['network', 'rm', n]);
  for (const v of d(['volume', 'ls', '-q', '--filter', 'label=claude-station=1']).out.split('\n').filter(Boolean)) d(['volume', 'rm', '-f', v]);
  fs.rmSync(ROOT, { recursive: true, force: true });
  // ensureContainer pre-creates each project's history dir in the REAL store; remove only ours, only if empty.
  for (const id of createdIds) {
    const h = path.join(process.env.HOME, '.claude', 'projects', `-workspace-${id}`);
    try { if (fs.readdirSync(h).length === 0) fs.rmdirSync(h); } catch { /* absent */ }
  }
}
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
