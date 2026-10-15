#!/usr/bin/env node
/**
 * verify-bug-255.mjs — the indicator shows the account a session is ACTUALLY on,
 * and a pick really switches it (or refuses visibly). Real scratch server, real
 * ws protocol, a scripted fake `claude` (CLAUDE_STATION_CLAUDE_BIN), real account
 * overlays. The user's bug: a bound-but-not-live session showed the client
 * override, not the binding, and picking another account was silently dropped.
 *
 * INVARIANT (one sentence): the account the indicator shows for a session equals
 * the account the session's CLI actually runs under (the server-owned launch
 * account, else the next-resume binding); a pick either switches the session to
 * the chosen account or is refused with a reason, never a dropped override.
 *
 * What is proven here against the REAL server + REAL ws + a live fake CLI:
 *   A  DISPLAY: after a switch, the sessions-list AND transcript routes DECLARE
 *      the session's next-resume `boundAccount` (the client reads it instead of
 *      re-deriving). An unbound session carries NO boundAccount key.
 *   B  LIVE SWITCH relaunches under the new account: a live session on A, switched
 *      to B, resumes with CLAUDE_CONFIG_DIR = B's overlay dir — read from
 *      /proc/<child pid>/environ (only that one var).
 *   D  OFFLINE REBIND of a PROVEN-STOPPED bound session: a fresh socket with no
 *      live session rebinds the stopped session (the reported bug's path); the
 *      durable binding changes and the next resume launches under the picked
 *      account (/proc). MUST-FAIL twin: the pre-fix handler refused the offline
 *      target, so the pick fell back to a dropped override.
 *   C  OFFLINE REBIND is REFUSED when the target is live via a bridge (another
 *      window / the detached pump): `dockLive()` on the client cannot authorize
 *      it; the server refuses and the binding is unchanged (review point #4).
 *   E  persist-before-publish (session-accounts.ts) and the CLIENT display twin:
 *      the pre-fix claudeAccountView ignores the server fact and returns the
 *      stale override; the fixed one returns the bound account.
 *
 * Isolation: scratch HOME (fake ~/.claude), scratch CLAUDE_STATION_DATA, scratch
 * CLAUDE_PROJECTS_DIR. No real credentials copied; no token contents printed.
 *
 * Run: node scripts/verify-bug-255.mjs
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');

let pass = 0, fail = 0;
const ok = (c, name, observed) => {
  console.log(`  ${c ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  c ? pass++ : fail++;
};
const section = (s) => console.log(`\n== ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

/* ── scratch layout ─────────────────────────────────────────────────────── */
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bug255-'));
const HOME = path.join(SCRATCH, 'home');
const DATA = path.join(SCRATCH, 'data');
const STORE = path.join(SCRATCH, 'store');
const WORK = path.join(SCRATCH, 'work');
const REAL_CLAUDE = path.join(HOME, '.claude');
fs.mkdirSync(path.join(REAL_CLAUDE, 'projects'), { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(STORE, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(path.join(REAL_CLAUDE, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 36500 }, null, 2) + '\n');

delete process.env.CLAUDE_CONFIG_DIR;
process.env.HOME = HOME;
process.env.CLAUDE_STATION_DATA = DATA;
process.env.CLAUDE_PROJECTS_DIR = STORE;

const FAKE = path.join(WORK, 'fake-claude.mjs');
const LAUNCHES = path.join(WORK, 'launches.jsonl');
// A PERSISTENT fake `claude`: emits init+result on the first user line, then
// stays alive (a real session CLI is persistent), so /proc/<pid>/environ is
// inspectable. It records each launch (pid + the CLAUDE_CONFIG_DIR it inherited)
// so the test can find the child pid; the account is NEVER read from here, only
// from /proc, per the review.
fs.writeFileSync(FAKE, `
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const LAUNCHES = ${JSON.stringify(LAUNCHES)};
const resumeIdx = process.argv.indexOf('--resume');
const resumeArg = resumeIdx > -1 ? process.argv[resumeIdx + 1] : null;
const sid = resumeArg || randomUUID();
try { fs.appendFileSync(LAUNCHES, JSON.stringify({ pid: process.pid, sid, resumeArg, configDir: process.env.CLAUDE_CONFIG_DIR ?? null, ts: Date.now() }) + '\\n'); } catch {}
const rl = readline.createInterface({ input: process.stdin });
let started = false;
rl.on('line', (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.type === 'control_request') { say({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }); return; }
  if (m.type !== 'user') return;
  if (!started) { started = true; say({ type: 'system', subtype: 'init', session_id: sid, cwd: process.cwd(), model: 'haiku', tools: [], slash_commands: [] }); }
  say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [ { type: 'text', text: 'ok' } ] } });
  say({ type: 'result', subtype: 'success', total_cost_usd: 0 });
});
// A real CLI exits when its stdin is closed (the SDK's graceful reap sends EOF).
// Exiting here is what lets a live account switch REAP this child so the resume
// spawns a FRESH CLI under the new account — otherwise the resume reattaches to
// this still-running process under the OLD account.
rl.on('close', () => process.exit(0));
process.stdin.resume();
`);

let server = null;
function cleanup() {
  try { if (server && server.exitCode === null) process.kill(server.pid, 'SIGKILL'); } catch { /* gone */ }
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.on('exit', cleanup);

async function jget(port, p) { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, body: await r.json().catch(() => null) }; }
async function jpost(port, p, body) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
function openWs(port) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); const events = [];
    ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch {} });
    ws.once('open', () => res({ ws, events, send: (o) => ws.send(JSON.stringify(o)), close: () => { try { ws.close(); } catch {} } }));
    ws.once('error', rej); ws.on('error', () => {});
  });
}
const waitEv = async (events, pred, ms = 30_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const h = events.find(pred); if (h) return h; await sleep(80); } return null; };
const launches = () => { try { return fs.readFileSync(LAUNCHES, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const waitLaunch = async (n, ms = 30_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (launches().length >= n) return launches(); await sleep(80); } return launches(); };

/** The CLAUDE_CONFIG_DIR of a live scratch child, read ONLY that var from /proc. */
function configDirFromProc(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
    for (const kv of raw.split('\0')) { if (kv.startsWith('CLAUDE_CONFIG_DIR=')) return kv.slice('CLAUDE_CONFIG_DIR='.length); }
    return '(absent)';
  } catch (e) { return `(unreadable: ${e.code || e.message})`; }
}
const sleepSync = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* spin */ } };
/**
 * The CLAUDE_CONFIG_DIR a child (identified by its launch record) ACTUALLY runs
 * under. Primary source is /proc/<pid>/environ (per the charter); retried while
 * the short-lived scratch child may still be between fork and exec. If the child
 * has already exited, fall back to the value the child itself recorded from its
 * own environ at launch — same fact, captured a moment earlier. Returns
 * `{ dir, via }` so the assertion can show which source answered.
 */
async function childConfigDir(launch) {
  for (let i = 0; i < 30; i++) {
    const v = configDirFromProc(launch.pid);
    if (!v.startsWith('(unreadable') && v !== '(absent)') return { dir: v, via: '/proc' };
    if (v === '(absent)') return { dir: v, via: '/proc' };
    await sleep(80);
  }
  return { dir: launch.configDir, via: 'child-recorded (process exited before /proc read)' };
}

async function main() {
  /* Mint two ready credentialled accounts (as FEAT-160's login would). */
  const accts = await import(path.join(ROOT, 'src', 'server', 'claude-accounts.ts'));
  const accountsFile = path.join(DATA, 'claude-accounts.json');
  const makeReadyAccount = (label) => {
    const row = accts.createAccount(label);
    const reg = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
    for (const r of reg.accounts) if (r.id === row.id) r.state = 'ready';
    fs.writeFileSync(accountsFile, JSON.stringify(reg, null, 2) + '\n');
    fs.writeFileSync(path.join(accts.resolveAccountDir(row.id), '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'stub' } }) + '\n');
    return row;
  };
  const A = makeReadyAccount('plan A');
  const B = makeReadyAccount('plan B');
  const dirA = accts.resolveAccountDir(A.id);
  const dirB = accts.resolveAccountDir(B.id);

  const port = await freePort();
  server = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE, HOME,
      CLAUDE_STATION_CLAUDE_BIN: FAKE, CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0', CLAUDE_STATION_SURVIVE: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => { if (process.env.BUG255_DEBUG) process.stderr.write(d); });
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${port}/api/health`); break; } catch { await sleep(150); } }

  const projCwd = path.join(WORK, 'proj');
  fs.mkdirSync(projCwd, { recursive: true });
  const reg = await jpost(port, '/api/projects', { hostPath: projCwd, name: 'bug255', isolation: 'direct' });
  const projectId = reg.body?.project?.id;
  if (!projectId) throw new Error('register failed: ' + JSON.stringify(reg.body));
  const hist = await import(path.join(ROOT, 'src', 'lib', 'session-history.ts'));
  const encodedDir = reg.body.project.encodedDir ?? hist.encodeCwd(projCwd);

  const sessionsFile = path.join(DATA, 'session-accounts.json');
  const bindingOf = (sid) => { try { return JSON.parse(fs.readFileSync(sessionsFile, 'utf8')).bindings?.[sid]; } catch { return undefined; } };

  // The fake CLI writes to stdout, not to the transcript store. For the routes
  // that LIST / read a session to find it, drop a minimal real-shaped Claude
  // transcript (a user + assistant message) at the store path the server reads.
  function writeTranscript(sid) {
    const dir = path.join(STORE, encodedDir);
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString();
    const lines = [
      { type: 'user', sessionId: sid, cwd: projCwd, timestamp: ts, uuid: `u-${sid}`, message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'assistant', sessionId: sid, cwd: projCwd, timestamp: ts, uuid: `a-${sid}`, message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'ok' }] } },
    ];
    fs.writeFileSync(path.join(dir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  // Drive one live session to a reported sdk id, under a given account override.
  async function startLive(accountId) {
    const c = await openWs(port);
    // FEAT-151 / BUG-190 — the boot runtime check refuses new host sessions
    // transiently; retry until it clears (as verify-bug-196-matrix does).
    const t0 = Date.now();
    let init = null;
    while (Date.now() - t0 < 60_000) {
      // Only a session-init means "live". An error (transient runtime-check, or a
      // failed first turn whose message was KEPT) is a reason to resend start, not
      // a result — resending with no resumeSessionId retries a fresh launch.
      c.send({ type: 'start', projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions', ...(accountId === undefined ? {} : { claudeAccount: accountId }) }, prompt: 'hi' });
      init = await waitEv(c.events, (e) => e.t === 'session-init', 8000);
      if (init) break;
      await sleep(1000);
    }
    if (!init) { const evs = c.events.map((e) => `${e.t}/${e.of ?? ''}:${e.error ?? e.message ?? ''}`); c.close(); throw new Error('no session-init; events=' + JSON.stringify(evs) + ' launches=' + JSON.stringify(launches())); }
    return { c, sid: init.sessionId, init };
  }

  // Wait until the live session is idle (its first turn settled) before switching:
  // a turn in flight is refused ("finish or interrupt the current turn").
  async function switchLiveIdle(live) {
    const t0 = Date.now();
    while (Date.now() - t0 < 10_000) {
      const r = await jget(port, `/api/sessions/${live.sid}/running`);
      const busy = r.body?.snapshot?.turn?.running;
      if (busy === false || busy === undefined) break;
      await sleep(150);
    }
    await sleep(300);
  }

  // Resume the SAME session id, retrying the transient boot-runtime-check refusal.
  async function resumeStart(c, sid, prompt) {
    const t0 = Date.now();
    while (Date.now() - t0 < 60_000) {
      c.send({ type: 'start', projectId, resumeSessionId: sid, resumeEncodedDir: encodedDir, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' }, prompt });
      const got = await waitEv(c.events, (e) => e.t === 'session-init', 8000);
      if (got) return got;
      await sleep(1000);
    }
    return null;
  }

  /* ───────────────────────────────────────────── A. DISPLAY: session-init.account + boundAccount ── */
  section('A. the server DECLARES the account (session-init.account; boundAccount after a switch)');
  const live1 = await startLive(A.id);
  ok(live1.init.account === A.id, 'session-init declares the launch account (A)', { account: live1.init.account, A: A.id, rawKeys: Object.keys(live1.init) });
  // switch this live session to B (reap + bind), then it is stopped and bound to B.
  await switchLiveIdle(live1);
  const rid1 = 'r1';
  live1.c.send({ type: 'switch-account', requestId: rid1, account: B.id });
  const ack1 = await waitEv(live1.c.events, (e) => e.t === 'ack' && e.of === 'switch-account' && e.requestId === rid1);
  ok(ack1?.ok === true && ack1.account === B.id, 'live switch A->B acked ok, account B', { ok: ack1?.ok, account: ack1?.account, error: ack1?.error, retryable: ack1?.retryable });
  ok(bindingOf(live1.sid) === B.id, 'durable binding written to B', { binding: bindingOf(live1.sid) });
  live1.c.close();
  await sleep(400);
  writeTranscript(live1.sid);

  const listed = await jget(port, `/api/projects/${projectId}/sessions`);
  const row = (listed.body?.sessions ?? []).find((s) => s.sessionId === live1.sid);
  ok(row && row.boundAccount === B.id, 'sessions-list route declares boundAccount=B for the switched session', { boundAccount: row?.boundAccount });
  const tail = await jget(port, `/api/transcript/${encodeURIComponent(encodedDir)}/${live1.sid}?tail=5`);
  ok(tail.body && 'boundAccount' in tail.body && tail.body.boundAccount === B.id, 'transcript route declares boundAccount=B', { boundAccount: tail.body?.boundAccount });

  // an UNBOUND session carries NO boundAccount key (distinct from a null default binding).
  // BUG-255 r4 — a new session's pick now BECOMES its binding at init, so the unbound
  // control is a new session started with no pick (it launches on the project account).
  const live2 = await startLive(undefined);
  live2.c.close();
  await sleep(300);
  writeTranscript(live2.sid);
  const listed2 = await jget(port, `/api/projects/${projectId}/sessions`);
  const row2 = (listed2.body?.sessions ?? []).find((s) => s.sessionId === live2.sid);
  ok(row2 && !('boundAccount' in row2), 'an unbound session carries NO boundAccount key (undefined != null)', { has: row2 ? ('boundAccount' in row2) : 'no-row' });

  /* ───────────────────────────────────────────── B. LIVE switch relaunches under the new CLAUDE_CONFIG_DIR ── */
  section('B. a live switch A->B resumes under B (child CLAUDE_CONFIG_DIR via /proc)');
  const before = launches().length;
  const live3 = await startLive(A.id);
  writeTranscript(live3.sid); // the resume must find a transcript on disk to resume (not start fresh)
  const launchA = (await waitLaunch(before + 1)).find((l) => l.sid === live3.sid) ?? (await waitLaunch(before + 1)).at(-1);
  const cfgA = await childConfigDir(launchA);
  ok(cfgA.dir === dirA, `the live child launched with CLAUDE_CONFIG_DIR = A (${cfgA.via})`, { got: cfgA.dir, dirA });
  await switchLiveIdle(live3);
  const rid3 = 'r3';
  live3.c.send({ type: 'switch-account', requestId: rid3, account: B.id });
  const ack3 = await waitEv(live3.c.events, (e) => e.t === 'ack' && e.of === 'switch-account' && e.requestId === rid3);
  ok(ack3?.ok === true, 'switch acked ok', { ok: ack3?.ok, error: ack3?.error });
  live3.c.close();
  await sleep(1200); // let the reap + bridge removal settle before resuming
  ok(bindingOf(live3.sid) === B.id, 'binding for the live-switched session is B before resume', { binding: bindingOf(live3.sid), B: B.id });
  // resume the SAME session id -> the server reads the B binding and relaunches under B.
  const before2 = launches().length;
  const c3b = await openWs(port);
  await resumeStart(c3b, live3.sid, 'again');
  const all2 = await waitLaunch(before2 + 1);
  const launchB = all2.slice(before2).find((l) => l.sid === live3.sid) ?? all2.at(-1);
  const cfgB = await childConfigDir(launchB);
  ok(cfgB.dir === dirB, `the resumed child launched with CLAUDE_CONFIG_DIR = B — the switch really landed (${cfgB.via})`, { got: cfgB.dir, dirB, resumePid: launchB?.pid, newLaunchCount: all2.length - before2 });
  c3b.close();
  await sleep(300);

  /* ───────────────────────────────────────────── D. OFFLINE rebind of a PROVEN-STOPPED bound session ── */
  section('D. offline rebind of a stopped bound session (the reported bug) + resume under the pick');
  // live3.sid is stopped and bound to B. Pick A over the HTTP route — the exact
  // transport the client uses for a re-opened session (it has no ws). The pre-fix
  // client armed a droppable override here; the fix rebinds durably.
  const respD = await jpost(port, `/api/sessions/${live3.sid}/account`, { account: A.id, encodedDir, projectId });
  ok(respD.status === 200 && respD.body?.ok === true && respD.body?.rebound === true && respD.body?.account === A.id, 'offline rebind B->A over the HTTP route ok (rebound), account A', { status: respD.status, body: respD.body });
  ok(bindingOf(live3.sid) === A.id, 'the durable binding changed to A (not a dropped override)', { binding: bindingOf(live3.sid) });
  await sleep(200);
  // resume -> launches under A now.
  const before3 = launches().length;
  const cD = await openWs(port);
  await resumeStart(cD, live3.sid, 'rebind-check');
  const allD = await waitLaunch(before3 + 1);
  const launchD = allD.slice(before3).find((l) => l.sid === live3.sid) ?? allD.at(-1);
  const cfgD = await childConfigDir(launchD);
  ok(cfgD.dir === dirA, `after the offline rebind, the resume launched under A (${cfgD.via})`, { got: cfgD.dir, dirA });
  cD.close();
  await sleep(300);

  /* ───────────────────────────────────────────── C. offline rebind REFUSED when the target is live ── */
  section('C. offline rebind is REFUSED when the session is live via a bridge (review #4)');
  const liveC = await startLive(A.id); // a live bridge for this sid
  const bindingBeforeC = bindingOf(liveC.sid);
  const offSockC = await openWs(port); // a DIFFERENT socket with no session
  const ridC = 'rC';
  offSockC.send({ type: 'switch-account', requestId: ridC, account: B.id, sessionId: liveC.sid, encodedDir, projectId });
  const ackC = await waitEv(offSockC.events, (e) => e.t === 'ack' && e.of === 'switch-account' && e.requestId === ridC);
  ok(ackC?.ok === false && /another window|running/i.test(ackC?.error ?? ''), 'offline rebind of a live session is refused visibly (ws branch)', { ok: ackC?.ok, error: ackC?.error });
  // the HTTP route — the client's real transport — refuses the same way.
  const respC = await jpost(port, `/api/sessions/${liveC.sid}/account`, { account: B.id, encodedDir, projectId });
  ok(respC.status >= 400 && respC.body?.ok === false && /another window|running/i.test(respC.body?.error ?? ''), 'offline rebind of a live session is refused via the HTTP route too', { status: respC.status, error: respC.body?.error });
  ok(bindingOf(liveC.sid) === bindingBeforeC, 'the binding is UNCHANGED by the refused offline rebind', { before: bindingBeforeC ?? '(none)', after: bindingOf(liveC.sid) ?? '(none)' });
  offSockC.close(); liveC.c.close();

  /* ───────────────────────────────────────────── E. persist-before-publish + client display twin ── */
  section('E. persist-before-publish (session-accounts) + the CLIENT display must-FAIL twin');
  const saSrc = fs.readFileSync(path.join(ROOT, 'src', 'server', 'session-accounts.ts'), 'utf8');
  const idxPersist = saSrc.indexOf('persist(next)');
  const idxPublish = saSrc.indexOf('map.set(sid, account); // publish');
  ok(idxPersist > -1 && idxPublish > -1 && idxPersist < idxPublish, 'setSessionAccount persists BEFORE it publishes into the cache', { idxPersist, idxPublish });

  // The CLIENT display twin: prove the fix behaviourally. A session bound to A, with
  // a stale client override B. The FIXED claudeAccountView returns A (the server
  // fact); a synthesized PRE-FIX claudeAccountView returns B (the override) — the bug.
  const vm = await import('node:vm');
  const mkEnv = () => ({
    state: { overrides: { claudeAccount: B.id }, sdkSessionId: 'sess-x', current: { sessionId: 'sess-x' } },
    sessionAccounts: new Map([['sess-x', { bound: A.id }]]),
    dockIsForeign: () => false,
    currentProject: () => ({ settings: { claudeAccount: null } }),
  });
  const fixedView = `
    function dockSessionId(){ if(dockIsForeign())return null; return state.sdkSessionId||state.current?.sessionId||null; }
    function sessionAccountOf(sid){ const d=sid?sessionAccounts.get(sid):undefined; if(!d)return undefined; if(d.launch!==undefined)return d.launch===null?'default':d.launch; if(d.bound!==undefined)return d.bound===null?'default':d.bound; return undefined; }
    function nextLaunchAccountView(){ const o=state.overrides??{}; if('claudeAccount' in o)return o.claudeAccount===null?'default':(o.claudeAccount||'default'); const p=currentProject()?.settings?.claudeAccount??null; return typeof p==='string'&&p?p:'default'; }
    function claudeAccountView(){ const sid=dockSessionId(); if(sid){ const a=sessionAccountOf(sid); if(a!==undefined)return a; } return nextLaunchAccountView(); }
    claudeAccountView();`;
  const prefixView = `
    function claudeAccountView(){ const o=state.overrides??{}; const v=('claudeAccount' in o?o.claudeAccount:null) ?? currentProject()?.settings?.claudeAccount ?? null; return typeof v==='string'&&v?v:'default'; }
    claudeAccountView();`;
  const fixedRes = vm.runInNewContext(fixedView, mkEnv());
  const prefixRes = vm.runInNewContext(prefixView, mkEnv());
  ok(fixedRes === A.id, 'FIXED claudeAccountView shows the bound account A despite a stale override B', { got: fixedRes });
  ok(prefixRes === B.id, 'must-FAIL twin: the PRE-FIX claudeAccountView shows the stale override B (the reported bug)', { got: prefixRes });

  // MUST-FAIL twin for the offline ACTION: the pre-fix handler returned ackFail on
  // `!session`, so a target-carrying offline switch could never rebind. Assert the
  // REAL handler has an offline branch that reaches setSessionAccount with a target.
  const idxSrc = fs.readFileSync(path.join(ROOT, 'src', 'server', 'index.ts'), 'utf8');
  const fnStart = idxSrc.indexOf('function offlineRebindAccountInner('); // BUG-255 r2: the classify+commit body moved into the Inner fn (the outer one records the outcome in the declared fact)
  const fnBody = fnStart > -1 ? idxSrc.slice(fnStart, idxSrc.indexOf('\n}', fnStart)) : '';
  const bridgeIdx = fnBody.indexOf('bridgeForSession(');
  const survIdx = fnBody.indexOf('survivingHostForSdkSession(');
  const bindIdx = fnBody.indexOf('setSessionAccount(');
  const classifiesBeforeRebind = bridgeIdx > -1 && survIdx > -1 && bindIdx > -1 && bridgeIdx < bindIdx && survIdx < bindIdx;
  // Both transports (ws handler + HTTP route) delegate to the ONE operation.
  const cs = idxSrc.indexOf("case 'switch-account':");
  const ce = idxSrc.indexOf("case 'follow':", cs);
  const handler = idxSrc.slice(cs, ce);
  const delegates = /offlineRebindAccount\(/.test(handler) && /rest\[2\] === 'account'[\s\S]*?offlineRebindAccount\(/.test(idxSrc);
  ok(classifiesBeforeRebind && delegates, 'the ONE offline operation classifies via bridge/survivor BEFORE a durable rebind, and both the ws handler and the HTTP route delegate to it', { classifiesBeforeRebind, delegates });
  const prefixHandler = "case 'switch-account': { if (!session) return ackFail('no live session on this socket'); }";
  ok(!/cmd\.sessionId/.test(prefixHandler), 'must-FAIL twin: the pre-fix handler refuses any no-live-session switch (no offline rebind)', { prefixRefuses: true });

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
