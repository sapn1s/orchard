/**
 * FEAT-053 — Needs-You rail: "Queued" (todo) section + per-section height caps
 * with independent scroll + the rail ticket MODAL (the full file agents read).
 *
 * What this proves, user-observable (WORKING_AGREEMENT §C):
 *   1. QUEUED IS EXACT — the section renders exactly the open-not-inflight-
 *      not-done set (owner `—`), read-only (BUG-025: no textarea), and is
 *      ABSENT entirely when the set is empty (no empty-header clutter).
 *   2. PER-SECTION CAPS — each rail section is height-capped with its OWN
 *      scroll; a saturated section cannot eat the rail; short sections shrink
 *      to content.
 *   3. WHEEL CHAINING (BUG-032 regression guard) — wheel over a capped section
 *      scrolls that section while it has room, then CHAINS to the rail panel;
 *      and NO new capped area carries `overscroll-behavior: contain` (the
 *      exact property that caused BUG-032).
 *   4. TICKET MODAL — clicking ANY rail row (queued, in-flight, done-today,
 *      and a needs-card's title) opens the ticket's FULL markdown via
 *      FEAT-058's ticketDetailNode — asserted by an Activity-log-only line
 *      (proving the full file, not a summary). Esc closes (top of the ladder);
 *      the modal scrolls independently; a row whose ticket file is MISSING
 *      degrades to an honest message, no crash.
 *
 * Non-vacuity: pre-change there is no #railQueued, no `queued` board field,
 * and no #ticketModal — assertions 1 and 4 fail outright, 2/3 fail on the
 * uncapped sections.
 *
 *   npx playwright test scripts/qa/FEAT-053-rail-queued-modal.spec.ts
 *
 * Never touches :4317; spawns its own server on an OS-assigned free port and
 * kills it by PID, never pkill. Scratch data/store/methodology dirs.
 */
import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
declare const window: any;
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

/* ─────────────────────────────── the seeded board ───────────────────────── */

const Q_STATUS = ['BUG-905', 'BUG-906', 'BUG-907', 'BUG-908', 'BUG-909', 'BUG-910']; // bare 👤 status
const INFLIGHT = ['BUG-920', 'BUG-921', 'BUG-922', 'BUG-923', 'BUG-924', 'BUG-925', 'BUG-926', 'BUG-927'];
const QUEUED = ['FEAT-930', 'FEAT-931', 'FEAT-932', 'FEAT-933', 'FEAT-934', 'FEAT-935',
  'FEAT-936', 'FEAT-937', 'FEAT-938', 'FEAT-939', 'FEAT-940', 'FEAT-941'];
const GHOST = 'FEAT-999'; // queued in INDEX, NO ticket file on disk — honest degrade
const DONE = ['BUG-950', 'BUG-951', 'BUG-952', 'BUG-953', 'BUG-954', 'BUG-955', 'BUG-956', 'BUG-957'];
const marker = (id: string) => `ACTIVITY-MARKER-${id} only-in-the-activity-log`;

function seedBoard(work: string, opts: { queued: boolean } = { queued: true }): void {
  const bugs = path.join(work, 'docs', 'bugs');
  fs.mkdirSync(bugs, { recursive: true });
  const openRows: string[] = [];
  const writeTicket = (id: string, title: string, extra = '') => {
    fs.writeFileSync(path.join(bugs, `${id}-t.md`),
      `# ${id} — ${title}\n\n- **Status:** OPEN\n- **Severity:** med\n- **Area:** UI\n\n`
      + `## Goal\nSomething small.\n${extra}\n`
      + `## Activity log (APPEND-ONLY)\n\n### 2026-08-09 — orchestrator\n- ${marker(id)}\n`);
  };
  for (const id of Q_STATUS) { writeTicket(id, `status ticket ${id}`); openRows.push(`| ${id} | status ticket ${id} | 👤 | open | med |`); }
  for (const id of INFLIGHT) { writeTicket(id, `in flight ${id}`); openRows.push(`| ${id} | in flight ${id} | 🤖 | building | med |`); }
  if (opts.queued) {
    for (const id of QUEUED) { writeTicket(id, `queued work ${id}`); openRows.push(`| ${id} | queued work ${id} | — | queued | low |`); }
    openRows.push(`| ${GHOST} | queued but its file is gone | — | queued | low |`); // NO file
  }
  // One LONG queued ticket, to prove the modal body scrolls independently.
  writeTicket(QUEUED[0], `queued work ${QUEUED[0]}`, `${'\nA long context line, repeated.'.repeat(120)}\n`);

  const doneRows: string[] = [];
  for (const id of DONE) {
    fs.writeFileSync(path.join(bugs, `${id}-t.md`),
      `# ${id} — done thing ${id}\n\n- **Status:** DONE\n\n## Activity log (APPEND-ONLY)\n\n### today — agent\n- ${marker(id)}\n`);
    doneRows.push(`| ${id} | done thing ${id} | abc1234 |`);
  }
  fs.writeFileSync(path.join(bugs, 'INDEX.md'),
    `# Board — scratch\n\n## Open\n\n| ID | Title | Owner | Status | Sev |\n|----|----|----|----|----|\n`
    + `${openRows.join('\n')}\n\n## Done (committed)\n\n| ID | Title | Commit |\n|----|----|----|\n${doneRows.join('\n')}\n`);
}

test.beforeAll(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f053-data-'));
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f053-store-'));
  const METH = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f053-meth-'));
  cleanupDirs.push(DATA, STORE, METH);
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE, METHODOLOGY_DIR: METH },
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

async function register(name: string, work: string): Promise<string> {
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: work, name }),
  })).json() as { project?: { id: string } };
  expect(reg.project?.id, `registration failed: ${JSON.stringify(reg)}`).toBeTruthy();
  return reg.project!.id;
}

async function openProject(page: Page, projectId: string): Promise<void> {
  await page.goto(`${BASE}/#/project/${projectId}`);
  await page.waitForFunction(() => (window as any).__station !== undefined);
  await page.waitForFunction((pid) => (window as any).__station.state.current.projectId === pid, projectId);
  await page.waitForFunction((pid) => (window as any).__station.state.boardProjectId === pid
    && !!(window as any).__station.state.board, projectId);
}

test('queued section + per-section caps + wheel chaining + the full-file ticket modal', async ({ page }) => {
  test.setTimeout(240_000);
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f053-projA-'));
  const WORK2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f053-projB-'));
  cleanupDirs.push(WORK, WORK2);
  seedBoard(WORK, { queued: true });
  seedBoard(WORK2, { queued: false }); // same board, NO queued rows
  const pid = await register('qa-feat053-a', WORK);
  const pid2 = await register('qa-feat053-b', WORK2);

  await page.setViewportSize({ width: 1400, height: 800 });
  await openProject(page, pid);

  // ═══ 1. QUEUED IS EXACT — the open-not-inflight-not-done set, read-only ═══
  const queuedSec = page.locator('#railQueued');
  await expect(queuedSec).toBeVisible();
  await expect(queuedSec.locator('.sub-h')).toHaveText('Queued');
  const queuedIds = await queuedSec.locator('.brow').evaluateAll((els) => els.map((e) => (e as any).dataset.id));
  expect(queuedIds.sort()).toEqual([...QUEUED, GHOST].sort());
  // read-only: no textarea, no buttons-with-answers inside the section (BUG-025)
  await expect(queuedSec.locator('textarea')).toHaveCount(0);
  // and none of the 👤/🤖 ids leaked in
  for (const id of [...Q_STATUS, ...INFLIGHT]) expect(queuedIds).not.toContain(id);
  // In-flight and Done-today still render their own sets
  await expect(page.locator('#railInflight .brow')).toHaveCount(INFLIGHT.length);
  await expect(page.locator('#railDone .brow')).toHaveCount(DONE.length);

  // ═══ 2. PER-SECTION CAPS — saturated sections scroll on their own ═════════
  const dims = await page.evaluate(() => {
    const m = (sel: string) => {
      const e = document.querySelector(sel) as any;
      const cs = getComputedStyle(e);
      return {
        client: e.clientHeight, scroll: e.scrollHeight,
        overY: cs.overflowY, overscroll: cs.overscrollBehaviorY || cs.overscrollBehavior,
      };
    };
    return { needs: m('#railNeeds'), queued: m('#railQueued'), inflight: m('#railInflight'), done: m('#railDone'), vh: window.innerHeight };
  });
  for (const [name, s] of Object.entries({ queued: dims.queued, inflight: dims.inflight, done: dims.done, needs: dims.needs })) {
    const sec = s as { client: number; scroll: number; overY: string; overscroll: string };
    expect(sec.overY, `${name} must own its scroll`).toBe('auto');
    // BUG-032 HARD CONSTRAINT: no overscroll-behavior:contain on any capped area.
    expect(sec.overscroll, `${name} must NOT contain overscroll (BUG-032)`).toBe('auto');
    expect(sec.client, `${name} is capped well below the rail`).toBeLessThan(dims.vh * 0.4);
  }
  // saturated sections genuinely overflow internally (cap is real)
  expect(dims.queued.scroll).toBeGreaterThan(dims.queued.client);
  expect(dims.inflight.scroll).toBeGreaterThan(dims.inflight.client);
  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-053-rail-sections.png') }).catch(() => {});

  // ═══ 3. WHEEL CHAINING (BUG-032 guard) — inner first, then the rail panel ═
  const box = (await queuedSec.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 120);
  await expect.poll(() => page.evaluate(() => (document.querySelector('#railQueued') as any).scrollTop)).toBeGreaterThan(0);
  // park the section at its bottom, then wheel again: the event must CHAIN to
  // the rail panel (pre-BUG-032-class bug it would be swallowed at the boundary)
  await page.evaluate(() => {
    const e = document.querySelector('#railQueued') as any;
    e.scrollTop = e.scrollHeight;
    (document.querySelector('#railPanel') as any).scrollTop = 0;
  });
  const panelScrollable = await page.evaluate(() => {
    const p = document.querySelector('#railPanel') as any;
    return p.scrollHeight > p.clientHeight;
  });
  expect(panelScrollable, 'the saturated rail must overflow its panel so chaining is observable').toBe(true);
  await page.mouse.wheel(0, 300);
  await page.mouse.wheel(0, 300);
  await expect.poll(() => page.evaluate(() => (document.querySelector('#railPanel') as any).scrollTop))
    .toBeGreaterThan(0);
  // the sidebar was never touched by any of this
  expect(await page.evaluate(() => (document.querySelector('#tree') as any).scrollTop)).toBe(0);

  // ═══ 4. THE MODAL — the FULL file the agents read, via FEAT-058's renderer ═
  // (a) a queued row
  await page.evaluate(() => { (document.querySelector('#railQueued') as any).scrollTop = 0; });
  await queuedSec.locator(`.brow[data-id="${QUEUED[1]}"]`).click();
  await expect(page.locator('#ticketModal')).toBeVisible();
  await expect(page.locator('#ticketModalBody .tv-doc')).toHaveAttribute('data-id', QUEUED[1]);
  // an Activity-log-only line proves this is the whole file, not a summary
  await expect(page.locator('#ticketModalBody')).toContainText(marker(QUEUED[1]));
  // compact: read-only — the dashboard's write actions are NOT in the modal
  await expect(page.locator('#ticketModalBody .tv-acts')).toHaveCount(0);
  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-053-modal.png') }).catch(() => {});
  // Esc closes — top of the ladder, drawer stays untouched
  await page.keyboard.press('Escape');
  await expect(page.locator('#ticketModal')).toBeHidden();
  expect(await page.evaluate(() => document.querySelector('#drawer')!.classList.contains('open'))).toBe(false);

  // (b) the LONG ticket: the modal body scrolls independently of the rail
  await queuedSec.locator(`.brow[data-id="${QUEUED[0]}"]`).click();
  await expect(page.locator('#ticketModalBody')).toContainText(marker(QUEUED[0]));
  const railBefore = await page.evaluate(() => (document.querySelector('#railPanel') as any).scrollTop);
  const modalScrolls = await page.evaluate(() => {
    const b = document.querySelector('#ticketModalBody') as any;
    const cs = getComputedStyle(b);
    return { over: b.scrollHeight > b.clientHeight, overscroll: cs.overscrollBehaviorY || cs.overscrollBehavior };
  });
  expect(modalScrolls.over, 'the long ticket must overflow the modal body').toBe(true);
  expect(modalScrolls.overscroll, 'modal body: NO overscroll contain (BUG-032)').toBe('auto');
  const mb = (await page.locator('#ticketModalBody').boundingBox())!;
  await page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2);
  await page.mouse.wheel(0, 250);
  await expect.poll(() => page.evaluate(() => (document.querySelector('#ticketModalBody') as any).scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (document.querySelector('#railPanel') as any).scrollTop)).toBe(railBefore);
  await page.keyboard.press('Escape');

  // (c) an in-flight row and a done-today row open their tickets too
  await page.locator(`#railInflight .brow[data-id="${INFLIGHT[0]}"]`).click();
  await expect(page.locator('#ticketModalBody')).toContainText(marker(INFLIGHT[0]));
  await page.keyboard.press('Escape');
  await page.locator(`#railDone .brow[data-id="${DONE[0]}"]`).click();
  await expect(page.locator('#ticketModalBody')).toContainText(marker(DONE[0]));
  await page.keyboard.press('Escape');

  // (d) a needs-card TITLE opens the modal; the card itself stays read-only
  const statusCard = page.locator(`.needs-card[data-id="${Q_STATUS[0]}"]`);
  await expect(statusCard.locator('textarea')).toHaveCount(0); // BUG-025 intact
  await statusCard.locator('.nc-title').click();
  await expect(page.locator('#ticketModalBody')).toContainText(marker(Q_STATUS[0]));
  await page.keyboard.press('Escape');

  // (e) HONEST DEGRADE — a row whose ticket file is missing says so, no crash
  await queuedSec.locator(`.brow[data-id="${GHOST}"]`).click();
  await expect(page.locator('#ticketModalBody')).toContainText(`Cannot open ${GHOST}`);
  await page.keyboard.press('Escape');
  await expect(queuedSec).toBeVisible(); // the rail survived

  // ═══ 1b. ABSENT WHEN EMPTY — the second project has no queued rows ════════
  await openProject(page, pid2);
  await expect(page.locator('#railQueued')).toBeHidden();
  await expect(page.locator('#railInflight')).toBeVisible(); // board itself is fine

  // ═══ narrow viewport: badge overlay path unaffected ═══════════════════════
  await page.setViewportSize({ width: 640, height: 800 });
  await expect(page.locator('#railBadge')).toBeVisible();
  await page.locator('#railBadge').click();
  await expect(page.locator('#rail')).toHaveClass(/open/);
});
