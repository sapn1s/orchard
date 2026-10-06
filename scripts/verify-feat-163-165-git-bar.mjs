#!/usr/bin/env node
/**
 * FEAT-163 + FEAT-165 (+ the FEAT-164 UI grant flow) — the git section of the
 * session top bar, driven in a REAL headless Chromium (Playwright) over the REAL
 * app.js, against an ISOLATED scratch server (own CLAUDE_STATION_DATA, free
 * port — never the live service, never the real registry).
 *
 *   node scripts/verify-feat-163-165-git-bar.mjs
 *
 * FIXTURES — real where a real instance exists:
 *   · BUSY  = this Orchard checkout itself (a real working tree with a long-lived
 *             pile of uncommitted changes). Read-only: the chip and popover only
 *             run status / numstat / diff reads; the Git panel (which fetches) is
 *             never opened on it.
 *   · MODERATE = the real methodology checkout beside it (a handful of modified
 *             and untracked files). Read-only likewise; the panel is opened on it
 *             only with every network/write route (fetch/pull/push/commit/stage)
 *             blocked at the browser.
 *   · NONGIT = SYNTHETIC: a scratch dir laid out like a real non-git web project
 *             (package.json, src/, README) — the user's real non-git project is
 *             not touched, because the init button must be clicked here.
 *   Both real checkouts are discovered at runtime and the suite fails LOUDLY if
 *   either is missing or clean (a clean tree cannot exercise the diffstat).
 *
 * INIT, HONESTLY: a dispatched agent lane runs with the FEAT-135 git shim first on
 * PATH, which refuses repo-creating commands, and the scratch server inherits it.
 * So the REAL server init is exercised on its refusal path (the UI must show the
 * server's error, and no .git may appear); the SUCCESS path is exercised with the
 * init response stubbed at the browser. A user-run pass (no shim) can set
 * F163_REAL_INIT=1 to require the real init to succeed instead.
 *
 * MUST-FAIL on the pre-change tree: the chip is hidden for a non-repo, the face
 * shows a bare count with no +/− spans, #gitPop does not exist and the chip
 * carries a native title; the grant control has no permanent option.
 *
 * Screenshots (both themes): docs/bugs/assets/FEAT-16{3,4,5}-*.png
 */
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { chromium } from 'playwright';
import { isolatedServerEnv } from './lib/station-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUTDIR = process.env.F165_SHOTS ?? path.join(ROOT, 'docs', 'bugs', 'assets');
const SHOTS = process.env.F165_NO_SHOTS !== '1';
const REAL_INIT = process.env.F163_REAL_INIT === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BUSY = process.env.F165_BUSY_REPO ?? ROOT;
const MODERATE = process.env.F165_MODERATE_REPO ?? path.resolve(ROOT, '..', 'methodology');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${observed === undefined ? '' : `\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
/** Run one graded section; a throw is ONE recorded failure and the next section still
 * runs, so the must-FAIL run against the pre-change tree reports per-section. */
async function section(name, fn) {
  try { await fn(); } catch (e) { check(`[${name}] section threw: ${String(e.message ?? e).split('\n')[0]}`, false); }
}
async function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
function findChromium() {
  const base = path.join(os.homedir(), '.cache', 'ms-playwright');
  const cands = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse() : [];
  for (const d of cands) {
    const p = path.join(base, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}
/** Read-only porcelain: the independent count of changed paths. */
function porcelainCount(dir) {
  const out = execFileSync('git', ['-C', dir, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const f = out.split('\0'); let n = 0;
  for (let i = 0; i < f.length && f[i]; i++) { n++; const x = f[i][0], y = f[i][1]; if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i++; }
  return n;
}

// ── preflight: the real fixtures must exist AND be dirty ──────────────────────
for (const [label, dir] of [['busy', BUSY], ['moderate', MODERATE]]) {
  let n = -1; try { n = porcelainCount(dir); } catch (e) { n = -1; }
  if (n <= 0) { console.error(`FATAL: the ${label} fixture ${dir} is missing, not a repo, or clean (${n}) — nothing real to grade.`); process.exit(2); }
}
const busyCount = porcelainCount(BUSY);
const modCount = porcelainCount(MODERATE);
/** The exact read-only porcelain of a real checkout, to prove the suite left it untouched. */
const porcelainOf = (dir) => execFileSync('git', ['-C', dir, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'utf8', maxBuffer: 64 << 20 });
const before = { busy: porcelainOf(BUSY), moderate: porcelainOf(MODERATE) };
console.log(`fixtures: busy=${busyCount} changed paths, moderate=${modCount} changed paths (real, read-only)`);

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f165-data-'));
const NONGIT = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f163-nongit-'));
fs.writeFileSync(path.join(NONGIT, 'package.json'), JSON.stringify({ name: 'fixture-web', version: '0.1.0', private: true }, null, 2));
fs.mkdirSync(path.join(NONGIT, 'src'));
fs.writeFileSync(path.join(NONGIT, 'src', 'page.tsx'), 'export default function Page() { return null; }\n');
fs.writeFileSync(path.join(NONGIT, 'README.md'), '# fixture\n');
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
let server = null, browser = null;
const serverLog = [];

async function boot() {
  const env = isolatedServerEnv({ PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_STATION_NO_WA_CONSOLIDATE: '1' });
  server = spawn(process.execPath, ['src/server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => serverLog.push(String(d))); server.stderr.on('data', (d) => serverLog.push(String(d)));
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(`${BASE}/api/projects`); if (r.ok) return; } catch { /* booting */ }
    await sleep(150);
  }
  throw new Error(`scratch server did not come up:\n${serverLog.join('').slice(-2000)}`);
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const done = new Promise((r) => server.once('exit', r));
  try { process.kill(server.pid, 'SIGTERM'); } catch { /* gone */ }
  await Promise.race([done, sleep(5000)]);
  try { process.kill(server.pid, 'SIGKILL'); } catch { /* gone */ }
}
const j = async (m, u, body) => {
  const r = await fetch(BASE + u, { method: m, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  let d; try { d = await r.json(); } catch { d = null; }
  return { status: r.status, d };
};
async function addProject(hostPath) {
  // applyMethod:false — registering a project otherwise ONBOARDS it (writes
  // CLAUDE.md, .orchard/, .claude/settings.json and package.json scripts into the
  // directory). On a real checkout that is a write; this suite must make none.
  // (Learned the hard way in this suite's first run — see FEAT-165's log.)
  const r = await j('POST', '/api/projects', { hostPath, isolation: 'direct', applyMethod: false });
  const id = r.d?.project?.id ?? r.d?.id;
  if (!id) throw new Error(`could not register ${hostPath}: ${r.status} ${JSON.stringify(r.d)}`);
  return id;
}
/** WCAG contrast of an element's text colour against the popover/bar surface. */
const CONTRAST_FN = `(sel, bgSel) => {
  const n = document.querySelector(sel); if (!n) return null;
  // Computed colours come back as rgb()/rgba() OR, for color-mix(), color(srgb r g b / a).
  const parse = (c) => {
    let m = c.match(/rgba?\\(([^)]+)\\)/);
    if (m) return m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number);
    m = c.match(/color\\(srgb ([^)]+)\\)/);
    if (m) { const p = m[1].split(/[ \\/]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1]; }
    return null;
  };
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  let bgNode = bgSel ? document.querySelector(bgSel) : n; let bg = null;
  while (bgNode) { const c = parse(getComputedStyle(bgNode).backgroundColor); if (c && (c.length < 4 || c[3] > 0.5)) { bg = c; break; } bgNode = bgNode.parentElement; }
  bg = bg ?? parse(getComputedStyle(document.body).backgroundColor) ?? [255, 255, 255];
  const fg = parse(getComputedStyle(n).color);
  const a = lum(fg), b = lum(bg);
  return { fg: fg.slice(0, 3), bg: bg.slice(0, 3), ratio: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100 };
}`;

try {
  await boot();
  const busyId = await addProject(BUSY);
  const modId = await addProject(MODERATE);
  const ngId = await addProject(NONGIT);
  browser = await chromium.launch({ executablePath: findChromium() });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  // Nothing in this suite may write to a real checkout or touch the network.
  const blocked = [];
  await page.route(/\/api\/projects\/[^/]+\/git\/(fetch|pull|push|commit|stage|switch-branch|create-branch|checkout-remote|create-repo)$/, (route) => { blocked.push(route.request().url()); return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'blocked by verify suite' }) }); });
  const setTheme = async (t) => page.evaluate((t) => { document.documentElement.dataset.theme = t; }, t);
  const go = async (pid) => {
    await page.goto(`${BASE}/#/project/${encodeURIComponent(pid)}`);
    await page.waitForFunction(() => document.querySelectorAll('#tree button.proj').length > 0, null, { timeout: 30_000 });
    await page.waitForFunction(() => !document.querySelector('#gitBtn').hidden, null, { timeout: 30_000 });
  };
  const barClip = async (extra = 0) => {
    const r = await page.evaluate(() => { const b = document.querySelector('#gitBtn').getBoundingClientRect(); const p = document.querySelector('#gitPop'); const pr = p.classList.contains('open') ? p.getBoundingClientRect() : null; return { b: { x: b.x, y: b.y, w: b.width, h: b.height }, p: pr && { x: pr.x, y: pr.y, w: pr.width, h: pr.height } }; });
    const x0 = Math.max(0, Math.min(r.b.x, r.p?.x ?? r.b.x) - 160);
    const y0 = Math.max(0, r.b.y - 14);
    const x1 = Math.min(1440, Math.max(r.b.x + r.b.w, (r.p?.x ?? 0) + (r.p?.w ?? 0)) + 160);
    const y1 = Math.min(900, Math.max(r.b.y + r.b.h + 14, (r.p?.y ?? 0) + (r.p?.h ?? 0) + 12) + extra);
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  };
  const shot = async (name, clip) => { if (SHOTS) await page.screenshot({ path: path.join(OUTDIR, name), clip: clip ?? await barClip() }); };
  const hoverOpen = async () => {
    await page.mouse.move(5, 5); await page.evaluate(() => window.__station && document.querySelector('#gitPop').classList.remove('open'));
    await page.hover('#gitBtn');
    await page.waitForFunction(() => document.querySelector('#gitPop').classList.contains('open'), null, { timeout: 5000 });
    await sleep(350); // let the .pop fade-in finish before anything is measured or shot
  };

  /* ── FEAT-165: MODERATE real repo ─────────────────────────────────────────── */
  await section('165-moderate', async () => {
  console.log('\n[165] diffstat face + popover on the real moderate checkout');
  await go(modId);
  const st = (await j('GET', `/api/projects/${encodeURIComponent(modId)}/git/status`)).d.status;
  await page.waitForFunction(() => document.querySelector('#gitBtn').dataset.repo === 'true', null, { timeout: 15_000 });
  const face = await page.evaluate(() => ({
    n: document.querySelector('#gitN').textContent, add: document.querySelector('#gitAdd').textContent,
    del: document.querySelector('#gitDel').textContent, statHidden: document.querySelector('#gitStat').hidden,
    title: document.querySelector('#gitBtn').getAttribute('title'), dot: document.querySelector('#gitDot').dataset.state,
  }));
  check('face shows the changed-file count (matches independent porcelain)', face.n === `${modCount} ${modCount === 1 ? 'file' : 'files'}`, { face: face.n, porcelain: modCount });
  // The face compacts ≥10,000 to "14.1k" (the popover is exact) — an independent
  // restatement of that rule, not a call into the app's own formatter.
  const compact = (n) => (n < 10_000 ? n.toLocaleString('en-US') : `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`);
  check('face shows green +added and red −removed matching the server status', !face.statHidden && face.add === `+${compact(st.added)}` && face.del === `−${compact(st.removed)}`, { face, server: { added: st.added, removed: st.removed } });
  check('no native title tooltip on the chip', face.title === null, face.title);
  for (const theme of ['light', 'dark']) {
    await setTheme(theme); await sleep(150);
    const add = await page.evaluate(`(${CONTRAST_FN})('#gitAdd')`);
    const del = await page.evaluate(`(${CONTRAST_FN})('#gitDel')`);
    check(`[${theme}] +added reads green (g dominant) with contrast ≥ 3`, add && add.fg[1] > add.fg[0] && add.ratio >= 3, add);
    check(`[${theme}] −removed reads red (r dominant) with contrast ≥ 3`, del && del.fg[0] > del.fg[1] && del.ratio >= 3, del);
    await shot(`FEAT-165-face-${theme}.png`);
    await hoverOpen();
    const pop = await page.evaluate(() => {
      const p = document.querySelector('#gitPop'); const r = p.getBoundingClientRect();
      const rows = [...p.querySelectorAll('.gp-row')];
      return {
        rows: rows.length, letters: rows.map((x) => x.querySelector('.gp-letter').textContent),
        types: rows.map((x) => x.dataset.type), allCounts: rows.every((x) => x.querySelector('.gp-n').textContent.trim().length > 0),
        branch: p.querySelector('.gp-branch')?.textContent, sum: p.querySelector('.gp-sum')?.textContent,
        inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      };
    });
    await page.waitForFunction((n) => document.querySelectorAll('#gitPop .gp-row').length === n, modCount, { timeout: 10_000 }).catch(() => {});
    const pop2 = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#gitPop .gp-row')];
      return { rows: rows.length, letters: rows.map((x) => x.querySelector('.gp-letter').textContent), types: rows.map((x) => x.dataset.type), allCounts: rows.every((x) => /[+−]|binary/.test(x.querySelector('.gp-n').textContent)) };
    });
    const letterOk = pop2.types.every((t, i) => ({ modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U' })[t] === pop2.letters[i]);
    check(`[${theme}] hover opens the styled popover (in viewport) with branch + diffstat summary`, pop.inView && !!pop.branch && /changed file/.test(pop.sum ?? ''), pop);
    check(`[${theme}] popover lists every changed file with status letter and +/− counts`, pop2.rows === modCount && letterOk && pop2.allCounts, pop2);
    const rowC = await page.evaluate(`(${CONTRAST_FN})('#gitPop .gp-row .gp-base', '#gitPop')`);
    check(`[${theme}] file names in the popover are readable (contrast ≥ 4.5)`, rowC && rowC.ratio >= 4.5, rowC);
    await shot(`FEAT-165-popover-${theme}.png`);
  }
  await setTheme('light');
  // Pointer can cross the gap into the popover without it closing; leaving closes it.
  await hoverOpen();
  const pr = await page.evaluate(() => { const r = document.querySelector('#gitPop .gp-sum').getBoundingClientRect(); return { x: r.x + 20, y: r.y + 5 }; });
  await page.mouse.move(pr.x, pr.y, { steps: 6 }); await sleep(450);
  check('pointer moving into the popover keeps it open', await page.evaluate(() => document.querySelector('#gitPop').classList.contains('open')));
  await page.mouse.move(700, 700, { steps: 4 }); await sleep(500);
  check('leaving chip + popover closes it', await page.evaluate(() => !document.querySelector('#gitPop').classList.contains('open')));
  // Keyboard: focus opens it.
  await page.evaluate(() => document.body.focus());
  await page.focus('#gitBtn'); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab'); await sleep(300);
  check('keyboard focus on the chip opens the popover', await page.evaluate(() => document.querySelector('#gitPop').classList.contains('open') && document.querySelector('#gitBtn').getAttribute('aria-expanded') === 'true'));
  await page.keyboard.press('Escape'); await sleep(200);
  check('Escape closes the popover', await page.evaluate(() => !document.querySelector('#gitPop').classList.contains('open')));

  /* ── FEAT-165: BUSY real repo ─────────────────────────────────────────────── */
  });
  await section('165-busy', async () => {
  console.log('\n[165] busy real checkout (many changed files)');
  await go(busyId);
  await page.waitForFunction(() => document.querySelector('#gitBtn').dataset.repo === 'true', null, { timeout: 30_000 });
  const busyFace = await page.evaluate(() => ({ n: document.querySelector('#gitN').textContent, add: document.querySelector('#gitAdd').textContent, del: document.querySelector('#gitDel').textContent, w: document.querySelector('#gitBtn').getBoundingClientRect().width }));
  check('busy face: file count matches porcelain; +/− compacted to fit (≤ 6 chars each), chip ≤ 220px wide', busyFace.n === `${busyCount} files` && busyFace.add.length <= 6 && busyFace.del.length <= 6 && busyFace.w <= 220, { busyFace, busyCount });
  for (const theme of ['light', 'dark']) {
    await setTheme(theme); await sleep(150);
    await hoverOpen();
    await page.waitForFunction(() => document.querySelectorAll('#gitPop .gp-row').length > 0, null, { timeout: 30_000 });
    const b = await page.evaluate(() => { const l = document.querySelector('#gitPop .gp-list'); const r = document.querySelector('#gitPop').getBoundingClientRect(); return { rows: document.querySelectorAll('#gitPop .gp-row').length, more: document.querySelector('#gitPop .gp-more')?.textContent ?? null, scrolls: l.scrollHeight > l.clientHeight, inView: r.bottom <= innerHeight && r.right <= innerWidth, h: Math.round(r.height) }; });
    const expectRows = Math.min(busyCount, 200);
    check(`[${theme}] busy popover: ${expectRows} rows${busyCount > 200 ? ' + "and N more"' : ''}, list scrolls, popover stays in viewport`, b.rows === expectRows && (busyCount > 200 ? /and .* more/.test(b.more ?? '') : b.more === null) && b.scrolls && b.inView, b);
    await shot(`FEAT-165-busy-popover-${theme}.png`);
  }
  await setTheme('light');
  // Narrow window: the unit word drops, the numbers stay.
  await page.setViewportSize({ width: 1000, height: 800 }); await sleep(200);
  const narrow = await page.evaluate(() => ({ unit: getComputedStyle(document.querySelector('#gitN .git-unit')).display, add: document.querySelector('#gitAdd').getBoundingClientRect().width > 0 }));
  check('narrow window (1000px): " files" unit hides, the +/− numbers stay visible', narrow.unit === 'none' && narrow.add, narrow);
  await page.mouse.move(5, 5);
  await shot('FEAT-165-busy-narrow-light.png');
  await page.setViewportSize({ width: 1440, height: 900 });

  /* ── FEAT-163: NON-GIT project ────────────────────────────────────────────── */
  });
  await section('163-nongit', async () => {
  console.log('\n[163] non-git project shows the git control + initialise');
  await go(ngId);
  await page.waitForFunction(() => document.querySelector('#gitBtn').dataset.repo === 'false', null, { timeout: 15_000 });
  const ng = await page.evaluate(() => ({ hidden: document.querySelector('#gitBtn').hidden, n: document.querySelector('#gitN').textContent, dot: document.querySelector('#gitDot').dataset.state, aria: document.querySelector('#gitBtn').getAttribute('aria-label') }));
  check('non-git project: the git control IS shown, in a distinct "no git" state', !ng.hidden && ng.n === 'no git' && ng.dot === 'none' && /not a git repository/.test(ng.aria ?? ''), ng);
  for (const theme of ['light', 'dark']) {
    await setTheme(theme); await sleep(150);
    await page.mouse.move(5, 5);
    await shot(`FEAT-163-face-${theme}.png`);
    await page.click('#gitBtn');
    await page.waitForFunction(() => document.querySelector('#gitPop').classList.contains('open'), null, { timeout: 5000 });
    const p1 = await page.evaluate(() => ({ head: document.querySelector('#gitPop .gp-branch')?.textContent, btn: document.querySelector('#gitPop [data-act="init"]')?.textContent, where: document.querySelector('#gitPop .gp-where')?.textContent }));
    check(`[${theme}] click pins the popover: "Not a git repository" + "Initialize git repository"`, p1.head === 'Not a git repository' && p1.btn === 'Initialize git repository' && !!p1.where, p1);
    await page.mouse.move(5, 5); await sleep(400);
    check(`[${theme}] a pinned popover survives the pointer leaving`, await page.evaluate(() => document.querySelector('#gitPop').classList.contains('open')));
    await shot(`FEAT-163-popover-${theme}.png`);
    await page.click('#gitPop [data-act="init"]');
    const armed = await page.evaluate(() => ({ ask: document.querySelector('#gitPop .gp-ask')?.textContent, confirm: !!document.querySelector('#gitPop [data-act="confirm"]'), cancel: !!document.querySelector('#gitPop [data-act="cancel"]'), focused: document.activeElement?.dataset?.act ?? null }));
    check(`[${theme}] Initialize asks for confirmation first (confirm focused, cancel offered)`, armed.confirm && armed.cancel && armed.focused === 'confirm' && /git init/.test(armed.ask ?? ''), armed);
    await shot(`FEAT-163-confirm-${theme}.png`);
    await page.click('#gitPop [data-act="cancel"]');
    check(`[${theme}] Cancel disarms without initialising`, await page.evaluate(() => !!document.querySelector('#gitPop [data-act="init"]')) && !fs.existsSync(path.join(NONGIT, '.git')));
    await page.keyboard.press('Escape');
  }
  await setTheme('light');
  // The REAL server init.
  const initReqs = [];
  page.on('request', (r) => { if (/\/git\/init$/.test(r.url())) initReqs.push(r.method()); });
  await page.click('#gitBtn'); await page.waitForFunction(() => document.querySelector('#gitPop').classList.contains('open'));
  await page.click('#gitPop [data-act="init"]'); await page.click('#gitPop [data-act="confirm"]');
  if (REAL_INIT) {
    await page.waitForFunction(() => document.querySelector('#gitBtn').dataset.repo === 'true', null, { timeout: 15_000 }).catch(() => {});
    check('REAL init: confirm runs the server init in the project dir; chip flips to a repo on main', fs.existsSync(path.join(NONGIT, '.git')) && await page.evaluate(() => document.querySelector('#gitBtn').dataset.repo === 'true'), { git: fs.existsSync(path.join(NONGIT, '.git')) });
  } else {
    await page.waitForFunction(() => !!document.querySelector('#gitPop .gp-err') || document.querySelector('#gitBtn').dataset.repo === 'true', null, { timeout: 15_000 }).catch(() => {});
    const res = await page.evaluate(() => ({ err: document.querySelector('#gitPop .gp-err')?.textContent ?? null, repo: document.querySelector('#gitBtn').dataset.repo }));
    check('REAL server init reached (one POST …/git/init) and its refusal under the agent shim is SHOWN, no .git created, chip stays "no git"', initReqs.length === 1 && initReqs[0] === 'POST' && /Could not initialise/.test(res.err ?? '') && res.repo === 'false' && !fs.existsSync(path.join(NONGIT, '.git')), { initReqs, res });
    await shot('FEAT-163-init-refused-light.png');
    await page.keyboard.press('Escape');
    // SUCCESS path, response stubbed at the browser (see header).
    await page.route(/\/git\/init$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: { repo: true, toplevel: NONGIT, branch: 'main', detachedAt: null, dirty: 3, conflicted: 0, added: 5, removed: 0, untrackedLinesIncluded: true, ahead: null, behind: null, upstream: null, remoteUrl: null, lastCommit: null } }) }));
    await page.click('#gitBtn'); await page.waitForFunction(() => document.querySelector('#gitPop').classList.contains('open'));
    await page.click('#gitPop [data-act="init"]'); await page.click('#gitPop [data-act="confirm"]');
    await page.waitForFunction(() => document.querySelector('#gitBtn').dataset.repo === 'true', null, { timeout: 10_000 }).catch(() => {});
    const after = await page.evaluate(() => ({ repo: document.querySelector('#gitBtn').dataset.repo, n: document.querySelector('#gitN').textContent, dot: document.querySelector('#gitDot').dataset.state }));
    check('init success (stubbed response): chip flips to the repo state with the new status', after.repo === 'true' && after.n === '3 files' && after.dot === 'dirty', after);
    await page.unroute(/\/git\/init$/);
  }

  /* ── FEAT-164: the permanent grant, end to end through the real UI ────────── */
  });
  await section('164-grant', async () => {
  console.log('\n[164] permanent agent-git grant through the Git panel');
  const gw = `/api/projects/${encodeURIComponent(modId)}/git-write-grant`;
  await page.goto(`${BASE}/#/git?project=${encodeURIComponent(modId)}`);
  await page.waitForFunction(() => document.querySelector('.git-view.open .gt-gitwrite') && !document.querySelector('.gt-gw-allow').hidden, null, { timeout: 30_000 });
  // The panel slides in; measure only once it has settled on screen.
  await page.waitForFunction(() => document.documentElement.classList.contains('git-open'), null, { timeout: 10_000 }).catch(() => {});
  await sleep(300);
  const pill = () => page.evaluate(() => { const w = document.querySelector('.gt-gitwrite'); return { on: w.dataset.on, scope: w.dataset.scope, armed: w.dataset.armed, state: w.querySelector('.gt-gw-state').textContent, allow: !w.querySelector('.gt-gw-allow').hidden, perm: w.querySelector('.gt-gw-perm').hidden ? null : w.querySelector('.gt-gw-perm').textContent, revoke: !w.querySelector('.gt-gw-revoke').hidden }; });
  const headClip = async () => { const r = await page.evaluate(() => { const b = document.querySelector('.gt-gitwrite').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }); return { x: Math.max(0, r.x - 30), y: Math.max(0, r.y - 12), width: Math.min(1440 - Math.max(0, r.x - 30), r.w + 60), height: r.h + 24 }; };
  let p0 = await pill();
  check('initial: blocked, both "Allow 30 min" and "Allow permanently…" offered', p0.on === 'false' && p0.allow && p0.perm === 'Allow permanently…' && !p0.revoke, p0);
  if (SHOTS) await page.screenshot({ path: path.join(OUTDIR, 'FEAT-164-blocked-light.png'), clip: await headClip() });
  await page.click('.gt-gw-perm');
  let p1 = await pill();
  check('one click only ARMS it: explicit confirm label + what it means; NO grant yet', p1.armed === 'true' && p1.perm === 'Confirm: allow permanently' && /until you revoke/.test(p1.state) && (await j('GET', gw)).d.grant === null, p1);
  if (SHOTS) await page.screenshot({ path: path.join(OUTDIR, 'FEAT-164-armed-light.png'), clip: await headClip() });
  await sleep(6500);
  p1 = await pill();
  check('an armed confirm lapses after 6 s with no grant', p1.armed === 'false' && p1.perm === 'Allow permanently…' && (await j('GET', gw)).d.grant === null, p1);
  await page.click('.gt-gw-perm'); await page.click('.gt-gw-perm');
  await page.waitForFunction(() => document.querySelector('.gt-gitwrite').dataset.scope === 'permanent', null, { timeout: 10_000 }).catch(() => {});
  const p2 = await pill();
  const g2 = (await j('GET', gw)).d.grant;
  const row2 = JSON.parse(fs.readFileSync(path.join(DATA, 'registry.json'), 'utf8')).projects.find((p) => p.id === modId);
  check('confirm grants PERMANENT: labelled "permanent", Revoke shown, server scope=permanent, registry setting written', p2.scope === 'permanent' && /permanent/.test(p2.state) && p2.revoke && p2.perm === null && !p2.allow && g2?.scope === 'permanent' && row2?.settings?.gitWrite?.permanent === true, { p2, g2, setting: row2?.settings?.gitWrite });
  for (const theme of ['light', 'dark']) { await setTheme(theme); await sleep(120); if (SHOTS) await page.screenshot({ path: path.join(OUTDIR, `FEAT-164-permanent-${theme}.png`), clip: await headClip() }); }
  await setTheme('light');
  // A reload re-reads it from the server (it is a project setting, not page state).
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.gt-gitwrite')?.dataset.scope === 'permanent', null, { timeout: 30_000 }).catch(() => {});
  check('after a page reload the panel still shows the permanent grant', (await pill()).scope === 'permanent');
  await page.click('.gt-gw-revoke');
  await page.waitForFunction(() => document.querySelector('.gt-gitwrite').dataset.on === 'false', null, { timeout: 10_000 }).catch(() => {});
  const p3 = await pill();
  const row3 = JSON.parse(fs.readFileSync(path.join(DATA, 'registry.json'), 'utf8')).projects.find((p) => p.id === modId);
  check('Revoke (same control) clears it: UI blocked, server grant null, registry setting cleared', p3.on === 'false' && p3.allow && (await j('GET', gw)).d.grant === null && !row3?.settings?.gitWrite?.permanent, { p3, setting: row3?.settings?.gitWrite });
  // The 30-minute grant keeps working, and can be upgraded.
  await page.click('.gt-gw-allow');
  await page.waitForFunction(() => document.querySelector('.gt-gitwrite').dataset.scope === 'duration', null, { timeout: 10_000 }).catch(() => {});
  const p4 = await pill(); const g4 = (await j('GET', gw)).d.grant;
  check('"Allow 30 min" still grants a 30-minute window; "Make permanent…" offered', p4.scope === 'duration' && /left/.test(p4.state) && p4.perm === 'Make permanent…' && g4?.scope === 'duration' && g4.expiresInMs > 29 * 60_000, { p4, g4 });
  if (SHOTS) await page.screenshot({ path: path.join(OUTDIR, 'FEAT-164-timed-light.png'), clip: await headClip() });
  await page.click('.gt-gw-perm'); await page.click('.gt-gw-perm');
  await page.waitForFunction(() => document.querySelector('.gt-gitwrite').dataset.scope === 'permanent', null, { timeout: 10_000 }).catch(() => {});
  check('a timed grant can be upgraded to permanent', (await pill()).scope === 'permanent' && (await j('GET', gw)).d.grant?.scope === 'permanent');
  await page.click('.gt-gw-revoke');
  await page.waitForFunction(() => document.querySelector('.gt-gitwrite').dataset.on === 'false', null, { timeout: 10_000 }).catch(() => {});
  check('one Revoke clears permanent AND the timed grant beneath it', (await j('GET', gw)).d.grant === null && (await pill()).on === 'false');

  });
  check('no page errors during the run', consoleErrors.length === 0, consoleErrors.slice(0, 3));
  // The Git panel auto-fetches on its own (pre-existing sync behaviour); those
  // requests were stopped at the browser and never reached the server. Anything
  // other than that auto-fetch would mean this suite drove a write.
  check('only the panel\'s own auto-fetch hit the block (stopped at the browser); no write route was driven', blocked.every((u) => /\/git\/fetch$/.test(u)), blocked);
} catch (e) {
  check(`suite threw: ${e.stack ?? e.message}`, false);
} finally {
  try { await browser?.close(); } catch { /* gone */ }
  await stop();
  for (const d of [DATA, NONGIT]) fs.rmSync(d, { recursive: true, force: true });
}
// The real checkouts must be byte-for-byte as the suite found them (status level).
const after = { busy: porcelainOf(BUSY), moderate: porcelainOf(MODERATE) };
check('the real busy checkout is untouched (porcelain identical before/after)', after.busy === before.busy);
check('the real moderate checkout is untouched (porcelain identical before/after)', after.moderate === before.moderate);
console.log(`\nFEAT-163/164/165 git bar: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
