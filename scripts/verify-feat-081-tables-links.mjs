/**
 * FEAT-081 — the shared prose() renderer must render GFM pipe tables and
 * `[text](url)` links, on BOTH surfaces that use it:
 *
 *   npm run verify:feat-081
 *
 * Scope note (widened from the filed ticket): prose() in public/lib/dom.js is
 * ONE renderer, used by the in-app Guide viewer AND — via digest.js
 * renderAssistantText() — by the assistant messages in the session transcript.
 * One fix serves both; this script verifies both.
 *
 * Real brave --headless=new over raw CDP (free port, never :4317; PID-kill only),
 * against a real scratch server serving the app's OWN docs/guide/*.md.
 *
 * A. GUIDE surface — the app's existing pages benefit:
 *    - #/guide/orchestration renders its `| Class | … |` block as a real <table>
 *      (2 header cells, 6 body rows), and `[verification.md](./verification.md)`
 *      as an <a href>. MUST-FAIL pre-fix: the raw `|---|` separator and the
 *      literal `[verification.md](…)` show as text and NO <table>/<a.md-link>.
 *    - #/guide/architecture renders its 3-column subsystem table.
 * B. TRANSCRIPT surface — the user's actual complaint: an assistant message with
 *    a markdown table + links renders the same real <table> + <a>, through
 *    renderMessages() (the transcript render path).
 * C. Degrade + SECURITY (through renderMessages, the untrusted path):
 *    - a malformed/partial table (no separator row) renders as TEXT — content
 *      preserved, nothing hidden, no <table>.
 *    - alignment (:--, --:, :-:) maps to text-align left/right/center.
 *    - a javascript: / data: link href is REFUSED — rendered as inert text, no
 *      <a> and no live navigable element.
 *    - HTML in a table cell and in link text is inserted as TEXT — no injected
 *      <img>/<b>/<script> element exists in the output.
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
const PORT = Number(process.env.VERIFY_FEAT_081_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f081-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f081-brave-'));
const BRAVE = process.env.VERIFY_FEAT_081_BROWSER ?? 'brave';

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
const SENTINEL = 'ORCHIDMOTH';

// A REALISTIC assistant reply: a GFM table with alignment + inline code in cells,
// an in-app ticket link, and an external link — the exact shape the user hit.
const TRANSCRIPT_OK =
  `Here is the ${SENTINEL} status table:\n\n` +
  '| Ticket | State | Note |\n' +
  '| :-- | :-: | --: |\n' +
  '| `FEAT-081` | done | tables + links |\n' +
  '| BUG-093 | open | see [FEAT-082](#/tickets/FEAT-082) |\n\n' +
  'Docs live at [the site](https://example.com/docs) and a bare word after.\n';

// A partial/malformed "table": a header and a body row but NO separator line.
// It must degrade to text — content preserved, no <table>.
const TRANSCRIPT_MALFORMED =
  `Broken ${SENTINEL} table below, must stay as text:\n\n` +
  '| a | b |\n' +
  '| c | d |\n';

// Hostile input: a javascript: and a data: href (both refused), HTML in a link
// text and in a table cell (both must be inert text). NOTHING live may appear.
const TRANSCRIPT_HOSTILE =
  `Hostile ${SENTINEL} content:\n\n` +
  '| Col | Payload |\n' +
  '| --- | --- |\n' +
  '| bad | <img src=x onerror="window.__pwned=1"> |\n\n' +
  'Refused: [click me](javascript:window.__pwned=1) and ' +
  '[data link](data:text/html,<script>window.__pwned=1</script>) and ' +
  'text link [<b>bolded</b>](https://ok.example.com/z).\n';

const asMsg = (text, index) => ({ role: 'assistant', index, blocks: [{ type: 'text', text }] });
const FX_B64 = Buffer.from(JSON.stringify({
  ok: asMsg(TRANSCRIPT_OK, 0),
  bad: asMsg(TRANSCRIPT_MALFORMED, 1),
  hostile: asMsg(TRANSCRIPT_HOSTILE, 2),
})).toString('base64');

/* Render a fixture assistant message through the REAL transcript path
   (renderMessages) and snapshot the resulting DOM. */
const RENDER_TRANSCRIPT = (key) => `(() => {
  const S = window.__station;
  const fx = JSON.parse(atob(${JSON.stringify(FX_B64)}));
  const pane = document.createElement('section');
  pane.className = 'pane';
  pane.dataset.thread = 'main';
  pane.dataset.probe = 'f081';
  document.getElementById('panes').appendChild(pane);
  const th = { key: 'p', kind: 'main', paneEl: pane, claudeBody: null, stream: null, tools: new Map() };
  S.renderMessages(th, [fx[${JSON.stringify(key)}]]);
  const table = pane.querySelector('table.md-table');
  const headCells = table ? [...table.querySelectorAll('thead th')].map((n) => n.textContent) : [];
  const bodyRows = table ? [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent)) : [];
  const aligns = table ? [...table.querySelectorAll('thead th')].map((n) => n.style.textAlign || null) : [];
  const links = [...pane.querySelectorAll('a.md-link')].map((a) => ({ text: a.textContent, href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel') }));
  const out = {
    hasTable: !!table,
    headCells, bodyRows, aligns, links,
    full: pane.textContent,
    // security probes: any live injected element from the untrusted text
    hasImg: !!pane.querySelector('img'),
    hasBold: !!pane.querySelector('b'),
    hasScript: !!pane.querySelector('script'),
    jsHrefs: [...pane.querySelectorAll('a')].map((a) => a.getAttribute('href')).filter((h) => /^javascript:|^data:/i.test(h || '')),
    pwned: !!window.__pwned,
  };
  pane.remove();
  return out;
})()`;

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
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
  const cdp = await Cdp.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');

  /* ============================ A. GUIDE surface ========================= */
  console.log('\n=== A. GUIDE surface: existing pages render tables + links ===');
  await cdp.send('Page.navigate', { url: `${BASE}/#/guide/orchestration` });
  await cdp.waitFor('app boot', 'window.__station !== undefined', 60_000);
  const orchReady = await cdp.waitFor('orchestration rendered', `(() => {
    const gv = document.querySelector('#guideView');
    const h1 = document.querySelector('#gvDoc h1');
    return gv && !gv.hidden && !!h1 && /Orchestration/i.test(h1.textContent);
  })()`, 30_000);
  const orch = await cdp.eval(`(() => {
    const doc = document.querySelector('#gvDoc');
    const table = doc.querySelector('table.md-table');
    const head = table ? [...table.querySelectorAll('thead th')].map((n) => n.textContent) : [];
    const rows = table ? table.querySelectorAll('tbody tr').length : 0;
    const firstCell = table ? (table.querySelector('tbody td')?.textContent ?? '') : '';
    const links = [...doc.querySelectorAll('a.md-link')].map((a) => ({ text: a.textContent, href: a.getAttribute('href') }));
    const txt = doc.textContent;
    return {
      hasTable: !!table, head, rows, firstCell, links,
      // MUST-FAIL guards: the raw markdown must be GONE from the rendered text
      rawSeparator: /\\|-{2,}\\|/.test(txt) || txt.includes('|---|'),
      rawLinkSyntax: txt.includes('[verification.md](./verification.md)'),
    };
  })()`);
  check('orchestration.md renders a real <table> (not raw pipe text)', orchReady && orch.hasTable, { ready: orchReady, hasTable: orch.hasTable });
  check('the table has the 2 header cells "Class" + choosing test', orch.head.length === 2 && /Class/.test(orch.head[0] ?? ''), orch.head);
  check('the table has all 6 body rows (trivial…verify)', orch.rows === 6, { rows: orch.rows });
  check('the first body cell is the `trivial` class', /trivial/.test(orch.firstCell), orch.firstCell);
  check('[verification.md](./verification.md) rendered as an <a href> in-app link',
    orch.links.some((l) => /verification\.md/.test(l.href ?? '') && !/^https?:/i.test(l.href ?? '')),
    orch.links.slice(0, 4));
  check('MUST-FAIL PRE-FIX: the raw |---| separator no longer shows as text', !orch.rawSeparator, { rawSeparator: orch.rawSeparator });
  check('MUST-FAIL PRE-FIX: the literal [verification.md](…) no longer shows as text', !orch.rawLinkSyntax, { rawLinkSyntax: orch.rawLinkSyntax });

  await cdp.send('Page.navigate', { url: `${BASE}/#/guide/architecture` });
  const archReady = await cdp.waitFor('architecture rendered', `(() => {
    const gv = document.querySelector('#guideView');
    const h1 = document.querySelector('#gvDoc h1');
    return gv && !gv.hidden && !!h1 && /Architecture/i.test(h1.textContent) && !!document.querySelector('#gvDoc table.md-table');
  })()`, 30_000);
  const arch = await cdp.eval(`(() => {
    const table = document.querySelector('#gvDoc table.md-table');
    return { hasTable: !!table, cols: table ? table.querySelectorAll('thead th').length : 0,
             firstHead: table ? (table.querySelector('thead th')?.textContent ?? '') : '' };
  })()`);
  check('architecture.md renders its 3-column subsystem table', archReady && arch.hasTable && arch.cols === 3 && /Subsystem/i.test(arch.firstHead), arch);

  /* ========================= B. TRANSCRIPT surface ======================= */
  console.log('\n=== B. TRANSCRIPT surface: assistant message table + links (the user complaint) ===');
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('app boot (transcript)', 'window.__station && !!window.__station.renderMessages', 60_000);
  const ok = await cdp.eval(RENDER_TRANSCRIPT('ok'));
  check('an assistant message renders its markdown table as a real <table>', ok.hasTable, { hasTable: ok.hasTable });
  check('the table header is Ticket | State | Note', JSON.stringify(ok.headCells) === JSON.stringify(['Ticket', 'State', 'Note']), ok.headCells);
  check('the table has 2 body rows with cells (inline code cell renders)',
    ok.bodyRows.length === 2 && ok.bodyRows[0][0] === 'FEAT-081' && ok.bodyRows[1][0] === 'BUG-093', ok.bodyRows);
  check('column alignment (:-- / :-: / --:) maps to left / center / right',
    JSON.stringify(ok.aligns) === JSON.stringify(['left', 'center', 'right']), ok.aligns);
  check('the in-app link [FEAT-082](#/tickets/FEAT-082) is an <a> with a hash href, NO target',
    ok.links.some((l) => l.text === 'FEAT-082' && l.href === '#/tickets/FEAT-082' && !l.target), ok.links);
  check('the external link opens safely (target=_blank, rel=noopener noreferrer)',
    ok.links.some((l) => l.href === 'https://example.com/docs' && l.target === '_blank' && /noopener/.test(l.rel ?? '') && /noreferrer/.test(l.rel ?? '')),
    ok.links);
  check('the surrounding prose sentinel still renders', ok.full.includes(SENTINEL), { hasSentinel: ok.full.includes(SENTINEL) });

  /* =================== C. Degrade safely + SECURITY ===================== */
  console.log('\n=== C. malformed table degrades to text; content never swallowed ===');
  const bad = await cdp.eval(RENDER_TRANSCRIPT('bad'));
  check('a table with no separator row renders NO <table>', !bad.hasTable, { hasTable: bad.hasTable });
  check('MUST-FAIL: the malformed table content is preserved as text (a, b, c, d all present)',
    bad.full.includes('a') && bad.full.includes('b') && bad.full.includes('c') && bad.full.includes('d') && bad.full.includes(SENTINEL),
    { sample: bad.full.slice(0, 120) });

  console.log('\n=== C. hostile hrefs + HTML in cells/link text are inert ===');
  const h = await cdp.eval(RENDER_TRANSCRIPT('hostile'));
  check('no javascript:/data: href reaches any <a> (refused links)', h.jsHrefs.length === 0, { jsHrefs: h.jsHrefs });
  check('the refused links are rendered as inert TEXT (raw markdown visible, no live link)',
    h.full.includes('javascript:window.__pwned=1') && h.full.includes('data:text/html'),
    { sample: h.full.slice(0, 160) });
  check('HTML in a table cell is inert text — no injected <img>', !h.hasImg, { hasImg: h.hasImg });
  check('HTML in link text is inert text — no injected <b>/<script>', !h.hasBold && !h.hasScript, { hasBold: h.hasBold, hasScript: h.hasScript });
  check('the external link with HTML text renders (as an <a>) with its text kept literal',
    h.links.some((l) => l.href === 'https://ok.example.com/z' && l.text.includes('<b>bolded</b>')), h.links);
  check('NOTHING executed — window.__pwned was never set', !h.pwned, { pwned: h.pwned });

  cdp.close();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(() => {
  stopByPid(browser);
  stopByPid(server);
  setTimeout(() => {
    for (const dir of [DATA, PROFILE]) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } }
    process.exit(process.exitCode ?? 0);
  }, 1500);
});
