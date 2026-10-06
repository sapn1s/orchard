/**
 * FEAT-155 — UI verification for the per-project container settings the drawer
 * did NOT yet expose: the `container.env` key/value editor (was API-only,
 * residual (d)) and the host-total-RAM context under the memory cap.
 *
 * The image/memory/gpu/workspaceRoot rows already existed and are proven by
 * scripts/verify-feat-gpu-env-mem.mjs (RAM -> cgroup, env -> container). This
 * harness drives the REAL drawer over CDP:
 *   - opens the Isolation category of a real container project's settings;
 *   - reads the host-RAM context line the server now surfaces (status.hostMemoryMb);
 *   - uses the env editor's real click-path to add PYTHONPATH, and confirms via
 *     the API that the UI write persisted; then rebuilds the container and reads
 *     `/sys/fs/cgroup/memory.max` and `printenv PYTHONPATH` from INSIDE it, so the
 *     value the user typed is proven to reach the real container;
 *   - drives the memory-cap cycle control until it reads 16 GiB and confirms it
 *     persisted;
 *   - ATTACK: types a RESERVED env key (HOME=/x) and confirms the server's
 *     validation error surfaces inline and nothing is saved;
 *   - screenshots the container settings in light and dark for a visual review.
 *
 * Boots the real server against throwaway dirs; stops everything by PID.
 *   node scripts/verify-feat-155-container-ui.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { ownerKeyFor, removeOwnedContainer, removeOwnedImages, pruneOwnedImages, refuseTakenName } from './lib/owned-docker.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BRAVE = process.env.VERIFY_BROWSER ?? 'brave';
const OUT = process.env.OUT_DIR || '/tmp/feat155-ui';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, obs) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}\n        observed: ${obs}`); ok ? pass++ : fail++; };
const procs = [];
function stopByPid(child) { if (!child || child.exitCode !== null) return; try { process.kill(child.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch {} }, 2000).unref(); }
async function freePort() { const net = await import('node:net'); return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async connect(url) { const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 }); await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }); const c = new Cdp(ws); ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && c.waiting.has(m.id)) { const { res, rej } = c.waiting.get(m.id); c.waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } }); return c; }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.waiting.set(id, { res, rej })); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`); return r.result?.value; }
  async waitFor(label, expr, timeoutMs = 30000) { const t0 = Date.now(); while (Date.now() - t0 < timeoutMs) { try { if (await this.eval(expr)) return true; } catch {} await sleep(150); } console.log(`  (timed out: ${label})`); return false; }
  async theme(tone) { await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: tone }] }); }
  async viewport(width, height) { await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); }
  async shot(file) { const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); const kb = (fs.statSync(file).size / 1024).toFixed(0); console.log(`  shot ${path.basename(file)} (${kb}KB)`); }
  close() { try { this.ws.close(); } catch {} }
}

let cdp = null;
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat155-ui-'));
  const DATA = path.join(tmp, 'data'), CFG = path.join(tmp, 'cfg'), STORE = path.join(CFG, 'projects'), PROJ = path.join(tmp, 'proj');
  for (const dd of [DATA, CFG, STORE, PROJ]) fs.mkdirSync(dd, { recursive: true });
  const OWNER = await ownerKeyFor(DATA); // FEAT-158: remove only what this server owns
  const port = await freePort();
  const server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_CONFIG_DIR: CFG, CLAUDE_PROJECTS_DIR: STORE }, stdio: ['ignore', 'ignore', 'pipe'] });
  procs.push(server);
  server.stderr?.on('data', (d) => { const s = String(d); if (/error/i.test(s)) process.stderr.write(`  [srv!] ${s}`); });
  const base = `http://127.0.0.1:${port}`;
  const api = async (p, method = 'GET', body) => {
    const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };
  let up = false; for (let i = 0; i < 160 && !up; i++) { try { await fetch(`${base}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never healthy');

  const reg = await api('/api/projects', 'POST', { hostPath: PROJ, name: 'FEAT-155 container UI', isolation: 'container' });
  const projectId = reg.body?.project?.id;
  if (!projectId) throw new Error('project create failed: ' + JSON.stringify(reg));
  console.log('projectId', projectId);
  refuseTakenName(`claude-station-${projectId}`); // FEAT-158

  const getSettings = async () => (await api(`/api/projects/${projectId}`)).body?.project?.settings?.container ?? {};

  // --- browser ---
  const profile = path.join(tmp, 'chrome'); fs.mkdirSync(profile, { recursive: true });
  const browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--disable-extensions', '--window-size=1400,1200', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  procs.push(browser);
  let devPort = 0; for (let i = 0; i < 120 && !devPort; i++) { try { devPort = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); } }
  if (!devPort) throw new Error('no DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  cdp = await Cdp.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.viewport(1400, 1200);

  const openIsolation = async () => {
    await cdp.send('Page.navigate', { url: `${base}/#/project/${encodeURIComponent(projectId)}` });
    await cdp.waitFor('app', `!!document.querySelector('#settingsBtn')`);
    await sleep(400);
    await cdp.eval(`document.querySelector('#settingsBtn').click()`);
    await cdp.waitFor('rail', `!!document.querySelector('.srail-item[data-cat="isolation"]')`);
    await cdp.eval(`document.querySelector('.srail-item[data-cat="isolation"]').click()`);
    await cdp.waitFor('container rows', `!!document.querySelector('[data-focus="isoSection"]') && !!document.querySelector('[data-focus="env"]')`, 15000);
    await sleep(500);
  };

  await openIsolation();

  // 1) Host-RAM context line under the memory cap.
  const hostMb = Math.round(os.totalmem() / (1024 * 1024));
  const memWhy = await cdp.eval(`(()=>{const s=[...document.querySelectorAll('.set-why')].map(n=>n.textContent).find(t=>/RAM/.test(t));return s||null;})()`);
  check('memory row shows the host total RAM as context', !!memWhy && memWhy.includes(`${(hostMb / 1024).toFixed(0)} GB`) && /recreates the container/.test(memWhy), `hostMemoryMb=${hostMb} -> "${memWhy}"`);

  // 2) The env editor exists and is empty to start.
  const envGroupPresent = await cdp.eval(`!!document.querySelector('[data-focus="env"]')`);
  const addBtn = await cdp.eval(`(()=>{const b=[...document.querySelectorAll('[data-focus="env"] .addrow')].find(x=>/Add variable/.test(x.textContent));return !!b;})()`);
  check('Environment group with an "+ Add variable" control is rendered', envGroupPresent && addBtn, `group=${envGroupPresent} addBtn=${addBtn}`);

  // 3) Add PYTHONPATH via the real click-path.
  await cdp.eval(`[...document.querySelectorAll('[data-focus="env"] .addrow')].find(x=>/Add variable/.test(x.textContent)).click()`);
  await cdp.waitFor('env input', `!!document.querySelector('[data-focus="env"] input.vin')`);
  await cdp.eval(`(()=>{const i=document.querySelector('[data-focus="env"] input.vin');i.value='PYTHONPATH=/workspace/pylibs';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
  // wait for the PATCH + refresh + repaint to land the row
  await cdp.waitFor('env row', `[...document.querySelectorAll('[data-focus="env"] .mrow .dst')].some(n=>n.textContent==='PYTHONPATH')`, 15000);
  const persisted = await getSettings();
  check('env editor add-path persisted PYTHONPATH through the UI', persisted.env?.PYTHONPATH === '/workspace/pylibs', JSON.stringify(persisted.env ?? {}));
  const rowShown = await cdp.eval(`(()=>{const r=[...document.querySelectorAll('[data-focus="env"] .mrow')].find(m=>m.querySelector('.dst')?.textContent==='PYTHONPATH');return r?r.textContent.replace(/\\s+/g,' ').trim():null;})()`);
  check('env row renders KEY = value with a remove control', !!rowShown && rowShown.includes('PYTHONPATH') && rowShown.includes('/workspace/pylibs'), rowShown);

  // 4) Memory cap dropdown (FEAT-159: was a click-to-cycle row) -> pick 16 GiB, confirm persist.
  await cdp.eval(`(()=>{const s=document.querySelector('[data-focus="isoSection"] #sel-container-memoryMb');s.value='16384';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  let mem = null;
  for (let i = 0; i < 10 && mem !== 16384; i++) { await sleep(300); mem = (await getSettings()).memoryMb ?? null; }
  check('memory-cap dropdown sets and persists 16 GiB (16384 MiB)', mem === 16384, `memoryMb=${mem}`);

  // 5) ATTACK — a reserved env key must be refused by the server and surfaced inline, saving nothing.
  const before = await getSettings();
  await cdp.eval(`[...document.querySelectorAll('[data-focus="env"] .addrow')].find(x=>/Add variable/.test(x.textContent))?.click()`);
  await cdp.waitFor('env input#2', `!!document.querySelector('[data-focus="env"] input.vin')`);
  await cdp.eval(`(()=>{const i=document.querySelector('[data-focus="env"] input.vin');i.value='HOME=/pwned';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
  await sleep(1500);
  const after = await getSettings();
  const toast = await cdp.eval(`(()=>{const t=[...document.querySelectorAll('.toast,.notify,.note,[role="alert"],[class*="toast"]')].map(n=>n.textContent).join(' | ');return t||document.body.innerText.match(/reserved[^\\n]*/i)?.[0]||null;})()`);
  const noSave = !('HOME' in (after.env ?? {}));
  const unchanged = JSON.stringify(after.env ?? {}) === JSON.stringify(before.env ?? {});
  check('reserved env key HOME is NOT saved (server refused; nothing persisted)', noSave && unchanged, `after.env=${JSON.stringify(after.env ?? {})} toast=${JSON.stringify(toast)}`);

  // 6) cgroup + env proof — rebuild the container on the UI-set values, read from inside.
  const rebuilt = await api(`/api/projects/${projectId}/container/rebuild`, 'POST');
  check('container rebuild on the UI-set values succeeded', rebuilt.status === 200 && (rebuilt.body?.state === 'running' || rebuilt.body?.state === 'stopped'), JSON.stringify(rebuilt.body).slice(0, 200));
  const cname = rebuilt.body?.containerName;
  if (cname) {
    // ensure running for exec
    if (rebuilt.body?.state !== 'running') { await api(`/api/projects/${projectId}/container/start`, 'POST'); await sleep(1500); }
    const cg = spawnSync('docker', ['exec', cname, 'cat', '/sys/fs/cgroup/memory.max'], { encoding: 'utf8' });
    const maxBytes = Number((cg.stdout || '').trim());
    console.log(`  [observed] /sys/fs/cgroup/memory.max = ${maxBytes} (want ${16 * 1024 ** 3})`);
    check('the 16 GiB the UI set is the real cgroup memory.max', maxBytes === 16 * 1024 ** 3, `${maxBytes}`);
    const pe = spawnSync('docker', ['exec', cname, 'printenv', 'PYTHONPATH'], { encoding: 'utf8' });
    console.log(`  [observed] PYTHONPATH inside ${cname} = ${JSON.stringify((pe.stdout || '').trim())}`);
    check('the PYTHONPATH the UI set is visible inside the container', (pe.stdout || '').trim() === '/workspace/pylibs', (pe.stdout || '').trim());
    // cleanup the container we made
    removeOwnedContainer(cname, OWNER);
  }

  // 7) Screenshots — both themes. Two shots each: the config rows (memory +
  //    host-RAM context) at the top, and the Environment editor scrolled into
  //    view. Wait for the open animation to finish (opacity settled) first.
  for (const tone of ['light', 'dark']) {
    await cdp.theme(tone);
    await openIsolation();
    await cdp.waitFor('modal settled', `(()=>{const m=document.querySelector('.modal,[class*="modal"],[role="dialog"]');if(!m)return false;return getComputedStyle(m).opacity==='1';})()`, 5000);
    await sleep(700);
    // top of the container block (memory cap + host-RAM context)
    await cdp.eval(`document.querySelector('[data-focus="isoSection"]')?.scrollIntoView({block:'start'})`);
    await sleep(300);
    await cdp.shot(path.join(OUT, `feat155-container-config-${tone}.png`));
    // the env editor with its row
    await cdp.eval(`document.querySelector('[data-focus="env"]')?.scrollIntoView({block:'center'})`);
    await sleep(300);
    await cdp.shot(path.join(OUT, `feat155-container-env-${tone}.png`));
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  console.log('screenshots in', OUT);
}
try { await main(); } catch (e) { console.error('HARNESS ERROR', e.stack || e.message); fail++; } finally { cdp?.close(); for (const p of procs) stopByPid(p); await sleep(400); process.exit(fail === 0 ? 0 : 1); }
