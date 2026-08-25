/**
 * BUG-010 — 'This session' scope rows must reflect a just-made local edit
 * (ctx.overrides) immediately, even while a session is live and its own
 * effective-config report still shows the old value. Before the fix, val()/
 * overriddenNow() in public/lib/drawer.js read live.effective FIRST, so
 * cycling Model (or typing a tool) silently wrote to ctx.overrides but the
 * row kept showing "inherited" and the revert arrow did nothing.
 *
 *   node scripts/verify-session-scope.mjs
 *   npm run verify:session-scope
 *
 * Real browser (brave, headless CDP), a real live session (a one-line haiku
 * turn against a scratch project so state.effective is genuinely populated
 * by the server, not faked). Kill by pid; never touches the server on 4317.
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
const PORT = Number(process.env.VERIFY_SESSION_SCOPE_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-scope-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-scope-chrome-'));
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

/*
 * Helpers injected before every eval so each call is one self-contained
 * expression. `readRow` inspects the same DOM structure `row()` builds in
 * drawer.js: span.v holds an optional .ovr/.inh tag span, a bare text node
 * for the displayed value, and (when overridden) a .rev revert button.
 */
const PRE = `
  function grp(label) { return [...document.querySelectorAll('.grp')].find(g => g.querySelector('.grp-l')?.textContent === label); }
  function modelRow() { const g = grp('Model'); return g ? g.querySelectorAll('.set')[0] : null; }
  function readRow(row) {
    const v = row.querySelector('.v');
    const tag = v.querySelector('.ovr') ? 'overridden' : (v.querySelector('.inh') ? 'inherited' : 'none');
    const txt = [...v.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
    return { tag, txt, hasRevert: !!v.querySelector('.rev') };
  }
`;

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-scope-proj-'));
  cleanupDirs.push(projDir);
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: projDir, name: 'scope-fixture' }),
  })).json();
  if (!reg.project?.id) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  const projectId = reg.project.id;

  // Project default model = haiku, so the live turn we run to populate
  // state.effective is cheap — and so the drawer's initial "This session"
  // row reads a concrete, human-checkable value ('haiku') rather than null.
  const patched = await (await fetch(`${BASE}/api/projects/${projectId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'haiku' }),
  })).json();
  if (patched.project?.settings?.model !== 'haiku') throw new Error(`precondition failed: project model not set to haiku: ${JSON.stringify(patched)}`);

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  const url = `${BASE}/#/project/${projectId}`;
  await cdp.send('Page.navigate', { url });
  await cdp.waitFor('project open', `window.__station?.state.current.projectId === ${JSON.stringify(projectId)}`, 30_000);

  console.log('\n=== start a real, cheap live session so state.effective is genuinely populated ===');
  await cdp.eval(`window.__station.startTurn('Reply with exactly the word: ok')`);
  const gotEffective = await cdp.waitFor(
    'state.effective populated with a live model',
    `window.__station?.state.effective?.effective?.model === 'haiku'`,
    60_000,
  );
  if (!gotEffective) throw new Error('precondition failed: session never went live with state.effective.effective.model === "haiku"');
  await cdp.waitFor('session-init assigns a real sdk session id', `typeof window.__station?.state.sdkSessionId === 'string'`, 15_000);
  const sidNow = await cdp.eval(`window.__station.state.sdkSessionId`);
  check('a real SDK session id is attached (this is a genuinely live session, not a fixture)', typeof sidNow === 'string' && sidNow.length > 0, sidNow);

  console.log('\n=== open the drawer, switch to "This session" scope ===');
  await cdp.eval(`document.querySelector('#cogBtn').click()`);
  await cdp.waitFor('drawer open', `document.querySelector('#drawer')?.classList.contains('open')`, 10_000);
  await cdp.eval(`document.querySelector('#dScope [data-scope="session"]').click()`);
  const scopeOn = await cdp.waitFor('session scope active', `document.querySelector('#dScope [data-scope="session"]')?.getAttribute('aria-pressed') === 'true'`, 5_000);
  check('scope switched to "This session"', scopeOn, scopeOn);

  console.log('\n=== BEFORE any edit: the Model row reads the live effective value, inherited ===');
  const before = await cdp.eval(`${PRE}; readRow(modelRow())`);
  check('initial row shows the live model (haiku) tagged "inherited" — nothing overridden yet',
    before?.txt === 'haiku' && before?.tag === 'inherited', before);

  console.log('\n=== cycle Model twice (haiku -> inherit -> opus): the row must visibly change ===');
  const afterCycle = await cdp.eval(`${PRE}; (function(){ modelRow().click(); modelRow().click(); return readRow(modelRow()); })()`);
  check('(a) the row\'s displayed value CHANGES to the picked value ("opus"), not stuck on "haiku"/inherited',
    afterCycle?.txt === 'opus' && afterCycle?.tag === 'overridden', afterCycle);
  check('(b) the revert affordance appears once the row is overridden',
    afterCycle?.hasRevert === true, afterCycle);
  const overridesAfterCycle = await cdp.eval(`window.__station.state.overrides.model ?? null`);
  check('(c) state.overrides.model reflects the local edit — this is what the NEXT session will launch with',
    overridesAfterCycle === 'opus', overridesAfterCycle);

  console.log('\n=== revert: the arrow must actually put the row back ===');
  const afterRevert = await cdp.eval(`${PRE}; (function(){ modelRow().querySelector('.rev').click(); return readRow(modelRow()); })()`);
  check('(b) revert restores the row to the live/inherited value ("haiku"), tagged "inherited" again',
    afterRevert?.txt === 'haiku' && afterRevert?.tag === 'inherited', afterRevert);
  const overridesAfterRevert = await cdp.eval(`window.__station.state.overrides.model ?? null`);
  check('(c) state.overrides.model is cleared by the revert — the NEXT session no longer gets a silent override',
    overridesAfterRevert === null, overridesAfterRevert);

  console.log('\n=== the same bug, in the "typing a tool + blur" shape ===');
  const toolsBefore = await cdp.eval(`document.querySelector('input[aria-label="Allowed tools"]').value`);
  await cdp.eval(`(function(){
    const inp = document.querySelector('input[aria-label="Allowed tools"]');
    inp.value = 'Bash, Read';
    inp.dispatchEvent(new Event('blur'));
  })()`);
  const toolsAfter = await cdp.eval(`document.querySelector('input[aria-label="Allowed tools"]')?.value ?? null`);
  check('typing into Allowed tools + blur keeps the typed value (does not snap back)',
    toolsAfter === 'Bash, Read', `before=${JSON.stringify(toolsBefore)} after=${JSON.stringify(toolsAfter)}`);
  const toolsOverride = await cdp.eval(`window.__station.state.overrides.allowedTools ?? null`);
  check('and it is recorded as a real local override',
    Array.isArray(toolsOverride) && toolsOverride.join(',') === 'Bash,Read', toolsOverride);

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
