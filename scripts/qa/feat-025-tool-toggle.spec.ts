/**
 * FEAT-025 — per-project attachable dev-tool toggle (Serena / Playwright).
 *
 * The USER-OBSERVABLE half of the ticket: the Integrations group in the
 * "Instructions & tools" settings section now carries a Serena and a Playwright
 * toggle. This spec proves:
 *   (a) both render, with the correct DEFAULTS — Serena ON (repo default,
 *       FEAT-025), Playwright OFF (opt-in UI-testing tool);
 *   (b) toggling each flips its pressed state, and the choice PERSISTS across a
 *       full page reload (it lives in the registry, not the DOM);
 *   (c) the persisted choice is what the SERVER stored under settings.tools —
 *       the exact per-project value a launched session's `plannedMcpServers`
 *       (src/server/tools.ts) reads to decide the attach. The compose-layer
 *       on/off proof (session gets it / does not) is verify-tool-toggle.mjs.
 *
 * MUST FAIL on the pre-FEAT-025 code: the Integrations group had only the
 * Browser row — no Serena/Playwright toggles exist, so getByLabel finds nothing.
 *
 *   npx playwright test scripts/qa/feat-025-tool-toggle.spec.ts
 *
 * Brave is reused via playwright.config.ts. Never touches :4317; spawns its own
 * server on an OS-assigned free port and kills it by PID.
 */
import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

declare const window: any;
declare const document: any;

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
  DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-qa-f2025-data-'));
  WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-qa-f2025-work-'));
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
  await expect(page.locator('#vSettings .sect-l')).toHaveCount(4);
}

const serenaSw = (page: Page) => page.locator('#vSettings').getByLabel('Toggle Serena (LSP)');
const playwrightSw = (page: Page) => page.locator('#vSettings').getByLabel('Toggle Playwright');

async function storedTools(projectId: string): Promise<{ serena?: boolean; playwright?: boolean }> {
  const list = await (await fetch(`${BASE}/api/projects`)).json() as { projects: any[] };
  return list.projects.find((p) => p.id === projectId)?.settings?.tools ?? {};
}

test('settings drawer: Serena/Playwright toggles render, default correctly, and persist', async ({ page }) => {
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: WORK, name: 'qa-tool-toggle' }),
  })).json() as { project?: { id: string } };
  const projectId = reg.project?.id;
  expect(projectId, `project registration failed: ${JSON.stringify(reg)}`).toBeTruthy();

  await bootToProject(page, projectId!);
  await openSettings(page);

  // ---- (a) both toggles render with the right defaults ----
  await expect(serenaSw(page)).toHaveCount(1);
  await expect(playwrightSw(page)).toHaveCount(1);
  await expect(serenaSw(page)).toHaveAttribute('aria-pressed', 'true');   // Serena default ON
  await expect(playwrightSw(page)).toHaveAttribute('aria-pressed', 'false'); // Playwright default OFF

  // screenshot the default state (Serena on, Playwright off) for the ticket,
  // with the toggles in view. Scroll inside a single evaluate so a drawer
  // repaint can't detach the node between query and scroll.
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#vSettings button.sw')];
    rows[rows.length - 1]?.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-025-after.png') });

  // ---- (b) toggle Serena OFF and Playwright ON ----
  await serenaSw(page).click();
  await expect(serenaSw(page)).toHaveAttribute('aria-pressed', 'false');
  await playwrightSw(page).click();
  await expect(playwrightSw(page)).toHaveAttribute('aria-pressed', 'true');

  // ---- (c) the server stored exactly that under settings.tools ----
  await expect.poll(() => storedTools(projectId!)).toMatchObject({ serena: false, playwright: true });

  // ---- (b) persistence across a full reload ----
  await page.reload();
  await page.waitForFunction(() => (window as any).__station !== undefined);
  await bootToProject(page, projectId!);
  await openSettings(page);
  await expect(serenaSw(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(playwrightSw(page)).toHaveAttribute('aria-pressed', 'true');
});
