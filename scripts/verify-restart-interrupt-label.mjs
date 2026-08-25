/**
 * BUG-028 — a restart-cut turn must NOT render as "[Request interrupted by
 * user]" (a false cause: the user did nothing), while a REAL user stop must
 * still render as user-initiated.
 *
 *   node scripts/verify-restart-interrupt-label.mjs
 *
 * ROOT-CAUSE MECHANISM THIS TESTS (grounded, probe-verified):
 *   The `claude` CLI writes the literal "[Request interrupted by user]" /
 *   "…for tool use]" into the transcript in BOTH cases, but stamps the entry
 *   differently:
 *     - shutdown-cut (the CLI got a graceful signal mid-turn — a server
 *       restart/redeploy):  `interruptedByShutdown: true`
 *     - real user stop (interrupt control request): `interruptedMessageId`,
 *       and NO shutdown flag.
 *   Pre-fix, claude-station's `toMessage()` dropped the flag and the client
 *   rendered every marker as a USER bubble — the false attribution. The fix
 *   carries the flag through `/api/transcript` and renders the shutdown case
 *   as a system caption naming the real cause.
 *
 * Deploy-shaped, non-vacuous, scratch-only: its own transient `--user`
 * service (KillMode=control-group, matching production), a REAL driven haiku
 * session mid-turn, a REAL `systemctl --user stop` as the restart's kill, a
 * fresh server over the same dataDir as the restarted half, and the REAL
 * dashboard (headless Brave) for the render assertions. Never touches :4317
 * or claude-station.service; kills only by pid / its own unit.
 *
 * CASE A (the bug): the restart's control-group SIGTERM cuts the CLI mid-turn
 *   (survival disabled for this fixture — the exact mechanism that produced
 *   the live marker; a fully-scoped survivor that DRAINS writes no marker at
 *   all, so there is nothing to attribute in that path). Reattach on a fresh
 *   server: the marker message must carry `interruptedByShutdown: true` over
 *   the API, and the dashboard must render the honest restart caption, not a
 *   user bubble. FAILS PRE-FIX (flag dropped, `.you` bubble rendered).
 * CASE B (the honest case, must not break): a real `{type:'interrupt'}` stop
 *   mid-turn. The marker must carry NO shutdown flag and must still render as
 *   the user-attributed bubble.
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
const RUN_TAG = `${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-blbl-data-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-blbl-work-'));
const ENCODED_DIR = WORK.replace(/[^a-zA-Z0-9]/g, '-');
const STORE = path.join(os.homedir(), '.claude', 'projects', ENCODED_DIR);

const MARKER_RX = /^\s*\[Request interrupted by user( for tool use)?\]\s*$/;
const HONEST_CAPTION_PREFIX = '[Turn interrupted — the server restarted or shut down mid-turn';

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

/* --------------------------------------------- transient service (server 1) */

function systemdRunAvailable() {
  try {
    const r = spawnSync('systemd-run', ['--version'], { encoding: 'utf8', timeout: 4000 });
    return r.status === 0 && !!process.env.XDG_RUNTIME_DIR;
  } catch { return false; }
}

function setenvArgs(overrides) {
  const merged = { ...process.env, ...overrides };
  const args = [];
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === null) continue;
    const s = String(v);
    if (s.includes('\n') || s.includes('\0')) continue;
    args.push(`--setenv=${k}=${s}`);
  }
  return args;
}

const services = new Set();
function startServerService(unit, port) {
  services.add(unit);
  const args = [
    '--user', `--unit=${unit}`, '--quiet', '--collect',
    `--working-directory=${ROOT}`,
    // CLAUDE_STATION_SURVIVE=0: Case A NEEDS the control-group stop to reach
    // the CLI mid-turn — that graceful SIGTERM is what stamps the marker with
    // interruptedByShutdown:true (probe-verified; the FEAT-015 Phase A shape).
    ...setenvArgs({ PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_STATION_SURVIVE: '0' }),
    process.execPath, ENTRY,
  ];
  const r = spawnSync('systemd-run', args, { encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0) throw new Error(`systemd-run for ${unit} failed: ${r.stderr || r.stdout}`);
}
function stopService(unit) {
  spawnSync('systemctl', ['--user', 'stop', unit], { encoding: 'utf8', timeout: 30000 });
  spawnSync('systemctl', ['--user', 'reset-failed', unit], { encoding: 'utf8', timeout: 8000 });
  services.delete(unit);
}

/* -------------------------------------------------------------------- ws/api */

function openWs(port) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const events = [];
    ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
    ws.once('open', () => res({ ws, events, send: (o) => ws.send(JSON.stringify(o)) }));
    ws.once('error', rej);
  });
}
const waitEv = async (events, pred, ms = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = events.find(pred);
    if (hit) return hit;
    await sleep(150);
  }
  return null;
};

async function waitHealth(port, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* not up */ }
    await sleep(250);
  }
  return false;
}
async function healthGone(port, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { await fetch(`http://127.0.0.1:${port}/api/health`); } catch { return true; }
    await sleep(200);
  }
  return false;
}

async function registerProject(port) {
  const reg = await (await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: WORK, name: 'restart-label-fixture' }),
  })).json();
  if (reg.project?.id) return reg.project.id;
  throw new Error(`register failed: ${JSON.stringify(reg)}`);
}

/** Drive a slow real haiku turn; resolve once the Bash tool-call is in flight. */
async function startSlowTurn(port, projectId, tag) {
  const c = await openWs(port);
  c.send({
    type: 'start', projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' },
    prompt:
      `Do exactly these steps in order and nothing else. ` +
      // python, NOT a bare `sleep`: some dev machines run an agent-harness hook
      // that blocks standalone sleeps, which would end the turn in seconds and
      // vacuously close the mid-turn window this test cuts into.
      `Step 1: use the Bash tool to run the command: python3 -c 'import time; time.sleep(30)' . ` +
      `Step 2: after it finishes, reply with exactly: ${tag}`,
  });
  const init = await waitEv(c.events, (e) => e.t === 'session-init', 90000);
  if (!init) throw new Error('session never initialised');
  const bash = await waitEv(c.events, (e) => e.t === 'tool-call' && e.name === 'Bash', 45000);
  return { c, sdkSessionId: init.sessionId, bashSeen: !!bash };
}

/* --------------------------------------------------------------- transcripts */

function rawMarkerEntries(sdkSessionId) {
  const f = path.join(STORE, `${sdkSessionId}.jsonl`);
  const out = [];
  let lines = [];
  try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch { return out; }
  for (const l of lines) {
    if (!l.includes('[Request interrupted by user')) continue;
    try {
      const m = JSON.parse(l);
      const c = m?.message?.content;
      if (Array.isArray(c) && c.some((b) => b?.type === 'text' && MARKER_RX.test(String(b.text ?? '')))) out.push(m);
    } catch { /* partial */ }
  }
  return out;
}
async function waitRawMarker(sdkSessionId, ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hits = rawMarkerEntries(sdkSessionId);
    if (hits.length) return hits;
    await sleep(400);
  }
  return [];
}

async function apiMarkerMessage(port, sdkSessionId) {
  const r = await fetch(`http://127.0.0.1:${port}/api/transcript/${ENCODED_DIR}/${sdkSessionId}?tail=100`);
  if (!r.ok) throw new Error(`transcript HTTP ${r.status}`);
  const t = await r.json();
  const msgs = t.messages ?? [];
  const hit = msgs.find((m) => m.role === 'user' && (m.blocks ?? []).some((b) => b.type === 'text' && MARKER_RX.test(String(b.text ?? ''))));
  return { hit: hit ?? null, count: msgs.length };
}

/* ------------------------------------------------------------------ browser */

let browser = null;
async function renderInDashboard(port, projectId, sdkSessionId, shotName) {
  if (!browser) browser = await chromium.launch({ headless: true, executablePath: BRAVE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`http://127.0.0.1:${port}/#/project/${encodeURIComponent(projectId)}/session/${encodeURIComponent(sdkSessionId)}?dir=${encodeURIComponent(ENCODED_DIR)}`);
    // The transcript tail paints async; wait until either rendering of the
    // marker (bubble or caption) shows up, bounded so a pre-fix run still
    // reports instead of hanging.
    await page.waitForFunction(
      () => document.body.innerText.includes('[Request interrupted by user') || document.body.innerText.includes('[Turn interrupted —'),
      undefined, { timeout: 30000 },
    ).catch(() => { /* asserted below either way */ });
    await sleep(700); // let the tail finish painting/scrolling
    const dom = await page.evaluate(() => {
      const youWithMarker = [...document.querySelectorAll('.you')].some((n) => n.textContent.includes('[Request interrupted by user'));
      const captions = [...document.querySelectorAll('.ran-lbl')].map((n) => n.textContent.trim());
      const honestCaption = captions.find((t) => t.startsWith('[Turn interrupted — the server restarted or shut down mid-turn')) ?? null;
      return { youWithMarker, honestCaption };
    });
    await page.screenshot({ path: path.join(ASSETS, shotName) });
    return dom;
  } finally {
    await page.close().catch(() => { /* ignore */ });
  }
}

/* --------------------------------------------------------------------- main */

let server2 = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
}

async function main() {
  if (!systemdRunAvailable()) {
    console.error('FATAL: this harness requires `systemd-run --user` (production\'s service shape). Not available here.');
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(BRAVE)) {
    console.error(`FATAL: browser not found at ${BRAVE} (set QA_BRAVE_PATH) — the bug is a RENDER attribution, so the render must be asserted.`);
    process.exitCode = 1;
    return;
  }

  console.log('\n===== BUG-028 — restart-cut turn must not render as a USER interruption =====');
  console.log('\n--- CASE A: server restart cuts the turn (the observed bug) ---');
  const unit = `cs-blbl-${RUN_TAG}.service`;
  const port = await freePort();
  startServerService(unit, port);
  if (!(await waitHealth(port))) throw new Error('scratch service never became healthy');
  const projectId = await registerProject(port);

  const a = await startSlowTurn(port, projectId, 'CUT-NEVER-SAID');
  check('PRECONDITION: turn A is genuinely in-flight (Bash sleep tool-call seen)', a.bashSeen, { sdkSessionId: a.sdkSessionId });
  try { a.c.ws.close(); } catch { /* ignore */ }

  // THE RESTART: a real control-group stop — the CLI receives the graceful
  // SIGTERM mid-turn and writes the marker on its way out.
  stopService(unit);
  check('the old server is down after the control-group stop', await healthGone(port), `port ${port}`);
  const rawA = await waitRawMarker(a.sdkSessionId);
  check('PRECONDITION (CLI ground truth): the cut turn\'s marker entry is stamped interruptedByShutdown:true on disk',
    rawA.length > 0 && rawA.every((m) => m.interruptedByShutdown === true && !m.interruptedMessageId),
    rawA.length ? { entries: rawA.length, interruptedByShutdown: rawA[0].interruptedByShutdown } : 'no marker entry found on disk');

  // Reattach half of the restart: a fresh server over the same dataDir.
  const port2 = await freePort();
  server2 = spawn(process.execPath, [ENTRY], {
    cwd: ROOT, env: { ...process.env, PORT: String(port2), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_STATION_SURVIVE: '0' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server2.stderr?.on('data', (d) => process.stderr.write(`  [server2!] ${d}`));
  if (!(await waitHealth(port2))) throw new Error('restarted server never became healthy');

  // THE FIX, API layer (fails pre-fix: the flag was dropped by toMessage()).
  const apiA = await apiMarkerMessage(port2, a.sdkSessionId);
  check('THE FIX: /api/transcript carries interruptedByShutdown:true on the cut turn\'s marker message',
    !!apiA.hit && apiA.hit.interruptedByShutdown === true,
    apiA.hit ? { interruptedByShutdown: apiA.hit.interruptedByShutdown } : `marker message not in tail (${apiA.count} msgs)`);

  // THE FIX, render layer (fails pre-fix: a `.you` bubble asserts a user stop).
  const domA = await renderInDashboard(port2, projectId, a.sdkSessionId, 'BUG-028-restart-label.png');
  check('THE FIX: the dashboard renders the restart-cut break as the honest server-restart caption',
    !!domA.honestCaption, { honestCaption: domA.honestCaption });
  check('THE FIX: the restart-cut break is NOT rendered as a user bubble saying "[Request interrupted by user]"',
    domA.youWithMarker === false, { youBubbleWithMarker: domA.youWithMarker });

  console.log('\n--- CASE B: a REAL user stop must still render as user-initiated ---');
  const b = await startSlowTurn(port2, projectId, 'STOP-NEVER-SAID');
  check('PRECONDITION: turn B is genuinely in-flight (Bash sleep tool-call seen)', b.bashSeen, { sdkSessionId: b.sdkSessionId });
  b.c.send({ type: 'interrupt' });
  const end = await waitEv(b.c.events, (e) => e.t === 'turn-end', 60000);
  check('PRECONDITION: the user stop landed (turn-end with interrupted:true)', !!end && end.interrupted === true,
    end ? { interrupted: end.interrupted, subtype: end.subtype } : 'no turn-end');
  try { b.c.send({ type: 'close' }); } catch { /* ignore */ }
  await sleep(1500);
  try { b.c.ws.close(); } catch { /* ignore */ }

  const rawB = await waitRawMarker(b.sdkSessionId);
  check('CLI ground truth: the user-stop marker is NOT stamped interruptedByShutdown (carries interruptedMessageId)',
    rawB.length > 0 && rawB.every((m) => m.interruptedByShutdown !== true),
    rawB.length ? { entries: rawB.length, interruptedByShutdown: rawB[0].interruptedByShutdown ?? null, interruptedMessageId: rawB[0].interruptedMessageId ?? null } : 'no marker entry found on disk');
  const apiB = await apiMarkerMessage(port2, b.sdkSessionId);
  check('HONEST CASE INTACT: /api/transcript does NOT flag the user-stop marker as a shutdown', !!apiB.hit && apiB.hit.interruptedByShutdown !== true,
    apiB.hit ? { interruptedByShutdown: apiB.hit.interruptedByShutdown ?? null } : `marker message not in tail (${apiB.count} msgs)`);
  const domB = await renderInDashboard(port2, projectId, b.sdkSessionId, 'BUG-028-user-stop.png');
  check('HONEST CASE INTACT: a real user stop still renders as the user\'s own "[Request interrupted…]" bubble',
    domB.youWithMarker === true && !domB.honestCaption,
    { youBubbleWithMarker: domB.youWithMarker, honestCaption: domB.honestCaption });

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(async () => {
  try { await browser?.close(); } catch { /* ignore */ }
  stopByPid(server2);
  for (const unit of [...services]) stopService(unit);
  await sleep(500);
  for (const d of [DATA, WORK, STORE]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
});
