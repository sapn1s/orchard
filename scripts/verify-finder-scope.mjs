/**
 * BUG-009 — finder "scope into #project" reachability.
 *
 * completeProjectScope() sets findInput.value = '#proj ' (a load-bearing
 * TRAILING SPACE that signals "project name complete, list its whole
 * session set"). Before the fix, renderSearch()/parseFinderQuery() did a
 * full .trim() on that value before parsing it, so the trailing space was
 * lost, the regex saw no \s group, and the mode fell back to 'pickProject'
 * — re-rendering the SAME project-suggestion list instead of the scoped
 * whole-project session list. This script:
 *   1. types "#<proj>", waits for suggestions, clicks the suggestion row
 *      (exercises the row-click completion path)
 *   2. asserts the pane now shows the scoped WHOLE-PROJECT session list
 *      (both sessions, found-l says "in #<proj>"), not the suggestion list
 *   3. types a query after the scope and asserts it filters WITHIN scope
 *   4. repeats step 1 via the Enter-key completion path
 *      (completeProjectScope()) for good measure
 *
 * Must FAIL on pre-fix app.js (stuck showing suggestions) and PASS after.
 *
 *   node scripts/verify-finder-scope.mjs
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
const PORT = Number(process.env.VERIFY_FINDER_SCOPE_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-findscope-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-findscope-chrome-'));
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
  async waitFor(label, expr, timeoutMs = 8_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.eval(expr)) return true; } catch { /* nav */ }
      await sleep(150);
    }
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
  execFileSync('touch', ['-d', t.toISOString(), f]);
}

async function makeProject(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cs-findscope-${name}-`));
  cleanupDirs.push(dir);
  const store = path.join(os.homedir(), '.claude', 'projects', dir.replace(/[/.]/g, '-'));
  fs.mkdirSync(store, { recursive: true });
  cleanupDirs.push(store);
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: dir, name }),
  })).json();
  if (!reg.project?.id) throw new Error(`register ${name} failed: ${JSON.stringify(reg)}`);
  return { id: reg.project.id, store };
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

  const sidAlpha = '66666666-7777-4888-a999-aaaaaaaaaaaa';
  const sidBeta = '77777777-8888-4999-aaaa-bbbbbbbbbbbb';
  const { store } = await makeProject('scopeproj');
  writeSession(store, sidAlpha, 'ALPHATASK unique text', 0.02);
  writeSession(store, sidBeta, 'BETATASK unique text', 0.01);
  await makeProject('otherproj'); // decoy — must never leak into the scoped view

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

  const type = (v) => cdp.eval(`(() => { const f = document.querySelector('#finder'); f.classList.add('on'); const i = document.querySelector('#findInput'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input')); })()`);
  const suggestionRows = `[...document.querySelectorAll('#tree .row.hit')]`;
  const sessionRowTexts = `[...document.querySelectorAll('#tree .row:not(.hit)')].map((r) => r.textContent)`;
  const foundLabel = `document.querySelector('#tree .found-l')?.textContent ?? ''`;

  console.log('\n=== click completion reaches the scoped whole-project list ===');
  await type('#scopepr');
  const sawSuggestion = await cdp.waitFor('project suggestion', `${suggestionRows}.some((r) => r.textContent.includes('#scopeproj'))`);
  check('typing "#scopepr" suggests the project', sawSuggestion, await cdp.eval(`${suggestionRows}.map((r) => r.textContent)`));

  await cdp.eval(`${suggestionRows}.find((r) => r.textContent.includes('#scopeproj')).click()`);
  const valAfterClick = await cdp.eval(`document.querySelector('#findInput').value`);
  check('click completion leaves the load-bearing trailing space', valAfterClick === '#scopeproj ', valAfterClick);

  // The core assertion: the pane must show the SCOPED WHOLE-PROJECT session
  // list (both sessions, by title text), not the project-suggestion list
  // again. On pre-fix code this times out because the pane keeps re-showing
  // suggestions (mode falls back to 'pickProject').
  const sawScopedList = await cdp.waitFor('scoped whole-project list',
    `${sessionRowTexts}.some((t) => t.includes('ALPHATASK')) && ${sessionRowTexts}.some((t) => t.includes('BETATASK'))`);
  const rowsNow = await cdp.eval(sessionRowTexts);
  const stillSuggesting = await cdp.eval(`${suggestionRows}.length > 0`);
  const label = await cdp.eval(foundLabel);
  check('scoped whole-project list is reached (empty-scope branch, not re-suggested)',
    sawScopedList && !stillSuggesting && /in #scopeproj/.test(label),
    { rowsNow, stillSuggesting, label });

  console.log('\n=== typing after the scope filters WITHIN it ===');
  await type('#scopeproj ALPHATASK');
  await cdp.waitFor('filtered to alpha', `${sessionRowTexts}.length === 1 && ${sessionRowTexts}[0].includes('ALPHATASK')`);
  const filteredRows = await cdp.eval(sessionRowTexts);
  const filteredLabel = await cdp.eval(foundLabel);
  check('post-scope query filters to just the matching session, still scoped',
    filteredRows.length === 1 && filteredRows[0].includes('ALPHATASK') && !filteredRows[0].includes('BETATASK') && /in #scopeproj/.test(filteredLabel),
    { filteredRows, filteredLabel });

  console.log('\n=== Enter-key completion (completeProjectScope) reaches it too ===');
  await type('#scopepr');
  await cdp.waitFor('project suggestion again', `${suggestionRows}.some((r) => r.textContent.includes('#scopeproj'))`);
  await cdp.eval(`document.querySelector('#findInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
  const valAfterEnter = await cdp.eval(`document.querySelector('#findInput').value`);
  check('Enter completion leaves the load-bearing trailing space', valAfterEnter === '#scopeproj ', valAfterEnter);
  const sawScopedListEnter = await cdp.waitFor('scoped whole-project list via Enter',
    `${sessionRowTexts}.some((t) => t.includes('ALPHATASK')) && ${sessionRowTexts}.some((t) => t.includes('BETATASK'))`);
  check('Enter-path also reaches the scoped whole-project list', sawScopedListEnter, await cdp.eval(sessionRowTexts));

  console.log('\n=== the decoy project never leaks into the scoped view ===');
  const leaked = await cdp.eval(`${sessionRowTexts}.some((t) => t.includes('otherproj'))`);
  check('no cross-project leakage in the scoped list', !leaked, leaked);

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
