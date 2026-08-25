/**
 * FEAT-022 — autonomous mode: an EXPLICITLY chosen never-pause loop with a
 * MANDATORY bounded stop condition (WA §M), against the REAL server + a REAL
 * driven session (haiku, so it is cheap and a hard turn cap keeps a runaway
 * from spinning).
 *
 * What this proves, user-observable (WA §C):
 *   1. INTERACTIVE by default — a live session shows the "Autonomous" toggle,
 *      no running badge, body not marked autonomous, and the server reports
 *      {autonomous:false}. (Non-vacuous: #autoBtn did not exist in the DOM and
 *      /api/sessions/:id/autonomous returned 404 before this ticket.)
 *   2. ENABLE + VISIBLE + PERSIST across a reload — arming autonomous with a
 *      stop condition lights an UNMISTAKABLE badge, and the mode survives a
 *      page reload of a still-live session (re-read from the server).
 *   3. LOOP ADVANCES then HALTS — with "stop after 2 turns", the server
 *      auto-continues the turn twice WITHOUT a human, then HALTS exactly at the
 *      stop condition (stopReason:'turns-reached'), returning to interactive.
 *      The halt is ASSERTED and shown to be STABLE — an unbounded loop that
 *      never stops is a FAIL, so this proves it stopped and stays stopped.
 *   4. STOP returns to interactive at any time.
 *
 *   npx playwright test scripts/qa/FEAT-022-autonomous-mode.spec.ts
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

// page.evaluate callbacks run in the BROWSER, where `document` exists; this
// project's tsconfig has no DOM lib (Node-only server/scripts).
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
let PORT = 0;
let DATA = '';
let WORK = '';
const cleanupDirs: string[] = [];

/** The server's authoritative autonomous state for a station session id. */
async function serverAuto(stationId: string): Promise<any> {
  const r = await fetch(`${BASE}/api/sessions/${encodeURIComponent(stationId)}/autonomous`);
  if (r.status === 404) return { __missing: true };
  return r.json();
}

test.beforeAll(async () => {
  PORT = await freePort(); // never 4317, the live systemd service
  BASE = `http://127.0.0.1:${PORT}`;
  DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat022-data-'));
  WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat022-work-'));
  cleanupDirs.push(DATA, WORK);
  cleanupDirs.push(path.join(os.homedir(), '.claude', 'projects', WORK.replace(/[^a-zA-Z0-9]/g, '-')));

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

async function bootToProject(page: Page, projectId: string): Promise<void> {
  await page.goto(`${BASE}/#/project/${projectId}`);
  await page.waitForFunction(() => (globalThis as any).__station !== undefined);
  await page.waitForFunction(
    (pid) => (globalThis as any).__station.state.current.projectId === pid,
    projectId,
  );
}

const stationId = (page: Page) => page.evaluate(() => (globalThis as any).__station.state.stationSessionId);
const autoMirror = (page: Page) => page.evaluate(() => (globalThis as any).__station.state.autonomous);

test('a session is interactive by default; autonomous is a visible, bounded, halting loop; Stop returns to interactive', async ({ page }) => {
  test.setTimeout(600_000);
  {
    // ---- scratch project: cheap + ungated (haiku, bypassPermissions, direct) ----
    const reg = await (await fetch(`${BASE}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostPath: WORK, name: 'qa-feat022-autonomous' }),
    })).json() as { project?: { id: string } };
    const projectId = reg.project?.id;
    expect(projectId, `project registration failed: ${JSON.stringify(reg)}`).toBeTruthy();
    // maxBudgetUsd is a belt-and-suspenders runaway net; the REAL hard cap is
    // the autonomous stop-after-N. haiku turns cost ~$0.0005, far under this.
    await (await fetch(`${BASE}/api/projects/${projectId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'haiku', permissionMode: 'bypassPermissions', maxBudgetUsd: 0.25 }),
    })).json();

    await bootToProject(page, projectId!);

    // ======================================================================
    // PHASE 1 — INTERACTIVE BY DEFAULT
    // ======================================================================
    // Drive one short turn so a live session exists (the affordance shows only
    // for a session this tab drives).
    await page.locator('#prompt').fill('Reply with exactly OK and nothing else.');
    await page.locator('#go').click();
    await page.waitForFunction(() => !!(globalThis as any).__station.state.sdkSessionId, undefined, { timeout: 30_000 });
    await page.waitForFunction(() => !!(globalThis as any).__station.state.stationSessionId, undefined, { timeout: 30_000 });
    // turn settles → idle
    await expect.poll(() => page.evaluate(() => (globalThis as any).__station.state.busy), { timeout: 40_000 }).toBe(false);

    const sid = await stationId(page);
    expect(sid, 'no station session id captured from the start ack').toBeTruthy();

    // The affordance exists (it did NOT before this ticket) and reads interactive.
    await expect(page.locator('#autoBtn')).toBeVisible();
    await expect(page.locator('#autoBtn')).toHaveText('Autonomous');
    await expect(page.locator('.auto-badge')).toBeHidden();
    expect(await page.evaluate(() => document.body.dataset.autonomous), 'body must not read autonomous by default').not.toBe('1');
    expect((await autoMirror(page)).autonomous, 'client mirror must default interactive').toBe(false);

    // Server ground truth: interactive, and the route EXISTS (404 pre-ticket).
    const s0 = await serverAuto(sid);
    expect(s0.__missing, 'the /autonomous route must exist').toBeFalsy();
    expect(s0.autonomous, 'server must report interactive by default').toBe(false);
    expect(s0.maxTurns, 'no stop condition while interactive').toBe(null);

    // ======================================================================
    // PHASE 2 — ENABLE (via the UI) + VISIBLE + PERSIST ACROSS RELOAD
    // ======================================================================
    // Kick a LONG turn so the session stays busy (it will DETACH — and survive —
    // across a reload, letting us prove the mode persisted). marker proves the
    // sub-turn's real work was not lost.
    const marker = path.join(WORK, 'feat022.marker');
    await page.locator('#prompt').fill(
      `Call the Bash tool exactly once with command \`sleep 14 && echo done > ${marker}\`, then reply DONE.`,
    );
    await page.locator('#go').click();
    await expect.poll(() => page.evaluate(() => (globalThis as any).__station.state.busy), { timeout: 30_000 }).toBe(true);

    // Arm autonomous THROUGH THE REAL AFFORDANCE: open the form, set 2 turns, Start.
    await page.locator('#autoBtn').click();
    await page.locator('#autoTurns').fill('2');
    await page.locator('#autoStart').click();

    await expect(page.locator('.auto-badge')).toBeVisible();
    await expect(page.locator('.auto-badge .txt')).toHaveText('AUTONOMOUS 0/2');
    await expect(page.locator('#autoBtn')).toHaveText('Stop');
    expect(await page.evaluate(() => document.body.dataset.autonomous), 'body must read autonomous when armed').toBe('1');
    await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-022-autonomous-on.png') }).catch(() => {});

    const s1 = await serverAuto(sid);
    expect(s1.autonomous, 'server must report autonomous armed').toBe(true);
    expect(s1.maxTurns, 'stop condition must be recorded').toBe(2);

    // RELOAD while still busy — the session detaches and survives; the mode must
    // survive with it. Prove it on the SERVER (the durable record) directly.
    await page.reload();
    await page.waitForFunction(() => (globalThis as any).__station !== undefined, undefined, { timeout: 30_000 });
    const sPersist = await serverAuto(sid);
    expect(sPersist.autonomous, 'autonomous mode did NOT persist across a reload of the live session').toBe(true);
    expect(sPersist.maxTurns, 'the stop condition was lost across the reload').toBe(2);

    // Stop it now (before the long turn ends) so Phase 3 starts from a clean,
    // interactive slate and the loop does not run on this long turn. Uses the
    // server route directly — the tab is not re-driving this session.
    const stopResp = await (await fetch(`${BASE}/api/sessions/${encodeURIComponent(sid)}/autonomous`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'stop' }),
    })).json() as any;
    expect(stopResp.ok).toBe(true);
    expect(stopResp.autonomous.autonomous, 'Stop must return to interactive').toBe(false);
    expect(stopResp.autonomous.stopReason).toBe('manual');

    // Let the detached long turn finish + self-close so it cannot bleed into the
    // next phase. marker confirms its real work completed (reload didn't kill it).
    for (let i = 0; i < 90 && !fs.existsSync(marker); i++) await sleep(300);
    expect(fs.existsSync(marker), 'the sub-turn marker never landed — the reload interrupted real work').toBe(true);
    await sleep(4000); // close-on-detach grace

    // ======================================================================
    // PHASE 3 — THE LOOP ADVANCES, THEN HALTS AT THE STOP CONDITION
    // ======================================================================
    // Re-open the SAME session fresh (the detached one has closed). A new live
    // session, interactive by default.
    await page.goto(`${BASE}/#/project/${projectId}`);
    await page.waitForFunction(() => (globalThis as any).__station !== undefined, undefined, { timeout: 30_000 });
    await page.waitForFunction((pid) => (globalThis as any).__station.state.current.projectId === pid, projectId);

    await page.locator('#prompt').fill('Reply with exactly READY and nothing else.');
    await page.locator('#go').click();
    await page.waitForFunction(() => !!(globalThis as any).__station.state.stationSessionId, undefined, { timeout: 30_000 });
    const sid3 = await stationId(page);
    await expect.poll(() => page.evaluate(() => (globalThis as any).__station.state.busy), { timeout: 40_000 }).toBe(false);

    // Arm autonomous with a stop-after-2 budget via the affordance.
    await page.locator('#autoBtn').click();
    await page.locator('#autoTurns').fill('2');
    await page.locator('#autoStart').click();
    await expect(page.locator('.auto-badge')).toBeVisible();
    expect((await serverAuto(sid3)).autonomous).toBe(true);

    // Kick the loop with ONE human turn. From here the SERVER auto-continues —
    // no further human input — up to 2 turns, then halts.
    await page.locator('#prompt').fill('Begin. Reply with a single short line.');
    await page.locator('#go').click();

    // ADVANCE: the loop drives turns without us until it reaches the cap. Poll
    // the server: turnsDone must climb to 2.
    await expect.poll(async () => (await serverAuto(sid3)).turnsDone, { timeout: 90_000, intervals: [500] })
      .toBe(2);

    // HALT: at the cap the server returns to interactive with a concrete reason.
    await expect.poll(async () => (await serverAuto(sid3)).autonomous, { timeout: 30_000, intervals: [500] })
      .toBe(false);
    const halted = await serverAuto(sid3);
    expect(halted.stopReason, 'the loop must halt for the RIGHT reason — the declared turn cap, not a budget/error accident').toBe('turns-reached');
    expect(halted.turnsDone, 'the loop must have advanced exactly the capped number of turns').toBe(2);

    // HALT IS STABLE — the loop is genuinely STOPPED, not merely between ticks.
    // An unbounded loop would keep advancing; assert it does not for a good while.
    await expect.poll(() => page.evaluate(() => (globalThis as any).__station.state.busy), { timeout: 40_000 }).toBe(false);
    const t0 = (await serverAuto(sid3)).turnsDone;
    await sleep(7000);
    const t1 = await serverAuto(sid3);
    expect(t1.turnsDone, 'the loop kept spinning after its stop condition — FAIL (this is an unbounded loop)').toBe(t0);
    expect(t1.autonomous, 'the session must stay interactive after halting').toBe(false);
    expect(await page.evaluate(() => (globalThis as any).__station.state.busy)).toBe(false);

    // The UI reflects the halt (interactive again).
    await expect(page.locator('#autoBtn')).toHaveText('Autonomous');
    await expect(page.locator('.auto-badge')).toBeHidden();
    await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-022-halted.png') }).catch(() => {});

    // ======================================================================
    // PHASE 4 — Stop returns to interactive on demand (re-arm, then Stop).
    // ======================================================================
    await page.locator('#autoBtn').click();
    await page.locator('#autoTurns').fill('5');
    await page.locator('#autoStart').click();
    await expect(page.locator('.auto-badge')).toBeVisible();
    expect((await serverAuto(sid3)).autonomous).toBe(true);
    await page.locator('#autoBtn').click(); // now labelled "Stop"
    await expect.poll(async () => (await serverAuto(sid3)).autonomous, { timeout: 15_000 }).toBe(false);
    await expect(page.locator('#autoBtn')).toHaveText('Autonomous');
    await expect(page.locator('.auto-badge')).toBeHidden();
  }
});
