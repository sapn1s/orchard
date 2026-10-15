#!/usr/bin/env node
/*
 * FEAT-190 (orchestrator decision 2026-10-14) MOVED the agent-git CONTROLS off this Settings drawer
 * onto the GIT PAGE (public/lib/git-view.js "Manage…" panel, opened IN PLACE — it no longer opens
 * the drawer). This suite was REWRITTEN (r15) to its FEAT-190 role:
 *   · it PROVES success criterion 6 — the drawer Agent git section is now READ-ONLY: a server-written
 *     summary + the scope note (read-only) + a "Manage on the Git page" button + a managed-elsewhere
 *     note, and NO editable controls (.agit-commit/.agit-push/.agit-scope-in/.agit-save/.agit-revoke/
 *     .agit-cut) — across none / scoped / release / migrated states and for the Git-page pill;
 *   · the drawer-CONTROL cases (toggles, scope textarea, Save, Revoke, cadence, the editable migrated
 *     callout) are RETIRED here with a note pointing at the Git-page test that now covers them,
 *     verify-feat-190-ui (the "Manage…" panel: controls, default-both-on, push-off preserved,
 *     optimistic-concurrency 200/409/400, legacy-permanent-route commit+push).
 * Driven in a REAL headless Chromium against an isolated scratch server (free port, own data dir;
 * never 4317, never the real registry/checkout). The policy is set via the ONE writer route with the
 * FEAT-190 r3 `revision` threaded (an un-revisioned PUT is refused 400 by design).
 */
/**
 * FEAT-164 — the Agent git SETTINGS UI, driven in a REAL headless Chromium
 * (Playwright) over the REAL app.js / drawer.js, against an ISOLATED scratch
 * server (its own CLAUDE_STATION_DATA, a free port — never the live service on
 * 4317, never the real registry, never a real checkout).
 *
 *   node scripts/verify-feat-164-settings-ui.mjs
 *
 * FIXTURE — SYNTHETIC (stated): there is no "real" agent-git-policy artifact to
 * point at, so this builds a throwaway git repo in a scratch dir (one commit, a
 * synthetic identity) and registers it as a scratch project. The repo is real
 * enough that `scripts/release.mjs plan` returns a non-error plan (next version,
 * cadence, zero eligible tickets), so the release-status block renders with live
 * server data rather than a stub. The repo is created with the REAL git binary
 * (the agent git shim, first on PATH, refuses `git init`); only fixture setup
 * bypasses the shim, never the product.
 *
 * COVERS (each check prints its observed value):
 *   · default reads "No agent commits (default)" (mode none);
 *   · "…and push" is disabled while "Agents may commit" is off;
 *   · commit on + a BLANK note, Save → summary "Soft releases…" and server mode=release;
 *   · a scope note, Save → server mode=scoped;
 *   · Revoke → server mode=none, the scope note KEPT;
 *   · an invalid cadence (minTickets=0) → the error is SHOWN, server mode unchanged;
 *   · the git pill "Settings…" button opens the drawer scrolled to the Agent git section.
 *
 * MUST-FAIL: run this same script against the pre-change public/ (the copies saved
 * before the edits) and it fails — the section, the "Settings…" button and the
 * policy route the checks drive do not exist there. See the ticket's Activity log.
 *
 * Screenshots (both themes): docs/bugs/assets/FEAT-164-agentgit-*.png
 */
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { chromium } from 'playwright';
import { isolatedServerEnv } from './lib/station-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUTDIR = process.env.F164_SHOTS ?? path.join(ROOT, 'docs', 'bugs', 'assets');
const SHOTS = process.env.F164_NO_SHOTS !== '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0, retired = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${observed === undefined ? '' : `\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
// FEAT-190 (orchestrator decision 2026-10-14) moved the agent-git CONTROLS off this Settings drawer
// onto the Git page. A drawer-control manipulation case whose controls no longer exist here is RETIRED
// with a note naming the covering Git-page test (verify-feat-190-ui); this suite now proves the drawer
// is READ-ONLY (success criterion 6) and the Git-page pill reflects the standing policy.
function retire(name, note) { retired++; console.log(`  RETIRED  ${name} — ${note}`); }
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
/** The REAL git binary — the first on PATH that is NOT the agent shim. Fixture setup
 * only (the shim refuses `git init`); the product under test still uses the shim. */
function realGit() {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir || dir.includes('shim')) continue;
    const g = path.join(dir, 'git');
    try { if (fs.statSync(g).isFile()) return g; } catch { /* next */ }
  }
  return '/usr/bin/git';
}

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f164-data-'));
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f164-repo-'));
// Build a throwaway git repo with the real git binary + a synthetic identity.
const GIT = realGit();
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'verify', GIT_AUTHOR_EMAIL: 'verify@example.invalid', GIT_COMMITTER_NAME: 'verify', GIT_COMMITTER_EMAIL: 'verify@example.invalid' };
const g = (...args) => execFileSync(GIT, ['-C', REPO, ...args], { encoding: 'utf8', env: gitEnv });
try {
  execFileSync(GIT, ['init', '-b', 'main', REPO], { encoding: 'utf8', env: gitEnv });
  fs.writeFileSync(path.join(REPO, 'README.md'), '# fixture repo (scratch, synthetic)\n');
  fs.writeFileSync(path.join(REPO, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.1.0', private: true, scripts: { gate: 'true' } }, null, 2));
  g('add', '-A');
  g('commit', '-m', 'initial');
} catch (e) {
  console.error(`FATAL: could not build the scratch git fixture with ${GIT}: ${e.message}`);
  process.exit(2);
}

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
  const r = await j('POST', '/api/projects', { hostPath, isolation: 'direct', applyMethod: false });
  const id = r.d?.project?.id ?? r.d?.id;
  if (!id) throw new Error(`could not register ${hostPath}: ${r.status} ${JSON.stringify(r.d)}`);
  return id;
}

try {
  await boot();
  const pid = await addProject(REPO);
  const polUrl = `/api/projects/${encodeURIComponent(pid)}/git-write-policy`;
  const policy = async () => (await j('GET', polUrl)).d;
  const waitPolicy = async (pred, ms = 12000) => { const t = Date.now(); let last; while (Date.now() - t < ms) { last = await policy(); if (pred(last)) return last; await sleep(150); } return last; };
  // FEAT-190 r3 — the policy PUT is optimistic-concurrency gated: it must carry the current revision
  // (verify-feat-190-ui covers the 400/409 contract directly). Setting a policy via the route here
  // threads it so the state is actually stored (otherwise every PUT returns 400 revision-required).
  const putPolicy = async (body) => { const revision = (await j('GET', polUrl)).d?.revision ?? null; return j('PUT', polUrl, { ...body, revision }); };

  browser = await chromium.launch({ executablePath: findChromium() });
  const bctx = await browser.newContext({ viewport: { width: 1440, height: 980 } });
  const page = await bctx.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  const setTheme = async (t) => page.evaluate((t) => { document.documentElement.dataset.theme = t; }, t);

  // FEAT-190 — the drawer's Agent git section is READ-ONLY now (success criterion 6: the controls
  // moved to the Git page). This reads the read-only state AND confirms the ABSENCE of the editable
  // controls (`.agit-commit/.agit-push/.agit-scope-in/.agit-save/.agit-revoke/.agit-cut`) that used
  // to live here — those are driven on the Git page by verify-feat-190-ui now.
  const agit = () => page.evaluate(() => {
    const st = document.querySelector('.agit-status');
    const g = document.querySelector('[data-focus="agentGit"]');
    const q = (s) => g?.querySelector(s);
    if (!g) return { present: false };
    const r = g.getBoundingClientRect();
    return {
      present: true,
      modalOpen: !document.querySelector('#smodal').hidden,
      summary: q('.agit-summary')?.textContent ?? null,
      mode: st?.dataset.mode ?? null,
      why: q('.set-why')?.textContent ?? null,
      note: [...g.querySelectorAll('.grp-note')].map((n) => n.textContent).join(' | '),
      hasManage: !!q('.agit-manage'),
      relPresent: !!q('.agit-rel'),
      hasEditableControl: !!q('.agit-commit, .agit-push, .agit-scope-in, .agit-save, .agit-revoke, .agit-cut'),
      inView: r.top >= 0 && r.top < innerHeight - 40,
    };
  });
  const agitClip = async () => {
    const r = await page.evaluate(() => { const g = document.querySelector('[data-focus="agentGit"]'); g.scrollIntoView({ block: 'start' }); const b = g.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
    return { x: Math.max(0, r.x - 12), y: Math.max(0, r.y - 12), width: Math.min(1440, r.w + 24), height: Math.min(980, r.h + 24) };
  };
  const shotSection = async (name) => { if (SHOTS) { await page.evaluate(() => document.querySelector('[data-focus="agentGit"]').scrollIntoView({ block: 'start' })); await sleep(120); await page.screenshot({ path: path.join(OUTDIR, name), clip: await agitClip() }); } };

  const goProject = async () => {
    await page.goto(`${BASE}/#/project/${encodeURIComponent(pid)}`);
    await page.waitForFunction(() => document.querySelectorAll('#tree button.proj').length > 0, null, { timeout: 30_000 });
  };

  // Open the Settings DRAWER to the (now read-only) Agent git section via the app's own opener
  // (FEAT-190 moved the controls to the Git page; the git pill's "Manage…" no longer opens the
  // drawer, so the suite reaches the drawer through window.__station.drawer like the other UI suites).
  const openDrawerAgentGit = async () => {
    await goProject();
    await page.waitForFunction((p) => window.__station?.state?.current?.projectId === p, pid, { timeout: 30_000 });
    await page.evaluate(() => window.__station.drawer.open('settings', { focus: 'agentGit' }));
    await page.waitForFunction(() => !document.querySelector('#smodal').hidden && !!document.querySelector('[data-focus="agentGit"] .agit-summary'), null, { timeout: 15_000 });
    await sleep(300);
  };
  const closeDrawer = async () => { await page.keyboard.press('Escape'); await page.waitForFunction(() => document.querySelector('#smodal').hidden, null, { timeout: 10_000 }).catch(() => {}); };

  /* ── A — the Git pill: "Manage…" opens the agent-git PANEL in place (not the drawer) ───────── */
  await section('190-git-pill', async () => {
    console.log('\n[190] the Git pill offers "Manage…" + "Allow 30 min"; Manage opens the panel IN PLACE on the Git page');
    await goProject();
    await page.goto(`${BASE}/#/git?project=${encodeURIComponent(pid)}`);
    await page.waitForFunction(() => document.querySelector('.git-view.open .gt-gitwrite') && !document.querySelector('.gt-gw-allow').hidden, null, { timeout: 30_000 });
    const pillBtns = await page.evaluate(() => ({ settings: !!document.querySelector('.gt-gw-settings'), settingsText: document.querySelector('.gt-gw-settings')?.textContent ?? null, perm: !!document.querySelector('.gt-gw-perm'), allow: !document.querySelector('.gt-gw-allow').hidden }));
    check('Git pill: a "Manage…" button replaces the old "Allow permanently…"; "Allow 30 min" still offered', pillBtns.settings && pillBtns.settingsText === 'Manage…' && !pillBtns.perm && pillBtns.allow, pillBtns);
    await page.click('.gt-gw-settings');
    await page.waitForFunction(() => { const p = document.querySelector('.gt-gw-panel'); return p && !p.hidden; }, null, { timeout: 15_000 });
    const opened = await page.evaluate(() => { const p = document.querySelector('.gt-gw-panel'); return { panelOpen: !!p && !p.hidden, drawerHidden: document.querySelector('#smodal').hidden }; });
    check('FEAT-190: "Manage…" opens the agent-git panel IN PLACE on the Git page — the Settings drawer does NOT open', opened.panelOpen && opened.drawerHidden, opened);
    retire('164-pill-opens (old: "Settings…" opened the Settings DRAWER with editable controls)',
      'FEAT-190 moved the controls to the Git page; the pill button is "Manage…" and opens the Git-page panel in place. The panel\'s controls (commit/push/scope/release/Save, cadence, concurrency) are covered by verify-feat-190-ui [190-git-page-panel, 190-default-grant-stores-commit-and-push, 190-optimistic-concurrency-chokepoint].');
  });

  /* ── B — the Settings DRAWER Agent git section is READ-ONLY (success criterion 6) ──────────── */
  await section('190-drawer-readonly-none', async () => {
    console.log('\n[190] drawer (default / none): a read-only summary + "Manage on the Git page", NO editable controls');
    await openDrawerAgentGit(); // fresh project → mode none
    const a = await agit();
    const srv = await policy();
    check('default drawer reads "No agent commits (default)" and server mode is none', a.summary === 'No agent commits (default)' && a.mode === 'none' && srv.policy.mode === 'none', { ui: a.summary, mode: a.mode, server: srv.policy.mode });
    check('the drawer section carries NO editable git controls (they moved to the Git page), a "Manage on the Git page" button, and the managed-on-the-Git-page note', a.hasEditableControl === false && a.hasManage && /managed on the Git page/i.test(a.note ?? ''), { editable: a.hasEditableControl, manage: a.hasManage, note: (a.note ?? '').slice(0, 90) });
    for (const theme of ['light', 'dark']) { await setTheme(theme); await shotSection(`FEAT-164-agentgit-none-${theme}.png`); }
    await setTheme('light');
    await closeDrawer();
    retire('164-default "…and push" disabled while commit off (a drawer TOGGLE assertion)',
      'the commit/push toggles live on the Git page now — verify-feat-190-ui [190-git-page-panel] asserts the panel carries push + that a fresh grant defaults both on.');
  });

  await section('190-drawer-readonly-scoped', async () => {
    console.log('\n[190] drawer (scoped): read-only summary names the scope note; still no editable controls');
    const NOTE = 'commit to main; push at most once a day';
    const put = await putPolicy({ commit: true, push: true, scope: NOTE, release: { opt_in: false } });
    const srv = await policy();
    check('setting scoped via the route (revision threaded) stores mode=scoped with the note', put.status === 200 && srv.policy.mode === 'scoped' && srv.policy.scope === NOTE, { status: put.status, mode: srv.policy.mode, scope: srv.policy.scope });
    await openDrawerAgentGit();
    const a = await agit();
    check('the scoped drawer shows the scope note read-only (.set-why) under an "Agents commit and push…" summary, with no editable controls', /Agents commit/.test(a.summary ?? '') && (a.why ?? '').includes(NOTE) && a.hasEditableControl === false && a.hasManage, { summary: a.summary, why: a.why, editable: a.hasEditableControl });
    for (const theme of ['light', 'dark']) { await setTheme(theme); await shotSection(`FEAT-164-agentgit-scoped-${theme}.png`); }
    await setTheme('light');
    await closeDrawer();
    retire('164-scoped / 164-revoke drawer edit (fill .agit-scope-in, Save / click .agit-revoke)',
      'editing/revoking the policy happens on the Git page now — verify-feat-190-ui drives Save and the panel\'s Revoke; the route\'s scoped/none transitions are covered by verify-feat-164-self-grant [UA5c] and verify-feat-190-ui.');
  });

  await section('190-drawer-readonly-release', async () => {
    console.log('\n[190] drawer (release / soft releases): read-only summary + release-status block, no editable controls');
    const put = await putPolicy({ commit: true, push: false, scope: null, release: { opt_in: true } });
    const srv = await policy();
    check('setting release via the route (EXPLICIT release.opt_in, FEAT-190 — a blank note no longer means release) stores mode=release', put.status === 200 && srv.policy.mode === 'release', { status: put.status, mode: srv.policy.mode });
    await openDrawerAgentGit();
    const a = await agit();
    check('the release drawer summary reads "Soft releases: …" and shows the read-only release-status block, with no editable controls', /^Soft releases: verified work batched into versioned release commits/.test(a.summary ?? '') && a.relPresent && a.hasEditableControl === false && a.hasManage, { summary: a.summary, rel: a.relPresent, editable: a.hasEditableControl });
    for (const theme of ['light', 'dark']) { await setTheme(theme); await shotSection(`FEAT-164-agentgit-release-${theme}.png`); }
    await setTheme('light');
    await closeDrawer();
    retire('164-release drawer edit (click .agit-commit, .agit-save → release) + 164-invalid cadence editing',
      'turning on commit / saving / editing the release cadence happens on the Git page now — verify-feat-190-ui [190-git-page-panel] carries the release opt-in + Save; cadence validation is server-side (the PUT route) and unchanged.');
  });

  /* ── C — "Manage on the Git page" button navigates to the Git page ─────────────────────────── */
  await section('190-drawer-manage-opens-git', async () => {
    console.log('\n[190] the drawer\'s "Manage on the Git page" button opens the Git page');
    await openDrawerAgentGit();
    await page.click('.agit-manage');
    await page.waitForFunction(() => !!document.querySelector('.git-view.open .gt-gitwrite'), null, { timeout: 15_000 }).catch(() => {});
    const landed = await page.evaluate(() => ({ gitOpen: !!document.querySelector('.git-view.open .gt-gitwrite'), drawerHidden: document.querySelector('#smodal').hidden }));
    check('clicking "Manage on the Git page" opens the Git page', landed.gitOpen, landed);
  });

  /* ── D — the Git pill reflects the standing policy ─────────────────────────────────────────── */
  await section('190-pill-standing', async () => {
    console.log('\n[190] the git pill reflects a standing policy (soft releases / scoped)');
    await putPolicy({ commit: true, push: false, scope: null, release: { opt_in: true } }); // release mode
    await page.goto(`${BASE}/#/git?project=${encodeURIComponent(pid)}`);
    await page.waitForFunction(() => document.querySelector('.git-view.open .gt-gitwrite') && document.querySelector('.gt-gitwrite').dataset.mode === 'release', null, { timeout: 30_000 }).catch(() => {});
    const pill = await page.evaluate(() => { const w = document.querySelector('.gt-gitwrite'); return { mode: w.dataset.mode, state: w.querySelector('.gt-gw-state').textContent, allowHidden: document.querySelector('.gt-gw-allow').hidden, revokeHidden: document.querySelector('.gt-gw-revoke').hidden }; });
    check('standing release policy → pill reads "Agent git · soft releases", Revoke shown, Allow hidden', pill.mode === 'release' && pill.state === 'Agent git · soft releases' && pill.revokeHidden === false && pill.allowHidden === true, pill);
    for (const theme of ['light', 'dark']) {
      await setTheme(theme); await sleep(150);
      if (SHOTS) { const r = await page.evaluate(() => { const b = document.querySelector('.gt-gitwrite').getBoundingClientRect(); return { x: Math.max(0, b.x - 30), y: Math.max(0, b.y - 12), width: Math.min(1440, b.width + 60), height: b.height + 24 }; }); await page.screenshot({ path: path.join(OUTDIR, `FEAT-164-agentgit-pill-${theme}.png`), clip: r }); }
    }
    await setTheme('light');
    await putPolicy({ commit: true, push: true, scope: 'commit to main', release: { opt_in: false } }); // scoped
    await page.goto(`${BASE}/#/git?project=${encodeURIComponent(pid)}`);
    await page.waitForFunction(() => document.querySelector('.gt-gitwrite')?.dataset.mode === 'scoped', null, { timeout: 30_000 }).catch(() => {});
    const scoped = await page.evaluate(() => document.querySelector('.gt-gw-state').textContent);
    check('standing scoped policy → pill reads "Agent git · scoped"', scoped === 'Agent git · scoped', scoped);
  });

  /* ── E — MIGRATION: an existing {permanent:true} grant keeps commit+push, shown read-only ──── */
  await section('190-migrated', async () => {
    console.log('\n[190] an EXISTING {permanent:true} grant (r1 shape on disk) keeps direct commits + pushes, shown as a read-only migrated note');
    await stop();
    const regFile = path.join(DATA, 'registry.json');
    const reg = JSON.parse(fs.readFileSync(regFile, 'utf8'));
    const row = reg.projects.find((p) => p.id === pid);
    row.settings.gitWrite = { permanent: true, grantedAt: '2026-10-07T23:24:05.330Z', grantedVia: 'dashboard' };
    fs.writeFileSync(regFile, JSON.stringify(reg, null, 2));
    // The real upgrade: a pre-option-A data dir has no seal key; the first load creates it
    // and seals the grants already on disk (FEAT-164 option A migration).
    fs.rmSync(path.join(DATA, 'git-write-seal.key'), { force: true });
    await boot();
    const srv = await policy();
    check('server reads the r1 grant as scoped + push with the migrated note (behaviour unchanged)', srv.policy.mode === 'scoped' && srv.policy.push === true && srv.policy.legacy === true && /as before \(migrated/.test(srv.policy.scope ?? ''), { mode: srv.policy.mode, push: srv.policy.push, scope: srv.policy.scope });
    const onDisk = JSON.parse(fs.readFileSync(regFile, 'utf8')).projects.find((p) => p.id === pid).settings.gitWrite;
    check('nothing rewritten on disk by reading it (the upgrade only adds the seal + its repo binding)', onDisk.permanent === true && onDisk.commit === undefined && typeof onDisk.seal === 'string' && !!onDisk.repo?.toplevel && Object.keys(onDisk).sort().join() === 'grantedAt,grantedVia,permanent,repo,seal', onDisk);
    await openDrawerAgentGit();
    const a = await agit();
    check('the migrated grant shows READ-ONLY in the drawer: the migrated scope note (.set-why) under an "Agents commit and push…" summary, no editable controls', (a.why ?? '').includes('as before (migrated') && /Agents commit/.test(a.summary ?? '') && a.hasEditableControl === false && a.hasManage, { why: (a.why ?? '').slice(0, 90), summary: a.summary, editable: a.hasEditableControl });
    for (const theme of ['light', 'dark']) { await setTheme(theme); await shotSection(`FEAT-164-agentgit-migrated-${theme}.png`); }
    await setTheme('light');
    await closeDrawer();
    retire('164-migrated "Migrated grant" callout + commit/push toggles in the DRAWER',
      'the migrated grant\'s editable surface (the "Migrated grant" callout, commit/push toggles) is on the Git page now — verify-feat-190-ui [190-legacy-permanent-route-default-push] covers that a legacy permanent grant stores commit AND push.');
  });

  check('no page errors during the run', consoleErrors.length === 0, consoleErrors.slice(0, 3));
} catch (e) {
  check(`suite threw: ${e.stack ?? e.message}`, false);
} finally {
  try { await browser?.close(); } catch { /* gone */ }
  await stop();
  for (const d of [DATA, REPO]) fs.rmSync(d, { recursive: true, force: true });
}
console.log(`\nFEAT-164 settings UI: ${pass} passed, ${fail} failed, ${retired} retired (controls moved to the Git page per FEAT-190)`);
if (fail) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
