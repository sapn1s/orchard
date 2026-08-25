/**
 * BUG-025 — a 👤-owned ticket is board STATUS ("user-owned"), not automatically
 * a QUESTION. The FEAT-018 first cut wrongly made every 👤 row an answerable
 * rail card (title + a blank "Your response…" field that asks nothing — the
 * only sane reply was "ok"). The fix (`src/server/board.ts` + `public/app.js`):
 *
 *   - a 👤 ticket is answerable ONLY when it carries a `## Question` section
 *     (parsed into `question` + optional bulleted `options`);
 *   - a bare 👤 ticket (no `## Question`) renders as a READ-ONLY attention
 *     row — title + an "open ticket" link — never a textarea.
 *
 * Real browser (Playwright + system Brave, see playwright.config.ts) against a
 * REAL scratch server + REAL files on disk — no mocking of the board reader or
 * the rail render. This spec is NON-VACUOUS: on pre-fix code the bare-👤
 * ticket renders WITH a `textarea.nc-input` (proven in this ticket's Activity
 * log by git-stashing the fix and re-running `verify:needs-you-rail`, which
 * this spec pairs with as the CDP-level anti-regression check).
 *
 *   npx playwright test scripts/qa/BUG-025-needs-you-question.spec.ts
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

// This project's tsconfig has no DOM lib for server/scripts code; `page.evaluate`
// callbacks below run in the BROWSER, where `document` genuinely exists.
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

const STATUS_ID = 'BUG-901';
const QUESTION_ID = 'BUG-902';

let server: ChildProcess | null = null;
let BASE = '';
let PORT = 0;
let DATA = '';
let WORK = '';
const cleanupDirs: string[] = [];

test.beforeAll(async () => {
  PORT = await freePort(); // never 4317, the live systemd service
  BASE = `http://127.0.0.1:${PORT}`;
  DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug025-data-'));
  WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug025-work-'));
  cleanupDirs.push(DATA, WORK);

  // Seed docs/bugs/: one bare 👤 ticket (STATUS_ID, no `## Question`) and one
  // 👤 ticket that poses an explicit `## Question` with two bulleted options.
  const bugs = path.join(WORK, 'docs', 'bugs');
  fs.mkdirSync(bugs, { recursive: true });
  fs.writeFileSync(path.join(bugs, 'INDEX.md'),
    `# Board\n\n## Open\n\n` +
    `| ID | Title | Owner | Status | Sev |\n|----|-------|-------|--------|-----|\n` +
    `| ${STATUS_ID} | user to sign off the new pricing page copy | 👤 | user-owned | low |\n` +
    `| ${QUESTION_ID} | should retries back off linearly or exponentially? | 👤 | needs decision | med |\n\n` +
    `## Done (committed)\n\n| ID | Title | Commit |\n|----|-------|--------|\n`);
  fs.writeFileSync(path.join(bugs, `${STATUS_ID}-pricing-copy.md`),
    `# ${STATUS_ID} — user to sign off the new pricing page copy\n\n` +
    `- **Status:** OPEN\n- **Severity:** low\n\n` +
    `## Activity log (APPEND-ONLY)\n\n### 2026-08-04 — orchestrator\n- marked 👤: user to review the copy in the PR, no decision embedded.\n`);
  fs.writeFileSync(path.join(bugs, `${QUESTION_ID}-retry-backoff.md`),
    `# ${QUESTION_ID} — should retries back off linearly or exponentially?\n\n` +
    `- **Status:** OPEN\n- **Severity:** med\n\n` +
    `## Question\nShould the retry loop back off linearly or exponentially?\n` +
    `- linear\n- exponential\n\n` +
    `## Activity log (APPEND-ONLY)\n\n### 2026-08-04 — orchestrator\n- filed, needs a real decision.\n`);

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

test('a bare 👤 ticket renders read-only (no answer box); a `## Question` ticket renders answerable', async ({ page }) => {
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: WORK, name: 'qa-bug025' }),
  })).json() as { project?: { id: string } };
  const projectId = reg.project?.id;
  expect(projectId, `project registration failed: ${JSON.stringify(reg)}`).toBeTruthy();

  await bootToProject(page, projectId!);

  // Server-side precondition (BUG-025): the board reader only attaches a
  // `question` to the ticket that actually carries a `## Question` section.
  const board = await (await fetch(`${BASE}/api/projects/${projectId}/board`)).json() as any;
  const statusItem = board.needsYou?.find((x: any) => x.id === STATUS_ID);
  const questionItem = board.needsYou?.find((x: any) => x.id === QUESTION_ID);
  expect(statusItem, 'the bare ticket must still be a needsYou item').toBeTruthy();
  expect(statusItem.question, 'a bare 👤 ticket (no ## Question) must carry NO question').toBeUndefined();
  expect(questionItem?.question).toContain('back off linearly or exponentially');
  expect(questionItem?.options).toEqual(['linear', 'exponential']);

  await page.waitForSelector('#railNeeds .needs-card', { timeout: 20_000 });

  // ---- (a) the bare 👤 STATUS ticket: read-only row, NO response box ----
  const statusCard = page.locator(`#railNeeds .needs-card[data-id="${STATUS_ID}"]`);
  await expect(statusCard).toBeVisible();
  expect(await statusCard.getAttribute('data-kind')).toBe('status');
  await expect(statusCard.locator('textarea.nc-input')).toHaveCount(0);
  await expect(statusCard.locator('.nc-title')).toHaveText(/pricing page copy/);
  const openLink = statusCard.locator('a.nc-send');
  await expect(openLink).toBeVisible();
  const href = await openLink.getAttribute('href');
  /*
   * FEAT-058 superseded the destination, not the guarantee. BUG-025's guarantee
   * is that this affordance is REAL — it identifies the ticket and goes
   * somewhere, rather than being a decorative `#`. It used to point at
   * `file://<path>`, which at best opened raw markdown; it now deep-links into
   * the ticket dashboard, where the same ticket is rendered with its activity
   * log and the reopen/note actions, and (being a real anchor with
   * target=_blank) opens in a SECOND TAB so this session stays live. The file
   * on disk is still named — on the tooltip — so the row still tells you which
   * bytes an agent is reading.
   */
  expect(href, 'the status row must deep-link to THIS ticket in the dashboard').toBe(
    `#/tickets/${STATUS_ID}?project=${projectId}`,
  );
  expect(await openLink.getAttribute('target'), 'it must open in a second tab').toBe('_blank');
  expect(await openLink.getAttribute('title'), 'and must still name the ticket file on disk')
    .toContain(`${STATUS_ID}-pricing-copy.md`);

  // ---- (b) the `## Question` ticket: answerable, question text + options + answer field ----
  const qCard = page.locator(`#railNeeds .needs-card[data-id="${QUESTION_ID}"]`);
  await expect(qCard).toBeVisible();
  await expect(qCard.locator('textarea.nc-input')).toHaveCount(1);
  await expect(qCard.locator('.nc-question')).toHaveText(/back off linearly or exponentially/);
  await expect(qCard.locator('.nc-opt')).toHaveCount(2);

  const ticketPath = path.join(WORK, 'docs', 'bugs', `${QUESTION_ID}-retry-backoff.md`);
  const before = fs.readFileSync(ticketPath, 'utf8');
  const ANSWER = `go exponential — bug025-answer-${Date.now()}`;
  await qCard.locator('textarea.nc-input').fill(ANSWER);
  await qCard.locator('.nc-send').click();

  await expect(page.locator(`#railNeeds .needs-card[data-id="${QUESTION_ID}"]`)).toHaveCount(0, { timeout: 20_000 });
  // The unrelated status card must be untouched by answering a different ticket.
  await expect(statusCard).toBeVisible();

  await expect.poll(() => fs.readFileSync(ticketPath, 'utf8'), { timeout: 5000 }).toContain(ANSWER);
  const after = fs.readFileSync(ticketPath, 'utf8');
  expect(after.startsWith(before), 'append-only: prior content must survive verbatim, untouched').toBe(true);

  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'BUG-025-status-row.png') }).catch(() => {});
});
