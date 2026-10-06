/**
 * FEAT-070 amendment (2026-10-05 user decision) — a session the USER started
 * stays inside the sidebar's recent window for at least 24h, however brief it
 * is; agent-started / fold-by-default brief sessions keep today's 2h behaviour.
 *
 * Real-shape: boots the REAL app.js in happy-dom against a REAL server, seats a
 * single project, and drives the REAL renderTree over a session list whose only
 * seating lever is the recency WINDOW — every row is stamped SEEN (so attention
 * never buys the seat) and none is pinned/open/live. The row set a brief session
 * gets is therefore decided by `withinRecentWindow` alone.
 *
 * Which app.js is imported is parametrised by APP_JS (absolute path to a file in
 * public/, so its ./lib/* imports resolve). The driver copies app.js to a
 * pre-fix sibling with the amendment reverted and runs the SAME assertions
 * against it: pre-fix the user-started 20h brief row FAILS to seat (2h window);
 * post-fix it seats and the 30h one / agent-started one still do not.
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
const APP_JS = process.env.APP_JS || path.join(ROOT, 'public', 'app.js');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat070ub-data-'));
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
  console.log(`\n========== FEAT-070 amendment — user-started brief sessions keep a 24h window (APP_JS=${path.basename(path.dirname(APP_JS))}/${path.basename(APP_JS)}) ==========`);
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
    await import(`${APP_JS}?ui=${Date.now()}`);
    const qa = (s) => [...doc.querySelectorAll(s)];
    const booted = await waitFor('project list', () => qa('#tree button.proj').length > 0);
    if (!booted) throw new Error('app.js never rendered any project row');

    const S = win.__station;
    const st = S.state;

    const PID = 'p-ub';
    st.projects = [{ id: PID, name: 'Windowed', lastActivityAt: iso(1 * HOUR), hostPath: '/tmp/ub' }];
    st.projSort = 'recency'; S.resortProjects();
    st.expanded = new Set([PID]);
    st.current = { projectId: null, encodedDir: null, sessionId: null, title: null, os: null };

    const ENC = 'enc-ub';
    // Brief (messageCount 2 < SUBSTANTIAL_MSGS). provenance + age vary.
    const mk = (id, msAgo, extra = {}) => ({
      sessionId: id, encodedDir: ENC, displayTitle: id, os: 'linux',
      lastActivityAt: iso(msAgo), messageCount: 2, ...extra,
    });
    const list = [
      mk('U20', 20 * HOUR, { startedBy: 'user', foldByDefault: false }),   // user, brief, 20h → seat (24h win)
      mk('A20', 20 * HOUR, { startedBy: 'agent', foldByDefault: true }),   // agent lane, brief, 20h → folded
      mk('U30', 30 * HOUR, { startedBy: 'user', foldByDefault: false }),   // user, brief, 30h → out of 24h win
      mk('UANCHOR', 1 * HOUR, { startedBy: 'user', foldByDefault: false }), // a plainly-recent row so the group renders
    ];
    // Stamp EVERY row seen in the future → none is "attention": the recency
    // window is the ONLY lever that can seat a brief row here.
    st.seen = new Map(list.map((x) => [`${ENC} ${x.sessionId}`, iso(-HOUR)]));
    st.sessions = new Map([[PID, { loaded: true, loading: false, error: null, list, shown: 6, encodedDir: ENC, dirs: [] }]]);

    S.renderTree();
    const group = qa('#tree .pgroup').find((gr) => gr.querySelector('.proj .nm')?.textContent.trim() === 'Windowed');
    const rowIds = () => [...(group?.querySelectorAll('.kids button.row') ?? [])]
      .map((r) => r.textContent.replace(/\s+/g, ' ').trim());
    const shows = (t) => rowIds().some((s) => s.split(' ').includes(t) || s.endsWith(t));

    const ids = rowIds();
    check('amendment: a USER-started brief session aged ~20h IS seated (must FAIL pre-fix: 2h window folds it)',
      shows('U20'), ids);
    check('amendment: an AGENT-started brief session aged ~20h is NOT seated (folds, unchanged)',
      !shows('A20'), ids);
    check('amendment: a USER-started brief session aged ~30h is NOT seated (past the 24h window)',
      !shows('U30'), ids);
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
