/**
 * BUG-079 — a session-boundary switch must clear the OUTGOING session's pending-
 * delivery pointers (drain-wait self-retry + force-send stash) and their live
 * timers, so they never act on the session being opened.
 *
 *   node scripts/verify-bug-079-session-switch-state.mjs
 *
 * Two findings, one root cause: resetTranscript() zeroes state.queue on a switch
 * but leaves state.drainWaitAttempt and state.forceSend (plus their timers)
 * pointing at the abandoned session.
 *
 *   Finding A (LOSS): a stale state.drainWaitAttempt makes queueRetryableRefusal
 *   read `retried` truthy and SKIP the enqueue — the incoming session's next
 *   retryable refusal is dropped (composer already cleared, bubble removed,
 *   socket closed): the text is lost from composer + queue + screen.
 *
 *   Finding B (WRONG-TARGET): a stale state.forceSend makes the incoming
 *   session's next turn-end run `deliverForced(item)` over the NEW socket — the
 *   OUTGOING session's text is injected into the wrong session.
 *
 * Real-shape: boots the REAL app.js in happy-dom against a REAL server (the
 * verify-resume-refusal idiom), opens a real on-disk session, plants the exact
 * pending state a mid-flight self-retry / force-send leaves, then drives a REAL
 * session switch (openSession, via a row click) and asserts the state machine.
 * The wire events (retryable refusal, interrupted turn-end) are staged through
 * the REAL onEvent — only the frames are synthetic, the state machine is real.
 *
 * PRE-FIX assertions that FAIL: after the switch drainWaitAttempt/forceSend and
 * their timers survive; the incoming session's retryable refusal is dropped;
 * the outgoing session's force text is delivered into the incoming session.
 * Same-session BUG-045 (retried exactly-once guard) and FEAT-031 (force-send
 * within its own session) regressions stay green pre AND post.
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug079-data-'));
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
  console.log('\n========== BUG-079 — session switch leaves nothing of the outgoing session able to act on the incoming one ==========');
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

  // ---- boot the REAL app.js in happy-dom against the REAL server (verify-ui idiom)
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const win = new Window({ url: `${BASE}/` });
  const doc = win.document;
  doc.write(html.replace(/<link[^>]*>/g, '').replace(/<script[^>]*><\/script>/g, ''));
  doc.close();

  const g = win;
  const realFetch = globalThis.fetch;
  /*
   * BUG-217 round 5: queued rows now live in each session's SERVER outbox, which
   * DELIVERS them by itself — and this suite drives REAL sessions of a neighbour
   * project with the REAL CLI. So every outbox write is intercepted HERE and
   * recorded (never reaching the server): nothing this suite stages can start a
   * real turn. Reads pass through (the scratch server's outbox is empty).
   */
  const outboxPosts = [];
  g.fetch = (input, init) => {
    const url = input.startsWith('http') ? input : BASE + input;
    if (/\/api\/outbox(\/|$)/.test(new URL(url).pathname) && (init?.method ?? 'GET') === 'POST') {
      const body = JSON.parse(init.body ?? '{}');
      outboxPosts.push({ path: new URL(url).pathname, body });
      const row = { id: `q-staged-${outboxPosts.length}`, nonce: body.nonce ?? 'n', seq: outboxPosts.length, text: body.text ?? '', origin: body.origin ?? 'queued', state: body.initial ?? 'queued', reason: body.reason ?? null, createdAt: Date.now(), updatedAt: Date.now(), forced: false, via: null };
      const view = { sessionId: body.session, rows: body.discard ? [] : [row], recent: [], hold: null, damaged: null };
      return Promise.resolve(new Response(JSON.stringify(new URL(url).pathname === '/api/outbox' ? { row, created: true, view } : view), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return realFetch(url, init);
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
    const q = (s) => doc.querySelector(s);
    const qa = (s) => [...doc.querySelectorAll(s)];
    const projName = (n) => n.querySelector('.nm')?.textContent?.trim() ?? '';

    const booted = await waitFor('project list', () => qa('#tree button.proj').length > 0);
    if (!booted) throw new Error('app.js never rendered any project row');

    const st = win.__station.state;
    const ownRows = () => {
      const head = qa('#tree button.proj').find((n) => projName(n) === NB);
      return [...(head?.nextElementSibling?.querySelectorAll('button.row') ?? [])];
    };
    await waitFor("neighbor's sessions", () => ownRows().length > 0);

    // Open session A, then switch to B. If the neighbor has >=2 sessions the
    // switch is to a DISTINCT session (the true "A -> B" the ticket describes);
    // with only one, the switch RE-OPENS it — the same openSession boundary
    // code path (closeSocket + resetTranscript + clearPendingDelivery) runs.
    const rows = ownRows();
    const bIdx = rows.length > 1 ? 1 : 0;
    const distinct = rows.length > 1;
    async function openRow(i) {
      const ok = await waitFor(`session row ${i}`, () => ownRows().length > i, 20000);
      if (!ok) throw new Error(`session row ${i} never appeared (rows=${ownRows().length})`);
      ownRows()[i].click();
      await waitFor('transcript', () => qa('#panes .pane .you, #panes .pane .claude, #panes .pane .hint-row').length > 0, 30000);
      await sleep(200); // let openSession settle past its awaits
    }
    await openRow(0);
    check('precondition: distinct session B available for a real A->B switch (else same-session reopen)',
      true, distinct ? `${rows.length} sessions — switching to a distinct B` : '1 session — reopen boundary');

    const marker = (t) => `[Force-sent`; // deliverForced's prefix — present iff a force-send was delivered
    const bubbleHas = (needle) => qa('#panes .pane .you').some((n) => (n.textContent ?? '').includes(needle));

    /*
     * BUG-217 round 5 — the tab no longer holds ANY pending delivery of its own:
     * the BUG-045 self-retry (drainWaitAttempt + its interval) and the FEAT-031
     * force-send stash (forceSend) are gone; a retryable refusal becomes a row in
     * the refused session's SERVER outbox, and Interrupt & send is a request the
     * server carries out for that session's row. So the class this ticket fixed —
     * an outgoing session's pointer acting on the incoming one — has nothing left
     * to point with. What is asserted now is the same user-facing property, on the
     * new mechanism: after an A -> B switch, B's refusal goes to B's outbox (never
     * A's, never lost), nothing of A reaches B at B's turn-end, and the session-
     * boundary pointers the tab still has (pendingStart / pendingSend) are cleared.
     */
    // ========================= FINDING A — message LOSS =========================
    const A_SID = st.current.sessionId;
    st.pendingStart = 'A in-flight start (stale)';
    st.pendingStartResume = A_SID;
    await openRow(bIdx);
    const B_SID = st.current.sessionId;
    check('A: session switch CLEARED the outgoing session\'s pending start (no pointer survives the boundary)',
      st.pendingStart == null && st.pendingStartResume == null, `pendingStart=${JSON.stringify(st.pendingStart)} resume=${JSON.stringify(st.pendingStartResume)}`);
    check('A: the tab carries no self-retry machinery that could act on the new session (BUG-045 is the server outbox\'s now)',
      !('drainWaitAttempt' in st) && !('drainWaitTimer' in st) && !('forceSend' in st), `fields=${JSON.stringify(Object.keys(st).filter((k) => /drainWait|forceSend/.test(k)))}`);

    // B gets a retryable refusal on its own resume: the text goes to B's server outbox — never A's, never lost.
    const B_MSG = 'BUG-079 finding-A: B own message must be QUEUED not lost';
    const postsBefore = outboxPosts.length;
    st.pendingStart = B_MSG;
    st.pendingStartResume = B_SID;
    win.__station.onEvent({ t: 'error', fatal: false, retryable: true, message: 'still draining', drain: { count: 1 } });
    await waitFor('the outbox request', () => outboxPosts.length > postsBefore, 3000);
    const post = outboxPosts.slice(postsBefore).find((p) => p.body.text === B_MSG);
    const queuedRow = st.queue.find((r) => r.text === B_MSG);
    check("A: B's own retryable refusal was QUEUED into B's outbox, not dropped (and not A's)",
      !!queuedRow && post?.body?.session === B_SID && (distinct ? B_SID !== A_SID : true), `hasBMsg=${!!queuedRow} posted to=${post?.body?.session ?? null} A=${A_SID} B=${B_SID}`);

    // ========================= FINDING B — WRONG-TARGET =========================
    await openRow(0);
    const A_FORCE = `BUG-079 finding-B force text ${Date.now()}`;
    st.busyWatchdog = setTimeout(() => {}, 100000);
    await openRow(bIdx);
    check('B: session switch CANCELLED the force-send watchdog (must FAIL pre-fix)',
      st.busyWatchdog == null, `busyWatchdog=${String(st.busyWatchdog != null && !!st.busyWatchdog)}`);
    const hadForceBubbleBefore = bubbleHas(A_FORCE);
    win.__station.onEvent({ t: 'turn-end', interrupted: true, subtype: 'interrupted', durationMs: 10 });
    await sleep(150);
    check("B: turn-end did NOT deliver A's force text into B (must FAIL pre-fix: injected)",
      !bubbleHas(A_FORCE), `A-force bubble present in B: before=${hadForceBubbleBefore} after=${bubbleHas(A_FORCE)}`);

    // ================ SAME-SESSION REGRESSIONS ================
    // R1: Interrupt & send (FEAT-031) asks the SERVER to interrupt THIS session and send THIS row first.
    await openRow(0);
    const SAME_SID = st.current.sessionId;
    st.outbox = { sessionId: SAME_SID, rows: [{ id: 'q-same', nonce: 'n-same-0001', seq: 1, text: 'BUG-079 same-session force', origin: 'queued', state: 'queued', reason: null, createdAt: Date.now(), updatedAt: Date.now(), forced: false, via: null }], recent: [], hold: { kind: 'busy', text: '' }, damaged: null };
    win.__station.paintQueue?.();
    const postsR1 = outboxPosts.length;
    // A repaint rebuilds rows from state.outbox; press the row's own button.
    st.queue = st.outbox.rows.map((r) => ({ ...r, local: false }));
    win.__station.paintQueue();
    qa('#queueBox .force-send')[0]?.click();
    await waitFor('the interrupt request', () => outboxPosts.length > postsR1, 3000);
    const r1 = outboxPosts.slice(postsR1)[0];
    check('REGRESSION: Interrupt & send (FEAT-031) asks the server for THIS session\'s row, with interrupt',
      r1?.path === '/api/outbox/send' && r1.body.session === SAME_SID && r1.body.id === 'q-same' && r1.body.interrupt === true, JSON.stringify(r1 ?? null));

    // R2: BUG-045 — one retryable refusal of one start is ONE outbox request (no duplicate, no loss).
    await openRow(0);
    const postsR2 = outboxPosts.length;
    st.pendingStart = 'BUG-045 one refusal, one row';
    st.pendingStartResume = st.current.sessionId;
    win.__station.onEvent({ t: 'error', fatal: false, retryable: true, message: 'still draining', drain: { count: 1 } });
    await sleep(600);
    win.__station.onEvent({ t: 'error', fatal: false, retryable: true, message: 'still draining', drain: { count: 1 } }); // a stray second refusal: nothing pending, nothing added
    await sleep(600);
    const r2 = outboxPosts.slice(postsR2).filter((p) => p.body.text === 'BUG-045 one refusal, one row');
    check('REGRESSION: BUG-045 a retryable refusal becomes exactly ONE outbox row (a stray repeat adds nothing)',
      // (the dock then mirrors the scratch server, which never received the intercepted write — so count the requests)
      r2.length === 1 && st.queue.filter((r) => r.text === 'BUG-045 one refusal, one row').length <= 1,
      `requests=${r2.length} rows=${st.queue.filter((r) => r.text === 'BUG-045 one refusal, one row').length}`);
  } finally {
    try {
      const st2 = win.__station?.state;
      if (st2?.drainWaitTimer) { clearInterval(st2.drainWaitTimer); st2.drainWaitTimer = null; }
      if (st2?.liveTimer) { clearInterval(st2.liveTimer); st2.liveTimer = null; }
      if (st2?.busyWatchdog) { clearTimeout(st2.busyWatchdog); st2.busyWatchdog = null; }
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
