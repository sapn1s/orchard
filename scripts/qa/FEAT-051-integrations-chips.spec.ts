/**
 * FEAT-051 — integrations chips in the crown: attached MCP capabilities
 * visible like browser-extension icons, honest about planned vs live.
 *
 * What this proves, user-observable (WORKING_AGREEMENT §C):
 *   1. PLANNED STATE — pre-launch, the strip shows what WOULD attach per the
 *      project's real toggles (serena default ON; playwright default OFF),
 *      visually distinct (data-live="false", hollow) from live.
 *   2. TOGGLING UPDATES — flipping Playwright on/off in the drawer's
 *      Integrations group adds/removes its chip; turning everything off hides
 *      the strip ENTIRELY (nothing attachable → no strip).
 *   3. WHEN-TO-USE one-liners ride the chip hover (title): stealth browser =
 *      real profile / stays logged in; playwright = clean headless for
 *      repeatable UI tests; serena = symbol-level code navigation (LSP) — and
 *      the drawer rows carry the same line inline.
 *   4. CODEX HONESTY — a project whose provider is openai shows the "MCP off"
 *      chip (that engine gets no station-attached MCP tools).
 *   5. LIVE STATE — a REAL session's own session-init tool report is the
 *      ground truth: the strip's chips match exactly the `mcp__<name>__…`
 *      servers the CLI itself reported, rendered as live (filled).
 *   6. CHIP CLICK opens the drawer's Integrations group (FEAT-054 deep link).
 *   7. NARROW VIEWPORT — labels drop to glyphs; no horizontal jank.
 *
 * Non-vacuity: pre-change #integStrip does not exist — assertion 1 fails
 * outright.
 *
 *   npx playwright test scripts/qa/FEAT-051-integrations-chips.spec.ts
 *
 * Never touches :4317; own scratch server on a free port, killed by PID.
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
let BASE = '';
let WORK = '';
const cleanupDirs: string[] = [];

test.beforeAll(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f051-data-'));
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f051-store-'));
  const METH = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f051-meth-'));
  WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f051-work-'));
  cleanupDirs.push(DATA, STORE, METH, WORK);
  cleanupDirs.push(path.join(os.homedir(), '.claude', 'projects', WORK.replace(/[^a-zA-Z0-9]/g, '-')));
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
  await sleep(300);
  for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
});

const chip = (page: Page, name: string) => page.locator(`#integStrip .ichip[data-integ="${name}"]`);

test('crown integrations chips: planned vs live, toggling, codex honesty, deep link, narrow viewport', async ({ page }) => {
  test.setTimeout(300_000);

  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: WORK, name: 'qa-feat051-chips' }),
  })).json() as { project?: { id: string } };
  const pid = reg.project?.id;
  expect(pid, `registration failed: ${JSON.stringify(reg)}`).toBeTruthy();
  await fetch(`${BASE}/api/projects/${pid}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { model: 'haiku', permissionMode: 'bypassPermissions', maxBudgetUsd: 0.25 } }),
  });

  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto(`${BASE}/#/project/${pid}`);
  await page.waitForFunction(() => (window as any).__station !== undefined);
  await page.waitForFunction((p) => (window as any).__station.state.current.projectId === p, pid);

  // ═══ 1. PLANNED — serena (default ON) shows hollow; playwright (default OFF) absent ═══
  await expect(page.locator('#integStrip')).toBeVisible();
  await expect(chip(page, 'serena')).toBeVisible();
  await expect(chip(page, 'serena')).toHaveAttribute('data-live', 'false');
  await expect(chip(page, 'playwright')).toHaveCount(0);
  // 3. the when-to-use one-liner rides the hover
  await expect(chip(page, 'serena')).toHaveAttribute('title', /symbol-level code navigation \(LSP\)/);
  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-051-planned.png') }).catch(() => {});

  // ═══ 6. CHIP CLICK → the drawer's Integrations group (deep-linked) ═══
  await chip(page, 'serena').click();
  await expect(page.locator('#drawer')).toHaveClass(/open/);
  await expect(page.locator('#vSettings [data-focus="integrations"]')).toBeVisible();
  // 3b. the drawer rows carry the one-liners inline
  await expect(page.locator('#vSettings [data-focus="integrations"] .use1',
    { hasText: 'symbol-level code navigation (LSP)' })).toBeVisible();
  await expect(page.locator('#vSettings [data-focus="integrations"] .use1',
    { hasText: 'clean headless browser for repeatable UI tests' })).toBeVisible();
  await expect(page.locator('#vSettings [data-focus="integrations"] .use1',
    { hasText: 'real profile, stays logged in, survives bot checks' })).toBeVisible();

  // ═══ 2. TOGGLING UPDATES — playwright on → chip appears (planned) ═══
  await page.locator('button[aria-label="Toggle Playwright"]').click();
  await expect(chip(page, 'playwright')).toBeVisible();
  await expect(chip(page, 'playwright')).toHaveAttribute('data-live', 'false');
  await expect(chip(page, 'playwright')).toHaveAttribute('title', /clean headless browser for repeatable UI tests/);
  // …and off again → chip leaves
  await page.locator('button[aria-label="Toggle Playwright"]').click();
  await expect(chip(page, 'playwright')).toHaveCount(0);
  // serena off too → NOTHING attachable → the strip hides entirely
  await page.locator('button[aria-label="Toggle Serena (LSP)"]').click();
  await expect(page.locator('#integStrip')).toBeHidden();
  // restore serena for the live leg
  await page.locator('button[aria-label="Toggle Serena (LSP)"]').click();
  await expect(chip(page, 'serena')).toBeVisible();
  await page.locator('#dClose').click();

  // ═══ 4. CODEX HONESTY — provider openai ⇒ MCP-off chip, no capability chips ═══
  await fetch(`${BASE}/api/projects/${pid}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { provider: 'openai' } }),
  });
  await page.reload();
  await page.waitForFunction((p) => (window as any).__station.state.current.projectId === p, pid);
  await expect(chip(page, 'mcp-off')).toBeVisible();
  await expect(chip(page, 'mcp-off')).toHaveAttribute('title', /no station-attached MCP tools/);
  await expect(chip(page, 'serena')).toHaveCount(0);
  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-051-codex-mcp-off.png') }).catch(() => {});
  await fetch(`${BASE}/api/projects/${pid}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { provider: 'anthropic' } }),
  });
  await page.reload();
  await page.waitForFunction((p) => (window as any).__station.state.current.projectId === p, pid);
  await expect(chip(page, 'serena')).toBeVisible();

  // ═══ 5. LIVE — a REAL session; the chips match the CLI's OWN tool report ═══
  // BUG-035 ground truth: serena can still be STARTING during turn one (uvx
  // cold path), and `session-init` re-fires on the next turn with the settled
  // attach — so drive TWO turns and assert on the final report.
  await page.locator('#prompt').fill('Reply with exactly OK and nothing else.');
  await page.locator('#go').click();
  await page.waitForFunction(() => Array.isArray((window as any).__station.state.liveTools), undefined, { timeout: 120_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__station.state.busy), { timeout: 120_000 }).toBe(false);
  await page.locator('#prompt').fill('Reply with exactly OK and nothing else.');
  await page.locator('#go').click();
  await page.waitForFunction(() => {
    const live = (window as any).__station.liveAttachedServers();
    return live && live.size > 0;
  }, undefined, { timeout: 120_000 });
  const truth = await page.evaluate(() => {
    const st = (window as any).__station;
    const live = [...(st.liveAttachedServers() ?? [])].sort();
    const chips = [...document.querySelectorAll('#integStrip .ichip')].map((c: any) => ({
      name: c.dataset.integ, live: c.dataset.live,
    }));
    return { live, chips };
  });
  // the strip must be exactly the live attach set, every chip marked live
  expect(truth.chips.map((c) => c.name).sort()).toEqual(truth.live);
  for (const c of truth.chips) expect(c.live, `${c.name} must render as LIVE`).toBe('true');
  // and with serena toggled on, the real attach should actually include it —
  // the CLI reported mcp__serena__… tools (ground truth, not the toggle)
  expect(truth.live, 'serena should really have attached to the live session').toContain('serena');
  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-051-live.png') }).catch(() => {});
  await expect.poll(() => page.evaluate(() => (window as any).__station.state.busy), { timeout: 120_000 }).toBe(false);

  // ═══ 7. NARROW VIEWPORT — glyph-only chips, no horizontal overflow ═══
  await page.setViewportSize({ width: 880, height: 800 });
  const narrow = await page.evaluate(() => {
    const n = document.querySelector('#integStrip .ichip .n') as any;
    return {
      labelShown: n ? getComputedStyle(n).display !== 'none' : false,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  expect(narrow.labelShown, 'labels drop to glyphs when narrow').toBe(false);
  expect(narrow.overflow, 'no horizontal overflow').toBe(false);
});
