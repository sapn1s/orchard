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
 * STATUS (option A built, user decision 2026-10-12): H1/H2/H3 and the in-cgroup case
 * are now hard invariants (FAIL, exit 1). They were reported as OPEN (exit 2) until the
 * fork was decided; on the pre-option-A tree all 11 reproduce (must-FAIL baseline).
 * Closed by: the caller check (src/server/caller-provenance.ts requireUserCaller) on the
 * grant POST, the policy PUT and a git-write request answer; and the sealed standing
 * grant (scripts/lib/git-write-seal.mjs) verified on every registry load.
 * Residuals by design (decision card): a same-uid agent that deliberately escapes its
 * scope, reads the seal key, or replays an old sealed value. Every other check is an
 * invariant too: the user's grants, the request flow, the answer-once rule, restart,
 * and a torn registry.
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
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  PASS ${name}`); return; }
  fail++;
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 400)}`}`);
}

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
    else if (s.rowSet) Object.assign(p, s.rowSet);
    else p.settings.gitWrite = s.value;
    fs.writeFileSync(s.file, JSON.stringify(reg, null, 2) + '\\n');
    return { ok: true };
  }
  if (s.kind === 'exec') {
    const r = spawnSync(process.execPath, s.args, { encoding: 'utf8', env: { ...process.env, ...(s.env || {}) }, timeout: 30000 });
    return { status: r.status, out: ((r.stdout || '') + (r.stderr || '')).slice(0, 600) };
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
// FEAT-190 r3 — the git-write-policy PUT is optimistic-concurrency gated: it must carry the
// `revision` it was rendered from, or the route refuses it (400 revision-required). The GET of
// the grant route returns the current revision (verify-feat-190-ui covers the 400/409 contract
// directly). A USER save threads that revision; this helper GETs it first, then PUTs as the user.
const userPutPolicy = async (pid, body) => {
  const revision = (await j('GET', `/api/projects/${encodeURIComponent(pid)}/git-write-grant`)).d?.revision ?? null;
  return userHttp('PUT', `/api/projects/${encodeURIComponent(pid)}/git-write-policy`, { ...body, revision });
};

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
    check(`H2 agent POST scope=${body.scope} is refused (4xx) and grants nothing`, r.status >= 400 && r.status < 500 && g === null, { status: r.status, grant: g?.scope ?? null });
    if (body.scope === 'permanent') check('H2b no permanent grant reached the registry from an agent POST', !regRow(A)?.settings?.gitWrite?.permanent, regRow(A)?.settings?.gitWrite);
    if (g) userHttp('DELETE', `/api/projects/${A}/git-write-grant`);
  }
  // The grant CLI run from the agent's own Bash: a child of the real session process, in
  // its claude-station-host-t-*.scope (a stand-alone look-alike scope would be a caller
  // the server never launched, which is the deliberate-escape residual, not this path).
  const [cli] = await agent.run([{ kind: 'exec', args: [path.join(ROOT, 'scripts', 'git-grant.mjs'), A, '--permanent'], env: { PORT: String(PORT) } }]);
  const gCli = await grantOf(A);
  check('H2c the grant CLI run from an agent cgroup is refused and grants nothing', cli.status !== 0 && gCli === null, { status: cli.status, grant: gCli?.scope ?? null, out: cli.out });
  if (gCli) userHttp('DELETE', `/api/projects/${A}/git-write-grant`);
  const [pol] = await agent.run([{ kind: 'http', method: 'PUT', url: `${BASE}/api/projects/${encodeURIComponent(A)}/git-write-policy`, body: { commit: true, push: true, scope: 'agent self-set scope' } }]);
  const polAfter = (await j('GET', `/api/projects/${encodeURIComponent(A)}/git-write-grant`)).d?.policy;
  check('H2d an agent PUT of the agent git policy is refused (4xx) and changes nothing', pol.status >= 400 && pol.status < 500 && polAfter?.mode === 'none' && !regRow(A)?.settings?.gitWrite?.commit, { status: pol.status, mode: polAfter?.mode });

  /* ═══ H3 — the agent raises a request and approves it itself ═══════════════ */
  console.log('\n[H3] agent raises a git-write request and answers it "Allow"');
  const [rq] = await agent.run([{ kind: 'http', method: 'POST', url: `${BASE}/api/sessions/${agent.sid}/git-write-request`, body: { reason: 'self-approve probe', scope: 'duration', minutes: 30 } }]);
  check('H3a the agent may RAISE a request (201, inert)', rq.status === 201 && rq.d?.granted === false, rq);
  const [ans] = await agent.run([{ kind: 'http', method: 'POST', url: `${BASE}/api/projects/${encodeURIComponent(A)}/board/answer`, body: { id: rq.d?.id, answer: 'Allow' } }]);
  const gAns = await grantOf(A);
  check('H3b the agent\'s own "Allow" is refused (4xx) and mints no grant', ans.status >= 400 && ans.status < 500 && gAns === null, { status: ans.status, grant: gAns?.scope ?? null });
  const feed = await j('GET', `/api/projects/${encodeURIComponent(A)}/board`);
  check('H3c the request is still pending on the rail for the user', (feed.d?.needsYou ?? []).some((x) => x.id === rq.d?.id), (feed.d?.needsYou ?? []).map((x) => x.id));
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
  // UA5b REWRITTEN to the FEAT-190 r13 rule (superseding the FEAT-164 r2/r3 behaviour it asserted).
  // Under FEAT-164 a scope-less permanent grant was RELEASE mode and a direct write to the project's
  // OWN repo — including its scratch fixture repo — was refused, naming "release mode". FEAT-190 r13
  // made scratch/fixture repos STORE-GOVERNED: a repo under the scratch root is no longer judged by
  // the real-repo policy (release mode is a REAL-repo guard only; decideByTarget sets `scratch` from
  // defaultFixtureRoots() and effectiveGitPermission then allows with reason 'scratch'), so the shim
  // lets the write THROUGH and the FEAT-108 store decides. PA is a scratch dir, so a release-mode
  // write there is allowed through exactly like the scoped case below (UA6). The REAL-repo release
  // refusal that UA5b used to prove is covered on resolvable repos by verify-feat-190-matrix (the
  // "an EXPLICITLY release-mode sharer/co-owner still vetoes" cases) and verify-feat-164-release (X7).
  const [gitRelease] = await agent.run([{ kind: 'git', args: ['add', 'x'], cwd: PA }]);
  check('UA5b release mode on a SCRATCH repo is store-governed — the write passes the shim (FEAT-190 r13; real-repo release refusal covered by verify-feat-190-matrix)', isAllowedThrough(gitRelease), gitRelease);
  const uScoped = await userPutPolicy(A, { commit: true, push: false, scope: 'FEAT-164 self-grant probe: scratch dir only' });
  check('UA5c the user sets SCOPED mode (commit + a scope note)', uScoped.status === 200 && uScoped.d?.policy?.mode === 'scoped', uScoped);
  const [gitAllowed] = await agent.run([{ kind: 'git', args: ['add', 'x'], cwd: PA }]);
  check('UA6 the running agent session\'s git write now passes the shim (git itself then fails: not a repo)', isAllowedThrough(gitAllowed), gitAllowed);

  /* ═══ B — grant binding: a grant is FOR the repo identity it was given for ═══ */
  console.log('\n[B] grant binding (coordinator ruling after verify f8f4bf80)');
  const PC = path.join(RUN, 'proj-c'); fs.mkdirSync(PC, { recursive: true });
  userHttp('DELETE', `/api/projects/${A}/git-write-grant`);
  const uT = userHttp('POST', `/api/projects/${A}/git-write-grant`, { scope: 'duration', minutes: 30 });
  check('B0 setup: the user\'s 30-minute grant on A records the repo it is for', uT.status === 200 && !!uT.d?.grant?.repo?.toplevel, uT.d?.grant);
  const [wT] = await agent.run([{ kind: 'git', args: ['add', 'x'], cwd: PA }]);
  check('B0 normal granted work is unaffected: under the timed grant the agent\'s write in A passes the shim', isAllowedThrough(wT), wT);
  const [pp] = await agent.run([{ kind: 'http', method: 'PATCH', url: `${BASE}/api/projects/${encodeURIComponent(A)}`, body: { hostPath: PC } }]);
  check('B1 an agent PATCH of the project path is refused (403) and the path is unchanged', pp.status === 403 && pp.d?.code === 'agent-self-grant' && regRow(A)?.hostPath === PA, { status: pp.status, hostPath: regRow(A)?.hostPath });
  await agent.run([{ kind: 'editRegistry', file: REGISTRY, projectId: A, rowSet: { hostPath: PC } }]);
  const [w2] = await agent.run([{ kind: 'git', args: ['add', 'x'], cwd: PC }]);
  const g2b = await grantOf(A);
  check('B2 a registry-file path edit leaves the live grant inert for the new path (write refused, grant voided)', w2.status !== 0 && isRefusal(w2) && g2b === null, { w2, grant: g2b?.scope ?? null });
  await agent.run([{ kind: 'editRegistry', file: REGISTRY, projectId: A, rowSet: { hostPath: PA } }]);
  check('B2b moving the path back does not revive it (the voided grant stays gone)', (await grantOf(A)) === null, await grantOf(A));
  userHttp('POST', `/api/projects/${A}/git-write-grant`, { scope: 'duration', minutes: 30 });
  await userPutPolicy(A, { commit: true, push: false, scope: 'FEAT-164 binding probe: scratch dir only' });
  const uMove = userHttp('PATCH', `/api/projects/${encodeURIComponent(A)}`, { hostPath: PC });
  const polMoved = (await j('GET', `/api/projects/${encodeURIComponent(A)}/git-write-grant`)).d;
  check('B3 a USER path change is allowed and voids both the timed and the standing grant', uMove.status === 200 && polMoved?.grant === null && polMoved?.policy?.mode === 'none', { status: uMove.status, grant: polMoved?.grant?.scope ?? null, mode: polMoved?.policy?.mode });
  const [w3] = await agent.run([{ kind: 'git', args: ['add', 'x'], cwd: PC }]);
  check('B3b after the move, the agent\'s write in the new repo is refused until the user re-grants', w3.status !== 0 && isRefusal(w3), w3);
  const reG = userHttp('POST', `/api/projects/${A}/git-write-grant`, { scope: 'duration', minutes: 30 });
  const [w4] = await agent.run([{ kind: 'git', args: ['add', 'x'], cwd: PC }]);
  check('B3c a re-grant binds the new repo and the agent\'s write there passes', reG.status === 200 && isAllowedThrough(w4), { reG: reG.status, w4 });
  // restore A for the H1 checks: back at PA with the user's scoped grant
  userHttp('PATCH', `/api/projects/${encodeURIComponent(A)}`, { hostPath: PA });
  userHttp('DELETE', `/api/projects/${A}/git-write-grant`);
  await userPutPolicy(A, { commit: true, push: false, scope: 'FEAT-164 self-grant probe: scratch dir only' });

  /* ═══ G — the user's git panel routes run git in the server, outside the shim ═══ */
  console.log('\n[G] agent calls the git panel (server-side git, no shim, no grant)');
  for (const action of ['stage', 'commit', 'push']) {
    const [g] = await agent.run([{ kind: 'http', method: 'POST', url: `${BASE}/api/projects/${encodeURIComponent(A)}/git/${action}`, body: { paths: ['x'], message: 'agent probe' } }]);
    check(`G1 an agent POST git/${action} is refused as user-only (403)`, g.status === 403 && g.d?.code === 'agent-self-grant', g);
  }
  const uStage = userHttp('POST', `/api/projects/${encodeURIComponent(A)}/git/stage`, { paths: ['x'] });
  check('G2 the USER\'s git panel action is not refused by the caller check (git itself may fail: not a repo)', uStage.status !== 403 && uStage.d?.code !== 'agent-self-grant' && uStage.d?.code !== 'caller-unknown', uStage);
  const [gd] = await agent.run([{ kind: 'http', method: 'POST', url: `${BASE}/api/projects/${encodeURIComponent(A)}/git/diff`, body: { path: 'x' } }]);
  check('G3 git/diff (a read) is not gated', gd.status !== 403, gd);

  /* ═══ H1 — the agent edits the registry file ════════════════════════════════ */
  console.log('\n[H1] agent edits the registry file');
  const pAPath = regRow(A)?.hostPath;
  check('H1e setup: A holds the user\'s scoped grant', (await grantOf(A))?.scope === 'permanent', await grantOf(A));
  await agent.run([{ kind: 'editRegistry', file: REGISTRY, projectId: A, rowSet: { hostPath: PB } }]);
  check('H1e repointing a granted project\'s hostPath at another dir voids the grant (seal binds id + hostPath)', (await grantOf(A)) === null, await grantOf(A));
  await agent.run([{ kind: 'editRegistry', file: REGISTRY, projectId: A, rowSet: { hostPath: pAPath } }]);
  const [cp] = await agent.run([{ kind: 'editRegistry', file: REGISTRY, projectId: B, copyFrom: A }]);
  // The stored shape is { commit, push, scope, grantedAt, grantedVia, seal } since the rescope
  // (permanent:true is the r1 legacy shape, never written any more).
  check('H1a setup: agent copied A\'s stored grant onto B', cp.ok === true && regRow(B)?.settings?.gitWrite?.commit === true, regRow(B)?.settings?.gitWrite);
  check('H1a a user grant copied onto ANOTHER project grants nothing there', (await grantOf(B)) === null, await grantOf(B));
  await agent.run([{ kind: 'editRegistry', file: REGISTRY, projectId: A, merge: { grantedAt: new Date(Date.now() - 1000).toISOString() } }]);
  check('H1b an agent-altered user grant stops granting (tamper reads as none)', (await grantOf(A)) === null, await grantOf(A));
  userHttp('DELETE', `/api/projects/${A}/git-write-grant`);
  await agent.run([{ kind: 'editRegistry', file: REGISTRY, projectId: A, value: { permanent: true, grantedAt: new Date().toISOString(), grantedVia: 'dashboard' } }]);
  check('H1c setup: agent wrote settings.gitWrite = {permanent:true} into the registry', regRow(A)?.settings?.gitWrite?.permanent === true);
  const gForged = await grantOf(A);
  check('H1c the forged registry setting grants nothing (route view)', gForged === null, gForged);
  const [gitForged] = await agent.run([{ kind: 'git', args: ['add', 'x'], cwd: PA }]);
  check('H1d the forged setting does not let the agent\'s git write through the shim', gitForged.status !== 0 && isRefusal(gitForged), gitForged);
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
  check('C1 an in-cgroup agent POSTing the grant route is refused and grants nothing', r2.status >= 400 && r2.status < 500 && g2 === null, { status: r2.status, grant: g2?.scope ?? null });
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

/* ═══ SEAL — the one writer's seal, the migration, and the release CLI's reader (pure) ═══ */
console.log('\n[M] seal: migration at key creation, project binding, the out-of-server reader');
{
  const seal = await import('./lib/git-write-seal.mjs');
  const { resolveTarget } = await import('./lib/release.mjs');
  const D = mkdtempScratch('f164seal-');
  try {
    const legacy = { permanent: true, grantedAt: '2026-10-01T00:00:00.000Z', grantedVia: 'dashboard' };
    const scoped = { commit: true, push: true, scope: 'pre-upgrade scoped grant', grantedAt: '2026-10-11T00:00:00.000Z', grantedVia: 'dashboard' };
    const projects = [{ id: 'm-legacy', hostPath: D, settings: { gitWrite: { ...legacy } } }, { id: 'm-scoped', hostPath: path.join(D, 'nope'), settings: { gitWrite: { ...scoped } } }, { id: 'm-none', settings: {} }];
    const migrated = seal.sealLegacyOnKeyCreation(D, projects);
    const [pL, pS] = projects;
    check('M1 first key creation seals the grants that existed before the upgrade (they keep working)', migrated.join() === 'm-legacy,m-scoped' && !!seal.verifiedGitWrite(D, pL, pL.settings.gitWrite) && !!seal.verifiedGitWrite(D, pS, pS.settings.gitWrite), migrated);
    check('M1b the key file is private (0600)', (fs.statSync(seal.sealKeyPath(D)).mode & 0o777) === 0o600);
    const later = [{ id: 'm-forged', settings: { gitWrite: { ...scoped } } }];
    check('M2 once the key exists, migration never runs again (a value planted later stays unsealed)', seal.sealLegacyOnKeyCreation(D, later).length === 0 && seal.verifiedGitWrite(D, later[0], later[0].settings.gitWrite) === null);
    check('M3 a sealed value copied onto another project does not verify there', seal.verifiedGitWrite(D, { id: 'm-other', hostPath: pS.hostPath }, pS.settings.gitWrite) === null);
    check('M3b the same project with its hostPath repointed does not verify (the seal binds the repo)', seal.verifiedGitWrite(D, { id: 'm-scoped', hostPath: D }, pS.settings.gitWrite) === null);
    check('M4 a sealed value with one field changed does not verify', seal.verifiedGitWrite(D, pS, { ...pS.settings.gitWrite, push: false }) === null && seal.verifiedGitWrite(D, pS, { ...pS.settings.gitWrite, scope: 'x' }) === null);
    check('M5 a junk / wrong-length seal does not verify', seal.verifiedGitWrite(D, pS, { ...scoped, seal: 'zz' }) === null && seal.verifiedGitWrite(D, pS, { ...scoped, seal: '0'.repeat(64) }) === null);
    // The release CLI reads registry.json itself (a separate process): it must apply the same check.
    fs.writeFileSync(path.join(D, 'registry.json'), JSON.stringify({ projects: [{ id: 'm-legacy', name: 'm-legacy', hostPath: D, settings: { gitWrite: projects[0].settings.gitWrite } }] }));
    const ok = resolveTarget('m-legacy', { env: { CLAUDE_STATION_DATA: D } });
    fs.writeFileSync(path.join(D, 'registry.json'), JSON.stringify({ projects: [{ id: 'm-legacy', name: 'm-legacy', hostPath: D, settings: { gitWrite: legacy } }] }));
    const forged = resolveTarget('m-legacy', { env: { CLAUDE_STATION_DATA: D } });
    check('M6 release.mjs honours a sealed grant and treats an unsealed one as none', ok.policy.mode !== 'none' && forged.policy.mode === 'none', { sealed: ok.policy.mode, unsealed: forged.policy.mode });
    // Symlink swap: the path STRING is unchanged, but it now resolves to another repo.
    const { repoIdentityOf, bindingHolds, grantBindingOf } = await import('./lib/repo-identity.mjs');
    const X1 = path.join(D, 'x1'), X2 = path.join(D, 'x2'), LNK = path.join(D, 'lnk');
    fs.mkdirSync(X1); fs.mkdirSync(X2); fs.symlinkSync(X1, LNK);
    const boundL = repoIdentityOf(LNK);
    const heldBefore = bindingHolds(boundL, LNK);
    fs.rmSync(LNK); fs.symlinkSync(X2, LNK);
    check('M8 a symlink swap under an unchanged path voids the binding (identity is the resolved repo)', heldBefore && !bindingHolds(boundL, LNK) && !bindingHolds(null, X1) && repoIdentityOf(path.join(D, 'missing')) === null, { boundL });
    check('M9 migration binds each pre-existing grant to its current repo', JSON.stringify(pL.settings.gitWrite.repo) === JSON.stringify(grantBindingOf(D)), pL.settings.gitWrite.repo);
    fs.rmSync(seal.sealKeyPath(D));
    check('M7 no key = no grant (fail closed), the reader never creates one', seal.verifiedGitWrite(D, pL, pL.settings.gitWrite) === null && !fs.existsSync(seal.sealKeyPath(D)));
  } catch (e) {
    check(`[M] threw: ${e.stack?.split('\n').slice(0, 3).join(' | ')}`, false);
  } finally { fs.rmSync(D, { recursive: true, force: true }); }
}

console.log(`\nFEAT-164 self-grant: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
