/**
 * BUG-283 r3 — the settings drawer's add-forms must not save from a RENDER.
 *
 *   node scripts/verify-bug-283-no-render-loop.mjs            # current public/ (must pass)
 *   node scripts/verify-bug-283-no-render-loop.mjs --old <drawer.js>
 *                                                             # serve another drawer.js (must-FAIL proof)
 *
 * The fault (r1/r2): paint() removes the focused add-form input; Chrome fires
 * `blur` on it; the blur handler commits; r1 re-renders the refused draft into
 * the rebuilt input, so a refused save repaints → blur → saves again → refused
 * → repaints … Measured 2497 PATCHes in ~4 s on a scratch server, the input
 * rebuilt (focus dropped) every turn.
 *
 * Drives the REAL drawer with REAL CDP mouse/keyboard input against a REAL
 * scratch server + a container project whose settings mirror a busy real one
 * (a real one: workspaceRoot, a Dockerfile, env, GPU, 20 GB) — the server
 * refusal is the server's own 400, not a stub. Background repaints are driven
 * through the same `drawer.repaintLive()` a live session's events call.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';
const oldIdx = process.argv.indexOf('--old');
const OLD_DRAWER = oldIdx > 0 ? path.resolve(process.argv[oldIdx + 1]) : null;
const REFUSED = '/nonexistent-bug283-r3/backups';

let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

const procs = [];
const dirs = [];
function stopByPid(child) { if (!child || child.exitCode !== null) return; try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref(); }

/** A temp tree serving `drawer` as public/lib/drawer.js (everything else is this checkout's). */
function treeWith(drawer) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b283r3-tree-')); dirs.push(tmp);
  for (const d of ['src', 'public']) fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true });
  for (const f of ['package.json', 'tsconfig.json']) { try { fs.cpSync(path.join(ROOT, f), path.join(tmp, f)); } catch { /* optional */ } }
  for (const d of ['node_modules', 'scripts', 'docs']) fs.symlinkSync(path.join(ROOT, d), path.join(tmp, d));
  fs.copyFileSync(drawer, path.join(tmp, 'public', 'lib', 'drawer.js'));
  return tmp;
}

async function bootServer(repoRoot) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'b283r3-data-')); dirs.push(data);
  const srv = spawn(process.execPath, [path.join(repoRoot, 'src', 'server', 'index.ts')], {
    cwd: repoRoot, env: { ...process.env, PORT: String(port), CLAUDE_STATION_DATA: data }, stdio: ['ignore', 'ignore', 'ignore'],
  });
  procs.push(srv);
  for (let i = 0; i < 80; i++) { try { await fetch(`${base}/api/health`); return base; } catch { await sleep(250); } }
  throw new Error('scratch server never became healthy');
}

async function busyContainerProject(base) {
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b283r3-proj-')); dirs.push(projDir);
  fs.writeFileSync(path.join(projDir, 'Dockerfile.orchard'), 'FROM scratch\n');
  const j = async (method, url, body) => {
    const r = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const t = await r.text();
    if (!r.ok) throw new Error(`${method} ${url} ${r.status}: ${t.slice(0, 200)}`);
    return JSON.parse(t);
  };
  const pid = (await j('POST', '/api/projects', { hostPath: projDir, name: 'b283r3-busy' })).project.id;
  await j('PATCH', `/api/projects/${pid}`, { isolation: 'container' });
  await j('PATCH', `/api/projects/${pid}`, { settings: { container: {
    memoryMb: 20480, gpu: 'auto', env: { PYTHONPATH: '/workspace/pylibs' }, workspaceRoot: true, dockerfile: 'Dockerfile.orchard', ports: [],
  }, laneDocker: 'host' } });
  return pid;
}

class Tab {
  static async open(base) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'b283r3-br-')); dirs.push(profile);
    const br = spawn(BRAVE, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--disable-extensions', '--window-size=1000,1300', 'about:blank'], { stdio: 'ignore' });
    procs.push(br);
    let dev = 0;
    for (let i = 0; i < 80 && !dev; i++) { try { dev = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); } }
    if (!dev) throw new Error('brave devtools never came up');
    const target = (await (await fetch(`http://127.0.0.1:${dev}/json/list`)).json()).find((x) => x.type === 'page');
    const WebSocket = (await import('ws')).default;
    const t = new Tab();
    t.ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 1 << 26 });
    await new Promise((r, rej) => { t.ws.once('open', r); t.ws.once('error', rej); });
    t.id = 0; t.waiting = new Map(); t.reqs = []; t.counting = false;
    t.ws.on('message', (m) => {
      const j = JSON.parse(m);
      if (j.id && t.waiting.has(j.id)) { const w = t.waiting.get(j.id); t.waiting.delete(j.id); j.error ? w.rej(new Error(j.error.message)) : w.res(j.result); }
      else if (j.method === 'Network.requestWillBeSent' && t.counting) t.reqs.push(`${j.params.request.method} ${new URL(j.params.request.url).pathname}`);
    });
    await t.send('Page.enable'); await t.send('Network.enable');
    await t.send('Page.navigate', { url: `${base}/` });
    await t.waitFor('window.__station !== undefined');
    return t;
  }
  // Bounded: on the old build the save loop can starve the page, and a hung
  // eval must FAIL the run, not hang it.
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.waiting.delete(id); rej(new Error(`CDP ${method} timed out (page unresponsive)`)); }, 15_000);
      this.waiting.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async waitFor(expr, ms = 20_000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await this.eval(expr)) return true; } catch { /* nav */ } await sleep(150); } return false; }
  async click(xy) { for (const type of ['mousePressed', 'mouseReleased']) await this.send('Input.dispatchMouseEvent', { type, x: xy.x, y: xy.y, button: 'left', clickCount: 1 }); }
  async type(text) { await this.send('Input.insertText', { text }); }
  async key(key, code = key, vk = 0) { for (const type of ['keyDown', 'keyUp']) await this.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk }); }
  /** Count network requests (and add-form input rebuilds) over `ms`, running `during` first. */
  async window(ms, aria, during = async () => {}) {
    await this.eval(`(() => { window.__b283 = 0; window.__b283mo?.disconnect();
      window.__b283mo = new MutationObserver((recs) => { for (const r of recs) for (const n of r.addedNodes) {
        if (n.nodeType === 1 && (n.matches?.('input[aria-label=${JSON.stringify(aria)}]') || n.querySelector?.('input[aria-label=${JSON.stringify(aria)}]'))) window.__b283++; } });
      window.__b283mo.observe(document.querySelector('#smodal'), { childList: true, subtree: true }); })()`);
    this.reqs = []; this.counting = true;
    await during();
    await sleep(ms);
    this.counting = false;
    const renders = await this.eval('(() => { window.__b283mo.disconnect(); return window.__b283; })()');
    const by = {}; for (const r of this.reqs) by[r] = (by[r] ?? 0) + 1;
    const writes = this.reqs.filter((r) => !r.startsWith('GET ')).length;
    return { total: this.reqs.length, writes, renders, by };
  }
  focused() { return this.eval(`(() => { const a = document.activeElement; return a?.getAttribute?.('aria-label') ?? a?.tagName ?? null; })()`); }
  input(aria) { return this.eval(`(() => { const i = document.querySelector('#smodal input[aria-label=${JSON.stringify(aria)}]'); if (!i) return null; i.scrollIntoView({ block: 'nearest' }); const r = i.getBoundingClientRect(); return { x: r.x + 24, y: r.y + r.height / 2, value: i.value }; })()`); }
  addButton(label) { return this.eval(`(() => { const b = [...document.querySelectorAll('#smodal button.addrow')].find((x) => x.textContent.includes(${JSON.stringify(label)})); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`); }
  saveErr() { return this.eval(`(() => { const e = document.querySelector('#dSaveErr'); return e && !e.hidden ? e.textContent : ''; })()`); }
}

async function openIso(tab, pid, focus) {
  await tab.eval(`(() => { const S = window.__station; S.selectProject(${JSON.stringify(pid)}); S.drawer.close?.(); S.drawer.open('settings', { focus: ${JSON.stringify(focus)} }); })()`);
  await tab.waitFor(`!document.querySelector('#smodal').hidden`);
  // let the opening fetches (container status etc.) land and their repaints settle
  await tab.waitFor(`!/Checking the container/.test(document.querySelector('#smodal').textContent)`, 8000);
  await sleep(800);
}

/** (Keeps a failing old build measurable past its first failure.) Make sure the
 *  form is open and its input focused + emptied, re-opening it if a repaint closed it. */
async function ensureFocused(tab, btn, aria) {
  for (let i = 0; i < 3 && !(await tab.input(aria)); i++) { const b = await tab.addButton(btn); if (b) await tab.click(b); await sleep(150); }
  await tab.eval(`(() => { const i = document.querySelector('#smodal input[aria-label=${JSON.stringify(aria)}]'); if (i) { i.focus(); i.select(); } })()`);
}

/** Open an add-form with a REAL click; returns the focus 200 ms later. */
async function openForm(tab, btn, aria) {
  const b = await tab.addButton(btn);
  if (!b) return { opened: false };
  await tab.click(b);
  await sleep(200);
  return { opened: !!(await tab.input(aria)), focus200: await tab.focused() };
}

async function run() {
  const tree = OLD_DRAWER ? treeWith(OLD_DRAWER) : ROOT;
  console.log(`\n--- drawer under test: ${OLD_DRAWER ?? 'public/lib/drawer.js (current)'} ---`);
  const base = await bootServer(tree);
  const pid = await busyContainerProject(base);
  const tab = await Tab.open(base);

  /* 1. a real click opens the mount form: focus lands and stays, nothing is saved */
  await openIso(tab, pid, 'mounts');
  let f;
  const w1 = await tab.window(3000, 'New mount', async () => { f = await openForm(tab, 'Add mount', 'New mount'); });
  check('(1a) one click on "+ Add mount" opens the form with the input focused 200 ms later', f.opened && f.focus200 === 'New mount', f);
  check('(1b) opening the form writes nothing (0 PATCH/POST in 3 s)', w1.writes === 0, w1);
  check('(1c) still focused 3 s after the click', (await tab.focused()) === 'New mount', await tab.focused());

  /* 2. typing, then background repaints (what a live session's events do): no save, no focus loss, text kept */
  await tab.type('/half/typ');
  const w2 = await tab.window(1500, 'New mount', async () => {
    for (let i = 0; i < 5; i++) { await tab.eval('window.__station.drawer.repaintLive()'); await sleep(80); }
  });
  const in2 = await tab.input('New mount');
  check('(2a) 5 background repaints while typing save NOTHING (0 writes)', w2.writes === 0, w2);
  check('(2b) the form stays open with the half-typed text and keeps focus',
    !!in2 && in2.value === '/half/typ' && (await tab.focused()) === 'New mount', { in2, focus: await tab.focused() });

  /* 3. a refused save: exactly ONE request, inline banner, input kept + focused */
  await ensureFocused(tab, 'Add mount', 'New mount');
  const w3 = await tab.window(3000, 'New mount', async () => { await tab.type(REFUSED); await tab.key('Enter', 'Enter', 13); });
  check('(3a) a refused mount save sends exactly ONE PATCH in 3 s (no render loop)', w3.writes === 1, w3);
  check('(3b) ...and rebuilds the form at most twice (one render per state change)', w3.renders <= 2, { renders: w3.renders });
  const err3 = await tab.saveErr();
  check('(3c) BUG-283 banner still shows the server refusal inline', /host path does not exist/.test(err3) && err3.includes(REFUSED), err3);
  const in3 = await tab.input('New mount');
  check('(3d) the refused text is preserved in the input, which has focus', in3?.value === REFUSED && (await tab.focused()) === 'New mount', { in3, focus: await tab.focused() });

  /* 4. click elsewhere then ONE click on the input: it takes focus and keeps it; no request */
  // click a non-interactive spot INSIDE the drawer (the banner text) so the input blurs
  const away = await tab.eval(`(() => { const r = (document.querySelector('#dSaveErr') ?? document.querySelector('#dBody')).getBoundingClientRect(); return { x: r.x + 10, y: r.y + r.height / 2 }; })()`);
  const wAway = await tab.window(1500, 'New mount', async () => { await tab.click(away); });
  const away4 = { focus: await tab.focused(), form: !!(await tab.input('New mount')), writes: wAway.writes };
  check('(4-) clicking away from the refused, unchanged input: form stays open, focus NOT yanked back, no re-send',
    away4.form && away4.focus !== 'New mount' && wAway.writes === 0, away4);
  const xy = await tab.input('New mount');
  let f4;
  const w4 = await tab.window(2000, 'New mount', async () => { if (xy) { await tab.click(xy); await sleep(200); f4 = await tab.focused(); } });
  check('(4a) after a refusal, ONE click focuses the input (200 ms later)', f4 === 'New mount', { f4 });
  check('(4b) ...and it is still focused 2 s later', (await tab.focused()) === 'New mount', await tab.focused());
  check('(4c) clicking back into the input writes nothing', w4.writes === 0, w4);

  /* 5. a host path that EXISTS saves: one PATCH, the form closes, the mount is listed */
  const okPath = fs.existsSync('/mnt/backup') ? '/mnt/backup' : fs.mkdtempSync(path.join(os.tmpdir(), 'b283r3-mnt-'));
  if (okPath !== '/mnt/backup') dirs.push(okPath);
  await ensureFocused(tab, 'Add mount', 'New mount');
  const w5 = await tab.window(2500, 'New mount', async () => { await tab.type(okPath); await tab.key('Enter', 'Enter', 13); });
  const listed = await tab.eval(`[...document.querySelectorAll('#smodal .mrow .p')].some((n) => n.textContent.includes(${JSON.stringify(path.basename(okPath))}))`);
  const saved = (await (await fetch(`${base}/api/projects/${pid}`)).json());
  const mounts = (saved.project ?? saved).settings?.mounts ?? [];
  check(`(5) an existing host path (${okPath}) saves with ONE PATCH, form closes, mount listed`,
    w5.writes === 1 && listed && !(await tab.input('New mount')) && mounts.some((m) => m.hostPath === okPath), { w5, listed, mounts });

  /* 6. class sweep: the other add-forms, one refusal each */
  const sweep = [
    { name: 'env (SERVER 400)', focus: 'env', btn: 'Add variable', aria: 'New environment variable', text: 'HOME=/tmp/x', expect: /reserved/ },
    { name: 'ports (client)', focus: 'mounts', btn: 'Publish a port', aria: 'New published port', text: 'notaport', expect: /HOST:CONTAINER/ },
    { name: 'services (client)', focus: 'services', btn: 'Add service', aria: 'New service', text: 'onlyname', expect: /name and an image/ },
  ];
  for (const s of sweep) {
    await openIso(tab, pid, s.focus);
    const o = await openForm(tab, s.btn, s.aria);
    const w = await tab.window(3000, s.aria, async () => { await tab.type(s.text); await tab.key('Enter', 'Enter', 13); });
    const err = await tab.saveErr();
    const inp = await tab.input(s.aria);
    const fo = await tab.focused();
    check(`(6 ${s.name}) opens focused; refusal = <= 1 write, <= 2 renders; banner; text kept + focused`,
      o.opened && o.focus200 === s.aria && w.writes <= 1 && w.renders <= 2 && s.expect.test(err) && inp?.value === s.text && fo === s.aria,
      { open: o, writes: w.writes, renders: w.renders, by: w.by, err, value: inp?.value, focus: fo });
  }

  /* 7. class sweep: every drawer category, idle — no request storm from rendering */
  await openIso(tab, pid, 'mounts');
  const cats = await tab.eval(`[...document.querySelectorAll('#smodal .srail-item')].map((b) => b.dataset.cat)`);
  const idle = {};
  for (const c of cats) {
    await tab.eval(`document.querySelector('#smodal .srail-item[data-cat=${JSON.stringify(c)}]').click()`);
    const w = await tab.window(2000, '__none__');
    idle[c] = w.total;
  }
  const worst = Math.max(...Object.values(idle));
  check(`(7) every one of ${cats.length} drawer categories, 2 s idle after selecting it, sends <= 20 requests`, worst <= 20, idle);
}

try {
  await run();
} catch (e) {
  console.error(e); fail++;
} finally {
  for (const p of procs) stopByPid(p);
  await sleep(500);
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
