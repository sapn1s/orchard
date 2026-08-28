/**
 * session-list-recency — the default per-project session list is:
 *   1. ordered by LAST ACTIVITY (recency), most-recent first;
 *   2. SUBSTANCE-SCALED: a BRIEF session drops out of the default view within a
 *      couple hours; a SUBSTANTIAL session (a real back-and-forth) lingers for
 *      days. A flat one-week window used to keep every brief throwaway (the
 *      real store is median-3-message), which is the clutter this fixes.
 *   3. bounded by an ADAPTIVE seat budget (MIN..MAX_SEATS) sized by how many
 *      pool sessions are genuinely recent — not a fixed slice.
 *   4. NEVER folds a session with LIVE work, whatever its age or length.
 * The open + pinned bypasses and the "N more" / "Show less" expansion are
 * unchanged (covered by verify-bug-085 / verify-feat-070); this suite is the
 * NEW behavior.
 *
 * Real-shape: boots the REAL app.js in happy-dom against a REAL server and drives
 * the REAL renderTree/visibleSessions over controlled state. Nothing re-derives
 * the window/budget rules. Fixtures are SYNTHETIC but model realistic
 * distributions (few / many / many-stale+one-live / all-stale / live-in-old).
 *
 * PRE-CHANGE assertions that FAIL against HEAD (flat 7-day window, fixed cap,
 * live not exempt): a brief 5h-old session shows instead of folding; a
 * substantial 48h-old session that should stay is treated identically to it; an
 * OLD live session folds instead of staying pinned-visible.
 *
 * Point APP_DIR at an alternate checkout of public/ to run the must-FAIL
 * baseline against pre-change app.js.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Window } from 'happy-dom';
import WebSocket from 'ws';
import { findNeighborProject } from './lib/neighbor-project.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP_DIR = process.env.APP_DIR ? path.resolve(process.env.APP_DIR) : path.join(ROOT, 'public');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sessrec-data-'));
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
  console.log(`\n========== session-list-recency (app: ${APP_DIR}) ==========`);
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

  const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
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
    await import(`${path.join(APP_DIR, 'app.js')}?ui=${Date.now()}`);
    const qa = (s) => [...doc.querySelectorAll(s)];
    const booted = await waitFor('project list', () => qa('#tree button.proj').length > 0);
    if (!booted) throw new Error('app.js never rendered any project row');

    const S = win.__station;
    const st = S.state;
    const PID = 'p-rec';
    const ENC = 'enc-rec';
    // Row text is "<age-or-date><title>"; the title is at the END.
    const mk = (id, msAgo, msgs, extra = {}) => ({
      sessionId: id, encodedDir: ENC, displayTitle: id, os: 'linux',
      lastActivityAt: iso(msAgo), messageCount: msgs, ...extra,
    });
    st.projects = [{ id: PID, name: 'Rec', lastActivityAt: iso(1 * HOUR), hostPath: '/tmp/rec' }];
    st.projSort = 'recency'; S.resortProjects();
    st.expanded = new Set([PID]);
    st.current = { projectId: null, encodedDir: null, sessionId: null, title: null, os: null };
    st.liveIds = new Map();

    const groupOf = () => qa('#tree .pgroup')
      .find((gr) => gr.querySelector('.proj .nm')?.textContent.trim() === 'Rec');
    const rowTitles = (gr) => [...(gr?.querySelectorAll('.kids button.row') ?? [])]
      .map((r) => r.textContent.replace(/\s+/g, ' ').trim());
    const shows = (gr, t) => rowTitles(gr).some((s) => s.endsWith(t));
    const moreBtn = (gr) => gr?.querySelector('.kids button.more:not(.less)');
    // Seen-stamp NEWER than a session's activity => it is NOT "attention"
    // (isolates the substance-window from the attention exemption).
    const seenNow = (ids) => new Map(ids.map((id) => [`${ENC} ${id}`, iso(0)]));
    const setList = (list, seen) => {
      st.seen = seen;
      st.sessions = new Map([[PID, { loaded: true, loading: false, error: null, list, shown: 6, encodedDir: ENC, dirs: [] }]]);
      S.renderTree();
      return groupOf();
    };

    // ===== A: substance-scaled window — brief folds fast, substantial lingers =====
    // BR: brief (1 msg) 5h old  -> FOLD.  SUB: substantial (40 msg) 48h old -> SHOW.
    // RN: brief (1 msg) 1h old  -> SHOW (still inside the brief window).
    // None are "attention" (all seen just now), so only the window decides.
    let gr = setList([mk('RN', 1 * HOUR, 1), mk('BR', 5 * HOUR, 1), mk('SUB', 48 * HOUR, 40)],
      seenNow(['RN', 'BR', 'SUB']));
    check('A: a SUBSTANTIAL 48h-old session stays in the default view (must FAIL pre-change only if window cuts it)',
      shows(gr, 'SUB'), rowTitles(gr));
    check('A: a BRIEF 5h-old session FOLDS (must FAIL pre-change: flat 7-day window keeps it)',
      !shows(gr, 'BR'), rowTitles(gr));
    check('A: a BRIEF but genuinely-recent (1h) session still shows',
      shows(gr, 'RN'), rowTitles(gr));
    check('A: the folded brief session is under "N more" (1 more)',
      /\b1 more\b/.test(moreBtn(gr)?.textContent.trim() ?? ''), moreBtn(gr)?.textContent.trim());

    // ===== B: a session with LIVE work NEVER folds, however old/brief =====
    // LIVE: brief (1 msg) 30 DAYS old, but in liveIds -> must stay visible past
    // both the window and the budget. Six recent substantial fillers fill the seats.
    const fillers = Array.from({ length: 6 }, (_, i) => mk(`F${i}`, (i + 1) * HOUR, 30));
    const withLive = [...fillers, mk('LIVE', 30 * DAY, 1)];
    st.liveIds = new Map([[`${ENC} LIVE`, { sessionId: 'LIVE', dir: ENC, drivenByDashboard: true }]]);
    gr = setList(withLive, seenNow(withLive.map((x) => x.sessionId)));
    check('B: an OLD, BRIEF, but LIVE session is NEVER folded (must FAIL pre-change: live not exempt -> folded)',
      shows(gr, 'LIVE'), rowTitles(gr));
    check('B: the live row carries the alive marker',
      !!gr?.querySelector('.kids button.row[data-live] .alive'), 'looked for [data-live] .alive');
    st.liveIds = new Map();

    // ===== C: rows are ordered by LAST ACTIVITY, most-recent first =====
    gr = setList([mk('c-old', 3 * HOUR, 30), mk('c-new', 20 * 60 * 1000, 30), mk('c-mid', 90 * 60 * 1000, 30)],
      seenNow(['c-old', 'c-new', 'c-mid']));
    check('C: rows read newest-first by lastActivityAt',
      JSON.stringify(rowTitles(gr).map((s) => s.replace(/^[^c]*/, ''))) === JSON.stringify(['c-new', 'c-mid', 'c-old']),
      rowTitles(gr));

    // ===== D: adaptive budget honours the historical <=6 ceiling on a busy burst =====
    // 10 substantial sessions all within the last 10h -> budget opens to the
    // MAX_SEATS ceiling (6), the older 4 fold.
    const burst = Array.from({ length: 10 }, (_, i) => mk(`b${i}`, (i + 1) * HOUR, 30));
    gr = setList(burst, seenNow(burst.map((x) => x.sessionId)));
    check('D: a 10-recent-substantial burst is capped at the ceiling (6 rows + "4 more")',
      rowTitles(gr).length === 6 && /\b4 more\b/.test(moreBtn(gr)?.textContent.trim() ?? ''),
      `rows=${rowTitles(gr).length} more=${moreBtn(gr)?.textContent.trim()}`);

    // ===== E: degrades sensibly for a SMALL project (all shown, no fold) =====
    gr = setList([mk('e1', 30 * 60 * 1000, 20), mk('e2', 90 * 60 * 1000, 12), mk('e3', 40 * HOUR, 30)],
      seenNow(['e1', 'e2', 'e3']));
    check('E: a 3-session project shows all three with no "N more"',
      rowTitles(gr).length === 3 && !moreBtn(gr), rowTitles(gr));

    // ===== F: an ALL-STALE project compresses to a compact fold, not a wall =====
    const stale = Array.from({ length: 8 }, (_, i) => mk(`s${i}`, (10 + i) * DAY, 2));
    gr = setList(stale, seenNow(stale.map((x) => x.sessionId)));
    check('F: 8 stale brief sessions all fold to "N more" (compact, not a wall of clutter)',
      rowTitles(gr).length === 0 && /\b8 more\b/.test(moreBtn(gr)?.textContent.trim() ?? ''),
      `rows=${rowTitles(gr).length} more=${moreBtn(gr)?.textContent.trim()}`);
    check('F: lifting the window reveals every stale session',
      (() => { moreBtn(groupOf()).click(); const g2 = groupOf(); return stale.every((x) => shows(g2, x.sessionId)); })(),
      rowTitles(groupOf()));
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
