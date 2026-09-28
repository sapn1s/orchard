/**
 * BUG-142 — "Git history: Load more adds nothing" + its cross-project sibling.
 *
 * Root cause (found by instrumenting the real click-to-render path): a single
 * hash / Back-Forward navigation fires the git view's open() TWICE (both the
 * `hashchange` and the `popstate` listener route git and both call showGit;
 * Chromium raises both on a Back/Forward that changes the fragment). Async
 * git-view loaders that await then mutate the shared list race, and a
 * superseded one applies its result over the current view. Two faces of the
 * one bug, both timing-dependent, both driven deterministically here with CDP
 * request interception rather than gambling on the flake:
 *
 *   Phase 1 — stale REBUILD. Two loadHistory() from the double-open race; the
 *   late one rebuilds the list and discards the page loadMore() had appended,
 *   so the row count snaps back to 50 ("Load more adds nothing").
 *
 *   Phase 2 — cross-project APPEND. Navigating to another project while a
 *   loadMore() page fetch is in flight splices project A's commits into project
 *   B's rendered list — silent cross-project wrongness.
 *
 * Both are fixed by binding every loader to open()'s `generation` token
 * (one shared `superseded()` check) and dropping any response whose view has
 * moved on.
 *
 *   node scripts/verify-bug-142-loadmore-race.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
async function freePort() { const net = await import('node:net'); return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }
const PORT = Number(process.env.VERIFY_GIT_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const SCRATCH = process.env.ORCHARD_SCRATCH ?? path.join(os.homedir(), 'scratch');
fs.mkdirSync(SCRATCH, { recursive: true });
const scratch = (p) => fs.mkdtempSync(path.join(SCRATCH, p));
const DATA = scratch('cs-b142-data-'); const PROFILE = scratch('cs-b142-prof-');
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 20000 }).trim();

let pass = 0, fail = 0;
function check(name, ok, observed) { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`); ok ? pass++ : fail++; }

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.handlers = []; ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && this.waiting.has(m.id)) { const { res, rej } = this.waiting.get(m.id); this.waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } else if (m.method) for (const h of this.handlers) h(m); }); }
  static async connect(url) { const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 }); await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }); return new Cdp(ws); }
  on(fn) { this.handlers.push(fn); }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.waiting.set(id, { res, rej })); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`); return r.result?.value; }
  async waitFor(expr, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await this.eval(expr)) return true; } catch {} await sleep(120); } return false; }
  close() { try { this.ws.close(); } catch {} }
}

function makeRepo(prefix, marker) {
  const repo = scratch(prefix);
  execFileSync('git', ['init', '-b', 'main', repo]);
  git(repo, ['config', 'user.email', 'verify@example.invalid']); git(repo, ['config', 'user.name', 'verify']);
  for (let i = 0; i < 120; i++) { fs.writeFileSync(path.join(repo, `f${i}.txt`), `c ${i}\n`); git(repo, ['add', '-A']); git(repo, ['commit', '-m', `${marker}-${i}`]); }
  return repo;
}

let server, browser;
async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_STATION_TERMINAL: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr?.on('data', (d) => process.stderr.write(`  [srv] ${d}`));
  let up = false; for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  // Two projects, distinct commit-subject markers so a stray row is unmistakable.
  // 120 commits each → three UI pages of 50/50/20.
  const repoA = makeRepo('cs-b142-a-', 'PROJA');
  const repoB = makeRepo('cs-b142-b-', 'PROJB');
  const total = 120;
  const regA = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: repoA, name: 'b142-alpha' }) })).json();
  const regB = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: repoB, name: 'b142-bravo' }) })).json();
  const pidA = regA.project.id, pidB = regB.project.id;

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0', '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0; for (let i = 0; i < 60 && !devPort; i++) { try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); } }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  // Mode-aware git/log interceptor.
  //   phase1: hold the SECOND page-1 request (the stale, superseded load).
  //   phase2: hold project A's page-2 (cursor) request while we jump to B.
  let mode = 'off', pageOneSeen = 0, heldId = null, heldUrl = null;
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/git/log*', requestStage: 'Request' }] });
  cdp.on((m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params, u = request.url;
    if (!/\/git\/log\?/.test(u)) { cdp.send('Fetch.continueRequest', { requestId }).catch(() => {}); return; }
    const hasCursor = u.includes('cursor=');
    let hold = false;
    if (mode === 'phase1' && !hasCursor) { pageOneSeen++; if (pageOneSeen === 2) hold = true; }
    if (mode === 'phase2' && hasCursor && u.includes(`/${pidA}/git/log`)) hold = true;
    if (hold) { heldId = requestId; heldUrl = u; return; }
    cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
  });

  /* ---------------------------------------------------- Phase 1: stale rebuild */
  mode = 'phase1'; pageOneSeen = 0; heldId = null;
  await cdp.send('Page.navigate', { url: `${BASE}/#/git/changes?project=${encodeURIComponent(pidA)}` });
  await cdp.waitFor(`document.querySelector('.git-view') && !document.querySelector('.git-view').hidden`);
  await sleep(300);
  await cdp.eval(`location.hash='#/git/history?project=${encodeURIComponent(pidA)}'`);
  const first = await cdp.waitFor(`document.querySelectorAll('.gt-parent-row').length===50 && document.querySelector('.gt-more')`);
  check('P1: history first page renders 50 rows and a Load more button', first, { rows: await cdp.eval(`document.querySelectorAll('.gt-parent-row').length`) });
  await cdp.eval(`document.querySelector('.gt-more').click()`);
  const page2 = await cdp.waitFor(`document.querySelectorAll('.gt-parent-row').length===100`);
  check('P1: Load more appends the second page (50 → 100)', page2, { rows: await cdp.eval(`document.querySelectorAll('.gt-parent-row').length`) });
  if (heldId) await cdp.send('Fetch.continueRequest', { requestId: heldId }).catch(() => {});
  await sleep(1500);
  const afterRelease = await cdp.eval(`(()=>{const rows=[...document.querySelectorAll('.gt-parent-row')];return {rows:rows.length,unique:new Set([...document.querySelectorAll('.gt-parent-row strong')].map(x=>x.textContent)).size}})()`);
  check('P1: a superseded history load does NOT rebuild after Load more (rows stay 100)',
    afterRelease.rows === 100, { ...afterRelease, staleRequestIssued: !!heldId, staleUrl: heldUrl });
  const moreStill = await cdp.eval(`!!document.querySelector('.gt-more')`);
  await cdp.eval(`document.querySelector('.gt-more')?.click()`);
  const page3 = await cdp.waitFor(`document.querySelectorAll('.gt-parent-row').length===${total}`, 8000);
  const endState = await cdp.eval(`(()=>{const short=[...document.querySelectorAll('.gt-parent-row strong')].map(x=>x.textContent);return {rows:short.length,unique:new Set(short).size,more:!!document.querySelector('.gt-more')}})()`);
  check('P1: last page lands, button disappears, no duplicate/looped rows at end of history',
    moreStill && page3 && endState.rows === total && endState.unique === total && endState.more === false, { total, ...endState });

  /* --------------------------------------------- Phase 2: cross-project append */
  mode = 'phase2'; heldId = null; heldUrl = null;
  // Re-enter A's history cleanly (changes → history guarantees a hashchange).
  await cdp.eval(`location.hash='#/git/changes?project=${encodeURIComponent(pidA)}'`);
  await cdp.waitFor(`document.querySelector('.gt-file') || document.querySelector('.gt-empty')`);
  await sleep(250);
  await cdp.eval(`location.hash='#/git/history?project=${encodeURIComponent(pidA)}'`);
  const aFirst = await cdp.waitFor(`document.querySelectorAll('.gt-parent-row').length===50 && [...document.querySelectorAll('.gt-parent-row')].every(r=>r.textContent.includes('PROJA'))`);
  check('P2: project A history shows 50 rows, all project A commits', aFirst,
    await cdp.eval(`(()=>{const r=[...document.querySelectorAll('.gt-parent-row')];return {rows:r.length,projA:r.filter(x=>x.textContent.includes('PROJA')).length}})()`));
  // Click Load more on A — its page-2 (cursor) request is HELD in flight.
  await cdp.eval(`document.querySelector('.gt-more').click()`);
  let held = false; { const t0 = Date.now(); while (Date.now() - t0 < 5000) { if (heldId) { held = true; break; } await sleep(80); } }
  check('P2: project A Load more page fetch is captured in flight', held, { heldUrl });
  // Jump to project B while A's page is in flight.
  await cdp.eval(`location.hash='#/git/history?project=${encodeURIComponent(pidB)}'`);
  const bShown = await cdp.waitFor(`document.querySelectorAll('.gt-parent-row').length===50 && [...document.querySelectorAll('.gt-parent-row')].every(r=>r.textContent.includes('PROJB'))`);
  check('P2: project B history renders its own 50 rows', bShown,
    await cdp.eval(`(()=>{const r=[...document.querySelectorAll('.gt-parent-row')];return {rows:r.length,projA:r.filter(x=>x.textContent.includes('PROJA')).length,projB:r.filter(x=>x.textContent.includes('PROJB')).length}})()`));
  // Release A's held page — it must be dropped, not spliced into B's list.
  if (heldId) await cdp.send('Fetch.continueRequest', { requestId: heldId }).catch(() => {});
  await sleep(1800);
  const crossState = await cdp.eval(`(()=>{const r=[...document.querySelectorAll('.gt-parent-row')];return {rows:r.length,projA:r.filter(x=>x.textContent.includes('PROJA')).length,projB:r.filter(x=>x.textContent.includes('PROJB')).length}})()`);
  check("P2: project A's in-flight Load more does NOT land in project B's list (no cross-project rows)",
    crossState.rows === 50 && crossState.projA === 0 && crossState.projB === 50, crossState);

  cdp.close();
  console.log(`\n  ${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}
main().catch((e) => { console.error('FATAL', e); process.exitCode = 1; }).finally(() => {
  try { if (browser?.pid) process.kill(browser.pid, 'SIGKILL'); } catch {}
  try { if (server?.pid) process.kill(server.pid, 'SIGKILL'); } catch {}
  for (const d of [DATA, PROFILE]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});
