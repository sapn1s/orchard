/**
 * BUG-251 — a GFM pipe table NOT preceded by a blank line renders as a run-on
 * paragraph with literal pipes.
 *
 *   npm run verify:bug-251
 *
 * prose() (public/lib/dom.js) splits a message body into blocks on `\n{2,}`
 * (blank lines) and only recognised a table when the HEADER row was lines[0] of
 * the block. A model routinely writes a bold caption on the line directly above
 * the header with NO blank line between, so the caption + header + separator +
 * rows land in ONE block whose lines[0] has no `|` — tryTable returned null and
 * the whole block collapsed into a single <p> with the Markdown pipes shown
 * literally. Fix: find the first header+separator pair ANYWHERE in the block,
 * render the lead-in through the normal prose path, the table rows as a <table>,
 * and re-run the remainder as prose (so a second table in the same block and any
 * trailing non-table lines are handled too).
 *
 * Drives the REAL served renderer (renderAssistantText, public/lib/digest.js,
 * which is what the transcript reading view calls) in a REAL headless browser
 * (brave --headless=new over raw CDP; free port, never :4317; PID-kill only) over
 * the REAL reported message, and grades RENDERED DOM shape + reader-visible text.
 *
 *  A. MUST-FAIL repro against a SYNTHESIZED pre-fix renderer (the live dom.js with
 *     the fix string-reverted, NOT anchored to HEAD, so it stays a valid pre-fix
 *     baseline after the fix commits; a pre-fix digest.js imports that pre-fix
 *     dom.js). The real message renders only 1 <table> pre-fix (the lone
 *     blank-line-preceded table), with the other two tables' pipes shown
 *     literally. The shipped renderer produces exactly 3 <table>s with the right
 *     header cells and zero literal `| Item |` pipe text.
 *  B. Edge / anti-regression shapes on the live prose(): a lone `|` in prose stays
 *     a <p>, a pipe table inside a code fence stays <pre>, an existing
 *     blank-line-separated table still renders, multiple tables in one block,
 *     trailing non-table lines after a table, and a table inside an orchard-answer
 *     block (the real wrapping) renders through renderAssistantText.
 *  C. Light + dark captures of the fixed real render, each graded on its own pixels.
 */
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { shotLedger } from './lib/shot-luma.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const REAL_SESSION = '4846de18-9f50-41d2-901d-564d93148b9a';
const REAL_UUID = '86f4f7f8-29b0-4fcc-85ee-c0b6c4bd2855';
// Locate the REAL transcript without hard-coding a home path (the leak gate
// forbids an encoded home path / username literal): find the Claude project dir
// whose encoded name ends in the marketplace project and read its session file.
function realJsonlPath() {
  if (process.env.VERIFY_BUG_251_JSONL) return process.env.VERIFY_BUG_251_JSONL;
  const base = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
  const dir = fs.readdirSync(base).find((d) => d.endsWith('facebook-marketplace'));
  if (!dir) throw new Error(`could not find the facebook-marketplace project dir under ${base}`);
  return path.join(base, dir, `${REAL_SESSION}.jsonl`);
}
const REAL_JSONL = realJsonlPath();

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_BUG_251_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b251-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b251-brave-'));
const BRAVE = process.env.VERIFY_BUG_251_BROWSER ?? 'brave';
const SHOT_LIGHT = path.join(ROOT, 'docs', 'bugs', 'assets', 'BUG-251-light.png');
const SHOT_DARK = path.join(ROOT, 'docs', 'bugs', 'assets', 'BUG-251-dark.png');

// Pre-fix modules dropped beside the real ones so relative imports resolve.
const PRE_DOM_REL = '__bug251-prefix-dom.js';
const PRE_DIGEST_REL = '__bug251-prefix-digest.js';
const PRE_DOM_ABS = path.join(ROOT, 'public', 'lib', PRE_DOM_REL);
const PRE_DIGEST_ABS = path.join(ROOT, 'public', 'lib', PRE_DIGEST_REL);

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

/* -------------------------------------------------- the REAL message text */
function realMessage() {
  const lines = fs.readFileSync(REAL_JSONL, 'utf8').split('\n').filter(Boolean);
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.uuid !== REAL_UUID) continue;
    const c = o.message?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
  throw new Error(`could not find message ${REAL_UUID} in ${REAL_JSONL}`);
}

const b64 = (s) => Buffer.from(s).toString('base64');

async function main() {
  const MSG = realMessage();
  if (!/\| Item \| Product \| € \| Link \|/.test(MSG)) {
    throw new Error('real message no longer contains the expected table header — fixture drift');
  }

  /* -------- synthesize the pre-fix renderer from the LIVE source (not HEAD) */
  const liveDom = fs.readFileSync(path.join(ROOT, 'public', 'lib', 'dom.js'), 'utf8');
  // Revert the block-loop change: replace the whole BUG-251 table-scan block with
  // the original two lines. Match from the fix's lead comment to its closing.
  const FIX_BLOCK_RE = /\n {6}\/\/ A GFM pipe table anywhere in the block[\s\S]*?\n {6}const tStart = findTableStart\(lines\);\n {6}if \(tStart >= 0\) \{[\s\S]*?\n {6}\}\n/;
  if (!FIX_BLOCK_RE.test(liveDom)) {
    throw new Error('could not locate the BUG-251 fix block in live dom.js to synthesize a pre-fix baseline');
  }
  const preDom = liveDom.replace(FIX_BLOCK_RE,
    '\n      const table = tryTable(lines);\n      if (table) { wrap.append(table); continue; }\n');
  if (preDom === liveDom || /const tStart = findTableStart/.test(preDom.split('export function prose')[1] ?? '')) {
    throw new Error('pre-fix synthesis did not remove the fix from the prose() block');
  }
  fs.writeFileSync(PRE_DOM_ABS, preDom);

  // A pre-fix digest.js that imports the pre-fix dom.js, so renderAssistantText
  // exercises the pre-fix prose() end-to-end.
  const liveDigest = fs.readFileSync(path.join(ROOT, 'public', 'lib', 'digest.js'), 'utf8');
  const preDigest = liveDigest.replace(/from '\.\/dom\.js'/g, `from './${PRE_DOM_REL}'`);
  if (preDigest === liveDigest) throw new Error('could not repoint pre-fix digest.js import to pre-fix dom.js');
  fs.writeFileSync(PRE_DIGEST_ABS, preDigest);

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
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('app boot', 'window.__station && !!window.__station.renderMessages', 60_000);

  const modReady = await cdp.eval(`(async () => {
    const liveDigest = await import('/lib/digest.js');
    const preDigest = await import('/lib/${PRE_DIGEST_REL}');
    const liveDom = await import('/lib/dom.js');
    window.__render = liveDigest.renderAssistantText;      // shipped (fixed)
    window.__renderPre = preDigest.renderAssistantText;    // synthesized pre-fix
    window.__prose = liveDom.prose;                        // live prose() for edge cases
    // UTF-8-safe base64 decode: atob() yields a Latin-1 binary string, which would
    // mojibake multi-byte chars (€, š) BEFORE they reach the renderer. Decode the
    // bytes as UTF-8 so the renderer sees the real text the user would.
    window.__u8 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
    return [window.__render, window.__renderPre, window.__prose].every((f) => typeof f === 'function');
  })()`);
  if (!modReady) throw new Error('could not import live + pre-fix renderers from /lib/');

  // Render a full message through a named render fn; report table shape + text.
  const renderMsg = (fnName, raw) => `(() => {
    const host = document.createElement('div');
    host.replaceChildren(window.${fnName}(window.__u8(${JSON.stringify(b64(raw))})));
    const tables = [...host.querySelectorAll('table')];
    const headers = tables.map((t) => [...t.querySelectorAll('thead th')].map((c) => c.textContent.trim()));
    const text = host.textContent;
    return {
      tables: tables.length,
      headers,
      literalPipes: (text.match(/\\| Item \\| Product/g) || []).length,
      pre: host.querySelectorAll('pre').length,
      text,
    };
  })()`;
  // Render raw text straight through prose() (edge cases).
  const renderProse = (raw) => `(() => {
    const host = document.createElement('div');
    host.replaceChildren(window.__prose(window.__u8(${JSON.stringify(b64(raw))})));
    return {
      tables: host.querySelectorAll('table').length,
      pre: host.querySelectorAll('pre').length,
      ps: [...host.querySelectorAll('p')].map((n) => n.textContent.trim()),
      headers: [...host.querySelectorAll('table')].map((t) => [...t.querySelectorAll('thead th')].map((c) => c.textContent.trim())),
      text: host.textContent,
    };
  })()`;

  /* ================= A. MUST-FAIL repro over the REAL message ========= */
  console.log('\n=== A. real reported message through the real renderer: pre-fix vs fixed ===');
  const pre = await cdp.eval(renderMsg('__renderPre', MSG));
  check('MUST-FAIL PRE-FIX: real message renders only 1 <table> (the two captioned tables collapse)',
    pre.tables === 1, { tables: pre.tables, headers: pre.headers });
  check('MUST-FAIL PRE-FIX: literal "| Item | Product" pipe text is shown (table source leaked)',
    pre.literalPipes >= 1, { literalPipes: pre.literalPipes });

  const fix = await cdp.eval(renderMsg('__render', MSG));
  check('FIXED: real message renders exactly 3 <table> elements',
    fix.tables === 3, { tables: fix.tables });
  check('FIXED: table 1 header cells are Item / Product / € / Link',
    JSON.stringify(fix.headers[0]) === JSON.stringify(['Item', 'Product', '€', 'Link']),
    { h0: fix.headers[0] });
  check('FIXED: table 2 header cells are Item / Product / € / Link',
    JSON.stringify(fix.headers[1]) === JSON.stringify(['Item', 'Product', '€', 'Link']),
    { h1: fix.headers[1] });
  check('FIXED: table 3 header cells are Date / What',
    JSON.stringify(fix.headers[2]) === JSON.stringify(['Date', 'What']),
    { h2: fix.headers[2] });
  check('FIXED: no literal "| Item | Product" pipe text leaks into the rendered page',
    fix.literalPipes === 0, { literalPipes: fix.literalPipes });
  check('FIXED: the bold captions survive as reader text (lead-in rendered, not eaten)',
    fix.text.includes('Kurši, collect in Jelgava') && fix.text.includes('Amazon.de, to your Jelgava address')
      && fix.text.includes('Order later'),
    { hasKursi: fix.text.includes('Kurši, collect in Jelgava') });
  check('FIXED: a body cell containing a URL/link reaches the table (go-link row present)',
    fix.text.includes('Roth Flat Kvadro') && fix.text.includes('Tapo L530E'),
    { hasRoth: fix.text.includes('Roth Flat Kvadro') });

  /* ================= B. edge / anti-regression shapes ================= */
  console.log('\n=== B. edge + anti-regression shapes ===');

  // B1: a lone `|` in prose, next line NOT an all-separator row -> no table.
  const lonePipe = 'The price is 5 | per unit\nand delivery is extra, see notes below.';
  const b1 = await cdp.eval(renderProse(lonePipe));
  check('[edge] lone `|` in prose stays a <p>, no <table>',
    b1.tables === 0 && b1.ps.length >= 1, { tables: b1.tables, ps: b1.ps });

  // B2: a pipe table inside a fenced code block stays raw <pre>, no <table>.
  const fenced = '```\n**caption**\n| A | B |\n|---|---|\n| 1 | 2 |\n```';
  const b2 = await cdp.eval(renderProse(fenced));
  check('[edge] pipe table inside a code fence stays <pre>, zero <table>',
    b2.tables === 0 && b2.pre === 1, { tables: b2.tables, pre: b2.pre });

  // B3: an existing blank-line-separated table still renders (no regression).
  const sepTable = 'Here is a table:\n\n| A | B |\n|---|---|\n| 1 | 2 |';
  const b3 = await cdp.eval(renderProse(sepTable));
  check('[edge] blank-line-separated table still renders as ONE <table>, lead-in as <p>',
    b3.tables === 1 && b3.ps.some((p) => p.includes('Here is a table')), { tables: b3.tables, ps: b3.ps });

  // B4: multiple captioned tables in ONE block (no blank lines anywhere).
  const multi = '**first**\n| A | B |\n|---|---|\n| 1 | 2 |\n**second**\n| C | D |\n|---|---|\n| 3 | 4 |';
  const b4 = await cdp.eval(renderProse(multi));
  check('[edge] two captioned tables in one block -> two <table>s with the right headers',
    b4.tables === 2
      && JSON.stringify(b4.headers[0]) === JSON.stringify(['A', 'B'])
      && JSON.stringify(b4.headers[1]) === JSON.stringify(['C', 'D']),
    { tables: b4.tables, headers: b4.headers });

  // B5: trailing non-table lines after the table rows end -> prose after table.
  const trailing = '**cap**\n| A | B |\n|---|---|\n| 1 | 2 |\nThat was the summary line B251trail.';
  const b5 = await cdp.eval(renderProse(trailing));
  check('[edge] trailing non-table line after a table renders as <p>, table intact',
    b5.tables === 1 && b5.ps.some((p) => p.includes('B251trail')) && b5.text.includes('cap'),
    { tables: b5.tables, ps: b5.ps });

  // B6: a captioned table inside an orchard-answer block via the full renderer.
  const inAnswer = '````orchard-answer\n**cap in answer**\n| A | B |\n|---|---|\n| 1 | 2 |\n````';
  const b6 = await cdp.eval(renderMsg('__render', inAnswer));
  check('[edge] captioned table inside an orchard-answer block renders a <table>',
    b6.tables === 1 && JSON.stringify(b6.headers[0]) === JSON.stringify(['A', 'B']) && b6.literalPipes === 0,
    { tables: b6.tables, headers: b6.headers });

  /* ==================== C. graded light + dark shots ================= */
  console.log('\n=== C. light + dark captures of the fixed real render, graded on pixels ===');
  await cdp.eval(`(() => {
    document.body.replaceChildren();
    document.body.style.margin = '16px';
    document.body.appendChild(window.__render(window.__u8(${JSON.stringify(b64(MSG))})));
    return true;
  })()`);
  const ledger = shotLedger();
  fs.mkdirSync(path.dirname(SHOT_LIGHT), { recursive: true });
  for (const [tone, file] of [['light', SHOT_LIGHT], ['dark', SHOT_DARK]]) {
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: tone }] });
    await sleep(200);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    const g = ledger.record(file, tone);
    check(`${tone} capture written and graded ${tone} (own pixels, not a twin)`, g.ok, `${file} — ${g.why}`);
  }

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
  for (const f of [PRE_DOM_ABS, PRE_DIGEST_ABS]) { try { fs.rmSync(f, { force: true }); } catch { /* gone */ } }
  setTimeout(() => {
    for (const dir of [DATA, PROFILE]) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } }
    process.exit(process.exitCode ?? 0);
  }, 1500);
});
