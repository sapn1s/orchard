/**
 * BUG-180 — selecting (plain-clicking) a session must change the HIGHLIGHT only,
 * never a row's POSITION. The reported bug: clicking a non-top session promoted it
 * to the top of its project's non-pinned block (the row jumped out from under the
 * cursor and every neighbour slid down), because `orderedSessions` gave the OPEN
 * session its own rank tier (`pinned ? 0 : (isOpen ? 1 : 2)`), a BUG-160 regression.
 * The fix drops that tier: `rank = pinned ? 0 : 1`; order is pinned, then recency
 * (last user submit) desc; selection highlight is carried independently by
 * `aria-current`.
 *
 *   node scripts/verify-bug-180-selection-no-reorder.mjs
 *
 * REAL app, REAL click path: boots an ISOLATED scratch server (isolatedServerEnv),
 * drives a headless Brave over CDP against it, injects a BUSY-DAY fixture (1 pinned
 * + 8 non-pinned, distinct recency, fold lifted so the whole busy list is on
 * screen), then CLICKS a non-top row (the real `button.row` → real `openSession`)
 * and reads the REAL rendered sidebar order from the DOM.
 *
 * Checks (FIXED code on disk):
 *   1. order of the sidebar rows is UNCHANGED across a plain selection (light theme)
 *   2. ...and under the dark theme too (DOM order is theme-independent; asserted)
 *   3. the selection highlight (`aria-current`) DID move to the clicked row
 *
 * must-FAIL discriminator (PRE-FIX code SYNTHESIZED onto disk by this script —
 * the `isOpen` rank tier reintroduced, NOT read from git/HEAD, then restored in
 * `finally`):
 *   4. on the pre-fix code the SAME click DID reorder — the clicked row jumped to
 *      the top of the non-pinned block. This proves checks 1-2 can fail, i.e. the
 *      harness actually discriminates the bug.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { isolatedServerEnv } from './lib/station-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = path.join(ROOT, 'public', 'app.js');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');

async function freePort() { const net = await import('node:net'); return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }
const PORT = Number(process.env.VERIFY_BUG180_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug180-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug180-store-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug180-chrome-'));
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';

let pass = 0, fail = 0; const failures = [];
function check(name, ok, observed) { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`); ok ? pass++ : (fail++, failures.push(name)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async connect(url) { const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 }); await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }); const c = new Cdp(ws); ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && c.waiting.has(m.id)) { const { res, rej } = c.waiting.get(m.id); c.waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } }); return c; }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.waiting.set(id, { res, rej })); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`); return r.result?.value; }
  async waitFor(label, expr, timeoutMs = 30_000) { const t0 = Date.now(); while (Date.now() - t0 < timeoutMs) { try { if (await this.eval(expr)) return true; } catch { /* nav */ } await sleep(150); } console.log(`  (timed out: ${label})`); return false; }
  close() { try { this.ws.close(); } catch { /* */ } }
}
let server = null, browser = null;
function stopByPid(child) { if (!child || child.exitCode !== null) return; try { process.kill(child.pid, 'SIGTERM'); } catch { /* */ } setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* */ } }, 2000).unref(); }

// ---- the busy-day fixture, injected client-side into the REAL state + render ----
const CLICK_MARK = 'Delta add second claude'; // the non-top row the user clicks
const INJECT = `(() => {
  const S = window.__station; const st = S.state;
  const pid = 'fx-proj';
  const now = Date.now();
  const iso = (minAgo) => new Date(now - minAgo * 60000).toISOString();
  st.projects = [{ id: pid, name: 'busy-day', hostPath: '/tmp/fx-busy-day', lastActivityAt: iso(1), isolation: 'direct', settings: { mounts: [], instructions: [] } }];
  const mk = (i, title, minAgo, pinned) => ({
    sessionId: 'sid-' + i, encodedDir: '-tmp-fx-busy-day',
    displayTitle: title, lastUserMessageAt: iso(minAgo), lastActivityAt: iso(minAgo),
    os: 'linux', provider: 'anthropic', ...(pinned ? { pinned: true } : {}),
  });
  const list = [
    mk(0, 'PINNED board review', 500, true),
    mk(1, 'Alpha fix navigation jump', 5, false),
    mk(2, 'Bravo review orchestrator', 12, false),
    mk(3, 'Charlie review project board', 20, false),
    mk(4, 'Delta add second claude', 31, false),
    mk(5, 'Echo review output rail', 44, false),
    mk(6, 'Foxtrot review handoff', 60, false),
    mk(7, 'Golf reread the board', 90, false),
    mk(8, 'Hotel verify lane notes', 130, false),
  ];
  st.sessions.set(pid, { list, windowed: false, shown: 100, loaded: true });
  if (!st.expanded) st.expanded = new Set();
  st.expanded.add(pid);
  st.current = { sessionId: null, encodedDir: null, projectId: null };
  st.openProjectId = null;
  S.renderTree();
  return list.length;
})()`;

const READ_ROWS = `(() => [...document.querySelectorAll('#tree .kids button.row')]
  .map((r) => ({ t: r.textContent.replace(/\\s+/g, ' ').trim(), cur: r.getAttribute('aria-current') })))()`;

async function runPass(cdp, theme) {
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  if (!await cdp.waitFor('boot', `window.__station !== undefined && !!window.__station.renderTree`)) throw new Error('app never booted');
  await cdp.eval(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`);
  const n = await cdp.eval(INJECT);
  if (!await cdp.waitFor('rows', `[...document.querySelectorAll('#tree .kids button.row')].length >= ${n}`)) throw new Error('fixture rows never rendered');
  const before = await cdp.eval(READ_ROWS);
  // click the non-top row (real DOM click → real openSession)
  const clicked = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('#tree .kids button.row')];
    const target = rows.find((r) => r.textContent.includes(${JSON.stringify(CLICK_MARK)}));
    if (!target) return null;
    const idx = rows.indexOf(target);
    target.click();
    return idx;
  })()`);
  await sleep(600);
  const after = await cdp.eval(READ_ROWS);
  return { before, after, clicked };
}

async function main() {
  console.log('\n========== BUG-180 — plain selection highlights, never reorders (real app) ==========');
  server = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: isolatedServerEnv({ PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE }, { requireStore: true }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [srv!] ${d}`));
  let up = false; for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never healthy');

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0', '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0; for (let i = 0; i < 80 && !devPort; i++) { try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); } }
  if (!devPort) throw new Error('brave devtools port never appeared');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }); // so a file swap is served fresh

  const seq = (rows) => rows.map((r) => r.t);
  const activeTitle = (rows) => (rows.find((r) => r.cur === 'true') || {}).t ?? null;

  // ===== FIXED code (already on disk) — selection must NOT reorder =====
  const FIXED = fs.readFileSync(APP, 'utf8');
  try {
    const light = await runPass(cdp, 'light');
    check('1: plain selection leaves the sidebar row ORDER unchanged (light theme)',
      JSON.stringify(seq(light.before)) === JSON.stringify(seq(light.after)),
      { clickedIdx: light.clicked, before: seq(light.before), after: seq(light.after) });
    check('3: the aria-current highlight DID move to the clicked row',
      activeTitle(light.after)?.includes(CLICK_MARK) === true,
      { active: activeTitle(light.after) });

    const dark = await runPass(cdp, 'dark');
    check('2: plain selection leaves the sidebar row ORDER unchanged (dark theme)',
      JSON.stringify(seq(dark.before)) === JSON.stringify(seq(dark.after)),
      { clickedIdx: dark.clicked, before: seq(dark.before), after: seq(dark.after) });

    // ===== PRE-FIX code, SYNTHESIZED onto disk (not from git) — the bug must reappear =====
    const FIXED_LINE = '  const rank = (x) => (api.pinnedOf(x) ? 0 : 1);';
    const PREFIX_BLOCK = [
      '  const isOpen = (x) => state.current.sessionId != null',
      '    && x?.sessionId === state.current.sessionId',
      '    && x?.encodedDir === state.current.encodedDir;',
      '  const rank = (x) => (api.pinnedOf(x) ? 0 : (isOpen(x) ? 1 : 2));',
    ].join('\n');
    const occ = FIXED.split(FIXED_LINE).length - 1;
    if (occ !== 1) throw new Error(`expected exactly one fixed rank line to synthesize the pre-fix from, found ${occ}`);
    const PREFIX = FIXED.replace(FIXED_LINE, PREFIX_BLOCK);
    fs.writeFileSync(APP, PREFIX);
    const pre = await runPass(cdp, 'light');
    const movedToTop = pre.after[1]?.t?.includes(CLICK_MARK) === true && !pre.before[1]?.t?.includes(CLICK_MARK);
    check('4: must-FAIL discriminator — on the PRE-FIX code the same click reordered the clicked row to the top of the non-pinned block',
      JSON.stringify(seq(pre.before)) !== JSON.stringify(seq(pre.after)) && movedToTop,
      { before: seq(pre.before), after: seq(pre.after) });
  } finally {
    fs.writeFileSync(APP, FIXED); // ALWAYS restore the fixed file
  }

  cdp.close();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`FAILURES: ${failures.join(' | ')}`);
}
main().catch((e) => { console.error(`\nFATAL: ${e.message}`); fail++; }).finally(() => {
  stopByPid(browser); stopByPid(server);
  setTimeout(() => { for (const d of [DATA, STORE, PROFILE]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } } process.exit(fail ? 1 : 0); }, 2500);
});
