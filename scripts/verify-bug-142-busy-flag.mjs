/**
 * BUG-142 round 4 — the SHARED `historyBusy` flag reset in loadMore's finally.
 *
 * Defect (round-3 clean-room BROKEN verdict, run 8fc1c329): loadMore()'s
 * `finally { historyBusy=false }` runs UNCONDITIONALLY — including on the
 * superseded early-return path. A superseded load-more (project A, or a prior
 * generation of the same project) therefore clears the SHARED busy flag while
 * another view's load-more (project B / the current generation) is still in
 * flight. B's re-entry guard is defeated: a duplicate page-2 fetch fires and B
 * ends with 150 rows, only 100 unique — B's own history corrupted by A.
 *
 * Invariant under test: busy/in-flight state is owned per request token — only
 * a request that is STILL CURRENT (`!superseded(token)`) may clear historyBusy.
 * A superseded load-more must not touch it (open() owns the cross-generation
 * reset).
 *
 * This drives the REAL click-to-render path in headless Brave with CDP request
 * interception, deterministically. It observes two things that do NOT depend on
 * the button's transient `disabled` styling:
 *   - the number of page-2 (cursor) fetches issued for the CURRENT view, and
 *   - the final rendered rows vs unique shas.
 * The guard's whole job is to keep the current view to exactly ONE in-flight
 * page-2 fetch; the bug lets a second fire.
 *
 *   node scripts/verify-bug-142-busy-flag.mjs
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
const DATA = scratch('cs-b142busy-data-'); const PROFILE = scratch('cs-b142busy-prof-');
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

// Robustly click Load more: the button is removed+re-appended by historyMore()
// during the double-open, so a naive querySelector().click() nulls. Retry until
// the click lands (or timeout), driving the onclick through a real event.
async function clickMore(cdp, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await cdp.eval(`(()=>{const b=document.querySelector('.gt-more');if(!b)return 'absent';b.disabled=false;b.click();return 'clicked';})()`);
    if (r === 'clicked') return true;
    await sleep(80);
  }
  return false;
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

  const repoA = makeRepo('cs-b142busy-a-', 'PROJA');
  const repoB = makeRepo('cs-b142busy-b-', 'PROJB');
  const regA = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: repoA, name: 'b142busy-alpha' }) })).json();
  const regB = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: repoB, name: 'b142busy-bravo' }) })).json();
  const pidA = regA.project.id, pidB = regB.project.id;

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0', '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0; for (let i = 0; i < 60 && !devPort; i++) { try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); } }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  // Per-project cursor(page-2)-fetch accounting + selective holds.
  //   holdA / holdB : capture that project's cursor request in flight.
  //   cursorCount[pid] : how many page-2 fetches that project has ISSUED.
  const cursorCount = { [pidA]: 0, [pidB]: 0 };
  let holdA = false, holdB = false; const heldA = [], heldB = [];
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/git/log*', requestStage: 'Request' }] });
  cdp.on((m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params, u = request.url;
    if (!/\/git\/log\?/.test(u)) { cdp.send('Fetch.continueRequest', { requestId }).catch(() => {}); return; }
    const hasCursor = u.includes('cursor=');
    if (hasCursor && u.includes(`/${pidA}/git/log`)) { cursorCount[pidA]++; if (holdA) { heldA.push(requestId); return; } }
    if (hasCursor && u.includes(`/${pidB}/git/log`)) { cursorCount[pidB]++; if (holdB) { heldB.push(requestId); return; } }
    cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
  });
  const rowState = () => cdp.eval(`(()=>{const s=[...document.querySelectorAll('.gt-parent-row strong')].map(x=>x.textContent);return {rows:s.length,unique:new Set(s).size,projA:[...document.querySelectorAll('.gt-parent-row')].filter(x=>x.textContent.includes('PROJA')).length,projB:[...document.querySelectorAll('.gt-parent-row')].filter(x=>x.textContent.includes('PROJB')).length}})()`);
  const gotoHistory = async (pid, marker) => {
    await cdp.eval(`location.hash='#/git/changes?project=${encodeURIComponent(pid)}'`);
    await cdp.waitFor(`document.querySelector('.gt-file')||document.querySelector('.gt-empty')`);
    await sleep(250);
    await cdp.eval(`location.hash='#/git/history?project=${encodeURIComponent(pid)}'`);
    await cdp.waitFor(`document.querySelectorAll('.gt-parent-row').length===50 && [...document.querySelectorAll('.gt-parent-row')].every(r=>r.textContent.includes('${marker}')) && document.querySelector('.gt-more')`);
    await sleep(500); // let the double-open settle
  };

  /* ---- CASE 1: cross-project busy-flag clear (the round-4 BROKEN verdict) ---- */
  await cdp.send('Page.navigate', { url: `${BASE}/#/git/changes?project=${encodeURIComponent(pidA)}` });
  await cdp.waitFor(`document.querySelector('.git-view') && !document.querySelector('.git-view').hidden`);
  await gotoHistory(pidA, 'PROJA');
  // Hold A's page-2 fetch, start A's load-more (historyBusy=true under gen A).
  holdA = true;
  await clickMore(cdp);
  { const t0 = Date.now(); while (Date.now() - t0 < 5000 && heldA.length < 1) await sleep(80); }
  check('C1: project A load-more page-2 fetch captured in flight', heldA.length === 1, { heldA: heldA.length });
  // Navigate to B history (open() bumps generation, resets historyBusy for B).
  await gotoHistory(pidB, 'PROJB');
  const bStart = await rowState();
  check('C1: project B history renders its own 50 rows', bStart.rows === 50 && bStart.projB === 50 && bStart.projA === 0, bStart);
  // Hold B's page-2 fetch, start B's load-more (historyBusy=true under gen B).
  holdB = true;
  await clickMore(cdp);
  { const t0 = Date.now(); while (Date.now() - t0 < 5000 && heldB.length < 1) await sleep(80); }
  const bCursorBeforeRelease = cursorCount[pidB];
  // Release A's stale load-more: superseded → its finally must NOT clear B's busy flag.
  for (const id of heldA.splice(0)) await cdp.send('Fetch.continueRequest', { requestId: id }).catch(() => {});
  await sleep(700);
  // Attempt a second B load-more while B's first is still in flight. If the busy
  // flag survived, the re-entry guard drops it and NO extra B cursor fetch fires.
  await clickMore(cdp, 1500);
  await sleep(500);
  const bCursorFetches = cursorCount[pidB];
  check('C1: only ONE project-B page-2 fetch issues while B load-more is in flight (busy guard held)',
    bCursorFetches === 1, { bCursorFetches, bCursorBeforeRelease });
  // Release B's held page(s) and settle.
  holdB = false; for (const id of heldB.splice(0)) await cdp.send('Fetch.continueRequest', { requestId: id }).catch(() => {});
  await sleep(1800);
  const bEnd = await rowState();
  check('C1: project B ends with 100 rows, all unique, no project-A rows (history uncorrupted)',
    bEnd.rows === 100 && bEnd.unique === 100 && bEnd.projA === 0, bEnd);

  /* ---- CASE 2: same-project A→A rapid re-enter, load-more superseded ---- */
  holdA = false; heldA.length = 0; cursorCount[pidA] = 0;
  await gotoHistory(pidA, 'PROJA');
  holdA = true;
  await clickMore(cdp);                         // load-more #1 (gen G1), held
  { const t0 = Date.now(); while (Date.now() - t0 < 5000 && heldA.length < 1) await sleep(80); }
  await gotoHistory(pidA, 'PROJA');             // re-enter → gen G2, historyBusy reset by open()
  holdA = true;                                 // keep holding subsequent A cursor fetches
  await clickMore(cdp);                         // load-more #2 (gen G2), held
  { const t0 = Date.now(); while (Date.now() - t0 < 5000 && heldA.length < 2) await sleep(80); }
  const aCursorBefore = cursorCount[pidA];
  for (const id of heldA.filter((_, i) => i === 0)) await cdp.send('Fetch.continueRequest', { requestId: id }).catch(() => {}); // release the stale #1
  await sleep(700);
  await clickMore(cdp, 1500);                    // try #3 while #2 in flight
  await sleep(500);
  const aCursorFetches = cursorCount[pidA];
  check('C2: superseded load-more does not re-open the busy guard (no extra page-2 fetch)',
    aCursorFetches === 2, { aCursorFetches, aCursorBefore });
  holdA = false; for (const id of heldA.slice(1)) await cdp.send('Fetch.continueRequest', { requestId: id }).catch(() => {});
  await sleep(1800);
  const aEnd = await rowState();
  check('C2: same-project history ends 100 rows, all unique (no duplicate page)',
    aEnd.rows === 100 && aEnd.unique === 100, aEnd);

  /* ---- CASE 3: double load-more in one generation is guarded ---- */
  holdA = false; heldA.length = 0; cursorCount[pidA] = 0;
  await gotoHistory(pidA, 'PROJA');
  holdA = true;
  await clickMore(cdp);
  await clickMore(cdp, 800);                     // second click while first in flight
  { const t0 = Date.now(); while (Date.now() - t0 < 3000 && cursorCount[pidA] < 1) await sleep(80); }
  await sleep(600);
  check('C3: two rapid load-more clicks issue exactly one page-2 fetch',
    cursorCount[pidA] === 1, { aCursorFetches: cursorCount[pidA] });
  holdA = false; for (const id of heldA.splice(0)) await cdp.send('Fetch.continueRequest', { requestId: id }).catch(() => {});
  await sleep(1500);
  const c3End = await rowState();
  check('C3: history ends 100 rows, all unique', c3End.rows === 100 && c3End.unique === 100, c3End);

  cdp.close();
  console.log(`\n  ${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}
main().catch((e) => { console.error('FATAL', e); process.exitCode = 1; }).finally(() => {
  try { if (browser?.pid) process.kill(browser.pid, 'SIGKILL'); } catch {}
  try { if (server?.pid) process.kill(server.pid, 'SIGKILL'); } catch {}
  for (const d of [DATA, PROFILE]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});
