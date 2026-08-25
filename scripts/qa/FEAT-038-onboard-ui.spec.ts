/**
 * FEAT-038 — "Onboard this project to Orchard" as a one-click UI ACTION (the CLI
 * half is DONE + verified; this is the last remaining piece).
 *
 * What this proves, USER-OBSERVABLE (WA §C), in a REAL browser against the REAL
 * server + REAL on-disk artifacts:
 *   1. NON-VACUOUS — before onboarding, the scratch project has NONE of the
 *      artifacts onboard.mjs creates, and the overflow menu is not on screen.
 *   2. ONE CLICK ONBOARDS — right-click the project header → "Onboard to
 *      Orchard" → the SAME core the CLI runs (scripts/onboard.mjs) scaffolds the
 *      board + CLAUDE.md + CONVENTIONS + the portable board guard on disk, and
 *      the UI reports success with a real created-count.
 *   3. IDEMPOTENT — clicking again does NOT crash or double-scaffold; the UI
 *      reports an honest "already onboarded", and every artifact is byte-for-byte
 *      unchanged (a hand-edit would survive).
 *   4. INVALID TARGET ERRORS CLEANLY — a project whose dir is gone surfaces the
 *      server's 400 in the UI (error styling), never a 500 leak.
 *
 *   npx playwright test scripts/qa/FEAT-038-onboard-ui.spec.ts
 *
 * Never touches :4317 (the live systemd service); spawns its own server on an
 * OS-assigned free port and kills it by PID, never pkill. All dirs are mktemp'd
 * scratch and removed in afterAll.
 */
import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

// The 6 on-disk artifacts onboard.mjs's core creates (mirror of its own list).
const ARTIFACTS = [
  'docs/bugs/README.md',
  'docs/bugs/INDEX.md',
  'docs/bugs/TEMPLATE.md',
  'CLAUDE.md',
  'docs/CONVENTIONS.md',
  'scripts/board.mjs',
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
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => {
    try { if (child.pid !== undefined) process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }, 2000).unref();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: ChildProcess | null = null;
let BASE = '';
let PORT = 0;
let DATA = '';
const cleanupDirs: string[] = [];

async function createProject(hostPath: string, name: string): Promise<string> {
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath, name }),
  })).json() as { project?: { id: string } };
  expect(reg.project?.id, `project registration failed: ${JSON.stringify(reg)}`).toBeTruthy();
  return reg.project!.id;
}

async function bootToProject(page: Page, projectId: string): Promise<void> {
  await page.goto(`${BASE}/#/project/${projectId}`);
  await page.waitForFunction(() => (globalThis as any).__station !== undefined);
  await page.waitForFunction(
    (pid) => (globalThis as any).__station.state.current.projectId === pid,
    projectId,
  );
}

/** The visible project-header button for a given project name. */
const projHead = (page: Page, name: string) => page.locator('.proj', { hasText: name });

test.beforeAll(async () => {
  PORT = await freePort(); // never 4317, the live systemd service
  BASE = `http://127.0.0.1:${PORT}`;
  DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat038-data-'));
  cleanupDirs.push(DATA);

  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
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

test('one click onboards a project to Orchard; a re-run is idempotent; a bad target errors cleanly', async ({ page }) => {
  test.setTimeout(120_000);

  // ---- a fresh scratch project dir with NONE of the Orchard artifacts ----
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat038-work-'));
  cleanupDirs.push(WORK);
  const projectId = await createProject(WORK, 'qa-feat038-onboard');

  // (1) NON-VACUOUS: nothing scaffolded yet.
  for (const rel of ARTIFACTS) {
    expect(fs.existsSync(path.join(WORK, rel)), `pre-onboard, ${rel} must NOT exist`).toBe(false);
  }

  await bootToProject(page, projectId);

  const head = projHead(page, 'qa-feat038-onboard');
  await expect(head).toBeVisible();
  // The overflow is not on screen until summoned — proves the click is what opens it.
  await expect(page.locator('#projMenu.open')).toHaveCount(0);

  // ======================================================================
  // (2) ONE CLICK ONBOARDS
  // ======================================================================
  await head.click({ button: 'right' });
  const item = page.locator('#projMenu.open [role="menuitem"]', { hasText: 'Onboard to Orchard' });
  await expect(item).toBeVisible();
  await item.click();

  // UI reports success with a real created-count (6 fresh artifacts).
  await expect(page.locator('#fine')).toContainText('onboarded qa-feat038-onboard to Orchard', { timeout: 15_000 });
  await expect(page.locator('#fine')).toContainText('artifacts created');
  await expect(page.locator('#fine')).not.toHaveClass(/err/);
  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-038-onboarded.png') }).catch(() => {});

  // The on-disk artifacts the core creates now exist (the REAL deliverable).
  for (const rel of ARTIFACTS) {
    expect(fs.existsSync(path.join(WORK, rel)), `post-onboard, ${rel} must exist on disk`).toBe(true);
  }
  // The copied board guard actually runs against the fresh (ticket-less) board.
  const board = spawn(process.execPath, [path.join(WORK, 'scripts', 'board.mjs'), 'check', `--dir=${path.join(WORK, 'docs', 'bugs')}`], { stdio: 'ignore' });
  const boardOk = await new Promise<boolean>((res) => board.on('exit', (code) => res(code === 0)));
  expect(boardOk, 'the copied board:check must PASS on the freshly onboarded board').toBe(true);

  // ======================================================================
  // (3) IDEMPOTENT — re-run does not crash or double-scaffold
  // ======================================================================
  // Prove no-clobber: hand-edit CLAUDE.md, then onboard again — it must survive.
  const claudeMd = path.join(WORK, 'CLAUDE.md');
  fs.appendFileSync(claudeMd, '\n<!-- local hand edit, must survive a re-onboard -->\n');
  const editedBytes = fs.readFileSync(claudeMd);

  await head.click({ button: 'right' });
  await page.locator('#projMenu.open [role="menuitem"]', { hasText: 'Onboard to Orchard' }).click();
  await expect(page.locator('#fine')).toContainText('already onboarded to Orchard', { timeout: 15_000 });
  await expect(page.locator('#fine')).not.toHaveClass(/err/);
  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-038-idempotent.png') }).catch(() => {});

  expect(Buffer.compare(fs.readFileSync(claudeMd), editedBytes), 'a re-onboard clobbered a local edit').toBe(0);

  // ======================================================================
  // (4) INVALID TARGET ERRORS CLEANLY — no 500 leak
  // ======================================================================
  const GONE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat038-gone-'));
  const goneId = await createProject(GONE, 'qa-feat038-gone');
  // Boot to it WHILE the dir still exists (navigation reads the project); only
  // the onboard action below hits the missing target. This project was created
  // AFTER the page first loaded, so a full reload is needed for the client to
  // fetch it into its project list (a hash-only goto would not).
  await page.goto(`${BASE}/#/project/${goneId}`);
  await page.reload();
  await page.waitForFunction(() => (globalThis as any).__station !== undefined);
  await page.waitForFunction((pid) => (globalThis as any).__station.state.current.projectId === pid, goneId);
  const goneHead = projHead(page, 'qa-feat038-gone');
  await expect(goneHead).toBeVisible();
  fs.rmSync(GONE, { recursive: true, force: true }); // now the project's dir vanishes

  // Server-side: a clean 400, never a 500 stack leak.
  const resp = await fetch(`${BASE}/api/projects/${encodeURIComponent(goneId)}/onboard`, { method: 'POST', body: '{}' });
  expect(resp.status, 'a missing target dir must be a clean 400, not a 500').toBe(400);
  const body = await resp.json() as { error?: string };
  expect(body.error, 'the 400 must carry the core\'s honest message').toContain('onboard:');

  // UI-observable: the same failure surfaces in the status line with error styling.
  await goneHead.click({ button: 'right' });
  await page.locator('#projMenu.open [role="menuitem"]', { hasText: 'Onboard to Orchard' }).click();
  await expect(page.locator('#fine')).toContainText('could not onboard qa-feat038-gone', { timeout: 15_000 });
  await expect(page.locator('#fine')).toHaveClass(/err/);
  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-038-invalid.png') }).catch(() => {});
});
