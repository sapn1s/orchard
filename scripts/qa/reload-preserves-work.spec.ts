/**
 * FIRST self-QA journey (FEAT-032 #2 + FEAT-033 Playwright adoption, shipped
 * together): the "reload during active work" bug CLASS that bit the user
 * directly and cost two tickets to fix —
 *
 *   BUG-017: a reload of a LIVE session showed the historical "N agents ran"
 *   summary INSTEAD of the conversation.
 *   BUG-020: a reload while a sub-agent (Task tool) was in flight left the
 *   reattached client's "agents running" strip silently blank — the
 *   sub-agent was never killed, but the client never learned it existed.
 *
 * Both are now fixed (public/app.js's live/gap guards; the server's
 * replayAgents() on reattach). This spec is the PERMANENT regression guard
 * for that whole class, driven from the user's seat: a real scratch server,
 * a real cheap (haiku) session that spawns a real Task-tool sub-agent so the
 * session is genuinely mid-turn, a real `page.reload()`, then the exact
 * recovery gesture a returning user performs (type + Enter, which
 * auto-supplies `resumeSessionId` and drives the real reattach handshake).
 *
 * Assertions are on the USER-OBSERVABLE surface (role/name, DOM structure),
 * per WORKING_AGREEMENT §C, not on server events:
 *   (a) after reload+reattach, the CONVERSATION renders — no historical
 *       "N agents ran" summary node is spliced in over live work (BUG-017's
 *       invariant: that summary must never REPLACE a live conversation).
 *   (b) the running-agents strip re-shows the in-flight sub-agent, by
 *       role/name (BUG-020).
 *
 * Honest scope note: BUG-017's own regression script
 * (scripts/verify-reload-live-summary.mjs) additionally manufactures a deep
 * scroll index + a padded transcript to force the narrow forward-`gap` path
 * that its fix specifically closes — that fixture-heavy edge case is left to
 * that script. This journey instead exercises the ordinary, most common
 * shape of the bug class end-to-end (a genuinely short, freshly-started live
 * session, reloaded near its tail, mid-turn) and asserts the same
 * conversation-over-summary invariant plus the strip backfill in one real
 * user-shaped pass — the two are complementary, not duplicates.
 *
 *   npm run qa:sweep
 *   npx playwright test scripts/qa/reload-preserves-work.spec.ts
 *
 * Brave is reused via playwright.config.ts's launchOptions.executablePath —
 * no chromium download. Never touches :4317 (the live systemd service);
 * spawns its own server on an OS-assigned free port and kills it by PID.
 */
import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

// This project's tsconfig has no DOM lib (server/scripts are Node-only) —
// `page.evaluate`/`page.waitForFunction` callbacks below run in the BROWSER,
// where `window` genuinely exists, but tsc typechecking this file has no
// declaration for it. Declare it locally, typed `any`, scoped to this file.
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
  DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-qa-data-'));
  WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-qa-work-'));
  cleanupDirs.push(DATA, WORK);
  // The Agent SDK subprocess that writes transcripts always writes under the
  // real ~/.claude/projects/<encoded cwd>, regardless of CLAUDE_STATION_DATA
  // (learned the hard way in scripts/verify-reattach-agent-backfill.mjs) —
  // sweep that up too.
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

test('reload during an in-flight sub-agent: the conversation stays on screen and the running-agents strip re-shows the sub-agent', async ({ page }) => {
  // ---- 1. register a scratch project, cheap+ungated (haiku, bypassPermissions) ----
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: WORK, name: 'qa-reload-preserves-work' }),
  })).json() as { project?: { id: string } };
  const projectId = reg.project?.id;
  expect(projectId, `project registration failed: ${JSON.stringify(reg)}`).toBeTruthy();
  await (await fetch(`${BASE}/api/projects/${projectId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'haiku', permissionMode: 'bypassPermissions' }),
  })).json();

  // ---- 2. sanity: the composer's static chrome matches its accessible shape
  //         (adopting toMatchAriaSnapshot per FEAT-033 — this region is
  //         deterministic pre-turn, unlike the transcript/strip below, whose
  //         dynamic elapsed-time text would make an exact snapshot flaky) ----
  await bootToProject(page, projectId!);
  await expect(page.locator('#box')).toMatchAriaSnapshot(`
    - textbox "Message Claude":
      - /placeholder: Message Claude…
    - button "Plan first":
      - img
    - button "Skip permission prompts" [pressed]:
      - img
    - button "Choose a model":
      - img
    - button "Project settings":
      - img
    - button "Send message":
      - img
  `);

  const marker = path.join(WORK, 'subagent.marker');

  // ---- 3. a REAL Task-tool sub-agent, genuinely still running when we reload ----
  // The Task tool in this SDK is asynchronous — the orchestrator's own turn
  // does not block on the sub-agent finishing — so the orchestrator is told
  // to keep itself busy with its own sleep afterward. That keeps the whole
  // turn genuinely `busy` (detach-not-close on socket loss) across the
  // reload window while the sub-agent is still mid-flight.
  const prompt = [
    'STRICT INSTRUCTIONS — follow exactly, use the Task tool exactly ONCE in this entire conversation:',
    'Step 1: call the Task tool once with subagent_type "general-purpose" and description exactly "qa-subagent". Its prompt must instruct the sub-agent to do EXACTLY this and nothing else: run one Bash tool call `sleep 8 && echo done > ' + marker + '`, then reply with exactly SUBAGENT-DONE.',
    'Step 2: immediately after the Task call returns (it returns right away, before the sub-agent finishes — do not wait for it, do not call any other tool to check on it), run ONE Bash tool call `sleep 15` yourself, in THIS conversation, then say exactly MAIN-DONE. Then stop completely — send no further tool call of any kind.',
  ].join('\n');

  await page.locator('#prompt').fill(prompt);
  await page.locator('#go').click();

  await page.waitForFunction(
    () => (window as any).__station.state.agents.size >= 1,
    undefined,
    { timeout: 90_000 },
  );
  const runningId = await page.evaluate(() => {
    const entries = [...(window as any).__station.state.agents.entries()];
    const running = entries.find(([, a]: [string, any]) => a.agent.status === 'running');
    return running ? running[0] : null;
  });
  expect(runningId, 'the real Task-tool sub-agent never reached a running state').toBeTruthy();

  const sdkSessionId = await page.evaluate(() => (window as any).__station.state.sdkSessionId);
  expect(sdkSessionId, 'no real sdkSessionId — the live turn never actually started').toBeTruthy();

  // sanity: the strip shows it BEFORE reload (unfixed baseline behaviour —
  // not itself the regression, just confirms the fixture is real)
  await expect(page.locator(`#stripRows button[data-thread="${runningId}"].run`)).toBeVisible();

  // ---- 4. the real action this bug class is named after ----
  await page.reload();
  await page.waitForFunction(() => (window as any).__station !== undefined, undefined, { timeout: 30_000 });
  await page.waitForFunction(
    (sid) => (window as any).__station.state.current.sessionId === sid,
    sdkSessionId,
    { timeout: 30_000 },
  );

  // Honest pre-condition: right after reload, before any reattach, the
  // client genuinely knows nothing yet — this IS the display gap BUG-020
  // describes, not something to paper over before a reattach happens.
  await expect.poll(() => page.evaluate(() => (window as any).__station.state.agents.size)).toBe(0);

  // ---- 5. (a) BUG-017 invariant: the CONVERSATION is on screen, not a
  //          historical "N agents ran" summary replacing it ----
  await expect(page.locator('#panes .pane.on .you, #panes .pane.on .claude').first()).toBeVisible();
  await expect(page.locator('#panes .pane.on .ran-stack')).toHaveCount(0);

  // ---- 6. the real user recovery gesture: type + Enter. This is what
  //          auto-supplies resumeSessionId and drives the actual reattach
  //          handshake (BUG-020's fix site) — a plain click on #go would hit
  //          the interrupt handler instead, since state.busy repaints it. ----
  await page.locator('#prompt').fill('continue');
  await page.locator('#prompt').press('Enter');

  // ---- 7. (b) BUG-020 invariant: the strip re-shows the in-flight sub-agent,
  //          by role/name, promptly on reattach — not eventually "by luck" ----
  const stripRow = page.getByRole('button', { name: /qa-subagent/ });
  await expect(stripRow).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(`#stripRows button[data-thread="${runningId}"]`)).toHaveClass(/run|wait/);

  // ---- 8. the sub-agent genuinely finishes for real afterward (never killed
  //          by the reload) — the strip updates and the marker lands on disk ----
  await expect.poll(
    () => page.evaluate((id) => (window as any).__station.state.agents.get(id)?.agent?.status, runningId),
    { timeout: 45_000 },
  ).not.toBe('running');
  for (let i = 0; i < 50 && !fs.existsSync(marker); i++) await sleep(200);
  expect(fs.existsSync(marker), 'the sub-agent marker file never landed on disk — the reload/reattach interrupted real work').toBe(true);

  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-032-self-qa-after.png') }).catch(() => {});
});
