/**
 * BUG-013 — after a budget stop, the composer must LOCK (visible reason,
 * cannot be used to send), and a rejected send must NEVER leave a phantom
 * "delivered" you-bubble in the transcript.
 *
 * Repro this closed: maxBudgetUsd is set to a fraction of a cent via a
 * session override, so ONE real cheap haiku turn already crosses it. The
 * server's result handler then sets `budgetStopped=true` and emits a
 * non-fatal `{t:'error', budgetStopped:true}` (agent-bridge.ts ~1093-1104).
 * Before the fix: turn-end had already set busy=false, app.js had zero
 * handling for `budgetStopped`, so the composer re-enabled itself; a second
 * send painted an optimistic "you" bubble, the server's `session.send()`
 * threw 'session stopped: budget exceeded' (agent-bridge.ts ~570), and the
 * bubble stayed in the transcript looking delivered forever.
 *
 *   node scripts/verify-budget-stop.mjs      (runs ONE cheap haiku turn)
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
const PORT = Number(process.env.VERIFY_BUDGET_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b-chrome-'));
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

  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b-proj-'));
  cleanupDirs.push(projDir);
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: projDir, name: 'budget-fixture' }),
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

  console.log('\n=== budget-stop: one cheap real turn trips a near-zero maxBudgetUsd ===');
  // A near-zero cap means the FIRST real turn's cost (however tiny) already
  // crosses it — no need to guess a model's per-token price.
  await cdp.eval(`(() => {
    const st = window.__station.state;
    st.overrides.model = 'haiku';
    st.overrides.maxBudgetUsd = 0.000001;
    document.querySelector('#prompt').value = 'Write one short sentence about rivers.';
    document.querySelector('#go').click();
  })()`);
  const busy = await cdp.waitFor('turn running', `window.__station.state.busy === true`, 30_000);
  if (!busy) throw new Error('turn never started');
  const idle = await cdp.waitFor('turn finished', `window.__station.state.busy === false`, 60_000);
  if (!idle) throw new Error('first turn never finished');

  const locked = await cdp.waitFor('budget lock latched', `window.__station.state.budgetLocked === true`, 15_000);
  check('the client latches state.budgetLocked after the budget-stop event', locked,
    await cdp.eval(`({ budgetLocked: window.__station.state.budgetLocked, reason: window.__station.state.budgetLockReason })`));

  const composer = await cdp.eval(`({
    boxHidden: document.querySelector('#box').hidden,
    lockPanelHidden: document.querySelector('#budgetLocked').hidden,
    lockText: document.querySelector('#budgetLocked').textContent,
  })`);
  check('the composer box is hidden and a visible lock banner with a reason takes its place',
    composer.boxHidden === true && composer.lockPanelHidden === false && /budget/i.test(composer.lockText),
    JSON.stringify(composer));

  const beforeBubbles = await cdp.eval(`[...document.querySelectorAll('#panes .you')].length`);

  console.log('\n=== budget-stop: attempting to send anyway must not leave a phantom bubble ===');
  // Real-user path: type into the (now hidden) composer and press Enter —
  // exercises the same submit() a bypassed/late click would. `hidden` only
  // stops rendering; the element and its listeners are still live, which is
  // exactly the scenario a race (click fired just before the lock latched)
  // would look like.
  await cdp.eval(`(() => {
    const p = document.querySelector('#prompt');
    p.value = 'This must never reach Claude — the session is budget-locked.';
    p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })()`);
  await sleep(1000); // let any (incorrect) optimistic paint + rejection round-trip settle

  const after = await cdp.eval(`({
    busy: window.__station.state.busy,
    bubbles: [...document.querySelectorAll('#panes .you')].length,
    bubbleTexts: [...document.querySelectorAll('#panes .you p')].map((n) => n.textContent),
    promptValue: document.querySelector('#prompt').value,
  })`);
  check('no new "you" bubble was added for the refused send (no phantom delivered message)',
    after.bubbles === beforeBubbles && !after.bubbleTexts.some((t) => t.includes('must never reach Claude')),
    JSON.stringify(after));
  check('the composer did not end up spinning/busy for a message that was never sent',
    after.busy === false, JSON.stringify({ busy: after.busy }));

  // Confirm on the SERVER side too: the second prompt never reached the
  // transcript file the SDK writes to (the ultimate source of truth).
  const sid = await cdp.eval(`window.__station.state.current.sessionId`);
  const dir = await cdp.eval(`window.__station.state.current.encodedDir`);
  await sleep(1000);
  const t = await (await fetch(`${BASE}/api/transcript/${encodeURIComponent(dir)}/${encodeURIComponent(sid)}?tail=200`)).json();
  const texts = (t.messages ?? []).flatMap((m) => (m.blocks ?? []).filter((b) => b.type === 'text').map((b) => `${m.role}:${b.text}`));
  check('the refused message never reached the model / never landed in the transcript on disk',
    !texts.some((x) => x.includes('must never reach Claude')),
    JSON.stringify(texts.slice(-4)));

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
