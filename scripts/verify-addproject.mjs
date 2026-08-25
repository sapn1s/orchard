/**
 * Add-project UX — the fs/dirs route, the whitespace context menu, and the
 * full browse-and-add flow in a real browser (navigate into a fixture dir
 * under $HOME, add it, see it registered with the server cross-checked).
 *
 *   node scripts/verify-addproject.mjs
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
const PORT = Number(process.env.VERIFY_ADDPROJECT_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ap-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ap-chrome-'));
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

  // Fixture dir directly under $HOME so the browser can REACH it by clicking.
  const fixName = `cs-addproj-${Date.now().toString(36)}`;
  const fixture = path.join(os.homedir(), fixName);
  fs.mkdirSync(path.join(fixture, '.git'), { recursive: true }); // so the git tag shows
  cleanupDirs.push(fixture);

  console.log('\n=== fs/dirs route ===');
  const home = await (await fetch(`${BASE}/api/fs/dirs`)).json();
  check('defaults to $HOME, lists the fixture dir with its git tag, hides dotdirs',
    home.path === os.homedir()
      && home.dirs.some((d) => d.name === fixName && d.hasGit === true)
      && !home.dirs.some((d) => d.name.startsWith('.')),
    `path=${home.path}, fixture=${JSON.stringify(home.dirs.find((d) => d.name === fixName))}`);
  const tilde = await (await fetch(`${BASE}/api/fs/dirs?path=${encodeURIComponent(`~/${fixName}`)}`)).json();
  check('~ expands; empty dir answers honestly', tilde.path === fixture && tilde.dirs.length === 1 && tilde.dirs[0].name === '.git'.replace('.git', '') || (tilde.path === fixture && tilde.dirs.length === 0),
    JSON.stringify({ path: tilde.path, dirs: tilde.dirs }));
  const missing = await fetch(`${BASE}/api/fs/dirs?path=/no/such/dir/anywhere`);
  check('a missing path is a 404 with words, not an empty list', missing.status === 404, `HTTP ${missing.status}`);

  console.log('\n=== whitespace menu + browse-and-add (real browser) ===');
  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--window-size=1280,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  // #tree exists in the static HTML — wait for the APP (listeners attached),
  // not the element, or the dispatch below races module execution.
  await cdp.waitFor('boot', `window.__station !== undefined`);

  // Right-click the tree's whitespace → menu.
  await cdp.eval(`(() => {
    const t = document.querySelector('#tree');
    const r = t.getBoundingClientRect();
    t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.bottom - 10 }));
  })()`);
  const menuUp = await cdp.waitFor('tree menu', `document.querySelector('#treeMenu').classList.contains('open')`);
  check('right-clicking the list whitespace opens the actions menu', menuUp,
    await cdp.eval(`document.querySelector('#treeMenu').className`));

  await cdp.eval(`document.querySelector('#tmAdd').click()`);
  const pickerUp = await cdp.waitFor('picker', `document.querySelector('#picker').classList.contains('open')`);
  check('"Add a project…" opens the picker (and closes the menu)',
    pickerUp && !(await cdp.eval(`document.querySelector('#treeMenu').classList.contains('open')`)),
    JSON.stringify({ pickerUp }));

  // Flip to browse (starts at $HOME), descend into the fixture, add it.
  await cdp.eval(`document.querySelector('#pickMode').click()`);
  await cdp.waitFor('browse at home', `document.querySelector('#pickPath').value === ${JSON.stringify(os.homedir())}`);
  const descended = await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('#pickList .prow.dir')].find((b) => b.textContent.includes(${JSON.stringify(fixName)}));
    if (!row) return false;
    row.click(); return true;
  })()`);
  await cdp.waitFor('inside fixture', `document.querySelector('#pickPath').value === ${JSON.stringify(fixture)}`);
  check('clicking a directory descends into it (path field follows)', descended === true,
    await cdp.eval(`document.querySelector('#pickPath').value`));

  await cdp.eval(`document.querySelector('#pickList .prow.here').click()`);
  const added = await cdp.waitFor('project registered', `window.__station.state.projects.some((p) => p.hostPath === ${JSON.stringify(fixture)})`);
  const serverSays = await (await fetch(`${BASE}/api/projects`)).json();
  check('"+ Add this directory" registers the project (server cross-checked)',
    added && serverSays.projects.some((p) => p.hostPath === fixture),
    JSON.stringify(serverSays.projects.map((p) => p.hostPath)));

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
