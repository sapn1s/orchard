/**
 * BUG-081 — the "model changed: <from> → <to> (refusal fallback · <category>)"
 * transcript notice must render as a DISTINCT, accented inline marker (a centred
 * hairline pill with an amber --st-needs accent), not as a plain body-coloured
 * line that blends into the conversation. It must keep the full from → to → reason
 * information.
 *
 *   npm run verify:bug-081
 *
 * Drives a REAL browser (brave --headless=new over raw CDP; the same rig
 * verify:bug-067 / verify:streaming-md use) against a REAL server, then exercises
 * the app's OWN render site.
 *
 * Reconciliation with BUG-067: the harness-notice path (task-notification /
 * [station]) flows through renderMessages() and is exercised by both applyAppend
 * (live) and a direct renderMessages (history). The model-change notice is
 * DIFFERENT: it is a LIVE-only marker — the SDK emits a `model-changed` /
 * `model-observed` SSE event which the client turns into a DOM append via
 * flagModelChange(); it is NOT persisted as a transcript block, so there is no
 * history/reload replay. We therefore exercise the TWO entry points that actually
 * reach the render site:
 *   PATH A — the authentic live SSE dispatch: onEvent({ t:'model-changed', … })
 *   PATH B — the render primitive directly: flagModelChange(from, to, why)
 * and assert BOTH produce the accented chip. (A single render site, honestly:
 * unlike BUG-067 there is no second, persisted path.)
 *
 * Must-FAIL pre-fix: on today's code the model-change line is a plain
 * `.ran-lbl.model-change` div coloured `--ink` — the SAME colour as ordinary
 * message prose — with no `.mc-chip`. So "computed colour differs from body" and
 * "rendered as a pill chip" both FAIL before the fix.
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
const PORT = Number(process.env.VERIFY_BUG_081_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b081-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b081-store-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b081-chrome-'));
const BRAVE = process.env.VERIFY_BUG_081_BROWSER ?? 'brave';

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
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  // Gate only on onEvent — the AUTHENTIC live SSE entry point, present pre-fix
  // too, so PATH A's must-FAIL assertions actually run on unfixed code (where
  // flagModelChange is not yet exposed on window.__station).
  const booted = await cdp.waitFor('app boot', 'window.__station && !!window.__station.onEvent', 30_000);
  if (!booted) throw new Error('app never booted in the page');

  // Reset the main thread so the notice renders into a clean pane, capture the
  // rendered model-change element, and — for the colour baseline — a real .prose
  // node attached to the SAME pane so CSS custom properties resolve identically.
  const PROBE = (drive) => `(() => {
    const S = window.__station;
    S.state.threads.delete('main');
    document.querySelectorAll('#panes .pane[data-thread="main"]').forEach((p) => p.remove());
    S.state.viewing = 'main';
    ${drive}
    const pane = document.querySelector('#panes .pane[data-thread="main"]');
    if (!pane) return { error: 'no main pane' };
    const mc = pane.querySelector('.model-change');
    if (!mc) return { error: 'no .model-change element rendered' };
    // Body baseline: a real prose node in the same pane (ordinary message text).
    const probe = document.createElement('div');
    probe.className = 'prose';
    probe.textContent = 'ordinary message';
    pane.appendChild(probe);
    const cs = getComputedStyle(mc);
    const bodyColor = getComputedStyle(probe).color;
    const chip = mc.querySelector('.mc-chip');
    probe.remove();
    return {
      text: mc.textContent.replace(/\\s+/g, ' ').trim(),
      color: cs.color,
      textAlign: cs.textAlign,
      bodyColor,
      hasChip: !!chip,
      chipBorderRadius: chip ? getComputedStyle(chip).borderTopLeftRadius : null,
      chipTitle: chip ? (chip.getAttribute('title') || '') : '',
    };
  })()`;

  console.log('\n=== PATH A — live SSE dispatch: onEvent({ t:"model-changed" }) ===');
  const a = await cdp.eval(PROBE(`
    S.onEvent({ t: 'model-changed', from: 'fable', to: 'claude-opus-4-8-20250101', reason: 'refusal-fallback', category: 'cyber' });
  `));
  if (a.error) throw new Error(`PATH A: ${a.error}`);
  runAssertions('live', a, { from: 'fable', to: 'opus', reason: 'refusal fallback', cat: 'cyber' });

  const primitiveExposed = await cdp.eval('typeof window.__station.flagModelChange === "function"');
  if (!primitiveExposed) {
    check('PATH B — flagModelChange render primitive is exposed (pre-fix it is not — expected FAIL before the fix)',
      false, 'flagModelChange not on window.__station');
  } else {
    console.log('\n=== PATH B — render primitive: flagModelChange(from, to, why) ===');
    const b = await cdp.eval(PROBE(`
      S.flagModelChange('sonnet', 'claude-opus-4-8-20250101', 'per-turn report');
    `));
    if (b.error) throw new Error(`PATH B: ${b.error}`);
    runAssertions('primitive', b, { from: 'sonnet', to: 'opus', reason: 'per-turn report', cat: null });

    console.log('\n=== long-reason tooltip fallback ===');
    const c = await cdp.eval(PROBE(`
      S.flagModelChange('fable', 'claude-opus-4-8-20250101', 'refusal fallback · a-very-long-category-name-that-overflows');
    `));
    if (c.error) throw new Error(`long-reason: ${c.error}`);
    check('long reason collapses inline to "fallback" but the FULL reason is in the chip title',
      c.hasChip && /fallback/.test(c.text) && c.chipTitle.includes('a-very-long-category-name-that-overflows'),
      { text: c.text, title: c.chipTitle });

    check('the two entry points agree (both accented, both distinct from body)',
      a.color === b.color && a.color !== a.bodyColor && b.color !== b.bodyColor,
      { liveColor: a.color, primitiveColor: b.color, body: a.bodyColor });
  }

  cdp.close();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

function runAssertions(tag, o, want) {
  const txt = o.text.toLowerCase();
  const title = o.chipTitle.toLowerCase();
  check(`[${tag}] the notice carries the distinct .model-change class`,
    o.text.startsWith('◇') || /model changed/.test(txt), o.text);
  check(`[${tag}] MUST-FAIL pre-fix: computed colour DIFFERS from ordinary body text`,
    o.color !== o.bodyColor, { color: o.color, bodyColor: o.bodyColor });
  check(`[${tag}] MUST-FAIL pre-fix: rendered as a pill chip (.mc-chip present, rounded)`,
    o.hasChip && o.chipBorderRadius && parseFloat(o.chipBorderRadius) >= 20, { hasChip: o.hasChip, radius: o.chipBorderRadius });
  check(`[${tag}] it is centred (station chrome, not a left-aligned prose line)`,
    o.textAlign === 'center', o.textAlign);
  check(`[${tag}] from → to → reason content all present`,
    txt.includes(want.from) && txt.includes(want.to) && o.text.includes('→') && txt.includes(want.reason) && (!want.cat || txt.includes(want.cat)),
    o.text);
  check(`[${tag}] full "from → to (reason)" line is available as the chip tooltip`,
    title.includes(want.from) && title.includes(want.to) && title.includes(want.reason),
    o.chipTitle);
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
