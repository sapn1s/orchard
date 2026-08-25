/**
 * Edit/Write diff chips — a recorded Edit tool call expands into a rendered
 * change (dimmed removals, moss additions, common lines trimmed) instead of
 * the raw JSON envelope; non-edit tools keep the raw view.
 *
 *   node scripts/verify-diffchips.mjs
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
const PORT = Number(process.env.VERIFY_DIFFCHIPS_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dc-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dc-chrome-'));
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

  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dc-proj-'));
  cleanupDirs.push(projDir);
  const store = path.join(os.homedir(), '.claude', 'projects', projDir.replace(/[/.]/g, '-'));
  fs.mkdirSync(store, { recursive: true });
  cleanupDirs.push(store);
  const sid = '55555555-6666-4777-a888-999999999999';
  const T = (n) => new Date(1700000000000 + n * 1000).toISOString();
  const uid = (n) => `00000000-0000-4000-b000-${String(n).padStart(12, '0')}`;
  // An Edit whose old/new share a first and last line — the diff must trim
  // them and show only the changed middle.
  const oldStr = 'keep top\nred line one\nred line two\nkeep bottom';
  const newStr = 'keep top\ngreen line\nkeep bottom';
  const lines = [
    JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', uuid: uid(1), timestamp: T(1), sessionId: sid,
      message: { role: 'user', content: [{ type: 'text', text: 'please edit the file' }] } }),
    JSON.stringify({ parentUuid: uid(1), isSidechain: false, type: 'assistant', uuid: uid(2), timestamp: T(2), sessionId: sid,
      message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: '/x/y.ts', old_string: oldStr, new_string: newStr } },
        { type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'echo hi' } },
      ] } }),
  ];
  fs.writeFileSync(path.join(store, `${sid}.jsonl`), lines.join('\n') + '\n');
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: projDir, name: 'dc-fixture' }),
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
  await cdp.send('Page.navigate', { url: `${BASE}/#/project/${reg.project.id}/session/${sid}?dir=${encodeURIComponent(path.basename(store))}` });
  await cdp.waitFor('transcript', `document.querySelector('#panes .pane .claude') !== null`, 30_000);

  console.log('\n=== diff chips ===');
  const d = await cdp.eval(`(() => {
    const chips = [...document.querySelectorAll('#panes .tool')];
    const edit = chips.find((c) => c.querySelector('.nm')?.textContent === 'Edit');
    const bash = chips.find((c) => c.querySelector('.nm')?.textContent === 'Bash');
    return {
      editHasDiff: !!edit?.querySelector('.diff'),
      dels: [...(edit?.querySelectorAll('.diff .dl.del') ?? [])].map((n) => n.textContent),
      adds: [...(edit?.querySelectorAll('.diff .dl.add') ?? [])].map((n) => n.textContent),
      editRawJson: /old_string/.test(edit?.querySelector('.out pre')?.textContent ?? ''),
      bashHasDiff: !!bash?.querySelector('.diff'),
      bashRaw: (bash?.querySelector('.out pre')?.textContent ?? '').slice(0, 40),
    };
  })()`);
  check('Edit chip renders a diff: shared top/bottom lines trimmed, only the change shown',
    d.editHasDiff
      && d.dels.length === 2 && d.dels[0].includes('red line one') && d.dels[1].includes('red line two')
      && d.adds.length === 1 && d.adds[0].includes('green line')
      && !d.dels.some((x) => x.includes('keep top')) && !d.adds.some((x) => x.includes('keep bottom')),
    JSON.stringify({ dels: d.dels, adds: d.adds }));
  check('…and the raw JSON envelope is gone from the Edit chip', d.editRawJson === false, `raw json present: ${d.editRawJson}`);
  check('a non-edit tool (Bash) keeps its raw input view, no diff', !d.bashHasDiff && d.bashRaw.includes('command'), JSON.stringify({ bashHasDiff: d.bashHasDiff, bashRaw: d.bashRaw }));

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
