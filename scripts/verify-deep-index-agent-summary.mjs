/**
 * BUG-014 — a still-LIVE session, deep-linked/reloaded at an index OLDER than
 * the newest tail (a forward gap forms), must NOT splice the historical
 * "N agents ran in this session" summary into the live tail once the reader
 * scrolls down and pays off the gap. This is the same stale-summary-in-a-
 * live-session lie BUG-004 fixed for the direct-open path — same class, a
 * DIFFERENT code path: `openSession` queued `th.agentsPending = true` whenever
 * `th.gap` was set, even when the session was ALSO live, and `loadNewer`
 * unconditionally drained that queued flag into `loadRecordedAgents` once the
 * gap cleared, dumping the ran-stack at the live end.
 *
 *   node scripts/verify-deep-index-agent-summary.mjs      (no live model turn needed)
 *
 * Both fixtures are fully synthetic (a real jsonl the server reads normally,
 * built directly on disk — same technique as verify-agent-summary.mjs), padded
 * past TAIL_PAGE(200)+RESTORE_AFTER(40) messages so opening at index 0 forces
 * `openHistoryWindow` to record a real forward gap. "Live" is mtime recency
 * (the mtime half of `liveRecordFor`'s union — the same helper BUG-004
 * introduced; the bridge half is already covered by
 * verify-agent-summary-bridge.mjs and is not re-proven here).
 *
 *   1. LIVE case: gap paid off by scrolling → summary must NOT appear, and a
 *      further live append (simulating the streaming tail continuing) must
 *      land cleanly with no summary sneaking in alongside it.
 *   2. CONTROL: a genuinely CLOSED/historical session paying off the SAME
 *      kind of real gap must STILL show its recorded agents — the fix must
 *      not over-suppress the honest review-view case.
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
const PORT = Number(process.env.VERIFY_DIAS_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dias-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dias-chrome-'));
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
  /** Drive the "reader scrolls down, paying off the gap" repro: repeatedly
   *  scroll #scroll to its bottom and dispatch a scroll event (the real
   *  listener onScroll() → maybeLoadNewer() is what drains the gap), until
   *  #history's `hidden` flips true (gap cleared — see app.js paintComposerFor)
   *  or the timeout is hit. */
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

// TAIL_PAGE=200, RESTORE_AFTER=40 in app.js — pad well past both so opening
// at index 0 forces openHistoryWindow to record a real forward gap.
const PAD_PAIRS = 140; // 280 messages total

/** Build a session file padded past the tail window, plus one recorded
 *  sub-agent (so the summary WOULD render if this were treated as finished
 *  history) — same shape as verify-agent-summary.mjs's makeSessionWithAgent,
 *  scaled up to force a forward gap on a deep-index restore. */
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

/** Append one more turn (simulating the live stream continuing) and touch the
 *  mtime to now — the honest way to exercise file-follow without a real SDK
 *  turn (same technique used elsewhere for the "external, mtime-live" case). */
function appendLiveTurn(file, sid, marker) {
  const ts = new Date().toISOString();
  const line = JSON.stringify({ parentUuid: null, isSidechain: false, isMeta: false,
    type: 'assistant', uuid: uid(9999), timestamp: ts, sessionId: sid,
    message: { role: 'assistant', content: [{ type: 'text', text: marker }] } });
  fs.appendFileSync(file, line + '\n');
  execFileSync('touch', [file]);
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

  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dias-proj-'));
  cleanupDirs.push(projDir);
  const encoded = projDir.replace(/[/.]/g, '-');
  const store = path.join(os.homedir(), '.claude', 'projects', encoded);
  fs.mkdirSync(store, { recursive: true });
  cleanupDirs.push(store);

  const sidLive = 'cccccccc-3333-4333-8333-333333333333';
  const sidClosed = 'dddddddd-4444-4444-8444-444444444444';
  const fileLive = makeDeepSession(store, sidLive, 3600_000);
  const fileClosed = makeDeepSession(store, sidClosed, 3600_000);

  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: projDir, name: 'dias-fixture' }),
  })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`register failed: ${JSON.stringify(reg)}`);

  // Sanity: both fixtures really carry PAD_PAIRS*2 messages (> TAIL_PAGE+RESTORE_AFTER)
  // and the recorded sub-agent, BEFORE any browser interaction.
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

  const openAt = (sid, i) => cdp.send('Page.navigate', { url: `${BASE}/#/project/${pid}/session/${sid}?dir=${encodeURIComponent(encoded)}&i=${i}` });
  const HERE = `document.querySelector('#panes .pane.on .you, #panes .pane.on .claude') !== null`;

  console.log('\n=== LIVE session deep-opened at index 0 (forward gap forms) ===');
  // Live via the mtime half of liveRecordFor's union (see file header) — touch
  // to now right before opening, same technique as verify-agent-summary.mjs.
  execFileSync('touch', [fileLive]);
  await openAt(sidLive, 0);
  await cdp.waitFor('deep-index window rendered', HERE, 30_000);
  await sleep(500);
  const preGap = await cdp.eval(`({
    historyHidden: document.querySelector('#history')?.hidden,
    ranStacks: document.querySelectorAll('#panes .pane.on .ran-stack').length,
  })`);
  check('precondition: opening at index 0 recorded a real forward gap (#history bar showing)',
    preGap.historyHidden === false, JSON.stringify(preGap));
  check('sanity: no summary yet before the gap is paid off',
    preGap.ranStacks === 0, JSON.stringify(preGap));

  console.log('\n=== reader scrolls down, paying off the gap ===');
  const paidOff = await cdp.payOffGap(25_000);
  check('scrolling pays off the forward gap (#history bar hides)', paidOff,
    await cdp.eval(`document.querySelector('#history')?.hidden`));

  const afterPayoff = await cdp.eval(`({
    ranStacks: document.querySelectorAll('#panes .pane.on .ran-stack').length,
    followingExternal: window.__station.state.followingExternal,
  })`);
  check('LIVE session paying off a deep-index gap does NOT splice the historical "N agents ran" summary into the tail',
    afterPayoff.ranStacks === 0, JSON.stringify(afterPayoff));
  check('…and it is still framed as live (followingExternal stays true)',
    afterPayoff.followingExternal === true, JSON.stringify(afterPayoff));

  console.log('\n=== a further live append lands cleanly (no summary sneaks in alongside it) ===');
  appendLiveTurn(fileLive, sidLive, 'LIVE-APPEND-MARKER');
  const appended = await cdp.waitFor('live append arrives via file-follow',
    `[...document.querySelectorAll('#panes .pane.on .claude')].some((n) => n.textContent.includes('LIVE-APPEND-MARKER'))`, 15_000);
  const afterAppend = await cdp.eval(`({
    ranStacks: document.querySelectorAll('#panes .pane.on .ran-stack').length,
  })`);
  check('the live append after gap payoff renders (follow re-armed once the gap cleared)', appended,
    await cdp.eval(`[...document.querySelectorAll('#panes .pane.on .claude')].map((n) => n.textContent.slice(-40)).slice(-1)[0] ?? ''`));
  check('…and still no stray summary after the live append', afterAppend.ranStacks === 0, JSON.stringify(afterAppend));

  console.log('\n=== CONTROL: CLOSED/historical session paying off a real gap STILL shows recorded agents ===');
  // Deliberately left at its 1h-old mtime (no touch) — genuinely closed, not live.
  await openAt(sidClosed, 0);
  await cdp.waitFor('closed deep-index window rendered', HERE, 30_000);
  await sleep(500);
  const closedPaidOff = await cdp.payOffGap(25_000);
  check('CONTROL: scrolling pays off the closed session\'s gap too', closedPaidOff,
    await cdp.eval(`document.querySelector('#history')?.hidden`));
  const closedAfter = await cdp.eval(`({
    ranStacks: document.querySelectorAll('#panes .pane.on .ran-stack').length,
  })`);
  check('CONTROL: a genuinely CLOSED session paying off a real historical gap STILL shows its recorded agents (no over-suppression)',
    closedAfter.ranStacks > 0, JSON.stringify(closedAfter));

  try {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const outDir = path.join(ROOT, 'docs', 'bugs', 'assets');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'BUG-014-after.png'), Buffer.from(shot.data, 'base64'));
    console.log(`        screenshot → docs/bugs/assets/BUG-014-after.png`);
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
