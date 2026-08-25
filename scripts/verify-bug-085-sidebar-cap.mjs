/**
 * BUG-085 — FEAT-070 regression: recent sessions bypassed the ≤6 cap (the full
 * list showed), and expansion was one-way until a page reload.
 *
 *   The default (collapsed) per-project view must be a HARD ≤6 by recency,
 *   regardless of how many sessions are "recent"/active. Only the OPEN session
 *   and genuinely user-PINNED sessions may exceed the cap; 24h "attention" now
 *   ranks WITHIN the cap (priority for a seat), it does not buy extra seats.
 *   After "N more", an in-place "Show less" returns to the capped view with NO
 *   page reload.
 *
 * Real-shape: boots the REAL app.js in happy-dom against a REAL server and drives
 * the REAL renderTree/visibleSessions over controlled state, asserting on the DOM
 * the real tree produced. Nothing here re-derives the cap/window rules.
 *
 * PRE-FIX assertions that FAIL: 12 sessions all active within 24h render all 12
 * (attention bypassed the cap) instead of exactly 6; and there is no "Show less"
 * collapse control (expansion was one-way until reload).
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug085-data-'));
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
const DAY = 24 * 3600 * 1000;
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
  console.log('\n========== BUG-085 — hard ≤6 session cap (attention ranks within, not beyond) + collapse-back ==========');
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

    const PID = 'p-cap';
    const ENC = 'enc-cap';
    const mk = (id, title, msAgo, extra = {}) => ({
      sessionId: id, encodedDir: ENC, displayTitle: title, os: 'linux',
      lastActivityAt: iso(msAgo), ...extra,
    });
    st.projects = [{ id: PID, name: 'Capped', lastActivityAt: iso(1 * HOUR), hostPath: '/tmp/capped' }];
    st.projSort = 'recency'; S.resortProjects();
    st.expanded = new Set([PID]);

    const groupOf = () => qa('#tree .pgroup')
      .find((gr) => gr.querySelector('.proj .nm')?.textContent.trim() === 'Capped');
    const rowTitles = (gr) => [...(gr?.querySelectorAll('.kids button.row') ?? [])]
      .map((r) => r.textContent.replace(/\s+/g, ' ').trim());
    // Row text is "<age><title>" (e.g. "1hR0") or "<date><title>" (e.g.
    // "Jul 14POLD") — the title is at the END, so match on endsWith.
    const showsIn = (gr, t) => rowTitles(gr).some((s) => s.endsWith(t));
    const recentCount = (gr) => rowTitles(gr).filter((s) => /R\d+$/.test(s)).length;
    const moreBtn = (gr) => gr?.querySelector('.kids button.more:not(.less)');
    const lessBtn = (gr) => gr?.querySelector('.kids button.more.less');

    // ===== Scenario A: 12 sessions ALL active within 24h (unseen -> attention) =====
    // Default view must be a HARD <=6, not the full list. (must FAIL pre-fix:
    // every 24h session was "attention" and bypassed the cap -> 12 rows.)
    const recent = Array.from({ length: 12 }, (_, i) => mk(`R${i}`, `R${i}`, (i + 1) * HOUR)); // 1h..12h
    st.seen = new Map(); // never seen -> all attention
    st.current = { projectId: null, encodedDir: null, sessionId: null, title: null, os: null };
    st.sessions = new Map([[PID, { loaded: true, loading: false, error: null, list: recent, shown: 6, encodedDir: ENC, dirs: [] }]]);
    S.renderTree();
    let gr = groupOf();
    let rows = [...gr.querySelectorAll('.kids button.row')].length;
    check('A: 12 sessions ALL active in 24h -> default shows EXACTLY 6 (must FAIL pre-fix: shows all 12)',
      rows === 6, `rows=${rows}`);
    check('A: the other 6 fold under "N more" (6 more) (must FAIL pre-fix: no "more", all shown)',
      /\b6 more\b/.test(moreBtn(gr)?.textContent.trim() ?? ''), `more=${JSON.stringify(moreBtn(gr)?.textContent.trim())}`);
    check('A: no collapse control while at the capped default view',
      !lessBtn(gr), `less=${JSON.stringify(lessBtn(gr)?.textContent.trim())}`);

    // ===== Scenario B: open session + user-pinned OLD survive the cap =====
    // 12 recent (attention) + a pinned OLD (30d) + the OPEN session (25d, out of
    // the top-6 by recency): both must show past the cap; the open one because it
    // is on screen, the pin because pinning is an explicit user act.
    const listB = [...recent, mk('POLD', 'POLD', 30 * DAY, { pinned: true }), mk('OPEN', 'OPEN', 25 * DAY)];
    st.seen = new Map(); // recents attention; OPEN is current (exempt); POLD pinned
    st.current = { projectId: PID, encodedDir: ENC, sessionId: 'OPEN', title: null, os: null };
    st.sessions.set(PID, { loaded: true, loading: false, error: null, list: listB, shown: 6, encodedDir: ENC, dirs: [] });
    S.renderTree();
    gr = groupOf();
    check('B: the currently-OPEN old session is always present',
      showsIn(gr, 'OPEN'), rowTitles(gr));
    check('B: a user-PINNED old session stays visible past the cap',
      showsIn(gr, 'POLD'), rowTitles(gr));
    // Exactly 6 unpinned, non-open recents make the capped cut.
    const recentShown = recentCount(gr);
    check('B: exactly 6 recent (unpinned, non-open) sessions make the cap — attention did NOT buy extra seats',
      recentShown === 6, `recentShown=${recentShown} titles=${JSON.stringify(rowTitles(gr))}`);
    check('B: the remaining recents fold under "N more" (6 more)',
      /\b6 more\b/.test(moreBtn(gr)?.textContent.trim() ?? ''), `more=${JSON.stringify(moreBtn(gr)?.textContent.trim())}`);

    // ===== Scenario C: expand reveals the rest, then collapse-back in place =====
    moreBtn(groupOf()).click(); // lift the window / grow the reveal
    gr = groupOf();
    const allRecentShown = recent.every((x) => showsIn(gr, x.sessionId));
    check('C: clicking "N more" reveals ALL the folded sessions',
      allRecentShown && showsIn(gr, 'POLD') && showsIn(gr, 'OPEN'), rowTitles(gr));
    check('C: a "Show less" collapse control now exists (must FAIL pre-fix: no collapse, expansion was one-way)',
      !!lessBtn(gr), `less=${JSON.stringify(lessBtn(gr)?.textContent.trim())}`);

    // Collapse back — IN PLACE, no reload (renderTree only; app.js never re-imported).
    lessBtn(gr).click();
    gr = groupOf();
    rows = [...gr.querySelectorAll('.kids button.row')].length;
    const recentShown2 = recentCount(gr);
    check('C: "Show less" returns to the capped view IN-PLACE (6 recent again, no reload)',
      recentShown2 === 6 && showsIn(gr, 'POLD') && showsIn(gr, 'OPEN'),
      `recentShown=${recentShown2} rows=${rows} titles=${JSON.stringify(rowTitles(gr))}`);
    check('C: the collapse control is gone again once back at the capped default',
      !lessBtn(gr) && /\b6 more\b/.test(moreBtn(gr)?.textContent.trim() ?? ''),
      `less=${JSON.stringify(lessBtn(gr)?.textContent.trim())} more=${JSON.stringify(moreBtn(gr)?.textContent.trim())}`);
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
