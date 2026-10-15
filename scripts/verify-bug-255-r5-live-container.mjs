/**
 * BUG-255 r5 — the LIVE switch-account refusal must read the CURRENT project.
 *
 * Independent verify r4 (run c36f27a6) broke the r4 re-fix on ONE path:
 * iso-drift-live-switch. A session running LIVE under `direct` on the project
 * account; the project is PATCHed isolation=`container` (allowed while live); a
 * ws `switch-account` pick of B is then ACCEPTED — ack "switched to B", binding
 * written B, the old CLI reaped — yet `effectiveLaunchAccount`/`fact.next` is
 * still the project account, because the handler validated the pick against
 * `session.project` (the START-TIME snapshot, isolation `direct`), so the
 * FEAT-145 container refusal never fired. The ack lied: the next launch will
 * not honour B.
 *
 * THE FIX (src/server/index.ts, live `case 'switch-account'`): read
 * `reg.getProject(session.project.id)` — the SAME live project
 * `effectiveLaunchAccount` reads — so the accept/refuse decision is in lockstep
 * with what the launch actually does. A pick on a now-container project is
 * refused with the FEAT-145 reason; the binding is untouched; the indicator
 * keeps the true (project) account.
 *
 * This script drives the REAL server + REAL ws + a live fake CLI, and grades the
 * SAME scenario against BOTH the fixed working tree AND a SYNTHESIZED PRE-FIX
 * tree (the one r5 edit reverted to `const proj = session.project;`). The fixed
 * tree must refuse; the pre-fix tree must exhibit the lie (ack ok, binding B,
 * next still the project account) — the must-FAIL anchor.
 *
 * Only CLAUDE_CONFIG_DIR is read from /proc/<pid>/environ (never the whole env,
 * never token contents). No container is started (the project registers
 * isolation=container; the refusal is decided before any spawn).
 *
 * Run: node scripts/verify-bug-255-r5-live-container.mjs
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ENTRY_REL = path.join('src', 'server', 'index.ts');

let pass = 0, fail = 0;
const ok = (c, name, observed) => {
  console.log(`  ${c ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  c ? pass++ : fail++;
};
const section = (s) => console.log(`\n== ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── scratch layout (shared across both runs; each run uses its own project + session) ── */
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bug255r5-'));
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
rl.on('close', () => process.exit(0));
process.stdin.resume();
`);

const spawned = new Set();
function cleanup() {
  for (const c of spawned) { try { if (c.exitCode === null) process.kill(c.pid, 'SIGKILL'); } catch {} }
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {}
  try { if (PRE_ROOT) fs.rmSync(PRE_ROOT, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
async function jget(port, p) { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, body: await r.json().catch(() => null) }; }
async function jpost(port, p, body) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function jpatch(port, p, body) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
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
function configDirFromProc(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
    for (const kv of raw.split('\0')) { if (kv.startsWith('CLAUDE_CONFIG_DIR=')) return kv.slice('CLAUDE_CONFIG_DIR='.length); }
    return '(absent)';
  } catch (e) { return `(unreadable: ${e.code || e.message})`; }
}
async function childConfigDir(launch) {
  for (let i = 0; i < 30; i++) {
    const v = configDirFromProc(launch.pid);
    if (!v.startsWith('(unreadable') && v !== '(absent)') return { dir: v, via: '/proc' };
    if (v === '(absent)') return { dir: v, via: '/proc' };
    await sleep(80);
  }
  return { dir: launch.configDir, via: 'child-recorded (process exited before /proc read)' };
}

/* The exact fixed block in index.ts and the single-line pre-fix it replaced. The
 * SYNTHESIZED PRE-FIX tree reverts ONLY this (not a diff vs HEAD), per the proof bar. */
const FIXED_MARK = 'const proj = reg.getProject(session.project.id) ?? session.project;';
const PREFIX_LINE = 'const proj = session.project;';
let PRE_ROOT = null;
function buildPreFixRoot() {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'bug255r5-preroot-'));
  // Copy the working tree except node_modules/.git; symlink node_modules so the server boots.
  for (const name of fs.readdirSync(ROOT)) {
    if (name === 'node_modules' || name === '.git') continue;
    fs.cpSync(path.join(ROOT, name), path.join(dst, name), { recursive: true });
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dst, 'node_modules'));
  const idx = path.join(dst, ENTRY_REL);
  const src = fs.readFileSync(idx, 'utf8');
  if (!src.includes(FIXED_MARK)) throw new Error('pre-fix synth: fixed marker not found in index.ts — update FIXED_MARK');
  // Revert the whole r5 comment block + the fixed line back to the pre-fix single line.
  const blockStart = src.indexOf('          /*\n           * BUG-255 r5 — read the CURRENT project');
  const fixedLineIdx = src.indexOf('          ' + FIXED_MARK);
  if (blockStart < 0 || fixedLineIdx < 0) throw new Error('pre-fix synth: could not locate the r5 block to revert');
  const after = fixedLineIdx + ('          ' + FIXED_MARK).length;
  const reverted = src.slice(0, blockStart) + '          ' + PREFIX_LINE + src.slice(after);
  if (!reverted.includes('          ' + PREFIX_LINE) || reverted.includes(FIXED_MARK)) throw new Error('pre-fix synth: revert produced an unexpected result');
  fs.writeFileSync(idx, reverted);
  PRE_ROOT = dst;
  return dst;
}

/* Mint two ready credentialled accounts (as FEAT-160's login would). */
let A, B, dirA, dirB;
async function mintAccounts() {
  const accts = await import(path.join(ROOT, 'src', 'server', 'claude-accounts.ts'));
  const accountsFile = path.join(DATA, 'claude-accounts.json');
  const makeReady = (label) => {
    const row = accts.createAccount(label);
    const reg = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
    for (const r of reg.accounts) if (r.id === row.id) r.state = 'ready';
    fs.writeFileSync(accountsFile, JSON.stringify(reg, null, 2) + '\n');
    fs.writeFileSync(path.join(accts.resolveAccountDir(row.id), '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'stub' } }) + '\n');
    return row;
  };
  A = makeReady('plan A'); B = makeReady('plan B');
  dirA = accts.resolveAccountDir(A.id); dirB = accts.resolveAccountDir(B.id);
}

async function startServer(rootDir) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(rootDir, ENTRY_REL)], {
    cwd: rootDir,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE, HOME,
      CLAUDE_STATION_CLAUDE_BIN: FAKE, CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0', CLAUDE_STATION_SURVIVE: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawned.add(child);
  child.stderr.on('data', (d) => { if (process.env.BUG255_DEBUG) process.stderr.write(d); });
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${port}/api/health`); break; } catch { await sleep(150); } }
  return { child, port };
}
async function killServer(child) { if (!child || child.exitCode !== null) return; const done = new Promise((r) => child.once('exit', r)); try { process.kill(child.pid, 'SIGKILL'); } catch {} await done; spawned.delete(child); }

/*
 * One run of the iso-drift-live-switch scenario against a server at `rootDir`.
 * Returns the observable outcome of the live switch after the project went
 * container: { ackOk, ackError, bindingAfter, nextAfter, launchDirBefore }.
 */
async function runScenario(rootDir, tag) {
  const { child, port } = await startServer(rootDir);
  try {
    const projCwd = path.join(WORK, `proj-${tag}`);
    fs.mkdirSync(projCwd, { recursive: true });
    const reg = await jpost(port, '/api/projects', { hostPath: projCwd, name: `bug255r5-${tag}`, isolation: 'direct' });
    const projectId = reg.body?.project?.id;
    if (!projectId) throw new Error(`[${tag}] register failed: ${JSON.stringify(reg.body)}`);
    const hist = await import(path.join(ROOT, 'src', 'lib', 'session-history.ts'));
    const encodedDir = reg.body.project.encodedDir ?? hist.encodeCwd(projCwd);
    // The PROJECT account is A ("plan A"): a live session with no pick launches on it.
    await jpatch(port, `/api/projects/${projectId}`, { settings: { claudeAccount: A.id } });

    const sessionsFile = path.join(DATA, 'session-accounts.json');
    const bindingOf = (sid) => { try { return JSON.parse(fs.readFileSync(sessionsFile, 'utf8')).bindings?.[sid]; } catch { return undefined; } };

    // Start a LIVE session (no pick → project account A).
    const c = await openWs(port);
    let init = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 60_000) {
      c.send({ type: 'start', projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' }, prompt: 'hi' });
      init = await waitEv(c.events, (e) => e.t === 'session-init', 8000);
      if (init) break;
      await sleep(1000);
    }
    if (!init) throw new Error(`[${tag}] no session-init; launches=${JSON.stringify(launches())}`);
    const sid = init.sessionId;
    const launchBefore = launches().find((l) => l.sid === sid || !l.resumeArg);
    const launchDir = launchBefore ? (await childConfigDir(launchBefore)).dir : '(none)';

    // Idle before switching (a turn in flight is refused for a different reason).
    const ti = Date.now();
    while (Date.now() - ti < 10_000) {
      const r = await jget(port, `/api/sessions/${sid}/running`);
      const busy = r.body?.snapshot?.turn?.running;
      if (busy === false || busy === undefined) break;
      await sleep(150);
    }
    await sleep(300);

    const factBefore = await jget(port, `/api/sessions/${sid}/account?dir=${encodeURIComponent(encodedDir)}&projectId=${projectId}`);

    // DRIFT: PATCH the live project to container (allowed while live).
    const toC = await jpatch(port, `/api/projects/${projectId}`, { isolation: 'container' });

    const factContainer = await jget(port, `/api/sessions/${sid}/account?dir=${encodeURIComponent(encodedDir)}&projectId=${projectId}`);

    // THE LIVE PICK of B, now that the project is container.
    const rid = `r5-${tag}`;
    c.send({ type: 'switch-account', requestId: rid, account: B.id });
    const ack = await waitEv(c.events, (e) => e.t === 'ack' && e.of === 'switch-account' && e.requestId === rid, 15_000);
    await sleep(400);
    const bindingAfter = bindingOf(sid);
    const factAfter = await jget(port, `/api/sessions/${sid}/account?dir=${encodeURIComponent(encodedDir)}&projectId=${projectId}`);
    c.close();

    return {
      projectAccount: A.id, pickTarget: B.id,
      launchDir, dirA, dirB,
      ackOk: ack?.ok ?? null, ackError: ack?.error ?? null,
      toContainerStatus: toC.status,
      nextBefore: factBefore.body?.next ?? '(absent)',
      nextContainer: factContainer.body?.next ?? '(absent)',
      bindingAfter: bindingAfter ?? '(none)',
      nextAfter: factAfter.body?.next ?? '(absent)',
    };
  } finally {
    await killServer(child);
  }
}

async function main() {
  await mintAccounts();

  section('setup: synthesize the PRE-FIX tree (revert ONLY the r5 one-line fix)');
  buildPreFixRoot();
  ok(!!PRE_ROOT, 'pre-fix tree synthesized (r5 reverted to `const proj = session.project;`)', { preRoot: PRE_ROOT });

  section('FIXED working tree — a live pick after the project went container is REFUSED');
  const fixed = await runScenario(ROOT, 'fixed');
  console.log('        ', JSON.stringify(fixed));
  ok(fixed.launchDir === fixed.dirA, 'setup: the live session launched on the project account A (/proc CLAUDE_CONFIG_DIR)', { launchDir: fixed.launchDir, dirA: fixed.dirA });
  ok(fixed.toContainerStatus === 200, 'setup: the live project was PATCHed to container (200)', { status: fixed.toContainerStatus });
  ok(fixed.nextContainer === fixed.projectAccount, 'after the container PATCH the indicator fact.next is the project account A', { nextContainer: fixed.nextContainer, projectAccount: fixed.projectAccount });
  ok(fixed.ackOk === false, 'the live pick of B is REFUSED (ack ok:false), not acked as a switch', { ackOk: fixed.ackOk, error: fixed.ackError });
  ok(typeof fixed.ackError === 'string' && /container/i.test(fixed.ackError), 'the refusal names the FEAT-145 container reason (visible)', { error: fixed.ackError });
  ok(fixed.bindingAfter !== fixed.pickTarget, 'the durable binding was NOT written to B (unchanged by the refused pick)', { bindingAfter: fixed.bindingAfter, pickTarget: fixed.pickTarget });
  ok(fixed.nextAfter === fixed.projectAccount, 'the indicator keeps the TRUE account (fact.next still the project account A)', { nextAfter: fixed.nextAfter, projectAccount: fixed.projectAccount });

  section('SYNTHESIZED PRE-FIX tree — the must-FAIL anchor: the ack LIES');
  const pre = await runScenario(PRE_ROOT, 'prefix');
  console.log('        ', JSON.stringify(pre));
  ok(pre.launchDir === pre.dirA, 'setup: the pre-fix live session also launched on the project account A', { launchDir: pre.launchDir, dirA: pre.dirA });
  // The bug: the stale-snapshot handler accepts the pick though the project is now container.
  const theLie = pre.ackOk === true && pre.bindingAfter === pre.pickTarget && pre.nextAfter === pre.projectAccount;
  ok(theLie, 'PRE-FIX exhibits the bug: ack "switched to B" + binding B, yet fact.next (the next launch) is still the project account A — the ack lies', {
    ackOk: pre.ackOk, bindingAfter: pre.bindingAfter, pickTarget: pre.pickTarget, nextAfter: pre.nextAfter, projectAccount: pre.projectAccount,
  });
  ok(!(fixed.ackOk === pre.ackOk && fixed.bindingAfter === pre.bindingAfter), 'FIXED and PRE-FIX diverge on exactly this decision (must-FAIL confirmed)', {
    fixed: { ackOk: fixed.ackOk, bindingAfter: fixed.bindingAfter }, pre: { ackOk: pre.ackOk, bindingAfter: pre.bindingAfter },
  });

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAIL'} ${pass}/${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
