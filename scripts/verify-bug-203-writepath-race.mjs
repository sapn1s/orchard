/**
 * BUG-203 — git-view WRITE paths share unguarded busy/in-flight state.
 *
 * Sibling of BUG-142 in the same file, same class: a superseded async
 * continuation renders one project's data into another's view / clears a SHARED
 * busy flag the now-current view owns. BUG-142 fixed the load/history paths;
 * this covers the write handlers (switchBranch/checkoutRemote/createForm/
 * commit/sync + refreshBranch, and the branchBusy/committing flags).
 *
 * Two facets, both driven deterministically in headless Brave with CDP request
 * holds:
 *
 *   C1 — busy flag LEAKS across navigation. Start a branch switch in project A,
 *   then navigate to project B before A's switch resolves. B's own branch switch
 *   must still work — i.e. `branchBusy` must NOT leak across the project switch
 *   and dead-lock B's controls. (Fixed by resetting branchBusy/committing in
 *   open(); pre-fix open() left the flag set, so B's switch guard was blocked.)
 *
 *   C2 — stale finally CLEARS the shared flag. With B's own switch in flight,
 *   releasing A's superseded switch must NOT clear the branchBusy flag B owns —
 *   otherwise B's re-entry guard drops and a duplicate B switch-branch POST
 *   fires. (Fixed by gating switchBranch's finally on !superseded.)
 *
 * Observed via network (switch-branch POSTs per project). `clickBranch` force-
 * enables the button before clicking, so the real re-entry guard under test is
 * `branchBusy` inside switchBranch, not the button's cosmetic disabled styling.
 *
 *   node scripts/verify-bug-203-writepath-race.mjs
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
const DATA = scratch('cs-b203-data-'); const PROFILE = scratch('cs-b203-prof-');
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

// The branch buttons are rebuilt by buildBranches(); retry until the click
// lands. Force-enable to drive onclick directly, isolating the branchBusy
// re-entry guard from the cosmetic `disabled` styling (as clickMore does for
// history). Returns whether a matching button was clicked.
async function clickBranch(cdp, name, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await cdp.eval(`(()=>{const b=[...document.querySelectorAll('.gt-branch-name')].find(x=>x.textContent===${JSON.stringify(name)});if(!b)return 'absent';b.disabled=false;b.click();return 'clicked';})()`);
    if (r === 'clicked') return true;
    await sleep(80);
  }
  return false;
}

function makeRepo(prefix, marker) {
  const repo = scratch(prefix);
  execFileSync('git', ['init', '-b', 'main', repo]);
  git(repo, ['config', 'user.email', 'verify@example.invalid']); git(repo, ['config', 'user.name', 'verify']);
  for (let i = 0; i < 4; i++) { fs.writeFileSync(path.join(repo, `${marker}-f${i}.txt`), `c ${i}\n`); git(repo, ['add', '-A']); git(repo, ['commit', '-m', `${marker}-${i}`]); }
  return repo;
}
// Registration scaffolds .claude/.orchard/CLAUDE.md/package.json into the repo,
// so the tree is dirty afterward. Commit that scaffold, THEN branch — both
// branches share one clean identical tree, so a switch is allowed and changes
// nothing (isolates the race from git's own dirty-tree refusal).
function settleClean(repo, extraBranch) {
  git(repo, ['add', '-A']); git(repo, ['commit', '-m', 'scaffold']);
  git(repo, ['branch', extraBranch]);
  const dirty = git(repo, ['status', '--porcelain']);
  if (dirty) throw new Error(`repo not clean after scaffold commit: ${dirty.slice(0, 200)}`);
}

let server, browser;
async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_STATION_TERMINAL: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr?.on('data', (d) => process.stderr.write(`  [srv] ${d}`));
  let up = false; for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const repoA = makeRepo('cs-b203-a-', 'PROJA');
  const repoB = makeRepo('cs-b203-b-', 'PROJB');
  const regA = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: repoA, name: 'b203-alpha' }) })).json();
  const regB = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: repoB, name: 'b203-bravo' }) })).json();
  const pidA = regA.project.id, pidB = regB.project.id;
  settleClean(repoA, 'feat-alpha'); settleClean(repoB, 'feat-bravo');

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0', '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0; for (let i = 0; i < 60 && !devPort; i++) { try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); } }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  // switch-branch POST accounting + selective holds, per project.
  const switchCount = { [pidA]: 0, [pidB]: 0 };
  let holdA = false, holdB = false; const heldA = [], heldB = [];
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/git/*', requestStage: 'Request' }] });
  cdp.on((m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params, u = request.url;
    if (/\/git\/switch-branch$/.test(u)) {
      if (u.includes(`/${pidA}/git/`)) { switchCount[pidA]++; if (holdA) { heldA.push(requestId); return; } }
      if (u.includes(`/${pidB}/git/`)) { switchCount[pidB]++; if (holdB) { heldB.push(requestId); return; } }
    }
    cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
  });
  const branchState = () => cdp.eval(`(()=>{const names=[...document.querySelectorAll('.gt-branch-name')].map(x=>x.textContent);return {rows:names.length,alpha:names.filter(n=>n==='feat-alpha').length,bravo:names.filter(n=>n==='feat-bravo').length}})()`);
  const gotoBranches = async (pid, extra) => {
    await cdp.eval(`location.hash='#/git/changes?project=${encodeURIComponent(pid)}'`);
    await cdp.waitFor(`document.querySelector('.gt-file')||document.querySelector('.gt-empty')`);
    await sleep(250);
    await cdp.eval(`location.hash='#/git/branches?project=${encodeURIComponent(pid)}'`);
    await cdp.waitFor(`[...document.querySelectorAll('.gt-branch-name')].some(x=>x.textContent===${JSON.stringify(extra)})`);
    await sleep(500);
  };

  /* ---- C1: branchBusy must NOT leak across the project switch ---- */
  await cdp.send('Page.navigate', { url: `${BASE}/#/git/changes?project=${encodeURIComponent(pidA)}` });
  await cdp.waitFor(`document.querySelector('.git-view') && !document.querySelector('.git-view').hidden`);
  await gotoBranches(pidA, 'feat-alpha');
  holdA = true;
  await clickBranch(cdp, 'feat-alpha');                                     // A switch, POST held (branchBusy=true, gen A)
  { const t0 = Date.now(); while (Date.now() - t0 < 5000 && heldA.length < 1) await sleep(80); }
  check('C1: project A switch-branch POST captured in flight', heldA.length === 1, { heldA: heldA.length });
  await gotoBranches(pidB, 'feat-bravo');                                   // open() must reset branchBusy for B
  holdB = true;
  await clickBranch(cdp, 'feat-bravo');                                     // B's own switch — must be allowed through
  { const t0 = Date.now(); while (Date.now() - t0 < 4000 && switchCount[pidB] < 1) await sleep(80); }
  check("C1: project B can still switch branches — A's in-flight branchBusy did not leak across the nav",
    switchCount[pidB] === 1, { bSwitchPosts: switchCount[pidB] });
  holdA = false; for (const id of heldA.splice(0)) await cdp.send('Fetch.continueRequest', { requestId: id }).catch(() => {});
  holdB = false; for (const id of heldB.splice(0)) await cdp.send('Fetch.continueRequest', { requestId: id }).catch(() => {});
  await sleep(1200);

  /* ---- C2: releasing A's stale switch must NOT clear B's owned branchBusy ---- */
  holdA = false; holdB = false; heldA.length = 0; heldB.length = 0; switchCount[pidA] = 0; switchCount[pidB] = 0;
  await gotoBranches(pidA, 'feat-alpha');
  holdA = true;
  await clickBranch(cdp, 'feat-alpha');                                     // A switch #1 (gen A), held
  { const t0 = Date.now(); while (Date.now() - t0 < 5000 && heldA.length < 1) await sleep(80); }
  await gotoBranches(pidB, 'feat-bravo');                                   // open() resets branchBusy
  holdB = true;
  await clickBranch(cdp, 'feat-bravo');                                     // B switch #1 (gen B), held → B owns branchBusy
  { const t0 = Date.now(); while (Date.now() - t0 < 5000 && heldB.length < 1) await sleep(80); }
  for (const id of heldA.splice(0)) await cdp.send('Fetch.continueRequest', { requestId: id }).catch(() => {}); // release A's stale switch
  await sleep(800);
  await clickBranch(cdp, 'feat-bravo', 1500);                              // try B switch #2 while B#1 still in flight
  await sleep(500);
  check('C2: releasing a superseded switch does not re-open B\'s busy guard (still one B switch POST)',
    switchCount[pidB] === 1, { bSwitchPosts: switchCount[pidB] });
  holdB = false; for (const id of heldB.splice(0)) await cdp.send('Fetch.continueRequest', { requestId: id }).catch(() => {});
  await sleep(1200);

  cdp.close();
  console.log(`\n  ${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}
main().catch((e) => { console.error('FATAL', e); process.exitCode = 1; }).finally(() => {
  try { if (browser?.pid) process.kill(browser.pid, 'SIGKILL'); } catch {}
  try { if (server?.pid) process.kill(server.pid, 'SIGKILL'); } catch {}
  for (const d of [DATA, PROFILE]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});
