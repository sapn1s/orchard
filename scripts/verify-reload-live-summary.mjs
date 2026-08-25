/**
 * BUG-017 — a LIVE session that owns its OWN bridge (`state.live` true — "our
 * own bridge already owns the tail") reloaded/opened at a DEEP scroll index
 * (a big transcript → a forward `gap` forms) still spliced the historical
 * "N agents ran in this session" summary INSTEAD of showing the conversation.
 *
 *   node scripts/verify-reload-live-summary.mjs      (no live model turn needed)
 *
 * Root cause: `liveRecordFor(sessionId)` (public/app.js) short-circuits
 * `if (!sessionId || state.live) return null;` — "our own bridge owns the
 * tail" — but `openSession`'s gap guard only excluded `liveRec`, not
 * `state.live` itself: `if (th.gap && !liveRec) th.agentsPending = true;`.
 * A `state.live` session got `liveRec = null` from the short-circuit, so
 * `!liveRec` read true and the historical summary got queued anyway — the
 * exact hole BUG-004/BUG-014 closed for the mtime/bridge-union case, reopened
 * for the `state.live` case. The fix ORs `state.live` into both the outer gate
 * (`th.gap || liveRec || state.live`) and the `agentsPending` guard
 * (`th.gap && !liveRec && !state.live`).
 *
 * Honest construction of "state.live is true when liveRecordFor runs":
 * `openSession()` is an async function that runs SYNCHRONOUSLY up to its first
 * `await` — including `closeSocket()` (which sets `state.live = false`) —
 * before it ever returns control to its caller. So calling
 * `window.__station.openSession(p, sess, {at: 0})` and, in the SAME tick
 * (before awaiting the returned promise), setting `state.live = true` lands
 * the flag exactly in the window between `closeSocket()` and the later
 * `await liveRecordFor(...)` call — deterministically reproducing the race a
 * real concurrent `connect()` (e.g. another in-flight `startTurn()` on this
 * same tab) would create, without depending on real network timing.
 * `openSession` is exposed on `window.__station` for exactly this purpose
 * (see the BUG-017 comment at its export site).
 *
 * Fixtures: same technique as verify-deep-index-agent-summary.mjs (BUG-014) —
 * fully synthetic sessions padded past TAIL_PAGE(200)+RESTORE_AFTER(40) so
 * opening at index 0 forces a real forward gap, each with one recorded
 * sub-agent so the summary WOULD render if this were treated as history.
 *
 *   1. SELF-OWNED-LIVE case: `state.live` forced true during the open →
 *      the CONVERSATION renders; the "N agents ran" summary must NOT be
 *      spliced in as a replacement, even after the gap is paid off.
 *   2. CONTROL: a genuinely finished session (no bridge, stale file,
 *      `state.live` left false) opened the SAME way STILL shows the summary
 *      — the fix must not over-suppress the honest review-view case.
 */
import { spawn, execFileSync } from 'node:child_process';
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
const PORT = Number(process.env.VERIFY_RLS_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rls-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rls-chrome-'));
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
  async waitFor(label, expr, timeoutMs = 20_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.eval(expr)) return true; } catch { /* nav */ }
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  async payOffGap(timeoutMs = 20_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const hidden = await this.eval(`(() => {
        const s = document.querySelector('#scroll');
        if (s) { s.scrollTop = s.scrollHeight; s.dispatchEvent(new Event('scroll')); }
        return document.querySelector('#history')?.hidden !== false;
      })()`);
      if (hidden) return true;
      await sleep(300);
    }
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

const uid = (n) => `00000000-0000-4000-e000-${String(n).padStart(12, '0')}`;
const PAD_PAIRS = 140; // 280 messages total — past TAIL_PAGE(200)+RESTORE_AFTER(40)

function makeDeepSession(store, sid, ageMs) {
  const base = Date.now() - ageMs;
  const lines = [];
  for (let i = 0; i < PAD_PAIRS; i++) {
    const ts = new Date(base + i * 1000).toISOString();
    lines.push(JSON.stringify({ parentUuid: i === 0 ? null : uid(2 * i), isSidechain: false, isMeta: false,
      type: 'user', uuid: uid(2 * i + 1), timestamp: ts, sessionId: sid,
      message: { role: 'user', content: [{ type: 'text', text: `pad user turn ${i}` }] } }));
    lines.push(JSON.stringify({ parentUuid: uid(2 * i + 1), isSidechain: false, isMeta: false,
      type: 'assistant', uuid: uid(2 * i + 2), timestamp: ts, sessionId: sid,
      message: { role: 'assistant', content: [{ type: 'text', text: `pad assistant turn ${i}` }] } }));
  }
  const f = path.join(store, `${sid}.jsonl`);
  fs.writeFileSync(f, lines.join('\n') + '\n');
  const agDir = path.join(store, sid, 'subagents');
  fs.mkdirSync(agDir, { recursive: true });
  fs.writeFileSync(path.join(agDir, 'agent-abc123.jsonl'),
    JSON.stringify({ isSidechain: true, agentId: 'abc123', type: 'assistant', timestamp: new Date(base).toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: 'sub-agent output' }], usage: { output_tokens: 5 } } }) + '\n');
  fs.writeFileSync(path.join(agDir, 'agent-abc123.meta.json'),
    JSON.stringify({ agentType: 'general-purpose', description: 'Fix stale example-app permissionMode', toolUseId: 'tu-x' }));
  execFileSync('touch', ['-d', new Date(base).toISOString(), f]);
  return f;
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

  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rls-proj-'));
  cleanupDirs.push(projDir);
  const encoded = projDir.replace(/[/.]/g, '-');
  const store = path.join(os.homedir(), '.claude', 'projects', encoded);
  fs.mkdirSync(store, { recursive: true });
  cleanupDirs.push(store);

  const sidLive = 'eeeeeeee-5555-4555-8555-555555555555';
  const sidClosed = 'ffffffff-6666-4666-8666-666666666666';
  makeDeepSession(store, sidLive, 3600_000); // mtime irrelevant here: liveness is forced via state.live, not mtime/bridge
  makeDeepSession(store, sidClosed, 3600_000);

  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: projDir, name: 'rls-fixture' }),
  })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`register failed: ${JSON.stringify(reg)}`);

  const tLive = await (await fetch(`${BASE}/api/transcript/${encodeURIComponent(encoded)}/${sidLive}?tail=1`)).json();
  check('fixture: LIVE session is padded well past TAIL_PAGE+RESTORE_AFTER (forces a real forward gap)',
    (tLive.total ?? 0) >= 2 * PAD_PAIRS, `total: ${tLive.total}`);
  const subsLive = await (await fetch(`${BASE}/api/sessions/${sidLive}/subagents?dir=${encodeURIComponent(encoded)}`)).json();
  check('fixture: LIVE session reports the injected recorded sub-agent (so a summary CAN render)',
    Array.isArray(subsLive.subagents) && subsLive.subagents.length === 1, JSON.stringify(subsLive).slice(0, 160));

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');

  await cdp.send('Page.navigate', { url: `${BASE}/#/project/${pid}` });
  await cdp.waitFor('boot', `window.__station !== undefined`);
  await cdp.waitFor('project selected', `window.__station.state.current.projectId === '${pid}'`);
  await sleep(500);

  const HERE = `document.querySelector('#panes .pane.on .you, #panes .pane.on .claude') !== null`;

  console.log('\n=== SELF-OWNED-LIVE: state.live forced true DURING openSession(at:0) (deep-index gap) ===');
  const openLive = await cdp.eval(`(() => {
    const st = window.__station;
    const p = st.state.projects.find((x) => x.id === '${pid}');
    const sess = { encodedDir: '${encoded}', sessionId: '${sidLive}', title: null, os: null };
    // openSession() runs synchronously up to its first \`await\` (closeSocket()
    // included) before returning — so state.live is already false again by
    // the time this call returns a pending promise. Force it back to true
    // right here: this lands DURING the pending transcript/gap fetches,
    // exactly where a real concurrent connect() would race in.
    const pr = st.openSession(p, sess, { at: 0 });
    st.state.live = true;
    window.__rlsPromise = pr;
    return true;
  })()`);
  check('drove openSession() for the LIVE fixture at a deep index', openLive === true, openLive);
  await cdp.eval(`window.__rlsPromise`); // wait for openSession to settle
  await cdp.waitFor('deep-index window rendered', HERE, 30_000);
  await sleep(500);

  const preGap = await cdp.eval(`({
    historyHidden: document.querySelector('#history')?.hidden,
    ranStacks: document.querySelectorAll('#panes .pane.on .ran-stack').length,
    live: window.__station.state.live,
  })`);
  check('precondition: opening at index 0 recorded a real forward gap (#history bar showing)',
    preGap.historyHidden === false, JSON.stringify(preGap));
  check('precondition: state.live really was true across the open (the exact BUG-017 condition)',
    preGap.live === true, JSON.stringify(preGap));
  check('sanity: no summary yet before the gap is paid off',
    preGap.ranStacks === 0, JSON.stringify(preGap));

  console.log('\n=== reader scrolls down, paying off the gap ===');
  const paidOff = await cdp.payOffGap(25_000);
  check('scrolling pays off the forward gap (#history bar hides)', paidOff,
    await cdp.eval(`document.querySelector('#history')?.hidden`));

  const afterPayoff = await cdp.eval(`({
    ranStacks: document.querySelectorAll('#panes .pane.on .ran-stack').length,
    convoVisible: ${HERE},
  })`);
  check('THE FIX: a self-owned LIVE session paying off a deep-index gap does NOT splice the historical "N agents ran" summary — the CONVERSATION renders instead',
    afterPayoff.ranStacks === 0 && afterPayoff.convoVisible === true, JSON.stringify(afterPayoff));

  console.log('\n=== CONTROL: genuinely CLOSED session (state.live left false) paying off the SAME kind of gap STILL shows recorded agents ===');
  await cdp.eval(`(window.__station.state.live = false)`);
  await cdp.send('Page.navigate', { url: `${BASE}/#/project/${pid}/session/${sidClosed}?dir=${encodeURIComponent(encoded)}&i=0` });
  await cdp.waitFor('closed deep-index window rendered', HERE, 30_000);
  await sleep(500);
  const closedPaidOff = await cdp.payOffGap(25_000);
  check('CONTROL: scrolling pays off the closed session\'s gap too', closedPaidOff,
    await cdp.eval(`document.querySelector('#history')?.hidden`));
  const closedAfter = await cdp.eval(`({
    ranStacks: document.querySelectorAll('#panes .pane.on .ran-stack').length,
    live: window.__station.state.live,
  })`);
  check('CONTROL: a genuinely CLOSED session (state.live false, no bridge, stale file) STILL shows its recorded agents (no over-suppression)',
    closedAfter.ranStacks > 0 && closedAfter.live === false, JSON.stringify(closedAfter));

  try {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const outDir = path.join(ROOT, 'docs', 'bugs', 'assets');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'BUG-017-after.png'), Buffer.from(shot.data, 'base64'));
    console.log(`        screenshot → docs/bugs/assets/BUG-017-after.png`);
  } catch (e) { console.log(`        (screenshot failed: ${e.message})`); }

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
