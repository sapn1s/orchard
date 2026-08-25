/**
 * FEAT-075 Phase 3 — the in-app Guide viewer.
 *
 *   node scripts/verify-feat-075-guide-viewer.mjs
 *
 * Two halves, one scratch server on an OS-assigned free port (never :4317):
 *
 *  SERVER (fetch, no browser):
 *   - GET /api/guide lists docs/guide/*.md with titles, README first.
 *   - GET /api/guide/:page returns that page's markdown, YAML frontmatter stripped.
 *   - path traversal is REJECTED (encoded ../, a non-.md lockfile name, a bare
 *     name that is not a page) → 404, never a file outside docs/guide, never 500.
 *   - the route rides the BUG-076 Host allowlist: a foreign Host → 403.
 *
 *  CLIENT (real brave --headless=new over raw CDP — happy-dom has no layout and
 *  cannot run mermaid's SVG engine):
 *   - the topbar Guide pill opens #/guide and the reader renders README's
 *     heading + prose;
 *   - a ```mermaid block renders OFFLINE to an <svg> from the vendored bundle
 *     (no network) — or, if that ever fails, the labelled source fallback stays;
 *   - the page list navigates (pushState) to #/guide/<page>, frontmatter is not
 *     shown, and browser Back returns to the previous page then out to sessions.
 *
 * REALISTIC fixture: the app's OWN six-page docs/guide/ (README + five sections,
 * three carrying mermaid, four carrying `sources:` frontmatter) — the real guide
 * a user reads, not a one-line stub.
 *
 * MUST-FAIL pre-fix: with the implementation reverted (git stash the lane files),
 * /api/guide 404s (no pages), the Guide pill is absent, and no diagram renders —
 * the server + client checks below fail. Re-run after `git stash pop`.
 */
import { spawn } from 'node:child_process';
import * as http from 'node:http';
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
const PORT = Number(process.env.VERIFY_GUIDE_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-guide-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-guide-brave-'));
const BRAVE = process.env.VERIFY_GUIDE_BROWSER ?? 'brave';

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
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
  async waitFor(label, expr, timeoutMs = 20_000) {
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

let server = null, browser = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

/** fetch that returns { status, json } without throwing on non-2xx. */
async function get(pathname, init) {
  const res = await fetch(`${BASE}${pathname}`, init);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

/** Raw HTTP GET with an explicit Host header — undici's fetch refuses to set
 *  Host, so the DNS-rebinding guard can only be exercised with node:http. */
function rawGet(pathname, hostHeader) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: pathname, method: 'GET',
        headers: hostHeader === undefined ? {} : { Host: hostHeader } },
      (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.end();
  });
}

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); }
  }
  if (!up) throw new Error('server never became healthy');

  /* ================================ SERVER route ============================ */
  console.log('\n=== /api/guide: lists pages, README first, with titles ===');
  const list = await get('/api/guide');
  const pages = list.body?.pages ?? [];
  const byId = Object.fromEntries(pages.map((p) => [p.page, p.title]));
  check('GET /api/guide → 200 with a pages array', list.status === 200 && Array.isArray(pages), { status: list.status, n: pages.length });
  check('lists the real multi-page guide (README + orchestration + verification present)',
    ['README', 'orchestration', 'verification'].every((p) => p in byId) && pages.length >= 5,
    pages.map((p) => p.page));
  check('README sorts FIRST', pages[0]?.page === 'README', pages[0]?.page);
  check('titles come from each page\'s # heading (not the filename)',
    byId.orchestration === 'Orchestration & dispatch' && /Guide/i.test(byId.README ?? ''),
    { README: byId.README, orchestration: byId.orchestration });

  console.log('\n=== /api/guide/:page: markdown, frontmatter stripped ===');
  const readme = await get('/api/guide/README');
  check('GET /api/guide/README → 200 with markdown + title',
    readme.status === 200 && typeof readme.body?.markdown === 'string' && !!readme.body?.title,
    { status: readme.status, title: readme.body?.title, bytes: readme.body?.markdown?.length });
  check('README markdown carries its ```mermaid diagram source',
    /```mermaid[\s\S]*flowchart/.test(readme.body?.markdown ?? ''),
    (readme.body?.markdown ?? '').includes('```mermaid'));
  const orch = await get('/api/guide/orchestration');
  check('a page with YAML frontmatter → the returned markdown has it STRIPPED (starts at the # heading)',
    orch.status === 200 && !/^\s*---/.test(orch.body?.markdown ?? '') && /^#\s+Orchestration/.test((orch.body?.markdown ?? '').trimStart()),
    (orch.body?.markdown ?? '').slice(0, 40));
  check('frontmatter `sources:` key is NOT leaked into the reader body',
    !/^sources:/m.test(orch.body?.markdown ?? ''),
    /sources:/.test(orch.body?.markdown ?? '') ? 'LEAKED' : 'clean');

  console.log('\n=== /api/guide: path traversal & non-page names are rejected ===');
  const traversals = [
    '/api/guide/..%2f..%2fpackage.json',       // encoded ../../
    '/api/guide/%2e%2e%2f%2e%2e%2fpackage',    // encoded ../../ (dot form)
    '/api/guide/..%5c..%5cpackage.json',       // encoded ..\..\
    '/api/guide/.doc-sources.lock.json',       // a real non-.md file in docs/guide
    '/api/guide/.doc-sources.lock',            // …without the extension too
    '/api/guide/nope-not-a-real-page',         // graceful missing → 404, not 500
  ];
  for (const t of traversals) {
    const r = await get(t);
    check(`${t} → 404 (rejected, not served, not 500)`, r.status === 404, { status: r.status });
  }
  // The lockfile is real and readable on disk — prove it never comes back through the route.
  const lockOnDisk = fs.existsSync(path.join(ROOT, 'docs', 'guide', '.doc-sources.lock.json'));
  const lockLeak = await get('/api/guide/.doc-sources.lock.json');
  check('the real .doc-sources.lock.json exists on disk yet the route refuses it (.md is appended, never accepted)',
    lockOnDisk && lockLeak.status === 404, { lockOnDisk, status: lockLeak.status });

  console.log('\n=== /api/guide rides the BUG-076 Host allowlist ===');
  const foreignHost = await rawGet('/api/guide', 'attacker.rebind.example');
  const goodHost = await rawGet('/api/guide', `127.0.0.1:${PORT}`);
  check('a foreign Host is rejected 403 on the guide route (DNS-rebind guard intact)', foreignHost === 403, { status: foreignHost });
  check('a localhost Host still serves the guide (guard did not over-block)', goodHost === 200, { status: goodHost });

  /* ================================ CLIENT view ============================ */
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

  console.log('\n=== client: the topbar Guide pill opens the reader ===');
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('app booted', 'window.__station !== undefined', 60_000);
  const pill = await cdp.eval(`(() => {
    const b = document.querySelector('#guideBtn');
    return { present: !!b, hidden: b ? b.hidden : null, href: b?.getAttribute('href') ?? null,
             visible: b ? (b.offsetParent !== null) : false };
  })()`);
  check('a Guide pill is present in the topbar, visible, → #/guide',
    pill.present && !pill.hidden && pill.visible && pill.href === '#/guide', pill);

  await cdp.eval(`document.querySelector('#guideBtn')?.click()`);
  const opened = await cdp.waitFor('reader open on README', `(() => {
    const gv = document.querySelector('#guideView');
    if (!gv || gv.hidden) return false;
    const h1 = document.querySelector('#gvDoc h1');
    return !!h1 && /Orchard/i.test(h1.textContent) && document.querySelectorAll('#gvDoc p').length > 0;
  })()`, 20_000);
  const afterOpen = await cdp.eval(`({
    hash: location.hash,
    heading: document.querySelector('#gvDoc h1')?.textContent ?? null,
    paras: document.querySelectorAll('#gvDoc p').length,
    navLinks: document.querySelectorAll('#gvNav a').length,
  })`);
  check('clicking the pill opens the reader on README (heading + prose rendered)',
    opened && /Orchard/i.test(afterOpen.heading ?? '') && afterOpen.paras > 0, afterOpen);
  check('the reader hash is #/guide and the page list shows every page',
    afterOpen.hash === '#/guide' && afterOpen.navLinks >= 5, { hash: afterOpen.hash, navLinks: afterOpen.navLinks });

  console.log('\n=== client: the mermaid diagram renders OFFLINE (vendored → <svg>) ===');
  const svgUp = await cdp.waitFor('mermaid svg', `document.querySelector('#gvDoc .gv-mermaid svg') !== null`, 30_000);
  const mm = await cdp.eval(`(() => {
    const holder = document.querySelector('#gvDoc .gv-mermaid');
    const svg = holder?.querySelector('svg') ?? null;
    return {
      holderPresent: !!holder,
      svgPresent: !!svg,
      rendered: holder?.classList.contains('rendered') ?? false,
      hasNodes: svg ? svg.querySelectorAll('g, path, rect, text').length : 0,
      fallbackHidden: holder ? getComputedStyle(holder.querySelector('.gv-mermaid-src') ?? holder).display === 'none' : null,
      // proof it was NOT fetched from a CDN: the vendored URL is same-origin/local
      mermaidGlobal: typeof window.mermaid !== 'undefined',
    };
  })()`);
  check('a ```mermaid block rendered to an on-page <svg> with drawn nodes (offline vendored engine)',
    svgUp && mm.svgPresent && mm.rendered && mm.hasNodes > 3, mm);

  console.log('\n=== client: page list navigates (pushState) and hides frontmatter ===');
  await cdp.eval(`(() => {
    const a = [...document.querySelectorAll('#gvNav a')].find((x) => x.getAttribute('href') === '#/guide/orchestration');
    if (a) a.click();
  })()`);
  const navd = await cdp.waitFor('orchestration page', `(() => {
    const h1 = document.querySelector('#gvDoc h1');
    return location.hash === '#/guide/orchestration' && !!h1 && /Orchestration/i.test(h1.textContent);
  })()`, 20_000);
  const orchView = await cdp.eval(`({
    hash: location.hash,
    heading: document.querySelector('#gvDoc h1')?.textContent ?? null,
    // the raw YAML frontmatter block (a bare 'sources:' key followed by '- '
    // path bullets, and the '---' fences) must NOT survive into the rendered doc
    leaksFrontmatter: /sources:\\s*\\n\\s*-\\s/.test(document.querySelector('#gvDoc')?.textContent ?? '')
      || (document.querySelector('#gvDoc')?.textContent ?? '').trimStart().startsWith('---'),
    onLink: document.querySelector('#gvNav a.on')?.getAttribute('href') ?? null,
  })`);
  check('clicking a page link navigates to #/guide/<page> and renders it, active row marked',
    navd && orchView.hash === '#/guide/orchestration' && orchView.onLink === '#/guide/orchestration', orchView);
  check('the YAML frontmatter (sources:) is NOT shown in the rendered document',
    !orchView.leaksFrontmatter, orchView.leaksFrontmatter ? 'LEAKED' : 'clean');

  console.log('\n=== client: browser Back returns to the previous page, then out to sessions ===');
  await cdp.eval('history.back()');
  const backToReadme = await cdp.waitFor('back on README', `(() => {
    const h1 = document.querySelector('#gvDoc h1');
    return location.hash === '#/guide' && !!h1 && /Orchard/i.test(h1.textContent);
  })()`, 20_000);
  check('Back returns from orchestration to the README index (history was pushed, not replaced)',
    backToReadme, await cdp.eval('location.hash'));
  await cdp.eval('history.back()');
  const outToSessions = await cdp.waitFor('reader closed', `document.querySelector('#guideView')?.hidden === true`, 20_000);
  check('Back again closes the reader (guide overlay torn down, session view returns)',
    outToSessions && !(await cdp.eval(`location.hash.startsWith('#/guide')`)), await cdp.eval('location.hash'));

  console.log('\n=== client: a deep link opened cold renders that page + its diagram ===');
  await cdp.send('Page.navigate', { url: `${BASE}/#/guide/verification` });
  await cdp.waitFor('cold deep-link boot', 'window.__station !== undefined', 60_000);
  const deep = await cdp.waitFor('verification page + svg', `(() => {
    const gv = document.querySelector('#guideView');
    const h1 = document.querySelector('#gvDoc h1');
    return gv && !gv.hidden && !!h1 && /Verification/i.test(h1.textContent)
      && document.querySelector('#gvDoc .gv-mermaid svg') !== null;
  })()`, 30_000);
  check('opening #/guide/<page> cold (a shared/bookmarked link) renders that page and its mermaid svg',
    deep, await cdp.eval(`({ hash: location.hash, heading: document.querySelector('#gvDoc h1')?.textContent ?? null })`));

  cdp.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) console.log(`  failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exitCode = 1;
}).finally(() => {
  stopByPid(browser);
  stopByPid(server);
  setTimeout(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    fs.rmSync(PROFILE, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }, 2500);
});
