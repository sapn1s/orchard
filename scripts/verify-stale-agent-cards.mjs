/**
 * BUG-030 — agent tool-call cards must never spin ◐ forever after a host CLI
 * cut/resume, and must settle when their call really finishes.
 *
 *   node scripts/verify-stale-agent-cards.mjs
 *
 * ROOT CAUSE THIS TESTS (probe-verified on claude CLI v2.1.220):
 *   1. Every Bash call a Task-tool subagent makes is announced by the CLI as
 *      its own task (`task_started`, task_type "local_bash") — the bridge
 *      turned each into a LiveAgent row. Its ONLY terminal frame is
 *      `task_notification` with status:"completed" — there is NO task_updated
 *      for it. Pre-fix the bridge's task_notification handler dropped the
 *      status, so the row stayed `running` in #agents (and ◐ on screen, timer
 *      growing) forever — the observed 16-row list.
 *   2. When the host CLI is cut (server restart / shutdown), the terminal
 *      frames for every in-flight task die with it, and a resumed CLI
 *      re-announces NOTHING (probe-verified). An open tab that lived through
 *      the cut keeps its stale ◐ rows, and nothing ever settled them.
 *
 * THE INVARIANT (fix): a card may show ◐ only while a live process/turn can
 * actually be behind it — enforced at the terminal seam (task_notification →
 * agent-completed), at turn boundaries (client settles zombies at turn-end),
 * and on reattach (rows not re-announced by replayAgents right behind the
 * `start` ack settle as "cut by shutdown"). A genuinely-running agent must
 * still show ◐ (BUG-020's replay refreshes it before the sweep fires).
 *
 * Deploy-shaped, scratch-only (pattern of verify-restart-interrupt-label):
 * its own transient `--user` service (KillMode=control-group, the production
 * cut), a REAL driven haiku session whose subagent runs a genuinely long Bash
 * call, a REAL `systemctl --user stop` mid-call as the cut, a fresh server on
 * the SAME port so the SAME open tab (headless Brave) reconnects/resumes —
 * the exact shape of the live incident. Never touches :4317 or
 * claude-station.service; kills only by pid / its own unit.
 *
 * Checks that FAIL pre-fix:
 *   - steady state: the subagent's finished short Bash call leaves the
 *     running strip while its long one still shows ◐;
 *   - after cut+resume: the cut call is settled (not ◐) once the resumed
 *     turn's own agent is live, and the "Cut by shutdown" caption exists;
 *   - after the resumed turn ends: zero unsettled running rows.
 * Checks that must NOT break (live case): a genuinely-running agent/call
 * still shows ◐ after reattach.
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b30-data-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b30-work-'));
const ENCODED_DIR = WORK.replace(/[^a-zA-Z0-9]/g, '-');
const STORE = path.join(os.homedir(), '.claude', 'projects', ENCODED_DIR);

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
    // SURVIVE=0: the cut must actually reach the CLI mid-call (control-group
    // SIGTERM) — a fully-scoped survivor would drain the turn to completion
    // and there would be no orphaned in-flight call to go stale.
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
    body: JSON.stringify({ hostPath: WORK, name: 'stale-cards-fixture' }),
  })).json();
  if (!reg.project?.id) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  // Project-level defaults, NOT per-start overrides: the page-driven RESUME
  // after the cut starts a fresh bridge that would not inherit start-time
  // overrides — without bypassPermissions there, the resumed turn's Bash
  // calls hang on approval cards and the whole flow stalls (observed).
  const patched = await (await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(reg.project.id)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { permissionMode: 'bypassPermissions', model: 'haiku' } }),
  })).json();
  if (patched.project?.settings?.permissionMode !== 'bypassPermissions') {
    throw new Error(`project settings patch failed: ${JSON.stringify(patched)}`);
  }
  return reg.project.id;
}

/* ------------------------------------------------------------------ browser */

/** Snapshot of the live strip + agents map, as the user sees it. */
const READ_UI = () => ({
  runningRows: [...document.querySelectorAll('#stripRows .lag.run')].map((r) => ({
    ty: r.querySelector('.ty')?.textContent ?? '',
    de: r.querySelector('.de')?.textContent ?? '',
    gl: r.querySelector('.gl')?.textContent ?? '',
  })),
  // textContent, not innerText: the caption lives inside a closed <details>
  // "ran" row, which innerText (display-aware) would skip.
  cutCaption: document.body.textContent.includes('Cut by shutdown'),
  busy: window.__station.state.busy,
  unsettledRunning: [...window.__station.state.agents.values()]
    .filter((x) => !x.settled && x.agent.status === 'running')
    .map((x) => ({ ty: x.agent.agentType, de: x.agent.description })),
});

async function pollUi(page, pred, ms) {
  const t0 = Date.now();
  let ui = null;
  while (Date.now() - t0 < ms) {
    ui = await page.evaluate(READ_UI);
    if (pred(ui)) return { ok: true, ui };
    await sleep(700);
  }
  return { ok: false, ui };
}

/** A TOOL-CALL row (ty local_bash) with this tag rendered as running. The ty
 * guard matters: the subagent's own row's description also names the tags. */
const hasRun = (ui, de) => ui.runningRows.some((r) => r.ty === 'local_bash' && r.de.includes(de));
/** ANY running row (tool call or agent) still naming a cut tag. */
const anyCutRun = (ui) => ui.runningRows.some((r) => r.de.includes('CUT-A') || r.de.includes('CUT-B'));

async function typeAndSend(page, text) {
  // Real keyboard path (BUG-020 learning): while busy, #go is repainted as an
  // interrupt button, so only Enter reliably SUBMITS — matching real use.
  await page.fill('#prompt', text);
  await page.focus('#prompt');
  await page.keyboard.press('Enter');
}

/* --------------------------------------------------------------------- main */

let server2 = null;
let browser = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
}

async function main() {
  if (!systemdRunAvailable()) {
    console.error('FATAL: this harness requires `systemd-run --user` (production\'s service shape).');
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(BRAVE)) {
    console.error(`FATAL: browser not found at ${BRAVE} (set QA_BRAVE_PATH) — the bug is what the USER SEES, so the DOM must be asserted.`);
    process.exitCode = 1;
    return;
  }

  console.log('\n===== BUG-030 — tool-call cards must settle; never ◐ without a live process =====');
  const unit = `cs-b30-${RUN_TAG}.service`;
  const port = await freePort();
  startServerService(unit, port);
  if (!(await waitHealth(port))) throw new Error('scratch service never became healthy');
  const projectId = await registerProject(port);

  // ---- turn 1 (driven over ws so the tab can attach as a RE-attach later):
  // a subagent runs a short Bash call (CUT-A) then a genuinely long one
  // (CUT-B); the orchestrator's own long sleep keeps the TURN busy (the Task
  // tool is async — BUG-020 learning).
  const c = await openWs(port);
  c.send({
    type: 'start', projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' },
    prompt:
      'You MUST make exactly two tool calls, in this order, no others, before replying anything.\n' +
      'TOOL CALL 1 — Task tool, subagent_type general-purpose, prompt exactly:\n' +
      '"First call the Bash tool with description exactly CUT-A and command: python3 -c \'import time; time.sleep(4)\' . ' +
      'After it completes, call the Bash tool with description exactly CUT-B and command: python3 -c \'import time; time.sleep(240)\' . ' +
      'After it completes, reply done."\n' +
      'TOOL CALL 2 — Bash tool, yourself, IMMEDIATELY after tool call 1 returns (it returns instantly; do NOT wait for the agent): ' +
      "description exactly KEEPBUSY, command: python3 -c 'import time; time.sleep(240)' . Wait for it to finish.\n" +
      'Skipping tool call 2 is a FAILURE. Only after KEEPBUSY finishes, reply exactly DONE-TURN-1',
  });
  const init = await waitEv(c.events, (e) => e.t === 'session-init', 90000);
  if (!init) throw new Error('session never initialised');
  const sdkSessionId = init.sessionId;
  const spawned = await waitEv(c.events, (e) => e.t === 'agent-started' && e.agent?.agentType === 'general-purpose', 120000);
  check('PRECONDITION: the subagent is genuinely running', !!spawned, { sdkSessionId });
  // The Task tool is async — the orchestrator's OWN keep-busy Bash call is
  // what holds the turn open across the attach/cut window (BUG-020 learning).
  const keepbusy = await waitEv(c.events,
    (e) => e.t === 'tool-call' && e.name === 'Bash' && !e.agentId && JSON.stringify(e.input ?? {}).includes('KEEPBUSY'), 90000);
  check('PRECONDITION: the outer turn is held busy (KEEPBUSY Bash in flight on the main thread)', !!keepbusy, { seen: !!keepbusy });
  try { c.ws.close(); } catch { /* detach-not-close: the turn keeps running */ }

  // ---- the open tab: attach mid-turn like a real returning user.
  browser = await chromium.launch({ headless: true, executablePath: BRAVE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/#/project/${encodeURIComponent(projectId)}/session/${encodeURIComponent(sdkSessionId)}?dir=${encodeURIComponent(ENCODED_DIR)}`);
  await page.waitForFunction(() => window.__station && document.querySelector('#prompt'), undefined, { timeout: 20000 });
  await sleep(1500); // let openSession finish its liveness probe
  await typeAndSend(page, 'status?'); // reattaches: start + resumeSessionId
  await page.evaluate(() => { window.__station.state.queue.length = 0; }); // the probe message queued mid-turn is not under test

  // Steady state, pre-cut: CUT-B in flight shows ◐, and the subagent row too
  // (replayed/streamed onto this attach — the reattach path under test).
  const b = await pollUi(page, (ui) => hasRun(ui, 'CUT-B') && ui.runningRows.some((r) => r.ty === 'general-purpose'), 180000);
  check('LIVE CASE: the in-flight long call (CUT-B) shows as a running ◐ row', !!b.ui && b.ui.runningRows.some((r) => r.de.includes('CUT-B') && r.gl === '◐'), b.ui);
  check('LIVE CASE: the subagent itself shows as a running ◐ row', b.ok, b.ui);
  await page.screenshot({ path: path.join(ASSETS, 'BUG-030-live-inflight.png') });
  // …and the FINISHED short call settles out of the running strip.
  // FAILS PRE-FIX: task_notification (the local_bash terminal frame) was
  // dropped, so CUT-A stayed `running`/◐ forever.
  const a = await pollUi(page, (ui) => !hasRun(ui, 'CUT-A') && hasRun(ui, 'CUT-B'), 45000);
  check('THE FIX (steady state): the FINISHED call (CUT-A) has settled out of the running strip while CUT-B still runs', a.ok, a.ui);

  // ---- THE CUT: a real control-group stop mid-call, tab left open.
  stopService(unit);
  check('the old server (and the host CLI with it) is down after the control-group stop', await healthGone(port), `port ${port}`);
  const stale = await page.evaluate(READ_UI);
  /*
   * PRECONDITION, stated design-neutrally (ARCH-001 phase 2 / BUG-034).
   *
   * What this must establish is that the tab is in the state the rest of the
   * test is about: a cut has happened and NOTHING may be left claiming to run
   * without a process behind it. There are now two honest ways to be in it:
   *  - the OLD one (and the one this test was written against): the tab still
   *    shows the cut call, because nothing ever told it otherwise — the rows
   *    are then settled by the sweeps below;
   *  - the NEW one: the shutting-down server PUSHES its final running-set
   *    snapshot (empty) as it closes the session, so the strip has already
   *    corrected itself at the moment of the cut. That is strictly stronger
   *    than settling it afterwards, and it is what this build produces.
   * Asserting the first shape alone would pin the test to the design that
   * caused BUG-034, so both count — and either way the checks below still have
   * to prove no ◐ survives and the cut caption is written.
   */
  check('PRECONDITION: at the cut, the tab either still shows the cut call or has already been told it stopped (nothing may spin unbacked)',
    hasRun(stale, 'CUT-B') || stale.runningRows.length === 0,
    { runningRows: stale.runningRows, shape: hasRun(stale, 'CUT-B') ? 'still-on-screen (pre-snapshot design)' : 'already corrected by the server snapshot' });

  // ---- restart half: fresh server on the SAME port so the SAME tab resumes.
  server2 = spawn(process.execPath, [ENTRY], {
    cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_STATION_SURVIVE: '0' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server2.stderr?.on('data', (d) => process.stderr.write(`  [server2!] ${d}`));
  if (!(await waitHealth(port))) throw new Error('restarted server never became healthy');

  await page.click('#reconnectBtn');
  await typeAndSend(page,
    'Follow these steps exactly, in order. ' +
    'Step 1: call the Task tool once, with subagent_type general-purpose and this exact prompt: ' +
    '"Call the Bash tool with description exactly NEW-LIVE and command: python3 -c \'import time; time.sleep(25)\' . After it completes, reply done." ' +
    'Step 2: IMMEDIATELY after the Task call returns (it returns instantly — do NOT wait for the agent), ' +
    'you MUST call the Bash tool yourself, with description exactly KEEPBUSY2 ' +
    "and command: python3 -c 'import time; time.sleep(35)' , and wait for it to finish. " +
    'Step 3: only after KEEPBUSY2 finishes, reply exactly DONE-TURN-2');

  // The resumed turn's own work must show ◐ (the live case must not break):
  // the NEW-LIVE call itself, or its genuinely-running subagent row (the tag
  // scoping matters — the STALE rows also render until the sweep fires, and
  // must not be what satisfies this check).
  const live2 = await pollUi(page,
    (ui) => ui.runningRows.some((r) => r.de.includes('NEW-LIVE') && r.gl === '◐'), 180000);
  check('LIVE CASE INTACT after reattach: the resumed turn\'s in-flight work shows ◐', live2.ok, live2.ui);
  // …while the cut call from the dead CLI must be SETTLED, not ◐.
  // FAILS PRE-FIX: nothing ever settled rows whose terminal frames died with
  // the cut CLI — they spun forever with growing timers.
  const settled = await pollUi(page, (ui) => !anyCutRun(ui), 20000);
  check('THE FIX: after cut+resume, the cut calls AND their subagent are settled — NOT rendered as running ◐', settled.ok, settled.ui);
  check('THE FIX: the cut subagent left an honest "Cut by shutdown" caption', settled.ui?.cutCaption === true, { cutCaption: settled.ui?.cutCaption });
  await page.screenshot({ path: path.join(ASSETS, 'BUG-030-settled-after-cut.png') });

  // ---- the invariant at rest: once the resumed turn's `result` lands and its
  // async subagent finishes, NOTHING may remain rendered in-flight (NEW-LIVE
  // settles via its own terminal frame — the task_notification seam — and any
  // straggler via the turn-end sweep). Generous poll: the agent's 25s Bash
  // may still genuinely (and correctly) show ◐ for a while after busy=false.
  const idle = await pollUi(page, (ui) => ui.busy === false, 240000);
  check('the resumed turn ended (busy=false)', idle.ok, { busy: idle.ui?.busy });
  // An async subagent announced AFTER its parent turn's `result` may
  // genuinely run on past busy=false (correctly ◐). Give it time to finish
  // naturally; if its terminal frame does not come, the NEXT turn boundary is
  // where the invariant must settle it — drive one, exactly like a user's
  // next message would.
  const atRest = (ui) => !ui.unsettledRunning.some((r) => r.de.includes('NEW-LIVE') || r.de.includes('CUT-'))
    && !ui.runningRows.some((r) => r.ty !== 'main' && (r.de.includes('NEW-LIVE') || r.de.includes('CUT-')));
  let finals = await pollUi(page, (ui) => ui.busy === false && atRest(ui), 60000);
  if (!finals.ok) {
    await typeAndSend(page, 'Do not use any tools and do not resume any earlier work. Reply exactly: PING');
    finals = await pollUi(page, (ui) => ui.busy === false && atRest(ui), 240000);
  }
  check('INVARIANT: at rest after the turn boundary, no tracked call/agent renders as in-flight', finals.ok, finals.ui);

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
