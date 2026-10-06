/**
 * FEAT-070 round 2 — the sidebar seat RANKING buried recent/active sessions.
 *
 * Bug: visibleSessions ranked the scarce seats by (brief, then attention) with no
 * WINDOW tier, so a stale OUT-OF-WINDOW session that qualifies for the pool only
 * via unseen "attention" (an old seen-stamp older than its last activity) was
 * ranked AHEAD of an IN-WINDOW session the user worked in recently (seen, so not
 * attention). With the seats full, the recent — and the currently-active —
 * sessions lost their seat and folded under "N more". Reproduced live against the
 * real :4317 claude-station list (688+ sessions): the recent/active rows were
 * hidden, days-old stale-attention rows seated.
 *
 * Fix (public/app.js, visibleSessions): a WINDOW tier leads the seat ranking —
 * in-window outranks out-of-window stale-attention; stale-attention takes leftover
 * seats only. (The open/live session is independently protected via alwaysIds.)
 *
 * Real-shape: boots the REAL app.js in happy-dom against a REAL server and drives
 * the REAL renderTree over a realistic BUSY-day fixture: EIGHT days-old substantial
 * sessions that are attention ONLY via a stale seen-stamp (out of window), plus a
 * 20h USER-started brief session (in window) and the OPEN session. Post-fix both
 * recent ones seat and the stale ones take leftover seats; a pre-fix SIBLING (the
 * window tier reverted) folds the 20h brief out — the must-FAIL proof, against a
 * synthesized pre-fix RANKING rather than git HEAD.
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
const APP_JS = path.join(ROOT, 'public', 'app.js');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat070rank-data-'));
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
const DAY = 24 * HOUR;

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
async function waitFor(fn, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (fn()) return true; await sleep(100); }
  return false;
}

/* The SAME realistic busy-day fixture, driven through whichever app.js variant is
 * passed. Returns the seated row ids for the project. Every row carries a stale
 * seen-stamp (seen 2h before its own last activity) so it reads as attention —
 * exactly the state that let stale rows outrank recents; the recent ones are the
 * only lever is now the window tier. */
async function runFixture(appJsPath, BASE, PORT) {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const win = new Window({ url: `${BASE}/` });
  const doc = win.document;
  doc.write(html.replace(/<link[^>]*>/g, '').replace(/<script[^>]*><\/script>/g, ''));
  doc.close();
  const realFetch = globalThis.fetch;
  win.fetch = (input, init) => realFetch(input.startsWith('http') ? input : BASE + input, init);
  const openSockets = [];
  class TrackedWebSocket extends WebSocket {
    constructor(...a) { super(...a); this.on('error', () => {}); openSockets.push(this); }
  }
  win.WebSocket = TrackedWebSocket;
  win.location.host = `127.0.0.1:${PORT}`;
  const prev = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, document: globalThis.document, window: globalThis.window, location: globalThis.location };
  globalThis.document = doc; globalThis.window = win; globalThis.WebSocket = win.WebSocket;
  globalThis.location = win.location; globalThis.fetch = win.fetch;

  try {
    await import(`${appJsPath}?ui=${Date.now()}-${Math.random()}`);
    const qa = (s) => [...doc.querySelectorAll(s)];
    const booted = await waitFor(() => qa('#tree button.proj').length > 0);
    if (!booted) throw new Error(`app.js never rendered a project row (${appJsPath})`);

    const S = win.__station;
    const st = S.state;
    const PID = 'p-rank';
    const ENC = 'enc-rank';
    st.projects = [{ id: PID, name: 'Busy', lastActivityAt: iso(1 * HOUR), hostPath: '/tmp/busy' }];
    st.projSort = 'recency'; S.resortProjects();
    st.expanded = new Set([PID]);

    const OPEN = 'OPEN258';
    const U20 = 'U20BRIEF';
    // 8 substantial days-old sessions (mc=40). Out of the 72h substantial window.
    const olds = Array.from({ length: 8 }, (_, i) =>
      ({ sessionId: `OLD${i}`, encodedDir: ENC, displayTitle: `Old ticket ${i}`, os: 'linux',
         lastActivityAt: iso((4 + i) * DAY), messageCount: 40, startedBy: 'user', foldByDefault: false }));
    const list = [
      // the open/active session (substantial, fresh) — also protected by alwaysIds
      { sessionId: OPEN, encodedDir: ENC, displayTitle: 'Active now', os: 'linux', lastActivityAt: iso(0.1 * HOUR), messageCount: 17, startedBy: 'user', foldByDefault: false },
      // a user-started BRIEF session from ~20h ago (inside the 24h user-brief window)
      { sessionId: U20, encodedDir: ENC, displayTitle: 'Quick user note', os: 'linux', lastActivityAt: iso(20 * HOUR), messageCount: 2, startedBy: 'user', foldByDefault: false },
      ...olds,
    ];
    // Stale seen-stamps: every row seen 2h BEFORE its own last activity => every
    // row reads as "attention". This is the state that made stale rows win seats.
    st.seen = new Map(list.map((x) => [`${ENC} ${x.sessionId}`, iso((Date.now() - new Date(x.lastActivityAt).getTime()) + 2 * HOUR)]));
    // The user is viewing the sidebar but NOT inside a session, so the active row
    // is not state.current here — it must earn a seat by the ranking (it is also
    // not marked live in this fixture). This isolates the window tier.
    st.current = { projectId: null, encodedDir: null, sessionId: null, title: null, os: null };
    st.sessions = new Map([[PID, { loaded: true, loading: false, error: null, list, shown: 6, encodedDir: ENC, dirs: [] }]]);

    S.renderTree();
    const group = qa('#tree .pgroup').find((gr) => gr.querySelector('.proj .nm')?.textContent.trim() === 'Busy');
    const rows = [...(group?.querySelectorAll('.kids button.row') ?? [])]
      .map((r) => r.textContent.replace(/\s+/g, ' ').trim());
    // Rows render as "<age><displayTitle>" (e.g. "20hQuick user note"), so match
    // on the title at the end, not the sessionId (which never appears in text).
    const seated = (title) => rows.some((s) => s.endsWith(title));
    return {
      rows,
      openSeated: seated('Active now'),
      u20Seated: seated('Quick user note'),
      oldSeatedCount: olds.filter((o) => seated(o.displayTitle)).length,
    };
  } finally {
    try {
      const st2 = win.__station?.state;
      if (st2?.snapPollTimer) { clearInterval(st2.snapPollTimer); st2.snapPollTimer = null; }
      if (st2?.liveTimer) { clearInterval(st2.liveTimer); st2.liveTimer = null; }
    } catch { /* never booted */ }
    for (const s of openSockets) { try { s.on('error', () => {}); s.close(); } catch { /* closed */ } }
    await sleep(150);
    // Only restore the network globals; leave document/window/location pointing at
    // this window so app.js's uncleared 1s intervals (usage countdown etc.) can
    // still read document.hidden until the process exits. Restoring them to the
    // pre-boot undefined would crash a stray timer after the checks ran.
    globalThis.WebSocket = prev.WebSocket; globalThis.fetch = prev.fetch;
  }
}

/* The pre-fix RANKING: the window tier reverted out of visibleSessions, written
 * to a sibling in public/ so its ./lib/* imports still resolve. */
function buildPrefixSibling() {
  const src = fs.readFileSync(APP_JS, 'utf8');
  const POST = `  const windowRank = (x) => (withinRecentWindow(x) ? 0 : 1);
  const briefRank = (x) => (isBriefSession(x) ? 1 : 0);
  const ranked = pool.slice().sort((a, b) =>
    windowRank(a) - windowRank(b)
    || briefRank(a) - briefRank(b)
    || (isAttentionSession(b) ? 1 : 0) - (isAttentionSession(a) ? 1 : 0));`;
  const PRE = `  const briefRank = (x) => (isBriefSession(x) ? 1 : 0);
  const ranked = pool.slice().sort((a, b) =>
    briefRank(a) - briefRank(b)
    || (isAttentionSession(b) ? 1 : 0) - (isAttentionSession(a) ? 1 : 0));`;
  if (!src.includes(POST)) throw new Error('could not find the post-fix ranking block to revert — update this test');
  const out = src.replace(POST, PRE);
  const p = path.join(ROOT, 'public', `.feat070-prefix-${process.pid}.js`);
  fs.writeFileSync(p, out);
  return p;
}

let server = null;
let prefixPath = null;

async function main() {
  console.log('\n========== FEAT-070 round 2 — seat ranking: in-window outranks stale out-of-window attention ==========');
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

  // POST-FIX (current public/app.js).
  const post = await runFixture(APP_JS, BASE, PORT);
  console.log(`  [post-fix] seated rows: ${JSON.stringify(post.rows)}`);
  check('post-fix: the currently-ACTIVE/recent session is SEATED (not folded behind stale rows)',
    post.openSeated, `openSeated=${post.openSeated}`);
  check('post-fix: a 20h USER-started brief session (in window) is SEATED over stale out-of-window rows',
    post.u20Seated, `u20Seated=${post.u20Seated}`);
  check('post-fix: stale out-of-window attention rows take LEFTOVER seats only (some still fold)',
    post.oldSeatedCount < 8, `oldSeatedCount=${post.oldSeatedCount} of 8`);

  // PRE-FIX ranking (window tier reverted) — the must-FAIL proof.
  prefixPath = buildPrefixSibling();
  const pre = await runFixture(prefixPath, BASE, PORT);
  console.log(`  [pre-fix ] seated rows: ${JSON.stringify(pre.rows)}`);
  check('MUST-FAIL pre-fix: without the window tier the 20h user-brief is BURIED by stale rows (not seated)',
    !pre.u20Seated, `u20Seated(pre)=${pre.u20Seated}`);
  check('MUST-FAIL pre-fix: stale out-of-window rows fill the seats the recents should have had',
    pre.oldSeatedCount >= post.oldSeatedCount, `old seated pre=${pre.oldSeatedCount} post=${post.oldSeatedCount}`);
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(async () => {
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : (process.exitCode ?? 0);
  try { if (prefixPath) fs.rmSync(prefixPath, { force: true }); } catch { /* ignore */ }
  try { if (server?.pid) process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
  await sleep(300);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
  setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
});
