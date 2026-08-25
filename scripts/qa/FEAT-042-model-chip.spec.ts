/**
 * FEAT-042 — the always-visible LIVE model chip in the crown, against the REAL
 * server + a REAL driven session (haiku, so it is cheap).
 *
 * What this proves, user-observable (WORKING_AGREEMENT §C):
 *   1. ALWAYS VISIBLE — a project shows the chip with the resolved model
 *      before any session runs; once the session launches the chip carries the
 *      CLI's own wire-id report (session-init), not the client's guess.
 *   2. LIVE-UPDATES ON A USER SWITCH — a /model live switch (BUG-026 path)
 *      updates the chip WITHOUT a reload, and does NOT flag: the user chose it.
 *   3. PER-TURN GROUND TRUTH, END TO END — after the switch, the next REAL
 *      turn's assistant message re-reports the wire model (`model-observed`
 *      emitted by the bridge from `message.model`); the chip's live report
 *      becomes the sonnet wire id purely from that signal (session-init never
 *      re-fires), still unflagged (it matches the user's confirmed choice).
 *   4. A CHANGE THE USER DID NOT INITIATE IS FLAGGED — both signal shapes,
 *      injected through the real client event contract (window.__station
 *      .onEvent, the same seam BUG-021's verify used — a real refusal fallback
 *      cannot be triggered on demand without shipping a jailbreak in the
 *      repo): the dedicated `model-changed` (refusal fallback) and a
 *      mismatching per-turn `model-observed` each pulse+flag the chip AND
 *      append a transcript "model changed: X → Y" system line.
 *   5. CLICK OPENS THE EXISTING PICKER — and acknowledges (clears) the flag.
 *
 * Non-vacuity: pre-fix there is NO #modelChip in the DOM at all — assertion 1
 * fails outright, not merely with a wrong value.
 *
 *   npx playwright test scripts/qa/FEAT-042-model-chip.spec.ts
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
  DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat042-data-'));
  WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat042-work-'));
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

const chipInfo = (page: Page) =>
  page.evaluate(() => (window as any).__station.modelChipInfo());

const sonnetRow = (page: Page) =>
  page.locator('#modelOpts button.opt')
    .filter({ has: page.locator('.n', { hasText: /sonnet/i }) })
    .filter({ hasNot: page.locator('.n', { hasText: /1m/i }) })
    .first();

test('the crown model chip shows the live resolved model, updates on a live switch, and loudly flags a change the user did not initiate', async ({ page }) => {
  test.setTimeout(300_000);

  // ---- scratch project: cheap + ungated (haiku default, bypassPermissions) ----
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: WORK, name: 'qa-feat042-model-chip' }),
  })).json() as { project?: { id: string } };
  const projectId = reg.project?.id;
  expect(projectId, `project registration failed: ${JSON.stringify(reg)}`).toBeTruthy();
  await (await fetch(`${BASE}/api/projects/${projectId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'haiku', permissionMode: 'bypassPermissions', maxBudgetUsd: 0.25 }),
  })).json();

  await page.goto(`${BASE}/#/project/${projectId}`);
  await page.waitForFunction(() => (window as any).__station !== undefined);
  await page.waitForFunction(
    (pid) => (window as any).__station.state.current.projectId === pid,
    projectId,
  );

  // ============================================================
  // 1a. ALWAYS VISIBLE — pre-launch, the chip already names the resolved
  //     project default. Pre-fix #modelChip does not exist: this FAILS outright.
  // ============================================================
  await expect(page.locator('#modelChip')).toBeVisible();
  await expect(page.locator('#modelChipName')).toContainText(/haiku/i);

  // ---- drive one short REAL turn so a LIVE session exists (haiku) ----
  await page.locator('#prompt').fill('Reply with exactly OK and nothing else.');
  await page.locator('#go').click();
  await page.waitForFunction(() => !!(window as any).__station.state.sdkSessionId, undefined, { timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__station.state.busy), { timeout: 60_000 }).toBe(false);

  // ============================================================
  // 1b. LIVE VALUE — the chip now carries the CLI's OWN wire-id report and the
  //     live (moss) treatment; nothing is flagged, nothing changed.
  // ============================================================
  await expect(page.locator('#modelChipName')).toContainText(/haiku/i);
  const info1 = await chipInfo(page);
  expect(String(info1.wire ?? ''), 'the chip must hold the session-reported wire id').toMatch(/^claude-.*haiku|^haiku/i);
  expect(info1.flagged).toBe(false);
  await expect(page.locator('#modelChip')).toHaveAttribute('data-live', 'true');
  await expect(page.locator('#modelChip')).not.toHaveAttribute('data-flag', 'true');
  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-042-chip.png') }).catch(() => {});

  // ============================================================
  // 5 (first half) + 2. CLICK OPENS THE PICKER; a live /model switch updates
  //     the chip WITHOUT a reload and does NOT flag (the user chose it).
  // ============================================================
  await page.locator('#modelChip').click();
  await expect(page.locator('#modelPop')).toHaveClass(/open/);
  await sonnetRow(page).click();
  await expect(page.locator('#fine')).toContainText(/confirmed by the server/i, { timeout: 15_000 });
  await expect(page.locator('#modelChipName')).toContainText(/sonnet/i, { timeout: 5_000 });
  await expect(page.locator('#modelChip')).not.toHaveAttribute('data-flag', 'true');

  // ============================================================
  // 3. PER-TURN GROUND TRUTH, END TO END — the next REAL turn's assistant
  //    message re-reports the wire model through the bridge's `model-observed`
  //    (session-init cannot re-fire on this session), so the chip's live
  //    report becomes the SONNET wire id. Still unflagged: it matches the
  //    user's confirmed choice.
  // ============================================================
  await page.locator('#prompt').fill('Reply with exactly OK and nothing else.');
  await page.locator('#go').click();
  await expect.poll(() => page.evaluate(() => (window as any).__station.state.busy), { timeout: 90_000 }).toBe(false);
  await expect.poll(async () => String((await chipInfo(page)).wire ?? ''), { timeout: 15_000 }).toMatch(/sonnet/i);
  expect((await chipInfo(page)).flagged, 'a user-initiated switch must never flag').toBe(false);
  await expect(page.locator('.ran-lbl.model-change')).toHaveCount(0);

  // ============================================================
  // 4a. THE DEDICATED SIGNAL — a refusal-fallback `model-changed` (the SDK's
  //     `model_refusal_fallback`, by definition NOT user-initiated) pulses+
  //     flags the chip, updates it, and appends the transcript system line.
  //     Injected through the real client event contract: a genuine safeguard
  //     refusal cannot be triggered on demand.
  // ============================================================
  const wireBefore = String((await chipInfo(page)).wire);
  await page.evaluate((from: string) => {
    (window as any).__station.onEvent({
      t: 'model-changed', from, to: 'claude-haiku-4-5-20251001',
      reason: 'refusal-fallback', category: 'cyber',
    });
  }, wireBefore);
  await expect(page.locator('#modelChip')).toHaveAttribute('data-flag', 'true');
  await expect(page.locator('#modelChipName')).toContainText(/haiku/i);
  const changeLine = page.locator('.ran-lbl.model-change');
  await expect(changeLine).toHaveCount(1);
  await expect(changeLine).toContainText(/model changed:/i);
  await expect(changeLine).toContainText(/→/);
  await expect(changeLine).toContainText(/haiku/i);
  await expect(page.locator('#fine')).toContainText(/model changed/i);
  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-042-flagged.png') }).catch(() => {});

  // ============================================================
  // 5 (second half). CLICKING THE CHIP ACKNOWLEDGES the flag and opens the
  //     existing /model picker (no new surface).
  // ============================================================
  await page.locator('#modelChip').click();
  await expect(page.locator('#modelPop')).toHaveClass(/open/);
  await expect(page.locator('#modelChip')).not.toHaveAttribute('data-flag', 'true');
  await page.keyboard.press('Escape');
  await page.locator('body').click({ position: { x: 4, y: 4 } });

  // ============================================================
  // 4b. THE PER-TURN SIGNAL — a `model-observed` wire id that does NOT match
  //     the expectation (what the user launched with / last confirmed) is a
  //     silent switch too: flagged once, new transcript line, chip adopts it.
  // ============================================================
  await page.evaluate(() => {
    (window as any).__station.onEvent({ t: 'model-observed', model: 'claude-opus-4-6-20260101' });
  });
  await expect(page.locator('#modelChip')).toHaveAttribute('data-flag', 'true');
  await expect(page.locator('#modelChipName')).toContainText(/opus/i);
  await expect(page.locator('.ran-lbl.model-change')).toHaveCount(2);
  // …and a REPEAT of the same wire id does not double-flag or double-line.
  await page.locator('#modelChip').click(); // acknowledge
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    (window as any).__station.onEvent({ t: 'model-observed', model: 'claude-opus-4-6-20260101' });
  });
  await expect(page.locator('#modelChip')).not.toHaveAttribute('data-flag', 'true');
  await expect(page.locator('.ran-lbl.model-change')).toHaveCount(2);
});
