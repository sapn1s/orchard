/**
 * BUG-026 — the /model picker must actually SWITCH the running session's model
 * (the WRITE path), against the REAL server + a REAL driven session (haiku, so
 * it is cheap). This is the sibling of the permission-mode live path: picking a
 * model on a RUNNING session goes through the server's `setModel`
 * (SDK `Query.setModel`), not a client-only override that silently reverts.
 *
 * What this proves, user-observable (WORKING_AGREEMENT §C):
 *   1. ACKNOWLEDGED — picking a different model on a live session shows an
 *      explicit "confirmed by the server … in force for this running session"
 *      line (NOT the old "applies to the NEXT session" arm-only copy).
 *   2. GOVERNS THE SESSION — the model the SESSION reports (its effective
 *      config) changes to the picked one. Pre-fix it stayed the launch model.
 *   3. PERSISTS ACROSS A REOPEN — closing and reopening the picker shows the
 *      picked model lit as current (aria-pressed). Pre-fix the picker reverted
 *      to the original model, which is the exact symptom the user reported.
 *   4. PERSISTS ACROSS A FULL RELOAD + REATTACH — after page.reload() and the
 *      real recovery gesture (type + Enter), the session STILL reports the
 *      picked model and the picker STILL shows it current — because the SERVER
 *      genuinely switched it, not just localStorage.
 *
 * Non-vacuity: on pre-fix app.js all four assertions FAIL — the picker only
 * armed `state.overrides.model` (which effectiveModel() rightly lets the live
 * value shadow), said "applies to the NEXT session", never told the server, and
 * so reverted on reopen. Verified by git-stashing the fix and re-running.
 *
 *   npx playwright test scripts/qa/BUG-026-model-switch.spec.ts
 *
 * Never touches :4317 (the live systemd service); spawns its own server on an
 * OS-assigned free port and kills it by PID, never pkill.
 */
import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

// page.evaluate callbacks run in the BROWSER; this project's tsconfig has no
// DOM lib (server/scripts are Node-only), so declare these locally as `any`.
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
  DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug026-data-'));
  WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug026-work-'));
  cleanupDirs.push(DATA, WORK);
  cleanupDirs.push(path.join(os.homedir(), '.claude', 'projects', WORK.replace(/[^a-zA-Z0-9]/g, '-')));

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

/** The model the SESSION reports it is running (the effective config). */
const sessionModel = (page: Page) =>
  page.evaluate(() => (window as any).__station.state.effective?.effective?.model ?? null);

/** Open the model picker and wait for its options to render. */
async function openPicker(page: Page): Promise<void> {
  await page.locator('#modelBtn').click();
  await expect(page.locator('#modelPop')).toHaveClass(/open/);
  await expect(page.locator('#modelOpts button.opt').first()).toBeVisible();
}

async function closePicker(page: Page): Promise<void> {
  if (await page.locator('#modelPop').evaluate((n: any) => n.classList.contains('open'))) {
    await page.locator('#modelBtn').click();
  }
  await expect(page.locator('#modelPop')).not.toHaveClass(/open/);
}

// The base "Sonnet" option (its picker value is the 'sonnet' alias), excluding a
// "[1m]" long-context variant. Works whether the list is the built-in fallback
// ("Sonnet") or the CLI's real names ("Sonnet 4.x") post-`/api/models`.
const sonnetRow = (page: Page) =>
  page.locator('#modelOpts button.opt')
    .filter({ has: page.locator('.n', { hasText: /sonnet/i }) })
    .filter({ hasNot: page.locator('.n', { hasText: /1m/i }) })
    .first();

test('picking a different model on a running session is acknowledged, governs the session, and survives a reopen and a full reload', async ({ page }) => {
  test.setTimeout(300_000);

  // ---- scratch project: cheap + ungated (haiku default, bypassPermissions) ----
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: WORK, name: 'qa-bug026-model-switch' }),
  })).json() as { project?: { id: string } };
  const projectId = reg.project?.id;
  expect(projectId, `project registration failed: ${JSON.stringify(reg)}`).toBeTruthy();
  await (await fetch(`${BASE}/api/projects/${projectId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'haiku', permissionMode: 'bypassPermissions', maxBudgetUsd: 0.25 }),
  })).json();

  await bootToProject(page, projectId!);

  // ---- drive one short turn so a LIVE session exists (haiku) ----
  await page.locator('#prompt').fill('Reply with exactly OK and nothing else.');
  await page.locator('#go').click();
  await page.waitForFunction(() => !!(window as any).__station.state.sdkSessionId, undefined, { timeout: 60_000 });
  await page.waitForFunction(() => !!(window as any).__station.state.stationSessionId, undefined, { timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__station.state.busy), { timeout: 60_000 }).toBe(false);
  const sdkSessionId = await page.evaluate(() => (window as any).__station.state.sdkSessionId);
  expect(sdkSessionId, 'no sdkSessionId — the live turn never really started').toBeTruthy();

  // The session is live and running haiku (the launch model), NOT sonnet.
  expect(await page.evaluate(() => (window as any).__station.state.live)).toBe(true);
  const before = await sessionModel(page);
  expect(String(before ?? ''), `expected the session to start on haiku, got ${before}`).toMatch(/haiku|null|^$/i);
  expect(String(before ?? '')).not.toMatch(/sonnet/i);

  // ============================================================
  // 1 + 2. PICK A DIFFERENT MODEL → acknowledged + governs the session
  // ============================================================
  await openPicker(page);
  await sonnetRow(page).click();

  // (1) ACKNOWLEDGED — a real server confirmation, not the arm-only copy.
  await expect(page.locator('#fine')).toBeVisible();
  await expect(page.locator('#fine')).toContainText(/confirmed by the server/i, { timeout: 15_000 });
  await expect(page.locator('#fine')).toContainText(/sonnet/i);

  // (2) GOVERNS THE SESSION — the effective model the session reports is sonnet.
  await expect.poll(() => sessionModel(page), { timeout: 15_000 }).toMatch(/sonnet/i);

  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'BUG-026-switched.png') }).catch(() => {});

  // ============================================================
  // 3. PERSISTS ACROSS A REOPEN of the picker
  // ============================================================
  await closePicker(page);
  await openPicker(page);
  await expect(sonnetRow(page)).toHaveAttribute('aria-pressed', 'true');
  // And the previously-current haiku row is no longer the selected one.
  const haikuPressed = await page.locator('#modelOpts button.opt')
    .filter({ has: page.locator('.n', { hasText: /^haiku/i }) })
    .first()
    .getAttribute('aria-pressed');
  expect(haikuPressed, 'haiku must no longer be the current model after switching to sonnet').not.toBe('true');
  await closePicker(page);

  // ============================================================
  // 4. PERSISTS ACROSS A FULL PAGE RELOAD + REATTACH
  // ============================================================
  // Keep the session genuinely BUSY across the reload so it DETACHES and stays
  // live (an idle one would close): the reattach then reports the SAME live
  // session's server-side effective config — proving the server truly switched
  // the model and kept it, not merely that localStorage remembered a choice.
  await page.locator('#prompt').fill('Call the Bash tool exactly once with command `sleep 14 && echo ok`, then reply DONE.');
  await page.locator('#go').click();
  await expect.poll(() => page.evaluate(() => (window as any).__station.state.busy), { timeout: 30_000 }).toBe(true);

  await page.reload();
  await page.waitForFunction(() => (window as any).__station !== undefined, undefined, { timeout: 30_000 });
  await page.waitForFunction(
    (sid) => (window as any).__station.state.current.sessionId === sid,
    sdkSessionId,
    { timeout: 30_000 },
  );
  // The real recovery gesture: type + Enter drives the reattach handshake.
  await page.locator('#prompt').fill('Reply with exactly STILL-HERE and nothing else.');
  await page.locator('#prompt').press('Enter');
  await page.waitForFunction(() => (window as any).__station.state.live === true, undefined, { timeout: 30_000 });

  // The reattached SESSION still reports sonnet — the server genuinely switched
  // it and held it across the reload (read straight off the reattach handshake).
  await expect.poll(() => sessionModel(page), { timeout: 20_000 }).toMatch(/sonnet/i);

  // …and the picker still shows sonnet current.
  await openPicker(page);
  await expect(sonnetRow(page)).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'BUG-026-after-reload.png') }).catch(() => {});
  await closePicker(page);

  // Let the detached sleep turn finish so the session self-closes cleanly.
  await expect.poll(() => page.evaluate(() => (window as any).__station.state.busy), { timeout: 60_000 }).toBe(false);
});
