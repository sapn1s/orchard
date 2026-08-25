/**
 * FEAT-069 — the add-project picker's live filter. Drives a real browser:
 * open the picker, confirm the filter input exists and is focused, type a
 * substring and watch the rows narrow (scan AND browse modes), confirm the
 * no-match hint, that clearing restores the full list, that up/down highlights
 * a row, and that Enter acts on the highlighted/sole match (adds in scan mode).
 *
 * Must FAIL before the fix: there is no #pickFilter input at all.
 *
 *   node scripts/verify-feat-069-add-project-filter.mjs
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
const PORT = Number(process.env.VERIFY_FEAT069_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f069-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f069-chrome-'));
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
  async safeEval(expr) { try { return await this.eval(expr); } catch { return undefined; } }
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

// Type into the filter and fire the input event the app listens for.
const typeFilter = (v) => `(() => {
  const inp = document.querySelector('#pickFilter');
  if (!inp) return false;
  inp.value = ${JSON.stringify(v)};
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;
// Visible (not-hidden) filterable rows and whether they all match a needle.
const visibleFilterRows = (needle) => `(() => {
  const rows = [...document.querySelectorAll('#pickList .prow[data-filter]')].filter((r) => !r.hidden);
  return {
    count: rows.length,
    allMatch: rows.every((r) => r.dataset.filter.includes(${JSON.stringify(needle.toLowerCase())})),
    names: rows.map((r) => r.textContent.trim().slice(0, 40)),
  };
})()`;
const key = (k) => `document.querySelector('#pickFilter').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }))`;

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  // Scan fixture: a uniquely-named dir under ~/projects (a scan root) so the
  // scan surfaces it deterministically amid the real ones.
  const tag = Date.now().toString(36);
  const scanName = `cs-f069-scan-${tag}`;
  const scanDir = path.join(os.homedir(), 'projects', scanName);
  fs.mkdirSync(path.join(scanDir, '.git'), { recursive: true });
  cleanupDirs.push(scanDir);
  // Browse fixtures: three sibling dirs under $HOME, only one carries the needle.
  const browseNeedle = `zqf069${tag}`;
  const browseHit = `cs-${browseNeedle}-hit`;
  const browseMiss1 = `cs-f069-other-a-${tag}`;
  const browseMiss2 = `cs-f069-other-b-${tag}`;
  for (const n of [browseHit, browseMiss1, browseMiss2]) {
    fs.mkdirSync(path.join(os.homedir(), n), { recursive: true });
    cleanupDirs.push(path.join(os.homedir(), n));
  }

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
  await cdp.waitFor('boot', `window.__station !== undefined`);

  console.log('\n=== filter input exists + focused on open (scan mode) ===');
  await cdp.eval(`document.querySelector('#addProjBtn').click()`);
  await cdp.waitFor('picker', `document.querySelector('#picker').classList.contains('open')`);
  const hasFilter = await cdp.safeEval(`!!document.querySelector('#pickFilter')`);
  check('a #pickFilter input exists in the open picker (FAILS pre-fix)', hasFilter === true, `present=${hasFilter}`);
  const focused = await cdp.safeEval(`document.activeElement === document.querySelector('#pickFilter')`);
  check('the filter is focused on open', focused === true, `focused=${focused}`);

  // Wait for the scan fixture row to appear before filtering.
  await cdp.waitFor('scan fixture row', `[...document.querySelectorAll('#pickList .prow[data-filter]')].some((r) => r.dataset.filter.includes(${JSON.stringify(scanName)}))`);
  const fullCount = (await cdp.safeEval(visibleFilterRows('')))?.count ?? 0;

  console.log('\n=== scan mode: substring narrows to matches only ===');
  await cdp.eval(typeFilter(scanName));
  await cdp.waitFor('narrowed', `[...document.querySelectorAll('#pickList .prow[data-filter]')].filter((r) => !r.hidden).length >= 1 && [...document.querySelectorAll('#pickList .prow[data-filter]')].filter((r) => !r.hidden).every((r) => r.dataset.filter.includes(${JSON.stringify(scanName)}))`);
  const narrowed = await cdp.safeEval(visibleFilterRows(scanName));
  check('typing the fixture name leaves only matching rows visible', !!narrowed && narrowed.count >= 1 && narrowed.count < fullCount && narrowed.allMatch,
    JSON.stringify({ full: fullCount, narrowed: narrowed?.count, names: narrowed?.names }));

  const highlighted = await cdp.safeEval(`!!document.querySelector('#pickList .prow.hi')`);
  check('a match is highlighted (sole match ready for Enter)', highlighted === true, `hi=${highlighted}`);

  console.log('\n=== scan mode: no-match hint, then clear restores ===');
  await cdp.eval(typeFilter(`nope-${tag}-zzz`));
  await cdp.waitFor('no-match hint', `!!document.querySelector('#pickList .pick-nomatch')`);
  const noMatch = await cdp.safeEval(`{ const v = [...document.querySelectorAll('#pickList .prow[data-filter]')].filter((r)=>!r.hidden).length; ({ hint: !!document.querySelector('#pickList .pick-nomatch'), visible: v }); }`);
  check('a query that matches nothing shows a quiet hint and hides every row', noMatch && noMatch.hint === true && noMatch.visible === 0, JSON.stringify(noMatch));
  await cdp.eval(typeFilter(''));
  const restored = (await cdp.safeEval(visibleFilterRows('')))?.count ?? -1;
  check('clearing the filter restores the full list', restored === fullCount, `full=${fullCount}, afterClear=${restored}`);

  console.log('\n=== scan mode: Enter adds the highlighted/sole match ===');
  await cdp.eval(typeFilter(scanName));
  await cdp.waitFor('sole match highlighted', `document.querySelectorAll('#pickList .prow[data-filter]:not([hidden])').length === 1 && !!document.querySelector('#pickList .prow.hi')`);
  await cdp.eval(key('Enter'));
  const added = await cdp.waitFor('registered', `window.__station.state.projects.some((p) => p.hostPath === ${JSON.stringify(scanDir)})`);
  const serverSays = await (await fetch(`${BASE}/api/projects`)).json();
  check('Enter on the sole match registers the project (server cross-checked)',
    added && serverSays.projects.some((p) => p.hostPath === scanDir),
    JSON.stringify(serverSays.projects.map((p) => p.hostPath)));

  console.log('\n=== browse mode: same filter narrows the folder list ===');
  await cdp.eval(`document.querySelector('#addProjBtn').click()`); // reopen (adding closed it)
  await cdp.waitFor('picker reopened', `document.querySelector('#picker').classList.contains('open')`);
  await cdp.eval(`document.querySelector('#pickMode').click()`); // → browse, starts at $HOME
  await cdp.waitFor('browse at home', `document.querySelector('#pickPath').value === ${JSON.stringify(os.homedir())}`);
  await cdp.waitFor('browse fixtures listed', `[...document.querySelectorAll('#pickList .prow[data-filter]')].some((r) => r.dataset.filter.includes(${JSON.stringify(browseHit)}))`);
  const browseFull = (await cdp.safeEval(visibleFilterRows('')))?.count ?? 0;
  await cdp.eval(typeFilter(browseNeedle));
  await cdp.waitFor('browse narrowed', `document.querySelectorAll('#pickList .prow[data-filter]:not([hidden])').length >= 1`);
  const browseNarrowed = await cdp.safeEval(visibleFilterRows(browseNeedle));
  check('browse mode filters the same way (only the needle dir remains)',
    !!browseNarrowed && browseNarrowed.count === 1 && browseNarrowed.allMatch && browseNarrowed.count < browseFull,
    JSON.stringify({ full: browseFull, narrowed: browseNarrowed?.count, names: browseNarrowed?.names }));

  console.log('\n=== browse mode: Enter acts on the highlighted match (navigates in) ===');
  await cdp.eval(key('Enter'));
  const navigated = await cdp.waitFor('descended into needle dir', `document.querySelector('#pickPath').value === ${JSON.stringify(path.join(os.homedir(), browseHit))}`);
  check('Enter fires the highlighted browse row (path field follows into it)', navigated === true,
    await cdp.safeEval(`document.querySelector('#pickPath') && document.querySelector('#pickPath').value`));

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
