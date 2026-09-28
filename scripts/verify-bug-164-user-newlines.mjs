/**
 * BUG-164 — a user's own typed message must render with the line breaks they
 * typed (single newlines, blank-line paragraph gaps, the leading indentation of
 * a pasted block) while long lines still wrap inside the bubble, and while the
 * text is rendered as PLAIN TEXT (never interpreted as HTML/markdown).
 *
 * This drives the REAL reload render path — renderMessages() -> youBubble() ->
 * the real `.you p` CSS in public/styles.css — in a REAL headless browser over a
 * REALISTIC multi-line transcript (the user's reality on reload, which is the
 * complaint: "Same after a reload"). The measured RENDERED property IS the proof
 * (WA §N, contained-render class): computed white-space, per-line client rects
 * (a Range over the text gives one rect per visual line box), horizontal overflow
 * (scrollWidth vs clientWidth), and the DOM child shape (no injected elements).
 *
 * MUST-FAIL BASELINE — NOT the committed CSS (a CSS fix committed to HEAD would
 * make the proof pass trivially forever; docs/CONVENTIONS.md). The pre-change
 * baseline is SYNTHESIZED in-page by overriding `.you p` back to the browser
 * default `white-space: normal` (the exact defect state), rendering the SAME
 * transcript through it, and asserting the breaks collapse. If the assertions
 * are non-vacuous they must fail there and pass on the real rule.
 *
 *   node scripts/verify-bug-164-user-newlines.mjs
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
const PORT = Number(process.env.VERIFY_BUG164_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-164-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-164-store-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-164-chrome-'));
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
      await sleep(120);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

let server = null, browser = null;
const cleanupDirs = [DATA, STORE, PROFILE];
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

const encodeCwd = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

// BREAKS fixture: the realistic multi-line note a user types/pastes — three
// single-newline lines, a blank-line paragraph gap, a pasted block with LEADING
// INDENTATION, and a line of HTML/markdown characters that must render LITERALLY
// (never be interpreted as markup). Deliberately has NO very-long token, so that
// under the collapsing default (`white-space: normal`) it genuinely flattens to
// a short blob — the must-FAIL discriminator is not confounded by wrap.
const BREAKS_TEXT = [
  'first line',
  'second line',
  'third line',
  '',
  'after a blank-line gap',
  '    indented pasted line',
  '        deeper indent',
  'a <b>bold</b> tag and **md** <img src=x onerror=alert(1)>',
].join('\n');

// LONG fixture: a single very long unbroken token (a pasted URL / log line) that
// must WRAP inside the bubble rather than overflow it horizontally.
const LONG_TEXT = 'https://example.test/' + 'x'.repeat(400);

/**
 * Render the fixture transcript through the REAL reload path into a laid-out pane
 * and measure the rendered `.you p`. `whiteSpaceOverride` (when set) synthesizes
 * the pre-change baseline by forcing the default collapse rule back onto `.you p`.
 */
function renderExpr(text, whiteSpaceOverride) {
  return `(() => {
    const S = window.__station;
    if (typeof S.renderMessages !== 'function') return { unavailable: true };
    document.getElementById('ovr-164')?.remove();
    ${whiteSpaceOverride ? `{
      const st = document.createElement('style');
      st.id = 'ovr-164';
      st.textContent = '.you p { white-space: ${whiteSpaceOverride} !important; }';
      document.head.appendChild(st);
    }` : ''}
    const panes = document.getElementById('panes');
    panes.querySelectorAll('.pane[data-thread="h164"]').forEach((p) => p.remove());
    const pane = document.createElement('section');
    pane.className = 'pane on';
    pane.dataset.thread = 'h164';
    panes.appendChild(pane);
    const th = { key: 'h164', kind: 'main', paneEl: pane, claudeBody: null, stream: null, tools: new Map() };
    S.renderMessages(th, [{ role: 'user', index: 0, uuid: 'u164',
      blocks: [{ type: 'text', text: ${JSON.stringify(text)} }] }]);
    const bubble = pane.querySelector('.you');
    const p = bubble && bubble.querySelector('p');
    if (!p) return { noBubble: true };

    const cs = getComputedStyle(p);
    const lineHeight = parseFloat(cs.lineHeight);
    // A Range over the paragraph's contents yields one client rect per visual
    // line box: the true count of lines the browser painted.
    const range = document.createRange();
    range.selectNodeContents(p);
    const rects = [...range.getClientRects()].map((r) => ({ left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width) }));
    // Distinct top offsets = distinct visual lines (blank lines contribute a gap
    // between rects rather than a zero-height rect, so also measure total height).
    const tops = [...new Set(rects.map((r) => r.top))].sort((a, b) => a - b);

    // Indentation: find the two consecutive lines "third line" then (after the
    // gap) the indented block. Compare the left edge of an indented line to a
    // non-indented one on the SAME wrap. We locate by scanning line rects: the
    // first rect is line 1's left (the base text left).
    const baseLeft = rects.length ? Math.min(...rects.map((r) => r.left)) : 0;
    const maxLeft = rects.length ? Math.max(...rects.map((r) => r.left)) : 0;

    const pRect = p.getBoundingClientRect();
    return {
      whiteSpace: cs.whiteSpace,
      overflowWrap: cs.overflowWrap || cs.wordWrap,
      lineHeight,
      height: Math.round(pRect.height),
      approxLines: Math.round(pRect.height / lineHeight),
      lineCount: rects.length,
      distinctTops: tops.length,
      baseLeft, maxLeft, indentPx: maxLeft - baseLeft,
      scrollWidth: p.scrollWidth,
      clientWidth: p.clientWidth,
      overflowX: p.scrollWidth - p.clientWidth,
      // Injection guard: no element children may be produced from user text.
      childElementCount: p.childElementCount,
      hasScriptOrImg: !!p.querySelector('script,img,b'),
      textPreserved: p.textContent === ${JSON.stringify(text)},
    };
  })()`;
}

function assertRendered(tag, r) {
  check(`[${tag}] the user bubble renders (renderMessages -> youBubble -> .you p)`,
    !r.unavailable && !r.noBubble, JSON.stringify(r).slice(0, 200));
  if (r.unavailable || r.noBubble) return;
  check(`[${tag}] white-space preserves breaks (pre-wrap), NOT the collapsing default (normal)`,
    r.whiteSpace === 'pre-wrap', `white-space=${r.whiteSpace}`);
  check(`[${tag}] single newlines paint as separate lines (>=7 distinct line tops for the 7 non-blank lines)`,
    r.distinctTops >= 7, `distinctTops=${r.distinctTops}, lineCount=${r.lineCount}, approxLines=${r.approxLines}`);
  check(`[${tag}] blank-line paragraph gap is preserved (block spans all 8 lines incl. the gap, not a ~1-line blob)`,
    r.approxLines >= 8, `approxLines=${r.approxLines}, height=${r.height}px`);
  check(`[${tag}] leading indentation of the pasted block survives (an indented line sits right of the base left edge)`,
    r.indentPx >= 12, `indentPx=${r.indentPx} (baseLeft=${r.baseLeft}, maxLeft=${r.maxLeft})`);
  check(`[${tag}] user text is rendered as PLAIN TEXT — no HTML/markdown elements injected`,
    r.childElementCount === 0 && r.hasScriptOrImg === false, `childElementCount=${r.childElementCount}, hasScriptOrImg=${r.hasScriptOrImg}`);
  check(`[${tag}] the rendered text is byte-identical to what the user typed`,
    r.textPreserved === true, `textPreserved=${r.textPreserved}`);
}

function assertOverflow(tag, r) {
  check(`[${tag}] a very long unbroken line WRAPS inside the bubble — no horizontal overflow`,
    !r.noBubble && r.overflowX <= 1, `scrollWidth=${r.scrollWidth}, clientWidth=${r.clientWidth}, overflowX=${r.overflowX}`);
  check(`[${tag}] the long line actually wrapped to multiple lines (did not run off one line)`,
    r.lineCount >= 2, `lineCount=${r.lineCount}, height=${r.height}px`);
}

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');

  for (const theme of ['dark', 'light']) {
    await cdp.send('Page.navigate', { url: `${BASE}/` });
    await cdp.waitFor('boot', 'window.__station && !!window.__station.renderMessages');
    await cdp.eval(`(() => { try { document.documentElement.dataset.theme = ${JSON.stringify(theme)}; localStorage.setItem('theme', ${JSON.stringify(theme)}); } catch {} })()`);

    console.log(`\n=== POST-CHANGE (${theme} theme): the real .you p rule over a realistic multi-line message ===`);
    assertRendered(`post/${theme}`, await cdp.eval(renderExpr(BREAKS_TEXT, null)));
    console.log(`--- (${theme}) a very long unbroken pasted line ---`);
    assertOverflow(`post/${theme}`, await cdp.eval(renderExpr(LONG_TEXT, null)));
  }

  // Screenshot the dark render for the human record (design review; both themes
  // were exercised above, a shot documents the paint).
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('boot', 'window.__station && !!window.__station.renderMessages');
  await cdp.eval(renderExpr(BREAKS_TEXT, null));
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const shotPath = path.join(os.tmpdir(), 'bug-164-render.png');
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  console.log(`\n  screenshot: ${shotPath}`);

  console.log('\n=== MUST-FAIL (synthesized pre-change): .you p forced back to white-space:normal collapses the breaks ===');
  const pre = await cdp.eval(renderExpr(BREAKS_TEXT, 'normal'));
  check('MUST-FAIL: with the collapsing default, white-space reads "normal" (the defect state)',
    pre.whiteSpace === 'normal', `white-space=${pre.whiteSpace}`);
  check('MUST-FAIL: the breaks collapse — the 8-line note flattens to a short wrapped blob (roughly half the lines, fewer distinct tops)',
    pre.approxLines <= 6 && pre.distinctTops <= 5,
    `approxLines=${pre.approxLines} (vs ~10 with pre-wrap), distinctTops=${pre.distinctTops} (vs ~9), height=${pre.height}px`);
  check('MUST-FAIL: the leading indentation is gone (collapsed to the base left edge)',
    pre.indentPx < 12, `indentPx=${pre.indentPx}`);

  cdp.close();
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => {
    stopByPid(server); stopByPid(browser);
    for (const d of cleanupDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
  });
