/**
 * BUG-101 — the muted ink tokens must clear WCAG AA (4.5:1) against every
 * surface they actually render TEXT on, in BOTH themes — so a contrast
 * regression cannot slip past the DOM-only functional suites again (three did
 * this session; each was found only by measuring rendered pixels).
 *
 *   node scripts/verify-bug-101-contrast.mjs           # audit the committed CSS
 *   node scripts/verify-bug-101-contrast.mjs --pre-fix # inject the OLD hexes to
 *                                                        # prove the guard bites
 *
 * SCOPE, widened (FEAT-090 round 2): this file used to audit TOKEN × SURFACE
 * pairs only — colour variables against page grounds. That is blind to the thing
 * a control actually renders: a FILL. The FEAT-090 "Record answer" button shipped
 * green through this guard at 2.87:1, because its `opacity:.45` disabled state
 * composited a token pair that measures 15.9:1 down to a grey slab under a
 * white label — a pixel that no token×surface pair describes. So the guard now
 * also measures rendered CONTROLS (see CONTROLS + --pre-fix5).
 *
 * Four must-FAIL modes, each pinning a defect that once shipped green (or, for
 * --pre-fix4, that the guard itself could not see): --pre-fix (the pre-BUG-101
 * hexes, 16 AA failures), --pre-fix2 (rail + footer-separator ranks re-broken),
 * --pre-fix3 (the fix2 eyebrow inversion + the over-corrected 1.86:1 FYI rail),
 * --pre-fix4 (light's eyebrow ladder fully reversed — invisible to adjacent-pair
 * comparison, caught now by the cumulative span check + a per-theme tolerance).
 *
 * It renders the REAL public/styles.css cascade in headless Brave over CDP —
 * a token×surface swatch matrix AND the real composer-footer markup (`.fine`
 * with its `.fine-run` transient count) — then reads getComputedStyle pixels
 * and computes the true contrast ratio. No server/registry boot: the defect is
 * purely in the stylesheet's resolved colours, so a static harness that links
 * the real /styles.css exercises exactly the cascade that ships.
 *
 * AUDITED PAIRS (must be >= 4.5:1): --ink, --ink-2, --ink-3, --ink-4 on the
 * three surfaces those tokens carry small informational text — --window,
 * --rail, --sunken — plus the live footer label (--ink-3) and transient count
 * (--ink-4). EXEMPT (not asserted, documented in the ticket): --hair/--hair-2/
 * --desk (no read-critical muted text renders there — a hovered/current row
 * promotes its text to --ink; --desk is the bare desktop); and --ink-4 as
 * borders/dots/dividers/ornament glyphs / disabled-state text (WCAG 1.4.3/1.4.11
 * incidental & inactive-component exemptions), and the moss "alive" dot.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';

const PRE_FIX = process.argv.includes('--pre-fix');
const PRE_FIX2 = process.argv.includes('--pre-fix2');
const PRE_FIX3 = process.argv.includes('--pre-fix3');
const PRE_FIX4 = process.argv.includes('--pre-fix4');
const PRE_FIX5 = process.argv.includes('--pre-fix5');
const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b101-chrome-'));
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';
const THRESHOLD = 4.5;

// The OLD (pre-fix) failing values — injected only in --pre-fix mode to prove
// the guard reports the known failures rather than silently passing.
const OLD = {
  light: { 'ink-2': '#5A625E', 'ink-3': '#8C948F', 'ink-4': '#AEB5B0' },
  dark:  { 'ink-3': '#737B76', 'ink-4': '#565D58' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The audited pairs: token on each real text surface, both themes.
const TOKENS = ['ink', 'ink-2', 'ink-3', 'ink-4'];
const SURFACES = ['window', 'rail', 'sunken'];

function harness() {
  const cells = [];
  for (const t of TOKENS) for (const s of SURFACES) {
    cells.push(`<div class="surf" data-bg="${s}" style="background:var(--${s})">`
      + `<span class="tok" data-tok="${t}" data-bg="${s}" style="color:var(--${t})">Aa 09 · path/to</span></div>`);
  }
  // Real footer markup: the stable label (.fine → --ink-3) + the transient count
  // (.fine-run → --ink-4) on the composer's --window ground, exactly as sayIso
  // renders it.
  const footer = `<div style="background:var(--window);padding:10px">`
    + `<div class="fine" id="realfine">Direct <span class="fine-sep">·</span> full access to this machine`
    + `<span class="fine-run"> 2 agents running</span></div></div>`;
  // BUG-101 fix2 — the RANKING harness (asserted separately from the 28 AA pairs,
  // below): the digest's four kind rails, whose weights must descend with
  // importance, and the footer's two separators, where the accent dot marks the
  // MAJOR break between two facts and the `·` a MINOR break inside one label.
  const rails = `<div class="digest" id="realdigest">`
    + ['decision', 'in-flight', 'done', 'fyi'].map((k) =>
        `<div class="digest-group digest-${k}" data-kind="${k}"><div class="digest-group-label">${k}</div>`
        + `<ul class="digest-items"><li class="digest-item imp-med">item</li></ul></div>`).join('')
    + `</div>`;
  // FEAT-090 round 2 — the real INTERACTIVE CONTROLS, in their real markup, on
  // their real ground: the Decide card's primary (enabled AND disabled), the
  // segmented secondary (selected + idle), the option rows (plain / annotated
  // "Recommended" / checked), the note field, the recommendation line, the
  // narrow pinned bar's primary, and the app's own primary (.tv-btn.solid) which
  // the card's primary must MATCH — the new card's main action reading weaker
  // than the note form it supersedes was half of the same defect.
  const controls = `<div id="realctl" style="background:var(--window);padding:12px;width:300px">
    <div class="tv-decide">
      <div class="dc-rec"><span class="dc-rec-k">Recommends B</span> decide later instead of on the spot</div>
      <div class="dc-seg"><button class="dc-seg-b on" data-ctl="segmented-selected">Decide</button><button class="dc-seg-b" data-ctl="segmented-idle">Ask a question</button></div>
      <div class="dc-opts">
        <label class="dc-opt"><input type="radio" name="g"><span class="dc-mid"><span class="dc-label"><span class="dc-k">A</span><span class="dc-lt">fix the root cause</span></span><span class="dc-desc">Rework turn-end so parentage is always known.</span></span></label>
        <label class="dc-opt is-rec"><input type="radio" name="g"><span class="dc-mid"><span class="dc-rec-tag">Recommended</span><span class="dc-label"><span class="dc-k">B</span><span class="dc-lt">decide later instead of on the spot</span></span></span></label>
        <label class="dc-opt" id="ctlpicked"><input type="radio" name="g" checked><span class="dc-mid"><span class="dc-label"><span class="dc-k">C</span><span class="dc-lt">accept the risk</span></span></span></label>
      </div>
      <textarea class="dc-note" rows="2">B, but ship D first</textarea>
      <button class="dc-send solid" data-ctl="primary-enabled">Record answer</button>
      <button class="dc-send solid" data-ctl="primary-disabled" disabled>Record answer</button>
    </div>
    <div class="tv-decide-bar" style="position:static"><span class="tdb-rec">Recommends B</span><button class="tdb-open solid" data-ctl="pinned-primary">Answer</button></div>
    <button class="tv-btn solid" data-ctl="app-primary">Append note</button>
  </div>`;
  // --pre-fix5: the FIFTH known-bad state — the one that shipped past this very
  // guard. Restores FEAT-090's `opacity:.45` disabled primary, which composites
  // to #949795 under a white label (2.87:1) in light and to #757874 in dark,
  // where it was the BRIGHTEST fill on the page. Proves the control assertions
  // bite: a token-pair audit cannot see either number.
  const preFix5Style = PRE_FIX5 ? `<style id="prefix5">
    .dc-send:disabled { background: var(--solid); color: var(--on-solid); border-color: var(--solid); opacity: .45; }
  </style>` : '';
  const preFixStyle = PRE_FIX ? `<style id="prefix">
    :root, :root[data-theme="light"] { ${Object.entries(OLD.light).map(([k, v]) => `--${k}:${v};`).join('')} }
    :root[data-theme="dark"] { ${Object.entries(OLD.dark).map(([k, v]) => `--${k}:${v};`).join('')} }
    /* in that epoch the footer's tones came straight off the global ladder */
    :root[data-theme] .fine { --fine-run-ink: var(--ink-4); --fine-sep: var(--ink-3); --fine-dot: var(--live); }
  </style>` : '';
  // --pre-fix2: the SECOND known-bad state — every value cleared AA, but the
  // ranks were wrong (the quietest token doing double duty as text AND
  // structure inflated the FYI rail into the loudest mark on the card; the
  // footer's minor `·` out-shouted the major accent dot). Proves the ranking
  // assertions bite, not just the floors.
  const preFix2Style = PRE_FIX2 ? `<style id="prefix2">
    :root, :root[data-theme="light"], :root[data-theme="dark"] { --ink-4-struct: var(--ink-4); }
    :root[data-theme] .digest { --dg-rail-dec: var(--st-needs); --dg-rail-fyi: var(--ink-4); }
    .digest { --dg-rail-dec: var(--st-needs); --dg-rail-fyi: var(--ink-4); }
    :root[data-theme] .fine { --fine-run-ink: var(--ink-4); --fine-sep: var(--ink-3); --fine-dot: var(--live); }
  </style>` : '';
  // --pre-fix3: the THIRD known-bad state — the state fix2 shipped. Its rails
  // ranked correctly, so the guard passed; the SAME inversion had simply moved
  // into the channel nobody asserted. Restores the fix2 eyebrow grounds (all
  // four off the plain global --ink-2, plus the BUG-098 pin) — which put FYI at
  // 6.53 (loudest) and DECISIONS at 4.67 (faintest) — and the over-corrected
  // 1.86:1 FYI rail. Proves the eyebrow ranking AND the rail-floor assertions
  // bite. Light only: dark was correct in fix2 and is untouched.
  const preFix3Style = PRE_FIX3 ? `<style id="prefix3">
    :root[data-theme="light"] .digest {
      --dg-eye-dec-ground: #494C4A;
      --dg-eye-prog-ground: var(--ink-2);
      --dg-eye-done-ground: var(--ink-2);
      --dg-eye-fyi-ground: var(--ink-2);
      --dg-rail-fyi: var(--ink-4-struct);
    }
  </style>` : '';
  // --pre-fix4: the FOURTH known-bad state — not one that ever shipped, but the
  // BLIND SPOT a reviewer proved in the fix3 guard itself. The eyebrow channel
  // compared ADJACENT PAIRS only, at tol 0.35, while light's shipped eyebrow
  // steps are 0.30 / 0.16 / 0.28 — every step SMALLER than the tolerance. So a
  // fully REVERSED light eyebrow ladder (4.75 / 5.03 / 5.19 / 5.49, today's
  // values exactly inverted) slid through adjacent-pair checking untouched: the
  // guard caught the round-2 defect only because that inversion happened to be
  // 1.78 wide. Reversal is expressed by handing each light group the MIRROR
  // kind's eyebrow colour, so the measured ratios reproduce the reviewer's
  // demonstration exactly. Caught now by the per-theme tolerance (light 0.15)
  // AND, independently, by the cumulative first-vs-last span check.
  const preFix4Style = PRE_FIX4 ? `<style id="prefix4">
    :root[data-theme="light"] .digest-decision  .digest-group-label { color: var(--dg-eye-fyi-ground); }
    :root[data-theme="light"] .digest-in-flight .digest-group-label { color: color-mix(in srgb, var(--st-done) 60%, var(--dg-eye-done-ground)); }
    :root[data-theme="light"] .digest-done      .digest-group-label { color: color-mix(in srgb, var(--st-prog) 60%, var(--dg-eye-prog-ground)); }
    :root[data-theme="light"] .digest-fyi       .digest-group-label { color: color-mix(in srgb, var(--st-needs) 60%, var(--dg-eye-dec-ground)); }
  </style>` : '';
  return `<!doctype html><html><head><meta charset="utf-8">
    <link rel="stylesheet" href="/styles.css">${preFixStyle}${preFix2Style}${preFix3Style}${preFix4Style}${preFix5Style}
    <style>body{margin:0}.surf{padding:6px}.tok{font-size:10.5px;font-family:var(--mono)}</style>
    </head><body>${cells.join('')}${footer}${rails}${controls}</body></html>`;
}

// CDP minimal client (same shape as verify-bug-100-footer-label).
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

// The measuring routine runs IN the page: parse rgb, compute WCAG contrast from
// the true rendered pixels (getComputedStyle), against the resolved surface bg.
const MEASURE = `(() => {
  const parse = (c) => c.match(/[\\d.]+/g).slice(0, 3).map(Number);
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const ratio = (a, b) => { const la = lum(parse(a)), lb = lum(parse(b)); const hi = Math.max(la, lb), lo = Math.min(la, lb); return (hi + 0.05) / (lo + 0.05); };
  const theme = document.documentElement.dataset.theme;
  const rows = [];
  for (const el of document.querySelectorAll('.tok')) {
    const fg = getComputedStyle(el).color;
    const bg = getComputedStyle(el.parentElement).backgroundColor;
    rows.push({ theme, token: el.dataset.tok, surface: el.dataset.bg, ratio: +ratio(fg, bg).toFixed(2), fg, bg });
  }
  // Live footer: the label (.fine) and the transient count (.fine-run) on window.
  const fine = document.getElementById('realfine');
  const run = fine.querySelector('.fine-run');
  const fbg = getComputedStyle(fine.parentElement).backgroundColor;
  rows.push({ theme, token: 'footer-label(.fine)', surface: 'window', ratio: +ratio(getComputedStyle(fine).color, fbg).toFixed(2), fg: getComputedStyle(fine).color, bg: fbg });
  rows.push({ theme, token: 'footer-count(.fine-run)', surface: 'window', ratio: +ratio(getComputedStyle(run).color, fbg).toFixed(2), fg: getComputedStyle(run).color, bg: fbg });
  return rows;
})()`;

/*
 * The ORDERING measurement. Contrast floors alone cannot catch what broke here:
 * every value was above AA, but the RANK order was wrong — the lowest-importance
 * rail had become the heaviest mark on the card, and the minor separator
 * out-shouted the major one. Rank is the invariant, so rank is what we assert.
 *
 * BUG-101 fix3 — asserted for EVERY channel that varies by group, not just the
 * one that last broke. Rounds 1–3 were one defect wearing three costumes: the
 * ranking was hand-tuned per channel, so fixing the asserted channel simply
 * pushed the inversion into an unasserted one (round 2 fixed the rails; the
 * eyebrows inverted the same way and shipped green).
 *
 * BUG-101 fix4 — asserted CUMULATIVELY as well as pairwise. Asserting a channel
 * is not enough if the assertion is blind at the amplitude the channel actually
 * ships at: adjacent-pair comparison with a tolerance wider than the step size
 * cannot detect a gradual inversion. See the CHANNELS block below.
 *
 * The full channel audit of the digest card — every property that differs
 * between .digest-decision / -in-flight / -done / -fyi:
 *   1. RAIL   — .digest-group border-left-color  (--dg-rail-dec / --st-prog /
 *               --st-done / --dg-rail-fyi)                     ← asserted
 *   2. EYEBROW — .digest-group-label color (kind hue 60% over the
 *               --dg-eye-*-ground ladder)                      ← asserted
 * Everything else on the card is INVARIANT across groups and therefore cannot
 * encode a ranking: the rail WIDTH (2px), group padding, the group divider
 * (--hair) and item rule (--dg-item-rule), the eyebrow's size/weight/tracking/
 * transform, the card ground (--sunken), and the group's DOM order (fixed
 * KIND_ORDER in public/lib/digest.js — positional, not a weight). The item ink
 * tiers (imp-high/med/low) vary by ITEM importance, not by group, and are
 * covered by the BUG-095 ladder. If a third group-varying channel is ever
 * added, add it to CHANNELS here — that is the point of this block.
 */
const ORDER = `(() => {
  const parse = (c) => { const v = c.match(/[\\d.]+/g).slice(0,3).map(Number); return /^color\\(/.test(c) ? v.map((x) => Math.round(x * 255)) : v; };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const ratio = (a, b) => { const la = lum(parse(a)), lb = lum(parse(b)); const hi = Math.max(la, lb), lo = Math.min(la, lb); return +((hi + 0.05) / (lo + 0.05)).toFixed(2); };
  const theme = document.documentElement.dataset.theme;
  const card = document.getElementById('realdigest');
  const cbg = getComputedStyle(card).backgroundColor;
  const rails = {}, eyebrows = {};
  for (const g of card.querySelectorAll('.digest-group')) {
    rails[g.dataset.kind] = ratio(getComputedStyle(g).borderLeftColor, cbg);
    eyebrows[g.dataset.kind] = ratio(getComputedStyle(g.querySelector('.digest-group-label')).color, cbg);
  }
  const fine = document.getElementById('realfine');
  const fbg = getComputedStyle(fine.parentElement).backgroundColor;
  const sep = {
    minor: ratio(getComputedStyle(fine.querySelector('.fine-sep')).color, fbg),
    major: ratio(getComputedStyle(fine.querySelector('.fine-run'), '::before').color, fbg),
  };
  return { theme, rails, eyebrows, sep };
})()`;

/*
 * FEAT-090 round 2 — the CONTROL audit. What token×surface pairs structurally
 * cannot see, and why this block exists:
 *
 *   1. COMPOSITED pixels. `opacity` on a control fades fill AND label together
 *      against whatever is behind it. --solid on --on-solid is 15.9:1 as a token
 *      pair and 2.87:1 as a rendered pixel at opacity .45. Only the composite is
 *      real, so the composite is what is measured here (own alpha × the element's
 *      opacity, over the first opaque ancestor ground).
 *   2. FILL prominence. A disabled control is WCAG-exempt from 1.4.3 — which is
 *      exactly why it needs a rule of its own: exemption is permission to be
 *      quiet, not permission to shout. FEAT-090's disabled primary was the
 *      brightest fill on the dark page. So a disabled control must RECEDE into
 *      its ground (<= 1.5:1) and must be less prominent than the enabled primary.
 *   3. PARITY. The card's primary must render the same fill as the app's primary
 *      (.tv-btn.solid). A main action that reads weaker than the secondary form
 *      it supersedes is a hierarchy defect a per-element floor never catches.
 */
const CONTROLS = [
  { name: 'primary .dc-send (enabled)', sel: '[data-ctl=primary-enabled]' },
  { name: 'primary .dc-send (DISABLED)', sel: '[data-ctl=primary-disabled]', disabled: true },
  { name: 'app primary .tv-btn.solid', sel: '[data-ctl=app-primary]' },
  { name: 'pinned .tdb-open', sel: '[data-ctl=pinned-primary]' },
  { name: 'segmented .dc-seg-b.on', sel: '[data-ctl=segmented-selected]' },
  { name: 'segmented .dc-seg-b idle', sel: '[data-ctl=segmented-idle]' },
  { name: 'note field .dc-note', sel: '.dc-note' },
  { name: 'chip .dc-rec-k', sel: '.dc-rec-k' },
  { name: 'chip .dc-rec text', sel: '.dc-rec' },
  { name: 'option key .dc-k', sel: '.dc-opt .dc-k' },
  { name: 'recommended tag .dc-rec-tag', sel: '.dc-rec-tag' },
  { name: 'selected option .dc-lt', sel: '#ctlpicked .dc-lt' },
  { name: 'pinned .tdb-rec', sel: '.tdb-rec' },
];

const CTL = `((targets) => {
  const rgba = (c) => {
    if (!c || c === 'transparent') return [0, 0, 0, 0];
    const n = (c.match(/[-\\d.]+(?:e[-+]?\\d+)?/gi) || []).map(Number);
    const isFn = /^color\\(/.test(c);
    const rgb = isFn ? n.slice(0, 3).map((v) => Math.round(v * 255)) : n.slice(0, 3);
    return [rgb[0], rgb[1], rgb[2], n.length > 3 ? n[3] : 1];
  };
  const over = (fg, bg, op) => { const a = fg[3] * op; return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)); };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const ratio = (a, b) => { const la = lum(a), lb = lum(b); const hi = Math.max(la, lb), lo = Math.min(la, lb); return +((hi + 0.05) / (lo + 0.05)).toFixed(2); };
  const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  // the opaque colour BEHIND an element: composite every translucent ancestor
  // background down onto the first opaque one.
  const ground = (el) => {
    const stack = [];
    for (let n = el.parentElement; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const c = rgba(cs.backgroundColor);
      stack.push([c, +cs.opacity]);
      if (c[3] === 1 && +cs.opacity === 1) break;
    }
    let base = [255, 255, 255];
    for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i][0], base, stack[i][1]);
    return base;
  };
  const theme = document.documentElement.dataset.theme;
  const rows = [];
  for (const t of targets) {
    const el = document.querySelector(t.sel);
    if (!el) { rows.push({ theme, name: t.name, missing: true }); continue; }
    const cs = getComputedStyle(el);
    const op = +cs.opacity;
    const g = ground(el);
    const fill = over(rgba(cs.backgroundColor), g, op);
    const text = over(rgba(cs.color), g, op);
    rows.push({
      theme, name: t.name, disabled: !!t.disabled,
      textOnFill: ratio(text, fill), fillOnGround: ratio(fill, g),
      fill: hex(fill), text: hex(text), ground: hex(g),
    });
  }
  return rows;
})(${JSON.stringify(CONTROLS)})`;

let server = null, browser = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 1500).unref();
}

async function main() {
  // Tiny static server: /styles.css from public, everything else the harness.
  server = http.createServer((req, res) => {
    if (req.url === '/styles.css') {
      res.setHeader('content-type', 'text/css');
      res.end(fs.readFileSync(path.join(PUBLIC, 'styles.css')));
    } else { res.setHeader('content-type', 'text/html'); res.end(harness()); }
  });
  const PORT = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const BASE = `http://127.0.0.1:${PORT}`;

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--window-size=700,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 80 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(200); }
  }
  if (!devPort) throw new Error('brave never exposed a devtools port');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const tab = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await tab.send('Page.enable');

  const results = [];
  const orders = [];
  const ctls = [];
  for (const theme of ['light', 'dark']) {
    await tab.send('Page.navigate', { url: BASE });
    await tab.waitFor(`!!document.getElementById('realfine')`);
    await tab.eval(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
    await sleep(120);
    const rows = await tab.eval(MEASURE);
    results.push(...rows);
    orders.push(await tab.eval(ORDER));
    ctls.push(...await tab.eval(CTL));
  }
  tab.close();

  const fails = results.filter((r) => r.ratio < THRESHOLD);
  const mode = PRE_FIX ? 'PRE-FIX (old hexes injected)'
    : PRE_FIX2 ? 'PRE-FIX2 (rail/separator ranks re-broken)'
    : PRE_FIX3 ? 'PRE-FIX3 (fix2 eyebrow inversion + over-corrected FYI rail)'
    : PRE_FIX4 ? 'PRE-FIX4 (light eyebrow ladder fully REVERSED — the fix3 guard\'s blind spot)'
    : PRE_FIX5 ? 'PRE-FIX5 (FEAT-090\'s opacity:.45 disabled primary — the CONTROL blind spot)'
    : 'committed CSS';
  console.log(`\nBUG-101 contrast guard — ${mode} — threshold ${THRESHOLD}:1\n`);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`  ${pad('theme', 6)}${pad('token', 26)}${pad('surface', 9)}ratio`);
  for (const r of results) {
    console.log(`  ${r.ratio < THRESHOLD ? 'FAIL ' : 'pass '}${pad(r.theme, 6)}${pad(r.token, 26)}${pad(r.surface, 9)}${r.ratio}`);
  }
  console.log(`\n  measured ${results.length} pairs — ${results.length - fails.length} pass, ${fails.length} fail`);

  // ── ranking assertions (separate from the AA pair count above) ────────────
  const rankFails = [];
  // IMPORTANCE, most → least. Every group-varying channel must decay along it.
  const IMPORTANCE = ['decision', 'in-flight', 'done', 'fyi'];
  /*
   * One entry per channel that encodes group importance. Each channel asserts
   * THREE things per theme, because the first alone is provably not enough:
   *
   *   tol  — how far one ADJACENT step may run backwards before it counts as an
   *          inversion. Two neighbouring groups can be intentionally near-equal,
   *          so some slack is needed. PER-THEME (see below).
   *   span — the CUMULATIVE check: the top rank must beat the bottom rank by at
   *          least this much. This is the assertion the fix3 guard lacked, and a
   *          reviewer proved the hole with the shipped logic: light's eyebrow
   *          steps are 0.30 / 0.16 / 0.28, i.e. EVERY step is smaller than the
   *          0.35 tolerance, so a fully reversed light ladder (4.75 / 5.03 /
   *          5.19 / 5.49) reported {"inv":[],"bf":[]} — a clean PASS. Adjacent
   *          comparison with a tolerance wider than the step size can never see
   *          a gradual inversion, at any amplitude; the first-vs-last span can.
   *          The round-2 defect was caught only because it happened to be 1.78
   *          wide. Span closes that for good.
   *   floor— the quietest a mark in this channel may get. The rails are non-text
   *          marks, so AA does not apply, but the fix2 FYI rail proved a rank
   *          fix can OVER-correct into invisibility (1.86:1, the only rail in
   *          either theme under 3:1). 2.5 bounds the bottom of the decay.
   *
   * WHY tol/span ARE PER-THEME. The 0.35 eyebrow tolerance was never about
   * light — it exists solely because DARK's eyebrow ladder is deliberately
   * near-flat (6.78 / 6.56 / 6.32 / 6.50, where FYI sits 0.18 ABOVE Done). A
   * single global number therefore has to be loose enough for dark's flatness,
   * which forces light — a deliberate, well-separated ladder — to be audited far
   * more loosely than it can afford. Splitting per theme lets LIGHT be strict
   * (tol 0.15, the same as the rails; its tightest real step is 0.16) while dark
   * stays permissive at 0.35. The same split is required arithmetically for the
   * span: dark's whole eyebrow ladder spans 0.28, which is LESS than its own
   * 0.35 tolerance, so "span > tol" is unsatisfiable there — span is its own
   * stated number, not derived from tol.
   */
  const per = (v, theme) => (typeof v === 'object' ? v[theme] : v);
  const CHANNELS = [
    { key: 'rails', label: 'rails  ', tol: 0.15, span: 0.5, floor: 2.5,
      why: 'in-flight/done sit within ~0.15 of each other by design (adjacent ranks, same weight of mark)' },
    { key: 'eyebrows', label: 'eyebrow', tol: { light: 0.15, dark: 0.35 }, span: { light: 0.5, dark: 0.15 }, floor: THRESHOLD,
      why: 'light is a deliberate ladder (5.49 / 5.19 / 5.03 / 4.75) and is held strict; dark\'s are deliberately near-flat (6.78 / 6.56 / 6.32 / 6.50) — a hue trace, not a shout' },
  ];
  console.log('\n  ranking — EVERY channel that varies by digest group must decay with');
  console.log('  IMPORTANCE (decision > in-flight > done > fyi), in BOTH themes, per ADJACENT');
  console.log('  step AND CUMULATIVELY (top vs bottom), and the footer\'s MAJOR (accent dot)');
  console.log('  break must out-rank its MINOR (`·`) break:\n');
  const TOP = IMPORTANCE[0], BOTTOM = IMPORTANCE[IMPORTANCE.length - 1];
  for (const o of orders) {
    for (const ch of CHANNELS) {
      const vals = o[ch.key];
      const tol = per(ch.tol, o.theme), minSpan = per(ch.span, o.theme);
      const seq = IMPORTANCE.map((k) => `${k} ${vals[k]}`).join(' > ');
      const inversions = IMPORTANCE.filter((k, i) => i > 0 && vals[k] > vals[IMPORTANCE[i - 1]] + tol)
        .map((k, _i) => k);
      const belowFloor = IMPORTANCE.filter((k) => vals[k] < ch.floor);
      // CUMULATIVE — the check adjacent pairs structurally cannot make: a ladder
      // whose every step is smaller than the tolerance can reverse end to end
      // without any single step tripping the adjacent test.
      const gap = +(vals[TOP] - vals[BOTTOM]).toFixed(2);
      const spanOk = gap >= minSpan;
      if (inversions.length) rankFails.push(`${o.theme}: ${ch.key} not in importance order (tol ${tol}) — ${seq}`);
      if (!spanOk) rankFails.push(`${o.theme}: ${ch.key} cumulative descent too small (${TOP} ${vals[TOP]} − ${BOTTOM} ${vals[BOTTOM]} = ${gap}, needs >= ${minSpan}) — ${seq}`);
      if (belowFloor.length) rankFails.push(`${o.theme}: ${ch.key} below the ${ch.floor}:1 floor — ${belowFloor.map((k) => `${k} ${vals[k]}`).join(', ')}`);
      console.log(`  ${inversions.length ? 'FAIL ' : 'pass '}${o.theme.padEnd(6)}${ch.label} ${seq}   [adjacent, tol ${tol} — ${ch.why}]`);
      console.log(`  ${spanOk ? 'pass ' : 'FAIL '}${o.theme.padEnd(6)}${ch.label} cumulative ${TOP} ${vals[TOP]} − ${BOTTOM} ${vals[BOTTOM]} = ${gap} >= ${minSpan}`);
      console.log(`  ${belowFloor.length ? 'FAIL ' : 'pass '}${o.theme.padEnd(6)}${ch.label} every mark >= the ${ch.floor}:1 floor`);
    }
    const sepOk = o.sep.major > o.sep.minor;
    if (!sepOk) rankFails.push(`${o.theme}: minor separator (${o.sep.minor}) out-ranks the major one (${o.sep.major})`);
    console.log(`  ${sepOk ? 'pass ' : 'FAIL '}${o.theme.padEnd(6)}footer  major(dot) ${o.sep.major} > minor(·) ${o.sep.minor}`);
  }

  // ── control assertions (rendered FILLS, not token pairs) ──────────────────
  const ctlFails = [];
  const RECEDE = 1.5;   // a disabled control may not stand off its ground by more
  console.log('\n  controls — an ENABLED control clears AA against its OWN rendered fill; a');
  console.log('  DISABLED one is AA-exempt but must RECEDE (<= 1.5:1 off its ground, and less');
  console.log('  prominent than the enabled primary); the card primary must MATCH the app primary:\n');
  console.log(`  ${pad('theme', 6)}${pad('control', 30)}${pad('text/fill', 11)}${pad('fill/ground', 13)}pixels`);
  for (const c of ctls) {
    if (c.missing) { ctlFails.push(`${c.theme}: harness control missing — ${c.name}`); console.log(`  FAIL  ${c.theme} ${c.name} — NOT RENDERED`); continue; }
    // A disabled control is AA-exempt only while it behaves like one: a control
    // that stands off its ground is CLAIMING attention, and anything claiming
    // attention has to be readable. Exemption is not a licence to shout.
    const aaOk = c.disabled ? (c.fillOnGround <= RECEDE || c.textOnFill >= THRESHOLD) : c.textOnFill >= THRESHOLD;
    if (!aaOk) ctlFails.push(`${c.theme}: ${c.name} label is ${c.textOnFill}:1 on its own fill ${c.fill}${c.disabled ? ` while standing ${c.fillOnGround}:1 off its ground (a disabled control this loud is not exempt)` : ''} (needs >= ${THRESHOLD})`);
    console.log(`  ${aaOk ? 'pass ' : 'FAIL '}${pad(c.theme, 6)}${pad(c.name, 30)}${pad(c.textOnFill + (c.disabled ? '*' : ''), 11)}${pad(c.fillOnGround, 13)}${c.text} on ${c.fill} over ${c.ground}`);
  }
  console.log('  (* disabled — AA-exempt per WCAG 1.4.3 inactive components; held to the recede rule below)');
  for (const theme of ['light', 'dark']) {
    const of = (n) => ctls.find((c) => c.theme === theme && c.name === n) ?? {};
    const dis = of('primary .dc-send (DISABLED)'), en = of('primary .dc-send (enabled)'), app = of('app primary .tv-btn.solid');
    const recedes = dis.fillOnGround <= RECEDE;
    if (!recedes) ctlFails.push(`${theme}: the DISABLED primary does not recede — fill ${dis.fill} stands ${dis.fillOnGround}:1 off its ground ${dis.ground} (max ${RECEDE})`);
    console.log(`  ${recedes ? 'pass ' : 'FAIL '}${theme.padEnd(6)}disabled primary recedes: ${dis.fillOnGround} <= ${RECEDE} (fill ${dis.fill} on ${dis.ground})`);
    const quieter = dis.fillOnGround < en.fillOnGround;
    if (!quieter) ctlFails.push(`${theme}: the DISABLED primary (${dis.fillOnGround}:1 off ground) is as prominent as the ENABLED primary (${en.fillOnGround}:1) — a dead control must not out-shout a live one`);
    console.log(`  ${quieter ? 'pass ' : 'FAIL '}${theme.padEnd(6)}disabled ${dis.fillOnGround} < enabled ${en.fillOnGround} (prominence order)`);
    const parity = en.fill === app.fill;
    if (!parity) ctlFails.push(`${theme}: the Decide card's primary fill ${en.fill} != the app primary fill ${app.fill} — the card's main action must not read weaker than the form it supersedes`);
    console.log(`  ${parity ? 'pass ' : 'FAIL '}${theme.padEnd(6)}card primary ${en.fill} === app primary ${app.fill}`);
  }

  if (PRE_FIX) {
    // The point of --pre-fix: the guard must BITE. If the old values somehow
    // passed, the guard would be worthless.
    if (fails.length === 0) { console.log('\n  UNEXPECTED — pre-fix values did not fail; the guard does not bite.'); process.exitCode = 1; }
    else console.log(`\n  EXPECTED — the guard bites: ${fails.length} known failing pairs reported (incl. ${fails.filter((f) => /ink-4|footer/.test(f.token)).length} on the raised token / footer).`);
  } else if (PRE_FIX5) {
    // The point of --pre-fix5: the CONTROL assertions must bite where the
    // token×surface matrix cannot. The old disabled primary passed every pair in
    // the matrix above and still shipped a 2.87:1 label on the loudest fill.
    if (ctlFails.length === 0) { console.log('\n  UNEXPECTED — the opacity:.45 disabled primary passed; the control assertions do not bite.'); process.exitCode = 1; }
    else { console.log(`\n  EXPECTED — the control assertions bite: ${ctlFails.length} finding(s) reported.`); for (const f of ctlFails) console.log(`    ${f}`); }
  } else if (PRE_FIX2 || PRE_FIX3 || PRE_FIX4) {
    const which = PRE_FIX2 ? 'pre-fix2' : PRE_FIX3 ? 'pre-fix3' : 'pre-fix4';
    if (rankFails.length === 0) { console.log(`\n  UNEXPECTED — the re-broken ranks passed; the ${which} ranking assertions do not bite.`); process.exitCode = 1; }
    else { console.log(`\n  EXPECTED — the ranking assertions bite: ${rankFails.length} finding(s) reported.`); for (const f of rankFails) console.log(`    ${f}`); }
  } else {
    if (fails.length) { console.log(`\n  FAILURES — ${fails.length} audited pair(s) below AA.`); process.exitCode = 1; }
    else console.log('\n  ALL PASS — every audited token×surface pair clears AA in both themes.');
    if (rankFails.length) { for (const f of rankFails) console.log(`  RANK FAILURE — ${f}`); process.exitCode = 1; }
    else console.log('  ALL PASS — every group-varying channel (rails, eyebrows) decays with importance, stays above its floor, and the footer separators rank correctly — both themes.');
    if (ctlFails.length) { for (const f of ctlFails) console.log(`  CONTROL FAILURE — ${f}`); process.exitCode = 1; }
    else console.log('  ALL PASS — every interactive control clears AA on its rendered fill, the disabled primary recedes in both themes, and the card primary matches the app primary.');
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => {
  stopByPid(browser);
  try { server?.close(); } catch { /* gone */ }
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* best effort */ }
});
