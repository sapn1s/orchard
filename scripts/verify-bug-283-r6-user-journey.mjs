/**
 * BUG-283 r6 — the user's own journey, in a real headless browser (Playwright), light AND dark.
 *
 *   node scripts/verify-bug-283-r6-user-journey.mjs                 # current public/ (must pass)
 *   node scripts/verify-bug-283-r6-user-journey.mjs --old <drawer.js>  # serve another drawer.js
 *
 * The user's words (session 4ea3d0d2, 2026-10-28T03:45:35Z), after adding the mount
 * `/backups` in Settings and finding only console lines
 *   "PATCH …/api/projects/b283r6-busy-lab 400 (Bad Request)"
 *   "[station] could not save mounts: mounts[0]: host path does not exist: /backups"  (twice):
 *     "oh ok, but either way, i got this error from console, should appear nicely in ux as toast or smtn"
 *
 * Acceptance (from those words): adding the mount `/backups` (which does not exist on this
 * machine) through the Settings drawer shows the server's refusal VISIBLY in the UI the user
 * is looking at — not only in the console — in both themes; the typed path is kept so it can
 * be corrected; the refusal costs one request, not two.
 *
 * Real click path: the header "⚙ Settings" pill → rail "Isolation & environment" →
 * "+ Add mount" → type → Enter. Real scratch server (free port, scratch data dir) and a
 * container project whose settings mirror a busy real one (synthetic: existing mount, env
 * vars, ports, memory cap, GPU). Screenshots: $TMPDIR/b283r6-shot-{light,dark}.png.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');
const oldIdx = process.argv.indexOf('--old');
const OLD_DRAWER = oldIdx > 0 ? path.resolve(process.argv[oldIdx + 1]) : null;
const USER_PATH = '/backups'; // the exact path the user typed
const SHOT_DIR = process.env.B283_SHOT_DIR ?? os.tmpdir();

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
const procs = [], dirs = [];
function stopByPid(c) { if (!c || c.exitCode !== null) return; try { process.kill(c.pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref(); }

function treeWith(drawer) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b283r6-tree-')); dirs.push(tmp);
  for (const d of ['src', 'public']) fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true });
  for (const f of ['package.json', 'tsconfig.json']) { try { fs.cpSync(path.join(ROOT, f), path.join(tmp, f)); } catch { /* optional */ } }
  for (const d of ['node_modules', 'scripts', 'docs']) fs.symlinkSync(path.join(ROOT, d), path.join(tmp, d));
  fs.copyFileSync(drawer, path.join(tmp, 'public', 'lib', 'drawer.js'));
  return tmp;
}
async function bootServer(repoRoot) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'b283r6-data-')); dirs.push(data);
  const srv = spawn(process.execPath, [path.join(repoRoot, 'src', 'server', 'index.ts')], {
    cwd: repoRoot, env: { ...process.env, PORT: String(port), CLAUDE_STATION_DATA: data }, stdio: ['ignore', 'ignore', 'ignore'],
  });
  procs.push(srv);
  for (let i = 0; i < 80; i++) { try { await fetch(`${base}/api/health`); return base; } catch { await sleep(250); } }
  throw new Error('scratch server never became healthy');
}
async function busyProject(base) {
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b283r6-proj-')); dirs.push(projDir);
  const libs = fs.mkdtempSync(path.join(os.tmpdir(), 'b283r6-libs-')); dirs.push(libs);
  const j = async (method, url, body) => {
    const r = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const t = await r.text();
    if (!r.ok) throw new Error(`${method} ${url} ${r.status}: ${t.slice(0, 200)}`);
    return JSON.parse(t);
  };
  const pid = (await j('POST', '/api/projects', { hostPath: projDir, name: 'b283r6-busy-lab' })).project.id;
  await j('PATCH', `/api/projects/${pid}`, { isolation: 'container' });
  await j('PATCH', `/api/projects/${pid}`, { settings: { container: {
    memoryMb: 20480, gpu: 'auto', env: { PYTHONPATH: '/workspace/pylibs', HF_HOME: '/workspace/.hf' }, workspaceRoot: true, ports: [{ hostPort: 8888, containerPort: 8888 }],
  } } });
  await j('PATCH', `/api/projects/${pid}`, { mounts: [{ hostPath: libs, containerPath: '/workspace/pylibs', mode: 'ro' }] });
  return pid;
}

async function journey(browser, base, pid, theme) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const writes = [];
  const warns = [];
  page.on('request', (r) => { if (r.method() === 'PATCH' && /\/api\/projects\//.test(r.url())) writes.push(r.postData()); });
  page.on('console', (m) => { if (m.type() === 'warning') warns.push(m.text()); });
  await page.goto(`${base}/`);
  await page.waitForFunction(() => window.__station !== undefined);
  await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
  await page.evaluate((id) => window.__station.selectProject(id), pid);
  // the user's path: header Settings pill -> Isolation & environment -> + Add mount
  await page.locator('#settingsBtn').click();
  await page.locator('#smodal').waitFor({ state: 'visible' });
  await page.locator('#smodal .srail-item[data-cat="isolation"]').click();
  await page.waitForFunction(() => !/Checking the container/.test(document.querySelector('#smodal').textContent), null, { timeout: 8000 }).catch(() => {});
  await page.locator('#smodal button.addrow', { hasText: 'Add mount' }).click();
  const input = page.locator('#smodal input[aria-label="New mount"]');
  await input.waitFor({ state: 'visible' });
  await input.pressSequentially(USER_PATH, { delay: 20 });
  writes.length = 0;
  await page.keyboard.press('Enter'); // the focused field; a build that tears the form down must still be graded
  await sleep(1800); // the server's refusal + any repaint it causes

  const r = await page.evaluate(() => {
    const vis = (e) => { if (!e || e.hidden) return false; const b = e.getBoundingClientRect(); const cs = getComputedStyle(e);
      return b.width > 0 && b.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && b.top >= 0 && b.bottom <= innerHeight; };
    const modal = document.querySelector('#smodal');
    // any visible element INSIDE the drawer carrying the refusal (banner, toast, inline line…)
    const carriers = [...modal.querySelectorAll('*')].filter((e) => vis(e) && [...e.childNodes].some((n) => n.nodeType === 3 && /host path does not exist/.test(n.textContent)));
    const c = carriers[0] ?? null;
    const box = c?.getBoundingClientRect();
    // is the carrier really on top at its centre (not behind another layer)?
    const onTop = box ? (() => { const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2); return !!hit && (hit === c || c.contains(hit)); })() : false;
    const i = modal.querySelector('input[aria-label="New mount"]');
    const ib = i?.getBoundingClientRect();
    const overlap = box && ib ? !(box.bottom <= ib.top || box.top >= ib.bottom || box.right <= ib.left || box.left >= ib.right) : null;
    const cs = c ? getComputedStyle(c) : null;
    // WCAG contrast of the carrier's text against its own (or nearest opaque ancestor's) background
    // normalise ANY CSS colour (rgb(), color(srgb …) from color-mix, …) through a canvas pixel
    const cv = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const rgb = (s) => { cv.clearRect(0, 0, 1, 1); cv.fillStyle = '#000'; cv.fillStyle = s; cv.fillRect(0, 0, 1, 1); const [r, g, b, a] = cv.getImageData(0, 0, 1, 1).data; return [r, g, b, a / 255]; };
    let bgEl = c, bg = null;
    while (bgEl) { const v = rgb(getComputedStyle(bgEl).backgroundColor); if (v.length >= 3 && (v[3] ?? 1) > 0.5) { bg = v; break; } bgEl = bgEl.parentElement; }
    const lum = ([r, g, b]) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const fg = cs ? rgb(cs.color) : null;
    const contrast = fg && bg ? (() => { const a = lum(fg), b = lum(bg); return +(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2)); })() : null;
    // the scroll host's visible top edge: a sticky banner must sit flush on it, so pane
    // content never shows ABOVE the banner (r6: a 16px strip of scrolled controls did)
    const host = c?.closest('#dBody') ?? null;
    const gapAbove = box && host ? +(box.top - host.getBoundingClientRect().top - host.clientTop).toFixed(1) : null;
    const scrolled = host ? host.scrollTop : null;
    return {
      gapAbove, scrolled,
      theme: document.documentElement.dataset.theme,
      text: c?.textContent ?? null, id: c?.id ?? null, role: c?.getAttribute('role') ?? c?.closest('[role]')?.getAttribute('role') ?? null,
      onTop, overlapInput: overlap, contrast,
      inputValue: i?.value ?? null, inputFocused: document.activeElement === i,
      drawerOpen: !modal.hidden,
    };
  });
  const shot = path.join(SHOT_DIR, `b283r6-shot-${theme}.png`);
  await page.screenshot({ path: shot });
  await page.close();
  return { ...r, writes: writes.length, consoleWarns: warns.filter((w) => /host path does not exist/.test(w)).length, shot };
}

async function run() {
  check(`precondition: the user's path ${USER_PATH} does not exist on this machine (the server must refuse it)`, !fs.existsSync(USER_PATH), { exists: fs.existsSync(USER_PATH) });
  const tree = OLD_DRAWER ? treeWith(OLD_DRAWER) : ROOT;
  console.log(`\n--- drawer under test: ${OLD_DRAWER ?? 'public/lib/drawer.js (current)'} ---`);
  const base = await bootServer(tree);
  const pid = await busyProject(base);
  // Brave, as playwright.config.ts does (the bundled headless shell may not be downloaded)
  const exe = process.env.VERIFY_ROUTING_BROWSER_PATH ?? (spawnSync('sh', ['-c', 'command -v brave || true']).stdout.toString().trim() || undefined);
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    for (const theme of ['light', 'dark']) {
      const r = await journey(browser, base, pid, theme);
      console.log(`\n  [${theme}] screenshot: ${r.shot}`);
      check(`[${theme}] the server's refusal "mounts[n]: host path does not exist: ${USER_PATH}" is VISIBLE inside the open Settings drawer, in the viewport, on top`,
        r.drawerOpen && r.theme === theme && !!r.text && r.text.includes(`host path does not exist: ${USER_PATH}`) && r.onTop, r);
      check(`[${theme}] it reads clearly: text/background contrast >= 4.5 (WCAG AA)`, (r.contrast ?? 0) >= 4.5, { contrast: r.contrast });
      check(`[${theme}] it is announced to assistive tech (role=alert/status)`, r.role === 'alert' || r.role === 'status', { role: r.role });
      check(`[${theme}] it does not cover the field the user must correct`, r.overlapInput === false, { overlapInput: r.overlapInput });
      check(`[${theme}] the pinned banner sits flush on the pane's top edge: no scrolled content shows above it`,
        r.scrolled > 0 && r.gapAbove !== null && Math.abs(r.gapAbove) <= 1, { scrolled: r.scrolled, gapAbove: r.gapAbove });
      check(`[${theme}] the typed path "${USER_PATH}" is kept in the still-focused field, ready to correct`, r.inputValue === USER_PATH && r.inputFocused, { inputValue: r.inputValue, inputFocused: r.inputFocused });
      check(`[${theme}] one Enter = one refused request (the user's console showed the PATCH twice)`, r.writes === 1 && r.consoleWarns === 1, { patches: r.writes, consoleWarns: r.consoleWarns });
    }
  } finally {
    await browser.close();
  }
}

try { await run(); } catch (e) { console.error(e); fail++; } finally {
  for (const p of procs) stopByPid(p);
  await sleep(500);
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
