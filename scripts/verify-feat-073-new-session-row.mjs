/**
 * FEAT-073 — a newly-opened (unsent) "New session" must appear at the TOP of its
 * project in the sidebar, marked current/open; if the user navigates away WITHOUT
 * sending it is REMOVED (no orphan) while the BUG-083 draft survives; once the
 * first message sends and the session is real, it becomes a normal row with NO
 * duplicate.
 *
 * Real-shape: boots the REAL app.js in happy-dom against a REAL server and drives
 * the REAL startNew / openSession / renderTree over controlled state. Nothing here
 * re-implements the row builder, the pending-row derivation, or the draft map.
 *
 * The live SDK turn that makes a new session real cannot run in-harness (no
 * provider), so the "first message sent" step drives the resulting client state
 * the send handler produces — station bridge live, then current+list pointing at
 * the real session — exactly as BUG-083's verify simulated its switches. The
 * assertion is on renderTree's output, which is the FE change under test.
 *
 * PRE-FIX assertions that FAIL: startNew renders NO row for the pending session
 * (it lived only in state.current, never in the tree), so "a pending row at the
 * top, marked current" cannot hold.
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat073-data-'));
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
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const HOUR = 3600 * 1000;

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
  console.log('\n========== FEAT-073 — pending new-session row at top, dropped if abandoned, draft preserved ==========');
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

    const PID = 'p-new';
    const ENC = 'enc-new';
    const mk = (id, title, msAgo, extra = {}) => ({
      sessionId: id, encodedDir: ENC, displayTitle: title, os: 'linux',
      lastActivityAt: iso(msAgo), ...extra,
    });
    // A project with two settled, on-disk sessions already.
    const baseList = () => [mk('OLD1', 'OLD1', 2 * HOUR), mk('OLD2', 'OLD2', 3 * HOUR)];
    st.projects = [{
      id: PID, name: 'Fresh', lastActivityAt: iso(1 * HOUR), hostPath: '/tmp/fresh',
      isolation: 'direct', settings: { instructions: [], mounts: [] },
    }];
    st.projSort = 'recency'; S.resortProjects();
    st.expanded = new Set([PID]);
    st.seen = new Map();
    st.stationSessionId = null;
    st.current = { projectId: null, encodedDir: null, sessionId: null, title: null, os: null };
    st.sessions = new Map([[PID, { loaded: true, loading: false, error: null, list: baseList(), shown: 10, encodedDir: ENC, dirs: [] }]]);
    S.renderTree();

    const groupOf = () => qa('#tree .pgroup')
      .find((gr) => gr.querySelector('.proj .nm')?.textContent.trim() === 'Fresh');
    const rowsOf = (gr) => [...(gr?.querySelectorAll('.kids button.row') ?? [])];
    const pendingRows = (gr) => rowsOf(gr).filter((r) => r.classList.contains('pending'));
    const rowText = (r) => r.textContent.replace(/\s+/g, ' ').trim();

    // ===== 1. startNew → a pending row at the TOP, marked current =====
    S.startNew(PID);
    await sleep(50);
    let gr = groupOf();
    let rows = rowsOf(gr);
    const pend = pendingRows(gr);
    check('startNew renders a pending "New session" row (must FAIL pre-fix: no row for the unsent session)',
      pend.length === 1, `pending rows=${pend.length}`);
    check('the pending row sits at the TOP of the project',
      rows[0] && rows[0].classList.contains('pending'), `first row="${rows[0] ? rowText(rows[0]) : '(none)'}"`);
    check('the pending row is marked current/open (aria-current="true")',
      pend[0]?.getAttribute('aria-current') === 'true', `aria-current=${pend[0]?.getAttribute('aria-current')}`);
    check('the pending row reads as the New session',
      /New session$/.test(rowText(pend[0] ?? rows[0])), `text="${rowText(pend[0] ?? rows[0])}"`);
    check('the two real on-disk sessions still render below it (pending is additive)',
      rows.some((r) => /OLD1$/.test(rowText(r))) && rows.some((r) => /OLD2$/.test(rowText(r))),
      rows.map(rowText));

    // ===== 2. switch away WITHOUT sending → row gone, draft preserved =====
    // Type a draft into the composer, then open a real session (navigate away).
    const DRAFT = 'a half-typed prompt for the new session';
    // The composer element is #prompt in index.html; drive it the way a user would.
    const composer = doc.getElementById('prompt');
    composer.value = DRAFT;

    const realSess = st.sessions.get(PID).list.find((x) => x.sessionId === 'OLD1');
    const proj = st.projects[0];
    await S.openSession(proj, realSess);
    await sleep(50);
    gr = groupOf();
    check('after switching away unsent, the pending row is GONE (no orphan)',
      pendingRows(gr).length === 0, `pending rows=${pendingRows(gr).length} titles=${rowsOf(gr).map(rowText)}`);
    // The pending-new draft lives under the SAME `p <projectId>` key BUG-083 uses
    // (built via the real draftKey, whose delimiter is not a literal space).
    const pendKey = S.draftKey({ projectId: PID, encodedDir: null, sessionId: null });
    check('the BUG-083 pending-new draft was saved under its own project key (removal did not wipe it)',
      st.drafts.get(pendKey) === DRAFT, `key=${JSON.stringify(pendKey)} saved="${st.drafts.get(pendKey)}"`);

    // Return to New session in this project → the draft is restored (BUG-083).
    S.startNew(PID);
    await sleep(50);
    gr = groupOf();
    check('returning to New session restores the saved draft into the composer (BUG-083 anti-regression)',
      doc.getElementById('prompt').value === DRAFT, `composer="${doc.getElementById('prompt').value}"`);
    check('the pending row is back at the top on return',
      rowsOf(gr)[0]?.classList.contains('pending'), `first row="${rowsOf(gr)[0] ? rowText(rowsOf(gr)[0]) : '(none)'}"`);

    // ===== 3. first message sent → real session, exactly one row, no dupe =====
    // The turn starts: a live station bridge is established. The pending row must
    // drop the instant the session stops being purely-unsent.
    st.stationSessionId = 'station-live-1';
    S.renderTree();
    gr = groupOf();
    check('once the first turn starts (station bridge live), the pending row drops',
      pendingRows(gr).length === 0, `pending rows=${pendingRows(gr).length}`);

    // The session becomes real/on-disk: current + list now point at NEW-REAL.
    const realNew = mk('NEW-REAL', 'first real message', 0);
    st.current = { projectId: PID, encodedDir: ENC, sessionId: 'NEW-REAL', title: 'first real message', os: 'linux' };
    st.sessions.set(PID, { loaded: true, loading: false, error: null, list: [realNew, ...baseList()], shown: 10, encodedDir: ENC, dirs: [] });
    S.renderTree();
    gr = groupOf();
    const rows3 = rowsOf(gr);
    check('the real session renders exactly once — no pending duplicate beside it',
      rows3.filter((r) => /first real message$/.test(rowText(r))).length === 1 && pendingRows(gr).length === 0,
      `matches=${rows3.filter((r) => /first real message$/.test(rowText(r))).length} pending=${pendingRows(gr).length} titles=${rows3.map(rowText)}`);
    check('the now-real session is the current/open one',
      rows3.find((r) => /first real message$/.test(rowText(r)))?.getAttribute('aria-current') === 'true',
      `aria-current=${rows3.find((r) => /first real message$/.test(rowText(r)))?.getAttribute('aria-current')}`);
  } finally {
    try {
      const st2 = win.__station?.state;
      if (st2?.snapPollTimer) { clearInterval(st2.snapPollTimer); st2.snapPollTimer = null; }
      if (st2?.liveTimer) { clearInterval(st2.liveTimer); st2.liveTimer = null; }
      if (st2?.railPollTimer) { clearInterval(st2.railPollTimer); st2.railPollTimer = null; }
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
