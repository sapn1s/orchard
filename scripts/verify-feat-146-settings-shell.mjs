/**
 * FEAT-146 (phase 1) — LIVE PROOF of the settings MODAL shell and its navigation.
 *
 *   node scripts/verify-feat-146-settings-shell.mjs
 *
 * Settings stopped being a 388px right-hand drawer carrying two orthogonal
 * navigation axes (a scope tab strip AND a content view axis) and became one
 * `.smodal`: CONTENT is the rail, SCOPE is a header lens over the write target.
 * Phase 1 is the shell only — the existing view builders render unchanged
 * inside the new pane.
 *
 * The anti-regression that matters is the DEEP LINKS: 18 `drawer.open()` call
 * sites in app.js reach 14 `data-focus` anchors and 6 `data-sect` anchors, and
 * a rail that selects the wrong category turns every one of them into a silent
 * no-op. So this script drives all 20 keys, on BOTH a container project and a
 * direct one, and asserts each one resolves, scrolls and flashes — then proves
 * the check is not vacuous by serving a SYNTHESIZED pre-fix drawer.js (its
 * FOCUS_CATEGORY map emptied) over CDP Fetch interception and showing the same
 * assertions go red.
 *
 * Harness: the real server + brave --headless=new over raw CDP, the same shape
 * scripts/verify-feat-132-ui.mjs uses. Ports are OS-assigned; :4317 is never
 * touched. Every process is one this script spawned and is stopped by PID (the
 * stubbed `claude` login child is killed by its own group through the product's
 * cancel path). No product code is modified. Screenshots land in the repo root
 * as feat146-*.png.
 *
 * Leak hygiene: every path used here is created by this script under the system
 * temp dir; no home path, no username, no real project path is written to disk
 * or printed. Confirm with `node scripts/leak-gate.mjs --summary`.
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

/* The keys that existed BEFORE this ticket. Every one must still resolve. */
const DATA_FOCUS_KEYS = [
  'permissionMode', 'integrations', 'iso', 'mounts', 'services', 'git', 'processes',
  'instructions', 'responseDigest', 'wiring', 'globalModel', 'newProjectDefaults',
  'globalAccount', 'appearance',
];
const DATA_SECT_KEYS = ['model', 'iso', 'caps', 'instr', 'advanced', 'patterns'];
/* Anchors only a CONTAINER project renders. On a direct project applyFocus's
   honest silent no-op is the CORRECT behaviour and is asserted as such. */
const CONTAINER_ONLY = new Set(['mounts', 'services']);
/* Anchors that need an async machine-scope fetch to have landed first. */
const MACHINE_KEYS = new Set(['globalModel', 'newProjectDefaults', 'globalAccount', 'appearance']);

const EXPECTED_API = ['open', 'close', 'isOpen', 'repaint', 'repaintLive', 'scope',
  'startTemplateIds', 'effectiveStack', 'templates', 'ensureTemplates'];

const RAIL_IDS = ['model', 'permissions', 'instructions', 'isolation', 'snapshots', 'workspace',
  'advanced', 'accounts', 'appearance', 'defaults', 'templates'];

/* ── infra ── */
const procs = [];
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.handlers = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c = new Cdp(ws);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
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
  async key(o) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...o });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...o });
  }
  async theme(tone) { await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: tone }] }); }
  async viewport(width, height) { await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

let cdp = null, browser = null, server = null;
const shots = [];
let consoleErrors = [];

async function shot(name, minKb = 6) {
  const file = path.join(ROOT, name);
  await cdp.shot(file);
  const kb = fs.statSync(file).size / 1024;
  check(`capture ${name} (non-blank, > ${minKb}KB)`, kb > minKb, `${kb.toFixed(1)} KB`);
  shots.push(file);
  return file;
}

/* Keyboard helpers — real key events, not synthetic .click(). */
const KEY = {
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35 },
};

/**
 * Drive ONE deep link exactly the way an app.js call site does, then read back
 * what the modal actually did with it: which rail category is selected, whether
 * the anchor node exists, whether the flash class landed on it, and whether the
 * pane scrolled to it. `flashed` is sampled inside the FLASH_MS window.
 */
const DEEP_LINK = (key) => `(async () => {
  const D = window.__station.drawer;
  D.close(); D.close();
  await D.open('settings', { focus: ${JSON.stringify(key)} });
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const pane = document.querySelector('#dBody');
  const host = pane.querySelector('.view.on');
  const q = () => {
    const h = document.querySelector('.view.on');
    return h ? (h.querySelector('[data-focus="' + ${JSON.stringify(key)} + '"]')
      ?? h.querySelector('details[data-sect="' + ${JSON.stringify(key)} + '"]')) : null;
  };
  const topOf = (t) => t ? Math.round(t.getBoundingClientRect().top - pane.getBoundingClientRect().top) : null;
  const paneH = Math.round(pane.getBoundingClientRect().height);
  const target = q();
  const flashed = target ? target.classList.contains('focus-flash') : false;
  const topNow = topOf(target);
  // Second sample once the view's async fetches (git, processes, wiring,
  // globals) have repainted: applyFocus re-lands inside its FLASH_MS window.
  await new Promise((r) => setTimeout(r, 900));
  const topLater = topOf(q());
  const sel = document.querySelector('.srail-item[aria-current="page"]');
  return {
    cat: sel ? sel.dataset.cat : null,
    found: !!target,
    flashed,
    kind: target ? (target.hasAttribute('data-focus') ? 'data-focus' : 'data-sect') : null,
    paneScrollTop: pane.scrollTop, paneH, topNow, topLater,
    inView: [topNow, topLater].some((t) => t !== null && t >= -4 && t < paneH),
    open: D.isOpen(),
  };
})()`;

async function runAnchorSuite(label, isContainer, expectFound = true) {
  const results = {};
  for (const key of [...new Set([...DATA_FOCUS_KEYS, ...DATA_SECT_KEYS])]) {
    if (MACHINE_KEYS.has(key)) {
      // The machine categories need /api/global-settings to have landed; open
      // the one that shows it and wait for the real fetch rather than racing it.
      // (Phase 2: {scope:'machine'} lands on Accounts, which no longer renders
      // the whole machine scroll — so warm up on the category that owns it.)
      await cdp.eval(`window.__station.drawer.open('settings', { focus: 'globalModel' })`);
      await cdp.waitFor(`globals for ${key}`, `!!document.querySelector('[data-focus="globalModel"]')`, 8000);
    }
    let r;
    try { r = await cdp.eval(DEEP_LINK(key)); } catch (err) { r = { error: err.message }; }
    results[key] = r;
  }
  for (const key of DATA_FOCUS_KEYS) {
    const r = results[key];
    const shouldExist = expectFound && (!CONTAINER_ONLY.has(key) || isContainer);
    if (shouldExist) {
      check(`[${label}] data-focus="${key}" → category "${r?.cat}", anchor found, flashed, scrolled into view`,
        !!r && r.open && r.found && r.flashed && r.kind === 'data-focus' && r.inView,
        JSON.stringify(r));
    } else if (!expectFound) {
      check(`[${label}] data-focus="${key}" does NOT resolve`, !!r && !r.found, JSON.stringify(r));
    } else {
      // Container-only anchor on a direct project: applyFocus's honest no-op.
      check(`[${label}] data-focus="${key}" is absent on a direct project (honest no-op, modal still open)`,
        !!r && r.open && !r.found, JSON.stringify(r));
    }
  }
  for (const key of DATA_SECT_KEYS) {
    const r = results[key];
    if (key === 'patterns') {
      // The Patterns section only exists when pattern templates are seeded.
      check(`[${label}] data-sect="patterns" → category "${r?.cat}" (templates) and the key routes`,
        !!r && r.open && r.cat === 'templates', JSON.stringify(r));
      continue;
    }
    if (expectFound) {
      check(`[${label}] data-sect="${key}" → category "${r?.cat}", anchor found, flashed`,
        !!r && r.open && r.found && r.flashed, JSON.stringify(r));
    } else {
      check(`[${label}] data-sect="${key}" does NOT resolve`, !!r && !r.found, JSON.stringify(r));
    }
  }
  return results;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat146-verify-'));
  const DATA = path.join(tmp, 'data');
  const CFG = path.join(tmp, 'cfg');
  const STORE = path.join(CFG, 'projects');
  const DIRECT = path.join(tmp, 'p-direct');
  const CONTAINER = path.join(tmp, 'p-container');
  const BIN = path.join(tmp, 'bin');
  for (const d of [DATA, CFG, STORE, DIRECT, CONTAINER, BIN]) fs.mkdirSync(d, { recursive: true });

  /* A STUB `claude` on the server's PATH. The login-in-flight guard is a real
     product path (claude-login.ts spawns the CLI and scrapes an authorize URL);
     stubbing the external binary makes it deterministic and offline. It prints
     a URL matching the product's own generic scrape and then blocks on stdin,
     which is exactly the state the guard must refuse to close over. */
  fs.writeFileSync(path.join(BIN, 'claude'), [
    '#!/bin/sh',
    'if [ "$2" = "status" ]; then echo \'{"loggedIn":false}\'; exit 1; fi',
    'echo "Opening browser to sign in…"',
    'echo "https://example.invalid/cai/oauth/authorize?code=stub&state=stub"',
    'printf "Paste code here if prompted > "',
    'cat > /dev/null',
  ].join('\n') + '\n', { mode: 0o755 });

  // ── boot the real server ──
  const port = await freePort();
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${BIN}:${process.env.PATH}`,
      PORT: String(port), HOST: '127.0.0.1',
      CLAUDE_STATION_DATA: DATA, CLAUDE_CONFIG_DIR: CFG, CLAUDE_PROJECTS_DIR: STORE,
      CLAUDE_STATION_LOGIN_URL_GRACE_MS: '120000',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  procs.push(server);
  server.stderr?.on('data', (d) => { const s = String(d); if (/error|Error/.test(s)) process.stderr.write(`  [srv!] ${s}`); });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 200 && !up; i++) { try { await fetch(`${base}/api/health`); up = true; } catch { await sleep(250); } }
  check('the real server booted and answers /api/health', up, base);
  if (!up) throw new Error('server never became healthy');

  // ── two projects: one direct, one container ──
  const mk = async (hostPath, name) => {
    const r = await (await fetch(`${base}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostPath, name, applyMethod: false }),
    })).json();
    return r.project?.id;
  };
  const directId = await mk(DIRECT, 'direct proj');
  const containerId = await mk(CONTAINER, 'container proj');
  check('both scratch projects registered', !!directId && !!containerId, `direct=${!!directId} container=${!!containerId}`);
  await fetch(`${base}/api/projects/${containerId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ isolation: 'container', mounts: [{ hostPath: CONTAINER, containerPath: '/workspace', readOnly: false }] }),
  });
  // Explicit, not assumed: the machine-wide new-project default SEEDS container
  // isolation, so "the direct project" is only direct because this says so.
  await fetch(`${base}/api/projects/${directId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ isolation: 'direct' }),
  });
  const cProj = await (await fetch(`${base}/api/projects/${containerId}`)).json();
  const dProj = await (await fetch(`${base}/api/projects/${directId}`)).json();
  check('the two projects really report the isolation this suite depends on',
    (cProj.project ?? cProj)?.isolation === 'container' && (dProj.project ?? dProj)?.isolation === 'direct',
    `container=${(cProj.project ?? cProj)?.isolation} direct=${(dProj.project ?? dProj)?.isolation}`);

  // ── browser ──
  const profile = path.join(tmp, 'chrome');
  fs.mkdirSync(profile, { recursive: true });
  browser = spawn(BRAVE, [
    '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--window-size=1400,1000', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
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
  await cdp.send('Log.enable');
  cdp.on('Runtime.exceptionThrown', (p) => consoleErrors.push(`exception: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`));
  cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') consoleErrors.push(`console.error: ${(p.args ?? []).map((a) => a.value ?? a.description).join(' ')}`); });
  cdp.on('Log.entryAdded', (p) => { if (p.entry?.level === 'error') consoleErrors.push(`log: ${p.entry.text}`); });
  await cdp.viewport(1400, 1000);

  const urlFor = (id) => `${base}/#/project/${encodeURIComponent(id)}`;
  const goto = async (id) => {
    // about:blank first: navigating between two `#/project/<id>` URLs is a
    // same-document hash change, which would leave the previous project (and
    // the previous module instance) in place — and silently make every
    // "on a direct project" assertion below a re-run of the container one.
    await cdp.send('Page.navigate', { url: 'about:blank' });
    await sleep(120);
    await cdp.send('Page.navigate', { url: urlFor(id) });
    await cdp.waitFor('app boot', `!!(window.__station && window.__station.drawer)`);
    const right = await cdp.waitFor('the right project selected',
      `window.__station.currentProject()?.id === ${JSON.stringify(id)}`);
    check(`PRECONDITION: the page is really showing project ${id.slice(0, 8)}…`, right === true, String(right));
    await sleep(300);
  };

  /* ══════════ 1. the shell ══════════ */
  section('1. the modal shell');
  await cdp.theme('dark');
  await goto(directId);
  consoleErrors = [];

  const noDrawer = await cdp.eval(`({ drawer: !!document.querySelector('#drawer'), globals: !!document.querySelector('#vGlobals'), smodal: !!document.querySelector('#smodal') })`);
  check('the 388px drawer and the dead vGlobals view are gone; #smodal is the settings surface',
    noDrawer.smodal && !noDrawer.drawer && !noDrawer.globals, JSON.stringify(noDrawer));

  await cdp.eval(`document.querySelector('#cogBtn').click()`);
  await cdp.waitFor('modal open', `!document.querySelector('#smodal').hidden`);

  const shell = await cdp.eval(`(() => {
    const m = document.querySelector('#smodal');
    const box = m.querySelector('.smodal-box');
    const cs = getComputedStyle(box);
    const back = getComputedStyle(m.querySelector('.smodal-back'));
    return {
      role: m.getAttribute('role'), modal: m.getAttribute('aria-modal'),
      labelledby: m.getAttribute('aria-labelledby'),
      labelText: document.getElementById(m.getAttribute('aria-labelledby'))?.textContent,
      isDialogEl: m.tagName === 'DIALOG',
      cols: cs.gridTemplateColumns, rows: cs.gridTemplateRows,
      w: Math.round(box.getBoundingClientRect().width), h: Math.round(box.getBoundingClientRect().height),
      heightProp: cs.height, maxHeight: cs.maxHeight,
      backFilter: back.backdropFilter, boxFilter: cs.backdropFilter,
      rail: !!m.querySelector('#sRail'), pane: !!m.querySelector('#dBody'), foot: !!m.querySelector('.sfoot'),
    };
  })()`);
  check('role="dialog" aria-modal="true" aria-labelledby → the live title, and NOT a <dialog>',
    shell.role === 'dialog' && shell.modal === 'true' && shell.labelledby === 'dTitle'
      && !!shell.labelText && !shell.isDialogEl, JSON.stringify(shell));
  check('.smodal-box is a 224px rail + content grid, 3 rows (52 / body / 44)',
    /^224px /.test(shell.cols) && shell.rows.split(' ').length === 3
      && shell.rows.startsWith('52px') && shell.rows.endsWith('44px'),
    `cols=${shell.cols} rows=${shell.rows}`);
  check('FIXED height (not max-height): 940×680 at 1400px viewport',
    shell.w === 940 && shell.h === 680 && shell.maxHeight === 'none', `${shell.w}×${shell.h} maxHeight=${shell.maxHeight}`);
  check('NO backdrop-filter anywhere on the modal or its backdrop',
    (shell.backFilter === 'none' || !shell.backFilter) && (shell.boxFilter === 'none' || !shell.boxFilter),
    `back=${shell.backFilter} box=${shell.boxFilter}`);

  const railInfo = await cdp.eval(`(() => {
    const r = document.querySelector('#sRail');
    const items = [...r.querySelectorAll('.srail-item')];
    const rr = r.getBoundingClientRect();
    return {
      tag: r.tagName, role: r.getAttribute('role'), label: r.getAttribute('aria-label'),
      anyTablist: !!document.querySelector('#smodal [role="tablist"]'),
      heads: [...r.querySelectorAll('h3')].map((h) => h.textContent),
      lists: [...r.querySelectorAll('ul[role="list"]')].length,
      ids: items.map((b) => b.dataset.cat),
      tags: [...new Set(items.map((b) => b.tagName))],
      current: items.filter((b) => b.getAttribute('aria-current') === 'page').map((b) => b.dataset.cat),
      roving: items.map((b) => b.tabIndex),
      railWidth: Math.round(rr.width),
      headStyle: (() => { const h = r.querySelector('h3'); const c = getComputedStyle(h); return { transform: c.textTransform, tracking: c.letterSpacing, size: c.fontSize, weight: c.fontWeight }; })(),
    };
  })()`);
  check('the rail is <nav aria-label> with two sentence-case group headings and two role="list" groups — NOT a tablist',
    railInfo.tag === 'NAV' && !!railInfo.label && !railInfo.anyTablist
      && JSON.stringify(railInfo.heads) === JSON.stringify(['This project', 'This machine'])
      && railInfo.lists === 2, JSON.stringify({ tag: railInfo.tag, label: railInfo.label, heads: railInfo.heads, lists: railInfo.lists, anyTablist: railInfo.anyTablist }));
  check('11 categories, in the decided order, all <button>',
    JSON.stringify(railInfo.ids) === JSON.stringify(RAIL_IDS) && JSON.stringify(railInfo.tags) === '["BUTTON"]',
    JSON.stringify(railInfo.ids));
  check('roving tabindex: exactly one aria-current="page" and exactly one tabindex=0',
    railInfo.current.length === 1 && railInfo.roving.filter((t) => t === 0).length === 1,
    `current=${JSON.stringify(railInfo.current)} tabindex=${JSON.stringify(railInfo.roving)}`);
  check('group headings deliberately break the app\'s uppercase-tracked idiom (sentence case, no tracking)',
    railInfo.headStyle.transform === 'none' && (railInfo.headStyle.tracking === 'normal' || railInfo.headStyle.tracking === '0px'),
    JSON.stringify(railInfo.headStyle));
  check('the rail is the specified fixed 224px', railInfo.railWidth === 224, `${railInfo.railWidth}px`);

  const noAnim = await cdp.eval(`getComputedStyle(document.querySelector('.view.on')).animationName`);
  check('NO category-switch transition: .view.on carries no animation', noAnim === 'none', String(noAnim));

  const paneStyle = await cdp.eval(`(() => {
    const p = document.querySelector('#dBody'); const c = getComputedStyle(p);
    const g = p.querySelector('.grp'); const gc = g ? getComputedStyle(g) : null;
    const pr = p.getBoundingClientRect(); const gr = g ? g.getBoundingClientRect() : null;
    return { overflowY: c.overflowY, padding: c.padding,
      cardMaxW: gc?.maxWidth, cardLeftGap: gr ? Math.round(gr.left - pr.left - parseFloat(c.paddingLeft)) : null };
  })()`);
  check('pane scrolls, cards capped at 720px and LEFT-aligned (not centred)',
    paneStyle.overflowY === 'auto' && paneStyle.cardMaxW === '720px' && paneStyle.cardLeftGap === 0,
    JSON.stringify(paneStyle));

  await shot('feat146-shell-dark.png');

  /* ══════════ 2. the exported API surface ══════════ */
  section('2. the exported drawer API is unchanged by shape');
  const api = await cdp.eval(`(() => {
    const D = window.__station.drawer;
    return { keys: Object.keys(D).sort(), types: Object.keys(D).sort().map((k) => typeof D[k]) };
  })()`);
  check('exactly the 10 documented exports, all functions — no key added, none removed',
    JSON.stringify(api.keys) === JSON.stringify([...EXPECTED_API].sort())
      && api.types.every((t) => t === 'function'),
    JSON.stringify(api.keys));
  const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  // Comment lines excluded — app.js documents the API in prose as well as
  // calling it, and a doc mention is not a call site.
  const callSites = src.split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .reduce((n, l) => n + (l.match(/drawer\.open\(/g) ?? []).length, 0);
  /* 20, not 21, since FEAT-146 round 4: the `#popSettings` handler — the footer
     of the isolation popover — was deleted with the popover and the `#isoBtn`
     that was its only opener, all of which had been unreachable since FEAT-139
     hid that button unconditionally. Every remaining call site is still here
     and none MOVED, which is the invariant; the deep link it carried
     (`{focus:'iso'}`) is asserted separately above. */
  check('all 20 live drawer.open() call sites in app.js are still there (none had to move)',
    callSites === 20, `${callSites} call sites`);

  /* ══════════ 3. the real doors ══════════ */
  section('3. the real doors open it');
  const closeIt = async () => { await cdp.eval(`(() => { const D = window.__station.drawer; D.close(); D.close(); })()`); await sleep(120); };

  await closeIt();
  await cdp.eval(`document.querySelector('#cogBtn').click()`);
  await cdp.waitFor('cog', `!document.querySelector('#smodal').hidden`);
  const viaCog = await cdp.eval(`document.querySelector('.srail-item[aria-current="page"]').dataset.cat`);
  check('the composer cog opens the modal on a project category', viaCog === 'model', String(viaCog));

  await closeIt();
  await cdp.eval(`document.querySelector('#settingsFootBtn').click()`);
  await cdp.waitFor('foot', `!document.querySelector('#smodal').hidden`);
  const viaFoot = await cdp.eval(`(() => ({
    cat: document.querySelector('.srail-item[aria-current="page"]').dataset.cat,
    lensHidden: document.querySelector('#dScope').hidden,
    eyebrow: document.querySelector('#dEyebrow').textContent,
  }))()`);
  check('the sidebar-foot machine door maps {scope:"machine"} → the Accounts category, lens hidden',
    viaFoot.cat === 'accounts' && viaFoot.lensHidden === true
      && viaFoot.eyebrow === 'Every project on this machine', JSON.stringify(viaFoot));

  await closeIt();
  await cdp.eval(`document.querySelector('#prompt').focus()`);
  await cdp.key({ ...KEY.Comma ?? {}, key: ',', code: 'Comma', windowsVirtualKeyCode: 188, nativeVirtualKeyCode: 188, modifiers: 2 });
  await sleep(200);
  const viaChord = await cdp.eval(`!document.querySelector('#smodal').hidden`);
  check('Ctrl/⌘ , still opens settings (BUG-158 shortcut survives the redesign)', viaChord === true, String(viaChord));

  /* ══════════ 4. deep links — the anti-regression that matters ══════════ */
  section('4. deep links: every pre-existing anchor still resolves (CONTAINER project)');
  await goto(containerId);
  await runAnchorSuite('container', true);

  section('4b. deep links on a DIRECT project (container-only anchors are an honest no-op)');
  await goto(directId);
  await runAnchorSuite('direct', false);

  /* the three deep links driven through their REAL app.js call sites */
  section('4c. three deep links driven through the real chips, not the API');
  await closeIt();
  await cdp.eval(`document.querySelector('#permLine').click()`);
  await sleep(400);
  const permLink = await cdp.eval(`(() => ({ open: !document.querySelector('#smodal').hidden,
    cat: document.querySelector('.srail-item[aria-current="page"]')?.dataset.cat,
    found: !!document.querySelector('.view.on [data-focus="permissionMode"]') }))()`);
  check('#permLine → Permissions & tools, permissionMode anchor present',
    permLink.open && permLink.cat === 'permissions' && permLink.found, JSON.stringify(permLink));
  await closeIt();
  /* FEAT-146 round 4 — this used to click `#popSettings`, the footer of the
     isolation popover. That popover's only opener (`#isoBtn`) had been
     unconditionally hidden since FEAT-139, so the door was unreachable by any
     user and both were deleted this round. The INVARIANT is unchanged and is
     what is asserted here: the `iso` focus key routes to Isolation &
     environment and its anchor is on screen. `#isoBtn` is also asserted ABSENT
     — a hidden-forever button is the defect that was removed. */
  const isoGone = await cdp.eval(`({ btn: !!document.querySelector('#isoBtn'), pop: !!document.querySelector('#pop') })`);
  check('the dead isolation door is gone (#isoBtn and #pop both removed)',
    isoGone.btn === false && isoGone.pop === false, JSON.stringify(isoGone));
  await cdp.eval(`window.__station.drawer.open('settings', { focus: 'iso' })`);
  await sleep(400);
  const isoLink = await cdp.eval(`(() => ({ open: !document.querySelector('#smodal').hidden,
    cat: document.querySelector('.srail-item[aria-current="page"]')?.dataset.cat,
    found: !!document.querySelector('.view.on [data-focus="iso"]') }))()`);
  check('{focus:"iso"} → Isolation & environment, iso anchor present',
    isoLink.open && isoLink.cat === 'isolation' && isoLink.found, JSON.stringify(isoLink));
  await closeIt();
  await cdp.eval(`document.querySelector('#procPopSettings').click()`);
  await sleep(600);
  const procLink = await cdp.eval(`(() => ({ open: !document.querySelector('#smodal').hidden,
    cat: document.querySelector('.srail-item[aria-current="page"]')?.dataset.cat,
    found: !!document.querySelector('.view.on [data-focus="processes"]') }))()`);
  check('#procPopSettings {focus:"processes"} → Workspace, processes anchor present',
    procLink.open && procLink.cat === 'workspace' && procLink.found, JSON.stringify(procLink));

  section('4d. the two navigation defects this ticket also fixes');
  const collide = await cdp.eval(`(() => {
    const D = window.__station.drawer; D.close(); D.close();
    return null;
  })()`);
  void collide;
  await cdp.eval(`window.__station.drawer.open('settings', { focus: 'isoSection' })`);
  await sleep(400);
  /* PHASE 2 updated this one assertion, and only this one: the INVARIANT is
     unchanged (the group anchor and the whole-section anchor are two distinct,
     reachable nodes — the pre-phase-1 collision made the section unreachable),
     but the node that answers `isoSection` is now the CATEGORY WRAPPER rather
     than a `<details class="sect">`, because the rail replaced the sections. */
  const sectReach = await cdp.eval(`(() => {
    const host = document.querySelector('.view.on');
    const grp = host.querySelector('[data-focus="iso"]');
    const sect = host.querySelector('[data-focus="isoSection"]') ?? host.querySelector('details[data-sect="isoSection"]');
    return { grp: !!grp, sect: !!sect, distinct: !!grp && !!sect && grp !== sect,
      sectIsWrapper: sect ? sect.classList.contains('scat') : false,
      sectContainsGrp: !!grp && !!sect && sect.contains(grp),
      stillCollides: !!host.querySelector('details[data-sect="iso"]') };
  })()`);
  check('the data-focus="iso" / data-sect="iso" collision is gone — both anchors exist and are DISTINCT nodes',
    sectReach.grp && sectReach.sect && sectReach.distinct && !sectReach.stillCollides, JSON.stringify(sectReach));

  const newAnchors = { projectModel: 'model', provider: 'model', snapshots: 'snapshots', memories: 'advanced' };
  for (const [key, cat] of Object.entries(newAnchors)) {
    const r = await cdp.eval(DEEP_LINK(key));
    check(`the previously anchor-less "${key}" group now has a reachable anchor (category ${cat})`,
      r.found && r.cat === cat, JSON.stringify(r));
  }

  /* ══════════ 5. focus trap ══════════ */
  section('5. focus trap');
  await closeIt();
  const trap = await cdp.eval(`(async () => {
    const cog = document.querySelector('#cogBtn');
    cog.focus();
    const opener = document.activeElement;
    cog.click();
    await new Promise((r) => setTimeout(r, 400));
    return {
      openerWasCog: opener === cog,
      inert: document.querySelector('#win').hasAttribute('inert'),
      focusInRail: document.activeElement?.classList.contains('srail-item'),
      focusCat: document.activeElement?.dataset?.cat,
      selectedCat: document.querySelector('.srail-item[aria-current="page"]')?.dataset.cat,
    };
  })()`);
  check('opening sets inert on the app root and focuses the SELECTED rail item (never a pane control)',
    trap.inert === true && trap.focusInRail === true && !!trap.focusCat
      && trap.focusCat === trap.selectedCat, JSON.stringify(trap));

  // Tab from the LAST focusable must wrap to the FIRST.
  const wrap = await cdp.eval(`(() => {
    const SEL = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const list = [...document.querySelector('#smodal').querySelectorAll(SEL)].filter((n) => n.checkVisibility({ checkVisibilityCSS: true }));
    const last = list[list.length - 1];
    last.focus();
    return { n: list.length, seated: document.activeElement === last,
      lastId: last.id || last.className, lastTag: last.tagName,
      lastText: (last.textContent || '').slice(0, 30), firstId: list[0].id || list[0].className };
  })()`);
  check('PRECONDITION: focus really seated on the last focusable before the wrap is measured',
    wrap.seated === true, JSON.stringify(wrap));
  await cdp.key(KEY.Tab);
  await sleep(150);
  const wrapped = await cdp.eval(`(() => {
    const SEL = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const list = [...document.querySelector('#smodal').querySelectorAll(SEL)].filter((n) => n.checkVisibility({ checkVisibilityCSS: true }));
    return { isFirst: document.activeElement === list[0], inModal: document.querySelector('#smodal').contains(document.activeElement),
      id: document.activeElement.id || document.activeElement.className };
  })()`);
  check('Tab from the last focusable wraps to the first and never escapes the modal',
    wrap.n > 3 && wrap.seated && wrapped.isFirst && wrapped.inModal, JSON.stringify({ ...wrap, ...wrapped }));

  await cdp.eval(`window.__station.drawer.close()`);
  await sleep(200);
  const restored = await cdp.eval(`(() => ({
    hidden: document.querySelector('#smodal').hidden,
    inert: document.querySelector('#win').hasAttribute('inert'),
    focus: document.activeElement?.id,
  }))()`);
  check('closing removes inert and returns focus to the opener (#cogBtn)',
    restored.hidden === true && restored.inert === false && restored.focus === 'cogBtn', JSON.stringify(restored));

  // Opener repainted away → fall back to #cogBtn rather than dropping focus to <body>.
  const fallback = await cdp.eval(`(async () => {
    const ghost = document.createElement('button');
    ghost.id = 'feat146Ghost';
    document.querySelector('.crown').appendChild(ghost);
    ghost.focus();
    await window.__station.drawer.open('settings');
    await new Promise((r) => setTimeout(r, 250));
    ghost.remove();                       // the opener is repainted away mid-visit
    window.__station.drawer.close();
    await new Promise((r) => setTimeout(r, 200));
    return { focus: document.activeElement?.id, isBody: document.activeElement === document.body };
  })()`);
  check('when the opener was repainted away, focus falls back to #cogBtn (never to <body>)',
    fallback.focus === 'cogBtn' && !fallback.isBody, JSON.stringify(fallback));

  /* ══════════ 6. Esc ladder + close guard ══════════ */
  section('6. Esc ladder and the close guard');
  await closeIt();
  // Arm a REAL ceremony: the git-init confirm on a non-repo scratch project.
  await cdp.eval(`window.__station.drawer.open('settings', { focus: 'git' })`);
  // Round 4: the Git card's actions are all `.mini` in one `.cacts` row now (the
  // three-idiom stack it used to be is the defect that removed).
  await cdp.waitFor('git group', `!!document.querySelector('.view.on [data-focus="git"] .cacts .mini')`, 15000);
  const armed = await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('.view.on [data-focus="git"] button')].find((x) => /git init/i.test(x.textContent));
    if (!b) return { armed: false, why: 'no git-init button' };
    b.click();
    return { armed: !!document.querySelector('#dBody [data-armed="true"]') };
  })()`);
  check('a real destructive-adjacent ceremony is armed (git init confirm)', armed.armed === true, JSON.stringify(armed));

  await cdp.key(KEY.Escape);
  await sleep(200);
  const afterEsc1 = await cdp.eval(`({ open: !document.querySelector('#smodal').hidden, armed: !!document.querySelector('#dBody [data-armed="true"]') })`);
  check('Esc #1 DISARMS the ceremony and the modal stays open',
    afterEsc1.open === true && afterEsc1.armed === false, JSON.stringify(afterEsc1));
  await cdp.key(KEY.Escape);
  await sleep(200);
  const afterEsc2 = await cdp.eval(`document.querySelector('#smodal').hidden`);
  check('Esc #2 closes the modal', afterEsc2 === true, String(afterEsc2));

  // backdrop click over an armed ceremony: refuses, scrolls it in and flashes.
  await cdp.eval(`window.__station.drawer.open('settings', { focus: 'git' })`);
  await cdp.waitFor('git group', `!!document.querySelector('.view.on [data-focus="git"] .addrow')`, 15000);
  await cdp.eval(`[...document.querySelectorAll('.view.on [data-focus="git"] button')].find((x) => /git init/i.test(x.textContent))?.click()`);
  await sleep(150);
  await cdp.eval(`document.querySelector('#smodalBack').click()`);
  await sleep(150);
  const afterBack = await cdp.eval(`({ open: !document.querySelector('#smodal').hidden,
    armed: !!document.querySelector('#dBody [data-armed="true"]'),
    flashed: !!document.querySelector('#dBody [data-armed="true"].focus-flash') })`);
  check('a backdrop click over an armed ceremony does NOT close — it flashes the armed element instead',
    afterBack.open && afterBack.armed && afterBack.flashed, JSON.stringify(afterBack));
  await cdp.eval(`window.__station.drawer.close()`); // disarm
  await sleep(150);
  await closeIt();

  // live sign-in: driven through the REAL login relay against a stubbed CLI.
  await cdp.eval(`window.__station.drawer.open('settings', { scope: 'machine' })`);
  await cdp.waitFor('accounts panel', `!!document.querySelector('#gAcctAdd')`, 15000);
  await cdp.eval(`document.querySelector('#gAcctAdd').click()`);
  await sleep(200);
  await cdp.waitFor('label field', `!!document.querySelector('#gAcctLabel')`, 8000);
  await cdp.eval(`(() => { const i = document.querySelector('#gAcctLabel'); i.value = 'verify stub'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await cdp.eval(`document.querySelector('#gAcctCreate').click()`);
  const loginUp = await cdp.waitFor('login panel', `!!document.querySelector('#gAcctCancel')`, 30000);
  check('a REAL sign-in is in flight (product login relay + a stubbed claude binary)', loginUp === true, String(loginUp));
  if (loginUp) {
    await cdp.key(KEY.Escape);
    await sleep(200);
    const escLogin = await cdp.eval(`({ open: !document.querySelector('#smodal').hidden,
      flashed: !!document.querySelector('#gAcctCancel.focus-flash'), login: !!document.querySelector('#gAcctCancel') })`);
    check('Esc during a live sign-in does NOT close — the cancel control flashes instead',
      escLogin.open && escLogin.login && escLogin.flashed, JSON.stringify(escLogin));
    await sleep(1400);
    await cdp.eval(`document.querySelector('#smodalBack').click()`);
    await sleep(200);
    const backLogin = await cdp.eval(`({ open: !document.querySelector('#smodal').hidden,
      flashed: !!document.querySelector('#gAcctCancel.focus-flash') })`);
    check('a backdrop click during a live sign-in does NOT close either', backLogin.open && backLogin.flashed, JSON.stringify(backLogin));
    // Cancel through the product's own path: it kills the child PROCESS GROUP.
    await cdp.eval(`document.querySelector('#gAcctCancel').click()`);
    await sleep(1200);
  }
  await closeIt();

  /* ══════════ 7. rail keyboard ══════════ */
  section('7. rail keyboard navigation');
  await cdp.eval(`window.__station.drawer.open('settings')`);
  await sleep(300);
  const railFocus = () => cdp.eval(`(() => ({
    cat: document.querySelector('.srail-item[aria-current="page"]')?.dataset.cat,
    focused: document.activeElement?.dataset?.cat ?? null,
    inRail: !!document.activeElement?.closest?.('#sRail'),
  }))()`);
  await cdp.eval(`document.querySelector('.srail-item[data-cat="advanced"]').focus()`);
  await cdp.eval(`window.__station.drawer` && `void 0`);
  // seat selection on 'advanced' (last of the project group) first
  await cdp.key(KEY.ArrowUp); await sleep(100);
  await cdp.key(KEY.ArrowDown); await sleep(100);
  const atBoundary = await railFocus();
  await cdp.key(KEY.ArrowDown); await sleep(150);
  const crossed = await railFocus();
  check('↓ crosses the "This project" → "This machine" group boundary, selecting AND keeping focus in the rail',
    atBoundary.cat === 'advanced' && crossed.cat === 'accounts' && crossed.focused === 'accounts' && crossed.inRail,
    JSON.stringify({ atBoundary, crossed }));
  await cdp.key(KEY.ArrowUp); await sleep(150);
  const backUp = await railFocus();
  check('↑ crosses back the other way', backUp.cat === 'advanced' && backUp.inRail, JSON.stringify(backUp));
  await cdp.key(KEY.End); await sleep(150);
  const atEnd = await railFocus();
  await cdp.key(KEY.Home); await sleep(150);
  const atHome = await railFocus();
  check('End / Home jump to the last and first categories, focus still in the rail',
    atEnd.cat === 'templates' && atHome.cat === 'model' && atEnd.inRail && atHome.inRail,
    JSON.stringify({ atEnd, atHome }));
  await cdp.key(KEY.Enter); await sleep(150);
  const afterEnter = await cdp.eval(`(() => ({ inRail: !!document.activeElement?.closest?.('#sRail'),
    isPane: document.activeElement?.id === 'dBody' }))()`);
  check('only Enter moves focus OUT of the rail and into the pane',
    afterEnter.inRail === false && afterEnter.isPane === true, JSON.stringify(afterEnter));

  /* ══════════ 8. the lens ══════════ */
  section('8. the scope lens changes the write target and nothing else');
  await closeIt();
  await goto(containerId);
  await cdp.eval(`window.__station.drawer.open('settings')`);
  await cdp.waitFor('modal', `!document.querySelector('#smodal').hidden`);
  /* Phase 2: measured on Permissions & tools. Isolation used to carry the
     snapshot settings card as well and was the longest project pane; the pane
     FILTERS now, so the scroll-preservation invariant is measured wherever the
     content is genuinely taller than the pane — which is asserted, not assumed. */
  await cdp.eval(`document.querySelector('.srail-item[data-cat="permissions"]').click()`);
  await cdp.waitFor('permissions pane', `!!document.querySelector('.view.on [data-focus="permissionMode"]')`, 10000);
  // Past the FLASH_MS window and past the async git/proc/wiring repaints, so
  // the scroll measured below is the reader's, not a deep link's re-land.
  await sleep(2200);
  const scrollable = await cdp.eval(`(() => { const p = document.querySelector('#dBody'); return p.scrollHeight - p.clientHeight; })()`);
  check('PRECONDITION: the pane under test really is scrollable (otherwise the next check is vacuous)',
    scrollable > 120, `${scrollable}px of overflow`);
  const lensFlip = await cdp.eval(`(() => {
    const pane = document.querySelector('#dBody');
    pane.scrollTop = 120;
    const before = { scroll: pane.scrollTop, cat: document.querySelector('.srail-item[aria-current="page"]').dataset.cat,
      railHtml: document.querySelector('#sRail').innerHTML.length,
      railNode: document.querySelector('.srail-item[data-cat="permissions"]') };
    document.querySelector('#dScope button[data-scope="session"]').click();
    const after = { scroll: pane.scrollTop, cat: document.querySelector('.srail-item[aria-current="page"]').dataset.cat,
      railHtml: document.querySelector('#sRail').innerHTML.length,
      sameNode: before.railNode === document.querySelector('.srail-item[data-cat="permissions"]'),
      pressed: [...document.querySelectorAll('#dScope button')].map((b) => b.getAttribute('aria-pressed')),
      hint: document.querySelector('#dHint').textContent };
    return { beforeScroll: before.scroll, afterScroll: after.scroll, beforeCat: before.cat, afterCat: after.cat,
      sameNode: after.sameNode, railHtmlSame: before.railHtml === after.railHtml, pressed: after.pressed, hint: after.hint };
  })()`);
  check('flipping the lens leaves scroll offset byte-identical, the rail NOT rebuilt, and the selection unchanged',
    lensFlip.beforeScroll === 120 && lensFlip.afterScroll === 120
      && lensFlip.beforeCat === lensFlip.afterCat && lensFlip.sameNode === true && lensFlip.railHtmlSame,
    JSON.stringify(lensFlip));
  check('the lens says what it now writes to',
    JSON.stringify(lensFlip.pressed) === '["false","true"]' && /this session only/i.test(lensFlip.hint),
    JSON.stringify({ pressed: lensFlip.pressed, hint: lensFlip.hint }));

  // WRITE TARGET: the same click writes a session override under one lens and
  // the registry under the other. Read back from the SERVER, not from the DOM.
  // (Phase 2: Effort lives in Model & spend now — the pane FILTERS, so the row
  // has to be looked for in the category that owns it.)
  await cdp.eval(`document.querySelector('.srail-item[data-cat="model"]').click()`);
  await cdp.waitFor('model pane', `!!document.querySelector('.view.on [data-focus="projectModel"]')`, 10000);
  const regBefore = await (await fetch(`${base}/api/projects/${containerId}`)).json();
  await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('.view.on .set')].find((r) => r.querySelector('.l')?.textContent.startsWith('Effort'));
    row.click();
  })()`);
  await sleep(500);
  const regAfterSession = await (await fetch(`${base}/api/projects/${containerId}`)).json();
  const sessionWrote = await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('.view.on .set')].find((r) => r.querySelector('.l')?.textContent.startsWith('Effort'));
    // Phase 2b: the "overridden" tag in the value slot is gone — the provenance
    // CHIP in column 2 carries that fact now (filled = set at the current write
    // target). The invariant this line asserts is unchanged: the row must SHOW
    // that the write landed at session scope.
    const chip = row.querySelector('.prov');
    return { ovr: chip?.dataset.level === 'session' && chip?.dataset.fill === 'true',
      rev: !!row.querySelector('.rev'), text: row.querySelector('.v').textContent.trim() };
  })()`);
  const effBefore = (regBefore.project ?? regBefore)?.settings?.effort ?? null;
  const effAfterS = (regAfterSession.project ?? regAfterSession)?.settings?.effort ?? null;
  check('under the SESSION lens the write is a session override — the registry is untouched',
    effBefore === effAfterS && sessionWrote.ovr === true && sessionWrote.rev === true,
    JSON.stringify({ effBefore, effAfterS, ...sessionWrote }));

  await cdp.eval(`document.querySelector('#dScope button[data-scope="project"]').click()`);
  await sleep(200);
  await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('.view.on .set')].find((r) => r.querySelector('.l')?.textContent.startsWith('Effort'));
    row.click();
  })()`);
  await sleep(700);
  const regAfterProject = await (await fetch(`${base}/api/projects/${containerId}`)).json();
  const effAfterP = (regAfterProject.project ?? regAfterProject)?.settings?.effort ?? null;
  check('under the PROJECT lens the SAME click writes through to the registry',
    effAfterP !== effBefore, `registry effort: ${JSON.stringify(effBefore)} → ${JSON.stringify(effAfterP)}`);

  // `.rev` was keyboard-dead (role=button, tabindex=0, click handler, no keydown).
  await cdp.eval(`document.querySelector('#dScope button[data-scope="session"]').click()`);
  await sleep(200);
  const revKb = await cdp.eval(`(async () => {
    const find = () => [...document.querySelectorAll('.view.on .set')].find((r) => r.querySelector('.l')?.textContent.startsWith('Effort'));
    let row = find();
    if (!row.querySelector('.rev')) { row.click(); await new Promise((r) => setTimeout(r, 300)); row = find(); }
    const rev = row.querySelector('.rev');
    if (!rev) return { had: false };
    rev.focus();
    rev.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    return { had: true, gone: !find().querySelector('.rev') };
  })()`);
  check('.rev answers Enter from the keyboard (it was click-only, so revert was keyboard-dead)',
    revKb.had === true && revKb.gone === true, JSON.stringify(revKb));

  /* ══════════ 9. widths and themes ══════════ */
  section('9. renders at three widths in both themes, with zero console errors');
  await closeIt();
  await goto(directId);
  consoleErrors = [];
  for (const [w, h, label] of [[940, 780, '940'], [800, 780, '800'], [500, 820, '500']]) {
    await cdp.viewport(w, h);
    await sleep(250);
    for (const tone of ['light', 'dark']) {
      await cdp.theme(tone);
      await cdp.eval(`window.__station.drawer.open('settings')`);
      await sleep(500);
      const geo = await cdp.eval(`(() => {
        const box = document.querySelector('.smodal-box');
        const r = box.getBoundingClientRect();
        const cs = getComputedStyle(box);
        const rail = document.querySelector('#sRail').getBoundingClientRect();
        const pane = document.querySelector('#dBody');
        const back = document.querySelector('.smodal-back');
        return { w: Math.round(r.width), h: Math.round(r.height), cols: cs.gridTemplateColumns,
          sideBySide: rail.right <= pane.getBoundingClientRect().left + 1,
          backShown: getComputedStyle(back).display !== 'none',
          overflowsViewport: r.right > innerWidth + 1 || r.bottom > innerHeight + 1,
          paneClipped: pane.scrollWidth > pane.clientWidth + 1,
          items: document.querySelectorAll('.srail-item').length };
      })()`);
      const oneCol = geo.cols.split(' ').length === 1;
      // >=860: two columns, rail beside the pane. <860: one column, rail is a
      // horizontal strip ABOVE the pane. <560: full-bleed sheet, no backdrop.
      const ok = geo.items === 11 && !geo.overflowsViewport && !geo.paneClipped
        && (w >= 860 ? (!oneCol && geo.sideBySide) : (oneCol && !geo.sideBySide))
        && (w >= 560 ? geo.backShown : !geo.backShown);
      check(`${label}px / ${tone}: layout is correct for its breakpoint and nothing overflows`, ok, JSON.stringify(geo));
      await shot(`feat146-${label}-${tone}.png`, 3);
      await closeIt();
    }
  }
  await cdp.viewport(1400, 1000);
  check('zero console errors across every width and both themes',
    consoleErrors.length === 0, consoleErrors.length ? consoleErrors.slice(0, 6).join(' | ') : 'none');

  /* ══════════ 10. MUST-FAIL — a synthesized pre-fix drawer.js ══════════ */
  section('10. must-FAIL: the same deep-link suite against a SYNTHESIZED pre-fix drawer.js');
  /* Anchored to a CONSTRUCTED broken variant, never to a moving revision: the
     shipped module is rewritten on the wire with FOCUS_CATEGORY emptied, which
     is exactly the pre-fix state (a rail that cannot route a focus key). If the
     suite above still passed here it would be measuring nothing. */
  const realSrc = fs.readFileSync(path.join(ROOT, 'public', 'lib', 'drawer.js'), 'utf8');
  const marker = '  const FOCUS_CATEGORY = {';
  check('PRECONDITION: the FOCUS_CATEGORY map is where the mutation expects it',
    realSrc.includes(marker), marker);
  const brokenSrc = realSrc.replace(marker, '  const FOCUS_CATEGORY = {}; const FOCUS_CATEGORY_DEAD = {');
  check('PRECONDITION: the synthesized variant really differs from the shipped one',
    brokenSrc !== realSrc && brokenSrc.includes('const FOCUS_CATEGORY = {};'),
    `${realSrc.length} → ${brokenSrc.length} bytes`);

  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/lib/drawer.js', requestStage: 'Request' }] });
  cdp.on('Fetch.requestPaused', (p) => {
    void cdp.send('Fetch.fulfillRequest', {
      requestId: p.requestId, responseCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'text/javascript' }],
      body: Buffer.from(brokenSrc, 'utf8').toString('base64'),
    });
  });
  await goto(directId);
  const mutated = await cdp.eval(`(async () => {
    const r = await fetch('/lib/drawer.js'); const t = await r.text();
    return t.includes('const FOCUS_CATEGORY = {};');
  })()`);
  check('the page is really running the synthesized pre-fix module', mutated === true, String(mutated));

  let mustFailRed = 0, mustFailTotal = 0;
  for (const key of ['permissionMode', 'git', 'processes', 'responseDigest', 'wiring', 'instructions']) {
    mustFailTotal++;
    let r;
    try { r = await cdp.eval(DEEP_LINK(key)); } catch (err) { r = { error: err.message }; }
    const routed = !!r && r.cat === FOCUS_CATEGORY_EXPECT[key];
    if (!routed) mustFailRed++;
    console.log(`        ${key}: cat=${r?.cat} found=${r?.found} (expected ${FOCUS_CATEGORY_EXPECT[key]})`);
  }
  check('MUST-FAIL: with FOCUS_CATEGORY emptied, every one of the 6 sampled deep links stops routing',
    mustFailRed === mustFailTotal, `${mustFailRed}/${mustFailTotal} went red`);
  await cdp.send('Fetch.disable');

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} passed, ${fail} failed`);
  if (fail) console.log(failures.map((f) => `  · ${f}`).join('\n'));
  console.log('\nscreenshots:');
  for (const s of shots) console.log(`  ${s}`);
}

const FOCUS_CATEGORY_EXPECT = {
  permissionMode: 'permissions', git: 'workspace', processes: 'workspace',
  responseDigest: 'instructions', wiring: 'advanced', instructions: 'instructions',
};

try {
  await main();
} catch (err) {
  console.error(`\nHARNESS ERROR: ${err.stack || err.message}`);
  fail++;
} finally {
  cdp?.close();
  for (const p of procs) stopByPid(p);
  await sleep(500);
  process.exit(fail ? 1 : 0);
}
