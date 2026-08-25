/**
 * BUG-126 — a severity written as a sentence must not break its row.
 *
 * THE DEFECT. `.tv-row` is a CSS grid whose severity track is 52px wide. Four of
 * its five text cells (`.c-id`, `.c-title`, `.c-when`, `.c-status`) carry the
 * house clamp — `overflow:hidden; text-overflow:ellipsis; white-space:nowrap`.
 * `.c-sev` did not. A promoted ticket cannot expose that, because its record
 * normalises `severity` to an enum; a LEGACY ticket's severity is whatever its
 * `- **Severity:**` line says, and BUG-125's says `high` followed by a
 * 208-character sentence. The cell wrapped one word per line and the row grew to
 * roughly ten times its neighbours, opening a blank band across the table in
 * both themes, above the fold.
 *
 * WHY THE COLUMN AND NOT THE TWO TICKETS. BUG-125 and FEAT-091 are deliberately
 * preserved prose (FEAT-094). Editing them to suit a renderer inverts which one
 * is authoritative, and it fixes exactly two files while the next long value —
 * from any source — breaks the table again.
 *
 * WHAT THIS SUITE ASSERTS, AND HOW IT AVOIDS THE TWO TRAPS IT WAS WRITTEN AFTER.
 *
 *  1. THE PROPERTY, NOT THE INSTANCE. Not "BUG-125's row is 26px". Every row's
 *     height is measured and no row may exceed a small multiple of the median.
 *     That fails on this row today and keeps failing for any future cell that
 *     overflows, whatever the reason. Which ticket is the offender is
 *     DISCOVERED, never named — it is a legacy ticket today and correct use is
 *     free to change that — and if the board contains no ticket with an
 *     overflow-capable severity, the suite says so LOUDLY rather than passing
 *     on a corpus that cannot exercise it.
 *
 *  2. THE MUST-FAIL IS ANCHORED TO A SYNTHESIZED PRE-CHANGE STATE, NEVER `HEAD`.
 *     The clamp is REMOVED at runtime through CDP — the pre-change rule
 *     transcribed, not fetched from a revision — the rows are re-measured, and
 *     the blow-up must reappear. Then it is restored and the property must hold
 *     again. That reference cannot become the fixed state when this commits.
 *
 *  3. THE THEME EVIDENCE IS PIXELS, NOT A DOM POKE. An earlier check in this
 *     area produced two LIGHT captures and offered their byte difference as
 *     proof they differed. Here each capture is graded on its decoded pixels
 *     (`shot-luma`: a file labelled dark must BE dark), the page's computed
 *     background colour is read and asserted to be genuinely dark/light rather
 *     than merely different, and the theme is changed by CLICKING the real theme
 *     button — the user's path — not by setting `dataset.theme` from a script.
 *
 * Run: node scripts/verify-bug-126-severity-column-clamp.mjs
 * Needs a browser (`VERIFY_BROWSER`, default `brave`). Starts its own server on
 * a free ephemeral port with scratch data dirs; touches no live service.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import WebSocket from 'ws';

import { shotLedger } from './lib/shot-luma.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BRAVE = process.env.VERIFY_BROWSER ?? 'brave';
const SHOTS = process.env.BUG126_SHOTS ?? path.join(os.tmpdir(), `bug126-shots-${process.pid}`);
/** Any row taller than this multiple of the median is the defect. */
const HEIGHT_RATIO_CAP = 2.5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

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
  async waitFor(label, expr, timeoutMs = 30_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.eval(expr)) return true; } catch { /* mid-navigation */ }
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const buf = Buffer.from(r.data, 'base64');
    fs.writeFileSync(file, buf);
    console.log(`        screenshot → ${file}  (sha256:${createHash('sha256').update(buf).digest('hex').slice(0, 12)})`);
    return file;
  }
  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

/** Every row's geometry, plus the severity text and its title attribute. */
const MEASURE = `(() => {
  const rows = [...document.querySelectorAll('#tvList a.tv-row')];
  return rows.map((r) => ({
    id: r.querySelector('.c-id')?.textContent.trim() ?? '',
    h: Math.round(r.getBoundingClientRect().height),
    sevText: r.querySelector('.c-sev')?.textContent ?? '',
    sevTitle: r.querySelector('.c-sev')?.getAttribute('title') ?? null,
    sevW: Math.round(r.querySelector('.c-sev')?.getBoundingClientRect().width ?? 0),
    sevScrollW: r.querySelector('.c-sev')?.scrollWidth ?? 0,
  }));
})()`;

const median = (ns) => {
  const s = [...ns].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** The one property, graded over whatever the board currently holds. */
function gradeHeights(label, rows) {
  const med = median(rows.map((r) => r.h));
  const worst = rows.reduce((a, b) => (b.h > a.h ? b : a));
  return { med, worst, ratio: med ? worst.h / med : Infinity, label };
}

let server = null, browser = null, cdp = null;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bug126-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'bug126-store-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'bug126-profile-'));

try {
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  console.log(`\n=== BUG-126 — the severity column clamp (scratch server on :${PORT}) ===\n`);

  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (d) => { if (/error/i.test(String(d))) process.stderr.write(`  [server!] ${d}`); });
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); }
  }
  if (!up) throw new Error('scratch server never became healthy');

  // The project under test is THIS repo — the real board, read-only.
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: ROOT, name: 'BUG-126 real board' }),
  })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`could not register the real repo: ${JSON.stringify(reg).slice(0, 200)}`);

  browser = spawn(BRAVE, [
    '--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--window-size=1600,1000', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 120 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  if (!devPort) throw new Error('browser never wrote DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  cdp = await Cdp.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  await cdp.send('Page.navigate', { url: `${BASE}/#/tickets/all?project=${encodeURIComponent(pid)}` });
  const listUp = await cdp.waitFor('ticket rows', `document.querySelectorAll('#tvList a.tv-row').length >= 20`);
  check('the All-tickets list renders the real board', listUp,
    await cdp.eval(`document.querySelectorAll('#tvList a.tv-row').length + ' rows'`));
  await sleep(600);

  /* ═════════════════ 1. the corpus can actually exercise the defect ════════ */

  console.log('\n── the board must contain a severity that OVERFLOWS, or this proves nothing');
  const rows = await cdp.eval(MEASURE);
  // Overflow-capable = the text is wider than the 52px track it must live in.
  const overflowing = rows.filter((r) => r.sevScrollW > r.sevW + 1);
  check('there IS a ticket whose severity overflows the column (discovered, never named)',
    overflowing.length > 0,
    overflowing.length
      ? `${overflowing.length}: ${overflowing.map((r) => `${r.id} (${r.sevScrollW}px into a ${r.sevW}px track)`).join(', ')}`
      : 'NO overflowing severity on the board — the property cannot be exercised; if the legacy tickets were normalised, this suite has lost its subject and must be re-anchored');

  /* ═════════════════════════ 2. the property, after the fix ═══════════════ */

  console.log('\n── every row is the height of its neighbours');
  const after = gradeHeights('fixed', rows);
  check(`no row exceeds ${HEIGHT_RATIO_CAP}x the median row height`,
    after.ratio <= HEIGHT_RATIO_CAP,
    `median=${after.med}px, tallest=${after.worst.id} at ${after.worst.h}px (${after.ratio.toFixed(2)}x) over ${rows.length} rows`);

  const offender = overflowing[0];
  if (offender) {
    const row = rows.find((r) => r.id === offender.id);
    check(`the overflowing row (${offender.id}) is within one line of the median`,
      row.h <= after.med * 1.5, `${row.h}px vs median ${after.med}px`);
    check(`…and its FULL severity is still reachable — the title attribute carries it whole`,
      typeof row.sevTitle === 'string' && row.sevTitle.length >= 100 && row.sevTitle.startsWith(row.sevText.replace(/[…]$/, '').trim().slice(0, 4)),
      `title is ${row.sevTitle?.length ?? 0} chars: ${JSON.stringify(String(row.sevTitle).slice(0, 70))}…`);
  }

  const wellFormed = rows.filter((r) => /^(low|med|high|crit)$/i.test(r.sevText.trim()));
  check('a well-formed severity still renders exactly its own word, unclamped and untruncated',
    wellFormed.length > 10 && wellFormed.every((r) => r.sevScrollW <= r.sevW + 1),
    `${wellFormed.length} enum severities, none truncated`);

  /* ══════ 3. MUST-FAIL against a SYNTHESIZED pre-change state, not HEAD ════ */

  console.log('\n── MUST-FAIL: the pre-change rule, transcribed and re-applied live');
  // The pre-change declaration was `.tv-row .c-sev { font-family; font-size;
  // color }` with no clamp. Transcribed here, not fetched from a revision, so
  // committing the fix cannot turn this reference into the fixed state.
  await cdp.eval(`(() => {
    const s = document.createElement('style');
    s.id = 'bug126-prechange';
    s.textContent = '.tv-row .c-sev { overflow: visible !important; text-overflow: clip !important; white-space: normal !important; }';
    document.head.append(s);
  })()`);
  await sleep(500);
  const preRows = await cdp.eval(MEASURE);
  const before = gradeHeights('pre-change', preRows);
  check('MUST-FAIL: with the clamp removed, a row really does blow up past the cap',
    before.ratio > HEIGHT_RATIO_CAP,
    `median=${before.med}px, tallest=${before.worst.id} at ${before.worst.h}px (${before.ratio.toFixed(2)}x) — the defect, reproduced`);
  const preShot = await cdp.shot(path.join(SHOTS, 'bug126-prechange-unclamped.png'));

  await cdp.eval(`document.getElementById('bug126-prechange')?.remove()`);
  await sleep(500);
  const restored = gradeHeights('restored', await cdp.eval(MEASURE));
  check('…and restoring the clamp brings the row back to its neighbours',
    restored.ratio <= HEIGHT_RATIO_CAP && restored.worst.h < before.worst.h,
    `tallest ${before.worst.h}px → ${restored.worst.h}px (median ${restored.med}px)`);

  /* ═══════════ 4. both themes, graded on PIXELS and computed colour ═══════ */

  console.log('\n── both themes: the real theme button, decoded pixels, computed colour');
  const ledger = shotLedger();
  const bgOf = `getComputedStyle(document.body).backgroundColor`;
  const themeNow = `(document.documentElement.dataset.theme ?? 'system')`;
  // Click the real control until the requested theme is active — the user's path.
  const setTheme = async (want) => {
    for (let i = 0; i < 4; i++) {
      if (await cdp.eval(themeNow) === want) return true;
      await cdp.eval(`document.querySelector('#themeBtn')?.click()`);
      await sleep(350);
    }
    return await cdp.eval(themeNow) === want;
  };
  const lumaOf = (rgb) => {
    const [r, g, b] = (String(rgb).match(/\d+/g) ?? [0, 0, 0]).map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };

  const captured = {};
  for (const [want, tone] of [['light', 'light'], ['dark', 'dark']]) {
    const okTheme = await setTheme(want);
    check(`the theme button really switched the page to ${want}`, okTheme, await cdp.eval(themeNow));
    await sleep(500);
    const bg = await cdp.eval(bgOf);
    captured[want] = { bg, luma: lumaOf(bg) };
    // Not "the two differ" — each is asserted to be genuinely on its own side.
    check(`${want}: the COMPUTED body background is genuinely ${want}`,
      want === 'light' ? captured[want].luma > 150 : captured[want].luma < 90,
      `${bg} → luma ${captured[want].luma.toFixed(1)}`);
    const rowsT = await cdp.eval(MEASURE);
    const g = gradeHeights(want, rowsT);
    check(`${want}: no row exceeds ${HEIGHT_RATIO_CAP}x the median`,
      g.ratio <= HEIGHT_RATIO_CAP,
      `median=${g.med}px, tallest=${g.worst.id} at ${g.worst.h}px (${g.ratio.toFixed(2)}x)`);
    const file = await cdp.shot(path.join(SHOTS, `bug126-all-tickets-${want}.png`));
    const graded = ledger.record(file, tone);
    check(`${want}: the CAPTURE itself is ${tone} (decoded pixels, not the stylesheet)`, graded.ok, graded.why);
  }
  check('the two theme captures are genuinely two different renders, not one file twice',
    Math.abs(captured.light.luma - captured.dark.luma) > 100,
    `light bg ${captured.light.bg} (luma ${captured.light.luma.toFixed(1)}) vs dark bg ${captured.dark.bg} (luma ${captured.dark.luma.toFixed(1)})`);
  // The pre-change capture is graded too, so the run cannot silently reuse a file.
  const preGraded = ledger.record(preShot, null);
  check('the pre-change capture is its own distinct image', preGraded.ok, preGraded.why);
} catch (err) {
  check('the run completed without throwing', false, String(err?.stack ?? err));
} finally {
  cdp?.close();
  for (const p of [browser, server]) { try { if (p?.pid) process.kill(p.pid, 'SIGTERM'); } catch { /* gone */ } }
  await sleep(800);
  for (const d of [DATA, STORE, PROFILE]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* leave it */ } }
}

console.log(`\n${'═'.repeat(70)}\nverify:bug-126 — ${pass} passed, ${fail} failed`);
if (fail) { console.log('failed:'); for (const f of failures) console.log(`  - ${f}`); }
console.log(`captures kept in ${SHOTS}`);
process.exit(fail ? 1 : 0);
