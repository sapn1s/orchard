/**
 * FEAT-155 round 5 — the drawer's "Dockerfile" field, driven in a real headless
 * browser (brave over CDP) against a scratch server, over a realistic state: a
 * project that already built its image once and whose Dockerfile was then
 * edited into a failing one (so the row must say it is running the last good
 * image, and the build log must be reachable).
 *
 *   node scripts/verify-feat-155-dockerfile-ui.mjs      (OUT_DIR=… for the shots)
 *
 * Checks: the field sits beside "Base image"; typing a path and pressing Enter
 * persists it (real click-path, confirmed via the API); the built state; the
 * failed-build state names the last good image; "Build log ›" opens the log;
 * ATTACK — build output carrying HTML and ANSI/OSC escapes renders as inert
 * text (no element injected, no script ran). Screenshots in light and dark.
 * Synthetic repo (stated): no real project is built here.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { removeScratchBuilders } from './lib/builder-cleanup.mjs';
import WebSocket from 'ws';
import { ownerKeyFor, removeOwnedContainer, removeOwnedImages, pruneOwnedImages, refuseTakenName } from './lib/owned-docker.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BRAVE = process.env.VERIFY_BROWSER ?? 'brave';
const OUT = process.env.OUT_DIR || '/tmp/feat155-df-ui';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, obs) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}\n        observed: ${String(obs).slice(0, 400)}`); ok ? pass++ : fail++; };
const procs = [];
function stopByPid(child) { if (!child || child.exitCode !== null) return; try { process.kill(child.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch {} }, 2000).unref(); }
async function freePort() { const net = await import('node:net'); return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }
const docker = (...a) => spawnSync('docker', a, { encoding: 'utf8' });

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async connect(url) { const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 }); await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }); const c = new Cdp(ws); ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && c.waiting.has(m.id)) { const { res, rej } = c.waiting.get(m.id); c.waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } }); return c; }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.waiting.set(id, { res, rej })); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`); return r.result?.value; }
  async waitFor(label, expr, timeoutMs = 30000) { const t0 = Date.now(); while (Date.now() - t0 < timeoutMs) { try { if (await this.eval(expr)) return true; } catch {} await sleep(150); } console.log(`  (timed out: ${label})`); return false; }
  async theme(tone) { await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: tone }] }); }
  async shot(file) { const r = await this.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); console.log(`  shot ${path.basename(file)}`); }
  close() { try { this.ws.close(); } catch {} }
}

let cdp = null, projectId = null, tmp = null, histPre = true;
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat155-dfui-'));
  const DATA = path.join(tmp, 'data'), PROJ = path.join(tmp, 'proj');
  for (const dd of [DATA, PROJ]) fs.mkdirSync(dd, { recursive: true });
  fs.writeFileSync(path.join(PROJ, 'README.md'), 'ui fixture\n');
  const DF = path.join(PROJ, 'Dockerfile.orchard');
  const writeDf = (body) => fs.writeFileSync(DF, `ARG ORCHARD_BASE_IMAGE\nFROM \${ORCHARD_BASE_IMAGE}\n${body}\n`);
  writeDf('USER root\nRUN echo ok > /opt/marker\nUSER claude');
  const port = await freePort();
  const server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA }, stdio: ['ignore', 'ignore', 'pipe'] });
  procs.push(server);
  const base = `http://127.0.0.1:${port}`;
  const api = async (p, method = 'GET', body) => {
    const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };
  let up = false; for (let i = 0; i < 160 && !up; i++) { try { await fetch(`${base}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never healthy');
  const reg = await api('/api/projects', 'POST', { hostPath: PROJ, name: 'FEAT-155 Dockerfile UI', isolation: 'container' });
  projectId = reg.body?.project?.id;
  if (!projectId) throw new Error('project create failed: ' + JSON.stringify(reg));
  refuseTakenName(`claude-station-${projectId}`); // FEAT-158
  histPre = fs.existsSync(path.join(os.homedir(), '.claude', 'projects', `-workspace-${projectId}`));
  // A project that has been used for a while: memory raised, env set.
  await api(`/api/projects/${projectId}`, 'PATCH', { settings: { container: { memoryMb: 16384, env: { PYTHONPATH: '/workspace/pylibs' }, gpu: 'off' } } });

  const profile = path.join(tmp, 'chrome'); fs.mkdirSync(profile, { recursive: true });
  const browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--disable-extensions', '--window-size=1400,1300', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  procs.push(browser);
  let devPort = 0; for (let i = 0; i < 120 && !devPort; i++) { try { devPort = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); } }
  if (!devPort) throw new Error('no DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  cdp = await Cdp.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1300, deviceScaleFactor: 1, mobile: false });

  const dfRow = `[...document.querySelectorAll('[data-focus="isoSection"] .set')].find(s=>s.querySelector('input[aria-label="Dockerfile"]'))`;
  const openIsolation = async () => {
    await cdp.send('Page.navigate', { url: 'about:blank' }); // a fresh load, so the drawer re-reads container status
    await sleep(200);
    await cdp.send('Page.navigate', { url: `${base}/#/project/${encodeURIComponent(projectId)}` });
    await cdp.waitFor('app', `!!document.querySelector('#settingsBtn')`);
    await sleep(400);
    await cdp.eval(`document.querySelector('#settingsBtn').click()`);
    await cdp.waitFor('rail', `!!document.querySelector('.srail-item[data-cat="isolation"]')`);
    await cdp.eval(`document.querySelector('.srail-item[data-cat="isolation"]').click()`);
    await cdp.waitFor('dockerfile row', `!!(${dfRow})`, 15000);
    await sleep(600);
  };

  await openIsolation();
  const order = await cdp.eval(`[...document.querySelectorAll('[data-focus="isoSection"] .set > .l')].map(l=>l.firstChild.textContent).slice(0,3).join('|')`);
  check('the Dockerfile field sits directly after Base image', /^Base image\|Dockerfile(\||$)/.test(order), order);

  // Real click-path: type the path, press Enter.
  await cdp.eval(`document.querySelector('input[aria-label="Dockerfile"]').focus()`);
  await cdp.send('Input.insertText', { text: 'Dockerfile.orchard' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  let saved = null;
  for (let i = 0; i < 40 && saved !== 'Dockerfile.orchard'; i++) { await sleep(250); saved = (await api(`/api/projects/${projectId}`)).body?.project?.settings?.container?.dockerfile ?? null; }
  check('typing a path + Enter persists container.dockerfile (confirmed via the API)', saved === 'Dockerfile.orchard', saved);

  // A launch builds it.
  const s1 = await api(`/api/projects/${projectId}/container/start`, 'POST', {});
  check('a launch builds and runs it', s1.body?.state === 'running', `${s1.status} ${s1.body?.error ?? ''}`);
  await openIsolation();
  const builtText = await cdp.eval(`(${dfRow}).querySelector('.set-why.df-state')?.textContent ?? ''`);
  check('built state: the row says built from the file and that it rebuilds on change', /^Built from Dockerfile\.orchard \(df-[0-9a-f]{12}\)/.test(builtText) && /session starts/.test(builtText), builtText);
  const imgNote = await cdp.eval(`[...document.querySelectorAll('[data-focus="isoSection"] .set')].find(s=>s.querySelector('input[aria-label="Base image"]'))?.querySelector('.set-why:not(.disclosure)')?.textContent ?? ''`);
  check('Base image says it is not used while a Dockerfile is set', /Not used while/.test(imgNote), imgNote);
  for (const tone of ['light', 'dark']) {
    await cdp.theme(tone); await openIsolation();
    await cdp.eval(`document.querySelector('[data-focus="isoSection"]').scrollIntoView({block:'start'})`); await sleep(400);
    await cdp.shot(path.join(OUT, `feat155-dockerfile-built-${tone}.png`));
  }

  // Edit into a failing Dockerfile whose output carries HTML + escapes.
  writeDf(`USER root\nRUN echo '<img src=x onerror="window.__xss=1">' && printf '\\033[31mRED\\033[0m \\033]0;title\\007\\n' && echo step-failed-on-purpose && exit 3\nUSER claude`);
  const s2 = await api(`/api/projects/${projectId}/container/start`, 'POST', {});
  check('the failing edit keeps the container running', s2.body?.state === 'running', `${s2.status} ${s2.body?.error ?? ''}`);
  await cdp.theme('light'); await openIsolation();
  const failText = await cdp.eval(`(${dfRow}).querySelector('.set-why.df-state')?.textContent ?? ''`);
  check('failed state: names the failure and the last good image it is running', /^Not built: .*Running the last good image \(df-[0-9a-f]{12}\)/s.test(failText), failText);
  await cdp.eval(`(${dfRow}).querySelector('.df-logtog').click()`);
  await cdp.waitFor('log', `(()=>{const p=(${dfRow})?.querySelector('pre.buildlog');return p && !/reading/.test(p.textContent);})()`, 10000);
  const logState = await cdp.eval(`(()=>{const p=(${dfRow}).querySelector('pre.buildlog');return {text:p.textContent, kids:p.children.length, imgs:document.querySelectorAll('pre.buildlog img').length, xss: window.__xss ?? null, esc: /[\\u001b\\u0007]/.test(p.textContent)};})()`);
  check('Build log › opens the real build log (BuildKit step headers) with the failing step', /#\d+ \[/.test(logState.text) && /step-failed-on-purpose/.test(logState.text) && /<img src=x/.test(logState.text) && !/could not read/.test(logState.text), logState.text.split('\n').filter((l) => /failed-on-purpose|img/.test(l)).slice(0, 2).join(' | '));
  check('ATTACK: HTML and ANSI/OSC escapes in build output render as inert text (no element, no script, no escape bytes)', logState.kids === 0 && logState.imgs === 0 && logState.xss === null && !logState.esc, JSON.stringify({ kids: logState.kids, imgs: logState.imgs, xss: logState.xss, esc: logState.esc }));
  for (const tone of ['light', 'dark']) {
    await cdp.theme(tone); await openIsolation();
    await cdp.eval(`(${dfRow}).querySelector('.df-logtog')?.click()`);
    await cdp.waitFor('log', `(()=>{const p=(${dfRow})?.querySelector('pre.buildlog');return p && !/reading/.test(p.textContent);})()`, 10000);
    await cdp.eval(`(${dfRow}).querySelector('pre.buildlog').scrollTop = 1e9; (${dfRow}).scrollIntoView({block:'start'})`); await sleep(400);
    await cdp.shot(path.join(OUT, `feat155-dockerfile-failed-${tone}.png`));
    await cdp.eval(`(${dfRow}).querySelector('.df-logtog')?.click()`); // close again so the next open starts closed
    await sleep(200);
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  console.log('screenshots in', OUT);
}
try { await main(); } catch (e) { console.error('HARNESS ERROR', e.stack || e.message); fail++; } finally {
  cdp?.close(); for (const p of procs) stopByPid(p); await sleep(600);
  if (projectId) {
    // FEAT-158: only what this run's server owns (its data dir's owner key); the names are fixed slugs.
    const OWNER = await ownerKeyFor(path.join(tmp, 'data'));
    removeOwnedContainer(`claude-station-${projectId}`, OWNER, { volumes: true });
    removeOwnedImages(`claude-station-project-${projectId}`, OWNER);
    pruneOwnedImages(OWNER, [`claude-station.dockerfile-project=${projectId}`]);
  }
  try { if (tmp) await removeScratchBuilders(path.join(tmp, 'data')); } catch {} // ARCH-020: this data dir's builders
  try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  if (projectId && !histPre) { try { fs.rmSync(path.join(os.homedir(), '.claude', 'projects', `-workspace-${projectId}`), { recursive: true, force: true }); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
}
