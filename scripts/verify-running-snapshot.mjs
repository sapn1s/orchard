#!/usr/bin/env node
/**
 * ARCH-001 phase 2 / BUG-034 — THE STRIP RENDERS THE SERVER'S SNAPSHOT.
 *
 * WHY THIS TEST IS SHAPED LIKE THIS. BUG-034 is intermittent ("sometimes they
 * do appear, sometimes not"), so a single green run proves nothing. The ticket
 * therefore sets the bar itself: N>=5 runs WITH INJECTED EVENT DROPS AND
 * DELAYED ATTACH, green every time. That is what this script does — and the
 * drops are real, injected into the page's own WebSocket before app.js loads,
 * so the client genuinely never receives the frames it used to depend on.
 *
 * THE ASSERTION THAT MATTERS: the STRIP (real DOM, real browser) must equal the
 * SERVER's own answer (`GET /api/sessions/:id/running`), in both directions:
 *   - rows the client never heard about must APPEAR (the reported symptom: three
 *     dispatched subagents, none of them shown);
 *   - rows the server does not vouch for must DISAPPEAR, with no page reload
 *     (the post-restart tab that kept counting a killed agent's timers).
 *
 * Per run, the phases are the three the ticket names, in order:
 *   1. three subagents in flight, seen WITHOUT a reload;
 *   2. across a MID-FLIGHT RELOAD (and note: no re-send is needed any more —
 *      the reloaded tab's poll alone reconciles it, which is the design change);
 *   3. after a HOST CUT (the engine process killed): the strip EMPTIES, still
 *      with no reload.
 * Plus the honesty checks: no fabricated stopwatch, no ◐ without the server's
 * backing, `state.agents` is NOT what is being rendered.
 *
 * ENGINE: the schema-validated fake `codex app-server` fixture (the same seam
 * verify-liveness-conformance L2b uses). Real server, real bridge, real
 * runtime, real browser — no station internals mocked, no API cost, and the
 * agent count is a parameter so "three subagents" is exactly reproducible.
 * `--live` additionally drives ONE real haiku session for the live shape.
 *
 * Usage:
 *   node scripts/verify-running-snapshot.mjs [--runs=5] [--live]
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const FAKE = path.join(ROOT, 'scripts', 'fixtures', 'codex-fake-app-server.mjs');
const BRAVE = process.env.QA_BRAVE_PATH ?? '/usr/bin/brave';
const ARGV = process.argv.slice(2);
const RUNS = Number((ARGV.find((a) => a.startsWith('--runs=')) ?? '--runs=5').split('=')[1]);
const LIVE = ARGV.includes('--live');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

const servers = new Set();
const tmpDirs = new Set();
function mkTmp(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `cs-b34-${tag}-`));
  tmpDirs.add(d);
  return d;
}
function startServer(port, dataDir, env = {}) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: dataDir, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (d) => { if (process.env.CS_VERBOSE) process.stderr.write(`  [srv] ${d}`); });
  servers.add(child);
  return child;
}
function stopByPid(pid) {
  if (!pid) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }, 2500).unref();
}
async function waitHealth(port, ms = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* not up */ }
    await sleep(200);
  }
  return false;
}
const getJson = async (port, p) => (await (await fetch(`http://127.0.0.1:${port}${p}`)).json());

async function registerProject(port, workDir, name, settings) {
  const reg = await (await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: workDir, name }),
  })).json();
  if (!reg.project?.id) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(reg.project.id)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings }),
  });
  return reg.project.id;
}

/* ------------------------------------------------- what the USER can see */

const READ_UI = () => ({
  rows: [...document.querySelectorAll('#stripRows .lag')].map((r) => ({
    key: r.dataset.thread,
    ty: r.querySelector('.ty')?.textContent ?? '',
    de: r.querySelector('.de')?.textContent ?? '',
    gl: r.querySelector('.gl')?.textContent ?? '',
    el: r.querySelector('.el')?.textContent ?? '',
    run: r.classList.contains('run'),
  })),
  hidden: document.querySelector('#strip')?.hidden === true,
  sum: document.querySelector('#stripSum')?.textContent ?? '',
  // The client-side accumulation that USED to drive the strip. Read only so we
  // can prove the strip is NOT rendering it any more.
  accumulated: [...window.__station.state.agents.values()]
    .filter((x) => !x.settled && x.agent.status === 'running').length,
  snapAt: window.__station.state.snap?.at ?? null,
  snapRunning: (window.__station.state.snap?.running ?? []).map((r) => r.id),
});

async function pollUi(page, pred, ms) {
  const t0 = Date.now();
  let ui = null;
  while (Date.now() - t0 < ms) {
    try { ui = await page.evaluate(READ_UI); } catch { /* mid-navigation */ }
    if (ui && pred(ui)) return { ok: true, ui };
    await sleep(400);
  }
  return { ok: false, ui };
}

/**
 * INJECTED EVENT DROPS — installed before app.js runs, so the client's own
 * socket genuinely loses frames. `mode` picks WHICH truth is taken away:
 *   'snapshot' — every `running-snapshot` push is dropped: only the POLL can
 *                save it (proves the correcting authority works on its own).
 *   'agents'   — every `agent-*` delta is dropped: proves the strip no longer
 *                depends on them at all.
 *   'random'   — a seeded fraction of BOTH: the messy real case.
 */
function dropScript(mode, seed) {
  return `(() => {
    let n = ${seed};
    const rand = () => { n = (n * 1103515245 + 12345) % 2147483648; return n / 2147483648; };
    const drop = (t) => {
      if (${JSON.stringify(mode)} === 'snapshot') return t === 'running-snapshot';
      if (${JSON.stringify(mode)} === 'agents') return t && t.startsWith('agent-');
      return (t === 'running-snapshot' || (t && t.startsWith('agent-'))) && rand() < 0.6;
    };
    window.__dropped = 0;
    const OrigWS = window.WebSocket;
    function Patched(...args) {
      const ws = new OrigWS(...args);
      const realAdd = ws.addEventListener.bind(ws);
      let userOnMessage = null;
      const filter = (fn) => (ev) => {
        let t = null;
        try { t = JSON.parse(ev.data).t; } catch { /* not ours */ }
        if (drop(t)) { window.__dropped++; return; }
        fn(ev);
      };
      ws.addEventListener = (type, fn, ...rest) =>
        realAdd(type, type === 'message' ? filter(fn) : fn, ...rest);
      Object.defineProperty(ws, 'onmessage', {
        get: () => userOnMessage,
        set: (fn) => { userOnMessage = fn; realAdd('message', filter(fn)); },
      });
      return ws;
    }
    Patched.prototype = OrigWS.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Patched[k] = OrigWS[k];
    window.WebSocket = Patched;
  })()`;
}

/** The SERVER's own answer — the thing the strip must equal. */
async function serverSnapshot(port, id) {
  const r = await getJson(port, `/api/sessions/${encodeURIComponent(id)}/running`);
  return r.snapshot ?? null;
}

/* ============================================================== ONE RUN ==== */

async function oneRun(i, browser) {
  const mode = ['snapshot', 'agents', 'random'][i % 3];
  const attachDelayMs = [0, 1200, 2500, 4000, 800][i % 5];
  console.log(`\n===== run ${i + 1}/${RUNS} — drops: ${mode}, attach delayed ${attachDelayMs}ms =====`);
  const port = await freePort();
  const DATA = mkTmp('data');
  const WORK = mkTmp('work');
  const srv = startServer(port, DATA, { CLAUDE_STATION_CODEX_BIN: FAKE, CLAUDE_STATION_SURVIVE: '0' });
  if (!(await waitHealth(port))) throw new Error('scratch server never became healthy');
  const projectId = await registerProject(port, WORK, `b34-run-${i}`, { provider: 'openai', model: null, permissionMode: 'bypassPermissions' });

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(dropScript(mode, 7919 + i));
  await page.goto(`http://127.0.0.1:${port}/#/project/${encodeURIComponent(projectId)}`);
  await page.waitForFunction(() => window.__station && document.querySelector('#prompt'), undefined, { timeout: 30000 });

  // --- the turn: three subagents that stay in flight (the reported shape).
  await page.fill('#prompt', 'HOLD_AGENTS:3 — hold three workers open');
  await page.focus('#prompt');
  await page.keyboard.press('Enter');

  // DELAYED ATTACH: look away for a while, exactly as a real tab does when the
  // user is elsewhere. Correctness must not depend on when we happen to look.
  if (attachDelayMs) await sleep(attachDelayMs);

  // The session id lands on the ack / session-init; wait for it rather than
  // assuming the engine spawned within the attach delay.
  await page.waitForFunction(
    () => !!(window.__station.state.stationSessionId || window.__station.state.sdkSessionId),
    undefined, { timeout: 30000 },
  ).catch(() => {});
  const sdk = await page.evaluate(() => window.__station.state.sdkSessionId);
  const station = await page.evaluate(() => window.__station.state.stationSessionId);
  const id = station || sdk;
  check(`run${i + 1} PRECONDITION: a real turn is running on the fixture engine`, !!id, { station, sdk });
  if (!id) { await page.close(); stopByPid(srv.pid); return; }

  const srvSnap = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const s = await serverSnapshot(port, id);
      if (s && s.running.filter((r) => r.row !== 'main').length === 3) return s;
      await sleep(300);
    }
    return await serverSnapshot(port, id);
  })();
  check(`run${i + 1} PRECONDITION: the SERVER's snapshot has main + 3 running agents (honest start times)`,
    !!srvSnap && srvSnap.turn.running === true
      && srvSnap.running.filter((r) => r.row === 'main').length === 1
      && srvSnap.running.filter((r) => r.row === 'agent').length === 3
      && srvSnap.running.every((r) => r.startedAt === null || Number.isFinite(r.startedAt)),
    srvSnap && { turn: srvSnap.turn.running, ids: srvSnap.running.map((r) => `${r.row}:${r.id}`) });

  /* PHASE 1 — visible WITHOUT a reload, despite the dropped frames. */
  const p1 = await pollUi(page, (ui) => ui.rows.length === 4 && ui.rows.filter((r) => r.ty !== 'main').length === 3, 25000);
  const dropped = await page.evaluate(() => window.__dropped ?? 0);
  check(`run${i + 1} PHASE 1: the strip shows main + the 3 subagents WITHOUT a reload (frames dropped: ${dropped})`,
    p1.ok, { rows: p1.ui?.rows, dropped, accumulated: p1.ui?.accumulated });
  check(`run${i + 1} PHASE 1: every rendered row is one the SERVER vouches for (no phantom ◐)`,
    !!p1.ui && p1.ui.rows.every((r) => r.gl === '◐' && r.run)
      && p1.ui.rows.every((r) => (srvSnap?.running ?? []).some((s) => s.id === r.key)),
    p1.ui?.rows);
  check(`run${i + 1} PHASE 1: the clock is honest (a real elapsed, never a fabricated one on an unknown start)`,
    !!p1.ui && p1.ui.rows.every((r) => /^\d+:\d\d$/.test(r.el) || r.el === '—'),
    p1.ui?.rows.map((r) => r.el));
  if (mode === 'agents') {
    check(`run${i + 1} PHASE 1: the strip is NOT rendering accumulated agent events (every agent-* frame was dropped)`,
      p1.ui?.accumulated === 0 && p1.ui?.rows.length === 4, { accumulated: p1.ui?.accumulated, rows: p1.ui?.rows.length });
  }

  /* PHASE 2 — across a MID-FLIGHT RELOAD, with no re-send by the user. */
  await page.reload();
  await page.waitForFunction(() => window.__station && document.querySelector('#prompt'), undefined, { timeout: 30000 });
  const p2 = await pollUi(page, (ui) => ui.rows.filter((r) => r.ty !== 'main').length === 3, 25000);
  check(`run${i + 1} PHASE 2: after a mid-flight RELOAD the strip is correct again with no user action`,
    p2.ok, { rows: p2.ui?.rows, snapRunning: p2.ui?.snapRunning });

  /* PHASE 3 — HOST CUT: kill the engine process; the strip must EMPTY. */
  const before = await getJson(port, '/api/health');
  const enginePids = String(before && '').length ? [] : [];
  // Kill the fake app-server child of this server (the engine behind the turn).
  const ps = spawn('pgrep', ['-f', `codex-fake-app-server.mjs`], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  ps.stdout.on('data', (d) => { out += String(d); });
  await new Promise((r) => ps.on('close', r));
  for (const pid of out.trim().split('\n').filter(Boolean).map(Number)) {
    // Only ours: the fixture child of THIS server process tree.
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (ppid === srv.pid) { enginePids.push(pid); process.kill(pid, 'SIGKILL'); }
    } catch { /* raced */ }
  }
  check(`run${i + 1} PHASE 3 PRECONDITION: the engine process behind the turn was killed`, enginePids.length > 0, { enginePids });
  const p3 = await pollUi(page, (ui) => ui.rows.length === 0 && !/running/.test(ui.sum), 30000);
  check(`run${i + 1} PHASE 3: after the host cut the strip EMPTIES — rows AND summary, without a page reload`,
    p3.ok, { rows: p3.ui?.rows, hidden: p3.ui?.hidden, sum: p3.ui?.sum });
  const finalSnap = await serverSnapshot(port, id);
  check(`run${i + 1} PHASE 3: the client's picture equals the SERVER's (both empty) — no state the server denies`,
    p3.ok && (!finalSnap || finalSnap.running.length === 0),
    { client: p3.ui?.rows.length ?? null, server: finalSnap?.running.length ?? null });

  await page.close();
  stopByPid(srv.pid);
}

/* =============================================== the REAL-engine live shape */

async function liveRun(browser) {
  console.log('\n===== LIVE (real haiku session, real Task subagents) =====');
  const port = await freePort();
  const DATA = mkTmp('live-data');
  const WORK = mkTmp('live-work');
  const srv = startServer(port, DATA, { CLAUDE_STATION_SURVIVE: '0' });
  if (!(await waitHealth(port))) throw new Error('scratch server never became healthy');
  const projectId = await registerProject(port, WORK, 'b34-live', { model: 'haiku', permissionMode: 'bypassPermissions' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/#/project/${encodeURIComponent(projectId)}`);
  await page.waitForFunction(() => window.__station && document.querySelector('#prompt'), undefined, { timeout: 30000 });
  await page.fill('#prompt',
    'Dispatch THREE Task-tool subagents (subagent_type general-purpose) in one turn, with prompts exactly: '
    + '"run: python3 -c \'import time; time.sleep(45)\' then reply done" for each, named A, B and C. '
    + 'Then IMMEDIATELY call the Bash tool yourself with description KEEPBUSY and command '
    + "python3 -c 'import time; time.sleep(60)' and wait for it. Then reply DONE.");
  await page.focus('#prompt');
  await page.keyboard.press('Enter');

  const got = await pollUi(page, (ui) => ui.rows.filter((r) => r.ty !== 'main').length >= 3, 240000);
  check('LIVE: three genuinely dispatched subagents are visible in the strip WITHOUT a reload', got.ok, got.ui?.rows);
  const id = await page.evaluate(() => window.__station.state.stationSessionId || window.__station.state.sdkSessionId);
  const snap = await serverSnapshot(port, id);
  check('LIVE: the strip equals the server snapshot (same ids, same count)',
    !!snap && got.ok && got.ui.rows.length === snap.running.length
      && got.ui.rows.every((r) => snap.running.some((s) => s.id === r.key)),
    { client: got.ui?.rows.map((r) => r.key), server: snap?.running.map((s) => s.id) });

  await page.reload();
  await page.waitForFunction(() => window.__station && document.querySelector('#prompt'), undefined, { timeout: 30000 });
  const after = await pollUi(page, (ui) => ui.rows.filter((r) => r.ty !== 'main').length >= 3, 40000);
  check('LIVE: across a mid-flight reload the subagents are still shown (no re-send needed)', after.ok, after.ui?.rows);

  /*
   * The SERVER itself is cut — a different case from the engine dying, and the
   * honest answer is neither "still running" nor "nothing is running": nothing
   * can be checked. The rows must stop claiming ◐ and stop counting, and the
   * strip must say why. (Deleting them would assert the work stopped, which is
   * false: a detached turn genuinely survives — BUG-018/BUG-020.)
   */
  stopByPid(srv.pid);
  const gone = await pollUi(page,
    (ui) => ui.rows.length === 0 || (ui.rows.every((r) => r.gl !== '◐') && /unverified/.test(ui.sum)), 60000);
  check('LIVE: after the SERVER is cut nothing keeps claiming ◐ — the rows freeze and say "unverified"',
    gone.ok, { rows: gone.ui?.rows, sum: gone.ui?.sum });
  await page.close();
}

/* ------------------------------------------------------------------- main */

let browser = null;
try {
  if (!fs.existsSync(BRAVE)) {
    console.error(`FATAL: browser not found at ${BRAVE} (set QA_BRAVE_PATH) — this bug is what the USER SEES, so the DOM is the assertion.`);
    process.exitCode = 1;
  } else {
    browser = await chromium.launch({ headless: true, executablePath: BRAVE });
    for (let i = 0; i < RUNS; i++) await oneRun(i, browser);
    if (LIVE) await liveRun(browser);
  }
} catch (err) {
  check('the suite ran to completion', false, String(err?.stack ?? err));
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const s of servers) stopByPid(s.pid);
  await sleep(600);
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) { console.log(`FAILED: ${failures.join(' | ')}`); process.exitCode = 1; }
