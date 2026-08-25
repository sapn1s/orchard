/**
 * FEAT-040 — session-state legibility, both halves against the REAL server.
 *
 * Human half (public/app.js + styles.css): an ALWAYS-present `#sessStatus`
 * affordance near the crown/composer that names the session's real state
 * with a DISTINCT label per state, so a transitional state never reads as
 * "broken". This drives a real session through several of those states and
 * asserts the affordance's `data-state`/label — never internal JS fields —
 * per WORKING_AGREEMENT §C (user-observable).
 *
 * Machine half (GET /api/health + scripts/station-doctor.mjs): the SAME
 * ground truth, read straight off the server rather than a hand-rolled
 * PPID/`ps` check (the exact mistake FEAT-040's Activity log records as
 * having falsely declared FEAT-015 broken).
 *
 * This spec is NON-VACUOUS: `#sessStatus` did not exist in the DOM at all
 * before this ticket, and `/api/health`'s `sessions[]` array is new — both
 * assertions fail outright (element not found / field undefined) against the
 * pre-FEAT-040 code, not just "wrong value".
 *
 *   npx playwright test scripts/qa/feat-040-session-status.spec.ts
 *
 * Never touches :4317 (the live systemd service); spawns its own server on
 * an OS-assigned free port and kills it by PID, never pkill.
 */
import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

// This project's tsconfig has no DOM lib (server/scripts are Node-only) —
// `page.evaluate` callbacks below run in the BROWSER, where `document`
// genuinely exists. Declare it locally, typed `any`, scoped to this file.
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

/** dataset.state of #sessStatus right now, or null if the element is missing. */
async function sessState(page: Page): Promise<string | null> {
  return page.evaluate(() => (document.querySelector('#sessStatus') as any)?.dataset?.state ?? null);
}

/**
 * Was `#sessStatus` EVER in state `want` within `timeoutMs`? A transient
 * state (thinking, detached) can come and go between two `expect.poll`
 * ticks — this catches it by polling as fast as the round trip allows rather
 * than checking only the value at the deadline.
 */
async function sawState(page: Page, want: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await sessState(page)) === want) return true;
  }
  return false;
}

/**
 * A window-of-time state can be SHORTER than a single page.evaluate round
 * trip (the WS reconnect + ack round trip to a same-host server can resolve
 * in single-digit ms — faster than polling from a separate test process can
 * reliably sample). A `MutationObserver` on `#sessStatus`'s `data-state`
 * attribute, installed IN-PAGE before the triggering action, catches every
 * value the DOM ever actually held — no round-trip gap to fall through.
 */
async function recordStates(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.querySelector('#sessStatus') as any;
    (globalThis as any).__feat040States = [el?.dataset?.state];
    const obs = new (globalThis as any).MutationObserver(() => {
      (globalThis as any).__feat040States.push(el?.dataset?.state);
    });
    obs.observe(el, { attributes: true, attributeFilter: ['data-state'] });
    (globalThis as any).__feat040Obs = obs;
  });
}
async function stopRecording(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    (globalThis as any).__feat040Obs?.disconnect();
    return (globalThis as any).__feat040States ?? [];
  });
}

let server: ChildProcess | null = null;
let BASE = '';
let PORT = 0;
let DATA = '';
let WORK = '';
const cleanupDirs: string[] = [];

test.beforeAll(async () => {
  PORT = await freePort(); // never 4317, the live systemd service
  BASE = `http://127.0.0.1:${PORT}`;
  DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat040-data-'));
  WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat040-work-'));
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

test('the session-status affordance names each real state, and GET /api/health + `station doctor` report the same ground truth', async ({ page }) => {
  // ---- 1. a scratch project, cheap+ungated (haiku, bypassPermissions, direct isolation) ----
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: WORK, name: 'qa-feat040-session-status' }),
  })).json() as { project?: { id: string } };
  const projectId = reg.project?.id;
  expect(projectId, `project registration failed: ${JSON.stringify(reg)}`).toBeTruthy();
  await (await fetch(`${BASE}/api/projects/${projectId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'haiku', permissionMode: 'bypassPermissions' }),
  })).json();

  await bootToProject(page, projectId!);

  // ---- 2. IDLE — genuinely nothing running, before any turn ----
  await expect(page.locator('#sessStatus')).toBeVisible();
  expect(await sessState(page), 'affordance must start idle with no session open').toBe('idle');
  await expect(page.locator('#sessStatusLbl')).toHaveText('Idle');

  const marker = path.join(WORK, 'feat040.marker');

  // ---- 3. THINKING — busy, no reply text yet. Forcing a tool call FIRST
  //          (never any text-delta before it) keeps the turn genuinely in
  //          "thinking" for the whole sleep, long enough to observe. ----
  const prompt = [
    'STRICT INSTRUCTIONS — follow exactly:',
    `Step 1: call the Bash tool exactly once, with command \`sleep 9 && echo done > ${marker}\`. Do not say anything before this tool call.`,
    'Step 2: once it returns, reply with exactly the text FEAT040-DONE and nothing else.',
  ].join('\n');
  await page.locator('#prompt').fill(prompt);
  await page.locator('#go').click();

  expect(
    await sawState(page, 'thinking', 6000),
    'the affordance never showed "thinking" while the turn was busy with no reply text yet',
  ).toBe(true);
  await expect(page.locator('#sessStatusLbl')).toHaveText('Thinking…');
  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-040-thinking.png') }).catch(() => {});

  await page.waitForFunction(() => !!(globalThis as any).__station.state.sdkSessionId, undefined, { timeout: 30_000 });
  const sdkSessionId: string = await page.evaluate(() => (globalThis as any).__station.state.sdkSessionId);
  expect(sdkSessionId, 'no real sdkSessionId — the live turn never actually started').toBeTruthy();

  // ---- 4. machine half, mid-turn: GET /api/health must report this exact
  //          session as busy, with isolation + a survival verdict that is a
  //          real cgroup-membership check, not a claim. ----
  const healthMid = await (await fetch(`${BASE}/api/health`)).json() as any;
  expect(Array.isArray(healthMid.sessions), '/api/health must carry a sessions[] array (FEAT-040)').toBe(true);
  const midEntry = healthMid.sessions.find((s: any) => s.sdkSessionId === sdkSessionId);
  expect(midEntry, 'the live session is missing from /api/health while genuinely busy').toBeTruthy();
  expect(midEntry.isolation).toBe('direct');
  expect(midEntry.busy).toBe(true);
  expect(typeof midEntry.survivalConfigured).toBe('boolean');
  // survivalScoped is GROUND TRUTH from a live /proc/<pid>/cgroup read — must
  // be a real verdict (boolean) whenever survival was actually attempted, and
  // is never allowed to just echo `survivalConfigured` back (that would be
  // the claim, not the verification).
  if (midEntry.survivalConfigured) {
    expect(midEntry.broker, 'survivalConfigured true but no broker reported').toBeTruthy();
    expect(typeof midEntry.broker.hostPid).toBe('number');
    expect(typeof midEntry.survivalScoped).toBe('boolean');
  } else {
    expect(midEntry.survivalScoped).toBe(null);
  }

  // ---- 5. `station doctor` prints the SAME ground truth, human-readable ----
  const doctorRun = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'station-doctor.mjs'), '--port', String(PORT)], { encoding: 'utf8', timeout: 15000 });
  expect(doctorRun.status, `station doctor exited non-zero: ${doctorRun.stderr}`).toBe(0);
  const out = doctorRun.stdout;
  expect(out).toContain(sdkSessionId.slice(0, 8));
  expect(out).toContain('isolation');
  expect(out).toContain('direct');
  expect(out).toContain('GROUND TRUTH');
  expect(out.toLowerCase()).toContain('busy');

  // Also prove the npm-script wiring itself (`npm run doctor`) is real, not
  // just the underlying file — smoke-check only (npm's own banner noise
  // makes exact assertions brittle, so this checks the doctor's own header).
  const npmRun = spawnSync('npm', ['run', 'doctor', '--', '--port', String(PORT), '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 20000 });
  expect(npmRun.status, `npm run doctor exited non-zero: ${npmRun.stderr}`).toBe(0);
  const npmJson = JSON.parse(npmRun.stdout.slice(npmRun.stdout.indexOf('{')));
  expect(npmJson.ok).toBe(true);
  expect(Array.isArray(npmJson.sessions)).toBe(true);

  // ---- 6. the real action this ticket is named after: a reload mid-turn.
  //          Right after reload, before this tab re-drives anything, the
  //          session is DETACHED (running headless) — not blank/broken. ----
  await page.reload();
  await page.waitForFunction(() => (globalThis as any).__station !== undefined, undefined, { timeout: 30_000 });
  await page.waitForFunction(
    (sid) => (globalThis as any).__station.state.current.sessionId === sid,
    sdkSessionId,
    { timeout: 30_000 },
  );
  expect(
    await sawState(page, 'detached', 8000),
    'after a reload of a still-running session, the affordance never showed "detached" — a transitional state read as broken/blank instead',
  ).toBe(true);
  await expect(page.locator('#sessStatusLbl')).toHaveText('Running in background');
  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-040-detached.png') }).catch(() => {});

  // ---- 7. the real recovery gesture: type + Enter re-attaches. That drives
  //          resumeSessionId through connect() — RECONNECTING before the
  //          live stream resumes — then STREAMING once the final reply's
  //          text starts arriving, then back to IDLE at turn-end. The
  //          reconnecting window can be shorter than a single test-process
  //          round trip (a same-host WS handshake + ack), so this is
  //          recorded with an in-page MutationObserver rather than polled
  //          from outside — see recordStates()'s doc comment. ----
  await page.locator('#prompt').fill('continue');
  await recordStates(page);
  await page.locator('#prompt').press('Enter');
  await expect.poll(() => sessState(page), { timeout: 20_000 }).toBe('idle');
  const seenStates = await stopRecording(page);
  expect(
    seenStates,
    'reattaching after a reload never showed "reconnecting" at any point — the gap read as blank/broken instead',
  ).toContain('reconnecting');
  expect(
    seenStates,
    'the final reply never showed "streaming" at any point once its text started arriving',
  ).toContain('streaming');
  await expect(page.locator('#sessStatusLbl')).toHaveText('Idle');

  for (let i = 0; i < 50 && !fs.existsSync(marker); i++) await sleep(200);
  expect(fs.existsSync(marker), 'the sub-turn marker never landed on disk — the reload/reattach interrupted real work').toBe(true);

  // ---- 8. machine half, after the fact: /api/health now shows this session idle ----
  const healthAfter = await (await fetch(`${BASE}/api/health`)).json() as any;
  const afterEntry = healthAfter.sessions.find((s: any) => s.sdkSessionId === sdkSessionId);
  if (afterEntry) {
    expect(afterEntry.busy).toBe(false);
    expect(afterEntry.state).toBe('idle');
  }
});
