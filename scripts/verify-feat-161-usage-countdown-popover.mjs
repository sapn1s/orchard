#!/usr/bin/env node
/**
 * FEAT-161 — the maxed-out provider-usage window shows a LIVE reset countdown on
 * the crown face, and the hover affordance is a STYLED limits popover (filled
 * bars per window) instead of the native `title` tooltip.
 *
 *   node scripts/verify-feat-161-usage-countdown-popover.mjs
 *
 * Driven in a REAL headless browser over the REAL app.js, against an ISOLATED
 * scratch server (own CLAUDE_STATION_DATA, free port) — never the live service,
 * never the real registry. The usage SNAPSHOTS are synthetic (same ProviderUsage
 * shape the server emits; only the values are crafted so the maxed/not-maxed/
 * unknown-reset states are all exercised in one run — the live endpoint cannot be
 * forced into a 100% state on demand). Everything else — the render, the ticker,
 * the popover DOM, the theme — is the real client.
 *
 * MUST-FAIL on the pre-change tree: `#usageCountdown`, `#usagePop`,
 * `paintUsagePop`, `fmtCountdown` and `usageMaxed` do not exist there, so the
 * countdown assertions and the popover assertions below cannot pass.
 *
 * Graded:
 *   A. FORMATS (pure) — fmtCountdown "1h 23m" / "4m 10s" / "42s" / null-on-expiry;
 *      fmtResetIn two-unit precision ("in 2h 34m", "in 3d 4h"); usageMaxed gate.
 *   B. COUNTDOWN GATING (real paint) — maxed + known reset → countdown + `maxed`
 *      capsule; not maxed → hidden; maxed + UNKNOWN reset → hidden.
 *   C. ZERO-CROSSING (real ticker) — a reset 1s out shows, then hides, nothing stale.
 *   D. POPOVER (r2 design, real DOM) — one group per provider, the face's snapshot
 *      first; plain window names; bar width == used %; calm/warn/full tiers (not
 *      everything red); the binding row emphasised; "Limit reached" only on a maxed
 *      provider; "Resets in … · …" lines that TICK while open; honest unknowns; one
 *      "Updated" footer instead of a per-provider as-of; no native title.
 *   E. INTERACTION (real pointer + keys via CDP Input) — hover dwell opens; the
 *      pointer crossing the gap into the popover keeps it open; leaving closes;
 *      a click inside does not close; click pins; Escape closes; keyboard focus opens.
 *   F. LAYOUT — popover fully on-screen at a 420px viewport; screenshots of every
 *      scenario in BOTH themes (docs/bugs/assets/FEAT-161-r2-*.png).
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { isolatedServerEnv } from './lib/station-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';
const OUTDIR = process.env.FEAT161_SHOTS ?? path.join(ROOT, 'docs', 'bugs', 'assets');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : (fail++, failures.push(name));
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c = new Cdp(ws);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (!m.id && m.method && c.onEvent) c.onEvent(m.method, m.params);
      if (m.id && c.waiting.has(m.id)) {
        const { res, rej } = c.waiting.get(m.id);
        c.waiting.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.waiting.set(id, { res, rej }));
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(() => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async expr(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async waitFor(label, e, timeoutMs = 30_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.expr(e)) return true; } catch { /* nav */ }
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  async shot(file, clip) {
    const r = await this.send('Page.captureScreenshot', clip ? { format: 'png', clip: { ...clip, scale: 1 } } : { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

const PORT = Number(process.env.VERIFY_FEAT161_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f161-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f161-brave-'));
const cleanupDirs = [DATA, PROFILE];
let server = null, browser = null;

function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

/*
 * Synthetic snapshots — the real ProviderUsage shape (provider-usage.ts); only the
 * values are crafted (the live endpoint cannot be forced to 100% on demand). Each
 * is a page-side expression so `now` is the browser's clock.
 */
const SNAP = {
  claudeOnly: `(() => { const now = Math.floor(Date.now()/1000); return [
    { provider:'anthropic', accountId:'default', accountLabel:null, available:true, asOf:Date.now(), plan:'max', note:null,
      windows:[ { label:'5h', usedPercent:62, resetsAt: now + 9240, binding:true },
                { label:'weekly', usedPercent:31, resetsAt: now + 3*86400 + 4*3600 } ] } ]; })()`,
  oneMaxed: `(() => { const now = Math.floor(Date.now()/1000); return [
    { provider:'anthropic', accountId:'default', accountLabel:null, available:true, asOf:Date.now(), plan:'max', note:null,
      windows:[ { label:'5h', usedPercent:100, resetsAt: now + 9245, binding:true },
                { label:'weekly', usedPercent:41, resetsAt: now + 3*86400 + 4*3600 + 300 },
                { label:'weekly · Fable', usedPercent:78, resetsAt: now + 3*86400 + 4*3600 + 300 } ] },
    { provider:'openai', accountId:null, accountLabel:null, available:true, asOf:Date.now(), plan:'plus', note:null,
      windows:[ { label:'5h', usedPercent:23, resetsAt: now + 3600*3 + 600, binding:true },
                { label:'weekly', usedPercent:9, resetsAt: now + 6*86400 } ] } ]; })()`,
  allMaxed: `(() => { const now = Math.floor(Date.now()/1000); return [
    { provider:'anthropic', accountId:'default', accountLabel:null, available:true, asOf:Date.now(), plan:'max', note:null,
      windows:[ { label:'5h', usedPercent:100, resetsAt: now + 1990, binding:true },
                { label:'weekly', usedPercent:88, resetsAt: now + 86400 + 3600 } ] },
    { provider:'openai', accountId:null, accountLabel:null, available:true, asOf:Date.now(), plan:'plus', note:null,
      windows:[ { label:'5h', usedPercent:64, resetsAt: now + 7200 },
                { label:'weekly', usedPercent:100, resetsAt: now + 2*86400 + 5*3600, binding:true } ] } ]; })()`,
  unknownReset: `(() => { const now = Math.floor(Date.now()/1000); return [
    { provider:'anthropic', accountId:'default', accountLabel:null, available:true, asOf:Date.now(), plan:'max', note:null,
      windows:[ { label:'5h', usedPercent:100, resetsAt: null, binding:true },
                { label:'weekly', usedPercent:40, resetsAt: now + 3*86400 } ] },
    { provider:'openai', accountId:null, accountLabel:null, available:true, asOf:Date.now(), plan:'plus', note:null,
      windows:[ { label:'5h', usedPercent:72, resetsAt: null, binding:true } ] },
    { provider:'anthropic', accountId:'work', accountLabel:'work', available:false, asOf:Date.now(), plan:null,
      note:'Claude sign-in expired — re-authenticate', windows:[] } ]; })()`,
};

async function main() {
  fs.mkdirSync(OUTDIR, { recursive: true });
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: isolatedServerEnv({ PORT: String(PORT), CLAUDE_STATION_DATA: DATA }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f161-proj-'));
  cleanupDirs.push(dir);
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: dir, name: 'usage-fixture', applyMethod: false }),
  })).json();
  if (!reg.project?.id) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  const proj = reg.project.id;

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--force-color-profile=srgb', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 80 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  if (!devPort) throw new Error('brave never exposed a devtools port');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const viewport = (width, height = 720) => cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
  await viewport(1280);
  await cdp.send('Page.navigate', { url: `${BASE}/#/project/${proj}` });
  await cdp.waitFor('app boot', `!!window.__station?.paintUsageChip`);
  await cdp.waitFor('project selected', `window.__station.currentProject()?.id === ${JSON.stringify(proj)}`);
  // Stop the real poll from overwriting the fixture mid-run: the scratch server
  // can read the machine's real provider usage, so /api/usage is answered with
  // `providers: null` ("route absent" → the client keeps the fixture it has).
  cdp.onEvent = (method, params) => {
    if (method !== 'Fetch.requestPaused') return;
    void cdp.send('Fetch.fulfillRequest', {
      requestId: params.requestId, responseCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'application/json' }],
      body: Buffer.from(JSON.stringify({ providers: null })).toString('base64'),
    }).catch(() => {});
  };
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/usage*' }] });

  const load = (k) => cdp.eval(`window.__station.state.usage = ${SNAP[k]}; window.__station.closePops(); window.__station.paintUsageChip();`);
  const isOpen = () => cdp.expr(`document.querySelector('#usagePop').classList.contains('open')`);
  const rect = (sel) => cdp.eval(`const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom };`);
  const mouse = (x, y) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  const click = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const key = async (k, code, vk) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
  };

  // ============================ A. formats (pure) ============================
  console.log('\n=== A. countdown / reset formats ===');
  const fmt = await cdp.eval(`
    const f = window.__station.fmtCountdown, r = window.__station.fmtResetIn;
    const now = Date.now()/1000;
    return {
      d: f(Math.round(now) + 2*86400 + 5*3600 + 30), h: f(Math.round(now) + 5025), m: f(Math.round(now) + 250), s: f(Math.round(now) + 42),
      past: f(Math.round(now) - 10), nul: f(null),
      rH: r(now + 9240.4), rD: r(now + 3*86400 + 4*3600 + 200), r1d: r(now + 86400 + 3540), rM: r(now + 23*60 + 5), rPast: r(now - 5),
    };`);
  check('>= 1d formats as "Dd Hh" (2d 5h, never "53h 0m")', fmt.d === '2d 5h', fmt.d);
  check('>= 1h formats as "Hh Mm" (1h 23m)', fmt.h === '1h 23m', fmt.h);
  check('< 1h formats as "Mm Ss" (4m 10s)', fmt.m === '4m 10s', fmt.m);
  check('< 1m formats as "Ss" (42s)', fmt.s === '42s', fmt.s);
  check('expired / null reset returns null (never "0s"/negative)', fmt.past === null && fmt.nul === null, [fmt.past, fmt.nul]);
  check('relative reset keeps two units ("in 2h 34m", "in 3d 4h", "in 1d", "in 23m", past → "now")',
    fmt.rH === 'in 2h 34m' && fmt.rD === 'in 3d 4h' && fmt.r1d === 'in 1d' && fmt.rM === 'in 23m' && fmt.rPast === 'now', fmt);
  const maxed = await cdp.eval(`
    const m = window.__station.usageMaxed;
    return { at100: m({usedPercent:100}), over: m({usedPercent:103}), at99: m({usedPercent:99}), none: m(null) };`);
  check('usageMaxed true at 100 and above, false below, false on null', maxed.at100 && maxed.over && !maxed.at99 && !maxed.none, maxed);

  // ============================ B. countdown gating ============================
  console.log('\n=== B. maxed → countdown capsule; not-maxed / unknown-reset → hidden ===');
  await load('oneMaxed');
  const shown = await cdp.eval(`
    const b = document.querySelector('#usageBtn'), cd = document.querySelector('#usageCountdown');
    return { visible: !cd.hidden, text: cd.textContent, maxed: b.classList.contains('maxed'), danger: b.classList.contains('danger'), aria: b.getAttribute('aria-label') };`);
  check('maxed binding window → countdown visible inside the maxed capsule', shown.visible && shown.maxed && shown.danger, shown);
  check('countdown text is a live clock ("…h …m" / "…m …s")', /^(\d+h \d+m|\d+m \d+s|\d+s)$/.test(shown.text), shown.text);
  check('aria-label says the limit is reached and when it resets', /limit reached, resets in .+ · .+/.test(shown.aria), shown.aria);
  await load('claudeOnly');
  const notMaxed = await cdp.eval(`const b = document.querySelector('#usageBtn'); return { hidden: document.querySelector('#usageCountdown').hidden, maxed: b.classList.contains('maxed'), danger: b.classList.contains('danger') };`);
  check('not-maxed (62%) → countdown hidden, no capsule, not red', notMaxed.hidden && !notMaxed.maxed && !notMaxed.danger, notMaxed);
  await load('unknownReset');
  const unknownReset = await cdp.eval(`const cd = document.querySelector('#usageCountdown'); return { hidden: cd.hidden, text: cd.textContent };`);
  check('maxed but UNKNOWN reset → countdown hidden (no wrong number)', unknownReset.hidden === true && unknownReset.text === '', unknownReset);

  // ============================ C. zero-crossing (real ticker) ============================
  console.log('\n=== C. countdown crossing zero hides + does not go stale ===');
  await cdp.eval(`
    window.__station.state.usage = [{ provider:'anthropic', accountId:'default', available:true, asOf:Date.now(), plan:'max', note:null,
      windows:[{ label:'5h', usedPercent:100, resetsAt: Math.floor(Date.now()/1000)+2, binding:true }] }];
    window.__station.paintUsageChip();`);
  const beforeZero = await cdp.eval(`return { hidden: document.querySelector('#usageCountdown').hidden, text: document.querySelector('#usageCountdown').textContent };`);
  check('reset ~2s out → countdown visible just before zero', beforeZero.hidden === false && /^\d+s$/.test(beforeZero.text), beforeZero);
  await sleep(2600);
  await cdp.eval(`window.__station.tickUsageCountdown();`);
  const afterZero = await cdp.eval(`return { hidden: document.querySelector('#usageCountdown').hidden, text: document.querySelector('#usageCountdown').textContent };`);
  check('after the reset passes → countdown hidden + text cleared', afterZero.hidden === true && afterZero.text === '', afterZero);

  // ============================ D. popover ============================
  console.log('\n=== D. popover: grouping, tiers, binding emphasis, live text ===');
  const readPop = () => cdp.eval(`
    const body = document.querySelector('#usagePopBody');
    return {
      groups: [...body.querySelectorAll('.usnap')].map(g => ({
        name: g.querySelector('.usnap-name')?.textContent,
        plan: g.querySelector('.usnap-plan')?.textContent ?? null,
        status: g.querySelector('.usnap-status')?.textContent ?? null,
        note: g.querySelector('.usnap-note')?.textContent ?? null,
        wins: [...g.querySelectorAll('.uwin')].map(w => ({
          label: w.querySelector('.uwin-label')?.textContent,
          pct: w.querySelector('.uwin-pct')?.textContent,
          fill: w.querySelector('.ubar-fill')?.style.width,
          tier: ['ok','warn','full'].find(t => w.classList.contains(t)),
          binding: w.classList.contains('binding'),
          barH: w.querySelector('.ubar').getBoundingClientRect().height,
          fillColor: getComputedStyle(w.querySelector('.ubar-fill')).backgroundColor,
          reset: w.querySelector('.uwin-reset')?.textContent,
        })),
      })),
      foot: body.querySelector('.usage-foot')?.textContent ?? null,
      asofCount: body.querySelectorAll('.usnap-asof').length,
      tags: body.querySelectorAll('.uwin-binding').length,
    };`);
  await load('oneMaxed');
  await cdp.eval(`window.__station.openUsagePop();`);
  check('popover opens', await isOpen(), true);
  check('native title attribute removed from the usage chip', (await cdp.eval(`return document.querySelector('#usageBtn').hasAttribute('title');`)) === false, 'no title');
  let pop = await readPop();
  const [cl, oa] = pop.groups;
  check('one group per provider, face snapshot (Claude) first, plan in sentence case', pop.groups.length === 2 && cl.name === 'Claude' && oa.name === 'OpenAI' && cl.plan === 'Max' && oa.plan === 'Plus', pop.groups.map((g) => [g.name, g.plan]));
  check('plain window names (5-hour session / Weekly / Weekly + "Fable only")',
    cl.wins.map((w) => w.label).join('|') === '5-hour session|Weekly|WeeklyFable only', cl.wins.map((w) => w.label));
  check('bar fill width == used % on every window', pop.groups.every((g) => g.wins.every((w) => w.fill === w.pct)), pop.groups.flatMap((g) => g.wins.map((w) => [w.pct, w.fill])));
  check('tiers: 100 → full, 78 → warn, 41/23/9 → ok (not everything red)',
    cl.wins[0].tier === 'full' && cl.wins[2].tier === 'warn' && cl.wins[1].tier === 'ok' && oa.wins.every((w) => w.tier === 'ok'), pop.groups.flatMap((g) => g.wins.map((w) => `${w.pct}:${w.tier}`)));
  check('calm / warn / full bars are three DIFFERENT colours', new Set([cl.wins[0].fillColor, cl.wins[1].fillColor, cl.wins[2].fillColor]).size === 3, [cl.wins[0].fillColor, cl.wins[1].fillColor, cl.wins[2].fillColor]);
  check('exactly one binding row per provider, drawn with a heavier bar', pop.groups.every((g) => g.wins.filter((w) => w.binding).length === 1)
    && cl.wins[0].binding && cl.wins[0].barH > cl.wins[1].barH, pop.groups.map((g) => g.wins.map((w) => `${w.binding}:${w.barH}`)));
  check('no jargon tags, no per-provider "as of" (one Updated footer)', pop.tags === 0 && pop.asofCount === 0 && /^Updated /.test(pop.foot ?? ''), { tags: pop.tags, asof: pop.asofCount, foot: pop.foot });
  check('maxed provider header says "Limit reached"; the healthy provider says nothing', cl.status === 'Limit reached' && oa.status === null, [cl.status, oa.status]);
  check('reset lines read "Resets in 2h 34m · <time>"', /^Resets in 2h 34m · \S/.test(cl.wins[0].reset) && /^Resets in 3d 4h · /.test(cl.wins[1].reset), cl.wins.map((w) => w.reset));
  // Under an hour the relative reset is minute-precise; move one across a minute
  // boundary and prove the open popover's text follows without a repaint.
  await cdp.eval(`window.__station.state.usage[0].windows[0].resetsAt = Math.floor(Date.now()/1000) + 601; window.__station.paintUsagePop();`);
  const r1 = (await readPop()).groups[0].wins[0].reset;
  await sleep(1600);
  await cdp.eval(`window.__station.tickUsagePop();`);
  const r2 = (await readPop()).groups[0].wins[0].reset;
  check('reset line ticks live while the popover is open (10m to 9m)', /^Resets in 10m/.test(r1) && /^Resets in 9m/.test(r2), [r1, r2]);

  await load('unknownReset');
  await cdp.eval(`window.__station.openUsagePop();`);
  pop = await readPop();
  check('maxed with unknown reset → "Limit reached" and no invented time', pop.groups[0].status === 'Limit reached', pop.groups[0].status);
  check('unknown reset lines read "Reset time unknown"', pop.groups.flatMap((g) => g.wins).filter((w) => w.reset === 'Reset time unknown').length === 2, pop.groups.flatMap((g) => g.wins.map((w) => w.reset)));
  const work = pop.groups.find((g) => g.name === 'Claude (work)');
  check('unavailable account: its own group with the plain-words note, no bars', !!work && /re-authenticate/.test(work.note) && work.wins.length === 0, work);

  await cdp.eval(`window.__station.providerView && (window.__station.state.overrides = { ...(window.__station.state.overrides ?? {}), provider: 'openai' });`);
  await load('allMaxed');
  await cdp.eval(`window.__station.openUsagePop();`);
  pop = await readPop();
  const face = await cdp.eval(`return { cd: document.querySelector('#usageCountdown').textContent, aria: document.querySelector('#usageBtn').getAttribute('aria-label') };`);
  check('all maxed + OpenAI selected → OpenAI listed first, both headers say "Limit reached"; face tracks the OpenAI weekly reset',
    pop.groups[0].name === 'OpenAI' && pop.groups.every((g) => g.status === 'Limit reached') && face.cd === '2d 4h' && /weekly limit reached, resets in 2d 4h · /.test(face.aria), { order: pop.groups.map((g) => [g.name, g.status]), face });
  await cdp.eval(`delete window.__station.state.overrides.provider;`);

  // ============================ E. interaction ============================
  console.log('\n=== E. hover intent, gap crossing, click, Escape, keyboard ===');
  await load('oneMaxed');
  await mouse(5, 400);
  const chip = await rect('#usageBtn');
  const cx = chip.x + chip.w / 2, cy = chip.y + chip.h / 2;
  await mouse(cx, cy);
  check('hover does not flash the popover open instantly (dwell)', (await isOpen()) === false, 'closed at t=0');
  await sleep(250);
  check('hover dwell opens the popover', await isOpen(), 'open');
  const pr = await rect('#usagePop');
  // Walk the pointer from the chip down across the gap into the popover.
  for (let y = chip.bottom - 1; y <= pr.y + 20; y += 2) { await mouse(cx, y); await sleep(8); }
  await sleep(400);
  check('pointer crossing the gap into the popover keeps it open', await isOpen(), 'open');
  await click(pr.x + pr.w / 2, pr.y + 40);
  await sleep(50);
  check('a click inside the popover does not close it', await isOpen(), 'open');
  await mouse(pr.x - 200 < 0 ? 5 : pr.x - 200, 650);
  await sleep(450);
  check('leaving chip + popover closes it', (await isOpen()) === false, 'closed');
  await click(cx, cy);
  await sleep(50);
  await mouse(5, 650);
  await sleep(450);
  check('a click pins it: stays open after the pointer leaves', await isOpen(), 'open');
  await key('Escape', 'Escape', 27);
  await sleep(50);
  check('Escape closes it (aria-expanded=false)', (await isOpen()) === false && (await cdp.expr(`document.querySelector('#usageBtn').getAttribute('aria-expanded')`)) === 'false', 'closed');
  await cdp.eval(`document.activeElement?.blur();`);
  await key('Shift', 'ShiftLeft', 16); // keyboard modality → focus-visible
  await cdp.eval(`document.querySelector('#usageBtn').focus();`);
  await sleep(50);
  check('keyboard focus opens it (aria-expanded=true)', (await isOpen()) && (await cdp.expr(`document.querySelector('#usageBtn').getAttribute('aria-expanded')`)) === 'true', 'open');
  await key('Escape', 'Escape', 27);
  await sleep(50);
  check('Escape closes the keyboard-opened popover', (await isOpen()) === false, 'closed');
  await cdp.eval(`document.activeElement?.blur();`);

  // ============================ F. layout + screenshots ============================
  console.log('\n=== F. narrow viewport + screenshots, both themes ===');
  const shots = [];
  const shoot = async (name) => {
    const c = await rect('#usageBtn');
    const open = await isOpen();
    const p = open ? await rect('#usagePop') : c;
    const x = Math.max(0, Math.min(c.x, p.x) - 60), y = Math.max(0, c.y - 40);
    const w = Math.min(await cdp.expr('innerWidth') - x, Math.max(c.right, p.right) - x + 60);
    const h = Math.max(c.bottom, p.bottom) - y + 30;
    const file = path.join(OUTDIR, `FEAT-161-r2-${name}.png`);
    await cdp.shot(file, { x, y, width: w, height: h });
    shots.push(file);
  };
  for (const th of ['light', 'dark']) {
    await cdp.eval(`document.documentElement.dataset.theme = ${JSON.stringify(th)};`);
    await viewport(1280);
    for (const k of ['claudeOnly', 'oneMaxed', 'allMaxed', 'unknownReset']) {
      if (k === 'allMaxed') await cdp.eval(`window.__station.state.overrides = { ...(window.__station.state.overrides ?? {}), provider: 'openai' };`);
      await load(k);
      await sleep(150);
      if (k === 'oneMaxed') await shoot(`face-${th}`);
      await cdp.eval(`window.__station.openUsagePop();`);
      await sleep(250);
      await shoot(`${k}-${th}`);
      if (k === 'allMaxed') await cdp.eval(`delete window.__station.state.overrides.provider;`);
    }
    await viewport(420, 800);
    await load('oneMaxed');
    await cdp.eval(`window.__station.openUsagePop();`);
    await sleep(250);
    const nr = await rect('#usagePop');
    check(`[${th}] 420px viewport: popover fully on-screen`, nr.x >= 0 && nr.right <= 420 && nr.y >= 0 && nr.bottom <= 800, nr);
    const file = path.join(OUTDIR, `FEAT-161-r2-narrow-${th}.png`);
    await cdp.shot(file); shots.push(file);
  }
  await viewport(1280);
  check('screenshots written for every scenario in both themes', shots.length === 12 && shots.every((f) => fs.existsSync(f)), shots.length);

  cdp.close();
  console.log(`\nScreenshots:\n  ${shots.join('\n  ')}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('FAILURES:\n  ' + failures.join('\n  ')); process.exitCode = 1; }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => {
    stopByPid(browser); stopByPid(server);
    for (const d of cleanupDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  });
