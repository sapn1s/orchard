/**
 * BUG-135 — a tool enabled MID-SESSION must not silently vanish from the UI.
 *
 * Real artifact: the reported session's OWN tool surface, lifted verbatim from
 * its transcript — 21 `mcp__serena__…` names, zero playwright — while the
 * project carries `tools: {serena: true, playwright: true}` (the real registry
 * values). That is the exact discrepancy the user hit: Playwright enabled 33
 * minutes after the session launched, so the launch-time mcpServers map never
 * had it, and both the crown strip and the drawer said nothing at all.
 *
 * Drives the REAL click-path against a scratch server on a free port.
 * Never touches :4317; server killed by PID.
 */
import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SHOTS = path.join(ROOT, 'docs', 'bugs', 'assets');
declare const window: any;
declare const document: any;

/**
 * The reported session's real attach report, extracted verbatim from its
 * transcript and inlined so the suite is self-contained (the transcript itself
 * is private and outside the repo). 21 serena tools, zero playwright — the
 * CLI's own account of what that session actually got.
 */
const REAL_LIVE_TOOLS: string[] = [
  'mcp__serena__delete_memory', 'mcp__serena__edit_memory', 'mcp__serena__find_declaration',
  'mcp__serena__find_implementations', 'mcp__serena__find_referencing_symbols', 'mcp__serena__find_symbol',
  'mcp__serena__get_diagnostics_for_file', 'mcp__serena__get_symbols_overview', 'mcp__serena__initial_instructions',
  'mcp__serena__insert_after_symbol', 'mcp__serena__insert_before_symbol', 'mcp__serena__list_memories',
  'mcp__serena__onboarding', 'mcp__serena__read_memory', 'mcp__serena__rename_memory',
  'mcp__serena__rename_symbol', 'mcp__serena__replace_content', 'mcp__serena__replace_in_files',
  'mcp__serena__replace_symbol_body', 'mcp__serena__safe_delete_symbol', 'mcp__serena__write_memory',
];

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
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: ChildProcess | null = null;
let BASE = '';
let WORK = '';
const cleanupDirs: string[] = [];

test.beforeAll(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b133-data-'));
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b133-store-'));
  const METH = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b133-meth-'));
  WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b133-work-'));
  cleanupDirs.push(DATA, STORE, METH, WORK);
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE, METHODOLOGY_DIR: METH },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
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

const chip = (page: Page, name: string) => page.locator(`#integStrip .ichip[data-integ="${name}"]`);

test('enabled-but-not-attached is visible as pending, and the drawer says why', async ({ page }) => {
  test.setTimeout(120_000);

  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: WORK, name: 'qa-bug133' }),
  })).json() as { project?: { id: string } };
  const pid = reg.project?.id;
  expect(pid, `registration failed: ${JSON.stringify(reg)}`).toBeTruthy();
  // The REAL registry values for the reported project.
  await fetch(`${BASE}/api/projects/${pid}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { tools: { serena: true, playwright: true } } }),
  });

  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto(`${BASE}/#/project/${pid}`);
  await page.waitForFunction(() => (window as any).__station !== undefined);
  await page.waitForFunction((p) => (window as any).__station.state.current.projectId === p, pid);

  // Sanity: with no live report both read as planned (pre-existing behaviour).
  await expect(chip(page, 'serena')).toHaveAttribute('data-live', 'false');
  await expect(chip(page, 'playwright')).toHaveAttribute('data-live', 'false');

  // Now the session reports its REAL tool surface: serena attached, playwright not.
  await page.evaluate((tools) => {
    (window as any).__station.state.liveTools = tools;
    (window as any).__station.paintIntegrations?.();
  }, REAL_LIVE_TOOLS);
  await page.waitForFunction(() => {
    const c = document.querySelector('#integStrip .ichip[data-integ="serena"]');
    return c && c.dataset.live === 'true';
  }, undefined, { timeout: 10_000 });

  // 1. Serena renders LIVE (the CLI really reported it).
  await expect(chip(page, 'serena')).toHaveAttribute('data-live', 'true');
  // 2. THE BUG: playwright must still be on the strip, marked pending — not gone.
  await expect(chip(page, 'playwright')).toHaveCount(1);
  await expect(chip(page, 'playwright')).toHaveAttribute('data-pending', 'true');
  await expect(chip(page, 'playwright')).toHaveAttribute('data-live', 'false');
  await expect(chip(page, 'playwright')).toHaveAttribute('title', /NOT in the running session/);
  // 3. It must be visually distinct from both live and planned.
  await expect(chip(page, 'playwright')).toHaveClass(/pending/);
  await page.screenshot({ path: path.join(SHOTS, 'BUG-135-strip-pending.png') }).catch(() => {});

  // 4. The drawer, where the user actually flips the switch, names it.
  await chip(page, 'playwright').click();
  await expect(page.locator('#drawer')).toHaveClass(/open/);
  const note = page.locator('#vSettings [data-focus="integrations"] .grp-note');
  await expect(note).toContainText('Playwright');
  await expect(note).toContainText('NOT in the session you are looking at');
  await expect(note).toContainText('Start a new session');
  // 5. …and it does NOT slander Serena, which really did attach.
  await expect(note).not.toContainText('Serena');
  // 6. The stale pre-BUG-108 "fetched on demand" claim is gone.
  await expect(page.locator('#vSettings [data-focus="integrations"]')).not.toContainText('Fetched on demand');
  await page.screenshot({ path: path.join(SHOTS, 'BUG-135-drawer-note.png') }).catch(() => {});

  // 7. No false alarm: with playwright OFF for the project, no note, no chip.
  await page.locator('button[aria-label="Toggle Playwright"]').click();
  await expect(chip(page, 'playwright')).toHaveCount(0);
  await expect(page.locator('#vSettings [data-focus="integrations"] .grp-note')).toHaveCount(0);
});
