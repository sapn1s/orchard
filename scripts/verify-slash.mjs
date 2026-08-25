/**
 * "/" command palette — proves the CLI really reports its slash commands
 * through session-init (one cheap live haiku turn), and that the composer
 * palette filters, completes, and stays out of the way (real browser).
 *
 *   node scripts/verify-slash.mjs
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
const PORT = Number(process.env.VERIFY_SLASH_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-slash-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-slash-chrome-'));
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

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-slash-proj-'));
  cleanupDirs.push(projDir);
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: projDir, name: 'slash-fixture' }),
  })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`register failed: ${JSON.stringify(reg)}`);

  console.log('\n=== bridge: the CLI reports its slash commands ===');
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  let init = null, turnEnded = false;
  ws.on('message', (raw) => {
    const e = JSON.parse(String(raw));
    if (e.t === 'session-init') init = e;
    if (e.t === 'turn-end') turnEnded = true;
  });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.send(JSON.stringify({ type: 'start', projectId: pid, prompt: 'Reply with exactly: SLASH-OK', overrides: { model: 'haiku' } }));
  const t0 = Date.now();
  while (!turnEnded && Date.now() - t0 < 180_000) await sleep(300);
  ws.close();
  const cmds = init?.slashCommands ?? [];
  check('session-init carries a non-empty slashCommands list from the CLI',
    cmds.length > 5, `${cmds.length} commands: ${cmds.slice(0, 8).join(', ')}…`);
  const served = await (await fetch(`${BASE}/api/slash-commands`)).json();
  check('the server remembers the list and serves it to fresh browsers',
    Array.isArray(served.commands) && served.commands.length === cmds.length,
    `${served.commands?.length} served`);
  // supportedModels() resolves shortly after the query starts — poll briefly.
  let models = [];
  for (let i = 0; i < 20 && !models.length; i++) {
    models = (await (await fetch(`${BASE}/api/models`)).json()).models ?? [];
    if (!models.length) await sleep(500);
  }
  check('the CLI reported its model list with VERSIONED display names',
    models.length >= 3 && models.some((mo) => /\d/.test(mo.displayName)),
    models.map((mo) => `${mo.value}=${mo.displayName}`).slice(0, 6).join(' | ') || '(none)');

  console.log('\n=== composer palette (real browser) ===');
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
  // NO list injection: this is a fresh profile with empty localStorage — the
  // palette must work purely off the server's remembered list at boot.
  // (Regression: it didn't, and "/" showed nothing in a fresh browser.)
  await cdp.waitFor('boot fetch landed', `(window.__station.state.slashCommands ?? []).length > 5`);

  const type = (v) => cdp.eval(`(() => { const p = document.querySelector('#prompt'); p.value = ${JSON.stringify(v)}; p.dispatchEvent(new Event('input')); })()`);
  await type('/');
  const allShown = await cdp.eval(`[...document.querySelectorAll('#slashPop .sl')].map((n) => n.textContent).length`);
  check('typing "/" opens the palette with commands', allShown > 0, `${allShown} rows`);
  await type('/mo');
  const filtered = await cdp.eval(`[...document.querySelectorAll('#slashPop .sl')].map((n) => n.textContent)`);
  check('typing filters by prefix', filtered.length >= 1 && filtered.every((x) => x.startsWith('/mo')), JSON.stringify(filtered));
  await cdp.eval(`document.querySelector('#prompt').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))`);
  const completed = await cdp.eval(`document.querySelector('#prompt').value`);
  check('Tab completes into the composer and closes the palette',
    /^\/mo\S*\s$/.test(completed) && (await cdp.eval(`document.querySelector('#slashPop').hidden`)) === true,
    JSON.stringify(completed));
  await type('plain text, no slash');
  check('ordinary text never shows the palette', (await cdp.eval(`document.querySelector('#slashPop').hidden`)) === true, 'hidden');

  console.log('\n=== model picker shows the CLI\'s versioned names ===');
  await cdp.eval(`document.querySelector('#modelBtn').click()`);
  const rows = await cdp.eval(`[...document.querySelectorAll('#modelOpts .opt .n')].map((n) => n.textContent)`);
  check('picker lists the CLI\'s display names (a version digit present)',
    rows.length >= 4 && rows.some((r) => /\d/.test(r)), JSON.stringify(rows));

  console.log('\n=== model picker highlights the ACTUAL effective model ===');
  // Run a real haiku turn through the UI itself (not the raw ws above) so
  // state.effective picks up the CLI's session-init report — typically a
  // full wire id like 'claude-haiku-4-5-20251001', not the bare 'haiku'
  // alias the picker's own row is keyed on.
  await cdp.eval(`(() => {
    const st = window.__station.state;
    st.overrides.model = 'haiku';
    document.querySelector('#prompt').value = 'Reply with exactly: MODEL-PICK-OK';
    document.querySelector('#go').click();
  })()`);
  const pickBusy = await cdp.waitFor('model-picker turn running', `window.__station.state.busy === true`, 30_000);
  if (!pickBusy) throw new Error('model-picker turn never started');
  const pickDone = await cdp.waitFor('model-picker turn ended', `window.__station.state.busy === false`, 180_000);
  if (!pickDone) throw new Error('model-picker turn never finished');
  const effModel = await cdp.eval(`window.__station.state.effective?.effective?.model ?? null`);
  await cdp.eval(`document.querySelector('#modelBtn').click()`);
  const pickerRows = await cdp.eval(`[...document.querySelectorAll('#modelOpts .opt')].map((o) => ({
    n: o.querySelector('.n')?.textContent ?? '',
    pressed: o.getAttribute('aria-pressed') === 'true',
  }))`);
  const pressedRows = pickerRows.filter((r) => r.pressed);
  check('exactly one row is marked current after a live haiku turn',
    pressedRows.length === 1, JSON.stringify({ effModel, pickerRows }));
  check('the current row is Haiku, correctly matched off the wire id the CLI actually reported',
    pressedRows.length === 1 && /haiku/i.test(pressedRows[0].n),
    JSON.stringify({ effModel, pressedRows }));
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
