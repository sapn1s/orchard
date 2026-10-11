/**
 * BUG-246 — the transcript dock's floating controls (#leftoff, the "Latest"
 * scroll-to-bottom pill #jump, and the FEAT-118 bookmark toggle #bookmark) must
 * NOT overlap EACH OTHER, must NOT be clipped by the viewport, and must NOT
 * cover the composer/input — at ANY viewport width, in either theme, at any
 * device scale, for EVERY subset of controls that can be visible at once.
 *
 *   node scripts/verify-bug-246-dock-controls.mjs
 *   MUSTFAIL=1          node …   # HEAD files             ⇒ Latest↔bookmark overlap (original report, r1)
 *   MUSTFAIL_LEFTOFF=1  node …   # pre-fix abs offsets    ⇒ #leftoff↔#jump overlap at narrow widths (r2)
 *   MUSTFAIL_BADGE=1    node …   # r2 min-width:0 layout  ⇒ #leftoff badge CONTENT paints over #jump (r3)
 *   MUSTFAIL_JUMPCLIP=1 node …   # pre-r4 right stack     ⇒ right stack CLIPPED past viewport under wide #jump (r3 clean-room)
 *   SHOTS=/path         node …   # write theme×width screenshots
 *
 * The MAIN (fixed) assertions probe #jump at BOTH its real static "Latest" label
 * AND a synthetically WIDE label ("Latest messages below here" — the r3 overflow
 * vector), across every width down to 160px, so the right stack's by-construction
 * containment is checked, not just assumed (BUG-246 r4).
 *
 * Driven in a REAL headless Brave over an isolated scratch server (station-boot
 * isolatedServerEnv + CLAUDE_STATION_DATA), serving the WORKING TREE (incl. the
 * uncommitted FEAT-171 mobile CSS). A long fixture session is opened and
 * scrolled up; then controls are forced visible with #leftoff carrying its
 * longest REAL content ("You left off here" + a large "N new" badge, exactly as
 * app.js:4610 sets .g) and #jump its real static "Latest".
 *
 * The no-overlap/clip property is checked on PAINTED rects — for each control we
 * union the client rects of the control AND every descendant element, each
 * CLAMPED to any overflow-clipping ancestor (so #leftoff's ellipsized .lbl does
 * NOT count its clipped-away text, but the non-clipped .g badge DOES count any
 * part that paints outside its shrunken button — the exact r3 defect). We then
 * assert, for every visible PAIR, that the two paint-unions do not intersect;
 * that every visible control's paint-union lies within the viewport; and that
 * none extends below the dock's top edge (would cover the composer).
 *
 * Scope (BUG-246 r3, widened per charter):
 *   • widths 280→1600 in steps of 20, plus 720 and 721
 *   • both themes, deviceScaleFactor 1 AND 2
 *   • every non-empty subset of {leftoff, jump, bookmark} forced visible
 *   • longest real content: "Latest" (jump) + "99999 new" (leftoff badge)
 *
 * Three synthesized must-FAIL baselines prove non-vacuity:
 *   • MUSTFAIL=1         serves HEAD index.html+styles.css+app.js  ⇒ Latest↔bookmark DO overlap.
 *   • MUSTFAIL_LEFTOFF=1 reverts to the pre-fix per-control absolute offsets ⇒ #leftoff↔#jump overlap.
 *   • MUSTFAIL_BADGE=1   restores r2's `.leftoff{min-width:0}` (lets the button
 *       underflow its badge) and widens the #jump label to crowd the row ⇒ the
 *       non-shrinkable "N new" badge CONTENT paints over #jump at narrow widths.
 */
import { spawn, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { isolatedServerEnv } from './lib/station-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';
const MUSTFAIL = process.env.MUSTFAIL === '1';
const MUSTFAIL_LEFTOFF = process.env.MUSTFAIL_LEFTOFF === '1';
const MUSTFAIL_BADGE = process.env.MUSTFAIL_BADGE === '1';
const MUSTFAIL_JUMPCLIP = process.env.MUSTFAIL_JUMPCLIP === '1';
const SHOTS = process.env.SHOTS || '';

// Pre-fix geometry (r1 state): #leftoff and the right stack each absolutely
// positioned on opposite corners of .dock, no shared shrinking row.
const PREFIX_CSS = `
  .dock-float { position: static; display: contents; }
  .dock-ctl { position: absolute; right: 32px; top: -34px; z-index: 3; margin-left: 0; display: flex; align-items: center; gap: 8px; }
  .leftoff { position: absolute; left: 32px; top: -34px; z-index: 3; flex: 0 0 auto; min-width: 0; }
  .leftoff .lbl { overflow: visible; text-overflow: clip; }
  @media (max-width: 720px) { .dock-ctl { right: 12px; } .leftoff { left: 12px; } }
`;

// r2 state: the shared row BEFORE r3 — single-line (no wrap), anchored by the
// top, with `min-width:0`/`max-width:none` restored on #leftoff so the flex
// button underflows its non-shrink badge and the badge paints outside. (Just
// restoring min-width:0 is not enough: r3's `flex-wrap:wrap-reverse` would wrap
// the row instead of shrinking #leftoff, hiding the defect — the full r2 layout
// must be reinstated for the baseline to be non-vacuous.)
const R2_CSS = `
  .dock-float { top: -34px; bottom: auto; margin-bottom: 0; flex-wrap: nowrap; }
  .leftoff { min-width: 0; max-width: none; }
`;

// Pre-r4 RIGHT-STACK state: the shared row exactly as r3 shipped it — the right
// stack .dock-ctl is `flex:none` with NO max-width, and #jump's label does not
// truncate (overflow visible, no min-width:0). This is what the r3 clean-room
// found BROKEN: under a wide #jump label the stack cannot give way, so it
// overflows .dock-float and runs past the viewport's right edge (clip) at
// 160-270px. MUSTFAIL_JUMPCLIP reinstates it so the r4 MAIN clip assertion is
// proven non-vacuous. (flex-wrap stays reverse — with the stack unable to
// shrink and no cap it overflows its own line rather than being contained.)
const PRE_R4_RIGHTSTACK_CSS = `
  .dock-ctl { flex: none; max-width: none; }
  .jump { overflow: visible; }
  .jump .lbl { min-width: auto; overflow: visible; text-overflow: clip; }
`;

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = (n) => `00000000-0000-4000-d000-${String(n).padStart(12, '0')}`;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  if (!ok) console.log(`  FAIL  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : (fail++, failures.push(name));
}

function rectsIntersect(a, b) {
  const eps = 0.5;
  return !(a.right <= b.left + eps || b.right <= a.left + eps || a.bottom <= b.top + eps || b.bottom <= a.top + eps);
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.handlers = []; }
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
        for (const h of c.handlers) h(m);
      }
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.waiting.set(id, { res, rej }));
  }
  on(fn) { this.handlers.push(fn); }
  async eval(expr) {
    const expression = `Promise.resolve((()=>{ const _f = (${expr}); return typeof _f==='function' ? _f() : _f; })())`;
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async waitFor(label, expr, timeoutMs = 20_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.eval(expr)) return true; } catch { /* nav */ }
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label})`);
    return false;
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b246-data-'));
const PROJECTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b246-proj-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b246-brave-'));
const cleanupDirs = [DATA, PROJECTS, PROFILE];
let server = null, browser = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

function writeSession(store, sid, firstText, pairs, ageMs) {
  const lines = [];
  let u = 0;
  const now = Date.now();
  for (let i = 0; i < pairs; i++) {
    const ts = new Date(now - ageMs - (pairs - i) * 1000).toISOString();
    lines.push(JSON.stringify({ parentUuid: u ? uid(u) : null, isSidechain: false, type: 'user', uuid: uid(++u), timestamp: ts, sessionId: sid, cwd: PROJECTS,
      message: { role: 'user', content: [{ type: 'text', text: i === 0 ? firstText : `question ${i}` }] } }));
    lines.push(JSON.stringify({ parentUuid: uid(u), isSidechain: false, type: 'assistant', uuid: uid(++u), timestamp: ts, sessionId: sid,
      message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: `answer number ${i} — lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore.` }] } }));
  }
  const file = path.join(store, `${sid}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const t = new Date(now - ageMs);
  fs.utimesSync(file, t, t);
  return sid;
}

// Width sweep: 280→1600 step 20, plus the 720/721 breakpoint pair. The subset of
// widths at which the pre-fix absolute-offset layout collided #leftoff↔#jump on
// the real tree (used by MUSTFAIL_LEFTOFF): 320/360 (phone gutters) and 721.
const WIDTHS = (() => {
  const w = [];
  // Floor 160 (BUG-246 r4): the r3 clean-room break was the RIGHT stack
  // (.dock-ctl) overflowing past the viewport edge under a wide #jump label at
  // 160-270px (it was flex:none with no cap/truncation). r4 makes #jump's label
  // truncate and caps the stack at max-width:100%; this floor + the wide-#jump
  // label variant below fold that probe into the MAIN pass assertions.
  for (let x = 160; x <= 1600; x += 20) w.push(x);
  // Breakpoint pair + common phone logical widths the review called out as the
  // everyday wrap state (iPhone/Android: 375/390/393/412) — not multiples of 20.
  for (const x of [375, 390, 393, 412, 720, 721]) if (!w.includes(x)) w.push(x);
  return w.sort((a, b) => a - b);
})();
const LEFTOFF_PREFIX_COLLIDE = new Set([320, 360, 721]);
const THEMES = ['light', 'dark'];
// Every non-empty subset of the three controls, by element id.
const SUBSETS = [
  ['leftoff', 'jump', 'bookmark'],
  ['leftoff', 'jump'],
  ['leftoff', 'bookmark'],
  ['jump', 'bookmark'],
  ['leftoff'],
  ['jump'],
  ['bookmark'],
];

// Page helper: paint-union of a control, clamping every descendant's rects to
// any overflow-clipping ancestor (ellipsized text does NOT count; a badge that
// paints outside its button DOES). Injected once as a window global.
const PAINT_HELPER = `() => {
  window.__b246paint = (sel) => {
    const root = document.querySelector(sel);
    if (!root) return null;
    const cs = getComputedStyle(root);
    if (root.hidden || cs.display === 'none' || cs.visibility === 'hidden' || root.getClientRects().length === 0) return null;
    const clipsOf = (el, stopAt) => {
      const clips = [];
      let p = el.parentElement;
      while (p && p !== stopAt) {
        const o = getComputedStyle(p);
        if (o.overflow !== 'visible' || o.overflowX !== 'visible' || o.overflowY !== 'visible') clips.push(p.getBoundingClientRect());
        p = p.parentElement;
      }
      return clips;
    };
    let L = Infinity, R = -Infinity, T = Infinity, B = -Infinity;
    const take = (el) => {
      const clips = clipsOf(el, root.parentElement);
      for (const r of el.getClientRects()) {
        let l = r.left, rr = r.right, t = r.top, b = r.bottom;
        for (const c of clips) { l = Math.max(l, c.left); rr = Math.min(rr, c.right); t = Math.max(t, c.top); b = Math.min(b, c.bottom); }
        if (rr > l && b > t) { L = Math.min(L, l); R = Math.max(R, rr); T = Math.min(T, t); B = Math.max(B, b); }
      }
    };
    take(root);
    for (const el of root.querySelectorAll('*')) take(el);
    return Number.isFinite(L) ? { left: +L.toFixed(1), right: +R.toFixed(1), top: +T.toFixed(1), bottom: +B.toFixed(1) } : null;
  };
  return true;
}`;

async function main() {
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const encoded = PROJECTS.replace(/[^a-zA-Z0-9]/g, '-');
  const storeDir = path.join(PROJECTS, encoded);
  fs.mkdirSync(storeDir, { recursive: true });

  const LONG = uid(206);
  writeSession(storeDir, LONG, 'a long session to scroll', 40, 40 * 60_000);

  const env = isolatedServerEnv({ PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: PROJECTS }, { requireStore: true });
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: PROJECTS, name: 'b246-fixture' }),
  })).json();
  if (!reg.project?.id) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  const pid = reg.project.id;

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--force-color-profile=srgb', '--window-size=1400,1000', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 80 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  if (MUSTFAIL) {
    const head = {
      '/': execSync('git show HEAD:public/index.html', { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }),
      '/styles.css': execSync('git show HEAD:public/styles.css', { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }),
      '/app.js': execSync('git show HEAD:public/app.js', { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }),
    };
    const ctype = { '/': 'text/html', '/styles.css': 'text/css', '/app.js': 'text/javascript' };
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    cdp.on((m) => {
      if (m.method !== 'Fetch.requestPaused') return;
      const p = m.params;
      const u = new URL(p.request.url);
      const key = (u.pathname === '/' || u.pathname === '/index.html') ? '/' : u.pathname;
      if (head[key]) {
        cdp.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200,
          responseHeaders: [{ name: 'content-type', value: ctype[key] }], body: head[key].toString('base64') });
      } else {
        cdp.send('Fetch.continueRequest', { requestId: p.requestId });
      }
    });
    console.log('\n  [MUSTFAIL] serving HEAD index.html + styles.css + app.js — expecting Latest↔bookmark to OVERLAP\n');
  }

  await cdp.send('Page.navigate', { url: `${BASE}/#/project/${pid}/session/${LONG}?dir=${encodeURIComponent(encoded)}` });
  await cdp.waitFor('app boot', `!!window.__station`, 30_000);
  await cdp.waitFor('long session open', `window.__station?.state.current.sessionId === ${JSON.stringify(LONG)}`, 30_000);
  await sleep(600);

  if (MUSTFAIL_LEFTOFF) {
    await cdp.eval(`() => { const s = document.createElement('style'); s.id = '__prefix246'; s.textContent = ${JSON.stringify(PREFIX_CSS)}; document.head.appendChild(s); }`);
    console.log('\n  [MUSTFAIL_LEFTOFF] reverted to pre-fix absolute offsets — expecting #leftoff↔#jump to OVERLAP at narrow widths\n');
  }
  if (MUSTFAIL_BADGE) {
    await cdp.eval(`() => { const s = document.createElement('style'); s.id = '__r2246'; s.textContent = ${JSON.stringify(R2_CSS)}; document.head.appendChild(s); }`);
    console.log('\n  [MUSTFAIL_BADGE] restored r2 `.leftoff{min-width:0}` + wide #jump label — expecting the "N new" badge CONTENT to paint over #jump at narrow widths\n');
  }
  if (MUSTFAIL_JUMPCLIP) {
    await cdp.eval(`() => { const s = document.createElement('style'); s.id = '__prer4246'; s.textContent = ${JSON.stringify(PRE_R4_RIGHTSTACK_CSS)}; document.head.appendChild(s); }`);
    console.log('\n  [MUSTFAIL_JUMPCLIP] restored pre-r4 right stack (.dock-ctl flex:none, no cap, #jump label not truncatable) + wide #jump label — expecting the right stack to OVERFLOW past the viewport (clip) at 160-270px\n');
  }

  // Force a subset of controls visible, seed #leftoff's longest real content and
  // #jump's label (the real static "Latest" or a synthetically widened label —
  // the r3 break vector, now folded into the MAIN assertions).
  const WIDE_JUMP = 'Latest messages below here';
  const forceSubset = (ids, jumpLabel) => `() => {
    const all = { jump: document.querySelector('#jump'), bookmark: document.querySelector('#bookmark'), leftoff: document.querySelector('#leftoff') };
    const want = new Set(${JSON.stringify(ids)});
    for (const [id, el] of Object.entries(all)) { if (!el) continue; const on = want.has(id); el.hidden = !on; if (on) el.removeAttribute('hidden'); else el.setAttribute('hidden', ''); }
    const l = all.leftoff; if (l) { const g = l.querySelector('.g'); if (g) g.textContent = '99999 new'; const lbl = l.querySelector('.lbl'); if (lbl) lbl.textContent = 'You left off here'; }
    const j = all.jump; if (j) { const jl = j.querySelector('.lbl'); if (jl) jl.textContent = ${JSON.stringify(jumpLabel)}; }
    return Object.values(all).filter(Boolean).length;
  }`;
  // Which #jump label(s) to exercise. The FIXED property probes BOTH the real
  // static "Latest" AND a synthetically wide label (the r3 overflow vector) when
  // #jump is visible. The HEAD/pre-fix/r2 baselines keep their own semantics.
  const jumpLabelsFor = (subset) => {
    if (MUSTFAIL_BADGE || MUSTFAIL_JUMPCLIP) return [WIDE_JUMP];
    if (MUSTFAIL || MUSTFAIL_LEFTOFF) return ['Latest'];
    return subset.includes('jump') ? ['Latest', WIDE_JUMP] : ['Latest'];
  };

  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const SHOT_WIDTHS = new Set([200, 300, 390, 412, 721, 1400]);

  for (const dsf of [1, 2]) {
    for (const vp of WIDTHS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp, height: 900, deviceScaleFactor: dsf, mobile: false });
      await sleep(60);
      for (const theme of THEMES) {
        await cdp.eval(`() => { document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); }`);
        await cdp.eval(`() => { const s=document.querySelector('#scroll'); s.scrollTop = 0; s.dispatchEvent(new Event('scroll')); }`);
        await sleep(90);

        // Which subsets to exercise at this config. The all-three subset runs at
        // EVERY width/theme/scale (the core property); the other 6 subsets run at
        // representative widths only (and dsf 1) to keep the run tractable.
        const representative = dsf === 1 && [300, 390, 480, 720, 721, 1000, 1400].includes(vp);
        const anyMustfail = MUSTFAIL || MUSTFAIL_LEFTOFF || MUSTFAIL_BADGE || MUSTFAIL_JUMPCLIP;
        const subsetsHere = anyMustfail
          ? [['leftoff', 'jump', 'bookmark']]
          : (representative ? SUBSETS : [['leftoff', 'jump', 'bookmark']]);

        for (const subset of subsetsHere) {
         for (const jumpLabel of jumpLabelsFor(subset)) {
          const wideJump = jumpLabel === WIDE_JUMP;
          await cdp.eval(forceSubset(subset, jumpLabel));
          await cdp.eval(PAINT_HELPER);
          await sleep(40);
          const dockTop = await cdp.eval(`() => { const d = document.querySelector('.dock'); return d ? +d.getBoundingClientRect().top.toFixed(1) : null; }`);
          const vh = await cdp.eval(`() => window.innerHeight`);
          const vw = await cdp.eval(`() => window.innerWidth`);
          const paint = {};
          for (const id of subset) paint[id] = await cdp.eval(`() => window.__b246paint('#${id}')`);

          const tag = `w${vp}/${theme}/dsf${dsf}/{${subset.join('+')}}${wideJump ? '/wideJump' : ''}`;

          if (MUSTFAIL) {
            const j = paint.jump, b = paint.bookmark;
            check(`[${tag}] BASELINE(HEAD): Latest↔bookmark OVERLAP (reproduces the report)`, !!(j && b && rectsIntersect(j, b)), { j, b });
            continue;
          }
          if (MUSTFAIL_LEFTOFF) {
            if (LEFTOFF_PREFIX_COLLIDE.has(vp)) {
              const l = paint.leftoff, j = paint.jump;
              check(`[${tag}] BASELINE(pre-fix): #leftoff↔#jump OVERLAP`, !!(l && j && rectsIntersect(l, j)), { l, j });
            }
            continue;
          }
          if (MUSTFAIL_BADGE) {
            // The non-shrink "N new" badge paints outside the shrunken button and
            // over #jump — a CONTENT overlap the button-rect-only check would miss.
            if (vp <= 320) {
              const l = paint.leftoff, j = paint.jump;
              check(`[${tag}] BASELINE(r2 min-width:0 + wide jump): #leftoff badge CONTENT over #jump`, !!(l && j && rectsIntersect(l, j)), { l, j });
            }
            continue;
          }
          if (MUSTFAIL_JUMPCLIP) {
            // Pre-r4 right stack: .dock-ctl flex:none, no cap, #jump label not
            // truncatable ⇒ under a wide label the stack overflows past the
            // viewport right edge (the r3 clean-room clip). Rightmost child is
            // #bookmark; either it or #jump must paint past vw at narrow widths.
            if (vp <= 270) {
              const j = paint.jump, b = paint.bookmark;
              const clipped = !!((j && j.right > vw + 0.5) || (b && b.right > vw + 0.5));
              check(`[${tag}] BASELINE(pre-r4 right stack + wide jump): right stack CLIPPED past viewport`, clipped, { j, b, vw });
            }
            continue;
          }

          // ── the FIXED property ──────────────────────────────────────────────
          // Every requested control is actually visible (not a vacuous pass).
          const allVisible = subset.every((id) => paint[id]);
          check(`[${tag}] all requested controls visible`, allVisible, paint);
          if (!allVisible) continue;

          // No two visible controls' PAINT-unions intersect.
          for (let i = 0; i < subset.length; i++) {
            for (let k = i + 1; k < subset.length; k++) {
              const a = subset[i], c = subset[k];
              check(`[${tag}] ${a} paint does NOT overlap ${c}`, !rectsIntersect(paint[a], paint[c]), { [a]: paint[a], [c]: paint[c] });
            }
          }
          // Nothing clipped by the viewport (paint-union within [0,vw]×[0,vh]).
          for (const id of subset) {
            const p = paint[id];
            const inVp = p.left >= -0.5 && p.right <= vw + 0.5 && p.top >= -0.5 && p.bottom <= vh + 0.5;
            check(`[${tag}] ${id} not clipped by the viewport`, inVp, { p, vw, vh });
          }
          // Nothing covers the composer/input (paint-union stays above the dock top).
          for (const id of subset) {
            check(`[${tag}] ${id} does NOT cover the composer`, paint[id].bottom <= dockTop + 0.5, { bottom: paint[id].bottom, dockTop });
          }

          if (SHOTS && dsf === 1 && SHOT_WIDTHS.has(vp) && subset.length === 3 && !wideJump) {
            const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
            fs.writeFileSync(path.join(SHOTS, `bug-246-${MUSTFAIL ? 'HEAD-' : MUSTFAIL_LEFTOFF ? 'PREFIX-' : MUSTFAIL_BADGE ? 'R2BADGE-' : MUSTFAIL_JUMPCLIP ? 'PRER4-' : ''}w${vp}-${theme}.png`), Buffer.from(shot.data, 'base64'));
          }
          if (SHOTS && dsf === 1 && SHOT_WIDTHS.has(vp) && subset.length === 3 && wideJump && !anyMustfail) {
            const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
            fs.writeFileSync(path.join(SHOTS, `bug-246-wideJump-w${vp}-${theme}.png`), Buffer.from(shot.data, 'base64'));
          }
         }
        }
      }
    }
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  cdp.close();
}

main()
  .catch((e) => { console.error(e); fail++; failures.push(`harness threw: ${e.message}`); })
  .finally(async () => {
    stopByPid(server); stopByPid(browser);
    await sleep(300);
    for (const d of cleanupDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
    const total = pass + fail;
    const mode = MUSTFAIL ? ' (MUSTFAIL — Latest↔bookmark OVERLAP on HEAD)'
      : MUSTFAIL_LEFTOFF ? ' (MUSTFAIL_LEFTOFF — #leftoff↔#jump OVERLAP under pre-fix offsets)'
      : MUSTFAIL_BADGE ? ' (MUSTFAIL_BADGE — badge CONTENT over #jump under r2 min-width:0)'
      : MUSTFAIL_JUMPCLIP ? ' (MUSTFAIL_JUMPCLIP — right stack CLIPPED past viewport under pre-r4 CSS + wide jump)'
      : '';
    console.log(`\n${'='.repeat(60)}\n  ${pass}/${total} passed${mode}`);
    if (failures.length) console.log(`  failing (${failures.length}): ${failures.slice(0, 20).join(' · ')}${failures.length > 20 ? ' …' : ''}`);
    process.exit(fail ? 1 : 0);
  });
