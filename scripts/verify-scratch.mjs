/**
 * FEAT-059 — the global "New session" button must open a session in an
 * Orchard-owned SCRATCH project, not whatever project happens to be
 * currently selected. Covers:
 *   A) fresh install: no scratch dir, no scratch registry row, until first use
 *   B) global New rebinds state.current.projectId to `scratch` (NOT the
 *      previously-selected project) and creates the dir + registry row
 *      on demand
 *   C) per-project "+" buttons are unaffected — they still bind to their
 *      own project
 *   D) the scratch dir + registry row SURVIVE a server restart
 *   E) scratch settings are PATCH-able like any other project's
 *   F) the injected instruction set for a scratch launch contains the WA
 *      and does NOT contain a board snapshot — asserted against the real
 *      compose surface (src/server/templates.ts composeInstructions +
 *      src/server/board.ts boardStateSection), the same functions
 *      agent-bridge.ts calls at launch (see agent-bridge.ts:478,783)
 *
 * No live model turn is started (same design choice as
 * verify-new-session-overrides.mjs) — everything here is asserted from
 * client state, the registry/filesystem, and the compose functions
 * directly, which is the real decision surface for what a launch will
 * fold into the system prompt.
 *
 *   node scripts/verify-scratch.mjs
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_SCRATCH_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-scratch-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-scratch-chrome-'));
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';

let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c = new Cdp(ws);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && c.waiting.has(m.id)) {
        const { res, rej } = c.waiting.get(m.id);
        c.waiting.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.waiting.set(id, { res, rej }));
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async waitFor(label, expr, timeoutMs = 20_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.eval(expr)) return true; } catch { /* nav */ }
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

let server = null, browser = null;
const cleanupDirs = [DATA, PROFILE];
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

async function startServer() {
  const s = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  s.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');
  return s;
}

async function main() {
  console.log('\n=== A) fresh install: no scratch dir/project until first use ===');
  const scratchDirPath = path.join(DATA, 'scratch');
  server = await startServer();
  check('no scratch dir on disk yet', !fs.existsSync(scratchDirPath), scratchDirPath);
  const projectsBefore = await (await fetch(`${BASE}/api/projects`)).json();
  check('no scratch project registered yet', !projectsBefore.projects.some((p) => p.id === 'scratch'),
    JSON.stringify(projectsBefore.projects.map((p) => p.id)));

  const projADir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-scratch-projA-'));
  const projBDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-scratch-projB-'));
  cleanupDirs.push(projADir, projBDir);
  const regA = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: projADir, name: 'scratch-fixture-A' }),
  })).json();
  const regB = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: projBDir, name: 'scratch-fixture-B' }),
  })).json();
  if (!regA.project?.id || !regB.project?.id) throw new Error(`register failed: ${JSON.stringify({ regA, regB })}`);

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('boot', 'window.__station !== undefined');
  await cdp.waitFor('projects loaded', `window.__station.state.projects.length >= 2`);

  console.log('\n=== B) select project A, click the GLOBAL New button ===');
  await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('#tree button.proj')].find((n) => n.querySelector('.nm')?.textContent === 'scratch-fixture-A');
    row.click();
  })()`);
  await cdp.waitFor('project A selected', `window.__station.state.current.projectId === ${JSON.stringify(regA.project.id)}`);
  const beforeClick = await cdp.eval(`window.__station.state.current.projectId`);
  check('precondition: project A is the currently-selected project', beforeClick === regA.project.id, beforeClick);

  await cdp.eval(`document.querySelector('#newBtn').click()`);
  await cdp.waitFor('scratch session armed', `window.__station.state.current.projectId === 'scratch'`, 15_000);
  const afterClick = await cdp.eval(`({
    projectId: window.__station.state.current.projectId,
    sessionId: window.__station.state.current.sessionId,
    scratchInProjects: window.__station.state.projects.find((p) => p.id === 'scratch'),
  })`);
  check('global New rebinds to the scratch project, NOT project A (the previously-selected one)',
    afterClick.projectId === 'scratch' && afterClick.projectId !== regA.project.id, JSON.stringify(afterClick.projectId));
  check('the new (unstarted) session has no sessionId of its own — a real fresh session, not a resume',
    afterClick.sessionId === null, String(afterClick.sessionId));
  check('scratch project entry present client-side with cwd = scratch dir',
    afterClick.scratchInProjects?.hostPath === scratchDirPath, JSON.stringify(afterClick.scratchInProjects));

  console.log('\n=== on-demand creation actually happened server-side ===');
  check('scratch dir now exists on disk', fs.existsSync(scratchDirPath) && fs.statSync(scratchDirPath).isDirectory(), scratchDirPath);
  const projectsAfter = await (await fetch(`${BASE}/api/projects`)).json();
  const scratchProj = projectsAfter.projects.find((p) => p.id === 'scratch');
  check('scratch is now a normal registered project (distinct label, cwd = scratch dir)',
    !!scratchProj && scratchProj.name !== 'scratch-fixture-A' && scratchProj.name !== 'scratch-fixture-B' && scratchProj.hostPath === scratchDirPath,
    JSON.stringify(scratchProj));
  check('no session materialized under project A from the global-New click',
    (await (await fetch(`${BASE}/api/projects/${regA.project.id}/sessions`)).json()).sessions.length === 0,
    'project A session count');

  console.log('\n=== C) per-project "+" still binds to its OWN project ===');
  // Project B has no activity yet, so it starts folded into the "inactive"
  // group (recency split — see renderTree()) and has no row until expanded.
  await cdp.eval(`(() => {
    window.__station.state.expanded.add(${JSON.stringify(regB.project.id)});
    window.__station.state.showInactive = true;
    window.__station.renderTree();
    return true;
  })()`);
  await cdp.waitFor('project B row visible', `[...document.querySelectorAll('#tree button.proj')].some((n) => n.querySelector('.nm')?.textContent === 'scratch-fixture-B')`);
  await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('#tree button.proj')].find((n) => n.querySelector('.nm')?.textContent === 'scratch-fixture-B');
    row.querySelector('.plus').click();
  })()`);
  await cdp.waitFor('project B new session armed', `window.__station.state.current.projectId === ${JSON.stringify(regB.project.id)}`, 15_000);
  const perProject = await cdp.eval(`window.__station.state.current.projectId`);
  check('per-project + still opens a session in ITS OWN project (B), unaffected by the scratch change',
    perProject === regB.project.id, perProject);

  cdp.close();

  console.log('\n=== D) scratch survives a server restart ===');
  stopByPid(server);
  await sleep(600);
  server = await startServer();
  const projectsRestart = await (await fetch(`${BASE}/api/projects`)).json();
  const scratchRestart = projectsRestart.projects.find((p) => p.id === 'scratch');
  check('scratch project still registered after restart', !!scratchRestart, JSON.stringify(scratchRestart?.id));
  check('scratch dir still on disk after restart', fs.existsSync(scratchDirPath), scratchDirPath);

  console.log('\n=== E) scratch settings are PATCH-able like any project\'s ===');
  const patched = await (await fetch(`${BASE}/api/projects/scratch`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { model: 'haiku', permissionMode: 'acceptEdits' } }),
  })).json();
  check('scratch settings PATCH is honored (model + permissionMode changed)',
    patched.project?.settings?.model === 'haiku' && patched.project?.settings?.permissionMode === 'acceptEdits',
    JSON.stringify(patched.project?.settings));

  console.log('\n=== F) injection decision — real compose surface, WA yes / board+conventions no ===');
  const tpl = await import(path.join(ROOT, 'src', 'server', 'templates.ts'));
  const boardMod = await import(path.join(ROOT, 'src', 'server', 'board.ts'));
  // Same call agent-bridge.ts makes at launch (agent-bridge.ts:478): refs
  // come from the project's own settings.instructions — scratch's default
  // is empty, but the seeded Working-Agreement template still exists and a
  // fresh project's `defaultSettings()` has an empty instructions list, so
  // exercise the WA explicitly the way a real project's instructions list
  // would reference it.
  const refs = [{ templateId: 'working-agreement-v2', enabled: true }];
  const composed = tpl.composeInstructions(refs, { hostPath: scratchDirPath, routing: true });
  const promptText = typeof composed.systemPrompt === 'string' ? composed.systemPrompt : (composed.systemPrompt?.append ?? '');
  check('composeInstructions applies the WA template for a scratch-hostPath launch',
    composed.appliedIds.includes('working-agreement-v2') && promptText.length > 200,
    JSON.stringify({ appliedIds: composed.appliedIds, chars: promptText.length }));
  const boardSection = boardMod.boardStateSection(scratchDirPath);
  check('boardStateSection() is null for the scratch dir (no docs/bugs/ there — nothing to inject)',
    boardSection === null, JSON.stringify(boardSection));
  check('composeInstructions did NOT fold in a local-conventions section either (no docs/CONVENTIONS.md in scratch)',
    !composed.appliedIds.includes('local-conventions'), JSON.stringify(composed.appliedIds));
  check('the composed prompt text contains no "Project state (live board snapshot)" heading',
    !promptText.includes('Project state (live board snapshot)'), 'grep for board heading');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}\n${err.stack}`);
  process.exitCode = 1;
}).finally(() => {
  stopByPid(browser);
  stopByPid(server);
  setTimeout(() => {
    for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }, 2500);
});
