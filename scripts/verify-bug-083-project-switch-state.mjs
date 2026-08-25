/**
 * BUG-083 — a project/session switch must isolate two pieces of per-session UI
 * state that today leak across the boundary:
 *
 *   Issue 1 (composer draft): unsent composer text follows the user into the
 *   session they switch to. Wanted: SAVE the outgoing draft under its own
 *   project/session key and RESTORE the target's own draft (empty if none) — a
 *   draft never rides into the wrong project, and a returned-to session gets its
 *   own text back.
 *
 *   Issue 2 (running strip): the strip shows the PREVIOUS session's running
 *   agents after a switch. resetTranscript() clears state.snap + renderStrip()
 *   immediately, but a running-set poll fired under the OLD session can still be
 *   in flight; when it lands, snapshotIsForCurrent() accepts it (a brand-new
 *   session has no ids yet, so the "no ids -> trust it" branch waves it through)
 *   and repaints the old session's agents under the new one. The fix stamps a
 *   scope token on every boundary (resetTranscript) and drops any poll answer
 *   whose scope has moved on.
 *
 * Real-shape: boots the REAL app.js in happy-dom against a REAL server (the
 * verify-bug-079 idiom), opens a real on-disk session, and drives REAL switches
 * (openSession via row click, startNew). The running-set endpoint is stubbed to
 * a controllable promise so the "stale poll lands AFTER the switch" race is
 * constructed deterministically — the state machine that decides whether it
 * paints is the real one.
 *
 * PRE-FIX assertions that FAIL: after a switch the composer still holds the
 * outgoing draft (carried, not saved/cleared); and a stale poll landing after
 * the switch repaints the old session's agent under the new (agent-less) one.
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug083-data-'));
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
  console.log('\n========== BUG-083 — per-project composer draft + running strip scoped to current session ==========');
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
  const NEIGHBOR_ID = (await reg.json()).project.id;

  const sess = await (await fetch(`${BASE}/api/projects/${NEIGHBOR_ID}/sessions`)).json();
  const sessions = sess.sessions ?? [];
  check('precondition: neighbor project has at least one on-disk session', sessions.length > 0,
    `${sessions.length} session(s)`);
  if (!sessions.length) throw new Error('no sessions to drive the switch path');

  // ---- boot the REAL app.js in happy-dom against the REAL server
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const win = new Window({ url: `${BASE}/` });
  const doc = win.document;
  doc.write(html.replace(/<link[^>]*>/g, '').replace(/<script[^>]*><\/script>/g, ''));
  doc.close();

  const g = win;
  const realFetch = globalThis.fetch;
  // BUG-083 issue-2 gate: when armed, the /running endpoint's response is held
  // until `runningGate` resolves and then answers with `stubbedSnap`. This lets
  // a poll be left in flight ACROSS a real switch (the exact race the scope
  // guard defends) — `api` is a read-only module namespace, so the seam is here.
  let runningGate = null;   // Promise the /running response awaits (null = pass through)
  let stubbedSnap = null;   // what /running returns while the gate is armed
  g.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    if (runningGate && url.includes('/running')) {
      return runningGate.then(() => new Response(JSON.stringify({ snapshot: stubbedSnap }),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    }
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
    const prompt = () => doc.querySelector('#prompt');
    const stripRowCount = () => qa('#stripRows button').length;
    const stripHidden = () => !!doc.querySelector('#strip')?.hidden;

    // The project's REAL, on-disk session rows. FEAT-073 adds a derived
    // "pending new" row at the top after startNew (it has no session behind it
    // and is a no-op to click); this helper means the real sessions, so it skips
    // that row to keep A/B switch indexing on genuine sessions.
    const ownRows = () => {
      const head = qa('#tree button.proj').find((n) => projName(n) === NB);
      return [...(head?.nextElementSibling?.querySelectorAll('button.row:not(.pending)') ?? [])];
    };
    await waitFor("neighbor's sessions", () => ownRows().length > 0);

    async function openRow(i) {
      const ok = await waitFor(`session row ${i}`, () => ownRows().length > i, 20000);
      if (!ok) throw new Error(`session row ${i} never appeared (rows=${ownRows().length})`);
      ownRows()[i].click();
      await waitFor('transcript', () => qa('#panes .pane .you, #panes .pane .claude, #panes .pane .hint-row').length > 0, 30000);
      await sleep(200); // let openSession settle past its awaits
    }

    const rows = ownRows();
    const distinct = rows.length > 1;
    check('precondition: distinct on-disk session B for a real A->B switch (else new-session boundary)',
      true, distinct ? `${rows.length} sessions — A->B is a distinct session` : '1 session — A->new-session boundary');

    // ============================ ISSUE 1 — composer draft ============================
    await openRow(0);
    const keyA = S.draftKey(st.current);
    const DRAFT_A = `BUG-083 draft for A ${Date.now()}`;
    prompt().value = DRAFT_A;

    // Switch A -> B. Distinct on-disk session when available; otherwise a fresh
    // "New session" in the same project (its own, project-keyed draft slot).
    if (distinct) await openRow(1); else S.startNew(NEIGHBOR_ID);
    const keyB = S.draftKey(st.current);
    await sleep(50);

    check("issue1: A's draft is NOT carried into B — composer is empty on landing (must FAIL pre-fix: carried)",
      prompt().value === '', `composer=${JSON.stringify(prompt().value)}`);
    check("issue1: A's draft was SAVED under A's own key (must FAIL pre-fix: never saved)",
      st.drafts.get(keyA) === DRAFT_A, `drafts[A]=${JSON.stringify(st.drafts.get(keyA) ?? null)}`);

    // Type B's own draft, then return to A: A's text must come back, not B's.
    const DRAFT_B = `BUG-083 draft for B ${Date.now()}`;
    prompt().value = DRAFT_B;
    await openRow(0);
    await sleep(50);
    check("issue1: returning to A RESTORES A's own draft, not B's (must FAIL pre-fix: B's carried in)",
      prompt().value === DRAFT_A, `composer=${JSON.stringify(prompt().value)}`);
    check("issue1: B's draft was saved under B's own key (round-trip isolation)",
      st.drafts.get(keyB) === DRAFT_B && keyA !== keyB, `drafts[B]=${JSON.stringify(st.drafts.get(keyB) ?? null)} keyA!=keyB=${keyA !== keyB}`);

    // clear the composer so it does not bleed into issue 2's session
    prompt().value = '';

    // ============================ ISSUE 2 — running strip scope ============================
    await openRow(0);
    // Stub the running-set endpoint with a controllable promise so we can make a
    // poll land AFTER the switch — the exact race the guard defends against.
    const A_AGENT = 'agent-A-only';
    const aSnap = {
      v: 1, at: Date.now(),
      turn: { running: true, since: Date.now() },
      running: [
        { id: 'main', row: 'main', startedAt: Date.now(), state: 'running' },
        { id: A_AGENT, row: 'agent', label: 'worker', description: "A project's agent", startedAt: Date.now(), state: 'running' },
      ],
      ended: [],
      stationSessionId: 'A-station', sdkSessionId: 'A-sdk',
    };
    // Arm the /running gate: any poll now hangs until we release it, then answers
    // with aSnap (A's running set). One shared gate settles every in-flight poll.
    let releaseGate = null;
    runningGate = new Promise((res) => { releaseGate = res; });
    stubbedSnap = aSnap;

    // Establish "A has a live agent": apply the snapshot the way A's own socket
    // would (trusted), so the strip is really showing A's agent before we switch.
    S.applySnapshot(aSnap, { trusted: true });
    check('issue2: precondition — with A on screen the strip shows A\'s running agent',
      !stripHidden() && stripRowCount() >= 2 && qa('#stripRows button .ty').some((n) => n.textContent === 'worker'),
      `hidden=${stripHidden()} rows=${stripRowCount()}`);

    // Fire a poll (captures A's scope) and leave it in flight.
    const pollP = S.pollRunning();
    await sleep(20);

    // Switch to a fresh, agent-less session (startNew): resetTranscript clears
    // the strip immediately and moves the scope token.
    S.startNew(NEIGHBOR_ID);
    await sleep(20);
    check('issue2: the strip clears IMMEDIATELY on switch to an agent-less session',
      stripHidden() && stripRowCount() === 0 && st.snap === null,
      `hidden=${stripHidden()} rows=${stripRowCount()} snap=${st.snap === null ? 'null' : 'set'}`);

    // Now let the stale poll (fired under A) land. It must be DROPPED.
    releaseGate();
    await pollP.catch(() => {});
    await sleep(80);
    check("issue2: a stale poll landing after the switch does NOT repaint A's agent (must FAIL pre-fix: A's agent shown under B)",
      stripRowCount() === 0 && stripHidden() && st.snap === null
        && !qa('#stripRows button .ty').some((n) => n.textContent === 'worker'),
      `hidden=${stripHidden()} rows=${stripRowCount()} snap=${st.snap === null ? 'null' : 'set'}`);

    // ============================ REGRESSION — poll for the CURRENT session still lands ============================
    await openRow(0);
    // A snapshot that IS for the session on screen (its ids match current) —
    // proves the scope guard is scoped to boundaries, not a blanket mute.
    const curId = st.current.sessionId;
    const okSnap = { ...aSnap, stationSessionId: curId, sdkSessionId: curId };
    stubbedSnap = okSnap;
    runningGate = Promise.resolve(); // resolves promptly, same-scope
    await S.pollRunning();
    await sleep(30);
    // The /running response is JSON round-tripped, so identity won't hold — assert
    // by content: a matching-scope snapshot with the agent set landed on the strip.
    check('REGRESSION: a same-scope poll for the session on screen still applies (guard is scoped, not a mute)',
      st.snap?.running?.length === 2 && !stripHidden() && stripRowCount() >= 2
        && qa('#stripRows button .ty').some((n) => n.textContent === 'worker'),
      `snap=${st.snap ? `applied(${st.snap.running?.length})` : 'dropped'} rows=${stripRowCount()}`);
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
  setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
});
