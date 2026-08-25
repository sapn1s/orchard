/**
 * BUG-029 — a resume the server refuses BEFORE the turn begins (the retryable
 * BUG-022 survivor-drain guard) must not lose the user's typed message.
 *
 *   node scripts/verify-resume-refusal.mjs
 *
 * The bug: startTurn() paints an optimistic "you" bubble, CLEARS the composer,
 * setBusy(true), opens a WS and sends `start`. When the server refuses with
 * {t:'error', fatal:false} the old client fell through to a 4s watchdog whose
 * "composer released" flip-flopped the status banner — meanwhile the bubble was
 * never persisted (the turn never started, so a reload lost it) and the typed
 * text was gone (cleared, never restored).
 *
 * The fix (BUG-029): a pre-turn refusal (`state.pendingStart` still set, no
 * `ack`) is rolled back immediately — the phantom bubble is removed, busy is
 * released at once (no 4s watchdog) — and for a NON-retryable refusal the
 * text is handed back to the composer.
 *
 * BUG-045 (the retryable half, e.g. this survivor-drain guard): the old
 * client bounced even a `retryable:true` refusal to the composer with "press
 * Enter to try again", leaving the user mashing Enter for the length of the
 * drain. Now the message becomes a visible drain-wait QUEUE row ("waiting for
 * the previous turn to finish draining"), stays editable and discardable, and
 * the client re-attempts the SAME resume itself on a slow poll (plus the
 * live-poll transition) — the server's gate re-judges every attempt, so
 * BUG-033/BUG-022 are untouched.
 *
 * We force the guard cheaply WITHOUT systemd or a slow real turn: plant a
 * surviving-host status file (a real live dummy pid) whose sdkSessionId matches
 * a real on-disk session, then drive the REAL app.js to resume that session.
 * `survivingHostForSdkSession` finds the planted host and the server refuses
 * exactly as it would during a genuine restart drain window. The drain never
 * settles here (the dummy stays alive), so no real turn ever runs against the
 * neighbor project; the settled-drain AUTO-DELIVERY leg is
 * verify-refusal-visible.mjs's ALIVE scenario (scratch project, real turn).
 *
 * PRE-FIX (BUG-045) assertions (each FAILS): no queue row / no drain chip
 * (the text bounced to the composer instead), no self-retry ever fires, the
 * row cannot be edited or discarded because it does not exist.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Window } from 'happy-dom';
import WebSocket from 'ws';
import { findNeighborProject } from './lib/neighbor-project.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-refusal-data-'));
const NEIGHBOR = findNeighborProject({ excludePath: path.resolve(import.meta.dirname, '..') });
const NB = path.basename(NEIGHBOR);
const TESTMSG = 'BUG-029 keep-this-message please';

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
let dummy = null;

async function main() {
  console.log('\n========== BUG-029 — pre-turn resume refusal keeps the typed message ==========');
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
  check('precondition: neighbor project has at least one on-disk session to resume', sessions.length > 0,
    `${sessions.length} session(s)`);
  if (!sessions.length) throw new Error('no sessions to drive the resume path');

  // A real, alive pid for the planted broker so `pidAlive()` in the guard is true.
  dummy = spawn('sleep', ['300'], { stdio: 'ignore', detached: true });
  dummy.unref();
  const hostsDir = path.join(DATA, 'session-hosts');
  fs.mkdirSync(hostsDir, { recursive: true });
  // Plant one survivor-host status per session id so whichever row the app
  // clicks, the cross-process guard fires exactly as in a real drain window.
  for (const s of sessions) {
    const key = `h-planted-${s.sessionId.slice(0, 8)}`;
    const status = path.join(hostsDir, `${key}.json`);
    fs.writeFileSync(status, JSON.stringify({
      hostPid: dummy.pid, claudePid: dummy.pid, sock: path.join(hostsDir, `${key}.sock`),
      status, sdkSessionId: s.sessionId, resumeHint: s.sessionId,
      state: 'draining', exitCode: null, signal: null, updatedAt: new Date().toISOString(),
    }), { mode: 0o600 });
  }

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

  const prev = { document: globalThis.document, window: globalThis.window, WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, location: globalThis.location };
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

    // The first project is auto-expanded at boot (app.js load()), so the neighbor's
    // sessions load without a click — clicking the header would only COLLAPSE it.
    const ownRows = () => {
      const head = qa('#tree button.proj').find((n) => projName(n) === NB);
      return [...(head?.nextElementSibling?.querySelectorAll('button.row') ?? [])];
    };
    await waitFor("neighbor's sessions", () => ownRows().length > 0);
    ownRows()[0].click();
    await waitFor('transcript', () => qa('#panes .pane .you, #panes .pane .claude').length > 0, 30000);

    // The optimistic bubble is a NEW top-level `.you` in the main pane — count
    // the baseline so we can prove it was added then rolled back. The
    // transcript renders progressively, so wait for the count to go STABLE
    // first (two identical samples 600ms apart) or the baseline is noise.
    const mainYou = () => qa('#panes .pane .you').length;
    let beforeYou = mainYou();
    for (let i = 0; i < 30; i++) { await sleep(600); const n = mainYou(); if (n === beforeYou) break; beforeYou = n; }

    const prompt = q('#prompt');
    const go = q('#go');
    if (!prompt || !go) throw new Error('composer (#prompt/#go) missing');
    prompt.value = TESTMSG;
    go.click();

    // The refusal is handled in well under the OLD 4s watchdog. Poll a short
    // window for the queued state; old code bounced the text to the composer.
    const queued = await waitFor('drain-wait queue row after refusal', () => qa('#queueBox .qrow').length === 1, 3000);
    const fine = (q('#fine')?.textContent ?? '');
    const st = win.__station?.state;

    // ---- BUG-045: retryable refusal QUEUES (each of these FAILS pre-fix) ----
    check('the retryable survivor-drain refusal QUEUED the message (visible queue row, not composer bounce)',
      queued && q('#queueBox .qedit')?.value === TESTMSG,
      `rows=${qa('#queueBox .qrow').length} rowText=${JSON.stringify(q('#queueBox .qedit')?.value ?? null)}`);
    check('the drain-wait chip names why it is waiting',
      /waiting for the previous turn to finish draining/.test(q('#queueBox .q-l')?.textContent ?? ''),
      `chip=${JSON.stringify(q('#queueBox .q-l')?.textContent ?? null)} #fine=${JSON.stringify(fine.slice(0, 120))}`);
    check('the composer was NOT re-filled (the queue row owns the text now)',
      q('#prompt')?.value === '', `#prompt.value=${JSON.stringify(q('#prompt')?.value)}`);
    check('the phantom optimistic bubble was rolled back (no lingering extra .you)',
      mainYou() === beforeYou, `you-count before=${beforeYou} after=${mainYou()}`);
    check('the composer released IMMEDIATELY (send mode, no 4s watchdog)',
      q('#go')?.dataset?.mode === 'send', `#go data-mode=${JSON.stringify(q('#go')?.dataset?.mode)}`);
    check('the self-retry loop is ARMED while the drain-wait row is queued',
      !!st?.drainWaitTimer, `state.drainWaitTimer=${String(st?.drainWaitTimer != null && !!st.drainWaitTimer)}`);

    // ---- BUG-045: the retry actually FIRES by itself (FAILS pre-fix). The
    // dummy broker is still alive, so the server refuses the retry again.
    // `drainWaitLastTry` is stamped ONLY when a self-retry launches a real
    // `start` (attemptDrainRetry) — a deterministic signal, unlike #fine which
    // other tickers can overwrite between polls.
    const retried = await waitFor('an automatic self-retry round-trip',
      () => (st?.drainWaitLastTry ?? 0) > 0 && st?.drainWaitAttempt == null, 12000);
    check('the queued message RETRIES ITSELF against the still-draining survivor (no Enter pressed)',
      retried, `drainWaitLastTry=${st?.drainWaitLastTry ?? null} #fine=${JSON.stringify((q('#fine')?.textContent ?? '').slice(0, 140))}`);
    check('the re-refused retry kept exactly ONE queue row (no duplicate, no loss)',
      qa('#queueBox .qrow').length === 1 && q('#queueBox .qedit')?.value === TESTMSG,
      `rows=${qa('#queueBox .qrow').length} rowText=${JSON.stringify(q('#queueBox .qedit')?.value ?? null)}`);

    // ---- BUG-045: the queued row stays EDITABLE and CANCELABLE ----
    const ta = q('#queueBox .qedit');
    if (ta) {
      ta.value = `${TESTMSG} (edited)`;
      ta.dispatchEvent(new win.Event('input', { bubbles: true }));
    }
    check('the queued row is editable (edit reaches the item that would be sent)',
      st?.queue?.[0]?.text === `${TESTMSG} (edited)`,
      `item.text=${JSON.stringify(st?.queue?.[0]?.text ?? null)}`);
    qa('#queueBox .mini.x').find((b) => b.textContent === 'Discard')?.click();
    check('the queued row is cancelable (Discard empties the queue)',
      (st?.queue?.length ?? -1) === 0 && q('#queueBox')?.hidden === true,
      `queue.length=${st?.queue?.length} boxHidden=${q('#queueBox')?.hidden}`);

    // ---- BUG-029 anti-regression: a NON-retryable pre-ack refusal still
    // returns the text to the composer (and never queues). Driven through the
    // real onEvent with the real state machine — only the wire event is staged.
    const TESTMSG2 = 'BUG-029 non-retryable keep-me in composer';
    st.pendingStart = TESTMSG2;
    st.pendingStartResume = sessions[0].sessionId;
    win.__station.onEvent({ t: 'error', fatal: false, message: 'no session on this socket' });
    check('BUG-029 kept: a NON-retryable refusal returns the text to the COMPOSER',
      q('#prompt')?.value === TESTMSG2, `#prompt.value=${JSON.stringify(q('#prompt')?.value)}`);
    check('BUG-029 kept: a NON-retryable refusal queues NOTHING',
      (st?.queue?.length ?? -1) === 0, `queue.length=${st?.queue?.length}`);
  } finally {
    // Stop the app's own timers (BUG-045 self-retry interval, live poll) and
    // let close-triggered microtasks (setBusy → flushQueue → paintQueue) run
    // while `document` still exists — restoring the globals first crashed the
    // process before the summary could print.
    try {
      const st2 = win.__station?.state;
      if (st2?.drainWaitTimer) { clearInterval(st2.drainWaitTimer); st2.drainWaitTimer = null; }
      if (st2?.liveTimer) { clearInterval(st2.liveTimer); st2.liveTimer = null; }
    } catch { /* app never booted that far */ }
    for (const s of openSockets) { try { s.removeAllListeners?.(); s.close(); } catch { /* closed */ } }
    await sleep(300);
    // Deliberately DO NOT restore `document`/`window`: app.js armed several
    // module-level timers (rail poll, proc poll, …) that dereference
    // `document` — restoring it to undefined here crashed the process before
    // the summary printed. Nothing after this point uses the DOM globals, and
    // the finally() below exits the process moments later.
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
  try { if (dummy?.pid) process.kill(dummy.pid, 'SIGKILL'); } catch { /* gone */ }
  await sleep(300);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
  setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
});
