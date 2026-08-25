/**
 * ARCH-004 (UI) — A TICKET WHOSE STATE CANNOT BE READ MUST LOOK LIKE ONE.
 *
 *   node scripts/verify-arch-004-broken-state-visible.mjs
 *   node scripts/verify-arch-004-broken-state-visible.mjs --no-red   # skip the base-worktree RED leg
 *
 * THE GAP THIS CLOSES. Three rounds of work taught the schema every way a
 * ticket can fail to declare exactly one interpretable state, and the server
 * carries the verdict on every summary as `statusError` / `statusWarning`.
 * `public/app.js` read neither field: a ticket with two contradictory
 * `- **Status:**` lines drew an ordinary row showing the first line's raw prose,
 * which is the same silent failure the parser work fixed, one layer out.
 *
 * WHAT IS REAL HERE. Everything except the nine broken tickets, which cannot be
 * real because the corpus has none (that is the defect's own alibi — nobody has
 * ever SEEN one). So the scratch board is the REAL 190-ticket corpus copied off
 * disk, with nine synthetic defects added to it: the broken row has to be
 * findable on a busy board, and the ~190 healthy rows have to stay silent. The
 * nine shapes are the schema's own enumeration, one ticket each. The server,
 * the API payload, the browser (brave --headless=new over raw CDP) and
 * public/app.js are all real; the board is copied read-only, never edited.
 *
 * THE LEGS
 *   RED   — the SAME payload rendered by the pre-change tree (a git worktree at
 *           HEAD, served by its own server): the contradictory ticket's row is
 *           proven INDISTINGUISHABLE from the healthy one, cell for cell.
 *   API   — every seeded shape arrives with the statusError/statusWarning the
 *           schema promises, and the healthy ones arrive with neither.
 *   TEXT  — each error row shows the SERVER'S headline instead of a state, each
 *           warning row keeps its state and takes one small mark, and every one
 *           carries the server's full sentence (never the UI's own wording).
 *   AX    — the message is in the accessibility tree: on the row (as part of the
 *           link's accessible name) and in the detail pane (a `note` landmark).
 *           A badge that is invisible to a screen reader is the same failure.
 *   QUIET — a healthy row renders BYTE-IDENTICALLY to the pre-change tree.
 *   COLOR — WCAG contrast for every new ink against the surface it really lands
 *           on, in BOTH themes, composited (the washes are alpha).
 *   SHOTS — nine captures, each graded by scripts/lib/shot-luma.mjs (tone +
 *           no byte-identical twins) and reviewed by eye.
 *
 * Theme is CDP `Emulation.setEmulatedMedia` prefers-color-scheme — never
 * localStorage. Ports are OS-assigned; :4317 is never touched. Every process is
 * one this script spawned, and is stopped by PID.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import WebSocket from 'ws';
import { shotLedger } from './lib/shot-luma.mjs';
import { scratchRoot } from './lib/scratch.mjs';

const ARGS = process.argv.slice(2);
const NO_RED = ARGS.includes('--no-red');
const ROOT = path.resolve(import.meta.dirname, '..');
// No absolute path is written in-tree: `scratchRoot()` is the project's own
// resolver ($CLAUDE_STATION_SCRATCH, else $XDG_STATE_HOME/…, else ~/.local/state),
// so this file carries no home directory and no username. A leak in a test
// script is one careless `git add` away from a public commit.
const SCRATCH = process.env.ARCH004_SCRATCH ?? path.join(scratchRoot(), 'arch-004-ui');
const WORK = path.join(SCRATCH, 'project');
const BUGS = path.join(WORK, 'docs', 'bugs');
const BASE_TREE = path.join(SCRATCH, 'base-tree');
const SHOTS = path.join(ROOT, 'docs', 'bugs', 'assets', 'arch-004');
const BRAVE = process.env.VERIFY_BROWSER ?? 'brave';
const REAL_BUGS = path.join(ROOT, 'docs', 'bugs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

/* ══════════════════════════════════════════════════ the nine broken shapes */

/* One ticket per row of the schema's own enumeration (ticket-schema.mjs,
 * "EVERY WAY A TICKET'S STATE CAN FAIL TO BE ONE UNAMBIGUOUS VALUE"), plus two
 * healthy controls. `expect` is what the SCHEMA promises — asserted against the
 * live API before any pixel is looked at, so a seed that stops reproducing its
 * defect fails loudly instead of quietly testing nothing. */
const SEEDS = [
  { id: 'BUG-901', kind: 'healthy',  title: 'healthy open control',        status: '- **Status:** OPEN\n',                                    expect: { err: null, warn: null } },
  { id: 'BUG-902', kind: 'healthy',  title: 'healthy verified control',    status: '- **Status:** VERIFIED\n',                                expect: { err: null, warn: null } },
  { id: 'BUG-903', kind: 'error',    title: 'no status line at all',       status: '',                                                        expect: { err: 'MISSING STATUS FIELD', warn: null } },
  { id: 'BUG-904', kind: 'error',    title: 'status line with no value',   status: '- **Status:** \n',                                        expect: { err: 'EMPTY STATUS FIELD', warn: null } },
  { id: 'BUG-905', kind: 'error',    title: 'a word the table cannot map', status: '- **Status:** MOSTLY SORTED\n',                           expect: { err: 'UNMAPPABLE STATUS', warn: null } },
  { id: 'BUG-906', kind: 'error',    title: 'two states that disagree',    status: '- **Status:** OPEN\n- **Status:** VERIFIED\n',            expect: { err: 'DUPLICATE STATUS FIELD', warn: null } },
  { id: 'BUG-907', kind: 'warn',     title: 'two states that agree',       status: '- **Status:** VERIFIED\n- **Status:** VERIFIED/DONE\n',   expect: { err: null, warn: 'DUPLICATE STATUS FIELD' } },
  { id: 'BUG-908', kind: 'both',     title: 'the state is down in prose',  status: '', body: '\n## Notes\n\n- **Status:** OPEN\n',            expect: { err: 'MISSING STATUS FIELD', warn: 'STATUS OUTSIDE HEADER' } },
  { id: 'BUG-909', kind: 'error',    title: 'a near-miss line that fights', status: '- **Status:** OPEN\n- **Status**: VERIFIED\n',            expect: { err: 'CONTRADICTORY STATUS LINE', warn: null } },
  { id: 'BUG-911', kind: 'warn',     title: 'a near-miss line that agrees', status: '- **Status:** OPEN\n- **Status**: OPEN\n',                expect: { err: null, warn: 'MALFORMED STATUS LINE' } },
  { id: 'BUG-910', kind: 'warn',     title: 'placed by an incidental token', status: '- **Status:** BLOCKED until the DONE criteria land\n',  expect: { err: null, warn: 'AMBIGUOUS STATUS' } },
];
const byId = (id) => SEEDS.find((s) => s.id === id);
const ERRORS = SEEDS.filter((s) => s.expect.err);
const WARNS = SEEDS.filter((s) => s.expect.warn);
const HEALTHY = SEEDS.filter((s) => s.kind === 'healthy');
const CONTRADICTORY = 'BUG-906';
const HEALTHY_TWIN = 'BUG-901';

/* Activity dates are chosen so the DIGEST's recent lane (7 days, top 10) ends up
 * MIXED — the error seeds are today, everything else is outside the window — so
 * the landing screen is graded the way a user would really meet it: a handful of
 * real tickets with a broken one among them, not a screen of nothing but seeds. */
const TODAY = '2026-08-19';
const OLD = '2026-08-01';
/* The healthy TWIN is dated with the error seeds on purpose: the RED leg
 * compares it cell-for-cell against the contradictory ticket, and a differing
 * Activity date would be a difference the pre-change UI is allowed to have. */
const seedDate = (s) => (s.expect.err || s.id === HEALTHY_TWIN ? TODAY : OLD);
const seedFile = (s) => `${s.id}-${s.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.md`;
const seedText = (s) => `# ${s.id} — ${s.title}\n`
  + s.status
  + `- **Severity:** high\n- **Area:** ui/tickets\n- **Reported:** ${seedDate(s)} (verify-arch-004)\n`
  + `\n## Summary\n\nA synthetic ticket seeded by verify-arch-004-broken-state-visible.mjs so the\ndashboard can be shown a state it cannot read. ${s.title}.\n`
  + (s.body ?? '')
  + `\n## Activity log\n\n### ${seedDate(s)} — verify-arch-004\n- seeded.\n`;

/* Two REAL tickets on this project's own board carry an AMBIGUOUS STATUS
 * warning today. They are not seeded and not cleaned up: they are the proof
 * that this treatment appears on the REAL corpus, so they are named here and
 * expected rather than tolerated. If the board is repaired, this list shrinks
 * and the assertion below says so instead of silently passing. */
const REAL_KNOWN_WARN = ['FEAT-020', 'FEAT-043'];

/** The REAL corpus, copied read-only, plus the nine defects — a busy board. */
function seedBoard() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(BUGS, { recursive: true });
  let copied = 0;
  for (const n of fs.readdirSync(REAL_BUGS)) {
    if (!/\.md$/.test(n)) continue;
    fs.copyFileSync(path.join(REAL_BUGS, n), path.join(BUGS, n));
    copied++;
  }
  for (const s of SEEDS) fs.writeFileSync(path.join(BUGS, seedFile(s)), seedText(s));
  // Splice the seeds into the copied INDEX's Open table so they carry a curated
  // row like every other open ticket (the boardStatus blurb is what an error
  // row must REPLACE — without it the test would prove less).
  const idx = path.join(BUGS, 'INDEX.md');
  let text = fs.readFileSync(idx, 'utf8');
  // Owner '—': the digest's Awaiting-you / In-flight lanes are driven by the
  // curated owner glyph, and a ticket in those lanes never reaches the recent
  // lane. Unowned rows land where the state pill actually claims done-or-open,
  // which is the digest surface under test.
  const rows = SEEDS.map((s) => `| ${s.id} | ${s.title} | — | seeded for ARCH-004 | high |`).join('\n');
  const at = text.indexOf('\n## Done');
  text = at === -1 ? `${text}\n${rows}\n` : `${text.slice(0, at)}\n${rows}\n${text.slice(at)}`;
  fs.writeFileSync(idx, text);
  return copied;
}

/* ═══════════════════════════════════════════════════════════════════ infra */

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

/** A server rooted at `tree` (its own public/ is what the browser gets). */
async function bootServer(tree, tag) {
  const port = await freePort();
  const data = path.join(SCRATCH, `data-${tag}`);
  const store = path.join(SCRATCH, `store-${tag}`);
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(store, { recursive: true });
  const child = spawn(process.execPath, [path.join(tree, 'src', 'server', 'index.ts')], {
    cwd: tree,
    env: { ...process.env, PORT: String(port), CLAUDE_STATION_DATA: data, CLAUDE_PROJECTS_DIR: store },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  procs.push(child);
  child.stderr?.on('data', (d) => { const s = String(d); if (/error|Error/.test(s)) process.stderr.write(`  [${tag}!] ${s}`); });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try { await fetch(`${base}/api/health`); up = true; } catch { await sleep(250); }
  }
  if (!up) throw new Error(`${tag} server never became healthy`);
  const reg = await (await fetch(`${base}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: WORK, name: `ARCH-004 ${tag}` }),
  })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`${tag}: could not register the scratch project: ${JSON.stringify(reg).slice(0, 200)}`);
  return { base, pid, tag };
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c = new Cdp(ws);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && c.waiting.has(m.id)) { const { res, rej } = c.waiting.get(m.id); c.waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    });
    return c;
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.waiting.set(id, { res, rej })); }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async waitFor(label, expr, timeoutMs = 30000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) { try { if (await this.eval(expr)) return true; } catch { /* mid-nav */ } await sleep(150); }
    console.log(`        (timed out waiting for ${label})`);
    return false;
  }
  async theme(tone) { await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: tone }] }); }
  async viewport(width, height) { await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 900 }); }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

/* ═══════════════════════════════════════════════ in-page measuring routines */

/** One row, reduced to what a reader can actually perceive. */
const ROW_SHAPE = (id) => `(() => {
  const r = document.querySelector('#tvList a.tv-row[data-id=${JSON.stringify(id)}]');
  if (!r) return null;
  const st = r.querySelector('.c-status');
  const cs = st && getComputedStyle(st);
  const rowCs = getComputedStyle(r);
  const mark = r.querySelector('.c-flawmark');
  const sr = r.querySelector('.sr-only');
  return {
    rowClass: r.className,
    cells: [...r.children].map((c) => c.className + '=' + c.textContent),
    statusClass: st ? st.className : null,
    statusText: st ? st.textContent : null,
    visibleText: st ? [...st.childNodes].filter((n) => !(n.nodeType === 1 && n.classList.contains('sr-only'))).map((n) => n.textContent).join('') : null,
    title: st ? st.getAttribute('title') : null,
    srText: sr ? sr.textContent : null,
    statusColor: cs ? cs.color : null,
    statusBg: cs ? cs.backgroundColor : null,
    statusBorder: cs ? cs.borderTopColor : null,
    statusVisible: st ? (st.getBoundingClientRect().width > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0) : false,
    statusWidth: st ? Math.round(st.getBoundingClientRect().width) : 0,
    markWidth: mark ? Math.round(mark.getBoundingClientRect().width) : 0,
    markColor: mark ? getComputedStyle(mark).color : null,
    rowShadow: rowCs.boxShadow,
    accName: r.getAttribute('aria-label') || r.textContent,
  };
})()`;

/** The detail pane's notes, verbatim. */
const NOTES = `(() => {
  const d = document.querySelector('#tvDetail .tv-doc');
  if (!d) return null;
  const notes = [...d.querySelectorAll('.tv-flaw')].map((n) => ({
    level: n.classList.contains('err') ? 'error' : 'warn',
    label: n.querySelector('.tvf-k').textContent,
    aria: n.getAttribute('aria-label'),
    role: n.getAttribute('role'),
    lines: [...n.querySelectorAll('.tvf-m')].map((p) => p.textContent),
    visible: n.getBoundingClientRect().height > 0,
    afterMeta: n.previousElementSibling ? n.previousElementSibling.className : null,
    beforeMd: !!n.nextElementSibling && (n.nextElementSibling.classList.contains('tv-md') || n.nextElementSibling.classList.contains('tv-flaw')),
  }));
  // GEOMETRY, not DOM order. The notes were once correct in the markup and
  // rendered at the FOOT of the page — the detail is a named-area grid, and an
  // unplaced child is auto-placed into whatever cell is spare. So what is
  // asserted is where the reader's eye finds it: inside the content column,
  // below the title, above the document, left-aligned with the prose.
  const box = (sel) => { const e = d.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), width: Math.round(r.width) }; };
  return { id: d.dataset.id, notes,
    geom: { flaws: box('.tv-flaws'), title: box('.tv-dtitle'), md: box('.tv-md'), meta: box('.tv-dmeta'), form: box('.tv-noteform') },
    statusKv: d.querySelector('.d-status') ? d.querySelector('.d-status').className + '=' + d.querySelector('.d-status').textContent : null };
})()`;

/* WCAG contrast against the surface a mark REALLY lands on. The washes are
   alpha (color-mix(... transparent)), so the background is composited up the
   ancestor chain rather than read off one element — which is precisely the
   mistake that shipped dark text on a dark card here once before. */
const CONTRAST_FN = `
  // color-mix() resolves to \`color(srgb r g b / a)\` with 0..1 channels in
  // Chrome, NOT to rgb() with 0..255. Reading those as 0..255 silently reports
  // ~1:1 for every mixed ink — a contrast guard that cannot see the colours it
  // was written to guard. Both notations are parsed here.
  const parse = (c) => {
    const v = (c.match(/[\\d.]+/g) || ['0','0','0']).slice(0, 4).map(Number);
    const s = /^color\\(/.test(c) ? 255 : 1;
    return { r: v[0] * s, g: v[1] * s, b: v[2] * s, a: v.length > 3 ? v[3] : 1 };
  };
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const bgOf = (el) => {
    let acc = { r: 255, g: 255, b: 255, a: 0 }, stack = [];
    for (let n = el; n; n = n.parentElement) stack.push(parse(getComputedStyle(n).backgroundColor));
    let out = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i], out);
    return out;
  };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const ratio = (fgc, el) => { const bg = bgOf(el); const fg = over(parse(fgc), bg); const a = lum(fg), b = lum(bg); const hi = Math.max(a, b), lo = Math.min(a, b); return +((hi + 0.05) / (lo + 0.05)).toFixed(2); };
`;

const MEASURE_INK = (sel, label) => `(() => {
  ${CONTRAST_FN}
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  const cs = getComputedStyle(el);
  const bg = bgOf(el);
  return { label: ${JSON.stringify(label)}, theme: document.documentElement.dataset.theme || null,
    color: cs.color, bg: 'rgb(' + [bg.r, bg.g, bg.b].map(Math.round).join(',') + ')',
    ratio: ratio(cs.color, el), fontSize: cs.fontSize };
})()`;

/* ═════════════════════════════════════════════════════════════════════ main */

let browser = null, cdp = null, ledger = null, worktreeMade = false;

async function main() {
  // A fresh run gets a fresh scratch: a leftover data dir keeps a project
  // registration pointing at the same path, which the server (rightly) refuses.
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  spawnSync('git', ['worktree', 'prune'], { cwd: ROOT });
  ledger = shotLedger();
  const copied = seedBoard();
  check('PRECONDITION: the scratch board is the REAL corpus (copied) plus the nine synthetic defects',
    copied >= 100 && SEEDS.every((s) => fs.existsSync(path.join(BUGS, seedFile(s)))),
    `${copied} real ticket files copied + ${SEEDS.length} seeded = ${fs.readdirSync(BUGS).filter((n) => /\.md$/.test(n)).length} files`);

  const fixed = await bootServer(ROOT, 'fixed');

  /* ═════════ API: the transport really carries the verdict ═════════ */
  console.log('\n=== API: every seeded shape arrives with the schema\'s verdict ===');
  const list = await (await fetch(`${fixed.base}/api/projects/${fixed.pid}/tickets`)).json();
  const tix = new Map((list.tickets ?? []).map((t) => [t.id, t]));
  check('the list route returns the whole busy board (real corpus + seeds)',
    (list.tickets?.length ?? 0) >= copied, `${list.tickets?.length} tickets`);
  for (const s of SEEDS) {
    const t = tix.get(s.id);
    const errOk = s.expect.err ? String(t?.statusError ?? '').startsWith(s.expect.err) : t?.statusError === null;
    const warnOk = s.expect.warn ? String(t?.statusWarning ?? '').includes(s.expect.warn) : t?.statusWarning === null;
    check(`  ${s.id} (${s.kind}) — ${s.expect.err ?? s.expect.warn ?? 'clean'}`, errOk && warnOk,
      JSON.stringify({ err: t?.statusError?.slice(0, 46) ?? null, warn: t?.statusWarning?.slice(0, 46) ?? null }));
  }
  const realBroken = (list.tickets ?? []).filter((t) => !SEEDS.some((s) => s.id === t.id) && (t.statusError || t.statusWarning));
  check('the REAL corpus flags exactly the tickets it should — this treatment is not hypothetical, it shows on THIS board today',
    JSON.stringify(realBroken.map((t) => t.id).sort()) === JSON.stringify([...REAL_KNOWN_WARN].sort())
      && realBroken.every((t) => t.statusError === null),
    realBroken.map((t) => `${t.id}: ${(t.statusError || t.statusWarning).slice(0, 46)}`).join(' | ') || 'none');

  /* ═════════ browser ═════════ */
  const profile = path.join(SCRATCH, 'chrome');
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  browser = spawn(BRAVE, [
    '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--window-size=1500,1000', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  procs.push(browser);
  let devPort = 0;
  for (let i = 0; i < 120 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  if (!devPort) throw new Error('browser never wrote DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  cdp = await Cdp.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Accessibility.enable');
  await cdp.viewport(1500, 1000);
  await cdp.theme('dark');

  /* ═════════ RED: the pre-change tree renders the defect as ordinary ═════════ */
  let redShapes = null;
  if (!NO_RED) {
    console.log('\n=== MUST-FAIL (pre-change tree, same payload): the broken ticket is indistinguishable ===');
    fs.rmSync(BASE_TREE, { recursive: true, force: true });
    const wt = spawnSync('git', ['worktree', 'add', '--detach', BASE_TREE, 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
    if (wt.status !== 0) throw new Error(`git worktree add failed: ${wt.stderr}`);
    worktreeMade = true;
    try { fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(BASE_TREE, 'node_modules')); } catch { /* present */ }
    const base = await bootServer(BASE_TREE, 'base');
    await cdp.send('Page.navigate', { url: `${base.base}/#/tickets/all?project=${encodeURIComponent(base.pid)}` });
    const up = await cdp.waitFor('base rows', `document.querySelectorAll('#tvList a.tv-row').length > 50`);
    redShapes = {
      broken: await cdp.eval(ROW_SHAPE(CONTRADICTORY)),
      healthy: await cdp.eval(ROW_SHAPE(HEALTHY_TWIN)),
    };
    const cellsEqual = up && redShapes.broken && redShapes.healthy
      && JSON.stringify(redShapes.broken.cells.filter((c) => !/^c-(id|title)=/.test(c)))
         === JSON.stringify(redShapes.healthy.cells.filter((c) => !/^c-(id|title)=/.test(c)))
      && redShapes.broken.rowClass === redShapes.healthy.rowClass
      && redShapes.broken.statusColor === redShapes.healthy.statusColor;
    check('RED: on the pre-change tree the CONTRADICTORY ticket renders cell-for-cell like the healthy one',
      cellsEqual, JSON.stringify({ broken: redShapes.broken?.cells, healthy: redShapes.healthy?.cells, sameInk: redShapes.broken?.statusColor === redShapes.healthy?.statusColor }));
    check('RED: the pre-change row shows the server NOTHING — no message text anywhere in the row',
      !!redShapes.broken && !String(redShapes.broken.accName).includes('DUPLICATE'),
      `row text = ${JSON.stringify(String(redShapes.broken?.accName ?? '').slice(0, 90))}`);
    await cdp.eval(`(() => { const r = document.querySelector('#tvList a.tv-row[data-id=${JSON.stringify(CONTRADICTORY)}]'); r.scrollIntoView({ block: 'center' }); r.click(); })()`);
    const dUp = await cdp.waitFor('base detail', `document.querySelector('#tvDetail .tv-doc')?.dataset.id === ${JSON.stringify(CONTRADICTORY)}`);
    const redDetail = await cdp.eval(`(() => { const d = document.querySelector('#tvDetail .tv-doc'); return { notes: d ? d.querySelectorAll('.tv-flaw').length : -1, text: d ? d.querySelector('.tv-dmeta').textContent : '' }; })()`);
    check('RED: the pre-change DETAIL pane says nothing either — no note, and the metadata claims a state',
      dUp && redDetail.notes === 0 && /OPEN/.test(redDetail.text),
      JSON.stringify({ notes: redDetail.notes, meta: redDetail.text.slice(0, 80) }));
    await ledgerShot('red-list-dark.png', 'dark', 'RED: pre-change list (dark)');
  }

  /* ═════════ GREEN: the fixed tree ═════════ */
  const listUrl = `${fixed.base}/#/tickets/all?project=${encodeURIComponent(fixed.pid)}`;
  await cdp.send('Page.navigate', { url: listUrl });
  const up = await cdp.waitFor('fixed rows', `document.querySelectorAll('#tvList a.tv-row').length > 50`);
  const total = await cdp.eval(`document.querySelectorAll('#tvList a.tv-row').length`);
  check('the fixed tree renders the same busy board', up && total > 100, `${total} rows on screen`);

  console.log('\n=== the ERROR shapes: the row stops claiming a state and shows the server\'s words ===');
  const shapes = new Map();
  for (const s of SEEDS) shapes.set(s.id, await cdp.eval(ROW_SHAPE(s.id)));
  for (const s of ERRORS) {
    const r = shapes.get(s.id);
    const msg = tix.get(s.id).statusError;
    const ok = !!r
      && /\bflaw-err\b/.test(r.rowClass)
      && /\bst-flaw-err\b/.test(r.statusClass)
      && r.visibleText.trim() === s.expect.err          // the SERVER's headline, not ours
      && r.title === msg                                // the full sentence, verbatim
      && r.srText.includes(msg)                         // …and not by hover alone
      && r.statusVisible && r.statusWidth > 20
      && r.rowShadow !== 'none';                        // the scanning edge
    check(`  ${s.id} — the tag reads "${s.expect.err}", carries the whole message, and the row takes an edge`, ok,
      JSON.stringify({ text: r?.visibleText, cls: r?.statusClass, w: r?.statusWidth, titleIsServerMsg: r?.title === msg, sr: String(r?.srText).slice(0, 40), shadow: r?.rowShadow }));
    const claims = String(r?.visibleText ?? '');
    check(`     …and it does NOT print a state word next to the error (${s.id})`,
      !/\b(OPEN|VERIFIED|FIXED|Done|seeded for ARCH-004)\b/.test(claims), JSON.stringify(claims));
  }

  console.log('\n=== the WARNING shapes: the state stands, one small mark is added ===');
  for (const s of WARNS) {
    const r = shapes.get(s.id);
    const msg = tix.get(s.id).statusWarning;
    const err = tix.get(s.id).statusError;
    if (err) {
      // BUG-908 is BOTH: the error dominates the row (the state is unreadable),
      // and the warning that explains WHY waits in the detail pane.
      check(`  ${s.id} — carries an error too, so the ROW shows the error (the warning explains it in the pane)`,
        /\bflaw-err\b/.test(r.rowClass) && r.title === err, JSON.stringify({ cls: r?.rowClass, title: String(r?.title).slice(0, 40) }));
      continue;
    }
    const stateWord = tix.get(s.id).section === 'done' ? 'Done' : (tix.get(s.id).boardStatus || tix.get(s.id).status);
    const ok = !!r
      && !/\bflaw-err\b/.test(r.rowClass)
      && /\bflaw-warn\b/.test(r.rowClass)
      && r.visibleText.startsWith(stateWord)   // the answer is NOT in doubt: it still shows
      && r.title === msg
      && r.srText.includes(msg)
      && r.markWidth > 3 && r.markWidth < 24   // one mark, rendered, not a tofu block or an emoji slab
      && r.rowShadow === 'none';               // no brick edge — this is not an alarm
    check(`  ${s.id} — keeps "${stateWord}", adds one amber mark (${r?.markWidth}px), full message on hover + to AT`, ok,
      JSON.stringify({ text: r?.visibleText, mark: r?.markWidth, markInk: r?.markColor, edge: r?.rowShadow, cls: r?.rowClass }));
  }

  console.log('\n=== QUIET: a healthy row is untouched — byte-identical to the pre-change tree ===');
  for (const s of HEALTHY) {
    const r = shapes.get(s.id);
    check(`  ${s.id} — no flaw class, no mark, no edge, ordinary status tag`,
      !!r && !/flaw/.test(r.rowClass) && !/flaw/.test(r.statusClass) && r.markWidth === 0 && !r.srText && r.rowShadow === 'none',
      JSON.stringify({ rowClass: r?.rowClass, statusClass: r?.statusClass, text: r?.statusText }));
  }
  if (redShapes) {
    check('  the healthy row renders IDENTICALLY before and after the change (the board did not get noisier)',
      JSON.stringify(shapes.get(HEALTHY_TWIN)) === JSON.stringify(redShapes.healthy),
      `identical=${JSON.stringify(shapes.get(HEALTHY_TWIN)) === JSON.stringify(redShapes.healthy)}`);
  }
  const noisy = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('#tvList a.tv-row')];
    const flagged = rows.filter((r) => /flaw/.test(r.className)).map((r) => r.dataset.id);
    return { rows: rows.length, flagged };
  })()`);
  const wantFlagged = [...SEEDS.filter((s) => s.kind !== 'healthy').map((s) => s.id), ...REAL_KNOWN_WARN].sort();
  check('  on a ~200-row board exactly the nine seeded defects + the two REAL ambiguous tickets are marked — nothing else lit up',
    JSON.stringify([...noisy.flagged].sort()) === JSON.stringify(wantFlagged),
    JSON.stringify({ rows: noisy.rows, flagged: noisy.flagged.sort(), want: wantFlagged }));

  /* ═════════ the accessibility tree ═════════ */
  console.log('\n=== AX: the message is in the accessibility tree, not only in pixels ===');
  const axName = await axNameOf(`#tvList a.tv-row[data-id="${CONTRADICTORY}"]`);
  check('the flawed ROW\'s accessible name carries the server\'s sentence (a screen reader hears the defect)',
    axName.includes('DUPLICATE STATUS FIELD') && axName.includes('disagree'),
    JSON.stringify(axName.slice(0, 150)));
  const axHealthy = await axNameOf(`#tvList a.tv-row[data-id="${HEALTHY_TWIN}"]`);
  check('  …and the healthy row\'s name gains nothing', !/STATUS/.test(axHealthy), JSON.stringify(axHealthy.slice(0, 90)));

  /* ═════════ the detail pane ═════════ */
  console.log('\n=== the DETAIL pane: the whole sentence, under the facts it contradicts ===');
  const detailShots = [];
  for (const s of SEEDS) {
    await openTicket(fixed, s.id);
    const d = await cdp.eval(NOTES);
    const t = tix.get(s.id);
    const want = [];
    if (t.statusError) want.push({ level: 'error', label: 'status error', line: t.statusError });
    if (t.statusWarning) want.push({ level: 'warn', label: 'status warning', lines: t.statusWarning.split(' | ') });
    if (!want.length) {
      check(`  ${s.id} (healthy) — the detail pane grows no note at all`, d.notes.length === 0, JSON.stringify(d));
      continue;
    }
    const got = d.notes;
    const ok = got.length === want.length && want.every((w, i) => got[i].level === w.level
      && got[i].label === w.label && got[i].role === 'note' && got[i].aria === w.label && got[i].visible
      && (w.line ? got[i].lines.length === 1 && got[i].lines[0] === w.line
                 : JSON.stringify(got[i].lines) === JSON.stringify(w.lines.map((x) => x.trim()))));
    check(`  ${s.id} — ${want.map((w) => w.label).join(' + ')}, verbatim, visible, in reading order`, ok,
      JSON.stringify(got.map((n) => ({ level: n.level, label: n.label, role: n.role, after: n.afterMeta, lines: n.lines.map((l) => l.slice(0, 44)) }))));
    if (t.statusError) {
      check(`     …and the status field in the metadata strip goes brick too (${s.id})`,
        /st-flaw-err/.test(String(d.statusKv)), JSON.stringify(d.statusKv));
    }
    const g = d.geom;
    check(`     …and it is WHERE a reader looks: in the prose column, under the title, above the document (${s.id})`,
      !!g.flaws && g.flaws.top > g.title.top && g.flaws.bottom <= g.md.top + 2
        && g.flaws.left === g.md.left && g.flaws.left < g.meta.left && g.flaws.width > 380,
      JSON.stringify(g));
  }

  // BUG-908 carries both — the one ticket that proves error and warning are two
  // appearances rather than one collapsed "problem" state.
  await openTicket(fixed, 'BUG-908');
  const both = await cdp.eval(`(() => {
    ${CONTRAST_FN}
    const ns = [...document.querySelectorAll('#tvDetail .tv-flaw')];
    return ns.map((n) => ({ cls: n.className, k: getComputedStyle(n.querySelector('.tvf-k')).color, border: getComputedStyle(n).borderTopColor, bg: getComputedStyle(n).backgroundColor }));
  })()`);
  check('a ticket with BOTH shows TWO distinct notes — different ink, different border, not one merged blob',
    both.length === 2 && both[0].k !== both[1].k && both[0].border !== both[1].border,
    JSON.stringify(both));
  const axNotes = await axNotesOf();
  check('both notes reach the accessibility tree as named `note` landmarks carrying the sentence',
    axNotes.length === 2 && axNotes.some((n) => n.name === 'status error' && /DUPLICATE|MISSING/.test(n.text))
      && axNotes.some((n) => n.name === 'status warning' && /OUTSIDE HEADER/.test(n.text)),
    JSON.stringify(axNotes.map((n) => ({ role: n.role, name: n.name, text: n.text.slice(0, 50) }))));

  /* ═════════ colour, in BOTH themes ═════════ */
  console.log('\n=== COLOR: every new ink, composited, in both themes (AA = 4.5:1 for this text size) ===');
  const INKS = [
    ['#tvDetail .tv-flaw.err .tvf-k', 'detail note — ERROR label'],
    ['#tvDetail .tv-flaw.err .tvf-m', 'detail note — ERROR message'],
    ['#tvDetail .tv-flaw.warn .tvf-k', 'detail note — WARNING label'],
    ['#tvDetail .tv-flaw.warn .tvf-m', 'detail note — WARNING message'],
    ['#tvDetail .tv-dmeta .d-status.st-flaw-err', 'detail metadata — status value'],
  ];
  const ROW_INKS = [
    [`#tvList a.tv-row[data-id="${CONTRADICTORY}"] .c-status`, 'list row — ERROR tag'],
    ['#tvList a.tv-row.flaw-warn .c-status .c-flawmark', 'list row — WARNING mark'],
    ['#tvList a.tv-row.flaw-warn .c-status', 'list row — WARNING status text'],
  ];
  for (const tone of ['dark', 'light']) {
    await cdp.theme(tone);
    await sleep(200);
    await openTicket(fixed, 'BUG-908');
    for (const [sel, label] of INKS) {
      const m = await cdp.eval(MEASURE_INK(sel, label));
      check(`  ${tone.padEnd(5)} ${label}`, !!m && m.ratio >= 4.5,
        m ? `${m.ratio}:1  ${m.color} on ${m.bg} @${m.fontSize}` : 'element not found');
    }
    await backToList(fixed);
    for (const [sel, label] of ROW_INKS) {
      const m = await cdp.eval(MEASURE_INK(sel, label));
      // The amber mark is a 9.5px glyph carrying meaning, so it is held to the
      // same 4.5:1 as text — a decorative-only exemption would be a lie here.
      check(`  ${tone.padEnd(5)} ${label}`, !!m && m.ratio >= 4.5,
        m ? `${m.ratio}:1  ${m.color} on ${m.bg} @${m.fontSize}` : 'element not found');
    }
    // The two levels must not merely both be legible — they must be TELLABLE APART.
    const distinct = await cdp.eval(`(() => {
      const e = document.querySelector('#tvList a.tv-row.flaw-err .c-status');
      const w = document.querySelector('#tvList a.tv-row.flaw-warn .c-status .c-flawmark');
      return { err: getComputedStyle(e).color, warn: getComputedStyle(w).color, errBg: getComputedStyle(e).backgroundColor };
    })()`);
    check(`  ${tone.padEnd(5)} the ERROR ink and the WARNING ink are different colours`,
      distinct.err !== distinct.warn, JSON.stringify(distinct));
  }

  /* ═════════ the digest (the landing screen) ═════════ */
  console.log('\n=== the DIGEST: the landing screen does not print a confident "Open" either ===');
  await cdp.theme('dark');
  await cdp.send('Page.navigate', { url: `${fixed.base}/#/tickets?project=${encodeURIComponent(fixed.pid)}` });
  await cdp.waitFor('digest', `document.querySelectorAll('#tvDigest .dg-recent-item').length > 0`);
  const dg = await cdp.eval(`(() => {
    const items = [...document.querySelectorAll('#tvDigest .dg-recent-item')].map((a) => ({
      id: a.dataset.id, state: a.querySelector('.dg-state')?.textContent ?? null,
      cls: a.querySelector('.dg-state')?.className ?? null,
      title: a.querySelector('.dg-state')?.getAttribute('title') ?? null,
    }));
    return { n: items.length,
      flawed: items.filter((i) => /st-flaw-err/.test(i.cls || '')),
      plain: items.filter((i) => !/st-flaw-err/.test(i.cls || '')) };
  })()`);
  check('a ticket whose state cannot be read shows the schema\'s headline on the digest, not "Open"',
    dg.flawed.length > 0 && dg.flawed.every((i) => /STATUS/.test(i.state) && String(i.title).length > 40),
    JSON.stringify({ flawed: dg.flawed.map((i) => [i.id, i.state]), of: dg.n }));
  check('  …and the healthy rows sharing that lane still read as plain Open/Done (the digest did not become an alarm board)',
    dg.plain.length > 0 && dg.plain.every((i) => i.state === 'Open' || i.state === 'Done'),
    JSON.stringify({ plain: dg.plain.map((i) => [i.id, i.state]), flawed: dg.flawed.length, of: dg.n }));
  await ledgerShot('digest-dark.png', 'dark', 'digest (dark)');

  /* ═════════ narrow ═════════ */
  console.log('\n=== NARROW (600px): the Status column is dropped — the unreadable state is not ===');
  await cdp.viewport(600, 900);
  await cdp.theme('light');
  await backToList(fixed);
  await sleep(250);
  const narrow = await cdp.eval(`(() => {
    const pick = (id) => { const r = document.querySelector('#tvList a.tv-row[data-id="' + id + '"]'); const s = r && r.querySelector('.c-status');
      return { shown: s ? getComputedStyle(s).display !== 'none' : null, text: s ? s.textContent.replace(/ — status.*$/, '') : null, w: s ? Math.round(s.getBoundingClientRect().width) : 0 }; };
    return { broken: pick(${JSON.stringify(CONTRADICTORY)}), healthy: pick(${JSON.stringify(HEALTHY_TWIN)}) };
  })()`);
  check('narrow keeps the ERROR tag visible while the ordinary Status column stays hidden',
    narrow.broken.shown === true && narrow.broken.w > 40 && narrow.healthy.shown === false,
    JSON.stringify(narrow));
  await ledgerShot('narrow-light.png', 'light', 'narrow list (light)');
  await cdp.viewport(1500, 1000);

  /* ═════════ the graded captures ═════════ */
  console.log('\n=== SHOTS (graded by shot-luma, then reviewed by eye) ===');
  for (const tone of ['dark', 'light']) {
    await cdp.theme(tone);
    await backToList(fixed);
    await cdp.eval(`document.querySelector('#tvList a.tv-row[data-id=${JSON.stringify(CONTRADICTORY)}]').scrollIntoView({ block: 'center' })`);
    await sleep(250);
    await ledgerShot(`list-${tone}.png`, tone, `list with the nine defects (${tone})`);
    // All eleven seeds in one frame — the errors and the warnings side by side,
    // which is the only view that shows the two treatments being different.
    await cdp.eval(`(() => { const s = document.querySelector('#tvSearch');
      s.value = 'A synthetic ticket seeded by'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await cdp.waitFor('search hits', `document.querySelectorAll('#tvList a.tv-row').length === ${SEEDS.length}`, 15_000);
    await sleep(250);
    await ledgerShot(`list-seeds-${tone}.png`, tone, `all eleven seeds together — errors and warnings (${tone})`);
    // Clear it again: the query survives a route change, so leaving it set made
    // the NEXT theme's "whole board" capture a filtered eleven-row view — and
    // the two captures came out byte-identical, which is exactly what the shot
    // ledger exists to catch.
    await cdp.eval(`(() => { const s = document.querySelector('#tvSearch'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await cdp.waitFor('full list back', `document.querySelectorAll('#tvList a.tv-row').length > 50`, 15_000);
    await openTicket(fixed, CONTRADICTORY);
    await sleep(200);
    await ledgerShot(`detail-error-${tone}.png`, tone, `detail — contradictory state (${tone})`);
    await openTicket(fixed, 'BUG-908');
    await sleep(200);
    await ledgerShot(`detail-both-${tone}.png`, tone, `detail — error + warning (${tone})`);
    await openTicket(fixed, 'BUG-907');
    await sleep(200);
    await ledgerShot(`detail-warn-${tone}.png`, tone, `detail — warning only (${tone})`);
  }

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} passed, ${fail} failed`);
  if (fail) console.log(failures.map((f) => `  · ${f}`).join('\n'));
  console.log(`\nscreenshots: ${SHOTS}`);
}

async function ledgerShot(name, tone, label) {
  const file = path.join(SHOTS, name);
  await cdp.shot(file);
  const g = ledger.record(file, tone);
  check(`  capture ${name} — ${label}`, g.ok, `${g.why}  →  ${file}`);
  return file;
}

async function openTicket(srv, id) {
  await cdp.send('Page.navigate', { url: `${srv.base}/#/tickets/${id}?project=${encodeURIComponent(srv.pid)}` });
  await cdp.waitFor(`detail ${id}`, `document.querySelector('#tvDetail .tv-doc')?.dataset.id === ${JSON.stringify(id)}`);
  await sleep(120);
}
async function backToList(srv) {
  await cdp.send('Page.navigate', { url: `${srv.base}/#/tickets/all?project=${encodeURIComponent(srv.pid)}` });
  await cdp.waitFor('list', `document.querySelectorAll('#tvList a.tv-row').length > 50`);
  await sleep(120);
}

/** The accessible NAME Chrome computes for a selector — what a screen reader says. */
async function axNameOf(sel) {
  const { root } = await cdp.send('DOM.getDocument', { depth: 1 });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
  if (!nodeId) return '';
  const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
  return nodes.map((n) => n.name?.value ?? '').join(' ');
}

/** Every `note` node in the AX tree, with its own subtree's text. */
async function axNotesOf() {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const textOf = (n) => {
    let out = n.name?.value ?? '';
    for (const c of n.childIds ?? []) { const k = byId.get(c); if (k) out += ` ${textOf(k)}`; }
    return out.trim();
  };
  return nodes.filter((n) => n.role?.value === 'note')
    .map((n) => ({ role: n.role.value, name: n.name?.value ?? '', text: textOf(n) }));
}

try {
  await main();
} catch (err) {
  console.error(`\nHARNESS ERROR: ${err.stack || err.message}`);
  fail++;
} finally {
  cdp?.close();
  for (const p of procs) stopByPid(p);
  await sleep(400);
  if (worktreeMade) spawnSync('git', ['worktree', 'remove', '--force', BASE_TREE], { cwd: ROOT });
  process.exit(fail ? 1 : 0);
}
