/**
 * BUG-109 — prose() silently ate a region when a lone CR followed a fence run.
 *
 *   npm run verify:bug-109
 *
 * prose() (public/lib/dom.js) normalised only CRLF (`/\r\n/g`), never a lone CR.
 * Every line-shaped rule below that normalise assumes a line break is `\n`: the
 * fence split, the info-string strip (`chunk.replace(/^[^\n]*\n/, '')`), the
 * paragraph split and `b.split('\n')`. A lone CR is invisible to all of them, so
 * a `\r` right after a fence's info string made the info-string strip match
 * across the CR and consume the entire first content line of the code block —
 * "R2 rendered nowhere at all". The fix normalises CRLF *and* lone CR to `\n`
 * INSIDE prose(), so no caller (plan cards, agent/notice text, streaming buffer,
 * guide + ticket markdown — all of which call prose() with no upstream normalise)
 * can be exposed, and no downstream rule can be blind to a line break.
 *
 * This drives the REAL served public/lib/dom.js prose() in a REAL browser
 * (brave --headless=new over raw CDP; free port, never :4317; PID-kill only) and
 * verifies against RENDERED TEXT, not DOM shape:
 *
 *  A. MUST-FAIL repro: a fence whose info string is followed by a lone CR — the
 *     first code line's sentinel must render SOMEWHERE. Pre-fix it vanishes.
 *  B. No content lost + order preserved across LF / CRLF / lone-CR / MIXED line
 *     endings of the SAME realistic multi-region message (heading, paragraph,
 *     fenced code, list). All four must render the identical ordered sentinel
 *     sequence and the fence body — proving line-ending no longer matters.
 *  C. The real transcript caller (renderMessages → renderAssistantText → prose)
 *     over a mixed-ending assistant reply keeps every region and its order.
 *  D. Light + dark captures of the rendered repro, each graded on its own pixels
 *     (shot-luma), so the screenshot is real evidence and not a mislabelled twin.
 *
 * BUG-110 (folded in here — same renderer, same content-loss guarantee): a GFM
 * table BODY row with MORE cells than its header dropped the surplus cell
 * entirely — it was in no <td> and absent from reader-visible text. tryTable()
 * sized every body row from the header column count, so a model that emits a
 * summary cell containing a pipe lost it silently. Section E proves this is
 * line-ending-INDEPENDENT (the loss reproduces under LF as well as CR/CRLF,
 * because prose() has already normalised endings to LF before tryTable runs),
 * checks the sibling row-sizing cases, and confirms the surplus cell now lands
 * in a real widened <td>. See docs/bugs/BUG-110-*.md.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { shotLedger } from './lib/shot-luma.mjs';

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_BUG_109_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b109-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b109-brave-'));
const BRAVE = process.env.VERIFY_BUG_109_BROWSER ?? 'brave';
const SHOT_LIGHT = path.join(ROOT, 'docs', 'bugs', 'assets', 'BUG-109-light.png');
const SHOT_DARK = path.join(ROOT, 'docs', 'bugs', 'assets', 'BUG-109-dark.png');

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

/* -------------------------------------------------------------- fixtures */
// Unique, greppable region sentinels. R2 is the code block's FIRST content line
// — the region the bug ate. The canonical message uses LF; the harness derives
// the CRLF / lone-CR / MIXED variants from it in the page.
const S = { r1: 'R1zq7heading', r2: 'R2zq7codeline', code: 'R2zq7codeline', r3: 'R3zq7para', r4: 'R4zq7bullet', r5: 'R5zq7tail' };
const CANON =
  `# Heading ${S.r1}\n\n` +
  'A short intro paragraph before the code.\n\n' +
  '```js\n' +
  `${S.r2} = firstCodeLine();\n` +
  'const keep = 1;\n' +
  '```\n\n' +
  `Body paragraph ${S.r3} after the fence.\n\n` +
  `- bullet one ${S.r4}\n` +
  `- bullet two ${S.r5}\n`;

// The MUST-FAIL repro: the info string ("js") is terminated by a LONE CR, so the
// pre-fix info-string strip runs past it and eats the whole first code line.
const REPRO =
  `# Heading ${S.r1}\n\n` +
  `\`\`\`js\r${S.r2} = firstCodeLine();\nconst keep = 1;\n\`\`\`\n\n` +
  `## Section ${S.r3}\n\nTrailing paragraph ${S.r5}.\n`;

const b64 = (s) => Buffer.from(s).toString('base64');

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
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('app boot', 'window.__station && !!window.__station.renderMessages', 60_000);

  // Import the REAL served module so prose() under test is the shipped artifact.
  const modReady = await cdp.eval(`(async () => {
    const m = await import('/lib/dom.js');
    window.__prose = m.prose;
    return typeof window.__prose === 'function';
  })()`);
  if (!modReady) throw new Error('could not import prose from /lib/dom.js in page');

  // Render a raw string through the real prose() into a throwaway node.
  const renderProse = (raw) => `(() => {
    const host = document.createElement('div');
    host.id = 'b109-host';
    document.body.appendChild(host);
    const node = window.__prose(atob(${JSON.stringify(b64(raw))}));
    host.replaceChildren(node);
    const pres = [...host.querySelectorAll('pre')].map((p) => p.textContent);
    const text = host.textContent;
    const idx = (t) => text.indexOf(t);
    host.remove();
    return { text, pres, idx: { r1: idx('${S.r1}'), r2: idx('${S.r2}'), r3: idx('${S.r3}'), r4: idx('${S.r4}'), r5: idx('${S.r5}') } };
  })()`;

  /* ======================= A. MUST-FAIL repro ========================= */
  console.log('\n=== A. lone CR after a fence info string must not eat the first code line ===');
  const repro = await cdp.eval(renderProse(REPRO));
  check('MUST-FAIL PRE-FIX: the first code line sentinel R2 renders somewhere (was eaten by the info-string strip)',
    repro.text.includes(S.r2), { r2Present: repro.text.includes(S.r2), sample: repro.text.slice(0, 160) });
  check('the eaten line is inside the rendered <pre> code block, not lost',
    repro.pres.some((p) => p.includes(S.r2)), { pres: repro.pres });
  check('no OTHER region was collateral-damaged (R1, R3, R5 all present)',
    repro.text.includes(S.r1) && repro.text.includes(S.r3) && repro.text.includes(S.r5),
    { r1: repro.text.includes(S.r1), r3: repro.text.includes(S.r3), r5: repro.text.includes(S.r5) });
  check('order preserved: heading R1 before code R2 before section R3 before tail R5',
    repro.idx.r1 >= 0 && repro.idx.r1 < repro.idx.r2 && repro.idx.r2 < repro.idx.r3 && repro.idx.r3 < repro.idx.r5,
    repro.idx);

  /* ============ B. LF / CRLF / lone-CR / MIXED equivalence ============ */
  console.log('\n=== B. no content lost + order preserved across all four line endings ===');
  const variants = {
    lf: CANON,
    crlf: CANON.replace(/\n/g, '\r\n'),
    cr: CANON.replace(/\n/g, '\r'),
    // MIXED within one input: paragraph breaks CRLF, fence-internal newlines lone
    // CR, the rest LF — the shape real model / file text actually arrives in.
    mixed: CANON.replace(/\n\n/g, '\r\n\r\n').replace(new RegExp(`(${S.r2} = firstCodeLine\\(\\);)\n`), '$1\r'),
  };
  const results = {};
  for (const [k, v] of Object.entries(variants)) results[k] = await cdp.eval(renderProse(v));
  for (const [k, r] of Object.entries(results)) {
    const all = [S.r1, S.r2, S.r3, S.r4, S.r5].every((t) => r.text.includes(t));
    check(`[${k}] every region sentinel present (no content lost)`, all,
      { r1: r.text.includes(S.r1), r2: r.text.includes(S.r2), r3: r.text.includes(S.r3), r4: r.text.includes(S.r4), r5: r.text.includes(S.r5) });
    const ordered = r.idx.r1 < r.idx.r2 && r.idx.r2 < r.idx.r3 && r.idx.r3 < r.idx.r4 && r.idx.r4 < r.idx.r5;
    check(`[${k}] region order preserved (R1<R2<R3<R4<R5)`, ordered, r.idx);
    check(`[${k}] the fence renders as a <pre> containing the code sentinel`,
      r.pres.some((p) => p.includes(S.code)), { pres: r.pres });
  }
  // Equivalence: normalisation makes line-ending irrelevant — all four render the
  // same ordered sentinel sequence and the same code body.
  const seq = (r) => JSON.stringify(['r1', 'r2', 'r3', 'r4', 'r5'].map((t) => r.idx[t]).map((_, i, a) => i).sort((x, y) => r.idx[['r1', 'r2', 'r3', 'r4', 'r5'][x]] - r.idx[['r1', 'r2', 'r3', 'r4', 'r5'][y]]));
  const codeBody = (r) => JSON.stringify(r.pres);
  check('all four variants produce the IDENTICAL region order', new Set(Object.values(results).map(seq)).size === 1,
    Object.fromEntries(Object.entries(results).map(([k, r]) => [k, r.idx])));
  check('all four variants produce the IDENTICAL fenced code body', new Set(Object.values(results).map(codeBody)).size === 1,
    Object.fromEntries(Object.entries(results).map(([k, r]) => [k, r.pres])));

  /* ============ C. real transcript caller keeps content + order ======= */
  console.log('\n=== C. renderMessages (real transcript path) over a mixed-ending reply ===');
  const TX = CANON.replace(/\n\n/g, '\r\n\r\n').replace(new RegExp(`(${S.r2} = firstCodeLine\\(\\);)\n`), '$1\r');
  const tx = await cdp.eval(`(() => {
    const pane = document.createElement('section');
    pane.className = 'pane'; pane.dataset.thread = 'main'; pane.dataset.probe = 'b109';
    document.getElementById('panes').appendChild(pane);
    const th = { key: 'p', kind: 'main', paneEl: pane, claudeBody: null, stream: null, tools: new Map() };
    const msg = { role: 'assistant', index: 0, blocks: [{ type: 'text', text: atob(${JSON.stringify(b64(TX))}) }] };
    window.__station.renderMessages(th, [msg]);
    const text = pane.textContent;
    const idx = (t) => text.indexOf(t);
    const pres = [...pane.querySelectorAll('pre')].map((p) => p.textContent);
    pane.remove();
    return { text, pres, idx: { r1: idx('${S.r1}'), r2: idx('${S.r2}'), r3: idx('${S.r3}'), r4: idx('${S.r4}'), r5: idx('${S.r5}') } };
  })()`);
  check('transcript render keeps every region sentinel (no content lost)',
    [S.r1, S.r2, S.r3, S.r4, S.r5].every((t) => tx.text.includes(t)), tx.idx);
  check('transcript render preserves region order',
    tx.idx.r1 < tx.idx.r2 && tx.idx.r2 < tx.idx.r3 && tx.idx.r3 < tx.idx.r4 && tx.idx.r4 < tx.idx.r5, tx.idx);
  check('transcript render keeps the fenced code body intact',
    tx.pres.some((p) => p.includes(S.code)), { pres: tx.pres });

  /* ===== E. BUG-110: over-wide table body row must not drop the surplus cell ===== */
  console.log('\n=== E. GFM table body row wider than the header keeps its surplus cell (BUG-110) ===');
  // Render a raw string through prose() and report reader-visible text, whether a
  // <table> exists, and the per-row cell text of every rendered <tr>.
  const renderTable = (raw) => `(() => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    host.replaceChildren(window.__prose(atob(${JSON.stringify(b64(raw))})));
    const text = host.textContent;
    const rows = [...host.querySelectorAll('tr')].map((tr) => [...tr.children].map((c) => c.textContent));
    const hasTable = !!host.querySelector('table');
    host.remove();
    return { text, rows, hasTable };
  })()`;

  // E1. The clean-room shape under LF / CRLF / lone CR — the control the original
  // probe never ran. Pre-fix, ALL THREE lose LOST-SENTINEL, which is the proof
  // this is a table-rendering bug and not line-ending-specific.
  const OVERWIDE_LF = '| H1 | H2 |\n| --- | --- |\n| KEEP-A | KEEP-B | LOST-SENTINEL |';
  const tableEndings = { lf: OVERWIDE_LF, crlf: OVERWIDE_LF.replace(/\n/g, '\r\n'), cr: OVERWIDE_LF.replace(/\n/g, '\r') };
  for (const [k, v] of Object.entries(tableEndings)) {
    const r = await cdp.eval(renderTable(v));
    check(`[table:${k}] MUST-FAIL PRE-FIX: surplus body cell LOST-SENTINEL is reader-visible`,
      r.text.includes('LOST-SENTINEL'), { hasSentinel: r.text.includes('LOST-SENTINEL'), text: r.text, rows: r.rows });
    check(`[table:${k}] every header + body cell present`,
      ['H1', 'H2', 'KEEP-A', 'KEEP-B', 'LOST-SENTINEL'].every((t) => r.text.includes(t)), { text: r.text });
    check(`[table:${k}] the surplus cell lands in a real <td> (row widened, not dropped/merged)`,
      r.rows.some((row) => row.some((c) => c.includes('LOST-SENTINEL')) && row.length >= 3), { rows: r.rows });
  }

  // E2. Sibling row-sizing cases a header-sized rule could also drop content on.
  const siblings = {
    fewer:       '| A1 | A2 | A3 |\n| --- | --- | --- |\n| ONE-a | ONE-b |',
    noSep:       '| N1 | N2 |\n| plain row NOSEP-c | NOSEP-d |',
    sepMismatch: '| M1 | M2 |\n| --- | --- | --- |\n| MIS-a | MIS-b | MIS-c |',
    escaped:     '| E1 | E2 |\n| --- | --- |\n| ESC-a | has \\| a pipe ESC-b |',
    noBody:      '| Z1 | Z2 |\n| --- | --- |',
  };
  const expect = {
    fewer:       ['A1', 'A2', 'A3', 'ONE-a', 'ONE-b'],
    noSep:       ['N1', 'N2', 'NOSEP-c', 'NOSEP-d'],
    sepMismatch: ['M1', 'M2', 'MIS-a', 'MIS-b', 'MIS-c'],
    escaped:     ['E1', 'E2', 'ESC-a', 'ESC-b'],
    noBody:      ['Z1', 'Z2'],
  };
  for (const [k, v] of Object.entries(siblings)) {
    const r = await cdp.eval(renderTable(v));
    const missing = expect[k].filter((t) => !r.text.includes(t));
    check(`[table:sibling:${k}] no content lost (all sentinels reader-visible)`, missing.length === 0,
      { missing, text: r.text, hasTable: r.hasTable, rows: r.rows });
  }
  {
    const r = await cdp.eval(renderTable(siblings.escaped));
    check('[table:sibling:escaped] the escaped pipe stays inside one cell (literal | )',
      r.text.includes('has | a pipe'), { text: r.text, rows: r.rows });
  }

  // E3. Real transcript caller keeps the surplus cell.
  const txt = await cdp.eval(`(() => {
    const pane = document.createElement('section');
    pane.className = 'pane'; pane.dataset.thread = 'main'; pane.dataset.probe = 'b110';
    document.getElementById('panes').appendChild(pane);
    const th = { key: 'p', kind: 'main', paneEl: pane, claudeBody: null, stream: null, tools: new Map() };
    const msg = { role: 'assistant', index: 0, blocks: [{ type: 'text', text: atob(${JSON.stringify(b64(OVERWIDE_LF))})}] };
    window.__station.renderMessages(th, [msg]);
    const text = pane.textContent;
    const rows = [...pane.querySelectorAll('tr')].map((tr) => [...tr.children].map((c) => c.textContent));
    pane.remove();
    return { text, rows };
  })()`);
  check('[table:transcript] renderMessages keeps the surplus cell LOST-SENTINEL',
    txt.text.includes('LOST-SENTINEL'), { text: txt.text, rows: txt.rows });

  // E4. Visual evidence: the widened over-wide table, light + dark, graded on own pixels.
  const SHOT_T_LIGHT = path.join(ROOT, 'docs', 'bugs', 'assets', 'BUG-110-light.png');
  const SHOT_T_DARK = path.join(ROOT, 'docs', 'bugs', 'assets', 'BUG-110-dark.png');
  await cdp.eval(`(() => {
    document.body.replaceChildren();
    document.body.style.margin = '16px';
    document.body.appendChild(window.__prose(atob(${JSON.stringify(b64(OVERWIDE_LF))})));
    return true;
  })()`);
  const tableLedger = shotLedger();
  fs.mkdirSync(path.dirname(SHOT_T_LIGHT), { recursive: true });
  for (const [tone, file] of [['light', SHOT_T_LIGHT], ['dark', SHOT_T_DARK]]) {
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: tone }] });
    await sleep(200);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    const g = tableLedger.record(file, tone);
    check(`[table:shot:${tone}] widened over-wide table captured and graded ${tone}`, g.ok, `${file} — ${g.why}`);
  }

  /* ===== F. truncated-stream replay of a CR-adjacent fence (carried gap) ===== */
  // The live streaming path re-renders the ACCUMULATING buffer through prose()
  // every frame, so a partial buffer truncated mid-region is a real input. No
  // authenticated live model stream is reachable in this harness, so this replays
  // the exact BUG-109 CR-adjacent-fence shape (REPRO) truncated at EVERY byte
  // offset — a SYNTHETIC stand-in for a stored transcript, mirroring how the
  // buffer grows one chunk at a time. Property graded at each offset: prose()
  // never throws, and any region whose COMPLETE bytes are present in the
  // truncated input is present in the rendered text (a truncation offset must
  // never eat content that has already fully arrived).
  console.log('\n=== F. CR-adjacent fence truncated at every byte offset through prose() (synthetic stream) ===');
  const trunc = await cdp.eval(`(() => {
    const full = atob(${JSON.stringify(b64(REPRO))});
    const sentinels = ${JSON.stringify([S.r1, S.r2, S.r3, S.r5])};
    let threw = null, lostAt = null;
    for (let n = 1; n <= full.length; n++) {
      const partial = full.slice(0, n);
      let text;
      try {
        const host = document.createElement('div');
        host.replaceChildren(window.__prose(partial));
        text = host.textContent;
      } catch (e) { threw = { n, msg: String(e && e.message || e) }; break; }
      for (const s of sentinels) {
        if (partial.includes(s) && !text.includes(s)) { lostAt = { n, sentinel: s, partialTail: partial.slice(-20), text: text.slice(0, 120) }; break; }
      }
      if (lostAt) break;
    }
    return { len: full.length, threw, lostAt };
  })()`);
  check('every byte-truncation of the CR-adjacent-fence buffer renders without prose() throwing',
    trunc.threw === null, trunc.threw ?? `all ${trunc.len} offsets rendered`);
  check('no truncation offset drops a region whose complete bytes have already arrived',
    trunc.lostAt === null, trunc.lostAt ?? `checked all ${trunc.len} offsets, no fully-arrived region lost`);

  /* ==================== D. graded light + dark shots ================== */
  console.log('\n=== D. light + dark captures of the rendered repro, graded on pixels ===');
  await cdp.eval(`(() => {
    document.body.replaceChildren();
    document.body.style.margin = '0';
    document.body.appendChild(window.__prose(atob(${JSON.stringify(b64(REPRO))})));
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
  setTimeout(() => {
    for (const dir of [DATA, PROFILE]) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } }
    process.exit(process.exitCode ?? 0);
  }, 1500);
});
