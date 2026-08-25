/**
 * BUG-044 — a server RESTART must NOT kill a session's live BACKGROUND agents
 * on the boot-time re-adopt drain path.
 *
 *   node scripts/verify-bug-044-restart-background.mjs [--beats=240] [--skip-restart]
 *
 * THE DEFECT (BUG-043's documented residual): on boot, `adoptSurvivingHosts()`
 * (src/server/survival.ts) SIGTERMs every surviving broker → the broker's
 * `gracefulReap()` (src/server/session-host.mjs) EOFs the CLI's stdin after the
 * foreground turn's `result`, then fires an UNCONDITIONAL SIGTERM at 150_000ms
 * / SIGKILL at 160_000ms. The CLI does not exit on EOF while a background agent
 * works (measured, BUG-043 arm C) — so the SIGTERM lands ~150s later and kills
 * the live background work, exactly like arm C before the socket-path fix.
 *
 * THE FIX UNDER TEST (ARCH-002 option 1 in the broker): the drain escalation
 * consults the SAME declared-lifetime signal BUG-043 gave the abandon net —
 * while the CLI's `background_tasks_changed` level says work is live (or the
 * lifetime is UNKNOWN inside the observed-dispatch window; unknown never
 * coerced), the escalation DECLINES and re-arms on a short recheck, bounded by
 * the dead-process probe (child exit) and the unknown window. The moment the
 * level is authoritatively empty, escalation proceeds on today's schedule.
 *
 * TWO SECTIONS:
 *  1. BROKER DRAIN ESCALATION (direct, fake CLI, tiny env knobs, seconds):
 *     HELD / BOUNDED / UNKNOWN-holds-then-expires / two CONTROLS. The HELD and
 *     UNKNOWN checks FAIL pre-fix (the fixed 150s→2s SIGTERM kills the CLI).
 *  2. DEPLOY-SHAPED RESTART (real server, real CLI, systemd-run): a session
 *     with a live 240s background heartbeat agent + an idle control session →
 *     SIGTERM the scratch server → boot a second server on the same dataDir
 *     (its `adoptSurvivingHosts` reaps both survivors) → the background agent
 *     must RUN TO COMPLETION (DONE marker) and its broker then reap cleanly;
 *     the idle survivor must drain+reap promptly (today's schedule). Pre-fix
 *     the heartbeat is cut ~150s after the re-adopt and DONE never lands.
 *
 * SAFETY: free port, scratch dataDir + scratch CLAUDE_PROJECTS_DIR + scratch
 * project cwd; everything killed BY PID. :4317 / the real service / scopes not
 * ours are never touched.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ARGV = process.argv.slice(2);
const numArg = (name, dflt) => {
  const hit = ARGV.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : dflt;
};
/** Seconds of heartbeat. MUST exceed (re-adopt delay + the broker's 150s fuse). */
const BEATS = numArg('beats', 240);
const SKIP_RESTART = ARGV.includes('--skip-restart');

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bg44-data-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bg44-work-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bg44-store-'));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  ok ? pass++ : (fail++, failures.push(name));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

/* -------------------------------------------------------------------------- *
 * SECTION 1 — BROKER DRAIN ESCALATION, direct (fake CLI, no systemd/server).
 * SIGTERM to the broker IS what reapHost()/adoptSurvivingHosts() sends, so
 * signalling the broker exercises exactly the boot re-adopt drain path.
 * Knobs: DRAIN_TERM_MS=2000, KILL_LAG=1000, RECHECK=500, BG_UNKNOWN_MS=4000.
 * -------------------------------------------------------------------------- */
const FAKE_CLI = path.join(WORK, 'fake-cli.mjs');
fs.writeFileSync(FAKE_CLI, `
import * as fs from 'node:fs';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
say({ type: 'system', subtype: 'init', session_id: 'fake-sdk-' + process.pid });
if (process.env.FAKE_EMIT_DISPATCH === '1') {
  // The pre-signal window: a background dispatch is seen, the level never reports.
  say({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'tu-1', name: 'Agent', input: { run_in_background: true, prompt: 'x' } },
  ] } });
}
say({ type: 'result', subtype: 'success' }); // midTurn=false, like a real idle CLI
if (process.env.FAKE_EMIT_BG === '1') {
  say({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg-1', task_type: 'local_agent' }] });
  say({ type: 'result', subtype: 'success' });
}
const flag = process.env.FAKE_EMPTY_FLAG;
if (flag) {
  const iv = setInterval(() => {
    if (fs.existsSync(flag)) {
      clearInterval(iv);
      say({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
      say({ type: 'result', subtype: 'success' });
    }
  }, 200);
  iv.unref?.();
}
if (process.env.FAKE_IGNORE_EOF === '1') {
  // Mirror the real CLI mid-background-work: stdin EOF does not make it exit.
  process.stdin.on('end', () => { setInterval(() => {}, 1000); });
} else {
  process.stdin.on('end', () => process.exit(0));
}
process.stdin.resume();
`);

const HOST_SCRIPT = path.join(ROOT, 'src', 'server', 'session-host.mjs');
const brokerDirs = [];
function mkBroker(name, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cs-bg44-broker-${name}-`));
  brokerDirs.push(dir);
  const ctl = path.join(dir, 'ctl.json');
  const statusPath = path.join(dir, 'status.json');
  fs.writeFileSync(ctl, JSON.stringify({
    sock: path.join(dir, 'host.sock'), status: statusPath, errlog: path.join(dir, 'host.err'),
    command: process.execPath, args: [FAKE_CLI], meta: { stationSessionId: `fake-${name}` },
  }));
  const broker = spawn(process.execPath, [HOST_SCRIPT, ctl], {
    cwd: dir,
    env: {
      ...process.env,
      CLAUDE_STATION_HOST_ABANDON_MS: '300000', // out of the way — the drain fuse is under test
      CLAUDE_STATION_HOST_DRAIN_TERM_MS: '2000',
      CLAUDE_STATION_HOST_DRAIN_KILL_LAG_MS: '1000',
      CLAUDE_STATION_HOST_DRAIN_RECHECK_MS: '500',
      CLAUDE_STATION_HOST_BG_UNKNOWN_MS: '4000',
      ...env,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return { dir, statusPath, broker };
}
const readStatus = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

async function brokerDrainSection() {
  console.log('\n=== SECTION 1: BROKER DRAIN ESCALATION (direct, fake CLI, DRAIN_TERM_MS=2000) ===');

  // -- HELD (§C: FAILS pre-fix): background live → the escalation must decline.
  const emptyFlag = path.join(WORK, 'bg-empty.flag');
  const g = mkBroker('held', { FAKE_EMIT_BG: '1', FAKE_IGNORE_EOF: '1', FAKE_EMPTY_FLAG: emptyFlag });
  await sleep(1200);
  const gCli = readStatus(g.statusPath)?.claudePid ?? null;
  try { process.kill(g.broker.pid, 'SIGTERM'); } catch { /* gone */ } // exactly what reapHost sends
  await sleep(8000); // >> TERM(2s) + KILL lag(1s): pre-fix the CLI is long dead here
  const gStatus = readStatus(g.statusPath);
  check('DRAIN (held): 8s after re-adopt SIGTERM with DRAIN_TERM_MS=2000, the CLI with LIVE background work is still alive (escalation declined)',
    !!gStatus && gStatus.state === 'draining' && gCli != null && pidAlive(gCli),
    { brokerState: gStatus?.state ?? 'status-file-gone', cliAlive: gCli != null && pidAlive(gCli) });

  // -- BOUNDED: level empties (CLI still wedged) → the next recheck escalates.
  fs.writeFileSync(emptyFlag, '1');
  let gReaped = false;
  const gDeadline = Date.now() + 12_000;
  while (Date.now() < gDeadline) {
    if (!fs.existsSync(g.statusPath) && (gCli == null || !pidAlive(gCli))) { gReaped = true; break; }
    await sleep(300);
  }
  check('DRAIN (bounded, no leak): once the level EMPTIES, the next recheck escalates — wedged CLI killed, status file removed',
    gReaped, { statusFileGone: !fs.existsSync(g.statusPath), cliDead: gCli == null || !pidAlive(gCli) });

  // -- UNKNOWN holds, then the window expires (§C: the hold FAILS pre-fix).
  const u = mkBroker('unknown', { FAKE_EMIT_DISPATCH: '1', FAKE_IGNORE_EOF: '1' });
  await sleep(1200);
  const uCli = readStatus(u.statusPath)?.claudePid ?? null;
  try { process.kill(u.broker.pid, 'SIGTERM'); } catch { /* gone */ }
  await sleep(3000); // past TERM(2s)+lag(1s), still inside BG_UNKNOWN_MS(4s from dispatch)
  const uHeld = uCli != null && pidAlive(uCli);
  check('DRAIN (unknown holds): an observed background dispatch with NO level frame yet holds the escalation past DRAIN_TERM_MS',
    uHeld, { cliAliveAt3s: uHeld });
  let uReaped = false;
  const uDeadline = Date.now() + 12_000;
  while (Date.now() < uDeadline) {
    if (!fs.existsSync(u.statusPath) && (uCli == null || !pidAlive(uCli))) { uReaped = true; break; }
    await sleep(300);
  }
  check('DRAIN (unknown bounded): the unknown window EXPIRES and the escalation then reaps the wedged CLI (no forever-hold)',
    uReaped, { statusFileGone: !fs.existsSync(u.statusPath), cliDead: uCli == null || !pidAlive(uCli) });

  // -- CONTROL (today's schedule): no background work ever → escalation fires at DRAIN_TERM_MS.
  const c = mkBroker('sched', { FAKE_IGNORE_EOF: '1' });
  await sleep(1200);
  const cCli = readStatus(c.statusPath)?.claudePid ?? null;
  const cT0 = Date.now();
  try { process.kill(c.broker.pid, 'SIGTERM'); } catch { /* gone */ }
  let cReapedAt = null;
  const cDeadline = Date.now() + 12_000;
  while (Date.now() < cDeadline) {
    if (!fs.existsSync(c.statusPath) && (cCli == null || !pidAlive(cCli))) { cReapedAt = Date.now() - cT0; break; }
    await sleep(200);
  }
  check('DRAIN (control, today\'s schedule): a wedged CLI with NO background work is still SIGTERMed at DRAIN_TERM_MS (no regression)',
    cReapedAt != null, { reapedAfterMs: cReapedAt });

  // -- CONTROL (clean drain): idle CLI exits on EOF, no escalation needed.
  const e = mkBroker('clean', {});
  await sleep(1200);
  const eCli = readStatus(e.statusPath)?.claudePid ?? null;
  try { process.kill(e.broker.pid, 'SIGTERM'); } catch { /* gone */ }
  let eReaped = false;
  const eDeadline = Date.now() + 8_000;
  while (Date.now() < eDeadline) {
    if (!fs.existsSync(e.statusPath) && (eCli == null || !pidAlive(eCli))) { eReaped = true; break; }
    await sleep(200);
  }
  check('DRAIN (control, clean): an idle CLI drains on stdin EOF and the broker exits promptly',
    eReaped, { statusFileGone: !fs.existsSync(e.statusPath), cliDead: eCli == null || !pidAlive(eCli) });

  for (const x of [g, u, c, e]) stopByPid(x.broker);
}

/* -------------------------------------------------------------------------- *
 * SECTION 2 — DEPLOY-SHAPED RESTART (real server, real CLI, real broker).
 * -------------------------------------------------------------------------- */
const hostsDir = () => path.join(DATA, 'session-hosts');
function hostStatuses() {
  try {
    return fs.readdirSync(hostsDir()).filter((f) => f.endsWith('.json') && !f.endsWith('.ctl.json'))
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(hostsDir(), f), 'utf8')); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
const hostFor = (stationSessionId) => hostStatuses().find((h) => h.stationSessionId === stationSessionId) ?? null;
const beatCount = (hb) => { try { return fs.readFileSync(hb, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
const isDone = (hb) => { try { return fs.readFileSync(hb, 'utf8').includes('DONE'); } catch { return false; } };

let server1 = null, server2 = null, server3 = null;
let server2Log = '';

function openWs(port) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const events = [];
    ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
    ws.once('open', () => res({ ws, events, send: (o) => ws.send(JSON.stringify(o)) }));
    ws.once('error', rej);
    ws.on('error', () => { /* a killed server drops the socket — never throw */ });
  });
}
const waitEv = async (events, pred, ms = 240_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = events.find(pred);
    if (hit) return hit;
    await sleep(200);
  }
  return null;
};
async function waitHealth(port) {
  for (let i = 0; i < 120; i++) { try { await fetch(`http://127.0.0.1:${port}/api/health`); return true; } catch { await sleep(250); } }
  return false;
}
function spawnServer(port, onLog) {
  const s = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  s.stdout?.on('data', (d) => onLog?.(String(d)));
  s.stderr?.on('data', (d) => onLog?.(String(d)));
  return s;
}

async function restartSection() {
  console.log(`\n=== SECTION 2: DEPLOY-SHAPED RESTART (real CLI, ${BEATS}s background heartbeat) ===`);
  const port1 = await freePort();
  server1 = spawnServer(port1, null);
  if (!(await waitHealth(port1))) throw new Error('server 1 never became healthy');

  const reg = await (await fetch(`http://127.0.0.1:${port1}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: WORK, name: 'bug044-restart-bg' }),
  })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`register failed: ${JSON.stringify(reg)}`);

  // Session 1: live background heartbeat agent.
  const hb = path.join(WORK, 'hb-restart.txt');
  const cmd = `for i in $(seq 1 ${BEATS}); do date +%s.%N >> ${hb}; sleep 1; done; echo DONE >> ${hb}`;
  const bg = await openWs(port1);
  bg.send({
    type: 'start', projectId: pid,
    overrides: { model: 'haiku', permissionMode: 'bypassPermissions' },
    prompt:
      'Dispatch ONE subagent with the Task/Agent tool, subagent_type "general-purpose", and ' +
      'run_in_background set to true. Its entire task is to run this one Bash command verbatim ' +
      `and nothing else:\n\n${cmd}\n\n` +
      'Do NOT run that command yourself and do NOT wait for the agent. The moment you have ' +
      'dispatched it, finish your turn by replying with exactly: BG-DISPATCHED',
  });
  const bgAck = await waitEv(bg.events, (e) => e.t === 'ack' && e.of === 'start', 180_000);
  const bgStarted = await waitEv(bg.events, (e) => e.t === 'agent-started', 180_000);
  const bgEnd = await waitEv(bg.events, (e) => e.t === 'turn-end', 180_000);
  if (!bgAck) throw new Error('background session never acked');
  const bgStation = bgAck.stationSessionId;

  // Session 2: idle control (a survivor with NO background work).
  const idle = await openWs(port1);
  idle.send({
    type: 'start', projectId: pid,
    overrides: { model: 'haiku', permissionMode: 'bypassPermissions' },
    prompt: 'Reply with exactly the word: IDLEDONE. Do not use any tools.',
  });
  const idleAck = await waitEv(idle.events, (e) => e.t === 'ack' && e.of === 'start', 180_000);
  const idleEnd = await waitEv(idle.events, (e) => e.t === 'turn-end', 180_000);
  if (!idleAck) throw new Error('idle session never acked');
  const idleStation = idleAck.stationSessionId;

  // PRECONDITION, measured not assumed: the background work OUTLIVES its turn.
  const beatsAtEnd = beatCount(hb);
  await sleep(10_000);
  const beatsBeforeRestart = beatCount(hb);
  const bgHost = hostFor(bgStation);
  const idleHost = hostFor(idleStation);
  check('[restart] PRECONDITION: background agent dispatched, turn ended, both sessions have survival brokers',
    !!bgStarted && !!bgEnd && !!idleEnd && !!bgHost && !!idleHost,
    { agentStarted: !!bgStarted, bgTurnEnded: !!bgEnd, idleTurnEnded: !!idleEnd, bgBroker: !!bgHost, idleBroker: !!idleHost });
  check('[restart] PRECONDITION: the background work OUTLIVES the turn (heartbeat still growing 10s after turn-end)',
    beatsBeforeRestart > beatsAtEnd, { atTurnEnd: beatsAtEnd, beforeRestart: beatsBeforeRestart });

  // THE RESTART: SIGTERM server 1 (what systemd's restart sends the service).
  try { bg.ws.close(); } catch { /* ignore */ }
  try { idle.ws.close(); } catch { /* ignore */ }
  const s1pid = server1.pid;
  try { process.kill(s1pid, 'SIGTERM'); } catch { /* ignore */ }
  const s1Deadline = Date.now() + 15_000;
  while (Date.now() < s1Deadline && pidAlive(s1pid)) await sleep(250);
  if (pidAlive(s1pid)) { try { process.kill(s1pid, 'SIGKILL'); } catch { /* ignore */ } }
  await sleep(1000);
  check('[restart] SURVIVAL: broker + CLI outlived the dead server',
    !!bgHost && pidAlive(bgHost.hostPid) && bgHost.claudePid != null && pidAlive(bgHost.claudePid),
    { brokerAlive: !!bgHost && pidAlive(bgHost.hostPid), cliAlive: !!bgHost && bgHost.claudePid != null && pidAlive(bgHost.claudePid) });

  // Boot server 2 on the SAME dataDir: adoptSurvivingHosts reaps both survivors.
  const port2 = await freePort();
  server2 = spawnServer(port2, (d) => { server2Log += d; });
  if (!(await waitHealth(port2))) throw new Error('server 2 never became healthy');
  const readoptAt = Date.now();
  await sleep(2000);
  check('[restart] RE-ADOPT: the fresh server logged its re-adopt of the surviving brokers',
    server2Log.includes('re-adopting surviving session host'), { logged: server2Log.includes('re-adopting surviving session host') });

  // THE LOAD-BEARING WAIT (§C, FAILS pre-fix): the background agent must reach
  // its own DONE marker. Pre-fix the unconditional SIGTERM lands ~150s after
  // the re-adopt and the heartbeat is CUT. Sample the broker state throughout.
  const deadline = readoptAt + (BEATS * 1000) + 120_000;
  let done = false;
  let idleGoneAt = null; // sampled HERE so the control's timing is actually observed
  const idleGone = () => {
    const h = hostFor(idleStation);
    return !h || (!pidAlive(h.hostPid) && (h.claudePid == null || !pidAlive(h.claudePid)));
  };
  if (idleGone()) idleGoneAt = Date.now();
  const brokerStates = new Set();
  while (Date.now() < deadline) {
    brokerStates.add(hostFor(bgStation)?.state ?? 'no-status-file');
    if (idleGoneAt == null && idleGone()) idleGoneAt = Date.now();
    if (isDone(hb)) { done = true; break; }
    await sleep(2000);
  }
  const beatsFinal = beatCount(hb);
  check(`[restart] LOAD-BEARING: the background agent RAN TO COMPLETION through the restart + re-adopt drain (${BEATS}/${BEATS} beats + DONE)`,
    done, done
      ? { done: true, beats: beatsFinal, of: BEATS, brokerStatesSeen: [...brokerStates] }
      : { done: false, beats: beatsFinal, of: BEATS, cutAtSecondsAfterReadopt: Math.round((Date.now() - readoptAt) / 1000), brokerStatesSeen: [...brokerStates] });

  // NO LEAK: with the work finished, the held drain must complete — broker and
  // CLI exit (EOF was already delivered; if the CLI wedges instead, the emptied
  // level lets the escalation reap it on the next recheck).
  let bgReaped = false;
  const reapDeadline = Date.now() + 240_000;
  let bgHostEnd = hostFor(bgStation);
  while (Date.now() < reapDeadline) {
    bgHostEnd = hostFor(bgStation);
    if (!bgHostEnd || (!pidAlive(bgHostEnd.hostPid) && (bgHostEnd.claudePid == null || !pidAlive(bgHostEnd.claudePid)))) { bgReaped = true; break; }
    await sleep(2000);
  }
  check('[restart] NO LEAK: once the background work ended, the broker reaped cleanly (status file gone, broker + CLI dead)',
    bgReaped, { statusFileGone: !hostFor(bgStation), brokerState: bgHostEnd?.state ?? 'gone' });

  // CONTROL: the session with NO background work is never held. Under a
  // graceful (SIGTERM) restart its lifetime answers 'no', so the shutdown
  // handoff decision CLOSES it — its broker drains + reaps at shutdown time
  // and there is nothing left to re-adopt. Either way it must be fully gone
  // well inside today's 150s/160s schedule.
  if (idleGoneAt == null && idleGone()) idleGoneAt = Date.now();
  check('[restart] CONTROL: the session with NO background work drained + reaped on today\'s schedule (not held, no leak)',
    idleGoneAt != null && idleGoneAt - readoptAt < 170_000,
    { goneSecondsAfterReadopt: idleGoneAt != null ? Math.round((idleGoneAt - readoptAt) / 1000) : null });

  // CRASH-SHAPED CONTROL (SIGKILL): a graceful shutdown closes an idle session
  // before re-adopt can ever see it, so the boot-drain schedule for an idle
  // SURVIVOR needs a crash: SIGKILL server 2 with a fresh idle session live,
  // boot server 3, and the re-adopted idle broker must drain + reap promptly.
  const idle2 = await openWs(port2);
  idle2.send({
    type: 'start', projectId: pid,
    overrides: { model: 'haiku', permissionMode: 'bypassPermissions' },
    prompt: 'Reply with exactly the word: IDLEDONE. Do not use any tools.',
  });
  const idle2Ack = await waitEv(idle2.events, (e) => e.t === 'ack' && e.of === 'start', 180_000);
  const idle2End = await waitEv(idle2.events, (e) => e.t === 'turn-end', 180_000);
  if (!idle2Ack) throw new Error('crash-control idle session never acked');
  const idle2Station = idle2Ack.stationSessionId;
  await sleep(1500);
  const idle2Host = hostFor(idle2Station);
  try { process.kill(server2.pid, 'SIGKILL'); } catch { /* ignore */ }
  await sleep(1500);
  const idle2Survived = !!idle2Host && pidAlive(idle2Host.hostPid);
  const port3 = await freePort();
  server3 = spawnServer(port3, null);
  if (!(await waitHealth(port3))) throw new Error('server 3 never became healthy');
  const readopt3At = Date.now();
  let idle2Gone = false, idle2GoneAfterMs = null;
  const idle2Deadline = readopt3At + 170_000;
  while (Date.now() < idle2Deadline) {
    const h = hostFor(idle2Station);
    if (!h || (!pidAlive(h.hostPid) && (h.claudePid == null || !pidAlive(h.claudePid)))) {
      idle2Gone = true; idle2GoneAfterMs = Date.now() - readopt3At; break;
    }
    await sleep(1000);
  }
  check('[crash] CONTROL PRECONDITION: the idle session\'s broker SURVIVED the SIGKILL\'d server (turn had ended)',
    !!idle2End && idle2Survived, { turnEnded: !!idle2End, brokerSurvived: idle2Survived });
  check('[crash] CONTROL: the re-adopted idle SURVIVOR drained + reaped on today\'s schedule (boot drain not held without background work)',
    idle2Gone, { goneSecondsAfterReadopt: idle2GoneAfterMs != null ? Math.round(idle2GoneAfterMs / 1000) : null });
}

async function main() {
  await brokerDrainSection();
  if (SKIP_RESTART) {
    console.log('\n(--skip-restart: section 2 skipped)');
  } else {
    if (spawnSync('systemd-run', ['--version'], { encoding: 'utf8' }).status !== 0) {
      console.error('FATAL: section 2 needs `systemd-run --user` (production\'s survival mechanism).');
      process.exitCode = 1;
      return;
    }
    await restartSection();
  }
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(async () => {
  // Kill BY PID anything this harness's own scratch dataDir spawned.
  for (const h of hostStatuses()) {
    for (const p of [h.claudePid, h.hostPid]) {
      if (p && pidAlive(p)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    }
  }
  stopByPid(server1);
  stopByPid(server2);
  stopByPid(server3);
  setTimeout(() => {
    for (const d of [DATA, WORK, STORE, ...brokerDirs]) fs.rmSync(d, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }, 2500);
});
