/**
 * FEAT-146 (round 4) — LIVE PROOF of the fourteen defects an independent
 * design-critical visual review measured in the settings modal.
 *
 *   node scripts/verify-feat-146-settings-polish.mjs
 *
 * Everything below is a MEASURED value read out of a real browser against the
 * real server — never a source grep, and never a "the rule exists in the
 * stylesheet" proxy. The review's own numbers are the baseline each assertion is
 * written against, and each check prints what it observed so the next reader can
 * see the number rather than trust the verdict:
 *
 *   1  the rail  — the SELECTED category is in view at 940 / 800 / 500px for a
 *                  first, a middle and a last category; edge fades exist; the
 *                  group headings stop rendering as pseudo-categories mid-strip.
 *   2  .set-why  — ONE component. Every explanatory block the modal can render,
 *                  across all 11 categories and both lenses, has an IDENTICAL
 *                  computed surface / radius / padding / measure. (Was two:
 *                  a card with radius 8 and a transparent hairline with radius 0
 *                  whose rule colour differed BY CATEGORY.)
 *   3  emoji     — no colour-emoji codepoint anywhere in the settings DOM, and
 *                  no non-greyscale paint except the two sanctioned accents.
 *   4  textarea  — the response-digest field resolves to the app's own mono
 *                  stack, is theme-correct in DARK, and is not a UA widget.
 *   5  no shift  — the card width is identical across all 11 categories
 *                  (`scrollbar-gutter: stable`).
 *   6  gutter    — the ⓘ's x-position is identical with and without a reset, and
 *                  both gutter controls sit on the row's FIRST line box.
 *   7  type      — every rendered font size in the pane is one of four steps.
 *   8  footer    — no footer string is clipped at 940 / 800 / 500px.
 *   9  .seg      — the three segmented controls are the same height.
 *  10  strings   — no unbounded user string is interpolated into a button label
 *                  or a tracked heading.
 *  11  templates — one label rail, one value rail, Patterns inside a card.
 *  12  workspace — the directory is in a card; the actions are one idiom.
 *  13  padding   — card and pane padding land on the stated scale.
 *  14  detail    — the duplicated inline settings key is gone, prose is not set
 *                  in mono, the selects draw their own caret, the destructive
 *                  primary outweighs Cancel.
 *
 * Plus the two product defects the round also closed: the dead `#isoBtn` door,
 * and `ensureGlobals()`'s repaint guard missing `d.view === 'machine'` (which
 * left the FIRST-ever visit to a machine category stuck on "Loading…").
 *
 * MUST-FAILs. Six of these could pass vacuously, so each is re-run against a
 * CONSTRUCTED broken variant — a stylesheet override served over CDP for the
 * layout ones, a synthesized `drawer.js` for the emoji one. Anchored to a
 * constructed state, never to a moving revision (CONVENTIONS.md).
 *
 * Harness: the real server + brave --headless=new over raw CDP, the same shape
 * phases 1 / 2a / 2b used. Ports are OS-assigned; every process is one this
 * script spawned and is stopped by PID; no product code is modified on disk.
 *
 * Leak hygiene: every path used here is created by this script under the system
 * temp dir. No home path, no username, no real project path is written or
 * printed. Confirm with `node scripts/leak-gate.mjs --summary`.
 */
import { spawn, execFileSync } from 'node:child_process';
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

const PROJECT_CATS = ['model', 'permissions', 'instructions', 'isolation', 'snapshots', 'workspace', 'advanced'];
const MACHINE_CATS = ['accounts', 'appearance', 'defaults', 'templates'];
const ALL_CATS = [...PROJECT_CATS, ...MACHINE_CATS];
const lensFor = (cat) => (MACHINE_CATS.includes(cat) ? 'machine' : 'project');

/** The four type steps this round collapsed the pane to. */
const TYPE_STEPS = ['15px', '12px', '11.5px', '10px'];

/* ── infra (the shape phases 1/2a/2b use) ── */
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

/* ── in-page probes ─────────────────────────────────────────────────────── */

/** Every explanatory block on screen, with its full computed surface. */
const WHY_SURFACE = `[...document.querySelectorAll('#dBody .view.on .set-why')].map((n) => {
  const s = getComputedStyle(n); const b = n.getBoundingClientRect();
  return { bg: s.backgroundColor, radius: s.borderTopLeftRadius, pad: s.padding,
    bd: s.borderTopColor + '/' + s.borderTopWidth, bl: s.borderLeftColor + '/' + s.borderLeftWidth,
    maxW: s.maxWidth, fs: s.fontSize, disclosure: n.classList.contains('disclosure'),
    w: Math.round(b.width), txt: n.textContent.trim().slice(0, 34) };
})`;

/** The card + pane geometry a category renders with. */
const CARD_GEO = `(() => {
  const pane = document.querySelector('#dBody'); const ps = getComputedStyle(pane);
  const cards = [...document.querySelectorAll('#dBody .view.on .grp')];
  return { panePad: ps.padding, gutter: ps.scrollbarGutter,
    overflows: pane.scrollHeight - pane.clientHeight > 4,
    cards: cards.map((k) => { const cs = getComputedStyle(k); const b = k.getBoundingClientRect();
      return { x: Math.round(b.x), w: Math.round(b.width), pad: cs.padding, radius: cs.borderTopLeftRadius }; }) };
})()`;

/**
 * Row geometry, per row: where each of the four columns actually lands, and
 * — the measurement that caught the last round's defect — the centre of the
 * row's FIRST LINE BOX, not the centre of a possibly two-line label block.
 */
const ROW_GEO = `[...document.querySelectorAll('#dBody .view.on .set')].map((r) => {
  const q = (sel) => { const n = r.querySelector(sel); if (!n) return null; const b = n.getBoundingClientRect();
    return { x: Math.round(b.x), right: Math.round(b.right), cy: +(b.y + b.height / 2).toFixed(1), w: Math.round(b.width) }; };
  const firstLineCy = (() => { const n = r.querySelector('.l'); if (!n) return null;
    const rg = document.createRange(); rg.selectNodeContents(n); const b = rg.getClientRects()[0];
    return b ? +(b.y + b.height / 2).toFixed(1) : null; })();
  return { label: (r.querySelector('.l')?.textContent ?? '').trim().slice(0, 18), firstLineCy,
    cols: getComputedStyle(r).gridTemplateColumns,
    l: q('.l'), prov: q('.prov'), v: q('.v'), why: q('button.why'), rev: q('.rev'), gut: q('.sgut') };
})`;

/** Every font size actually painted by a non-empty leaf inside the modal. */
/* Every element that renders TEXT OF ITS OWN — i.e. that has a non-empty direct
   child text node — not merely every childless leaf. A `.set .l` carries the
   item title AND a `.f` sub-label element, so a leaf-only sweep never measures
   the single most important size in the pane. (Found by a must-FAIL that
   refused to fail: a 12.5px label was invisible to the earlier sweep.) */
const TYPE_SWEEP = `(() => {
  const seen = new Map(); const bad = [];
  const ownsText = (n) => [...n.childNodes].some((k) => k.nodeType === 3 && k.nodeValue.trim())
    || (n.value != null && String(n.value).trim() !== '' && /INPUT|TEXTAREA/.test(n.tagName))
    || (n.tagName === 'SELECT' && n.options.length > 0);
  for (const n of document.querySelectorAll('#smodal *')) {
    if (!ownsText(n)) continue;
    const s = getComputedStyle(n);
    if (s.visibility === 'hidden' || s.display === 'none') continue;
    const mono = /Plex Mono|JetBrains|SF Mono|Sans Mono|ui-monospace|monospace/.test(s.fontFamily);
    seen.set(s.fontSize + (mono ? ' mono' : ' sans'), (seen.get(s.fontSize + (mono ? ' mono' : ' sans')) ?? 0) + 1);
    if (!${JSON.stringify(TYPE_STEPS)}.includes(s.fontSize)) {
      bad.push({ fs: s.fontSize, cls: String(n.className).slice(0, 26), tag: n.tagName, txt: (n.textContent || '').trim().slice(0, 26) });
    }
  }
  return { sizes: [...seen.keys()].sort(), bad: bad.slice(0, 8) };
})()`;

/**
 * Colour-emoji codepoints anywhere in the modal, and any non-greyscale paint.
 * The greyscale test is chroma, not a name list: max(r,g,b) - min(r,g,b).
 */
const PAINT_SWEEP = `(() => {
  const EMOJI = /[\\u{1F300}-\\u{1FAFF}\\u{2190}-\\u{21FF}\\u{2300}-\\u{23FF}\\u{2460}-\\u{24FF}\\u{25A0}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{FE0F}]/u;
  const COLOUR_EMOJI = /[\\u{1F300}-\\u{1FAFF}\\u{2705}\\u{274C}\\u{2139}\\u{26A0}\\u{2757}\\u{2049}\\u{FE0F}]/u;
  const emoji = [];
  for (const n of document.querySelectorAll('#smodal *')) {
    if (n.children.length) continue;
    const t = (n.textContent || '');
    if (COLOUR_EMOJI.test(t)) emoji.push({ cls: String(n.className).slice(0, 24), txt: t.trim().slice(0, 6), font: getComputedStyle(n).fontFamily.slice(0, 30) });
  }
  const chroma = (v) => { const m = /rgba?\\((\\d+), ?(\\d+), ?(\\d+)(?:, ?([\\d.]+))?/.exec(v); if (!m) return 0;
    if (m[4] !== undefined && Number(m[4]) === 0) return 0;
    return Math.max(+m[1], +m[2], +m[3]) - Math.min(+m[1], +m[2], +m[3]); };
  const hues = []; const seen = new Set();
  for (const n of document.querySelectorAll('#smodal *')) {
    const s = getComputedStyle(n);
    for (const [p, v] of [['color', s.color], ['bg', s.backgroundColor], ['bd', s.borderTopColor]]) {
      if (chroma(v) < 12) continue;
      const k = p + v; if (seen.has(k)) continue; seen.add(k);
      hues.push({ p, v, cls: String(n.className).slice(0, 26), txt: (n.textContent || '').trim().slice(0, 22) });
    }
  }
  return { emoji, hues, ic: document.querySelectorAll('#dBody .ic').length };
})()`;

/** Every footer leaf, and whether it is clipped. */
const FOOTER = `[...document.querySelectorAll('.sfoot *')].filter((n) => !n.children.length).map((n) => {
  const b = n.getBoundingClientRect();
  return { txt: (n.textContent || '').trim().slice(0, 48), w: Math.round(b.width),
    scrollW: n.scrollWidth, clientW: n.clientWidth, clipped: n.scrollWidth > n.clientWidth + 1 };
})`;

/** The rail strip's scroll state and where the selection sits inside it. */
const RAIL = `(() => {
  const r = document.querySelector('#sRail'); const rb = r.getBoundingClientRect(); const cs = getComputedStyle(r);
  const sel = r.querySelector('[aria-current="page"]');
  const sb = sel ? sel.getBoundingClientRect() : null;
  return {
    cat: sel?.dataset.cat ?? null,
    scrollW: r.scrollWidth, clientW: r.clientWidth, overflows: r.scrollWidth > r.clientWidth + 1,
    selFullyInView: sb ? (sb.left >= rb.left - 1 && sb.right <= rb.right + 1) : null,
    selCentreFrac: sb ? +((((sb.left + sb.right) / 2) - rb.left) / rb.width).toFixed(2) : null,
    mask: (cs.maskImage && cs.maskImage !== 'none') ? 'yes' : (cs.webkitMaskImage && cs.webkitMaskImage !== 'none' ? 'yes' : 'no'),
    headings: [...r.querySelectorAll('h3')].map((h) => { const b = h.getBoundingClientRect();
      return { text: h.textContent, w: Math.round(b.width), fs: getComputedStyle(h).fontSize, display: getComputedStyle(h).display }; }),
  };
})()`;

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat146d-verify-'));
  const DATA = path.join(tmp, 'data');
  const CFG = path.join(tmp, 'cfg');
  const STORE = path.join(CFG, 'projects');
  /* A deliberately long directory name AND a deliberately long project name:
     defect 10 is about unbounded user strings reaching display slots, so the
     fixture has to contain one. */
  const PROJ_DIR = path.join(tmp, 'a-project-directory-with-a-deliberately-long-name-for-wrapping');
  const BIN = path.join(tmp, 'bin');
  for (const dd of [DATA, CFG, STORE, PROJ_DIR, BIN]) fs.mkdirSync(dd, { recursive: true });
  fs.writeFileSync(path.join(PROJ_DIR, 'README.md'), '# fixture\n');
  /* A real repo in the fixture so the Git card renders its full action row
     rather than the not-a-repo branch. Synthetic identity only — CONVENTIONS.md
     forbids a real one even on a throwaway. Best-effort: if this environment
     refuses the git write the card still renders two actions and the
     one-idiom assertion below still holds. */
  let fixtureIsRepo = false;
  try {
    const git = (...a) => execFileSync('git', ['-c', 'user.email=verify@example.invalid', '-c', 'user.name=verify', ...a], { cwd: PROJ_DIR, stdio: 'ignore' });
    git('init', '-q');
    git('add', '.');
    git('commit', '-qm', 'fixture');
    fixtureIsRepo = true;
  } catch { /* refused — the weaker branch still exercises the invariant */ }
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

  const LONG_NAME = 'Kubernetes Platform Migration — Control Plane Rewrite (Q3 2026 programme)';
  const r0 = await (await fetch(`${base}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: PROJ_DIR, name: LONG_NAME, applyMethod: false }),
  })).json();
  const projId = r0.project?.id;
  check('PRECONDITION: a real project with a 73-character name exists on the server',
    typeof projId === 'string' && (r0.project?.name ?? '').length > 60, `${(r0.project?.name ?? '').length} chars`);
  const patch = (id, body) => fetch(`${base}/api/projects/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((res) => res.json());
  await patch(projId, { isolation: 'container', container: { dockerSocket: true } });
  await patch(projId, {
    responseDigest: {
      enabled: true,
      guidance: 'Lead with the decision and the evidence that forced it. Name the file paths you changed. '
        + 'If you could not verify something, say which property you could not test and why, rather than reporting a clean run.',
    },
  });
  const acctRes = await (await fetch(`${base}/api/claude-accounts`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Platform Engineering shared Max seat (billing owner: finance-ops)' }),
  })).json();
  const WORK_ID = acctRes.account?.id ?? acctRes.id ?? null;
  check('PRECONDITION: a REAL second Claude account with a 62-character label exists',
    typeof WORK_ID === 'string' && !!WORK_ID, String(WORK_ID));
  await fetch(`${base}/api/projects/${projId}/snapshots`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'before the control-plane rewrite' }),
  }).catch(() => {});

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

  const goto = async () => {
    await cdp.send('Page.navigate', { url: 'about:blank' });
    await sleep(120);
    await cdp.send('Page.navigate', { url: `${base}/#/project/${encodeURIComponent(projId)}` });
    await cdp.waitFor('app boot', `!!(window.__station && window.__station.drawer)`);
    await cdp.waitFor('the project selected', `window.__station.currentProject()?.id === ${JSON.stringify(projId)}`);
    await sleep(320);
  };
  const seedAccounts = () => cdp.eval(`(() => { window.__station.setAccountsForTest([
    { id: 'default', label: 'Default (~/.claude)', state: 'ready', lastStatus: { subscriptionType: 'pro' } },
    { id: ${JSON.stringify(WORK_ID)}, label: 'Platform Engineering shared Max seat (billing owner: finance-ops)', state: 'ready', lastStatus: { subscriptionType: 'max' } }]); })()`);
  const closeIt = async () => { await cdp.eval(`(() => { const D = window.__station.drawer; D.close(); D.close(); })()`); await sleep(140); };
  const openCat = async (cat, lens = null, settle = 1100) => {
    await closeIt();
    const l = lens ?? lensFor(cat);
    await cdp.eval(`(async () => { await window.__station.drawer.open('settings', { scope: ${JSON.stringify(l === 'machine' ? 'machine' : l)} });
      document.querySelector('.srail-item[data-cat="${cat}"]').click(); })()`);
    await sleep(settle);
  };

  await cdp.viewport(1400, 1000);
  await cdp.theme('dark');
  await goto();
  await seedAccounts();
  consoleErrors = [];

  /* ══════════ 5 + 13. the card rail does not move, and padding is on scale ═══ */
  section('5 + 13. no sideways shift on a category switch; padding on one scale');
  const geos = {};
  for (const c of ALL_CATS) { await openCat(c); geos[c] = await cdp.eval(CARD_GEO); }
  const widths = ALL_CATS.map((c) => geos[c].cards[0]?.w ?? null);
  const xs = ALL_CATS.map((c) => geos[c].cards[0]?.x ?? null);
  const overflowMix = new Set(ALL_CATS.map((c) => geos[c].overflows));
  check('CARD WIDTH is identical across all 11 categories (was 660 on 7 and 670 on 4 — a 10px shift on most switches)',
    new Set(widths).size === 1 && widths[0] > 0,
    `widths=${JSON.stringify(widths)} x=${JSON.stringify([...new Set(xs)])}`);
  check('PRECONDITION: that is not vacuous — some categories overflow the pane and some do not, so the scrollbar really would have appeared',
    overflowMix.size === 2, `overflowing=${ALL_CATS.filter((c) => geos[c].overflows).join(',')} · not=${ALL_CATS.filter((c) => !geos[c].overflows).join(',')}`);
  check('the pane reserves the scrollbar gutter (`scrollbar-gutter: stable`)',
    geos.model.gutter === 'stable', geos.model.gutter);
  const pads = new Set(ALL_CATS.flatMap((c) => geos[c].cards.map((k) => k.pad)));
  const radii = new Set(ALL_CATS.flatMap((c) => geos[c].cards.map((k) => k.radius)));
  check('every card in every category has ONE padding (was `12px 15px 13px` — top and bottom 1px apart for no reason)',
    pads.size === 1 && [...pads][0] === '14px 16px', JSON.stringify([...pads]));
  check('and ONE radius', radii.size === 1, JSON.stringify([...radii]));
  check('the pane padding is on the same scale (was `16px 22px 26px`)',
    geos.model.panePad === '16px 20px 24px', geos.model.panePad);

  /* ══════════ 2. .set-why is ONE component ══════════ */
  section('2. one explanatory block: one surface, one radius, one measure, everywhere');
  const surfaces = [];
  for (const lens of ['project', 'session']) {
    for (const c of ALL_CATS) {
      if (lens === 'session' && MACHINE_CATS.includes(c)) continue;
      await openCat(c, lens);
      for (const b of await cdp.eval(WHY_SURFACE)) surfaces.push({ cat: c, lens, ...b });
    }
  }
  // Open every disclosure too, so the ⓘ-toggled variant is measured beside the
  // always-visible ones rather than assumed to match.
  await openCat('model');
  await cdp.eval(`document.querySelector('#dWhyAll').click()`);
  await sleep(500);
  for (const c of ['model', 'isolation', 'defaults']) {
    await closeIt();
    await cdp.eval(`(async () => { await window.__station.drawer.open('settings', { scope: ${JSON.stringify('project')} });
      document.querySelector('.srail-item[data-cat="${c}"]').click(); })()`);
    await sleep(900);
    for (const b of await cdp.eval(WHY_SURFACE)) surfaces.push({ cat: c, lens: 'whyAll', ...b });
  }
  await cdp.eval(`document.querySelector('#dWhyAll').click()`);
  await sleep(300);
  const visible = surfaces.filter((s) => s.w > 0);
  const tuple = (s) => `${s.bg}|${s.radius}|${s.pad}|${s.bd}|${s.bl}|${s.maxW}|${s.fs}`;
  const tuples = new Set(visible.map(tuple));
  check(`every explanatory block in the modal is ONE component — same surface, radius, padding, border and measure (${visible.length} blocks over ${new Set(visible.map((s) => s.cat)).size} categories)`,
    tuples.size === 1 && visible.length >= 8, [...tuples].join('  ||  ').slice(0, 400));
  check('PRECONDITION: the sweep covers BOTH kinds — the always-visible block and the ⓘ-toggled disclosure',
    visible.some((s) => s.disclosure) && visible.some((s) => !s.disclosure),
    `disclosure=${visible.filter((s) => s.disclosure).length} inline=${visible.filter((s) => !s.disclosure).length}`);
  check('the radius is one of the three sanctioned ones (the hairline variant painted radius 0)',
    ['8px', '12px', '6px'].includes(visible[0]?.radius), String(visible[0]?.radius));
  const noLeftRule = visible.every((s) => s.bl === visible[0].bl);
  check('no per-category left-rule colour any more (it was rgb(133,134,131) in most and rgb(36,39,36) in Advanced, nearly invisible)',
    noLeftRule, `border-left=${visible[0]?.bl}`);
  const maxPx = parseFloat(visible[0]?.maxW ?? 'NaN');
  check('the measure is capped at one value, well short of the 628px / 95-character lines the hairline variant ran to',
    Number.isFinite(maxPx) && maxPx > 0 && maxPx < 520
      && new Set(visible.map((s) => s.maxW)).size === 1,
    `computed max-width = ${visible[0]?.maxW} (authored 62ch), identical on all ${visible.length} blocks`);

  /* ══════════ 7. four type steps ══════════ */
  section('7. the type set is four steps, not ten');
  const typeBad = [];
  const typeSeen = new Set();
  for (const c of ALL_CATS) {
    await openCat(c);
    const t = await cdp.eval(TYPE_SWEEP);
    for (const s of t.sizes) typeSeen.add(s);
    if (t.bad.length) typeBad.push({ cat: c, bad: t.bad });
  }
  check(`every rendered font size in the modal is one of ${TYPE_STEPS.join(' / ')} (was ten sizes, seven of them 0.5–1px apart)`,
    typeBad.length === 0, typeBad.length ? JSON.stringify(typeBad).slice(0, 380) : `sizes in use: ${[...typeSeen].sort().join(', ')}`);
  check('PRECONDITION: the sweep really read a lot of leaves (not vacuous)',
    typeSeen.size >= 4, `${typeSeen.size} distinct size+family combinations: ${[...typeSeen].sort().join(', ')}`);

  /* ══════════ 3. no colour emoji, no stray hue ══════════ */
  section('3. greyscale plus the two sanctioned accents — no colour emoji anywhere');
  const paints = [];
  for (const c of ALL_CATS) { await openCat(c); paints.push({ cat: c, ...(await cdp.eval(PAINT_SWEEP)) }); }
  const anyEmoji = paints.flatMap((p) => p.emoji.map((e) => `${p.cat}:${e.txt}(${e.cls})`));
  check('NO colour-emoji codepoint anywhere in the settings DOM (Advanced painted ❌ at Material red 500, rgb(244,67,54))',
    anyEmoji.length === 0, anyEmoji.length ? anyEmoji.join(' | ') : 'none, across all 11 categories');
  check('the `.ic` icon column is gone from the pane',
    paints.every((p) => p.ic === 0), JSON.stringify(paints.map((p) => `${p.cat}:${p.ic}`)));
  /* The two accents that ARE sanctioned: --live (moss, "alive") and --warn
     (caution, per-theme by BUG-183). Anything else is a third accent. */
  const hues = paints.flatMap((p) => p.hues.map((h) => h.v));
  const known = new Set(await cdp.eval(`(() => { const cs = getComputedStyle(document.documentElement);
    const px = (v) => { const d = document.createElement('div'); d.style.color = v; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; };
    return ['--live', '--warn', '--st-prog', '--st-needs', '--st-done', '--st-high'].map((k) => px(cs.getPropertyValue(k).trim())); })()`));
  const stray = [...new Set(hues)].filter((v) => {
    const m = /rgba?\((\d+), ?(\d+), ?(\d+)/.exec(v);
    return !known.has(`rgb(${m[1]}, ${m[2]}, ${m[3]})`);
  });
  check('every non-greyscale paint in the modal is a declared palette accent (--live / --warn), never an ad-hoc hue',
    stray.length === 0, stray.length ? `STRAY: ${stray.join(', ')}` : `accents in use: ${[...new Set(hues)].join(', ')}`);

  /* ══════════ 4. the guidance textarea ══════════ */
  section('4. the response-digest field is a real control, not a raw UA widget');
  await openCat('instructions');
  const taDark = await cdp.eval(`(() => { const t = document.querySelector('#dBody .view.on textarea.guidance-in'); if (!t) return null;
    const s = getComputedStyle(t); const b = t.getBoundingClientRect();
    const card = t.closest('.grp').getBoundingClientRect();
    const px = (v) => { const d = document.createElement('div'); d.style.color = v; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; };
    const cs = getComputedStyle(document.documentElement);
    return { w: Math.round(b.width), h: Math.round(b.height), cardW: Math.round(card.width),
      radius: s.borderTopLeftRadius, resize: s.resize, appearance: s.appearance,
      fontFamily: s.fontFamily, fontSize: s.fontSize, lineHeight: s.lineHeight,
      bg: s.backgroundColor, colour: s.color,
      windowToken: px(cs.getPropertyValue('--window').trim()), inkToken: px(cs.getPropertyValue('--ink').trim()),
      monoToken: cs.getPropertyValue('--mono').trim(),
      valueLen: t.value.length, clipped: t.scrollHeight > t.clientHeight + 1 }; })()`);
  check('the field exists and fills the card (it was 201px wide inside a 670px card)',
    !!taDark && taDark.w > taDark.cardW - 60, JSON.stringify({ w: taDark?.w, cardW: taDark?.cardW }));
  check('its computed font-family resolves to the APP MONO STACK — not the bare `monospace` keyword',
    taDark.fontFamily === taDark.monoToken, `computed=${taDark.fontFamily.slice(0, 60)}`);
  check('12px / 1.55 line height, radius 8, vertical-only resize, appearance:none',
    taDark.fontSize === '12px' && taDark.radius === '8px' && taDark.resize === 'vertical' && taDark.appearance === 'none'
      && Math.abs(parseFloat(taDark.lineHeight) - 12 * 1.55) < 0.6,
    JSON.stringify({ fs: taDark.fontSize, lh: taDark.lineHeight, r: taDark.radius, resize: taDark.resize, appearance: taDark.appearance }));
  check('its background is THEME-CORRECT in dark (it rendered light grey — it did not respect the theme at all)',
    taDark.bg === taDark.windowToken && taDark.colour === taDark.inkToken,
    `bg=${taDark.bg} (--window=${taDark.windowToken}) · colour=${taDark.colour} (--ink=${taDark.inkToken})`);
  check('at least 96px tall, so a real 205-character value is not clipped into a 24-character window',
    taDark.h >= 96 && taDark.valueLen > 180 && taDark.clipped === false,
    `h=${taDark.h} value=${taDark.valueLen} chars clipped=${taDark.clipped}`);
  await cdp.theme('light');
  await sleep(250);
  const taLight = await cdp.eval(`(() => { const t = document.querySelector('#dBody .view.on textarea.guidance-in');
    const s = getComputedStyle(t); const cs = getComputedStyle(document.documentElement);
    const px = (v) => { const d = document.createElement('div'); d.style.color = v; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; };
    return { bg: s.backgroundColor, windowToken: px(cs.getPropertyValue('--window').trim()) }; })()`);
  check('and it follows the theme when the theme flips',
    taLight.bg === taLight.windowToken && taLight.bg !== taDark.bg,
    `light bg=${taLight.bg} · dark bg=${taDark.bg}`);
  await cdp.theme('dark');
  await sleep(200);

  /* ══════════ 6. the gutter ══════════ */
  section('6. the affordance gutter: two fixed slots, both on the first line box');
  await openCat('model');
  const before = await cdp.eval(ROW_GEO);
  const rowNoReset = before.find((r) => r.why && !r.rev);
  check('PRECONDITION: a row with an ⓘ and NO reset is on screen to measure',
    !!rowNoReset, JSON.stringify(rowNoReset?.label ?? before.map((r) => r.label)));
  // Write a value so the reset appears on the SAME row.
  await cdp.eval(`(() => { const rows = [...document.querySelectorAll('#dBody .view.on .set')];
    const r = rows.find((x) => x.querySelector('button.why') && !x.querySelector('.rev')); r.click(); })()`);
  await sleep(900);
  const after = await cdp.eval(ROW_GEO);
  const rowWithReset = after.find((r) => r.label === rowNoReset.label);
  check('a reset really did appear on that row (the measurement is not comparing a row to itself unchanged)',
    !!rowWithReset?.rev && !rowNoReset.rev, JSON.stringify({ before: !!rowNoReset.rev, after: !!rowWithReset?.rev }));
  check('THE ⓘ DOES NOT MOVE when a reset appears beside it (it moved x:1089→1068 — the reserved column was shared, so the no-reflow property did not hold for it)',
    rowWithReset.why.x === rowNoReset.why.x && rowWithReset.why.right === rowNoReset.why.right,
    `x ${rowNoReset.why.x} → ${rowWithReset.why.x}`);
  check('the gutter itself is the same 46px box in both states',
    rowWithReset.gut.w === 46 && rowNoReset.gut.w === 46 && rowWithReset.gut.x === rowNoReset.gut.x,
    `${rowNoReset.gut.w}px @${rowNoReset.gut.x} → ${rowWithReset.gut.w}px @${rowWithReset.gut.x}`);
  const spread = (r) => {
    const ys = [r.firstLineCy, r.prov?.cy, r.v?.cy, r.why?.cy, r.rev?.cy].filter((v) => v != null);
    return +(Math.max(...ys) - Math.min(...ys)).toFixed(1);
  };
  check('all four columns sit on the row\'s FIRST LINE BOX — the gutter was 8px low, centred on a two-line label block instead',
    spread(rowWithReset) <= 2.5,
    `spread=${spread(rowWithReset)}px · firstLine=${rowWithReset.firstLineCy} chip=${rowWithReset.prov?.cy} value=${rowWithReset.v?.cy} info=${rowWithReset.why?.cy} reset=${rowWithReset.rev?.cy}`);
  const twoLine = after.find((r) => r.l && r.why && r.l.x != null && r.firstLineCy != null);
  check('PRECONDITION: the label really is a two-line block, which is what made the old centring wrong',
    twoLine != null, JSON.stringify({ label: twoLine?.label, firstLineCy: twoLine?.firstLineCy }));
  // reset it again so later sections see a clean project
  await cdp.eval(`(() => { const r = [...document.querySelectorAll('#dBody .view.on .set')].find((x) => x.querySelector('.rev')); r?.querySelector('.rev')?.click(); })()`);
  await sleep(700);

  /* ══════════ 9. one segmented control, one height ══════════ */
  section('9. the three segmented controls are the same height, and carry no glyphs');
  const segs = {};
  for (const [c, lens] of [['model', 'project'], ['isolation', 'project'], ['appearance', 'machine']]) {
    await openCat(c, lens);
    segs[c] = await cdp.eval(`[...document.querySelectorAll('#dBody .view.on .seg button')].map((b) => {
      const r = b.getBoundingClientRect(); const s = getComputedStyle(b);
      return { h: Math.round(r.height), dir: s.flexDirection, glyph: !!b.querySelector('.g'),
        txt: b.textContent.trim().slice(0, 14) }; })`);
  }
  const heights = new Set(Object.values(segs).flat().map((b) => b.h));
  check('Provider (was 53px), Isolation (was 54px) and Appearance (was 35px) are all ONE height, matching the 34px row minimum',
    heights.size === 1 && [...heights][0] === 34,
    JSON.stringify(Object.fromEntries(Object.entries(segs).map(([k, v]) => [k, v.map((b) => b.h)]))));
  check('no `.g` glyph span survives in any segment (`✳ ⌬ ▣ ◑ ○` were unreadable at size and inconsistent between the two sets)',
    Object.values(segs).flat().every((b) => b.glyph === false),
    JSON.stringify(Object.values(segs).flat().map((b) => `${b.txt}:${b.glyph}`)));

  /* ══════════ 8. the footer ══════════ */
  section('8. the footer at every width: nothing clipped, one prose slot');
  const footStates = [];
  for (const w of [940, 800, 500]) {
    await cdp.viewport(w, 820);
    await sleep(250);
    for (const lens of ['project', 'session']) {
      await openCat('model', lens);
      footStates.push({ w, lens, items: await cdp.eval(FOOTER) });
    }
  }
  const clipped = footStates.flatMap((f) => f.items.filter((i) => i.clipped).map((i) => `${f.w}/${f.lens}: "${i.txt}" ${i.scrollW}>${i.clientW}`));
  check('NO footer string is clipped at 940 / 800 / 500px under either lens (two adjacent ellipses in a 44px bar was the defect)',
    clipped.length === 0, clipped.length ? clipped.join(' | ') : `${footStates.length} states measured, 0 clipped`);
  const footTexts = footStates.find((f) => f.w === 940 && f.lens === 'session').items.map((i) => i.txt);
  check('the footer carries the toggle and ONE prose slot — the duplicate "These apply to the next session…" string is gone',
    footTexts.length === 2 && footTexts.some((t) => /Writing to this session only/.test(t))
      && !footTexts.some((t) => /These apply to the next session/.test(t)),
    JSON.stringify(footTexts));
  await cdp.viewport(1400, 1000);
  await sleep(200);
  await openCat('model', 'session');
  const liveNote = await cdp.eval(`(() => { const n = document.querySelector('#dLive'); const b = n.getBoundingClientRect();
    return { inPane: !!n.closest('#dBody'), hidden: n.hidden, w: Math.round(b.width), txt: n.textContent.trim().slice(0, 40) }; })()`);
  check('the live-state line lives in the PANE now, not the footer, and is silent when it has nothing to add',
    liveNote.inPane === true && liveNote.hidden === true, JSON.stringify(liveNote));

  /* ══════════ 1. the rail below 860px ══════════ */
  section('1. the narrow rail: the selected category is always in view');
  const railStates = [];
  for (const w of [940, 800, 500]) {
    await cdp.viewport(w, 820);
    await sleep(260);
    for (const c of ['model', 'snapshots', 'templates']) {
      await openCat(c, null, 900);
      railStates.push({ w, cat: c, ...(await cdp.eval(RAIL)) });
    }
  }
  const outOfView = railStates.filter((r) => r.selFullyInView !== true);
  check('the SELECTED category is fully in view at every width, for a first / middle / last category (`selInView` was false — the selection was scrolled off the left edge and never scrolled back)',
    outOfView.length === 0,
    outOfView.length ? outOfView.map((r) => `${r.w}/${r.cat}`).join(', ')
      : railStates.map((r) => `${r.w}/${r.cat}@${r.selCentreFrac}`).join(' '));
  check('PRECONDITION: the strip really does overflow at these widths, so "in view" is not free',
    railStates.filter((r) => r.w <= 800).every((r) => r.overflows === true),
    JSON.stringify(railStates.filter((r) => r.w <= 800).map((r) => `${r.w}:${r.scrollW}>${r.clientW}`)));
  const midCentred = railStates.filter((r) => r.cat === 'snapshots' && r.w <= 800);
  check('a middle category is CENTRED, not merely nudged into frame (so the 500px pill is never sliced mid-word)',
    midCentred.every((r) => Math.abs(r.selCentreFrac - 0.5) < 0.12),
    JSON.stringify(midCentred.map((r) => `${r.w}:${r.selCentreFrac}`)));
  const narrow = railStates.filter((r) => r.w <= 800);
  check('the strip carries 24px edge fades, so "there is more" is visible without a scrollbar',
    narrow.every((r) => r.mask === 'yes'), JSON.stringify([...new Set(narrow.map((r) => r.mask))]));
  check('the group headings no longer render as inline text mid-strip ("This project" sat at x:-327, off the left edge; "This machine" floated mid-strip looking like a 12th category)',
    narrow.every((r) => r.headings.every((h) => h.w <= 2 || h.display === 'none')),
    JSON.stringify(narrow[0]?.headings));
  await cdp.viewport(1400, 1000);
  await sleep(250);
  const wideRail = await (async () => { await openCat('model'); return cdp.eval(RAIL); })();
  check('and at 940px the headings are back to full sentence-case text (the desktop rail is unchanged)',
    wideRail.headings.length === 2 && wideRail.headings.every((h) => h.w > 40 && h.fs === '10px'),
    JSON.stringify(wideRail.headings));

  /* ══════════ 10 / 11 / 12 / 14. the rest, measured ══════════ */
  section('10. no unbounded user string in a display slot');
  await openCat('snapshots', 'project', 1800);
  const restoreBtn = await cdp.eval(`(async () => {
    const b = [...document.querySelectorAll('#dBody .view.on button')].find((x) => /^Restore$/.test(x.textContent.trim()));
    if (!b) return { armed: false };
    b.click(); await new Promise((r) => setTimeout(r, 500));
    const go = [...document.querySelectorAll('#dBody .ceremony button')].find((x) => /Restore/.test(x.textContent));
    const cancel = [...document.querySelectorAll('#dBody .ceremony button')].find((x) => /Cancel/.test(x.textContent));
    const cs = go ? getComputedStyle(go) : null; const ccs = cancel ? getComputedStyle(cancel) : null;
    const lab = document.querySelector('#dBody .ceremony .cl');
    return { armed: true, label: go?.textContent.trim() ?? null, w: go ? Math.round(go.getBoundingClientRect().width) : null,
      projName: window.__station.currentProject()?.name ?? '',
      goBg: cs?.backgroundColor, cancelBg: ccs?.backgroundColor,
      confirmHTML: lab ? lab.innerHTML : null, confirmText: lab ? lab.textContent : null }; })()`);
  check('PRECONDITION: the restore ceremony really armed on a real snapshot', restoreBtn.armed === true, JSON.stringify(restoreBtn.armed));
  check('the restore confirm button does NOT interpolate the project name (a 73-character name made an 830px button)',
    restoreBtn.label === 'Restore this project' && !restoreBtn.label.includes(restoreBtn.projName) && restoreBtn.w < 220,
    `"${restoreBtn.label}" · ${restoreBtn.w}px · project name is ${restoreBtn.projName.length} chars`);
  check('the destructive primary is FILLED and Cancel is not — they were both hollow',
    restoreBtn.goBg !== restoreBtn.cancelBg, `primary=${restoreBtn.goBg} cancel=${restoreBtn.cancelBg}`);
  check('"Type <name> to confirm" has a word space on BOTH sides of the inline mono span',
    / $/.test(restoreBtn.confirmText.split(restoreBtn.projName)[0] ?? '')
      && /^ /.test(restoreBtn.confirmText.split(restoreBtn.projName)[1] ?? ''),
    JSON.stringify(restoreBtn.confirmText.slice(0, 40) + '…' + restoreBtn.confirmText.slice(-18)));

  await openCat('accounts', 'machine', 1600);
  const acctCard = await cdp.eval(`(async () => {
    document.querySelector('#gAcctAdd')?.click(); await new Promise((r) => setTimeout(r, 300));
    const i = document.querySelector('#gAcctLabel');
    if (i) { i.value = 'Platform Engineering shared Max seat (billing owner: finance-ops)'; i.dispatchEvent(new Event('input', { bubbles: true })); }
    document.querySelector('#gAcctCreate')?.click();
    for (let k = 0; k < 120 && !document.querySelector('#gAcctCancel'); k++) await new Promise((r) => setTimeout(r, 120));
    await new Promise((r) => setTimeout(r, 500));
    const head = document.querySelector('#dBody .acctlogin .grp-l');
    const hs = head ? getComputedStyle(head) : null;
    const rows = [...document.querySelectorAll('#dBody .acctlogin .gcustom')].map((g) => {
      const cs = getComputedStyle(g); const kids = [...g.children].map((k) => Math.round(k.getBoundingClientRect().width));
      const gapPx = g.children.length > 1
        ? Math.round(g.children[1].getBoundingClientRect().left - g.children[0].getBoundingClientRect().right) : null;
      return { joined: g.classList.contains('joined'), gap: cs.columnGap, measuredGap: gapPx, kids }; });
    return { headText: head?.textContent.trim() ?? null, headLines: head ? Math.round(head.getBoundingClientRect().height / parseFloat(hs.fontSize)) : null,
      transform: hs?.textTransform, rows }; })()`);
  check('the add-account heading is a FIXED string — the 62-character label is not inside an uppercase tracked heading at full card width',
    acctCard.headText === 'Signing in' && acctCard.transform === 'uppercase',
    `"${acctCard.headText}" (${acctCard.transform})`);
  check('the sign-in URL field and its Copy button are JOINED (they were two bordered boxes 15px apart)',
    acctCard.rows.length > 0 && acctCard.rows.every((r) => r.joined === true && r.measuredGap === 0),
    JSON.stringify(acctCard.rows));
  await cdp.eval(`document.querySelector('#gAcctCancel')?.click()`);
  await sleep(1200);

  section('11. Templates: one label rail, one value rail, Patterns in a card');
  await openCat('templates', 'machine', 1600);
  const tpl = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('#dBody .view.on .lrow')];
    const titleX = rows.map((r) => { const n = r.querySelector('.nm');
      const rg = document.createRange();
      const txt = [...n.childNodes].find((k) => k.nodeType === 3 && k.nodeValue.trim());
      if (!txt) return null; rg.selectNodeContents(txt); const b = rg.getBoundingClientRect(); return Math.round(b.x); });
    const markers = rows.map((r) => !!r.querySelector('.spark') && !r.querySelector('.spark.off'));
    const rightEdge = rows.map((r) => Math.round(r.querySelector('.rt').getBoundingClientRect().right));
    const modes = [...document.querySelectorAll('#dBody .view.on .mode')].map((m) => {
      const s = getComputedStyle(m); return { r: s.borderTopLeftRadius, bw: s.borderTopWidth, bg: s.backgroundColor, txt: m.textContent.trim() }; });
    const patterns = document.querySelector('#dBody .view.on details[data-sect="patterns"]');
    return { titleX, markers, rightEdge, modes,
      patternsInCard: !!patterns && !!patterns.closest('.grp'),
      patternsCardW: patterns ? Math.round(patterns.closest('.grp').getBoundingClientRect().width) : null };
  })()`);
  check('every template title starts on ONE left rail — rows with the living marker and rows without were 25px apart',
    new Set(tpl.titleX.filter((x) => x != null)).size === 1, JSON.stringify(tpl.titleX));
  check('PRECONDITION: the sweep saw BOTH kinds of row (marked and unmarked), so the rail test is not vacuous',
    tpl.markers.includes(true) && tpl.markers.includes(false), JSON.stringify(tpl.markers));
  check('the `append` control is a plain text button — no border, no radius, no fill (it was visually identical to the hollow provenance chip while meaning something unrelated)',
    tpl.modes.length > 0 && tpl.modes.every((m) => m.bw === '0px' && m.r === '0px' && /rgba\(0, 0, 0, 0\)/.test(m.bg)),
    JSON.stringify(tpl.modes));
  check('`Patterns (opt-in)` is inside a card — it was a card header with no card',
    tpl.patternsInCard === true && tpl.patternsCardW > 0, JSON.stringify({ inCard: tpl.patternsInCard, w: tpl.patternsCardW }));
  const railCompare = await (async () => {
    const tplRight = Math.max(...tpl.rightEdge);
    await openCat('model');
    const setRight = await cdp.eval(`(() => { const v = document.querySelector('#dBody .view.on .set .v');
      return Math.round(v.getBoundingClientRect().right); })()`);
    return { tplRight, setRight };
  })();
  check('the Templates right block ends on the SAME rail as every settings row\'s value (it was a second value rail)',
    Math.abs(railCompare.tplRight - railCompare.setRight) <= 2, JSON.stringify(railCompare));

  section('12. Workspace: the directory is in the card system, the actions are one idiom');
  await openCat('workspace', 'project', 1800);
  const ws = await cdp.eval(`(() => {
    const box = document.querySelector('#dBody .view.on .proj-dir-box');
    const dir = document.querySelector('#dBody .view.on .proj-dir');
    const v = dir?.querySelector('.v');
    const vs = v ? getComputedStyle(v) : null;
    const gitCard = document.querySelector('#dBody .view.on [data-focus="git"]');
    const acts = gitCard ? [...gitCard.querySelectorAll('button')] : [];
    const kinds = [...new Set(acts.map((b) => (b.className.split(' ').filter((c) => c !== 'wiring-go').sort().join('.') || b.tagName)))];
    const lefts = [...new Set(acts.map((b) => Math.round(b.getBoundingClientRect().left)))];
    const borders = [...new Set(acts.map((b) => getComputedStyle(b).borderTopWidth))];
    return { dirIsCard: !!box && box.classList.contains('grp'),
      dirRowIsSet: !!dir && dir.classList.contains('set'),
      valAlign: vs?.textAlign, valWrap: vs?.overflowWrap,
      changeIsButton: (() => { const c = document.querySelector('.dir-change'); if (!c) return null;
        const s = getComputedStyle(c); return s.borderTopWidth !== '0px' && s.borderTopStyle !== 'none'; })(),
      valOverflows: v ? v.scrollWidth > v.clientWidth + 1 : null,
      actionKinds: kinds, actionBorders: borders, actionCount: acts.length, actionLefts: lefts.length };
  })()`);
  check('the working directory is a CARD with a normal row in it — it was the only pane content outside the card system',
    ws.dirIsCard === true && ws.dirRowIsSet === true, JSON.stringify({ card: ws.dirIsCard, row: ws.dirRowIsSet }));
  check('the path is left-aligned, breaks anywhere and is not clipped (it wrapped mid-token with its continuation aligned to nothing)',
    ws.valAlign === 'left' && ws.valWrap === 'anywhere' && ws.valOverflows === false,
    JSON.stringify({ align: ws.valAlign, wrap: ws.valWrap, clipped: ws.valOverflows }));
  check('`Change…` has a real button affordance',
    ws.changeIsButton === true, String(ws.changeIsButton));
  check('PRECONDITION: whether the fixture is a real repo (decides how many actions the card shows)',
    true, fixtureIsRepo ? 'real git repo — the full action row' : 'not a repo (git write refused here) — the two-action branch');
  check('the Git card\'s actions are ONE idiom — it stacked three (a bare `›` link, a bordered button and a bare `↻`), so only the middle one had a border',
    ws.actionKinds.length === 1 && ws.actionKinds[0] === 'mini' && ws.actionBorders.length === 1
      && ws.actionBorders[0] !== '0px' && ws.actionCount >= 2,
    `${ws.actionCount} buttons, classes=${JSON.stringify(ws.actionKinds)} border-widths=${JSON.stringify(ws.actionBorders)}`);

  section('14. the smaller ones, each measured');
  await openCat('permissions');
  const detail = await cdp.eval(`(() => {
    const browserRow = [...document.querySelectorAll('#dBody .view.on .risk')].find((r) => /Browser/.test(r.querySelector('.l')?.textContent ?? ''));
    const flag = browserRow?.querySelector('.f')?.textContent ?? '';
    const why = browserRow?.querySelector('.set-why')?.textContent ?? '';
    const use1 = browserRow?.querySelector('.use1');
    const u1 = use1 ? getComputedStyle(use1) : null;
    const cs = getComputedStyle(document.documentElement);
    return { flag, whyRepeatsKey: /browser\\.enabled/.test(why),
      use1Mono: u1 ? /Plex Mono|JetBrains|ui-monospace|monospace/.test(u1.fontFamily) : null,
      use1Text: use1?.textContent.trim().slice(0, 40) ?? null,
      sansToken: cs.getPropertyValue('--sans').trim(), use1Family: u1?.fontFamily }; })()`);
  check('the settings key is stated ONCE, on its own line — the inline copy dumped mid-paragraph is gone',
    /browser\.enabled/.test(detail.flag) && detail.whyRepeatsKey === false,
    `flag="${detail.flag}" · repeated in prose=${detail.whyRepeatsKey}`);
  check('the when-to-use fragment is PROSE, set in sans — mono is the machine-string token in this app',
    detail.use1Mono === false && detail.use1Family === detail.sansToken,
    `"${detail.use1Text}" → ${detail.use1Family?.slice(0, 40)}`);
  await openCat('accounts', 'machine', 1500);
  const selects = await cdp.eval(`[...document.querySelectorAll('#dBody .view.on select')].map((s) => {
    const cs = getComputedStyle(s); return { appearance: cs.appearance, bgImage: cs.backgroundImage !== 'none', radius: cs.borderTopLeftRadius }; })`);
  check('both native <select>s draw their own caret (`appearance: none`) rather than the OS chevron',
    selects.length > 0 && selects.every((s) => s.appearance === 'none' && s.bgImage === true),
    JSON.stringify(selects));
  const btnFonts = await cdp.eval(`(() => { const cs = getComputedStyle(document.documentElement);
    const sans = cs.getPropertyValue('--sans').trim();
    const bad = [...document.querySelectorAll('#dBody .view.on button.mini')].filter((b) => getComputedStyle(b).fontFamily !== sans)
      .map((b) => ({ txt: b.textContent.trim().slice(0, 14), f: getComputedStyle(b).fontFamily.slice(0, 26) }));
    return { total: document.querySelectorAll('#dBody .view.on button.mini').length, bad }; })()`);
  check('every button label is sans — `Delete…` was mono while every other button was not',
    btnFonts.total > 0 && btnFonts.bad.length === 0, JSON.stringify(btnFonts));
  const acctAlign = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('#dBody .view.on .acctlist .set')].filter((r) => r.querySelector('.v button'));
    return rows.map((r) => { const l = r.querySelector('.l').getBoundingClientRect(); const v = r.querySelector('.v').getBoundingClientRect();
      return { lines: Math.round(l.height / 18), off: Math.round(((v.top + v.bottom) / 2) - ((l.top + l.bottom) / 2)) }; }); })()`);
  check('an account row\'s action sits on the optical centre of its (possibly two-line) label block — it was 17px above it',
    acctAlign.length > 0 && acctAlign.every((r) => Math.abs(r.off) <= 3), JSON.stringify(acctAlign));

  section('also: the two product defects this round closed');
  const doorGone = await cdp.eval(`({ isoBtn: !!document.querySelector('#isoBtn'), pop: !!document.querySelector('#pop'), popSettings: !!document.querySelector('#popSettings') })`);
  check('the dead isolation door is REMOVED, not left hidden — nothing could un-hide it after FEAT-139',
    doorGone.isoBtn === false && doorGone.pop === false && doorGone.popSettings === false, JSON.stringify(doorGone));
  /* ensureGlobals()'s repaint guard: a FIRST-ever visit to a machine category on
     a freshly-loaded page used to stick on "Loading machine-wide defaults…" with
     nothing to repaint it. Drive exactly that: reload, then go straight there. */
  await goto();
  await seedAccounts();
  await cdp.eval(`(async () => { await window.__station.drawer.open('settings');
    document.querySelector('.srail-item[data-cat="defaults"]').click(); })()`);
  await sleep(2200);
  const machineFirstVisit = await cdp.eval(`(() => { const h = document.querySelector('#dBody .view.on');
    return { stuck: /Loading machine-wide defaults/.test(h.textContent),
      cards: h.querySelectorAll('.grp').length, first: (h.textContent || '').trim().slice(0, 40) }; })()`);
  check('the FIRST-ever visit to a machine category resolves without another click (ensureGlobals()\'s `.finally` never covered `d.view === "machine"`)',
    machineFirstVisit.stuck === false && machineFirstVisit.cards >= 3, JSON.stringify(machineFirstVisit));

  section('screenshots + console');
  await cdp.viewport(1400, 1000);
  await openCat('advanced');
  await shot('feat146-polish-advanced-dark.png');
  await cdp.theme('light');
  await sleep(250);
  await openCat('workspace', 'project', 1600);
  await shot('feat146-polish-workspace-light.png');
  await cdp.theme('dark');
  await cdp.viewport(500, 820);
  await sleep(300);
  await openCat('snapshots', 'project', 1200);
  await shot('feat146-polish-rail-500-dark.png');
  await cdp.viewport(1400, 1000);
  await sleep(200);
  check('zero console errors across the whole run',
    consoleErrors.length === 0, consoleErrors.length ? consoleErrors.slice(0, 6).join(' | ') : 'none');

  /* ══════════ MUST-FAIL ══════════ */
  section('MUST-FAIL: each measurement above is re-run against a CONSTRUCTED broken variant');
  const realCss = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  const anchors = {
    gutter: 'overflow-y: auto; scrollbar-width: thin; scrollbar-gutter: stable;',
    sgut: '.sgut > button.why { grid-column: 1; }',
    label: '.set .l { font-size: 15px; color: var(--ink); font-weight: 500; min-width: 0; }',
    why: '.set-why {\n  margin: 8px 0 2px; padding: 9px 11px;',
    seg: '  flex: 1; min-height: 34px; padding: 0 10px; border-radius: 7px;',
  };
  check('PRECONDITION: all five stylesheet mutation sites are where the must-FAILs expect them',
    Object.values(anchors).every((a) => realCss.includes(a)),
    JSON.stringify(Object.fromEntries(Object.entries(anchors).map(([k, v]) => [k, realCss.includes(v)]))));

  /* The five defects, re-created exactly, in one variant sheet. */
  const brokenCss = realCss
    .replace(anchors.gutter, 'overflow-y: auto; scrollbar-width: thin; scrollbar-gutter: auto;')
    .replace(anchors.sgut, '.sgut { display: flex; justify-content: flex-end; gap: 4px; }')
    .replace(anchors.label, '.set .l { font-size: 12.5px; color: var(--ink); font-weight: 500; min-width: 0; }')
    .replace(anchors.why, '.risk .set-why { border-radius: 0; background: none; border: 0; border-left: 1px solid var(--ink-4-struct); padding: 0 0 0 10px; max-width: none; }\n.set-why {\n  margin: 8px 0 2px; padding: 9px 11px;')
    // ONE control raised, not all three — the original defect was per-control
    // (a stacked glyph line only the Provider and Isolation sets carried).
    .replace(anchors.seg, '  flex: 1; min-height: 34px; padding: 0 10px; border-radius: 7px;\n}\n.prov-seg button { min-height: 53px;');
  check('PRECONDITION: the synthesized stylesheet really differs from the shipped one',
    brokenCss !== realCss && brokenCss.includes('scrollbar-gutter: auto'),
    `${realCss.length} → ${brokenCss.length} bytes`);

  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*styles.css*', requestStage: 'Request' }] });
  cdp.on('Fetch.requestPaused', (p) => {
    void cdp.send('Fetch.fulfillRequest', {
      requestId: p.requestId, responseCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'text/css' }],
      body: Buffer.from(brokenCss, 'utf8').toString('base64'),
    });
  });
  await goto();
  await seedAccounts();
  const servingBroken = await cdp.eval(`(async () => (await (await fetch('/styles.css')).text()).includes('scrollbar-gutter: auto'))()`);
  check('the page is really running the synthesized stylesheet', servingBroken === true, String(servingBroken));

  const bGeos = {};
  for (const c of ALL_CATS) { await openCat(c); bGeos[c] = await cdp.eval(CARD_GEO); }
  const bWidths = new Set(ALL_CATS.map((c) => bGeos[c].cards[0]?.w ?? null));
  check('MUST-FAIL (5): without `scrollbar-gutter: stable` the card width DIFFERS between categories again',
    bWidths.size > 1, JSON.stringify([...bWidths]));

  await openCat('model');
  const bBefore = await cdp.eval(ROW_GEO);
  const bNoReset = bBefore.find((r) => r.why && !r.rev);
  await cdp.eval(`(() => { const rows = [...document.querySelectorAll('#dBody .view.on .set')];
    const r = rows.find((x) => x.querySelector('button.why') && !x.querySelector('.rev')); r.click(); })()`);
  await sleep(900);
  const bAfter = await cdp.eval(ROW_GEO);
  const bWithReset = bAfter.find((r) => r.label === bNoReset?.label);
  check('MUST-FAIL (6): with a flex-packed gutter the ⓘ MOVES when a reset appears',
    !!bNoReset && !!bWithReset?.rev && bWithReset.why.x !== bNoReset.why.x,
    `x ${bNoReset?.why?.x} → ${bWithReset?.why?.x}`);

  const bType = await cdp.eval(TYPE_SWEEP);
  check('MUST-FAIL (7): a 12.5px label puts a fifth size back on the screen and the sweep NAMES it',
    bType.bad.length > 0 && bType.bad.some((b) => b.fs === '12.5px'), JSON.stringify(bType.bad.slice(0, 3)));

  /* The variant only alters `.risk .set-why`, so the two surfaces are only both
     on screen where an ⓘ disclosure sits beside an always-visible block. Turn
     "Show all descriptions" on and sweep Isolation, which renders both. */
  await openCat('isolation');
  await cdp.eval(`(() => { const t = document.querySelector('#dWhyAll'); if (t.getAttribute('aria-pressed') !== 'true') t.click(); })()`);
  await sleep(700);
  const bSurfaces = (await cdp.eval(WHY_SURFACE)).filter((s) => s.w > 0);
  check('PRECONDITION: the broken sweep really sees both an ⓘ disclosure and an always-visible block',
    bSurfaces.some((s) => s.disclosure) && bSurfaces.some((s) => !s.disclosure),
    `disclosure=${bSurfaces.filter((s) => s.disclosure).length} inline=${bSurfaces.filter((s) => !s.disclosure).length}`);
  check('MUST-FAIL (2): restoring the hairline variant makes two different `.set-why` surfaces appear side by side again',
    new Set(bSurfaces.map(tuple)).size > 1,
    JSON.stringify([...new Set(bSurfaces.map((s) => `${s.radius}/${s.bg}`))]));
  await cdp.eval(`(() => { const t = document.querySelector('#dWhyAll'); if (t.getAttribute('aria-pressed') === 'true') t.click(); })()`);
  await sleep(300);

  const bSegs = {};
  for (const [c, lens] of [['model', 'project'], ['appearance', 'machine']]) {
    await openCat(c, lens);
    bSegs[c] = await cdp.eval(`[...document.querySelectorAll('#dBody .view.on .seg button')].map((b) => Math.round(b.getBoundingClientRect().height))`);
  }
  check('MUST-FAIL (9): a 53px provider seg makes the three segmented controls disagree again',
    new Set(Object.values(bSegs).flat()).size > 1, JSON.stringify(bSegs));
  await cdp.send('Fetch.disable');

  /* The emoji and footer detectors are behaviour, not layout, so their broken
     variant is a constructed DOM state rather than a stylesheet. */
  await goto();
  await seedAccounts();
  await openCat('advanced');
  const emojiBroken = await cdp.eval(`(() => {
    const row = document.querySelector('#dBody .view.on .wiring-row .top');
    const s = document.createElement('span'); s.className = 'ic'; s.textContent = '❌';
    row.prepend(s); return !!document.querySelector('#dBody .ic'); })()`);
  check('PRECONDITION: a colour-emoji glyph was really injected into the pane', emojiBroken === true, String(emojiBroken));
  const bPaint = await cdp.eval(PAINT_SWEEP);
  check('MUST-FAIL (3): the emoji detector catches a single re-introduced ❌ and names the element that carries it',
    bPaint.emoji.length > 0 && bPaint.ic > 0, JSON.stringify(bPaint.emoji));

  await openCat('model', 'session');
  const footBroken = await cdp.eval(`(() => {
    const f = document.querySelector('.sfoot');
    const s = document.createElement('span'); s.className = 'sfoot-r';
    s.style.cssText = 'flex:1 1 auto;min-width:0;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    s.textContent = 'These apply to the next session you start from this project. They are never written to the registry.';
    f.append(s); return true; })()`);
  const bFoot = await cdp.eval(FOOTER);
  check('MUST-FAIL (8): the footer detector catches the second string the moment it is put back — it clips immediately',
    footBroken === true && bFoot.some((i) => i.clipped),
    JSON.stringify(bFoot.map((i) => `${i.clipped ? 'CLIPPED ' : ''}${i.txt.slice(0, 26)}`)));

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
