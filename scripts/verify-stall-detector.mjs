#!/usr/bin/env node
/**
 * BUG-046 (half 2) — THE STALL DETECTOR: silently-stopped work surfaces as
 * ⚠ stalled, never as blank and never as a death.
 *
 * THE INCIDENT THIS DESIGNS AGAINST (4 occurrences in one day): a dispatched
 * agent registers as running work, launches its long run, the run dies, the
 * agent idles awaiting a notification that never fires. The strip honestly
 * shows the row as running — "N lanes silently stalled" is indistinguishable
 * from healthy work — and ~1h is lost per stall until a human probes processes.
 *
 * WHAT MUST HOLD (and what this script checks):
 *   1. INJECTED STALL: a registered work row whose progress stops surfaces as
 *      state 'stalled' (⚠, with evidence: last progress time + what was
 *      checked) within the window. MUST FAIL PRE-FEATURE.
 *   2. LIVE CHATTY WORK IS NEVER FLAGGED: rows with progress heartbeats stay
 *      'running' across several windows.
 *   3. RECOVERY CLEARS WITHOUT RESIDUE: progress resumes → the same row goes
 *      back to 'running', no stall field left behind, the row never vanished.
 *   4. A STALL IS NOT A DEATH: the outcomes ledger (FEAT-057/BUG-041) is not
 *      written by stalling — completions are never deaths, and a stall is not
 *      an outcome at all.
 *   5. ESCALATION IS ADVISORY: past the second window a Needs-You rail card
 *      appears, evidence-carrying, actionless (ARCH-002 — never auto-kill).
 *
 * Parts:
 *   A — unit: the REAL `stalls.ts` judgment + REAL `running-set.ts` builder,
 *       plus source-conformance (the live call sites actually consult them —
 *       guards against a correct function nobody calls).
 *   B — end to end: real server, real bridge, the schema-validated fake
 *       `codex app-server` (HOLD_AGENTS held-open rows = the injected stall;
 *       new `;TICK` heartbeats = chatty / recovery), real browser DOM.
 *
 * Scratch servers on free ports only; no API cost.
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

/* Unit-part windows — set BEFORE the module import below reads them. */
const UNIT_WINDOW = 1000;
const UNIT_ESCALATE = 2000;
process.env.CLAUDE_STATION_STALL_WINDOW_MS = String(UNIT_WINDOW);
process.env.CLAUDE_STATION_STALL_ESCALATE_MS = String(UNIT_ESCALATE);

/* E2E windows (passed to the scratch servers' env, not this process's import). */
const E2E_WINDOW = 5000;
const E2E_ESCALATE = 9000;

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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `cs-b46-${tag}-`));
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
async function serverSnapshot(port, id) {
  const r = await getJson(port, `/api/sessions/${encodeURIComponent(id)}/running`);
  return r.snapshot ?? null;
}

/* ==================================================== A — the unit half ==== */

async function partA() {
  console.log('\n===== A — unit: the real judgment + the real snapshot builder =====');
  let stalls, rs;
  try {
    stalls = await import('../src/server/stalls.ts');
    rs = await import('../src/server/running-set.ts');
  } catch (err) {
    check('A0 the stall module exists and is importable', false, String(err).slice(0, 140));
    return;
  }
  check('A0 the stall module exists and is importable',
    typeof stalls.judgeStall === 'function' && typeof stalls.stallEscalated === 'function',
    { window: stalls.STALL_WINDOW_MS, escalate: stalls.STALL_ESCALATE_MS });

  const now = Date.now();
  const v1 = stalls.judgeStall({ lastProgressAt: now - 200, startedAt: now - 5000, signal: null }, now);
  check('A1 fresh progress → not stalled', v1.stalled === false && !v1.evidence, v1);

  const v2 = stalls.judgeStall({ lastProgressAt: now - 3 * UNIT_WINDOW, startedAt: now - 5000, signal: null }, now);
  check('A2 evidence flat past the window with no live signal → STALLED, with quotable evidence',
    v2.stalled === true
      && v2.evidence?.lastProgressAt === now - 3 * UNIT_WINDOW
      && v2.evidence?.stalledForMs === 3 * UNIT_WINDOW
      && /no frame or counter progress/.test(v2.evidence?.checked ?? '')
      && /no live process signal/.test(v2.evidence?.checked ?? ''),
    v2);

  const v3 = stalls.judgeStall(
    { lastProgressAt: now - 3 * UNIT_WINDOW, startedAt: now - 5000, signal: { live: true, detail: 'the engine lists it' } }, now);
  check('A3 a LIVE process signal outranks any silence — never stalled', v3.stalled === false, v3);

  const v4 = stalls.judgeStall({ lastProgressAt: now - 100, startedAt: now - 5000, signal: null }, now);
  check('A4 recovery is residue-free by construction — bumped progress, same call, clean verdict',
    v4.stalled === false && v4.evidence === undefined, v4);

  const v5 = stalls.judgeStall({ lastProgressAt: null, startedAt: null, signal: null }, now);
  check('A5 no progress clock at all → NOT stalled (a stall needs a real "flat since"; §C, no fabricated clocks)',
    v5.stalled === false, v5);

  check('A6 escalation only past the SECOND window',
    stalls.stallEscalated({ lastProgressAt: null, stalledForMs: UNIT_ESCALATE - 200, windowMs: UNIT_WINDOW, checked: '' }) === false
      && stalls.stallEscalated({ lastProgressAt: null, stalledForMs: UNIT_ESCALATE + 200, windowMs: UNIT_WINDOW, checked: '' }) === true,
    { threshold: UNIT_ESCALATE });

  /* A7 — window <= 0 disables, proven against the real module in a subprocess
   * (the constants are read at import; this process already imported them). */
  const sub = spawn(process.execPath, ['--input-type=module', '-e', `
    const m = await import(${JSON.stringify(path.join(ROOT, 'src', 'server', 'stalls.ts'))});
    const v = m.judgeStall({ lastProgressAt: Date.now() - 10_000_000, startedAt: null, signal: null });
    console.log(JSON.stringify(v));
  `], { cwd: ROOT, env: { ...process.env, CLAUDE_STATION_STALL_WINDOW_MS: '0', CLAUDE_STATION_STALL_ESCALATE_MS: '0' } });
  let subOut = '';
  sub.stdout.on('data', (d) => { subOut += String(d); });
  await new Promise((r) => sub.on('close', r));
  let v7 = null;
  try { v7 = JSON.parse(subOut.trim()); } catch { /* left null */ }
  check('A7 CLAUDE_STATION_STALL_WINDOW_MS<=0 disables detection entirely', v7?.stalled === false, subOut.trim() || '(no output)');

  /* A8 — the REAL snapshot builder marks entries in place and never drops them. */
  const t = Date.now();
  const mkSource = () => ({
    id: 'st-1', sdkSessionId: 'sdk-1', closed: false, busy: true,
    lastFrameAt: t, turnStartedAt: t - 60_000,
    processProbe: () => ({ state: 'alive', detail: 'fake probe: alive' }),
    liveAgents: () => [
      { agentId: 'a-stalled', toolUseId: null, agentType: 'worker', description: 'silent one', kind: 'agent', status: 'running', lastTool: null, totalTokens: 0, toolUses: 0, elapsedMs: 0, startedAt: t - 60_000, lastProgressAt: t - 3 * UNIT_WINDOW },
      { agentId: 'a-chatty', toolUseId: null, agentType: 'worker', description: 'chatty one', kind: 'agent', status: 'running', lastTool: null, totalTokens: 5, toolUses: 1, elapsedMs: 0, startedAt: t - 60_000, lastProgressAt: t - 100 },
      { agentId: 'a-bg', toolUseId: null, agentType: 'worker', description: 'background one', kind: 'tool', status: 'running', lastTool: null, totalTokens: 0, toolUses: 0, elapsedMs: 0, startedAt: t - 60_000, lastProgressAt: t - 3 * UNIT_WINDOW },
    ],
    stallSignalFor: (id) => (id === 'a-bg' ? { live: true, detail: 'the engine level lists it' } : null),
  });
  const snap = rs.snapshotOfSession(mkSource(), [], t);
  const byId = Object.fromEntries(snap.running.map((r) => [r.id, r]));
  check('A8a the stalled row is KEPT in the running set, state \'stalled\', evidence attached — not removed',
    snap.running.length === 4 && byId['a-stalled']?.state === 'stalled'
      && /no live process signal/.test(byId['a-stalled']?.stall?.checked ?? ''),
    byId['a-stalled']);
  check('A8b chatty work is never flagged; a level-vouched row is never flagged; main is out of scope',
    byId['a-chatty']?.state === 'running' && byId['a-chatty']?.stall === undefined
      && byId['a-bg']?.state === 'running' && byId['main']?.state === 'running',
    { chatty: byId['a-chatty']?.state, bg: byId['a-bg']?.state, main: byId['main']?.state });
  const recovered = mkSource();
  const agents = recovered.liveAgents();
  recovered.liveAgents = () => agents.map((a) => (a.agentId === 'a-stalled' ? { ...a, lastProgressAt: t - 50 } : a));
  const snap2 = rs.snapshotOfSession(recovered, [], t);
  const rrow = snap2.running.find((r) => r.id === 'a-stalled');
  check('A8c RECOVERY: progress resumed → the same row is \'running\' again with NO stall residue',
    rrow?.state === 'running' && rrow?.stall === undefined, rrow);

  /* A9 — source conformance: the live sites actually consult all of this. */
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'server', 'agent-bridge.ts'), 'utf8');
  const rsSrc = fs.readFileSync(path.join(ROOT, 'src', 'server', 'running-set.ts'), 'utf8');
  const stallsSrc = fs.readFileSync(path.join(ROOT, 'src', 'server', 'stalls.ts'), 'utf8');
  const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const idxSrc = fs.readFileSync(path.join(ROOT, 'src', 'server', 'index.ts'), 'utf8');
  check('A9a the bridge stamps lastProgressAt on task frames and exposes stallSignalFor',
    (bridgeSrc.match(/lastProgressAt\s*[:=]\s*Date\.now\(\)/g) ?? []).length >= 3
      && /stallSignalFor\(/.test(bridgeSrc),
    { stamps: (bridgeSrc.match(/lastProgressAt\s*[:=]\s*Date\.now\(\)/g) ?? []).length });
  check('A9b the snapshot builder consults judgeStall + the source\'s live signal',
    /judgeStall\(/.test(rsSrc) && /stallSignalFor\?\.\(/.test(rsSrc), 'running-set.ts');
  check('A9c a stall CANNOT be a death by construction — stalls.ts and running-set.ts never touch the outcomes ledger',
    !/outcomes/.test(stallsSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').match(/import[^;]+;/g)?.join('') ?? '')
      && !/outcomes\.record|record\(/.test(stallsSrc)
      && !/outcomes\.record/.test(rsSrc),
    'no outcomes import/write in stalls.ts or running-set.ts');
  check('A9d the client renders ⚠ for a stalled row and a read-only advisory rail card',
    /stalled/.test(appSrc) && /⚠/.test(appSrc) && /needsStallRow/.test(appSrc) && /kind === 'stall'/.test(appSrc),
    'public/app.js');
  check('A9e the board route consults stallEscalated for the advisory rail card',
    /stallEscalated/.test(idxSrc) && /kind: 'stall'/.test(idxSrc), 'src/server/index.ts');
}

/* ================================================== B — the E2E half ==== */

const READ_STRIP = () => ({
  rows: [...document.querySelectorAll('#stripRows .lag')].map((r) => ({
    key: r.dataset.thread,
    gl: r.querySelector('.gl')?.textContent ?? '',
    title: r.title ?? '',
    stallCls: r.classList.contains('stall'),
  })),
  sum: document.querySelector('#stripSum')?.textContent ?? '',
  railStalls: [...document.querySelectorAll('.needs-card.stall')].map((c) => ({
    id: c.dataset.id,
    title: c.querySelector('.nc-title')?.textContent ?? '',
    detail: c.querySelector('.nc-question')?.textContent ?? '',
  })),
});

async function pollFor(fn, pred, ms, everyMs = 500) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    try { last = await fn(); } catch { /* transient */ }
    if (last != null && pred(last)) return { ok: true, v: last };
    await sleep(everyMs);
  }
  return { ok: false, v: last };
}

async function startScenario(browser, port, projectId, prompt) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/#/project/${encodeURIComponent(projectId)}`);
  await page.waitForFunction(() => window.__station && document.querySelector('#prompt'), undefined, { timeout: 30000 });
  await page.fill('#prompt', prompt);
  await page.focus('#prompt');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => !!(window.__station.state.stationSessionId || window.__station.state.sdkSessionId),
    undefined, { timeout: 30000 },
  ).catch(() => {});
  const id = await page.evaluate(() => window.__station.state.stationSessionId || window.__station.state.sdkSessionId);
  return { page, id };
}

async function partB(browser) {
  console.log(`\n===== B — end to end (window ${E2E_WINDOW}ms, escalate ${E2E_ESCALATE}ms) =====`);
  const port = await freePort();
  const DATA = mkTmp('data');
  const srv = startServer(port, DATA, {
    CLAUDE_STATION_CODEX_BIN: FAKE,
    CLAUDE_STATION_SURVIVE: '0',
    CLAUDE_STATION_STALL_WINDOW_MS: String(E2E_WINDOW),
    CLAUDE_STATION_STALL_ESCALATE_MS: String(E2E_ESCALATE),
  });
  if (!(await waitHealth(port))) throw new Error('scratch server never became healthy');
  const settings = { provider: 'openai', model: null, permissionMode: 'bypassPermissions' };

  /* ---- B1 — THE INJECTED STALL (the incident's shape, compressed) ---- */
  {
    const projectId = await registerProject(port, mkTmp('work1'), 'b46-stall', settings);
    const { page, id } = await startScenario(browser, port, projectId, 'HOLD_AGENTS:2 — hold two workers, then silence');
    check('B1 PRECONDITION: a real turn is running on the fixture engine', !!id, { id });
    const appear = await pollFor(() => serverSnapshot(port, id),
      (s) => s && s.running.filter((r) => r.row !== 'main').length === 2, 20000, 300);
    const initialStates = appear.v?.running.filter((r) => r.row !== 'main').map((r) => r.state ?? 'running') ?? [];
    check('B1a the two held rows register as RUNNING first (registered work, not yet stalled)',
      appear.ok && initialStates.every((st) => st === 'running'),
      { states: initialStates });
    const outcomesBefore = (await getJson(port, '/api/agent-outcomes?all=1')).outcomes?.length ?? 0;

    const stalled = await pollFor(() => serverSnapshot(port, id),
      (s) => s && s.running.filter((r) => r.state === 'stalled').length === 2, E2E_WINDOW + 15000);
    const srows = stalled.v?.running.filter((r) => r.state === 'stalled') ?? [];
    check('B1b THE CORE: progress stops → both rows surface as ⚠ STALLED within the window — not blank, not removed',
      stalled.ok && stalled.v.running.filter((r) => r.row !== 'main').length === 2,
      { states: stalled.v?.running.map((r) => `${r.id}:${r.state ?? '(none)'}`) });
    check('B1c the ⚠ carries evidence: last progress time + what was checked',
      srows.length === 2 && srows.every((r) =>
        Number.isFinite(r.stall?.lastProgressAt) && r.stall?.stalledForMs > E2E_WINDOW
        && /no frame or counter progress/.test(r.stall?.checked ?? '')
        && /no live process signal/.test(r.stall?.checked ?? '')),
      srows.map((r) => r.stall?.checked?.slice(0, 110)));
    check('B1d the MAIN row is not the stall detector\'s business (the authority\'s backstop owns it)',
      stalled.v?.running.find((r) => r.id === 'main')?.state !== 'stalled',
      stalled.v?.running.find((r) => r.id === 'main'));

    const outcomesAfter = (await getJson(port, '/api/agent-outcomes?all=1')).outcomes ?? [];
    check('B1e A STALL IS NOT A DEATH: the outcomes ledger is untouched by the stall (BUG-041 invariants intact)',
      outcomesAfter.length === outcomesBefore
        && !outcomesAfter.some((o) => srows.some((r) => r.id === o.agentId)),
      { before: outcomesBefore, after: outcomesAfter.length });

    const ui = await pollFor(() => page.evaluate(READ_STRIP),
      (u) => u.rows.filter((r) => r.gl === '⚠').length === 2, 15000);
    check('B1f WHAT THE USER SEES: the strip shows the two rows as ⚠ (distinct from ◐), reason on the row\'s tooltip',
      ui.ok && ui.v.rows.filter((r) => r.gl === '⚠').every((r) => r.stallCls && /stalled — no frame or counter progress/.test(r.title)),
      ui.v?.rows);
    check('B1g the summary says it out loud instead of counting stalled lanes as running',
      ui.ok && /⚠ 2 stalled/.test(ui.v.sum), ui.v?.sum);

    const board = await pollFor(() => getJson(port, `/api/projects/${encodeURIComponent(projectId)}/board`),
      (b) => (b.needsYou ?? []).filter((x) => x.kind === 'stall').length === 2, E2E_ESCALATE + 15000);
    const cards = (board.v?.needsYou ?? []).filter((x) => x.kind === 'stall');
    check('B1h ESCALATION: past the second window a Needs-You rail card appears, evidence-carrying and ADVISORY',
      board.ok && cards.every((c) => /advisory/.test(c.detail ?? '') && /no frame or counter progress/.test(c.detail ?? '')
        && !c.question),
      cards.map((c) => c.title));
    const railUi = await pollFor(() => page.evaluate(READ_STRIP), (u) => u.railStalls.length === 2, 15000);
    check('B1i the rail card renders read-only (no question box, evidence shown)',
      railUi.ok && railUi.v.railStalls.every((c) => /stalled/.test(c.title) && /advisory/.test(c.detail)),
      railUi.v?.railStalls?.map((c) => c.title));
    await page.close();
  }

  /* ---- B2 — LIVE CHATTY WORK IS NEVER FLAGGED ---- */
  {
    const projectId = await registerProject(port, mkTmp('work2'), 'b46-chatty', settings);
    const { page, id } = await startScenario(browser, port, projectId, 'HOLD_AGENTS:2;TICK:1000 — chatty workers');
    const appear = await pollFor(() => serverSnapshot(port, id),
      (s) => s && s.running.filter((r) => r.row !== 'main').length === 2, 20000, 300);
    check('B2 PRECONDITION: two chatty rows registered', appear.ok, appear.v?.running.map((r) => r.id));
    // Sample across ~2.5 windows: NO sample may ever say stalled.
    let flagged = null;
    const t0 = Date.now();
    while (Date.now() - t0 < E2E_WINDOW * 2.5) {
      const s = await serverSnapshot(port, id);
      const bad = s?.running.find((r) => r.state === 'stalled');
      if (bad) { flagged = bad; break; }
      await sleep(700);
    }
    check('B2a live chatty work is NEVER flagged across 2.5 windows (a false ⚠ on live work is this feature\'s own failure mode)',
      flagged === null, flagged ?? `clean for ${Math.round(E2E_WINDOW * 2.5 / 1000)}s`);
    await page.close();
  }

  /* ---- B3 — RECOVERY CLEARS WITHOUT RESIDUE ---- */
  {
    const projectId = await registerProject(port, mkTmp('work3'), 'b46-recover', settings);
    const { page, id } = await startScenario(browser, port, projectId,
      `HOLD_AGENTS:1;TICK:1000:${E2E_WINDOW + 3000} — silent past the window, then progress resumes`);
    const stalled = await pollFor(() => serverSnapshot(port, id),
      (s) => s && s.running.some((r) => r.state === 'stalled'), E2E_WINDOW + 12000);
    check('B3a the row genuinely stalls first (silence past the window before the ticks start)',
      stalled.ok, stalled.v?.running.map((r) => `${r.id}:${r.state ?? '(none)'}`));
    const recovered = await pollFor(() => serverSnapshot(port, id),
      (s) => s && s.running.filter((r) => r.row !== 'main').length === 1
        && s.running.filter((r) => r.row !== 'main').every((r) => r.state === 'running'), 20000);
    const rrow = recovered.v?.running.find((r) => r.row !== 'main');
    check('B3b RECOVERY: progress resumed → the row is \'running\' again, still present the whole time, NO stall residue',
      recovered.ok && rrow?.state === 'running' && rrow?.stall === undefined, rrow);
    const uiBack = await pollFor(() => page.evaluate(READ_STRIP),
      (u) => u.rows.some((r) => r.key === rrow?.id && r.gl === '◐'), 15000);
    check('B3c the strip row is back to ◐ with no ⚠ left anywhere', uiBack.ok && uiBack.v.rows.every((r) => r.gl !== '⚠'), uiBack.v?.rows);
    const b = await getJson(port, `/api/projects/${encodeURIComponent(projectId)}/board`);
    check('B3d no stall rail card survives recovery (computed, never persisted — nothing to dismiss)',
      (b.needsYou ?? []).filter((x) => x.kind === 'stall').length === 0,
      { stallCards: (b.needsYou ?? []).filter((x) => x.kind === 'stall').length });
    const outs = (await getJson(port, '/api/agent-outcomes?all=1')).outcomes ?? [];
    check('B3e the whole stall→recovery cycle wrote NOTHING to the outcomes ledger',
      !outs.some((o) => o.agentId === rrow?.id), { outcomes: outs.length });
    await page.close();
  }

  stopByPid(srv.pid);
}

/* ------------------------------------------------------------------- main */

let browser = null;
try {
  await partA();
  if (!fs.existsSync(BRAVE)) {
    check('B the browser exists for the E2E half (set QA_BRAVE_PATH)', false, BRAVE);
  } else {
    browser = await chromium.launch({ headless: true, executablePath: BRAVE });
    await partB(browser);
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
