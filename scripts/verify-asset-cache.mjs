/**
 * BUG-019 — static assets (app.js/lib/*.js/styles.css/index.html) must never
 * be served in a way that lets a browser reuse a STALE cached copy after a
 * normal reload. Two things are checked, on a real server + real browser:
 *
 *   1. HTTP layer: every app-shell/asset response carries a header that
 *      forbids the browser disk cache from reusing bytes without a fresh
 *      request (`Cache-Control: no-store` — or `no-cache`/must-revalidate
 *      with a validator — either satisfies "normal reload always re-fetches").
 *   2. Browser layer: load the page, REWRITE public/app.js on disk (append a
 *      marker global), do a NORMAL reload (location.reload(), not
 *      Ctrl+Shift+R/cache-bypass), and assert the new code actually ran.
 *
 *   node scripts/verify-asset-cache.mjs
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
const PORT = Number(process.env.VERIFY_ASSET_CACHE_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const APP_JS = path.join(ROOT, 'public', 'app.js');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ac-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ac-chrome-'));
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
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

let server = null, browser = null;
const cleanupDirs = [DATA, PROFILE];
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

const originalAppJs = fs.readFileSync(APP_JS, 'utf8');
function restoreAppJs() {
  try { fs.writeFileSync(APP_JS, originalAppJs); } catch { /* best effort */ }
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

  console.log('\n=== HTTP layer: does every app asset forbid reuse-without-revalidation? ===');
  const paths = ['/', '/app.js', '/styles.css', '/lib/api.js', '/lib/dom.js'];
  for (const p of paths) {
    const r = await fetch(`${BASE}${p}`);
    const cc = (r.headers.get('cache-control') ?? '').toLowerCase();
    const revalidates = cc.includes('no-store') || (cc.includes('no-cache') || cc.includes('must-revalidate'));
    check(`${p} Cache-Control forces revalidation on every load`, revalidates, cc || '(none)');
  }

  console.log('\n=== browser layer: normal reload after an on-disk app.js change must run the NEW code ===');
  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');

  // First load: current (unmarked) app.js.
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('boot (pre-edit)', `window.__station !== undefined`);
  const markerBefore = await cdp.eval(`window.__BUG019_MARKER__ ?? null`);
  check('marker absent before the on-disk edit', markerBefore === null, markerBefore);

  // Edit app.js on disk — the "a fix just shipped" moment — then a NORMAL reload.
  const marker = `__BUG019_MARKER_${Date.now()}__`;
  fs.appendFileSync(APP_JS, `\nwindow.__BUG019_MARKER__ = ${JSON.stringify(marker)};\n`);
  await cdp.eval('location.reload()'); // plain reload — NOT a cache-bypassing hard reload
  await cdp.waitFor('boot (post-edit, post normal-reload)', `window.__station !== undefined`, 20_000);
  await sleep(300);
  const markerAfter = await cdp.eval(`window.__BUG019_MARKER__ ?? null`);
  check('a NORMAL reload picks up the on-disk app.js change (not stale-cached)', markerAfter === marker, markerAfter);

  cdp.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exitCode = 1;
}).finally(() => {
  restoreAppJs();
  stopByPid(browser);
  stopByPid(server);
  setTimeout(() => {
    for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }, 2500);
});
