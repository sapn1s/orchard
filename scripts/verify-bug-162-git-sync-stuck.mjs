/**
 * BUG-162 — the git sync control perma-stuck on "Working…".
 *
 * Two compounding defects made every project's Fetch/Sync button sit on
 * "Working…" forever:
 *   1) A network git op (fetch/push/pull) with no real bound: a remote that
 *      prompts for a credential/host-key with no tty, or a black-hole that
 *      accepts and never answers, hung `git` for the whole hard timeout.
 *   2) The client's `syncing` flag was owned per-generation but never reset by
 *      open(): during a slow fetch, any navigation (project dropdown, view tab)
 *      bumped the generation, so the in-flight fetch's finally skipped the clear
 *      (t !== generation) and open() inherited the stale true — perma "Working…".
 *
 * This drives the REAL UI in headless brave against scratch repos: one whose
 * origin is a black-hole (accept + never respond) so a fetch really is slow, and
 * one with no remote at all. It reproduces the exact strand (navigate to the
 * remoteless project mid-fetch) and checks the sibling states.
 *
 *   node scripts/verify-bug-162-git-sync-stuck.mjs
 *
 * Scratch-only, free port, black-hole on a loopback ephemeral port. Reads its
 * own screenshots (both themes) so an eyeball on the artifacts is possible.
 */
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import WebSocket from 'ws';

async function freePort() {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const SCRATCH = process.env.ORCHARD_SCRATCH ?? path.join(os.homedir(), 'scratch');
fs.mkdirSync(SCRATCH, { recursive: true });
const scratch = (p) => fs.mkdtempSync(path.join(SCRATCH, p));
const DATA = scratch('cs-b162-data-');
const PROFILE = scratch('cs-b162-chrome-');
const SHOTS = scratch('cs-b162-shots-');
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';

let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 15_000 }).trim();

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c = new Cdp(ws);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && c.waiting.has(m.id)) { const { res, rej } = c.waiting.get(m.id); c.waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    });
    return c;
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.waiting.set(id, { res, rej })); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`); return r.result?.value; }
  async waitFor(label, expr, timeoutMs = 20_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) { try { if (await this.eval(expr)) return true; } catch { /* nav */ } await sleep(120); }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  async shot(name, theme) {
    await this.eval(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    await sleep(250);
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(SHOTS, `${name}-${theme}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

let server = null, browser = null, hole = null;
const cleanupDirs = [DATA, PROFILE]; // SHOTS kept for eyeball review
function stopByPid(child) { if (!child || child.exitCode !== null) return; try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref(); }

async function main() {
  // Black-hole remote: accept the TCP connection, read nothing back. `git fetch`
  // against this is a real, slow, never-answering network op.
  const held = [];
  hole = net.createServer((s) => held.push(s));
  await new Promise((r) => hole.listen(0, '127.0.0.1', r));
  const holePort = hole.address().port;

  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_STATION_TERMINAL: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  function mkrepo(prefix, remoteUrl) {
    const repo = scratch(prefix); cleanupDirs.push(repo);
    execFileSync('git', ['init', '-b', 'main', repo]);
    git(repo, ['config', 'user.email', 'verify@example.invalid']);
    git(repo, ['config', 'user.name', 'verify']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(repo, ['add', '-A']); git(repo, ['commit', '-m', 'first']);
    if (remoteUrl) git(repo, ['remote', 'add', 'origin', remoteUrl]);
    return repo;
  }
  // A: has an origin that black-holes → its fetch is genuinely slow/in-flight.
  const withRemote = mkrepo('cs-b162-remote-', `http://127.0.0.1:${holePort}/x.git`);
  // B: no remote at all → the sync control must read "No origin configured".
  const remoteless = mkrepo('cs-b162-noremote-', null);

  const register = async (hostPath, name) => (await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath, name }),
  })).json()).project?.id;
  const A = await register(withRemote, 'has-remote-blackhole');
  const B = await register(remoteless, 'no-remote-at-all');
  if (!A || !B) throw new Error(`register failed: A=${A} B=${B}`);

  // Server-side sanity: a black-hole fetch is now BOUNDED and surfaces a real
  // reason, rather than riding the full 60s hard timeout.
  console.log('\n=== server: network fetch is bounded + honest ===');
  const t0 = Date.now();
  const fr = await fetch(`${BASE}/api/projects/${A}/git/fetch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const fetchMs = Date.now() - t0;
  const fbody = await fr.json();
  check('black-hole fetch fails fast (<30s) with a real reason, not a silent 60s hang',
    fr.status >= 400 && fetchMs < 30_000 && /slow|timed out|could not|unable to access/i.test(JSON.stringify(fbody)),
    { http: fr.status, ms: fetchMs, error: JSON.stringify(fbody).slice(0, 160) });

  console.log('\n=== browser: strand + sibling states ===');
  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0', '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) { try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); } }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const label = () => cdp.eval(`document.querySelector('.gt-sync button')?.textContent`);

  // Sibling C: a clean open of the remoteless project reads correctly + disabled.
  await cdp.send('Page.navigate', { url: `${BASE}/#/git?project=${encodeURIComponent(B)}` });
  // Wait for the panel to settle past the transient pre-status-load paint.
  const settledNoRemote = await cdp.waitFor('remoteless panel settled', `document.querySelector('.gt-sync button')?.textContent==='No origin configured'`, 10_000);
  const cleanNoRemote = await cdp.eval(`(()=>{const b=document.querySelector('.gt-sync button');return{text:b?.textContent,disabled:b?.disabled}})()`);
  check('remoteless project shows "No origin configured" and disables the button on a clean open',
    settledNoRemote && cleanNoRemote.text === 'No origin configured' && cleanNoRemote.disabled === true, cleanNoRemote);

  // THE STRAND: open A (auto-fetch fires against the black-hole → "Working…"),
  // then navigate CLIENT-SIDE (same SPA closure) to the remoteless B mid-flight.
  // Broken code leaves B stuck on "Working…" forever; fixed code shows the label
  // that matches B.
  await cdp.send('Page.navigate', { url: `${BASE}/#/git?project=${encodeURIComponent(A)}` });
  const gotWorking = await cdp.waitFor('A fetch in flight ("Working…")', `document.querySelector('.gt-sync button')?.textContent==='Working…'`, 15_000);
  const midFlightLabel = await label();
  // Same closure — a hashchange, not a reload — so the stale generation can strand the flag.
  await cdp.eval(`location.hash='#/git?project=${encodeURIComponent(B)}'`);
  const recovered = await cdp.waitFor('B recovers to "No origin configured"', `document.querySelector('.gt-sync button')?.textContent==='No origin configured'`, 8_000);
  const afterNav = await label();
  check('navigating to the remoteless project mid-fetch does NOT strand the button on "Working…"',
    gotWorking && recovered && afterNav === 'No origin configured', { midFlightLabel, afterNav, gotWorking, recovered });

  // Hold on B a while: even after A's slow fetch finally resolves, B must not flip back to "Working…".
  await sleep(3000);
  const settled = await label();
  check('after the stranded fetch resolves, the remoteless panel stays usable (never reverts to "Working…")',
    settled === 'No origin configured', { settled });
  const strandShotDark = await cdp.shot('remoteless-after-strand', 'dark');
  const strandShotLight = await cdp.shot('remoteless-after-strand', 'light');

  // Sibling: a FAILED explicit fetch clears the control and reports the reason.
  await cdp.send('Page.navigate', { url: `${BASE}/#/git?project=${encodeURIComponent(A)}` });
  await cdp.waitFor('A panel', `document.querySelector('.gt-sync button')!=null`);
  // Wait out any auto-fetch, then trigger an explicit fetch and let it fail.
  await cdp.waitFor('A idle before explicit fetch', `document.querySelector('.gt-sync button')?.textContent!=='Working…'`, 25_000);
  await cdp.eval(`document.querySelector('.gt-sync button').click()`);
  const clearedAfterFail = await cdp.waitFor('explicit fetch clears', `document.querySelector('.gt-sync button')?.textContent!=='Working…' && /could not reach origin/i.test(document.querySelector('.gt-sync small')?.textContent||'')`, 25_000);
  const failState = await cdp.eval(`({button:document.querySelector('.gt-sync button')?.textContent,note:document.querySelector('.gt-sync small')?.textContent})`);
  check('a failed fetch clears "Working…" and surfaces "could not reach origin" rather than sitting silent',
    clearedAfterFail && failState.button !== 'Working…' && /could not reach origin/i.test(failState.note ?? ''), failState);
  const failShotDark = await cdp.shot('failed-fetch', 'dark');
  const failShotLight = await cdp.shot('failed-fetch', 'light');

  console.log(`\n  screenshots: \n    ${strandShotDark}\n    ${strandShotLight}\n    ${failShotDark}\n    ${failShotLight}`);
  cdp.close();

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} passed, ${fail} failed`);
}

main().catch((e) => { console.error(e); fail++; }).finally(() => {
  stopByPid(server); stopByPid(browser);
  try { hole?.close(); } catch { /* gone */ }
  for (const d of cleanupDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* leave it */ } }
  process.exit(fail ? 1 : 0);
});
