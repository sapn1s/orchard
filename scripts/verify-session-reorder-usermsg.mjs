/**
 * session-list-recency — ORDER BY LAST USER SUBMIT, not transcript mtime.
 *
 * The report: the session list only reorders after a page reload, and (the
 * refined requirement) it must reorder on the HUMAN's submitted message ONLY —
 * an agent grinding in a session for hours must NOT keep dragging it to the top
 * ("so it doesnt keep reordering perma"). Two properties, one discriminator:
 *
 *   1. rows order by `lastUserMessageAt` (last human submit), NOT `lastActivityAt`
 *      (transcript mtime, which moves on agent output too);
 *   2. a mtime bump WITHOUT a new user submit does NOT reorder the list — the
 *      must-FAIL discriminator: pre-change ordered by mtime, so it DID;
 *   3. a human submit reorders IMMEDIATELY (stampUserSubmit), no reload;
 *   4. FOLD stays keyed on LIVENESS, not on user input — a live agent session is
 *      still never folded even though the human has not typed in it (unchanged,
 *      re-asserted so this change did not collapse the two signals).
 *
 * Real-shape: boots the REAL app.js in happy-dom against a REAL server and drives
 * the REAL renderTree/visibleSessions/orderedSessions over controlled state.
 * Nothing re-derives the ordering. Assertions read the DOM row order a user
 * would actually see. Fixtures are SYNTHETIC but model a realistic busy project
 * (a session an agent is live in, several human sessions, a currently-open one).
 *
 * MUST-FAIL baseline: point APP_DIR at a checkout of HEAD's public/ (which
 * orders by lastActivityAt), e.g. a scratch dir holding `git show HEAD:public/*`.
 *   node scripts/verify-session-reorder-usermsg.mjs            # current tree
 *   APP_DIR=<pre-change public> node scripts/verify-session-reorder-usermsg.mjs
 *                                                              # pre-change: FAILS 1,2
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-reorder-data-'));
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
  console.log(`\n========== session reorder-by-user-submit (app: ${APP_DIR}) ==========`);
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
    const PID = 'p-ro';
    const ENC = 'enc-ro';
    // A realistic busy project: every session SUBSTANTIAL (>=6 msgs) and within
    // the recent window so NOTHING folds — this isolates ORDER, not the fold.
    // lastUserMessageAt = the human submit; lastActivityAt = transcript mtime.
    const mk = (id, userMsAgo, mtimeMsAgo, extra = {}) => ({
      sessionId: id, encodedDir: ENC, displayTitle: id, os: 'linux',
      messageCount: 30,
      lastUserMessageAt: userMsAgo == null ? null : iso(userMsAgo),
      lastActivityAt: iso(mtimeMsAgo),
      ...extra,
    });
    st.projects = [{ id: PID, name: 'Ro', lastActivityAt: iso(1 * HOUR), hostPath: '/tmp/ro' }];
    st.projSort = 'recency'; S.resortProjects();
    st.expanded = new Set([PID]);
    st.current = { projectId: null, encodedDir: null, sessionId: null, title: null, os: null };
    st.liveIds = new Map();

    const groupOf = () => qa('#tree .pgroup')
      .find((gr) => gr.querySelector('.proj .nm')?.textContent.trim() === 'Ro');
    const seenNow = (ids) => new Map(ids.map((id) => [`${ENC} ${id}`, iso(0)]));
    const setList = (list, seen) => {
      st.seen = seen;
      st.sessions = new Map([[PID, { loaded: true, loading: false, error: null, list, shown: 6, encodedDir: ENC, dirs: [] }]]);
      S.renderTree();
      return groupOf();
    };
    // Each row renders "<when-label><title>" with no separator; the title IS the
    // sessionId in these fixtures. Strip the leading when-label (e.g. "10m",
    // "now", "Aug 17") to recover the id in visual order.
    const rowIds = (gr) => [...(gr?.querySelectorAll('.kids button.row') ?? [])]
      .map((r) => r.textContent.replace(/\s+/g, ' ').trim()
        .replace(/^(now|\d+[smhdwy]|[A-Z][a-z]{2} \d+)/, ''));

    // ===== 1: rows order by LAST USER SUBMIT, not transcript mtime =====
    // U1 human-submitted most recently (10m). U2 (2h). AGENT: human submitted 5h
    // ago but an agent is writing RIGHT NOW (mtime 1m) — mtime would rank it #1,
    // user-submit ranks it LAST.
    let gr = setList([
      mk('U2', 2 * HOUR, 2 * HOUR),
      mk('AGENT', 5 * HOUR, 1 * 60 * 1000),
      mk('U1', 10 * 60 * 1000, 10 * 60 * 1000),
    ], seenNow(['U1', 'U2', 'AGENT']));
    check('1: rows read by last USER submit, newest-first — AGENT (fresh mtime, stale submit) is LAST (must FAIL pre-change: mtime puts it first)',
      JSON.stringify(rowIds(gr)) === JSON.stringify(['U1', 'U2', 'AGENT']),
      rowIds(gr));

    // ===== 2: DISCRIMINATOR — an agent mtime bump alone does NOT reorder =====
    // Same three, then AGENT's mtime jumps to "now" (agent output) with its
    // user-submit UNCHANGED. Order must be identical. Pre-change (mtime sort)
    // would hoist AGENT to the top — the reorder the user does NOT want.
    const before = rowIds(gr);
    const list2 = [
      mk('U2', 2 * HOUR, 2 * HOUR),
      mk('AGENT', 5 * HOUR, 0),            // mtime = now (agent still writing)
      mk('U1', 10 * 60 * 1000, 10 * 60 * 1000),
    ];
    gr = setList(list2, seenNow(['U1', 'U2', 'AGENT']));
    check('2: an AGENT mtime bump with no new user submit does NOT reorder (must FAIL pre-change: mtime hoists AGENT to #1)',
      JSON.stringify(rowIds(gr)) === JSON.stringify(before)
      && JSON.stringify(rowIds(gr)) === JSON.stringify(['U1', 'U2', 'AGENT']),
      { before, after: rowIds(gr) });

    // ===== 3: a HUMAN submit reorders IMMEDIATELY, no reload =====
    // U2 sits below U1. Stamp a user submit into U2 (what submit() does on send)
    // and re-render: U2 must jump to the top with no list refetch/reload.
    S.stampUserSubmit('U2', ENC);
    gr = groupOf();
    check('3: stampUserSubmit(U2) moves it to the TOP immediately, no reload',
      rowIds(gr)[0] === 'U2', rowIds(gr));

    // ===== 4: FOLD stays keyed on LIVENESS, not user input =====
    // AGENTLIVE: human submitted 30 DAYS ago (would fold on any recency) but is
    // in liveIds — must stay visible. Six fresh human sessions fill the seats.
    const fillers = Array.from({ length: 6 }, (_, i) => mk(`F${i}`, (i + 1) * HOUR, (i + 1) * HOUR));
    const withLive = [...fillers, mk('AGENTLIVE', 30 * 24 * HOUR, 0)];
    st.liveIds = new Map([[`${ENC} AGENTLIVE`, { sessionId: 'AGENTLIVE', dir: ENC, drivenByDashboard: false }]]);
    gr = setList(withLive, seenNow(withLive.map((x) => x.sessionId)));
    check('4: a live agent session (no recent human submit) is NEVER folded (liveness, not user-input, governs the fold)',
      rowIds(gr).includes('AGENTLIVE'), rowIds(gr));
    check('4: the live row carries the alive marker',
      !!gr?.querySelector('.kids button.row[data-live] .alive'), 'looked for [data-live] .alive');
    st.liveIds = new Map();

    // ===== 5: fallback — a row with NO user-submit orders by mtime (codex/old) =====
    // C1/C2 have null lastUserMessageAt; they must still sort sensibly by mtime.
    gr = setList([
      mk('C2', null, 3 * HOUR),
      mk('C1', null, 30 * 60 * 1000),
    ], seenNow(['C1', 'C2']));
    check('5: rows lacking lastUserMessageAt fall back to mtime order (codex/pre-existing)',
      JSON.stringify(rowIds(gr)) === JSON.stringify(['C1', 'C2']), rowIds(gr));
  } finally {
    for (const ws of openSockets) { try { ws.close(); } catch { /* */ } }
  }

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`FAILURES: ${failures.join(' | ')}`);
}

main()
  .catch((e) => { console.error(e); fail++; })
  .finally(() => {
    if (server) { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* */ } }
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* */ }
    process.exit(fail ? 1 : 0);
  });
