/**
 * BUG-100 — the composer footer (#fine) must keep its stable isolation/access
 * label and NEVER adopt the raw text of a running command.
 *
 *   node scripts/verify-bug-100-footer-label.mjs
 *
 * No OAuth / no real turn: the defect is entirely in how the client renders
 * server events into the footer, so this drives the REAL render paths
 * (window.__station.onEvent + restLabel) over CDP against a real page and
 * asserts on the real DOM.
 *
 * What it proves (must-FAIL pre-fix — the old code did `say(e.status)` and
 * `say(bits.join(' · '))`, dumping the raw command and an unlabelled cost into
 * the footer):
 *   1. Resting: the footer shows the isolation label ("… full access …").
 *   2. A dispatched agent whose command is a long multi-LINE shell heredoc (the
 *      exact shape of the report, over a REALISTIC busy state of 2 running
 *      agents): the footer KEEPS the isolation label + a bounded "N agents
 *      running" indicator; the raw command NEVER appears in the footer; the
 *      footer length stays under the hard cap; the raw command is reachable on
 *      the title.
 *   3. Fuzz: a 2,000-char command routed through the footer stays under the cap
 *      and renders on a SINGLE line that does not spill past the composer.
 *   4. A turn-end run summary no longer displaces the label (the label is
 *      restored) and the cost is labelled as an estimate, not real spend.
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
const PORT = Number(process.env.VERIFY_B100_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b100-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b100-chrome-'));
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';
const SHOT_DIR = '/tmp/iv-orchard';

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
  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
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

// The reported shape: a multi-line heredoc that flashed under the input, with
// the alarming fragments (GUARD_BYPASS / rm -rf) and a mid-word truncation.
const REPORT_CMD = [
  "GUARD_BYPASS=1 rm -rf /tmp/cs-harness-XXXX && mkdir -p /tmp/cs-harness-XXXX/work",
  "node /tmp/cs-harness-XXXX/harness.mjs 2>/tmp/cs-harness-XXXX/err.log & HARNESS=$!",
  "sleep 0.5 && PROMPT='reproduce the sandbox EPERM on AF_UNIX connect inside the workspace'",
  "timeout 120 codex exec --sandbox workspace-write --json --skip-git-repo-check",
].join('\n');
const FORBIDDEN = ['GUARD_BYPASS', 'rm -rf', 'harness.mjs', 'codex exec', 'mkdir'];

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b100-proj-'));
  cleanupDirs.push(projDir);
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: projDir, name: 'b100-fixture' }),
  })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`register failed: ${JSON.stringify(reg)}`);

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--window-size=900,1200', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const tab = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await tab.send('Page.enable');
  await tab.send('Page.navigate', { url: `${BASE}/` });
  await tab.waitFor('boot', `window.__station !== undefined`);
  await tab.waitFor('project selected + composer ready',
    `window.__station.state.current.projectId && document.querySelector('#prompt')`);
  await sleep(500);

  // ---- 1. resting: the footer holds the isolation label ---------------------
  const rest = await tab.eval(`(() => {
    const S = window.__station;
    S.restLabel();
    const fine = document.querySelector('#fine');
    return { label: S.isoLabel(S.currentProject()), fine: fine.textContent, hidden: fine.hidden };
  })()`);
  check('(1) resting footer shows the isolation/access label',
    rest.fine === rest.label && /full access|writes confined|stays on this machine/.test(rest.fine) && !rest.hidden,
    rest);
  await tab.eval(`document.documentElement.dataset.theme = 'light'`);
  await sleep(150);
  await tab.screenshot(path.join(SHOT_DIR, 'footer-after.png')); // idle, light — captured now; agent-running overwrites nothing

  // ---- 2. a dispatched agent runs a long multi-line command -----------------
  // Realistic busy state: the server's running snapshot reports TWO agents in
  // flight (not the minimal one-agent case), and one emits its raw command.
  const busy = await tab.eval(`(() => {
    const S = window.__station;
    S.state.busy = false;                     // the main turn is idle; a detached worker is running
    S.state.snap = { running: [
      { id: 'main', row: 'main', startedAt: Date.now() - 8000 },
      { id: 'a1', row: 'agent', label: 'worker', description: 'harness repair', startedAt: Date.now() - 6000 },
      { id: 'a2', row: 'agent', label: 'worker', description: 'sandbox probe', startedAt: Date.now() - 4000 },
    ] };
    S.onEvent({ t: 'status', status: ${JSON.stringify(REPORT_CMD)} });
    const fine = document.querySelector('#fine');
    return {
      fine: fine.textContent,
      len: fine.textContent.length,
      title: fine.title,
      cap: S.MAX_FINE,
      label: S.isoLabel(S.currentProject()),
    };
  })()`);
  check('(2a) footer KEEPS the isolation label while an agent runs',
    busy.fine.includes(busy.label), busy.fine);
  check('(2b) footer shows a bounded "N agents running" indicator (not the command)',
    /\d+ agents? running/.test(busy.fine), busy.fine);
  const leaked = FORBIDDEN.filter((f) => busy.fine.includes(f));
  check('(2c) the raw command NEVER appears in the footer',
    leaked.length === 0, leaked.length ? `LEAKED: ${leaked.join(', ')} in "${busy.fine}"` : busy.fine);
  check('(2d) footer length stays within the hard cap',
    busy.len <= busy.cap, `len=${busy.len} cap=${busy.cap}`);
  check('(2e) the raw command is still reachable (rides the title/hover)',
    busy.title.includes('GUARD_BYPASS') && busy.title.includes('codex exec'),
    busy.title.slice(0, 80));

  await sleep(150);
  await tab.screenshot(path.join(SHOT_DIR, 'footer-after.png')); // idle+running, light
  await tab.eval(`document.documentElement.dataset.theme = 'dark'`);
  await sleep(200);
  await tab.screenshot(path.join(SHOT_DIR, 'footer-after-dark.png'));
  await tab.eval(`document.documentElement.dataset.theme = 'light'`);
  await sleep(150);

  // ---- 3. fuzz: a 2,000-char command through the footer ---------------------
  const fuzz = await tab.eval(`(() => {
    const S = window.__station;
    S.state.busy = false;
    const huge = Array.from({length: 250}, (_, i) => 'runstep' + i).join(' ; ');
    // Route it through a real say()-backed path (an error notice) — the cap must
    // hold for EVERY caller, whatever the length.
    S.onEvent({ t: 'error', message: huge });
    const fine = document.querySelector('#fine');
    const col = fine.parentElement;
    const fr = fine.getBoundingClientRect();
    const cr = col.getBoundingClientRect();
    return {
      srcLen: huge.length,
      len: fine.textContent.length,
      cap: S.MAX_FINE,
      ellipsis: fine.textContent.endsWith('…'),
      oneLine: fine.scrollHeight <= fine.clientHeight + 1,
      noSpill: fr.right <= cr.right + 1 && fr.left >= cr.left - 1,
      titleHasFull: fine.title.length >= huge.length,
    };
  })()`);
  check('(3a) a 2,000-char command is capped in the footer',
    fuzz.len <= fuzz.cap && fuzz.srcLen > 1500, `srcLen=${fuzz.srcLen} rendered=${fuzz.len} cap=${fuzz.cap}`);
  check('(3b) it is truncated with an ellipsis, not chopped raw', fuzz.ellipsis, fuzz);
  check('(3c) it renders on a single line and does not spill past the composer',
    fuzz.oneLine && fuzz.noSpill, fuzz);
  check('(3d) the full text is preserved on the title', fuzz.titleHasFull, fuzz.titleHasFull);

  // ---- 4. a turn-end run summary must not displace the label ----------------
  const summary = await tab.eval(`(() => {
    const S = window.__station;
    S.state.busy = false;
    S.restLabel();
    S.state.snap = { running: [] };
    S.onEvent({ t: 'turn-end', subtype: 'success', durationMs: 37800, costUsd: 65.5067, numTurns: 3, isError: false, interrupted: false });
    const fine = document.querySelector('#fine');
    const outcome = [...document.querySelectorAll('.turn-outcome')].pop();
    return {
      fine: fine.textContent,
      label: S.isoLabel(S.currentProject()),
      outcomeText: outcome ? outcome.textContent : null,
      outcomeTitle: outcome ? outcome.title : null,
    };
  })()`);
  check('(4a) the run summary does NOT replace the isolation label in the footer',
    summary.fine === summary.label && !/turns|est\./.test(summary.fine), summary.fine);
  check('(4b) the run summary lands in the transcript outcome rail',
    !!summary.outcomeText && /success/.test(summary.outcomeText) && /3 turns/.test(summary.outcomeText),
    summary.outcomeText);
  check('(4c) the cost is labelled as an ESTIMATE, never bare spend',
    !!summary.outcomeText && summary.outcomeText.includes('est.') && summary.outcomeText.includes('~$'),
    summary.outcomeText);
  check('(4d) the outcome carries a "not billed" clarification on hover',
    !!summary.outcomeTitle && /estimate/i.test(summary.outcomeTitle) && /not money|not billed/i.test(summary.outcomeTitle),
    summary.outcomeTitle);

  console.log(`\n  screenshots: ${path.join(SHOT_DIR, 'footer-after.png')} , ${path.join(SHOT_DIR, 'footer-after-dark.png')}`);
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — pass=${pass} fail=${fail}`);
  tab.close();
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => {
  stopByPid(browser);
  stopByPid(server);
  for (const d of cleanupDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});
