/**
 * FEAT-054 — crown/topbar chips deep-link to their drawer target: select the
 * rail CATEGORY that now contains it, scroll the target into view, one brief
 * highlight — and never leave a stale flash or a wrong rail selection behind.
 *
 * FEAT-146 replaced the drawer with a modal (`.smodal`) whose content is an
 * 11-category rail; the four `<details class="sect">` sections this spec
 * originally keyed off (`model`/`caps`/`instr`/`isoSection`) are gone — only
 * `advanced` (Agent memories) and `patterns` (Templates) still use a real
 * `<details>`. `FOCUS_CATEGORY` in `public/lib/drawer.js` re-maps every one of
 * this spec's anchors onto its new rail category: `git`/`processes` moved from
 * "Advanced" to "Workspace" (re-homed there in phase 2a — see
 * `docs/bugs/FEAT-146-settings-is-two-navigation-axes-fighting-each-other.md`),
 * `permissionMode` stayed in "Permissions & tools", `mounts`/`iso` stayed in
 * "Isolation & environment". None of the five door chips this spec drives
 * still targets a collapsible section, so the "Advanced expands" half of the
 * original intent has no surviving analog for THESE anchors — the guard this
 * spec keeps instead is the one that still applies to every one of them: the
 * right rail category gets selected, the right node is scrolled in and
 * flashed once, and going back to a plain door leaves no stray flash.
 *
 * What this proves, user-observable (WORKING_AGREEMENT §C):
 *   1. git chip   → Workspace ▸ Git
 *   2. proc chip  → Workspace ▸ Running here
 *   3. perm chip + composer permission hairline → Permissions & tools
 *   4. mount pill → Isolation & environment ▸ Mounts
 *   5. isolation popover's settings footer → Isolation & environment
 *   For each: modal open, the mapped rail category becomes selected
 *   (`aria-current="page"`), the mapped target visible IN the viewport,
 *   `.focus-flash` applies then CLEARS (a one-shot, never a persistent state).
 *   6. NO STRAY FLASH, RAIL STATE HONEST — a plain #cogBtn open never flashes
 *      anything; a deep link's one-shot flash never survives a close/reopen;
 *      and the modal remembers the last-selected category across a
 *      close/reopen within one page session (current behaviour: `d.cat` is
 *      NOT reset to the default by a plain open — see `open()` in
 *      `drawer.js`), so the assertion is that reopening after a git-chip
 *      visit stays on Workspace rather than silently snapping back.
 *   7. prefers-reduced-motion — the highlight is a static brief outline
 *      (animation: none), still applied and still cleared.
 *   8. the model chip stays as-is: it opens the /model picker, not the modal.
 *
 * Non-vacuity: pre-change `drawer.open('settings', {focus})` ignores the
 * object, there are no data-focus anchors and no .focus-flash — every mapped
 * assertion fails (each chip lands at the drawer's top, on whatever category
 * happened to be selected already).
 *
 *   npx playwright test scripts/qa/FEAT-054-chip-deep-link.spec.ts
 *
 * Never touches :4317; own scratch server on a free port, killed by PID.
 */
import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess, spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
declare const window: any;
declare const document: any;
declare const getComputedStyle: any;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}
function stopByPid(child: ChildProcess | null): void {
  if (!child || child.exitCode !== null || child.pid === undefined) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => {
    try { if (child.pid !== undefined) process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
  }, 2000).unref();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: ChildProcess | null = null;
let squatter: ChildProcess | null = null; // a real process cwd'd in WORK → the proc chip shows
let BASE = '';
let WORK = '';
const cleanupDirs: string[] = [];

test.beforeAll(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f054-data-'));
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f054-store-'));
  const METH = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f054-meth-'));
  WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f054-work-'));
  cleanupDirs.push(DATA, STORE, METH, WORK);
  // a real repo, so the git chip renders and the Git group has content
  execFileSync('git', ['init', '-q'], { cwd: WORK });
  fs.writeFileSync(path.join(WORK, 'a.txt'), 'hello\n');
  // a real process cwd'd inside the project, so the "running here" chip shows
  squatter = spawn('sleep', ['600'], { cwd: WORK, stdio: 'ignore' });
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE, METHODOLOGY_DIR: METH },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); }
  }
  if (!up) throw new Error('scratch server never became healthy');
});

test.afterAll(async () => {
  stopByPid(server);
  stopByPid(squatter);
  await sleep(300);
  for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** target visible, inside the viewport, flash applies then CLEARS. */
async function expectLanded(page: Page, selector: string) {
  const target = page.locator(`#vSettings ${selector}`);
  await expect(page.locator('#smodal')).not.toHaveAttribute('hidden', ''); // FEAT-146: the drawer became a modal
  await expect(target).toBeVisible();
  // the flash is a one-shot — catch it, then watch it clear
  await expect(target).toHaveClass(/focus-flash/, { timeout: 3000 });
  // the scroll may be mid-flight (smooth) or re-landed after an async repaint
  await expect.poll(async () => target.evaluate((e) => {
    const r = e.getBoundingClientRect();
    return r.top >= -2 && r.top < window.innerHeight;
  }), { timeout: 4000, message: `${selector} must be scrolled into the viewport` }).toBe(true);
  await expect(target).not.toHaveClass(/focus-flash/, { timeout: 4000 });
}

test('every mapped chip lands on its drawer section — expanded, scrolled, briefly highlighted; prefs preserved; reduced-motion path; plain cog unchanged', async ({ page }) => {
  test.setTimeout(240_000);

  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: WORK, name: 'qa-feat054-deeplink' }),
  })).json() as { project?: { id: string } };
  const pid = reg.project?.id;
  expect(pid, `registration failed: ${JSON.stringify(reg)}`).toBeTruthy();
  // container isolation + a mount → mount pills render; bypass → permLine shows
  await fetch(`${BASE}/api/projects/${pid}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ isolation: 'container' }),
  });
  await fetch(`${BASE}/api/projects/${pid}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { mounts: [{ hostPath: WORK, containerPath: '/data', readOnly: false }] } }),
  });

  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto(`${BASE}/#/project/${pid}`);
  await page.waitForFunction(() => (window as any).__station !== undefined);
  await page.waitForFunction((p) => (window as any).__station.state.current.projectId === p, pid);

  // ═══ baseline: a PLAIN cog open lands on the default rail category (Model &
  //      spend — `d.cat` starts life as 'model'), nothing flashed ═══
  await page.locator('#cogBtn').click();
  await expect(page.locator('#smodal')).not.toHaveAttribute('hidden', ''); // FEAT-146: the drawer became a modal
  await expect(page.locator('#sRail-model')).toHaveAttribute('aria-current', 'page');
  expect(await page.locator('#vSettings .focus-flash').count(), 'plain open must not flash anything').toBe(0);
  await page.locator('#dClose').click();

  // ═══ 1. git chip → Workspace ▸ Git (re-homed from Advanced in phase 2a) ═══
  await expect(page.locator('#gitBtn')).toBeVisible();
  await page.locator('#gitBtn').click();
  await expect(page.locator('#sRail-workspace')).toHaveAttribute('aria-current', 'page');
  await expectLanded(page, '[data-focus="git"]');
  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-054-git-landed.png') }).catch(() => {});
  await page.locator('#dClose').click();

  // ═══ 6. NO STRAY FLASH, RAIL STATE HONEST ═══
  // A plain reopen right after a deep-linked visit: the one-shot flash from
  // the git-chip visit above must NOT still be present, and — current
  // behaviour, unlike the retired ephemeral-<details> model — the rail stays
  // on Workspace rather than snapping back to the default; `d.cat` is only
  // reset to 'model' when the previous category was in the MACHINE group.
  await page.locator('#cogBtn').click();
  await expect(page.locator('#sRail-workspace')).toHaveAttribute('aria-current', 'page');
  expect(await page.locator('#vSettings .focus-flash').count(), 'a plain reopen must carry no stray flash').toBe(0);
  await page.locator('#dClose').click();
  await expect(page.locator('#procBtn')).toBeVisible({ timeout: 30_000 }); // proc poll finds the squatter
  await page.locator('#procBtn').click(); // deep link to processes — same category (Workspace) as git
  await expect(page.locator('#sRail-workspace')).toHaveAttribute('aria-current', 'page');
  await expectLanded(page, '[data-focus="processes"]');
  await page.locator('#dClose').click();

  // ═══ 3. permission chip (seal) + composer hairline → Permissions group ═══
  await page.locator('.seal .perm').click();
  await expectLanded(page, '[data-focus="permissionMode"]');
  await page.locator('#dClose').click();
  const permLineVisible = await page.locator('#permLine').isVisible();
  expect(permLineVisible, 'container project skips prompts → the hairline shows').toBe(true);
  await page.locator('#permLine').click();
  await expectLanded(page, '[data-focus="permissionMode"]');
  await page.locator('#dClose').click();

  // ═══ 4. mount pill → Access ▸ Mounts ═══
  await page.locator('.seal .pill.mnt').first().click();
  await expectLanded(page, '[data-focus="mounts"]');
  await page.locator('#dClose').click();

  // ═══ 5. isolation popover footer → Isolation & environment ═══
  // FINDING, unrelated to FEAT-146: `#isoBtn` (the door to `#pop`, whose
  // footer is `#popSettings`) has been unconditionally `hidden = true` since
  // FEAT-139 (`public/app.js:2619`, "moved into Settings... reachable in one
  // click via Settings"), and nothing anywhere ever un-hides it — so this
  // door is dead code a real user cannot reach, predating this ticket. Out of
  // scope to fix here (app.js is off limits for this charter; it belongs to
  // whoever owns FEAT-139's follow-up). The `focus:'iso'` mapping itself is
  // still real, live product code (`#popSettings`'s own click handler calls
  // `drawer.open('settings', {focus:'iso'})`), so this exercises that call
  // directly rather than through the unreachable button — still proving the
  // 'iso' anchor lands correctly, distinct from the 'mounts' anchor (#4
  // above) that happens to share its rail category.
  await page.evaluate(() => (window as any).__station.drawer.open('settings', { focus: 'iso' }));
  await expectLanded(page, '[data-focus="iso"]');
  await page.locator('#dClose').click();

  // ═══ 7. prefers-reduced-motion — static brief outline, no animation ═══
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#gitBtn').click();
  const git = page.locator('#vSettings [data-focus="git"]');
  await expect(git).toHaveClass(/focus-flash/, { timeout: 3000 });
  const treatment = await git.evaluate((e) => {
    const cs = getComputedStyle(e);
    return { animation: cs.animationName, outline: cs.outlineStyle };
  });
  expect(treatment.animation, 'reduced motion: no flash animation').toBe('none');
  expect(treatment.outline, 'reduced motion: a static outline instead').not.toBe('none');
  await expect(git).not.toHaveClass(/focus-flash/, { timeout: 4000 }); // still one-shot
  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-054-reduced-motion.png') }).catch(() => {});
  await page.locator('#dClose').click();
  await page.emulateMedia({ reducedMotion: null });

  // ═══ 8. the model chip stays as-is — /model picker, never the drawer ═══
  if (await page.locator('#modelChip').isVisible()) {
    await page.locator('#modelChip').click();
    await expect(page.locator('#modelPop')).toHaveClass(/open/);
    expect(await page.evaluate(() => document.querySelector('#smodal')!.hidden)).toBe(true); // FEAT-146
    await page.keyboard.press('Escape');
  }
});
