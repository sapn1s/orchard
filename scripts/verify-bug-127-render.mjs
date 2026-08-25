#!/usr/bin/env node
/**
 * BUG-127, the RENDERED half — because the sibling defect (BUG-126) was invisible
 * in the source and only showed on screen.
 *
 *   npm run verify:bug-127-render
 *
 * The reported finding was graded on markdown SOURCE. Two questions only a real
 * render answers:
 *
 *   1. Is `docs/bugs/archive/INDEX.md` reachable in this product at all? The
 *      guide viewer serves `docs/guide/` and nothing else, so the answer is
 *      expected to be NO — asserted here against a real server rather than read
 *      off the route table, because "not reachable" is the kind of claim that is
 *      wrong after one commit.
 *   2. What does this project's own renderer do with a corrupted index? That
 *      matters even though the archive index is not served today: `prose()` is
 *      the one renderer behind the guide viewer and the transcript, and it is
 *      where any future surface would show this file.
 *
 * The expected answers differ per hazard, and saying so is the point:
 *   - a NEWLINE breaks the row in BOTH — `prose()` splits paragraphs on blank
 *     lines and the table ends where the row did;
 *   - a `<!--` hides rows on GitHub and in any HTML-passing renderer, but NOT in
 *     `prose()`, which inserts every cell as TEXT and so cannot open a comment.
 * So the source finding is real, the "hides every following row" half is
 * renderer-dependent, and this suite pins which is which instead of assuming.
 *
 * Real brave --headless=new over raw CDP. Free ephemeral port, never :4317;
 * scratch data dir; processes killed by pid, never pkill.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { mkdtempScratch } from './lib/scratch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = mkdtempScratch('verify-bug-127-render-');
const DATA = path.join(SCRATCH, 'data');
const PROFILE = path.join(SCRATCH, 'brave');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(PROFILE, { recursive: true });
const BRAVE = process.env.VERIFY_BUG_127_BROWSER ?? 'brave';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0; const fails = [];
const ok = (name, cond, observed) => {
  if (cond) { pass++; console.log(`  PASS  ${name}\n        observed: ${observed}`); }
  else { fails.push(name); console.log(`  FAIL  ${name}\n        observed: ${observed}`); }
};

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

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
  async waitFor(label, expr, timeoutMs = 45_000) {
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

let server = null; let browser = null;
const stopByPid = (child) => {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
};

/* ── the two documents, both built from the REAL shipped index ───────────── */

const SHIPPED = fs.readFileSync(path.join(ROOT, 'docs/bugs/archive/INDEX.md'), 'utf8');
const LEGACY_HEADER = '| ID | Still at |';
if (!SHIPPED.includes(LEGACY_HEADER)) throw new Error('the shipped archive index has no legacy section — this suite reads the wrong file');

/** The real index with the FIRST legacy row's reason cell corrupted, pre-fix style. */
function corrupt(reason) {
  const lines = SHIPPED.split('\n');
  const start = lines.findIndex((l) => l.startsWith(LEGACY_HEADER));
  const i = start + 2;
  const m = /^(\| \S+ \| \[[^\]]+\]\([^)]+\) \| ).* \|$/.exec(lines[i]);
  if (!m) throw new Error(`the first legacy row is not the shape this suite corrupts: ${lines[i]}`);
  lines[i] = `${m[1]}${reason} |`;
  return lines.join('\n');
}
const CORRUPT_NEWLINE = corrupt('Contested evidence.\n\n## Injected heading\n\nloose prose that is no longer a row.');
const CORRUPT_COMMENT = corrupt('Contested evidence <!-- from here on, invisible');

const B64 = Buffer.from(JSON.stringify({
  shipped: SHIPPED, newline: CORRUPT_NEWLINE, comment: CORRUPT_COMMENT,
})).toString('base64');

/**
 * Render one document through the app's OWN `prose()` — the renderer behind the
 * guide viewer and the transcript — and report what a reader would see.
 */
const RENDER = (key) => `(async () => {
  const { prose } = await import('/lib/dom.js');
  const docs = JSON.parse(atob(${JSON.stringify(B64)}));
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;width:1200px';
  document.body.append(host);
  host.append(prose(docs[${JSON.stringify(key)}]));
  const tables = [...host.querySelectorAll('table')];
  const legacy = tables.find((t) => [...t.querySelectorAll('thead th')].some((th) => /Still at/.test(th.textContent)));
  const main = tables.find((t) => [...t.querySelectorAll('thead th')].some((th) => /Original title/.test(th.textContent)));
  const out = {
    tables: tables.length,
    mainRows: main ? main.querySelectorAll('tbody tr').length : 0,
    legacyRows: legacy ? legacy.querySelectorAll('tbody tr').length : 0,
    legacyIds: legacy ? [...legacy.querySelectorAll('tbody tr')].map((tr) => tr.cells[0]?.textContent.trim()) : [],
    headings: [...host.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => h.textContent.trim()),
    visibleText: host.innerText,
    liveComments: (() => {
      let n = 0;
      const w = document.createTreeWalker(host, NodeFilter.SHOW_COMMENT);
      while (w.nextNode()) n++;
      return n;
    })(),
  };
  host.remove();
  return out;
})()`;

/* ═════════════════════════════════════════════════════════════════ run */

console.log('BUG-127 (rendered) — what a reader actually sees\n');
try {
  const PORT = Number(process.env.VERIFY_BUG_127_PORT ?? await freePort());
  const BASE = `http://127.0.0.1:${PORT}`;
  console.log(`  scratch server on ${BASE} (never :4317); data ${DATA}`);
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  /* ── A. is the archive index reachable in the product at all? ─────────── */
  console.log('\nA. reachability of the archive index in the running app');
  const probes = [
    '/api/guide/doc?path=../bugs/archive/INDEX.md',
    '/api/guide/doc?path=archive/INDEX.md',
    '/docs/bugs/archive/INDEX.md',
  ];
  const reached = [];
  for (const p of probes) {
    const r = await fetch(`${BASE}${p}`);
    const body = r.ok ? await r.text() : '';
    if (r.ok && body.includes('pre-migration ticket originals')) reached.push(`${p} -> ${r.status}`);
  }
  ok('the archive index is NOT served by the running app, so no in-app surface renders it',
    reached.length === 0, reached.length === 0 ? `${probes.length} routes probed, none returned it` : `REACHABLE via ${reached.join(', ')}`);

  /* ── browser ──────────────────────────────────────────────────────────── */
  browser = spawn(BRAVE, [
    '--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--window-size=1280,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 80 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  if (!devPort) throw new Error('browser never wrote DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page') ?? targets[0];
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('app boot', 'window.__station !== undefined', 60_000);

  /* ── B. the fixed index renders as one whole table ────────────────────── */
  console.log("\nB. the shipped index through the app's own prose() renderer");
  const good = await cdp.eval(RENDER('shipped'));
  ok('the legacy table renders as a table with every named ticket in it',
    good.legacyRows === 2 && good.legacyIds.length === 2,
    `${good.legacyRows} rows: ${JSON.stringify(good.legacyIds)}`);
  ok('the main table renders all 194 archived rows', good.mainRows === 194, `${good.mainRows} rows`);
  ok('the document has exactly the two headings the generator wrote',
    good.headings.length === 2, JSON.stringify(good.headings));

  /* ── C. a newline breaks the row HERE TOO ─────────────────────────────── */
  console.log('\nC. pre-fix corruption: a newline in a reason');
  const nl = await cdp.eval(RENDER('newline'));
  ok('a newline in a cell loses a row from the rendered legacy table',
    nl.legacyRows < good.legacyRows, `${nl.legacyRows} rows (shipped renders ${good.legacyRows}): ${JSON.stringify(nl.legacyIds)}`);
  ok("the reason's own text becomes a heading on the page",
    nl.headings.includes('Injected heading'), JSON.stringify(nl.headings));

  /* ── D. `<!--` — the half that is renderer-dependent ──────────────────── */
  console.log('\nD. pre-fix corruption: a `<!--` in a reason');
  const cm = await cdp.eval(RENDER('comment'));
  ok('prose() opens NO comment node — every cell is inserted as text',
    cm.liveComments === 0, `${cm.liveComments} comment nodes`);
  ok('so in THIS app nothing is hidden: both legacy rows still render',
    cm.legacyRows === good.legacyRows, `${cm.legacyRows} rows: ${JSON.stringify(cm.legacyIds)}`);
  ok('the `<!--` is visible as literal text, which is the honest degradation',
    cm.visibleText.includes('<!-- from here on, invisible'), 'literal `<!--` shown to the reader');
  console.log('  NOTE  the "hides every following row" half of the finding is real on GitHub and');
  console.log('        any HTML-passing markdown renderer, and NOT reproducible in prose(). The');
  console.log('        archive index is read as source and on GitHub, so the hazard stands; this');
  console.log('        suite records that the in-app renderer is not the surface that shows it.');

  cdp.close();
} finally {
  stopByPid(browser);
  stopByPid(server);
  await sleep(300);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.log('FAILED:');
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
