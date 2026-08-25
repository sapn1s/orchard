/**
 * FEAT-071 — surface the selected project's associated host directory in the UX.
 *
 *   A project maps to a host directory (registry `hostPath`) but the UI showed
 *   it NOWHERE — after a rename/relocation the user could not confirm the path.
 *   Fix: a low-chrome "Directory" line at the top of the Project settings drawer
 *   (shortPath for display, FULL path in the title attr), and the crown project
 *   name carries the full path as a hover title too.
 *
 * Real-shape: boots the REAL app.js in happy-dom against a REAL server, registers
 * a real neighbour project, selects it, drives the REAL drawer.open('settings')
 * and paintCrown, and asserts on the produced DOM — matching the value against
 * the registry's hostPath fetched from the server.
 *
 * PRE-FIX assertions that FAIL: the settings drawer has no `.proj-dir` line, so
 * the path appears nowhere.
 *
 * Leak hygiene: this file hardcodes NO home path; the neighbour path is
 * discovered at runtime and only ever rendered through dom.js shortPath.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Window } from 'happy-dom';
import WebSocket from 'ws';
import { findNeighborProject } from './lib/neighbor-project.mjs';
import { shortPath } from '../public/lib/dom.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat071-data-'));
const NEIGHBOR = findNeighborProject({ excludePath: ROOT });
const NB = path.basename(NEIGHBOR);

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
async function waitFor(label, fn, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (fn()) return true; await sleep(100); }
  console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
  return false;
}

let server = null;

// Opening the settings drawer kicks off background fetches (e.g. refreshMemories)
// that can settle AFTER teardown kills the server — a server-unreachable
// rejection then, not a test failure. Swallow only that race; anything else
// still fails the run.
process.on('unhandledRejection', (err) => {
  if (err && (err.status === 0 || /unreachable|fetch failed/i.test(String(err.message ?? '')))) return;
  console.error(`\nUNHANDLED: ${err?.stack ?? err}`);
  process.exitCode = 1;
});

async function main() {
  console.log('\n========== FEAT-071 — show the selected project directory (shortPath in settings + tooltip) ==========');
  if (!fs.existsSync(NEIGHBOR)) throw new Error(`precondition failed: ${NEIGHBOR} missing`);
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;

  server = spawn(process.execPath, [ENTRY], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'ignore', 'pipe'], detached: true,
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(200); } }
  if (!up) throw new Error('server never became healthy');

  const reg = await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: NEIGHBOR, name: NB }),
  });
  if (!reg.ok) throw new Error(`could not register ${NB}: ${await reg.text()}`);
  const registered = await reg.json();
  const REG_PATH = registered.hostPath ?? registered.project?.hostPath;

  // ---- boot the REAL app.js in happy-dom against the REAL server
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const win = new Window({ url: `${BASE}/` });
  const doc = win.document;
  doc.write(html.replace(/<link[^>]*>/g, '').replace(/<script[^>]*><\/script>/g, ''));
  doc.close();

  const g = win;
  const realFetch = globalThis.fetch;
  g.fetch = (input, init) => realFetch(input.startsWith('http') ? input : BASE + input, init);
  const openSockets = [];
  class TrackedWebSocket extends WebSocket {
    constructor(...a) { super(...a); this.on('error', () => {}); openSockets.push(this); }
  }
  g.WebSocket = TrackedWebSocket;
  win.location.host = `127.0.0.1:${PORT}`;

  const prev = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch };
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.WebSocket = g.WebSocket;
  globalThis.location = win.location;
  globalThis.fetch = g.fetch;

  try {
    await import(`${path.join(ROOT, 'public', 'app.js')}?ui=${Date.now()}`);
    const qa = (s) => [...doc.querySelectorAll(s)];
    const booted = await waitFor('project list', () => qa('#tree button.proj').length > 0);
    if (!booted) throw new Error('app.js never rendered any project row');

    const S = win.__station;
    const st = S.state;
    const proj = st.projects.find((p) => p.hostPath === REG_PATH) ?? st.projects[0];
    check('precondition: the registered project carries a hostPath from the registry',
      typeof proj?.hostPath === 'string' && proj.hostPath.length > 0, `hostPath=${JSON.stringify(proj?.hostPath)}`);

    // Select the project and open its settings drawer (the real code path a cog
    // click drives).
    st.current = { projectId: proj.id, encodedDir: null, sessionId: null, title: null, os: null };
    S.renderTree();
    await S.drawer.open('settings');
    await waitFor('.proj-dir', () => !!doc.querySelector('.proj-dir'), 5000);

    const dir = doc.querySelector('.proj-dir');
    const shown = dir?.querySelector('.v')?.textContent.trim() ?? '';
    const titleAttr = dir?.getAttribute('title') ?? '';
    const want = shortPath(proj.hostPath);

    check('settings drawer shows a Directory line at all (must FAIL pre-fix: path shown nowhere)',
      !!dir, `dir=${dir ? 'present' : 'MISSING'}`);
    check('the Directory line shows the SHORTENED path (dom.js shortPath)',
      shown === want && shown.length > 0, `shown=${JSON.stringify(shown)} want=${JSON.stringify(want)}`);
    check('the FULL path is in the title attr and matches the registry hostPath',
      titleAttr === proj.hostPath && titleAttr === REG_PATH, `title=${JSON.stringify(titleAttr)} reg=${JSON.stringify(REG_PATH)}`);
    check('the label reads "Directory"',
      dir?.querySelector('.k')?.textContent.trim() === 'Directory', `k=${JSON.stringify(dir?.querySelector('.k')?.textContent.trim())}`);

    // The crown name doubles as a discoverable dir tooltip (full path in title).
    const where = doc.querySelector('#where');
    check('the crown project name carries the full host path as a hover title',
      (where?.getAttribute('title') ?? '').includes(proj.hostPath), `title=${JSON.stringify(where?.getAttribute('title'))}`);
  } finally {
    try {
      const st2 = win.__station?.state;
      if (st2?.snapPollTimer) { clearInterval(st2.snapPollTimer); st2.snapPollTimer = null; }
      if (st2?.liveTimer) { clearInterval(st2.liveTimer); st2.liveTimer = null; }
    } catch { /* never booted */ }
    for (const s of openSockets) { try { s.on('error', () => {}); s.close(); } catch { /* closed */ } }
    await sleep(200);
    globalThis.WebSocket = prev.WebSocket; globalThis.fetch = prev.fetch;
  }
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(async () => {
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : (process.exitCode ?? 0);
  try { if (server?.pid) process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
  await sleep(300);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
  setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
});
