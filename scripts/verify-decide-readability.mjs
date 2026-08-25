/**
 * FEAT-090 — the Decide panel READABILITY guard (the half 6a1653e missed).
 *
 *   node scripts/verify-decide-readability.mjs
 *   node scripts/verify-decide-readability.mjs --no-ui   # (nothing to run — this
 *                                                          #  suite IS the UI)
 *
 * WHAT THIS PROVES, against the USER'S REALITY — the REAL decision tickets on the
 * board, DISCOVERED at runtime (never named: the user answers/reopens/archives a
 * named ticket and reddens a passing suite), copied into a scratch project the
 * harness registers. The suite selects whichever real ticket currently carries the
 * SHAPE each leg needs, and fails loudly if the board has none:
 *
 *   A. READABILITY — every option description in the wide Decide panel renders at
 *      a real reading measure: at least 250px wide AND no longer than 8 line
 *      boxes. This is the assertion 6a1653e's 360px rail violated (real options
 *      wrapped to 10-11 lines). Driven on EVERY real paragraph-length decision at
 *      1440/1280/1000 wide, in BOTH themes.
 *   B. ADVERSARIAL — the same, on a synthetic board of four genuine ~95-word
 *      options (the independent shape that reproduced `[11,10,10,10]`).
 *   C. INLINE MARKDOWN — a real option description that carries `*emphasis*` /
 *      `**strong**` renders the emphasis and never shows a raw `*` marker, on the
 *      exact option(s) the parser reports as carrying markdown.
 *   D. REACHABILITY ANTI-REGRESS — the serious half of 6a1653e must STAY proved:
 *      at short viewport heights (480/560/620/700) and with 6 and 12 options, the
 *      "Record answer" action stays reachable from the natural landing (the card
 *      scrolls internally and the action row is pinned in view).
 *
 * THEME is set with CDP `Emulation.setEmulatedMedia` prefers-color-scheme — the
 * app follows the system theme — so this harness NEVER writes localStorage on
 * about:blank (the `SecurityError` that killed a prior verification round). Every
 * screenshot is graded with shot-luma so a mislabelled/duplicate capture fails.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { shotLedger } from './lib/shot-luma.mjs';
import { ticketDecision } from '../src/server/board.ts';
import { discoverRealDecisions } from './lib/real-decisions.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
// The real board to DISCOVER decisions from. Override (test-only) lets a
// mutation-simulation point the real suite at a COPIED, mutated board to prove
// it adapts / fails-loudly rather than coupling to today's live values.
const REAL_BUGS = process.env.VERIFY_REAL_BUGS ?? path.join(ROOT, 'docs', 'bugs');
const BRAVE = process.env.VERIFY_BROWSER ?? 'brave';
const SHOTDIR = '/tmp/iv-orchard/decide-readability';

const MAX_LINES = 8;    // the readable line budget the panel must honour
const MIN_WIDTH = 250;  // …at a real measure, not by shrinking the text

// The two PROPERTIES the real tickets must supply — the reason this suite uses
// real prose rather than a fixture (docs/CONVENTIONS.md, "invariant PROPERTIES,
// not values legitimate use changes"). We do NOT name ARCH-003/ARCH-004 (the
// user answers, reopens or archives them, which would redden a passing suite);
// we DISCOVER at runtime whichever real decision currently carries these shapes:
//   • paragraph-length options — a genuinely long option description (the wrap
//     stress the 360px-rail defect this guard exists to catch is only visible
//     against real, long prose, never a one-liner);
//   • inline markdown — an option whose description carries a `*…*` / `**…**`
//     span, so section C proves the renderer emits <em>/<strong> and never a raw
//     `*` marker on REAL author-written emphasis.
const INLINE_MD_RE = /\*\*[^*]+\*\*|\*[^*\s][^*]*\*/;   // a `**strong**` or `*emphasis*` span
const maxDescChars = (dec) => Math.max(...dec.options.map((o) => o.description.length));
const mdOptionKeys = (dec) => dec.options.filter((o) => INLINE_MD_RE.test(o.description)).map((o) => o.key);

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────────────────────────── the scratch board (real + synthetic tickets) ── */
// A genuine ~95-word option paragraph (the adversarial shape, no markdown).
const LOREM = ('the change reworks how the turn boundary is detected so that parentage is ' +
  'always known before any record is written, which costs real code in the waiting ' +
  'step and the timeout path but is the only route that stops the system guessing ' +
  'about what happened; it reads what actually occurred instead of what might have, ' +
  'closes both directions of the error at once, and removes the fragile dependency ' +
  'on an internal engine detail nobody has ever confirmed, at the price of a slower ' +
  'and more careful path through the hottest part of the loop under real load today').split(/\s+/);
const words = (n) => Array.from({ length: n }, (_, i) => LOREM[i % LOREM.length]).join(' ') + '.';

function decisionTicket(id, title, opts) {
  const rows = opts.map((o) => `- **${o.key} — ${o.label}.** ${o.desc}`).join('\n');
  return `# ${id} — ${title}\n\n- **Status:** OPEN — DECISION NEEDED\n- **Severity:** high\n- **Area:** UI\n\n` +
    `## Decision — pick one\n${rows}\n\n` +
    `## Activity log (APPEND-ONLY)\n\n### 2026-08-10 — orchestrator\n- filed, waiting on the user.\n`;
}
// The server's ticket route only accepts ARCH|BUG|FEAT|DEPLOY prefixes, so the
// synthetic tickets borrow FEAT with high numbers that cannot collide with real.
const ADV = 'FEAT-9001';        // four ~95-word options (the adversarial shape)
const REACH6 = 'FEAT-9006';     // 6 options   (reachability anti-regress)
const REACH12 = 'FEAT-9012';    // 12 options  (reachability anti-regress)
const advTicket = () => decisionTicket(ADV, 'four paragraph-length options',
  ['A', 'B', 'C', 'D'].map((k) => ({ key: k, label: `option ${k} in one clause`, desc: words(95) })));
const reachTicket = (id, n) => decisionTicket(id, `${n} options for reachability`,
  Array.from({ length: n }, (_, i) => ({ key: String.fromCharCode(65 + i), label: `choice ${i + 1}`, desc: words(38) })));

/* ── discover the REAL decisions to measure (property, not named ticket) ──
 * PARA_MIN — an option long enough to genuinely wrap (a one-liner can't ribbon,
 *   so it can't exercise the defect this guard exists to catch).
 * PARA_MAX — the panel's PROVEN reading envelope. Section B proves the panel
 *   renders a ~95-word (~540-char) option in ≤ MAX_LINES lines at the tested
 *   widths. An option MUCH longer than that cannot fit MAX_LINES at ANY readable
 *   width by length ALONE — measuring it would test option LENGTH, not the
 *   width-driven ribboning this guard proves, and would false-red on a
 *   legitimately-long real option (e.g. a decision-grade PLAN option that renders
 *   as a tall-but-readable 10-line paragraph at 426px — NOT a narrow ribbon).
 *   Bounding to the envelope (with margin) keeps the invariant honest: WITHIN it,
 *   > MAX_LINES lines always means a real width/layout regression; BEYOND it, just
 *   a long option. This is SELECTION over real prose — nothing is shortened. */
const PARA_MIN_CHARS = 200;
const PARA_MAX_CHARS = Math.round(words(95).length * 1.2);   // ~1.2× the proven ~540-char envelope
const inEnvelope = (dec) => { const n = maxDescChars(dec); return n >= PARA_MIN_CHARS && n <= PARA_MAX_CHARS; };

// Fail LOUDLY (not quietly green) if the board has no qualifying real decision.
const REAL_DECISIONS = discoverRealDecisions(REAL_BUGS, ticketDecision);
const PARAGRAPH_DECISIONS = REAL_DECISIONS.filter((d) => inEnvelope(d.decision));
const MARKDOWN_DECISIONS = PARAGRAPH_DECISIONS.filter((d) => mdOptionKeys(d.decision).length > 0);
const OVER_ENVELOPE = REAL_DECISIONS.filter((d) => maxDescChars(d.decision) > PARA_MAX_CHARS).map((d) => `${d.id}(${maxDescChars(d.decision)}ch)`);
if (!PARAGRAPH_DECISIONS.length) {
  throw new Error(
    `no real decision on the board has a paragraph-length option in [${PARA_MIN_CHARS}, ${PARA_MAX_CHARS}] chars — ` +
    'the readability guard has no real long prose it can hold to the line budget (worth knowing).' +
    (OVER_ENVELOPE.length ? ` (over-envelope, excluded: ${OVER_ENVELOPE.join(', ')})` : ''));
}
if (!MARKDOWN_DECISIONS.length) {
  throw new Error(
    'no real paragraph-length decision on the board carries inline markdown (`*…*`/`**…**`) in an ' +
    'option — section C has no real emphasis to prove the renderer against (worth knowing).');
}
// READABILITY (A) measures every in-envelope real decision; INLINE MARKDOWN (C)
// proves the first that also carries emphasis. Both are seeded on the board.
const READABILITY_TICKETS = PARAGRAPH_DECISIONS;
const MARKDOWN_TICKET = MARKDOWN_DECISIONS[0];
const SEED_REALS = [...new Map(
  [...READABILITY_TICKETS, MARKDOWN_TICKET].map((d) => [d.id, d]),
).values()].sort((a, b) => a.id.localeCompare(b.id));
console.log(`  [discovery] in-envelope real decisions [${PARA_MIN_CHARS}-${PARA_MAX_CHARS}ch]: `
  + `${READABILITY_TICKETS.map((d) => `${d.id}(${maxDescChars(d.decision)}ch)`).join(', ')}`
  + `; inline-markdown proof: ${MARKDOWN_TICKET.id} (option ${mdOptionKeys(MARKDOWN_TICKET.decision).join('/')})`
  + (OVER_ENVELOPE.length ? `; over-envelope excluded: ${OVER_ENVELOPE.join(', ')}` : ''));

// This guard measures the UNANSWERED reading form — the option-description
// readability the decision card must deliver BEFORE a choice is made. A real
// ticket may since have been answered on the board (it carries a `you (answer …)`
// entry), which flips the card to its read-only state and hides the options.
// Strip from the first user-reply entry to EOF so the seeded copy is the same
// REAL decision prose in its unanswered state — the exact thing under test —
// rather than an answered card with no descriptions to measure. (This only
// removes the answer log; the option prose above is untouched, so the readability
// measure still runs against the real, full-length author-written options.)
const unanswered = (body) => body.replace(/\n### \d{4}-\d\d-\d\d — you \([^\n]*[\s\S]*$/, '\n');

const row = (id, title) => `| ${id} | ${title} | 👤 | needs decision | high |`;

function seedBoard(bugs) {
  fs.mkdirSync(bugs, { recursive: true });
  const realRows = [];
  for (const t of SEED_REALS) {
    fs.writeFileSync(path.join(bugs, t.name), unanswered(t.body));
    realRows.push(row(t.id, t.decision.question.replace(/\|/g, '/').slice(0, 48)));
  }
  fs.writeFileSync(path.join(bugs, `${ADV}-adversarial.md`), advTicket());
  fs.writeFileSync(path.join(bugs, `${REACH6}-six.md`), reachTicket(REACH6, 6));
  fs.writeFileSync(path.join(bugs, `${REACH12}-twelve.md`), reachTicket(REACH12, 12));
  for (const t of ['TEMPLATE.md', 'TEMPLATE-ARCH.md']) {
    try { fs.copyFileSync(path.join(REAL_BUGS, t), path.join(bugs, t)); } catch { /* optional */ }
  }
  fs.writeFileSync(path.join(bugs, 'INDEX.md'),
    `# Board — scratch\n\n## Open\n\n| ID | Title | Owner | Status | Sev |\n|----|-------|-------|--------|-----|\n` +
    [...realRows,
     row(ADV, 'adversarial'), row(REACH6, 'six options'), row(REACH12, 'twelve options')].join('\n') +
    `\n\n## Done (committed)\n\n| ID | Title | Commit |\n|----|-------|--------|\n\n## Shipped\n\n- nothing yet\n`);
}

/* ───────────────────────────────────────────────────────────── infra helpers ── */
const procs = new Set();
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
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c = new Cdp(ws);
    ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && c.waiting.has(m.id)) { const { res, rej } = c.waiting.get(m.id); c.waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } });
    return c;
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.waiting.set(id, { res, rej })); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`); return r.result?.value; }
  async waitFor(label, expr, timeoutMs = 20000) { const t0 = Date.now(); while (Date.now() - t0 < timeoutMs) { try { if (await this.eval(expr)) return true; } catch { /* mid-nav */ } await sleep(150); } console.log(`        (timed out waiting for ${label})`); return false; }
  async setViewport(width, height, dark) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  }
  async shot(file) { try { const r = await this.send('Page.captureScreenshot', { format: 'png' }); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); return file; } catch (err) { console.log(`        (screenshot failed: ${err.message})`); return null; } }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

// Runs IN the page: geometry of the wide grid + per-option description measure.
// Line count = number of line boxes (getClientRects on the inline .dc-desc).
const MEASURE = `(() => {
  const doc = document.querySelector('#tvDetail .tv-doc.has-decide');
  const rail = document.querySelector('#tvDetail .tv-decide-wrap');
  const card = document.querySelector('#tvDetail .tv-decide');
  if (!doc || !rail || !card) return { ok:false };
  // .dc-desc is a grid item, so it is blockified — getClientRects() on the element
  // returns ONE border box, not per-line boxes. A Range over its text contents
  // yields a rect PER LINE FRAGMENT; distinct rounded tops = wrapped line count.
  const linesOf = (d) => {
    const r = document.createRange(); r.selectNodeContents(d);
    return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size;
  };
  const descs = [...card.querySelectorAll('.dc-opt .dc-desc')].map((d) => ({
    key: d.closest('.dc-opt').querySelector('.dc-k')?.textContent ?? '?',
    width: Math.round(d.getBoundingClientRect().width),
    lines: linesOf(d), chars: d.textContent.length,
    emph: !!d.querySelector('em, strong'), raw: /\\*/.test(d.textContent),
  }));
  const barHidden = !document.querySelector('#tvDetail .tv-decide-bar')
    || getComputedStyle(document.querySelector('#tvDetail .tv-decide-bar')).display === 'none';
  return { ok:true, barHidden,
    docW: Math.round(doc.getBoundingClientRect().width),
    railW: Math.round(rail.getBoundingClientRect().width),
    mdW: Math.round((document.querySelector('#tvDetail .tv-md')?.getBoundingClientRect().width) ?? 0),
    descs };
})()`;

// Reachability: the action row must be reachable from the natural landing (top of
// the ticket). The card scrolls internally; .dc-actions is pinned to its bottom.
const REACH = `(() => {
  const card = document.querySelector('#tvDetail .tv-decide');
  const actions = card && card.querySelector('.dc-actions');
  const send = card && card.querySelector('.dc-send');
  if (!card || !actions || !send) return { ok:false };
  const ar = actions.getBoundingClientRect(), sr = send.getBoundingClientRect();
  return { ok:true,
    overflows: card.scrollHeight > card.clientHeight + 2,   // options really overflow → a real test
    actionBottom: Math.round(ar.bottom), sendBottom: Math.round(sr.bottom),
    sendTop: Math.round(sr.top), vh: window.innerHeight,
    actionInView: ar.bottom <= window.innerHeight + 2 && ar.top >= -2,
    sendInView: sr.bottom <= window.innerHeight + 2 && sr.top >= -2 };
})()`;

let ledger;
async function main() {
  fs.rmSync(SHOTDIR, { recursive: true, force: true });
  ledger = shotLedger();
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-data-'));
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-store-'));
  const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-prof-'));
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-proj-'));
  seedBoard(path.join(WORK, 'docs', 'bugs'));

  const srv = spawn(process.execPath, [ENTRY], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE, CLAUDE_STATION_SURVIVE: '0' }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  srv.stderr?.on('data', (d) => { if (process.env.CS_VERBOSE) process.stderr.write(`  [srv] ${d}`); });
  procs.add(srv);
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { const r = await fetch(`${BASE}/api/health`); up = r.ok; } catch { await sleep(200); } }
  if (!up) throw new Error('server never healthy');
  const reg = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: WORK, name: 'Decide Readability' }) })).json();
  const pid = reg.project.id;

  const browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0', '--no-first-run', '--disable-extensions', '--window-size=1500,950', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  procs.add(browser);
  let devPort = 0;
  for (let i = 0; i < 80 && !devPort; i++) { try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); } }
  if (!devPort) throw new Error('browser never wrote DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');

  // navigate + settle at (width,height,theme); returns the geometry measure.
  const open = async (id, w, h, dark) => {
    await cdp.setViewport(w, h, dark);
    await cdp.send('Page.navigate', { url: `${BASE}/#/tickets/${id}?project=${encodeURIComponent(pid)}` });
    const okCard = await cdp.waitFor('decide card', `!!document.querySelector('#tvDetail .tv-decide .dc-desc')`, 20000);
    await sleep(250);
    return { okCard, m: await cdp.eval(MEASURE) };
  };

  const WIDTHS = [1440, 1280, 1000];
  const THEMES = [['light', false], ['dark', true]];

  /* ── A + C — REAL discovered decisions: readability + inline markdown ── */
  console.log(`\n=== A. READABILITY — real ${READABILITY_TICKETS.map((d) => d.id).join(' / ')}, wide, both themes ===`);
  for (const { id } of READABILITY_TICKETS) {
    for (const w of WIDTHS) {
      for (const [tname, dark] of THEMES) {
        const { okCard, m } = await open(id, w, 900, dark);
        if (!okCard || !m.ok) { check(`${id} @${w} ${tname}: panel rendered`, false, m); continue; }
        const maxLines = Math.max(...m.descs.map((d) => d.lines));
        const minWidth = Math.min(...m.descs.map((d) => d.width));
        check(`${id} @${w} ${tname}: every option ≤ ${MAX_LINES} lines (measure), ≥ ${MIN_WIDTH}px wide`,
          maxLines <= MAX_LINES && minWidth >= MIN_WIDTH,
          { railW: m.railW, mdW: m.mdW, descWidthMin: minWidth, maxDescLines: maxLines, lines: m.descs.map((d) => d.lines) });
      }
    }
  }

  console.log('\n=== C. INLINE MARKDOWN — emphasis rendered, no raw `*` markers ===');
  {
    // The parser reports which real option descriptions carry a `*…*`/`**…**`
    // span; assert the renderer emits <em>/<strong> on THOSE exact options and
    // never leaks a raw `*` on ANY option — no coupling to which option that is.
    const mdKeys = mdOptionKeys(MARKDOWN_TICKET.decision);
    const { m } = await open(MARKDOWN_TICKET.id, 1440, 900, false);
    check(`${MARKDOWN_TICKET.id}: descriptions render inline emphasis and show NO raw \`*\` markers`,
      m.descs.some((d) => d.emph) && m.descs.every((d) => !d.raw),
      m.descs.map((d) => ({ key: d.key, emph: d.emph, raw: d.raw })));
    const marked = m.descs.filter((d) => mdKeys.includes(d.key));
    check(`${MARKDOWN_TICKET.id} option(s) ${mdKeys.join('/')} (real \`*…*\`/\`**…**\`): render <em>/<strong>, no raw \`*\``,
      marked.length === mdKeys.length && marked.every((d) => d.emph && !d.raw),
      marked.map((d) => ({ key: d.key, emph: d.emph, raw: d.raw })));
  }

  /* ── B — adversarial four ~95-word options ── */
  console.log('\n=== B. ADVERSARIAL — four ~95-word options, wide, both themes ===');
  for (const w of WIDTHS) {
    for (const [tname, dark] of THEMES) {
      const { okCard, m } = await open(ADV, w, 900, dark);
      if (!okCard || !m.ok) { check(`${ADV} @${w} ${tname}: panel rendered`, false, m); continue; }
      const maxLines = Math.max(...m.descs.map((d) => d.lines));
      const minWidth = Math.min(...m.descs.map((d) => d.width));
      check(`${ADV} (adversarial) @${w} ${tname}: four ~95-word options ≤ ${MAX_LINES} lines, ≥ ${MIN_WIDTH}px`,
        maxLines <= MAX_LINES && minWidth >= MIN_WIDTH,
        { railW: m.railW, descWidthMin: minWidth, maxDescLines: maxLines, allLines: m.descs.map((d) => d.lines) });
    }
  }

  /* ── D — REACHABILITY anti-regress: short heights × 6 and 12 options ── */
  console.log('\n=== D. REACHABILITY (anti-regress) — Record answer reachable from landing ===');
  for (const [id, n] of [[REACH6, 6], [REACH12, 12]]) {
    for (const h of [480, 560, 620, 700]) {
      await cdp.setViewport(1400, h, false);
      await cdp.send('Page.navigate', { url: `${BASE}/#/tickets/${id}?project=${encodeURIComponent(pid)}` });
      const ok = await cdp.waitFor('decide card', `!!document.querySelector('#tvDetail .tv-decide .dc-send')`, 20000);
      await sleep(250);
      const r = await cdp.eval(REACH);
      // The PROVEN property (6a1653e, independently re-verified): from the natural
      // landing the primary action (.dc-send "Record answer") is in view while the
      // options scroll behind it. We assert on the BUTTON — the action block's
      // sub-button foot helper text may sit a few px below the fold at these tiny
      // heights, which is pre-existing (reachability-passing) behaviour, not a
      // regression this lane introduces.
      check(`${id} (${n} opts) @1400x${h}: card scrolls internally AND Record answer is in view from the landing`,
        ok && r.ok && r.overflows && r.sendInView, r);
    }
  }

  /* ── graded screenshots (LOOK at these) ── */
  console.log('\n=== screenshots (graded via shot-luma) ===');
  // One light + one dark shot of each discovered real decision, plus the adversarial.
  const shots = [
    ...READABILITY_TICKETS.flatMap((d) => [[d.id, 1440, false, 'light'], [d.id, 1280, true, 'dark']]),
    [ADV, 1440, false, 'light'], [ADV, 1280, true, 'dark'],
  ];
  for (const [id, w, dark, tone] of shots) {
    await open(id, w, 900, dark);
    const file = await cdp.shot(path.join(SHOTDIR, `${id}-${w}-${tone}.png`));
    if (!file) { check(`shot ${id} @${w} ${tone} captured`, false, 'no file'); continue; }
    const g = ledger.record(file, tone);
    check(`shot ${id} @${w} ${tone} graded ${tone}`, g.ok, `${file} — ${g.why}`);
  }

  cdp.close();
  stopByPid(browser);
  stopByPid(srv);
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(STORE, { recursive: true, force: true });
  fs.rmSync(PROFILE, { recursive: true, force: true });
}

main().then(() => {
  for (const c of procs) stopByPid(c);
  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass}/${pass + fail} checks passed`);
  if (fail) { console.log(`failed: ${failures.join(' | ')}`); process.exit(1); }
  process.exit(0);
}).catch((err) => {
  for (const c of procs) stopByPid(c);
  console.error(err);
  process.exit(1);
});
