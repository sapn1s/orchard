/**
 * BUG-067 — harness-injected user-role lines (task-notification / [station]
 * briefing / <system-reminder> / SYSTEM NOTIFICATION) must render as compact,
 * collapsed STATION NOTICES, not as user bubbles that put a wall of XML in the
 * user's mouth. A real user message that merely QUOTES a sentinel mid-text must
 * stay a user bubble.
 *
 *   npm run verify:bug-067
 *
 * This drives a REAL browser (brave --headless=new over raw CDP; the same rig
 * verify:streaming-md uses) against a REAL server, then renders a FIXTURE
 * transcript through the app's own renderer and asserts on the resulting DOM.
 * No CLI turn is spawned — the fixtures ARE the transcript — so the run is fast,
 * free, and pollutes nothing.
 *
 * BOTH render paths converge on renderMessages(): applyAppend() (the live-follow
 * path) and the history/reload path both call it. We exercise BOTH — applyAppend
 * for the live path and a direct renderMessages() into a fresh pane for the
 * history path — and assert the split is identical.
 *
 * Must-FAIL pre-fix: on today's code all four fixture lines render as `.you`
 * bubbles (0 `.notice`). Post-fix: the real message + the mid-text quote are
 * bubbles; the task-notification + [station] lines are collapsed notices whose
 * summary parses the block's fields and whose disclosure holds the full payload.
 *
 * Process hygiene: OS-assigned free port (never 4317). Kill children by PID
 * only, never pkill.
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
const PORT = Number(process.env.VERIFY_BUG_067_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b067-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b067-store-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b067-chrome-'));
const BRAVE = process.env.VERIFY_BUG_067_BROWSER ?? 'brave';

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : (fail++, failures.push(name));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- raw CDP */
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
      try { if (await this.eval(expr)) return true; } catch { /* mid-navigation */ }
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

/* ------------------------------------------------------------- processes */
let server = null, browser = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

/* ------------------------------------------------------------- fixtures */
// A user-role transcript whose four entries span the full classification:
//   0: a real message the human typed            -> user bubble
//   1: a task-notification (with SYSTEM preamble) -> collapsed notice
//   2: a [station] "while you were away" briefing -> collapsed notice
//   3: a real message that QUOTES the sentinel    -> user bubble (conservative)
const FIXTURES = [
  { role: 'user', index: 0, blocks: [{ type: 'text', text: 'Please refactor the login flow when you get a chance.' }] },
  {
    role: 'user', index: 1, blocks: [{
      type: 'text',
      text: '[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>\n<task-id>bzx1dm6ow</task-id>\n<status>completed</status>\n<summary>Refactored the login flow and added tests</summary>\n</task-notification>',
    }],
  },
  { role: 'user', index: 2, blocks: [{ type: 'text', text: '[station] While you were away: 2 agent/turns ended since your last turn (1 event). status?' }] },
  { role: 'user', index: 3, blocks: [{ type: 'text', text: 'Why does a <task-notification> block appear in my transcript as if I sent it?' }] },
];

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  browser = spawn(BRAVE, [
    '--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--window-size=1280,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  if (!devPort) throw new Error('browser never wrote DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const pageT = targets.find((t) => t.type === 'page');
  const cdp = await Cdp.connect(pageT.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  const booted = await cdp.waitFor('app boot', 'window.__station && !!window.__station.applyAppend', 30_000);
  if (!booted) throw new Error('app never booted in the page');

  // Snapshot helper: classify the direct children of a pane into bubbles vs
  // notices, in DOM order, and surface each notice's one-liner + whether its
  // full payload is present behind the disclosure.
  const CLASSIFY = (paneSel) => `(() => {
    const pane = ${paneSel};
    if (!pane) return { error: 'no pane' };
    const kids = [...pane.children];
    const seq = kids.map((k) => k.classList.contains('you') ? 'bubble'
      : k.classList.contains('notice') ? 'notice'
      : k.tagName === 'DETAILS' && k.classList.contains('notice') ? 'notice'
      : null).filter(Boolean);
    const bubbles = kids.filter((k) => k.classList.contains('you'));
    const notices = kids.filter((k) => k.classList.contains('notice'));
    return {
      seq,
      bubbleCount: bubbles.length,
      noticeCount: notices.length,
      bubbleText: bubbles.map((b) => b.textContent.trim()),
      noticeOneLiners: notices.map((n) => n.querySelector('summary .nl')?.textContent ?? ''),
      noticeFull: notices.map((n) => n.querySelector('.notice-full')?.textContent ?? ''),
      noticeIsDetails: notices.every((n) => n.tagName === 'DETAILS'),
    };
  })()`;

  console.log('\n=== LIVE-FOLLOW path (applyAppend -> renderMessages) ===');
  const live = await cdp.eval(`(() => {
    const S = window.__station;
    // Fresh main pane: drop any existing thread so the fixture renders alone.
    // applyAppend() recreates the main thread internally, so this needs nothing
    // exposed beyond applyAppend — which is true on pre-fix code too, so the
    // must-FAIL assertions actually run there.
    S.state.threads.delete('main');
    document.querySelectorAll('#panes .pane[data-thread="main"]').forEach((p) => p.remove());
    // applyAppend only splices onto the session on screen — point state.current
    // at a fixture id and hand it a matching, unbridged append.
    S.state.live = false;
    S.state.current.sessionId = 'fixture-b067';
    S.state.current.encodedDir = null;
    S.applyAppend({ sessionId: 'fixture-b067', messages: ${JSON.stringify(FIXTURES)} });
    return { paneReady: !!document.querySelector('#panes .pane[data-thread="main"]') };
  })()`);
  if (!live.paneReady) throw new Error('main pane never materialised');
  const liveClass = await cdp.eval(CLASSIFY(`document.querySelector('#panes .pane[data-thread="main"]')`));

  runAssertions('live', liveClass);

  console.log('\n=== HISTORY path (renderMessages into a fresh pane) ===');
  const histClass = await cdp.eval(`(() => {
    const S = window.__station;
    if (typeof S.renderMessages !== 'function') return { unavailable: true };
    // Build a throwaway pane + thread just like newThread would, without
    // touching the main thread, and render the same fixtures through it.
    const pane = document.createElement('section');
    pane.className = 'pane';
    pane.dataset.thread = 'main';
    document.getElementById('panes').appendChild(pane);
    const th = { key: 'h', kind: 'main', paneEl: pane, claudeBody: null, stream: null, tools: new Map() };
    S.renderMessages(th, ${JSON.stringify(FIXTURES)});
    const kids = [...pane.children];
    const bubbles = kids.filter((k) => k.classList.contains('you'));
    const notices = kids.filter((k) => k.classList.contains('notice'));
    return {
      seq: kids.map((k) => k.classList.contains('you') ? 'bubble' : k.classList.contains('notice') ? 'notice' : null).filter(Boolean),
      bubbleCount: bubbles.length,
      noticeCount: notices.length,
      bubbleText: bubbles.map((b) => b.textContent.trim()),
      noticeOneLiners: notices.map((n) => n.querySelector('summary .nl')?.textContent ?? ''),
      noticeFull: notices.map((n) => n.querySelector('.notice-full')?.textContent ?? ''),
      noticeIsDetails: notices.every((n) => n.tagName === 'DETAILS'),
    };
  })()`);
  if (histClass.unavailable) {
    check('HISTORY path renderMessages is exposed (pre-fix it is not — expected FAIL before the fix)', false, 'renderMessages not on window.__station');
  } else {
    runAssertions('history', histClass);
    check('the two render paths agree (identical bubble/notice split)',
      JSON.stringify(liveClass.seq) === JSON.stringify(histClass.seq),
      { live: liveClass.seq, history: histClass.seq });
  }

  cdp.close();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

function runAssertions(tag, c) {
  check(`[${tag}] exactly the real messages are user bubbles (2)`, c.bubbleCount === 2, { bubbleCount: c.bubbleCount, text: c.bubbleText });
  check(`[${tag}] exactly the harness lines are notices (2)`, c.noticeCount === 2, { noticeCount: c.noticeCount });
  check(`[${tag}] the render order is bubble, notice, notice, bubble`,
    JSON.stringify(c.seq) === JSON.stringify(['bubble', 'notice', 'notice', 'bubble']), c.seq);
  check(`[${tag}] the mid-text QUOTE stayed a user bubble`,
    c.bubbleText.some((t) => t.includes('appear in my transcript')), c.bubbleText);
  check(`[${tag}] the real first message stayed a user bubble`,
    c.bubbleText.some((t) => t.includes('refactor the login flow when')), c.bubbleText);
  check(`[${tag}] the task-notification one-liner parsed summary + status`,
    c.noticeOneLiners.some((o) => o.includes('Refactored the login flow') && o.includes('completed')), c.noticeOneLiners);
  check(`[${tag}] the [station] briefing one-liner is compact (not raw)`,
    c.noticeOneLiners.some((o) => o.startsWith('⚙') && o.includes('While you were away')), c.noticeOneLiners);
  check(`[${tag}] each notice is collapsible <details> holding the full payload`,
    c.noticeIsDetails && c.noticeFull.some((f) => f.includes('<task-notification>')) && c.noticeFull.some((f) => f.includes('[station]')),
    { isDetails: c.noticeIsDetails, fullHasXml: c.noticeFull.map((f) => f.slice(0, 40)) });
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(() => {
  stopByPid(browser);
  stopByPid(server);
  setTimeout(() => {
    for (const d of [DATA, STORE, PROFILE]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
    process.exit(process.exitCode ?? 0);
  }, 1500);
});
