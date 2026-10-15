#!/usr/bin/env node
/**
 * verify-feat-190-ui.mjs — FEAT-190 D5: the agent-git CONTROLS live on the GIT PAGE now, and the
 * Settings drawer no longer carries them. Driven in a REAL headless browser against an isolated
 * scratch server over a registered fixture project.
 *
 * FEAT-190 r3 — the END-TO-END default-grant case (the visual review's finding): a grant made
 * through the real panel with DEFAULTS must store commit AND push ON, and the host decide route
 * must then allow a push. This drives the real client (draft defaults + the commit toggle), SAVES
 * through the real PUT route, reads the STORED policy back through the real registry+seal (GET
 * route), and feeds it to decideByTarget — the function src/server/index.ts's /api/git-shim/decide
 * calls (the HTTP route itself is gated by a per-boot, memory-only shim secret that needs a
 * launched session, so the decision is exercised through its own pure function with the real stored
 * policy + the real registry grant binding). A browser launched by this process on a SCRATCH server
 * classifies as the user (caller-provenance: it is not in the scratch server's session scope, not a
 * descendant of the scratch server, not in its service cgroup), so the SAVE succeeds — verified
 * empirically in r3. F190_NO_SHOTS=1 skips screenshots.
 */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { isolatedServerEnv } from './lib/station-boot.mjs';
import { decideByTarget, describeRegisteredRepo } from './lib/agent-git-policy.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUTDIR = process.env.F190_SHOTS ?? path.join(os.tmpdir(), 'feat190-shots');
const SHOTS = process.env.F190_NO_SHOTS !== '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const failures = [];
const check = (name, ok, obs) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${obs === undefined ? '' : `\n        observed: ${typeof obs === 'string' ? obs : JSON.stringify(obs)}`}`); if (ok) pass++; else { fail++; failures.push(name); } };
async function section(name, fn) { try { await fn(); } catch (e) { check(`[${name}] threw: ${String(e.message ?? e).split('\n')[0]}`, false); } }
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
function findChromium() {
  const base = path.join(os.homedir(), '.cache', 'ms-playwright');
  const cands = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse() : [];
  for (const d of cands) { const p = path.join(base, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell'); if (fs.existsSync(p)) return p; }
  return undefined;
}
function realGit() { for (const dir of (process.env.PATH ?? '').split(path.delimiter)) { if (!dir || dir.includes('shim')) continue; const g = path.join(dir, 'git'); try { if (fs.statSync(g).isFile()) return g; } catch { /* next */ } } return '/usr/bin/git'; }

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f190-data-'));
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f190-repo-'));
const GIT = realGit();
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'verify', GIT_AUTHOR_EMAIL: 'verify@example.invalid', GIT_COMMITTER_NAME: 'verify', GIT_COMMITTER_EMAIL: 'verify@example.invalid' };
const g = (...a) => execFileSync(GIT, ['-C', REPO, ...a], { encoding: 'utf8', env: gitEnv });
execFileSync(GIT, ['init', '-b', 'main', REPO], { encoding: 'utf8', env: gitEnv });
fs.writeFileSync(path.join(REPO, 'README.md'), '# fixture (scratch, synthetic)\n');
g('remote', 'add', 'origin', 'https://example.invalid/feat190.git'); // a real network remote → the grant records it, so a push has a destination to decide
g('add', '-A'); g('commit', '-m', 'initial');
if (SHOTS) fs.mkdirSync(OUTDIR, { recursive: true });

const PORT = await freePort(); const BASE = `http://127.0.0.1:${PORT}`;
let server = null, browser = null; const log = [];
async function boot() {
  const env = isolatedServerEnv({ PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_STATION_NO_WA_CONSOLIDATE: '1' });
  server = spawn(process.execPath, ['src/server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => log.push(String(d))); server.stderr.on('data', (d) => log.push(String(d)));
  for (let i = 0; i < 200; i++) { try { const r = await fetch(`${BASE}/api/projects`); if (r.ok) return; } catch { /* booting */ } await sleep(150); }
  throw new Error(`server did not boot:\n${log.join('').slice(-1500)}`);
}
const j = async (m, u, body) => { const r = await fetch(BASE + u, { method: m, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined }); let d; try { d = await r.json(); } catch { d = null; } return { status: r.status, d }; };
// FEAT-190 r3 — the policy PUT is now optimistic-concurrency gated: it needs the current revision.
const getRev = async (id) => (await j('GET', `/api/projects/${encodeURIComponent(id)}/git-write-grant`)).d?.revision ?? null;
const putPolicy = async (id, body) => { const revision = await getRev(id); return j('PUT', `/api/projects/${encodeURIComponent(id)}/git-write-policy`, { ...body, revision }); };

try {
  await boot();
  const r = await j('POST', '/api/projects', { hostPath: REPO, isolation: 'direct', applyMethod: false });
  const pid = r.d?.project?.id ?? r.d?.id;
  if (!pid) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.d)}`);

  browser = await chromium.launch({ executablePath: findChromium() });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 980 } })).newPage();
  const perr = []; page.on('pageerror', (e) => perr.push(String(e)));

  // Open the Manage panel reliably: navigate, WAIT for loadGrant to settle (the pill stops showing
  // its "Agent git…" loading placeholder) BEFORE clicking Manage — else loadGrant resolves after the
  // panel opens and nulls the draft mid-edit (a test-timing race, not a product path: a user clicks
  // Manage only after the pill has painted).
  async function openGwPanel() {
    // The SPA reuses the pill DOM across navigations, so there is no loading transient to wait on;
    // wait for the git-write-grant GET that open()→loadGrant fires, so the draft is seeded from the
    // freshly-loaded policy and a late loadGrant cannot null it after the panel opens.
    const grantLoaded = page.waitForResponse((r) => /\/git-write-grant\b/.test(r.url()), { timeout: 30_000 });
    await page.goto(`${BASE}/#/git?project=${encodeURIComponent(pid)}`);
    await page.waitForFunction(() => document.querySelector('.git-view.open .gt-gitwrite'), null, { timeout: 30_000 });
    await grantLoaded; await sleep(150);
    await page.click('.gt-gw-settings');
    // Opening Manage re-fetches the policy (FEAT-190 r3); wait for the loaded form (Save present),
    // not merely the panel container, so draft reads see the fresh policy.
    await page.waitForFunction(() => { const p = document.querySelector('.gt-gw-panel'); return p && !p.hidden && p.querySelector('.gt-gw-save'); }, null, { timeout: 15_000 });
  }
  const saveAndWait = async (pg = page) => {
    await pg.click('.gt-gw-save');
    await pg.waitForFunction(() => { const b = document.querySelector('.gt-gw-save'); return b && !/Saving/.test(b.textContent || ''); }, null, { timeout: 15_000 });
    await sleep(400);
  };

  await section('190-git-page-panel', async () => {
    await page.goto(`${BASE}/#/git?project=${encodeURIComponent(pid)}`);
    await page.waitForFunction(() => document.querySelector('.git-view.open .gt-gitwrite'), null, { timeout: 30_000 });
    const manageText = await page.evaluate(() => document.querySelector('.gt-gw-settings')?.textContent ?? null);
    check('the git pill shows "Manage…" (controls live here now)', manageText === 'Manage…', manageText);
    await page.waitForFunction(() => { const s = document.querySelector('.gt-gw-state'); return s && s.textContent && s.textContent !== 'Agent git…'; }, null, { timeout: 30_000 });
    await page.click('.gt-gw-settings');
    // Opening Manage re-fetches the policy (FEAT-190 r3); wait for the loaded form (Save present).
    await page.waitForFunction(() => { const p = document.querySelector('.gt-gw-panel'); return p && !p.hidden && p.querySelector('.gt-gw-save'); }, null, { timeout: 15_000 });
    const panel = await page.evaluate(() => {
      const p = document.querySelector('.gt-gw-panel');
      const t = (s) => p.querySelector(s);
      const rows = [...p.querySelectorAll('.gt-gw-row')].map((r) => r.querySelector('span')?.textContent ?? '');
      return { present: !!p, commitRow: rows.some((x) => /commit/i.test(x)), pushRow: rows.some((x) => /push/i.test(x)), scope: !!t('.gt-gw-scope'), releaseRow: rows.some((x) => /soft releases/i.test(x)), save: !!t('.gt-gw-save'), foot: /leak gate/.test(p.textContent) };
    });
    check('the git-page panel carries the commit control', panel.present && panel.commitRow, panel);
    check('the panel carries push, scope note, release opt-in, Save', panel.pushRow && panel.scope && panel.releaseRow && panel.save, panel);
    check('the panel states the leak gate still runs', panel.foot, panel.foot);
    if (SHOTS) await page.screenshot({ path: path.join(OUTDIR, 'feat190-git-panel.png') });
  });

  await section('190-default-grant-stores-commit-and-push', async () => {
    // The visual-review finding (FEAT-190 r3): a grant made with DEFAULTS through the real panel
    // must allow push. Drive the real client, SAVE, read the STORED policy, decide a push.
    await openGwPanel();
    // The panel OPENS on a fresh no-grant state with the default grant intent: commit ON, push ON.
    const draft = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.gt-gw-panel .gt-gw-row')];
      const on = (re) => rows.find((r) => re.test(r.querySelector('span')?.textContent || ''))?.querySelector('.gt-gw-sw')?.dataset.on;
      return { commit: on(/may commit/i), push: on(/push to the remote/i) };
    });
    check('a fresh grant panel defaults BOTH commit and push ON', draft.commit === 'true' && draft.push === 'true', draft);
    // Minimal user action: just Save (the user granted; defaults apply). Record the PUT result.
    const saved = [];
    const onResp = (resp) => { if (resp.url().includes('git-write-policy') && resp.request().method() === 'PUT') saved.push(resp.status()); };
    page.on('response', onResp);
    await saveAndWait(); page.off('response', onResp);
    check('the Save PUT succeeded (200) from the browser (user caller on the scratch server)', saved.length > 0 && saved.every((s) => s === 200), saved);
    // Read the STORED policy back through the real registry+seal.
    const pol = (await j('GET', `/api/projects/${encodeURIComponent(pid)}/git-write-policy`)).d?.policy ?? null;
    check('the STORED default grant allows commit AND push', !!pol && pol.commit === true && pol.push === true && pol.mode === 'scoped', pol);
    // The host decide route's function: a push to the project's own remote must be ALLOWED. Build
    // the project descriptor + grant binding the way src/server/index.ts does.
    let decision = null, binding = null;
    try {
      const reg = JSON.parse(fs.readFileSync(path.join(DATA, 'registry.json'), 'utf8'));
      const list = Array.isArray(reg.projects) ? reg.projects : Array.isArray(reg) ? reg : Object.values(reg);
      const rec = list.find?.((x) => x && x.id === pid) ?? null;
      binding = rec?.settings?.gitWrite?.repo ?? null;
      const desc = describeRegisteredRepo(REPO);
      const projects = [{ id: pid, name: 'fixture', ...desc, policy: pol, timedGrantLive: false, binding }];
      // FEAT-190 r14 — carry the RESOLVED source toplevel the way the real git-shim does (git-target
      // runs `git rev-parse --show-toplevel`; the real /api/git-shim/decide route consumes
      // body.target.toplevel). The old fixture omitted it, so the push resolved as a bare/no-work-tree
      // source and the r10 one-resolved-repo invariant correctly refused it (the UI 40/2 red). A real
      // working-repo push always carries its toplevel; desc.tree is that working-tree root.
      decision = decideByTarget({ argv: ['push', 'origin', 'main'], target: { resolvedVerb: true, verb: 'push', cwd: REPO, commonDir: desc.commonDir, toplevel: desc.tree, push: { urls: ['https://example.invalid/feat190.git'] } }, sessionProjectId: pid, projects });
    } catch (e) { decision = { refusal: `decide build threw: ${String(e.message ?? e)}` }; }
    check('the host decide route ALLOWS a push under the default grant', !!decision && decision.refusal === null, { decision, bindingPresent: !!binding });
    if (SHOTS) await page.screenshot({ path: path.join(OUTDIR, 'feat190-default-grant.png') });
  });

  await section('190-existing-push-off-preserved', async () => {
    // Guard the preserve property: a grant with push explicitly OFF must be reflected by the panel
    // (not silently re-defaulted to ON) and saving without touching push must keep it OFF.
    await openGwPanel();
    // Turn push OFF (explicit opt-out) and Save.
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.gt-gw-panel .gt-gw-row')];
      const sw = rows.find((r) => /push to the remote/i.test(r.querySelector('span')?.textContent || ''))?.querySelector('.gt-gw-sw');
      if (sw && sw.dataset.on === 'true') sw.click();
    });
    await sleep(100);
    await saveAndWait();
    const pol1 = (await j('GET', `/api/projects/${encodeURIComponent(pid)}/git-write-policy`)).d?.policy ?? null;
    check('an explicit push opt-out stores commit:true push:false', !!pol1 && pol1.commit === true && pol1.push === false, pol1);
    // Reopen: the panel must REFLECT push OFF (not re-default it ON).
    await openGwPanel();
    const draft2 = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.gt-gw-panel .gt-gw-row')];
      const on = (re) => rows.find((r) => re.test(r.querySelector('span')?.textContent || ''))?.querySelector('.gt-gw-sw')?.dataset.on;
      return { commit: on(/may commit/i), push: on(/push to the remote/i) };
    });
    check('reopening reflects the stored push:false (not silently re-enabled)', draft2.commit === 'true' && draft2.push === 'false', draft2);
    // The release copy must state plainly that it blocks direct pushes.
    const releaseCopy = await page.evaluate(() => [...document.querySelectorAll('.gt-gw-panel .gt-gw-row span')].map((s) => s.textContent).find((t) => /soft releases/i.test(t || '')) || '');
    check('the Soft-releases copy states it blocks direct pushes', /push/i.test(releaseCopy) && /(block|never)/i.test(releaseCopy), releaseCopy);
  });

  await section('190-save-before-policy-loads-cannot-overgrant', async () => {
    // IV run 01a13c5b (cross-provider, BROKEN): opening "Manage" BEFORE loadGrant resolves used to
    // seed a default-ON (commit+push) draft, so an untouched Save silently flipped the EXISTING
    // push:false grant to push:true — a silent OVER-grant. The panel must show a loading state (no
    // toggles, no Save) until the policy arrives, then reflect the stored push:false. pid currently
    // holds commit:true push:false (prior section).
    const pre = (await j('GET', `/api/projects/${encodeURIComponent(pid)}/git-write-policy`)).d?.policy ?? null;
    if (!(pre && pre.commit === true && pre.push === false)) { check('precondition: pid holds an existing push:false grant', false, pre); return; }
    // A FRESH context/page so git-view's in-memory `policy` starts null (the real first-load trigger:
    // the IV attack needs an unloaded policy, which a navigation within one SPA session does not give
    // because the closure retains the prior project's policy).
    const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 980 } });
    const page2 = await ctx2.newPage();
    const perr2 = []; page2.on('pageerror', (e) => perr2.push(String(e)));
    try {
      // Delay the git-write-grant GET so we can race the panel open against it.
      await page2.route('**/git-write-grant', async (route) => { await sleep(1800); await route.continue(); });
      await page2.goto(`${BASE}/#/git?project=${encodeURIComponent(pid)}`);
      await page2.waitForFunction(() => document.querySelector('.git-view.open .gt-gitwrite'), null, { timeout: 30_000 });
      await page2.click('.gt-gw-settings'); // open BEFORE the delayed GET resolves (policy still null)
      await page2.waitForFunction(() => { const p = document.querySelector('.gt-gw-panel'); return p && !p.hidden; }, null, { timeout: 10_000 });
      const whileLoading = await page2.evaluate(() => {
        const p = document.querySelector('.gt-gw-panel');
        return { hasToggles: p.querySelectorAll('.gt-gw-row').length, hasSave: !!p.querySelector('.gt-gw-save') };
      });
      check('panel shows a loading state (no toggles, no Save) before the policy loads', whileLoading.hasToggles === 0 && !whileLoading.hasSave, whileLoading);
      // THE ATTACK (IV 01a13c5b): try to Save RIGHT NOW, while the policy is still loading. The fixed
      // build offers no Save button during the load window; a build that seeds a default-ON draft
      // before load would Save commit+push over the existing push:false here (silent over-grant).
      const prematureSaved = await page2.evaluate(() => { const b = document.querySelector('.gt-gw-panel .gt-gw-save'); if (b) { b.click(); return true; } return false; });
      await sleep(2400); // let the delayed GET resolve and any premature PUT settle
      const post = (await j('GET', `/api/projects/${encodeURIComponent(pid)}/git-write-policy`)).d?.policy ?? null;
      check('a Save attempted during a slow policy load cannot over-grant (push stays false)', !!post && post.commit === true && post.push === false, { post, prematureSaved });
      // And once loaded the panel reflects the stored push:false (re-seeded from the real policy).
      const afterLoad = await page2.evaluate(() => {
        const rows = [...document.querySelectorAll('.gt-gw-panel .gt-gw-row')];
        const on = (re) => rows.find((r) => re.test(r.querySelector('span')?.textContent || ''))?.querySelector('.gt-gw-sw')?.dataset.on;
        return { commit: on(/may commit/i), push: on(/push to the remote/i) };
      });
      check('once loaded, the panel reflects the stored push:false', afterLoad.commit === 'true' && afterLoad.push === 'false', afterLoad);
      check('no uncaught page errors (fresh-load race)', perr2.length === 0, perr2.slice(0, 3).join(' | '));
    } finally { try { await ctx2.close(); } catch { /* ignore */ } }
  });

  await section('190-failed-policy-load-cannot-overgrant', async () => {
    // IV run 01a13c63 (cross-provider, BROKEN): loadGrant's error path treated a FAILED policy GET
    // as a loaded null policy, so the panel seeded a default-ON draft and an untouched Save flipped
    // the existing push:false to push:true. A failed load must show an error, no toggles, no Save.
    const pre = (await j('GET', `/api/projects/${encodeURIComponent(pid)}/git-write-policy`)).d?.policy ?? null;
    if (!(pre && pre.commit === true && pre.push === false)) { check('precondition: pid holds an existing push:false grant', false, pre); return; }
    const ctx3 = await browser.newContext({ viewport: { width: 1440, height: 980 } });
    const page3 = await ctx3.newPage();
    const perr3 = []; page3.on('pageerror', (e) => perr3.push(String(e)));
    try {
      // Make the policy GET FAIL (503) on a fresh page (policy starts null).
      await page3.route('**/git-write-grant', async (route) => { await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable' }) }); });
      await page3.goto(`${BASE}/#/git?project=${encodeURIComponent(pid)}`);
      await page3.waitForFunction(() => document.querySelector('.git-view.open .gt-gitwrite'), null, { timeout: 30_000 });
      await page3.click('.gt-gw-settings');
      await page3.waitForFunction(() => { const p = document.querySelector('.gt-gw-panel'); return p && !p.hidden; }, null, { timeout: 10_000 });
      await sleep(500);
      const state = await page3.evaluate(() => {
        const p = document.querySelector('.gt-gw-panel');
        return { toggles: p.querySelectorAll('.gt-gw-row').length, hasSave: !!p.querySelector('.gt-gw-save'), hasErr: !!p.querySelector('.gt-gw-err') };
      });
      check('a FAILED policy load shows an error with no toggles and no Save', state.toggles === 0 && !state.hasSave && state.hasErr, state);
      // Attack: try to Save anyway (no button in the fixed build → no-op).
      const clicked = await page3.evaluate(() => { const b = document.querySelector('.gt-gw-panel .gt-gw-save'); if (b) { b.click(); return true; } return false; });
      await sleep(800);
      const post = (await j('GET', `/api/projects/${encodeURIComponent(pid)}/git-write-policy`)).d?.policy ?? null;
      check('a Save during a FAILED policy load cannot over-grant (push stays false)', !!post && post.commit === true && post.push === false, { post, clicked });
    } finally { try { await ctx3.close(); } catch { /* ignore */ } }
  });

  await section('190-reopen-refetches-concurrent-grant-change', async () => {
    // IV run 01a13c67 (cross-provider, BROKEN): a second tab changed the grant to push:false while
    // this page held a cached push:true policy; reopening Manage showed the STALE push:true and an
    // untouched Save clobbered the other tab's push:false. Opening Manage must RE-FETCH, not trust
    // the cached policy.
    // 1) Set stored push:true (via the real PUT; the node test process classifies as the user).
    const setTrue = await putPolicy(pid, { commit: true, push: true, scope: null, release: { opt_in: false } });
    if (setTrue.status !== 200) { check('precondition: could set push:true via PUT', false, setTrue); return; }
    // 2) Page A loads the git view → caches policy push:true (panel NOT opened yet).
    const ctxA = await browser.newContext({ viewport: { width: 1440, height: 980 } });
    const pageA = await ctxA.newPage();
    const perrA = []; pageA.on('pageerror', (e) => perrA.push(String(e)));
    try {
      const grantLoaded = pageA.waitForResponse((r) => /\/git-write-grant\b/.test(r.url()), { timeout: 30_000 });
      await pageA.goto(`${BASE}/#/git?project=${encodeURIComponent(pid)}`);
      await pageA.waitForFunction(() => document.querySelector('.git-view.open .gt-gitwrite'), null, { timeout: 30_000 });
      await grantLoaded; await sleep(200);
      // 3) Another tab (simulated via PUT) changes the grant to push:false AFTER page A cached it.
      const setFalse = await putPolicy(pid, { commit: true, push: false, scope: null, release: { opt_in: false } });
      check('a concurrent tab stored push:false', setFalse.status === 200 && setFalse.d?.policy?.push === false, setFalse.d?.policy);
      // 4) Page A opens Manage WITHOUT reloading — it must re-fetch and reflect push:false.
      await pageA.click('.gt-gw-settings');
      await pageA.waitForFunction(() => { const p = document.querySelector('.gt-gw-panel'); return p && !p.hidden && p.querySelector('.gt-gw-save'); }, null, { timeout: 15_000 });
      const draft = await pageA.evaluate(() => {
        const rows = [...document.querySelectorAll('.gt-gw-panel .gt-gw-row')];
        const on = (re) => rows.find((r) => re.test(r.querySelector('span')?.textContent || ''))?.querySelector('.gt-gw-sw')?.dataset.on;
        return { commit: on(/may commit/i), push: on(/push to the remote/i) };
      });
      check('reopening Manage re-fetches and reflects the concurrent push:false', draft.commit === 'true' && draft.push === 'false', draft);
      // 5) Untouched Save must preserve push:false (not clobber it with a stale push:true).
      await saveAndWait(pageA);
      const post = (await j('GET', `/api/projects/${encodeURIComponent(pid)}/git-write-policy`)).d?.policy ?? null;
      check('untouched Save after a concurrent change preserves push:false', !!post && post.commit === true && post.push === false, post);
      check('no uncaught page errors (concurrent-tab reopen)', perrA.length === 0, perrA.slice(0, 3).join(' | '));
    } finally { try { await ctxA.close(); } catch { /* ignore */ } }
  });

  await section('190-late-initial-load-cannot-clobber-edit', async () => {
    // IV run 01a13c6d (cross-provider): open()'s initial loadGrant resolves LATE, AFTER the panel's
    // own re-fetch has rendered and the user has toggled push OFF, re-seeding the draft and
    // discarding that edit (silent over-grant). The seq guard makes the superseded load inert.
    const setTrue = await putPolicy(pid, { commit: true, push: true, scope: null, release: { opt_in: false } });
    if (setTrue.status !== 200 || setTrue.d?.policy?.push !== true) { check('precondition: stored push:true', false, setTrue.d?.policy); return; }
    const ctxL = await browser.newContext({ viewport: { width: 1440, height: 980 } });
    const pageL = await ctxL.newPage();
    const perrL = []; pageL.on('pageerror', (e) => perrL.push(String(e)));
    let releaseFirst; const firstReleased = new Promise((r) => { releaseFirst = r; });
    let count = 0;
    try {
      // Hold the FIRST git-write-grant GET (open()'s initial load); let the panel re-fetch pass.
      await pageL.route('**/git-write-grant', async (route) => { count += 1; if (count === 1) { await firstReleased; await route.continue(); } else { await route.continue(); } });
      await pageL.goto(`${BASE}/#/git?project=${encodeURIComponent(pid)}`);
      await pageL.waitForFunction(() => document.querySelector('.git-view.open .gt-gitwrite'), null, { timeout: 30_000 });
      await pageL.click('.gt-gw-settings'); // fires the 2nd (fast) load → panel renders push:true
      await pageL.waitForFunction(() => { const p = document.querySelector('.gt-gw-panel'); return p && !p.hidden && p.querySelector('.gt-gw-save'); }, null, { timeout: 15_000 });
      // User explicitly toggles push OFF.
      await pageL.evaluate(() => { const sw = [...document.querySelectorAll('.gt-gw-panel .gt-gw-row')].find((r) => /push to the remote/i.test(r.querySelector('span')?.textContent || ''))?.querySelector('.gt-gw-sw'); if (sw && sw.dataset.on === 'true') sw.click(); });
      await sleep(100);
      // NOW release the late initial load — it must NOT clobber the edit.
      releaseFirst(); await sleep(900);
      const draft = await pageL.evaluate(() => { const sw = [...document.querySelectorAll('.gt-gw-panel .gt-gw-row')].find((r) => /push to the remote/i.test(r.querySelector('span')?.textContent || ''))?.querySelector('.gt-gw-sw'); return sw?.dataset.on; });
      check('a late superseded initial load does NOT clobber the user push-OFF edit', draft === 'false', draft);
      const putStatuses = [];
      const onPut = (resp) => { if (resp.url().includes('git-write-policy') && resp.request().method() === 'PUT') putStatuses.push(resp.status()); };
      pageL.on('response', onPut);
      await saveAndWait(pageL); pageL.off('response', onPut);
      const post = (await j('GET', `/api/projects/${encodeURIComponent(pid)}/git-write-policy`)).d?.policy ?? null;
      check('Save after a late load preserves the explicit push:false', !!post && post.commit === true && post.push === false, { post, putStatuses });
      check('no uncaught page errors (late-load clobber)', perrL.length === 0, perrL.slice(0, 3).join(' | '));
    } finally { try { releaseFirst && releaseFirst(); } catch { /* ignore */ } try { await ctxL.close(); } catch { /* ignore */ } }
  });

  await section('190-optimistic-concurrency-chokepoint', async () => {
    // Coordinator redesign (two-break rule): the PUT git-write-policy route is the authoritative
    // race-killer — a save carries the rendered revision; the server refuses a stale write (409),
    // so "a save stores something other than what the user saw" is impossible by construction.
    const policyUrl = `/api/projects/${encodeURIComponent(pid)}/git-write-policy`;
    // Known start: a grant with push:true.
    const seed = await putPolicy(pid, { commit: true, push: true, scope: null, release: { opt_in: false } });
    if (seed.status !== 200) { check('precondition: seeded a grant', false, seed); return; }
    // (1) Two concurrent PUTs carrying the SAME revision → exactly one wins.
    const rev = await getRev(pid);
    const [a, b] = await Promise.all([
      j('PUT', policyUrl, { commit: true, push: false, scope: null, release: { opt_in: false }, revision: rev }),
      j('PUT', policyUrl, { commit: true, push: true, scope: null, release: { opt_in: false }, revision: rev }),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    check('two concurrent PUTs with the same revision → exactly one 200, one 409', statuses[0] === 200 && statuses[1] === 409, { a: a.status, b: b.status });
    const winner = a.status === 200 ? a : b;
    const stored1 = (await j('GET', policyUrl)).d?.policy ?? null;
    check('the stored policy is exactly the winner\'s (not a merge/clobber)', !!stored1 && stored1.push === winner.d?.policy?.push, { stored: stored1?.push, winner: winner.d?.policy?.push });
    // (2) A stale panel: capture a revision, advance it, then PUT with the stale one → 409, nothing stored.
    const staleRev = await getRev(pid);
    const advance = await putPolicy(pid, { commit: true, push: false, scope: null, release: { opt_in: false } });
    const beforeStale = (await j('GET', policyUrl)).d?.policy ?? null;
    const stalePut = await j('PUT', policyUrl, { commit: true, push: true, scope: null, release: { opt_in: false }, revision: staleRev });
    check('a PUT carrying a stale revision is refused (409)', stalePut.status === 409, stalePut.status);
    const afterStale = (await j('GET', policyUrl)).d?.policy ?? null;
    check('a stale-revision PUT stores NOTHING (push unchanged)', !!afterStale && afterStale.push === beforeStale.push && advance.status === 200, { beforeStale: beforeStale?.push, afterStale: afterStale?.push });
    // (3) A PUT with NO revision is refused (400).
    const noRev = await j('PUT', policyUrl, { commit: true, push: true, scope: null, release: { opt_in: false } });
    check('a PUT with no revision is refused (400)', noRev.status === 400, { status: noRev.status, error: noRev.d?.error });
  });

  await section('190-get-policy-revision-consistency', async () => {
    // IV run 01a13c85 (cross-provider, finding surfaced before the dispatch was cut by a content
    // filter): GET /git-write-policy read the policy BEFORE its awaited release-plan CLI but the
    // revision AFTER, so a concurrent save during that await returned a STALE policy with the NEW
    // revision — a client could then store that stale view through the guard. Invariant now: the
    // returned {policy, revision} pair is internally consistent (same revision ⇒ same value).
    const policyUrl = `/api/projects/${encodeURIComponent(pid)}/git-write-policy`;
    const grantUrl = `/api/projects/${encodeURIComponent(pid)}/git-write-grant`;
    const seed = await putPolicy(pid, { commit: true, push: true, scope: null, release: { opt_in: false } });
    if (seed.status !== 200) { check('precondition: seeded push:true', false, seed); return; }
    // Start the slow GET (its release-plan CLI await is the race window), then land a push:false save.
    const getP = j('GET', policyUrl);
    await sleep(40);
    await putPolicy(pid, { commit: true, push: false, scope: null, release: { opt_in: false } });
    const g = (await getP).d ?? {};
    const auth = (await j('GET', grantUrl)).d ?? {};
    // Same revision MUST imply same value (a GET from an earlier state has an earlier revision, which
    // is fine; the bug is same-revision-but-different-value).
    const consistent = g.revision !== auth.revision || g.policy?.push === auth.policy?.push;
    check('GET git-write-policy returns a self-consistent {policy,revision} under a concurrent save', consistent, { gRev: g.revision, gPush: g.policy?.push, authRev: auth.revision, authPush: auth.policy?.push });
  });

  await section('190-stale-panel-409-ux', async () => {
    // When the panel is ALREADY open and another tab changes the grant before Save, the save hits a
    // 409; the panel must show "settings changed — review and save again", re-fetch, and NOT clobber.
    const policyUrl = `/api/projects/${encodeURIComponent(pid)}/git-write-policy`;
    const seed = await putPolicy(pid, { commit: true, push: true, scope: null, release: { opt_in: false } });
    if (seed.status !== 200) { check('precondition: seeded push:true', false, seed); return; }
    const ctxS = await browser.newContext({ viewport: { width: 1440, height: 980 } });
    const pageS = await ctxS.newPage();
    const perrS = []; pageS.on('pageerror', (e) => perrS.push(String(e)));
    try {
      // Open the panel (re-fetches → holds the current revision, shows push:true).
      const grantLoaded = pageS.waitForResponse((r) => /\/git-write-grant\b/.test(r.url()), { timeout: 30_000 });
      await pageS.goto(`${BASE}/#/git?project=${encodeURIComponent(pid)}`);
      await pageS.waitForFunction(() => document.querySelector('.git-view.open .gt-gitwrite'), null, { timeout: 30_000 });
      await grantLoaded; await sleep(150);
      await pageS.click('.gt-gw-settings');
      await pageS.waitForFunction(() => { const p = document.querySelector('.gt-gw-panel'); return p && !p.hidden && p.querySelector('.gt-gw-save'); }, null, { timeout: 15_000 });
      // Another tab changes the grant (advances the revision) while this panel sits open.
      const concurrent = await putPolicy(pid, { commit: true, push: false, scope: null, release: { opt_in: false } });
      check('concurrent change stored push:false', concurrent.status === 200 && concurrent.d?.policy?.push === false, concurrent.d?.policy);
      // The stale panel saves → 409 → error banner, re-fetch, no clobber.
      await pageS.click('.gt-gw-save');
      await pageS.waitForFunction(() => { const e = document.querySelector('.gt-gw-panel .gt-gw-err'); return e && /changed/i.test(e.textContent || ''); }, null, { timeout: 15_000 });
      const errText = await pageS.evaluate(() => document.querySelector('.gt-gw-panel .gt-gw-err')?.textContent ?? '');
      check('a stale Save shows the "settings changed — save again" message (no auto-retry)', /changed/i.test(errText) && /save again/i.test(errText), errText);
      await sleep(400);
      const post = (await j('GET', policyUrl)).d?.policy ?? null;
      check('the stale Save did NOT clobber the concurrent push:false', !!post && post.commit === true && post.push === false, post);
      check('no uncaught page errors (stale-409 ux)', perrS.length === 0, perrS.slice(0, 3).join(' | '));
    } finally { try { await ctxS.close(); } catch { /* ignore */ } }
  });

  await section('190-no-post-save-refetch-clobber', async () => {
    // IV run fd9c30b8 (BROKEN): gwSave used to fire `void loadGrant(token)` after a 200; a push-OFF
    // edit made while that re-fetch was in flight got reverted to ON and the next Save stored
    // push:true. The fix REMOVES the post-save re-fetch (the PUT response already carries the
    // authoritative policy+revision). Structural guard: a successful save fires NO git-write-grant
    // GET afterwards (so there is no re-fetch to clobber an edit), and a save→edit→save preserves it.
    const policyUrl = `/api/projects/${encodeURIComponent(pid)}/git-write-policy`;
    const seed = await putPolicy(pid, { commit: true, push: true, scope: null, release: { opt_in: false } });
    if (seed.status !== 200) { check('precondition: seeded push:true', false, seed); return; }
    const ctxN = await browser.newContext({ viewport: { width: 1440, height: 980 } });
    const pageN = await ctxN.newPage();
    const perrN = []; pageN.on('pageerror', (e) => perrN.push(String(e)));
    try {
      const grantLoaded = pageN.waitForResponse((r) => /\/git-write-grant\b/.test(r.url()), { timeout: 30_000 });
      await pageN.goto(`${BASE}/#/git?project=${encodeURIComponent(pid)}`);
      await pageN.waitForFunction(() => document.querySelector('.git-view.open .gt-gitwrite'), null, { timeout: 30_000 });
      await grantLoaded; await sleep(150);
      await pageN.click('.gt-gw-settings');
      await pageN.waitForFunction(() => { const p = document.querySelector('.gt-gw-panel'); return p && !p.hidden && p.querySelector('.gt-gw-save'); }, null, { timeout: 15_000 });
      // Count git-write-grant GETs fired AFTER the save (the post-save re-fetch, if any).
      let postSaveGets = 0;
      const onReq = (r) => { if (/\/git-write-grant\b/.test(r.url())) postSaveGets += 1; };
      pageN.on('request', onReq);
      await saveAndWait(pageN); // save #1 (no-op content change, still a 200 write)
      await sleep(900);
      pageN.off('request', onReq);
      check('a successful save fires NO post-save policy re-fetch (no clobber window)', postSaveGets === 0, postSaveGets);
      // Behavioural: after the save, toggle push OFF and save again → stored push:false (no revert).
      await pageN.evaluate(() => { const sw = [...document.querySelectorAll('.gt-gw-panel .gt-gw-row')].find((r) => /push to the remote/i.test(r.querySelector('span')?.textContent || ''))?.querySelector('.gt-gw-sw'); if (sw && sw.dataset.on === 'true') sw.click(); });
      await sleep(100);
      await saveAndWait(pageN);
      const post = (await j('GET', policyUrl)).d?.policy ?? null;
      check('save → push-OFF edit → save stores push:false (edit not reverted)', !!post && post.commit === true && post.push === false, post);
      check('no uncaught page errors (post-save refetch)', perrN.length === 0, perrN.slice(0, 3).join(' | '));
    } finally { try { await ctxN.close(); } catch { /* ignore */ } }
  });

  await section('190-legacy-permanent-route-default-push', async () => {
    // IV run fd9c30b8 (BROKEN): POST /git-write-grant {scope:'permanent'} (what git-grant.mjs
    // --permanent calls → setGitWritePermanent) inherited cur.push (false on a fresh project), so a
    // DEFAULT standing grant via this route stored commit:true push:false and the host refused the
    // push — the ticket's original defect on a non-panel route. A fresh permanent grant must default
    // push ON (success criterion 1), like the panel PUT.
    const repo2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f190-repo2-'));
    execFileSync(GIT, ['init', '-b', 'main', repo2], { encoding: 'utf8', env: gitEnv });
    fs.writeFileSync(path.join(repo2, 'README.md'), '# fixture2 (scratch, synthetic)\n');
    execFileSync(GIT, ['-C', repo2, 'remote', 'add', 'origin', 'https://example.invalid/feat190b.git'], { env: gitEnv });
    execFileSync(GIT, ['-C', repo2, 'add', '-A'], { env: gitEnv });
    execFileSync(GIT, ['-C', repo2, 'commit', '-m', 'init'], { encoding: 'utf8', env: gitEnv });
    const reg2 = await j('POST', '/api/projects', { hostPath: repo2, isolation: 'direct', applyMethod: false });
    const pid2 = reg2.d?.project?.id ?? reg2.d?.id;
    if (!pid2) { check('precondition: registered fresh project', false, reg2); fs.rmSync(repo2, { recursive: true, force: true }); return; }
    try {
      // The legacy/CLI route: a PERMANENT standing grant, no revision, on a fresh (mode none) project.
      const grant = await j('POST', `/api/projects/${encodeURIComponent(pid2)}/git-write-grant`, { scope: 'permanent' });
      check('the permanent-grant POST succeeded', grant.status === 200, grant.status);
      const pol = (await j('GET', `/api/projects/${encodeURIComponent(pid2)}/git-write-policy`)).d?.policy ?? null;
      check('a DEFAULT permanent grant stores commit AND push (not commit-only)', !!pol && pol.commit === true && pol.push === true && pol.mode === 'scoped', pol);
      // And the host decide route allows a push under it.
      const regFile = JSON.parse(fs.readFileSync(path.join(DATA, 'registry.json'), 'utf8'));
      const list = Array.isArray(regFile.projects) ? regFile.projects : Array.isArray(regFile) ? regFile : Object.values(regFile);
      const rec = list.find?.((x) => x && x.id === pid2) ?? null;
      const binding = rec?.settings?.gitWrite?.repo ?? null;
      const desc = describeRegisteredRepo(repo2);
      const projects = [{ id: pid2, name: 'fixture2', ...desc, policy: pol, timedGrantLive: false, binding }];
      // FEAT-190 r14 — carry the RESOLVED source toplevel (see the matching note above); the old
      // fixture omitted it and the r10 bare-source invariant correctly refused the push (UI 40/2 red).
      const decision = decideByTarget({ argv: ['push', 'origin', 'main'], target: { resolvedVerb: true, verb: 'push', cwd: repo2, commonDir: desc.commonDir, toplevel: desc.tree, push: { urls: ['https://example.invalid/feat190b.git'] } }, sessionProjectId: pid2, projects });
      check('the host decide route ALLOWS a push under the default permanent grant', !!decision && decision.refusal === null, { decision, bindingPresent: !!binding });
    } finally { try { fs.rmSync(repo2, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  await section('190-drawer-readonly', async () => {
    // The Settings drawer's Agent git group must no longer carry editable controls.
    await page.goto(`${BASE}/#/project/${encodeURIComponent(pid)}`);
    await page.waitForFunction(() => document.querySelectorAll('#tree button.proj').length > 0, null, { timeout: 30_000 });
    // Open Settings → Agent git (the drawer). Use the app's own deep-link.
    await page.evaluate((id) => { location.hash = `#/project/${encodeURIComponent(id)}/settings`; }, pid);
    await sleep(800);
    const drawer = await page.evaluate(() => {
      const grp = document.querySelector('[data-focus="agentGit"]');
      if (!grp) return { present: false };
      return { present: true, hasSave: !!grp.querySelector('.agit-save'), hasScopeInput: !!grp.querySelector('.agit-scope-in'), hasToggle: !!grp.querySelector('.agit-commit'), hasManage: !!grp.querySelector('.agit-manage'), text: (grp.textContent || '').slice(0, 160) };
    });
    if (!drawer.present) { check('drawer Agent git group not reachable in this build (skipped)', true, 'not found — settings route differs; render check is the git page'); return; }
    check('the drawer no longer carries the editable controls (no Save/scope/toggle)', !drawer.hasSave && !drawer.hasScopeInput && !drawer.hasToggle, drawer);
    check('the drawer links to the Git page ("Manage on the Git page")', drawer.hasManage, drawer);
  });

  check('no uncaught page errors', perr.length === 0, perr.slice(0, 3).join(' | '));
} finally {
  try { if (browser) await browser.close(); } catch { /* ignore */ }
  try { if (server && server.exitCode === null) process.kill(server.pid, 'SIGTERM'); } catch { /* ignore */ }
  await sleep(400);
  for (const d of [DATA, REPO]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
}
console.log(`\nFEAT-190 UI: ${pass} passed, ${fail} failed${SHOTS ? ` (shots in ${OUTDIR})` : ''}`);
process.exit(fail ? 1 : 0);
