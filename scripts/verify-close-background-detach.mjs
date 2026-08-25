/**
 * BUG-043 — closing/switching a session must NOT kill its live BACKGROUND agents.
 *
 *   node scripts/verify-close-background-detach.mjs [--runs=3] [--beats=240]
 *
 * THE DEFECT (proven N=3/arm before the fix): the close/detach decision in
 * `src/server/index.ts` (the client's explicit `{type:'close'}` — sent on EVERY
 * session switch / New / navigation / reopen — and `ws.on('close')`) asked ONLY
 * `session.busy`. `busy` is TURN-scoped: it goes false at `result` while a
 * background subagent keeps working. So a session with live background agents
 * read as IDLE, the socket drop CLOSED it, `close()` reaped the broker, and the
 * broker's UNCONDITIONAL `SIGTERM` at 150_000ms (session-host.mjs gracefulReap)
 * killed the agent ~150s later — silently, with an EMPTY `.err` file.
 *
 * WHAT THIS PROVES, with the heartbeat FILE as ground truth (never the ledger,
 * which BUG-037 showed lies about background agents):
 *   1. a real background subagent is dispatched and OUTLIVES its turn (checked,
 *      not assumed: the file keeps growing after `turn-end`);
 *   2. the driving socket is dropped the way the real client drops it (trial 1
 *      the explicit `{type:'close'}` + `ws.close()`, trial 2 a RAW `ws.close()`,
 *      alternating — both decision sites are covered);
 *   3. THE FIX: the session DETACHES instead of closing (it stays in the live
 *      registry, the server logs the lifetime reason, the broker never goes to
 *      `draining`), and the agent RUNS TO COMPLETION (its `DONE` marker lands);
 *   4. NO LEAK: once the background work ends, the re-armed close-on-detach fuse
 *      closes the session and reaps the broker (registry entry gone, broker and
 *      CLI pids dead);
 *   5. CONTROL: a session with NO live agents still closes and reaps on the very
 *      same close sequence — the fix did not turn every close into a leak.
 *
 * PRE-FIX EXPECTATION (the non-vacuous half): checks 3 and 4's first half fail —
 * the session vanishes from the registry at the close millisecond, the broker
 * flips to `draining`, and the heartbeat stops ~150s later with no `DONE`.
 *
 * SAFETY: free port, scratch dataDir + scratch CLAUDE_PROJECTS_DIR + scratch
 * project cwd, everything killed BY PID. :4317 and the user's real service are
 * never touched. Requires `systemd-run --user` — survival is the mechanism under
 * test (the broker is what holds the 150s SIGTERM).
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
const RUNS = numArg('runs', 3);
/** Seconds of heartbeat. MUST exceed (close delay + the broker's 150s fuse). */
const BEATS = numArg('beats', 240);

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bg43-data-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bg43-work-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bg43-store-'));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  ok ? pass++ : (fail++, failures.push(name));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_BG43_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;

let server = null;
let serverLog = '';
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function openWs() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const events = [];
    ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
    ws.once('open', () => res({ ws, events, send: (o) => ws.send(JSON.stringify(o)) }));
    ws.once('error', rej);
  });
}
const waitEv = async (events, pred, ms = 240_000, from = 0) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = events.slice(from).find(pred);
    if (hit) return hit;
    await sleep(200);
  }
  return null;
};
const sessionsList = async () => {
  try { return (await (await fetch(`${BASE}/api/sessions`)).json()).sessions ?? []; } catch { return []; }
};
const inRegistry = async (sid) => (await sessionsList()).some((s) => s.sdkSessionId === sid);

/** The EXACT sequence public/app.js closeSocket() sends on every switch/New/reopen. */
function clientCloseSocket(conn) {
  try { conn.ws.send(JSON.stringify({ type: 'close' })); conn.ws.close(); } catch { /* gone */ }
}
/** A raw tab-close / crash — no explicit command, just the socket dropping. */
function rawCloseSocket(conn) {
  try { conn.ws.close(); } catch { /* gone */ }
}

const hostsDir = () => path.join(DATA, 'session-hosts');
function hostStatuses() {
  try {
    return fs.readdirSync(hostsDir()).filter((f) => f.endsWith('.json') && !f.endsWith('.ctl.json'))
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(hostsDir(), f), 'utf8')); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
/**
 * The broker minding a given session, matched on the station session id the
 * broker itself records. A MISSING record means the broker exited and cleaned up
 * after itself (BUG-023) — i.e. it was reaped.
 */
function hostFor(stationSessionId) {
  return hostStatuses().find((h) => h.stationSessionId === stationSessionId) ?? null;
}

const beatCount = (hb) => { try { return fs.readFileSync(hb, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
const isDone = (hb) => { try { return fs.readFileSync(hb, 'utf8').includes('DONE'); } catch { return false; } };

/**
 * One trial. Dispatches ONE real background subagent whose entire task is a
 * BEATS-second heartbeat file, ends the turn, waits, then drops the socket.
 */
async function trial(pid, i) {
  const label = `T${i + 1}`;
  const explicit = i % 2 === 0; // alternate the two decision sites
  const hb = path.join(WORK, `hb-${i + 1}.txt`);
  const cmd = `for i in $(seq 1 ${BEATS}); do date +%s.%N >> ${hb}; sleep 1; done; echo DONE >> ${hb}`;
  const c = await openWs();
  c.send({
    type: 'start', projectId: pid,
    overrides: { model: 'haiku', permissionMode: 'bypassPermissions' },
    prompt:
      'Dispatch ONE subagent with the Task/Agent tool, subagent_type "general-purpose", and ' +
      'run_in_background set to true. Its entire task is to run this one Bash command verbatim ' +
      `and nothing else:\n\n${cmd}\n\n` +
      'Do NOT run that command yourself and do NOT wait for the agent. The moment you have ' +
      'dispatched it, finish your turn by replying with exactly: BG-DISPATCHED',
  });
  const ack = await waitEv(c.events, (e) => e.t === 'ack' && e.of === 'start', 180_000);
  const init = await waitEv(c.events, (e) => e.t === 'session-init', 180_000);
  if (!init || !ack) throw new Error(`[${label}] session never initialised`);
  const stationId = ack.stationSessionId;
  const started = await waitEv(c.events, (e) => e.t === 'agent-started', 180_000);
  const end = await waitEv(c.events, (e) => e.t === 'turn-end', 180_000);
  const endAt = Date.now();

  // PRECONDITION, measured not assumed: the work OUTLIVES the turn.
  const beatsAtEnd = beatCount(hb);
  await sleep(10_000);
  const beatsBeforeClose = beatCount(hb);

  const key = init.sessionId;
  const hostBefore = hostFor(stationId);
  const logBefore = serverLog.length;
  if (explicit) clientCloseSocket(c); else rawCloseSocket(c);
  const closedAt = Date.now();
  await sleep(1500);

  const listedAfterClose = await inRegistry(key);
  const hostAfter = hostFor(stationId);
  const detachLogged = serverLog.slice(logBefore).includes('work outlives the turn');

  // The load-bearing wait: the agent must reach its own DONE marker. Pre-fix the
  // heartbeat stops ~150s after the close and DONE never lands.
  // While waiting, SAMPLE the broker's own state. This covers the CLOSE-ON-
  // DETACH fuse (armed 3s after the detached session's `result`, re-checked on
  // a loop — agent-bridge.ts #armDetachedClose): a close routes through
  // `gracefulReap()`, which writes `state:'draining'` FIRST, so a 240s window
  // with no `draining` sample is direct evidence the fuse declined for the
  // whole run. NOTE this window does NOT arm the broker's ABANDON net
  // (CLAUDE_STATION_HOST_ABANDON_MS): a ws drop is server-side only — the
  // server-to-broker unix socket stays connected. That fuse gets its own
  // direct broker-level section below.
  const deadline = closedAt + (BEATS * 1000) + 90_000;
  let done = false;
  const brokerStates = new Set();
  while (Date.now() < deadline) {
    brokerStates.add(hostFor(stationId)?.state ?? 'no-status-file');
    if (isDone(hb)) { done = true; break; }
    await sleep(2000);
  }
  const drainedDuringWait = brokerStates.has('draining') || brokerStates.has('no-status-file');
  const beatsFinal = beatCount(hb);
  const cutAfterCloseMs = done ? null : Math.round((Date.now() - closedAt) / 1000);

  // NO LEAK: once the background level empties, the re-armed fuse must close the
  // detached session and reap its broker.
  let reaped = false;
  const reapDeadline = Date.now() + 90_000;
  while (Date.now() < reapDeadline) {
    if (!(await inRegistry(key))) { reaped = true; break; }
    await sleep(1000);
  }
  // The reap is graceful: stdin EOF first, and the CLI may legitimately finish
  // a final notification-wake turn before exiting; the broker's own escalation
  // (force-EOF 90s, SIGTERM 150s, SIGKILL 160s — session-host.mjs gracefulReap)
  // is the hard bound. The window covers that bound: what is being proven is
  // "the reap HAPPENS and completes", not that it is instant.
  let hostPidsGone = false;
  let hostEnd = hostFor(stationId);
  const pidDeadline = Date.now() + 200_000;
  while (Date.now() < pidDeadline) {
    hostEnd = hostFor(stationId);
    if (!hostEnd || (!pidAlive(hostEnd.hostPid) && (hostEnd.claudePid == null || !pidAlive(hostEnd.claudePid)))) {
      hostPidsGone = true; break;
    }
    await sleep(1000);
  }

  return {
    label, explicit, sdkSessionId: key, stationId, hadBroker: !!hostBefore,
    agentStarted: !!started, turnEnded: !!end,
    beatsAtEnd, beatsBeforeClose, beatsFinal, done, cutAfterCloseMs,
    brokerStates: [...brokerStates], drainedDuringWait,
    listedAfterClose, detachLogged, reaped, hostPidsGone,
    hostStateAfterClose: hostAfter?.state ?? (hostBefore ? 'status-file-gone (broker exited)' : 'no-broker'),
    turnToCloseMs: closedAt - endAt,
  };
}

async function control(pid) {
  const c = await openWs();
  c.send({
    type: 'start', projectId: pid,
    overrides: { model: 'haiku', permissionMode: 'bypassPermissions' },
    prompt: 'Reply with exactly the word: IDLEDONE. Do not use any tools.',
  });
  const ack = await waitEv(c.events, (e) => e.t === 'ack' && e.of === 'start', 180_000);
  const init = await waitEv(c.events, (e) => e.t === 'session-init', 180_000);
  if (!init || !ack) throw new Error('control session never initialised');
  const end = await waitEv(c.events, (e) => e.t === 'turn-end', 180_000);
  await sleep(600);
  const key = init.sessionId;
  const host = hostFor(ack.stationSessionId);
  clientCloseSocket(c);
  let gone = false;
  for (let i = 0; i < 60 && !gone; i++) { if (!(await inRegistry(key))) { gone = true; break; } await sleep(500); }
  // The broker must actually be reaped — not just deregistered.
  let brokerGone = false;
  for (let i = 0; i < 90 && !brokerGone; i++) {
    const h = hostFor(ack.stationSessionId);
    if (!h || !pidAlive(h.hostPid)) { brokerGone = true; break; }
    await sleep(1000);
  }
  return { turnEnded: !!end, hadBroker: !!host, gone, brokerGone };
}

/* -------------------------------------------------------------------------- *
 * THE BROKER'S ABANDON NET (CLAUDE_STATION_HOST_ABANDON_MS) — direct test.
 *
 * A ws drop never arms this fuse (the server keeps its unix-socket connection
 * to the broker), so it is tested at its OWN level: session-host.mjs is spawned
 * directly (no systemd, no server, no real CLI) minding a FAKE CLI that speaks
 * just enough stream-json, with a tiny ABANDON_MS and no client ever connecting
 * — the exact "server died and never came back" scenario.
 *
 *  GUARDED: the fake CLI reports a live background task. Pre-fix the net fires
 *  unconditionally at ABANDON_MS and reaps (status 'draining', stdin EOF, CLI
 *  dies). Post-fix the net DECLINES and re-arms for as long as the level says
 *  work is live — the CLI must still be alive after many fuse windows — and
 *  then reaps NORMALLY once the level empties (bounded: no leak).
 *
 *  CONTROL: a fake CLI that never emits the signal is reaped at the first
 *  expiry, byte-identical to pre-BUG-043 behaviour.
 * -------------------------------------------------------------------------- */
const FAKE_CLI = path.join(WORK, 'fake-cli.mjs');
fs.writeFileSync(FAKE_CLI, `
import * as fs from 'node:fs';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
say({ type: 'system', subtype: 'init', session_id: 'fake-sdk-' + process.pid });
say({ type: 'result', subtype: 'success' }); // midTurn=false, like a real idle CLI
if (process.env.FAKE_EMIT_BG === '1') {
  say({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg-1', task_type: 'local_agent' }] });
  say({ type: 'result', subtype: 'success' });
}
const flag = process.env.FAKE_EMPTY_FLAG;
const iv = setInterval(() => {
  if (flag && fs.existsSync(flag)) {
    clearInterval(iv);
    say({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    say({ type: 'result', subtype: 'success' });
  }
}, 300);
process.stdin.on('end', () => process.exit(0)); // stdin EOF = the broker reaped us
process.stdin.resume();
`);

async function brokerAbandonSection() {
  console.log('\n=== BROKER ABANDON NET (direct, fake CLI, ABANDON_MS=2000, no client ever connects) ===');
  const HOST_SCRIPT = path.join(ROOT, 'src', 'server', 'session-host.mjs');
  const mk = (name, env) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cs-bg43-broker-${name}-`));
    const ctl = path.join(dir, 'ctl.json');
    const statusPath = path.join(dir, 'status.json');
    fs.writeFileSync(ctl, JSON.stringify({
      sock: path.join(dir, 'host.sock'), status: statusPath, errlog: path.join(dir, 'host.err'),
      command: process.execPath, args: [FAKE_CLI], meta: { stationSessionId: `fake-${name}` },
    }));
    const broker = spawn(process.execPath, [HOST_SCRIPT, ctl], {
      cwd: dir, env: { ...process.env, CLAUDE_STATION_HOST_ABANDON_MS: '2000', ...env },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    return { dir, statusPath, broker };
  };
  const readStatus = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

  // -- GUARDED: background live → the net must decline, repeatedly.
  const emptyFlag = path.join(WORK, 'bg-empty.flag');
  const g = mk('guarded', { FAKE_EMIT_BG: '1', FAKE_EMPTY_FLAG: emptyFlag });
  await sleep(1000);
  const gCli = readStatus(g.statusPath)?.claudePid ?? null;
  await sleep(11_000); // > 5 fuse windows
  const gStatus = readStatus(g.statusPath);
  check('ABANDON (guarded): after 12s at ABANDON_MS=2000 the broker has NOT reaped its CLI (background work declared live)',
    !!gStatus && gStatus.state === 'running' && gCli != null && pidAlive(gCli),
    { brokerState: gStatus?.state ?? 'status-file-gone', cliAlive: gCli != null && pidAlive(gCli) });

  // -- BOUNDED: the level empties → the very next expiry reaps normally.
  fs.writeFileSync(emptyFlag, '1');
  let gReaped = false;
  const gDeadline = Date.now() + 15_000;
  while (Date.now() < gDeadline) {
    if (!fs.existsSync(g.statusPath) && (gCli == null || !pidAlive(gCli))) { gReaped = true; break; }
    await sleep(500);
  }
  check('ABANDON (bounded, no leak): once the background level EMPTIES, the next expiry reaps — CLI dead, status file removed',
    gReaped, { statusFileGone: !fs.existsSync(g.statusPath), cliDead: gCli == null || !pidAlive(gCli) });

  // -- CONTROL: no signal ever → first expiry reaps, exactly the old behaviour.
  const c = mk('control', {});
  await sleep(1000);
  const cCli = readStatus(c.statusPath)?.claudePid ?? null;
  let cReaped = false;
  const cDeadline = Date.now() + 12_000;
  while (Date.now() < cDeadline) {
    if (!fs.existsSync(c.statusPath) && (cCli == null || !pidAlive(cCli))) { cReaped = true; break; }
    await sleep(500);
  }
  check('ABANDON (control): a CLI that never reports background work is still reaped at the first expiry (no regression)',
    cReaped, { statusFileGone: !fs.existsSync(c.statusPath), cliDead: cCli == null || !pidAlive(cCli) });

  for (const x of [g, c]) {
    stopByPid(x.broker);
    fs.rmSync(x.dir, { recursive: true, force: true });
  }
}

async function main() {
  if (spawnSync('systemd-run', ['--version'], { encoding: 'utf8' }).status !== 0) {
    console.error('FATAL: this harness needs `systemd-run --user` — the broker holds the 150s fuse under test.');
    process.exitCode = 1;
    return;
  }
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (d) => {
    serverLog += String(d);
    if (process.env.VERIFY_BG43_DEBUG) process.stderr.write(`  [server] ${d}`);
  });
  server.stderr?.on('data', (d) => { serverLog += String(d); process.stderr.write(`  [server!] ${d}`); });
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: WORK, name: 'bug043-bg-detach' }),
  })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  await (await fetch(`${BASE}/api/projects/${pid}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'haiku', permissionMode: 'bypassPermissions' }),
  })).json();

  await brokerAbandonSection();

  console.log(`\n=== ARM C reproduction — ${RUNS} concurrent trials, ${BEATS}s background agent each ===`);
  const results = await Promise.all(Array.from({ length: RUNS }, (_, i) => trial(pid, i)));
  for (const r of results) {
    console.log(`\n-- ${r.label} (${r.explicit ? 'explicit {type:close}' : 'raw ws.close()'}) --`);
    check(`[${r.label}] PRECONDITION: a real background subagent was dispatched, the turn ended, and a survival broker exists`,
      r.agentStarted && r.turnEnded && r.hadBroker,
      { agentStarted: r.agentStarted, turnEnded: r.turnEnded, broker: r.hadBroker });
    check(`[${r.label}] PRECONDITION: the work OUTLIVES the turn (heartbeat still growing 10s after turn-end)`,
      r.beatsBeforeClose > r.beatsAtEnd, { atTurnEnd: r.beatsAtEnd, beforeClose: r.beatsBeforeClose });
    check(`[${r.label}] THE FIX (decision): the session DETACHED on the socket drop instead of closing`,
      r.listedAfterClose && r.detachLogged,
      { stillInRegistry: r.listedAfterClose, serverLoggedLifetimeReason: r.detachLogged, brokerState: r.hostStateAfterClose });
    check(`[${r.label}] THE FIX (no reap): the broker was NOT put into 'draining' by the close`,
      r.hostStateAfterClose !== 'draining' && r.hostStateAfterClose !== 'file-gone', { brokerState: r.hostStateAfterClose });
    check(`[${r.label}] CLOSE-ON-DETACH FUSE: no reap for the whole ${BEATS}s window — the 3s fuse declined while background work was live`,
      !r.drainedDuringWait, { brokerStatesObserved: r.brokerStates });
    check(`[${r.label}] LOAD-BEARING: the background agent RAN TO COMPLETION after the socket closed`,
      r.done, r.done
        ? { done: true, beats: r.beatsFinal, of: BEATS }
        : { done: false, beats: r.beatsFinal, of: BEATS, cutAtSecondsAfterClose: r.cutAfterCloseMs });
    check(`[${r.label}] NO LEAK: the detached session closed itself once the background work ended`,
      r.reaped && r.hostPidsGone, { leftRegistry: r.reaped, brokerAndCliDead: r.hostPidsGone });
  }

  console.log('\n=== CONTROL: a session with NO live agents still closes and reaps ===');
  const ctl = await control(pid);
  check('CONTROL PRECONDITION: the control session finished a turn and had a real broker',
    ctl.turnEnded && ctl.hadBroker, ctl);
  check('CONTROL (regression guard): the idle session LEAVES the registry on the same close sequence',
    ctl.gone, ctl);
  check('CONTROL (no zombie): its broker is actually reaped, not left running',
    ctl.brokerGone, ctl);

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
  stopByPid(server);
  setTimeout(() => {
    for (const d of [DATA, WORK, STORE]) fs.rmSync(d, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }, 2500);
});
