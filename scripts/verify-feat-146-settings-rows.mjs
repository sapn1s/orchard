/**
 * FEAT-146 (phase 2b) — LIVE PROOF of row treatment: the four-column grid, the
 * provenance chip, and the inline `ⓘ` disclosure.
 *
 *   node scripts/verify-feat-146-settings-rows.mjs
 *
 * THE ASSERTION THAT MATTERS is the hazard rule, and it is the reason this file
 * exists at all. The mechanical test the ticket settled on:
 *
 *   if removing the sentence could cause the user to take an irreversible,
 *   costly, or security-widening action they would otherwise not take, it
 *   stays inline.
 *
 * So section 1 drives each load-bearing string onto the screen in the REAL state
 * that produces it — a bypassPermissions project, a container with the docker
 * socket on, a project whose directory has actually been deleted, the session
 * lens on a container project — and asserts, for every one of them, that it is
 * visible on FIRST PAINT and is not inside a `.set-why.disclosure`. It then
 * closes the general case with a two-directional invariant: EVERY block the
 * whole modal can render, across all 11 categories and both lenses, must carry
 * one of the five definitional descriptions. A load-bearing sentence cannot hide
 * behind an icon without breaking that.
 *
 * Non-vacuity: the sweep is re-run against a SYNTHESIZED variant of drawer.js
 * that moves exactly one load-bearing sentence (permModeNote's) behind an `ⓘ`,
 * served over CDP Fetch interception. Anchored to a constructed broken variant,
 * never to a moving revision.
 *
 * Also proved here, each printing what was observed:
 *   · the chip in all five states against REAL inheritance (built-in / machine /
 *     project / session / project-only), filled-vs-hollow against the current
 *     write target, and the flip when the lens flips;
 *   · reset renders only on a filled chip and really reverts to the resolved
 *     parent value, read back from the server;
 *   · the `ⓘ` keyboard path end to end with REAL key events over CDP Input —
 *     Tab reaches it, Enter toggles, aria-expanded/-controls/-describedby are
 *     wired, Esc collapses, restores focus, and does NOT close the modal;
 *   · `Show all descriptions` across categories, surviving a reload;
 *   · NO REFLOW: the 46px gutter is reserved, so the column rails are identical
 *     with and without a reset button — measured in pixels, two ways;
 *   · chip contrast in BOTH themes in BOTH treatments;
 *   · 940/800/500px, zero console errors.
 *
 * Harness: the real server + brave --headless=new over raw CDP — the same shape
 * phases 1 and 2a used, deliberately not a third harness. Ports are OS-assigned.
 * Every process is one this script spawned and is stopped by PID. No product
 * code is modified on disk.
 *
 * Leak hygiene: every path used here is created by this script under the system
 * temp dir; no home path, no username and no real project path is written to
 * disk or printed. Confirm with `node scripts/leak-gate.mjs --summary`.
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

const RAIL_IDS = ['model', 'permissions', 'instructions', 'isolation', 'snapshots', 'workspace',
  'advanced', 'accounts', 'appearance', 'defaults', 'templates'];

/* ───────────────────────── the load-bearing inventory ─────────────────────────
 * Each entry names a sentence that may NEVER go behind an `ⓘ`, the hazard class
 * it falls under, and the real state that puts it on screen. `proj` selects
 * which of the three projects the harness built; `lens` which write target.
 *
 * Classes: (a) destruction/overwrite of user data · (b) widening of security
 * posture · (c) what a control does NOT protect · (d) live-state honesty ·
 * (e) cost and billing consequence.
 */
const LOAD_BEARING = [
  { id: 'bypass-perms', cls: 'b', proj: 'direct', lens: 'project', cat: 'permissions',
    text: 'Approvals are skipped: the model runs commands on this machine without asking.' },
  { id: 'no-container', cls: 'c', proj: 'direct', lens: 'project', cat: 'isolation',
    text: 'No container. Work happens on this machine with nothing held back.' },
  { id: 'docker-socket', cls: 'b', proj: 'container', lens: 'project', cat: 'isolation',
    text: 'the isolation you set above stops at the socket' },
  { id: 'project-only-iso', cls: 'c', proj: 'container', lens: 'session', cat: 'isolation',
    text: 'can only be set for the whole project' },
  { id: 'account-pinned', cls: 'e', proj: 'container', lens: 'session', cat: 'model',
    text: 'the account is pinned at project scope here' },
  { id: 'dir-gone', cls: 'a', proj: 'gone', lens: 'project', cat: 'workspace',
    text: 'This directory is gone.' },
  { id: 'dir-gone-consequence', cls: 'a', proj: 'gone', lens: 'project', cat: 'workspace',
    text: 'sessions can’t start' },
  { id: 'restore-excludes', cls: 'c', proj: 'container', lens: 'project', cat: 'snapshots',
    text: 'a restore does not touch them — they stay exactly as they are now' },
];

/** The five descriptions that ARE allowed behind an `ⓘ`, by their opening words. */
const ALLOWED_WHY_OPENERS = [
  'Which Claude model a new session',
  'How much reasoning the model is asked',
  'The Docker image sessions in this project run inside',
  'Serena attaches a language server',
  'Playwright gives a session a headless browser',
];

/* ── infra (same shape as phases 1 and 2a) ── */
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
  /** A REAL key press, not a synthetic KeyboardEvent — default actions run. */
  async key(key, code, vk, text = undefined) {
    await this.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await sleep(160);
  }
  tab() { return this.key('Tab', 'Tab', 9); }
  enter() { return this.key('Enter', 'Enter', 13, '\r'); }
  esc() { return this.key('Escape', 'Escape', 27); }
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

async function shot(name, minKb = 3) {
  const file = path.join(ROOT, name);
  await cdp.shot(file);
  const kb = fs.statSync(file).size / 1024;
  check(`capture ${name} (non-blank, > ${minKb}KB)`, kb > minKb, `${kb.toFixed(1)} KB`);
  shots.push(file);
  return file;
}

/**
 * In-page: find the element that actually renders a sentence, and report
 * whether it is visible on screen and whether it sits inside a disclosure.
 * FEAT-146 round 4 note: `.set-why` became the ONE explanatory surface in this
 * modal (the old `.risk .why` hairline variant was deleted), so the class alone
 * no longer means "behind an icon". `.set-why.disclosure` does, and that is the
 * set this rule has always been about.
 * A TreeWalker over text nodes, so a sentence split across <b>/<code> children
 * is found by the fragment the harness names.
 */
const FIND = (sub) => `(() => {
  const host = document.querySelector('#dBody .view.on');
  if (!host) return { found: false, why: 'no visible view host' };
  const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let n = null, hit = null;
  while ((n = w.nextNode())) { if (n.nodeValue && n.nodeValue.includes(${JSON.stringify(sub)})) { hit = n.parentElement; break; } }
  if (!hit) return { found: false, paneText: host.textContent.slice(0, 120) };
  return {
    found: true,
    visible: typeof hit.checkVisibility === 'function' ? hit.checkVisibility({ checkVisibilityCSS: true }) : hit.offsetParent !== null,
    inWhy: !!hit.closest('.set-why.disclosure'),
    behindHidden: !!hit.closest('[hidden]'),
    // the row (or card) it belongs to, and whether that row carries an info toggle
    rowHasInfoButton: !!(hit.closest('.set') ?? hit.closest('.grp'))?.querySelector('button.why[data-why]'),
  };
})()`;

/** Every ⓘ-toggled block the modal can render, across all categories + lenses. */
const WHY_SWEEP = `(async () => {
  const D = window.__station.drawer;
  const out = [];
  for (const lens of ['project', 'session']) {
    for (const id of ${JSON.stringify(RAIL_IDS)}) {
      D.close(); D.close();
      await D.open('settings', { scope: lens });
      document.querySelector('.srail-item[data-cat="' + id + '"]').click();
      await new Promise((r) => setTimeout(r, 420));
      for (const b of document.querySelectorAll('#dBody .view.on .set-why.disclosure')) {
        out.push({ lens, cat: id, text: b.textContent.trim() });
      }
    }
  }
  D.close(); D.close();
  return out;
})()`;

/** The Effort row, wherever it currently is, reported in full. */
const EFFORT = `(() => {
  const row = [...document.querySelectorAll('#dBody .view.on .set')].find((r) => r.querySelector('.l')?.textContent.startsWith('Effort'));
  if (!row) return { found: false };
  const chip = row.querySelector('.prov');
  const rev = row.querySelector('.rev');
  const rect = (n) => { if (!n) return null; const b = n.getBoundingClientRect(); const p = row.getBoundingClientRect();
    return { left: Math.round(b.left - p.left), right: Math.round(b.right - p.left), w: Math.round(b.width) }; };
  const rb = row.getBoundingClientRect();
  return { found: true,
    level: chip?.dataset.level ?? null, fill: chip?.dataset.fill ?? null, chipText: chip?.textContent ?? null,
    value: row.querySelector('.v')?.textContent.trim() ?? null,
    dim: !!row.querySelector('.v')?.classList.contains('dim'),
    rev: !!rev, revLabel: rev?.getAttribute('aria-label') ?? null,
    label: row.querySelector('.set-main')?.getAttribute('aria-label') ?? null,
    geo: { h: Math.round(rb.height), w: Math.round(rb.width),
      l: rect(row.querySelector('.l')), v: rect(row.querySelector('.v')), gut: rect(row.querySelector('.sgut')) } };
})()`;

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat146c-verify-'));
  const DATA = path.join(tmp, 'data');
  const CFG = path.join(tmp, 'cfg');
  const STORE = path.join(CFG, 'projects');
  const DIRECT = path.join(tmp, 'p-direct');
  const CONTAINER = path.join(tmp, 'p-container');
  const GONE = path.join(tmp, 'p-gone');
  const BIN = path.join(tmp, 'bin');
  for (const dd of [DATA, CFG, STORE, DIRECT, CONTAINER, GONE, BIN]) fs.mkdirSync(dd, { recursive: true });

  /* A stub `claude` so nothing reaches the network if an account path is hit. */
  fs.writeFileSync(path.join(BIN, 'claude'), [
    '#!/bin/sh',
    'if [ "$2" = "status" ]; then echo \'{"loggedIn":false}\'; exit 1; fi',
    'echo "https://example.invalid/cai/oauth/authorize?code=stub&state=stub"',
    'cat > /dev/null',
  ].join('\n') + '\n', { mode: 0o755 });

  const port = await freePort();
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${BIN}:${process.env.PATH}`,
      PORT: String(port), HOST: '127.0.0.1',
      CLAUDE_STATION_DATA: DATA, CLAUDE_CONFIG_DIR: CFG, CLAUDE_PROJECTS_DIR: STORE,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  procs.push(server);
  server.stderr?.on('data', (dd) => { const s = String(dd); if (/error|Error/.test(s)) process.stderr.write(`  [srv!] ${s}`); });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 200 && !up; i++) { try { await fetch(`${base}/api/health`); up = true; } catch { await sleep(250); } }
  check('the real server booted and answers /api/health', up, base);
  if (!up) throw new Error('server never became healthy');

  const mk = async (hostPath, name) => {
    const r = await (await fetch(`${base}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostPath, name, applyMethod: false }),
    })).json();
    return r.project?.id;
  };
  const patch = (id, body) => fetch(`${base}/api/projects/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());
  const readProj = async (id) => {
    const r = await (await fetch(`${base}/api/projects/${id}`)).json();
    return r.project ?? r;
  };

  const directId = await mk(DIRECT, 'direct proj');
  const containerId = await mk(CONTAINER, 'container proj');
  const goneId = await mk(GONE, 'vanished proj');
  const PROJ = { direct: directId, container: containerId, gone: goneId };

  /* The real states each load-bearing sentence needs. Every one is a real
     server write, read back below — not a client-side fixture. */
  await patch(containerId, { isolation: 'container', container: { dockerSocket: true } });
  await patch(directId, { isolation: 'direct', permissionMode: 'bypassPermissions' });
  fs.rmSync(GONE, { recursive: true, force: true });   // the directory really is gone

  const cProj = await readProj(containerId);
  const dProj = await readProj(directId);
  const gProj = await readProj(goneId);
  check('PRECONDITION: the three real states exist on the SERVER (container+socket, direct+bypass, a deleted directory)',
    cProj.isolation === 'container' && cProj.settings?.container?.dockerSocket === true
      && dProj.isolation === 'direct' && dProj.settings?.permissionMode === 'bypassPermissions'
      && !fs.existsSync(GONE),
    JSON.stringify({ container: cProj.settings?.container, direct: dProj.settings?.permissionMode, goneExists: fs.existsSync(GONE), goneName: !!gProj.name }));

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

  const goto = async (id) => {
    await cdp.send('Page.navigate', { url: 'about:blank' });
    await sleep(120);
    await cdp.send('Page.navigate', { url: `${base}/#/project/${encodeURIComponent(id)}` });
    await cdp.waitFor('app boot', `!!(window.__station && window.__station.drawer)`);
    await cdp.waitFor('the right project selected', `window.__station.currentProject()?.id === ${JSON.stringify(id)}`);
    await sleep(300);
  };
  const closeIt = async () => { await cdp.eval(`(() => { const D = window.__station.drawer; D.close(); D.close(); })()`); await sleep(140); };
  /** Open the modal fresh on a category under a lens, and let async reads land. */
  const openCat = async (cat, lens = 'project', settle = 1100) => {
    await closeIt();
    await cdp.eval(`(async () => { await window.__station.drawer.open('settings', { scope: ${JSON.stringify(lens)} });
      document.querySelector('.srail-item[data-cat="${cat}"]').click(); })()`);
    await sleep(settle);
  };

  /* A REAL second Claude account, created through the product's own route — the
     account-pinned sentence only renders when there is a choice to lock. */
  const acctRes = await (await fetch(`${base}/api/claude-accounts`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Work Max' }),
  })).json();
  const WORK_ID = acctRes.account?.id ?? acctRes.id ?? null;
  check('PRECONDITION: a REAL second Claude account exists on the server', typeof WORK_ID === 'string' && !!WORK_ID, String(WORK_ID));
  const seedAccounts = async () => cdp.eval(`(() => { window.__station.setAccountsForTest([
    { id: 'default', label: 'Default (~/.claude)', state: 'ready', lastStatus: { subscriptionType: 'pro' } },
    { id: ${JSON.stringify(WORK_ID)}, label: 'Work Max', state: 'ready', lastStatus: { subscriptionType: 'max' } }]); })()`);

  await cdp.theme('dark');
  await goto(containerId);
  await seedAccounts();
  consoleErrors = [];

  /* ══════════ 0. the CSS this row treatment is built on ══════════ */
  section('0. preconditions: the layout primitives the four-column row needs');
  const cssOk = await cdp.eval(`({
    subgrid: CSS.supports('grid-template-columns', 'subgrid'),
    has: CSS.supports('selector(:has(*))'),
  })`);
  check('the browser under test supports subgrid and :has (the cycle row spans columns 1-3 as a subgrid)',
    cssOk.subgrid === true && cssOk.has === true, JSON.stringify(cssOk));

  /* ══════════ 1. THE HAZARD ASSERTION ══════════ */
  section('1. the hazard rule: every load-bearing sentence is visible on first paint and behind NO toggle');
  const hazard = [];
  for (const lb of LOAD_BEARING) {
    await goto(PROJ[lb.proj]);
    await seedAccounts();
    await openCat(lb.cat, lb.lens);
    const r = await cdp.eval(FIND(lb.text));
    hazard.push({ id: lb.id, ...r });
    check(`(${lb.cls}) "${lb.id}" renders IN FLOW on first paint — found, visible, not inside a .set-why`,
      r.found === true && r.visible === true && r.inWhy === false && r.behindHidden === false,
      JSON.stringify(r));
  }
  check(`all ${LOAD_BEARING.length} load-bearing sentences cleared the rule (classes a/b/c/e covered)`,
    hazard.every((h) => h.found && h.visible && !h.inWhy),
    hazard.map((h) => `${h.id}:${h.found && h.visible && !h.inWhy ? 'ok' : 'BROKEN'}`).join(' '));

  /* (d) live-state honesty — the provider verdict is a live read, so its WORDING
     is not pinned; its presence in flow is. */
  await goto(containerId);
  await seedAccounts();
  await openCat('model');
  const provState = await cdp.eval(`(() => { const n = document.querySelector('#dBody .view.on .prov-state');
    return n ? { text: n.textContent.trim(), status: n.dataset.status ?? null, inWhy: !!n.closest('.set-why.disclosure'),
      visible: n.checkVisibility({ checkVisibilityCSS: true }) } : { text: null }; })()`);
  check('(d) the live provider verdict renders in flow, never behind an icon',
    !!provState.text && provState.visible === true && provState.inWhy === false, JSON.stringify(provState));

  /* The general case, two-directionally: every `.set-why` the modal can produce,
     over all 11 categories and both lenses, carries a DEFINITIONAL description. */
  const whys = await cdp.eval(WHY_SWEEP);
  const foreign = whys.filter((w) => !ALLOWED_WHY_OPENERS.some((o) => w.text.startsWith(o)));
  check('every `.set-why` block the modal can render carries one of the five definitional descriptions — nothing else',
    whys.length > 0 && foreign.length === 0,
    foreign.length ? `FOREIGN PROSE BEHIND AN ICON: ${foreign.map((f) => `${f.cat}/${f.lens}: ${f.text.slice(0, 60)}`).join(' | ')}`
      : `${whys.length} blocks across ${new Set(whys.map((w) => w.cat)).size} categories, all definitional`);
  check('PRECONDITION for that sweep: it is not vacuous — descriptions really do exist in more than one category',
    new Set(whys.map((w) => w.cat)).size >= 2, JSON.stringify([...new Set(whys.map((w) => `${w.cat}`))]));

  /* ══════════ 2. the provenance chip in all five states ══════════ */
  section('2. the chip against REAL inheritance: built-in / machine / project / session / project-only');
  await goto(containerId);
  await seedAccounts();
  await openCat('model');
  const builtIn = await cdp.eval(EFFORT);
  check('BUILT-IN — nothing set at any level: NO chip at all, and the value dims and says so',
    builtIn.found && builtIn.level === null && builtIn.dim === true && builtIn.value === 'built-in' && builtIn.rev === false,
    JSON.stringify({ level: builtIn.level, value: builtIn.value, dim: builtIn.dim, rev: builtIn.rev }));

  /* MACHINE: a real machine-wide default, written through the product's own
     global-settings surface and read back from the server. */
  await fetch(`${base}/api/settings`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ effort: 'medium' }),
  });
  const gs = await (await fetch(`${base}/api/settings`)).json();
  check('PRECONDITION: the machine-wide default effort is really stored on the server',
    (gs.settings ?? gs)?.effort === 'medium', JSON.stringify(gs.settings ?? gs));
  await goto(containerId);
  await seedAccounts();
  await openCat('model');
  const machine = await cdp.eval(EFFORT);
  check('MACHINE — inherited from the machine default: a HOLLOW "machine" chip, the machine value shown, no reset',
    machine.level === 'machine' && machine.fill === 'false' && machine.value === 'medium' && machine.rev === false,
    JSON.stringify({ level: machine.level, fill: machine.fill, value: machine.value, rev: machine.rev }));

  /* PROJECT: set at the project, which IS the current write target → filled. */
  await patch(containerId, { effort: 'low' });
  await goto(containerId);
  await seedAccounts();
  await openCat('model');
  const projFilled = await cdp.eval(EFFORT);
  check('PROJECT under the project lens — set at the current write target: a FILLED "project" chip, and a reset appears',
    projFilled.level === 'project' && projFilled.fill === 'true' && projFilled.value === 'low' && projFilled.rev === true,
    JSON.stringify({ level: projFilled.level, fill: projFilled.fill, value: projFilled.value, rev: projFilled.rev, revLabel: projFilled.revLabel }));

  /* The SAME row, the lens flipped: the level did not change, but whose decision
     it is did — so the chip goes hollow and the reset disappears. */
  await cdp.eval(`document.querySelector('#dScope button[data-scope="session"]').click()`);
  await sleep(350);
  const projHollow = await cdp.eval(EFFORT);
  check('LENS FLIP — the same project value under the SESSION lens goes HOLLOW, and the reset goes with it',
    projHollow.level === 'project' && projHollow.fill === 'false' && projHollow.rev === false,
    JSON.stringify({ level: projHollow.level, fill: projHollow.fill, rev: projHollow.rev }));

  /* SESSION: click the row under the session lens — a local override. */
  await cdp.eval(`[...document.querySelectorAll('#dBody .view.on .set')].find((r) => r.querySelector('.l')?.textContent.startsWith('Effort')).click()`);
  await sleep(450);
  const sess = await cdp.eval(EFFORT);
  const regAfterSession = await readProj(containerId);
  check('SESSION — a session override: a FILLED "session" chip, a reset, and the REGISTRY is untouched',
    sess.level === 'session' && sess.fill === 'true' && sess.rev === true && regAfterSession.settings?.effort === 'low',
    JSON.stringify({ level: sess.level, fill: sess.fill, rev: sess.rev, value: sess.value, registry: regAfterSession.settings?.effort }));

  /* PROJECT-ONLY: container.* is refused at session scope by design. */
  await openCat('isolation', 'session');
  const projectOnly = await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('#dBody .view.on .set')].find((r) => r.querySelector('.l')?.textContent.startsWith('Base image'));
    const chip = row?.querySelector('.prov');
    return { found: !!row, level: chip?.dataset.level ?? null, fill: chip?.dataset.fill ?? null, text: chip?.textContent ?? null };
  })()`);
  check('PROJECT-ONLY — a field a session may not override says so, hollow, in its own words',
    projectOnly.level === 'project-only' && projectOnly.fill === 'false' && projectOnly.text === 'project-only',
    JSON.stringify(projectOnly));

  /* Every chip the modal can render, across all 11 categories and both lenses:
     the TEXT must always name the level (the treatment is never the sole
     carrier), and the levels actually observed must span more than one. */
  const chipSweep = await cdp.eval(`(async () => {
    const D = window.__station.drawer;
    const seen = [];
    for (const lens of ['project', 'session']) {
      for (const id of ${JSON.stringify(RAIL_IDS)}) {
        D.close(); D.close();
        await D.open('settings', { scope: lens });
        document.querySelector('.srail-item[data-cat="' + id + '"]').click();
        await new Promise((r) => setTimeout(r, 420));
        for (const c of document.querySelectorAll('#dBody .view.on .prov')) {
          seen.push({ cat: id, lens, level: c.dataset.level, fill: c.dataset.fill, text: c.textContent });
        }
      }
    }
    D.close(); D.close();
    return seen;
  })()`);
  const LEGAL = ['built-in', 'machine', 'project', 'session', 'project-only'];
  const levels = [...new Set(chipSweep.map((c) => c.level))];
  check('every chip anywhere in the modal NAMES its level in text, and the text matches the level it reports',
    chipSweep.length > 0 && chipSweep.every((c) => LEGAL.includes(c.level) && c.text === c.level),
    `${chipSweep.length} chips · levels ${JSON.stringify(levels)} · ${JSON.stringify([...new Set(chipSweep.map((c) => `${c.cat}/${c.lens}:${c.level}/${c.fill}`))].slice(0, 12))}`);
  check('PRECONDITION: that sweep is not vacuous — more than one level really occurs',
    levels.length >= 2 && chipSweep.length >= 3, `${levels.length} distinct levels over ${chipSweep.length} chips`);

  /* ══════════ 3. reset: only on a filled chip, and it really reverts ══════════ */
  section('3. reset appears only on a filled chip, and reverts to the RESOLVED parent value');
  await goto(containerId);
  await seedAccounts();
  await openCat('model');
  const beforeReset = await cdp.eval(EFFORT);
  const regBeforeReset = await readProj(containerId);
  check('PRECONDITION: the project value is set, the machine default differs, and the chip is filled',
    regBeforeReset.settings?.effort === 'low' && beforeReset.fill === 'true' && /machine value \(medium\)/.test(beforeReset.revLabel ?? ''),
    JSON.stringify({ registry: regBeforeReset.settings?.effort, fill: beforeReset.fill, label: beforeReset.revLabel }));
  await cdp.eval(`[...document.querySelectorAll('#dBody .view.on .set')].find((r) => r.querySelector('.l')?.textContent.startsWith('Effort')).querySelector('.rev').click()`);
  await sleep(900);
  const afterReset = await cdp.eval(EFFORT);
  const regAfterReset = await readProj(containerId);
  check('clicking reset CLEARS the project value on the server and the row falls back to the machine default',
    (regAfterReset.settings?.effort ?? null) === null && afterReset.level === 'machine'
      && afterReset.fill === 'false' && afterReset.value === 'medium' && afterReset.rev === false,
    JSON.stringify({ registry: `${JSON.stringify(regBeforeReset.settings?.effort)} → ${JSON.stringify(regAfterReset.settings?.effort ?? null)}`,
      row: { level: afterReset.level, fill: afterReset.fill, value: afterReset.value, rev: afterReset.rev } }));

  const noResetWhenHollow = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('#dBody .view.on .set')];
    const bad = rows.filter((r) => { const c = r.querySelector('.prov'); const rev = r.querySelector('.rev');
      return !!rev && (!c || c.dataset.fill !== 'true'); })
      .map((r) => r.querySelector('.l')?.textContent);
    return { rows: rows.length, bad };
  })()`);
  check('across the whole pane, NO row shows a reset without a filled chip',
    noResetWhenHollow.bad.length === 0, JSON.stringify(noResetWhenHollow));

  /* ══════════ 4. NO REFLOW — the gutter is reserved, measured in pixels ══════════ */
  section('4. no reflow: the 46px gutter holds the rails still whether or not a reset is rendered');
  await patch(containerId, { effort: 'low' });
  await goto(containerId);
  await seedAccounts();
  await openCat('model');
  const withRev = await cdp.eval(EFFORT);
  /* Same paint, a row that has NO reset at all: its rails must be identical. */
  const sibling = await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('#dBody .view.on .set')].find((r) => r.querySelector('.l')?.textContent.startsWith('Spend cap'));
    if (!row) return null;
    const p = row.getBoundingClientRect();
    const rect = (n) => { if (!n) return null; const b = n.getBoundingClientRect();
      return { left: Math.round(b.left - p.left), right: Math.round(b.right - p.left), w: Math.round(b.width) }; };
    return { rev: !!row.querySelector('.rev'), w: Math.round(p.width),
      l: rect(row.querySelector('.l')), v: rect(row.querySelector('.v')), gut: rect(row.querySelector('.sgut')) };
  })()`);
  check('a row WITH a reset and a row WITHOUT one share the same column rails to the pixel',
    !!sibling && sibling.rev === false && withRev.rev === true
      && sibling.gut.left === withRev.geo.gut.left && sibling.gut.w === withRev.geo.gut.w
      && sibling.gut.w === 46 && sibling.l.left === withRev.geo.l.left && sibling.v.right === withRev.geo.v.right,
    JSON.stringify({ withReset: withRev.geo, withoutReset: sibling }));

  /* And the same row, before and after the reset button disappears. */
  await cdp.eval(`[...document.querySelectorAll('#dBody .view.on .set')].find((r) => r.querySelector('.l')?.textContent.startsWith('Effort')).querySelector('.rev').click()`);
  await sleep(900);
  const afterGeo = await cdp.eval(EFFORT);
  check('the SAME row keeps byte-identical geometry once its reset button is gone',
    afterGeo.rev === false && afterGeo.geo.h === withRev.geo.h && afterGeo.geo.w === withRev.geo.w
      && afterGeo.geo.gut.left === withRev.geo.gut.left && afterGeo.geo.gut.w === withRev.geo.gut.w
      && afterGeo.geo.l.left === withRev.geo.l.left && afterGeo.geo.v.right === withRev.geo.v.right,
    JSON.stringify({ before: withRev.geo, after: afterGeo.geo }));

  /* ══════════ 5. the `ⓘ` keyboard path, with REAL key events ══════════ */
  section('5. the ⓘ disclosure end to end on the keyboard — Tab, Enter, Esc');
  await goto(containerId);
  await seedAccounts();
  await openCat('model');
  const order = await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('#dBody .view.on .set')].find((r) => r.querySelector('.l')?.textContent.startsWith('Model'));
    const sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const all = [...document.querySelectorAll('#smodal ' + sel)];
    const main = row.querySelector('.set-main');
    const why = row.querySelector('.why');
    return { hasMain: !!main, hasWhy: !!why, afterControl: all.indexOf(why) === all.indexOf(main) + 1,
      mainLabel: main?.getAttribute('aria-label') ?? null, whyTag: why?.tagName, whyType: why?.getAttribute('type') };
  })()`);
  check('the ⓘ is a real <button type="button">, and it is next in tab order after the row\'s own control',
    order.hasMain && order.hasWhy && order.afterControl === true && order.whyTag === 'BUTTON' && order.whyType === 'button',
    JSON.stringify(order));
  check('the cycle row announces itself plainly (the mono flag text no longer pollutes the computed name)',
    /^Model: .+\. Activate to change\.$/.test(order.mainLabel ?? ''), String(order.mainLabel));

  await cdp.eval(`[...document.querySelectorAll('#dBody .view.on .set')].find((r) => r.querySelector('.l')?.textContent.startsWith('Model')).querySelector('.set-main').focus()`);
  await cdp.tab();
  const afterTab = await cdp.eval(`(() => ({ id: document.activeElement?.id ?? null, cls: document.activeElement?.className ?? null }))()`);
  check('a REAL Tab from the row control lands on that row\'s ⓘ',
    afterTab.cls === 'why' && afterTab.id === 'whyb-model', JSON.stringify(afterTab));

  await cdp.enter();
  await sleep(300);
  const opened = await cdp.eval(`(() => {
    const b = document.querySelector('#whyb-model');
    const blk = document.querySelector('#why-model');
    const main = b?.closest('.set')?.querySelector('.set-main');
    return { expanded: b?.getAttribute('aria-expanded'), controls: b?.getAttribute('aria-controls'),
      blockVisible: blk ? blk.checkVisibility({ checkVisibilityCSS: true }) : false,
      describedBy: main?.getAttribute('aria-describedby') ?? null,
      text: blk?.textContent.slice(0, 48) ?? null,
      focus: document.activeElement?.id ?? null,
      modalOpen: window.__station.drawer.isOpen() };
  })()`);
  check('a REAL Enter expands the block in flow, and aria-expanded / aria-controls / aria-describedby are all wired',
    opened.expanded === 'true' && opened.controls === 'why-model' && opened.blockVisible === true
      && opened.describedBy === 'why-model' && opened.focus === 'whyb-model',
    JSON.stringify(opened));

  /* Expanding must PUSH the rows below it down — an in-flow block, not an overlay. */
  const pushed = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('#dBody .view.on .set')];
    const model = rows.find((r) => r.querySelector('.l')?.textContent.startsWith('Model'));
    const effort = rows.find((r) => r.querySelector('.l')?.textContent.startsWith('Effort'));
    const blk = document.querySelector('#why-model');
    return { gap: Math.round(effort.getBoundingClientRect().top - model.getBoundingClientRect().bottom),
      blockBottom: Math.round(blk.getBoundingClientRect().bottom),
      effortTop: Math.round(effort.getBoundingClientRect().top),
      overlaps: blk.getBoundingClientRect().bottom > effort.getBoundingClientRect().top + 1 };
  })()`);
  check('the expanded block is IN FLOW — it pushes the next row down instead of covering it',
    pushed.overlaps === false && pushed.blockBottom <= pushed.effortTop + 1, JSON.stringify(pushed));

  /* A picture of the state a human has to judge: a filled chip, its reset, and
     an expanded description, all in one paint. */
  await shot('feat146c-expanded.png');

  await cdp.esc();
  await sleep(300);
  const collapsed = await cdp.eval(`(() => {
    const b = document.querySelector('#whyb-model');
    const blk = document.querySelector('#why-model');
    const main = b?.closest('.set')?.querySelector('.set-main');
    return { expanded: b?.getAttribute('aria-expanded'),
      blockVisible: blk ? blk.checkVisibility({ checkVisibilityCSS: true }) : false,
      describedBy: main?.getAttribute('aria-describedby') ?? null,
      focus: document.activeElement?.id ?? null,
      modalOpen: window.__station.drawer.isOpen(), modalHidden: document.querySelector('#smodal').hidden };
  })()`);
  check('Esc collapses the description, returns focus to its ⓘ, drops aria-describedby — and does NOT close the modal',
    collapsed.expanded === 'false' && collapsed.blockVisible === false && collapsed.describedBy === null
      && collapsed.focus === 'whyb-model' && collapsed.modalOpen === true && collapsed.modalHidden === false,
    JSON.stringify(collapsed));

  await cdp.esc();
  await sleep(300);
  const secondEsc = await cdp.eval(`({ open: window.__station.drawer.isOpen() })`);
  check('the NEXT Esc closes the modal — the ladder is extended, not hijacked', secondEsc.open === false, JSON.stringify(secondEsc));

  /* ══════════ 6. Show all descriptions ══════════ */
  section('6. "Show all descriptions" expands every block in every category, and survives a reload');
  await goto(containerId);
  await seedAccounts();
  await cdp.eval(`window.__station.drawer.open('settings')`);
  await sleep(500);
  const togBefore = await cdp.eval(`(() => ({ pressed: document.querySelector('#dWhyAll')?.getAttribute('aria-pressed'),
    openBlocks: [...document.querySelectorAll('#dBody .set-why.disclosure')].filter((b) => !b.hidden).length })) ()`);
  await cdp.eval(`document.querySelector('#dWhyAll').click()`);
  await sleep(400);
  const spread = await cdp.eval(`(async () => {
    const D = window.__station.drawer;
    const out = {};
    for (const id of ['model', 'isolation', 'defaults']) {
      document.querySelector('.srail-item[data-cat="' + id + '"]').click();
      await new Promise((r) => setTimeout(r, 700));
      const blocks = [...document.querySelectorAll('#dBody .view.on .set-why.disclosure')];
      out[id] = { total: blocks.length, open: blocks.filter((b) => !b.hidden).length };
    }
    out.stored = localStorage.getItem('orchard.settings.descriptions');
    out.pressed = document.querySelector('#dWhyAll').getAttribute('aria-pressed');
    void D;
    return out;
  })()`);
  check('one click expands EVERY description in every category that has one (model + isolation + defaults)',
    togBefore.openBlocks === 0 && spread.pressed === 'true' && spread.stored === 'all'
      && ['model', 'isolation', 'defaults'].every((k) => spread[k].total > 0 && spread[k].open === spread[k].total),
    JSON.stringify({ before: togBefore, after: spread }));

  await goto(containerId);
  await seedAccounts();
  await cdp.eval(`window.__station.drawer.open('settings')`);
  await sleep(700);
  const afterReload = await cdp.eval(`(() => {
    const blocks = [...document.querySelectorAll('#dBody .view.on .set-why.disclosure')];
    return { stored: localStorage.getItem('orchard.settings.descriptions'),
      pressed: document.querySelector('#dWhyAll').getAttribute('aria-pressed'),
      total: blocks.length, open: blocks.filter((b) => !b.hidden).length };
  })()`);
  check('the choice survives a full page reload (localStorage["orchard.settings.descriptions"])',
    afterReload.stored === 'all' && afterReload.pressed === 'true' && afterReload.total > 0 && afterReload.open === afterReload.total,
    JSON.stringify(afterReload));
  await cdp.eval(`document.querySelector('#dWhyAll').click()`);
  await sleep(300);
  const offAgain = await cdp.eval(`(() => ({ stored: localStorage.getItem('orchard.settings.descriptions'),
    open: [...document.querySelectorAll('#dBody .view.on .set-why.disclosure')].filter((b) => !b.hidden).length }))()`);
  check('turning it back off collapses them again and records the choice',
    offAgain.stored === 'auto' && offAgain.open === 0, JSON.stringify(offAgain));

  /* ══════════ 7. chip contrast, both treatments, both themes ══════════ */
  section('7. the chip clears WCAG AA in both treatments in BOTH themes');
  const CONTRAST = `(() => {
    const lum = (c) => { const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const parse = (s) => (s.match(/[\\d.]+/g) ?? []).slice(0, 3).map(Number);
    const solidBg = (n) => { for (let e = n; e; e = e.parentElement) {
      const bg = getComputedStyle(e).backgroundColor;
      const p = parse(bg); if (p.length === 3 && !/rgba\\(.*,\\s*0\\)/.test(bg)) return p; } return [255, 255, 255]; };
    const ratio = (fg, bg) => { const a = lum(fg) + 0.05, b = lum(bg) + 0.05; return Math.round((Math.max(a, b) / Math.min(a, b)) * 100) / 100; };
    const out = {};
    for (const chip of document.querySelectorAll('#dBody .view.on .prov')) {
      const fill = chip.dataset.fill === 'true' ? 'filled' : 'hollow';
      const cs = getComputedStyle(chip);
      const bg = solidBg(chip);
      out[fill] = { text: chip.textContent, fg: cs.color, ownBg: cs.backgroundColor,
        resolvedBg: 'rgb(' + bg.join(', ') + ')', ratio: ratio(parse(cs.color), bg) };
    }
    return out;
  })()`;
  await patch(containerId, { effort: 'low' });
  for (const tone of ['light', 'dark']) {
    await cdp.theme(tone);
    await goto(containerId);
    await seedAccounts();
    await openCat('model', 'project');
    const filled = await cdp.eval(CONTRAST);
    await cdp.eval(`document.querySelector('#dScope button[data-scope="session"]').click()`);
    await sleep(350);
    const hollow = await cdp.eval(CONTRAST);
    const f = filled.filled, h = hollow.hollow;
    check(`${tone}: the FILLED chip clears AA (4.5:1) — luminance, not hue`,
      !!f && f.ratio >= 4.5, JSON.stringify(f));
    check(`${tone}: the HOLLOW chip clears AA (4.5:1)`,
      !!h && h.ratio >= 4.5, JSON.stringify(h));
    await shot(`feat146c-rows-${tone}.png`);
  }
  await cdp.theme('dark');

  /* ══════════ 8. widths, themes, console ══════════ */
  section('8. every category at three widths in both themes, zero console errors');
  await goto(containerId);
  await seedAccounts();
  consoleErrors = [];
  for (const [w, h, label] of [[940, 780, '940'], [800, 780, '800'], [500, 820, '500']]) {
    await cdp.viewport(w, h);
    await sleep(250);
    for (const tone of ['light', 'dark']) {
      await cdp.theme(tone);
      const geo = await cdp.eval(`(async () => {
        const D = window.__station.drawer;
        const bad = [];
        for (const id of ${JSON.stringify(RAIL_IDS)}) {
          D.close(); D.close();
          await D.open('settings');
          document.querySelector('.srail-item[data-cat="' + id + '"]').click();
          await new Promise((r) => setTimeout(r, 260));
          const pane = document.querySelector('#dBody');
          const box = document.querySelector('.smodal-box').getBoundingClientRect();
          if (pane.scrollWidth > pane.clientWidth + 1) bad.push(id + ':clipped');
          if (box.right > innerWidth + 1 || box.bottom > innerHeight + 1) bad.push(id + ':overflow');
          if (!document.querySelector('#dBody .view.on').children.length) bad.push(id + ':empty');
          for (const r of document.querySelectorAll('#dBody .view.on .set')) {
            const g = r.querySelector('.sgut');
            if (g && Math.round(g.getBoundingClientRect().width) !== 46) bad.push(id + ':gutter=' + Math.round(g.getBoundingClientRect().width));
          }
        }
        D.close(); D.close();
        return bad;
      })()`);
      check(`${label}px / ${tone}: all 11 categories render unclipped, and every gutter is still exactly 46px`,
        geo.length === 0, geo.length ? geo.slice(0, 6).join(' | ') : 'all 11 clean, gutters 46px');
    }
  }
  await cdp.viewport(1400, 1000);
  await cdp.theme('dark');
  check('zero console errors across every category, width and theme',
    consoleErrors.length === 0, consoleErrors.length ? consoleErrors.slice(0, 6).join(' | ') : 'none');

  /* ══════════ 9. MUST-FAIL ══════════ */
  section('9. must-FAIL: one load-bearing sentence moved behind an ⓘ must be CAUGHT');
  const realSrc = fs.readFileSync(path.join(ROOT, 'public', 'lib', 'drawer.js'), 'utf8');
  const whyAnchor = `  const WHY = {\n    model: 'Which Claude model a new session in this project starts with. '`;
  const noteAnchor = `    if (val('permissionMode') !== 'bypassPermissions') return null;`;
  check('PRECONDITION: both mutation sites are where the must-FAIL expects them',
    realSrc.includes(whyAnchor) && realSrc.includes(noteAnchor),
    `WHY map: ${realSrc.includes(whyAnchor)} · permModeNote: ${realSrc.includes(noteAnchor)}`);
  /* The regression this guards against, built exactly: the bypassPermissions
     sentence is taken OUT of flow and put behind the row's own ⓘ. */
  const brokenSrc = realSrc
    .replace(whyAnchor, `  const WHY = {\n    permissionMode: 'Approvals are skipped: the model runs commands on this machine without asking. '\n      + 'On a direct project that is a deliberate, risky choice.',\n    model: 'Which Claude model a new session in this project starts with. '`)
    .replace(noteAnchor, `    return null; // must-FAIL variant: the sentence now lives behind the ⓘ`);
  check('PRECONDITION: the synthesized variant really differs from the shipped one',
    brokenSrc !== realSrc && brokenSrc.includes('permissionMode: \'Approvals are skipped'),
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
  const mutated = await cdp.eval(`(async () => (await (await fetch('/lib/drawer.js')).text()).includes("permissionMode: 'Approvals are skipped"))()`);
  check('the page is really running the synthesized variant', mutated === true, String(mutated));
  await seedAccounts();
  await openCat('permissions');
  const brokenFind = await cdp.eval(FIND('Approvals are skipped: the model runs commands on this machine without asking'));
  check('MUST-FAIL (1): the hazard sweep sees the sentence is NO LONGER visible on first paint',
    brokenFind.found === false || brokenFind.visible === false || brokenFind.inWhy === true,
    JSON.stringify(brokenFind));
  const brokenWhys = await cdp.eval(WHY_SWEEP);
  const brokenForeign = brokenWhys.filter((w) => !ALLOWED_WHY_OPENERS.some((o) => w.text.startsWith(o)));
  check('MUST-FAIL (2): the "every .set-why is definitional" invariant goes red and NAMES the smuggled prose',
    brokenForeign.length > 0 && brokenForeign.some((f) => /Approvals are skipped/.test(f.text)),
    brokenForeign.length ? brokenForeign.map((f) => `${f.cat}: ${f.text.slice(0, 54)}`).join(' | ') : 'NOTHING — the sweep is vacuous');
  await cdp.send('Fetch.disable');

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} passed, ${fail} failed`);
  if (fail) console.log(failures.map((f) => `  · ${f}`).join('\n'));
  console.log('\nscreenshots:');
  for (const s of shots) console.log(`  ${s}`);
}

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
