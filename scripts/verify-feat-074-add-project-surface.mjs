/**
 * FEAT-074 — adding a project must (A) open a fresh NEW session (the FEAT-073
 * pending-new active row), NOT auto-open a detected old session, and (B) SURFACE
 * the just-added project so the user can find it: floated to the TOP of the
 * sidebar (temporarily-most-recent) and/or scrolled into view, with the opened
 * (pending) session aria-current. Moving away unsent drops the pending row
 * (FEAT-073) and the project keeps its natural sort thereafter.
 *
 * Real-shape: boots the REAL app.js in happy-dom against a REAL server (the
 * BUG-083/087 idiom) and drives the REAL addProject over a freshly-created temp
 * directory the server registers, asserting on the tree the real renderTree
 * produced.
 *
 * PRE-FIX (before the FEAT-074 edit — addProject set a bare New-session
 * state.current with no pendingNew, no surfacing) the must-FAIL assertions FAIL:
 * no pending-new active row for the added project, state.pendingNew unset, and
 * the added project sinks to the BOTTOM of the recency order instead of the top.
 * The FEAT-073 anti-regress (move away unsent -> the pending row drops) stays
 * green pre AND post.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Window } from 'happy-dom';
import WebSocket from 'ws';
import { findNeighborProject } from './lib/neighbor-project.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat074-data-'));
const NEIGHBOR = findNeighborProject({ excludePath: ROOT });
const NB = path.basename(NEIGHBOR);
// The project we ADD — a fresh dir (createProject only needs it to exist). Named
// with a leading 'zzz' so a PRE-FIX recency/alpha sort would place it LAST, which
// makes the "surfaces to the TOP" assertion a genuine must-FAIL pre-fix.
const ADDED = fs.mkdtempSync(path.join(os.tmpdir(), 'zzz-feat074-added-'));

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

async function main() {
  console.log('\n========== FEAT-074 — add-project opens a new active session + surfaces the project ==========');
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
  const NEIGHBOR_ID = (await reg.json()).project.id;

  // ---- boot the REAL app.js in happy-dom against the REAL server
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const win = new Window({ url: `${BASE}/` });
  const doc = win.document;
  doc.write(html.replace(/<link[^>]*>/g, '').replace(/<script[^>]*><\/script>/g, ''));
  doc.close();

  const g = win;
  const realFetch = globalThis.fetch;
  g.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    return realFetch(url.startsWith('http') ? url : BASE + url, init);
  };
  const openSockets = [];
  class TrackedWebSocket extends WebSocket { constructor(...a) { super(...a); openSockets.push(this); } }
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
    const projName = (n) => n.querySelector('.nm')?.textContent?.trim() ?? '';

    const booted = await waitFor('project list', () => qa('#tree button.proj').length > 0);
    if (!booted) throw new Error('app.js never rendered any project row');

    const S = win.__station;
    const st = S.state;
    const ADDED_NAME = path.basename(ADDED);

    // The added project's rendered group (its own .pgroup), so we can look at ITS
    // rows — not another project's.
    const addedGroup = () => qa('#tree .pgroup').find((gr) => projName(gr.querySelector('.proj')) === ADDED_NAME);
    const addedPendingRow = () => addedGroup()?.querySelector('button.row.pending') ?? null;
    const firstProjName = () => projName(qa('#tree .pgroup')[0]?.querySelector('.proj'));

    // ---- drive the REAL add-project
    await S.addProject(ADDED, ADDED_NAME);
    await sleep(200);
    const added = st.projects.find((p) => p.name === ADDED_NAME);
    check('precondition: the project was registered on the server + client', !!added, added ? added.id : 'MISSING');
    if (!added) throw new Error('addProject did not register the project');

    // ============================ PART A — opens a NEW pending session ============================
    check('A: the opened session is a NEW one (no sessionId/encodedDir), not a detected old session',
      st.current.projectId === added.id && st.current.sessionId === null && st.current.encodedDir === null,
      `current.project=${st.current.projectId} sessionId=${st.current.sessionId} encodedDir=${st.current.encodedDir}`);
    check('A: MUST-FAIL PRE-FIX — state.pendingNew points at the added project (the FEAT-073 pending-new row)',
      st.pendingNew === added.id, `pendingNew=${st.pendingNew} added=${added.id}`);
    check('A: MUST-FAIL PRE-FIX — a pending-new row exists for the added project and is aria-current (active)',
      !!addedPendingRow() && addedPendingRow().getAttribute('aria-current') === 'true',
      `pendingRow=${!!addedPendingRow()} aria-current=${addedPendingRow()?.getAttribute('aria-current') ?? 'none'}`);

    // ============================ PART B — the project SURFACES ============================
    check('B: MUST-FAIL PRE-FIX — the added project floats to the TOP of the ordered project list',
      S.orderedProjects()[0]?.id === added.id, `top=${S.orderedProjects()[0]?.id} added=${added.id}`);
    check('B: MUST-FAIL PRE-FIX — the added project is the FIRST group rendered in the sidebar (findable, not off at the bottom)',
      firstProjName() === ADDED_NAME, `first group=${JSON.stringify(firstProjName())} added=${ADDED_NAME}`);

    // ============================ REGRESSION (FEAT-073) — move away unsent drops the pending row ==========
    // Navigate away without sending: start a New session in the neighbor project.
    // The added project's pending row must drop (it never became a real session),
    // and the added project keeps its natural (now-relaxed) sort thereafter.
    S.startNew(NEIGHBOR_ID);
    await sleep(120);
    check('REGRESSION (FEAT-073): moving away unsent drops the added project\'s pending row',
      addedPendingRow() === null && st.pendingNew === NEIGHBOR_ID,
      `addedPendingRow=${addedPendingRow() === null ? 'gone' : 'still there'} pendingNew=${st.pendingNew}`);
  } finally {
    try {
      const st2 = win.__station?.state;
      if (st2?.snapPollTimer) { clearInterval(st2.snapPollTimer); st2.snapPollTimer = null; }
      if (st2?.liveTimer) { clearInterval(st2.liveTimer); st2.liveTimer = null; }
      if (st2?.drainWaitTimer) { clearInterval(st2.drainWaitTimer); st2.drainWaitTimer = null; }
    } catch { /* app never booted that far */ }
    for (const s of openSockets) { try { s.removeAllListeners?.(); s.close(); } catch { /* closed */ } }
    await sleep(300);
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
  try { fs.rmSync(ADDED, { recursive: true, force: true }); } catch { /* ignore */ }
  setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
});
