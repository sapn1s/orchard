/**
 * BUG-021 — the model picker's current-state readout used to show the literal
 * placeholder "Whatever the project is set to" for a session inheriting the
 * project default, instead of the model actually in effect. Fix: when the
 * session carries no 'model' override, resolveInheritedModelLabel() (app.js)
 * resolves the concrete model — the project's own configured default, or
 * (once a session has run) the live wire id `session-init` reported — and the
 * picker renders THAT with an "inherited" tag, not the opaque phrase.
 *
 * Real browser, DOM assertions only (§C: assert what RENDERS, not internal
 * state) — every check below reads text out of the actual #modelOpts DOM.
 *
 *   node scripts/verify-model-picker.mjs
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
const PORT = Number(process.env.VERIFY_MODELPICKER_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-mp-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-mp-chrome-'));
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

const uid = (n) => `00000000-0000-4000-f000-${String(n).padStart(12, '0')}`;

// Snapshot of the model popover's DOM, read out of the page — never internal state.
const READ_MODEL_OPTS = `[...document.querySelectorAll('#modelOpts .opt')].map((b) => ({
  n: b.querySelector('.n')?.textContent ?? '',
  d: b.querySelector('.d')?.textContent ?? '',
  tag: b.querySelector('.tag')?.textContent ?? null,
  current: b.getAttribute('aria-pressed') === 'true',
}))`;

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-mp-proj-'));
  cleanupDirs.push(projDir);
  const store = path.join(os.homedir(), '.claude', 'projects', projDir.replace(/[/.]/g, '-'));
  fs.mkdirSync(store, { recursive: true });
  cleanupDirs.push(store);
  const sid = 'f0000000-9999-4aaa-bbbb-eeeeeeeeeeee';
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(store, `${sid}.jsonl`), [
    JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', uuid: uid(1), timestamp: now, sessionId: sid,
      message: { role: 'user', content: [{ type: 'text', text: 'hello model-picker world' }] } }),
    JSON.stringify({ parentUuid: uid(1), isSidechain: false, type: 'assistant', uuid: uid(2), timestamp: now, sessionId: sid,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi.' }] } }),
  ].join('\n') + '\n');
  // Back-date past the LIVE_WINDOW_MS so the fixture reads as an idle, non-live
  // session (see verify-overrides.mjs's comment on the same pattern).
  const oldTime = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(path.join(store, `${sid}.jsonl`), oldTime, oldTime);

  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: projDir, name: 'mp-fixture' }),
  })).json();
  if (!reg.project?.id) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  const pid = reg.project.id;
  // Freshly-registered projects default to settings.model: null (registry.ts
  // defaultSettings()) — "let the CLI decide". This is the COMMON case this
  // bug is about, not an edge case: most projects never touch the model
  // setting, so most sessions are inheriting a default nobody named yet.

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  const url = `${BASE}/#/project/${pid}/session/${sid}?dir=${encodeURIComponent(path.basename(store))}`;
  await cdp.send('Page.navigate', { url });
  await cdp.waitFor('session open', `window.__station?.state.current.sessionId === ${JSON.stringify(sid)}`, 30_000);

  console.log('\n=== fresh project (settings.model: null, the common case): unresolved is HONEST, never the old placeholder ===');
  await cdp.eval(`document.querySelector('#modelBtn').click()`);
  await sleep(200);
  let rows = await cdp.eval(READ_MODEL_OPTS);
  let cur = rows.find((r) => r.current);
  check('a row is marked current', !!cur, JSON.stringify(rows));
  check('current row label stays "Project default" (the OPTION label is untouched)',
    cur?.n === 'Project default', JSON.stringify(cur));
  check('nothing has resolved it yet (no project setting, no session has run) — honest fallback, no "inherited" tag',
    cur?.tag == null, JSON.stringify(cur));
  const wholePopText0 = await cdp.eval(`document.querySelector('#modelOpts').textContent`);
  check('the literal placeholder phrase "Whatever the project is set to" never appears — the bug this ticket is about',
    !/Whatever the project is set to/.test(wholePopText0), wholePopText0);

  console.log('\n=== (still not live) setting an explicit session override shows THAT model, not "Project default" ===');
  await cdp.eval(`[...document.querySelectorAll('#modelOpts .opt')].find((b) => b.querySelector('.n')?.textContent === 'Sonnet').click()`);
  await sleep(200);
  rows = await cdp.eval(READ_MODEL_OPTS);
  cur = rows.find((r) => r.current);
  check('current row is now Sonnet', cur?.n === 'Sonnet', JSON.stringify(cur));
  check('the explicit override carries no "inherited" tag', cur?.tag == null, JSON.stringify(cur));

  console.log('\n=== clearing the override returns to the (still-unresolved) default display ===');
  await cdp.eval(`[...document.querySelectorAll('#modelOpts .opt')].find((b) => b.querySelector('.n')?.textContent === 'Project default').click()`);
  await sleep(200);
  rows = await cdp.eval(READ_MODEL_OPTS);
  cur = rows.find((r) => r.current);
  check('current row is "Project default" again, no leftover override',
    cur?.n === 'Project default' && cur?.tag == null, JSON.stringify(cur));

  console.log('\n=== a session with NO model override, once the CLI has actually named one, shows the CONCRETE resolved model + "inherited" tag ===');
  // A live session reports the CLI's real wire id via session-init — the only
  // source of truth for a project default nobody explicitly configured (see
  // resolveInheritedModelLabel in app.js). Simulated here via the exposed
  // onEvent hook (window.__station), the same one a real socket message drives.
  const wireId = 'claude-opus-4-8-simulated-wire-id';
  await cdp.eval(`window.__station.onEvent({ t: 'session-init', sessionId: ${JSON.stringify(sid)}, cwd: '/tmp', model: ${JSON.stringify(wireId)}, tools: [] })`);
  await sleep(200);
  await cdp.eval(`document.querySelector('#modelBtn').click()`); // close
  await sleep(100);
  await cdp.eval(`document.querySelector('#modelBtn').click()`); // reopen — repaints fresh
  await sleep(200);
  rows = await cdp.eval(READ_MODEL_OPTS);
  cur = rows.find((r) => r.current);
  check('current row label is still "Project default"', cur?.n === 'Project default', JSON.stringify(cur));
  check('current row readout now names the CONCRETE resolved model, not the placeholder',
    cur?.d === wireId, JSON.stringify(cur));
  check('current row carries an "inherited" tag', cur?.tag === 'inherited', JSON.stringify(cur));
  const wholePopText1 = await cdp.eval(`document.querySelector('#modelOpts').textContent`);
  check('the literal placeholder phrase still never appears',
    !/Whatever the project is set to/.test(wholePopText1), wholePopText1);
  const btnTitle = await cdp.eval(`document.querySelector('#modelBtn').title`);
  check('the model button tooltip also names the concrete model',
    btnTitle.includes(`Model: ${wireId} (project default)`), btnTitle);

  console.log('\n=== separately: a project WITH its own configured default resolves directly, no ambiguity ===');
  const patched = await (await fetch(`${BASE}/api/projects/${pid}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { model: 'opus' } }),
  })).json();
  if (patched.project?.settings?.model !== 'opus') throw new Error(`patch failed: ${JSON.stringify(patched)}`);
  await cdp.eval('location.reload()');
  await sleep(600);
  await cdp.waitFor('session reopen', `window.__station?.state.current.sessionId === ${JSON.stringify(sid)}`, 30_000);
  await cdp.eval(`document.querySelector('#modelBtn').click()`);
  await sleep(200);
  rows = await cdp.eval(READ_MODEL_OPTS);
  cur = rows.find((r) => r.current);
  check('current row is the named model itself ("Opus"), matched directly — the pre-existing correct path',
    cur?.n === 'Opus', JSON.stringify(cur));
  const idleProjDefRow = rows.find((r) => r.n === 'Project default');
  check('the idle "Project default" option also reports what it resolves to',
    idleProjDefRow?.d === 'Opus', JSON.stringify(idleProjDefRow));

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
