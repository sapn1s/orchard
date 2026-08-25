/**
 * BUG-129 (option A) — a message typed while the assistant is working must
 * survive the tab that took it.
 *
 * The live loss: the pending queue was a plain array on the in-memory state
 * object. A reload, a tab close or a session switch destroyed typed-but-
 * undelivered text with no signal and no copy anywhere on disk (see the
 * ticket's Evidence — the lost message was in no store on either side).
 *
 * This drives a REAL browser against a REAL server with its own data dir, and
 * runs REAL turns: the decisive case is a reload with a message pending, which
 * no fixture over a state object can express.
 *
 * What is asserted, in the user's terms:
 *   1. Type while a real reply is running, RELOAD — the text is on screen, in
 *      the dock, still marked unsent (not merely "a storage key exists").
 *   2. It still looks DIFFERENT from an ordinary queued row — asserted by
 *      computed background colour, plus two screenshots that must differ.
 *   3. It still delivers, ONCE, at the next pause — the on-disk transcript is
 *      the judge (durable twice is a different harm, and the ticket says so).
 *   4. A session boundary no longer discards rows: switch away, come back, the
 *      text is there.
 *   5. A batch HANDED to the socket is durable for the whole send -> turn-end
 *      window (the outbox), retired when the turn ends, and comes back marked
 *      "never saw its turn start" — never silently resent — if it does not.
 *   6. MUST-FAIL: the same script actions against a SYNTHESIZED pre-fix client
 *      (persistQueue/adoptQueue neutered by a mechanical transform served
 *      through CDP interception) lose the text, as they did live. The baseline
 *      is a constructed variant, never `HEAD` — committing this fix must not
 *      turn the proof into decoration.
 *
 *   node scripts/verify-bug-129-queue-durability.mjs      (runs real turns)
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_BUG129_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-129-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-129-chrome-'));
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-129-shots-'));
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';

let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.on = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c = new Cdp(ws);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && c.waiting.has(m.id)) {
        const { res, rej } = c.waiting.get(m.id);
        c.waiting.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method && c.on.has(m.method)) {
        c.on.get(m.method)(m.params);
      }
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.waiting.set(id, { res, rej }));
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async waitFor(label, expr, timeoutMs = 30_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.eval(expr)) return true; } catch { /* nav */ }
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

let server = null, browser = null;
const cleanupDirs = [DATA, PROFILE];
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

/*
 * The MUST-FAIL baseline. NOT `git show HEAD:public/app.js`: the moment this
 * fix is committed HEAD becomes the FIXED state and the proof could never fail
 * again (docs/CONVENTIONS.md — "a must-FAIL proof must not be anchored to a
 * moving baseline"). Instead the pre-fix client is CONSTRUCTED from the current
 * one by a mechanical transform whose hit count is asserted: neutering
 * persistQueue + adoptQueue reproduces exactly the pre-fix arrangement — the
 * queue lives only in the tab's heap. If the transform ever stops matching,
 * this throws rather than quietly proving nothing.
 */
function preFixClient() {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const edits = [
    ['function persistQueue() {', 'function persistQueue() { return; /* PRE-FIX: nothing is ever written */'],
    ['function adoptQueue() {', 'function adoptQueue() { return; /* PRE-FIX: nothing is ever restored */'],
  ];
  let out = src;
  for (const [from, to] of edits) {
    const hits = out.split(from).length - 1;
    if (hits !== 1) throw new Error(`pre-fix transform matched ${hits}x (expected 1) for: ${from}`);
    out = out.replace(from, to);
  }
  return out;
}

/**
 * A REAL reload, proved to be one. `Page.navigate` to the page's own URL is a
 * SAME-DOCUMENT navigation when only the fragment is involved: the tab's heap
 * survives, nothing is restored, and every assertion here would pass vacuously
 * on the untouched in-memory queue. (That is not hypothetical — the first run
 * of this suite did exactly that and reported three green checks about a reload
 * that never happened.) So: plant a marker on the document, reload, and throw
 * unless the marker is gone.
 */
async function reload(cdp, label) {
  await cdp.eval(`window.__reloadMarker129 = 'same-document'`);
  await cdp.send('Page.reload', { ignoreCache: true });
  if (!await cdp.waitFor(`reboot (${label})`, `window.__station !== undefined`, 45_000)) {
    throw new Error(`the page never came back after the ${label} reload`);
  }
  const marker = await cdp.eval(`window.__reloadMarker129 ?? null`);
  if (marker !== null) throw new Error(`the ${label} "reload" did not reload the document (marker survived) — the check would be vacuous`);
}

/** Queue N messages through the REAL submit() path while a turn is running. */
function typeSendExpr(t) {
  return `(() => {
    const p = document.querySelector('#prompt');
    p.value = ${JSON.stringify(t)};
    p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })()`;
}

const DOCK = `(() => ({
  rows: [...document.querySelectorAll('#queueBox .qrow')].map((r) => ({
    status: r.querySelector('.qs')?.textContent ?? '',
    text: r.querySelector('.qedit')?.value ?? '',
    restored: r.classList.contains('restored'),
    dead: r.classList.contains('dead'),
  })),
  label: document.querySelector('#queueBox .q-l')?.textContent ?? '',
  hidden: document.querySelector('#queueBox').hidden,
}))()`;

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-129-proj-'));
  cleanupDirs.push(projDir);
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: projDir, name: 'bug129-fixture' }),
  })).json();
  if (!reg.project?.id) throw new Error(`register failed: ${JSON.stringify(reg)}`);

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  // The pre-fix leg below substitutes app.js through Fetch interception; a
  // memory-cached copy would silently defeat it and the must-FAIL proof would
  // then be run against the FIXED client and "pass" vacuously.
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('boot', `window.__station !== undefined`);

  /* ═══ 1. the live case: type while a real reply runs, then RELOAD ═══ */
  console.log('\n=== 1. a message typed during a real reply survives a reload ===');
  await cdp.eval(`(() => {
    const st = window.__station.state;
    st.overrides.model = 'haiku';
    document.querySelector('#prompt').value = 'Write a detailed 400-word story about a lighthouse keeper.';
    document.querySelector('#go').click();
  })()`);
  if (!await cdp.waitFor('turn running', `window.__station.state.busy === true`, 60_000)) {
    throw new Error('the first turn never started — cannot test the mid-turn case');
  }
  const A = 'Reply with exactly: SURVIVED-ALPHA';
  const B = 'Reply with exactly: SURVIVED-BRAVO';
  await cdp.eval(typeSendExpr(A));
  await cdp.eval(typeSendExpr(B));
  const beforeReload = await cdp.eval(DOCK);
  check('both mid-turn messages are queued in the dock before the reload',
    beforeReload.rows.length === 2 && beforeReload.rows[0].text === A && beforeReload.rows[1].text === B,
    JSON.stringify(beforeReload.rows.map((r) => r.text)));

  const storedBefore = await cdp.eval(`localStorage.getItem(window.__station.QUEUE_KEY)`);
  check('the accepted text is written to durable storage AT ACCEPTANCE (both texts present)',
    typeof storedBefore === 'string' && storedBefore.includes('SURVIVED-ALPHA') && storedBefore.includes('SURVIVED-BRAVO'),
    (storedBefore ?? '(nothing stored)').slice(0, 220));

  if (!await cdp.waitFor('session id in the URL',
    `!!window.__station.state.current.sessionId && location.hash.includes(window.__station.state.current.sessionId)`, 60_000)) {
    throw new Error('the session never acquired an id — a reload would not resolve back to it');
  }
  const url = await cdp.eval(`location.href`);
  await reload(cdp, 'mid-turn');
  const restoredOk = await cdp.waitFor('rows restored',
    `document.querySelectorAll('#queueBox .qrow').length >= 2`, 30_000);
  const afterReload = await cdp.eval(DOCK);
  check('AFTER THE RELOAD the user can still see their own words on screen, in the dock',
    restoredOk && afterReload.rows.some((r) => r.text === A) && afterReload.rows.some((r) => r.text === B),
    JSON.stringify(afterReload.rows.map((r) => r.text)));
  check('and each restored row SAYS it is still unsent (row status + dock label), whatever else the dock is reporting',
    afterReload.rows.filter((r) => r.restored).length >= 2
      && afterReload.rows.every((r) => !r.restored || /unsent/.test(r.status))
      && /restored after a reload, still unsent/.test(afterReload.label)
      && !/delivering/.test(afterReload.label),
    JSON.stringify({ label: afterReload.label, statuses: afterReload.rows.map((r) => r.status) }));

  /* ═══ 2. an unsent row LOOKS different from an ordinary queued one ═══ */
  console.log('\n=== 2. restored-and-unsent is visibly distinct from ordinary queued ===');
  // Queued through the real queueMessage(), not the composer: after a mid-turn
  // reload the tab is still re-attaching, and submit() would take the start
  // gate instead — which would leave this leg with no ORDINARY row to compare
  // the restored one against (observed: the comparison silently had nothing to
  // compare, which is the vacuous shape this suite is supposed to refuse).
  const C = 'Reply with exactly: SURVIVED-CHARLIE';
  await cdp.eval(`window.__station.queueMessage(${JSON.stringify(C)})`);
  const colours = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('#queueBox .qrow')];
    const r = rows.find((x) => x.classList.contains('restored'));
    const n = rows.find((x) => !x.classList.contains('restored'));
    if (!r || !n) return { got: rows.length, restored: !!r, normal: !!n };
    const cs = (el) => getComputedStyle(el.querySelector('summary'));
    return {
      restoredBg: cs(r).backgroundColor, normalBg: cs(n).backgroundColor,
      restoredEdge: cs(r).borderLeftWidth + ' ' + cs(r).borderLeftColor,
      normalEdge: cs(n).borderLeftWidth + ' ' + cs(n).borderLeftColor,
    };
  })()`);
  check('a restored (unsent) row and an ordinary queued row differ by COMPUTED background colour, not just by markup',
    !!colours.restoredBg && colours.restoredBg !== colours.normalBg && colours.restoredEdge !== colours.normalEdge,
    JSON.stringify(colours));
  // Screenshots for the record — and they must differ from each other, which
  // is asserted on the BYTES only as a secondary signal; the computed-colour
  // assertion above is the real one (an earlier check in this area passed
  // vacuously by producing two identical captures).
  const shotOf = async (name, expr) => {
    await cdp.eval(expr);
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(SHOTS, name);
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    return p;
  };
  const shotA = await shotOf('restored-marked.png', `document.querySelector('#queueBox').scrollIntoView()`);
  const shotB = await shotOf('restored-unmarked.png',
    `[...document.querySelectorAll('#queueBox .qrow.restored')].forEach((r) => r.classList.remove('restored'))`);
  const bytesDiffer = !fs.readFileSync(shotA).equals(fs.readFileSync(shotB));
  check('the marking is actually rendered (screenshot with vs without the restored class differs)',
    bytesDiffer, JSON.stringify({ shotA, shotB, bytesDiffer }));
  await cdp.eval(`window.__station.paintQueue()`); // restore the real classes

  /* ═══ 3. it still delivers — once ═══ */
  console.log('\n=== 3. the restored rows are honest about their state, then really deliver, once ===');
  /*
   * A reloaded tab FOLLOWS the live session; it does not drive it until the
   * user sends (pre-existing behaviour). Before this fix the rows were gone by
   * then so the question never arose — now they are on screen, and the dock
   * must not promise a delivery this tab cannot perform. Asserted first,
   * because that promise is exactly the kind of lie this ticket is about.
   */
  const notDriving = await cdp.eval(`({
    live: window.__station.state.live, label: document.querySelector('#queueBox .q-l')?.textContent ?? '',
  })`);
  check('while the reloaded tab is only FOLLOWING the session, the dock says so instead of promising delivery',
    notDriving.live ? true : /not driving the session/.test(notDriving.label),
    JSON.stringify(notDriving));

  // The real journey: the running turn finishes, the user takes the session
  // over by sending their next message — and the restored rows go with it.
  if (!await cdp.waitFor('followed turn finished', `window.__station.state.busy === false`, 300_000)) {
    throw new Error('the followed turn never ended');
  }
  await sleep(1000);
  await cdp.eval(`(() => {
    document.querySelector('#prompt').value = 'Reply with exactly: TAKEOVER-HOTEL';
    document.querySelector('#go').click();
  })()`);
  const drained = await cdp.waitFor('queue drained + idle after the takeover',
    `window.__station.state.queue.length === 0 && window.__station.state.busy === false`, 300_000);
  check('taking the session over delivers the rows that survived the reload (the queue drains)', drained,
    await cdp.eval(`({ q: window.__station.state.queue.length, busy: window.__station.state.busy, live: window.__station.state.live })`));
  // Read the session the tab is ACTUALLY in now: taking over a session resumes
  // it, and a resume can land under a new id. Pinning the pre-reload id here
  // would grade the wrong file.
  const sid = await cdp.eval(`window.__station.state.current.sessionId`);
  const dir = await cdp.eval(`window.__station.state.current.encodedDir`);
  await sleep(2000);
  const readTranscript = async (which = {}) => {
    const t = await (await fetch(`${BASE}/api/transcript/${encodeURIComponent(which.dir ?? dir)}/${encodeURIComponent(which.sid ?? sid)}?tail=300`)).json();
    return (t.messages ?? []).flatMap((m) => (m.blocks ?? []).filter((b) => b.type === 'text').map((b) => `${m.role}:${b.text}`));
  };
  const texts = await readTranscript();
  const countIn = (needle) => texts.filter((x) => x.startsWith('user:') && x.includes(needle)).length;
  check('every message typed before the reload reached the model, and NOT twice (durable, not duplicated)',
    countIn('SURVIVED-ALPHA') === 1 && countIn('SURVIVED-BRAVO') === 1 && countIn('SURVIVED-CHARLIE') === 1,
    JSON.stringify({ alpha: countIn('SURVIVED-ALPHA'), bravo: countIn('SURVIVED-BRAVO'), charlie: countIn('SURVIVED-CHARLIE'), sid }));
  const storedAfter = await cdp.eval(`localStorage.getItem(window.__station.QUEUE_KEY)`);
  check('once delivered, nothing lingers in storage to come back as a zombie row',
    !String(storedAfter ?? '').includes('SURVIVED-'), String(storedAfter ?? '(empty)').slice(0, 200));

  /* ═══ 4. a session boundary no longer discards pending rows ═══ */
  console.log('\n=== 4. switching sessions away and back keeps the pending text ===');
  const D = 'Reply with exactly: BOUNDARY-DELTA';
  await cdp.eval(`window.__station.queueMessage(${JSON.stringify(D)})`);
  const projId = await cdp.eval(`window.__station.state.current.projectId`);
  await cdp.eval(`window.__station.startNew(${JSON.stringify(projId)})`);
  const away = await cdp.eval(`({ q: window.__station.state.queue.length, rows: document.querySelectorAll('#queueBox .qrow').length })`);
  check('switching away clears the dock for the session being left (unchanged behaviour)',
    away.q === 0 && away.rows === 0, JSON.stringify(away));
  const storedAway = await cdp.eval(`localStorage.getItem(window.__station.QUEUE_KEY)`);
  check('…but the text itself is NOT destroyed by the boundary — it is still stored under that session',
    String(storedAway ?? '').includes('BOUNDARY-DELTA'), String(storedAway ?? '(empty)').slice(0, 200));
  await cdp.eval(`(async () => {
    const st = window.__station.state;
    const p = window.__station.state.projects.find((x) => x.id === ${JSON.stringify(projId)});
    const s = (await window.__station.loadSessions(p.id, { force: true })).list.find((x) => x.sessionId === ${JSON.stringify(sid)});
    await window.__station.openSession(p, s);
  })()`);
  const back = await cdp.waitFor('row back on screen',
    `[...document.querySelectorAll('#queueBox .qedit')].some((t) => t.value.includes('BOUNDARY-DELTA'))`, 30_000);
  const backDock = await cdp.eval(DOCK);
  const backDiag = await cdp.eval(`({
    ownerKey: window.__station.queueOwnerKey(),
    draftKey: window.__station.draftKey(window.__station.state.current),
    storeKeys: Object.keys(JSON.parse(localStorage.getItem(window.__station.QUEUE_KEY) ?? '{}')),
    queue: window.__station.state.queue.length,
  })`);
  check('coming back to that session puts the undelivered text back on screen, marked unsent',
    back && backDock.rows.some((r) => r.text.includes('BOUNDARY-DELTA') && r.restored && /unsent/.test(r.status)),
    JSON.stringify({ rows: backDock.rows, ...backDiag }));
  // Discard it through the real button so it cannot ride into a later turn.
  await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('#queueBox .qrow')];
    const r = rows.find((x) => x.querySelector('.qedit')?.value.includes('BOUNDARY-DELTA'));
    r?.querySelector('button.x')?.click();
  })()`);
  const afterDiscard = await cdp.eval(`localStorage.getItem(window.__station.QUEUE_KEY)`);
  check('a DISCARDED row is really gone from storage too (a discard must not resurrect)',
    !String(afterDiscard ?? '').includes('BOUNDARY-DELTA'), String(afterDiscard ?? '(empty)').slice(0, 200));

  /* ═══ 5. the handed-to-the-socket window (the outbox) ═══ */
  console.log('\n=== 5. a batch handed to the socket is durable until its turn ends ===');
  // A watcher inside the page samples storage every 20 ms, so the REAL write in
  // the send -> turn-end window is captured as it happens rather than described.
  await cdp.eval(`(() => {
    window.__ob129 = null;
    clearInterval(window.__ob129t);
    window.__ob129t = setInterval(() => {
      try {
        const s = JSON.parse(localStorage.getItem(window.__station.QUEUE_KEY) ?? '{}');
        for (const [k, v] of Object.entries(s)) if (v && v.outbox) window.__ob129 = { key: k, entry: v };
      } catch {}
    }, 20);
  })()`);
  await cdp.eval(`(() => {
    const st = window.__station.state;
    st.overrides.model = 'haiku';
    document.querySelector('#prompt').value = 'Write a detailed 300-word story about a river ferry.';
    document.querySelector('#go').click();
  })()`);
  if (!await cdp.waitFor('turn running (outbox leg)', `window.__station.state.busy === true`, 60_000)) {
    throw new Error('the outbox-leg turn never started');
  }
  const E = 'Reply with exactly: OUTBOX-ECHO';
  await cdp.eval(typeSendExpr(E));
  const settled = await cdp.waitFor('outbox leg drained + idle',
    `window.__station.state.queue.length === 0 && window.__station.state.busy === false && window.__ob129 !== null`, 300_000);
  const captured = await cdp.eval(`window.__ob129`);
  await cdp.eval(`clearInterval(window.__ob129t)`);
  check('while the batch was in flight — out of the queue, not yet acknowledged by a turn — it was still recorded on disk',
    settled && !!captured?.entry?.outbox?.texts?.some((t) => t.includes('OUTBOX-ECHO')),
    JSON.stringify(captured?.entry?.outbox ?? '(never observed)'));
  const afterTurn = await cdp.eval(`localStorage.getItem(window.__station.QUEUE_KEY)`);
  check('and it is retired once the turn ENDS (so a later reload raises no false "undelivered" alarm)',
    !String(afterTurn ?? '').includes('OUTBOX-ECHO'), String(afterTurn ?? '(empty)').slice(0, 200));

  // Replay of that REAL captured entry, with its text changed to something the
  // transcript does not contain — the shape a refused-after-ack send leaves
  // behind. (The bytes are real; the substituted text is synthetic, and said so.)
  await cdp.eval(`(() => {
    const cap = ${JSON.stringify(captured)};
    const entry = JSON.parse(JSON.stringify(cap.entry));
    entry.rows = [];
    entry.outbox.texts = ['NEVER-ARRIVED-FOXTROT'];
    const store = JSON.parse(localStorage.getItem(window.__station.QUEUE_KEY) ?? '{}');
    store[window.__station.draftKey(window.__station.state.current)] = entry;
    localStorage.setItem(window.__station.QUEUE_KEY, JSON.stringify(store));
  })()`);
  await reload(cdp, 'unconfirmed replay');
  const unconfirmed = await cdp.waitFor('unconfirmed row',
    `[...document.querySelectorAll('#queueBox .qedit')].some((t) => t.value.includes('NEVER-ARRIVED-FOXTROT'))`, 30_000);
  const unconfDock = await cdp.eval(DOCK);
  const row = unconfDock.rows.find((r) => r.text.includes('NEVER-ARRIVED-FOXTROT'));
  check('a handed-off message whose turn was never seen comes back — readable, copyable, and NOT claimed as delivered',
    unconfirmed && !!row && row.dead && /NOT delivered/.test(row.status) && /never saw its turn start/.test(row.status),
    JSON.stringify(row ?? unconfDock.rows));
  const resent = (await readTranscript()).filter((x) => x.includes('NEVER-ARRIVED-FOXTROT')).length;
  check('…and it is NEVER silently resent (redelivering reads as the user repeating themselves)',
    resent === 0, JSON.stringify({ occurrencesInTranscript: resent }));
  await cdp.eval(`(() => {
    const r = [...document.querySelectorAll('#queueBox .qrow')].find((x) => x.querySelector('.qedit')?.value.includes('NEVER-ARRIVED-FOXTROT'));
    r?.querySelector('button.x')?.click();
  })()`);

  // Suppression: the SAME shape, but with text the transcript DOES hold, must
  // raise nothing — a false "undelivered" on every mid-turn reload would train
  // the user to ignore the one time it is true.
  // Anchored to a user message the CURRENT session's transcript genuinely
  // holds, read back from the server — not to a token this script assumes made
  // it there (an assumption that would make the check pass for the wrong reason
  // if delivery had failed).
  const sidNow = await cdp.eval(`window.__station.state.current.sessionId`);
  const dirNow = await cdp.eval(`window.__station.state.current.encodedDir`);
  const liveTexts = await readTranscript({ sid: sidNow, dir: dirNow });
  const delivered = liveTexts.filter((x) => x.startsWith('user:')).map((x) => x.slice(5))
    .flatMap((x) => x.split('\n').filter((l) => l.trim().length > 12 && !l.trim().startsWith('[')));
  if (!delivered.length) throw new Error('no delivered user text found in the transcript — the suppression check would prove nothing');
  const knownDelivered = delivered[delivered.length - 1].trim();
  console.log(`        (suppression anchor, read from the transcript: ${JSON.stringify(knownDelivered.slice(0, 60))})`);
  await cdp.eval(`(() => {
    const cap = ${JSON.stringify(captured)};
    const entry = JSON.parse(JSON.stringify(cap.entry));
    entry.rows = [];
    entry.outbox.texts = [${JSON.stringify(knownDelivered)}];
    const store = JSON.parse(localStorage.getItem(window.__station.QUEUE_KEY) ?? '{}');
    store[window.__station.draftKey(window.__station.state.current)] = entry;
    localStorage.setItem(window.__station.QUEUE_KEY, JSON.stringify(store));
  })()`);
  await reload(cdp, 'suppression');
  await cdp.waitFor('transcript painted', `document.querySelectorAll('#panes .you').length > 0`, 30_000);
  await sleep(4000); // the confirm is a fetch — give the WRONG answer time to appear
  const suppressed = await cdp.eval(DOCK);
  const supDiag = await cdp.eval(`({
    youBubbles: [...document.querySelectorAll('#panes .you')].length,
    lastYou: [...document.querySelectorAll('#panes .you')].slice(-3).map((n) => n.textContent.slice(0, 70)),
    ownerKey: window.__station.queueOwnerKey(),
  })`);
  check('a handed-off message that the transcript DOES contain raises no row at all (no crying wolf)',
    !suppressed.rows.some((r) => r.text.includes(knownDelivered)),
    JSON.stringify({ rows: suppressed.rows.map((r) => r.text.slice(0, 40)), ...supDiag }));

  /* ═══ 6. MUST-FAIL against a synthesized pre-fix client ═══ */
  console.log('\n=== 6. must-FAIL: the same actions against a synthesized PRE-FIX client ===');
  const preFix = preFixClient();
  check('the pre-fix client was constructed by a transform that matched exactly once per site (baseline is a variant, not HEAD)',
    preFix.includes('PRE-FIX: nothing is ever written') && preFix.includes('PRE-FIX: nothing is ever restored'),
    `${preFix.length} bytes, 2 sites neutered`);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/app.js*', requestStage: 'Request' }] });
  cdp.on.set('Fetch.requestPaused', (p) => {
    void cdp.send('Fetch.fulfillRequest', {
      requestId: p.requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'text/javascript' }, { name: 'cache-control', value: 'no-store' }],
      body: Buffer.from(preFix, 'utf8').toString('base64'),
    }).catch(() => {});
  });
  await cdp.eval(`localStorage.removeItem(window.__station.QUEUE_KEY)`);
  await reload(cdp, 'pre-fix client swap');
  await cdp.waitFor('pre-fix boot', `window.__station !== undefined && window.__station.persistQueue.toString().includes('PRE-FIX')`, 30_000);
  const G = 'Reply with exactly: PREFIX-GOLF';
  await cdp.eval(`window.__station.queueMessage(${JSON.stringify(G)})`);
  const preDock = await cdp.eval(DOCK);
  check('pre-fix: the message is accepted and shown in the dock, exactly as the user saw it live',
    preDock.rows.some((r) => r.text === G), JSON.stringify(preDock.rows.map((r) => r.text)));
  const preStored = await cdp.eval(`localStorage.getItem(window.__station.QUEUE_KEY)`);
  check('pre-fix: nothing is written anywhere — the text exists only in this tab (the defect)',
    !String(preStored ?? '').includes('PREFIX-GOLF'), String(preStored ?? '(nothing stored)').slice(0, 120));
  await reload(cdp, 'pre-fix');
  await cdp.waitFor('pre-fix transcript painted', `document.querySelectorAll('#panes .you').length > 0`, 30_000);
  await sleep(1000);
  const preAfter = await cdp.eval(DOCK);
  check('MUST-FAIL PROVED: pre-fix, the reload destroys the message — no row, no text, no signal',
    !preAfter.rows.some((r) => r.text.includes('PREFIX-GOLF')),
    JSON.stringify({ rows: preAfter.rows.map((r) => r.text), hidden: preAfter.hidden }));
  await cdp.send('Fetch.disable');
  cdp.on.delete('Fetch.requestPaused');

  console.log(`\nscreenshots: ${SHOTS}`);
  cdp.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exitCode = 1;
}).finally(() => {
  stopByPid(browser);
  stopByPid(server);
  setTimeout(() => {
    for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }, 2500);
});
