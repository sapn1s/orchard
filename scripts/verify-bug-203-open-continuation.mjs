/**
 * BUG-203 r3 — open()'s continuation must not touch state after the boundary.
 *
 * The round-2 clean room (grey run e0afcc07) found: open() awaits loadView, and
 * its continuation then calls projects(), whose FIRST act (before its own await)
 * is `projectSelect.replaceChildren(...)`. So if the user switches from project
 * A to B while A's open() is suspended in that await, A's continuation resumes
 * and WIPES B's project dropdown, repopulating it with A.
 *
 * Fixed by (a) open() no longer awaiting anything — every load/project/stash is
 * FIRED, each self-guarding via guard(), so open() can't suspend-then-run; and
 * (b) projects() only APPENDING other repos behind guard (open() sets the
 * current option synchronously), so a superseded projects() touches nothing.
 *
 * Driven in headless Brave with a CDP hold on project A's initial changes fetch,
 * so A's open() is in flight while we switch to B, then released.
 *
 *   node scripts/verify-bug-203-open-continuation.mjs
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
const DATA = scratch('cs-b203o-data-'); const PROFILE = scratch('cs-b203o-prof-');
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
  for (let i = 0; i < 3; i++) { fs.writeFileSync(path.join(repo, `${marker}-f${i}.txt`), `c ${i}\n`); git(repo, ['add', '-A']); git(repo, ['commit', '-m', `${marker}-${i}`]); }
  return repo;
}

let server, browser;
async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_STATION_TERMINAL: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr?.on('data', (d) => process.stderr.write(`  [srv] ${d}`));
  let up = false; for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const repoA = makeRepo('cs-b203o-a-', 'PROJA');
  const repoB = makeRepo('cs-b203o-b-', 'PROJB');
  const regA = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: repoA, name: 'openc-alpha' }) })).json();
  const regB = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: repoB, name: 'openc-bravo' }) })).json();
  // Commit the scaffold so both trees are clean (irrelevant here, but keeps the changes view small).
  for (const r of [repoA, repoB]) { git(r, ['add', '-A']); git(r, ['commit', '-m', 'scaffold']); }
  const pidA = regA.project.id, pidB = regB.project.id;

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0', '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0; for (let i = 0; i < 60 && !devPort; i++) { try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); } }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');

  // Hold project A's initial changes fetch so A's open() is in flight.
  let holdA = false; const heldA = [];
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/git/changes', requestStage: 'Request' }] });
  cdp.on((m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params, u = request.url;
    if (/\/git\/changes$/.test(u) && u.includes(`/${pidA}/git/`) && holdA) { heldA.push(requestId); return; }
    cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
  });
  const selState = () => cdp.eval(`(()=>{const s=document.querySelector('.gt-sel');return {value:s?.value||'',selected:s?.selectedOptions?.[0]?.textContent||'',options:[...(s?.options||[])].map(o=>o.textContent)}})()`);

  // Open project A with its changes fetch HELD → A's open() is suspended (r2) /
  // in flight (r3) while we switch to B.
  holdA = true;
  await cdp.send('Page.navigate', { url: `${BASE}/#/git/changes?project=${encodeURIComponent(pidA)}` });
  await cdp.waitFor(`document.querySelector('.git-view') && !document.querySelector('.git-view').hidden`);
  { const t0 = Date.now(); while (Date.now() - t0 < 6000 && heldA.length < 1) await sleep(80); }
  check('project A initial changes fetch captured in flight (A open() suspended)', heldA.length >= 1, { heldA: heldA.length });

  // Switch to project B — B loads fully (its changes fetch is not held). Wait
  // until B is selected AND B's projects() has appended the OTHER repo
  // (openc-alpha) to the dropdown — that appended option is what A's wiping
  // continuation drops.
  await cdp.eval(`location.hash='#/git/branches?project=${encodeURIComponent(pidB)}'`); // branches view so B does not need the held changes fetch
  await cdp.waitFor(`document.querySelector('.gt-sel') && document.querySelector('.gt-sel').value===${JSON.stringify(pidB)} && [...document.querySelector('.gt-sel').options].some(o=>o.textContent.includes('openc-alpha'))`);
  const bBefore = await selState();
  check('project B selected, dropdown lists both repos before release', bBefore.value === pidB && bBefore.options.some((o) => o.includes('openc-alpha')), bBefore);

  // Release A's held changes fetch → A's open() continuation resumes. In the bug
  // (open awaits loadView, projects() replaceChildren) A's continuation wipes the
  // dropdown back to the current project and drops the appended openc-alpha.
  holdA = false; for (const id of heldA.splice(0)) await cdp.send('Fetch.continueRequest', { requestId: id }).catch(() => {});
  await sleep(1600);

  const after = await selState();
  check("A's resumed open() continuation does NOT wipe B's dropdown (both repos still listed)",
    after.value === pidB && after.options.some((o) => o.includes('openc-bravo')) && after.options.some((o) => o.includes('openc-alpha')), after);

  cdp.close();
  console.log(`\n  ${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}
main().catch((e) => { console.error('FATAL', e); process.exitCode = 1; }).finally(() => {
  try { if (browser?.pid) process.kill(browser.pid, 'SIGKILL'); } catch {}
  try { if (server?.pid) process.kill(server.pid, 'SIGKILL'); } catch {}
  for (const d of [DATA, PROFILE]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});
