/**
 * BUG-106 — the running strip (and the permission hairline, and the rail's
 * live-count chip) must not keep showing one project's live agents while the user
 * has selected a DIFFERENT project in the sidebar.
 *
 * The uncovered boundary BUG-083 left behind: a bare `selectProject` — a sidebar
 * project-HEADER click that is NOT a session switch. It moves the sidebar
 * selection (state.current.projectId, the crown + rail) but never calls
 * resetTranscript, so the transcript dock stays bound to the previously-OPENED
 * session: the strip keeps rendering the other project's agents, the permission
 * hairline keeps asserting the other project's posture, and the 4s running poll
 * keeps re-fetching the foreign session forever.
 *
 * Option A (the chosen fix): track the open session's OWNING project
 * (state.openProjectId) separately from the sidebar selection; gate the strip,
 * the hairline, the live-count and the running poll on the two matching
 * (dockIsForeign); and do NOT close the open session — a switch back restores it.
 *
 * Real-shape: boots the REAL app.js in happy-dom against a REAL server (the
 * BUG-083 idiom), registers TWO projects — A (a real neighbor with on-disk
 * sessions) and B (a fresh empty project) — opens a real session in A, and drives
 * the REAL sidebar project-header CLICK to switch A -> B and back.
 *
 * Four directions, all proven here:
 *   (1) LEAK clears  — after selecting B, A's worker row is gone, strip hidden,
 *                      hairline hidden, live-count omitted (must FAIL pre-fix).
 *   (2) OWN shows    — while A is selected (before the switch AND after switching
 *                      back), the strip shows A's own worker row.
 *   (3) EMPTY nothing— project B, which owns no live work, shows an empty strip.
 *   (4) SWITCH-BACK  — selecting A again restores the real strip + hairline, and
 *                      the open session was never discarded (state.snap kept).
 * Plus: the poll is ignored while foreign (no repaint), and the permission
 * hairline half of the report (container "permissions skipped") is covered.
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug106-data-'));
const NEIGHBOR = findNeighborProject({ excludePath: ROOT });
const NB = path.basename(NEIGHBOR);
// Project B — a fresh, empty project the user "looks at". A real on-disk dir so
// registration behaves exactly as the sidebar's add-project does.
const PROJ_B_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug106-projB-'));
const PB = path.basename(PROJ_B_DIR);

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

let server = null;

async function main() {
  console.log('\n========== BUG-106 — the running strip / hairline must re-scope on a bare project switch ==========');
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

  async function register(hostPath, name) {
    const reg = await fetch(`${BASE}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostPath, name }),
    });
    if (!reg.ok) throw new Error(`could not register ${name}: ${await reg.text()}`);
    return (await reg.json()).project.id;
  }
  const A_ID = await register(NEIGHBOR, NB);
  const B_ID = await register(PROJ_B_DIR, PB);

  const sess = await (await fetch(`${BASE}/api/projects/${A_ID}/sessions`)).json();
  const sessions = sess.sessions ?? [];
  check('precondition: project A (neighbor) has at least one on-disk session', sessions.length > 0,
    `${sessions.length} session(s)`);
  if (!sessions.length) throw new Error('no sessions to open in A');

  // ---- boot the REAL app.js in happy-dom against the REAL server
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const win = new Window({ url: `${BASE}/` });
  const doc = win.document;
  doc.write(html.replace(/<link[^>]*>/g, '').replace(/<script[^>]*><\/script>/g, ''));
  doc.close();

  const g = win;
  const realFetch = globalThis.fetch;
  // A controllable /running seam (BUG-083 idiom): while armed, hold the response
  // until releaseGate resolves and answer with stubbedSnap — so a foreign poll can
  // be left in flight across the switch and its non-repaint asserted.
  let runningGate = null;
  let stubbedSnap = null;
  // Count the /running requests that actually reach the SERVER (past the seam), so
  // the "does the poll genuinely STOP while foreign" work-queue item can be proven
  // by request-counting the wire, not by a client-side assertion that it was merely
  // ignored after fetching. A gated (stubbed) request never reaches realFetch, so
  // only true server-bound polls are counted.
  let runningReqCount = 0;
  g.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    if (runningGate && url.includes('/running')) {
      return runningGate.then(() => new Response(JSON.stringify({ snapshot: stubbedSnap }),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    if (url.includes('/running')) runningReqCount++;
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
    const projName = (n) => n.querySelector('.nm')?.textContent?.trim() ?? '';

    const booted = await waitFor('project list', () => qa('#tree button.proj').length > 0);
    if (!booted) throw new Error('app.js never rendered any project row');

    const S = win.__station;
    const st = S.state;
    const stripHidden = () => !!doc.querySelector('#strip')?.hidden;
    const stripRowCount = () => qa('#stripRows button').length;
    const hasWorkerRow = () => qa('#stripRows button .ty').some((n) => n.textContent === 'worker');
    const permHidden = () => !!doc.querySelector('#permLine')?.hidden;
    const permText = () => doc.querySelector('#permLine')?.textContent ?? '';
    // The rail's "live" count chip (FEAT-067): a .rs-chip.st-live button carrying
    // the running-process count in data-count. Absent entirely when live === null
    // (no snapshot / gated foreign). Returns { present, n }.
    const liveChip = () => {
      const chip = doc.querySelector('#railSummary .rs-chip.st-live');
      return { present: !!chip, n: chip ? Number(chip.getAttribute('data-count')) : null };
    };

    const headerFor = (name) => qa('#tree button.proj').find((n) => projName(n) === name);
    const ownRows = () => {
      const head = headerFor(NB);
      return [...(head?.nextElementSibling?.querySelectorAll('button.row:not(.pending)') ?? [])];
    };
    await waitFor('both project headers', () => headerFor(NB) && headerFor(PB), 20000);
    // Expand A and wait for its real session rows.
    if (!st.expanded.has(A_ID)) headerFor(NB).click();
    await waitFor("A's sessions", () => ownRows().length > 0);

    async function openRow(i) {
      const ok = await waitFor(`session row ${i}`, () => ownRows().length > i, 20000);
      if (!ok) throw new Error(`session row ${i} never appeared (rows=${ownRows().length})`);
      ownRows()[i].click();
      await waitFor('transcript', () => qa('#panes .pane .you, #panes .pane .claude, #panes .pane .hint-row').length > 0, 30000);
      await sleep(200);
    }

    // ---- Open a real session in A, then prime it with A's live running set + a
    // container skip-perms effective config so BOTH the strip and the hairline are
    // showing A's live work before we switch.
    await openRow(0);
    check('precondition: opening A\'s session records A as the dock owner (openProjectId)',
      st.openProjectId === A_ID && st.current.projectId === A_ID,
      `openProjectId=${st.openProjectId === A_ID ? 'A' : st.openProjectId} current=${st.current.projectId === A_ID ? 'A' : st.current.projectId}`);

    const A_AGENT = 'agent-A-worker';
    const curId = st.current.sessionId;
    const aSnap = {
      v: 1, at: Date.now(),
      turn: { running: true, since: Date.now() },
      running: [
        { id: 'main', row: 'main', startedAt: Date.now(), state: 'running' },
        { id: A_AGENT, row: 'agent', label: 'worker', description: 'Test cheap-model claim checking', startedAt: Date.now(), state: 'running' },
      ],
      ended: [],
      stationSessionId: curId, sdkSessionId: curId,
    };
    S.applySnapshot(aSnap, { trusted: true });
    // Container skip-perms effective config → the hairline paints "permissions
    // skipped · container is the boundary" (the user's real, reported scenario).
    // Full live report: also a resolved model (crown model chip), a live provider,
    // capabilities, and a live tool list carrying an attached MCP server (the
    // integrations strip) — so EVERY surface that reads the open session's live
    // state is armed with A's work before we switch, and the clean-room defect A
    // (the crown model/provider chip) is exercised, not just the strip.
    st.live = true;
    st.effective = {
      effective: { permissionMode: 'bypassPermissions', model: 'claude-opus-A-only' },
      permissionModeSource: 'container-default', isolation: 'container',
      provider: 'anthropic', capabilities: {},
    };
    st.liveTools = ['Read', 'Edit', 'mcp__serena__find_symbol'];
    S.paintPerm();
    S.paintCrown(); // repaint the crown-owned surfaces (model chip, integrations) from the live report

    // ---- Enumerate EVERY surface that reads the open session's live state, and the
    // single gate they all route through, so the fix is structural — a NEW surface
    // that reads state.snap/live/effective/liveTools/liveWireModel directly, ungated,
    // is caught here rather than shipping a sixth silent leak (defect A was the fifth).
    const modelChip = () => doc.querySelector('#modelChip');
    const chipText = () => (modelChip()?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const chipLive = () => modelChip()?.dataset.live === 'true';
    const integLive = () => qa('#integStrip .ichip').some((c) => c.dataset.live === 'true');
    const sealPerm = () => doc.querySelector('#seal .perm')?.textContent ?? '';
    const provBtnShown = () => !!doc.querySelector('#provBtn') && !doc.querySelector('#provBtn').hidden;
    // Read the dot straight from the exposed projectDot() rather than rebuilding the
    // #tree (renderTree mid-test churns the DOM the later real clicks depend on).
    const projById = (id) => (st.projects ?? []).find((p) => p.id === id);
    const dotForId = (id) => { const p = projById(id); return p ? S.projectDot(p) : '(no project)'; };
    // The single gate: while NOT foreign every dock accessor returns the live value.
    check('OWN: the crown model chip is live and names A\'s model',
      chipLive() && /opus-A-only/.test(chipText()), `live=${chipLive()} text=${JSON.stringify(chipText())}`);
    check('OWN: the integrations strip shows A\'s live attached MCP server (data-live=true)',
      integLive(), `integLive=${integLive()}`);
    check('OWN: dockLive/dockEffective/dockLiveTools all resolve to A\'s live values (not foreign)',
      S.dockLive() === true && !!S.dockEffective() && Array.isArray(S.dockLiveTools()),
      `dockLive=${S.dockLive()} dockEffective=${!!S.dockEffective()} dockLiveTools=${Array.isArray(S.dockLiveTools())}`);

    // (2) OWN direction — before any switch, A's own work shows.
    check('OWN: with A selected the strip shows A\'s worker row',
      !stripHidden() && stripRowCount() >= 2 && hasWorkerRow(),
      `hidden=${stripHidden()} rows=${stripRowCount()} worker=${hasWorkerRow()}`);
    check('OWN: with A selected the container permission hairline is shown',
      !permHidden() && /permissions skipped/i.test(permText()) && /container is the boundary/i.test(permText()),
      `permHidden=${permHidden()} text=${JSON.stringify(permText())}`);
    check('OWN: with A selected the rail live-count chip reports A\'s running set (2)',
      liveChip().present && liveChip().n === 2,
      `liveChip=${JSON.stringify(liveChip())}`);

    // ---- THE BOUNDARY: a real sidebar click on project B's header (NOT a session
    // switch). This is selectProject(B), the path BUG-083 never covered.
    headerFor(PB).click();
    await sleep(60);

    check('boundary: the sidebar selection switched to project B',
      st.current.projectId === B_ID, `current=${st.current.projectId === B_ID ? 'B' : st.current.projectId}`);
    check('boundary: the open session was NOT discarded (Option A — a look, not a navigation)',
      st.openProjectId === A_ID && st.snap && Array.isArray(st.snap.running) && st.current.sessionId === curId,
      `openProjectId=${st.openProjectId === A_ID ? 'A' : st.openProjectId} snap=${st.snap ? 'kept' : 'null'} sessionId=${st.current.sessionId === curId ? 'kept' : 'changed'}`);

    // (1) LEAK direction — the whole point. Must FAIL pre-fix.
    check('LEAK: after selecting B the strip no longer shows A\'s worker row (must FAIL pre-fix)',
      stripHidden() && stripRowCount() === 0 && !hasWorkerRow(),
      `hidden=${stripHidden()} rows=${stripRowCount()} worker=${hasWorkerRow()}`);
    check('LEAK: after selecting B the permission hairline is hidden, not A\'s posture under B (must FAIL pre-fix)',
      permHidden(),
      `permHidden=${permHidden()} text=${JSON.stringify(permText())}`);
    check('LEAK: after selecting B the rail live-count chip is omitted, not reporting A\'s set (must FAIL pre-fix)',
      !liveChip().present,
      `liveChip=${JSON.stringify(liveChip())}`);
    check('LEAK: dockIsForeign() is true while B is selected and A owns the open session',
      S.dockIsForeign() === true, `dockIsForeign=${S.dockIsForeign()}`);

    // ---- The surface enumeration under B. THIS is the clean-room defect A and its
    // siblings: the crown model/provider chip (the exact reported leak), the
    // integrations strip, the permission SEAL chip, the launch provider control and
    // the sidebar dot must ALL fall back to B's own predicted state — none may paint
    // A's live model / provider / attach / posture. Each was a separate call site;
    // they now route through the one dock gate, so this passes by construction.
    check('LEAK (defect A): the crown model chip is NOT live and does NOT name A\'s model under B (must FAIL pre-fix)',
      !chipLive() && !/opus-A-only/.test(chipText()),
      `live=${chipLive()} text=${JSON.stringify(chipText())} title=${JSON.stringify(modelChip()?.getAttribute('title'))}`);
    check('LEAK: the integrations strip shows no live-attached chip under B (A\'s MCP attach does not bleed)',
      !integLive(), `integLive=${integLive()}`);
    check('LEAK: the permission SEAL chip does not assert A\'s "skips prompts" under B',
      !/skips prompts/i.test(sealPerm()), `seal=${JSON.stringify(sealPerm())}`);
    // The launch provider control's gating is verified by unit call (it is not on the
    // selectProject repaint path, so it merely goes stale-hidden — never leaks A's
    // provider): forcing a repaint while foreign must show B's own control.
    S.paintProvBtn();
    check('LEAK: on repaint while foreign the launch provider control follows B (not hidden by A\'s live session)',
      provBtnShown(), `provBtnShown=${provBtnShown()}`);
    check('LEAK: the sidebar run-dot does NOT light up B while A is the live session (owner-keyed, not selection-keyed)',
      !/\brun\b/.test(dotForId(B_ID)), `dotB=${JSON.stringify(dotForId(B_ID))} dotA=${JSON.stringify(dotForId(A_ID))}`);
    check('LEAK: the single dock gate blanks EVERY live accessor while foreign (structural)',
      S.dockSnap() == null && S.dockLive() === false && S.dockEffective() == null
        && S.dockLiveTools() == null && S.dockLiveModel() == null,
      `snap=${S.dockSnap() == null} live=${S.dockLive()} eff=${S.dockEffective() == null} tools=${S.dockLiveTools() == null} model=${S.dockLiveModel() == null}`);

    // Poll is IGNORED while foreign: a poll that would answer with A's set must not
    // repaint the strip under B.
    let releaseGate = null;
    runningGate = new Promise((res) => { releaseGate = res; });
    stubbedSnap = aSnap;
    const pollP = S.pollRunning();
    releaseGate();
    await pollP.catch(() => {});
    await sleep(40);
    check('LEAK: the 4s running poll is ignored while foreign — no repaint of A\'s worker under B',
      stripHidden() && !hasWorkerRow(),
      `hidden=${stripHidden()} worker=${hasWorkerRow()}`);
    runningGate = null;

    // (3) EMPTY direction — project B owns no live work; its view is an empty strip.
    check('EMPTY: project B (no open session, no live work) shows an empty/hidden strip',
      stripHidden() && stripRowCount() === 0, `hidden=${stripHidden()} rows=${stripRowCount()}`);

    // (4) SWITCH-BACK — select A again; the real strip + hairline return, from the
    // still-present snapshot, with the session never having been closed.
    headerFor(NB).click();
    await sleep(60);
    check('SWITCH-BACK: dockIsForeign() is false again once A is re-selected',
      S.dockIsForeign() === false, `dockIsForeign=${S.dockIsForeign()}`);
    check('SWITCH-BACK: selecting A restores A\'s worker row in the strip (from the kept snapshot)',
      !stripHidden() && stripRowCount() >= 2 && hasWorkerRow(),
      `hidden=${stripHidden()} rows=${stripRowCount()} worker=${hasWorkerRow()}`);
    check('SWITCH-BACK: selecting A restores the container permission hairline',
      !permHidden() && /permissions skipped/i.test(permText()),
      `permHidden=${permHidden()} text=${JSON.stringify(permText())}`);
    check('SWITCH-BACK: selecting A restores the crown model chip (live, A\'s model) and the integrations attach',
      chipLive() && /opus-A-only/.test(chipText()) && integLive(),
      `live=${chipLive()} text=${JSON.stringify(chipText())} integLive=${integLive()}`);

    /* ═══ The verifier's "could not test" list — a work queue, not a footnote ═══ */
    // The MAIN proof above drove the REAL sidebar header CLICK (the authentic
    // boundary). These extra scenarios drive selectProject() directly — the very
    // function the header click invokes — because an empty, deselected project (B)
    // is intentionally filtered OUT of the rendered #tree, so its header is not
    // always clickable; the boundary being exercised is identical.
    const select = async (id) => { S.selectProject(id, { quiet: true }); await sleep(40); };

    // (WQ-1) POLL GENUINELY STOPS while foreign — proven by request-counting the
    // WIRE, not a client assertion. Force N interval poll cycles under B and assert
    // ZERO reach the server; then one under A and assert it DOES fetch (the poll is
    // stopped, not broken).
    await select(B_ID);
    const before = runningReqCount;
    for (let i = 0; i < 5; i++) { await S.pollRunning().catch(() => {}); }
    await sleep(40);
    check('WQ-1 POLL STOPS: five poll cycles while foreign emit ZERO /running requests to the server',
      runningReqCount === before, `emitted=${runningReqCount - before}`);
    await select(A_ID);
    await S.pollRunning().catch(() => {});
    await sleep(40);
    check('WQ-1 POLL RESUMES: a poll cycle after switching back to A DOES reach the server (stopped, not broken)',
      runningReqCount > before, `emittedAfterBack=${runningReqCount - before}`);

    // (WQ-2) EVENT ARRIVES MID-SWITCH: a push snapshot for A (its own socket) that
    // lands WHILE B is selected must keep state.snap warm (for switch-back) yet must
    // NOT repaint A's rows under B. applySnapshot({trusted}) is the push path.
    await select(B_ID);
    S.applySnapshot({ ...aSnap, at: Date.now() }, { trusted: true });
    await sleep(20);
    check('WQ-2 MID-SWITCH EVENT: a push for A while B is selected does not repaint A\'s worker under B, but keeps the snapshot',
      stripHidden() && !hasWorkerRow() && !!st.snap, `hidden=${stripHidden()} worker=${hasWorkerRow()} snap=${!!st.snap}`);

    // (WQ-3) RAPID SWITCHING A→B→A→B with no settle between — the final state must be
    // coherent with the LAST selection, never a stale mid-flight paint.
    S.selectProject(A_ID, { quiet: true }); S.selectProject(B_ID, { quiet: true });
    S.selectProject(A_ID, { quiet: true }); S.selectProject(B_ID, { quiet: true });
    await sleep(60);
    check('WQ-3 RAPID SWITCH: after A→B→A→B the dock is foreign and shows nothing of A',
      S.dockIsForeign() === true && stripHidden() && !hasWorkerRow() && !chipLive(),
      `foreign=${S.dockIsForeign()} hidden=${stripHidden()} worker=${hasWorkerRow()} chipLive=${chipLive()}`);
    await select(A_ID);
    check('WQ-3 RAPID SWITCH: ending back on A restores A\'s live strip + chip coherently',
      S.dockIsForeign() === false && !stripHidden() && hasWorkerRow() && chipLive(),
      `foreign=${S.dockIsForeign()} hidden=${stripHidden()} worker=${hasWorkerRow()} chipLive=${chipLive()}`);

    // (WQ-4) SELECTED PROJECT UNREGISTERED while it is the foreign selection: no crash,
    // the dock stays gated (owner A's work still not shown under a now-gone B).
    await select(B_ID);
    let unregErr = null;
    try {
      await realFetch(`${BASE}/api/projects/${B_ID}`, { method: 'DELETE' });
      await S.loadProjects?.();
      S.renderTree();
      await sleep(40);
    } catch (e) { unregErr = e.message; }
    check('WQ-4 UNREGISTER SELECTED: deleting the selected project mid-view does not crash and does not leak A\'s work',
      unregErr == null && !hasWorkerRow(), `err=${unregErr} worker=${hasWorkerRow()}`);

    // (WQ-5) OPEN A SESSION IN THE SECOND PROJECT while the first is still open: this
    // is a real navigation (openSession), so the dock RE-SCOPES to the new owner —
    // dockIsForeign false, and A's rows are gone because A's session is no longer open.
    // (Covered structurally: openSession sets state.openProjectId; here we assert the
    // predicate the whole fix hinges on flips correctly when the owner changes.)
    // A fresh empty B has no on-disk session to open, so assert the invariant via the
    // owner field directly: were B to own the dock, the dock would not be foreign.
    st.openProjectId = B_ID; // simulate "a session in B is now the open dock owner"
    st.current.projectId = B_ID;
    check('WQ-5 OPEN-IN-SECOND: once B owns the open dock, the dock is no longer foreign (re-scoped to the new owner)',
      S.dockIsForeign() === false, `foreign=${S.dockIsForeign()} owner=${st.openProjectId === B_ID ? 'B' : st.openProjectId}`);
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
  try { fs.rmSync(PROJ_B_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
});
