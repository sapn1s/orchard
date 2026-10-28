#!/usr/bin/env node
/**
 * FEAT-196 — the REMOTE git-write grant, end-to-end against a REAL scratch server with a REAL
 * Orchard-launched agent session (in its claude-station-host-t-*.scope) and a REAL user caller
 * (a transient user scope, where the browser/terminal live) — the exact harness shape as
 * verify-feat-164-self-grant.mjs.
 *
 * The live phone transport (`tailscale serve` → root tailscaled → loopback, peer uid 0) cannot
 * be spawned by a uid-1000 test, so the root-proxy HAPPY path is proven in the unit suite
 * (verify-feat-196-pairing-store.mjs) through the real gate via the peer-uid seam. What THIS
 * suite proves against the running server, with no stubs:
 *   B1  a REAL agent presenting a VALID pairing token over DIRECT loopback is REFUSED (its peer
 *       socket is the server's own uid, never the root proxy) — a leaked token is inert off the
 *       proxy, and the git-grant route's allowPaired opt-in did NOT open an agent path;
 *   B2  an agent with a forged/garbage token is refused;
 *   B3  an agent cannot ENROL a pairing (POST /api/pairings is localhost-user only);
 *   B4  the LOCALHOST user still grants normally (desktop path unchanged);
 *   B5  the user enrols a pairing, gets a token once, and the on-disk store holds only a sealed
 *       sha256 — never the token;
 *   B6  an agent that reads every byte of the pairing store cannot obtain a working credential.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as http from 'node:http';
import * as os from 'node:os';
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
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 400)}`}`); }
};

if (spawnSync('systemd-run', ['--version']).status !== 0) {
  console.log('FAIL systemd-run is required (agent sessions are cgroup-scoped by it)');
  process.exit(1);
}

const RUN = mkdtempScratch('f196-');
const DATA = path.join(RUN, 'data');
const STORE = path.join(RUN, 'store');
const PA = path.join(RUN, 'proj-a');
for (const d of [DATA, STORE, PA]) fs.mkdirSync(d, { recursive: true });
const tag = randomBytes(3).toString('hex');
const PAIR_STORE = path.join(DATA, 'device-pairings.json');

/* ── stand-in CLI: a session process that runs probe steps (http supports headers) ── */
const FAKE = path.join(RUN, 'fake-claude.mjs');
fs.writeFileSync(FAKE, `
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
let started = false, inbox = null;
async function step(s) {
  if (s.kind === 'cgroup') return { cgroup: fs.readFileSync('/proc/self/cgroup', 'utf8').trim() };
  if (s.kind === 'http') {
    try {
      const headers = { ...(s.body ? { 'content-type': 'application/json' } : {}), ...(s.headers || {}) };
      const r = await fetch(s.url, { method: s.method, headers, body: s.body ? JSON.stringify(s.body) : undefined });
      let d = null; try { d = await r.json(); } catch {}
      return { status: r.status, d };
    } catch (e) { return { error: String(e && e.message) }; }
  }
  if (s.kind === 'readFile') { try { return { ok: true, data: fs.readFileSync(s.file, 'utf8') }; } catch (e) { return { error: String(e && e.message) }; } }
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

let server = null;
const liveWs = [];
async function boot() {
  const env = isolatedServerEnv({ PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE, CLAUDE_STATION_CLAUDE_BIN: FAKE, CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0' });
  server = spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', `--unit=orchard-f196-srv-${tag}-${Date.now().toString(36)}`, process.execPath, 'src/server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
  server.logText = () => log;
  for (let i = 0; i < 200; i++) { try { const r = await fetch(`${BASE}/api/projects`); if (r.ok) return; } catch { /* booting */ } await sleep(150); }
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

/** Run a node snippet as the USER: a transient scope outside every agent cgroup. */
function asUser(code) {
  const r = spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', `--unit=orchard-f196-user-${tag}-${randomBytes(3).toString('hex')}`, process.execPath, '--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env }, timeout: 30_000 });
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { error: `asUser: ${r.status} ${r.stderr?.slice(0, 300)}` }; }
}
const userHttp = (method, url, body) => asUser(`
const r = await fetch(${JSON.stringify(BASE + url)}, { method: ${JSON.stringify(method)}, headers: { 'content-type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} });
let d = null; try { d = await r.json(); } catch {}
console.log(JSON.stringify({ status: r.status, d }));`);

async function startAgent(projectId) {
  const inbox = fs.mkdtempSync(path.join(RUN, 'inbox-'));
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`); const events = [];
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
  ws.on('error', () => {});
  liveWs.push(ws);
  const sendStart = () => ws.send(JSON.stringify({ type: 'start', projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' }, prompt: `INBOX=${inbox}` }));
  for (let t = 0; t < 40; t++) {
    const seen = events.length; sendStart(); let pending = false;
    for (let i = 0; i < 30; i++) { await sleep(100); if (events.slice(seen).some((e) => e.code === 'runtime-check-pending')) { pending = true; break; } if (events.slice(seen).some((e) => e.t === 'agent-started' || (e.t === 'ack' && e.of === 'start') || e.t === 'session')) break; }
    if (!pending) break; await sleep(1500);
  }
  let n = 0;
  const run = async (steps) => {
    const k = n++; fs.writeFileSync(path.join(inbox, `cmd-${k}.json`), JSON.stringify(steps));
    const f = path.join(inbox, `res-${k}.json`);
    for (let i = 0; i < 300; i++) { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); await sleep(100); }
    throw new Error(`agent did not answer probe ${k}`);
  };
  for (let i = 0; i < 300; i++) { if (fs.existsSync(path.join(inbox, 'res-0.json'))) break; if (i === 0) fs.writeFileSync(path.join(inbox, 'cmd-0.json'), JSON.stringify([{ kind: 'cgroup' }])); await sleep(100); }
  if (!fs.existsSync(path.join(inbox, 'res-0.json'))) throw new Error(`agent session never came up: ${JSON.stringify(events.slice(-6)).slice(0, 1500)}`);
  const first = JSON.parse(fs.readFileSync(path.join(inbox, 'res-0.json'), 'utf8'));
  n = 1;
  return { run, cgroup: first[0].cgroup };
}

const grantUrl = (pid) => `${BASE}/api/projects/${encodeURIComponent(pid)}/git-write-grant`;
const grantOf = async (pid) => (await j('GET', `/api/projects/${encodeURIComponent(pid)}/git-write-grant`)).d?.grant ?? null;

try {
  await boot();
  const cA = await j('POST', '/api/projects', { hostPath: PA, name: 'f196-a', isolation: 'direct', applyMethod: false });
  const A = cA.d?.project?.id;
  check('S0 scratch project registered', !!A, cA.status);

  const agent = await startAgent(A);
  check('S1 the agent is a real Orchard session in a claude-station-host-t-*.scope', /claude-station-host-t-[^/]*\.scope/.test(agent.cgroup), agent.cgroup);

  /* B5 — the USER enrols a pairing (localhost); token returned once; store holds only a hash */
  const enroll = userHttp('POST', '/api/pairings', { label: 'my phone' });
  const token = enroll?.d?.token;
  check('B5 user (localhost) enrols a pairing and gets a 64-hex token once', enroll?.status === 200 && /^[0-9a-f]{64}$/.test(token || ''), enroll);
  const storeRaw = fs.existsSync(PAIR_STORE) ? fs.readFileSync(PAIR_STORE, 'utf8') : '';
  check('B5b the on-disk store never contains the raw token', !!storeRaw && !storeRaw.includes(token), 'token present in store');
  check('B5c the on-disk store contains a sealed record (tokenHash + seal)', /"tokenHash"/.test(storeRaw) && /"seal"/.test(storeRaw));

  /* B1 — a REAL agent presenting the VALID token over DIRECT loopback is refused */
  const [b1] = await agent.run([{ kind: 'http', method: 'POST', url: grantUrl(A), headers: { 'x-orchard-pairing': token }, body: { scope: 'permanent' } }]);
  const g1 = await grantOf(A);
  check('B1 agent + VALID token over direct loopback is REFUSED (leaked token inert off the proxy)', b1.status >= 400 && b1.status < 500 && g1 === null, { status: b1.status, grant: g1?.scope ?? null });

  /* B2 — agent with a forged/garbage token */
  const [b2] = await agent.run([{ kind: 'http', method: 'POST', url: grantUrl(A), headers: { 'x-orchard-pairing': 'c'.repeat(64) }, body: { scope: 'permanent' } }]);
  check('B2 agent + forged token is refused and grants nothing', b2.status >= 400 && b2.status < 500 && (await grantOf(A)) === null, { status: b2.status });

  /* B3 — agent cannot enrol a pairing */
  const [b3] = await agent.run([{ kind: 'http', method: 'POST', url: `${BASE}/api/pairings`, body: { label: 'agent self-enrol' } }]);
  check('B3 agent POST /api/pairings is refused (enrolment is localhost-user only)', b3.status >= 400 && b3.status < 500 && !b3.d?.token, { status: b3.status, d: b3.d });

  /* B6 — agent reads the whole store; the hash it finds is not a usable credential */
  const [b6] = await agent.run([{ kind: 'readFile', file: PAIR_STORE }]);
  const hash = (() => { try { return JSON.parse(b6.data)[0].tokenHash; } catch { return null; } })();
  check('B6 agent can read the store but it holds only a hash (no token)', b6.ok && !!hash && !b6.data.includes(token));
  const [b6b] = await agent.run([{ kind: 'http', method: 'POST', url: grantUrl(A), headers: { 'x-orchard-pairing': hash }, body: { scope: 'permanent' } }]);
  check('B6b presenting the stored HASH as a token (over loopback) is refused', b6b.status >= 400 && b6b.status < 500 && (await grantOf(A)) === null, { status: b6b.status });

  /* B7 — the SOURCE-BIND bypass (independent-verify run 01a17ef5, BROKEN): a same-uid caller binds
   * its client socket to a local NON-loopback source (100.x/192.168.x/…) and connects to 127.0.0.1
   * so req.socket.remoteAddress looks "remote". Before the fix classifyCaller returned 'user' and
   * minted a grant / enrolled a pairing with HTTP 200. It must now fail closed (refused). */
  const nonLoopback = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
  const srcBind = (method, pathname, body, headers = {}) => new Promise((resolve) => {
    if (!nonLoopback) return resolve({ skipped: true });
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: pathname, localAddress: nonLoopback, headers: { 'content-type': 'application/json', ...headers, ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, (r) => { let t = ''; r.on('data', (c) => { t += c; }); r.on('end', () => { let d = null; try { d = JSON.parse(t); } catch {} resolve({ status: r.statusCode, d }); }); });
    req.on('error', (e) => resolve({ error: String(e.message) }));
    if (data) req.write(data); req.end();
  });
  if (nonLoopback) {
    const sb1 = await srcBind('POST', `/api/projects/${encodeURIComponent(A)}/git-write-grant`, { scope: 'permanent' });
    check(`B7 source-bound (src ${nonLoopback}→127.0.0.1) grant is REFUSED, not classified as user`, (sb1.error || (sb1.status >= 400 && sb1.status < 500)) && (await grantOf(A)) === null, sb1);
    const sb2 = await srcBind('POST', '/api/pairings', { label: 'source-bind self-enrol' });
    check('B7b source-bound /api/pairings enrolment is REFUSED (no self-minted token)', (sb2.error || (sb2.status >= 400 && sb2.status < 500)) && !sb2.d?.token, sb2);
  } else {
    console.log('  SKIP B7 — no non-loopback IPv4 interface to bind a spoofed source from');
  }

  /* B4 — the LOCALHOST user still grants normally (desktop path unchanged) */
  const b4 = userHttp('POST', `/api/projects/${encodeURIComponent(A)}/git-write-grant`, { scope: 'permanent' });
  check('B4 localhost user grant still works (200, permanent grant issued)', b4?.status === 200 && b4.d?.grant?.scope === 'permanent', b4);
  userHttp('DELETE', `/api/projects/${encodeURIComponent(A)}/git-write-grant`);

  console.log(`\nFEAT-196 remote-grant integration: ${pass} passed, ${fail} failed`);
} catch (e) {
  console.log(`FAIL harness threw: ${e.stack || e.message}`);
  fail++;
} finally {
  await stop();
  try { fs.rmSync(RUN, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.exit(fail ? 1 : 0);
