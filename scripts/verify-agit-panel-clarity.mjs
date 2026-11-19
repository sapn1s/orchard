#!/usr/bin/env node
/**
 * verify-agit-panel-clarity.mjs — the Git page "Agent git for this project" panel, made obvious at a
 * glance (user report 2026-10-16: "it works to allow git for 30 min, but there is no longer an
 * option to allow permanently, or is it one of these? Makes no sense intuitively.").
 *
 *   A. STORE (pure, must-FAIL/pass): throwaway repos under a fixture root (system tmp — e.g. the
 *      Claude CLI's `/tmp/claude-<uid>/bash-edit-diff/<hash>` diff repos that filled the list —,
 *      Orchard's scratch root, the confined /work) are never RECORDED, REPLAYED or LISTED in the
 *      cross-repo reach log; a real repo outside them still is (contrast).
 *      AGIT_STORE=<path to a git-grant-store.mjs> runs part A against another copy (the RED run
 *      uses the pre-change HEAD copy).
 *   B. PRUNE TOOL: reach-log-prune.mjs keeps a backup, removes only fixture lines, keeps torn lines.
 *   C. DOM (real headless browser, isolated scratch server, fixture project):
 *      1 duration — the status says "Off" / "On until you turn it off" / "On until HH:MM (…left)";
 *        one "How long" choice (For 30 minutes | Until I turn it off); switching a standing grant to
 *        30 minutes really ends the standing one; an active timed pass opens on "30 minutes".
 *      2 mode — ONE "How agents work" choice (Direct commits / Soft releases / Ticket branches
 *        (pilot)), each with a one-line explanation, mapped onto the SAME stored fields
 *        (release.opt_in, branchMode.enabled) with the same mutual exclusion.
 *      3 other repos — fixture-root keys are not shown; a real repo shows its folder name, the full
 *        path on hover.
 *      4 no jargon — no "scoped", "Scope note", "Per-ticket branch mode", "grant reached".
 *      Screenshots of the panel, light + dark → AGIT_SHOTS (default <scratch>/agit-panel-clarity).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { scratchRoot } from './lib/scratch.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0, fail = 0; const failures = [];
const check = (name, ok, obs) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || obs === undefined ? '' : `\n        observed: ${typeof obs === 'string' ? obs : JSON.stringify(obs)}`}`); if (ok) pass++; else { fail++; failures.push(name); } };
async function section(name, fn) { console.log(`\n[${name}]`); try { await fn(); } catch (e) { check(`[${name}] threw: ${String(e.message ?? e).split('\n')[0]}`, false); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────────────────────── A. store ───────────────────────── */
const storePath = process.env.AGIT_STORE ? path.resolve(process.env.AGIT_STORE) : path.join(ROOT, 'scripts/lib/git-grant-store.mjs');
const store = await import(pathToFileURL(storePath).href);
const LIVE_SHAPE = path.join(os.tmpdir(), 'claude-1000', 'bash-edit-diff', '3387253691576999784-5442919945313106721-6d8f65dbdda05e49');
const SCRATCH_FIX = path.join(scratchRoot(), 'agit-clarity-fixture', 'repo');
const CONFINED_FIX = '/work/fixture-repo';
const REAL = '/srv/agit-clarity-not-a-fixture/orchard-website';

await section('A store: throwaway repos are never recorded, replayed or listed', async () => {
  store._resetGitGrantsForTest();
  const sunk = []; store.setCrossRepoReachSink((e) => sunk.push(e));
  for (const [label, top] of [['the live /tmp/claude-<uid>/bash-edit-diff/<hash> shape', LIVE_SHAPE], ['a scratch-root fixture', SCRATCH_FIX], ['a confined /work fixture', CONFINED_FIX]]) {
    const r = store.recordCrossRepoReach('P', { targetCommonDir: top === LIVE_SHAPE ? top : path.join(top, '.git'), targetToplevel: top, resolved: { network: [], local: [] } });
    check(`${label} is NOT recorded`, r === null, r);
  }
  check('no throwaway repo reached the durable sink', sunk.length === 0, sunk.map((e) => e.targetToplevel));
  check('crossRepoReachFor lists no throwaway repo', store.crossRepoReachFor('P').length === 0, store.crossRepoReachFor('P').map((e) => e.targetToplevel));
  store.loadCrossRepoReach({ sourceProjectKey: 'P', targetCommonDir: LIVE_SHAPE, targetToplevel: LIVE_SHAPE, at: '2026-10-15T21:39:25.810Z' });
  check('a stale throwaway line in the durable log is NOT replayed on boot', store.crossRepoReachFor('P').length === 0 && store.crossRepoReachOf('P', LIVE_SHAPE) === null, store.crossRepoReachFor('P'));
  // contrast: a real repo outside every fixture root is still recorded + listed + made durable
  const real = store.recordCrossRepoReach('P', { targetCommonDir: path.join(REAL, '.git'), targetToplevel: REAL, resolved: { network: ['github.com/o/r'], local: [] } });
  check('contrast: a real repo outside the fixture roots IS recorded, listed and sunk', !!real && store.crossRepoReachFor('P').length === 1 && sunk.length === 1, { real, n: store.crossRepoReachFor('P').length, sunk: sunk.length });
  store._resetGitGrantsForTest();
});

/* ───────────────────────── B. prune tool ───────────────────────── */
await section('B prune tool: backup first, removes only throwaway lines', async () => {
  const { pruneReachLog } = await import(pathToFileURL(path.join(ROOT, 'scripts/reach-log-prune.mjs')).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agit-prune-'));
  try {
    const f = path.join(dir, 'git-cross-repo-reach.jsonl');
    const lines = [
      JSON.stringify({ sourceProjectKey: 'P', targetCommonDir: LIVE_SHAPE, targetToplevel: LIVE_SHAPE, at: 'x' }),
      JSON.stringify({ sourceProjectKey: 'P', targetCommonDir: path.join(REAL, '.git'), targetToplevel: REAL, at: 'y' }),
      '{"torn',
    ];
    fs.writeFileSync(f, lines.join('\n') + '\n');
    const dry = pruneReachLog(f);
    check('dry run changes nothing and reports 1 throwaway of 3', !dry.applied && dry.dropped === 1 && dry.kept === 2 && fs.readFileSync(f, 'utf8') === lines.join('\n') + '\n', dry);
    const r = pruneReachLog(f, { apply: true });
    const after = fs.readFileSync(f, 'utf8').trim().split('\n');
    check('apply writes a byte-identical backup first', !!r.backup && fs.readFileSync(r.backup, 'utf8') === lines.join('\n') + '\n', r.backup);
    check('apply keeps the real repo and the torn line, drops the throwaway one', after.length === 2 && after[0] === lines[1] && after[1] === lines[2], after);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ───────────────────────── C. DOM (browser) ───────────────────────── */
if (process.env.AGIT_STORE) { console.log('\n(AGIT_STORE set: store-only run, DOM part skipped)'); finish(); }
const { chromium } = await import('playwright');
const { isolatedServerEnv } = await import(pathToFileURL(path.join(ROOT, 'scripts/lib/station-boot.mjs')).href);
const OUTDIR = process.env.AGIT_SHOTS ?? path.join(scratchRoot(), 'agit-panel-clarity');
fs.mkdirSync(OUTDIR, { recursive: true });
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
function findChromium() {
  const base = path.join(os.homedir(), '.cache', 'ms-playwright');
  const c = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse() : [];
  for (const d of c) { const p = path.join(base, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell'); if (fs.existsSync(p)) return p; }
  return undefined;
}
function realGit() { for (const dir of (process.env.PATH ?? '').split(path.delimiter)) { if (!dir || dir.includes('shim')) continue; const g = path.join(dir, 'git'); try { if (fs.statSync(g).isFile()) return g; } catch { /* next */ } } return '/usr/bin/git'; }
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agit-clarity-data-'));
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'agit-clarity-repo-'));
const GIT = realGit();
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'verify', GIT_AUTHOR_EMAIL: 'verify@example.invalid', GIT_COMMITTER_NAME: 'verify', GIT_COMMITTER_EMAIL: 'verify@example.invalid' };
execFileSync(GIT, ['init', '-q', '-b', 'main', REPO], { env: gitEnv });
fs.writeFileSync(path.join(REPO, 'README.md'), '# fixture (scratch, synthetic)\n');
execFileSync(GIT, ['-C', REPO, 'add', '-A'], { env: gitEnv }); execFileSync(GIT, ['-C', REPO, 'commit', '-q', '-m', 'initial'], { env: gitEnv });
const PORT = await freePort(); const BASE = `http://127.0.0.1:${PORT}`;
let server = null, browser = null; const log = [];
const j = async (m, u, body) => { const r = await fetch(BASE + u, { method: m, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined }); let d; try { d = await r.json(); } catch { d = null; } return { status: r.status, d }; };
try {
  server = spawn(process.execPath, ['src/server/index.ts'], { cwd: ROOT, env: isolatedServerEnv({ PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_STATION_NO_WA_CONSOLIDATE: '1', ORCHARD_RELEASE_TICK: '0' }), stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => log.push(String(d))); server.stderr.on('data', (d) => log.push(String(d)));
  let up = false; for (let i = 0; i < 200 && !up; i++) { try { up = (await fetch(`${BASE}/api/projects`)).ok; } catch { /* booting */ } if (!up) await sleep(150); }
  if (!up) throw new Error(`scratch server did not boot:\n${log.join('').slice(-1500)}`);
  const reg = await j('POST', '/api/projects', { hostPath: REPO, isolation: 'direct', applyMethod: false });
  const pid = reg.d?.project?.id ?? reg.d?.id; if (!pid) throw new Error(`register failed ${reg.status}`);
  const gw = `/api/projects/${encodeURIComponent(pid)}/git-write-grant`, pol = `/api/projects/${encodeURIComponent(pid)}/git-write-policy`;
  browser = await chromium.launch({ executablePath: findChromium() });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1180 } })).newPage();
  const perr = []; page.on('pageerror', (e) => perr.push(String(e)));
  const openPanel = async () => {
    await page.goto(`${BASE}/#/`); await sleep(100); // force a fresh open() (same-hash goto does not re-route)
    const loaded = page.waitForResponse((r) => /\/git-write-grant\b/.test(r.url()), { timeout: 30_000 });
    await page.goto(`${BASE}/#/git?project=${encodeURIComponent(pid)}`);
    await page.waitForFunction(() => document.querySelector('.git-view.open .gt-gitwrite'), null, { timeout: 30_000 });
    await loaded; await sleep(150);
    if (await page.evaluate(() => !document.querySelector('.gt-gw-panel') || document.querySelector('.gt-gw-panel').hidden)) await page.click('.gt-gw-settings');
    await page.waitForFunction(() => { const p = document.querySelector('.gt-gw-panel'); return p && !p.hidden && p.querySelector('.gt-gw-save'); }, null, { timeout: 15_000 });
  };
  const view = () => page.evaluate(() => {
    const p = document.querySelector('.gt-gw-panel');
    const grp = (c) => [...p.querySelectorAll(`.${c} .gt-gw-opt`)].map((b) => ({ v: b.dataset.value, label: b.querySelector('b')?.textContent, hint: b.querySelector('small')?.textContent, on: b.getAttribute('aria-checked') === 'true', role: b.getAttribute('role'), disabled: b.disabled }));
    return {
      status: p.querySelector('.gt-gw-status')?.dataset.state, statusText: p.querySelector('.gt-gw-status')?.textContent ?? '',
      dur: grp('gt-gw-dur'), mode: grp('gt-gw-mode'), modeRole: p.querySelector('.gt-gw-mode')?.getAttribute('role'),
      rows: [...p.querySelectorAll(':scope > .gt-gw-sec .gt-gw-row, :scope > .gt-gw-row')].map((r) => r.querySelector('span')?.textContent),
      save: p.querySelector('.gt-gw-save')?.textContent, off: p.querySelector('.gt-gw-revoke2')?.textContent ?? null,
      reachedH: p.querySelector('.gt-gw-reached-h')?.textContent ?? null,
      reached: [...p.querySelectorAll('.gt-gw-reached-row')].map((r) => ({ name: r.querySelector('.gt-gw-reached-name')?.textContent, title: r.querySelector('.gt-gw-reached-name')?.getAttribute('title'), toggles: [...r.querySelectorAll('.gt-gw-row span')].map((s) => s.textContent) })),
      text: p.textContent, pill: document.querySelector('.gt-gw-state')?.textContent,
    };
  });
  const pick = async (grp, v) => { await page.click(`.gt-gw-panel .${grp} .gt-gw-opt[data-value="${v}"]`); await sleep(60); };
  const save = async () => { await page.click('.gt-gw-panel .gt-gw-save'); await page.waitForFunction(() => { const b = document.querySelector('.gt-gw-panel .gt-gw-save'); return b && !/Saving/.test(b.textContent || ''); }, null, { timeout: 15_000 }); await sleep(350); };
  const shoot = async (name) => { for (const theme of ['light', 'dark']) { await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme); await sleep(150); const f = path.join(OUTDIR, `${name}-${theme}.png`); await page.locator('.gt-gw-panel').screenshot({ path: f }); console.log(`        screenshot: ${f}`); } await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; }); };

  await section('C1 duration: off state, the one "How long" choice, plain status', async () => {
    await openPanel(); const v = await view();
    check('fresh project: status says Off (agents can’t commit or push)', v.status === 'off' && /^Off: agents can’t commit or push/.test(v.statusText), v.statusText);
    check('"How long" offers exactly "For 30 minutes" and "Until I turn it off", as radios', JSON.stringify(v.dur.map((o) => o.label)) === '["For 30 minutes","Until I turn it off"]' && v.dur.every((o) => o.role === 'radio' && o.hint), v.dur);
    check('with nothing granted it opens on "Until I turn it off" and Save says so', v.dur.find((o) => o.v === 'standing')?.on && v.save === 'Allow until I turn it off', { dur: v.dur, save: v.save });
    check('no Turn off button while nothing is on', v.off === null, v.off);
    await shoot('agit-panel-off');
  });

  await section('C2 mode: ONE "How agents work" choice over the same stored fields', async () => {
    await openPanel(); let v = await view();
    check('three options, in order, each with a one-line explanation', JSON.stringify(v.mode.map((o) => o.label)) === '["Direct commits","Soft releases","Ticket branches (pilot)"]' && v.mode.every((o) => o.hint && o.hint.length > 20 && o.role === 'radio') && v.modeRole === 'radiogroup', v.mode);
    check('a fresh grant defaults to Direct commits', v.mode.find((o) => o.v === 'direct')?.on === true, v.mode);
    await pick('gt-gw-mode', 'branch'); v = await view();
    check('picking Ticket branches checks only it and reveals the agents-merge toggle', v.mode.filter((o) => o.on).map((o) => o.v).join() === 'branch' && v.rows.some((r) => /merge a verified ticket into main/i.test(r ?? '')), { mode: v.mode, rows: v.rows });
    await save();
    let p = (await j('GET', pol)).d?.policy;
    check('saved Ticket branches → branchMode.enabled true, release.opt_in false (same fields as before)', p?.branchMode?.enabled === true && p?.release?.opt_in === false && p?.commit === true, { bm: p?.branchMode, rel: p?.release?.opt_in });
    await openPanel(); await pick('gt-gw-mode', 'release'); await save();
    p = (await j('GET', pol)).d?.policy;
    check('saved Soft releases → release.opt_in true, branchMode.enabled false, mode release', p?.release?.opt_in === true && p?.branchMode?.enabled === false && p?.mode === 'release', { bm: p?.branchMode, rel: p?.release?.opt_in, mode: p?.mode });
    await openPanel(); v = await view();
    check('reopening reflects Soft releases', v.mode.find((o) => o.v === 'release')?.on === true, v.mode);
    await pick('gt-gw-mode', 'direct'); await save();
    p = (await j('GET', pol)).d?.policy;
    check('saved Direct commits → both off, mode scoped', p?.release?.opt_in === false && p?.branchMode?.enabled === false && p?.mode === 'scoped', { bm: p?.branchMode, rel: p?.release?.opt_in, mode: p?.mode });
    await openPanel(); await page.click('.gt-gw-panel .gt-gw-row:has-text("Agents may commit") .gt-gw-sw'); await sleep(60); v = await view();
    check('with "Agents may commit" off, the mode choice is disabled', v.mode.every((o) => o.disabled), v.mode);
  });

  await section('C1b duration: standing grant reads "On until you turn it off"', async () => {
    await openPanel(); const v = await view();
    check('standing grant: status "On until you turn it off" + what + mode, survives restarts', v.status === 'standing' && /On until you turn it off/.test(v.statusText) && /commit and push · direct commits/.test(v.statusText) && /survives restarts/.test(v.statusText), v.statusText);
    check('Save reads "Save" and a Turn off button is shown', v.save === 'Save' && v.off === 'Turn off', { save: v.save, off: v.off });
    check('pill reads "Agent git on · until you turn it off"', v.pill === 'Agent git on · until you turn it off', v.pill);
  });

  await section('C3 other repos: fixture repos hidden, real repos by folder name with path on hover', async () => {
    const rev = (await j('GET', gw)).d?.revision;
    const r = await j('PUT', pol, { commit: true, push: true, scope: null, release: { opt_in: false }, repoOverrides: { [LIVE_SHAPE]: { push: false }, [path.join(SCRATCH_FIX, '.git')]: { commit: false }, [path.join(REAL, '.git')]: { push: false } }, revision: rev });
    check('precondition: policy with 3 per-repo overrides saved', r.status === 200, r.status);
    const listed = (await j('GET', gw)).d?.reachedRepos ?? [];
    check('the server lists only the real repo (fixture keys never shown)', listed.length === 1 && listed[0].key === path.join(REAL, '.git'), listed.map((x) => x.key));
    await openPanel(); const v = await view();
    check('heading reads "Other repos agents committed to (1)"', v.reachedH === 'Other repos agents committed to (1)', v.reachedH);
    check('the row shows the folder name, the full path on hover', v.reached.length === 1 && v.reached[0].name === 'orchard-website' && v.reached[0].title === REAL, v.reached);
    check('per-repo toggles read Commit / Push / Block', JSON.stringify(v.reached[0]?.toggles) === '["Commit","Push","Block"]', v.reached[0]?.toggles);
    check('no hash-named entry anywhere in the panel', !/bash-edit-diff|6d8f65dbdda05e49/.test(v.text), null);
    await shoot('agit-panel-standing');
  });

  await section('C1c duration: switch to 30 minutes; an active timed pass shows its expiry', async () => {
    await openPanel(); await pick('gt-gw-dur', 'timed'); let v = await view();
    check('choosing 30 minutes over a standing grant explains it replaces it; Save says "Switch to 30 minutes"', v.save === 'Switch to 30 minutes' && /replaces the current “until you turn it off” permission/.test(v.text), { save: v.save });
    check('the 30-minute view hides the standing-only choices (no mode choice)', v.mode.length === 0, v.mode.length);
    await save();
    const g = (await j('GET', gw)).d;
    check('standing grant ended, a 30-minute pass is live', g?.policy?.mode === 'none' && g?.grant?.scope === 'duration' && g.timedGrant?.expiresInMs > 29 * 60_000, { mode: g?.policy?.mode, grant: g?.grant?.scope, left: g?.timedGrant?.expiresInMs });
    await openPanel(); v = await view();
    check('reopened: status "On until HH:MM (…m left)", a timed pass, ends on restart', v.status === 'timed' && /On until \d{1,2}:\d{2}.*\(\d+m left\)/.test(v.statusText) && /sooner if Orchard restarts/.test(v.statusText), v.statusText);
    check('an active timed pass opens on "For 30 minutes" with Save "Restart the 30 minutes"', v.dur.find((o) => o.v === 'timed')?.on && v.save === 'Restart the 30 minutes', { dur: v.dur, save: v.save });
    await shoot('agit-panel-timed');
    await page.click('.gt-gw-panel .gt-gw-revoke2'); await sleep(600);
    const g2 = (await j('GET', gw)).d;
    check('Turn off ends the timed pass (and nothing standing remains)', g2?.grant === null && g2?.timedGrant === null && g2?.policy?.mode === 'none', { grant: g2?.grant, mode: g2?.policy?.mode });
  });

  await section('C1d pill "Allow 30 min" + panel; standing + timed together', async () => {
    await openPanel(); await page.click('.gt-gw-panel .gt-gw-x');
    await page.click('.gt-gw-allow'); await sleep(500);
    await openPanel(); let v = await view();
    check('after the pill’s "Allow 30 min" the panel shows the timed pass, "Given with “Allow 30 min”"', v.status === 'timed' && /Given with “Allow 30 min”/.test(v.statusText), v.statusText);
    await pick('gt-gw-dur', 'standing'); await save();
    await openPanel(); v = await view();
    check('standing saved while timed live: status says on until you turn it off AND names the timed pass expiry', v.status === 'standing' && /A timed pass is also on until \d{1,2}:\d{2}/.test(v.statusText), v.statusText);
  });

  await section('C4 no jargon in the panel', async () => {
    await openPanel(); const v = await view();
    const bad = ['scoped', 'Scope note', 'Per-ticket branch mode', 'grant reached', 'runtime hook', 'standing grant'].filter((w) => v.text.includes(w));
    check('none of "scoped", "Scope note", "Per-ticket branch mode", "grant reached", "runtime hook", "standing grant" appear', bad.length === 0, bad);
    check('no uncaught page errors', perr.length === 0, perr.slice(0, 3));
  });
} catch (e) {
  check(`DOM part threw: ${String(e.message ?? e).split('\n')[0]}`, false);
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { server?.kill('SIGTERM'); } catch { /* ignore */ }
  await sleep(300);
  for (const d of [DATA, REPO]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
}
finish();

function finish() {
  console.log(`\nverify-agit-panel-clarity: ${pass} passed, ${fail} failed`);
  if (fail) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
  process.exit(0);
}
