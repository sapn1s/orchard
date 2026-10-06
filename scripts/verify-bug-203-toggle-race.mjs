/**
 * BUG-203 r2 — the stage-checkbox path (`toggle`) must be generation-owned.
 *
 * The round-2 clean room (run 5aa54e8e) broke on `toggle()`, the one write-ish
 * handler no earlier round named:
 *   T1 — a stage POST resolving AFTER the user switched to project B renders
 *        project A's status into B's header + commit button.
 *   T2 — a FAILED stage in A shows A's error in B and clears B's loading flag.
 *
 * Driven deterministically in headless Brave with CDP request holds/fulfils.
 * Observed via B's rendered header / commit button / view-error text.
 *
 *   node scripts/verify-bug-203-toggle-race.mjs
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
const DATA = scratch('cs-b203t-data-'); const PROFILE = scratch('cs-b203t-prof-');
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

// Robustly tick the first stage checkbox (buildFiles rebuilds the list).
async function clickCheckbox(cdp, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await cdp.eval(`(()=>{const b=document.querySelector('.gt-file input[type=checkbox]');if(!b)return 'absent';b.click();return 'clicked';})()`);
    if (r === 'clicked') return true;
    await sleep(80);
  }
  return false;
}

function makeRepo(prefix, marker, branch) {
  const repo = scratch(prefix);
  execFileSync('git', ['init', '-b', branch, repo]);
  git(repo, ['config', 'user.email', 'verify@example.invalid']); git(repo, ['config', 'user.name', 'verify']);
  for (let i = 0; i < 4; i++) { fs.writeFileSync(path.join(repo, `${marker}-f${i}.txt`), `c ${i}\n`); git(repo, ['add', '-A']); git(repo, ['commit', '-m', `${marker}-${i}`]); }
  return repo;
}
// Registration scaffolds files in; commit them, then leave ONE tracked file
// modified-unstaged so the changes view shows a stage checkbox.
function settleWithChange(repo, marker) {
  git(repo, ['add', '-A']); git(repo, ['commit', '-m', 'scaffold']);
  fs.appendFileSync(path.join(repo, `${marker}-f0.txt`), 'unstaged edit\n');
}

let server, browser;
async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_STATION_TERMINAL: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr?.on('data', (d) => process.stderr.write(`  [srv] ${d}`));
  let up = false; for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const repoA = makeRepo('cs-b203t-a-', 'PROJA', 'alphabranch');
  const repoB = makeRepo('cs-b203t-b-', 'PROJB', 'bravobranch');
  const regA = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: repoA, name: 'b203t-alpha' }) })).json();
  const regB = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: repoB, name: 'b203t-bravo' }) })).json();
  const pidA = regA.project.id, pidB = regB.project.id;
  settleWithChange(repoA, 'PROJA'); settleWithChange(repoB, 'PROJB');

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0', '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0; for (let i = 0; i < 60 && !devPort; i++) { try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); } }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  // Hold or fulfil project A's stage POST.
  let holdA = false, failA = false; const heldA = [];
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/git/stage', requestStage: 'Request' }] });
  cdp.on((m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params, u = request.url;
    if (/\/git\/stage$/.test(u) && u.includes(`/${pidA}/git/`)) {
      if (failA) { cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 500, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ error: 'STALE-A-STAGE-FAILURE' })).toString('base64') }).catch(() => {}); return; }
      if (holdA) { heldA.push(requestId); return; }
    }
    cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
  });
  const headerState = () => cdp.eval(`(()=>({branch:document.querySelector('.gt-branch')?.textContent||'',commit:document.querySelector('.gt-commit button')?.textContent||'',err:document.querySelector('.gt-view-error')?.textContent||''}))()`);
  const gotoChanges = async (pid, branch) => {
    await cdp.eval(`location.hash='#/git/changes?project=${encodeURIComponent(pid)}'`);
    await cdp.waitFor(`(document.querySelector('.gt-branch')?.textContent||'').includes('${branch}')`);
    await sleep(400);
  };

  /* ---- T1: A's late stage resolve must not render A's status into B ---- */
  await cdp.send('Page.navigate', { url: `${BASE}/#/git/changes?project=${encodeURIComponent(pidA)}` });
  await cdp.waitFor(`document.querySelector('.git-view') && !document.querySelector('.git-view').hidden`);
  await gotoChanges(pidA, 'alphabranch');
  await cdp.waitFor(`document.querySelector('.gt-file input[type=checkbox]')`);
  holdA = true;
  await clickCheckbox(cdp);                                                 // A stage POST held
  { const t0 = Date.now(); while (Date.now() - t0 < 5000 && heldA.length < 1) await sleep(80); }
  check('T1: project A stage POST captured in flight', heldA.length === 1, { heldA: heldA.length });
  await gotoChanges(pidB, 'bravobranch');
  const bStart = await headerState();
  check('T1: project B renders its own status (bravobranch)', bStart.branch.includes('bravobranch') && !bStart.branch.includes('alphabranch'), bStart);
  for (const id of heldA.splice(0)) await cdp.send('Fetch.continueRequest', { requestId: id }).catch(() => {}); // release A's stale stage
  await sleep(1400);
  const bEnd = await headerState();
  check("T1: A's superseded stage does NOT render project A's status into B (no alphabranch)",
    bEnd.branch.includes('bravobranch') && !bEnd.branch.includes('alphabranch') && !bEnd.commit.includes('alphabranch'), bEnd);

  /* ---- T2: A's FAILED stage must not show A's error / clear loading in B ---- */
  holdA = false; heldA.length = 0; failA = false;
  await gotoChanges(pidA, 'alphabranch');
  await cdp.waitFor(`document.querySelector('.gt-file input[type=checkbox]')`);
  failA = true;                                                            // A's stage POST will be fulfilled 500
  await clickCheckbox(cdp);                                                // A toggle -> catch runs after we've navigated
  await gotoChanges(pidB, 'bravobranch');                                  // switch to B immediately
  await sleep(1400);
  const t2 = await headerState();
  check("T2: A's failed stage does NOT surface A's error in project B's view",
    !t2.err.includes('STALE-A-STAGE-FAILURE') && t2.branch.includes('bravobranch'), t2);

  cdp.close();
  console.log(`\n  ${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}
main().catch((e) => { console.error('FATAL', e); process.exitCode = 1; }).finally(() => {
  try { if (browser?.pid) process.kill(browser.pid, 'SIGKILL'); } catch {}
  try { if (server?.pid) process.kill(server.pid, 'SIGKILL'); } catch {}
  for (const d of [DATA, PROFILE]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});
