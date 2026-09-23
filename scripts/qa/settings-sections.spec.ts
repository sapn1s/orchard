/**
 * FEAT-034 — settings drawer: grouped sections + conditional disclosure.
 *
 * Original (FEAT-034) shape: the settings view was four named
 * `<details class="sect">` sections, "Advanced" collapsed by default, and the
 * "Access" card (mounts + docker socket) rendered UNCONDITIONALLY, even though
 * both settings are rejected server-side unless isolation === 'container'.
 *
 * FEAT-146 replaced the whole drawer with a modal (`.smodal`) whose CONTENT is
 * the navigation: an 11-item rail in two groups ("This project" / "This
 * machine") stands in for the old four sections — see
 * `docs/bugs/FEAT-146-settings-is-two-navigation-axes-fighting-each-other.md`.
 * Only two `<details class="sect">` survive at all (`advanced`, `patterns`),
 * because those two lists are genuinely long; everything else that used to be
 * a collapsible section is now a rail category, always fully shown once
 * selected. This spec is the regression guard for the SAME two invariants,
 * translated onto the new shape:
 *
 *   (a) grouping — the rail carries all 11 categories, in order, split into
 *       "This project" (7) and "This machine" (4); the one category that kept
 *       a real `<details>` (Advanced ▸ Agent memories) is still collapsed by
 *       default and still expands/collapses on click;
 *   (b) conditional disclosure — the "Access" card (mounts, docker socket) is
 *       ABSENT from the DOM under the Isolation & environment category when
 *       isolation = direct, and appears the moment isolation flips to
 *       container, gone again the moment it flips back.
 *
 * It also proves persistence survived the redesign in both scopes: a
 * project-default edit survives a reload, and a this-session override
 * survives switching the scope lens away and back (the in-memory
 * `ctx.overrides` path).
 *
 * MUST FAIL on the pre-FEAT-146 code: `#sRail` does not exist there (the old
 * markup has `#dScope` tabs and `<details class="sect">` sections only), so
 * every rail-based locator in this spec would find nothing.
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
  // FEAT-146: the rail is the shape under test now — wait for all 11 items
  // rather than an arbitrary sleep.
  await expect(page.locator('#sRail .srail-item')).toHaveCount(11);
}

test('settings modal: 11-category rail (2 groups) + container-only settings gated on isolation', async ({ page }) => {
  // ---- register a scratch project, then FORCE isolation to direct: the
  //      server's own NEW_PROJECT_DEFAULT_ISOLATION is 'container'
  //      (registry.ts), so relying on the registration default to be
  //      'direct' is a race against a value this spec does not own. Setting
  //      it explicitly makes the direct-vs-container transition below a
  //      controlled fixture rather than an assumption. ----
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: WORK, name: 'qa-settings-sections' }),
  })).json() as { project?: { id: string; isolation?: string } };
  const projectId = reg.project?.id;
  expect(projectId, `project registration failed: ${JSON.stringify(reg)}`).toBeTruthy();
  const toDirect = await fetch(`${BASE}/api/projects/${projectId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ isolation: 'direct' }),
  });
  expect(toDirect.ok, `force isolation=direct: ${await toDirect.text()}`).toBe(true);

  await bootToProject(page, projectId!);
  await openSettings(page);

  // ---- (a) grouping: 11 categories, in order, "This project" then "This
  //      machine" (the boundary is index 7 — this IS the grouping test, since
  //      the rail renders the two groups as one ordered list of buttons) ----
  const catLabels = await page.locator('#sRail .srail-item .n').allTextContents();
  expect(catLabels).toEqual([
    'Model & spend', 'Permissions & tools', 'Instructions', 'Isolation & environment',
    'Snapshots', 'Workspace', 'Advanced',
    'Accounts', 'Appearance', 'New-project defaults', 'Templates',
  ]);
  const groupHeadings = await page.locator('#sRail h3').allTextContents();
  expect(groupHeadings).toEqual(['This project', 'This machine']);

  // ---- (a) the one surviving <details class="sect">: Advanced ▸ Agent
  //      memories, collapsed by default, expands/collapses on click ----
  await page.locator('#sRail-advanced').click();
  const advDetails = page.locator('#vSettings details[data-sect="advanced"]');
  await expect(advDetails).toHaveJSProperty('open', false);
  await expect(advDetails.locator('.grp-l', { hasText: 'Agent memories' })).toHaveCount(1);
  await expect(advDetails.locator('.grp-l', { hasText: 'Agent memories' })).toBeHidden();
  await advDetails.locator('.sect-l').click();
  await expect(advDetails).toHaveJSProperty('open', true);
  await expect(advDetails.locator('.grp-l', { hasText: 'Agent memories' })).toBeVisible();
  await advDetails.locator('.sect-l').click();
  await expect(advDetails).toHaveJSProperty('open', false);

  // ---- (b) conditional disclosure: Access (mounts, docker socket) is ABSENT
  //          under Isolation & environment in direct isolation, not merely
  //          disabled or hidden-by-CSS ----
  await page.locator('#sRail-isolation').click();
  await expect(page.locator('#vSettings .grp-l', { hasText: 'Access' })).toHaveCount(0);
  await expect(page.locator('#vSettings').getByRole('button', { name: '+ Add mount' })).toHaveCount(0);
  await expect(page.locator('#vSettings').getByLabel('Toggle docker socket access')).toHaveCount(0);

  // ---- switch isolation to Container, Access appears ----
  const isoSeg = page.locator('#vSettings .grp[data-focus="iso"] .seg');
  await isoSeg.getByRole('button', { name: 'Container' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__station.state.current.projectId)).toBe(projectId);
  await expect(page.locator('#vSettings .grp-l', { hasText: 'Access' })).toHaveCount(1);
  await expect(page.locator('#vSettings').getByRole('button', { name: '+ Add mount' })).toBeVisible();
  await expect(page.locator('#vSettings').getByLabel('Toggle docker socket access')).toBeVisible();

  // ---- switch back to Direct, Access disappears again ----
  await isoSeg.getByRole('button', { name: 'Direct' }).click();
  await expect(page.locator('#vSettings .grp-l', { hasText: 'Access' })).toHaveCount(0);

  // ---- persistence, project-default scope: change Model, survive a reload ----
  await page.locator('#sRail-model').click();
  const modelGrp = page.locator('#vSettings .grp[data-focus="projectModel"]');
  const modelRow = modelGrp.locator('.set').first();
  const before = await modelRow.locator('.v').textContent();
  await modelRow.click();
  await expect.poll(async () => modelRow.locator('.v').textContent()).not.toBe(before);
  const afterFirstClick = await modelRow.locator('.v').textContent();

  await page.reload();
  await page.waitForFunction(() => (window as any).__station !== undefined);
  await bootToProject(page, projectId!);
  await openSettings(page);
  await page.locator('#sRail-model').click();
  const modelGrp2 = page.locator('#vSettings .grp[data-focus="projectModel"]');
  const modelRow2 = modelGrp2.locator('.set').first();
  await expect(modelRow2.locator('.v')).toHaveText(afterFirstClick ?? '');

  // ---- persistence, this-session scope: an override survives a scope
  //      round-trip without a reload (the in-memory ctx.overrides path) ----
  // FEAT-146 phase 2b (landed mid-fix, while this spec was being repaired —
  // see this ticket's Activity log): `.ovr` ("overridden") text is retired,
  // replaced by a provenance CHIP — `.prov[data-level="session"]`, filled
  // when the current write target itself holds the override. Same
  // invariant (a session override is visibly marked and survives the scope
  // round-trip), new marker.
  await page.locator('#dScope button[data-scope="session"]').click();
  const effortRow = modelGrp2.locator('.set').nth(1); // Effort
  await effortRow.click();
  const effortChip = effortRow.locator('.prov[data-level="session"]');
  await expect(effortChip).toHaveAttribute('data-fill', 'true');
  await page.locator('#dScope button[data-scope="project"]').click();
  await page.locator('#dScope button[data-scope="session"]').click();
  await expect(effortChip).toHaveAttribute('data-fill', 'true');

  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-034-after.png') }).catch(() => {});
});
