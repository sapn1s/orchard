/**
 * FEAT-034 — settings drawer: grouped sections + conditional disclosure.
 *
 * Before this ticket, `public/lib/drawer.js`'s settingsView() was one flat
 * run of `.grp` cards (Runtime, Snapshots, Memories, Git, Processes, Access,
 * Integrations, Model, Permissions, Instructions) appended straight to the
 * body — and the "Access" card (mounts + docker-socket) rendered
 * UNCONDITIONALLY, even though both settings are rejected server-side unless
 * isolation === 'container' (see `PROJECT_ONLY` / validate.ts's mount
 * rejection). A direct-isolation project showed two dead controls with
 * nothing behind them.
 *
 * This spec is the PERMANENT regression guard for both halves of the fix:
 *   (a) grouping — the settings view is now four named <details class="sect">
 *       sections (Model & behaviour / Isolation & environment / Instructions
 *       & tools / Advanced), each collapsible, "Advanced" collapsed by
 *       default;
 *   (b) conditional disclosure — the "Access" card (mounts, docker socket)
 *       is ABSENT from the DOM when isolation = direct, and appears the
 *       moment isolation flips to container, gone again the moment it flips
 *       back.
 * It also proves persistence survived the refactor in both scopes: a
 * project-default edit survives a reload, and a this-session override
 * survives switching the scope toggle away and back (the in-memory
 * `ctx.overrides` path).
 *
 * MUST FAIL on the pre-FEAT-034 code: the old flat view has no `.sect`
 * elements at all, and always renders the Access group regardless of
 * isolation.
 *
 * Assertions are on the USER-OBSERVABLE surface (role/name, DOM structure,
 * visibility), per WORKING_AGREEMENT §C — never on server/registry internals.
 *
 *   npx playwright test scripts/qa/settings-sections.spec.ts
 *
 * Brave is reused via playwright.config.ts's launchOptions.executablePath —
 * no chromium download. Never touches :4317 (the live systemd service);
 * spawns its own server on an OS-assigned free port and kills it by PID.
 */
import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

declare const window: any;

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
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => {
    try { if (child.pid !== undefined) process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }, 2000).unref();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: ChildProcess | null = null;
let BASE = '';
let DATA = '';
let WORK = '';
const cleanupDirs: string[] = [];

test.beforeAll(async () => {
  const port = await freePort(); // never 4317, the live systemd service
  BASE = `http://127.0.0.1:${port}`;
  DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-qa-data-'));
  WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-qa-work-'));
  cleanupDirs.push(DATA, WORK);

  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), CLAUDE_STATION_DATA: DATA },
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
  await sleep(300);
  for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
});

async function bootToProject(page: Page, projectId: string): Promise<void> {
  await page.goto(`${BASE}/#/project/${projectId}`);
  await page.waitForFunction(() => (window as any).__station !== undefined);
  await page.waitForFunction(
    (pid) => (window as any).__station.state.current.projectId === pid,
    projectId,
  );
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Project settings' }).click();
  // The four themed sections are the shape under test — wait for all of them
  // rather than an arbitrary sleep.
  await expect(page.locator('#vSettings .sect-l')).toHaveCount(4);
}

test('settings drawer: grouped sections + container-only settings gated on isolation', async ({ page }) => {
  // ---- register a scratch project, isolation left at its default (direct) ----
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: WORK, name: 'qa-settings-sections' }),
  })).json() as { project?: { id: string; isolation?: string } };
  const projectId = reg.project?.id;
  expect(projectId, `project registration failed: ${JSON.stringify(reg)}`).toBeTruthy();
  expect(reg.project?.isolation ?? 'direct', 'fixture must start in direct isolation').toBe('direct');

  await bootToProject(page, projectId!);
  await openSettings(page);

  // ---- (a) grouping: four named sections, in order, "Advanced" collapsed ----
  const sectionLabels = await page.locator('#vSettings .sect-l').allTextContents();
  expect(sectionLabels).toEqual([
    'Model & behaviour',
    'Isolation & environment',
    'Instructions & tools',
    'Advanced',
  ]);
  const modelSect = page.locator('#vSettings .sect').filter({ has: page.locator('.sect-l', { hasText: 'Model & behaviour' }) });
  const isoSect = page.locator('#vSettings .sect').filter({ has: page.locator('.sect-l', { hasText: 'Isolation & environment' }) });
  const advSect = page.locator('#vSettings .sect').filter({ has: page.locator('.sect-l', { hasText: 'Advanced' }) });
  await expect(modelSect).toHaveJSProperty('open', true);
  await expect(isoSect).toHaveJSProperty('open', true);
  await expect(advSect).toHaveJSProperty('open', false);
  // Content of a closed <details> is present but not visible.
  await expect(advSect.locator('.grp-l', { hasText: 'Running here' })).toHaveCount(1);
  await expect(advSect.locator('.grp-l', { hasText: 'Running here' })).toBeHidden();

  // ---- (a) collapse/expand: click the Advanced summary, content shows ----
  await advSect.locator('.sect-l').click();
  await expect(advSect).toHaveJSProperty('open', true);
  await expect(advSect.locator('.grp-l', { hasText: 'Running here' })).toBeVisible();
  await advSect.locator('.sect-l').click();
  await expect(advSect).toHaveJSProperty('open', false);

  // ---- (b) conditional disclosure: Access (mounts, docker socket) is ABSENT
  //          in direct isolation, not merely disabled or hidden-by-CSS ----
  await expect(page.locator('#vSettings .grp-l', { hasText: 'Access' })).toHaveCount(0);
  await expect(page.locator('#vSettings').getByRole('button', { name: '+ Add mount' })).toHaveCount(0);
  await expect(page.locator('#vSettings').getByLabel('Toggle docker socket access')).toHaveCount(0);

  // ---- switch isolation to Container, Access appears ----
  await isoSect.getByRole('button', { name: 'Container' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__station.state.current.projectId)).toBe(projectId);
  await expect(page.locator('#vSettings .grp-l', { hasText: 'Access' })).toHaveCount(1);
  await expect(page.locator('#vSettings').getByRole('button', { name: '+ Add mount' })).toBeVisible();
  await expect(page.locator('#vSettings').getByLabel('Toggle docker socket access')).toBeVisible();

  // ---- switch back to Direct, Access disappears again ----
  await isoSect.getByRole('button', { name: 'Direct' }).click();
  await expect(page.locator('#vSettings .grp-l', { hasText: 'Access' })).toHaveCount(0);

  // ---- persistence, project-default scope: change Model, survive a reload ----
  const modelRow = modelSect.locator('.grp').first().locator('.set').first();
  const before = await modelRow.locator('.v').textContent();
  await modelRow.click();
  await expect.poll(async () => modelRow.locator('.v').textContent()).not.toBe(before);
  const afterFirstClick = await modelRow.locator('.v').textContent();

  await page.reload();
  await page.waitForFunction(() => (window as any).__station !== undefined);
  await bootToProject(page, projectId!);
  await openSettings(page);
  const modelSect2 = page.locator('#vSettings .sect').filter({ has: page.locator('.sect-l', { hasText: 'Model & behaviour' }) });
  const modelRow2 = modelSect2.locator('.grp').first().locator('.set').first();
  await expect(modelRow2.locator('.v')).toHaveText(afterFirstClick ?? '');

  // ---- persistence, this-session scope: an override survives a scope
  //      round-trip without a reload (the in-memory ctx.overrides path) ----
  await page.locator('#dScope button[data-scope="session"]').click();
  const effortRow = modelSect2.locator('.grp').first().locator('.set').nth(1); // Effort
  await effortRow.click();
  await expect(effortRow.locator('.ovr')).toHaveText('overridden');
  await page.locator('#dScope button[data-scope="project"]').click();
  await page.locator('#dScope button[data-scope="session"]').click();
  await expect(effortRow.locator('.ovr')).toHaveText('overridden');

  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-034-after.png') }).catch(() => {});
});
