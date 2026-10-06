/**
 * BUG-194 — selecting a PROJECT result in the search palette left a FOREIGN
 * session open in the dock.
 *
 * Symptom: while a session from project A is open in the transcript, the user
 * types part of project B's name in the finder and clicks the project result.
 * The sidebar header switched to B, but A's session stayed on screen — so the
 * header said B while the transcript (and the composer's send target,
 * state.current's encodedDir/sessionId) still belonged to A. "which project is
 * this view showing" had two disagreeing answers (ARCH-010 violation).
 *
 * Decided behaviour (implemented): selecting a project result must land the view
 * FULLY in that project via the ONE project-open transition, startNew() — the
 * same state as clicking the sidebar "+ start a session": foreign session closed,
 * openProjectId = B, a fresh new-session composer for B, and NO agent launched
 * until the user sends. Session/message results are unchanged (openSession
 * already sets the selected project).
 *
 * Real-shape: boots the REAL app.js in happy-dom against a REAL server (the
 * verify-bug-083 idiom). Project A is a real neighbour project with an on-disk
 * session that we open by a real row CLICK. Project B is a second registered
 * project. The palette is driven through the REAL DOM: type B's name into
 * #findInput, render, and CLICK the real project-hit row button — so the actual
 * projectHitRow() click handler is exercised, not startNew() called directly.
 *
 * PRE-FIX assertions that FAIL (bare selectProject in the handler): after the
 * click openProjectId is still A, state.current.sessionId is still A's, and A's
 * transcript is still painted — the header disagrees with the dock.
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug194-data-'));
const B_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug194-projB-'));
const NEIGHBOR = findNeighborProject({ excludePath: ROOT });
const NB = path.basename(NEIGHBOR);
// A unique, obviously-searchable name for project B that cannot collide with the
// neighbour's own name (substring match) — stands in for the user's example
// project name typed into the finder.
const B_TOKEN = `zqxproj${Date.now().toString(36)}`;

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
  console.log('\n========== BUG-194 — selecting a project result closes the foreign session and opens a fresh composer ==========');
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

  // Project A — the neighbour project with real on-disk sessions.
  const regA = await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: NEIGHBOR, name: NB }),
  });
  if (!regA.ok) throw new Error(`could not register A (${NB}): ${await regA.text()}`);
  const A_ID = (await regA.json()).project.id;

  // Project B — a second, distinctly-named project (needs no sessions; it is the
  // one the user searches for and selects).
  const regB = await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: B_DIR, name: B_TOKEN }),
  });
  if (!regB.ok) throw new Error(`could not register B (${B_TOKEN}): ${await regB.text()}`);
  const B_ID = (await regB.json()).project.id;

  const sessA = await (await fetch(`${BASE}/api/projects/${A_ID}/sessions`)).json();
  const sessionsA = sessA.sessions ?? [];
  check('precondition: project A has at least one on-disk session to open', sessionsA.length > 0,
    `${sessionsA.length} session(s)`);
  if (!sessionsA.length) throw new Error('no A session to open');

  // ---- boot the REAL app.js in happy-dom against the REAL server
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const win = new Window({ url: `${BASE}/` });
  const doc = win.document;
  doc.write(html.replace(/<link[^>]*>/g, '').replace(/<script[^>]*><\/script>/g, ''));
  doc.close();

  const realFetch = globalThis.fetch;
  // Record every fetch so we can prove NO turn/launch request is made by the
  // project-select (a launch would be a POST that carries the prompt to the SDK).
  const fetchLog = [];
  const g = win;
  g.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    fetchLog.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
    return realFetch(url.startsWith('http') ? url : BASE + url, init);
  };
  const openSockets = [];
  class TrackedWebSocket extends WebSocket {
    constructor(...a) { super(...a); openSockets.push(this); this.__sent = []; }
    send(d) { this.__sent.push(String(d)); return super.send(d); }
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
    const projName = (n) => n.querySelector('.nm')?.textContent?.trim() ?? '';

    const booted = await waitFor('project list', () => qa('#tree button.proj').length > 0);
    if (!booted) throw new Error('app.js never rendered any project row');

    const S = win.__station;
    const st = S.state;
    const prompt = () => doc.querySelector('#prompt');
    const boxHidden = () => !!doc.querySelector('#box')?.hidden;
    const transcriptBubbles = () => qa('#panes .pane .you, #panes .pane .claude').length;

    // Project A's real, on-disk session rows.
    const aRows = () => {
      const head = qa('#tree button.proj').find((n) => projName(n) === NB);
      return [...(head?.nextElementSibling?.querySelectorAll('button.row:not(.pending)') ?? [])];
    };
    await waitFor("A's sessions", () => aRows().length > 0);

    // ---- Step 1: open a real session from project A by a real row click.
    aRows()[0].click();
    await waitFor('A transcript', () => transcriptBubbles() > 0 || qa('#panes .pane .hint-row').length > 0, 30000);
    await sleep(250);
    check('setup: a project-A session is open (openProjectId=A, current.sessionId set)',
      st.openProjectId === A_ID && !!st.current.sessionId && st.current.projectId === A_ID,
      `openProjectId=${st.openProjectId === A_ID ? 'A' : st.openProjectId} sessionId=${st.current.sessionId ? 'set' : 'null'} current.projectId=${st.current.projectId === A_ID ? 'A' : st.current.projectId}`);
    const aSessionId = st.current.sessionId;
    const aEncodedDir = st.current.encodedDir;

    // ---- Step 2: open the finder, search for B, and CLICK the real project hit row.
    const finder = () => doc.querySelector('#findInput');
    finder().value = B_TOKEN;
    S.renderTree(); // renders the search view (renderSearch) with the Projects section
    await sleep(50);
    const hitBtn = qa('#tree button.row.hit').find((n) => (n.getAttribute('title') || '') === `Open ${B_TOKEN}`);
    check('palette shows a PROJECT result row for B (searched by name)', !!hitBtn,
      hitBtn ? `found "Open ${B_TOKEN}"` : `no project-hit row (hits=${qa('#tree button.row.hit').length})`);
    if (!hitBtn) throw new Error('project-hit row for B never rendered');

    const fetchesBefore = fetchLog.length;
    hitBtn.click();
    await sleep(300);

    // ---- Assertions on the user-observable outcome ----
    check('B1: the selected project is now B (header follows the selection)',
      st.current.projectId === B_ID && S.currentProject()?.name === B_TOKEN,
      `current.projectId=${st.current.projectId === B_ID ? 'B' : st.current.projectId} name=${S.currentProject()?.name}`);

    check('B2: the FOREIGN session is closed — openProjectId is B, not A (must FAIL pre-fix: stays A)',
      st.openProjectId === B_ID,
      `openProjectId=${st.openProjectId === B_ID ? 'B' : (st.openProjectId === A_ID ? 'A (foreign session still open!)' : st.openProjectId)}`);

    check("B3: A's transcript is no longer on screen (must FAIL pre-fix: A's messages still painted)",
      transcriptBubbles() === 0,
      `transcript bubbles=${transcriptBubbles()}`);

    check('B4: a fresh NEW-SESSION composer for B is shown (box visible, pending-new = B, no session id) (must FAIL pre-fix)',
      !boxHidden() && st.pendingNew === B_ID && st.current.sessionId === null,
      `boxHidden=${boxHidden()} pendingNew=${st.pendingNew === B_ID ? 'B' : st.pendingNew} sessionId=${st.current.sessionId === null ? 'null' : 'set'}`);

    check("B5: the composer now targets B, not A — current.encodedDir/sessionId are NOT A's (must FAIL pre-fix: still A's send target)",
      st.current.sessionId !== aSessionId && st.current.encodedDir !== aEncodedDir && st.current.sessionId === null && st.current.encodedDir === null,
      `sessionId=${st.current.sessionId} (A was ${aSessionId ? 'set' : 'null'}) encodedDir=${st.current.encodedDir} (A was ${aEncodedDir ?? 'null'})`);

    // No agent launched: startNew makes no turn request and sends nothing on any
    // socket. A launch would POST the prompt or send a start frame.
    const newFetches = fetchLog.slice(fetchesBefore);
    const launchFetch = newFetches.find((f) => f.method === 'POST' && /\/(turn|start|messages|prompt|send)/i.test(f.url));
    const socketSends = openSockets.reduce((n, s) => n + (s.__sent?.filter((m) => /"type"\s*:\s*"(start|prompt|turn|user)"/i.test(m)).length || 0), 0);
    check('B6: NO agent/turn was launched by selecting the project (composer waits for the user to send)',
      !launchFetch && socketSends === 0,
      `launchPOST=${launchFetch ? launchFetch.url : 'none'} launchSocketFrames=${socketSends}`);
  } finally {
    try {
      const st2 = win.__station?.state;
      if (st2?.snapPollTimer) { clearInterval(st2.snapPollTimer); st2.snapPollTimer = null; }
      if (st2?.liveTimer) { clearInterval(st2.liveTimer); st2.liveTimer = null; }
      if (st2?.drainWaitTimer) { clearInterval(st2.drainWaitTimer); st2.drainWaitTimer = null; }
      if (st2?.railPollTimer) { clearTimeout(st2.railPollTimer); st2.railPollTimer = null; }
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
  try { fs.rmSync(B_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
});
