/**
 * FEAT-072 — a queued/batch-delivered user message arrives with a fixed
 * bracketed metadata prefix at position 0 ("[msg N/M · queued … ago, composed
 * while the previous response was still being written]" / "[Queued Ns ago,
 * composed while …]"). That boilerplate must be lifted OUT of the bubble into a
 * small, dimmed, distinct caption (its own line above the message), with the
 * user's actual words in a normal bubble below. Conservative: a real user
 * message that merely STARTS with "[" (a markdown link, code) must NOT be
 * captioned.
 *
 *   npm run verify:feat-072
 *
 * Sibling of BUG-067: same single choke point — renderMessages()'s user branch,
 * reached by BOTH the live-follow path (applyAppend) and the history/reload
 * path. We exercise BOTH and assert the split is identical.
 *
 * Must-FAIL pre-fix: on today's code the two queued lines render as `.you`
 * bubbles with the metadata prefix inline (0 `.qmeta` captions; the "[msg 1/2 …"
 * text sits inside the bubble). Post-fix: each queued line becomes a dim
 * `.qmeta` caption + a bubble holding ONLY the user's words; the markdown-link
 * message and the plain message stay whole bubbles with no caption.
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
const PORT = Number(process.env.VERIFY_FEAT_072_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f072-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f072-store-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f072-chrome-'));
const BRAVE = process.env.VERIFY_FEAT_072_BROWSER ?? 'brave';

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
// A user-role transcript spanning the full classification:
//   0: a real message that merely STARTS with "[" (markdown link) -> whole bubble, NO caption
//   1: a "[msg N/M · queued … ago, composed while …]" queued line -> caption + body bubble
//   2: a "[Queued Ns ago, composed while …]" queued variant       -> caption + body bubble
//   3: a plain real message                                        -> whole bubble, no caption
const BODY1 = 'Please refactor the login flow and add tests.';
const BODY2 = 'Also, can you update the changelog?';
const MDLINK = '[see the docs](https://example.com/docs) — start here before the refactor.';
const PLAIN = 'Thanks, that looks good to me.';
const FIXTURES = [
  { role: 'user', index: 0, blocks: [{ type: 'text', text: MDLINK }] },
  { role: 'user', index: 1, blocks: [{ type: 'text', text: `[msg 1/2 · queued 1m46s ago, composed while the previous response was still being written] ${BODY1}` }] },
  { role: 'user', index: 2, blocks: [{ type: 'text', text: `[Queued 5s ago, composed while the previous response was still being written — it predates your latest reply] ${BODY2}` }] },
  { role: 'user', index: 3, blocks: [{ type: 'text', text: PLAIN }] },
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

  // Classify a pane's direct children into bubbles vs qmeta captions, in DOM
  // order, and surface each bubble's text + each caption's text.
  const CLASSIFY = (paneSel) => `(() => {
    const pane = ${paneSel};
    if (!pane) return { error: 'no pane' };
    const kids = [...pane.children];
    const seq = kids.map((k) => k.classList.contains('you') ? 'bubble'
      : k.classList.contains('qmeta') ? 'qmeta'
      : null).filter(Boolean);
    const bubbles = kids.filter((k) => k.classList.contains('you'));
    const caps = kids.filter((k) => k.classList.contains('qmeta'));
    return {
      seq,
      bubbleCount: bubbles.length,
      capCount: caps.length,
      bubbleText: bubbles.map((b) => b.textContent.trim()),
      capText: caps.map((c) => c.textContent.trim()),
    };
  })()`;

  console.log('\n=== LIVE-FOLLOW path (applyAppend -> renderMessages) ===');
  const live = await cdp.eval(`(() => {
    const S = window.__station;
    S.state.threads.delete('main');
    document.querySelectorAll('#panes .pane[data-thread="main"]').forEach((p) => p.remove());
    S.state.live = false;
    S.state.current.sessionId = 'fixture-f072';
    S.state.current.encodedDir = null;
    S.applyAppend({ sessionId: 'fixture-f072', messages: ${JSON.stringify(FIXTURES)} });
    return { paneReady: !!document.querySelector('#panes .pane[data-thread="main"]') };
  })()`);
  if (!live.paneReady) throw new Error('main pane never materialised');
  const liveClass = await cdp.eval(CLASSIFY(`document.querySelector('#panes .pane[data-thread="main"]')`));
  runAssertions('live', liveClass);

  console.log('\n=== HISTORY path (renderMessages into a fresh pane) ===');
  const histClass = await cdp.eval(`(() => {
    const S = window.__station;
    if (typeof S.renderMessages !== 'function') return { unavailable: true };
    const pane = document.createElement('section');
    pane.className = 'pane';
    pane.dataset.thread = 'main';
    document.getElementById('panes').appendChild(pane);
    const th = { key: 'h', kind: 'main', paneEl: pane, claudeBody: null, stream: null, tools: new Map() };
    S.renderMessages(th, ${JSON.stringify(FIXTURES)});
    const kids = [...pane.children];
    const bubbles = kids.filter((k) => k.classList.contains('you'));
    const caps = kids.filter((k) => k.classList.contains('qmeta'));
    return {
      seq: kids.map((k) => k.classList.contains('you') ? 'bubble' : k.classList.contains('qmeta') ? 'qmeta' : null).filter(Boolean),
      bubbleCount: bubbles.length,
      capCount: caps.length,
      bubbleText: bubbles.map((b) => b.textContent.trim()),
      capText: caps.map((c) => c.textContent.trim()),
    };
  })()`);
  if (histClass.unavailable) {
    check('HISTORY path renderMessages is exposed', false, 'renderMessages not on window.__station');
  } else {
    runAssertions('history', histClass);
    check('the two render paths agree (identical bubble/qmeta split)',
      JSON.stringify(liveClass.seq) === JSON.stringify(histClass.seq),
      { live: liveClass.seq, history: histClass.seq });
  }

  // Unit-level conservatism check on the detector itself (post-fix only).
  const detector = await cdp.eval(`(() => {
    const q = window.__station.queuedCaption;
    if (typeof q !== 'function') return { unavailable: true };
    return {
      md: q(${JSON.stringify(MDLINK)}),
      code: q('[1, 2, 3] is a list literal at the start.'),
      queued: q(${JSON.stringify(FIXTURES[1].blocks[0].text)}),
    };
  })()`);
  if (detector.unavailable) {
    check('queuedCaption detector is exposed', false, 'not on window.__station');
  } else {
    check('detector does NOT match a markdown-link message', detector.md === null, detector.md);
    check('detector does NOT match a code/list-literal message', detector.code === null, detector.code);
    check('detector splits the queued prefix from the body', !!detector.queued && detector.queued.body === BODY1, detector.queued);
  }

  cdp.close();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

function runAssertions(tag, c) {
  check(`[${tag}] four user bubbles (markdown-link + two queued BODIES + plain)`, c.bubbleCount === 4, { bubbleCount: c.bubbleCount, text: c.bubbleText });
  check(`[${tag}] exactly the two queued lines produce dim captions (2)`, c.capCount === 2, { capCount: c.capCount, capText: c.capText });
  check(`[${tag}] render order is bubble, [qmeta,bubble], [qmeta,bubble], bubble`,
    JSON.stringify(c.seq) === JSON.stringify(['bubble', 'qmeta', 'bubble', 'qmeta', 'bubble', 'bubble']), c.seq);
  check(`[${tag}] queued body #1 is JUST the user's words (no "[msg" prefix in the bubble)`,
    c.bubbleText.includes(BODY1) && !c.bubbleText.some((t) => t.includes('[msg 1/2')), c.bubbleText);
  check(`[${tag}] queued body #2 is JUST the user's words (no "[Queued" prefix in the bubble)`,
    c.bubbleText.includes(BODY2) && !c.bubbleText.some((t) => t.includes('[Queued 5s')), c.bubbleText);
  check(`[${tag}] the caption carries the metadata (queued/composed), not the user's words`,
    c.capText.length === 2 && c.capText.every((t) => /queued|composed while the previous response/i.test(t)) && !c.capText.some((t) => t.includes(BODY1) || t.includes(BODY2)),
    c.capText);
  check(`[${tag}] the markdown-link message stayed a whole bubble (no false caption)`,
    c.bubbleText.some((t) => t.startsWith('[see the docs]')), c.bubbleText);
  check(`[${tag}] the plain message stayed a whole bubble`,
    c.bubbleText.includes(PLAIN), c.bubbleText);
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
