/**
 * BUG-296 — at SESSION scope the project-only settings sections (mounts, env,
 * ports, services, the container fields, the docker socket) hid their add/edit
 * control and left only a passive grey note, so a user who came to "+ Add mount"
 * saw no add control and concluded the feature did not exist. And the session
 * HEADER "+ Add mount" pill opened the drawer without forcing project scope, so
 * it landed the user on that same dead affordance — a screen with no add-mount
 * option, the exact verbatim report.
 *
 * The fix (public/lib/drawer.js + public/app.js + public/styles.css):
 *   - a shared `projectOnlyEdit(label, focus)` renders a LIVE affordance where
 *     the add control would be; a click routes to "This project" scope, focused
 *     and flashing the section (prior round, already in tree).
 *   - open({openForm}) + PROJECT_ONLY_FOCUS: a deep link into a project-only
 *     section opens in "This project" scope, and an add-form deep link opens the
 *     editable form itself with its input focused (this round).
 *   - the header "+ Add mount" pill passes {focus:'mounts', openForm:'mount'}.
 *   - the docker socket switch at session scope is clickable-to-switch, not a
 *     bare dead disabled control.
 *
 *   node scripts/verify-bug-296-session-scope-affordance.mjs
 *
 * LIVE PROOF over the real server + brave --headless=new via raw CDP — the same
 * harness shape as verify-bug-292-session-iso-click.mjs. Ports are OS-assigned;
 * every process is one this script spawned and is stopped by PID; no product
 * code is modified on disk.
 *
 * "Session in view" (sections B/D) is simulated by setting state.current =
 * {sessionId} — the EXACT field ctx.getSessionId() reads — because a real live
 * session needs a runtime this host may not have. SYNTHETIC, and flagged as such.
 *
 * Non-vacuity (section E): a synthesized PRE-FIX variant of drawer.js with the
 * scope-forcing line neutralised is served over CDP Fetch interception; the
 * header-add journey must then redden (scope stays session, no focused form).
 *
 * Leak hygiene: every path is under the system temp dir; no home path, username
 * or real project path is written or printed. `node scripts/leak-gate.mjs`.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const BRAVE = process.env.VERIFY_BROWSER ?? 'brave';
const SHOTS = process.env.BUG296_SHOTS ?? fs.mkdtempSync(path.join(os.tmpdir(), 'bug296-shots-'));
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

/* Click the REAL session-header "+ Add mount" pill and report where it landed. */
const CLICK_HEADER_ADD = `(async () => {
  const D = window.__station.drawer;
  D.close(); D.close();
  const pill = document.querySelector('.pill.addm');
  if (!pill) return { err: 'no + Add mount pill in header' };
  pill.click();
  await new Promise((r) => setTimeout(r, 800));
  const input = document.querySelector('[data-ek="add:mount"]');
  return {
    scope: D.scope(),
    formPresent: !!input,
    focused: !!input && document.activeElement === input,
    mountsSectionVisible: !!document.querySelector('[data-focus="mounts"]'),
    affordancePresent: !!document.querySelector('[data-focus="mounts"] .addrow.proj-only'),
  };
})()`;

/* Type a host path into the open mount form and commit it (Enter). */
const ADD_MOUNT = (p) => `(async () => {
  const input = document.querySelector('[data-ek="add:mount"]');
  if (!input) return { err: 'no mount input' };
  input.focus();
  input.value = ${JSON.stringify(p)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise((r) => setTimeout(r, 1000));
  return { rows: [...document.querySelectorAll('[data-focus="mounts"] .mrow')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim()) };
})()`;

const SET_SESSION_IN_VIEW = (on) =>
  `(() => { const s = window.__station.state; s.current = { ...(s.current || {}), sessionId: ${on ? "'sim-sess-1'" : 'null'} }; })()`;

async function headerAddJourney(label, { sessionInView }) {
  // Establish (or clear) a simulated session-in-view (keeps projectId — the real
  // app never nulls state.current), then click the real header pill.
  await cdp.eval(SET_SESSION_IN_VIEW(sessionInView));
  const landed = await cdp.eval(CLICK_HEADER_ADD);
  check(`${label}: header "+ Add mount" lands in "This project" scope`, landed?.scope === 'project', landed?.scope);
  check(`${label}: ...with the editable mount form present (not the dead affordance)`,
    landed?.formPresent === true && landed?.affordancePresent === false,
    { form: landed?.formPresent, affordance: landed?.affordancePresent });
  check(`${label}: ...and the mount input is FOCUSED`, landed?.focused === true, landed?.focused);
  return landed;
}

async function sessionAffordances(label) {
  const r = await cdp.eval(`(async () => {
    const D = window.__station.drawer;
    D.close(); D.close();
    await D.open('settings', { scope: 'session' });
    document.querySelector('.srail-item[data-cat="isolation"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const aff = (focus) => {
      const g = document.querySelector('[data-focus="' + focus + '"]');
      if (!g) return null;
      const b = g.querySelector('.addrow.proj-only');
      if (!b) return { present: false };
      return { present: true, text: b.textContent.trim(), ariaDisabled: b.getAttribute('aria-disabled'), cursor: getComputedStyle(b).cursor };
    };
    // the socket switch at session scope: locked but clickable-to-switch
    const sw = document.querySelector('[data-focus="mounts"] .sw');
    const socket = sw ? { aria: sw.getAttribute('aria-disabled'), nativeDisabled: sw.disabled, cursor: getComputedStyle(sw).cursor } : null;
    return { mounts: aff('mounts'), env: aff('env'), ports: aff('ports'), services: aff('services'), socket };
  })()`);
  for (const sec of ['mounts', 'env', 'ports', 'services']) {
    const a = r?.[sec];
    check(`${label}: ${sec} shows a live add affordance (not just a grey note)`,
      a?.present === true && a?.ariaDisabled === 'true' && a?.cursor === 'pointer',
      a);
  }
  check(`${label}: the docker socket is locked-but-clickable (aria-disabled, not native disabled)`,
    r?.socket?.aria === 'true' && r?.socket?.nativeDisabled === false && r?.socket?.cursor === 'pointer',
    r?.socket);
  return r;
}

/* Click a section's affordance and confirm it routes to project scope, flashes,
   and the section now renders its real add control. */
const CLICK_AFFORDANCE = (focus, realAddText) => `(async () => {
  const D = window.__station.drawer;
  D.close(); D.close();
  await D.open('settings', { scope: 'session' });
  document.querySelector('.srail-item[data-cat="isolation"]').click();
  await new Promise((r) => setTimeout(r, 350));
  const g = document.querySelector('[data-focus="${focus}"]');
  const aff = g && g.querySelector('.addrow.proj-only');
  if (!aff) return { err: 'no affordance' };
  aff.click();
  await new Promise((r) => setTimeout(r, 220));
  const g2 = document.querySelector('[data-focus="${focus}"]');
  const realAdd = g2 ? [...g2.querySelectorAll('.addrow')].find((b) => !b.classList.contains('proj-only') && b.textContent.includes(${JSON.stringify(realAddText)})) : null;
  return {
    scopeAfter: D.scope(),
    flashed: !!(g2 && (g2.classList.contains('focus-flash') || g2.querySelector('.focus-flash'))),
    realAddPresent: !!realAdd,
  };
})()`;

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bug296-verify-'));
  const DATA = path.join(tmp, 'data');
  const CFG = path.join(tmp, 'cfg');
  const STORE = path.join(CFG, 'projects');
  const PROJ = path.join(tmp, 'p-container');
  const BIN = path.join(tmp, 'bin');
  // A real, existing directory to mount: the server refuses a host path that does
  // not exist (index.ts "host path does not exist"), so the journey needs one.
  const MOUNT_SRC = path.join(tmp, 'scratch-mount');
  for (const d of [DATA, CFG, STORE, PROJ, BIN, MOUNT_SRC]) fs.mkdirSync(d, { recursive: true });
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
      CLAUDE_STATION_DOCKER: 'bug296-no-such-docker-binary',
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
    body: JSON.stringify({ hostPath: PROJ, name: 'container proj', applyMethod: false }),
  })).json();
  const id = proj.project?.id;
  await fetch(`${base}/api/projects/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ isolation: 'container' }),
  });
  const reg0 = await (await fetch(`${base}/api/projects/${id}`)).json();
  check('PRECONDITION: a container-isolation project exists', (reg0.project ?? reg0)?.isolation === 'container', (reg0.project ?? reg0)?.isolation);

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
  section('A — header "+ Add mount" with NO session in view: lands in the editable form');
  const diag = await cdp.eval(`(async () => {
    const appHasOpenForm = (await (await fetch('/app.js')).text()).includes("openForm: 'mount'");
    const id = window.__station.currentProject().id;
    const r = await fetch('/api/projects/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mounts: [{ hostPath: '/tmp/probe-mount', containerPath: '/mnt/probe', readOnly: false }] }) });
    const patchStatus = r.status; const patchBody = (await r.text()).slice(0, 160);
    await fetch('/api/projects/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mounts: [] }) });
    const D = window.__station.drawer;
    D.close(); D.close();
    await D.open('settings', { focus: 'mounts', openForm: 'mount' });
    const input = document.querySelector('[data-ek="add:mount"]');
    return { appHasOpenForm, patchStatus, patchBody, scope: D.scope(), directForm: !!input, directFocused: !!input && document.activeElement === input };
  })()`);
  console.log(`        [diag] ${JSON.stringify(diag)}`);
  await headerAddJourney('A', { sessionInView: false });
  const added = await cdp.eval(ADD_MOUNT(`${MOUNT_SRC}:/mnt/scratch:ro`));
  check('A: the typed mount now appears in the Access list', Array.isArray(added?.rows) && added.rows.some((t) => t.includes('scratch-mount')), added?.rows);
  await sleep(300);
  const regA = await (await fetch(`${base}/api/projects/${id}`)).json();
  const mA = (regA.project ?? regA)?.settings?.mounts ?? [];
  check('A: the mount PERSISTED to the registry', mA.some((m) => (m.hostPath || '').includes('scratch-mount')), mA.map((m) => m.hostPath));

  // ─────────────────────────────────────────────────────────────────────────
  section('B — header "+ Add mount" WITH a session in view (synthetic): still forces project scope');
  // control: a plain open over a session lands on "This session" (BUG-287)
  const plain = await cdp.eval(`(async () => {
    const D = window.__station.drawer;
    { const s = window.__station.state; s.current = { ...(s.current || {}), sessionId: 'sim-sess-1' }; }
    D.close(); D.close();
    await D.open('settings');
    return D.scope();
  })()`);
  check('B control: a plain Settings open over a session defaults to "This session" (BUG-287 intact)', plain === 'session', plain);
  await headerAddJourney('B', { sessionInView: true });
  await cdp.eval(SET_SESSION_IN_VIEW(false));

  // ─────────────────────────────────────────────────────────────────────────
  section('C — session scope shows a live affordance on every project-only section');
  await sessionAffordances('C');
  await cdp.theme('dark');
  await sessionAffordances('C·dark');
  await cdp.theme('light');

  section('C2 — clicking an affordance routes to project scope, flashes, reveals the real add control');
  const envRoute = await cdp.eval(CLICK_AFFORDANCE('env', '+ Add variable'));
  check('C2: env affordance → "This project" scope', envRoute?.scopeAfter === 'project', envRoute?.scopeAfter);
  check('C2: ...flashes the env section', envRoute?.flashed === true, envRoute?.flashed);
  check('C2: ...and the real "+ Add variable" control is now present', envRoute?.realAddPresent === true, envRoute?.realAddPresent);
  const portRoute = await cdp.eval(CLICK_AFFORDANCE('ports', '+ Publish a port'));
  check('C2: ports affordance → "This project" scope with the real add control', portRoute?.scopeAfter === 'project' && portRoute?.realAddPresent === true, portRoute);

  section('D — visual capture (light + dark), session scope on Isolation');
  for (const tone of ['light', 'dark']) {
    await cdp.theme(tone);
    await cdp.eval(`(async () => {
      const D = window.__station.drawer;
      { const s = window.__station.state; s.current = { ...(s.current || {}), sessionId: 'sim-sess-1' }; }
      D.close(); D.close();
      await D.open('settings', { scope: 'session' });
      document.querySelector('.srail-item[data-cat="isolation"]').click();
      await new Promise((r) => setTimeout(r, 450));
    })()`);
    const f = await cdp.shot(path.join(SHOTS, `bug296-session-isolation-${tone}.png`));
    check(`D: captured ${tone} session-scope isolation screenshot`, fs.existsSync(f), f);
  }
  // and the landed add-form, project scope, light
  await cdp.theme('light');
  await cdp.eval(SET_SESSION_IN_VIEW(false));
  await cdp.eval(CLICK_HEADER_ADD);
  const fForm = await cdp.shot(path.join(SHOTS, 'bug296-add-mount-form-light.png'));
  check('D: captured the landed add-mount form screenshot', fs.existsSync(fForm), fForm);
  await cdp.theme('light');

  // ─────────────────────────────────────────────────────────────────────────
  section('E — non-vacuity: a PRE-FIX drawer.js (no scope-forcing) must redden section B');
  const realSrc = fs.readFileSync(path.join(ROOT, 'public', 'lib', 'drawer.js'), 'utf8');
  const marker = "else if (addForm || (focusKey && PROJECT_ONLY_FOCUS.has(focusKey))) d.scope = 'project';";
  const preFixSrc = realSrc.replace(marker, "else if (false) d.scope = 'project'; /* pre-fix */");
  check('E PRECONDITION: the synthesized pre-fix variant really differs from the shipped file',
    preFixSrc !== realSrc && preFixSrc.includes('/* pre-fix */'),
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
  const running = await cdp.eval(`(async () => (await (await fetch('/lib/drawer.js')).text()).includes('/* pre-fix */'))()`);
  check('E: the page is really running the synthesized pre-fix variant', running === true, String(running));

  const beforeFail = fail, beforePass = pass, namesLen = failures.length;
  await headerAddJourney('E·prefix(EXPECTED-RED)', { sessionInView: true });
  const reddened = fail - beforeFail;
  fail = beforeFail; pass = beforePass; failures.length = namesLen;
  check('E: the pre-fix variant DID fail the header-add journey with a session in view (fix is non-vacuous)', reddened > 0, `${reddened} assertions reddened under pre-fix`);

  console.log(`\nscreenshots: ${SHOTS}`);
  console.log(`${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed (intentional pre-fix reds netted out)`);
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
