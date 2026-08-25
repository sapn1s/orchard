/**
 * FEAT-063 — the ticket portal is a TRACKER, not a chat.
 *
 * Visual/structural assertions from the ticket (screenshots are the real
 * acceptance artifact — this spec pins the bones so they can't silently
 * regress back into chat DNA):
 *   1. LIST = a real data table: dense one-line rows (row height under a
 *      threshold), all six columns present, and NO chat-bubble markup
 *      anywhere inside #/tickets.
 *   2. ONE toolbar row: the filters and the search field share a single
 *      compact toolbar (#tvSearch lives inside #tvFilters).
 *   3. SORTABLE HEADERS: clicking a column header sorts; clicking it again
 *      reverses. (The old #tvSort select is gone.)
 *   4. KEYBOARD: ↑/↓ move a visible cursor row, Enter opens it.
 *   5. DETAIL = a DOCUMENT: metadata strip (state/status/owner/sev/area/
 *      reported) under the ID+title header, a small right-aligned action
 *      toolbar (not a composer), the Activity log SECTIONED into bordered
 *      dated blocks, and the append-note field a plain form under the log.
 *
 * Non-vacuity: pre-FEAT-063 there is no .hsort, no keyboard cursor, no
 * .tv-logent, and #tvSearch sits in the top bar — 2/3/4/5 fail outright.
 *
 *   npx playwright test scripts/qa/FEAT-063-tracker-visual.spec.ts
 *
 * Never touches :4317; spawns its own server on an OS-assigned free port and
 * kills it by PID, never pkill. Scratch data/store dirs.
 */
import { test, expect } from '@playwright/test';
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
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
const cleanupDirs: string[] = [];

/* ── a small seeded board: enough rows to see the table shape ── */
const IDS = ['BUG-901', 'FEAT-902', 'BUG-903', 'FEAT-904'] as const;

function seedBoard(work: string): void {
  const bugs = path.join(work, 'docs', 'bugs');
  fs.mkdirSync(bugs, { recursive: true });
  fs.writeFileSync(path.join(bugs, 'INDEX.md'),
    `# Board — scratch\n\n## Open\n\n| ID | Title | Owner | Status | Sev |\n|----|----|----|----|----|\n`
    + `| FEAT-902 | export button needs a decision | 👤 | needs decision | high |\n`
    + `| BUG-903 | flaky retry loop under load | 🤖 | building | med |\n`
    + `| FEAT-904 | paginate the audit view | — | queued | low |\n\n`
    + `## Done (committed)\n\n| ID | Title | Commit |\n|----|----|----|\n`
    + `| BUG-901 | pivot table breaks under a Turkish locale | abc1234 |\n`);
  fs.writeFileSync(path.join(bugs, 'BUG-901-pivot-locale.md'),
    `# BUG-901 — pivot table breaks under a Turkish locale\n\n`
    + `- **Status:** VERIFIED / DONE\n- **Severity:** high\n- **Area:** reports\n`
    + `- **Reported:** 2026-08-01 by user\n- **Verified-by:** scripts/verify-pivot.mjs\n\n`
    + `## Symptom\nThe report grid renders empty for some users.\n\n`
    + `## Activity log (APPEND-ONLY)\n\n### 2026-08-02 — agent\n- reproduced under tr-TR.\n\n`
    + `### 2026-08-04 — orchestrator\n- closed after the locale fix landed.\n`);
  fs.writeFileSync(path.join(bugs, 'FEAT-902-export-button.md'),
    `# FEAT-902 — export button needs a decision\n\n- **Status:** OPEN\n- **Severity:** high\n- **Area:** UI\n\n`
    + `## Activity log (APPEND-ONLY)\n\n### 2026-08-03 — orchestrator\n- filed.\n`);
  fs.writeFileSync(path.join(bugs, 'BUG-903-flaky-retry.md'),
    `# BUG-903 — flaky retry loop under load\n\n- **Status:** IN-PROGRESS\n- **Severity:** med\n- **Area:** server\n\n`
    + `## Activity log (APPEND-ONLY)\n\n### 2026-08-05 — agent\n- reproducing.\n`);
  fs.writeFileSync(path.join(bugs, 'FEAT-904-paginate-audit.md'),
    `# FEAT-904 — paginate the audit view\n\n- **Status:** OPEN\n- **Severity:** low\n- **Area:** UI\n\n`
    + `## Activity log (APPEND-ONLY)\n\n### 2026-08-06 — orchestrator\n- queued.\n`);
}

test.beforeAll(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f063-data-'));
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f063-store-'));
  const METH = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f063-meth-'));
  cleanupDirs.push(DATA, STORE, METH);
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE, METHODOLOGY_DIR: METH },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
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

test('the tickets tab has tracker bones — table list, sortable headers, keyboard, document detail', async ({ page }) => {
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f063-proj-'));
  cleanupDirs.push(WORK);
  seedBoard(WORK);
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: WORK, name: 'qa-feat063' }),
  })).json() as { project?: { id: string } };
  const pid = reg.project?.id;
  expect(pid, `registration failed: ${JSON.stringify(reg)}`).toBeTruthy();

  await page.setViewportSize({ width: 1400, height: 860 });
  // FEAT-082: the full tracker table is at /all now (bare #/tickets is the digest).
  await page.goto(`${BASE}/#/tickets/all?project=${pid}`);
  const rows = page.locator('#tvList a.tv-row');
  await expect(rows).toHaveCount(4);

  // ═══ 1. a real data table: dense one-line rows, all columns, no bubbles ═══
  for (const cls of ['.c-id', '.c-title', '.c-own', '.c-status', '.c-sev', '.c-when']) {
    await expect(page.locator(`#tvList .tv-head ${cls}`)).toHaveCount(1);
    await expect(rows.first().locator(cls)).toHaveCount(1);
  }
  const heights = await rows.evaluateAll((els) => els.map((e) => (e as any).getBoundingClientRect().height));
  for (const h of heights) expect(h, 'rows must be DENSE — one line, tracker density').toBeLessThan(34);
  // no chat DNA anywhere inside the tickets surface
  await expect(page.locator('#ticketsView .you, #ticketsView .needs-card, #ticketsView .dock')).toHaveCount(0);

  // ═══ 2. ONE toolbar row — filters + search share #tvFilters ═══
  expect(await page.evaluate(() => document.querySelector('#tvFilters #tvSearch') !== null),
    'the search field must live in the single filters toolbar').toBe(true);
  expect(await page.evaluate(() => document.querySelector('#tvSort')),
    'the sort select is gone — headers sort now').toBeNull();

  // ═══ 3. sortable headers: click = sort, click again = reverse ═══
  const ids = () => rows.evaluateAll((els) => els.map((e) => (e as any).dataset.id));
  await page.locator('#tvList .tv-head .c-id').click();
  expect(await ids()).toEqual(['BUG-901', 'BUG-903', 'FEAT-902', 'FEAT-904']);
  await page.locator('#tvList .tv-head .c-id').click();
  expect(await ids()).toEqual(['FEAT-904', 'FEAT-902', 'BUG-903', 'BUG-901']);
  await expect(page.locator('#tvList .tv-head .c-id')).toHaveAttribute('aria-sort', 'descending');
  // severity: first click = ascending (low → high)
  await page.locator('#tvList .tv-head .c-sev').click();
  const bySev = await rows.evaluateAll((els) => els.map((e) => (e as any).querySelector('.c-sev').textContent));
  expect(bySev).toEqual(['low', 'med', 'high', 'high']);
  // activity: switching TO it from another column gives its intuitive
  // default — newest first (direction toggling is proven on ID above)
  await page.locator('#tvList .tv-head .c-when').click();
  expect(await ids()).toEqual(['FEAT-904', 'BUG-903', 'BUG-901', 'FEAT-902']); // newest activity first

  // ═══ 4. keyboard: ↑/↓ move a visible cursor, Enter opens ═══
  await page.locator('#tvList').click({ position: { x: 8, y: 4 } }); // blur any control
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(0)).toHaveClass(/kb/);
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toHaveClass(/kb/);
  await expect(rows.nth(0)).not.toHaveClass(/kb/);
  await page.keyboard.press('Enter');
  await expect(page.locator('#tvDetail .tv-doc')).toHaveAttribute('data-id', 'BUG-903');
  await page.goBack();
  await expect(rows).toHaveCount(4);
  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-063-list.png') }).catch(() => {});

  // ═══ 5. detail = a document with a metadata header ═══
  await page.goto(`${BASE}/#/tickets/BUG-901?project=${pid}`);
  const doc = page.locator('#tvDetail .tv-doc');
  await expect(doc).toHaveAttribute('data-id', 'BUG-901');
  // metadata strip: state badge + the file-only facts (reported / verified-by)
  const meta = doc.locator('.tv-dmeta');
  await expect(meta.locator('.d-badge')).toHaveText('Done');
  await expect(meta).toContainText('2026-08-01 by user');
  await expect(meta).toContainText('scripts/verify-pivot.mjs');
  await expect(meta.locator('.d-sev')).toHaveText('high');
  // the action toolbar is small and right-aligned in the header, not a composer
  const tools = doc.locator('.tv-tools');
  await expect(tools.locator('#tvReopenBtn')).toBeVisible();
  await expect(tools.locator('#tvFlagBtn')).toBeVisible();
  const geo = await page.evaluate(() => {
    const t = document.querySelector('.tv-tools').getBoundingClientRect();
    const d = document.querySelector('#tvDetail .tv-doc').getBoundingClientRect();
    return { toolsRight: t.right, docRight: d.right, toolsMid: t.left - d.left, docWidth: d.width };
  });
  expect(geo.toolsMid, 'the toolbar sits in the RIGHT half of the document').toBeGreaterThan(geo.docWidth / 2);
  // the Activity log is SECTIONED: bordered dated blocks with heading headers
  const ents = doc.locator('.tv-md .tv-log .tv-logent');
  await expect(ents).toHaveCount(2);
  await expect(ents.first().locator('.tv-logent-h')).toContainText('2026-08-02 — agent');
  await expect(ents.first()).toContainText('reproduced under tr-TR');
  const border = await ents.first().evaluate((e: any) => getComputedStyle(e).borderTopWidth);
  expect(border, 'each dated entry is a BORDERED block').toBe('1px');
  // the append-note field is a plain form under the log, with its own submit
  const form = doc.locator('.tv-noteform');
  await expect(form.locator('textarea.tv-note')).toBeVisible();
  await expect(form.locator('#tvNoteBtn')).toBeVisible();
  expect(await page.evaluate(() => {
    const f = document.querySelector('.tv-noteform').getBoundingClientRect();
    const l = document.querySelector('.tv-md .tv-log').getBoundingClientRect();
    return f.top >= l.bottom;
  }), 'the note form sits UNDER the activity log — chronology, not a composer dock').toBe(true);
  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-063-detail.png') }).catch(() => {});
});
