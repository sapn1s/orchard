/**
 * Per-session override memory — the skip-permissions toggle must survive a
 * reload of the SAME session, and a NEW session must never inherit it.
 *
 *   node scripts/verify-overrides.mjs
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
const PORT = Number(process.env.VERIFY_OVERRIDES_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ovr-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ovr-chrome-'));
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

const uid = (n) => `00000000-0000-4000-d000-${String(n).padStart(12, '0')}`;

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ovr-proj-'));
  cleanupDirs.push(projDir);
  const store = path.join(os.homedir(), '.claude', 'projects', projDir.replace(/[/.]/g, '-'));
  fs.mkdirSync(store, { recursive: true });
  cleanupDirs.push(store);
  const sid = '88888888-9999-4aaa-bbbb-cccccccccccc';
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(store, `${sid}.jsonl`), [
    JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', uuid: uid(1), timestamp: now, sessionId: sid,
      message: { role: 'user', content: [{ type: 'text', text: 'hello override world' }] } }),
    JSON.stringify({ parentUuid: uid(1), isSidechain: false, type: 'assistant', uuid: uid(2), timestamp: now, sessionId: sid,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi.' }] } }),
  ].join('\n') + '\n');
  // Back-date the fixture's mtime past the server's LIVE_WINDOW_MS (30s,
  // src/server/watcher.ts). isSessionLive() is pure mtime-recency — see the
  // comment there on why (open-fd checks false-positive on the dashboard's own
  // readers). A file written moments ago by THIS test would otherwise read as
  // "being written right now by another process", which is indistinguishable
  // from an external terminal — so the app correctly shows the "if you take
  // over" external-follow chip instead of "from next send". That is honest
  // app behavior, not a bug; the fixture must simulate an old, idle session to
  // exercise the armed-but-not-live path this test is actually named for.
  const oldTime = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(path.join(store, `${sid}.jsonl`), oldTime, oldTime);
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: projDir, name: 'ovr-fixture' }),
  })).json();
  if (!reg.project?.id) throw new Error(`register failed: ${JSON.stringify(reg)}`);

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  const url = `${BASE}/#/project/${reg.project.id}/session/${sid}?dir=${encodeURIComponent(path.basename(store))}`;
  await cdp.send('Page.navigate', { url });
  await cdp.waitFor('session open', `window.__station?.state.current.sessionId === ${JSON.stringify(sid)}`, 30_000);

  console.log('\n=== skip flag survives reload of the SAME session ===');
  await cdp.eval(`document.querySelector('#skipBtn').click()`);
  const armed = await cdp.waitFor('armed', `document.querySelector('#skipBtn').getAttribute('aria-pressed') === 'true'`);
  check('toggle arms (aria-pressed true, override recorded)',
    armed && (await cdp.eval(`window.__station.state.overrides.permissionMode`)) === 'bypassPermissions', 'armed');
  const pend = await cdp.eval(`({
    btn: document.querySelector('#skipBtn').dataset.pending,
    chip: document.querySelector('#seal .perm')?.textContent ?? '',
  })`);
  check('armed-not-live shows an explicit PENDING state (hollow mark, "from next send")',
    pend.btn === 'true' && /from next send/.test(pend.chip), JSON.stringify(pend));
  await cdp.eval('location.reload()');
  await sleep(600);
  await cdp.waitFor('session reopen', `window.__station?.state.current.sessionId === ${JSON.stringify(sid)}`, 30_000);
  const after = await cdp.eval(`({ pressed: document.querySelector('#skipBtn').getAttribute('aria-pressed'), ovr: window.__station.state.overrides.permissionMode ?? null })`);
  check('after reload the toggle is STILL armed for this session',
    after.pressed === 'true' && after.ovr === 'bypassPermissions', JSON.stringify(after));

  console.log('\n=== a NEW session never inherits it ===');
  await cdp.eval(`document.querySelector('#tree .proj .plus') ? [...document.querySelectorAll('#tree .proj')][0].querySelector('.plus').click() : window.__station.state && (() => { throw new Error('no plus') })()`);
  await sleep(400);
  const fresh = await cdp.eval(`({ sid: window.__station.state.current.sessionId, pressed: document.querySelector('#skipBtn').getAttribute('aria-pressed'), ovr: window.__station.state.overrides.permissionMode ?? null })`);
  check('startNew: toggle off, no permissionMode override',
    fresh.sid === null && fresh.pressed !== 'true' && fresh.ovr === null, JSON.stringify(fresh));

  console.log('\n=== disarming persists too ===');
  await cdp.send('Page.navigate', { url });
  await sleep(500);
  await cdp.waitFor('session reopen 2', `window.__station?.state.current.sessionId === ${JSON.stringify(sid)}`, 30_000);
  await cdp.waitFor('still armed on reopen', `document.querySelector('#skipBtn').getAttribute('aria-pressed') === 'true'`);
  await cdp.eval(`document.querySelector('#skipBtn').click()`); // disarm
  await cdp.waitFor('disarmed', `document.querySelector('#skipBtn').getAttribute('aria-pressed') === 'false'`);
  await cdp.eval('location.reload()');
  await sleep(600);
  await cdp.waitFor('session reopen 3', `window.__station?.state.current.sessionId === ${JSON.stringify(sid)}`, 30_000);
  const disarmed = await cdp.eval(`({ pressed: document.querySelector('#skipBtn').getAttribute('aria-pressed'), ovr: window.__station.state.overrides.permissionMode ?? null })`);
  check('disarm also survives reload (no zombie re-arm)',
    disarmed.pressed === 'false' && disarmed.ovr === null, JSON.stringify(disarmed));
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
