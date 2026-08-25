/**
 * Reload-while-running honesty — hard-reloading a tab mid-turn must NOT
 * present the still-running session as finished history. (Observed live:
 * reload showed idle + "agents ran" summary, then the response leaked in.)
 *
 *   node scripts/verify-reload-live.mjs      (one longer haiku turn)
 *
 * Real browser: start a turn, hard-reload while busy, and assert the reloaded
 * page reflects BUSY/following (not idle), the answer lands, then it flips to
 * idle when the run ends.
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
const PORT = Number(process.env.VERIFY_RELOAD_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rl-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rl-chrome-'));
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
  async waitFor(label, expr, timeoutMs = 30_000) {
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

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rl-proj-'));
  cleanupDirs.push(projDir);
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: projDir, name: 'reload-fixture' }),
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
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('boot', `window.__station !== undefined`);
  await cdp.waitFor('project selected + composer ready', `window.__station.state.current.projectId && document.querySelector('#prompt')`);
  await sleep(800);

  console.log('\n=== start a real turn, then hard-reload mid-turn ===');
  await cdp.eval(`(() => {
    const s = window.__station.state; s.overrides.model = 'haiku';
    document.querySelector('#prompt').value = 'Write a detailed 250-word essay about the history of clocks, then end with exactly: CLOCKS-DONE';
    document.querySelector('#go').click();
  })()`);
  // Wait for busy AND the real SDK session id (session-init assigns it a beat
  // after the turn starts) — the URL restore after reload needs that id.
  const busy = await cdp.waitFor('turn running with an id',
    `window.__station.state.busy === true && !!window.__station.state.current.sessionId`, 30_000);
  const sid = await cdp.eval(`window.__station.state.current.sessionId`);
  if (!busy || !sid) throw new Error('turn never started');
  await sleep(2000); // firmly mid-turn — socket about to die on reload
  await cdp.eval('location.reload()'); // ← the Ctrl+Shift+R moment
  await cdp.waitFor('boot after reload', `window.__station !== undefined`, 30_000);
  // The reloaded page restores the session from the URL, then reflects live state.
  const reflected = await cdp.waitFor('busy reflected after reload',
    `window.__station.state.current.sessionId === ${JSON.stringify(sid)} && window.__station.state.followingLive === true && window.__station.state.busy === true`, 30_000);
  const after = await cdp.eval(`({
    sid: window.__station.state.current.sessionId,
    busy: window.__station.state.busy,
    following: window.__station.state.followingLive,
    goMode: document.querySelector('#go').dataset.mode,
    fine: document.querySelector('#fine')?.textContent?.slice(0, 60),
  })`);
  check('reloaded tab reflects the STILL-RUNNING session as busy/following (not idle history)',
    reflected && after.busy === true && after.following === true && after.goMode === 'stop',
    JSON.stringify(after));

  console.log('\n=== the answer lands, then it flips to idle ===');
  const landed = await cdp.waitFor('answer arrives via file-follow',
    `[...document.querySelectorAll('#panes .pane.on .claude')].some((n) => n.textContent.includes('CLOCKS-DONE'))`, 240_000);
  check('the running turn\'s answer arrived in the reloaded tab', landed,
    await cdp.eval(`[...document.querySelectorAll('#panes .pane.on .claude')].map((n) => n.textContent.slice(-30)).slice(-1)[0] ?? ''`));
  const idle = await cdp.waitFor('flips to idle when the run ends',
    `window.__station.state.busy === false && window.__station.state.followingLive === false`, 30_000);
  check('flips to idle honestly once the run finishes (busy off, following off)', idle,
    await cdp.eval(`({ busy: window.__station.state.busy, following: window.__station.state.followingLive, go: document.querySelector('#go').dataset.mode })`));

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
