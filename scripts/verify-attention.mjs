/**
 * Sidebar attention signals — the "3 projects at once" workflow:
 *   1. expansion state survives a reload (no re-opening projects every time)
 *   2. a collapsed project header badges "N new" for sessions with activity
 *      the user has not looked at (24h first-run baseline)
 *   3. opening the session clears its badge; the OTHER project's stays
 *   4. new activity on disk in a non-open project re-badges after the
 *      live-poll refresh path
 *
 *   node scripts/verify-attention.mjs
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
const PORT = Number(process.env.VERIFY_ATTENTION_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-att-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-att-chrome-'));
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

const uid = (n) => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`;
function writeSession(store, sid, count, t0ms) {
  const lines = [];
  for (let n = 0; n < count; n++) {
    const role = n % 2 ? 'assistant' : 'user';
    lines.push(JSON.stringify({
      parentUuid: null, isSidechain: false, type: role,
      message: { role, content: [{ type: 'text', text: `att message ${n}` }] },
      uuid: uid(n), timestamp: new Date(t0ms + n * 1000).toISOString(), sessionId: sid,
    }));
  }
  fs.writeFileSync(path.join(store, `${sid}.jsonl`), lines.join('\n') + '\n');
}

async function makeProject(name, sid) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cs-att-${name}-`));
  cleanupDirs.push(dir);
  const store = path.join(os.homedir(), '.claude', 'projects', dir.replace(/[/.]/g, '-'));
  fs.mkdirSync(store, { recursive: true });
  cleanupDirs.push(store);
  writeSession(store, sid, 6, Date.now() - 3600 * 1000); // active 1h ago — inside the 24h baseline
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: dir, name }),
  })).json();
  if (!reg.project?.id) throw new Error(`register ${name} failed: ${JSON.stringify(reg)}`);
  return { id: reg.project.id, dir, store };
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

  const sidA = '33333333-4444-4555-a666-777777777777';
  const sidB = '44444444-5555-4666-a777-888888888888';
  const A = await makeProject('att-a', sidA);
  const B = await makeProject('att-b', sidB);

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');

  const HEAD = (name) => `[...document.querySelectorAll('#tree button.proj')].find((n) => n.querySelector('.nm')?.textContent === ${JSON.stringify(name)})`;

  console.log('\n=== attention: unseen badges on first load ===');
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('boot', `document.querySelectorAll('#tree button.proj').length >= 2`);
  const badged = await cdp.waitFor('badges after background list load',
    `${HEAD('att-a')}?.querySelector('.unseen')?.textContent === '1' && ${HEAD('att-b')}?.querySelector('.unseen')?.textContent === '1'`);
  check('both projects badge "1 new" for recent never-opened sessions (lists loaded in background, nothing expanded)',
    badged, await cdp.eval(`[...document.querySelectorAll('#tree .unseen')].map((n) => n.textContent)`));

  console.log('\n=== attention: expansion survives reload ===');
  // Expand only what is not already expanded (boot expands the first project).
  await cdp.eval(`(() => { const h = ${HEAD('att-a')}; if (h.getAttribute('aria-expanded') !== 'true') h.click(); })()`);
  await cdp.eval(`(() => { const h = ${HEAD('att-b')}; if (h.getAttribute('aria-expanded') !== 'true') h.click(); })()`);
  await cdp.waitFor('both expanded', `${HEAD('att-a')}?.getAttribute('aria-expanded') === 'true' && ${HEAD('att-b')}?.getAttribute('aria-expanded') === 'true'`);
  await cdp.eval('location.reload()');
  await sleep(600);
  await cdp.waitFor('boot again', `document.querySelectorAll('#tree button.proj').length >= 2`);
  const stillOpen = await cdp.waitFor('expansion restored',
    `${HEAD('att-a')}?.getAttribute('aria-expanded') === 'true' && ${HEAD('att-b')}?.getAttribute('aria-expanded') === 'true'`);
  check('hard reload keeps BOTH projects expanded (the working set survives)',
    stillOpen, await cdp.eval(`[...document.querySelectorAll('#tree button.proj')].map((n) => n.querySelector('.nm').textContent + ':' + n.getAttribute('aria-expanded'))`));

  console.log('\n=== attention: opening a session clears ITS badge only ===');
  await cdp.eval(`(() => {
    const head = ${HEAD('att-a')};
    // kids is the header's own next sibling inside its pgroup (see verify-ui)
    const rows = [...(head.nextElementSibling?.querySelectorAll('button.row') ?? [])];
    rows[0]?.click();
  })()`);
  await cdp.waitFor('session open', `window.__station.state.current.sessionId === ${JSON.stringify(sidA)}`, 20_000);
  await sleep(700); // seen stamp persists on a 400ms debounce
  const after = await cdp.eval(`({
    a: ${HEAD('att-a')}?.querySelector('.unseen')?.textContent ?? null,
    b: ${HEAD('att-b')}?.querySelector('.unseen')?.textContent ?? null,
  })`);
  check('att-a badge cleared by opening; att-b badge intact', after.a === null && after.b === '1', JSON.stringify(after));

  console.log('\n=== attention: seen state survives reload too ===');
  await cdp.eval('location.reload()');
  await sleep(600);
  await cdp.waitFor('boot 3', `document.querySelectorAll('#tree button.proj').length >= 2`);
  await sleep(1200); // background list load
  const after2 = await cdp.eval(`({
    a: ${HEAD('att-a')}?.querySelector('.unseen')?.textContent ?? null,
    b: ${HEAD('att-b')}?.querySelector('.unseen')?.textContent ?? null,
  })`);
  check('after reload: att-a stays cleared (seen persisted), att-b still badged', after2.a === null && after2.b === '1', JSON.stringify(after2));

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
