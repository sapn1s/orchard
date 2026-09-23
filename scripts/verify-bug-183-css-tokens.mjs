/**
 * BUG-183 — a CSS custom property that is REFERENCED but never DEFINED fails
 * silently: the whole declaration is invalid at computed-value time, so the
 * property simply does not apply. There is no console error, no lint, and — for
 * `outline: 2px solid var(--accent)` — no focus ring at all. Three shipped:
 *
 *   1. .gsel / .gtext / .gbtn were written against FIVE tokens that have never
 *      existed in this codebase (--ink-1, --bg-2, --line-1, --line-2, --accent).
 *      The global model picker, the custom-model field and EVERY input in the
 *      FEAT-145 add-account OAuth flow therefore had no visible focus ring and
 *      no background — that flow was keyboard-unusable.
 *   2. --warn was never defined; every call site read `var(--warn, #B0703C)`,
 *      so the light-mode hex shipped unchanged onto the dark surface.
 *   3. --focus was never defined (one call site, `var(--focus, var(--ink-4))`).
 *   (+ --danger, --accent and two raw #B0703C literals, found by the sweep below.)
 *
 *   node scripts/verify-bug-183-css-tokens.mjs            # audit the committed CSS
 *   node scripts/verify-bug-183-css-tokens.mjs --pre-fix  # synthesize the OLD
 *                                                         # rules and prove the
 *                                                         # guard bites
 *
 * PROOF SHAPE. Four blocks, three of which measure the REAL public/styles.css
 * cascade in headless Brave over CDP (the harness is lifted from
 * verify-bug-101-contrast.mjs — same static server, same minimal CDP client, no
 * server/registry boot, because the defect is purely in the resolved stylesheet):
 *
 *   A. SWEEP (static, and the assertion that stops the class recurring) — every
 *      `var(--token)` in public/styles.css must have a definition. Comments are
 *      stripped first, or a token merely NAMED in prose reads as a use. Offenders
 *      are LISTED, not just counted.
 *   B. THEME-BLOCK PARITY (static) — the file has FOUR theme declaration blocks
 *      (`:root`, `@media (prefers-color-scheme: dark) :root`,
 *      `:root[data-theme="dark"]`, `:root[data-theme="light"]`). Missing one is
 *      literally the bug class here, so every per-theme token must appear in all
 *      four. ALIASES are exempt by construction and the exemption is derived, not
 *      hand-listed: a declaration whose value is a bare `var(...)` follows the
 *      active theme through the token it names and cannot drift, so declaring it
 *      once in `:root` is correct (CONVENTIONS.md / ARCH-010).
 *   C. TOKENS RESOLVE, all four theme paths — system-light, system-dark (both via
 *      Emulation.setEmulatedMedia, no attribute), `data-theme="dark"` and
 *      `data-theme="light"` (each with the OPPOSITE media emulated, so the
 *      attribute is proven to win). Each token is read two ways: its computed
 *      value on :root, AND a probe element painted `var(--token, SENTINEL)` whose
 *      rendered colour exposes a fallback that fired.
 *   D. FOCUS RINGS, both themes — the real add-account / picker markup as
 *      drawer.js emits it, with :focus-visible FORCED via CDP CSS.forcePseudoState
 *      (programmatic .focus() does not reliably match :focus-visible on <select>
 *      and <button> in Chromium, which would make this test lie). Each control
 *      must show a ring that is present, has non-zero width, is not transparent,
 *      and clears WCAG 1.4.11's 3:1 against the ground it is drawn on.
 *
 * MUST-FAIL TWIN (--pre-fix): the pre-fix state is SYNTHESIZED INLINE — the old
 * rule text re-declared in a <style>, plus `--warn/--focus/--danger: initial`,
 * which is the one value that genuinely un-defines a custom property. It is NOT
 * anchored to git HEAD or any moving revision (CONVENTIONS.md, "a must-FAIL proof
 * must not be anchored to a moving baseline"), so it keeps biting after the fix
 * lands. In that mode every section must REPORT failures; a clean run is the
 * error.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';

const PRE_FIX = process.argv.includes('--pre-fix');
const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const CSS_PATH = path.join(PUBLIC, 'styles.css');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b183-chrome-'));
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';
const RING_MIN = 3;          // WCAG 1.4.11 non-text contrast, for a focus indicator
const SENTINEL = 'rgb(255, 0, 255)';   // magenta: only ever painted by a fallback

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (s, n) => String(s).padEnd(n);

// ── the exact pre-fix rule text, transcribed. Nothing here reads the repo. ────
const PRE_FIX_CSS = `
  :root, :root[data-theme="light"], :root[data-theme="dark"] {
    --warn: initial; --focus: initial; --danger: initial;
  }
  .gsel {
    width: 100%; margin-top: 6px; padding: 7px 9px;
    font: inherit; font-size: 13px; color: var(--ink-1);
    background: var(--bg-2); border: 1px solid var(--line-1); border-radius: 7px;
  }
  .gsel:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .gtext {
    font: inherit; font-size: 13px; font-family: var(--mono); color: var(--ink-1);
    background: var(--bg-2); border: 1px solid var(--line-1); border-radius: 7px;
  }
  .gtext:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .gbtn {
    flex: none; padding: 7px 12px;
    font: inherit; font-size: 12.5px; color: var(--ink-1);
    background: var(--bg-2); border: 1px solid var(--line-1); border-radius: 7px;
  }
  .gbtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .modelfree-set:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .seal .perm:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--focus); }
`;
// The pre-fix .gsel/.gtext/.gbtn source, for the SWEEP's own must-FAIL (A).
const PRE_FIX_SWEEP_SAMPLE = PRE_FIX_CSS;

/*
 * B's must-FAIL cannot come from the injection above: a <style> cannot desync the
 * four theme blocks in the file on disk, so running B against the real sheet in
 * --pre-fix mode would (correctly) pass and prove nothing. So B gets its own
 * SELF-CONTAINED broken fixture — a fixed baseline that names nothing in the repo
 * and therefore cannot stop biting when the real file changes. It carries exactly
 * the two defects B exists to catch:
 *   1. --warn declared in three of the four theme blocks (the BUG-183 bug class);
 *   2. --focus declared as a :root alias AND re-declared per theme (two places
 *      able to hold different answers — the ARCH-010 violation the alias exemption
 *      would otherwise let through).
 */
const DESYNC_FIXTURE = `
:root { --ink-2: #535755; --warn: #B0703C; --focus: var(--ink-2); }
@media (prefers-color-scheme: dark) { :root { --ink-2: #9AA29C; --warn: #C89A6A; --focus: #9AA29C; } }
:root[data-theme="dark"] { --ink-2: #9AA29C; --focus: #9AA29C; }
:root[data-theme="light"] { --ink-2: #535755; --warn: #B0703C; --focus: #535755; }
.x { color: var(--warn); outline-color: var(--focus); }
`;

/* ───────────────────────── A + B: static analysis ───────────────────────── */

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every custom property DEFINED anywhere in the sheet. */
function definedProps(css) {
  const out = new Map();  // name -> count
  for (const m of stripComments(css).matchAll(/(^|[;{\s])(--[A-Za-z0-9_-]+)\s*:/g)) {
    out.set(m[2], (out.get(m[2]) ?? 0) + 1);
  }
  return out;
}

/** Every `var(--token)` USED, with the line numbers it is used on. */
function usedProps(css) {
  const lines = stripComments(css).split('\n');
  const out = new Map();
  lines.forEach((l, i) => {
    for (const m of l.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
      if (!out.has(m[1])) out.set(m[1], []);
      out.get(m[1]).push(i + 1);
    }
  });
  return out;
}

/** Extract the body of a top-level block whose selector text matches `pred`. */
function blocks(css) {
  const src = stripComments(css);
  const found = [];
  // `:root` variants at top level, plus the one nested inside the dark media query.
  const pats = [
    ['root(light)', /(^|\})\s*:root\s*\{([^}]*)\}/],
    ['media(dark) :root', /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/],
    ['[data-theme="dark"]', /:root\[data-theme="dark"\]\s*\{([^}]*)\}/],
    ['[data-theme="light"]', /:root\[data-theme="light"\]\s*\{([^}]*)\}/],
  ];
  for (const [name, re] of pats) {
    const m = src.match(re);
    if (!m) { found.push({ name, body: null }); continue; }
    found.push({ name, body: m[m.length - 1] });
  }
  return found;
}

/** name -> value for the custom properties declared in one block body. */
function declsOf(body) {
  const out = new Map();
  for (const m of body.matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
}

function runSweep(css, label) {
  const defs = definedProps(css);
  const uses = usedProps(css);
  const offenders = [...uses.entries()].filter(([t]) => !defs.has(t));
  console.log(`\n  A. SWEEP — every var(--token) in ${label} must be DEFINED somewhere in the sheet.`);
  console.log(`     ${defs.size} properties defined, ${uses.size} distinct tokens used.`);
  for (const [tok, lns] of offenders) {
    console.log(`     UNDEFINED  ${pad(tok, 18)} used on line(s) ${lns.slice(0, 12).join(', ')}${lns.length > 12 ? ` (+${lns.length - 12} more)` : ''}`);
  }
  if (!offenders.length) console.log('     pass — no undefined token is referenced.');
  return offenders;
}

function runParity(css, label) {
  const bs = blocks(css);
  console.log(`\n  B. THEME-BLOCK PARITY — in ${label}, a per-theme token must be declared in ALL FOUR blocks.`);
  const missingBlocks = bs.filter((b) => b.body === null).map((b) => b.name);
  if (missingBlocks.length) {
    console.log(`     FAIL — theme block(s) not found in the sheet: ${missingBlocks.join(', ')}`);
    return [`theme block(s) missing: ${missingBlocks.join(', ')}`];
  }
  const maps = bs.map((b) => ({ name: b.name, decls: declsOf(b.body) }));
  const base = maps[0].decls;   // :root is the superset by construction
  // An ALIAS — value is a bare var(...) — follows the active theme through the
  // token it names, so declaring it once in :root is correct and it is exempt.
  const isAlias = (v) => /^var\(\s*--[A-Za-z0-9_-]+\s*\)$/.test(v);
  const aliases = [...base.entries()].filter(([, v]) => isAlias(v)).map(([k]) => k);
  // Structural/typographic tokens live only in :root and never vary by theme;
  // the parity set is "declared in at least one NON-:root theme block".
  const themed = new Set();
  for (const m of maps.slice(1)) for (const k of m.decls.keys()) themed.add(k);
  const fails = [];
  console.log(`     aliases exempt (declared once in :root, resolve through a themed token): ${aliases.join(', ') || '(none)'}`);
  for (const tok of [...themed].sort()) {
    if (aliases.includes(tok)) {
      fails.push(`${tok} is declared as a :root alias AND re-declared in a theme block — two places can now hold different answers`);
      console.log(`     FAIL ${pad(tok, 18)} alias re-declared per theme`);
      continue;
    }
    const absent = maps.filter((m) => !m.decls.has(tok)).map((m) => m.name);
    if (absent.length) {
      fails.push(`${tok} is missing from ${absent.join(', ')} — the theme blocks are out of sync`);
      console.log(`     FAIL ${pad(tok, 18)} missing from ${absent.join(', ')}`);
    } else {
      console.log(`     pass ${pad(tok, 18)} present in all four`);
    }
  }
  return fails;
}

/* ─────────────────────── C + D: the real browser ────────────────────────── */

// Real markup, as public/lib/drawer.js emits it (renderAccounts / renderModelPickers
// / the FEAT-145 login panel), so the cascade under test is the shipped one.
const TARGETS = [
  { name: '.gsel  global model picker', sel: '#gModelSel', ring: 'outline' },
  { name: '.gtext custom model id', sel: '#gModelCustomInput', ring: 'outline' },
  { name: '.gbtn  custom model Set', sel: '#gModelCustomApply', ring: 'outline' },
  { name: '.gtext add-account label', sel: '#gAcctLabel', ring: 'outline', acct: true },
  { name: '.gbtn  add-account Add', sel: '#gAcctCreate', ring: 'outline', acct: true },
  { name: '.gtext OAuth sign-in URL', sel: '#gAcctUrl', ring: 'outline', acct: true },
  { name: '.gbtn  OAuth Copy', sel: '#gAcctCopy', ring: 'outline', acct: true },
  { name: '.gtext OAuth code', sel: '#gAcctCode', ring: 'outline', acct: true },
  { name: '.gbtn  OAuth Send code', sel: '#gAcctCodeSend', ring: 'outline', acct: true },
  { name: '.modelfree-set', sel: '#mfSet', ring: 'outline' },
  { name: '.seal .perm (--focus)', sel: '#permChip', ring: 'box-shadow' },
];

// The tokens under test and what each theme path must resolve them to.
const THEMES = [
  { name: 'system-light', attr: null, media: 'light', warn: '#B0703C' },
  { name: 'system-dark', attr: null, media: 'dark', warn: '#C89A6A' },
  { name: 'attr-dark', attr: 'dark', media: 'light', warn: '#C89A6A' },
  { name: 'attr-light', attr: 'light', media: 'dark', warn: '#B0703C' },
];
const TOKENS = ['--warn', '--focus', '--danger'];

function harness() {
  const probes = TOKENS.map((t) =>
    `<span class="probe" data-tok="${t}" style="color: var(${t}, ${SENTINEL})">probe</span>`).join('');
  const pickers = `
    <div class="grp" style="background:var(--window);padding:10px;width:300px">
      <select class="gsel" id="gModelSel" aria-label="Global default model"><option>Opus</option></select>
      <div class="gcustom">
        <input type="text" class="gtext" id="gModelCustomInput" placeholder="model id">
        <button type="button" class="gbtn" id="gModelCustomApply">Set</button>
      </div>
      <div class="modelfree-row"><button type="button" class="modelfree-set" id="mfSet">Set</button></div>
    </div>`;
  const acct = `
    <div class="grp acctlist" style="background:var(--window);padding:10px;width:300px">
      <div class="acctadd">
        <input type="text" class="gtext" id="gAcctLabel" placeholder="Label for this account">
        <button type="button" class="gbtn" id="gAcctCreate">Add</button>
      </div>
      <div class="acctlogin">
        <a class="acctlink" href="#">Open the Claude sign-in page &#8599;</a>
        <input type="text" class="gtext mono" id="gAcctUrl" readonly value="https://example.invalid/oauth" aria-label="Claude sign-in URL">
        <button type="button" class="gbtn" id="gAcctCopy">Copy</button>
        <input type="text" class="gtext" id="gAcctCode" autocomplete="off" spellcheck="false" placeholder="code">
        <button type="button" class="gbtn" id="gAcctCodeSend">Send code</button>
      </div>
    </div>`;
  const perm = `<div class="seal" style="background:var(--window);padding:10px">
      <button type="button" class="perm" id="permChip"><span class="dot"></span>permissions</button>
    </div>`;
  const pre = PRE_FIX ? `<style id="prefix">${PRE_FIX_CSS}</style>` : '';
  return `<!doctype html><html><head><meta charset="utf-8">
    <link rel="stylesheet" href="/styles.css">${pre}
    <style>body{margin:0;background:var(--desk)}.probe{font-size:11px}</style>
    </head><body><div id="probes">${probes}</div>${pickers}${acct}${perm}</body></html>`;
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async connect(url) {
    const { default: WebSocket } = await import('ws');
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
  async waitFor(expr, timeoutMs = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) { try { if (await this.eval(expr)) return true; } catch { /* nav */ } await sleep(120); }
    return false;
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

// Reads the token values off :root AND off the probe spans, in the page.
const READ_TOKENS = (toks) => `((toks) => {
  const cs = getComputedStyle(document.documentElement);
  const out = [];
  for (const t of toks) {
    const probe = document.querySelector('.probe[data-tok="' + t + '"]');
    out.push({ token: t, declared: cs.getPropertyValue(t).trim(), painted: getComputedStyle(probe).color });
  }
  return out;
})(${JSON.stringify(toks)})`;

// Measures the focus indicator on each target, with the ring's contrast against
// the opaque ground it is drawn over.
const MEASURE_RINGS = (targets) => `((targets) => {
  const rgba = (c) => {
    if (!c || c === 'transparent' || c === 'none') return [0, 0, 0, 0];
    const n = (c.match(/[-\\d.]+(?:e[-+]?\\d+)?/gi) || []).map(Number);
    const isFn = /^color\\(/.test(c);
    const rgb = isFn ? n.slice(0, 3).map((v) => Math.round(v * 255)) : n.slice(0, 3);
    return [rgb[0], rgb[1], rgb[2], n.length > 3 ? n[3] : 1];
  };
  const over = (fg, bg) => { const a = fg[3]; return [0,1,2].map((i) => fg[i] * a + bg[i] * (1 - a)); };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const ratio = (a, b) => { const la = lum(a), lb = lum(b); const hi = Math.max(la, lb), lo = Math.min(la, lb); return +((hi + 0.05) / (lo + 0.05)).toFixed(2); };
  const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const ground = (el) => {
    let base = [255, 255, 255]; const stack = [];
    for (let n = el.parentElement; n; n = n.parentElement) {
      const c = rgba(getComputedStyle(n).backgroundColor);
      stack.push(c); if (c[3] === 1) break;
    }
    for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
    return base;
  };
  const theme = document.documentElement.dataset.theme || '(system)';
  const rows = [];
  for (const t of targets) {
    const el = document.querySelector(t.sel);
    if (!el) { rows.push({ theme, name: t.name, missing: true }); continue; }
    const cs = getComputedStyle(el);
    const g = ground(el);
    let present = false, width = 0, colour = 'none', kind = t.ring;
    if (t.ring === 'outline') {
      width = parseFloat(cs.outlineWidth) || 0;
      colour = cs.outlineColor;
      present = cs.outlineStyle !== 'none' && width > 0 && rgba(colour)[3] > 0;
    } else {
      const bs = cs.boxShadow;
      // 'none' means the whole declaration dropped (or was never applied).
      const m = bs && bs !== 'none' ? bs.match(/(rgba?\\([^)]*\\)|#[0-9a-f]{3,8})/i) : null;
      const spread = bs && bs !== 'none' ? (bs.match(/(-?[\\d.]+)px/g) || []).map(parseFloat) : [];
      width = spread.length ? Math.max(...spread.map(Math.abs)) : 0;
      colour = m ? m[1] : 'none';
      present = !!m && width > 0 && rgba(colour)[3] > 0;
    }
    const ringPx = present ? over(rgba(colour), g) : g;
    rows.push({
      theme, name: t.name, kind, present, width,
      colour, ring: hex(ringPx), ground: hex(g), contrast: ratio(ringPx, g),
      fill: getComputedStyle(el).backgroundColor, ink: getComputedStyle(el).color,
    });
  }
  return rows;
})(${JSON.stringify(targets)})`;

let server = null, browser = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  // Kill the PROCESS GROUP, so no renderer/zygote child outlives the run.
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ } }
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 1500).unref();
}

async function main() {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  console.log(`\nBUG-183 — undefined CSS custom properties. Mode: ${PRE_FIX ? 'PRE-FIX (old rules synthesized inline)' : 'committed CSS'}`);

  // ── A. the sweep ──────────────────────────────────────────────────────────
  // In --pre-fix mode the sweep is run against the SYNTHESIZED pre-fix source,
  // never against a git revision — the baseline must not move when the fix lands.
  const sweepSrc = PRE_FIX ? PRE_FIX_SWEEP_SAMPLE : css;
  const sweepFails = runSweep(sweepSrc, PRE_FIX ? 'the synthesized PRE-FIX rules' : 'public/styles.css');

  // ── B. theme-block parity ─────────────────────────────────────────────────
  const parityFails = PRE_FIX
    ? runParity(DESYNC_FIXTURE, 'the synthesized DESYNCED fixture')
    : runParity(css, 'public/styles.css');

  // ── browser ───────────────────────────────────────────────────────────────
  server = http.createServer((req, res) => {
    if (req.url === '/styles.css') {
      res.setHeader('content-type', 'text/css');
      res.end(fs.readFileSync(CSS_PATH));
    } else { res.setHeader('content-type', 'text/html'); res.end(harness()); }
  });
  const PORT = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const BASE = `http://127.0.0.1:${PORT}`;

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--window-size=700,900', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let devPort = 0;
  for (let i = 0; i < 80 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(200); }
  }
  if (!devPort) throw new Error('brave never exposed a devtools port');
  const list = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const tab = await Cdp.connect(list.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await tab.send('Page.enable');
  await tab.send('DOM.enable');
  await tab.send('CSS.enable');
  await tab.send('Page.navigate', { url: BASE });
  const ready = await tab.waitFor(`!!document.getElementById('gAcctCode')`);
  if (!ready) throw new Error('harness never rendered — refusing to report a pass');

  // Force :focus-visible on every target. A programmatic .focus() does NOT match
  // :focus-visible on <select>/<button> in Chromium, so measuring after .focus()
  // would report "no ring" for correct CSS — a check that lies in both directions.
  const { root } = await tab.send('DOM.getDocument', { depth: 1 });
  for (const t of TARGETS) {
    const { nodeId } = await tab.send('DOM.querySelector', { nodeId: root.nodeId, selector: t.sel });
    if (!nodeId) throw new Error(`harness target missing: ${t.sel}`);
    await tab.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['focus', 'focus-visible'] });
  }

  const tokenRows = [];
  const ringRows = [];
  for (const th of THEMES) {
    await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: th.media }] });
    await tab.eval(th.attr
      ? `document.documentElement.dataset.theme = ${JSON.stringify(th.attr)}`
      : `delete document.documentElement.dataset.theme`);
    await sleep(120);
    for (const r of await tab.eval(READ_TOKENS(TOKENS))) tokenRows.push({ path: th.name, expectWarn: th.warn, ...r });
    // Rings are a light/dark property, measured on both real theme paths.
    for (const r of await tab.eval(MEASURE_RINGS(TARGETS))) ringRows.push({ path: th.name, ...r });
  }
  tab.close();

  // ── C. tokens resolve, all four theme paths ───────────────────────────────
  const tokFails = [];
  console.log('\n  C. TOKEN RESOLUTION — all four theme paths. `painted` is a probe span coloured');
  console.log(`     var(--token, ${SENTINEL}); the sentinel showing means the token is UNDEFINED and the`);
  console.log('     literal fallback is what ships.\n');
  console.log(`     ${pad('theme path', 14)}${pad('token', 10)}${pad('declared', 12)}${pad('painted', 20)}verdict`);
  for (const r of tokenRows) {
    const resolved = r.declared !== '' && r.painted !== SENTINEL;
    let note = resolved ? 'resolves' : 'UNDEFINED — fallback shipped';
    if (r.token === '--warn' && resolved) {
      const want = r.expectWarn.toLowerCase();
      const got = r.declared.toLowerCase();
      if (got !== want) { note = `WRONG VALUE — expected ${r.expectWarn} on this path`; tokFails.push(`${r.path}: --warn is ${r.declared}, expected ${r.expectWarn}`); }
      else note = `resolves, theme-correct (${r.expectWarn})`;
    }
    if (!resolved) tokFails.push(`${r.path}: ${r.token} is undefined (probe painted the ${SENTINEL} fallback)`);
    console.log(`     ${resolved && !note.startsWith('WRONG') ? 'pass ' : 'FAIL '}${pad(r.path, 14)}${pad(r.token, 10)}${pad(r.declared || '(empty)', 12)}${pad(r.painted, 20)}${note}`);
  }
  // The adapt assertion: a token that merely "resolves" could still be one
  // hardcoded value. --warn must DIFFER between light and dark.
  const lw = tokenRows.find((r) => r.path === 'system-light' && r.token === '--warn')?.declared;
  const dw = tokenRows.find((r) => r.path === 'system-dark' && r.token === '--warn')?.declared;
  const adapts = lw && dw && lw !== dw;
  if (!adapts) tokFails.push(`--warn does not adapt: light ${lw || '(empty)'} === dark ${dw || '(empty)'}`);
  console.log(`     ${adapts ? 'pass ' : 'FAIL '}--warn ADAPTS across themes: light ${lw || '(empty)'} vs dark ${dw || '(empty)'}`);

  // ── D. focus rings ────────────────────────────────────────────────────────
  const ringFails = [];
  console.log('\n  D. FOCUS RINGS — :focus-visible forced via CDP, real drawer markup, both themes.');
  console.log(`     A ring must be PRESENT, non-zero width, non-transparent, and >= ${RING_MIN}:1 on its ground.\n`);
  console.log(`     ${pad('theme path', 14)}${pad('control', 28)}${pad('kind', 11)}${pad('w', 5)}${pad('ring', 10)}${pad('ground', 10)}contrast`);
  for (const r of ringRows.filter((x) => x.path === 'attr-light' || x.path === 'attr-dark')) {
    if (r.missing) { ringFails.push(`${r.path}: harness control missing — ${r.name}`); console.log(`     FAIL ${r.path} ${r.name} — NOT RENDERED`); continue; }
    const ok = r.present && r.contrast >= RING_MIN;
    if (!r.present) ringFails.push(`${r.path}: ${r.name} has NO focus ring (${r.kind} resolved to ${r.colour}, width ${r.width})`);
    else if (r.contrast < RING_MIN) ringFails.push(`${r.path}: ${r.name} focus ring is only ${r.contrast}:1 on ${r.ground} (needs >= ${RING_MIN})`);
    console.log(`     ${ok ? 'pass ' : 'FAIL '}${pad(r.path, 14)}${pad(r.name, 28)}${pad(r.kind, 11)}${pad(r.width, 5)}${pad(r.ring, 10)}${pad(r.ground, 10)}${r.present ? r.contrast : 'NO RING'}`);
  }
  // The .gsel/.gtext/.gbtn grounds must also have actually applied — a transparent
  // background is what --bg-2 produced, and is invisible to a ring-only check.
  console.log('');
  for (const r of ringRows.filter((x) => x.path === 'attr-dark' && /^\.(gsel|gtext|gbtn)/.test(x.name))) {
    const opaque = !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(r.fill);
    if (!opaque) ringFails.push(`${r.path}: ${r.name} has no background (${r.fill}) — its ground token did not apply`);
    console.log(`     ${opaque ? 'pass ' : 'FAIL '}${pad(r.path, 14)}${pad(r.name, 28)}background ${r.fill}, ink ${r.ink}`);
  }

  // ── verdict ───────────────────────────────────────────────────────────────
  const all = [
    ['A sweep', sweepFails.map(([t, l]) => `${t} used on line(s) ${l.join(',')} but never defined`)],
    ['B parity', parityFails],
    ['C tokens', tokFails],
    ['D rings', ringFails],
  ];
  const total = all.reduce((n, [, f]) => n + f.length, 0);
  if (PRE_FIX) {
    // Every section must bite. A pre-fix run that passes proves nothing.
    const silent = all.filter(([, f]) => !f.length).map(([n]) => n);
    console.log('');
    if (silent.length) {
      console.log(`  UNEXPECTED — section(s) ${silent.join(', ')} reported nothing against the pre-fix rules; the guard does not bite there.`);
      process.exitCode = 1;
    } else {
      console.log(`  EXPECTED — the guard bites: ${total} finding(s) against the synthesized pre-fix state.`);
      for (const [n, f] of all) for (const x of f) console.log(`    ${n}: ${x}`);
    }
  } else if (total) {
    console.log('');
    for (const [n, f] of all) for (const x of f) console.log(`  FAILURE — ${n}: ${x}`);
    console.log(`\n  ${total} failure(s).`);
    process.exitCode = 1;
  } else {
    console.log('\n  ALL PASS — no undefined token is referenced; the four theme blocks are in sync;');
    console.log('  --warn/--focus/--danger resolve (and --warn adapts) on all four theme paths; and every');
    console.log('  picker / add-account control shows a visible, AA-clearing focus ring in both themes.');
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  stopByPid(browser);
  try { server?.close(); } catch { /* gone */ }
  // WAIT for the browser to actually exit before removing its profile: rm'ing it
  // out from under a live Chromium leaves the dir re-created and the run litters
  // /tmp (six of them, measured, before this wait was added).
  if (browser && browser.exitCode === null) {
    await Promise.race([new Promise((r) => browser.once('exit', r)), sleep(4000)]);
  }
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* best effort */ }
});
