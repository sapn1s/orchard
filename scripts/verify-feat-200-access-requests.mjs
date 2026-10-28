#!/usr/bin/env node
/**
 * FEAT-200 — END-TO-END proof of container ACCESS requests, on a REAL scratch Orchard server and REAL
 * containers in the FEAT-158 sandbox daemon. The agent is a fake in-container CLI
 * (scripts/fixtures/feat-200/fake-container-cli.mjs, via the ORCHARD_TEST_CONTAINER_CLI seam) that raises its
 * request EXACTLY as the injected instructions tell a real agent: a JSON file written into
 * $ORCHARD_ACCESS_DIR from INSIDE the container (tmp + mv), then the reply read back.
 *
 *   npm run sandbox:docker -- up && eval "$(npm run -s sandbox:docker -- env)"
 *   node scripts/verify-feat-200-access-requests.mjs [--tree <dir>] [--only A,B] [--no-shots]
 *
 * `--tree <dir>` runs the scratch SERVER from another checkout (must-FAIL baseline: a pre-FEAT-200 copy).
 *
 * Properties (each prints what it observed):
 *   I   container sessions are launched with the "Container access" instructions
 *   A   raise from inside the container → a PENDING record; nothing written to settings or the container
 *   G   agent callers (a process in an Orchard session scope) are refused: decide → 403 agent-not-user,
 *       PATCH env/ports → 403, the generic answer route → 409; the record stays pending, settings unchanged
 *   K   a REAL host port collision (a program on this machine already listens on 127.0.0.1:3000) and a
 *       cross-project collision are shown on the record and approval is refused (409 port-conflict)
 *   L   a non-loopback publish cannot be asked for, nor set by PATCH
 *   P   approve → settings written → container RECREATED at idle by the reconciler → `docker inspect`: the env
 *       and a 127.0.0.1-ONLY PortBindings → the session is resumed with "access granted: …, continue" and
 *       sees MONGODB_URI in its own process env
 *   B   approve while ANOTHER session of the project runs a turn: no recreate until that turn ends
 *   R   reject → nothing written, no recreate → the session is resumed with "denied: …"
 *   Y   FEAT-200 r5: the four recorded REVERT breaks over HTTP with a real docker refusal (shared key, shared port,
 *       stale provenance after a user delete, chained refusals) — must FAIL on a pre-r5 tree
 *   U   FEAT-200 r6: a user save touching a key/port named by an approved-pending request CANCELS it (the three
 *       IV r5 sequences: change-and-back, add-then-delete, publish-then-remove), the card's user-only Cancel, no false
 *       cancel on an unrelated save, the drawer's pending list, a refused user port shown with docker's reason
 *   X   (c) after the r3 redesign: a port taken AFTER approval keeps the old container running, reverts the change,
 *       resumes "approved, but could not be applied", no loop, no hold; an IPv6-only listener is a conflict; a
 *       NON-port start failure keeps the container; approval with no running container never claims "granted"
 *   SHOTS6 FEAT-200 r6: the Cancel button on an approved-pending card and the drawer warning, light and dark, plus the
 *       "Save and cancel" click-path
 *   SHOTS  the card on the session view and on the rail, light and dark (Playwright + brave)
 *   C   FEAT-200 r7: SIGKILL between the commit's settings write and the record mark (on-disk state constructed),
 *       restart, a user edit of one named key → the requester is told the truth, once; no edit → "granted" once.
 *       Must FAIL on a pre-r7 tree. Runs last (it restarts the server).
 *   D   FEAT-200 r8: the same crash state, then the project is DELETED and RE-ADDED under the same id over HTTP
 *       before any pass: the committed request is told "its project was removed … not in effect" (never "cancelled
 *       … never written"), the old project's undecided request cannot be approved on the new card (409
 *       project-removed), Cancel is refused, the re-added project inherits nothing, and the removed project's closed
 *       session is not resumed into the new one. Must FAIL on the r7 tree. Runs after C (it restarts the server).
 *       r10: D7 — neither removed-incarnation request is a Needs-You card on the re-added project (must FAIL on r9).
 *   Q   BUG-284 (the former FEAT-200 r8 residual, IV r8 ec528a8a): "access granted" QUEUED in the outbox and held, and
 *       a PLAIN queued message for another closed session, then delete + re-add: neither is resumed into the re-added
 *       project (both rows failed with the reason); a message for the re-added project's own session still goes.
 *       Runs by default since BUG-284 (it was --only Q while contained). Must FAIL on the pre-BUG-284 tree.
 *       r10 (IV r9 2af93888): Q5 — that committed request's CARD, served over HTTP and read by the real accessStatusText,
 *       says "removed … not sent", never "open the session". Must FAIL on the r9 tree.
 *   QR  BUG-284: a plain message held behind a running turn, delete + re-add, server RESTART: not resumed either.
 *
 * ISOLATION: assertIsolatedDocker FIRST (refuses the host daemon, takes the sandbox lock). Only containers our
 * scratch data dir owns are removed. No live service/port/data dir, no pkill, no git writes.
 * The probe for G runs in a transient `claude-station-host-t-*` scope via systemd-run (the cgroup a real
 * session's Bash runs in); it lives only for one HTTP call.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

import { assertIsolatedDocker } from './lib/docker-sandbox.mjs';
import { isolatedServerEnv } from './lib/station-boot.mjs';
import { ownerKeyFor, removeOwnedContainer } from './lib/owned-docker.mjs';

const { target: TARGET } = assertIsolatedDocker('verify-feat-200-access-requests');

const REPO = path.resolve(import.meta.dirname, '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const SRC_TREE = arg('--tree') ? path.resolve(arg('--tree')) : REPO;
const ONLY = arg('--only') ? new Set(arg('--only').split(',')) : null;
const want = (id) => (!ONLY ? true : ONLY.has(id)); // BUG-284: Q (the former r8 residual) now runs by default
const DO_SHOTS = !process.argv.includes('--no-shots');
const SHOTS = process.env.FEAT200_SHOTS || '/tmp/feat200-shots';
const CLI_VERSION = '9.9.200-feat200';
const REBUILD_WAIT = Number(process.env.F200_REBUILD_WAIT_MS) || 240_000;
const FAKE_CLI = path.join(REPO, 'scripts', 'fixtures', 'feat-200', 'fake-container-cli.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const fails = [];
function check(name, ok, obs) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof obs === 'string' ? obs : JSON.stringify(obs)}`);
  if (ok) pass++; else { fail++; fails.push(name); }
  return ok;
}

/* ------------------------------------------------------------------ scratch dirs */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feat200-e2e-'));
const DATA = path.join(TMP, 'data');
const HOME = path.join(TMP, 'home');
const WORK = path.join(TMP, 'work');
for (const d of [DATA, WORK, path.join(HOME, '.claude', 'projects')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(HOME, '.claude', '.credentials.json'), '{}\n');

/* ------------------------------------------------------------------ docker helpers */
const dkEnv = { ...process.env, DOCKER_HOST: TARGET };
const dk = (args, timeout = 120_000) => { const r = spawnSync('docker', args, { encoding: 'utf8', env: dkEnv, timeout }); return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }; };
const cidOf = (name) => { const r = dk(['inspect', name, '--format', '{{.Id}}']); return r.code === 0 ? r.out : null; };
const inspectJson = (name) => { const r = dk(['inspect', name, '--format', '{{json .}}']); try { return r.code === 0 ? JSON.parse(r.out) : null; } catch { return null; } };

/* ------------------------------------------------------------------ server */
let base = '', serverLog = '', serverProc = null;
const createdContainers = new Set();
const squatters = new Set(); // FEAT-200 r3: containers this suite runs to take a host port (removed by name in cleanup)
async function freePort() { return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }
async function boot({ fast = false, extraEnv = {} } = {}) {
  const port = await freePort();
  const env = isolatedServerEnv({
    PORT: String(port), CLAUDE_STATION_DATA: DATA, DOCKER_HOST: TARGET,
    HOME, CLAUDE_PROJECTS_DIR: path.join(HOME, '.claude', 'projects'), ORCHARD_DISPATCH_SOCK: '',
    ORCHARD_TEST_CONTAINER_CLI: FAKE_CLI, ORCHARD_TEST_CONTAINER_CLI_VERSION: CLI_VERSION,
    CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0', ORCHARD_ACCESS_POLL_MS: '500', ...extraEnv,
  });
  const proc = spawn(process.execPath, [path.join(SRC_TREE, 'src', 'server', 'index.ts')], { cwd: SRC_TREE, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (d) => { serverLog = (serverLog + d).slice(-80000); });
  proc.stderr.on('data', (d) => { serverLog = (serverLog + d).slice(-80000); });
  serverProc = proc;
  spawn(process.execPath, ['-e', `const p=${process.pid},c=${proc.pid};setInterval(()=>{try{process.kill(c,0)}catch{process.exit(0)}try{process.kill(p,0)}catch{try{process.kill(c,'SIGKILL')}catch{}process.exit(0)}},1000)`], { detached: true, stdio: 'ignore' }).unref();
  base = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let i = 0; i < 200 && !healthy; i++) { try { const r = await fetch(`${base}/api/health`); if (r.ok) healthy = true; } catch { /* */ } if (proc.exitCode !== null) throw new Error(`server exited early (${proc.exitCode}): ${serverLog.slice(-2000)}`); if (!healthy) await sleep(250); }
  if (!healthy) throw new Error(`server never healthy: ${serverLog.slice(-2000)}`);
  if (fast) return; // FEAT-200 r7 block C: act at once after a restart, before the reconciler's first pass
  for (let i = 0; i < 240 && !/base-pin migration (done|skipped)/.test(serverLog); i++) await sleep(250);
}
async function api(p, method = 'GET', body) {
  const r = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* */ }
  return { status: r.status, body: j };
}
async function health() { try { return await (await fetch(`${base}/api/health`)).json(); } catch { return null; } }
async function sdkIdFor(station) { const h = await health(); return (h?.sessions ?? []).find((s) => s.stationSessionId === station)?.sdkSessionId ?? null; }
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

function makeRepo(name) {
  const dir = path.join(WORK, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  return dir;
}
/** Per-run project names, so a container left by an earlier, killed run (another data dir owns it) never collides. */
const RUN_TAG = crypto.randomBytes(2).toString('hex');
async function registerProject(name, isolation = 'container') {
  const dir = makeRepo(name);
  const r = await api('/api/projects', 'POST', { hostPath: dir, name: `f200-${name}-${RUN_TAG}`, isolation, applyMethod: false, settings: { ...(isolation === 'container' ? { container: { gpu: 'off' } } : {}), tools: { serena: false, playwright: false, openaiDispatch: false } } });
  const id = r.body?.project?.id;
  if (!id) throw new Error(`register ${name} failed: ${JSON.stringify(r)}`);
  const cname = `claude-station-${id}`;
  createdContainers.add(cname);
  return { id, dir, cname };
}
async function startSession(projectId, prompt) {
  const c = await openWs();
  c.send({ type: 'start', projectId, prompt, overrides: { permissionMode: 'default' } });
  const ack = await waitEv(c, (e) => (e.t === 'ack' && e.of === 'start'), 180_000);
  if (!ack) { c.close(); throw new Error(`start never acked for ${projectId}: ${JSON.stringify(c.events.slice(-6))}`); }
  const station = ack.stationSessionId;
  const sdk = await waitFor(() => sdkIdFor(station), 60_000);
  await waitEv(c, (e) => e.t === 'turn-end', 60_000);
  return { c, station, sdk };
}
async function say(s, text) {
  const n = s.c.events.length;
  const sendId = `s-${crypto.randomUUID()}`;
  s.c.send({ type: 'send', prompt: text, sendId });
  await waitFor(() => s.c.events.slice(n).find((e) => e.t === 'turn-end'), 90_000);
  return s.c.events.slice(n);
}
const assistantText = (evs) => evs.filter((e) => e.t === 'assistant' || e.t === 'text' || e.t === 'assistant-text').map((e) => JSON.stringify(e)).join('\n');
const received = (dir) => { try { return fs.readFileSync(path.join(dir, '.feat200-received.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const projectGet = async (id) => (await api(`/api/projects/${id}`)).body?.project;
const accessList = async (id) => (await api(`/api/projects/${id}/access-requests`)).body?.requests ?? [];
async function raise(s, p, body) {
  const evs = await say(s, `[[access:${JSON.stringify(body)}]]`);
  const t = assistantText(evs);
  const m = /(acc-[a-z0-9]+-[a-z0-9]+)/.exec(t);
  const rec = m ? (await accessList(p.id)).find((r) => r.id === m[1]) : null;
  return { text: t, id: m?.[1] ?? null, rec };
}

/** Run one HTTP call from a process in a transient Orchard session-host scope (where an agent's Bash runs). */
function agentProbe(method, urlPath, body) {
  const unit = `claude-station-host-t-feat200-${crypto.randomBytes(4).toString('hex')}`;
  const js = `fetch(${JSON.stringify(base + urlPath)},{method:${JSON.stringify(method)},headers:{'content-type':'application/json'},body:${JSON.stringify(body ? JSON.stringify(body) : undefined)}}).then(async r=>{console.log(JSON.stringify({status:r.status,body:await r.text()}))}).catch(e=>console.log(JSON.stringify({status:-1,body:String(e)})))`;
  const r = spawnSync('systemd-run', ['--user', '--scope', '--quiet', `--unit=${unit}`, process.execPath, '-e', js], { encoding: 'utf8', timeout: 30_000 });
  try { const o = JSON.parse((r.stdout || '').trim().split('\n').pop()); let b = null; try { b = JSON.parse(o.body); } catch { b = o.body; } return { status: o.status, body: b, unit }; } catch { return { status: -2, body: (r.stderr || r.stdout || '').slice(0, 300), unit }; }
}

async function cleanup() {
  if (serverProc && serverProc.exitCode === null) { try { process.kill(serverProc.pid, 'SIGTERM'); } catch { /* */ } for (let i = 0; i < 40 && serverProc.exitCode === null; i++) await sleep(200); if (serverProc.exitCode === null) { try { process.kill(serverProc.pid, 'SIGKILL'); } catch { /* */ } } }
  for (const n of squatters) dk(['rm', '-f', n]);
  let OWNER = '';
  try { OWNER = await ownerKeyFor(DATA); } catch { /* */ }
  for (const n of createdContainers) { try { removeOwnedContainer(n, OWNER); } catch { /* */ } }
  if (/^[0-9a-f]{16}$/.test(OWNER)) {
    for (const id of dk(['ps', '-aq', '--filter', `label=claude-station.owner=${OWNER}`]).out.split('\n').filter(Boolean)) dk(['rm', '-f', '-v', id]);
    for (const id of dk(['images', '-q', '--filter', `label=claude-station.owner=${OWNER}`]).out.split('\n').filter(Boolean)) dk(['image', 'rm', '-f', id]);
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
}

/* ================================================================== RUN */
const MONGO = 'mongodb://host.docker.internal:27017/app';
let A, S1;
let hostPortFree = 0;
try {
  await boot();
  console.log(`scratch server ${base} (tree ${SRC_TREE}); docker ${TARGET}`);
  A = await registerProject('alpha');
  S1 = await startSession(A.id, 'hello');
  const c0 = cidOf(A.cname);
  check('setup: project alpha has a running container and a live session', !!c0 && !!S1.sdk, { container: (c0 ?? '').slice(0, 12), sdk: S1.sdk });

  if (want('I')) {
    console.log('\n--- I: container sessions are launched with the "Container access" instructions');
    const launch = (() => { try { return fs.readFileSync(path.join(A.dir, '.feat200-launch.jsonl'), 'utf8'); } catch { return ''; } })();
    check('I1 the container session\'s launch carries "## Container access (Orchard)" and the inbox recipe', /## Container access \(Orchard\)/.test(launch) && /ORCHARD_ACCESS_DIR/.test(launch), `${launch.length} bytes; has section=${/## Container access/.test(launch)}`);
    const rcv = received(A.dir);
    check('I2 the container session\'s exec env names its inbox (ORCHARD_ACCESS_DIR)', !!rcv[0]?.accessDir && rcv[0].accessDir.includes('/.claude/projects/'), rcv[0]?.accessDir ?? null);
  }

  // ---- K: a REAL host collision first (127.0.0.1:3000 is in use on this machine), then L, then the real request.
  if (want('K') || want('P')) {
    console.log('\n--- K/A: raise from INSIDE the container; a real host-port collision is caught');
    const before = await projectGet(A.id);
    const k = await raise(S1, A, { reason: 'integration tests need the local MongoDB; the user wants to open the dev server', env: { MONGODB_URI: MONGO }, ports: [{ containerPort: 3000, hostPort: 3000 }] });
    const busy3000 = await new Promise((res) => { const s = net.createServer(); s.once('error', () => res(true)); s.listen({ host: '127.0.0.1', port: 3000, exclusive: true }, () => s.close(() => res(false))); });
    check('A1 the request was raised from inside the container (reply ok with an id)', !!k.id, k.text.slice(0, 300));
    check('A2 the record is PENDING with exactly the asked changes', k.rec && !k.rec.decision && k.rec.changes.length === 2 && k.rec.changes[0].key === 'MONGODB_URI' && k.rec.changes[1].hostIp === '127.0.0.1', k.rec?.changes);
    check('K1 this machine really has 127.0.0.1:3000 in use, and the record says so (conflict shown)', busy3000 && (k.rec?.conflicts ?? []).some((c) => /3000.*in use on this machine/.test(c)), { busy3000, conflicts: k.rec?.conflicts });
    const ap = await api(`/api/projects/${A.id}/access-requests/${k.id}/decide`, 'POST', { verdict: 'approve' });
    check('K2 approving it is refused 409 port-conflict; still pending', ap.status === 409 && ap.body?.code === 'port-conflict' && !(await accessList(A.id)).find((r) => r.id === k.id)?.decision, { status: ap.status, body: ap.body });
    const after = await projectGet(A.id);
    check('A3 nothing was written: project env/ports unchanged', JSON.stringify(before.settings.container?.env ?? {}) === JSON.stringify(after.settings.container?.env ?? {}) && JSON.stringify(after.settings.container?.ports ?? []) === '[]', after.settings.container);
    const envIn = inspectJson(A.cname)?.Config?.Env ?? [];
    check('A4 nothing reached the container: no MONGODB_URI in its env', !envIn.some((e) => e.startsWith('MONGODB_URI=')), envIn.filter((e) => /MONGO/.test(e)));
    const card = (await api(`/api/sessions/${S1.sdk}/access-requests`)).body?.requests ?? [];
    check('A5 the session\'s own card endpoint lists it', card.some((r) => r.id === k.id), card.map((r) => r.id));
    const rj = await api(`/api/projects/${A.id}/access-requests/${k.id}/decide`, 'POST', { verdict: 'reject' });
    check('K3 the user rejects the conflicting one (200)', rj.status === 200 && rj.body?.request?.decision?.verdict === 'rejected', { status: rj.status });
    await waitFor(() => received(A.dir).find((r) => /\[station\] denied: env MONGODB_URI/.test(r.text)), 60_000);
  }

  if (want('L')) {
    console.log('\n--- L: a non-loopback publish cannot be asked for, nor set by PATCH');
    const l = await raise(S1, A, { reason: 'x', ports: [{ containerPort: 3000, hostPort: 3001, hostIp: '0.0.0.0' }] });
    check('L1 a request naming hostIp 0.0.0.0 is refused by the channel (no record)', !l.id && /not settable/.test(l.text), l.text.slice(0, 240));
    const pt = await api(`/api/projects/${A.id}`, 'PATCH', { settings: { container: { ports: [{ hostPort: 3001, containerPort: 3000, hostIp: '0.0.0.0' }] } } });
    check('L2 a user PATCH with a hostIp is refused 400', pt.status === 400 && /not settable/.test(pt.body?.error ?? ''), pt);
  }

  let P1 = null;
  if (want('G') || want('P')) {
    console.log('\n--- A/G: the real request, then agent callers are refused');
    hostPortFree = await freePort();
    P1 = await raise(S1, A, { reason: 'integration tests need the local MongoDB; the user wants to open the dev server', env: { MONGODB_URI: MONGO }, ports: [{ containerPort: 3000, hostPort: hostPortFree }] });
    check('A6 the request (container 3000 → free host port) is raised, pending, no conflict', !!P1.id && P1.rec && !P1.rec.decision && P1.rec.conflicts.length === 0, { id: P1.id, conflicts: P1.rec?.conflicts, hostPort: hostPortFree });
  }
  if (want('G')) {
    const before = await projectGet(A.id);
    const g1 = P1?.id ? agentProbe('POST', `/api/projects/${A.id}/access-requests/${P1.id}/decide`, { verdict: 'approve' }) : { status: 'no request was raised', body: null };
    check('G1 an agent (session-scope process) approving its own request → 403 agent-not-user', g1.status === 403 && g1.body?.code === 'agent-not-user', g1);
    const g2 = agentProbe('PATCH', `/api/projects/${A.id}`, { settings: { container: { env: { MONGODB_URI: MONGO }, ports: [{ hostPort: hostPortFree, containerPort: 3000 }] } } });
    check('G2 an agent PATCHing env/ports directly → 403 agent-not-user', g2.status === 403 && g2.body?.code === 'agent-not-user', g2);
    const g3 = agentProbe('PATCH', `/api/projects/${A.id}`, { settings: { container: { dockerSocket: true } } });
    check('G3 an agent turning on the docker socket → 403', g3.status === 403, g3);
    const g4 = agentProbe('PATCH', `/api/projects/${A.id}`, { isolation: 'direct' });
    check('G4 an agent switching the project out of the container → 403', g4.status === 403, g4);
    // IV r1 break: an image / Dockerfile of the agent's choosing can bake any non-reserved ENV — so they are gated too.
    const g4b = agentProbe('PATCH', `/api/projects/${A.id}`, { settings: { container: { image: 'docker.io/library/agent-chosen:latest' } } });
    check('G4b an agent re-pointing the container image → 403', g4b.status === 403 && g4b.body?.code === 'agent-not-user', g4b);
    const g4c = agentProbe('PATCH', `/api/projects/${A.id}`, { settings: { container: { dockerfile: 'Dockerfile' } } });
    check('G4c an agent setting a Dockerfile → 403', g4c.status === 403 && g4c.body?.code === 'agent-not-user', g4c);
    const g4d = agentProbe('PATCH', `/api/projects/${A.id}`, { settings: { container: { gpu: 'on' } } });
    check('G4d an agent turning GPU passthrough on → 403', g4d.status === 403, g4d);
    const g4e = agentProbe('PATCH', `/api/projects/${A.id}`, { settings: { browser: { enabled: true } } });
    check('G4e an agent attaching the stealth browser → 403', g4e.status === 403, g4e);
    const g4f = agentProbe('PATCH', `/api/projects/${A.id}`, { settings: { mounts: [{ hostPath: WORK, containerPath: '/mnt/work', readOnly: false }] } });
    check('G4f an agent adding a mount → 403', g4f.status === 403, g4f);
    const g5 = agentProbe('POST', `/api/projects/${A.id}/board/answer`, { id: P1?.id ?? 'acc-none-000000', answer: 'Allow' });
    check('G5 the generic answer route refuses an access id (409 use-access-decide)', g5.status === 409 && g5.body?.code === 'use-access-decide', g5);
    const g6 = agentProbe('POST', '/api/projects', { hostPath: makeRepo('sneaky'), name: 'sneaky', isolation: 'container', settings: { container: { env: { X: 'y' } } } });
    check('G6 an agent creating a project that carries env → 403', g6.status === 403, g6);
    const g6b = agentProbe('POST', '/api/projects', { hostPath: makeRepo('sneaky2'), name: 'sneaky2', isolation: 'container', settings: { container: { image: 'docker.io/library/agent-chosen:latest' } } });
    check('G6b an agent creating a project on an image of its choosing → 403', g6b.status === 403, g6b);
    const after = await projectGet(A.id);
    const rec = P1?.id ? (await accessList(A.id)).find((r) => r.id === P1.id) : null;
    check('G7 after all of that: still pending, settings byte-identical', !!rec && !rec.decision && JSON.stringify(before.settings) === JSON.stringify(after.settings) && after.isolation === 'container', { decision: rec?.decision ?? null, envAfter: after.settings.container?.env, isolation: after.isolation });
    const u = await api(`/api/projects/${A.id}`, 'PATCH', { settings: { container: { memoryMb: before.settings.container?.memoryMb ?? 8192 } } });
    check('G8 a USER (this test, launcher cgroup) PATCH of an ordinary field still works', u.status === 200, u.status);
  }

  if (want('P') && P1?.id) {
    console.log('\n--- P: approve → settings → idle recreate → docker inspect → resumed "access granted"');
    const c1 = cidOf(A.cname);
    const ap = await api(`/api/projects/${A.id}/access-requests/${P1.id}/decide`, 'POST', { verdict: 'approve' });
    check('P1 the USER approves (200, typed decision approved by user, APPROVED-PENDING: applied=false — r5 commit on success)', ap.status === 200 && ap.body?.request?.decision?.verdict === 'approved' && ap.body.request.decision.by === 'user' && ap.body.request.decision.applied === false, ap.body?.request?.decision ?? ap);
    const proj = await projectGet(A.id);
    check('P2 approval wrote NOTHING to the settings yet (it is written once a running container carries it)', !('MONGODB_URI' in (proj.settings.container?.env ?? {})) && !(proj.settings.container?.ports ?? []).length, proj.settings.container);
    const c2 = await waitFor(() => { const id = cidOf(A.cname); return id && id !== c1 ? id : null; }, REBUILD_WAIT, 500);
    check('P3 the reconciler RECREATED the container once the project was idle (new id)', !!c2, { before: (c1 ?? '').slice(0, 12), after: (c2 ?? '').slice(0, 12) });
    const ins = inspectJson(A.cname);
    const pb = ins?.HostConfig?.PortBindings ?? null;
    const envIn = ins?.Config?.Env ?? [];
    console.log(`        docker inspect ${A.cname}: Env[MONGODB_URI]=${JSON.stringify(envIn.find((e) => e.startsWith('MONGODB_URI=')))} HostConfig.PortBindings=${JSON.stringify(pb)} NetworkSettings.Ports=${JSON.stringify(ins?.NetworkSettings?.Ports ?? null)}`);
    check('P4 docker inspect: Env has MONGODB_URI', envIn.includes(`MONGODB_URI=${MONGO}`), envIn.filter((e) => /MONGO/.test(e)));
    const binds = Object.values(pb ?? {}).flat();
    check('P5 docker inspect: PortBindings is exactly 3000/tcp → 127.0.0.1:<host>, NO other interface', JSON.stringify(pb) === JSON.stringify({ '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: String(hostPortFree) }] }) && binds.every((b) => b.HostIp === '127.0.0.1'), pb);
    const got = await waitFor(() => received(A.dir).find((r) => /\[station\] access granted: /.test(r.text) && r.text.includes(P1.id) === false && /MONGODB_URI/.test(r.text)), 120_000, 500);
    check('P6 the requesting session was resumed with "[station] access granted: <what>, continue"', !!got && /access granted: env MONGODB_URI=mongodb:\/\/host\.docker\.internal:27017\/app; port 127\.0\.0\.1:\d+ → container 3000, continue/.test(got.text), got?.text ?? null);
    check('P7 …in the NEW container: that turn\'s process sees MONGODB_URI in its env', got?.mongodbUri === MONGO, got?.mongodbUri ?? null);
    const rec = await waitFor(async () => { const r = (await accessList(A.id)).find((x) => x.id === P1.id); return r?.delivery === 'delivered' ? r : null; }, 60_000);
    check('P8 the card reads the REAL outbox row: delivered', rec?.delivery === 'delivered' && rec?.resume?.state === 'queued', { delivery: rec?.delivery, resume: rec?.resume?.state });
    const proj2 = await projectGet(A.id);
    check('P9 COMMITTED: once the container carried it, the settings carry the env and the loopback port, and the record is applied', proj2.settings.container?.env?.MONGODB_URI === MONGO && JSON.stringify(proj2.settings.container?.ports) === JSON.stringify([{ hostPort: hostPortFree, containerPort: 3000 }]) && rec?.decision?.applied === true, { container: proj2.settings.container, applied: rec?.decision?.applied });
  }

  if (want('B')) {
    console.log('\n--- B: approve while ANOTHER session of the project runs a turn: no recreate until it ends');
    const busy = await openWs();
    busy.send({ type: 'start', projectId: A.id, prompt: '[[sleep:60000]]', overrides: { permissionMode: 'default' } });
    await waitEv(busy, (e) => e.t === 'ack' && e.of === 'start', 120_000);
    await waitEv(busy, (e) => e.t === 'assistant' || e.t === 'text' || e.t === 'assistant-text', 60_000);
    const S5 = await startSession(A.id, 'hello from the requester');
    const b = await raise(S5, A, { reason: 'feature flag for the e2e run', env: { E2E_FLAG: 'on' } });
    const c3 = cidOf(A.cname);
    const h0 = await health();
    console.log(`        diag: busy ws events=${JSON.stringify(busy.events.map((e) => e.t))}`);
    console.log(`        diag: server sessions=${JSON.stringify((h0?.sessions ?? []).map((x) => ({ st: x.stationSessionId?.slice(0, 8), sdk: x.sdkSessionId?.slice(0, 8), busy: x.busy, state: x.state ?? x.liveness?.state ?? null, project: x.projectId })))}`);
    const ap = await api(`/api/projects/${A.id}/access-requests/${b.id}/decide`, 'POST', { verdict: 'approve' });
    const samples = [];
    for (let i = 0; i < 5; i++) { await sleep(2000); samples.push(cidOf(A.cname) === c3); }
    check('B1 approved while a turn runs in another session: container NOT recreated during the turn (10 s sampled)', ap.status === 200 && samples.every(Boolean), { status: ap.status, samples });
    const c4 = await waitFor(() => { const id = cidOf(A.cname); return id && id !== c3 ? id : null; }, REBUILD_WAIT, 500);
    const endedAt = busy.events.find((e) => e.t === 'turn-end')?.at ?? null;
    check('B2 …recreated only after that turn ended', !!c4 && !!endedAt, { recreated: !!c4, turnEnded: !!endedAt });
    const envIn = inspectJson(A.cname)?.Config?.Env ?? [];
    check('B3 the new container has E2E_FLAG=on (and still MONGODB_URI)', envIn.includes('E2E_FLAG=on') && (!want('P') || envIn.includes(`MONGODB_URI=${MONGO}`)), envIn.filter((e) => /E2E|MONGO/.test(e)));
    const got = await waitFor(() => received(A.dir).find((r) => /\[station\] access granted: env E2E_FLAG=on, continue/.test(r.text)), 120_000, 500);
    check('B4 the requester was resumed with access granted', !!got, got?.text ?? null);
    busy.close(); S5.c.close();
  }

  if (want('R')) {
    console.log('\n--- R: reject → nothing written, no recreate → "denied: …"');
    const S6 = await startSession(A.id, 'hello again');
    const r = await raise(S6, A, { reason: 'would like a second database', env: { SECOND_DB: 'postgres://host.docker.internal:5432/x' } });
    const c5 = cidOf(A.cname);
    const rj = await api(`/api/projects/${A.id}/access-requests/${r.id}/decide`, 'POST', { verdict: 'reject' });
    check('R1 the user rejects (200, typed rejected)', rj.status === 200 && rj.body?.request?.decision?.verdict === 'rejected', rj.body?.request?.decision ?? rj);
    const got = await waitFor(() => received(A.dir).find((r2) => /\[station\] denied: env SECOND_DB=/.test(r2.text)), 60_000, 500);
    check('R2 the session was resumed with "[station] denied: <what>"', !!got, got?.text ?? null);
    await sleep(4000);
    const proj = await projectGet(A.id);
    check('R3 nothing written, container not recreated', !('SECOND_DB' in (proj.settings.container?.env ?? {})) && cidOf(A.cname) === c5, { env: proj.settings.container?.env, same: cidOf(A.cname) === c5 });
    const again = await api(`/api/projects/${A.id}/access-requests/${r.id}/decide`, 'POST', { verdict: 'approve' });
    check('R4 a decided request cannot be decided again (409 already-decided)', again.status === 409 && again.body?.code === 'already-decided', again.status);
    S6.c.close();
  }

  if (want('K')) {
    console.log('\n--- K: cross-project collision');
    const Bp = await registerProject('beta');
    const S7 = await startSession(Bp.id, 'hello');
    const port = hostPortFree || 13000;
    const k = await raise(S7, Bp, { reason: 'my own dev server', ports: [{ containerPort: 8080, hostPort: port }] });
    const shows = (k.rec?.conflicts ?? []).some((c) => /already published by (project|container)/.test(c));
    check('K4 another project asking for a host port alpha already publishes: conflict on the record', !!k.id && (want('P') ? shows : true), k.rec?.conflicts);
    const ap = await api(`/api/projects/${Bp.id}/access-requests/${k.id}/decide`, 'POST', { verdict: 'approve' });
    check('K5 approving it is refused 409 port-conflict', !want('P') || (ap.status === 409 && ap.body?.code === 'port-conflict'), { status: ap.status, body: ap.body });
    const pt = await api(`/api/projects/${Bp.id}`, 'PATCH', { settings: { container: { ports: [{ hostPort: port, containerPort: 8080 }] } } });
    check('K6 a user PATCH taking alpha\'s host port is refused 409 too (every writer checks)', !want('P') || (pt.status === 409 && pt.body?.code === 'port-conflict'), { status: pt.status, error: pt.body?.error });
    S7.c.close();
  }

  /*
   * X — property (c) after the round-3 design review (REDESIGN): Docker's own start is the allocation authority,
   * a refused replacement never removes the working container, the approved-but-unappliable change is reverted
   * and the requester is told "approved, but could not be applied: <reason>", nothing loops or holds.
   */
  if (want('Y')) {
    /*
     * FEAT-200 r5 — the four recorded breaks of the REVERT property, replayed over HTTP against a REAL docker refusal
     * (a container squatting 127.0.0.1:H after approval, while another session's turn holds the idle recreate).
     * Tree-agnostic: the must-FAIL baseline is `--tree <pre-r5 copy>`.
     */
    const IMG = dk(['images', '--format', '{{.Repository}}:{{.Tag}}']).out.split('\n').find((x) => x.startsWith('claude-station-rt:')) ?? null;
    const squatY = (hostPort) => {
      const n = `f200r5-squat-${crypto.randomBytes(3).toString('hex')}`;
      squatters.add(n);
      const r = dk(['run', '-d', '--name', n, '--label', 'f200r5=1', '-p', `127.0.0.1:${hostPort}:80`, '--entrypoint', 'sleep', IMG, '900']);
      return r.code === 0;
    };
    const holdTurn = async (pid, ms) => {
      const busy = await openWs();
      busy.send({ type: 'start', projectId: pid, prompt: `[[sleep:${ms}]]`, overrides: { permissionMode: 'default' } });
      await waitEv(busy, (e) => e.t === 'ack' && e.of === 'start', 120_000);
      await waitEv(busy, (e) => e.t === 'assistant' || e.t === 'text' || e.t === 'assistant-text', 60_000);
      return busy;
    };
    const approve = (pid, rid) => api(`/api/projects/${pid}/access-requests/${rid}/decide`, 'POST', { verdict: 'approve' });
    const toldOf = (dir, rid, what) => received(dir).find((r) => r.text.includes(rid) || (what && r.text.includes(what)));
    const settled = async (P, ids) => waitFor(async () => { const l = await accessList(P.id); return ids.every((id) => l.find((r) => r.id === id)?.resume?.state === 'queued') ? l : null; }, 200_000, 1000);
    const envOf = (cname) => Object.fromEntries((inspectJson(cname)?.Config?.Env ?? []).map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
    const pbOf = (cname) => Object.values(inspectJson(cname)?.HostConfig?.PortBindings ?? {}).flat().map((b) => Number(b.HostPort));

    console.log('\n--- Y1: r3 — two pending requests set K=new (same value), different ports; A\'s port taken after approval');
    {
      const P = await registerProject('yone');
      await api(`/api/projects/${P.id}`, 'PATCH', { settings: { container: { env: { YK: 'old' } } } });
      const S = await startSession(P.id, 'hello y1');
      const [HA, HB] = [await freePort(), await freePort()];
      const a = await raise(S, P, { reason: 'y1 a', env: { YK: 'new' }, ports: [{ containerPort: 8080, hostPort: HA }] });
      const b = await raise(S, P, { reason: 'y1 b', env: { YK: 'new' }, ports: [{ containerPort: 8081, hostPort: HB }] });
      const busy = await holdTurn(P.id, 30_000);
      const apA = await approve(P.id, a.id); const apB = await approve(P.id, b.id);
      const sq = squatY(HA);
      check('Y1 setup: both raised and approved while a turn runs; then 127.0.0.1:HA is taken', !!a.id && !!b.id && apA.status === 200 && apB.status === 200 && sq, { a: a.id, b: b.id, apA: apA.status, apB: apB.status, sq });
      await waitFor(() => busy.events.find((e) => e.t === 'turn-end'), 90_000);
      await settled(P, [a.id, b.id].filter(Boolean));
      await sleep(3000);
      const pj = await projectGet(P.id);
      check('Y1a settings = base + B: YK=new, HB published, HA not', pj.settings.container?.env?.YK === 'new' && (pj.settings.container?.ports ?? []).some((x) => x.hostPort === HB) && !(pj.settings.container?.ports ?? []).some((x) => x.hostPort === HA), pj.settings.container);
      check('Y1b the running container carries exactly that (YK=new, publishes HB only)', envOf(P.cname).YK === 'new' && JSON.stringify(pbOf(P.cname)) === JSON.stringify([HB]), { env: envOf(P.cname).YK, pb: pbOf(P.cname) });
      const tA = toldOf(P.dir, a.id); const tB = received(P.dir).find((r) => r.text.includes(`127.0.0.1:${HB}`));
      check('Y1c A told "could not be applied"; B told "access granted"', /could not be applied/.test(tA?.text ?? '') && /access granted/.test(tB?.text ?? ''), { A: tA?.text?.slice(0, 120) ?? null, B: tB?.text?.slice(0, 120) ?? null });
      busy.close(); S.c.close();
    }

    console.log('\n--- Y2: r4 — A asks HA+HS, B independently asks HS; HA taken after approval');
    {
      const P = await registerProject('ytwo');
      const S = await startSession(P.id, 'hello y2');
      const [HA, HS] = [await freePort(), await freePort()];
      const a = await raise(S, P, { reason: 'y2 a', ports: [{ containerPort: 8080, hostPort: HA }, { containerPort: 9000, hostPort: HS }] });
      const b = await raise(S, P, { reason: 'y2 b', ports: [{ containerPort: 9000, hostPort: HS }] });
      const busy = await holdTurn(P.id, 30_000);
      const apA = await approve(P.id, a.id); const apB = await approve(P.id, b.id);
      const sq = squatY(HA);
      check('Y2 setup: both raised and approved while a turn runs; then 127.0.0.1:HA is taken', !!a.id && !!b.id && apA.status === 200 && apB.status === 200 && sq, { apA: apA.status, apB: apB.status, sq });
      await waitFor(() => busy.events.find((e) => e.t === 'turn-end'), 90_000);
      await settled(P, [a.id, b.id].filter(Boolean));
      await sleep(3000);
      const pj = await projectGet(P.id);
      check('Y2a settings keep B\'s HS (docker never refused it), not A\'s HA', (pj.settings.container?.ports ?? []).some((x) => x.hostPort === HS) && !(pj.settings.container?.ports ?? []).some((x) => x.hostPort === HA), pj.settings.container?.ports ?? []);
      check('Y2b the running container publishes HS', JSON.stringify(pbOf(P.cname)) === JSON.stringify([HS]), pbOf(P.cname));
      const l = await accessList(P.id);
      const tB = l.find((r) => r.id === b.id)?.resume?.text ?? '';
      check('Y2c B told "access granted" (not "settings changed since"); A told "could not be applied"', /access granted/.test(tB) && /could not be applied/.test(l.find((r) => r.id === a.id)?.resume?.text ?? ''), { A: l.find((r) => r.id === a.id)?.resume?.text?.slice(0, 100), B: tB.slice(0, 140) });
      busy.close(); S.c.close();
    }

    console.log('\n--- Y3: r4 C1 — stale provenance: C applied YK=new, the USER deletes YK, then A sets YK=new + a port taken after approval');
    {
      const P = await registerProject('ythree');
      const S = await startSession(P.id, 'hello y3');
      const c = await raise(S, P, { reason: 'y3 c', env: { YK: 'new' } });
      const apC = await approve(P.id, c.id);
      await settled(P, [c.id]);
      const cOk = (await projectGet(P.id)).settings.container?.env?.YK === 'new';
      const del = await api(`/api/projects/${P.id}`, 'PATCH', { settings: { container: { env: {} } } });
      await waitFor(() => !('YK' in envOf(P.cname)) ? true : null, REBUILD_WAIT, 1000);
      const H = await freePort();
      // The recreates above closed S (resumably, FEAT-175); raise from a fresh session of the project.
      const S2 = await startSession(P.id, 'hello y3 again');
      const a = await raise(S2, P, { reason: 'y3 a', env: { YK: 'new' }, ports: [{ containerPort: 8080, hostPort: H }] });
      const busy = await holdTurn(P.id, 30_000);
      const apA = await approve(P.id, a.id);
      const sq = squatY(H);
      check('Y3 setup: C applied (YK=new in settings), the user deleted YK, A raised + approved, then its port taken', apC.status === 200 && cOk && del.status === 200 && !!a.id && apA.status === 200 && sq, { apC: apC.status, cOk, del: del.status, apA: apA.status, sq });
      await waitFor(() => busy.events.find((e) => e.t === 'turn-end'), 90_000);
      await settled(P, [a.id].filter(Boolean));
      await sleep(3000);
      const pj = await projectGet(P.id);
      check('Y3a the user\'s delete stands: YK not in the settings, nor in the running container', !('YK' in (pj.settings.container?.env ?? {})) && !('YK' in envOf(P.cname)), { settings: pj.settings.container?.env, container: envOf(P.cname).YK ?? null });
      const tA = (await accessList(P.id)).find((r) => r.id === a.id)?.resume?.text ?? '';
      check('Y3b A told "could not be applied" (true)', /could not be applied/.test(tA), tA.slice(0, 120));
      busy.close(); S.c.close(); S2.c.close();
    }

    console.log('\n--- Y4: r4 C2 — chained same-key refusals: A sets YK old→new1 + P1, B sets YK→new2 + P2; both ports taken');
    {
      const P = await registerProject('yfour');
      await api(`/api/projects/${P.id}`, 'PATCH', { settings: { container: { env: { YK: 'old' } } } });
      const S = await startSession(P.id, 'hello y4');
      const [P1p, P2p] = [await freePort(), await freePort()];
      const busy = await holdTurn(P.id, 40_000);
      const a = await raise(S, P, { reason: 'y4 a', env: { YK: 'new1' }, ports: [{ containerPort: 8080, hostPort: P1p }] });
      const apA = await approve(P.id, a.id);
      const b = await raise(S, P, { reason: 'y4 b', env: { YK: 'new2' }, ports: [{ containerPort: 8081, hostPort: P2p }] });
      const apB = await approve(P.id, b.id);
      const sq = squatY(P1p) && squatY(P2p);
      check('Y4 setup: A approved, then B raised and approved, while a turn runs; then both ports taken', !!a.id && !!b.id && apA.status === 200 && apB.status === 200 && sq, { apA: apA.status, apB: apB.status, sq });
      await waitFor(() => busy.events.find((e) => e.t === 'turn-end'), 90_000);
      await settled(P, [a.id, b.id].filter(Boolean));
      await sleep(3000);
      const pj = await projectGet(P.id);
      check('Y4a neither applied → YK is exactly the base "old" (never A\'s refused "new1"), no ports', pj.settings.container?.env?.YK === 'old' && !(pj.settings.container?.ports ?? []).length, pj.settings.container);
      check('Y4b the running container carries YK=old and publishes nothing', envOf(P.cname).YK === 'old' && pbOf(P.cname).length === 0, { env: envOf(P.cname).YK, pb: pbOf(P.cname) });
      const l = await accessList(P.id);
      check('Y4c both requesters told "could not be applied"', [a.id, b.id].every((id) => /could not be applied/.test(l.find((r) => r.id === id)?.resume?.text ?? '')), l.filter((r) => [a.id, b.id].includes(r.id)).map((r) => r.resume?.text?.slice(0, 80)));
      busy.close(); S.c.close();
    }
  }

  if (want('U')) {
    /*
     * FEAT-200 r6 — a user's save that touches a key or port named by an APPROVED-but-unapplied request cancels it
     * (edit versions stamped by the one registry writer; decided by the commit pass). Replays the three IV r5
     * (9095680c) sequences over HTTP on a real scratch server + real containers, plus the card's Cancel (user-only),
     * the drawer's view of pending requests, no false cancel, and a user port docker refused made visible.
     * Each request is approved while ANOTHER session's turn holds the idle recreate, so the edits land while it is
     * approved-pending. Must FAIL on a pre-r6 tree (`--tree`).
     */
    const IMG = dk(['images', '--format', '{{.Repository}}:{{.Tag}}']).out.split('\n').find((x) => x.startsWith('claude-station-rt:')) ?? null;
    const squatU = (hostPort) => {
      const n = `f200r6-squat-${crypto.randomBytes(3).toString('hex')}`;
      squatters.add(n);
      return dk(['run', '-d', '--name', n, '--label', 'f200r6=1', '-p', `127.0.0.1:${hostPort}:80`, '--entrypoint', 'sleep', IMG, '900']).code === 0;
    };
    const holdTurn = async (pid, ms) => {
      const busy = await openWs();
      busy.send({ type: 'start', projectId: pid, prompt: `[[sleep:${ms}]]`, overrides: { permissionMode: 'default' } });
      await waitEv(busy, (e) => e.t === 'ack' && e.of === 'start', 120_000);
      await waitEv(busy, (e) => e.t === 'assistant' || e.t === 'text' || e.t === 'assistant-text', 60_000);
      return busy;
    };
    const approve = (pid, rid) => api(`/api/projects/${pid}/access-requests/${rid}/decide`, 'POST', { verdict: 'approve' });
    const settled = async (P, ids) => waitFor(async () => { const l = await accessList(P.id); return ids.every((id) => l.find((r) => r.id === id)?.resume?.state === 'queued') ? l : null; }, 200_000, 1000);
    const envOf = (cname) => Object.fromEntries((inspectJson(cname)?.Config?.Env ?? []).map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
    const pbOf = (cname) => Object.values(inspectJson(cname)?.HostConfig?.PortBindings ?? {}).flat().map((b) => Number(b.HostPort));
    const patchEnv = (P, env) => api(`/api/projects/${P.id}`, 'PATCH', { settings: { container: { env } } });
    const patchPorts = (P, ports) => api(`/api/projects/${P.id}`, 'PATCH', { settings: { container: { ports } } });
    const textFor = async (P, rid) => (await accessList(P.id)).find((r) => r.id === rid)?.resume?.text ?? '';

    console.log('\n--- U1: r5 seq 1 — base UK=old; A (old→new) approved-pending; the user saves UK=new, then UK=old');
    {
      const P = await registerProject('uone');
      await patchEnv(P, { UK: 'old' });
      const S = await startSession(P.id, 'hello u1');
      const busy = await holdTurn(P.id, 30_000);
      const a = await raise(S, P, { reason: 'u1', env: { UK: 'new' } });
      const ap = await approve(P.id, a.id);
      const st = await api(`/api/projects/${P.id}/container/status`);
      const pend = st.body?.access?.pending ?? [];
      check('U0 the drawer\'s container status lists the approved-pending request with the env key it names (the warning\'s input)', pend.some((x) => x.id === a.id && (x.env ?? []).includes('UK')), pend);
      const s1 = await patchEnv(P, { UK: 'new' }); const s2 = await patchEnv(P, { UK: 'old' });
      check('U1 setup: raised, approved while a turn runs, then two user saves (UK=new, UK=old) both 200', !!a.id && ap.status === 200 && s1.status === 200 && s2.status === 200, { a: a.id, ap: ap.status, s1: s1.status, s2: s2.status });
      await waitFor(() => busy.events.find((e) => e.t === 'turn-end'), 90_000);
      await settled(P, [a.id].filter(Boolean));
      await sleep(3000);
      const pj = await projectGet(P.id);
      check('U1a the user\'s final UK=old stands in the settings AND the running container', pj.settings.container?.env?.UK === 'old' && envOf(P.cname).UK === 'old', { settings: pj.settings.container?.env, container: envOf(P.cname).UK ?? null });
      const t = await textFor(P, a.id);
      check('U1b A told "cancelled: the user edited env UK … after approving it", never granted', /was cancelled: the user edited env UK/.test(t) && !/access granted/.test(t), t.slice(0, 200));
      busy.close(); S.c.close();
    }

    console.log('\n--- U2: r5 seq 2 — A adds UN=new (absent) approved-pending; the user adds UN=new, then deletes it');
    {
      const P = await registerProject('utwo');
      const S = await startSession(P.id, 'hello u2');
      const busy = await holdTurn(P.id, 30_000);
      const a = await raise(S, P, { reason: 'u2', env: { UN: 'new' } });
      const ap = await approve(P.id, a.id);
      const s1 = await patchEnv(P, { UN: 'new' }); const s2 = await patchEnv(P, {});
      check('U2 setup: raised, approved while a turn runs, user add then delete (200, 200)', !!a.id && ap.status === 200 && s1.status === 200 && s2.status === 200, { ap: ap.status, s1: s1.status, s2: s2.status });
      await waitFor(() => busy.events.find((e) => e.t === 'turn-end'), 90_000);
      await settled(P, [a.id].filter(Boolean));
      await sleep(3000);
      const pj = await projectGet(P.id);
      check('U2a UN is in neither the settings nor the running container', !('UN' in (pj.settings.container?.env ?? {})) && !('UN' in envOf(P.cname)), { settings: pj.settings.container?.env, container: envOf(P.cname).UN ?? null });
      const t = await textFor(P, a.id);
      check('U2b A told "cancelled"', /was cancelled: the user edited env UN/.test(t), t.slice(0, 200));
      busy.close(); S.c.close();
    }

    console.log('\n--- U3: r5 seq 3 — A publishes H→8080 approved-pending; the user publishes the same, then removes it');
    {
      const P = await registerProject('uthree');
      const S = await startSession(P.id, 'hello u3');
      const H = await freePort();
      const busy = await holdTurn(P.id, 30_000);
      const a = await raise(S, P, { reason: 'u3', ports: [{ containerPort: 8080, hostPort: H }] });
      const ap = await approve(P.id, a.id);
      const s1 = await patchPorts(P, [{ hostPort: H, containerPort: 8080 }]); const s2 = await patchPorts(P, []);
      check('U3 setup: raised, approved while a turn runs, user publish then remove (200, 200)', !!a.id && ap.status === 200 && s1.status === 200 && s2.status === 200, { ap: ap.status, s1: s1.status, s2: s2.status, s1e: s1.body?.error });
      await waitFor(() => busy.events.find((e) => e.t === 'turn-end'), 90_000);
      await settled(P, [a.id].filter(Boolean));
      await sleep(3000);
      const pj = await projectGet(P.id);
      check('U3a H is in neither the settings nor the container\'s PortBindings', !(pj.settings.container?.ports ?? []).some((x) => x.hostPort === H) && !pbOf(P.cname).includes(H), { settings: pj.settings.container?.ports, pb: pbOf(P.cname) });
      const t = await textFor(P, a.id);
      check('U3b A told "cancelled: … port 127.0.0.1:H …"', /was cancelled/.test(t) && t.includes(`127.0.0.1:${H}`), t.slice(0, 200));
      busy.close(); S.c.close();
    }

    console.log('\n--- U4: the card\'s Cancel (user-only) on an approved-pending request; no false cancel on an unrelated save');
    {
      const P = await registerProject('ufour');
      await patchEnv(P, { KEEP: '1' });
      const S = await startSession(P.id, 'hello u4');
      const busy = await holdTurn(P.id, 40_000);
      const a = await raise(S, P, { reason: 'u4 a', env: { UC: 'x' } });
      const b = await raise(S, P, { reason: 'u4 b', env: { UB: 'y' } });
      const apA = await approve(P.id, a.id); const apB = await approve(P.id, b.id);
      const view = (await accessList(P.id)).find((r) => r.id === a.id);
      const agent = agentProbe('POST', `/api/projects/${P.id}/access-requests/${a.id}/cancel`, {});
      const user = await api(`/api/projects/${P.id}/access-requests/${a.id}/cancel`, 'POST', {});
      const again = await api(`/api/projects/${P.id}/access-requests/${a.id}/cancel`, 'POST', {});
      // an unrelated save (the drawer re-sends the whole env map plus a new key) must NOT cancel B
      const unrelated = await patchEnv(P, { KEEP: '1', OTHER: '2' });
      check('U4 setup: both approved while a turn runs; the card view says cancellable', apA.status === 200 && apB.status === 200 && view?.cancellable === true, { apA: apA.status, apB: apB.status, cancellable: view?.cancellable });
      check('U4a an AGENT caller (session scope) is refused 403 agent-not-user and nothing changes', agent.status === 403 && agent.body?.code === 'agent-not-user', { status: agent.status, code: agent.body?.code });
      check('U4b the USER\'s Cancel → 200 cancelled; a second Cancel → 409 not-pending', user.status === 200 && user.body?.request?.notApplied?.cause === 'cancelled' && again.status === 409, { user: user.status, cause: user.body?.request?.notApplied?.cause, again: again.status });
      await waitFor(() => busy.events.find((e) => e.t === 'turn-end'), 90_000);
      await settled(P, [a.id, b.id].filter(Boolean));
      await sleep(3000);
      const pj = await projectGet(P.id);
      const env = envOf(P.cname);
      check('U4c the cancelled change is in neither the settings nor the container; the unrelated user edit and B both land', unrelated.status === 200 && !('UC' in (pj.settings.container?.env ?? {})) && !('UC' in env) && pj.settings.container?.env?.UB === 'y' && env.UB === 'y' && pj.settings.container?.env?.OTHER === '2', { settings: pj.settings.container?.env, container: { UC: env.UC ?? null, UB: env.UB ?? null } });
      const tA = await textFor(P, a.id); const tB = await textFor(P, b.id);
      check('U4d A told "cancelled: the user cancelled it…"; B told "access granted"', /was cancelled: the user cancelled it/.test(tA) && /access granted/.test(tB), { A: tA.slice(0, 120), B: tB.slice(0, 80) });
      busy.close(); S.c.close();
    }

    console.log('\n--- U5: a host port the USER typed, taken before the idle recreate, stays in the settings and is SHOWN with docker\'s reason');
    {
      const P = await registerProject('ufive');
      const S = await startSession(P.id, 'hello u5');
      const H = await freePort();
      const c0 = cidOf(P.cname);
      const busy = await holdTurn(P.id, 20_000);
      const pt = await api(`/api/projects/${P.id}`, 'PATCH', { settings: { container: { ports: [{ hostPort: H, containerPort: 3000 }] } } });
      const sq = squatU(H);
      check('U5 setup: the user PATCHed a free port (200) while a turn runs; then another container took it', pt.status === 200 && sq, { pt: pt.status, err: pt.body?.error, sq });
      await waitFor(() => busy.events.find((e) => e.t === 'turn-end'), 90_000);
      const seen = await waitFor(async () => { const st = await api(`/api/projects/${P.id}/container/status`); return st.body?.access?.portRefusal ? st.body : null; }, REBUILD_WAIT, 1500);
      const pj = await projectGet(P.id);
      check('U5a the container status (the drawer reads it) shows the refusal: the port and docker\'s own words', !!seen && seen.access.portRefusal.ports.includes(H) && /allocated|bind|address/i.test(seen.access.portRefusal.reason), seen?.access?.portRefusal ?? null);
      check('U5b the port stays in the settings and the previous container keeps running', (pj.settings.container?.ports ?? []).some((x) => x.hostPort === H) && cidOf(P.cname) === c0, { ports: pj.settings.container?.ports, same: cidOf(P.cname) === c0 });
      const rm = await api(`/api/projects/${P.id}`, 'PATCH', { settings: { container: { ports: [] } } });
      const st2 = await api(`/api/projects/${P.id}/container/status`);
      check('U5c once the user removes the port, the refusal is no longer shown', rm.status === 200 && !st2.body?.access?.portRefusal, { rm: rm.status, refusal: st2.body?.access?.portRefusal ?? null });
      busy.close(); S.c.close();
    }
  }

  if (want('X')) {
    const IMG = dk(['images', '--format', '{{.Repository}}:{{.Tag}}']).out.split('\n').find((x) => x.startsWith('claude-station-rt:')) ?? null;
    const squat = (hostPort) => {
      const n = `f200r3-squat-${crypto.randomBytes(3).toString('hex')}`;
      squatters.add(n);
      const r = dk(['run', '-d', '--name', n, '--label', 'f200r3=1', '-p', `127.0.0.1:${hostPort}:80`, '--entrypoint', 'sleep', IMG, '900']);
      return { name: n, ok: r.code === 0, err: r.err };
    };
    // A PROCESS listening in the daemon's network namespace: invisible to `docker ps` port lists and (in the sandbox,
    // whose daemon has its own netns) to the server's own host probe — so every pre-check passes and only docker's
    // start can refuse. That is exactly the "taken after every check" door.
    const squatProc = async (hostPort) => {
      const n = `f200r3-hostsq-${crypto.randomBytes(3).toString('hex')}`;
      squatters.add(n);
      const r = dk(['run', '-d', '--name', n, '--label', 'f200r3=1', '--network', 'host', '--entrypoint', 'python3', IMG, '-c', `import socket,time;s=socket.socket();s.bind(('127.0.0.1',${hostPort}));s.listen();time.sleep(900)`]);
      await sleep(1500);
      return { name: n, ok: r.code === 0 && inspectJson(n)?.State?.Running === true, err: r.err };
    };
    const recreates = (pid) => serverLog.split('\n').filter((l) => /recreating the container for/.test(l) && l.includes(`f200-`) && l.includes(pid.slice(0, 4))).length;

    console.log('\n--- X1: a host port taken AFTER approval, before the idle recreate (door 1: taken late)');
    const G = await registerProject('gamma');
    const SG = await startSession(G.id, 'hello gamma');
    const busy = await openWs();
    busy.send({ type: 'start', projectId: G.id, prompt: '[[sleep:25000]]', overrides: { permissionMode: 'default' } });
    await waitEv(busy, (e) => e.t === 'ack' && e.of === 'start', 120_000);
    await waitEv(busy, (e) => e.t === 'assistant' || e.t === 'text' || e.t === 'assistant-text', 60_000);
    const H = await freePort();
    const rq = await raise(SG, G, { reason: 'dev server for the e2e run', env: { X200_LATE: 'yes' }, ports: [{ containerPort: 8080, hostPort: H }] });
    const ap = await api(`/api/projects/${G.id}/access-requests/${rq.id}/decide`, 'POST', { verdict: 'approve' });
    const c0 = cidOf(G.cname);
    const sq = squat(H);
    check('X1 setup: approved (200) while another session runs a turn; then another container takes 127.0.0.1:H', ap.status === 200 && !!c0 && sq.ok, { approve: ap.status, H, squat: sq.ok ? sq.name : sq.err });
    await waitFor(() => busy.events.find((e) => e.t === 'turn-end'), 90_000);
    const told = await waitFor(() => received(G.dir).find((r) => r.text.includes('could not be applied')), 150_000, 500);
    const c1 = cidOf(G.cname);
    const ins1 = c1 ? inspectJson(G.cname) : null;
    check('X1a the previous container is still there and RUNNING (never removed for a refused replacement)', !!c1 && c1 === c0 && ins1?.State?.Running === true, { before: (c0 ?? '').slice(0, 12), after: (c1 ?? '').slice(0, 12), running: ins1?.State?.Running ?? null });
    check('X1b the requester was resumed with "approved, but could not be applied: <docker\'s reason>"', !!told && /approved, but could not be applied/.test(told.text) && new RegExp(String(H)).test(told.text), told?.text ?? null);
    const pg = await projectGet(G.id);
    check('X1c the unappliable change is not in the settings (r5: never written): no port H, no X200_LATE', !(pg.settings.container?.ports ?? []).some((x) => x.hostPort === H) && !('X200_LATE' in (pg.settings.container?.env ?? {})), pg.settings.container);
    const n0 = recreates(G.id);
    const ids = [];
    for (let i = 0; i < 8; i++) { await sleep(2000); ids.push(cidOf(G.cname)); }
    const view = (await api(`/api/projects/${G.id}/container/grant-rebuild`)).body;
    check('X1d no retry loop: the container id is stable for 16 s and no further recreate was attempted', ids.every((x) => x === c0) && recreates(G.id) === n0, { stable: ids.every((x) => x === c0), recreatesBefore: n0, recreatesAfter: recreates(G.id) });
    const SG2 = await startSession(G.id, 'still usable?');
    check('X1e no hold: a NEW session in the project starts and completes a turn', !!SG2.sdk, { sdk: SG2.sdk, rebuildView: view ?? null });
    const rec = (await accessList(G.id)).find((r) => r.id === rq.id);
    check('X1f the record says so (not applied, with the reason) and its resume is queued once', !!rec?.notApplied?.reason && rec?.resume?.state === 'queued', { notApplied: rec?.notApplied ?? null, resume: rec?.resume?.state ?? null });
    busy.close(); SG2.c.close();

    console.log('\n--- X2: an IPv6-only listener on [::1]:H reads as IN USE (door 2: IPv6)');
    const H6 = await freePort();
    const v6 = net.createServer();
    const v6ok = await new Promise((res) => { v6.once('error', (e) => res(String(e.code))); v6.listen({ host: '::1', port: H6, ipv6Only: true }, () => res(true)); });
    const v4free = await new Promise((res) => { const s = net.createServer(); s.once('error', () => res(false)); s.listen({ host: '127.0.0.1', port: H6, exclusive: true }, () => s.close(() => res(true))); });
    const SG3 = await startSession(G.id, 'hello v6');
    const r6 = await raise(SG3, G, { reason: 'dev server', ports: [{ containerPort: 5173, hostPort: H6 }] });
    check('X2a setup: something listens ONLY on [::1]:H6 and 127.0.0.1:H6 is free', v6ok === true && v4free === true, { v6ok, v4free, H6 });
    check('X2b the record shows the conflict (loopback is two addresses)', (r6.rec?.conflicts ?? []).some((c) => c.includes(String(H6)) && /::1|IPv6/.test(c)), r6.rec?.conflicts ?? r6.text.slice(0, 200));
    const ap6 = r6.id ? await api(`/api/projects/${G.id}/access-requests/${r6.id}/decide`, 'POST', { verdict: 'approve' }) : { status: 'no id' };
    check('X2c approving it is refused 409 port-conflict', ap6.status === 409 && ap6.body?.code === 'port-conflict', { status: ap6.status, body: ap6.body });
    if (r6.id && ap6.status !== 200) await api(`/api/projects/${G.id}/access-requests/${r6.id}/decide`, 'POST', { verdict: 'reject' });
    v6.close(); SG3.c.close();

    console.log('\n--- X3: a NON-port start failure of the replacement (GPU requested on a daemon with none) keeps the container');
    const D = await registerProject('delta');
    const st = await api(`/api/projects/${D.id}/container/start`, 'POST');
    const d0 = cidOf(D.cname);
    const pt = await api(`/api/projects/${D.id}`, 'PATCH', { settings: { container: { gpu: 'on' } } });
    const rb = await api(`/api/projects/${D.id}/container/rebuild`, 'POST');
    const d1 = cidOf(D.cname);
    const dins = d1 ? inspectJson(D.cname) : null;
    check('X3a setup: delta has a running container; the user turns GPU on; Rebuild is refused by docker', st.status === 200 && !!d0 && pt.status === 200 && rb.status >= 400, { start: st.status, patch: pt.status, rebuild: rb.status, error: String(rb.body?.error ?? '').slice(0, 200), detail: String(rb.body?.detail ?? '').slice(0, 200) });
    check('X3b the previous container is still there and RUNNING after the failed rebuild', !!d1 && d1 === d0 && dins?.State?.Running === true, { before: (d0 ?? '').slice(0, 12), after: (d1 ?? '').slice(0, 12), running: dins?.State?.Running ?? null });
    check('X3c the refusal says the previous container is still running', /previous container is still running/i.test(`${rb.body?.error ?? ''} ${rb.body?.detail ?? ''}`), rb.body?.error ?? null);
    const leftovers = dk(['ps', '-a', '--format', '{{.Names}}', '--filter', `name=${D.cname}`]).out.split('\n').filter(Boolean);
    check('X3d no half-made replacement is left behind', leftovers.length === 1 && leftovers[0] === D.cname, leftovers);
    await api(`/api/projects/${D.id}`, 'PATCH', { settings: { container: { gpu: 'off' } } });

    console.log('\n--- X4: approved with NO running container, port taken: never "granted" before a container has it');
    const E = await registerProject('epsilon');
    const SE = await startSession(E.id, 'hello epsilon');
    const H4 = await freePort();
    const r4 = await raise(SE, E, { reason: 'dev server', env: { X200_NOC: 'yes' }, ports: [{ containerPort: 8080, hostPort: H4 }] });
    const rm = await api(`/api/projects/${E.id}/container/remove?force=1`, 'POST');
    await waitFor(() => !cidOf(E.cname), 60_000);
    const sq4 = await squatProc(H4);
    const ap4 = await api(`/api/projects/${E.id}/access-requests/${r4.id}/decide`, 'POST', { verdict: 'approve' });
    check('X4 setup: request raised, container removed, port taken, then approved', !!r4.id && rm.status === 200 && sq4.ok && ap4.status === 200, { raise: !!r4.id, remove: rm.status, squat: sq4.ok, approve: ap4.status });
    const told4 = await waitFor(() => received(E.dir).find((r) => /could not be applied|access granted/.test(r.text) && r.text.includes('X200_NOC')), 150_000, 500);
    check('X4a the requester is told "could not be applied", never "access granted"', !!told4 && /approved, but could not be applied/.test(told4.text), told4?.text ?? null);
    const e1 = cidOf(E.cname);
    check('X4b the project has a running container again (without the refused port)', !!e1 && inspectJson(E.cname)?.State?.Running === true && JSON.stringify(inspectJson(E.cname)?.HostConfig?.PortBindings ?? {}) === '{}', { container: (e1 ?? '').slice(0, 12), pb: inspectJson(E.cname)?.HostConfig?.PortBindings ?? null });
    const pe = await projectGet(E.id);
    check('X4c the refused change is not in the settings (no port H4, no X200_NOC)', !(pe.settings.container?.ports ?? []).some((x) => x.hostPort === H4) && !('X200_NOC' in (pe.settings.container?.env ?? {})), pe.settings.container);
    SE.c.close(); SG.c.close();
  }

  if (want('SHOTS6') && DO_SHOTS) {
    /* FEAT-200 r6 — the approved-pending card's Cancel button and the drawer's warning before a save that cancels a pending request, light and dark. */
    console.log('\n--- SHOTS6: the Cancel button on an approved-pending card + the drawer warning, light and dark');
    fs.mkdirSync(SHOTS, { recursive: true });
    const P = await registerProject('shotsix');
    await api(`/api/projects/${P.id}`, 'PATCH', { settings: { container: { env: { DATABASE_URL: 'postgres://localhost/old', LOG_LEVEL: 'info' } } } });
    const S = await startSession(P.id, 'hello for the r6 screenshots');
    const busy = await openWs();
    busy.send({ type: 'start', projectId: P.id, prompt: '[[sleep:150000]]', overrides: { permissionMode: 'default' } });
    await waitEv(busy, (e) => e.t === 'ack' && e.of === 'start', 120_000);
    const sh = await raise(S, P, { reason: 'the app reads its database URL from the environment; it should use the host database', env: { DATABASE_URL: 'postgres://host.docker.internal:5432/app' } });
    const ap = await api(`/api/projects/${P.id}/access-requests/${sh.id}/decide`, 'POST', { verdict: 'approve' });
    check('SHOTS6 setup: approved-pending while another session works', ap.status === 200 && ap.body?.request?.cancellable === true, { ap: ap.status, cancellable: ap.body?.request?.cancellable });
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true, executablePath: process.env.QA_BRAVE_PATH || '/usr/bin/brave' });
    try {
      for (const theme of ['light', 'dark']) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: theme });
        await page.addInitScript((t) => { try { localStorage.setItem('cs.theme', t); } catch { /* */ } }, theme);
        await page.goto(`${base}/#/project/${encodeURIComponent(P.id)}/session/${encodeURIComponent(S.sdk)}`, { waitUntil: 'load' });
        const card = await page.waitForSelector(`.ask.access[data-access-id="${sh.id}"]`, { timeout: 30_000 }).catch(() => null);
        await sleep(800);
        const btn = card ? await card.$('.acc-cancel') : null;
        const f = path.join(SHOTS, `feat200-r6-cancel-card-${theme}.png`);
        if (card) await card.screenshot({ path: f }); else await page.screenshot({ path: f });
        const colors = btn ? await btn.evaluate((n) => ({ color: getComputedStyle(n).color, border: getComputedStyle(n).borderTopColor, text: n.textContent, access: getComputedStyle(document.documentElement).getPropertyValue('--access').trim() })) : null;
        check(`SHOTS6 approved-pending session card (${theme}) shows "Cancel request" in the --access hue`, !!btn && /Cancel request/.test(colors?.text ?? ''), { file: f, colors });
        // the drawer: remove DATABASE_URL (the key the pending request names) → the save is held behind the warning
        await page.evaluate(() => window.__station.drawer.open('settings', { focus: 'env' }));
        await sleep(1500); // the drawer repaints once the container status arrives; click a settled row
        const x = await page.click('[aria-label="Remove DATABASE_URL"]', { timeout: 20_000 }).then(() => true, () => false);
        if (x) await sleep(600);
        const warn = await page.waitForSelector('.acc-warn', { timeout: 10_000 }).catch(() => null);
        const f2 = path.join(SHOTS, `feat200-r6-drawer-warning-${theme}.png`);
        if (warn) { await warn.scrollIntoViewIfNeeded().catch(() => {}); const grp = await page.$('.grp[data-focus="env"]'); await (grp ?? warn).screenshot({ path: f2 }); } else await page.screenshot({ path: f2 });
        const wt = warn ? await warn.evaluate((n) => ({ text: n.textContent, border: getComputedStyle(n).borderLeftColor })) : null;
        const still = (await projectGet(P.id)).settings.container?.env?.DATABASE_URL;
        check(`SHOTS6 drawer (${theme}): removing a key a pending request names shows the warning naming it, and saves NOTHING yet`, !!warn && /cancels an approved access request/.test(wt?.text ?? '') && /DATABASE_URL/.test(wt?.text ?? '') && still === 'postgres://localhost/old', { file: f2, warn: wt?.text?.slice(0, 160), border: wt?.border, stillSaved: still });
        await page.click('.acc-warn .acc-keep', { timeout: 5_000 }).catch(() => {});
        await sleep(300);
        await page.close();
      }
      // the click-path end to end in one theme: Save and cancel → the setting is saved, the request is cancelled
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const patches = [];
      page.on('response', async (r) => { if (r.request().method() === 'PATCH') patches.push({ status: r.status(), body: (await r.text().catch(() => '')).slice(0, 200) }); });
      await page.goto(`${base}/#/project/${encodeURIComponent(P.id)}/session/${encodeURIComponent(S.sdk)}`, { waitUntil: 'load' });
      await sleep(1500);
      await page.evaluate(() => window.__station.drawer.open('settings', { focus: 'env' }));
      await sleep(1500);
      const x = await page.click('[aria-label="Remove DATABASE_URL"]', { timeout: 20_000 }).then(() => true, () => false);
      if (x) await sleep(600);
      const go = await page.click('.acc-warn .acc-go', { timeout: 10_000 }).then(() => true, () => false);
      const done = await waitFor(async () => { const l = await accessList(P.id); const r = l.find((q) => q.id === sh.id); return r?.notApplied ? r : null; }, 30_000, 500);
      const pj = await projectGet(P.id);
      check('SHOTS6 "Save and cancel the request": the user\'s delete is saved and the request is cancelled (told so)', !!go && !('DATABASE_URL' in (pj.settings.container?.env ?? {})) && done?.notApplied?.cause === 'cancelled', { go: !!go, patches, env: pj.settings.container?.env, cause: done?.notApplied?.cause, text: done?.resume?.text?.slice(0, 140) });
      await page.close();
    } finally { await browser.close(); }
    console.log(`        screenshots in ${SHOTS}`);
    busy.close(); S.c.close();
  }

  if (want('SHOTS') && DO_SHOTS) {
    console.log('\n--- SHOTS: the access card (session view + rail), light and dark');
    fs.mkdirSync(SHOTS, { recursive: true });
    const S8 = await startSession(A.id, 'hello for the screenshot');
    const sh = await raise(S8, A, { reason: 'the app reads its database URL from the environment and the user wants to open the dev server', env: { DATABASE_URL: 'postgres://host.docker.internal:5432/app' }, ports: [{ containerPort: 5173, hostPort: await freePort() }] });
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true, executablePath: process.env.QA_BRAVE_PATH || '/usr/bin/brave' });
    try {
      for (const theme of ['light', 'dark']) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: theme });
        await page.addInitScript((t) => { try { localStorage.setItem('cs.theme', t); } catch { /* */ } }, theme);
        await page.goto(`${base}/#/project/${encodeURIComponent(A.id)}/session/${encodeURIComponent(S8.sdk)}`, { waitUntil: 'load' });
        const card = await page.waitForSelector(`.ask.access[data-access-id="${sh.id}"]`, { timeout: 30_000 }).catch(() => null);
        await sleep(800);
        const f = path.join(SHOTS, `feat200-session-card-${theme}.png`);
        await page.screenshot({ path: f, fullPage: false });
        const colors = card ? await card.evaluate((n) => { const cs = getComputedStyle(n); const btn = n.querySelector('.solid'); return { borderLeft: cs.borderLeftColor, bg: cs.backgroundColor, approve: btn ? getComputedStyle(btn).backgroundColor : null, access: getComputedStyle(document.documentElement).getPropertyValue('--access').trim() }; }) : null;
        const ask = await page.evaluate(() => { const n = document.querySelector('.ask:not(.access)'); return n ? getComputedStyle(n).borderLeftColor : null; });
        check(`SHOTS session card (${theme}): rendered with Approve/Reject in the --access hue`, !!card && !!colors && colors.access.length > 0 && colors.approve !== null, { file: f, colors, permissionCardBorder: ask });
        // the rail card
        // the rail: the board-grid tile (its own hue), then the opened answer card with Approve / Reject
        const tile = await page.waitForSelector(`.tc[data-access="1"][data-id="${sh.id}"]`, { timeout: 15_000 }).catch(() => null);
        const tileBorder = tile ? await tile.evaluate((n) => getComputedStyle(n).borderLeftColor) : null;
        const needsTile = await page.evaluate(() => { const n = document.querySelector('.tc[data-state="needs"]:not([data-access])'); return n ? getComputedStyle(n).borderColor : null; });
        check(`SHOTS rail grid tile (${theme}): the access request wears the --access hue`, !!tile && !!tileBorder, { tileBorder, otherNeedsTileBorder: needsTile });
        if (tile) { await tile.click().catch(() => {}); await sleep(900); }
        const rail = await page.$(`.needs-card.access[data-id="${sh.id}"]`);
        const f2 = path.join(SHOTS, `feat200-rail-card-${theme}.png`);
        await page.screenshot({ path: f2 });
        check(`SHOTS rail answer card (${theme}) opened with Approve / Reject`, !!rail && !!(await rail.$('.acc-approve')) && !!(await rail.$('.acc-reject')), f2);
        await page.close();
      }
    } finally { await browser.close(); }
    console.log(`        screenshots in ${SHOTS}`);
    await api(`/api/projects/${A.id}/access-requests/${sh.id}/decide`, 'POST', { verdict: 'reject' });
    S8.c.close();
  }
  // C restarts the server, so it runs after the browser blocks (a restart just before them made SHOTS6 flaky).
  if (want('C')) {
    /*
     * FEAT-200 r7 — the commit two-write window (IV r6 91a246ca) on a REAL server + real containers. The crash state is
     * produced for real up to the approval (raised from inside the container, approved over HTTP while another
     * session's turn holds the idle recreate), then the server is SIGKILLed. The registry is then written on disk as
     * the commit's settings write leaves it (ops folded in; on an r7 tree that same write names the request in
     * `accessCommitted`; the access store is untouched, so the record is approved-pending = the lost mark). That
     * on-disk construction is SYNTHETIC by necessity: the two writes are synchronous in one tick and cannot be split
     * from outside. Then the server restarts and:
     *   C1 (project crash):  the user edits ONE named key (CK) over HTTP before the first recreate → the requester must
     *                        be told the truth (approved; port in place; CK=new not), never "None of it was applied".
     *   C2 (project crash2): no edit → "access granted" exactly once.
     * Must FAIL on a pre-r7 tree (`--tree`): C1 is told "cancelled … never written" while its port is published.
     */
    console.log('\n--- C: crash between the commit\'s settings write and the record mark; restart; a user edit of one named key');
    const holdTurnC = async (pid, ms) => {
      const busy = await openWs();
      busy.send({ type: 'start', projectId: pid, prompt: `[[sleep:${ms}]]`, overrides: { permissionMode: 'default' } });
      await waitEv(busy, (e) => e.t === 'ack' && e.of === 'start', 120_000);
      await waitEv(busy, (e) => e.t === 'assistant' || e.t === 'text' || e.t === 'assistant-text', 60_000);
      return busy;
    };
    const envOfC = (cname) => Object.fromEntries((inspectJson(cname)?.Config?.Env ?? []).map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
    const pbOfC = (cname) => Object.values(inspectJson(cname)?.HostConfig?.PortBindings ?? {}).flat().map((b) => Number(b.HostPort));
    const P1 = await registerProject('crash');
    const P2 = await registerProject('crashtwo');
    await api(`/api/projects/${P1.id}`, 'PATCH', { settings: { container: { env: { CK: 'old' } } } });
    const S1c = await startSession(P1.id, 'hello c1');
    const S2c = await startSession(P2.id, 'hello c2');
    const H1 = await freePort(); const H2 = await freePort();
    const busy1 = await holdTurnC(P1.id, 120_000);
    const busy2 = await holdTurnC(P2.id, 120_000);
    const a1 = await raise(S1c, P1, { reason: 'c1', env: { CK: 'new' }, ports: [{ hostPort: H1, containerPort: 8080 }] });
    const a2 = await raise(S2c, P2, { reason: 'c2', env: { C2K: 'yes' }, ports: [{ hostPort: H2, containerPort: 8081 }] });
    const ap1 = await api(`/api/projects/${P1.id}/access-requests/${a1.id}/decide`, 'POST', { verdict: 'approve' });
    const ap2 = await api(`/api/projects/${P2.id}/access-requests/${a2.id}/decide`, 'POST', { verdict: 'approve' });
    const c1pre = cidOf(P1.cname); const c2pre = cidOf(P2.cname);
    // CRASH.
    try { process.kill(serverProc.pid, 'SIGKILL'); } catch { /* */ }
    for (let i = 0; i < 50 && serverProc.exitCode === null && serverProc.signalCode === null; i++) await sleep(100);
    busy1.close(); busy2.close(); S1c.c.close(); S2c.c.close();
    // The commit's ONE settings write, as it lands on disk (ops + the committed set; the store keeps the old mark).
    const regFile = path.join(DATA, 'registry.json');
    const regJ = JSON.parse(fs.readFileSync(regFile, 'utf8'));
    for (const [P, rid, envAdd, port] of [[P1, a1.id, { CK: 'new' }, { hostPort: H1, containerPort: 8080 }], [P2, a2.id, { C2K: 'yes' }, { hostPort: H2, containerPort: 8081 }]]) {
      const row = regJ.projects.find((x) => x.id === P.id);
      row.settings.container = { ...(row.settings.container ?? {}), env: { ...(row.settings.container?.env ?? {}), ...envAdd }, ports: [...(row.settings.container?.ports ?? []), port] };
      row.accessCommitted = [...(row.accessCommitted ?? []), rid];
    }
    fs.writeFileSync(`${regFile}.tmp-c`, `${JSON.stringify(regJ, null, 2)}\n`); fs.renameSync(`${regFile}.tmp-c`, regFile);
    const storeRec = JSON.parse(fs.readFileSync(path.join(DATA, 'access-requests.json'), 'utf8')).filter((r) => r.id === a1.id || r.id === a2.id).map((r) => ({ id: r.id, applied: r.decision?.applied, notApplied: r.notApplied ?? null }));
    check('C0 setup: both raised + approved while a turn held the recreate; server killed; on disk: ops in the settings, records still approved-pending', !!a1.id && !!a2.id && ap1.status === 200 && ap2.status === 200 && storeRec.length === 2 && storeRec.every((r) => r.applied === false && !r.notApplied), { a1: a1.id, a2: a2.id, ap1: ap1.status, ap2: ap2.status, storeRec });
    // RESTART, and the user's edit of ONE named key at once.
    await boot({ fast: true });
    const ed = await api(`/api/projects/${P1.id}`, 'PATCH', { settings: { container: { env: { CK: 'mine' } } } });
    const sameAtEdit = cidOf(P1.cname) === c1pre;
    check('C1 precondition: the user\'s PATCH of CK landed (200) before the first recreate after the restart', ed.status === 200 && sameAtEdit, { status: ed.status, sameContainerAtEdit: sameAtEdit });
    const textC = async (P, rid) => (await accessList(P.id)).find((r) => r.id === rid)?.resume?.text ?? '';
    const t1 = await waitFor(async () => { const l = await accessList(P1.id); const r = l.find((x) => x.id === a1.id); return r?.resume?.state === 'queued' ? r.resume.text : null; }, 240_000, 1000) ?? await textC(P1, a1.id);
    const t2 = await waitFor(async () => { const l = await accessList(P2.id); const r = l.find((x) => x.id === a2.id); return r?.resume?.state === 'queued' ? r.resume.text : null; }, 240_000, 1000) ?? await textC(P2, a2.id);
    const pj1 = await projectGet(P1.id);
    check('C1a the port is in the settings AND published by the running container; the user\'s CK=mine stands in both', (pj1.settings.container?.ports ?? []).some((x) => x.hostPort === H1) && pbOfC(P1.cname).includes(H1) && pj1.settings.container?.env?.CK === 'mine' && envOfC(P1.cname).CK === 'mine', { ports: pj1.settings.container?.ports, pb: pbOfC(P1.cname), env: pj1.settings.container?.env, cenv: envOfC(P1.cname).CK ?? null });
    check('C1b the requester is told the truth: approved, port in place, CK=new not — never "cancelled" / "None of it was applied" / "never written"', /approved/.test(t1) && !/was cancelled|None of it was applied|never written/.test(t1) && new RegExp(String(H1)).test(t1) && /CK=new/.test(t1) && /not in the container now/.test(t1), t1.slice(0, 260));
    const del = async (P, rid) => (await accessList(P.id)).find((x) => x.id === rid)?.delivery ?? null;
    const d1 = await waitFor(async () => ((await del(P1, a1.id)) === 'delivered' ? 'delivered' : null), 180_000, 1000) ?? await del(P1, a1.id);
    const d2 = await waitFor(async () => ((await del(P2, a2.id)) === 'delivered' ? 'delivered' : null), 180_000, 1000) ?? await del(P2, a2.id);
    console.log(`        diag: outbox delivery c1=${d1} c2=${d2}`);
    await sleep(8000);
    const got1 = received(P1.dir).filter((r) => (r.text ?? '').includes(a1.id) || /access granted: env CK/.test(r.text ?? ''));
    const got2 = received(P2.dir).filter((r) => /access granted: env C2K=yes/.test(r.text ?? ''));
    check('C1c the closed requester session received exactly that message, exactly once', got1.length === 1 && got1[0].text.includes(t1.slice(0, 60)), { n: got1.length, texts: got1.map((r) => r.text.slice(0, 100)) });
    check('C2 no edit: after the restart the requester is told "access granted" EXACTLY ONCE, and the container has it', /access granted: env C2K=yes/.test(t2) && got2.length === 1 && envOfC(P2.cname).C2K === 'yes' && pbOfC(P2.cname).includes(H2), { t2: t2.slice(0, 100), n: got2.length, env: envOfC(P2.cname).C2K ?? null, pb: pbOfC(P2.cname), recreated: cidOf(P2.cname) !== c2pre });
  }
  if (want('D')) {
    /*
     * FEAT-200 r8 — IV r7 7b08ede8's door on a REAL server: the commit's settings write lands (the request named in the
     * project's committed set), the store mark is lost, then the project is DELETED and RE-ADDED under the same id
     * (DELETE + POST /api/projects with the same name) before the next pass. Real up to the approval (raised from inside
     * the container, approved over HTTP while a turn holds the recreate); then SIGKILL, and the registry written as the
     * commit's ONE write leaves it (SYNTHETIC by necessity, as in block C). The server restarts with its 2 s access timer
     * slowed, so nothing reconciles before the delete + re-add, which are real HTTP calls. Then the user tries to approve
     * a request the OLD project still had undecided (that also wakes the pass).
     * Must FAIL on the r7 tree: the committed request is told "cancelled … never written", and the undecided one is
     * approvable onto the re-added project.
     */
    console.log('\n--- D: commit landed, mark lost, project DELETED and RE-ADDED under the same id (HTTP), then decide/cancel on the new card');
    const holdTurnD = async (pid, ms) => {
      const busy = await openWs();
      busy.send({ type: 'start', projectId: pid, prompt: `[[sleep:${ms}]]`, overrides: { permissionMode: 'default' } });
      await waitEv(busy, (e) => e.t === 'ack' && e.of === 'start', 120_000);
      await waitEv(busy, (e) => e.t === 'assistant' || e.t === 'text' || e.t === 'assistant-text', 60_000);
      return busy;
    };
    const PD = await registerProject('readd');
    await api(`/api/projects/${PD.id}`, 'PATCH', { settings: { container: { env: { DK: 'old' } } } });
    const SD = await startSession(PD.id, 'hello d');
    const HD = await freePort();
    const busyD = await holdTurnD(PD.id, 120_000);
    const dA = await raise(SD, PD, { reason: 'd-committed', env: { DK: 'new' }, ports: [{ hostPort: HD, containerPort: 8080 }] });
    const dB = await raise(SD, PD, { reason: 'd-undecided', env: { DB: 'yes' } });
    const apA = await api(`/api/projects/${PD.id}/access-requests/${dA.id}/decide`, 'POST', { verdict: 'approve' });
    try { process.kill(serverProc.pid, 'SIGKILL'); } catch { /* */ }
    for (let i = 0; i < 50 && serverProc.exitCode === null && serverProc.signalCode === null; i++) await sleep(100);
    busyD.close(); SD.c.close();
    const regFileD = path.join(DATA, 'registry.json');
    const regD = JSON.parse(fs.readFileSync(regFileD, 'utf8'));
    const rowD = regD.projects.find((x) => x.id === PD.id);
    rowD.settings.container = { ...(rowD.settings.container ?? {}), env: { ...(rowD.settings.container?.env ?? {}), DK: 'new' }, ports: [...(rowD.settings.container?.ports ?? []), { hostPort: HD, containerPort: 8080 }] };
    rowD.accessCommitted = [...(rowD.accessCommitted ?? []), dA.id];
    fs.writeFileSync(`${regFileD}.tmp-d`, `${JSON.stringify(regD, null, 2)}\n`); fs.renameSync(`${regFileD}.tmp-d`, regFileD);
    check('D0 setup: A approved, B undecided, both raised from inside the container; server killed; on disk A\'s ops + committed set in the settings, A still approved-pending in the store', !!dA.id && !!dB.id && apA.status === 200, { a: dA.id, b: dB.id, apA: apA.status });
    await boot({ fast: true, extraEnv: { ORCHARD_ACCESS_POLL_MS: '3600000' } });
    // The lost mark persists across the delete + re-add: the access store is unreadable for that window (a directory
    // stands where the file was — a store fault, the r7 IV's EACCES shape), so no pass can reconcile A in between (the
    // DELETE's own container removal wakes the pass). It is put back before anything reads it again.
    const storeFileD = path.join(DATA, 'access-requests.json');
    fs.renameSync(storeFileD, `${storeFileD}.held-d`); fs.mkdirSync(storeFileD);
    const delD = await api(`/api/projects/${PD.id}?force=1`, 'DELETE');
    const reD = await api('/api/projects', 'POST', { hostPath: PD.dir, name: `f200-readd-${RUN_TAG}`, isolation: 'container', applyMethod: false, settings: { container: { gpu: 'off', env: { DK: 'old' } }, tools: { serena: false, playwright: false, openaiDispatch: false } } });
    fs.rmdirSync(storeFileD); fs.renameSync(`${storeFileD}.held-d`, storeFileD);
    const storeA = JSON.parse(fs.readFileSync(path.join(DATA, 'access-requests.json'), 'utf8')).find((r) => r.id === dA.id);
    check('D1 precondition: DELETE 200 and the re-add (POST, same name) got the SAME id before any pass reconciled A (still approved-pending in the store)', delD.status === 200 && reD.body?.project?.id === PD.id && storeA?.decision?.applied === false && !storeA?.notApplied, { del: delD.status, readd: reD.body?.project?.id ?? reD.body, storeA: storeA?.decision });
    const apB = await api(`/api/projects/${PD.id}/access-requests/${dB.id}/decide`, 'POST', { verdict: 'approve' });
    check('D2 approving the OLD project\'s undecided request on the re-added project\'s card is refused: 409 project-removed', apB.status === 409 && apB.body?.code === 'project-removed', { status: apB.status, body: apB.body });
    const closedD = await waitFor(async () => { const l = await accessList(PD.id); const a = l.find((x) => x.id === dA.id); const b = l.find((x) => x.id === dB.id); return a?.resume?.text && b?.resume?.text && a.resume.state !== 'waiting' && a.resume.state !== 'frozen' ? { a, b } : null; }, 60_000, 500);
    const tA = closedD?.a?.resume?.text ?? ''; const tB = closedD?.b?.resume?.text ?? '';
    check('D3 A (committed to the REMOVED project) is told "approved, but its project was removed … not in effect" — never "cancelled" / "None of it was applied" / "never written"', /its project was removed from Orchard/.test(tA) && /not in effect/.test(tA) && !/was cancelled|None of it was applied|never written|access granted/.test(tA) && closedD?.a?.notApplied?.cause === 'removed', { tA: tA.slice(0, 220), cause: closedD?.a?.notApplied?.cause ?? null });
    check('D3b B (undecided) is closed the same way ("not decided: its project was removed"), and neither card offers Approve/Cancel', /not decided: its project was removed/.test(tB) && closedD?.b?.notApplied?.cause === 'removed' && closedD?.a?.cancellable === false && closedD?.b?.cancellable === false, { tB: tB.slice(0, 160), a: closedD?.a?.cancellable, b: closedD?.b?.cancellable });
    const cnD = await api(`/api/projects/${PD.id}/access-requests/${dA.id}/cancel`, 'POST');
    check('D4 Cancel on A from the re-added project\'s card is refused (409) and changes nothing', cnD.status === 409 && (await accessList(PD.id)).find((x) => x.id === dA.id)?.notApplied?.cause === 'removed', { status: cnD.status, body: cnD.body });
    const pjD = await projectGet(PD.id);
    check('D5 the re-added project inherits nothing: DK=old, no published port in its settings, no committed set', pjD?.settings?.container?.env?.DK === 'old' && !(pjD?.settings?.container?.ports ?? []).length && !(pjD?.accessCommitted ?? []).length, { env: pjD?.settings?.container?.env, ports: pjD?.settings?.container?.ports, committed: pjD?.accessCommitted ?? null });
    await sleep(6000);
    const gotD = received(PD.dir).filter((r) => (r.text ?? '').includes(dA.id) || (r.text ?? '').includes(dB.id));
    check('D6 the removed project\'s closed session is NOT resumed into the re-added project: nothing delivered, recorded "undeliverable"', gotD.length === 0 && closedD?.a?.resume?.state === 'undeliverable' && closedD?.b?.resume?.state === 'undeliverable', { n: gotD.length, a: closedD?.a?.resume?.state, b: closedD?.b?.resume?.state, err: closedD?.a?.resume?.error ?? null });
    {
      // FEAT-200 r10: a request closed as removed has nothing to decide, so it is never a Needs-You card on the project
      // re-added under its id (the r9 tree kept B there forever as a dead card). Must FAIL on the r9 tree.
      const bd = await api(`/api/projects/${PD.id}/board`);
      const railD = (bd.body?.needsYou ?? []).filter((x) => x.access && (x.id === dA.id || x.id === dB.id));
      check('D7 r10: neither removed-incarnation request (A committed, B undecided-closed) is on the re-added project\'s Needs-You rail', bd.status === 200 && Array.isArray(bd.body?.needsYou) && railD.length === 0, { status: bd.status, onRail: railD.map((x) => x.id) });
    }
  }
  if (want('Q')) {
    /*
     * BUG-284 (was the FEAT-200 r8 RESIDUAL, IV r8 ec528a8a run 8216df1bf6c7). The request commits and "access granted"
     * is QUEUED in the outbox for the closed requester; a PLAIN message (no access request) is queued for a second closed
     * session of the same project; the outbox holds both (another program is writing the transcripts); the project is
     * DELETED and RE-ADDED under the same id; the holds clear. Before BUG-284 the outbox resumed the REMOVED project's
     * session inside the re-added project and delivered "access granted" there (the re-added project does not have it).
     * Now each row carries the project incarnation it was queued for, and delivery refuses to resume into another:
     * nothing is delivered, both rows are failed with the reason. Must FAIL on the pre-BUG-284 tree (Q3, QN2).
     */
    console.log('\n--- Q (BUG-284): "granted" + a plain message queued and held, then delete + re-add; neither is resumed into the re-added project');
    if (want('D')) {
      // D left the server running with its access timer slowed to an hour; Q needs the normal pass to queue "granted".
      try { process.kill(serverProc.pid, 'SIGKILL'); } catch { /* */ }
      for (let i = 0; i < 50 && serverProc.exitCode === null && serverProc.signalCode === null; i++) await sleep(100);
      await boot();
    }
    const PQ = await registerProject('qreadd');
    const SQ = await startSession(PQ.id, 'hello q');
    const SQN = await startSession(PQ.id, 'hello qn');
    const q = await raise(SQ, PQ, { reason: 'q', env: { QX: '1' } });
    const findTranscript = (sid) => { const root = path.join(HOME, '.claude', 'projects'); for (const d of fs.readdirSync(root)) { const f = path.join(root, d, `${sid}.jsonl`); if (fs.existsSync(f)) return f; } return null; };
    const tq = findTranscript(SQ.sdk); const tqn = findTranscript(SQN.sdk);
    check('Q0 setup: raised from inside the container; both session transcripts are on the host', !!q.id && !!tq && !!tqn, { id: q.id, tq, tqn });
    // "Another program is writing this session": keep touching the transcripts, so the outbox holds the resumes.
    let touching = true;
    const toucher = (async () => { while (touching) { for (const f of [tq, tqn]) { try { const now = new Date(); fs.utimesSync(f, now, now); } catch { /* */ } } await sleep(700); } })();
    const apQ = await api(`/api/projects/${PQ.id}/access-requests/${q.id}/decide`, 'POST', { verdict: 'approve' });
    SQ.c.close(); SQN.c.close();
    await sleep(4000); // past the 2 s grace after this server's own bridge last held the sessions
    const PLAIN = `BUG284-plain-${RUN_TAG}`;
    const qn = await api('/api/outbox', 'POST', { session: SQN.sdk, project: PQ.id, nonce: `bug284-${crypto.randomBytes(6).toString('hex')}`, text: PLAIN, origin: 'direct' });
    const queuedQ = await waitFor(async () => { const r = (await accessList(PQ.id)).find((x) => x.id === q.id); return r?.resume?.state === 'queued' && r.delivery !== 'delivered' ? r : null; }, REBUILD_WAIT, 1000);
    const qnRow = async () => ((await api(`/api/outbox?session=${SQN.sdk}`)).body?.rows ?? []).find((r) => r.text === PLAIN) ?? null;
    const qnBefore = await qnRow();
    check('Q1 setup: committed, "access granted" frozen and QUEUED in the outbox, not delivered yet (held)', apQ.status === 200 && /access granted: env QX=1/.test(queuedQ?.resume?.text ?? ''), { ap: apQ.status, state: queuedQ?.resume?.state ?? null, delivery: queuedQ?.delivery ?? null });
    check('QN1 setup: a PLAIN message (no access request) is queued for the second closed session and held', (qn.status === 201 || qn.status === 200) && qnBefore?.state === 'queued', { status: qn.status, state: qnBefore?.state ?? null, hold: (await api(`/api/outbox?session=${SQN.sdk}`)).body?.hold?.kind ?? null });
    const delQ = await api(`/api/projects/${PQ.id}?force=1`, 'DELETE');
    const reQ = await api('/api/projects', 'POST', { hostPath: PQ.dir, name: `f200-qreadd-${RUN_TAG}`, isolation: 'container', applyMethod: false, settings: { container: { gpu: 'off' }, tools: { serena: false, playwright: false, openaiDispatch: false } } });
    touching = false; await toucher;
    check('Q2 setup: deleted and re-added under the SAME id while the rows were held', delQ.status === 200 && reQ.body?.project?.id === PQ.id, { del: delQ.status, id: reQ.body?.project?.id ?? null });
    await sleep(40_000); // LIVE_WINDOW + the outbox's retry
    const gotQ = received(PQ.dir).filter((r) => /access granted: env QX=1/.test(r.text ?? ''));
    const gotQN = received(PQ.dir).filter((r) => (r.text ?? '').includes(PLAIN));
    const pjQ = await projectGet(PQ.id);
    const recQ = (await accessList(PQ.id)).find((x) => x.id === q.id);
    check('Q3 the removed project\'s session is NOT resumed into the re-added project and is not told "access granted" there', gotQ.length === 0, { delivered: gotQ.length, reAddedEnv: pjQ?.settings?.container?.env ?? null });
    check('Q4 the access row is shown NOT SENT (delivery failed), never delivered', recQ?.delivery === 'failed', { delivery: recQ?.delivery ?? null, resume: recQ?.resume?.state ?? null });
    {
      // FEAT-200 r10 (IV r9 2af93888): the CARD of that committed request, as served over HTTP by the real accessView and
      // read by the real accessStatusText (public/app.js of the tree under test). Must FAIL on the r9 tree, which read
      // "approved · container ready · the resume message could not be delivered — open the session to see it".
      const appSrc = fs.readFileSync(path.join(SRC_TREE, 'public', 'app.js'), 'utf8');
      const at = appSrc.indexOf('function accessStatusText(rec) {');
      let depth = 0, end = -1;
      for (let i = appSrc.indexOf('{', at); i < appSrc.length; i++) { if (appSrc[i] === '{') depth++; else if (appSrc[i] === '}' && !--depth) { end = i + 1; break; } }
      const statusText = new Function(`${appSrc.slice(at, end)}; return accessStatusText;`)();
      const sessQ = (await api(`/api/sessions/${SQ.sdk}/access-requests`)).body?.requests ?? [];
      const viaSession = sessQ.find((x) => x.id === q.id) ?? null;
      const tq5 = recQ ? statusText(recQ) : '';
      const ts5 = viaSession ? statusText(viaSession) : '';
      const ok5 = (t) => /its project was removed from Orchard, so it is not in effect · not sent/.test(t) && !/open the session|check the session/.test(t);
      check('Q5 r10: the card of the committed request after delete + re-add reads "removed … not sent", never "open the session" (project list AND session list)', ok5(tq5) && ok5(ts5) && recQ?.cancellable === false, { project: tq5, session: ts5, cancellable: recQ?.cancellable ?? null, projectRemoved: recQ?.projectRemoved ?? null });
      if (DO_SHOTS) {
        // The user's real path: the removed project's session is still listed under the re-added project (same hostPath),
        // so opening it shows this card. Light + dark, real brave; no Approve / Reject / Cancel on it.
        fs.mkdirSync(SHOTS, { recursive: true });
        const { chromium } = await import('playwright');
        const browser = await chromium.launch({ headless: true, executablePath: process.env.QA_BRAVE_PATH || '/usr/bin/brave' });
        try {
          for (const theme of ['light', 'dark']) {
            const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: theme });
            await page.addInitScript((t) => { try { localStorage.setItem('cs.theme', t); } catch { /* */ } }, theme);
            await page.goto(`${base}/#/project/${encodeURIComponent(PQ.id)}/session/${encodeURIComponent(SQ.sdk)}`, { waitUntil: 'load' });
            const card = await page.waitForSelector(`.ask.access[data-access-id="${q.id}"]`, { timeout: 30_000 }).catch(() => null);
            await sleep(800);
            const f = path.join(SHOTS, `feat200-removed-card-${theme}.png`);
            if (card) await card.scrollIntoViewIfNeeded().catch(() => {});
            await page.screenshot({ path: f, fullPage: false });
            const seen = card ? await card.evaluate((n) => ({ text: n.querySelector('.acc-status')?.textContent ?? '', buttons: [...n.querySelectorAll('button')].map((b) => b.textContent) })) : null;
            check(`Q5s r10 removed-state card (${theme}) on the real session view: "removed … not sent", no buttons, no "open the session"`, !!seen && ok5(seen.text) && seen.buttons.length === 0, { file: f, ...(seen ?? {}) });
            await page.close();
          }
        } finally { await browser.close(); }
      }
    }
    const qnAfter = await qnRow();
    check('QN2 the PLAIN message is not delivered into the re-added project either; its row is failed with the reason', gotQN.length === 0 && qnAfter?.state === 'failed' && /removed from Orchard/.test(qnAfter?.reason ?? ''), { delivered: gotQN.length, state: qnAfter?.state ?? null, reason: (qnAfter?.reason ?? '').slice(0, 100) });
    // Anti-regression: a message for a session of the RE-ADDED project still goes (the new incarnation is the current one).
    const SQ3 = await startSession(PQ.id, 'hello q3');
    SQ3.c.close(); await sleep(1500);
    const OK3 = `BUG284-current-${RUN_TAG}`;
    await api('/api/outbox', 'POST', { session: SQ3.sdk, project: PQ.id, nonce: `bug284-${crypto.randomBytes(6).toString('hex')}`, text: OK3, origin: 'direct' });
    const got3 = await waitFor(() => received(PQ.dir).filter((r) => (r.text ?? '').includes(OK3)).length || null, 60_000, 1000);
    check('QN3 anti-regression: a message queued for a closed session of the RE-ADDED project is delivered once', got3 === 1, { delivered: got3 ?? 0 });
  }
  if (want('QR')) {
    /*
     * BUG-284 with a SERVER RESTART between the delete + re-add and the delivery: a plain message is queued while the
     * session runs a long turn (held: "sends when Claude pauses"), the project is deleted (?force=1 closes its sessions)
     * and re-added under the same id, the server is SIGKILLed and booted again. The row is on disk with its incarnation;
     * the new process finds no running session and must refuse to resume it into the re-added project.
     * Must FAIL on the pre-BUG-284 tree.
     */
    console.log('\n--- QR (BUG-284): a held plain message, delete + re-add, RESTART → not resumed into the re-added project');
    const PR = await registerProject('qrestart');
    const SR = await startSession(PR.id, 'hello qr');
    const nR = SR.c.events.length;
    SR.c.send({ type: 'send', prompt: '[[sleep:180000]]', sendId: `s-${crypto.randomUUID()}` });
    await waitFor(() => SR.c.events.slice(nR).find((e) => e.t === 'assistant' || e.t === 'text' || e.t === 'assistant-text'), 60_000);
    const PLAINR = `BUG284-restart-${RUN_TAG}`;
    const qr = await api('/api/outbox', 'POST', { session: SR.sdk, project: PR.id, nonce: `bug284-${crypto.randomBytes(6).toString('hex')}`, text: PLAINR, origin: 'queued' });
    await sleep(2000);
    const heldR = (await api(`/api/outbox?session=${SR.sdk}`)).body ?? {};
    const rowR0 = (heldR.rows ?? []).find((r) => r.text === PLAINR) ?? null;
    const preR = received(PR.dir).filter((r) => (r.text ?? '').includes(PLAINR)).length;
    const delR = await api(`/api/projects/${PR.id}?force=1`, 'DELETE');
    const reR = await api('/api/projects', 'POST', { hostPath: PR.dir, name: `f200-qrestart-${RUN_TAG}`, isolation: 'container', applyMethod: false, settings: { container: { gpu: 'off' }, tools: { serena: false, playwright: false, openaiDispatch: false } } });
    try { process.kill(serverProc.pid, 'SIGKILL'); } catch { /* */ }
    for (let i = 0; i < 50 && serverProc.exitCode === null && serverProc.signalCode === null; i++) await sleep(100);
    SR.c.close();
    check('QR0 setup: queued + HELD behind a running turn (not delivered), deleted and re-added under the same id, server killed', (qr.status === 201 || qr.status === 200) && rowR0?.state === 'queued' && preR === 0 && delR.status === 200 && reR.body?.project?.id === PR.id, { q: qr.status, state: rowR0?.state ?? null, hold: heldR.hold?.kind ?? null, deliveredBefore: preR, del: delR.status, id: reR.body?.project?.id ?? null });
    await boot();
    await sleep(30_000);
    const gotR = received(PR.dir).filter((r) => (r.text ?? '').includes(PLAINR));
    const rowR = ((await api(`/api/outbox?session=${SR.sdk}`)).body?.rows ?? []).find((r) => r.text === PLAINR) ?? null;
    check('QR1 after the restart the held message is NOT resumed into the re-added project; its row is failed with the reason', gotR.length === 0 && rowR?.state === 'failed' && /removed from Orchard/.test(rowR?.reason ?? ''), { delivered: gotR.length, state: rowR?.state ?? null, reason: (rowR?.reason ?? '').slice(0, 100) });
  }

} catch (err) {
  check('the suite ran to completion', false, `${err.stack ?? err}`.slice(0, 1500));
  console.log(serverLog.slice(-4000));
} finally {
  try { S1?.c.close(); } catch { /* */ }
  if (fail) console.log(`\n--- server log (tail) ---\n${serverLog.split('\n').filter((l) => /FEAT-200|FEAT-175|access|error/i.test(l)).slice(-40).join('\n')}`);
  await cleanup();
}
console.log(`\n${pass} passed, ${fail} failed${fails.length ? `\nFAILED: ${fails.join(' | ')}` : ''}`);
process.exit(fail ? 1 : 0);
