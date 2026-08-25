/**
 * Per-project process visibility — a REAL server spawned with cwd inside a
 * fixture project must list with its listening port, die on the kill route,
 * and the guardrails must hold (self-protection, cwd re-check, bad pids).
 *
 *   node scripts/verify-processes.mjs
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
const PORT = Number(process.env.VERIFY_PROCESSES_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-proc-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-proc-chrome-'));
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

let server = null, browser = null, stray = null, stray2 = null;
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

  // Fixture project + a REAL stray service running from inside it.
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-proc-proj-'));
  cleanupDirs.push(projDir);
  const strayPort = await freePort();
  stray = spawn(process.execPath, ['-e',
    `require('http').createServer((q,s)=>s.end('stray')).listen(${strayPort},'127.0.0.1');setInterval(()=>{},1e6)`],
    { cwd: projDir, stdio: 'ignore', detached: true });
  stray.unref();
  await sleep(600);

  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: projDir, name: 'proc-fixture' }),
  })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  const regSelf = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: ROOT, name: 'station-itself' }),
  })).json();

  console.log('\n=== processes: listing ===');
  const list = (await (await fetch(`${BASE}/api/projects/${pid}/processes`)).json()).processes;
  const mine = list.find((x) => x.pid === stray.pid);
  check('the stray service lists with its pid, command and LISTENING PORT',
    !!mine && mine.ports.includes(strayPort) && /http/.test(mine.command),
    JSON.stringify(mine ?? list.slice(0, 3)));
  const selfList = (await (await fetch(`${BASE}/api/projects/${regSelf.project.id}/processes`)).json()).processes;
  const selfRow = selfList.find((x) => x.self);
  check('the dashboard\'s own server lists under its project, tagged self',
    !!selfRow && selfRow.ports.includes(PORT), JSON.stringify(selfRow ?? selfList.slice(0, 3)));

  console.log('\n=== processes: summary (ambient indicators) ===');
  const summary = (await (await fetch(`${BASE}/api/processes/summary`)).json()).byProject;
  check('one-sweep summary attributes the stray (with port) and the self server to their projects',
    summary[pid]?.count >= 1 && summary[pid].ports.includes(strayPort)
      && summary[regSelf.project.id]?.hasSelf === true && summary[regSelf.project.id].ports.includes(PORT),
    JSON.stringify(summary));

  console.log('\n=== processes: guardrails ===');
  const killSelf = await fetch(`${BASE}/api/projects/${regSelf.project.id}/processes/${selfRow.pid}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check('killing the dashboard\'s own server is refused with words', killSelf.status === 400,
    `HTTP ${killSelf.status}: ${JSON.stringify((await killSelf.json()).error)}`);
  const killForeign = await fetch(`${BASE}/api/projects/${pid}/processes/1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check('pid 1 / out-of-project pids are refused', killForeign.status === 400 || killForeign.status === 409, `HTTP ${killForeign.status}`);

  console.log('\n=== processes: kill through the UI flow ===');
  const killed = await (await fetch(`${BASE}/api/projects/${pid}/processes/${stray.pid}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  await sleep(800);
  let alive = true;
  try { process.kill(stray.pid, 0); } catch { alive = false; }
  const relist = (await (await fetch(`${BASE}/api/projects/${pid}/processes`)).json()).processes;
  check('SIGTERM by pid: process really dead, re-list from /proc confirms',
    killed.killed === stray.pid && !alive && !relist.some((x) => x.pid === stray.pid),
    JSON.stringify({ killed, alive, relisted: relist.length }));

  console.log('\n=== drawer group + ambient chips (real browser) ===');
  // A fresh stray for the browser phase — the first one was verifiably killed.
  const stray2Port = await freePort();
  stray2 = spawn(process.execPath, ['-e',
    `require('http').createServer((q,s)=>s.end('stray2')).listen(${stray2Port},'127.0.0.1');setInterval(()=>{},1e6)`],
    { cwd: projDir, stdio: 'ignore', detached: true });
  stray2.unref();
  await sleep(600);
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
  // Ambient chips: visible with NOTHING expanded and no drawer open.
  const chipUp = await cdp.waitFor('header chips', `[...document.querySelectorAll('#tree .proj .procn')].length >= 2`);
  const chips = await cdp.eval(`[...document.querySelectorAll('#tree .proj .procn')].map((n) => n.textContent)`);
  // The station project's chip shows its LOWEST port — on a machine where the
  // real dashboard (4317) also runs from ROOT, that wins over the scratch
  // server's ephemeral port. Assert the fixture's port exactly, and that the
  // station project shows a port chip at all.
  check('sidebar headers show ambient chips (listening ports) with no submenu open',
    chipUp && chips.some((c) => c.includes(`:${stray2Port}`)) && chips.some((c) => /^:\d+/.test(c) && !c.includes(`:${stray2Port}`)),
    JSON.stringify({ chips, fixturePort: stray2Port }));
  const crown = await cdp.eval(`(() => { const b = document.querySelector('#procBtn'); return { hidden: b.hidden, text: document.querySelector('#procN')?.textContent }; })()`);
  check('crown chip shows the current project\'s running count and port',
    crown.hidden === false && /procs?/.test(crown.text ?? '') && crown.text.includes(`:${stray2Port}`), JSON.stringify(crown));
  // Select the station project (has the self-tagged server) and open settings.
  await cdp.eval(`(async () => { window.__station.state.current.projectId = ${JSON.stringify(regSelf.project.id)}; await window.__station.drawer.open('settings'); })()`);
  const grpUp = await cdp.waitFor('running-here group', `[...document.querySelectorAll('#vSettings .grp-l')].some((n) => n.textContent === 'Running here') && document.querySelectorAll('#vSettings .procrow').length > 0`);
  const rowText = await cdp.eval(`[...document.querySelectorAll('#vSettings .procrow')].map((r) => r.textContent)`);
  check('drawer shows the processes with the self row refusing to offer a stop',
    grpUp && rowText.some((t) => /own server/.test(t) && /won’t stop itself/.test(t)),
    rowText.map((t) => t.slice(0, 60)).join(' || ').slice(0, 300));
  cdp.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exitCode = 1;
}).finally(() => {
  stopByPid(stray);
  stopByPid(stray2);
  stopByPid(browser);
  stopByPid(server);
  setTimeout(() => {
    for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }, 2500);
});
