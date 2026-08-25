/**
 * FEAT-048 — survival ground truth surfaced on #sessStatus's hover/title, fed
 * lazily by GET /api/health (FEAT-040's machine half, BUG-027's adopted/
 * scoped fields). doctor stays the CLI tool; this puts the SAME ground truth
 * at the point of need — hovering the status affordance the user already
 * reads (FEAT-040).
 *
 * Four verdicts, matching scripts/station-doctor.mjs's own vocabulary:
 *  - "Protected — survives a server restart." — survivalConfigured &&
 *    survivalScoped === true (a REAL driven direct-isolation session; this
 *    dev box already runs nested inside its own claude-station-host-*.scope,
 *    confirmed by `cat /proc/self/cgroup`, so nested `systemd-run --scope`
 *    works here exactly as it did for FEAT-040/BUG-027's own specs).
 *  - "Not protected — survival is not configured…" — survivalConfigured
 *    false, driven for REAL by starting the scratch server with
 *    `CLAUDE_STATION_SURVIVE=0` (survival.ts's own documented kill-switch).
 *  - "⚠ survival configured but NOT scoped…" — the BUG-024 class (scope
 *    escape attempted but failed). Reproducing the actual failure needs the
 *    deployed-service harness BUG-024/BUG-027 already own (systemd-run
 *    unavailable in a --user SERVICE's env) — out of scope here. Verifying
 *    the ⚠ wording is a CLIENT-side rendering concern: this test intercepts
 *    the same /api/health response driving the REAL open session and swaps
 *    in that one verdict (a fixture, per the charter), proving the UI reacts
 *    correctly to a ground-truth payload the server is independently
 *    verified (BUG-024/BUG-027) to be capable of emitting.
 *  - "Survived a restart — broker alive (…), not yet adopted…" — a
 *    surviving-unadopted broker (BUG-027 class). Same fixture rationale:
 *    reproducing it for real needs BUG-027's own restart harness (a second
 *    server process, a genuinely different in-memory session); this proves
 *    the client renders that server-shaped verdict honestly.
 *
 * NON-VACUOUS: before this change #sessStatus's title never carried survival
 * wording at all (it was fixed per-state boilerplate from SESS_STATUS_META);
 * every assertion below fails outright on pre-FEAT-048 code, not just reads
 * a wrong value.
 *
 *   npx playwright test scripts/qa/feat-048-survival-hover.spec.ts
 *
 * Each server is scratch, OS-assigned free port (never :4317), killed by pid.
 */
import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
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

async function startScratchServer(envOverrides: NodeJS.ProcessEnv = {}): Promise<{ child: ChildProcess; base: string; port: number; data: string; work: string }> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat048-data-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat048-work-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), CLAUDE_STATION_DATA: data, ...envOverrides },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try { await fetch(`${base}/api/health`); up = true; } catch { await sleep(250); }
  }
  if (!up) throw new Error('scratch server never became healthy');
  return { child, base, port, data, work };
}

async function bootToProject(page: Page, base: string, projectId: string): Promise<void> {
  await page.goto(`${base}/#/project/${projectId}`);
  await page.waitForFunction(() => (globalThis as any).__station !== undefined);
  await page.waitForFunction(
    (pid) => (globalThis as any).__station.state.current.projectId === pid,
    projectId,
  );
}

async function driveQuickTurn(page: Page, base: string, work: string, name: string): Promise<{ projectId: string; sdkSessionId: string }> {
  const reg = await (await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: work, name }),
  })).json() as { project?: { id: string } };
  const projectId = reg.project?.id;
  expect(projectId, `project registration failed: ${JSON.stringify(reg)}`).toBeTruthy();
  await (await fetch(`${base}/api/projects/${projectId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'haiku', permissionMode: 'bypassPermissions' }),
  })).json();

  await bootToProject(page, base, projectId!);
  await page.locator('#prompt').fill('Reply with exactly the text FEAT048-DONE and nothing else.');
  await page.locator('#go').click();

  await page.waitForFunction(() => !!(globalThis as any).__station.state.sdkSessionId, undefined, { timeout: 30_000 });
  const sdkSessionId: string = await page.evaluate(() => (globalThis as any).__station.state.sdkSessionId);
  expect(sdkSessionId, 'no real sdkSessionId — the live turn never actually started').toBeTruthy();

  // Let the turn actually finish so the affordance is idle (state text stops
  // moving) before we probe the survival hover — the hover text must ride
  // ALONGSIDE the state label, not replace/race it.
  await expect.poll(() => page.evaluate(() => (globalThis as any).__station.computeSessState()), { timeout: 30_000 }).toBe('idle');

  return { projectId: projectId!, sdkSessionId };
}

/** Forces the lazy fetch (bypassing the hover-cache) and returns the resulting title. */
async function forceSurvivalTitle(page: Page): Promise<string> {
  await page.evaluate(() => {
    const st = (globalThis as any).__station;
    st.state.sessSurvival = { key: null, entry: null, at: 0 }; // bust the cache
    st.refreshSessSurvival();
  });
  // Wait for the fetched entry to actually LAND against the current
  // session's key (not just "title is non-empty" — the base per-state hint
  // is already non-empty before any fetch, e.g. "Nothing is running.").
  await expect.poll(
    () => page.evaluate(() => {
      const st = (globalThis as any).__station;
      const key = st.state.stationSessionId || st.state.sdkSessionId || null;
      return !!key && st.state.sessSurvival.key === key && !!st.state.sessSurvival.entry;
    }),
    { timeout: 10_000, message: 'refreshSessSurvival() never resolved a matching /api/health entry' },
  ).toBe(true);
  return (await page.locator('#sessStatus').getAttribute('title')) ?? '';
}

let servers: ChildProcess[] = [];
const cleanupDirs: string[] = [];

test.afterEach(async () => {
  for (const s of servers) stopByPid(s);
  servers = [];
  await sleep(300);
  for (const d of cleanupDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

test('protected — a real survival-configured, cgroup-scoped session shows "Protected — survives a server restart."', async ({ page }) => {
  const { child, base, work, data } = await startScratchServer();
  servers.push(child);
  cleanupDirs.push(data, work);

  await driveQuickTurn(page, base, work, 'qa-feat048-protected');

  // Pre-hover: no survival wording yet (nothing fetched) — proves the fetch
  // really is lazy, not baked into every paint.
  const beforeHover = await page.locator('#sessStatus').getAttribute('title');
  expect(beforeHover ?? '').not.toContain('Protected');
  expect(beforeHover ?? '').not.toContain('protected');

  // The real gesture: hovering the affordance.
  await page.locator('#sessStatus').hover();
  await expect.poll(
    async () => page.locator('#sessStatus').getAttribute('title'),
    { timeout: 10_000 },
  ).toContain('Protected — survives a server restart.');

  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-048-protected.png') }).catch(() => {});
});

test('unconfigured — a real session started with CLAUDE_STATION_SURVIVE=0 shows "Not protected"', async ({ page }) => {
  const { child, base, work, data } = await startScratchServer({ CLAUDE_STATION_SURVIVE: '0' });
  servers.push(child);
  cleanupDirs.push(data, work);

  await driveQuickTurn(page, base, work, 'qa-feat048-unconfigured');

  const title = await forceSurvivalTitle(page);
  expect(title).toContain('Not protected — survival is not configured for this session.');
  expect(title).not.toContain('Protected —');
  expect(title).not.toContain('⚠');

  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-048-unconfigured.png') }).catch(() => {});
});

test('configured but NOT scoped (BUG-024 class) — a fixture /api/health verdict shows the ⚠ line', async ({ page }) => {
  const { child, base, work, data } = await startScratchServer();
  servers.push(child);
  cleanupDirs.push(data, work);

  const { sdkSessionId } = await driveQuickTurn(page, base, work, 'qa-feat048-not-scoped');

  // Intercept the real /api/health call the client makes on hover and swap
  // in the one verdict that is impractical to force live outside the
  // deployed-service harness BUG-024/BUG-027 already own: survival WAS
  // attempted (configured:true) but the ground-truth cgroup check says it
  // did not land (scoped:false) — the exact false-sense-of-protection class
  // BUG-024 exists to catch. Everything else in the payload is real.
  await page.route('**/api/health', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    for (const s of body.sessions ?? []) {
      if (s.sdkSessionId === sdkSessionId) {
        s.survivalConfigured = true;
        s.survivalScoped = false;
      }
    }
    await route.fulfill({ response: res, json: body });
  });

  const title = await forceSurvivalTitle(page);
  expect(title).toContain('⚠ survival configured but NOT scoped — not actually protected against a restart right now.');

  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-048-not-scoped.png') }).catch(() => {});
});

test('surviving-unadopted (BUG-027 class) — a fixture health entry surfaces the broker state honestly', async ({ page }) => {
  const { child, base, work, data } = await startScratchServer();
  servers.push(child);
  cleanupDirs.push(data, work);

  const { sdkSessionId } = await driveQuickTurn(page, base, work, 'qa-feat048-survivor');

  // Same rationale as the not-scoped fixture above: reproducing a REAL
  // adopted:false survivor needs BUG-027's own restart harness (a fresh
  // server process, a genuinely different in-memory session). This proves
  // the CLIENT renders that exact server-shaped verdict honestly — broker
  // state named, not just a bare "protected"/"not protected" binary.
  await page.route('**/api/health', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    for (const s of body.sessions ?? []) {
      if (s.sdkSessionId === sdkSessionId) {
        s.adopted = false;
        s.state = 'surviving-unadopted';
        s.survivalConfigured = true;
        s.survivalScoped = true;
        s.broker = { hostPid: 999999, claudePid: 999998, state: 'draining', sock: '/tmp/qa-fixture.sock', updatedAt: new Date().toISOString() };
      }
    }
    await route.fulfill({ response: res, json: body });
  });

  const title = await forceSurvivalTitle(page);
  expect(title).toContain('Survived a restart — broker alive (draining), not yet adopted by this server; resume to continue the thread.');

  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-048-survivor.png') }).catch(() => {});
});
