/**
 * BUG-006 — clicking "+" (New session) on the SAME project must NOT carry the
 * prior session's model/effort/tool overrides into the new one. Only
 * permissionMode was ever honestly reset by startNew(); model/effort (and by
 * the same code path maxBudgetUsd/allowedTools/disallowedTools) leaked
 * because startNew deleted only state.overrides.permissionMode instead of
 * clearing the whole state.overrides map.
 *
 *   node scripts/verify-new-session-overrides.mjs
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
const PORT = Number(process.env.VERIFY_NEWSESSION_OVR_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-nsovr-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-nsovr-chrome-'));
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

const uid = (n) => `00000000-0000-4000-e000-${String(n).padStart(12, '0')}`;

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-nsovr-proj-'));
  cleanupDirs.push(projDir);
  const store = path.join(os.homedir(), '.claude', 'projects', projDir.replace(/[/.]/g, '-'));
  fs.mkdirSync(store, { recursive: true });
  cleanupDirs.push(store);
  const sid = '77777777-9999-4aaa-bbbb-dddddddddddd';
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(store, `${sid}.jsonl`), [
    JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', uuid: uid(1), timestamp: now, sessionId: sid,
      message: { role: 'user', content: [{ type: 'text', text: 'hello new-session-override world' }] } }),
    JSON.stringify({ parentUuid: uid(1), isSidechain: false, type: 'assistant', uuid: uid(2), timestamp: now, sessionId: sid,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi.' }] } }),
  ].join('\n') + '\n');
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: projDir, name: 'nsovr-fixture' }),
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

  console.log('\n=== arm a non-default model/effort/tool override on session A ===');
  // Drive the override directly through state + the same paint path the model
  // popover's click handler uses, mirroring what a user picking "haiku" from
  // the model popover does (see paintModelPop's option click handler).
  await cdp.eval(`(() => {
    window.__station.state.overrides.model = 'haiku';
    window.__station.state.overrides.effort = 'high';
    window.__station.state.overrides.allowedTools = ['Bash'];
    window.__station.persistOverrides?.();
    window.__station.paintModelBtn?.();
    return true;
  })()`);
  const armed = await cdp.eval(`({
    model: window.__station.state.overrides.model ?? null,
    set: document.querySelector('#modelBtn')?.dataset.set,
  })`);
  check('override armed on session A (model=haiku, modelBtn marked set)',
    armed.model === 'haiku' && armed.set === 'true', JSON.stringify(armed));

  console.log('\n=== click "+" New session on the SAME project ===');
  await cdp.eval(`[...document.querySelectorAll('#tree .proj')][0].querySelector('.plus').click()`);
  await sleep(400);
  const fresh = await cdp.eval(`({
    sid: window.__station.state.current.sessionId,
    overrides: window.__station.state.overrides,
    modelBtnSet: document.querySelector('#modelBtn')?.dataset.set,
    payload: window.__station.sessionOverrides ? window.__station.sessionOverrides() : null,
  })`);
  check('new session has a null sessionId (a fresh, unstarted session)',
    fresh.sid === null, JSON.stringify(fresh.sid));
  check('state.overrides is completely empty — no leaked model/effort/tools',
    fresh.overrides && Object.keys(fresh.overrides).length === 0, JSON.stringify(fresh.overrides));
  check('model button no longer reads "set"',
    fresh.modelBtnSet !== 'true', String(fresh.modelBtnSet));
  check('sessionOverrides() (the start-payload builder) carries no leaked override — undefined omits it from the start payload entirely',
    fresh.payload === undefined || Object.keys(fresh.payload).length === 0, JSON.stringify(fresh.payload));

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
