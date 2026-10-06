#!/usr/bin/env node
/**
 * BUG-223 — a lane reaches the Docker SANDBOX by default; the host only by an
 * explicit, logged opt-out; the live server keeps the host.
 *
 *   node scripts/verify-bug-223-lane-docker.mjs
 *
 * Graded by DAEMON ID (read independently: `docker info` under the pinned host
 * env and under the sandbox socket), never by the env var alone.
 *
 *   A  REAL SESSION LAUNCH. A scratch Orchard server, started with the LIVE
 *      server's Docker environment (no DOCKER_HOST, no opt-out marker), launches
 *      a direct session through the real bridge → ClaudeRuntime → SDK (and the
 *      survival broker when systemd-run is available, as on the live service).
 *      The model process is a fake `claude` (CLAUDE_STATION_CLAUDE_BIN) that
 *      reads the daemon id itself AND from a node grandchild that inherits its
 *      env (the shape of a suite → scratch server → docker chain), and creates
 *      one labelled probe VOLUME from that grandchild, so the suite can see on
 *      which daemon an object actually LANDED.
 *        A1 project carrying the sandbox tooling (synthetic Orchard checkout:
 *           a scratch dir holding a copy of scripts/lib/docker-sandbox.mjs)
 *           → sandbox id, volume in the sandbox, not on the host.
 *        A2 project WITHOUT the tooling → host id (other projects' own docker
 *           workflows are untouched).
 *        A3 the scratch server's OWN environment has no DOCKER_HOST and its
 *           docker reaches the host (the live server keeps the host daemon).
 *   B  THE OPT-OUT. Under a sandbox lane env, `useHostDocker(reason)` reaches
 *      the host, logs a line to stderr and host-optouts.jsonl, and marks the env
 *      so a scratch server under it launches host sessions; without it, the
 *      same child reaches the sandbox.
 *   C  DISPATCH BROKER (the server-side launch point, `ORCHARD_DISPATCH_CMD`).
 *      The real broker, in-process with the live-like env, spawns a fake
 *      dispatch script (ORCHARD_DISPATCH_SCRIPT) that reads the daemon id.
 *   D  CODEX RUNTIME. A real CodexRuntime spawn (CLAUDE_STATION_CODEX_BIN fake)
 *      given the bridge's dockerEnv hands it to the child.
 *   E  CONTAINER SESSIONS UNAFFECTED: `docker exec` argv never forwards
 *      DOCKER_HOST, even when the session env carries one.
 *   F  COVERAGE of the project rule: marker at the root, a checkout held one or
 *      two levels below (A4 drives that shape end to end), the server's own
 *      checkout at any depth; not node_modules, not a plain project.
 *
 *   G  INHERITED, NOT RE-DERIVED (round 3, ARCH-010). G0: the decision rule (an
 *      inherited ORCHARD_LANE_DOCKER wins over layout; fail-closed). G1-G6: real
 *      processes in a bwrap jail whose host socket is a TRIPWIRE, so "reached the
 *      host" is graded by the tripwire's id and request log. G1/G2 are the round-2
 *      attacker's breaks A/B; G3 is a nested server with a shifted layout.
 *
 *   H  THE DECLARED SETTING DECIDES (round 4). Jailed like G. H1/H2 are the round-3
 *      attacker's breaks (a project inside a checkout subdir; a home-shaped project past
 *      the scan budget), each DECLARED sandbox through the real PATCH route; H3/H4 show
 *      the setting beats the shape both ways. G0f-G0i check the reader in-process,
 *      including that a top-level laneDockerEnv() makes 0 directory listings.
 *
 *   Round 5/6: A7, F12, G0j are the round-5 attackers' breaks fixed in lane-docker/registry;
 *   C4/C5/G0k are the round-6 fix (the dispatch broker re-reads its project BY ID per lane).
 *
 * MUST-FAIL: on the pre-fix tree A1, C1 and D1 report the HOST id. On the round-1
 * tree G1 and G2 fail; on the round-2 tree G3, G4 and G5 fail; on the round-3 tree
 * H1, H2, H3, H4 and G0f-G0i fail; on the round-4 tree A7, F12 and G0j fail; on the round-5
 * tree C4, C5 and G0k fail.
 *
 * Needs the sandbox up (`npm run sandbox:docker -- up`); refuses otherwise.
 * Safety: free port, scratch data dir/store/cwd; every process killed by pid;
 * the only Docker objects created are uniquely named probe volumes, removed by
 * exact name from whichever daemon holds them.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { hostDockerEnv, sandboxPaths, daemonIdUnder } from './lib/docker-sandbox.mjs';
import { mkdtempScratch } from './lib/scratch.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const MARK_SRC = path.join(ROOT, 'scripts', 'lib', 'docker-sandbox.mjs');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

/* The LIVE server's Docker environment: what systemd gives it — no DOCKER_HOST, no marker.
 * Built explicitly here because this suite may itself run inside a sandboxed lane. */
function liveLikeEnv(base = process.env) {
  const env = hostDockerEnv(base);
  delete env.ORCHARD_DOCKER_HOST_OPTOUT;
  delete env.ORCHARD_LANE_DOCKER;
  return env;
}
const SBX_ENV = { ...hostDockerEnv(), DOCKER_HOST: sandboxPaths().dockerHost };
const HOST_ID = daemonIdUnder(liveLikeEnv());
const SBX_ID = daemonIdUnder(SBX_ENV);
const idName = (id) => (id === SBX_ID ? `sandbox(${id.slice(0, 8)})` : id === HOST_ID ? `HOST(${id.slice(0, 8)})` : `other(${String(id).slice(0, 8)})`);

const scratch = mkdtempScratch ? mkdtempScratch('bug223-') : fs.mkdtempSync(path.join(os.tmpdir(), 'bug223-'));
const DATA = path.join(scratch, 'data'); const STORE = path.join(scratch, 'store'); const OUT = path.join(scratch, 'out');
for (const d of [DATA, STORE, OUT]) fs.mkdirSync(d, { recursive: true });
const probeVolumes = new Set();

/* A synthetic Orchard checkout (carries the sandbox tooling) and a plain project. */
function project(name, withTooling) {
  const d = path.join(scratch, name);
  fs.mkdirSync(d, { recursive: true });
  if (withTooling) { fs.mkdirSync(path.join(d, 'scripts', 'lib'), { recursive: true }); fs.copyFileSync(MARK_SRC, path.join(d, 'scripts', 'lib', 'docker-sandbox.mjs')); }
  return d;
}

/* A scratch registry declaring settings.laneDocker per project (round 4: the setting decides).
 * rows: [id, hostPath, laneDocker|undefined]. Returns the registry file path. */
function writeRegistry(dataDir, rows) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'registry.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, projects: rows.map(([id, hostPath, laneDocker]) => ({ id, name: id, hostPath, isolation: 'direct', settings: laneDocker ? { laneDocker } : {} })) }));
  return file;
}

/* The fake `claude`: records env + daemon ids (own + inherited grandchild) + a probe volume, then speaks minimal stream-json. */
const FAKE = path.join(scratch, 'fake-claude.mjs');
fs.writeFileSync(FAKE, `
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
const id = () => (spawnSync('docker', ['info', '--format', '{{.ID}}'], { encoding: 'utf8', timeout: 15000 }).stdout || '').trim();
const vol = 'bug223-probe-' + process.pid + '-' + Date.now();
// A grandchild that inherits this env, as a suite's scratch server would.
const gc = spawnSync(process.execPath, ['-e', \`const {spawnSync}=require('node:child_process');const o=(a)=>(spawnSync('docker',a,{encoding:'utf8',timeout:15000}).stdout||'').trim();process.stdout.write(JSON.stringify({id:o(['info','--format','{{.ID}}']),vol:o(['volume','create','--label','bug223.probe=1',\${JSON.stringify(vol)}])}))\`], { encoding: 'utf8' });
let g = {}; try { g = JSON.parse(gc.stdout); } catch {}
fs.writeFileSync(path.join(process.env.BUG223_OUT, path.basename(process.cwd()) + '.json'), JSON.stringify({
  cwd: process.cwd(), DOCKER_HOST: process.env.DOCKER_HOST ?? null, mark: process.env.ORCHARD_LANE_DOCKER ?? null,
  optout: process.env.ORCHARD_DOCKER_HOST_OPTOUT ?? null, ownId: id(), grandchildId: g.id ?? null, volume: g.vol ? vol : null,
}));
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
let started = false;
rl.on('line', (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.type === 'control_request') { say({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }); return; }
  if (m.type !== 'user' || started) return;
  started = true;
  say({ type: 'system', subtype: 'init', session_id: 'fakesdk-' + process.pid, cwd: process.cwd(), model: 'haiku', tools: [], slash_commands: [] });
  say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'ok' }] } });
  say({ type: 'result', subtype: 'success', total_cost_usd: 0 });
});
process.stdin.resume();
`);

function whereIsVolume(name) {
  const on = (env) => spawnSync('docker', ['volume', 'inspect', name], { env, encoding: 'utf8' }).status === 0;
  return { sandbox: on(SBX_ENV), host: on(liveLikeEnv()) };
}
function removeProbe(name) {
  for (const env of [SBX_ENV, liveLikeEnv()]) {
    const lbl = spawnSync('docker', ['volume', 'inspect', '--format', '{{index .Labels "bug223.probe"}}', name], { env, encoding: 'utf8' });
    if (lbl.status === 0 && lbl.stdout.trim() === '1') spawnSync('docker', ['volume', 'rm', name], { env, encoding: 'utf8' });
  }
}

const servers = new Set();
async function bootServer(env) {
  const port = await freePort();
  const s = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE,
      CLAUDE_STATION_CLAUDE_BIN: FAKE, CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0', CLAUDE_STATION_NO_WA_CONSOLIDATE: '1', BUG223_OUT: OUT,
      CLAUDE_STATION_SCRATCH_DIR: path.join(scratch, 'scratch-project') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; s.stdout.on('data', (d) => { log += d; }); s.stderr.on('data', (d) => { log += d; });
  servers.add(s);
  for (let i = 0; i < 160; i++) { try { await fetch(`http://127.0.0.1:${port}/api/health`); return { port, s, log: () => log }; } catch { await sleep(250); } }
  throw new Error('scratch server never healthy: ' + log.slice(-800));
}
async function register(port, hostPath, name) {
  const r = await (await fetch(`http://127.0.0.1:${port}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath, name, isolation: 'direct' }) })).json();
  if (!r.project?.id) throw new Error('register failed ' + JSON.stringify(r));
  return r.project.id;
}
async function launch(port, projectId, cwd) {
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('error', () => {});
  const events = [];
  ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch {} });
  const start = () => ws.send(JSON.stringify({ type: 'start', projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' }, prompt: 'hi' }));
  start();
  const file = path.join(OUT, path.basename(cwd) + '.json');
  // A fresh server refuses host sessions until its runtime check completes (runtime-check-pending); retry then.
  let seen = 0;
  for (let i = 0; i < 600 && !fs.existsSync(file); i++) {
    await sleep(100);
    const pend = events.slice(seen).some((e) => e.code === 'runtime-check-pending');
    seen = events.length;
    if (pend) { await sleep(1000); start(); }
  }
  await sleep(200);
  try { ws.close(); } catch {}
  if (!fs.existsSync(file)) { console.log('        launch events: ' + JSON.stringify(events.filter((e) => /error|status|ack/.test(e.t ?? '')).slice(-6)).slice(0, 1500)); return null; }
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (rec.volume) probeVolumes.add(rec.volume);
  return rec;
}

async function partA() {
  console.log('\n===== A — real session launch through a scratch server with the LIVE server\'s Docker env =====');
  const srv = await bootServer(liveLikeEnv());
  const orchardLike = project('orchard-like', true);
  const plain = project('plain-project', false);
  fs.writeFileSync(path.join(plain, 'docker-compose.yml'), 'services: {}\n'); // a real (non-empty) project of the user's own
  const a1 = await launch(srv.port, await register(srv.port, orchardLike, 'bug223-orchard-like'), orchardLike);
  if (!a1) check('A1 the fake claude was launched for the sandboxed project', false, srv.log().split('\n').filter((l) => /error|fail|refus/i.test(l)).slice(-8).join(' // ') || srv.log().slice(-600));
  else {
    check('A1 session process reaches the SANDBOX daemon (own docker)', a1.ownId === SBX_ID, { ownId: idName(a1.ownId), DOCKER_HOST: a1.DOCKER_HOST });
    check('A1 an inheriting grandchild (suite → scratch server shape) reaches the SANDBOX daemon', a1.grandchildId === SBX_ID, idName(a1.grandchildId));
    const w = a1.volume ? whereIsVolume(a1.volume) : null;
    check('A1 the object the grandchild created LANDED in the sandbox and NOT on the host', !!w && w.sandbox && !w.host, { volume: a1.volume, ...w });
  }
  const a2 = await launch(srv.port, await register(srv.port, plain, 'bug223-plain'), plain);
  if (!a2) check('A2 the fake claude was launched for the plain project', false, srv.log().slice(-600));
  else check('A2 a project WITHOUT the sandbox tooling keeps the host daemon (unaffected)', a2.ownId === HOST_ID && !a2.DOCKER_HOST, { ownId: idName(a2.ownId), DOCKER_HOST: a2.DOCKER_HOST });
  // A4 — round-1 attacker break 1: a catch-all project (a home dir) whose ROOT has no
  // marker but which holds an Orchard checkout below it; the lane cd's into it.
  const homeLike = path.join(scratch, 'home-like');
  fs.mkdirSync(path.join(homeLike, 'projects'), { recursive: true });
  fs.renameSync(project('home-like-checkout', true), path.join(homeLike, 'projects', 'orchard'));
  const a4 = await launch(srv.port, await register(srv.port, homeLike, 'bug223-home-like'), homeLike);
  if (!a4) check('A4 the fake claude was launched for the home-like project', false, srv.log().slice(-400));
  else check('A4 a project HOLDING a checkout below its root (home-dir shape) reaches the SANDBOX', a4.ownId === SBX_ID && a4.grandchildId === SBX_ID, { ownId: idName(a4.ownId), grandchildId: idName(a4.grandchildId) });
  // A5/A6 — round-4 attacker breaks: a declared value must not be a stale 'host' snapshot.
  const regOf = (id) => JSON.parse(fs.readFileSync(path.join(DATA, 'registry.json'), 'utf8')).projects.find((p) => p.id === id)?.settings?.laneDocker;
  const notes = project('notes-project', false); fs.writeFileSync(path.join(notes, 'README.md'), 'notes\n');
  const notesId = await register(srv.port, notes, 'bug223-notes');
  const before5 = regOf(notesId);
  const target5 = project('repoint-target', true);
  const rp = await fetch(`http://127.0.0.1:${srv.port}/api/projects/${encodeURIComponent(notesId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: target5 }) });
  check('A5 (r4 break 2) repointing a host project at a directory holding a checkout moves it to sandbox', before5 === 'host' && rp.status === 200 && regOf(notesId) === 'sandbox', { before: before5, repoint: rp.status, after: regOf(notesId) });
  const ens = await fetch(`http://127.0.0.1:${srv.port}/api/projects/scratch/ensure`, { method: 'POST' });
  check('A6 (r4 break 1) the scratch project, registered on an EMPTY dir, is declared sandbox', ens.status === 200 && regOf('scratch') === 'sandbox', { ensure: ens.status, laneDocker: regOf('scratch') });
  // Round 5 (attacker p1 break 2): scratch deleted, then re-ensured over a previous session's
  // leftovers (a plain, non-empty dir), must not be re-classified 'host' that nobody chose.
  fs.writeFileSync(path.join(scratch, 'scratch-project', 'docker-compose.yml'), 'services: {}\n');
  const del7 = await fetch(`http://127.0.0.1:${srv.port}/api/projects/scratch`, { method: 'DELETE' });
  const ens7 = await fetch(`http://127.0.0.1:${srv.port}/api/projects/scratch/ensure`, { method: 'POST' });
  check('A7 (r5 p1 break 2) scratch deleted and re-ensured over leftover files is declared sandbox again', del7.ok && ens7.status === 200 && regOf('scratch') === 'sandbox', { delete: del7.status, ensure: ens7.status, laneDocker: regOf('scratch') });
  const environ = fs.readFileSync(`/proc/${srv.s.pid}/environ`, 'utf8').split('\0').filter(Boolean);
  const serverEnv = Object.fromEntries(environ.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  check('A3 the server process itself has no DOCKER_HOST after launching sessions', !('DOCKER_HOST' in serverEnv), serverEnv.DOCKER_HOST ?? '(unset)');
  check('A3 the server\'s own docker reaches the HOST daemon', daemonIdUnder({ ...serverEnv, PATH: process.env.PATH }) === HOST_ID, idName(daemonIdUnder({ ...serverEnv, PATH: process.env.PATH })));
  const hosts = (() => { try { return fs.readdirSync(path.join(DATA, 'session-hosts')).length; } catch { return 0; } })();
  console.log(`        (launch path: ${hosts ? 'survival broker (session-host scope)' : 'direct SDK spawn'})`);
}

async function partB() {
  console.log('\n===== B — the explicit, logged opt-out =====');
  const DATA_B = path.join(scratch, 'data-b');
  const REG_B = writeRegistry(DATA_B, [['b-root', ROOT, 'sandbox']]);
  let lane = null;
  try {
    const { laneDockerEnv } = await import('./lib/lane-docker.mjs');
    lane = laneDockerEnv({ projectPath: ROOT, baseEnv: liveLikeEnv(), registry: REG_B });
  } catch (e) { check('B lane-docker module loads', false, e.message); return; }
  const laneEnv = { ...liveLikeEnv(), ...lane.env };
  const probe = (code) => spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, env: laneEnv, encoding: 'utf8' });
  const idOf = `import {spawnSync} from 'node:child_process';const id=()=>(spawnSync('docker',['info','--format','{{.ID}}'],{encoding:'utf8'}).stdout||'').trim();`;
  const noOpt = probe(`${idOf}process.stdout.write(id())`);
  check('B1 a lane child WITHOUT the opt-out reaches the sandbox', noOpt.stdout.trim() === SBX_ID, idName(noOpt.stdout.trim()));
  const logFile = path.join(sandboxPaths().dir, 'host-optouts.jsonl');
  const before = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').length : 0;
  const opt = probe(`${idOf}import {useHostDocker,laneDockerEnv} from './scripts/lib/lane-docker.mjs';useHostDocker('BUG-223 verify suite: opt-out self-test',{who:'verify-bug-223'});const kid=spawnSync(process.execPath,['-e',"process.stdout.write((require('node:child_process').spawnSync('docker',['info','--format','{{.ID}}'],{encoding:'utf8'}).stdout||'').trim())"],{encoding:'utf8'}).stdout;process.stdout.write(JSON.stringify({id:id(),kid,nested:laneDockerEnv({projectPath:process.cwd()}).decision}))`);
  let o = {}; try { o = JSON.parse(opt.stdout); } catch { /* reported below */ }
  check('B2 useHostDocker(reason) reaches the HOST daemon', o.id === HOST_ID, { id: idName(o.id), stderr: opt.stderr.trim().slice(0, 200) });
  check('B2 its children stay on the host too', o.kid === HOST_ID, idName(o.kid));
  check('B2 a scratch server under the opt-out would launch HOST sessions (decision host-optout)', o.nested === 'host-optout', o.nested);
  check('B3 the opt-out is announced on stderr', /HOST DOCKER OPT-OUT: verify-bug-223/.test(opt.stderr), opt.stderr.trim().slice(0, 200));
  const after = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(before) : '';
  check('B3 the opt-out is recorded in host-optouts.jsonl', /BUG-223 verify suite: opt-out self-test/.test(after), after.trim().slice(0, 200));
  const noReason = probe(`import {useHostDocker} from './scripts/lib/lane-docker.mjs';try{useHostDocker('');process.stdout.write('allowed')}catch(e){process.stdout.write('refused')}`);
  check('B4 an opt-out without a reason is refused', noReason.stdout === 'refused', noReason.stdout);
  // Sandbox DOWN (modelled by a state dir with no daemon behind its socket path, so the
  // shared sandbox other lanes use is never stopped): the lane's docker FAILS, never the host.
  const downState = path.join(scratch, 'state-no-sandbox');
  fs.mkdirSync(downState, { recursive: true });
  const down = spawnSync(process.execPath, ['--input-type=module', '-e', `import {laneDockerEnv} from './scripts/lib/lane-docker.mjs';import {spawnSync} from 'node:child_process';const l=laneDockerEnv({projectPath:process.cwd()});const r=spawnSync('docker',['info','--format','{{.ID}}'],{env:{...process.env,...l.env},encoding:'utf8',timeout:15000});process.stdout.write(JSON.stringify({decision:l.decision,host:l.env.DOCKER_HOST,code:r.status,id:(r.stdout||'').trim()}))`], { cwd: ROOT, env: { ...liveLikeEnv(), XDG_STATE_HOME: downState, CLAUDE_STATION_DATA: DATA_B }, encoding: 'utf8' });
  let d = {}; try { d = JSON.parse(down.stdout); } catch { d = { raw: down.stdout, err: down.stderr.slice(0, 200) }; }
  check('B5 sandbox not answering: the lane docker call FAILS (no fallback to the host)', d.decision === 'sandbox' && d.code !== 0 && d.id !== HOST_ID, d);
}

async function partF() {
  console.log('\n===== F — the REGISTRATION-TIME classification (classifyLaneDocker; never run at spawn) =====');
  const { isSandboxedProject, classifyLaneDocker } = await import('./lib/lane-docker.mjs');
  const base = path.join(scratch, 'cover');
  const mk = (rel, marker) => { const d = path.join(base, rel); fs.mkdirSync(d, { recursive: true }); if (marker) { fs.mkdirSync(path.join(d, 'scripts', 'lib'), { recursive: true }); fs.copyFileSync(MARK_SRC, path.join(d, 'scripts', 'lib', 'docker-sandbox.mjs')); } return d; };
  mk('root/a', true); mk('d2/x/y', true); mk('d3/x/y/z', true); mk('nm/node_modules/pkg', true); mk('plain/src', false); mk('deep/a/b/c/own', false);
  check('F1 checkout at the project root', isSandboxedProject(path.join(base, 'root/a')) === true, 'root/a');
  check('F2 checkout two levels down (nested copy)', isSandboxedProject(path.join(base, 'd2')) === true, 'd2/x/y');
  check('F3 checkout three levels down is beyond the bounded scan (documented limit)', isSandboxedProject(path.join(base, 'd3')) === false, 'd3/x/y/z');
  check('F4 ...but covered at any depth when it is the server\'s own checkout', isSandboxedProject(path.join(base, 'd3'), { checkouts: [path.join(base, 'd3/x/y/z')] }) === true, 'checkouts rule');
  check('F5 a marker inside node_modules does not count', isSandboxedProject(path.join(base, 'nm')) === false, 'nm/node_modules/pkg');
  check('F6 a plain project is not covered', isSandboxedProject(path.join(base, 'plain')) === false, 'plain');
  check('F7 the real repo root is covered', isSandboxedProject(ROOT) === true, ROOT);
  // Round 4: the two shapes the round-3 attacker broke, at REGISTRATION (the spawn never scans).
  if (typeof classifyLaneDocker !== 'function') { check('F8/F9 lane-docker exports classifyLaneDocker (registration-time classification)', false, 'missing'); return; }
  const inside = mk('tree/docs', false); mk('tree', true);
  const c8 = classifyLaneDocker(inside);
  check('F8 a project rooted INSIDE a checkout subdir starts as sandbox (r3 break 1 shape)', c8.value === 'sandbox', c8);
  const big = path.join(base, 'big-home');
  for (let i = 0; i < 4101; i++) fs.mkdirSync(path.join(big, `d${String(i).padStart(4, '0')}`), { recursive: true });
  mk('big-home/projects/orchard', true);
  const c9 = classifyLaneDocker(big);
  check('F9 a scan that runs out of budget starts as sandbox, the safe side (r3 break 2 shape)', c9.value === 'sandbox', c9);
  const c10 = classifyLaneDocker(mk('empty-dir', false));
  check('F10 an EMPTY directory starts as sandbox (r4 break 1 shape: nothing there yet)', c10.value === 'sandbox', c10);
  const c11 = classifyLaneDocker(path.join(base, 'plain'));
  check('F11 ...a non-empty plain project still starts as host (other projects keep their compose stacks on the host)', c11.value === 'host', c11);
  // Round 5 (attacker p1 break 1): an empty dir that cannot be LISTED (mode 0333) is not evidence of host.
  const unl = mk('unlistable-empty', false); fs.chmodSync(unl, 0o333);
  let c12; try { c12 = classifyLaneDocker(unl); } finally { fs.chmodSync(unl, 0o755); }
  check('F12 (r5 p1 break 1) a directory that cannot be listed starts as sandbox, the safe side', c12?.value === 'sandbox', c12);
}

async function partC() {
  console.log('\n===== C — the dispatch broker (server-side lane launch) =====');
  const fakeDispatch = path.join(scratch, 'fake-dispatch.mjs');
  fs.writeFileSync(fakeDispatch, `import * as fs from 'node:fs'; import {spawnSync} from 'node:child_process';
const a = process.argv.slice(2); fs.readFileSync(0, 'utf8');
fs.writeFileSync(a[a.indexOf('--meta-out') + 1], JSON.stringify({ provider: 'openai', sessionId: 'f', exitCode: 0, failureKind: null }));
process.stdout.write(JSON.stringify({ id: (spawnSync('docker', ['info', '--format', '{{.ID}}'], { encoding: 'utf8' }).stdout || '').trim(), DOCKER_HOST: process.env.DOCKER_HOST ?? null, cwd: process.cwd() }));`);
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) delete process.env[k];
  // Round 4: the broker reads each project's DECLARED settings.laneDocker from its registry.
  const brokerDirs = { true: project('broker-orchard', true), false: project('broker-plain', false) };
  writeRegistry(path.join(scratch, 'broker-data'), [['bug223-o', brokerDirs.true, 'sandbox'], ['bug223-p', brokerDirs.false, 'host']]);
  Object.assign(process.env, liveLikeEnv(saved), { CLAUDE_STATION_DATA: path.join(scratch, 'broker-data'), ORCHARD_DISPATCH_SCRIPT: fakeDispatch });
  const broker = await import('../src/server/dispatch-broker.ts');
  const ask = (sock) => new Promise((resolve, reject) => {
    const s = net.createConnection(sock); let b = ''; s.setEncoding('utf8');
    s.on('connect', () => s.write(JSON.stringify({ op: 'dispatch', provider: 'openai', prompt: 'x' }) + '\n'));
    s.on('data', (x) => { b += x; }); s.on('end', () => resolve(b.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)))); s.on('error', reject);
  });
  for (const [label, withTooling, want] of [['C1 sandboxed project', true, SBX_ID], ['C2 plain project', false, HOST_ID]]) {
    const dir = brokerDirs[withTooling];
    const p = { id: `bug223-${withTooling ? 'o' : 'p'}`, name: 'b', hostPath: dir, isolation: 'direct', settings: { tools: { serena: false, playwright: false, openaiDispatch: true } } };
    const sock = await broker.start(p);
    try {
      const res = (await ask(sock)).at(-1);
      let got = {}; try { got = JSON.parse(res.text); } catch { got = { raw: res?.text }; }
      check(`${label}: the broker-launched lane reaches ${want === SBX_ID ? 'the SANDBOX' : 'the HOST'} daemon`, got.id === want, { id: idName(got.id), DOCKER_HOST: got.DOCKER_HOST });
    } finally { await broker.stop(p); }
  }
  check('C3 the broker\'s own process env is unchanged (no DOCKER_HOST)', !process.env.DOCKER_HOST, process.env.DOCKER_HOST ?? '(unset)');
  // Round 6 (r5 p3 break): a broker is started once per project id and outlives a repoint. It used
  // to keep the project object of its FIRST start, so after B (sandbox) was repointed and a plain
  // project A (classified host) was registered at B's old path, B's next lane ran in A's directory
  // with A's 'host'. Driven through the REAL registry functions (createProject / updateProject /
  // deleteProject) and the real classifier, as the user's repoint + register would.
  const reg = await import('../src/server/registry.ts');
  const c4 = path.join(scratch, 'c4'); fs.mkdirSync(c4, { recursive: true });
  const oldDir = path.join(c4, 'proj'); const newDir = path.join(c4, 'proj-moved');
  fs.mkdirSync(path.join(oldDir, 'scripts', 'lib'), { recursive: true }); fs.copyFileSync(MARK_SRC, path.join(oldDir, 'scripts', 'lib', 'docker-sandbox.mjs'));
  const B = reg.createProject({ name: 'bug223-c4-b', hostPath: oldDir, isolation: 'direct', settings: { tools: { serena: false, playwright: false, openaiDispatch: true } } });
  const sockB = await broker.start(B);
  try {
    const lane = async () => { const r = (await ask(sockB)).at(-1); try { return { ...JSON.parse(r.text), failureKind: r.failureKind ?? null }; } catch { return { raw: r?.text, failureKind: r?.failureKind ?? null, ok: r?.ok }; } };
    const l1 = await lane();
    fs.renameSync(oldDir, newDir);
    reg.updateProject(B.id, { hostPath: newDir });
    fs.mkdirSync(oldDir); fs.writeFileSync(path.join(oldDir, 'docker-compose.yml'), 'services: {}\n');
    const A = reg.createProject({ name: 'bug223-c4-a', hostPath: oldDir, isolation: 'direct' });
    const sameSock = (await broker.start(reg.getProject(B.id))) === sockB;
    const l2 = await lane();
    check('C4 (r5 p3 break) after B (sandbox) is repointed and a host project registered at its old path, B\'s next broker lane reaches the SANDBOX in B\'s NEW directory',
      l1.id === SBX_ID && sameSock && reg.getProject(A.id)?.settings?.laneDocker === 'host' && l2.id === SBX_ID && l2.cwd === newDir,
      { lane1: idName(l1.id), sameBroker: sameSock, aDeclared: reg.getProject(A.id)?.settings?.laneDocker, lane2: idName(l2.id), lane2Cwd: l2.cwd, want: newDir });
    reg.deleteProject(B.id);
    const l3 = await lane();
    check('C5 (r6) a lane for a project that is no longer registered is REFUSED (no cached path, no spawn)', l3.failureKind === 'project-not-registered' && !l3.id, l3);
  } finally { await broker.stop(B); }
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, saved);
}

async function partD() {
  console.log('\n===== D — the codex runtime applies the launch dockerEnv =====');
  const out = path.join(scratch, 'codex-out.json');
  const fake = path.join(scratch, 'fake-codex.mjs');
  fs.writeFileSync(fake, `import * as fs from 'node:fs'; import {spawnSync} from 'node:child_process';
fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ id: (spawnSync('docker', ['info', '--format', '{{.ID}}'], { encoding: 'utf8' }).stdout || '').trim(), DOCKER_HOST: process.env.DOCKER_HOST ?? null }));
process.stdin.resume(); setTimeout(() => process.exit(0), 3000);`);
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) delete process.env[k];
  const codexCwd = project('codex-orchard', true);
  writeRegistry(path.join(scratch, 'codex-data'), [['codex-orchard', codexCwd, 'sandbox']]);
  Object.assign(process.env, liveLikeEnv(saved), { CLAUDE_STATION_CODEX_BIN: fake, CLAUDE_STATION_DATA: path.join(scratch, 'codex-data') });
  try {
    const { CodexRuntime } = await import('../src/server/runtime/codex-runtime.ts');
    const { laneDockerEnv } = await import('./lib/lane-docker.mjs');
    const rt = new CodexRuntime();
    const cwd = codexCwd;
    try {
      rt.start({ cwd, firstPrompt: 'hi', permissionMode: 'default', onApproval: async () => ({ behavior: 'deny', message: 'n/a' }), dockerEnv: laneDockerEnv({ projectPath: cwd }).env });
      void (async () => { try { for await (const _ of rt.messages()) { /* drain */ } } catch { /* fake exits */ } })();
    } catch { /* the fake speaks no protocol */ }
    for (let i = 0; i < 100 && !fs.existsSync(out); i++) await sleep(100);
    try { rt.close(); } catch { /* ignore */ }
    const r = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
    check('D1 a codex-runtime session child reaches the SANDBOX daemon', !!r && r.id === SBX_ID, r ? { id: idName(r.id), DOCKER_HOST: r.DOCKER_HOST } : 'fake codex never ran');
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

async function partE() {
  console.log('\n===== E — container sessions are unaffected =====');
  const cm = await import('../src/server/container-manager.ts');
  const argv = cm.execArgv({ id: 'bug223-c', name: 'c', hostPath: scratch, isolation: 'container', settings: {} }, { command: 'claude', args: [], env: { DOCKER_HOST: sandboxPaths().dockerHost, ORCHARD_LANE_DOCKER: 'sandbox' }, execId: 'x' });
  check('E1 docker exec argv does not forward DOCKER_HOST into a container', !argv.join(' ').includes('DOCKER_HOST'), argv.filter((a) => a.includes('DOCKER')).join(' ') || '(none)');
}


/* ===== G — inherited, not re-derived (round 3, ARCH-010) — jailed, host socket = TRIPWIRE =====
 * The host socket (/run/docker.sock, which /var/run/docker.sock and the default context
 * resolve to) is bind-mounted, inside a bwrap jail, onto a tripwire that answers `info`
 * with ID HOST-TRIPWIRE-… and logs every request. "Reached the host" = that id or any
 * logged line; the real host daemon is unreachable from inside. Scenarios (synthetic
 * fixtures, the shapes the round-2 attacker and the round-3 charter named):
 *   G1 round-2 break A: a LANE (declared ORCHARD_LANE_DOCKER=<sandbox socket>) boots a
 *      scratch server with its own XDG_STATE_HOME; its session lands in the sandbox and
 *      nothing (no `sandbox:docker up`) reaches the host.
 *   G2 round-2 break B: a live-like (top-level) server, a project holding the checkout
 *      through a SYMLINKED dir → sandbox, no host contact.
 *   G3 NEW, nested server with a SHIFTED LAYOUT: the lane's scratch server is booted with
 *      DOCKER_HOST dropped (hostDockerEnv(laneEnv)) and its own XDG_STATE_HOME; it launches
 *      an Orchard-shaped project AND a plain one. Both land in the sandbox; no host contact.
 *   G4 a process booted inside a lane with DOCKER_HOST dropped obeys its declaration as
 *      soon as it loads lane-docker.mjs (its OWN docker reaches the sandbox).
 *   G5 `sandbox:docker up` inside a lane whose declared daemon is down: refused, no host contact.
 *   G6 a declaration naming the HOST socket is not honoured: fail-closed, no host contact.
 */
const TRIP_ID = 'HOST-TRIPWIRE-0000-0000-0000-000000000000';
const TRIPWIRE_SRC = `import http from 'node:http'; import fs from 'node:fs';
const [sock, log] = process.argv.slice(2); try { fs.unlinkSync(sock); } catch {}
const srv = http.createServer((req, res) => { let body = ''; req.on('data', (d) => { if (body.length < 2000) body += d; });
  req.on('end', () => { fs.appendFileSync(log, JSON.stringify({ ts: new Date().toISOString(), method: req.method, url: req.url }) + '\\n');
    const h = { 'Content-Type': 'application/json', 'Api-Version': '1.47', 'Ostype': 'linux' }; const u = req.url.replace(/^\\/v[0-9.]+/, '');
    if (u.startsWith('/_ping')) { res.writeHead(200, { ...h, 'Content-Type': 'text/plain' }); return res.end(req.method === 'HEAD' ? undefined : 'OK'); }
    if (u.startsWith('/version')) { res.writeHead(200, h); return res.end(JSON.stringify({ Version: 'tripwire', ApiVersion: '1.47', MinAPIVersion: '1.24', Os: 'linux', Arch: 'amd64', Components: [] })); }
    if (u.startsWith('/info')) { res.writeHead(200, h); return res.end(JSON.stringify({ ID: '${TRIP_ID}', Name: 'HOST-TRIPWIRE', ServerVersion: 'tripwire' })); }
    res.writeHead(500, h); res.end(JSON.stringify({ message: 'TRIPWIRE: reached the HOST socket path (BUG-223 suite jail)' })); }); });
srv.listen(sock, () => { fs.chmodSync(sock, 0o666); process.stdout.write('ready\\n'); });`;

const RUNNER_SRC = `import { spawn, spawnSync } from 'node:child_process'; import * as fs from 'node:fs'; import * as path from 'node:path'; import * as net from 'node:net';
const [ROOT, which, W, FAKE, SBX_HOST, TRIP] = process.argv.slice(2);
const { hostDockerEnv } = await import(path.join(ROOT, 'scripts/lib/docker-sandbox.mjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tripN = () => { try { return fs.readFileSync(TRIP, 'utf8').split('\\n').filter(Boolean).length; } catch { return 0; } };
const strip = (e) => { const x = hostDockerEnv(e); delete x.ORCHARD_LANE_DOCKER; delete x.ORCHARD_DOCKER_HOST_OPTOUT; return x; };
const base = strip(process.env);
const lane = { ...base, DOCKER_HOST: SBX_HOST, ORCHARD_LANE_DOCKER: SBX_HOST };
const B = path.join(W, which); const OUT = path.join(B, 'out'); fs.mkdirSync(OUT, { recursive: true });
const marker = (d) => { fs.mkdirSync(path.join(d, 'scripts/lib'), { recursive: true }); fs.copyFileSync(path.join(ROOT, 'scripts/lib/docker-sandbox.mjs'), path.join(d, 'scripts/lib/docker-sandbox.mjs')); return d; };
const plain = (d) => { fs.mkdirSync(d, { recursive: true }); return d; };
async function server(env, projects) {
  const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const s = spawn(process.execPath, [path.join(ROOT, 'src/server/index.ts')], { cwd: ROOT, detached: true,
    env: { ...env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: path.join(B, 'data'), CLAUDE_PROJECTS_DIR: path.join(B, 'store'),
      CLAUDE_STATION_CLAUDE_BIN: FAKE, CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0', CLAUDE_STATION_NO_WA_CONSOLIDATE: '1', CLAUDE_STATION_SURVIVE: '0', BUG223_OUT: OUT },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; s.stdout.on('data', (d) => { log += d; }); s.stderr.on('data', (d) => { log += d; });
  const recs = {}; const patches = {};
  try {
    let up = false; for (let i = 0; i < 200 && !up; i++) { try { await fetch('http://127.0.0.1:' + port + '/api/health'); up = true; } catch { await sleep(250); } }
    const { default: WebSocket } = await import(path.join(ROOT, 'node_modules/ws/wrapper.mjs'));
    for (const ent of projects) {
      const dir = typeof ent === 'string' ? ent : ent.dir;
      const r = await (await fetch('http://127.0.0.1:' + port + '/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: dir, name: 'g-' + which + '-' + path.basename(dir), isolation: 'direct' }) })).json();
      if (typeof ent !== 'string' && ent.laneDocker) {
        // Round 4: the user DECLARES the project's daemon (Settings → Isolation). A server that
        // does not know the setting rejects the PATCH; the session launches anyway.
        const pr = await fetch('http://127.0.0.1:' + port + '/api/projects/' + encodeURIComponent(r.project.id), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: { laneDocker: ent.laneDocker } }) });
        patches[path.basename(dir)] = pr.status;
      }
      const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws'); await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }); ws.on('error', () => {});
      const events = []; ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch {} });
      const start = () => ws.send(JSON.stringify({ type: 'start', projectId: r.project.id, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' }, prompt: 'hi' }));
      const f = path.join(OUT, path.basename(dir) + '.json');
      start(); let seen = 0;
      for (let i = 0; i < 400 && !fs.existsSync(f); i++) { await sleep(100); if (events.slice(seen).some((e) => e.code === 'runtime-check-pending')) { await sleep(1000); start(); } seen = events.length; }
      await sleep(300); try { ws.close(); } catch {}
      recs[path.basename(dir)] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
    }
    await sleep(1500); // let a background ensureSandboxUp() reach (or not reach) the host
  } finally { try { process.kill(-s.pid, 'SIGTERM'); } catch {} await sleep(500); try { process.kill(-s.pid, 'SIGKILL'); } catch {} }
  return { recs, patches, log: log.split('\\n').filter((l) => /BUG-223/.test(l)).map((l) => l.slice(0, 240)) };
}
const t0 = tripN(); let res = {};
if (which === 'G1') res = await server({ ...lane, XDG_STATE_HOME: path.join(B, 'xdg') }, [marker(path.join(B, 'proj'))]);
else if (which === 'G2') { plain(path.join(B, 'proj')); marker(path.join(B, 'ext', 'orchard')); fs.symlinkSync('../ext/orchard', path.join(B, 'proj', 'orchard')); res = await server(base, [path.join(B, 'proj')]); }
else if (which === 'G3') res = await server({ ...hostDockerEnv(lane), XDG_STATE_HOME: path.join(B, 'xdg') }, [marker(path.join(B, 'proj')), plain(path.join(B, 'plain'))]);
else if (which === 'G4') { const r = spawnSync(process.execPath, ['--input-type=module', '-e', "await import(" + JSON.stringify(path.join(ROOT, 'scripts/lib/lane-docker.mjs')) + "); const {spawnSync}=await import('node:child_process'); process.stdout.write((spawnSync('docker',['info','--format','{{.ID}}'],{encoding:'utf8',timeout:15000}).stdout||'').trim())"], { env: { ...hostDockerEnv(lane), XDG_STATE_HOME: path.join(B, 'xdg') }, encoding: 'utf8' }); res = { id: r.stdout.trim(), err: r.stderr.slice(0, 200) }; }
else if (which === 'G5') { const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/docker-sandbox.mjs'), 'up', '--no-preload'], { env: { ...hostDockerEnv(lane), ORCHARD_LANE_DOCKER: 'unix://' + path.join(B, 'gone.sock'), XDG_STATE_HOME: path.join(B, 'xdg') }, encoding: 'utf8', timeout: 150000 }); res = { code: r.status, err: (r.stderr || '').trim().split('\\n').slice(-2).join(' | ').slice(0, 300) }; }
else if (which === 'H') {
  // Round-3 attacker break 1: a project rooted INSIDE a checkout subdir (tree/docs).
  marker(path.join(B, 'tree')); const inside = plain(path.join(B, 'tree', 'docs'));
  // Round-3 attacker break 2: a home-shaped project whose 4101 dirs exhaust the scan budget before projects/orchard.
  const home = plain(path.join(B, 'home')); for (let i = 0; i < 4101; i++) fs.mkdirSync(path.join(home, 'd' + String(i).padStart(4, '0')));
  marker(path.join(home, 'projects', 'orchard'));
  res = await server(base, [{ dir: inside, laneDocker: 'sandbox' }, { dir: home, laneDocker: 'sandbox' }]);
}
else if (which === 'H3') res = await server(base, [{ dir: marker(path.join(B, 'shaped')), laneDocker: 'host' }, { dir: plain(path.join(B, 'flat')), laneDocker: 'sandbox' }]);
else if (which === 'G6') res = await server({ ...lane, DOCKER_HOST: 'unix:///run/docker.sock', ORCHARD_LANE_DOCKER: 'unix:///run/docker.sock' }, [marker(path.join(B, 'proj'))]);
const tripReqs = (() => { try { return fs.readFileSync(TRIP, 'utf8').split('\\n').filter(Boolean).slice(t0).map((l) => JSON.parse(l)); } catch { return []; } })();
process.stdout.write('\\n' + JSON.stringify({ scenario: which, trip: tripN() - t0, tripReqs, ...res }) + '\\n');
process.exit(0);`;

async function partG() {
  console.log('\n===== G — inherited, not re-derived (round 3): jailed, host socket = tripwire =====');
  const { inheritedLaneDocker, laneDockerEnv, FAIL_CLOSED_DOCKER_HOST } = await import('./lib/lane-docker.mjs').catch(() => ({}));
  // G0 — the decision rule itself: an inherited declaration wins over the project layout.
  if (typeof inheritedLaneDocker !== 'function') check('G0 lane-docker exports inheritedLaneDocker (the declared-value reader)', false, 'missing');
  else {
    const sock = sandboxPaths().dockerHost;
    const plainDir = project('g0-plain', false); const orch = project('g0-orch', true);
    const lane = { ...liveLikeEnv(), DOCKER_HOST: sock, ORCHARD_LANE_DOCKER: sock };
    const a = laneDockerEnv({ projectPath: plainDir, baseEnv: { ...lane, XDG_STATE_HOME: path.join(scratch, 'g0-xdg') } });
    check('G0a an inherited sandbox declaration wins over a plain layout and a shifted XDG_STATE_HOME', a.decision === 'sandbox' && a.env.DOCKER_HOST === sock && a.inherited === true, a);
    const h = laneDockerEnv({ projectPath: orch, baseEnv: { ...liveLikeEnv(), ORCHARD_LANE_DOCKER: 'host' } });
    check('G0b an inherited host declaration is not re-derived from an Orchard-shaped layout', h.decision === 'not-applicable' && !h.env.DOCKER_HOST, h);
    // Round 4: the top level READS the project's declared settings.laneDocker and stamps it.
    const undeclared = project('g0-undeclared', false);
    const REG = writeRegistry(path.join(scratch, 'g0-data'), [['g0-orch', orch, 'sandbox'], ['g0-plain', plainDir, 'host'], ['g0-undeclared', undeclared, undefined]]);
    const t = laneDockerEnv({ projectPath: orch, baseEnv: liveLikeEnv(), registry: REG });
    check('G0c the top level (nothing inherited) reads the DECLARED setting and STAMPS it', t.decision === 'sandbox' && t.env.ORCHARD_LANE_DOCKER === sock && t.inherited === false, t);
    const REG2 = writeRegistry(path.join(scratch, 'g0-data2'), [['g0-orch', orch, 'host'], ['g0-plain', plainDir, 'sandbox']]);
    const f = laneDockerEnv({ projectPath: orch, baseEnv: liveLikeEnv(), registry: REG2 });
    check('G0f an Orchard-SHAPED project DECLARED host keeps the host (the setting decides, not the shape)', f.decision === 'not-applicable' && !f.env.DOCKER_HOST && f.env.ORCHARD_LANE_DOCKER === 'host', f);
    const g = laneDockerEnv({ projectPath: plainDir, baseEnv: liveLikeEnv(), registry: REG2 });
    check('G0g a PLAIN project DECLARED sandbox gets the sandbox (the setting decides, not the shape)', g.decision === 'sandbox' && g.env.DOCKER_HOST === sock, g);
    const u = laneDockerEnv({ projectPath: undeclared, baseEnv: liveLikeEnv(), registry: REG });
    const un = laneDockerEnv({ projectPath: path.join(scratch, 'not-registered'), baseEnv: liveLikeEnv(), registry: REG });
    check('G0h an UNDECLARED row or an unregistered path fails SAFE to the sandbox', u.decision === 'sandbox' && un.decision === 'sandbox' && u.env.DOCKER_HOST === sock, { undeclared: u.reason, unregistered: un.reason });
    // "Never scans": count directory listings made by a top-level laneDockerEnv() call.
    const { syncBuiltinESMExports } = await import('node:module');
    const fsd = (await import('node:fs')).default;
    const realReaddir = fsd.readdirSync; const realOpendir = fsd.opendirSync; let listings = 0;
    fsd.readdirSync = function (...a) { listings++; return realReaddir.apply(this, a); };
    fsd.opendirSync = function (...a) { listings++; return realOpendir.apply(this, a); };
    syncBuiltinESMExports();
    try { for (const pp of [orch, plainDir, undeclared, ROOT, os.homedir()]) laneDockerEnv({ projectPath: pp, baseEnv: liveLikeEnv(), registry: REG }); }
    finally { fsd.readdirSync = realReaddir; fsd.opendirSync = realOpendir; syncBuiltinESMExports(); }
    // Control: the same counter DOES see the classification's scan (the probe is live).
    fsd.readdirSync = function (...a) { listings++; return realReaddir.apply(this, a); }; syncBuiltinESMExports();
    let ctl = 0; try { const before = listings; const m = await import('./lib/lane-docker.mjs'); (m.classifyLaneDocker ?? m.isSandboxedProject)(plainDir); ctl = listings - before; listings -= ctl; }
    finally { fsd.readdirSync = realReaddir; syncBuiltinESMExports(); }
    check('G0i control: the listing counter does see a classification scan', ctl > 0, { ctl });
    check('G0i a top-level laneDockerEnv() never scans the filesystem (0 directory listings over 5 calls, incl. the home dir)', listings === 0, { listings });
    const bad = ['garbage', 'unix://relative/x.sock', 'unix:///run/docker.sock', 'unix:///var/run/docker.sock'].map((m) => laneDockerEnv({ projectPath: plainDir, baseEnv: { ...liveLikeEnv(), ORCHARD_LANE_DOCKER: m } }).env.DOCKER_HOST);
    check('G0d an unusable or host-naming declaration FAILS CLOSED (never the host)', bad.every((x) => x === FAIL_CLOSED_DOCKER_HOST), bad);
    const leg = laneDockerEnv({ projectPath: plainDir, baseEnv: { ...liveLikeEnv(), ORCHARD_LANE_DOCKER: 'sandbox', DOCKER_HOST: sock } });
    check('G0e a legacy (round 1-2) "sandbox" mark is read as its DOCKER_HOST', leg.decision === 'sandbox' && leg.env.DOCKER_HOST === sock, leg.env);
    // Round 5 (attacker p2 break 1): two rows resolve to one path (the scratch repoint has no clash
    // check). First-match used to hand a 'sandbox' project the other row's 'host'.
    const shared = project('g0-shared', false);
    const REG3 = writeRegistry(path.join(scratch, 'g0-data3'), [['g0-host-first', shared, 'host'], ['g0-sbx-second', shared, 'sandbox']]);
    const REG4 = writeRegistry(path.join(scratch, 'g0-data4'), [['g0-h1', shared, 'host'], ['g0-h2', `${shared}/`, 'host']]);
    const j = laneDockerEnv({ projectPath: shared, baseEnv: liveLikeEnv(), registry: REG3 });
    const jj = laneDockerEnv({ projectPath: shared, baseEnv: liveLikeEnv(), registry: REG4 });
    check('G0j (r5 p2 break 1) two rows on one path: host only when EVERY row declares host (first match no longer decides)', j.decision === 'sandbox' && j.env.DOCKER_HOST === sock && jj.decision === 'not-applicable', { mixed: j.reason, allHost: jj.reason });
    // Round 6: a caller holding the project's row, re-read BY ID, gets THAT row's declaration,
    // never whichever row sits at its path; a project that is no longer registered fails safe.
    const byIdSbx = laneDockerEnv({ projectPath: shared, project: { id: 'g0-sbx-second', hostPath: shared, settings: { laneDocker: 'sandbox' } }, baseEnv: liveLikeEnv(), registry: REG4 });
    const byIdHost = laneDockerEnv({ projectPath: orch, project: { id: 'g0-orch', hostPath: orch, settings: { laneDocker: 'host' } }, baseEnv: liveLikeEnv(), registry: REG });
    const byIdGone = laneDockerEnv({ projectPath: plainDir, project: null, baseEnv: liveLikeEnv(), registry: REG });
    const byIdBad = laneDockerEnv({ projectPath: plainDir, project: { id: 'x', settings: { laneDocker: 'HOST' } }, baseEnv: liveLikeEnv(), registry: REG });
    check('G0k (r6) the row re-read by id decides, not the path: sandbox row at an all-host path -> sandbox; host row at a sandbox path -> host; unregistered (null) and malformed -> sandbox',
      byIdSbx.decision === 'sandbox' && byIdHost.decision === 'not-applicable' && byIdGone.decision === 'sandbox' && byIdBad.decision === 'sandbox',
      { sbxRow: byIdSbx.reason, hostRow: byIdHost.reason, gone: byIdGone.reason, malformed: byIdBad.reason });
  }
  // G1-G6 — real processes in a bwrap jail whose host socket is the tripwire.
  if (spawnSync('bwrap', ['--version'], { encoding: 'utf8' }).status !== 0) { check('G jail available (bwrap)', false, 'bwrap not runnable: the jailed scenarios did NOT run'); return; }
  const tripSock = path.join(scratch, 'trip.sock'); const tripLog = path.join(scratch, 'trip.jsonl');
  const trSrc = path.join(scratch, 'tripwire.mjs'); fs.writeFileSync(trSrc, TRIPWIRE_SRC);
  const runner = path.join(scratch, 'g-runner.mjs'); fs.writeFileSync(runner, RUNNER_SRC);
  fs.writeFileSync(tripLog, '');
  const tw = spawn(process.execPath, [trSrc, tripSock, tripLog], { stdio: ['ignore', 'pipe', 'inherit'] });
  servers.add(tw);
  await new Promise((res) => { tw.stdout.once('data', res); setTimeout(res, 5000); });
  const W = path.join(scratch, 'g'); fs.mkdirSync(W, { recursive: true });
  const jail = (which) => {
    const r = spawnSync('bwrap', ['--dev-bind', '/', '/', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--bind', tripSock, '/run/docker.sock',
      '--', process.execPath, runner, ROOT, which, W, FAKE, sandboxPaths().dockerHost, tripLog],
    { env: { ...liveLikeEnv(), HOST_DOCKER_ID: TRIP_ID }, encoding: 'utf8', timeout: 300_000 });
    const line = (r.stdout ?? '').trim().split('\n').reverse().find((l) => l.startsWith('{"scenario"'));
    let o = null; try { o = JSON.parse(line); } catch { o = { scenario: which, error: `runner exit ${r.status}`, stderr: (r.stderr ?? '').slice(-400) }; }
    for (const rec of Object.values(o.recs ?? {})) if (rec?.volume) probeVolumes.add(rec.volume);
    return o;
  };
  const sid = (rec) => (rec ? idName(rec.ownId === TRIP_ID ? 'HOST-TRIPWIRE' : rec.ownId) : 'no session');
  const ok = (rec) => !!rec && rec.ownId === SBX_ID && rec.grandchildId === SBX_ID;
  // A TOP-LEVEL server keeps the host for its OWN docker by design (A3): its read-only boot
  // listing of labelled containers (`ps --filter label=claude-station=1`) is not a lane
  // reaching the host. Everything else on the tripwire is.
  const laneReqs = (o) => (o.tripReqs ?? []).filter((r) => !(r.method === 'HEAD' && /\/_ping$/.test(r.url)) && !(r.method === 'GET' && /\/containers\/json\?/.test(r.url)));
  const g1 = jail('G1');
  check('G1 (r2 break A) a lane-booted server with its own XDG_STATE_HOME: session in the SANDBOX, 0 host requests', ok(g1.recs?.proj) && g1.trip === 0, { session: sid(g1.recs?.proj), hostRequests: g1.trip, log: g1.log, err: g1.error });
  const g2 = jail('G2');
  check('G2 (r2 break B) a symlinked checkout under a top-level server: SANDBOX, 0 lane requests to the host', ok(g2.recs?.proj) && laneReqs(g2).length === 0, { session: sid(g2.recs?.proj), hostRequests: g2.trip, laneRequests: laneReqs(g2), err: g2.error });
  const g3 = jail('G3');
  check('G3 (new) nested server, shifted layout (DOCKER_HOST dropped, own XDG): Orchard-shaped project in the SANDBOX', ok(g3.recs?.proj), { session: sid(g3.recs?.proj), DOCKER_HOST: g3.recs?.proj?.DOCKER_HOST, err: g3.error });
  check('G3 (new) ...a PLAIN project launched by that nested server is in the SANDBOX too (inherited, not re-derived)', ok(g3.recs?.plain), { session: sid(g3.recs?.plain), DOCKER_HOST: g3.recs?.plain?.DOCKER_HOST });
  check('G3 (new) ...and nothing in that scenario reached the host (no sandbox:docker up, no server docker call)', g3.trip === 0, { hostRequests: g3.trip, log: g3.log });
  const g4 = jail('G4');
  check('G4 a process booted in a lane with DOCKER_HOST dropped obeys its declaration once it loads lane-docker.mjs', g4.id === SBX_ID && g4.trip === 0, { id: g4.id === TRIP_ID ? 'HOST-TRIPWIRE' : idName(g4.id), hostRequests: g4.trip, err: g4.err });
  const g5 = jail('G5');
  check('G5 sandbox:docker up inside a lane whose declared daemon is down: refused, 0 host requests', g5.code !== 0 && g5.trip === 0, { code: g5.code, hostRequests: g5.trip, err: g5.err });
  const g6 = jail('G6');
  const s6 = g6.recs?.proj;
  check('G6 a declaration naming the HOST socket is not honoured: the session does not reach the host, 0 host requests', !!s6 && s6.ownId !== TRIP_ID && s6.grandchildId !== TRIP_ID && g6.trip === 0, { session: sid(s6), DOCKER_HOST: s6?.DOCKER_HOST, hostRequests: g6.trip });
  // H — round 4: the DECLARED setting decides at spawn; the round-3 attacker's two breaks.
  console.log('\n===== H — the declared per-project setting decides (round 4): the round-3 breaks, jailed =====');
  const h = jail('H');
  check('H1 (r3 break 1) a project rooted INSIDE a checkout subdir, declared sandbox: session + grandchild in the SANDBOX', ok(h.recs?.docs), { session: sid(h.recs?.docs), mark: h.recs?.docs?.mark, patch: h.patches?.docs, err: h.error });
  check('H2 (r3 break 2) a home-shaped project past the scan budget, declared sandbox: session + grandchild in the SANDBOX', ok(h.recs?.home), { session: sid(h.recs?.home), mark: h.recs?.home?.mark, patch: h.patches?.home });
  check('H1/H2 no lane request in that scenario reached the host (only the top-level server\'s own read-only listing)', laneReqs(h).length === 0, { hostRequests: h.trip, laneRequests: laneReqs(h), log: h.log });
  const h3 = jail('H3');
  const hs = h3.recs?.shaped;
  check('H3 an Orchard-SHAPED project the user DECLARED host reaches the host (the setting decides, not the shape)', !!hs && hs.ownId === TRIP_ID && hs.mark === 'host' && !hs.DOCKER_HOST, { session: sid(hs), mark: hs?.mark, patch: h3.patches?.shaped, err: h3.error });
  check('H4 a PLAIN project the user DECLARED sandbox reaches the SANDBOX', ok(h3.recs?.flat), { session: sid(h3.recs?.flat), mark: h3.recs?.flat?.mark, patch: h3.patches?.flat });
  try { tw.kill('SIGTERM'); } catch { /* gone */ }
}

async function main() {
  if (!HOST_ID || !SBX_ID || HOST_ID === SBX_ID) {
    console.error(`REFUSED: need both daemons readable and distinct (host=${HOST_ID || '?'} sandbox=${SBX_ID || '?'}). Start the sandbox: npm run sandbox:docker -- up`);
    process.exit(2);
  }
  console.log(`host daemon ${HOST_ID.slice(0, 12)}  sandbox daemon ${SBX_ID.slice(0, 12)}`);
  const only = (process.env.BUG223_ONLY ?? 'A,B,C,D,E,F,G').split(','); // H runs inside G (same jail)
  if (only.includes('A')) await partA();
  if (only.includes('B')) await partB();
  if (only.includes('C')) await partC();
  if (only.includes('D')) await partD();
  if (only.includes('E')) await partE();
  if (only.includes('F')) await partF();
  if (only.includes('G')) await partG();
}

let fatal = false;
main().catch((e) => { console.error('FATAL', e.stack ?? e.message); fatal = true; }).finally(async () => {
  await sleep(300);
  try { for (const f of fs.readdirSync(path.join(DATA, 'session-hosts'))) { try { const h = JSON.parse(fs.readFileSync(path.join(DATA, 'session-hosts', f), 'utf8')); for (const p of [h.claudePid, h.hostPid]) if (p && pidAlive(p)) try { process.kill(p, 'SIGKILL'); } catch {} } catch {} } } catch {}
  for (const sv of servers) { if (sv?.pid) { try { process.kill(sv.pid, 'SIGTERM'); } catch {} } }
  await sleep(1500);
  for (const sv of servers) { if (sv?.pid && pidAlive(sv.pid)) try { process.kill(sv.pid, 'SIGKILL'); } catch {} }
  for (const v of probeVolumes) removeProbe(v);
  console.log(`\n${pass}/${pass + fail} checks passed${fatal ? ' (FATAL — the run aborted before completing)' : ''}`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  if (process.env.BUG223_KEEP) console.log(`kept scratch: ${scratch}`); else fs.rmSync(scratch, { recursive: true, force: true });
  process.exit((fail || fatal || pass + fail === 0) ? 1 : 0);
});
