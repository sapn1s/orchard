/**
 * FEAT-070 — sidebar recency ordering (+alpha toggle) + recent-session window.
 *
 *   Issue 3: projects are ordered by name; the user wants most-recently-worked
 *   at the top (lastActivityAt desc) by default, with an alpha toggle. Churn is
 *   mitigated by capturing a STABLE order that only re-sorts on refresh/toggle.
 *
 *   Issue 4: a project shows a FLAT 6 sessions regardless of age. The default
 *   view should be a RECENCY WINDOW (~1 week) under the same <=6 cap: older
 *   sessions fold under "N more"; pinned/active/attention sessions stay visible
 *   however old.
 *
 * Real-shape: boots the REAL app.js in happy-dom against a REAL server, then
 * drives the REAL render functions (resortProjects/toggleProjSort/renderTree)
 * over controlled project + session state and asserts on the DOM the real tree
 * produced. Nothing here re-derives the ordering/window rules — it exercises the
 * ones shipped in app.js.
 *
 * PRE-FIX assertions that FAIL: projects render in raw (name) order, not recency,
 * and the toggle-back-to-recency does nothing; a weeks-spanning project shows a
 * flat 6 (old sessions cluttering, an attention-old session cut by the cap).
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat070-data-'));
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
  console.log('\n========== FEAT-070 — sidebar recency ordering (+alpha toggle) + recent-session window ==========');
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
    constructor(...a) {
      super(...a);
      // Swallow late close/reset errors so a teardown-race 'error' event on a
      // socket the app opened cannot crash the run after the checks have passed.
      this.on('error', () => {});
      openSockets.push(this);
    }
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
    const projNames = () => qa('#tree button.proj .nm').map((n) => n.textContent.trim());

    // ======================= ISSUE 3 — project ordering + toggle =======================
    // Raw insertion order is ALPHABETICAL, so recency order is DISTINCT — a
    // pre-fix render (raw order) cannot pass the recency assertion by accident.
    st.projects = [
      { id: 'p-alfa', name: 'Alfa', lastActivityAt: iso(2 * DAY), hostPath: '/tmp/alfa' },
      { id: 'p-mike', name: 'Mike', lastActivityAt: iso(5 * DAY), hostPath: '/tmp/mike' },
      { id: 'p-zulu', name: 'Zulu', lastActivityAt: iso(1 * HOUR), hostPath: '/tmp/zulu' },
    ];
    st.projSort = 'recency';
    S.resortProjects();
    S.renderTree();
    check('issue3: default order is recency-desc (most recent first) (must FAIL pre-fix: name order)',
      JSON.stringify(projNames()) === JSON.stringify(['Zulu', 'Alfa', 'Mike']), projNames());

    S.toggleProjSort(); // -> alpha
    check('issue3: the toggle flips to ALPHABETICAL order',
      JSON.stringify(projNames()) === JSON.stringify(['Alfa', 'Mike', 'Zulu']), projNames());
    check('issue3: the toggle control names the active mode (A–Z)',
      doc.querySelector('#projSort')?.textContent.trim() === 'A–Z',
      `label=${JSON.stringify(doc.querySelector('#projSort')?.textContent.trim())}`);

    S.toggleProjSort(); // -> back to recency
    check('issue3: flipping back returns to recency-desc (must FAIL pre-fix: order never changes)',
      JSON.stringify(projNames()) === JSON.stringify(['Zulu', 'Alfa', 'Mike']), projNames());
    check('issue3: the toggle control names the active mode (Recent)',
      doc.querySelector('#projSort')?.textContent.trim() === 'Recent',
      `label=${JSON.stringify(doc.querySelector('#projSort')?.textContent.trim())}`);

    // Churn mitigation: a background activity bump does NOT reshuffle on the next
    // render — the captured order holds until an explicit resort.
    st.projects.find((p) => p.id === 'p-mike').lastActivityAt = iso(1); // Mike just became most-recent
    S.renderTree(); // a plain render (no resort)
    check('issue3: a background activity bump does NOT reshuffle mid-session (stable capture)',
      JSON.stringify(projNames()) === JSON.stringify(['Zulu', 'Alfa', 'Mike']), projNames());
    S.resortProjects(); S.renderTree(); // an explicit resort DOES pick it up
    check('issue3: an explicit resort DOES re-order (Mike now first)',
      projNames()[0] === 'Mike', projNames());

    // ======================= ISSUE 4 — recency window for sessions =======================
    const PID = 'p-win';
    st.projects = [{ id: PID, name: 'Windowed', lastActivityAt: iso(1 * HOUR), hostPath: '/tmp/win' }];
    st.projSort = 'recency'; S.resortProjects();
    st.expanded = new Set([PID]);
    st.current = { projectId: null, encodedDir: null, sessionId: null, title: null, os: null };

    const ENC = 'enc-win';
    const mk = (id, title, msAgo, extra = {}) => ({
      sessionId: id, encodedDir: ENC, displayTitle: title, os: 'linux',
      lastActivityAt: iso(msAgo), ...extra,
    });
    // 2 recent, 4 plain-old, 1 pinned-old, 1 attention-old.
    const list = [
      mk('R1', 'R1', 1 * HOUR),
      mk('R2', 'R2', 2 * HOUR),
      mk('O1', 'O1', 8 * DAY),
      mk('O2', 'O2', 9 * DAY),
      mk('O3', 'O3', 10 * DAY),
      mk('O4', 'O4', 11 * DAY),
      mk('POLD', 'POLD', 30 * DAY, { pinned: true }),
      mk('AOLD', 'AOLD', 20 * DAY),
    ];
    // AOLD carries activity the user has not seen since (attention): its
    // last-seen stamp is OLDER than its lastActivityAt.
    st.seen = new Map([[`${ENC} AOLD`, iso(40 * DAY)]]);
    st.sessions = new Map([[PID, { loaded: true, loading: false, error: null, list, shown: 6, encodedDir: ENC, dirs: [] }]]);

    S.renderTree();
    const group = qa('#tree .pgroup').find((gr) => gr.querySelector('.proj .nm')?.textContent.trim() === 'Windowed');
    const rowTitlesOf = () => [...(group?.querySelectorAll('.kids button.row') ?? [])]
      .map((r) => r.textContent.replace(/\s+/g, ' ').trim());
    const shows = (t) => rowTitlesOf().some((s) => s.split(' ').includes(t) || s.includes(` ${t}`) || s.endsWith(t));
    const moreText = () => group?.querySelector('.kids button.more')?.textContent.trim() ?? '';

    const titles = rowTitlesOf();
    check('issue4: within-window recents are shown (R1, R2)',
      shows('R1') && shows('R2'), titles);
    check('issue4: an OLD PINNED session stays visible regardless of the window (must FAIL pre-fix only if cap cuts it)',
      shows('POLD'), titles);
    check('issue4: an OLD ATTENTION session stays visible past the window (must FAIL pre-fix: cut by flat cap)',
      shows('AOLD'), titles);
    check('issue4: plain OLD sessions are folded under "N more", not shown by default (must FAIL pre-fix: flat 6 shows them)',
      !shows('O1') && !shows('O2') && !shows('O3') && !shows('O4'), titles);
    check('issue4: the folded old sessions appear under "N more" (4 more)',
      /\b4 more\b/.test(moreText()), `more=${JSON.stringify(moreText())}`);

    // Lift the window via "N more": the old sessions become visible. renderTree
    // rebuilds the tree, so re-query the group after the click.
    group.querySelector('.kids button.more').click();
    const group2 = qa('#tree .pgroup').find((gr) => gr.querySelector('.proj .nm')?.textContent.trim() === 'Windowed');
    const shows2 = (t) => [...group2.querySelectorAll('.kids button.row')]
      .map((r) => r.textContent.replace(/\s+/g, ' ').trim())
      .some((s) => s.endsWith(t));
    check('issue4: clicking "N more" lifts the window — the old sessions reveal',
      shows2('O1') && shows2('O2') && shows2('O3') && shows2('O4'),
      [...group2.querySelectorAll('.kids button.row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()));

    // The <=6 cap is a HARD limit even when every session is RECENT + ATTENTION
    // (BUG-085): 8 unpinned sessions all active within 24h and UNSEEN (so all
    // "attention") -> the cap still shows only 6, the other 2 fold under "N more".
    // This is the case that pre-BUG-085 wrongly dodged by marking the sessions
    // seen/non-attention; here attention no longer buys a seat past the cap.
    const capList = Array.from({ length: 8 }, (_, i) => mk(`W${i}`, `W${i}`, (i + 1) * HOUR)); // ~1h..8h, all recent
    st.seen = new Map(); // never seen -> all attention (activity newer than the 24h baseline)
    st.sessions.set(PID, {
      loaded: true, loading: false, error: null, encodedDir: ENC, dirs: [], shown: 6, list: capList,
    });
    S.renderTree();
    const cap = qa('#tree .pgroup').find((gr) => gr.querySelector('.proj .nm')?.textContent.trim() === 'Windowed');
    const capRows = [...cap.querySelectorAll('.kids button.row')].length;
    const capMore = cap.querySelector('.kids button.more')?.textContent.trim() ?? '';
    check('issue4: the HARD <=6 cap holds even when all 8 are recent+attention (6 rows + "2 more") (must FAIL pre-BUG-085: attention bypassed the cap, 8 rows)',
      capRows === 6 && /\b2 more\b/.test(capMore), `rows=${capRows} more=${JSON.stringify(capMore)}`);
  } finally {
    try {
      const st2 = win.__station?.state;
      if (st2?.snapPollTimer) { clearInterval(st2.snapPollTimer); st2.snapPollTimer = null; }
      if (st2?.liveTimer) { clearInterval(st2.liveTimer); st2.liveTimer = null; }
    } catch { /* never booted */ }
    // Keep an 'error' listener through close(): closing a still-CONNECTING
    // socket emits 'error' asynchronously, which would be unhandled (and crash
    // the run) if removeAllListeners had stripped the swallow handler first.
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
