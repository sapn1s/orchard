#!/usr/bin/env node
/**
 * verify-feat-112-services.mjs — per-project service sidecars, end to end.
 *
 * This is the RUNTIME proof, not a shape check. It uses real docker:
 *   A. declare a redis service, ensure it, create a real session container, join
 *      it to the network, and connect FROM INSIDE that container with a real
 *      client call (node TCP PING → +PONG). That is the claim: something inside
 *      the session actually reaches the service by name.
 *   B. failure path — a bogus image fails fast with a SPECIFIC message; an
 *      unreachable registry is ABORTED by the bounded pull timeout and does not
 *      hang. Neither is silent.
 *   C. cleanup — after teardown, a real `docker ps -a` / `network ls` / `volume
 *      ls` show nothing of ours left.
 *   D. an agent cannot apply its own proposal — the request (raise) writes no
 *      settings; only the USER answer route (Allow) applies. Driven against a
 *      real booted server.
 *
 * Safety: everything is keyed to a random projectId under the `t-feat112-`
 * prefix; the finally block removes only what this script created, by name/label.
 * The user's real containers are never touched. Not part of `npm run gate`
 * (needs docker + network); run explicitly:  node scripts/verify-feat-112-services.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Bound the pull timeout low BEFORE importing the module, so the timeout case is
// provable in seconds. Set the isolation data dir too, for the decisions store.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f112-data-'));
process.env.CLAUDE_STATION_DATA = DATA;
process.env.CLAUDE_STATION_SERVICE_PULL_TIMEOUT_MS = process.env.CLAUDE_STATION_SERVICE_PULL_TIMEOUT_MS ?? '4000';

const svc = await import('../src/server/service-manager.ts');
const decisions = await import('../src/server/decisions.ts');
const { validateServices } = await import('../src/server/validate.ts');

const ROOT = path.resolve(import.meta.dirname, '..');
const DOCKER = process.env.CLAUDE_STATION_DOCKER ?? 'docker';
const BASE_IMAGE = process.env.VERIFY_F112_BASE ?? 'claude-station-base:u1000-g1000';
const SVC_IMAGE = process.env.VERIFY_F112_REDIS ?? 'redis:7-alpine';
const PID = `t-feat112-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const sessionName = `claude-station-${PID}`;

let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function d(args, timeout = 60_000) {
  const r = spawnSync(DOCKER, args, { encoding: 'utf8', timeout });
  return { code: typeof r.status === 'number' ? r.status : 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}
function projectWith(services) {
  return { id: PID, isolation: 'container', settings: { services } };
}
// A real client call from inside the session container: speak RESP over a raw
// TCP socket via node (redis-cli is not in the base image), send PING, expect
// +PONG. Exit 0 only on PONG.
const PROBE = [
  'node', '-e',
  "const net=require('net');const s=net.connect(6379,'redis');let b='';" +
  "s.on('connect',()=>s.write('PING\\r\\n'));" +
  "s.on('data',d=>{b+=d;if(b.includes('PONG')){console.log('GOT:'+b.trim());process.exit(0);}});" +
  "s.on('error',e=>{console.log('ERR:'+e.message);process.exit(2)});" +
  "setTimeout(()=>{console.log('TIMEOUT:'+JSON.stringify(b));process.exit(3)},4000);",
];

let server = null;
async function main() {
  // Preflight
  if (d(['version', '--format', '{{.Server.Version}}']).code !== 0) throw new Error('docker not available');
  if (d(['image', 'inspect', BASE_IMAGE]).code !== 0) throw new Error(`base image ${BASE_IMAGE} not present — set VERIFY_F112_BASE`);

  console.log('\n=== A. lifecycle + REAL in-container connect ===');
  const redis = { name: 'redis', image: SVC_IMAGE, env: [], dataPath: '/data' };
  await svc.ensureServices(projectWith([redis]), (s) => process.stdout.write(`    ${s}`));

  const svcName = svc.serviceContainerName(PID, 'redis');
  const netName = svc.networkName(PID);
  const running = d(['inspect', svcName, '--format', '{{.State.Running}}']);
  check('redis sidecar is running', running.out === 'true', `${svcName} Running=${running.out}`);
  const onNet = d(['inspect', svcName, '--format', '{{json .NetworkSettings.Networks}}']);
  check('sidecar is on the per-project network, aliased "redis"',
    onNet.out.includes(netName) && onNet.out.includes('redis'), onNet.out.slice(0, 200));

  // A real session container mirroring the manager's naming/labels, on the
  // default bridge like the real one, then joined to the service network.
  d(['rm', '-f', sessionName]);
  const created = d(['run', '-d', '--name', sessionName,
    '--label', 'claude-station=1', '--label', `claude-station.project=${PID}`,
    BASE_IMAGE, 'sleep', '600']);
  check('scratch session container started', created.code === 0, created.code === 0 ? sessionName : created.err.slice(0, 200));

  // MUST-FAIL baseline: on the default bridge alone (pre-join, the OLD
  // architecture), the session container cannot resolve "redis" by name. This is
  // the mechanism the feature adds; if this "fails to connect" check passes, the
  // subsequent success proves the network-join is what made the difference.
  const preProbe = d(['exec', sessionName, ...PROBE], 8000);
  check('BEFORE joining the network, the session CANNOT reach "redis" (must-fail baseline)',
    preProbe.code !== 0 || !preProbe.out.includes('PONG'), `code=${preProbe.code} out=${(preProbe.out || preProbe.err).slice(0, 120)}`);

  svc.connectSessionToServices(PID, (s) => process.stdout.write(`    ${s}`));
  // Idempotency: a second connect must not throw.
  let secondConnectOk = true;
  try { svc.connectSessionToServices(PID); } catch { secondConnectOk = false; }
  check('connectSessionToServices is idempotent (second call no-op)', secondConnectOk, `ok=${secondConnectOk}`);

  // THE CLAIM: from INSIDE the session container, a real client call to redis,
  // now that it has joined the network. Retry briefly while redis finishes boot.
  let pong = { code: 1, out: '' };
  for (let i = 0; i < 10; i++) {
    pong = d(['exec', sessionName, ...PROBE], 8000);
    if (pong.code === 0 && pong.out.includes('PONG')) break;
    await sleep(500);
  }
  check('a node client INSIDE the session container reached redis by name and got +PONG',
    pong.code === 0 && pong.out.includes('PONG'), `${pong.out || pong.err}`.slice(0, 200));

  console.log('\n=== B. failure paths are loud and bounded ===');
  // B1 — bogus tag on a reachable registry: fails FAST with a specific message.
  let e1 = null;
  const t1 = Date.now();
  try {
    await svc.ensureServices(projectWith([{ name: 'nope', image: 'redis:this-tag-does-not-exist-999x', env: [], dataPath: null }]));
  } catch (e) { e1 = e; }
  const b1ms = Date.now() - t1;
  check('a bad image tag throws ServiceError naming the service + image',
    !!e1 && (e1.code === 'pull-failed' || e1.code === 'not-running' || e1.code === 'create-failed')
      && /nope/.test(e1.message) && /this-tag-does-not-exist/.test(e1.message),
    e1 ? `code=${e1.code} msg=${e1.message.slice(0, 140)}` : 'no error thrown');
  // Reconcile away the failed/leftover 'nope' before continuing.
  svc.teardownServices(PID, { removeVolumes: false });

  // B2 — unreachable registry: bounded pull timeout ABORTS, does not hang.
  let e2 = null;
  const t2 = Date.now();
  try {
    await svc.ensureServices(projectWith([{ name: 'slow', image: '10.255.255.1:5000/nope:latest', env: [], dataPath: null }]));
  } catch (e) { e2 = e; }
  const b2ms = Date.now() - t2;
  check('an unreachable registry is ABORTED by the bounded timeout (did not hang)',
    !!e2 && b2ms < 30_000, e2 ? `code=${e2.code} after ${b2ms}ms: ${e2.message.slice(0, 120)}` : `no error after ${b2ms}ms`);
  svc.teardownServices(PID, { removeVolumes: false });

  console.log('\n=== C. cleanup leaves nothing of ours ===');
  // Re-establish a full service so teardown has real things to remove.
  await svc.ensureServices(projectWith([redis]));
  svc.connectSessionToServices(PID);
  svc.teardownServices(PID, { removeVolumes: true });
  // Also remove the scratch session container (the manager would, on its own path).
  d(['rm', '-f', sessionName]);

  const leftContainers = d(['ps', '-a', '--filter', `label=claude-station.project=${PID}`, '--format', '{{.Names}}']).out;
  check('no service/session containers left for this project', leftContainers === '', `left: ${JSON.stringify(leftContainers)}`);
  const leftNet = d(['network', 'ls', '--filter', `name=${netName}`, '--format', '{{.Name}}']).out;
  check('the per-project network is gone', leftNet === '', `left: ${JSON.stringify(leftNet)}`);
  const leftVol = d(['volume', 'ls', '--filter', `label=claude-station.project=${PID}`, '--format', '{{.Name}}']).out;
  check('the data volume is gone (removeVolumes purge)', leftVol === '', `left: ${JSON.stringify(leftVol)}`);

  // Orphan reap: create infra then reap as if the project vanished from registry.
  await svc.ensureServices(projectWith([redis]));
  const reaped = svc.reapOrphanServiceInfra(new Set()); // no known projects → all orphan
  const afterReapNet = d(['network', 'ls', '--filter', `name=${netName}`, '--format', '{{.Name}}']).out;
  const afterReapVol = d(['volume', 'ls', '--filter', `label=claude-station.project=${PID}`, '--format', '{{.Name}}']).out;
  const afterReapC = d(['ps', '-a', '--filter', `label=claude-station.project=${PID}`, '--format', '{{.Names}}']).out;
  check('reapOrphanServiceInfra removes the orphan network + volumes + containers',
    afterReapNet === '' && afterReapVol === '' && afterReapC === '',
    `reaped=${JSON.stringify(reaped)} net=${JSON.stringify(afterReapNet)} vol=${JSON.stringify(afterReapVol)} c=${JSON.stringify(afterReapC)}`);

  console.log('\n=== D. an agent cannot apply its own proposal (real server) ===');
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f112-proj-'));
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (x) => { if (/error|throw/i.test(String(x))) process.stderr.write(`  [server!] ${x}`); });
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  // Create a real container project via the API.
  const createRes = await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'feat112', hostPath: projDir, isolation: 'container' }),
  });
  const proj = (await createRes.json()).project;
  check('project created', createRes.status < 300 && proj?.id, `HTTP ${createRes.status} id=${proj?.id}`);

  // The agent-facing request route REFUSES without a live session — an agent
  // cannot even raise (let alone apply) from nothing.
  const noSess = await fetch(`${BASE}/api/sessions/does-not-exist/services-request`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'x', services: [{ name: 'redis', image: 'redis:7-alpine' }] }),
  });
  check('services-request 400s without a live session', noSess.status === 400, `HTTP ${noSess.status}`);

  // Raising a proposal (exactly what the request route does) writes an INERT
  // record and NOTHING to the project — proving proposing ≠ applying.
  const proposed = validateServices([{ name: 'redis', image: 'redis:7-alpine', env: [], dataPath: '/data' }]);
  const rec = decisions.raise({
    projectId: proj.id, sessionId: 'fake-session', sdkSessionId: null,
    question: `Add service sidecars to "feat112"? test — proposed: redis.`,
    options: ['Allow', 'Decline'], services: { services: proposed, reason: 'test' },
  });
  const beforeProj = (await (await fetch(`${BASE}/api/projects/${proj.id}`)).json()).project;
  const beforeServices = beforeProj.settings?.services ?? [];
  check('after the proposal is raised, project settings still have NO services (inert)',
    beforeServices.length === 0, `services=${JSON.stringify(beforeServices)}`);

  // Only the USER answer route (Allow) applies.
  const allow = await fetch(`${BASE}/api/projects/${proj.id}/board/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: rec.id, answer: 'Allow' }),
  });
  const allowBody = await allow.json();
  const afterProj = (await (await fetch(`${BASE}/api/projects/${proj.id}`)).json()).project;
  const afterServices = afterProj.settings?.services ?? [];
  check('answering "Allow" (the USER action) applies the proposed services',
    allow.status === 200 && afterServices.length === 1 && afterServices[0].name === 'redis',
    `HTTP ${allow.status} ok=${allowBody.ok} services=${JSON.stringify(afterServices)}`);

  // Decline applies nothing.
  const rec2 = decisions.raise({
    projectId: proj.id, sessionId: 'fake-session', sdkSessionId: null,
    question: 'Add service sidecars? test2 — proposed: mongo.', options: ['Allow', 'Decline'],
    services: { services: validateServices([{ name: 'mongo', image: 'mongo:7' }]), reason: 't2' },
  });
  await fetch(`${BASE}/api/projects/${proj.id}/board/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: rec2.id, answer: 'Decline' }),
  });
  const declProj = (await (await fetch(`${BASE}/api/projects/${proj.id}`)).json()).project;
  const declServices = declProj.settings?.services ?? [];
  check('"Decline" writes nothing new (still just redis)',
    declServices.length === 1 && declServices[0].name === 'redis', `services=${JSON.stringify(declServices)}`);

  fs.rmSync(projDir, { recursive: true, force: true });
}

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

function cleanup() {
  try { svc.teardownServices(PID, { removeVolumes: true }); } catch { /* */ }
  d(['rm', '-f', sessionName]);
  // Backstop: remove anything still labelled to this project id.
  const stray = d(['ps', '-aq', '--filter', `label=claude-station.project=${PID}`]).out.split('\n').filter(Boolean);
  for (const c of stray) d(['rm', '-f', c]);
  const net = d(['network', 'ls', '--filter', `name=${svc.networkName(PID)}`, '--format', '{{.Name}}']).out;
  if (net) d(['network', 'rm', net]);
  for (const v of d(['volume', 'ls', '--filter', `label=claude-station.project=${PID}`, '--format', '{{.Name}}']).out.split('\n').filter(Boolean)) d(['volume', 'rm', v]);
  if (server && server.exitCode === null) { try { process.kill(server.pid, 'SIGTERM'); } catch { /* */ } }
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* */ }
}

main()
  .then(() => {
    cleanup();
    console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error('\nERROR:', e?.stack || e);
    cleanup();
    process.exit(1);
  });
