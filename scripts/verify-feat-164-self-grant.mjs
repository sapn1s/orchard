#!/usr/bin/env node
/**
 * FEAT-164 round 2 — an agent cannot grant ITSELF agent git-write access.
 *
 * The goal the user set: the USER grants an agent git-write access (once, 30 min
 * or permanent, per project); an agent cannot grant itself. Round 1 shipped the
 * permanent grant with three self-grant paths open for DIRECT (host) sessions:
 *   H1  the agent edits the registry file and sets settings.gitWrite itself;
 *   H2  the agent calls POST /api/projects/:id/git-write-grant over loopback
 *       (directly, or through scripts/git-grant.mjs);
 *   H3  the agent raises a git-write request and answers it "Allow" itself via
 *       POST /api/projects/:id/board/answer.
 *
 * REALISM (not a fixture of the agent): the "agent" here is a REAL Orchard-launched
 * session process on an isolated scratch server — the CLI binary is a stand-in
 * (CLAUDE_STATION_CLAUDE_BIN) but Orchard launches it exactly as it launches
 * Claude: through the session host, in its claude-station-host-t-*.scope cgroup,
 * with the real FEAT-135 git shim on its PATH. The stand-in executes the probe
 * steps this suite hands it (HTTP calls, a registry edit, `git` through its PATH)
 * FROM INSIDE that session process — the process an agent's Bash really is.
 * The "user" is a process outside every agent cgroup (a transient user scope),
 * which is where the user's browser and terminal live. The scratch server runs in
 * its own scope, like the live service does.
 *
 * Nothing here touches a real repo: the project dirs are plain scratch dirs, and
 * the only `git` run is `git add` through the shim in a NON-repo dir (allowed →
 * git itself fails "not a git repository"; refused → the shim's refusal).
 *
 * STATUS: H1/H2/H3 and the in-cgroup case are marked OPEN (exit 2), not FAIL. They
 * are real self-grant paths today and are reproduced on every run. Closing them
 * awaits the FEAT-164 fork decision, because a same-uid host agent can work around
 * anything Orchard alone holds. The checks are behavioural ("refused, grants
 * nothing"), so whichever design closes them, this suite verifies it. Every other
 * check is an invariant that must hold now: the user's grants, the request flow,
 * the answer-once rule, restart, and a torn registry. A failure there is FAIL (exit 1).
 *
 *   node scripts/verify-feat-164-self-grant.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { mkdtempScratch } from './lib/scratch.mjs';
import { isolatedServerEnv } from './lib/station-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0, holesOpen = 0;
/** `hole` marks a self-grant path whose closure awaits the FEAT-164 fork decision
 * (see the ticket's 2026-10-05 fixing-r2 entry). It is reported loudly as OPEN and
 * makes the run exit 2; every other check is an invariant that must hold today. */
function check(name, ok, detail, { hole = false } = {}) {
  if (ok) { pass++; console.log(`  PASS ${name}`); return; }
  if (hole) holesOpen++; else fail++;
  console.log(`  ${hole ? 'OPEN' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 400)}`}`);
}
const HOLE = { hole: true };

if (spawnSync('systemd-run', ['--version']).status !== 0) {
  console.log('FAIL systemd-run is required (agent sessions are cgroup-scoped by it; the suite cannot model them without it)');
  process.exit(1);
}

const RUN = mkdtempScratch('f164sg-');
const DATA = path.join(RUN, 'data');
const STORE = path.join(RUN, 'store');
const PA = path.join(RUN, 'proj-a');
const PB = path.join(RUN, 'proj-b');
for (const d of [DATA, STORE, PA, PB]) fs.mkdirSync(d, { recursive: true });
const REGISTRY = path.join(DATA, 'registry.json');
const tag = randomBytes(3).toString('hex');

/* ── the stand-in CLI: a long-lived session process that runs probe steps ────── */
const FAKE = path.join(RUN, 'fake-claude.mjs');
fs.writeFileSync(FAKE, `
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
let started = false, inbox = null;
async function step(s) {
  if (s.kind === 'cgroup') return { cgroup: fs.readFileSync('/proc/self/cgroup', 'utf8').trim() };
  if (s.kind === 'http') {
    try {
      const r = await fetch(s.url, { method: s.method, headers: s.body ? { 'content-type': 'application/json' } : undefined, body: s.body ? JSON.stringify(s.body) : undefined });
      let d = null; try { d = await r.json(); } catch {}
      return { status: r.status, d };
    } catch (e) { return { error: String(e && e.message) }; }
  }
  if (s.kind === 'editRegistry') {
    const reg = JSON.parse(fs.readFileSync(s.file, 'utf8'));
    const p = reg.projects.find((x) => x.id === s.projectId);
    p.settings = p.settings || {};
    if (s.copyFrom) p.settings.gitWrite = reg.projects.find((x) => x.id === s.copyFrom).settings.gitWrite;
    else if (s.merge) p.settings.gitWrite = { ...(p.settings.gitWrite || {}), ...s.merge };
    else p.settings.gitWrite = s.value;
    fs.writeFileSync(s.file, JSON.stringify(reg, null, 2) + '\\n');
    return { ok: true };
  }
  if (s.kind === 'git') {
    const r = spawnSync('git', s.args, { cwd: s.cwd, encoding: 'utf8', env: process.env });
    return { status: r.status, stderr: (r.stderr || '').slice(0, 600), pathHasShim: (process.env.PATH || '').split(':')[0] };
  }
  return { error: 'unknown step' };
}
rl.on('line', (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.type === 'control_request') { say({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }); return; }
  if (m.type !== 'user' || started) return;
  started = true;
  const text = typeof m.message?.content === 'string' ? m.message.content : (m.message?.content || []).map((c) => c.text || '').join('');
  const mm = /INBOX=(\\S+)/.exec(text); inbox = mm ? mm[1] : null;
  say({ type: 'system', subtype: 'init', session_id: 'fakesdk-' + process.pid, cwd: process.cwd(), model: 'haiku', tools: [], slash_commands: [] });
  say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [ { type: 'text', text: 'idle' } ] } });
  say({ type: 'result', subtype: 'success', total_cost_usd: 0 });
  // Poll the inbox: cmd-<n>.json → run its steps in order → res-<n>.json.
  let n = 0;
  const tick = async () => {
    const f = path.join(inbox, 'cmd-' + n + '.json');
    if (inbox && fs.existsSync(f)) {
      const steps = JSON.parse(fs.readFileSync(f, 'utf8'));
      const out = []; for (const s of steps) out.push(await step(s));
      fs.writeFileSync(path.join(inbox, 'res-' + n + '.json.tmp'), JSON.stringify(out));
      fs.renameSync(path.join(inbox, 'res-' + n + '.json.tmp'), path.join(inbox, 'res-' + n + '.json'));
      n++;
    }
    setTimeout(tick, 100);
  };
  tick();
});
process.stdin.resume();
`);

async function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
}
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

/* ── processes this suite owns (killed by pid only) ─────────────────────────── */
let server = null;
const liveWs = [];
async function boot(extraEnv = {}) {
  const env = isolatedServerEnv({ PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE, CLAUDE_STATION_CLAUDE_BIN: FAKE, CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0', ...extraEnv });
  // Own scope, like the live service has its own unit: the server's cgroup is
  // neither the suite's nor any session's. systemd-run --scope execs in place, so
  // the spawned pid IS the server.
  server = spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', `--unit=orchard-f164sg-srv-${tag}-${Date.now().toString(36)}`, process.execPath, 'src/server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
  server.logText = () => log;
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(`${BASE}/api/projects`); if (r.ok) return; } catch { /* booting */ }
    await sleep(150);
  }
  throw new Error(`scratch server did not come up:\n${log.slice(-2000)}`);
}
async function stop() {
  for (const ws of liveWs.splice(0)) { try { ws.close(); } catch { /* gone */ } }
  if (!server || server.exitCode !== null) return;
  const done = new Promise((r) => server.once('exit', r));
  try { process.kill(server.pid, 'SIGTERM'); } catch { /* gone */ }
  await Promise.race([done, sleep(6000)]);
  try { process.kill(server.pid, 'SIGKILL'); } catch { /* gone */ }
}

const j = async (m, u, body) => {
  const r = await fetch(BASE + u, { method: m, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  let d; try { d = await r.json(); } catch { d = null; }
  return { status: r.status, d };
};

/** Run a node snippet as the USER: in a transient scope outside every agent cgroup. */
function asUser(code) {
  const r = spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', `--unit=orchard-f164sg-user-${tag}-${randomBytes(3).toString('hex')}`, process.execPath, '--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env }, timeout: 30_000 });
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { error: `asUser: ${r.status} ${r.stderr?.slice(0, 300)}` }; }
}
const userHttp = (method, url, body) => asUser(`
const r = await fetch(${JSON.stringify(BASE + url)}, { method: ${JSON.stringify(method)}, headers: { 'content-type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} });
let d = null; try { d = await r.json(); } catch {}
console.log(JSON.stringify({ status: r.status, d }));`);
const userCgroup = () => asUser(`import * as fs from 'node:fs'; console.log(JSON.stringify({ cgroup: fs.readFileSync('/proc/self/cgroup','utf8').trim() }));`);

/** An agent-shaped caller that is NOT a session: the CLI run from an agent's Bash
 * lands in that agent's claude-station-host-*.scope. Model it with such a scope. */
function cliInAgentScope(args) {
  const r = spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', `--unit=claude-station-host-t-f164cli-${tag}-${randomBytes(3).toString('hex')}`, process.execPath, path.join(ROOT, 'scripts', 'git-grant.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, PORT: String(PORT) }, timeout: 30_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}`.slice(0, 400) };
}

/* ── a live session = the agent ─────────────────────────────────────────────── */
async function startAgent(projectId) {
  const inbox = fs.mkdtempSync(path.join(RUN, 'inbox-')); // inside RUN: removed in finally
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`); const events = [];
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
  ws.on('error', () => {});
  liveWs.push(ws);
  const sendStart = () => ws.send(JSON.stringify({ type: 'start', projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' }, prompt: `INBOX=${inbox}` }));
  // A fresh server refuses new host sessions until its runtime check completes
  // (BUG-190, code runtime-check-pending, transient): retry on that code only.
  for (let t = 0; t < 40; t++) {
    const seen = events.length;
    sendStart();
    let pending = false;
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      if (events.slice(seen).some((e) => e.code === 'runtime-check-pending')) { pending = true; break; }
      if (events.slice(seen).some((e) => e.t === 'agent-started' || (e.t === 'ack' && e.of === 'start') || e.t === 'session')) break;
    }
    if (!pending) break;
    await sleep(1500);
  }
  let n = 0;
  const run = async (steps) => {
    const k = n++;
    fs.writeFileSync(path.join(inbox, `cmd-${k}.json`), JSON.stringify(steps));
    const f = path.join(inbox, `res-${k}.json`);
    for (let i = 0; i < 300; i++) { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); await sleep(100); }
    throw new Error(`agent did not answer probe ${k}`);
  };
  // Wait until the session process is up and answering.
  for (let i = 0; i < 300; i++) { if (fs.existsSync(path.join(inbox, 'res-0.json'))) break; if (i === 0) fs.writeFileSync(path.join(inbox, 'cmd-0.json'), JSON.stringify([{ kind: 'cgroup' }])); await sleep(100); }
  if (!fs.existsSync(path.join(inbox, 'res-0.json'))) throw new Error(`agent session never came up: ${JSON.stringify(events.slice(-6)).slice(0, 1500)}`);
  const first = JSON.parse(fs.readFileSync(path.join(inbox, 'res-0.json'), 'utf8'));
  n = 1;
  let sid = null;
  for (let i = 0; i < 100 && !sid; i++) {
    const h = await (await fetch(`${BASE}/api/health`)).json().catch(() => ({ sessions: [] }));
    const s = (h.sessions ?? []).find((x) => x.projectId === projectId && (x.stationSessionId || x.sdkSessionId));
    if (s) sid = s.stationSessionId || s.sdkSessionId; else await sleep(200);
  }
  return { run, cgroup: first[0].cgroup, sid, inbox };
}
const grantUrl = (pid) => `${BASE}/api/projects/${encodeURIComponent(pid)}/git-write-grant`;
const grantOf = async (pid) => (await j('GET', `/api/projects/${encodeURIComponent(pid)}/git-write-grant`)).d?.grant ?? null;
const regRow = (pid) => JSON.parse(fs.readFileSync(REGISTRY, 'utf8')).projects.find((p) => p.id === pid);
const isRefusal = (r) => /orchard|refus|blocked|not permitted|git write/i.test(r.stderr) && !/not a git repository/i.test(r.stderr);
const isAllowedThrough = (r) => /not a git repository/i.test(r.stderr);

try {
  await boot();
  const cA = await j('POST', '/api/projects', { hostPath: PA, name: 'f164sg-a', isolation: 'direct', applyMethod: false });
  const cB = await j('POST', '/api/projects', { hostPath: PB, name: 'f164sg-b', isolation: 'direct', applyMethod: false });
  const A = cA.d?.project?.id, B = cB.d?.project?.id;
  check('S0 two scratch projects registered', !!A && !!B, { a: cA.status, b: cB.status });

  const agent = await startAgent(A);
  check('S1 the agent is a real Orchard-launched session process in a claude-station-host-t-*.scope', /claude-station-host-t-[^/]*\.scope/.test(agent.cgroup), agent.cgroup);
  check('S2 the agent session has a session id (for its git-write request)', !!agent.sid);
  const uc = userCgroup();
  check('S3 the user caller sits outside every agent cgroup', !!uc.cgroup && !/claude-station/.test(uc.cgroup), uc);

  /* ═══ H2 — the agent calls the grant route itself ═══════════════════════════ */
  console.log('\n[H2] agent POSTs the grant route');
  for (const body of [{ scope: 'once' }, { scope: 'duration', minutes: 30 }, { scope: 'permanent' }]) {
    const [r] = await agent.run([{ kind: 'http', method: 'POST', url: grantUrl(A), body }]);
    const g = await grantOf(A);
    check(`H2 agent POST scope=${body.scope} is refused (4xx) and grants nothing`, r.status >= 400 && r.status < 500 && g === null, { status: r.status, grant: g?.scope ?? null }, HOLE);
    if (body.scope === 'permanent') check('H2b no permanent grant reached the registry from an agent POST', !regRow(A)?.settings?.gitWrite?.permanent, regRow(A)?.settings?.gitWrite, HOLE);
    if (g) userHttp('DELETE', `/api/projects/${A}/git-write-grant`);
  }
  const cli = cliInAgentScope([A, '--permanent']);
  const gCli = await grantOf(A);
  check('H2c the grant CLI run from an agent cgroup is refused and grants nothing', cli.status !== 0 && gCli === null, { status: cli.status, grant: gCli?.scope ?? null, out: cli.out }, HOLE);
  if (gCli) userHttp('DELETE', `/api/projects/${A}/git-write-grant`);

  /* ═══ H3 — the agent raises a request and approves it itself ═══════════════ */
  console.log('\n[H3] agent raises a git-write request and answers it "Allow"');
  const [rq] = await agent.run([{ kind: 'http', method: 'POST', url: `${BASE}/api/sessions/${agent.sid}/git-write-request`, body: { reason: 'self-approve probe', scope: 'duration', minutes: 30 } }]);
  check('H3a the agent may RAISE a request (201, inert)', rq.status === 201 && rq.d?.granted === false, rq);
  const [ans] = await agent.run([{ kind: 'http', method: 'POST', url: `${BASE}/api/projects/${encodeURIComponent(A)}/board/answer`, body: { id: rq.d?.id, answer: 'Allow' } }]);
  const gAns = await grantOf(A);
  check('H3b the agent\'s own "Allow" is refused (4xx) and mints no grant', ans.status >= 400 && ans.status < 500 && gAns === null, { status: ans.status, grant: gAns?.scope ?? null }, HOLE);
  const feed = await j('GET', `/api/projects/${encodeURIComponent(A)}/board`);
  check('H3c the request is still pending on the rail for the user', (feed.d?.needsYou ?? []).some((x) => x.id === rq.d?.id), (feed.d?.needsYou ?? []).map((x) => x.id), HOLE);
  if (gAns) userHttp('DELETE', `/api/projects/${A}/git-write-grant`);

  /* ═══ USER — the user's grants still work, and take effect live ════════════ */
  console.log('\n[USER] the user grants; the running agent session honours it');
  const [gitBlocked] = await agent.run([{ kind: 'git', args: ['add', 'x'], cwd: PA }]);
  check('UA0 with no grant the agent\'s git write is refused by the shim', gitBlocked.status !== 0 && isRefusal(gitBlocked), gitBlocked);
  // A fresh request: the H3 one may already be resolved by the agent (while H3 is open).
  const [rq2] = await agent.run([{ kind: 'http', method: 'POST', url: `${BASE}/api/sessions/${agent.sid}/git-write-request`, body: { reason: 'user-approve probe', scope: 'duration', minutes: 30 } }]);
  const userAnswer = userHttp('POST', `/api/projects/${encodeURIComponent(A)}/board/answer`, { id: rq2.d?.id, answer: 'Allow' });
  const gUA = await grantOf(A);
  check('UA1 the USER approving the agent\'s request mints the grant', userAnswer.status === 200 && gUA?.scope === 'duration', { status: userAnswer.status, grant: gUA });
  const uDel = userHttp('DELETE', `/api/projects/${A}/git-write-grant`);
  check('UA2 the user can revoke', uDel.status === 200 && (await grantOf(A)) === null, uDel);
  const replay = userHttp('POST', `/api/projects/${encodeURIComponent(A)}/board/answer`, { id: rq2.d?.id, answer: 'Allow' });
  const gReplay = await grantOf(A);
  check('UA2b replaying an already-answered "Allow" is refused (409) and re-mints nothing', replay.status === 409 && gReplay === null, { status: replay.status, grant: gReplay?.scope ?? null });
  if (gReplay) userHttp('DELETE', `/api/projects/${A}/git-write-grant`);
  const u30 = userHttp('POST', `/api/projects/${A}/git-write-grant`, { scope: 'duration', minutes: 30 });
  check('UA3 the user\'s 30-minute grant is issued', u30.status === 200 && u30.d?.grant?.scope === 'duration', u30);
  const [agentRevoke] = await agent.run([{ kind: 'http', method: 'DELETE', url: grantUrl(A) }]);
  check('UA4 an agent MAY revoke (giving up access is never a self-grant)', agentRevoke.status === 200 && (await grantOf(A)) === null, agentRevoke);
  const uPerm = userHttp('POST', `/api/projects/${A}/git-write-grant`, { scope: 'permanent' });
  check('UA5 the user\'s permanent grant is issued', uPerm.status === 200 && uPerm.d?.grant?.scope === 'permanent', uPerm);
  const [gitAllowed] = await agent.run([{ kind: 'git', args: ['add', 'x'], cwd: PA }]);
  check('UA6 the running agent session\'s git write now passes the shim (git itself then fails: not a repo)', isAllowedThrough(gitAllowed), gitAllowed);

  /* ═══ H1 — the agent edits the registry file ════════════════════════════════ */
  console.log('\n[H1] agent edits the registry file');
  const [cp] = await agent.run([{ kind: 'editRegistry', file: REGISTRY, projectId: B, copyFrom: A }]);
  check('H1a setup: agent copied A\'s stored grant onto B', cp.ok === true && regRow(B)?.settings?.gitWrite?.permanent === true);
  check('H1a a user grant copied onto ANOTHER project grants nothing there', (await grantOf(B)) === null, await grantOf(B), HOLE);
  await agent.run([{ kind: 'editRegistry', file: REGISTRY, projectId: A, merge: { grantedAt: new Date(Date.now() - 1000).toISOString() } }]);
  check('H1b an agent-altered user grant stops granting (tamper reads as none)', (await grantOf(A)) === null, await grantOf(A), HOLE);
  userHttp('DELETE', `/api/projects/${A}/git-write-grant`);
  await agent.run([{ kind: 'editRegistry', file: REGISTRY, projectId: A, value: { permanent: true, grantedAt: new Date().toISOString(), grantedVia: 'dashboard' } }]);
  check('H1c setup: agent wrote settings.gitWrite = {permanent:true} into the registry', regRow(A)?.settings?.gitWrite?.permanent === true);
  const gForged = await grantOf(A);
  check('H1c the forged registry setting grants nothing (route view)', gForged === null, gForged, HOLE);
  const [gitForged] = await agent.run([{ kind: 'git', args: ['add', 'x'], cwd: PA }]);
  check('H1d the forged setting does not let the agent\'s git write through the shim', gitForged.status !== 0 && isRefusal(gitForged), gitForged, HOLE);
  userHttp('DELETE', `/api/projects/${A}/git-write-grant`);
  userHttp('DELETE', `/api/projects/${B}/git-write-grant`);

  /* ═══ restart — a USER permanent grant survives; the seal key is private ═══ */
  console.log('\n[R] restart');
  const uPerm2 = userHttp('POST', `/api/projects/${B}/git-write-grant`, { scope: 'permanent' });
  check('R0 user permanent grant on B', uPerm2.status === 200 && uPerm2.d?.grant?.scope === 'permanent', uPerm2);
  await stop(); await boot();
  check('R1 the user\'s permanent grant survives a server restart', (await grantOf(B))?.scope === 'permanent', await grantOf(B));
  // Torn registry while the server runs: never a grant, never a crash.
  const full = fs.readFileSync(REGISTRY, 'utf8');
  let tornOk = true; const tornDetail = [];
  for (const cut of [0.25, 0.5, 0.9]) {
    fs.writeFileSync(REGISTRY, full.slice(0, Math.floor(full.length * cut)));
    const r = await j('GET', `/api/projects/${encodeURIComponent(B)}/git-write-grant`);
    const granted = r.status === 200 && !!r.d?.grant;
    tornDetail.push({ cut, status: r.status, granted });
    if (granted) tornOk = false;
  }
  fs.writeFileSync(REGISTRY, full);
  check('R3 a torn registry (3 cut points) never reads as a grant', tornOk, tornDetail);
  check('R4 the server is still up after the torn reads', (await j('GET', '/api/projects')).status === 200);
  userHttp('DELETE', `/api/projects/${B}/git-write-grant`);
  await stop();

  /* ═══ IN-CGROUP — a session running in the server's own cgroup ═════════════ */
  console.log('\n[C] survival off: the agent shares the server\'s cgroup');
  await boot({ CLAUDE_STATION_SURVIVE: '0' });
  const agent2 = await startAgent(B);
  const [srvCg] = await agent2.run([{ kind: 'cgroup' }]);
  check('C0 setup: this agent is NOT in a session scope (it shares the server cgroup)', !/claude-station-host-/.test(srvCg.cgroup), srvCg.cgroup);
  const [r2] = await agent2.run([{ kind: 'http', method: 'POST', url: grantUrl(B), body: { scope: 'permanent' } }]);
  const g2 = await grantOf(B);
  check('C1 an in-cgroup agent POSTing the grant route is refused and grants nothing', r2.status >= 400 && r2.status < 500 && g2 === null, { status: r2.status, grant: g2?.scope ?? null }, HOLE);
} catch (e) {
  check(`suite threw: ${e.stack?.split('\n').slice(0, 3).join(' | ')}`, false, server?.logText?.().slice(-1500));
} finally {
  await stop();
  await reapOwnHosts();
  fs.rmSync(RUN, { recursive: true, force: true });
}

/**
 * The first boot runs with survival ON, so each agent session's broker + CLI live in
 * their own claude-station-host-t-*.scope and deliberately OUTLIVE the server (that is
 * what R1 relies on) — stopping the server never ends them. Before this, every run
 * leaked one such scope (FEAT-164 r3 disclosure). End ONLY the hosts this run started:
 * the ones recorded in this run's own data dir, each pid checked to still sit in that
 * host's exact scope cgroup (never a glob, never a reused pid), then prove none is left.
 */
async function reapOwnHosts() {
  const dir = path.join(DATA, 'session-hosts');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.ctl.json')); } catch { /* no hosts started */ }
  const hosts = [];
  for (const f of names) {
    const key = f.slice(0, -'.json'.length);
    if (!key.startsWith('t-')) continue; // an isolated server only ever makes t- hosts
    let st = null;
    try { st = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { /* torn */ }
    const unit = `claude-station-host-${key}.scope`;
    const pids = [st?.hostPid, st?.claudePid].filter((p) => Number.isInteger(p) && p > 1);
    hosts.push({ unit, pids });
  }
  const inUnit = (pid, unit) => { try { return fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').includes(`/${unit}`); } catch { return false; } };
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    for (const h of hosts) for (const pid of h.pids) if (inUnit(pid, h.unit)) { try { process.kill(pid, sig); } catch { /* gone */ } }
    for (let i = 0; i < 30 && hosts.some((h) => h.pids.some((p) => inUnit(p, h.unit))); i++) await sleep(100);
  }
  const left = hosts.filter((h) => {
    const r = spawnSync('systemctl', ['--user', 'list-units', '--all', '--no-legend', h.unit], { encoding: 'utf8' });
    return (r.stdout || '').includes(h.unit);
  }).map((h) => h.unit);
  check('CLEANUP every session-host scope this run started is gone (none left running)', hosts.length > 0 && left.length === 0, { started: hosts.map((h) => h.unit), left });
}

console.log(`\nFEAT-164 self-grant: ${pass} passed, ${fail} failed, ${holesOpen} self-grant holes OPEN`);
if (holesOpen) console.log('  OPEN = an agent can still grant itself this way; closure awaits the FEAT-164 fork decision.');
process.exit(fail ? 1 : holesOpen ? 2 : 0);
