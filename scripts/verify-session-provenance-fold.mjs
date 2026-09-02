/**
 * Session provenance — the PICKER FOLD, driven through the REAL app.js
 * visibleSessions in happy-dom (same harness as verify-bug-085-sidebar-cap).
 *
 *   An agent-started session (startedBy:'agent') folds out of the DEFAULT view;
 *   a user-started one stays. "N more" reveals the folded agent rows (they are
 *   never permanently unreachable). A LIVE agent session, and the OPEN one, are
 *   NEVER folded — running/on-screen work always shows.
 *
 * ORCHARD_APP_JS overrides which app.js is loaded, so the SAME assertions can be
 * run against a copy with the fold removed — the must-FAIL control (see
 * verify-session-provenance-fold-mustfail.mjs).
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
const APP_JS = process.env.ORCHARD_APP_JS || path.join(ROOT, 'public', 'app.js');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-prov-fold-data-'));
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
  console.log('\n========== session provenance — picker fold (real app.js) ==========');
  console.log(`  app.js = ${APP_JS}`);
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
    await import(`file://${APP_JS}?ui=${Date.now()}`);
    const qa = (s) => [...doc.querySelectorAll(s)];
    const booted = await waitFor('project list', () => qa('#tree button.proj').length > 0);
    if (!booted) throw new Error('app.js never rendered any project row');

    const S = win.__station;
    const st = S.state;

    const PID = 'p-prov';
    const ENC = 'enc-prov';
    // Realistic busy-day state: a handful of the user's OWN sessions, plus MANY
    // recent agent-dispatched rows (ticket-titled) — the exact shape that buries
    // the human's conversations. All recent so recency/attention can't explain
    // the fold; only provenance can.
    const mk = (id, title, msAgo, extra = {}) => ({
      sessionId: id, encodedDir: ENC, displayTitle: title, os: 'linux',
      messageCount: 12, lastActivityAt: iso(msAgo), lastUserMessageAt: iso(msAgo), ...extra,
    });
    st.projects = [{ id: PID, name: 'TradingVol', lastActivityAt: iso(HOUR), hostPath: '/tmp/tv' }];
    st.projSort = 'recency'; S.resortProjects();
    st.expanded = new Set([PID]);
    st.caps = { subagents: null, live: null, running: null, outcomes: null };

    const groupOf = () => qa('#tree .pgroup')
      .find((gr) => gr.querySelector('.proj .nm')?.textContent.trim() === 'TradingVol');
    const rowTitles = (gr) => [...(gr?.querySelectorAll('.kids button.row') ?? [])]
      .map((r) => r.textContent.replace(/\s+/g, ' ').trim());
    const showsIn = (gr, t) => rowTitles(gr).some((s) => s.endsWith(t));
    const moreBtn = (gr) => gr?.querySelector('.kids button.more:not(.less)');

    // Two human sessions + six agent-dispatched (ticket-titled), all within 2h.
    const users = [mk('U0', 'my-own-thread', 1 * HOUR), mk('U1', 'debugging-the-fill', 2 * HOUR)];
    const agents = Array.from({ length: 6 }, (_, i) =>
      mk(`A${i}`, `BUG-${200 + i}`, (i + 1) * HOUR, { startedBy: 'agent' }));
    const list = [...users, ...agents];
    st.seen = new Map();
    st.current = { projectId: null, encodedDir: null, sessionId: null, title: null, os: null };
    st.sessions = new Map([[PID, { loaded: true, loading: false, error: null, list, shown: 6, windowed: true, encodedDir: ENC, dirs: [] }]]);
    S.renderTree();

    let gr = groupOf();
    check('user-started sessions are visible in the default view',
      showsIn(gr, 'my-own-thread') && showsIn(gr, 'debugging-the-fill'), rowTitles(gr));
    check('agent-started sessions are FOLDED out of the default view (must FAIL pre-fix)',
      agents.every((a) => !showsIn(gr, a.displayTitle)), rowTitles(gr));
    check('the folded agent rows are counted under "N more" (6 more)',
      /\b6 more\b/.test(moreBtn(gr)?.textContent.trim() ?? ''), `more=${JSON.stringify(moreBtn(gr)?.textContent.trim())}`);

    // ----- "N more" reveals the agent rows (never permanently unreachable) -----
    moreBtn(groupOf())?.click();
    gr = groupOf();
    check('"N more" reveals every folded agent session',
      agents.every((a) => showsIn(gr, a.displayTitle)), rowTitles(gr));

    // ----- LIVE and OPEN agent sessions are NEVER folded -----
    const liveAgent = mk('ALIVE', 'BUG-500-live', 5 * HOUR, { startedBy: 'agent', live: true });
    const openAgent = mk('AOPEN', 'BUG-501-open', 6 * HOUR, { startedBy: 'agent' });
    const list2 = [...users, ...agents, liveAgent, openAgent];
    st.current = { projectId: PID, encodedDir: ENC, sessionId: 'AOPEN', title: null, os: null };
    st.sessions.set(PID, { loaded: true, loading: false, error: null, list: list2, shown: 6, windowed: true, encodedDir: ENC, dirs: [] });
    S.renderTree();
    gr = groupOf();
    check('a LIVE agent-started session is NEVER folded (running work always shows)',
      showsIn(gr, 'BUG-500-live'), rowTitles(gr));
    check('the OPEN agent-started session is NEVER folded (on-screen always shows)',
      showsIn(gr, 'BUG-501-open'), rowTitles(gr));
    check('the non-live, non-open agent rows still fold while live/open show',
      agents.every((a) => !showsIn(gr, a.displayTitle)), rowTitles(gr));
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
