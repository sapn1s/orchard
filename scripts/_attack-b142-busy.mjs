/**
 * ATTACK (BUG-142 round 4): historyBusy reset lets two loadMore concurrently.
 *
 * loadMore()'s finally runs `historyBusy=false` UNCONDITIONALLY, including on
 * the superseded early-return path; open() also resets historyBusy=false. So a
 * superseded loadMore resolving can clear the busy flag that a LIVE loadMore in
 * the current view set — opening a window for a THIRD loadMore to start while
 * the second is still in flight. Both read the same nextCursor and append the
 * same page → duplicate rows (the list-correctness property the ticket guards).
 *
 * Deterministic drive with CDP request holds:
 *   gen5: A history, click Load more -> loadMore#1 cursor req HELD.
 *   re-enter A history (open() bumps gen -> gen6, resets historyBusy).
 *   click Load more -> loadMore#2 cursor req HELD.
 *   release #1 (stale) -> superseded, its finally sets historyBusy=false.
 *   click Load more -> loadMore#3 (busy was cleared) cursor req allowed.
 *   release #2 -> #2 and #3 both append page2 -> duplicates if the hole is real.
 */
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
async function freePort() { const net = await import('node:net'); return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }
const PORT = Number(await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const SCRATCH = process.env.ORCHARD_SCRATCH ?? path.join(os.homedir(), 'scratch');
fs.mkdirSync(SCRATCH, { recursive: true });
const scratch = (p) => fs.mkdtempSync(path.join(SCRATCH, p));
const DATA = scratch('cs-atk-data-'); const PROFILE = scratch('cs-atk-prof-');
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 20000 }).trim();

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.handlers = []; ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && this.waiting.has(m.id)) { const { res, rej } = this.waiting.get(m.id); this.waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } else if (m.method) for (const h of this.handlers) h(m); }); }
  static async connect(url) { const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 }); await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }); return new Cdp(ws); }
  on(fn) { this.handlers.push(fn); }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.waiting.set(id, { res, rej })); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`); return r.result?.value; }
  async waitFor(expr, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await this.eval(expr)) return true; } catch {} await sleep(100); } return false; }
  close() { try { this.ws.close(); } catch {} }
}

function makeRepo(prefix, marker) {
  const repo = scratch(prefix);
  execFileSync('git', ['init', '-b', 'main', repo]);
  git(repo, ['config', 'user.email', 'v@example.invalid']); git(repo, ['config', 'user.name', 'v']);
  for (let i = 0; i < 120; i++) { fs.writeFileSync(path.join(repo, `f${i}.txt`), `c ${i}\n`); git(repo, ['add', '-A']); git(repo, ['commit', '-m', `${marker}-${i}`]); }
  return repo;
}

let server, browser;
async function once(cdp, pid) {
  // Hold cursor (page-2) requests; collect their ids in order.
  const heldCursor = [];
  let holdCursor = false;
  const handler = (m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params, u = request.url;
    if (!/\/git\/log\?/.test(u)) { cdp.send('Fetch.continueRequest', { requestId }).catch(() => {}); return; }
    if (holdCursor && u.includes('cursor=')) { heldCursor.push(requestId); return; }
    cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
  };
  cdp.on(handler);

  await cdp.eval(`location.hash='#/git/changes?project=${encodeURIComponent(pid)}'`);
  await cdp.waitFor(`document.querySelector('.gt-file')||document.querySelector('.gt-empty')`);
  await sleep(200);
  await cdp.eval(`location.hash='#/git/history?project=${encodeURIComponent(pid)}'`);
  await cdp.waitFor(`document.querySelectorAll('.gt-parent-row').length===50 && document.querySelector('.gt-more')`);
  await sleep(500); // let the double-open settle so the button is stable

  holdCursor = true;
  await cdp.waitFor(`document.querySelector('.gt-more')`);
  await cdp.eval(`document.querySelector('.gt-more').click()`);           // loadMore#1
  { const t0 = Date.now(); while (Date.now() - t0 < 4000 && heldCursor.length < 1) await sleep(60); }

  // Re-enter A history -> open() bumps generation, resets historyBusy.
  await cdp.eval(`location.hash='#/git/changes?project=${encodeURIComponent(pid)}'`);
  await cdp.waitFor(`document.querySelector('.gt-file')||document.querySelector('.gt-empty')`);
  await sleep(200);
  await cdp.eval(`location.hash='#/git/history?project=${encodeURIComponent(pid)}'`);
  await cdp.waitFor(`document.querySelectorAll('.gt-parent-row').length===50 && document.querySelector('.gt-more')`);
  await sleep(500);

  await cdp.waitFor(`document.querySelector('.gt-more')`);
  await cdp.eval(`document.querySelector('.gt-more').click()`);           // loadMore#2 (gen6)
  { const t0 = Date.now(); while (Date.now() - t0 < 4000 && heldCursor.length < 2) await sleep(60); }

  // Release the stale loadMore#1 -> its finally clears historyBusy.
  if (heldCursor[0]) await cdp.send('Fetch.continueRequest', { requestId: heldCursor[0] }).catch(() => {});
  await sleep(600);

  // Now busy is (bug) cleared: a THIRD click starts loadMore#3, allowed through.
  holdCursor = false;
  await cdp.eval(`document.querySelector('.gt-more') && document.querySelector('.gt-more').click()`); // loadMore#3
  await sleep(400);

  // Release loadMore#2 -> both #2 and #3 append page-2.
  if (heldCursor[1]) await cdp.send('Fetch.continueRequest', { requestId: heldCursor[1] }).catch(() => {});
  await sleep(1800);

  const state = await cdp.eval(`(()=>{const short=[...document.querySelectorAll('.gt-parent-row strong')].map(x=>x.textContent);return {rows:short.length,unique:new Set(short).size,heldCount:${heldCursor.length}}})()`);
  cdp.handlers = cdp.handlers.filter((h) => h !== handler);
  return { ...state, held: heldCursor.length };
}

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_STATION_TERMINAL: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr?.on('data', () => {});
  let up = false; for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server not healthy');
  const repoA = makeRepo('cs-atk-a-', 'PROJA');
  const reg = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: repoA, name: 'atk-alpha' }) })).json();
  const pid = reg.project.id;

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0', '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0; for (let i = 0; i < 60 && !devPort; i++) { try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); } }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/git/log*', requestStage: 'Request' }] });

  const N = Number(process.env.ATK_ITERS ?? 6);
  let dup = 0;
  for (let i = 0; i < N; i++) {
    const s = await once(cdp, pid);
    const bad = s.rows !== s.unique;
    if (bad) dup++;
    console.log(`  iter ${i + 1}: rows=${s.rows} unique=${s.unique} held=${s.held} -> ${bad ? 'DUPLICATE' : 'clean'}`);
  }
  console.log(`\n  RESULT: ${dup} duplicate-row failures in ${N} iterations`);
  cdp.close();
  process.exitCode = dup ? 1 : 0;
}
main().catch((e) => { console.error('FATAL', e); process.exitCode = 2; }).finally(() => {
  try { if (browser?.pid) process.kill(browser.pid, 'SIGKILL'); } catch {}
  try { if (server?.pid) process.kill(server.pid, 'SIGKILL'); } catch {}
  for (const d of [DATA, PROFILE]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});
