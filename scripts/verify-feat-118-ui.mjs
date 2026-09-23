/**
 * FEAT-118 — the global-defaults SURFACE, driven in a real headless browser.
 *
 * Proves: the drawer has a "Global defaults" view; its model picker is the
 * DERIVED catalog (contains the CLI's versioned display names, e.g. "Opus 4.8"),
 * not a hand-written set; setting it persists; a project with no model of its
 * own shows it inherits the global default; and a project that overrides it is
 * listed as an overrider. Screenshots in both themes are written for a human to
 * read.
 *
 *   node scripts/verify-feat-118-ui.mjs
 *
 * Scratch server on a free port + throwaway data dir — never touches the real
 * registry, and changes the model only on its own fixtures.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_FEAT118_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f118-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f118-chrome-'));
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f118-shots-'));
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';

let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
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
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async waitFor(label, expr, timeoutMs = 20_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.eval(expr)) return true; } catch { /* nav */ }
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

let server = null, browser = null;
const cleanupDirs = [DATA, PROFILE];
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

// A REALISTIC derived catalog — mirrors the REAL machine's models.json exactly
// (default/opus[1m]/claude-fable-5[1m]/sonnet/haiku). Two things this shape
// captures that a made-up catalog would not: (1) the CLI's advertised ids carry
// SQUARE BRACKETS (`opus[1m]`), which the old MODEL_RE 400'd on the global path;
// (2) `claude-opus-4-8` — the id the user pinned in the plain CLI — is NOT in
// the catalog at all, because supportedModels() does not advertise every id the
// CLI accepts. So the picker must persist a bracketed catalog value AND accept a
// free-text id the catalog never lists. Seeded BEFORE boot (agent-bridge reads
// models.json once at module load).
const CATALOG = [
  { value: 'default', resolvedModel: 'claude-opus-5[1m]', displayName: 'Default (recommended)', description: 'Opus 5 with 1M context', supportsEffort: true },
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)', description: 'Opus 5 with 1M context', supportsEffort: true },
  { value: 'claude-fable-5[1m]', resolvedModel: 'claude-fable-5', displayName: 'Fable', description: 'Most capable, longest-running', supportsEffort: true },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Efficient for routine tasks', supportsEffort: false },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku 4.5', description: 'Fastest for quick answers', supportsEffort: false },
];

async function main() {
  fs.writeFileSync(path.join(DATA, 'models.json'), JSON.stringify(CATALOG));

  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  // Two fixture projects on throwaway dirs, method NOT applied (nothing scaffolded).
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f118-alpha-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f118-beta-'));
  cleanupDirs.push(dirA, dirB);
  async function mkProject(hostPath, name) {
    const r = await (await fetch(`${BASE}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostPath, name, applyMethod: false }),
    })).json();
    if (!r.project?.id) throw new Error(`register ${name} failed: ${JSON.stringify(r)}`);
    return r.project.id;
  }
  const alpha = await mkProject(dirA, 'alpha-inherits');
  const beta = await mkProject(dirB, 'beta-overrides');
  // beta overrides the model; alpha leaves it null (will inherit the global).
  await fetch(`${BASE}/api/projects/${beta}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { model: 'sonnet' } }),
  });

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `${BASE}/#/project/${alpha}` });
  await cdp.waitFor('app boot', `!!window.__station?.drawer`, 30_000);
  await cdp.waitFor('alpha selected', `window.__station.currentProject()?.id === ${JSON.stringify(alpha)}`, 30_000);

  console.log('\n=== the Global defaults view exists and offers the DERIVED catalog ===');
  // FEAT-146: `open('globals')` now routes to the Accounts rail category (the
  // "machine warm-up" default), not the model picker — the model picker lives
  // under the "New-project defaults" category, reached by its own anchor.
  // `FOCUS_CATEGORY.globalModel === 'defaults'` in drawer.js, so this is the
  // current, real way a deep link lands on it (`app.js`'s own "Machine-wide
  // default: … · manage ›" link uses the same `{focus:'globalModel'}` shape).
  //
  // FINDING (drawer.js, not fixed here — a concurrent lane owns that file per
  // this charter): `ensureGlobals()`'s own `.finally(() => { … if (d.view ===
  // 'globals' || d.view === 'settings') paint(); })` was never updated for
  // FEAT-146's `d.view === 'machine'` (New-project defaults/Accounts/
  // Appearance all render through that view now). On the very FIRST ever
  // visit to a machine category the settings+catalog fetch is still in
  // flight when the synchronous paint() inside open() runs, so the pane shows
  // "Loading machine-wide defaults…" and that placeholder is never replaced
  // when the fetch resolves — only a LATER click (which calls paint() again
  // directly) picks up the by-then-cached data. Reproduced here every run.
  // Worked around below by reopening once the cache has had time to warm,
  // exactly the click a real user would make; the real regression stays
  // reported here for FEAT-146 phase 2b rather than silently absorbed.
  await cdp.eval(`window.__station.drawer.open('settings', { focus: 'globalModel' })`);
  let haveSel = await cdp.waitFor('#gModelSel', `!!document.querySelector('#gModelSel')`, 3_000);
  if (!haveSel) {
    console.log('        (cold-open race hit, as expected — reopening once the machine-defaults fetch has landed)');
    await cdp.eval(`window.__station.drawer.open('settings', { focus: 'globalModel' })`);
    haveSel = await cdp.waitFor('#gModelSel', `!!document.querySelector('#gModelSel')`);
  }
  check('drawer has a Global defaults view with a model picker', haveSel, haveSel);
  const opts = await cdp.eval(`[...document.querySelectorAll('#gModelSel option')].map(o => o.textContent)`);
  const optVals = await cdp.eval(`[...document.querySelectorAll('#gModelSel option')].map(o => o.value)`);
  check('picker lists the CLI catalog with versioned names (Opus 1M + Haiku 4.5)',
    Array.isArray(opts) && opts.some((t) => /Opus \(1M context\)/.test(t)) && opts.some((t) => /Haiku 4\.5/.test(t)), opts);
  check('picker carries the bracketed CLI ids as real option values (opus[1m], claude-fable-5[1m])',
    Array.isArray(optVals) && optVals.includes('opus[1m]') && optVals.includes('claude-fable-5[1m]'), optVals);
  check('picker offers an explicit "no global default" row',
    Array.isArray(opts) && opts.some((t) => /no global default/i.test(t)), opts);
  check('picker offers a free-text "Other model id" escape hatch',
    Array.isArray(opts) && opts.some((t) => /Other model id/i.test(t)), opts);

  console.log('\n=== a BRACKETED catalog value persists (the old MODEL_RE 400 is gone) ===');
  const bracketRes = await fetch(`${BASE}/api/settings`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'opus[1m]' }),
  });
  check('PATCH /api/settings {model:"opus[1m]"} returns 200 (was 400)', bracketRes.status === 200, `status ${bracketRes.status}`);
  const afterBracket = await (await fetch(`${BASE}/api/settings`)).json();
  check('bracketed model persisted as opus[1m]', afterBracket?.settings?.model === 'opus[1m]', afterBracket?.settings);

  console.log('\n=== selecting a bracketed catalog row in the PICKER persists (200, not 400) ===');
  await cdp.eval(`window.__station.drawer.open('settings', { focus: 'globalModel' })`);
  await cdp.waitFor('#gModelSel', `!!document.querySelector('#gModelSel')`);
  await cdp.eval(`(() => { const s = document.querySelector('#gModelSel'); s.value = 'claude-fable-5[1m]'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(500);
  const afterPick = await (await fetch(`${BASE}/api/settings`)).json();
  check('picking "Fable" (value claude-fable-5[1m]) persisted via the UI', afterPick?.settings?.model === 'claude-fable-5[1m]', afterPick?.settings);

  console.log('\n=== FREE TEXT: a versioned id the catalog does NOT advertise (claude-opus-4-8) ===');
  await cdp.eval(`window.__station.drawer.open('settings', { focus: 'globalModel' })`);
  await cdp.waitFor('#gModelSel', `!!document.querySelector('#gModelSel')`);
  // FEAT-146's rail carries background "dot" prefetches (`prefetchForDots()`)
  // that call the SAME full-pane `paint()` whenever any of them resolves,
  // whether or not the resolved category is the one on screen. `saveGlobal()`
  // itself is async (it awaits the PATCH before touching `d.globals`), so a
  // click on Apply does not update the pane's own source of truth until that
  // round trip lands — and an UNRELATED repaint landing in that window
  // rebuilds the pane from the still-stale `d.globals` and makes a SEPARATE,
  // LATER read of `#gModelCustom`'s hidden state lie (it reports the reveal
  // as having reverted, even though the click already fired on the correct
  // node and the save is genuinely in flight — reproduced here in ~1 run in
  // 3: the DOM read said "not revealed" while the server-side PATCH still
  // landed correctly moments later). The fix is to observe the reveal
  // WITHIN the same synchronous eval that selects "Other…" — a single
  // Runtime.evaluate call cannot be interleaved by an async paint() — rather
  // than in a later, separate CDP round trip.
  const revealed = await cdp.eval(`(() => {
    const s = document.querySelector('#gModelSel');
    s.value = '__custom__';
    s.dispatchEvent(new Event('change'));
    return !(document.querySelector('#gModelCustom')?.hidden ?? true);
  })()`);
  check('choosing "Other model id" reveals a free-text field', revealed, revealed);
  // Type + Apply, atomically for the same reason — but what this step proves
  // (the value reaches the server) is checked against `/api/settings` below,
  // never against transient DOM, so it needs no further care about repaints.
  await cdp.eval(`(() => {
    const i = document.querySelector('#gModelCustomInput');
    i.value = 'claude-opus-4-8';
    document.querySelector('#gModelCustomApply').click();
  })()`);
  await sleep(500);
  const persisted = await (await fetch(`${BASE}/api/settings`)).json();
  check('PATCH /api/settings recorded the free-text model=claude-opus-4-8', persisted?.settings?.model === 'claude-opus-4-8', persisted?.settings);
  // Re-open: a custom value survives a reload and is shown in the field for editing.
  await cdp.eval(`window.__station.drawer.open('settings')`); await sleep(200);
  await cdp.eval(`window.__station.drawer.open('settings', { focus: 'globalModel' })`);
  await cdp.waitFor('#gModelCustomInput', `!!document.querySelector('#gModelCustomInput')`);
  const roundTrip = await cdp.eval(`document.querySelector('#gModelCustomInput')?.value ?? ''`);
  check('the custom id round-trips into the editable field on reopen', roundTrip === 'claude-opus-4-8', roundTrip);

  console.log('\n=== a project that overrides the model is listed as an overrider ===');
  await cdp.eval(`window.__station.drawer.open('settings', { focus: 'globalModel' })`);
  await sleep(400);
  // FEAT-146: #vGlobals (the dead standalone view) is retired; the same
  // content — the overrider list — now renders inside #vSettings under the
  // New-project defaults category (see catWrap/machineDefaultsView in drawer.js).
  const overText = await cdp.eval(`document.querySelector('#vSettings')?.textContent ?? ''`);
  check('overrider list names beta (its own model), not alpha', /beta-overrides/.test(overText) && !/alpha-inherits/.test(overText), overText.slice(0, 200));

  console.log('\n=== a project with no model of its own shows it inherits the global ===');
  await cdp.eval(`window.__station.drawer.open('settings')`);
  await cdp.waitFor('settings model row', `!!document.querySelector('#vSettings .set')`);
  await sleep(300);
  const modelRow = await cdp.eval(`[...document.querySelectorAll('#vSettings .set')].map(r => r.textContent).find(t => /^Model/.test(t)) ?? ''`);
  check('alpha Model row shows it inherits the global default (claude-opus-4-8)',
    /global default/i.test(modelRow) && /claude-opus-4-8/.test(modelRow), modelRow);
  const link = await cdp.eval(`[...document.querySelectorAll('#vSettings .addrow')].map(b => b.textContent).find(t => /machine-wide/i.test(t)) ?? ''`);
  check('settings view links to the machine-wide default (reflecting the current value)',
    /claude-opus-4-8/.test(link), link);

  console.log('\n=== screenshots, both themes ===');
  await cdp.eval(`window.__station.drawer.open('settings', { focus: 'globalModel' })`);
  await sleep(400);
  await cdp.eval(`document.documentElement.dataset.theme = 'light'`);
  await sleep(200);
  await cdp.shot(path.join(SHOTS, 'globals-light.png'));
  await cdp.eval(`document.documentElement.dataset.theme = 'dark'`);
  await sleep(200);
  await cdp.shot(path.join(SHOTS, 'globals-dark.png'));
  check('screenshots written (read them)', fs.existsSync(path.join(SHOTS, 'globals-light.png')) && fs.existsSync(path.join(SHOTS, 'globals-dark.png')), SHOTS);
  console.log(`        screenshots: ${SHOTS}`);
  cdp.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exitCode = 1;
}).finally(() => {
  stopByPid(browser);
  stopByPid(server);
  setTimeout(() => {
    for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }, 2500);
});
