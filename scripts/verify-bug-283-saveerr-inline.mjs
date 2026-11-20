/**
 * BUG-283 — a settings save the server refuses (e.g. a mount whose host path
 * does not exist) must surface the server's message INSIDE the drawer, keep the
 * unsaved input so the user can fix it, and do so for EVERY drawer save path —
 * not vanish into the footer strip the open drawer covers + a console line.
 *
 *   node scripts/verify-bug-283-saveerr-inline.mjs
 *
 * Drives the REAL drawer over CDP against a REAL scratch server + a real
 * container project, so the mount refusal is the server's own 400, not a stub.
 *
 * PART A (current public/): a nonexistent mount path →
 *   - #dSaveErr is visible, inside #smodal, carries the server message;
 *   - the add-form input is still there, with the typed path (preserved);
 *   - sweep: services / env (client) and env reserved key (SERVER 400) each
 *     surface the same inline error;
 *   - screenshots in light and dark.
 * PART B (pre-fix public/, served from a temp copy): the SAME bad mount →
 *   the error does NOT appear anywhere inside #smodal (must-FAIL on old code).
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SHOT_DIR = path.join(ROOT, 'docs', 'bugs', 'assets');
const PRE_DIR = path.join(os.homedir(), '.local/state/claude-station/scratch/saveerr-lane/pre');
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';
const BAD_PATH = '/nonexistent-host-path-bug283';

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

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async connect(url) {
    const WebSocket = (await import('ws')).default;
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
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async waitFor(label, expr, timeoutMs = 20_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) { try { if (await this.eval(expr)) return true; } catch { /* nav */ } await sleep(150); }
    console.log(`        (timed out waiting for ${label})`); return false;
  }
  async screenshot(file) { const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

const procs = [];
const dirs = [];
function stopByPid(child) { if (!child || child.exitCode !== null) return; try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref(); }

async function bootServer(repoRoot, label) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), `cs-b283-data-${label}-`)); dirs.push(data);
  const srv = spawn(process.execPath, [path.join(repoRoot, 'src', 'server', 'index.ts')], {
    cwd: repoRoot, env: { ...process.env, PORT: String(port), CLAUDE_STATION_DATA: data }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(srv);
  srv.stderr?.on('data', (d) => { const s = String(d); if (/error|throw|unhandled/i.test(s)) process.stderr.write(`  [${label}!] ${s}`); });
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${base}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error(`${label} server never became healthy`);
  return { srv, base, port };
}

async function registerContainerProject(base, slug) {
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), `cs-b283-proj-${slug}-`)); dirs.push(projDir);
  const reg = await (await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: projDir, name: `b283-${slug}` }) })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  const patch = await (await fetch(`${base}/api/projects/${pid}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ isolation: 'container' }) })).json();
  // isolation is a TOP-LEVEL project field (project.isolation), not under settings.
  const iso = patch?.project?.isolation ?? patch?.isolation;
  if (iso !== 'container') throw new Error(`could not set container isolation: ${JSON.stringify(patch).slice(0, 200)}`);
  return pid;
}

async function openBrowser(base) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b283-chrome-')); dirs.push(profile);
  const browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--disable-extensions', '--window-size=1000,1300', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  procs.push(browser);
  let devPort = 0;
  for (let i = 0; i < 80 && !devPort; i++) { try { devPort = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); } }
  if (!devPort) throw new Error('brave devtools never came up');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const tab = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await tab.send('Page.enable');
  await tab.send('Page.navigate', { url: `${base}/` });
  await tab.waitFor('boot', `window.__station !== undefined`);
  return tab;
}

/** Open the drawer at the Isolation category (mounts/env/ports/services live there) for pid. */
async function openIsolation(tab, pid, focus = 'mounts') {
  await tab.eval(`(() => { const S = window.__station; S.selectProject(${JSON.stringify(pid)}); S.drawer.open('settings', { focus: ${JSON.stringify(focus)} }); })()`);
  await tab.waitFor('drawer open', `!document.querySelector('#smodal').hidden`);
  await sleep(300);
}

/** Click an add-row button by its visible label, type into the form input, press Enter, wait. */
async function addVia(tab, buttonText, inputAria, value) {
  // The add form may already be open from a prior step (its button is then
  // hidden). Open it only if the input isn't already present.
  const clicked = await tab.eval(`(() => {
    const sel = '#smodal input[aria-label=' + ${JSON.stringify(JSON.stringify(inputAria))} + ']';
    if (document.querySelector(sel)) return true; // form already open
    const btns = [...document.querySelectorAll('#smodal button.addrow')];
    const b = btns.find((x) => x.textContent.includes(${JSON.stringify(buttonText)}));
    if (!b) return false; b.click(); return true;
  })()`);
  if (!clicked) return { clicked: false };
  await tab.waitFor(`${inputAria} input`, `document.querySelector('#smodal input[aria-label=${JSON.stringify(inputAria)}]')`);
  await tab.eval(`(() => {
    const i = document.querySelector('#smodal input[aria-label=${JSON.stringify(inputAria)}]');
    i.value = ${JSON.stringify(value)};
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(800); // allow the PATCH round-trip + repaint
  return { clicked: true };
}

/** Read the inline error line + whether it is inside the drawer + visible. */
async function readSaveErr(tab) {
  return tab.eval(`(() => {
    const e = document.querySelector('#dSaveErr');
    const modal = document.querySelector('#smodal');
    const fine = document.querySelector('#fine');
    const pane = document.querySelector('#dBody');
    // Truly on screen: not hidden AND its rect intersects the pane's scroll
    // viewport (a note scrolled above the fold is "rendered" but unseen).
    let inView = false;
    if (e && !e.hidden && pane) {
      const er = e.getBoundingClientRect(); const pr = pane.getBoundingClientRect();
      inView = er.bottom > pr.top + 1 && er.top < pr.bottom - 1 && er.height > 0;
    }
    return {
      exists: !!e,
      text: e ? e.textContent : '',
      hidden: e ? e.hidden : true,
      visible: inView,
      insideModal: !!(e && modal && modal.contains(e)),
      // Does the drawer contain the error text ANYWHERE (not just #dSaveErr)?
      errTextInModal: !!(modal && /host path does not exist/.test(modal.textContent)),
      fineText: fine ? fine.textContent : '',
    };
  })()`);
}

async function partA() {
  console.log('\n--- PART A: current public/ — error surfaces inline, input preserved ---');
  const { base } = await bootServer(ROOT, 'fix');
  const pid = await registerContainerProject(base, 'fix');
  const tab = await openBrowser(base);
  await openIsolation(tab, pid, 'mounts');

  // 1. a mount whose host path does not exist (real server 400)
  const added = await addVia(tab, 'Add mount', 'New mount', BAD_PATH);
  check('(A0) the "+ Add mount" button + mount input were reachable', added.clicked, added);
  const se = await readSaveErr(tab);
  check('(A1) inline save-error line exists and is VISIBLE', se.exists && se.visible, se);
  check('(A2) it is INSIDE the drawer (#smodal), not the footer', se.insideModal, { insideModal: se.insideModal });
  check('(A3) it carries the SERVER message (host path does not exist + the path)',
    /host path does not exist/.test(se.text) && se.text.includes(BAD_PATH), se.text);
  // input preserved
  const preserved = await tab.eval(`(() => {
    const i = document.querySelector('#smodal input[aria-label="New mount"]');
    return { present: !!i, value: i ? i.value : null };
  })()`);
  check('(A4) the add-form input is still present with the typed path (preserved)',
    preserved.present && preserved.value === BAD_PATH, preserved);

  // (A4b) the banner must take its OWN space and cover no control: in the state
  // the user actually sees (error shown, input scrolled into view), the sticky
  // banner's rect must not intersect the first interactive control beneath it.
  // (Visual review r1→r2: the banner was overlaying the top of the Mounts type
  // toggle; the scrollIntoView centred the input and pinned the banner over it.)
  const geo = await tab.eval(`(() => {
    const banner = document.querySelector('#dSaveErr');
    const pane = document.querySelector('#dBody');
    const br = banner.getBoundingClientRect();
    const pr = pane.getBoundingClientRect();
    const ctrls = [...pane.querySelectorAll('button, input, select, textarea, [role="switch"], [role="radio"], [role="button"], [tabindex]')]
      .filter((el) => el !== banner && !banner.contains(el))
      .map((el) => ({ r: el.getBoundingClientRect(), label: ((el.getAttribute('aria-label') || el.textContent || el.tagName) + '').trim().slice(0, 40) }))
      // visible within the pane's scroll viewport
      .filter((c) => c.r.height > 0 && c.r.width > 0 && c.r.bottom > pr.top + 1 && c.r.top < pr.bottom - 1)
      // horizontally in the banner's column
      .filter((c) => c.r.right > br.left && c.r.left < br.right)
      // at or below the banner's top edge (i.e. "under" it on screen)
      .filter((c) => c.r.bottom > br.top)
      .sort((a, b) => a.r.top - b.r.top);
    const first = ctrls[0] || null;
    const intersects = !!(first && !(br.bottom <= first.r.top || br.top >= first.r.bottom));
    return {
      banner: { top: Math.round(br.top), bottom: Math.round(br.bottom), left: Math.round(br.left), right: Math.round(br.right) },
      firstCtrl: first ? { label: first.label, top: Math.round(first.r.top), bottom: Math.round(first.r.bottom) } : null,
      intersects,
    };
  })()`);
  check('(A4b) the banner takes its own space — its rect does not intersect the first control under it',
    !!geo.firstCtrl && !geo.intersects, geo);

  // screenshots both themes (the drawer, with the inline error showing)
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await tab.eval(`document.documentElement.dataset.theme = 'light'`); await sleep(200);
  await tab.screenshot(path.join(SHOT_DIR, 'BUG-283-mount-error-light.png'));
  await tab.eval(`document.documentElement.dataset.theme = 'dark'`); await sleep(200);
  await tab.screenshot(path.join(SHOT_DIR, 'BUG-283-mount-error-dark.png'));
  await tab.eval(`document.documentElement.dataset.theme = 'light'`); await sleep(150);

  // 2. SWEEP — one check per other save path. Re-open isolation each time to
  //    clear the prior error, then trigger a refusal and confirm it surfaces.
  // service (put, client refusal: name+image)
  await openIsolation(tab, pid, 'services');
  await addVia(tab, 'Add service', 'New service', 'onlyname');
  let s = await readSaveErr(tab);
  check('(A5 sweep: services) a bad service surfaces inline', s.visible && s.insideModal && /service needs a name and an image/.test(s.text), s.text);

  // env (putContainer, client refusal: KEY=value)
  await openIsolation(tab, pid, 'env');
  await addVia(tab, 'Add variable', 'New environment variable', 'NOEQUALS');
  s = await readSaveErr(tab);
  check('(A6 sweep: env client) a malformed env var surfaces inline', s.visible && s.insideModal && /KEY=value/.test(s.text), s.text);

  // env reserved key (putContainer, SERVER 400) — the reserved-key refusal the charter cited
  await openIsolation(tab, pid, 'env');
  await addVia(tab, 'Add variable', 'New environment variable', 'HOME=/tmp/x');
  s = await readSaveErr(tab);
  check('(A7 sweep: env SERVER) a reserved env key surfaces the server message inline', s.visible && s.insideModal && /reserved/.test(s.text), s.text);

  // port (putContainer, client refusal: format)
  await openIsolation(tab, pid, 'mounts'); // re-open isolation page; ports group is here too
  await addVia(tab, 'Publish a port', 'New published port', 'notaport');
  s = await readSaveErr(tab);
  check('(A8 sweep: ports) a malformed port surfaces inline', s.visible && s.insideModal && /HOST:CONTAINER/.test(s.text), s.text);

  tab.close();
  return { lightShot: path.join(SHOT_DIR, 'BUG-283-mount-error-light.png'), darkShot: path.join(SHOT_DIR, 'BUG-283-mount-error-dark.png') };
}

async function buildPrefixRepo() {
  // A light temp "repo": copy src + public + manifests, symlink node_modules.
  // projectRoot() resolves from src/lib/paths.ts, so PUBLIC = <temp>/public.
  const tmp = fs.mkdtempSync(path.join(os.homedir(), '.local/state/claude-station/scratch/b283-prefix-')); dirs.push(tmp);
  for (const d of ['src', 'public']) fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true });
  for (const f of ['package.json', 'tsconfig.json']) { try { fs.cpSync(path.join(ROOT, f), path.join(tmp, f)); } catch { /* optional */ } }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'));
  // src/ imports a few helpers from scripts/lib (e.g. cost-model.mjs); symlink
  // the real scripts/ dir — the pre-fix behaviour we test lives only in public/.
  fs.symlinkSync(path.join(ROOT, 'scripts'), path.join(tmp, 'scripts'));
  // seedTemplates reads docs/prompts/*; symlink docs/ (read-only use).
  fs.symlinkSync(path.join(ROOT, 'docs'), path.join(tmp, 'docs'));
  // Overwrite with the PRE-FIX snapshots taken before any edit this lane made.
  for (const f of ['lib/drawer.js', 'index.html', 'styles.css']) {
    const snap = path.join(PRE_DIR, path.basename(f));
    fs.copyFileSync(snap, path.join(tmp, 'public', f));
  }
  return tmp;
}

async function partB() {
  console.log('\n--- PART B: pre-fix public/ — must-FAIL (error does NOT appear in the drawer) ---');
  if (!fs.existsSync(path.join(PRE_DIR, 'drawer.js'))) { check('(B) pre-fix snapshot present', false, `missing ${PRE_DIR}`); return; }
  const tmp = await buildPrefixRepo();
  const { base } = await bootServer(tmp, 'pre');
  const pid = await registerContainerProject(base, 'pre');
  const tab = await openBrowser(base);
  await openIsolation(tab, pid, 'mounts');
  const added = await addVia(tab, 'Add mount', 'New mount', BAD_PATH);
  check('(B0) the pre-fix drawer reached the mount add form', added.clicked, added);
  const se = await readSaveErr(tab);
  // Must-FAIL: the old code has no inline error element and never puts the
  // message inside the drawer; it only reaches the footer (#fine) + console.
  check('(B1) MUST-FAIL: no inline #dSaveErr element exists in the pre-fix build', !se.exists, { exists: se.exists });
  check('(B2) MUST-FAIL: the refusal text appears NOWHERE inside the drawer', !se.errTextInModal, { errTextInModal: se.errTextInModal });
  check('(B3) (control) the refusal DID reach the footer strip on the old code', /host path does not exist/.test(se.fineText), se.fineText);
  tab.close();
}

async function main() {
  try {
    const shots = await partA();
    await partB();
    console.log(`\n  screenshots: ${shots.lightShot}\n               ${shots.darkShot}`);
  } finally {
    for (const p of procs) stopByPid(p);
    await sleep(400);
    for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); for (const p of procs) stopByPid(p); process.exit(2); });
