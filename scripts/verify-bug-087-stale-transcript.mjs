/**
 * BUG-087 — opening a session (the reported trigger is add-project, but the
 * invariant is general) must show THAT session's transcript, never the
 * previously-viewed one. The header/title is set synchronously from state.current;
 * the transcript pane was painted by an EARLIER open and is only replaced when the
 * open path resets it. addProject changed the header (New session) but never reset
 * the pane, so the CONTENT stayed the previous session's transcript — the reported
 * "header says X, content is Y" mismatch. A slow transcript fetch from the prior
 * session could also land after the switch and paint into the un-reset pane.
 *
 * The fix: the add-project open path now resets the transcript (so header/content
 * agree and the outgoing transcript clears immediately), and openSession carries
 * the transcript-pane sibling of BUG-083's running-strip scope guard — a monotonic
 * `state.txScope` bumped on every boundary (resetTranscript), captured after the
 * reset, that DROPS a transcript fetch landing after the user has switched away.
 *
 * Real-shape: boots the REAL app.js in happy-dom against a REAL server (the
 * BUG-083 idiom). Session A's transcript is stubbed with a unique marker and its
 * fetch is gated at the fetch seam so it can be left IN FLIGHT across the switch —
 * the exact race. The switch is a REAL addProject (a fresh temp dir the server
 * registers). We assert the pane never carries A's marker under the new header.
 *
 * PRE-FIX assertions that FAIL: after addProject the pane still shows A's
 * transcript (stale content under the new header), and a late A fetch repaints it.
 * The regression (a normal, un-raced open still paints its own content) stays
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug087-data-'));
const NEIGHBOR = findNeighborProject({ excludePath: ROOT });
const NB = path.basename(NEIGHBOR);
// A fresh directory for the add-project switch (createProject only needs it to
// exist). It is the project we switch TO — a NEW session, no transcript.
const ADDED = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug087-added-'));

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

function stubTranscript(marker) {
  return {
    messages: [{ role: 'user', index: 0, blocks: [{ type: 'text', text: marker }] }],
    total: 1, offset: 0, totalIsLowerBound: false, tookMs: 1,
  };
}

let server = null;

async function main() {
  console.log('\n========== BUG-087 — transcript pane scoped to the opened session (stale fetch dropped) ==========');
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
  // BUG-087 gate: session A's transcript fetch is held until `gateA` resolves,
  // then answers with A's stubbed transcript (unique marker). This lets A's
  // transcript be left in flight ACROSS the add-project switch — the exact race
  // the txScope guard defends. `api` is a read-only module namespace, so the seam
  // is fetch itself (the same idiom BUG-083's verify used for /running).
  const SESS_A = 'sess-A-0000';
  const MARK_A = 'MARKER_A_TRANSCRIPT_CONTENT';
  let gateA = null; // Promise A's transcript response awaits (null = not armed)
  g.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    if (url.includes('/api/transcript/') && url.includes(SESS_A)) {
      const json = new Response(JSON.stringify(stubTranscript(MARK_A)),
        { status: 200, headers: { 'content-type': 'application/json' } });
      return (gateA ?? Promise.resolve()).then(() => json);
    }
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

    const booted = await waitFor('project list', () => qa('#tree button.proj').length > 0);
    if (!booted) throw new Error('app.js never rendered any project row');

    const S = win.__station;
    const st = S.state;
    const proj = st.projects.find((p) => p.id === NEIGHBOR_ID);
    check('precondition: neighbor project object is on state', !!proj, proj ? proj.name : 'MISSING');
    if (!proj) throw new Error('neighbor project not on state');

    const ENC = '-home-neighbor-encoded';
    const sessA = { encodedDir: ENC, sessionId: SESS_A, title: 'Session A', os: 'linux' };
    const paneText = () => doc.querySelector('#panes')?.textContent ?? '';
    const showsA = () => paneText().includes(MARK_A);

    // ---- REGRESSION baseline: a normal (un-raced) open of A paints A's content.
    await S.openSession(proj, sessA);
    await sleep(120);
    check('REGRESSION: a normal (un-raced) open of A paints A\'s own transcript',
      showsA() && st.current.sessionId === SESS_A,
      `showsA=${showsA()} current=${st.current.sessionId}`);

    // ===================== CASE 1 — add-project must reset the pane =====================
    // A is fully loaded and on screen. Switching to a freshly-added project via
    // addProject must clear A's transcript — header (New session) and content agree.
    await S.addProject(ADDED, path.basename(ADDED));
    await sleep(150);
    const addedProj = st.projects.find((p) => p.hostPath === fs.realpathSync(ADDED) || p.name === path.basename(ADDED));
    check('add-project landed on the new project as a New session (header)',
      !!addedProj && st.current.projectId === addedProj?.id && st.current.sessionId === null,
      `current.project=${st.current.projectId} added=${addedProj?.id} sessionId=${st.current.sessionId}`);
    check('MUST-FAIL PRE-FIX: after add-project the pane does NOT show the previous session\'s transcript (header/content agree)',
      !showsA(), `showsA=${showsA()} pane=${JSON.stringify(paneText().slice(0, 80))}`);

    // ===================== CASE 2 — an in-flight prior fetch is dropped =====================
    // Re-open A with its transcript fetch GATED (left in flight), then add another
    // project. Release A's fetch AFTER the switch: it must not paint under the new
    // header (txScope guard + the pane reset both defend this).
    await S.openSession(proj, sessA); // gate not armed yet: this settles, showing A
    await sleep(120);
    let releaseA = null;
    gateA = new Promise((res) => { releaseA = res; });
    const pA = S.openSession(proj, sessA); // re-open A: its transcript now hangs in flight
    await sleep(60);
    const ADDED2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug087-added2-'));
    await S.addProject(ADDED2, path.basename(ADDED2)); // switch while A's fetch is in flight
    await sleep(120);
    const added2 = st.projects.find((p) => p.name === path.basename(ADDED2));
    check('CASE2: add-project switched to the second new project (New session)',
      st.current.projectId === added2?.id && st.current.sessionId === null,
      `current.project=${st.current.projectId} added2=${added2?.id}`);
    releaseA();
    await pA.catch(() => {});
    await sleep(150);
    check('MUST-FAIL PRE-FIX: a late in-flight transcript fetch from A is dropped, not painted under the new header',
      !showsA() && st.current.sessionId === null,
      `showsA=${showsA()} current=${st.current.sessionId}`);
    try { fs.rmSync(ADDED2, { recursive: true, force: true }); } catch { /* ignore */ }
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
