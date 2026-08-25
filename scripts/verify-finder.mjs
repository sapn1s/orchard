/**
 * Finder + sidebar fold verification:
 *   - a project quiet for 2w+ folds into the "N inactive" row; expanding
 *     reveals it; a recent project never folds
 *   - "#" suggests project names (inactive ones included); Enter completes;
 *     "#name text" scopes BOTH title filtering and content search to it
 *
 *   node scripts/verify-finder.mjs
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
const PORT = Number(process.env.VERIFY_FINDER_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-find-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-find-chrome-'));
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';
const TOKEN = 'XFINDERTOKENX';

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

const uid = (n) => `00000000-0000-4000-c000-${String(n).padStart(12, '0')}`;
function writeSession(store, sid, text, ageDays) {
  const t = new Date(Date.now() - ageDays * 24 * 3600 * 1000);
  const lines = [
    JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', uuid: uid(1), timestamp: t.toISOString(), sessionId: sid,
      message: { role: 'user', content: [{ type: 'text', text }] } }),
    JSON.stringify({ parentUuid: uid(1), isSidechain: false, type: 'assistant', uuid: uid(2), timestamp: t.toISOString(), sessionId: sid,
      message: { role: 'assistant', content: [{ type: 'text', text: 'noted.' }] } }),
  ];
  const f = path.join(store, `${sid}.jsonl`);
  fs.writeFileSync(f, lines.join('\n') + '\n');
  // lastActivityAt derives from file mtime — age the file itself.
  execFileSync('touch', ['-d', t.toISOString(), f]);
}

async function makeProject(name, sid, text, ageDays) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cs-find-${name}-`));
  cleanupDirs.push(dir);
  const store = path.join(os.homedir(), '.claude', 'projects', dir.replace(/[/.]/g, '-'));
  fs.mkdirSync(store, { recursive: true });
  cleanupDirs.push(store);
  writeSession(store, sid, text, ageDays);
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: dir, name }),
  })).json();
  if (!reg.project?.id) throw new Error(`register ${name} failed: ${JSON.stringify(reg)}`);
  return reg.project.id;
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

  const sidFresh = '66666666-7777-4888-a999-aaaaaaaaaaaa';
  const sidOld = '77777777-8888-4999-aaaa-bbbbbbbbbbbb';
  await makeProject('fresh-proj', sidFresh, `hello ${TOKEN} fresh`, 0.04);
  await makeProject('zdusty-proj', sidOld, `hello ${TOKEN} dusty`, 30);

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('boot', `window.__station !== undefined`);

  console.log('\n=== recency fold ===');
  const HEADS = `[...document.querySelectorAll('#tree button.proj .nm')].map((n) => n.textContent)`;
  // fresh-proj is projects[0]? boot selects first project — ensure dusty is NOT current by construction order.
  const heads = await cdp.eval(HEADS);
  const foldText = await cdp.eval(`document.querySelector('#tree .inactive-l')?.textContent ?? null`);
  check('a 30-day-quiet project folds; the fresh one stays visible',
    heads.includes('fresh-proj') && !heads.includes('zdusty-proj') && /1 inactive/.test(foldText ?? ''),
    JSON.stringify({ heads, foldText }));
  await cdp.eval(`document.querySelector('#tree .inactive-l').click()`);
  const headsOpen = await cdp.eval(HEADS);
  check('expanding the fold reveals it', headsOpen.includes('zdusty-proj'), JSON.stringify(headsOpen));

  console.log('\n=== "#" project scoping ===');
  const type = (v) => cdp.eval(`(() => { const f = document.querySelector('#finder'); f.classList.add('on'); const i = document.querySelector('#findInput'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input')); })()`);
  await type('#zdu');
  await cdp.waitFor('suggestions', `[...document.querySelectorAll('#tree .row.hit')].some((r) => r.textContent.includes('#zdusty-proj'))`);
  const sugg = await cdp.eval(`[...document.querySelectorAll('#tree .row.hit')].map((r) => r.textContent.slice(0, 40))`);
  check('typing "#zdu" suggests the INACTIVE project too', sugg.some((s) => s.includes('#zdusty-proj')), JSON.stringify(sugg));
  await cdp.eval(`document.querySelector('#findInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
  const completed = await cdp.eval(`document.querySelector('#findInput').value`);
  check('Enter completes the scope', completed === '#zdusty-proj ', JSON.stringify(completed));
  // Wait for its session list, then title-filter inside the scope.
  await cdp.waitFor('scoped listing', `[...document.querySelectorAll('#tree .row')].some((r) => r.textContent.includes('hello'))`);
  // Scoped CONTENT search: "#zdusty-proj <TOKEN>" then Enter.
  await type(`#zdusty-proj ${TOKEN}`);
  await cdp.eval(`document.querySelector('#findInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
  const gotHits = await cdp.waitFor('scoped content hits', `[...document.querySelectorAll('#tree .row.hit .snip')].length > 0`);
  const snips = await cdp.eval(`[...document.querySelectorAll('#tree .row.hit .snip')].map((n) => n.textContent)`);
  const label = await cdp.eval(`[...document.querySelectorAll('#tree .found-l')].map((n) => n.textContent).join(' | ')`);
  check('scoped content search hits ONLY the scoped project',
    gotHits && snips.length === 1 && snips[0].includes('dusty') && /#zdusty-proj contents/.test(label),
    JSON.stringify({ snips, label }));

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
