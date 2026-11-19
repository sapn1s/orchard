#!/usr/bin/env node
/**
 * BUG-286 — a dispatch-heavy project's sidebar falsely claims "No interactive
 * sessions here" and hides the user's real sessions (FEAT-199 regression).
 *
 * THE BUG. FEAT-199 made the sidebar load only the first recency PAGE (60 rows).
 * In a project used heavily as a dispatch target, the 60 newest rows are all
 * agent lanes (foldByDefault=true), so `listedCount` of the PAGE is 0 and the
 * client renders the all-hidden empty-state note — a claim only the COMPLETE
 * list can support. The user's own interactive sessions are older, sit past page
 * 1, and never surface. Reported for project `trading_volume`: the sidebar read
 * "No interactive sessions here. 60 background/scripted sessions are hidden"
 * while 5 real user sessions (74–143 msgs, Aug–Sep) sat in the store.
 *
 * REAL-SHAPE. Boots the REAL app.js in happy-dom against a REAL server whose
 * reader is pointed at the USER'S REAL `~/.claude/projects` (read-only) and whose
 * DATA dir is an isolated scratch dir seeded with the real `trading-volume`
 * registry row only. Every request is a read-only GET; nothing in the real store
 * or the real station data is mutated. SKIPs cleanly if that store is absent.
 *
 * PRE-FIX assertions that FAIL (run against HEAD's app.js):
 *   A. the project group shows "No interactive sessions here" (the false claim).
 *   B. the client never escalates: the in-hand list stays at one page
 *      (serverHasMore latched true, list length === page size).
 *   C. none of the known interactive session titles is ever reachable.
 * POST-FIX: A is absent, B escalates to the full list (serverHasMore false), and
 * C the interactive sessions become reachable under "N more".
 *
 * Scenario D is a SYNTHETIC direct-state check (not from the real store): when
 * the FULL list is in hand (serverHasMore=false) and it is genuinely all-folded,
 * the honest all-hidden note MUST still render — the fix must not suppress it.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Window } from 'happy-dom';
import WebSocket from 'ws';
import { isolatedServerEnv } from './lib/station-boot.mjs';
import * as hist from '../src/lib/session-history.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const REAL_STORE = path.join(os.homedir(), '.claude', 'projects');
const REAL_REG = path.join(os.homedir(), '.local', 'share', 'claude-station', 'registry.json');
const PROJECT_ID = 'trading-volume';
// Distinctive titles of the user's real interactive sessions in trading_volume
// (observed from the live API, read-only). Any one being reachable proves the
// buried interactive sessions surfaced.
const KNOWN_INTERACTIVE = [
  'Under the water conversation',
  'Review handoff and project state for trading engine',
  'Backtesting storage and market period analysis',
];

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
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
async function waitFor(label, fn, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (await fn()) return true; await sleep(150); }
  console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
  return false;
}

let server = null;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug286-data-'));

async function main() {
  console.log('\n========== BUG-286 — all-folded first page must not falsely claim "No interactive sessions" ==========');

  // Precondition: the real trading-volume store must exist on this machine.
  let row = null, storeDir = null;
  try {
    const reg = JSON.parse(fs.readFileSync(REAL_REG, 'utf8'));
    row = (reg.projects ?? reg).find((p) => p.id === PROJECT_ID);
    if (row) storeDir = hist.encodeCwd(row.hostPath);
  } catch { /* no registry */ }
  if (!row || !storeDir || !fs.existsSync(path.join(REAL_STORE, storeDir))) {
    console.log(`  SKIP — the real ${PROJECT_ID} store is absent on this machine; nothing to verify against.`);
    return;
  }

  // Seed an ISOLATED data dir with just that one project row.
  fs.mkdirSync(path.join(DATA, 'session-hosts'), { recursive: true });
  const reg = JSON.parse(fs.readFileSync(REAL_REG, 'utf8'));
  fs.writeFileSync(path.join(DATA, 'registry.json'), JSON.stringify({ version: reg.version ?? 1, projects: [row] }, null, 2));
  // Copy the REAL provenance records (read-only on the source) into the scratch
  // data dir, so the scratch server folds rows EXACTLY as the user's live server
  // does. The fold is decided by these per-session records (startedBy), not by
  // the transcript's first message; without them the classifier falls back to a
  // weaker first-message heuristic and does NOT reproduce the user's reality.
  const realProv = path.join(os.homedir(), '.local', 'share', 'claude-station', 'session-provenance');
  if (fs.existsSync(realProv)) fs.cpSync(realProv, path.join(DATA, 'session-provenance'), { recursive: true });

  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = isolatedServerEnv({
    PORT: String(PORT), HOST: '127.0.0.1',
    CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: REAL_STORE,
    CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0',
  }, { requireStore: true });
  server = spawn(process.execPath, [ENTRY], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  server.stderr?.on('data', (d) => { if (process.env.VERBOSE) process.stderr.write(`  [server] ${d}`); });
  let up = false;
  for (let i = 0; i < 150 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(200); } }
  if (!up) throw new Error('server never became healthy');

  // Sanity on the server contract that CREATES the trap: page 1 is all-folded,
  // the full list holds interactive (non-folded) rows further down.
  const page1 = await (await fetch(`${BASE}/api/projects/${PROJECT_ID}/sessions?limit=60`)).json();
  const pageListed = (page1.sessions ?? []).filter((x) => !x.foldByDefault).length;
  check('precondition: first recency page (60) has ZERO non-folded rows',
    pageListed === 0 && page1.page?.hasMore === true, `pageListed=${pageListed} hasMore=${page1.page?.hasMore}`);

  // ---- boot the REAL app.js in happy-dom against the REAL server ----
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
    const booted = await waitFor('project list', async () => qa('#tree button.proj').length > 0, 20000);
    if (!booted) throw new Error('app.js never rendered any project row');

    const S = win.__station;
    const st = S.state;

    const groupOf = () => qa('#tree .pgroup')
      .find((gr) => gr.querySelector('.proj .nm')?.textContent.trim() === row.name
        || gr.querySelector('.proj')?.getAttribute('data-id') === PROJECT_ID);
    const groupText = () => (groupOf()?.textContent ?? '');
    const rowTitles = () => [...(groupOf()?.querySelectorAll('.kids button.row') ?? [])]
      .map((r) => r.textContent.replace(/\s+/g, ' ').trim());
    const moreBtn = () => groupOf()?.querySelector('.kids button.more:not(.less)');

    // Expand the real project; the REAL loadSessions runs its page-1 fetch.
    st.expanded = new Set([PROJECT_ID]);
    S.renderTree();
    await S.loadSessions(PROJECT_ID);
    S.renderTree();

    // ===== A — the false claim must never render (must FAIL pre-fix) =====
    // Give the escalation a tick to fire from renderTree; the claim must not
    // appear at ANY point once page 1 (all-folded) is in hand.
    await sleep(200); S.renderTree();
    check('A: the group never shows "No interactive sessions here" (must FAIL pre-fix)',
      !/No interactive sessions here/.test(groupText()),
      JSON.stringify(groupText().replace(/\s+/g, ' ').slice(0, 140)));

    // ===== B — the client escalates to the full list (must FAIL pre-fix) =====
    const escalated = await waitFor('full-list escalation (serverHasMore=false)',
      async () => { S.renderTree(); const s = st.sessions.get(PROJECT_ID); return s && s.serverHasMore === false; }, 60000);
    const sState = st.sessions.get(PROJECT_ID);
    check('B: page-1 all-folded triggers a one-shot full-list load (must FAIL pre-fix: stays paged)',
      escalated && sState.list.length > 60,
      `serverHasMore=${sState?.serverHasMore} listLen=${sState?.list?.length}`);

    const listedNow = (sState?.list ?? []).filter((x) => !x.foldByDefault).length;
    check('B: with the full list in hand the project now HAS listed interactive sessions',
      listedNow > 0, `listedCount=${listedNow}`);

    // ===== C — the user's own sessions are REACHABLE from the sidebar (must FAIL pre-fix) =====
    // These sessions are months old, so the recency window keeps them under
    // "N more" (intended, pre-FEAT-199 behaviour — not what this fix changes).
    // The regression was that they were not in the client's hands AT ALL, so
    // they could never be reached. Prove reachability: lift the window fully
    // (what repeated "N more" / "Show less"→expand does) and assert a known
    // interactive title renders. Pre-fix this FAILS: the full list was never
    // loaded, so no amount of revealing surfaces them.
    const sC = st.sessions.get(PROJECT_ID);
    sC.windowed = false; sC.shown = (sC.list?.length ?? 0) + 10;
    S.renderTree();
    await waitFor('interactive titles in DOM',
      async () => { const t = rowTitles(); return KNOWN_INTERACTIVE.some((k) => t.some((r) => r.endsWith(k))); }, 10000);
    const titles = rowTitles();
    const found = KNOWN_INTERACTIVE.filter((k) => titles.some((r) => r.endsWith(k)));
    check('C: the user\'s own interactive sessions are reachable once the window is lifted (must FAIL pre-fix)',
      found.length > 0, `found=${JSON.stringify(found)} ofRows=${titles.length}`);

    // ===== F — a forced reload must NOT drop the escalated full list (must FAIL pre-r2) =====
    // IV run 51074bff: re-arming the escalation on each page-1 reload threw away
    // the full list, flickering the count back to "0+" and re-fetching 2925 rows.
    // Sticky needsFullList makes a reload fetch the full list directly — one
    // fetch, no drop-back. Pre-r2 this reloads a 60-row page (listed 0).
    sC.windowed = true; sC.shown = 6; // back to default view first
    await S.loadSessions(PROJECT_ID, { force: true });
    const sF = st.sessions.get(PROJECT_ID);
    check('F: a forced reload keeps the escalated full list (no drop to a 60-row page) (must FAIL pre-r2)',
      sF.serverHasMore === false && sF.list.length > 60 && sF.list.filter((x) => !x.foldByDefault).length === 5,
      `serverHasMore=${sF.serverHasMore} listLen=${sF.list.length} listed=${sF.list.filter((x) => !x.foldByDefault).length}`);

    // ===== G — a failed escalation does NOT latch: a later load recovers (must FAIL pre-r2) =====
    // IV run 51074bff: a transient full-fetch failure left the project stuck on
    // "history unavailable" with no retry. Inject one 500 on a fresh escalation
    // point, then a PLAIN (non-forced) reload must still retry the full list.
    const sG = st.sessions.get(PROJECT_ID);
    sG.serverHasMore = true; sG.list = sG.list.slice(0, 60); // simulate pre-escalation page-1 state
    let failOnce = true;
    const baseFetch = g.fetch;
    g.fetch = (input, init) => {
      if (failOnce && /\/api\/projects\/[^/]+\/sessions/.test(String(input))) { failOnce = false; return Promise.resolve(new Response('boom', { status: 500 })); }
      return baseFetch(input, init);
    };
    await S.loadSessions(PROJECT_ID, { force: true }); // fails (500)
    await S.loadSessions(PROJECT_ID);                  // PLAIN reload — must retry full (sticky)
    g.fetch = baseFetch;
    const sGa = st.sessions.get(PROJECT_ID);
    check('G: a transient escalation failure recovers on the next plain load (no latch) (must FAIL pre-r2)',
      sGa.error == null && sGa.serverHasMore === false && sGa.list.filter((x) => !x.foldByDefault).length === 5,
      `err=${sGa.error} serverHasMore=${sGa.serverHasMore} listed=${sGa.list.filter((x) => !x.foldByDefault).length}`);

    // ===== H — a failed refresh must NOT hide already-loaded sessions (must FAIL pre-r3) =====
    // IV run 01a1824e: a redundant/failed reload set s.error, and the error
    // branch replaced the whole group with "history unavailable" even though the
    // full list (with the interactive rows) was already in hand. A transient
    // refresh failure must keep the loaded sessions visible.
    const sH = st.sessions.get(PROJECT_ID);
    sH.error = 'boom'; sH.loading = false;
    sH.windowed = false; sH.shown = (sH.list?.length ?? 0) + 10;
    S.renderTree();
    const hTitles = rowTitles();
    const hFound = KNOWN_INTERACTIVE.some((k) => hTitles.some((r) => r.endsWith(k)));
    const hText = groupText();
    check('H: a failed refresh keeps the loaded interactive sessions visible, not "history unavailable" (must FAIL pre-r3)',
      hFound && /couldn.t refresh/.test(hText) && !/history unavailable/.test(hText),
      `found=${hFound} refreshHint=${/couldn.t refresh/.test(hText)} unavailable=${/history unavailable/.test(hText)}`);
    sH.error = null;

    // ===== D — SYNTHETIC: a genuinely all-folded COMPLETE list still shows the honest note =====
    // Direct-state, not from the real store: serverHasMore=false + every row
    // folded. The honest all-hidden note must still appear (fix must not gag it).
    const PID2 = 'p-synthetic-allfolded';
    const ENC2 = 'enc-synth';
    const folded = Array.from({ length: 8 }, (_, i) => ({
      sessionId: `L${i}`, encodedDir: ENC2, displayTitle: `Dispatch: ticket=X phase=p`,
      os: 'linux', lastActivityAt: new Date(Date.now() - (i + 1) * 3600_000).toISOString(),
      foldByDefault: true, startedBy: 'agent',
    }));
    st.projects = [...st.projects, { id: PID2, name: 'Synthetic', lastActivityAt: folded[0].lastActivityAt, hostPath: '/tmp/synthetic' }];
    st.projSort = 'recency'; S.resortProjects();
    st.expanded = new Set([PID2]);
    st.sessions.set(PID2, { loaded: true, loading: false, error: null, list: folded, shown: 6, encodedDir: ENC2, dirs: [], serverHasMore: false, serverTotal: folded.length });
    S.renderTree();
    const synthGroup = qa('#tree .pgroup').find((gr) => gr.querySelector('.proj .nm')?.textContent.trim() === 'Synthetic');
    check('D (synthetic): a genuinely all-folded COMPLETE list still shows the honest all-hidden note',
      /No interactive sessions here/.test(synthGroup?.textContent ?? ''),
      JSON.stringify((synthGroup?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 120)));

    // ===== E — SYNTHETIC: escalation must NOT re-enter renderTree mid-loop =====
    // Regression guard for independent-verify run 4648fc31 (BROKEN): the escalation
    // was a SYNCHRONOUS loadSessions() call inside renderTree's project loop, and
    // loadSessions() calls renderTree() before its first await. That nested render
    // cleared #tree and rebuilt every project, then the outer loop re-appended each
    // project AFTER the escalating one — duplicate project groups in the sidebar.
    // Place an all-folded, serverHasMore project FIRST, ahead of other projects,
    // expand it, render once, and assert every project group appears EXACTLY once
    // (the escalating fetch itself is deferred to a microtask, so the synchronous
    // render completes clean). Must FAIL against the pre-queueMicrotask fix.
    const PIDX = 'p-escal-first';
    const ENCX = 'enc-escal';
    const foldedX = Array.from({ length: 8 }, (_, i) => ({
      sessionId: `X${i}`, encodedDir: ENCX, displayTitle: 'Dispatch: ticket=Y phase=p',
      os: 'linux', lastActivityAt: new Date(Date.now() - (i + 1) * 60_000).toISOString(),
      foldByDefault: true, startedBy: 'agent',
    }));
    const others = ['adv-A', 'adv-B', 'adv-C'].map((id, i) => ({ id, enc: `enc-${id}` , ts: new Date(Date.now() - (i + 2) * 3600_000).toISOString() }));
    st.projects = [
      { id: PIDX, name: 'EscalFirst', lastActivityAt: new Date().toISOString(), hostPath: '/tmp/escal' },
      ...others.map((o) => ({ id: o.id, name: o.id, lastActivityAt: o.ts, hostPath: `/tmp/${o.id}` })),
    ];
    st.projSort = 'recency'; S.resortProjects();
    st.expanded = new Set([PIDX, ...others.map((o) => o.id)]);
    st.sessions = new Map();
    // All-folded + serverHasMore → the escalation branch fires for PIDX.
    st.sessions.set(PIDX, { loaded: true, loading: false, error: null, list: foldedX, shown: 6, encodedDir: ENCX, dirs: [], serverHasMore: true, serverTotal: 999, escalatedForInteractive: false });
    for (const o of others) {
      st.sessions.set(o.id, { loaded: true, loading: false, error: null, encodedDir: o.enc, dirs: [], serverHasMore: false, serverTotal: 1,
        list: [{ sessionId: `${o.id}-s`, encodedDir: o.enc, displayTitle: `${o.id} session`, os: 'linux', lastActivityAt: o.ts, foldByDefault: false, startedBy: 'user' }] });
    }
    S.renderTree(); // count IMMEDIATELY — before the deferred escalation microtask runs
    const ids = qa('#tree .pgroup').map((gr) => gr.querySelector('.proj .nm')?.textContent.trim());
    const counts = ids.reduce((m, id) => (m[id] = (m[id] || 0) + 1, m), {});
    const dups = Object.entries(counts).filter(([, n]) => n > 1);
    check('E: an escalating all-folded project does NOT duplicate later project groups (must FAIL pre-fix)',
      dups.length === 0, `groups=${JSON.stringify(ids)} dups=${JSON.stringify(dups)}`);
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
