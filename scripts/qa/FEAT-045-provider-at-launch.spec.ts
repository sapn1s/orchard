/**
 * FEAT-045 — the PROVIDER is visible at session-launch, and /model is
 * provider-aware. Against the REAL server + the protocol-VALIDATING fake
 * codex app-server (spawn seam CLAUDE_STATION_CODEX_BIN — no subscription
 * usage, no install).
 *
 * What this proves, user-observable (WORKING_AGREEMENT §C):
 *   1. LAUNCH SURFACE — the composer tray has a provider control pre-start,
 *      its popover shows both engines AND the live detectCodex() verdict
 *      (the same /api/providers truth the drawer shows).
 *   2. ARMING — picking OpenAI arms the existing per-launch override
 *      (`start.overrides.provider` — SESSION_OVERRIDE_FIELDS has validated it
 *      since P3; the client just never sent it), and the FEAT-042 crown chip
 *      marks the armed engine.
 *   3. CODEX SESSION + REAL CATALOG — launching yields a codex session, and
 *      /model on it lists the CODEX catalog (the fake's model/list:
 *      "GPT-5.2 Codex" / "GPT-5.2") and NOT the Claude aliases.
 *   4. LIVE SWITCH APPLIES — picking GPT-5.2 is confirmed with honest
 *      "applies from the next turn" copy (model rides turn/start — P2c), and
 *      the NEXT turn carries it ON THE WIRE: the fake's ASSERT_MODEL marker
 *      kills the transport (protocol violation) if turn/start lacks the
 *      model, so the turn completing IS the wire proof.
 *   5. NO CATALOG POISONING — after a codex session ran, GET /api/models
 *      (the Claude list) contains no gpt-* row; the codex catalog lives at
 *      /api/models?provider=openai. (Pre-change, rememberModels overwrote
 *      the single global list.)
 *   6. HONEST WARN — on a server where codex is NOT usable (scrubbed
 *      HOME/PATH), the control shows the not-installed verdict and picking
 *      OpenAI warns with the actionable hint instead of pretending.
 *
 * Non-vacuity: pre-change there is no #provBtn at all (1, 2, 6 fail), the
 * picker lists Opus/Sonnet/Haiku on the codex session (3 fails), and the
 * Claude /api/models is poisoned with gpt-* rows after the codex session
 * (5 fails).
 *
 *   npx playwright test scripts/qa/FEAT-045-provider-at-launch.spec.ts
 *
 * Never touches :4317; scratch servers on OS-assigned free ports, killed by
 * PID, never pkill.
 */
import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const FAKE = path.join(ROOT, 'scripts', 'fixtures', 'codex-fake-app-server.mjs');
const SHOTS = path.join(ROOT, 'docs', 'bugs', 'assets');

// page.evaluate callbacks run in the BROWSER; this project's tsconfig has no
// DOM lib (server/scripts are Node-only), so declare these locally as `any`.
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

interface Srv { child: ChildProcess; base: string; data: string }
const servers: Srv[] = [];
const cleanupDirs: string[] = [];

async function startServer(extraEnv: Record<string, string> = {}): Promise<Srv> {
  const port = await freePort(); // never 4317, the live systemd service
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat045-data-'));
  cleanupDirs.push(data);
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), CLAUDE_STATION_DATA: data, ...extraEnv },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (d) => process.stderr.write(`  [server:${port}!] ${d}`));
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try { await fetch(`${base}/api/health`); up = true; } catch { await sleep(250); }
  }
  if (!up) throw new Error(`scratch server on ${port} never became healthy`);
  const srv = { child, base, data };
  servers.push(srv);
  return srv;
}

async function registerProject(base: string, name: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cs-feat045-${name}-`));
  cleanupDirs.push(dir);
  cleanupDirs.push(path.join(os.homedir(), '.claude', 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-')));
  const r = await (await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: dir, name }),
  })).json() as { project?: { id: string } };
  if (!r.project?.id) throw new Error(`project registration failed: ${JSON.stringify(r)}`);
  return r.project.id;
}

test.afterAll(async () => {
  for (const s of servers) stopByPid(s.child);
  await sleep(300);
  for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
});

async function bootToProject(page: Page, base: string, projectId: string): Promise<void> {
  await page.goto(`${base}/#/project/${projectId}`);
  await page.waitForFunction(() => (window as any).__station !== undefined);
  await page.waitForFunction(
    (pid) => (window as any).__station.state.current.projectId === pid,
    projectId,
  );
}

test('provider is pickable at launch, a codex session lists the codex catalog, and a live switch rides the next turn/start', async ({ page }) => {
  test.setTimeout(240_000);
  const srv = await startServer({ CLAUDE_STATION_CODEX_BIN: FAKE });
  const projectId = await registerProject(srv.base, 'launch');
  await bootToProject(page, srv.base, projectId);

  // ============================================================
  // 1. LAUNCH SURFACE — provider control, with the live detection verdict
  // ============================================================
  const provBtn = page.locator('#provBtn');
  await expect(provBtn, 'the launch surface must carry a provider control (FEAT-045)').toBeVisible();

  await provBtn.click();
  await expect(page.locator('#provPop')).toHaveClass(/open/);
  const opts = page.locator('#provOpts button.opt');
  await expect(opts.filter({ hasText: /claude/i }).first()).toBeVisible();
  await expect(opts.filter({ hasText: /openai|codex/i }).first()).toBeVisible();

  // The popover shows the SAME detectCodex() verdict /api/providers reports.
  const prov = await (await fetch(`${srv.base}/api/providers`)).json() as any;
  const routeStatus = String(prov?.providers?.openai?.status ?? '');
  expect(['connected', 'installed-not-signed-in', 'not-installed']).toContain(routeStatus);
  const stateLine = page.locator('#provPop .prov-state');
  await expect(stateLine).toBeVisible();
  await expect(stateLine).toHaveAttribute('data-status', routeStatus);
  await page.screenshot({ path: path.join(SHOTS, 'FEAT-045-launch-picker.png') });

  // ============================================================
  // 2. ARMING — picking OpenAI arms the per-launch override + marks the chip
  // ============================================================
  await opts.filter({ hasText: /openai|codex/i }).first().click();
  const armed = await page.evaluate(() => (window as any).__station.sessionOverrides());
  expect(armed?.provider, 'picking OpenAI must arm start.overrides.provider').toBe('openai');
  await expect(page.locator('#modelChip .m')).toContainText(/codex/i); // FEAT-042 chip marks the armed engine

  // ============================================================
  // 3. LAUNCH → codex session; /model lists the CODEX catalog, not Claude's
  // ============================================================
  await page.locator('#prompt').fill('Say hello.');
  await page.locator('#go').click();
  await page.waitForFunction(() => (window as any).__station.state.effective?.provider === 'openai', undefined, { timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__station.state.busy), { timeout: 30_000 }).toBe(false);
  await expect(page.locator('#panes .claude .body').last()).toContainText('Hello from fixture Codex.');

  await page.locator('#modelBtn').click();
  await expect(page.locator('#modelPop')).toHaveClass(/open/);
  // The fake's model/list catalog — fetched via /api/models?provider=openai.
  await expect(page.locator('#modelOpts')).toContainText('GPT-5.2 Codex', { timeout: 15_000 });
  await expect(page.locator('#modelOpts')).toContainText('GPT-5.2');
  // …and NOT the static Claude aliases.
  await expect(page.locator('#modelOpts')).not.toContainText(/opus|sonnet|haiku/i);
  await page.screenshot({ path: path.join(SHOTS, 'FEAT-045-codex-model-list.png') });

  // ============================================================
  // 4. LIVE SWITCH — confirmed with next-turn honesty, then proven ON THE WIRE
  // ============================================================
  await page.locator('#modelOpts button.opt').filter({ has: page.locator('.n', { hasText: /^GPT-5\.2$/ }) }).first().click();
  await expect(page.locator('#fine')).toContainText(/confirmed/i, { timeout: 15_000 });
  await expect(page.locator('#fine'), 'codex switches at turn boundaries — the copy must say so').toContainText(/next turn/i);
  const effModel = await page.evaluate(() => (window as any).__station.state.effective?.effective?.model);
  expect(effModel).toBe('gpt-5.2');
  await page.screenshot({ path: path.join(SHOTS, 'FEAT-045-live-switch.png') });

  // The NEXT turn must carry model=gpt-5.2 on turn/start: the fake's
  // ASSERT_MODEL marker raises a protocol violation (transport death → the
  // turn fails) if it does not. The turn completing IS the wire assertion.
  await page.locator('#prompt').fill('ASSERT_MODEL:gpt-5.2; continue');
  await page.locator('#go').click();
  await expect.poll(() => page.evaluate(() => (window as any).__station.state.busy), { timeout: 30_000 }).toBe(false);
  await expect(page.locator('#panes .claude .body').last()).toContainText('Hello from fixture Codex.');
  const stillLive = await page.evaluate(() => (window as any).__station.state.live);
  expect(stillLive, 'a fake violation would have killed the session — it must still be live').toBe(true);

  // ============================================================
  // 5. NO POISONING — the Claude catalog never absorbs the codex one
  // ============================================================
  const claudeList = await (await fetch(`${srv.base}/api/models`)).json() as any;
  expect(JSON.stringify(claudeList.models ?? []), 'GET /api/models (Claude) must not carry gpt-* rows').not.toMatch(/gpt-/i);
  const codexList = await (await fetch(`${srv.base}/api/models?provider=openai`)).json() as any;
  expect(JSON.stringify(codexList.models ?? [])).toMatch(/gpt-5\.2-codex/);
});

test('on a machine where codex is not usable, the launch control shows the verdict and picking OpenAI warns with the hint', async ({ page }) => {
  test.setTimeout(120_000);
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat045-nohome-'));
  cleanupDirs.push(emptyHome);
  const env: Record<string, string> = { HOME: emptyHome, PATH: '/definitely-not-a-bin-dir' };
  const srv = await startServer(env);
  const projectId = await registerProject(srv.base, 'nocodex');
  await bootToProject(page, srv.base, projectId);

  await page.locator('#provBtn').click();
  await expect(page.locator('#provPop')).toHaveClass(/open/);
  const stateLine = page.locator('#provPop .prov-state');
  await expect(stateLine).toHaveAttribute('data-status', 'not-installed', { timeout: 15_000 });

  // Picking OpenAI is ALLOWED (arming is honest) but warns with the hint.
  await page.locator('#provOpts button.opt').filter({ hasText: /openai|codex/i }).first().click();
  await expect(page.locator('#fine')).toContainText(/not installed|not-installed|not usable|PROVIDERS/i, { timeout: 15_000 });
  const armed = await page.evaluate(() => (window as any).__station.sessionOverrides());
  expect(armed?.provider).toBe('openai');
  await page.locator('#provBtn').click(); // reopen: the warn note renders in the popover too
  await expect(page.locator('#provPop')).toContainText(/codex login|install|PROVIDERS/i);
  await page.screenshot({ path: path.join(SHOTS, 'FEAT-045-not-connected.png') });
});
