/**
 * FEAT-054 — crown/topbar chips deep-link to their drawer section: expand it
 * (Advanced included), scroll it into view, one brief highlight — and never
 * rewrite the user's collapse preferences.
 *
 * What this proves, user-observable (WORKING_AGREEMENT §C):
 *   1. git chip   → Advanced ▸ Git         (collapsed-by-default Advanced EXPANDS)
 *   2. proc chip  → Advanced ▸ Running here
 *   3. perm chip + composer permission hairline → Model & behaviour ▸ Permissions
 *   4. mount pill → Access ▸ Mounts
 *   5. isolation popover's settings footer → Isolation & environment
 *   For each: drawer open, mapped target visible IN the viewport, `.focus-flash`
 *   applies then CLEARS (a one-shot, never a persistent selected state).
 *   6. COLLAPSE PREFS PRESERVED — after a deep link expanded Advanced, a plain
 *      #cogBtn open lands at the default position with Advanced collapsed
 *      again, and no flash anywhere (no regression to the plain open).
 *   7. prefers-reduced-motion — the highlight is a static brief outline
 *      (animation: none), still applied and still cleared.
 *   8. the model chip stays as-is: it opens the /model picker, not the drawer.
 *
 * Non-vacuity: pre-change `drawer.open('settings', {focus})` ignores the
 * object, there are no data-focus/data-sect anchors and no .focus-flash —
 * every mapped assertion fails (each chip lands at the drawer's top).
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
  await expect(page.locator('#drawer')).toHaveClass(/open/);
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

  // ═══ baseline: a PLAIN cog open lands at the default — Advanced collapsed ═══
  await page.locator('#cogBtn').click();
  await expect(page.locator('#drawer')).toHaveClass(/open/);
  await expect(page.locator('#vSettings details[data-sect="advanced"]')).not.toHaveAttribute('open', '');
  expect(await page.locator('#vSettings .focus-flash').count(), 'plain open must not flash anything').toBe(0);
  await page.locator('#dClose').click();

  // ═══ 1. git chip → Advanced ▸ Git (Advanced expands for the visit) ═══
  await expect(page.locator('#gitBtn')).toBeVisible();
  await page.locator('#gitBtn').click();
  await expect(page.locator('#vSettings details[data-sect="advanced"]')).toHaveAttribute('open', '');
  await expectLanded(page, '[data-focus="git"]');
  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-054-git-landed.png') }).catch(() => {});
  await page.locator('#dClose').click();

  // ═══ 6. PREFS PRESERVED — the deep-link expansion was ephemeral ═══
  await page.locator('#cogBtn').click();
  await expect(page.locator('#vSettings details[data-sect="advanced"]')).not.toHaveAttribute('open', '');
  // …and a section the USER closed stays closed across a deep link elsewhere
  await page.locator('#vSettings details[data-sect="instr"] summary').click();
  await expect(page.locator('#vSettings details[data-sect="instr"]')).not.toHaveAttribute('open', '');
  await page.locator('#dClose').click();
  await expect(page.locator('#procBtn')).toBeVisible({ timeout: 30_000 }); // proc poll finds the squatter
  await page.locator('#procBtn').click(); // deep link to processes
  await expect(page.locator('#vSettings details[data-sect="advanced"]')).toHaveAttribute('open', '');
  await expectLanded(page, '[data-focus="processes"]');
  await expect(page.locator('#vSettings details[data-sect="instr"]'),
    'the user-closed section must stay closed').not.toHaveAttribute('open', '');
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
  await page.locator('#isoBtn').click();
  await expect(page.locator('#pop')).toHaveClass(/open/);
  await page.locator('#popSettings').click();
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
    expect(await page.evaluate(() => document.querySelector('#drawer')!.classList.contains('open'))).toBe(false);
    await page.keyboard.press('Escape');
  }
});
