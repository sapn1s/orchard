/**
 * BUG-084 — the model-observer must NOT flag the user's OWN /model override as a
 * per-turn "silent switch". The baseline a per-turn `model-observed` report is
 * judged against is what the USER SELECTED (`state.overrides.model`), not the
 * configured default the CLI reports at `session-init` (e.g. Fable from
 * settings.json). When the live wire model matches the user's explicit choice,
 * it is the user's own model answering — never a change — even though the stale
 * init-seeded expectation disagrees.
 *
 *   npm run verify:bug-084
 *
 * Drives the REAL app (brave --headless=new over raw CDP, the same rig
 * verify:bug-081 / verify:bug-067 use) against a REAL server, exercising the
 * app's OWN dispatcher (window.__station.onEvent) and its OWN render site
 * (flagModelChange → `.model-change`). Each scenario runs in a fresh page
 * (Page.navigate re-boots module state: expectedLiveModel/liveWireModel = null),
 * seeds the baseline expectation via the always-flag `model-changed` path, wipes
 * the seed's render, sets the user's explicit selection, then fires the TEST
 * dispatch and asserts whether a NEW `.model-change` notice rendered.
 *
 * MUST-FAIL pre-fix: scenario 1 (live == the user's explicit choice) renders a
 * "per-turn report" notice on today's code — the exact false positive this
 * ticket fixes — so "no notice when live matches the user's selection" FAILS
 * before the fix and PASSES after.
 *
 * Anti-regression, all must STILL hold post-fix:
 *   2  a GENUINE silent switch (live ≠ the user's selection) STILL flags.
 *   3  a real `model_refusal_fallback` (model-changed) STILL flags.
 *   4  with NO explicit override, an unexplained wire change STILL flags.
 *
 * Process hygiene: OS-assigned free port (never 4317). Kill children by PID only,
 * never pkill.
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
const PORT = Number(process.env.VERIFY_BUG_084_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b084-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b084-store-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b084-chrome-'));
const BRAVE = process.env.VERIFY_BUG_084_BROWSER ?? 'brave';

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : (fail++, failures.push(name));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- raw CDP */
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
      try { if (await this.eval(expr)) return true; } catch { /* mid-navigation */ }
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

/* ------------------------------------------------------------- processes */
let server = null, browser = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

/**
 * One scenario, in a fresh page:
 *   seedModel      — baseline expectation, seeded via the always-flag
 *                    `model-changed` path (then its render is wiped); null = leave
 *                    expectedLiveModel null.
 *   overrideModel  — the user's explicit /model selection (state.overrides.model);
 *                    null = the user made NO explicit choice.
 *   testEvent      — the StationEvent literal to dispatch as the TEST.
 * Returns { rendered, text, info } where `rendered` = a NEW `.model-change`
 * notice appeared for the test dispatch.
 */
async function scenario(cdp, { seedModel, overrideModel, testEvent }) {
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  const booted = await cdp.waitFor('app boot', 'window.__station && !!window.__station.onEvent', 30_000);
  if (!booted) throw new Error('app never booted in the page');
  const seed = seedModel
    ? `S.onEvent({ t: 'model-changed', from: 'x-prev', to: ${JSON.stringify(seedModel)}, reason: 'refusal-fallback' });`
    : '';
  const setOverride = overrideModel == null
    ? 'delete S.state.overrides.model;'
    : `S.state.overrides.model = ${JSON.stringify(overrideModel)};`;
  return cdp.eval(`(() => {
    const S = window.__station;
    S.state.threads.delete('main');
    document.querySelectorAll('#panes .pane[data-thread="main"]').forEach((p) => p.remove());
    S.state.viewing = 'main';
    S.state.overrides = S.state.overrides || {};
    ${seed}
    // wipe the seed's rendered notice — only the TEST dispatch's render counts.
    document.querySelectorAll('#panes .pane[data-thread="main"] .model-change').forEach((n) => n.remove());
    ${setOverride}
    ${testEvent}
    const pane = document.querySelector('#panes .pane[data-thread="main"]');
    const mc = pane ? pane.querySelector('.model-change') : null;
    return {
      rendered: !!mc,
      text: mc ? mc.textContent.replace(/\\s+/g, ' ').trim() : '',
      info: S.modelChipInfo(),
    };
  })()`);
}

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  browser = spawn(BRAVE, [
    '--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--window-size=1280,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  if (!devPort) throw new Error('browser never wrote DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const pageT = targets.find((t) => t.type === 'page');
  const cdp = await Cdp.connect(pageT.webSocketDebuggerUrl);
  await cdp.send('Page.enable');

  // 1 — THE FALSE POSITIVE. Configured default = Fable (seeded baseline), the
  // user's explicit /model choice = opus, the wire reports opus. It is the
  // user's own model answering → NO notice. MUST-FAIL pre-fix (renders today).
  console.log('\n=== 1 — live == the user\'s explicit /model choice (the false positive) ===');
  const s1 = await scenario(cdp, {
    seedModel: 'claude-fable-5',
    overrideModel: 'claude-opus-4-8',
    testEvent: `S.onEvent({ t: 'model-observed', model: 'claude-opus-4-8' });`,
  });
  check('MUST-FAIL pre-fix: NO per-turn "model changed" notice when live matches the user\'s own /model override',
    s1.rendered === false, { rendered: s1.rendered, text: s1.text, info: s1.info });

  // 1b — same, but the override is a canonical id while the wire id is dated
  // (the realistic pairing). sameModel() containment must still recognise it.
  console.log('\n=== 1b — override canonical vs dated wire id (same model, must not flag) ===');
  const s1b = await scenario(cdp, {
    seedModel: 'claude-fable-5',
    overrideModel: 'claude-opus-4-8',
    testEvent: `S.onEvent({ t: 'model-observed', model: 'claude-opus-4-8-20250101' });`,
  });
  check('no notice when the dated wire id matches the user\'s canonical /model choice',
    s1b.rendered === false, { rendered: s1b.rendered, text: s1b.text });

  // 2 — a GENUINE silent switch: the user chose opus, the wire reports sonnet.
  // Unexplained, not the user's choice → MUST still flag.
  console.log('\n=== 2 — genuine silent switch (live != the user\'s selection) still surfaces ===');
  const s2 = await scenario(cdp, {
    seedModel: 'claude-opus-4-8',
    overrideModel: 'claude-opus-4-8',
    testEvent: `S.onEvent({ t: 'model-observed', model: 'claude-sonnet-5' });`,
  });
  check('a wire model that differs from the user\'s selection STILL renders a per-turn notice',
    s2.rendered === true && /sonnet/i.test(s2.text), { rendered: s2.rendered, text: s2.text });

  // 3 — a real model_refusal_fallback (model-changed) is always flagged (FEAT-042
  // / BUG-081). The fix must not touch this dedicated push signal.
  console.log('\n=== 3 — real refusal fallback (model-changed) still surfaces ===');
  const s3 = await scenario(cdp, {
    seedModel: null,
    overrideModel: 'claude-opus-4-8', // even WITH a matching override, a refusal-fallback is a real event
    testEvent: `S.onEvent({ t: 'model-changed', from: 'claude-fable-5', to: 'claude-opus-4-8', reason: 'refusal-fallback', category: 'cyber' });`,
  });
  check('a model_refusal_fallback STILL renders a "refusal fallback" notice',
    s3.rendered === true && /refusal fallback/i.test(s3.text) && /cyber/i.test(s3.text),
    { rendered: s3.rendered, text: s3.text });

  // 4 — NO explicit override: an unexplained wire change IS worth flagging (the
  // user did not ask for it). The fix keys on the user's selection, so the
  // no-selection path is unchanged.
  console.log('\n=== 4 — no explicit override: an unexplained wire change still surfaces ===');
  const s4 = await scenario(cdp, {
    seedModel: 'claude-fable-5',
    overrideModel: null,
    testEvent: `S.onEvent({ t: 'model-observed', model: 'claude-opus-4-8' });`,
  });
  check('with NO user /model choice, a wire change off the baseline STILL renders a notice',
    s4.rendered === true, { rendered: s4.rendered, text: s4.text });

  cdp.close();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(() => {
  stopByPid(browser);
  stopByPid(server);
  setTimeout(() => {
    for (const d of [DATA, STORE, PROFILE]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
    process.exit(process.exitCode ?? 0);
  }, 1500);
});
