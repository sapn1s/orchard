/**
 * BUG-292 — at SESSION scope, the project-only segmented controls (the isolation
 * tier Container/Sandbox/Direct, and the lane-docker daemon Sandbox/Host) were
 * native `<button disabled>`: a click was SILENTLY swallowed and the button
 * looked IDENTICAL to a live option (full opacity, pointer cursor, no dim). The
 * user clicked "Direct" and nothing happened, with no hint why or what to do —
 * the exact verbatim report. The fix (public/lib/drawer.js lockProjectOnlySeg +
 * the `.seg button[aria-disabled]` rule in public/styles.css): render them
 * aria-disabled (dimmed + not-allowed) but KEEP them clickable, and make a click
 * a way FORWARD — switch to "This project" scope and flash the control, reusing
 * the deep-link focus/flash idiom.
 *
 *   node scripts/verify-bug-292-session-iso-click.mjs
 *
 * LIVE PROOF over the real server + brave --headless=new via raw CDP — the same
 * harness shape as verify-feat-146-settings-content.mjs, deliberately not a
 * second one. Ports are OS-assigned; every process is one this script spawned
 * and is stopped by PID; no product code is modified on disk.
 *
 * Non-vacuity: section C re-runs the session-scope assertions against a
 * SYNTHESIZED pre-fix variant of drawer.js — lockProjectOnlySeg(...) reverted to
 * `b.disabled = true`, served over CDP Fetch interception — and that section
 * must go RED (the buttons are natively disabled, carry no aria-disabled, and the
 * click does nothing). Anchored to a constructed broken variant, never a moving
 * revision.
 *
 * Section B proves the PROJECT-scope write path is untouched: clicking "Sandbox"
 * at project scope persists `isolation: "sandbox"` to the registry (read back
 * over the real GET route). Sandbox needs no container runtime, so this holds on
 * a host with no docker.
 *
 * Leak hygiene: every path is created under the system temp dir; no home path,
 * username or real project path is written or printed. `node scripts/leak-gate.mjs`.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const BRAVE = process.env.VERIFY_BROWSER ?? 'brave';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

async function freePort() {
  const net = await import('node:net');
  return await new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.handlers = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c = new Cdp(ws);
    ws.on('message', (dd) => {
      const m = JSON.parse(dd.toString());
      if (m.id && c.waiting.has(m.id)) {
        const { res, rej } = c.waiting.get(m.id);
        c.waiting.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method) {
        for (const h of c.handlers.get(m.method) ?? []) h(m.params);
      }
    });
    return c;
  }
  on(method, fn) { if (!this.handlers.has(method)) this.handlers.set(method, []); this.handlers.get(method).push(fn); }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.waiting.set(id, { res, rej })); }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async waitFor(label, expr, timeoutMs = 30000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) { try { if (await this.eval(expr)) return true; } catch { /* mid-nav */ } await sleep(120); }
    console.log(`        (timed out waiting for ${label})`);
    return false;
  }
  async theme(tone) { await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: tone }] }); }
  async viewport(w, h) { await this.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }); }
  async shot(file) { const r = await this.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); return file; }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

let cdp = null, browser = null, server = null;
const procs = [];

/* Drive the drawer to Isolation + a named scope, then read the live state of the
   two project-only segmented controls (iso + lane-docker). One observation. */
const READ_SEGS = (scope) => `(async () => {
  const D = window.__station.drawer;
  D.close(); D.close();
  await D.open('settings', { scope: ${JSON.stringify(scope)} });
  document.querySelector('.srail-item[data-cat="isolation"]').click();
  await new Promise((r) => setTimeout(r, 400));
  const read = (focus) => {
    const g = document.querySelector('[data-focus="' + focus + '"]');
    if (!g) return null;
    return [...g.querySelectorAll('.seg button')].map((b) => ({
      txt: b.textContent.trim(),
      nativeDisabled: b.disabled,
      ariaDisabled: b.getAttribute('aria-disabled'),
      pressed: b.getAttribute('aria-pressed'),
      cursor: getComputedStyle(b).cursor,
      opacity: Number(getComputedStyle(b).opacity),
    }));
  };
  return { scope: D.scope(), iso: read('iso'), laneDocker: read('laneDocker') };
})()`;

/* At session scope, click the isolation "Direct" button and report what happened:
   the scope the lens moved to, whether the iso group flashed, and — crucially —
   that NO session isolation override was armed (a click must not write). */
const CLICK_DIRECT_AT_SESSION = `(async () => {
  const D = window.__station.drawer;
  D.close(); D.close();
  await D.open('settings', { scope: 'session' });
  document.querySelector('.srail-item[data-cat="isolation"]').click();
  await new Promise((r) => setTimeout(r, 300));
  const ovrBefore = JSON.stringify(window.__station.state.overrides ?? {});
  const g = document.querySelector('[data-focus="iso"]');
  const direct = [...g.querySelectorAll('.seg button')].find((b) => b.textContent.trim() === 'Direct');
  if (!direct) return { err: 'no Direct button' };
  direct.click();
  await new Promise((r) => setTimeout(r, 180));
  const g2 = document.querySelector('[data-focus="iso"]');
  return {
    scopeAfter: D.scope(),
    flashed: !!(g2 && (g2.classList.contains('focus-flash') || g2.querySelector('.focus-flash'))),
    nowClickable: g2 ? [...g2.querySelectorAll('.seg button')].every((b) => !b.disabled && b.getAttribute('aria-disabled') === null) : false,
    ovrBefore,
    ovrAfter: JSON.stringify(window.__station.state.overrides ?? {}),
  };
})()`;

async function sessionAssertions(label) {
  const segs = await cdp.eval(READ_SEGS('session'));
  const iso = segs?.iso ?? [];
  check(`${label}: session scope renders 3 isolation options`, iso.length === 3, iso.map((b) => b.txt));
  check(`${label}: NONE are native <button disabled> (clicks would reach them)`,
    iso.length === 3 && iso.every((b) => b.nativeDisabled === false),
    iso.map((b) => `${b.txt}:disabled=${b.nativeDisabled}`));
  check(`${label}: all carry aria-disabled="true" (read as unavailable to AT)`,
    iso.length === 3 && iso.every((b) => b.ariaDisabled === 'true'),
    iso.map((b) => `${b.txt}:aria=${b.ariaDisabled}`));
  check(`${label}: all show the not-allowed cursor`,
    iso.length === 3 && iso.every((b) => b.cursor === 'not-allowed'),
    iso.map((b) => `${b.txt}:${b.cursor}`));
  check(`${label}: all are visibly dimmed (opacity < 1)`,
    iso.length === 3 && iso.every((b) => b.opacity < 1),
    iso.map((b) => `${b.txt}:${b.opacity}`));
  const ld = segs?.laneDocker ?? [];
  check(`${label}: lane-docker seg is also aria-disabled + dimmed + not-allowed`,
    ld.length === 2 && ld.every((b) => b.nativeDisabled === false && b.ariaDisabled === 'true' && b.cursor === 'not-allowed' && b.opacity < 1),
    ld.map((b) => `${b.txt}:aria=${b.ariaDisabled},cur=${b.cursor},op=${b.opacity}`));

  const clicked = await cdp.eval(CLICK_DIRECT_AT_SESSION);
  check(`${label}: clicking "Direct" at session scope SWITCHES the lens to "This project"`,
    clicked?.scopeAfter === 'project', clicked?.scopeAfter);
  check(`${label}: ...and FLASHES the isolation control (one-shot focus-flash)`,
    clicked?.flashed === true, clicked?.flashed);
  check(`${label}: ...landing the user on the now-usable (enabled) control`,
    clicked?.nowClickable === true, clicked?.nowClickable);
  check(`${label}: ...and writes NOTHING (no session isolation override armed)`,
    clicked?.ovrBefore === clicked?.ovrAfter, { before: clicked?.ovrBefore, after: clicked?.ovrAfter });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bug292-verify-'));
  const DATA = path.join(tmp, 'data');
  const CFG = path.join(tmp, 'cfg');
  const STORE = path.join(CFG, 'projects');
  const PROJ = path.join(tmp, 'p-direct');
  const BIN = path.join(tmp, 'bin');
  for (const d of [DATA, CFG, STORE, PROJ, BIN]) fs.mkdirSync(d, { recursive: true });
  // No container runtime: point the preflight at a binary that is not on PATH so
  // the host's real docker is never consulted — the user's own reality on a
  // host without docker, and all we need (this ticket's scopes are direct/sandbox).
  const base = `http://127.0.0.1:${await freePort()}`;
  const port = base.split(':').pop();

  section('boot the real server (scratch data dir, no container runtime)');
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${BIN}:${process.env.PATH}`,
      PORT: String(port), HOST: '127.0.0.1',
      CLAUDE_STATION_DATA: DATA, CLAUDE_CONFIG_DIR: CFG, CLAUDE_PROJECTS_DIR: STORE,
      CLAUDE_STATION_DOCKER: 'bug292-no-such-docker-binary',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  procs.push(server);
  server.stderr?.on('data', (dd) => { const s = String(dd); if (/error|Error/.test(s)) process.stderr.write(`  [srv!] ${s}`); });
  let up = false;
  for (let i = 0; i < 200 && !up; i++) { try { await fetch(`${base}/api/health`); up = true; } catch { await sleep(250); } }
  check('the real server booted and answers /api/health', up, base);
  if (!up) throw new Error('server never became healthy');

  const proj = await (await fetch(`${base}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: PROJ, name: 'direct proj', applyMethod: false }),
  })).json();
  const id = proj.project?.id;
  await fetch(`${base}/api/projects/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ isolation: 'direct' }),
  });
  const reg0 = await (await fetch(`${base}/api/projects/${id}`)).json();
  check('PRECONDITION: a direct-isolation project exists', (reg0.project ?? reg0)?.isolation === 'direct', (reg0.project ?? reg0)?.isolation);

  section('browser');
  const profile = path.join(tmp, 'chrome');
  fs.mkdirSync(profile, { recursive: true });
  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--window-size=1400,1000', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  procs.push(browser);
  let devPort = 0;
  for (let i = 0; i < 160 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  if (!devPort) throw new Error('browser never wrote DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  cdp = await Cdp.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  // So the section-C Fetch-intercepted pre-fix variant actually loads as the
  // page's module, never a cached copy of the real drawer.js.
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.viewport(1400, 1000);

  const goto = async () => {
    await cdp.send('Page.navigate', { url: 'about:blank' });
    await sleep(120);
    await cdp.send('Page.navigate', { url: `${base}/#/project/${encodeURIComponent(id)}` });
    await cdp.waitFor('app boot', `!!(window.__station && window.__station.drawer)`);
    await cdp.waitFor('the right project selected', `window.__station.currentProject()?.id === ${JSON.stringify(id)}`);
    await sleep(300);
  };
  await goto();

  // ─────────────────────────────────────────────────────────────────────────
  section('A — the SHIPPED file: session scope is visibly disabled yet a way forward');
  await sessionAssertions('A');
  await cdp.theme('dark');
  await sessionAssertions('A·dark');
  await cdp.theme('light');

  // ─────────────────────────────────────────────────────────────────────────
  section('B — PROJECT scope write path is untouched (Sandbox persists to registry)');
  const persisted = await cdp.eval(`(async () => {
    const D = window.__station.drawer;
    D.close(); D.close();
    await D.open('settings', { scope: 'project' });
    document.querySelector('.srail-item[data-cat="isolation"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const g = document.querySelector('[data-focus="iso"]');
    const sandbox = [...g.querySelectorAll('.seg button')].find((b) => b.textContent.trim() === 'Sandbox');
    const clickable = !sandbox.disabled && sandbox.getAttribute('aria-disabled') === null;
    sandbox.click();
    await new Promise((r) => setTimeout(r, 900));
    return { clickable };
  })()`);
  check('B: at project scope the options are ENABLED (not aria-disabled)', persisted?.clickable === true, persisted?.clickable);
  await sleep(400);
  const reg1 = await (await fetch(`${base}/api/projects/${id}`)).json();
  check('B: clicking "Sandbox" at project scope PERSISTED isolation=sandbox to the registry',
    (reg1.project ?? reg1)?.isolation === 'sandbox', (reg1.project ?? reg1)?.isolation);

  // ─────────────────────────────────────────────────────────────────────────
  section('C — non-vacuity: synthesized PRE-FIX drawer.js must make section A RED');
  const realSrc = fs.readFileSync(path.join(ROOT, 'public', 'lib', 'drawer.js'), 'utf8');
  const preFixSrc = realSrc
    .replace("if (sessionScope) lockProjectOnlySeg(b, 'iso');", 'if (sessionScope) b.disabled = true;')
    .replace("if (sessionScope) lockProjectOnlySeg(b, 'laneDocker');", 'if (sessionScope) b.disabled = true;');
  check('C PRECONDITION: the synthesized pre-fix variant really differs from the shipped file',
    preFixSrc !== realSrc && preFixSrc.includes('b.disabled = true;') && !preFixSrc.includes("lockProjectOnlySeg(b, 'iso')"),
    `delta=${realSrc.length - preFixSrc.length} chars`);

  cdp.on('Fetch.requestPaused', (p) => {
    if (p.request.url.includes('/lib/drawer.js')) {
      cdp.send('Fetch.fulfillRequest', {
        requestId: p.requestId, responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'text/javascript' }],
        body: Buffer.from(preFixSrc, 'utf8').toString('base64'),
      }).catch(() => {});
    } else {
      cdp.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
    }
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/lib/drawer.js', requestStage: 'Request' }] });
  await goto();
  // No cache-busting query: the Fetch pattern is `*/lib/drawer.js`, and a `?x=`
  // suffix would miss it. Cache is disabled (Network.setCacheDisabled), so a bare
  // fetch re-requests and is intercepted — returning the pre-fix body.
  const running = await cdp.eval(`(async () => (await (await fetch('/lib/drawer.js')).text()).includes('if (sessionScope) b.disabled = true;'))()`);
  check('C: the page is really running the synthesized pre-fix variant', running === true, String(running));

  // The pre-fix sub-run is EXPECTED to redden. Snapshot the counters, run it,
  // then net its intentional reds out of the suite total (and drop their names).
  const beforeFail = fail, beforePass = pass, namesLen = failures.length;
  await sessionAssertions('C·prefix(EXPECTED-RED)');
  const reddened = fail - beforeFail;
  // Net out: those passes/fails belonged to the broken variant, not the suite.
  fail = beforeFail;
  pass = beforePass;
  failures.length = namesLen;
  check('C: the synthesized pre-fix variant DID fail section A (the fix is non-vacuous)', reddened > 0, `${reddened} assertions reddened under pre-fix`);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed (intentional pre-fix reds netted out)`);
  if (fail > 0) { console.log('Failed:'); for (const f of failures) console.log('  - ' + f); }
}

main()
  .catch((e) => { console.error('HARNESS ERROR:', e); fail++; })
  .finally(async () => {
    try { cdp?.close(); } catch { /* gone */ }
    for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
    await sleep(200);
    process.exit(fail === 0 ? 0 : 1);
  });
