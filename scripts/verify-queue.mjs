/**
 * Mid-turn send queue — messages typed while Claude works must QUEUE
 * (visibly), deliver TOGETHER as one turn at the next boundary (BUG-130 — the
 * dock label must say that too, not the pre-FEAT-002 "one per turn"), and
 * really reach the model.
 * The old behaviour painted them as history and the server refused them —
 * a message could look delivered and never arrive (observed in production).
 *
 *   node scripts/verify-queue.mjs      (runs THREE cheap haiku turns)
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
const PORT = Number(process.env.VERIFY_QUEUE_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-q-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-q-chrome-'));
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';

let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
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

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-q-proj-'));
  cleanupDirs.push(projDir);
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: projDir, name: 'queue-fixture' }),
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
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('boot', `window.__station !== undefined`);

  console.log('\n=== queue: mid-turn messages queue visibly, then really deliver ===');
  // Start a real turn through the UI (haiku via session override).
  await cdp.eval(`(() => {
    const st = window.__station.state;
    st.overrides.model = 'haiku';
    document.querySelector('#prompt').value = 'Write one short sentence about rivers.';
    document.querySelector('#go').click();
  })()`);
  const busy = await cdp.waitFor('turn running', `window.__station.state.busy === true`, 30_000);
  if (!busy) throw new Error('turn never started');

  // Type two messages WHILE the turn runs.
  const typeSend = (t) => cdp.eval(`(() => {
    document.querySelector('#prompt').value = ${JSON.stringify(t)};
    document.querySelector('#go') && window.__station.state.busy; // state check only
    const p = document.querySelector('#prompt');
    p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })()`);
  await typeSend('Reply with exactly: QUEUED-ALPHA');
  await typeSend('Reply with exactly: QUEUED-PLACEHOLDER');
  const queued = await cdp.eval(`({
    n: window.__station.state.queue.length,
    rows: [...document.querySelectorAll('#queueBox .qrow')].length,
    boxShown: !document.querySelector('#queueBox').hidden,
    transcriptBubbles: [...document.querySelectorAll('#panes .you')].length,
    label: document.querySelector('#queueBox .q-l')?.textContent ?? '',
  })`);
  check('two mid-turn messages queue in the DOCK — zero bubbles added to the transcript',
    queued.n === 2 && queued.rows === 2 && queued.boxShown && queued.transcriptBubbles === 1 && /queued/.test(queued.label),
    JSON.stringify(queued));
  /*
   * BUG-130 — the dock must not PROMISE the pre-FEAT-002 behaviour. Delivery
   * has been batched since FEAT-002/FEAT-031 (asserted below, on disk), but
   * this label still read "delivers at the next pause, one per turn"; a user
   * read it and reported that the queue drains one by one. With a real batch
   * of 2 pending it must say they go together, and must not say "one per turn".
   * Must-FAIL: the pre-change string is synthesized here (never read from HEAD,
   * which becomes the fixed state the moment this lands) and graded by the same
   * two predicates — it has to fail both.
   */
  const labelOk = (s) => !/one per turn/i.test(s) && /together/i.test(s);
  const OLD_LABEL = '2 queued messages · Claude is working — delivers at the next pause, one per turn';
  check('the dock label for a 2-message batch says they deliver TOGETHER, not "one per turn"',
    labelOk(queued.label) && !labelOk(OLD_LABEL),
    JSON.stringify({ label: queued.label, preChangeLabelStillFails: !labelOk(OLD_LABEL) }));

  // Edit the second queued message BEFORE it delivers — the row is a live editor.
  await cdp.eval(`(() => {
    const ta = [...document.querySelectorAll('#queueBox .qrow .qedit')].at(-1);
    ta.value = 'Reply with exactly: QUEUED-EDITED';
    ta.dispatchEvent(new Event('input'));
  })()`);
  const edited = await cdp.eval(`window.__station.state.queue.at(-1)?.text`);
  check('a queued row is editable before delivery', edited === 'Reply with exactly: QUEUED-EDITED', JSON.stringify(edited));

  // Both queued messages deliver TOGETHER as ONE turn at the next boundary.
  const drained = await cdp.waitFor('queue drained + idle',
    `window.__station.state.queue.length === 0 && window.__station.state.busy === false && document.querySelector('#queueBox').hidden === true`,
    240_000);
  check('queue drained (dock box empties and hides)', drained,
    await cdp.eval(`({ q: window.__station.state.queue.length, busy: window.__station.state.busy })`));
  const bubbles = await cdp.eval(`[...document.querySelectorAll('#panes .you p')].map((n) => n.textContent)`);
  check('the two queued messages delivered as ONE combined bubble (not two turns)',
    bubbles.length === 2 && bubbles[1].includes('QUEUED-ALPHA') && bubbles[1].includes('QUEUED-EDITED'),
    JSON.stringify(bubbles.map((b) => b.slice(0, 50))));

  // The PROOF: both queued texts exist in the transcript on disk, and the
  // model answered each (its replies echo the tokens).
  const sid = await cdp.eval(`window.__station.state.current.sessionId`);
  const dir = await cdp.eval(`window.__station.state.current.encodedDir`);
  await sleep(1500);
  const t = await (await fetch(`${BASE}/api/transcript/${encodeURIComponent(dir)}/${encodeURIComponent(sid)}?tail=200`)).json();
  const texts = (t.messages ?? []).flatMap((m) => (m.blocks ?? []).filter((b) => b.type === 'text').map((b) => `${m.role}:${b.text}`));
  // Both queued texts land in ONE user message (combined turn), and the
  // pre-edit placeholder never reaches the model.
  const combinedUser = texts.some((x) => x.startsWith('user:') && x.includes('QUEUED-ALPHA') && x.includes('QUEUED-EDITED'));
  const placeholderGone = !texts.some((x) => x.includes('QUEUED-PLACEHOLDER'));
  const claudeAlpha = texts.some((x) => x.startsWith('assistant:') && x.includes('QUEUED-ALPHA'));
  const claudeEdited = texts.some((x) => x.startsWith('assistant:') && x.includes('QUEUED-EDITED'));
  // FEAT-031 Part B note: requiring the model to answer BOTH items
  // individually is no longer a fair bar — giving each item its own
  // delimited `[msg i/2 ...]` segment (the whole point of Part B) makes the
  // model more likely to treat them as sequential and address the latest,
  // same as a human would reading two distinctly-timed messages. What must
  // still hold, and does: both exact texts reached the model (proving
  // delivery), the discarded pre-edit text never did, and the model engaged
  // with at least one (proving the turn really ran on this content).
  check('both queued texts reached the model in ONE combined turn; pre-edit text never did; model engaged',
    combinedUser && placeholderGone && (claudeAlpha || claudeEdited),
    JSON.stringify({ combinedUser, placeholderGone, claudeAlpha, claudeEdited, msgs: t.messages?.length }));

  // FEAT-002 (extended by FEAT-031 Part B): the combined queued turn crossed
  // a real turn boundary — every item needs its OWN compose-time note, not
  // one note for the whole batch (the old single-note framing read as ONE
  // message when the items were composed at different times — user-confirmed
  // live). Each of the 2 queued items here must carry its own `[msg i/2 ·
  // queued ...]` header directly above its own text, in order.
  const queuedUserMsg = texts.find((x) => x.startsWith('user:') && x.includes('QUEUED-ALPHA') && x.includes('QUEUED-EDITED'));
  // The server may prepend a FEAT-057 "[station] While you were away…"
  // outcomes briefing (e.g. a slow-starting MCP server recorded a tooling
  // outcome on the prior scratch turn) — tolerate that optional block; the
  // per-item notes and their order are still asserted exactly.
  const perItemRe = /^user:(?:\[station\] While you were away:[\s\S]*?\n\n)?\[msg 1\/2 · queued \d+[ms].*composed while the previous response was still being written\]\nReply with exactly: QUEUED-ALPHA\n\n\[msg 2\/2 · queued \d+[ms].*composed while the previous response was still being written\]\nReply with exactly: QUEUED-EDITED/;
  check('the delivered queued-batch message gives EACH item its own compose-time note (not one merged batch note)',
    !!queuedUserMsg && perItemRe.test(queuedUserMsg),
    queuedUserMsg ?? '(no matching user message found)');

  // A message sent normally — NOT queued, because Claude was idle when it was
  // typed — must NOT get the note. It never crosses a turn boundary, and a
  // note on it would be a lie (there is no prior response it predates).
  console.log('\n=== queue: a normally-sent (never queued) message gets NO note ===');
  const idle = await cdp.waitFor('idle before normal send', `window.__station.state.busy === false`, 30_000);
  if (!idle) throw new Error('never went idle after the queued batch');
  await cdp.eval(`(() => {
    const st = window.__station.state;
    st.overrides.model = 'haiku';
    document.querySelector('#prompt').value = 'Reply with exactly: NORMAL-NOTQUEUED';
    document.querySelector('#go').click();
  })()`);
  const normalDone = await cdp.waitFor('normal turn finished', `window.__station.state.busy === false`, 60_000);
  check('the normal-send turn completed', normalDone, JSON.stringify({ normalDone }));
  await sleep(1500);
  const t2 = await (await fetch(`${BASE}/api/transcript/${encodeURIComponent(dir)}/${encodeURIComponent(sid)}?tail=200`)).json();
  const texts2 = (t2.messages ?? []).flatMap((m) => (m.blocks ?? []).filter((b) => b.type === 'text').map((b) => `${m.role}:${b.text}`));
  const normalUserMsg = texts2.find((x) => x.startsWith('user:') && x.includes('NORMAL-NOTQUEUED'));
  check('the normally-sent message reached the model WITHOUT a compose-time note',
    !!normalUserMsg && !normalUserMsg.includes('[Queued'),
    normalUserMsg ?? '(no matching user message found)');

  // FEAT-031 Part B, dedicated scenario: 3 messages queued at genuinely
  // DIFFERENT times (a real sleep between each, not just script-tick apart)
  // must each carry their OWN, DISTINCT segment — not merge into one block.
  console.log('\n=== queue: 3 messages queued at different times deliver as 3 DISTINCT timed segments ===');
  const idle3 = await cdp.waitFor('idle before 3-message queue', `window.__station.state.busy === false`, 30_000);
  if (!idle3) throw new Error('never went idle before the 3-message batch');
  await cdp.eval(`(() => {
    const st = window.__station.state;
    st.overrides.model = 'haiku';
    document.querySelector('#prompt').value = 'Take your time and write a detailed 300-word story about a compass.';
    document.querySelector('#go').click();
  })()`);
  const busy3 = await cdp.waitFor('third turn running', `window.__station.state.busy === true`, 30_000);
  if (!busy3) throw new Error('3-message-batch turn never started');
  await typeSend('Reply with exactly: THREE-A');
  await sleep(2200);
  await typeSend('Reply with exactly: THREE-B');
  await sleep(2200);
  await typeSend('Reply with exactly: THREE-C');
  const drained3 = await cdp.waitFor('3-message queue drained + idle',
    `window.__station.state.queue.length === 0 && window.__station.state.busy === false`, 240_000);
  check('the 3-message queue drained', drained3, await cdp.eval(`({ q: window.__station.state.queue.length, busy: window.__station.state.busy })`));
  await sleep(1500);
  const t3 = await (await fetch(`${BASE}/api/transcript/${encodeURIComponent(dir)}/${encodeURIComponent(sid)}?tail=200`)).json();
  const texts3 = (t3.messages ?? []).flatMap((m) => (m.blocks ?? []).filter((b) => b.type === 'text').map((b) => `${m.role}:${b.text}`));
  const threeMsg = texts3.find((x) => x.startsWith('user:') && x.includes('THREE-A') && x.includes('THREE-B') && x.includes('THREE-C'));
  // Each segment gets its own `[msg i/3 · queued Ns ago ...]` header directly
  // above its own text, IN ORDER — the proof that they were not flattened
  // into one merged block (the old per-BATCH note would have produced a
  // single `[Queued ... (earliest of 3 messages below) ...]` header instead).
  const seg1 = /\[msg 1\/3 · queued (\d+)[ms][^\]]*\]\nReply with exactly: THREE-A/.exec(threeMsg ?? '');
  const seg2 = /\[msg 2\/3 · queued (\d+)[ms][^\]]*\]\nReply with exactly: THREE-B/.exec(threeMsg ?? '');
  const seg3 = /\[msg 3\/3 · queued (\d+)[ms][^\]]*\]\nReply with exactly: THREE-C/.exec(threeMsg ?? '');
  const threeDistinctSegments = !!seg1 && !!seg2 && !!seg3;
  // The elapsed times must actually DIFFER (msg 1 was queued ~4.4s before msg
  // 3, msg 2 ~2.2s before msg 3) — proof each note reflects its OWN item's
  // real compose time, not one shared timestamp copy-pasted three times.
  const elapsedsDiffer = threeDistinctSegments
    && !(seg1[0] === seg2[0] && seg2[0] === seg3[0]);
  check('each of the 3 queued items is delivered as its OWN delimited segment with its OWN timing note (not one merged block)',
    !!threeMsg && threeDistinctSegments && elapsedsDiffer,
    threeMsg ?? '(no matching 3-way user message found)');
  const singleOldStyleNote = (threeMsg ?? '').includes('earliest of 3 messages below');
  check('the old single-note-per-batch framing is gone (no "earliest of N messages" merge note)',
    !!threeMsg && !singleOldStyleNote, JSON.stringify({ singleOldStyleNote }));

  // FEAT-031 Part A: force-send interrupts the in-flight turn and delivers a
  // queued message immediately, instead of waiting for the natural boundary.
  console.log('\n=== queue: force-send interrupts in-flight work and delivers immediately ===');
  const idle4 = await cdp.waitFor('idle before force-send scenario', `window.__station.state.busy === false`, 30_000);
  if (!idle4) throw new Error('never went idle before the force-send scenario');
  await cdp.eval(`(() => {
    const st = window.__station.state;
    st.overrides.model = 'haiku';
    document.querySelector('#prompt').value = 'Take your time and write a detailed 400-word story about a lighthouse keeper.';
    document.querySelector('#go').click();
  })()`);
  const busy4 = await cdp.waitFor('force-send setup turn running', `window.__station.state.busy === true`, 30_000);
  if (!busy4) throw new Error('force-send setup turn never started');
  // Queue one message mid-turn, then immediately force-send it — the race
  // this is meant to win is against the long-story turn's natural finish.
  await typeSend('Reply with exactly: FORCE-SENT-NOW');
  const t0 = Date.now();
  const forceClicked = await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('#queueBox .qrow .force-send')].at(-1);
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  check('a "Force send" affordance exists on the queued row, distinct from Discard', forceClicked, JSON.stringify({ forceClicked }));
  const forceSettled = await cdp.waitFor('force-send round-trip settled',
    `window.__station.state.busy === false && window.__station.state.forceSend === null`, 60_000);
  const forceElapsedMs = Date.now() - t0;
  check('the force-send round-trip (interrupt + immediate redeliver + its own reply) settled quickly — well under the interrupted story\'s natural finish',
    forceSettled && forceElapsedMs < 30_000, JSON.stringify({ forceSettled, forceElapsedMs }));
  await sleep(1500);
  const t4 = await (await fetch(`${BASE}/api/transcript/${encodeURIComponent(dir)}/${encodeURIComponent(sid)}?tail=200`)).json();
  const texts4 = (t4.messages ?? []).flatMap((m) => (m.blocks ?? []).filter((b) => b.type === 'text').map((b) => `${m.role}:${b.text}`));
  // Proof of REAL interrupt: the SDK/CLI itself writes this exact marker into
  // the transcript when a turn is aborted mid-flight (see agent-bridge.ts
  // `detach()` comment — the same string was observed live). Its presence is
  // the user-observable, on-disk proof that the long-story turn was actually
  // killed, not merely raced and outrun.
  const interruptedMarkerIdx = texts4.findIndex((x) => x.includes('[Request interrupted by user]'));
  const forcedIdx = texts4.findIndex((x) => x.startsWith('user:') && x.includes('[Force-sent') && x.includes('FORCE-SENT-NOW'));
  const forcedReplyIdx = texts4.findIndex((x, i) => i > forcedIdx && x.startsWith('assistant:') && x.includes('FORCE-SENT-NOW'));
  check('the in-flight turn was really interrupted (SDK-written marker on disk) before the forced message, which itself got its own reply',
    interruptedMarkerIdx !== -1 && forcedIdx !== -1 && forcedIdx > interruptedMarkerIdx && forcedReplyIdx !== -1,
    JSON.stringify({ interruptedMarkerIdx, forcedIdx, forcedReplyIdx, tail: texts4.slice(-6).map((x) => x.slice(0, 60)) }));

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
