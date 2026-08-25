/**
 * FEAT-066 — the ticket portal is REACHABLE, uses the VIEWPORT, and has a
 * readable COLOR hierarchy. Three user complaints, three assertions, each of
 * which must FAIL on the pre-FEAT-066 tree (proven by `git stash`):
 *
 *   1. ENTRY — a persistent affordance opens #/tickets from the session view
 *      (the topbar board pill), it navigates there, and Back returns to the
 *      session exactly as it was. Pre-fix: there is no #boardBtn at all.
 *   2. WIDTH — on a wide viewport the detail renders TWO ZONES: a metadata
 *      sidebar to the RIGHT of a full-width content column. Below ~900px it
 *      collapses to one column (metadata strip on top). Pre-fix: the detail is
 *      a single 820px column at every width — the sidebar is never beside the
 *      content.
 *   3. COLOR — the status tag carries a small color language: open (neutral),
 *      needs-you (amber), in-progress (blue), done (green) compute to DISTINCT
 *      colors. Pre-fix: every status tag is the same grey (--ink-3).
 *
 *   npx playwright test scripts/qa/FEAT-066-portal-entry-width-color.spec.ts
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

/* the same seeded board FEAT-063 uses — one ticket per status KIND:
   FEAT-902 = 👤 needs-you · BUG-903 = 🤖 in-progress · FEAT-904 = open ·
   BUG-901 = done. That is exactly the set the color language must distinguish. */
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

async function register(work: string, name: string): Promise<string> {
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: work, name }),
  })).json() as { project?: { id: string } };
  const pid = reg.project?.id;
  expect(pid, `registration failed: ${JSON.stringify(reg)}`).toBeTruthy();
  return pid!;
}

test.beforeAll(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f066-data-'));
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f066-store-'));
  const METH = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f066-meth-'));
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

test('1 — the topbar board pill opens #/tickets and Back returns to the session', async ({ page }) => {
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f066-entry-'));
  cleanupDirs.push(WORK);
  seedBoard(WORK);
  const pid = await register(WORK, 'qa-f066-entry');

  await page.setViewportSize({ width: 1400, height: 860 });
  await page.goto(`${BASE}/#/project/${pid}`);

  // the PERSISTENT entry: a board pill in the crown chips, shown because this
  // project HAS a board. (Pre-fix this element does not exist — the whole point
  // of the ticket: "no option to open it from anywhere in ui".)
  const pill = page.locator('#boardBtn');
  await expect(pill).toBeVisible();
  await expect(pill).toContainText('Board');

  await pill.click();
  await expect(page.locator('#ticketsView')).toBeVisible();
  // FEAT-082: the pill lands on the DIGEST (what awaits you), not the full table.
  await expect(page.locator('#tvDigest .dg-wrap')).toBeVisible();
  expect(page.url()).toContain('#/tickets');

  // Back returns to the session view exactly as it was (the ticket route is a
  // cover, never a teardown) — and the entry pill is there again.
  await page.goBack();
  await expect(page.locator('#ticketsView')).toBeHidden();
  await expect(pill).toBeVisible();

  // second entry point: the rail-head "Open board →" link, same contract
  await expect(page.locator('#railBoardLink')).toBeVisible();
});

test('2 — the detail is two zones wide, one column narrow', async ({ page }) => {
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f066-width-'));
  cleanupDirs.push(WORK);
  seedBoard(WORK);
  const pid = await register(WORK, 'qa-f066-width');

  // ── WIDE: metadata sidebar sits to the RIGHT of the content column ──
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${BASE}/#/tickets/BUG-901?project=${pid}`);
  await expect(page.locator('#tvDetail .tv-doc')).toHaveAttribute('data-id', 'BUG-901');
  const wide = await page.evaluate(() => {
    const meta = document.querySelector('#tvDetail .tv-doc > .tv-dmeta').getBoundingClientRect();
    const md = document.querySelector('#tvDetail .tv-doc > .tv-md').getBoundingClientRect();
    return { metaLeft: meta.left, mdRight: md.right, metaTop: meta.top, mdTop: md.top };
  });
  // two zones: the sidebar begins at or past the content column's right edge,
  // and they sit at roughly the same height (side-by-side, not stacked)
  expect(wide.metaLeft, 'metadata sidebar is to the RIGHT of the content column').toBeGreaterThanOrEqual(wide.mdRight - 2);
  expect(Math.abs(wide.metaTop - wide.mdTop), 'sidebar and content share the top edge — side by side').toBeLessThan(120);
  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-066-detail-wide.png') }).catch(() => {});

  // ── NARROW: one column — metadata strip stacks ABOVE the content ──
  await page.setViewportSize({ width: 720, height: 900 });
  await page.goto(`${BASE}/#/tickets/BUG-901?project=${pid}`);
  await expect(page.locator('#tvDetail .tv-doc')).toHaveAttribute('data-id', 'BUG-901');
  const narrow = await page.evaluate(() => {
    const meta = document.querySelector('#tvDetail .tv-doc > .tv-dmeta').getBoundingClientRect();
    const md = document.querySelector('#tvDetail .tv-doc > .tv-md').getBoundingClientRect();
    return { metaLeft: meta.left, mdLeft: md.left, metaBottom: meta.bottom, mdTop: md.top };
  });
  expect(Math.abs(narrow.metaLeft - narrow.mdLeft), 'one column — metadata shares the left edge with content').toBeLessThan(4);
  expect(narrow.metaBottom, 'one column — metadata stacks ABOVE the content').toBeLessThanOrEqual(narrow.mdTop + 2);
  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-066-detail-narrow.png') }).catch(() => {});
});

test('3 — the status color language: open / needs-you / done compute distinct colors', async ({ page }) => {
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f066-color-'));
  cleanupDirs.push(WORK);
  seedBoard(WORK);
  const pid = await register(WORK, 'qa-f066-color');

  await page.setViewportSize({ width: 1400, height: 900 });
  // FEAT-082: the full table is at /all now (bare #/tickets is the digest).
  await page.goto(`${BASE}/#/tickets/all?project=${pid}`);
  await expect(page.locator('#tvList a.tv-row')).toHaveCount(4);

  const colorOf = (id: string) => page.evaluate((tid: string) => {
    const row = [...document.querySelectorAll('#tvList a.tv-row')].find((r: any) => r.dataset.id === tid);
    const tag = row?.querySelector('.c-status');
    return tag ? getComputedStyle(tag).color : null;
  }, id);

  const open = await colorOf('FEAT-904');   // open — neutral
  const needs = await colorOf('FEAT-902');  // 👤 — amber
  const prog = await colorOf('BUG-903');    // 🤖 — blue
  const done = await colorOf('BUG-901');    // done — green
  for (const [k, v] of Object.entries({ open, needs, prog, done })) {
    expect(v, `status tag color for ${k} should resolve`).toBeTruthy();
  }
  // the whole complaint: pre-fix these are one identical grey. They must differ.
  const set = new Set([open, needs, prog, done]);
  expect(set.size, `open/needs/prog/done must be DISTINCT colors, got ${JSON.stringify({ open, needs, prog, done })}`).toBe(4);

  // and the detail state badge tints too (green on a Done ticket)
  await page.goto(`${BASE}/#/tickets/BUG-901?project=${pid}`);
  const badgeColor = await page.evaluate(() => {
    const b = document.querySelector('#tvDetail .tv-doc .d-badge');
    return b ? getComputedStyle(b).color : null;
  });
  expect(badgeColor, 'the Done state badge is tinted, not the default ink').not.toBe(open);
  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-066-list.png') }).catch(() => {});
});
