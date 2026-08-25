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
  console.log('\n========== BUG-079 — session switch clears pending drain-wait + force-send state ==========');
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
  g.fetch = (input, init) => realFetch(input.startsWith('http') ? input : BASE + input, init);
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

    // ========================= FINDING A — message LOSS =========================
    // Plant the state a mid-flight drain-wait self-retry leaves in session A:
    // an in-flight attempt row + an armed self-retry interval.
    const staleAttempt = { text: 'A drain-wait row (stale)', dead: null, composedAt: Date.now(), drainWait: true, drainProject: st.current.projectId };
    st.drainWaitAttempt = staleAttempt;
    st.drainWaitLastTry = Date.now();
    if (!st.drainWaitTimer) st.drainWaitTimer = setInterval(() => {}, 100000);

    // Switch A -> B (real openSession via the row click).
    await openRow(bIdx);

    check('A: session switch CLEARED the stale drain-wait attempt (must FAIL pre-fix)',
      st.drainWaitAttempt === null, `drainWaitAttempt=${st.drainWaitAttempt ? JSON.stringify(st.drainWaitAttempt.text) : 'null'}`);
    check('A: session switch DISARMED the drain-wait self-retry interval (must FAIL pre-fix)',
      st.drainWaitTimer == null, `drainWaitTimer=${String(st.drainWaitTimer != null && !!st.drainWaitTimer)}`);

    // Now B gets a retryable refusal on its own send. With the stale attempt
    // gone, queueRetryableRefusal enqueues; with it present it drops the text.
    const B_MSG = 'BUG-079 finding-A: B own message must be QUEUED not lost';
    const beforeQ = st.queue.length;
    st.pendingStart = B_MSG;
    st.pendingStartResume = null;
    win.__station.onEvent({ t: 'error', fatal: false, retryable: true, message: 'still draining', drain: { count: 1 } });
    const queuedRow = st.queue.find((r) => r.text === B_MSG);
    check("A: B's own retryable refusal was QUEUED, not dropped (must FAIL pre-fix: lost)",
      !!queuedRow, `queue.len ${beforeQ}->${st.queue.length}, hasBMsg=${!!queuedRow}`);

    // ========================= FINDING B — WRONG-TARGET =========================
    // Re-open A cleanly (drops B's queue), then plant a pending force-send in A
    // and an armed watchdog, switch to B, and drive B's next turn-end.
    await openRow(0);
    const A_FORCE = `BUG-079 finding-B force text ${Date.now()}`;
    st.forceSend = { text: A_FORCE, dead: null, composedAt: Date.now() };
    st.busyWatchdog = setTimeout(() => {}, 100000);

    await openRow(bIdx);
    check('B: session switch CLEARED the stale force-send stash (must FAIL pre-fix)',
      st.forceSend === null, `forceSend=${st.forceSend ? JSON.stringify(st.forceSend.text) : 'null'}`);
    check('B: session switch CANCELLED the force-send watchdog (must FAIL pre-fix)',
      st.busyWatchdog == null, `busyWatchdog=${String(st.busyWatchdog != null && !!st.busyWatchdog)}`);

    // Drive B's next turn-end. Post-fix nothing to deliver; pre-fix A's text is
    // injected into B via deliverForced.
    const hadForceBubbleBefore = bubbleHas(A_FORCE);
    win.__station.onEvent({ t: 'turn-end', interrupted: true, subtype: 'interrupted', durationMs: 10 });
    await sleep(150);
    check("B: turn-end did NOT deliver A's force text into B (must FAIL pre-fix: injected)",
      !bubbleHas(A_FORCE), `A-force bubble present in B: before=${hadForceBubbleBefore} after=${bubbleHas(A_FORCE)}`);

    // ================ SAME-SESSION REGRESSIONS (green pre AND post) ================
    // R1: force-send WITHIN its own session still delivers at turn-end (FEAT-031
    // Part A) — no switch, so clearPendingDelivery never runs; deliverForced
    // paints its bubble.
    await openRow(0);
    const SAME_FORCE = `BUG-079 same-session force ${Date.now()}`;
    st.forceSend = { text: SAME_FORCE, dead: null, composedAt: Date.now() };
    win.__station.onEvent({ t: 'turn-end', interrupted: true, subtype: 'interrupted', durationMs: 10 });
    await sleep(150);
    check('REGRESSION: force-send WITHIN its own session still delivers at turn-end (FEAT-031)',
      bubbleHas(SAME_FORCE) && st.forceSend === null,
      `same-force bubble=${bubbleHas(SAME_FORCE)} forceSend=${st.forceSend === null ? 'null' : 'set'}`);

    // R2: BUG-045 exactly-once "retried" guard within one session — a re-refused
    // self-retry keeps the SAME row queued (no duplicate, no new row). No switch.
    await openRow(0);
    const itemX = { text: 'BUG-045 in-flight self-retry row', dead: null, composedAt: Date.now(), drainWait: true, drainProject: st.current.projectId };
    st.queue.length = 0;
    st.queue.push(itemX);
    st.drainWaitAttempt = itemX;
    st.pendingStart = itemX.text;
    st.pendingStartResume = null;
    const qLenBefore = st.queue.length;
    win.__station.onEvent({ t: 'error', fatal: false, retryable: true, message: 'still draining', drain: { count: 1 } });
    check('REGRESSION: BUG-045 re-refused self-retry keeps exactly ONE row (retried guard intact)',
      st.queue.length === qLenBefore && st.queue.filter((r) => r === itemX).length === 1 && st.drainWaitAttempt === null,
      `queue.len ${qLenBefore}->${st.queue.length} itemXcount=${st.queue.filter((r) => r === itemX).length} drainWaitAttempt=${st.drainWaitAttempt === null ? 'null' : 'set'}`);
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
