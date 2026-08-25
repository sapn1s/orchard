/**
 * BUG-033 — a bridge may not claim `busy` without a live process behind it.
 *
 *   node scripts/verify-zombie-busy.mjs
 *
 * THE REAL SHAPE, not a simulation. Every scenario drives a REAL haiku session
 * on a scratch server (free port, scratch dataDir; :4317 and the real service
 * are never touched) and then KILLS THE CLI CHILD BY PID mid-turn, so the
 * stream half-dies with NO terminal frame — exactly how the reported incident
 * happened. Nothing here calls an internal setter to fake `busy`.
 *
 * A — GROUND TRUTH (survival on: the broker records the CLI's pid).
 *   Tab open on a detached, genuinely-busy session; kill the CLI.
 *   a) the UI settles honestly within the window (no forever-◐)
 *   b) the message typed afterwards is DELIVERED for real (the dead bridge is
 *      dropped and the session resumes from disk) — never swallowed
 *   c) the queue never becomes a black hole (nothing left parked in it)
 *   e) /api/health and `npm run doctor` agree with the UI
 *   …plus the honest turn clock: the reattached tab shows the turn's REAL age
 *   (server-reported), and never a fabricated stopwatch.
 *
 * B — FALSE-POSITIVE GUARD (the check that keeps the fix from being worse than
 *   the bug). Same setup, but NOTHING is killed and the frameless window is
 *   shrunk to 8s while the turn sits inside a genuinely long, SILENT tool call
 *   for far longer than that. Ground truth (the CLI's pid) must beat the timer:
 *   the session survives many sweeps and its turn completes normally, marker on
 *   disk. Frames flowing (a streaming turn) must equally never be reaped.
 *
 * C — THE SDK-OWNED CHILD (CLAUDE_STATION_SURVIVE=0 → no pid to check, the
 *   honest 'unknown' probe). Same kill, driven through the real UI: the tab must
 *   still settle and the typed message must still end up somewhere the user can
 *   see it.
 *
 * D — THE TIMER BACKSTOP + HONEST REFUSAL: an engine with no checkable pid whose
 *   stream WEDGES rather than dies (the CodexRuntime verification seam's
 *   documented HANG turn). Silence past the window drops the stale bridge, and
 *   because silence is evidence and not proof, a message riding in is REFUSED
 *   retryably — never queued, and never raced onto the transcript by a second
 *   engine — with the text handed back to the composer (BUG-029).
 *
 * E — SECOND FALSE-POSITIVE GUARD: a turn blocked on an unanswered permission
 *   card is silent by construction and perfectly healthy. It must survive the
 *   timer (with the card intact) however long the user takes to answer.
 *
 * PRE-FIX this reproduces the incident: `busy` stuck true forever, the UI stuck
 * on ◐ with a fabricated clock, and the typed message silently queued.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const ASSETS = path.join(ROOT, 'docs', 'bugs', 'assets');
const BRAVE = process.env.QA_BRAVE_PATH ?? '/usr/bin/brave';

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

/* ------------------------------------------------------------ scratch server */

const servers = new Set();
const tmpDirs = new Set();
function mkTmp(tag) { const d = fs.mkdtempSync(path.join(os.tmpdir(), `cs-b33-${tag}-`)); tmpDirs.add(d); return d; }
function storeFor(workDir) {
  const s = path.join(os.homedir(), '.claude', 'projects', workDir.replace(/[^a-zA-Z0-9]/g, '-'));
  tmpDirs.add(s);
  return s;
}

function startServer(port, dataDir, env = {}) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: dataDir, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const log = [];
  child.stderr?.on('data', (d) => { log.push(String(d)); });
  servers.add(child);
  child.__log = log;
  return child;
}
/** Kill by PID only — never pkill (this machine also runs the user's real server). */
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
  servers.delete(child);
}

async function waitHealth(port, ms = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* not up */ }
    await sleep(250);
  }
  return false;
}
const health = async (port) => (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json());

async function registerProject(port, workDir, name) {
  const reg = await (await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: workDir, name }),
  })).json();
  if (!reg.project?.id) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  // PROJECT-level (not per-start) so a page-driven resume inherits them too.
  await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(reg.project.id)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { permissionMode: 'bypassPermissions', model: 'haiku' } }),
  });
  return reg.project.id;
}

/* ------------------------------------------------------------------- ws/api */

function openWs(port) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const events = [];
    ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
    ws.once('open', () => res({ ws, events, send: (o) => ws.send(JSON.stringify(o)) }));
    ws.once('error', rej);
  });
}
const waitEv = async (events, pred, ms = 120000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = events.find(pred);
    if (hit) return hit;
    await sleep(200);
  }
  return null;
};

/** A long, SILENT tool call: the one legitimately frameless stretch of a turn. */
const SLEEP_TOOL = (tag, secs) =>
  `Call the Bash tool exactly once, with description exactly ${tag} and command: ` +
  `python3 -c 'import time; time.sleep(${secs})' . Wait for it to finish, then reply exactly ${tag}-DONE.`;

/** Drive a real turn to the point where its tool call is genuinely in flight. */
async function driveBusyTurn(port, projectId, prompt) {
  const c = await openWs(port);
  c.send({ type: 'start', projectId, prompt });
  const init = await waitEv(c.events, (e) => e.t === 'session-init', 120000);
  if (!init) throw new Error('session never initialised');
  const tool = await waitEv(c.events, (e) => e.t === 'tool-call' && e.name === 'Bash', 120000);
  if (!tool) throw new Error('the turn never reached its tool call');
  return { c, sdkSessionId: init.sessionId };
}

/** The CLI pid, from the server's own ground-truth self-report. */
function cliPidOf(h, sdkSessionId) {
  const s = (h.sessions ?? []).find((x) => x.sdkSessionId === sdkSessionId);
  return s?.broker?.claudePid ?? null;
}
/** No broker (survival off) → find the SDK's own child by its argv. */
function findCliPidByArgv(sdkStoreDir) {
  const r = spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' });
  for (const line of r.stdout.split('\n')) {
    if (!line.includes('claude-agent-sdk') || !line.includes('--output-format stream-json')) continue;
    if (sdkStoreDir && !line.includes(sdkStoreDir)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (Number.isInteger(pid)) return pid;
  }
  return null;
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

/* ------------------------------------------------------------------ browser */

const READ_UI = () => ({
  busy: window.__station.state.busy,
  turnStartedAt: window.__station.state.turnStartedAt,
  turnStartUnknown: window.__station.state.turnStartUnknown,
  clock: document.querySelector('#stripClk')?.textContent ?? null,
  // The strip is hidden when nothing runs; a row inside a hidden strip is not
  // 'on screen', so visibility is part of the claim.
  mainRowRunning: !document.querySelector('#strip')?.hidden && !!document.querySelector('#stripRows .lag.main.run'),
  queue: window.__station.state.queue.map((q) => ({ text: q.text.slice(0, 40), dead: q.dead })),
  composer: document.querySelector('#prompt')?.value ?? '',
  fine: document.querySelector('#fine')?.textContent ?? '',
  bodyText: document.body.textContent.slice(-4000),
});
async function pollUi(page, pred, ms) {
  const t0 = Date.now();
  let ui = null;
  while (Date.now() - t0 < ms) {
    try { ui = await page.evaluate(READ_UI); } catch { /* navigating */ }
    if (ui && pred(ui)) return { ok: true, ui };
    await sleep(600);
  }
  return { ok: false, ui };
}
async function openTab(browser, port, projectId, sdkSessionId, encodedDir) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/#/project/${encodeURIComponent(projectId)}/session/${encodeURIComponent(sdkSessionId)}?dir=${encodeURIComponent(encodedDir)}`);
  await page.waitForFunction(() => window.__station && document.querySelector('#prompt'), undefined, { timeout: 25000 });
  await sleep(2500); // let openSession finish its liveness probe
  return page;
}
async function typeAndSend(page, text) {
  await page.fill('#prompt', text);
  await page.focus('#prompt');
  await page.keyboard.press('Enter');
}

/* --------------------------------------------------------------------- main */

let browser = null;

async function scenarioA() {
  console.log('\n===== A — ground truth: CLI killed mid-turn, tab open (a,b,c,e + honest clock) =====');
  const port = await freePort();
  const DATA = mkTmp('a-data');
  const WORK = mkTmp('a-work');
  const STORE = storeFor(WORK);
  const ENCODED = WORK.replace(/[^a-zA-Z0-9]/g, '-');
  // Sweep fast so the test is minutes, not hours. The frameless window stays at
  // its 10-minute default: scenario A must be settled by GROUND TRUTH (the dead
  // pid) and by nothing else — if the timer could reach it, the check would be
  // vacuous.
  const srv = startServer(port, DATA, { CLAUDE_STATION_REAP_SWEEP_MS: '4000' });
  if (!(await waitHealth(port))) throw new Error('scratch server never became healthy');
  const projectId = await registerProject(port, WORK, 'b33-a');

  const { c, sdkSessionId } = await driveBusyTurn(port, projectId, SLEEP_TOOL('KEEPBUSY', 300));
  const h0 = await health(port);
  const s0 = h0.sessions.find((x) => x.sdkSessionId === sdkSessionId);
  check('PRECONDITION: a real turn is genuinely in flight with a live CLI behind it',
    s0?.busy === true && s0?.processAlive === 'alive' && s0?.liveness?.live === true,
    { busy: s0?.busy, processAlive: s0?.processAlive, liveness: s0?.liveness });
  const turnStartedAt = s0?.turnStartedAt ?? 0;
  check('the server reports an honest turnStartedAt for the in-flight turn',
    Number.isFinite(turnStartedAt) && turnStartedAt > 0 && Date.now() - turnStartedAt < 10 * 60_000, { turnStartedAt });

  try { c.ws.close(); } catch { /* detach, not close — the turn keeps running */ }
  await sleep(1500);

  // The tab a returning user opens: it reads the session as live off the bridge
  // (the BUG-004 union) — the exact path that used to render the zombie.
  const page = await openTab(browser, port, projectId, sdkSessionId, ENCODED);
  const live = await pollUi(page, (ui) => ui.busy === true, 30000);
  check('the reopened tab reflects the RUNNING session (BUG-004 live-bridge override intact)', live.ok, {
    busy: live.ui?.busy, clock: live.ui?.clock,
  });
  // BUG-033 point 5: the clock is the SERVER's turn start, not a fresh stamp.
  const drift = Math.abs((live.ui?.turnStartedAt ?? 0) - turnStartedAt);
  check('the turn clock is the turn\'s REAL age, not a stopwatch started at reopen (no fake stamp)',
    drift < 1500 && live.ui?.turnStartUnknown === false,
    { serverTurnStartedAt: turnStartedAt, tabTurnStartedAt: live.ui?.turnStartedAt, driftMs: drift, clock: live.ui?.clock });
  await page.screenshot({ path: path.join(ASSETS, 'BUG-033-live-before-kill.png') });

  // ---- THE KILL: the CLI child dies mid-turn. No terminal frame is ever sent.
  const victim = cliPidOf(h0, sdkSessionId);
  check('PRECONDITION: the CLI pid is known from ground truth and alive', !!victim && pidAlive(victim), { claudePid: victim });
  process.kill(victim, 'SIGKILL');
  const killedAt = Date.now();
  for (let i = 0; i < 40 && pidAlive(victim); i++) await sleep(250); // reaping the corpse takes a tick
  check('PRECONDITION: the CLI is dead and NO terminal frame reached the bridge', !pidAlive(victim), { claudePid: victim, alive: pidAlive(victim) });

  // (a) the UI settles honestly, within the window.
  const settled = await pollUi(page, (ui) => ui.busy === false && !ui.mainRowRunning, 90000);
  check('(a) THE FIX: the UI settles to an honest not-running state — no forever-◐',
    settled.ok, { busy: settled.ui?.busy, mainRowRunning: settled.ui?.mainRowRunning, afterMs: Date.now() - killedAt });
  check('(a) …and it settled from GROUND TRUTH, far inside the frameless window (not the timer)',
    settled.ok && Date.now() - killedAt < 90_000, { settledAfterMs: Date.now() - killedAt, framelessWindowMs: 600_000 });
  await page.screenshot({ path: path.join(ASSETS, 'BUG-033-settled-after-kill.png') });

  // (e) health + doctor agree with the UI.
  const h1 = await health(port);
  check('(e) /api/health agrees: the zombie bridge is gone', (h1.sessions ?? []).every((x) => x.sdkSessionId !== sdkSessionId),
    { liveBridges: h1.liveBridges, sessions: h1.sessions.map((x) => x.state) });
  const doc = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'station-doctor.mjs'), '--port', String(port)], {
    encoding: 'utf8', env: { ...process.env, CLAUDE_STATION_DATA: DATA }, timeout: 30000,
  });
  const docOut = `${doc.stdout ?? ''}${doc.stderr ?? ''}`;
  check('(e) doctor agrees too: it does not report this session as running', !docOut.includes(sdkSessionId),
    docOut.split('\n').filter((l) => l.trim()).slice(0, 4).join(' | ') || '(no output)');
  const reaped = srv.__log.join('').includes('reaping zombie session');
  check('the reaper announced the drop in the server log (an honest event, not a silent vanish)', reaped,
    srv.__log.join('').split('\n').filter((l) => l.includes('reaping')).join(' | ').slice(0, 200) || '(not logged)');

  // (b)+(c) the message the user types NOW must really be delivered.
  await typeAndSend(page, 'Reply with exactly: AFTER-KILL-OK');
  const delivered = await pollUi(page, (ui) => ui.bodyText.includes('AFTER-KILL-OK') && ui.busy === false, 180000);
  check('(b) THE FIX: a message sent after the kill is DELIVERED for real (never swallowed)',
    delivered.ok, { sawReply: delivered.ui?.bodyText.includes('AFTER-KILL-OK'), busy: delivered.ui?.busy, fine: delivered.ui?.fine });
  check('(c) the queue is not a black hole: nothing is parked in it', (delivered.ui?.queue ?? []).length === 0, delivered.ui?.queue);
  check('(b) the composer is empty — the message left it because it was actually sent', (delivered.ui?.composer ?? '') === '',
    { composer: delivered.ui?.composer });
  await page.screenshot({ path: path.join(ASSETS, 'BUG-033-message-delivered.png') });
  await page.close();
  stopByPid(srv);
}

async function scenarioB() {
  console.log('\n===== B — FALSE-POSITIVE GUARD: a genuinely long turn must NOT be reaped =====');
  const port = await freePort();
  const DATA = mkTmp('b-data');
  const WORK = mkTmp('b-work');
  const STORE = storeFor(WORK);
  // The window is shrunk to 8s and the turn then sits SILENT inside one long
  // tool call for ~75s — an order of magnitude past it. If the timer could ever
  // outrank ground truth, this session would be killed many times over.
  const srv = startServer(port, DATA, { CLAUDE_STATION_REAP_SWEEP_MS: '2000', CLAUDE_STATION_FRAMELESS_MS: '8000' });
  if (!(await waitHealth(port))) throw new Error('scratch server never became healthy');
  const projectId = await registerProject(port, WORK, 'b33-b');
  const { c, sdkSessionId } = await driveBusyTurn(port, projectId, SLEEP_TOOL('LONGCALL', 75));

  const framesBefore = c.events.length;
  const t0 = Date.now();
  let minSilentMs = 0;
  let everReaped = false;
  while (Date.now() - t0 < 60000) {
    await sleep(3000);
    const h = await health(port);
    const s = h.sessions.find((x) => x.sdkSessionId === sdkSessionId);
    if (!s || s.busy !== true) { everReaped = true; break; }
    minSilentMs = Math.max(minSilentMs, Date.now() - (s.lastFrameAt ?? Date.now()));
  }
  check('the turn really did go SILENT for far longer than the 8s frameless window',
    minSilentMs > 20000, { longestSilenceMs: minSilentMs, framelessWindowMs: 8000 });
  check('FALSE-POSITIVE GUARD: the genuinely-running turn was NOT reaped (ground truth beats the timer)',
    !everReaped, { reaped: everReaped, sweepsSurvived: Math.floor(60000 / 2000) });
  const hMid = await health(port);
  const sMid = hMid.sessions.find((x) => x.sdkSessionId === sdkSessionId);
  check('…and the server says why: the CLI pid is verified alive', sMid?.processAlive === 'alive' && sMid?.liveness?.live === true,
    { processAlive: sMid?.processAlive, liveness: sMid?.liveness });

  // The definitive proof it was unharmed: the turn finishes normally.
  const end = await waitEv(c.events, (e) => e.t === 'turn-end', 240000);
  const gotMarker = c.events.some((e) => e.t === 'text' && String(e.text ?? '').includes('LONGCALL-DONE'));
  check('FALSE-POSITIVE GUARD: the long turn COMPLETED normally after surviving the sweeps',
    !!end && end.interrupted === false && gotMarker, { turnEnd: end && { subtype: end.subtype, interrupted: end.interrupted }, marker: gotMarker });

  // A chatty turn (frames flowing) must equally never be reaped.
  c.send({ type: 'send', prompt: 'Write a 400-word story about a lighthouse, then end with exactly LIGHTHOUSE-DONE' });
  const end2 = await waitEv(c.events, (e) => e.t === 'turn-end' && e !== end, 240000);
  const chatty = c.events.length - framesBefore;
  check('FALSE-POSITIVE GUARD: a streaming turn (frames flowing) also runs to completion untouched',
    !!end2 && end2.interrupted === false && c.events.some((e) => e.t === 'text' && String(e.text ?? '').includes('LIGHTHOUSE-DONE')),
    { turnEnd: end2 && { subtype: end2.subtype, interrupted: end2.interrupted }, framesSeen: chatty });
  try { c.ws.close(); } catch { /* ignore */ }
  stopByPid(srv);
}

async function scenarioC() {
  console.log('\n===== C — the SDK-owned child: a killed CLI must still settle, and the message must survive =====');
  const port = await freePort();
  const DATA = mkTmp('c-data');
  const WORK = mkTmp('c-work');
  storeFor(WORK);
  const ENCODED = WORK.replace(/[^a-zA-Z0-9]/g, '-');
  // SURVIVE=0: the SDK owns the child directly and exposes no pid, so the probe
  // must answer an honest 'unknown' — the shape where the frameless backstop is
  // the only signal available (a container session looks the same from here).
  const srv = startServer(port, DATA, {
    CLAUDE_STATION_SURVIVE: '0', CLAUDE_STATION_REAP_SWEEP_MS: '2000', CLAUDE_STATION_FRAMELESS_MS: '6000',
  });
  if (!(await waitHealth(port))) throw new Error('scratch server never became healthy');
  const projectId = await registerProject(port, WORK, 'b33-c');
  const { c, sdkSessionId } = await driveBusyTurn(port, projectId, SLEEP_TOOL('KEEPBUSY2', 300));
  const h0 = await health(port);
  const s0 = h0.sessions.find((x) => x.sdkSessionId === sdkSessionId);
  check('PRECONDITION: with no broker there is no pid to check, and the probe says so — "unknown", never a guess',
    s0?.processAlive === 'unknown', { processAlive: s0?.processAlive, survivalConfigured: s0?.survivalConfigured });

  const victim = findCliPidByArgv(WORK);
  check('PRECONDITION: the SDK\'s own CLI child was located by argv', !!victim && pidAlive(victim), { pid: victim });
  try { c.ws.close(); } catch { /* detach */ }
  const page = await openTab(browser, port, projectId, sdkSessionId, ENCODED);
  const live = await pollUi(page, (ui) => ui.busy === true, 30000);
  check('PRECONDITION: the tab shows the session as running before the kill', live.ok, { busy: live.ui?.busy });

  process.kill(victim, 'SIGKILL');
  for (let i = 0; i < 40 && pidAlive(victim); i++) await sleep(250);
  // Send IMMEDIATELY, inside the window where the server may not have noticed
  // yet: the message must end up somewhere the user can see it — delivered, or
  // back in the composer — and never parked in a queue with no boundary coming.
  await typeAndSend(page, 'MSG-MUST-SURVIVE: is anyone there?');
  const refused = await pollUi(page,
    (ui) => ui.composer.includes('MSG-MUST-SURVIVE') || ui.bodyText.includes('MSG-MUST-SURVIVE'), 90000);
  const ui = refused.ui ?? {};
  const inComposer = (ui.composer ?? '').includes('MSG-MUST-SURVIVE');
  const inQueue = (ui.queue ?? []).some((q) => q.text.includes('MSG-MUST-SURVIVE') && !q.dead);
  const delivered = (ui.bodyText ?? '').includes('MSG-MUST-SURVIVE') && !inQueue;
  check('(b) THE FIX: the message is either DELIVERED or handed back to the user — never silently swallowed',
    inComposer || delivered, { inComposer, delivered, inQueue, fine: ui.fine });
  check('(c) it is NOT sitting undelivered in a queue with no boundary coming', !inQueue, ui.queue);
  await page.screenshot({ path: path.join(ASSETS, 'BUG-033-refusal-keeps-message.png') });

  const settled = await pollUi(page, (ui2) => ui2.busy === false && !ui2.mainRowRunning, 90000);
  check('(a) the UI settles honestly here too — no forever-◐ for an SDK-owned child either', settled.ok,
    { busy: settled.ui?.busy, mainRowRunning: settled.ui?.mainRowRunning });
  const h1 = await health(port);
  check('(e) /api/health agrees: no bridge is left claiming to be busy',
    (h1.sessions ?? []).every((x) => x.busy !== true), { sessions: h1.sessions.map((x) => ({ state: x.state, busy: x.busy })) });
  await page.close();
  stopByPid(srv);
}

/**
 * D — THE TIMER BACKSTOP AND ITS DELIBERATE CAUTION.
 *
 * The one shape ground truth cannot reach: an engine whose child this process
 * does not own a pid for (probe 'unknown') AND whose stream simply stops
 * without ending — a wedged transport rather than a dead process. Built with
 * the existing CodexRuntime verification seam (CLAUDE_STATION_CODEX_BIN → the
 * scripted fake app-server) whose documented HANG marker starts a turn and
 * then goes silent forever. No mocking of station internals: a real bridge, a
 * real runtime, a real turn, real silence.
 *
 * Because silence is evidence and not proof, the disposition here is
 * deliberately NOT the same as scenario A's: the stale bridge is dropped so
 * the UI stops lying, but a message riding along is REFUSED retryably — the
 * server will not race a second engine onto a transcript it cannot prove is
 * finished (BUG-022). The user keeps their text either way, which is the whole
 * point of the ticket.
 */
async function scenarioD() {
  console.log('\n===== D — frameless backstop (no pid knowable, stream wedged) + honest retryable refusal =====');
  const port = await freePort();
  const DATA = mkTmp('d-data');
  const WORK = mkTmp('d-work');
  const FAKE = path.join(ROOT, 'scripts', 'fixtures', 'codex-fake-app-server.mjs');
  // The periodic sweep is DISABLED here on purpose: this scenario is about the
  // OTHER reaper — the liveness gate on the reattach path — so the refusal it
  // produces cannot be an artifact of a background timer winning a race.
  const srv = startServer(port, DATA, {
    CLAUDE_STATION_CODEX_BIN: FAKE, CLAUDE_STATION_REAP_SWEEP_MS: '0', CLAUDE_STATION_FRAMELESS_MS: '4000',
  });
  if (!(await waitHealth(port))) throw new Error('scratch server never became healthy');
  const projectId = await registerProject(port, WORK, 'b33-d');
  await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(projectId)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { provider: 'openai', model: null } }),
  });

  const c = await openWs(port);
  c.send({ type: 'start', projectId, prompt: 'HANG until stopped' });
  const init = await waitEv(c.events, (e) => e.t === 'session-init', 60000);
  check('PRECONDITION: a real turn started on a real runtime, then the stream went silent (HANG)', !!init, { sessionId: init?.sessionId });
  const sdkSessionId = init?.sessionId;
  await sleep(3000);
  const h0 = await health(port);
  const s0 = h0.sessions.find((x) => x.sdkSessionId === sdkSessionId);
  check('PRECONDITION: the bridge is busy with NO pid to check — the probe answers "unknown"',
    s0?.busy === true && s0?.processAlive === 'unknown', { busy: s0?.busy, processAlive: s0?.processAlive, liveness: s0?.liveness });
  check('PRECONDITION: inside the window it is still judged LIVE (the backstop does not fire early)',
    s0?.liveness?.live === true, s0?.liveness);

  // Ride a message in DURING the silence but AFTER the window has elapsed: the
  // exact moment the old code accepted-and-queued into a queue that could never
  // drain. It must be refused, retryably, with the text kept.
  await sleep(6000);
  const hMid = await health(port);
  const sMid = hMid.sessions.find((x) => x.sdkSessionId === sdkSessionId);
  check('past the window the server\'s own self-report stops vouching for it (kind: frameless)',
    sMid?.busy === true && sMid?.liveness?.live === false && sMid?.liveness?.kind === 'frameless',
    { busy: sMid?.busy, liveness: sMid?.liveness });
  const c2 = await openWs(port);
  c2.send({ type: 'start', projectId, prompt: 'DID-THIS-SURVIVE', resumeSessionId: sdkSessionId });
  const refusal = await waitEv(c2.events, (e) => e.t === 'error', 30000);
  check('(b) THE FIX: a message into an unverifiable "busy" session is REFUSED, retryably — not swallowed',
    refusal?.retryable === true && refusal?.fatal === false && /NOT delivered/.test(String(refusal?.message)),
    { retryable: refusal?.retryable, fatal: refusal?.fatal, message: String(refusal?.message ?? '').slice(0, 160) });
  const acked = c2.events.some((e) => e.t === 'ack' && e.of === 'start');
  check('…and it is refused BEFORE any start ack, so the client\'s pre-turn rollback (BUG-029) can hand the text back',
    !acked, { sawStartAck: acked });
  const h1 = await health(port);
  check('the stale bridge was dropped by the frameless backstop', (h1.sessions ?? []).every((x) => x.busy !== true),
    { sessions: h1.sessions.map((x) => ({ state: x.state, busy: x.busy })) });
  const framelessReap = srv.__log.join('').includes('(frameless)');
  check('the reap was the TIMER backstop (kind: frameless) — the branch this scenario exists to cover', framelessReap,
    srv.__log.join('').split('\n').filter((l) => l.includes('reaping')).join(' | ').slice(0, 240) || '(not logged)');
  try { c.ws.close(); c2.ws.close(); } catch { /* ignore */ }
  stopByPid(srv);
}

/**
 * E — THE SECOND FALSE-POSITIVE GUARD: a turn BLOCKED ON THE USER.
 *
 * A turn waiting for an unanswered permission / question / plan card is silent
 * by construction and perfectly healthy — the engine asked something and is
 * waiting. Where no pid is checkable (container sessions, and this Codex
 * fixture), the frameless timer would otherwise reap it for the crime of the
 * user being away from the keyboard, taking the unanswered card with it and
 * undoing BUG-008/BUG-018. A pending card is positive evidence of a live turn
 * and must outrank the timer.
 */
async function scenarioE() {
  console.log('\n===== E — FALSE-POSITIVE GUARD 2: a turn blocked on an unanswered card must NOT be reaped =====');
  const port = await freePort();
  const DATA = mkTmp('e-data');
  const WORK = mkTmp('e-work');
  const FAKE = path.join(ROOT, 'scripts', 'fixtures', 'codex-fake-app-server.mjs');
  const srv = startServer(port, DATA, {
    CLAUDE_STATION_CODEX_BIN: FAKE, CLAUDE_STATION_REAP_SWEEP_MS: '2000', CLAUDE_STATION_FRAMELESS_MS: '4000',
  });
  if (!(await waitHealth(port))) throw new Error('scratch server never became healthy');
  const projectId = await registerProject(port, WORK, 'b33-e');
  await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(projectId)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { provider: 'openai', model: null, permissionMode: 'default' } }),
  });

  const c = await openWs(port);
  c.send({ type: 'start', projectId, prompt: 'EXEC_APPROVAL please' });
  const card = await waitEv(c.events, (e) => e.t === 'approval-request', 60000);
  check('PRECONDITION: a real turn is blocked on an unanswered approval card', !!card,
    { requestId: card?.requestId, toolName: card?.toolName });

  // Sit on it for 3x the window — exactly what a user who stepped away does.
  await sleep(13000);
  const h = await health(port);
  const s = h.sessions.find((x) => x.stationSessionId && x.busy === true);
  check('FALSE-POSITIVE GUARD: after 3x the frameless window, the blocked turn is STILL alive (not reaped)',
    !!s && s.liveness?.live === true, { busy: s?.busy, liveness: s?.liveness, sessions: h.sessions.length });
  check('…and the server says WHY: it is blocked on the user, not stalled',
    /unanswered/.test(String(s?.liveness?.reason ?? '')), { reason: s?.liveness?.reason });
  const reapedAnything = srv.__log.join('').includes('reaping zombie session');
  check('nothing was reaped while the card was open (the card itself survives — BUG-008/018 intact)',
    !reapedAnything, srv.__log.join('').split('\n').filter((l) => l.includes('reaping')).join(' | ').slice(0, 200) || '(nothing reaped)');

  // Answering it must still work — proof the waiting turn was undamaged.
  c.send({ type: 'approval-response', requestId: card.requestId, allow: true });
  const end = await waitEv(c.events, (e) => e.t === 'turn-end', 60000);
  check('the answered card resumes the turn normally (the waiting turn was never damaged)',
    !!end, { turnEnd: end && { subtype: end.subtype, interrupted: end.interrupted } });
  try { c.ws.close(); } catch { /* ignore */ }
  stopByPid(srv);
}

async function main() {
  if (!fs.existsSync(BRAVE)) {
    console.error(`FATAL: browser not found at ${BRAVE} (set QA_BRAVE_PATH) — this bug is what the USER SEES, so the DOM must be asserted.`);
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(ASSETS, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: BRAVE });
  const only = process.argv[2];
  if (!only || only === 'A') await scenarioA();
  if (!only || only === 'B') await scenarioB();
  if (!only || only === 'C') await scenarioC();
  if (!only || only === 'D') await scenarioD();
  if (!only || only === 'E') await scenarioE();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(async () => {
  try { await browser?.close(); } catch { /* ignore */ }
  for (const s of [...servers]) stopByPid(s);
  await sleep(800);
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
});
