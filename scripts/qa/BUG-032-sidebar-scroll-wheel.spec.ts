/**
 * BUG-032 — the mouse wheel did NOTHING over the sidebar (project/session
 * list); only dragging its scrollbar worked. Reported live by the user:
 * "scroll wheel doesnt work on sidebar, only works on the actual scroll bar".
 *
 * ROOT CAUSE (public/styles.css, `.kids` — an expanded project's session
 * list): it carried `overscroll-behavior: contain` alongside `overflow-y:
 * auto; max-height: 52vh`. The comment's intent was "an expanded project must
 * not swallow the sidebar" — stopping a long inner list's scroll from
 * bleeding into the page. But `overscroll-behavior: contain` does not merely
 * suppress rubber-band bounce; it blocks wheel-scroll CHAINING to the
 * ancestor scroller (`#tree`) entirely, and it applies the instant the box is
 * "at" its scroll boundary — which is immediately true for any short or
 * empty `.kids` list (scrollHeight === clientHeight, i.e. every freshly
 * created project with no/few sessions). Since `.kids` sits directly under
 * the cursor for most of the sidebar's real estate (each project auto-shows
 * its session list), a wheel event almost anywhere in the sidebar landed on
 * a `.kids` element that consumed it and handed nothing to `#tree` — so nothing
 * scrolled, while dragging `#tree`'s own native scrollbar thumb (a different
 * input path, not wheel-based) still worked. That is exactly the reported
 * split symptom.
 *
 * FIX: removed `overscroll-behavior: contain` from `.kids`. Native chaining
 * is restored: `.kids` still scrolls internally first when it has its own
 * overflow (the original "don't swallow the sidebar" goal — an expanded
 * project's own list scrolling past ~52vh stays contained by max-height, not
 * by overscroll-behavior), and once it has no more room, the wheel input
 * naturally continues scrolling `#tree`, the actual sidebar scroller.
 *
 * This spec proves it against a REAL browser (Playwright + the system Brave
 * binary, see playwright.config.ts) driving a REAL scratch server + REAL
 * dispatched wheel events (page.mouse.wheel — genuine synthetic hardware
 * wheel input over CDP, not a scrollTop assignment) — non-vacuous: verified
 * FAILING pre-fix (scrollTop stayed 0 hovering an expanded project's kids
 * list) and PASSING post-fix, by hand before this spec existed, then
 * confirmed again by this spec itself.
 *
 *   npx playwright test scripts/qa/BUG-032-sidebar-scroll-wheel.spec.ts
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

declare const document: any;
declare const window: any;
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
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => {
    try { if (child.pid !== undefined) process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }, 2000).unref();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: ChildProcess | null = null;
let PORT = 0;
let BASE = '';
let DATA = '';
const cleanupDirs: string[] = [];

test.beforeAll(async () => {
  PORT = await freePort(); // never 4317, the live systemd service
  BASE = `http://127.0.0.1:${PORT}`;
  DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug032-data-'));
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

  // Seed enough projects to overflow the sidebar. Each freshly created project
  // has NO sessions yet, so its `.kids` renders a short "no sessions yet"
  // hint-row — exactly the zero-overflow `.kids` shape that triggered BUG-032
  // (overscroll-behavior:contain swallows chaining the instant the box is at
  // its own boundary, which for an empty list is immediately).
  for (let i = 0; i < 45; i++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cs-bug032-proj-${i}-`));
    cleanupDirs.push(dir);
    const r = await fetch(`${BASE}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostPath: dir, name: `proj-${String(i).padStart(2, '0')}` }),
    });
    if (!r.ok) throw new Error(`precondition failed: could not register project ${i}: ${await r.text()}`);
  }

  // Seed enough needs-you tickets (a real board, real files — same shape as
  // BUG-025's spec) to overflow the rail, so the rail-unaffected assertion is
  // non-vacuous too.
  const railDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug032-rail-'));
  cleanupDirs.push(railDir);
  const bugs = path.join(railDir, 'docs', 'bugs');
  fs.mkdirSync(bugs, { recursive: true });
  const rows: string[] = [];
  let index = `# Board\n\n## Open\n\n| ID | Title | Owner | Status | Sev |\n|----|-------|-------|--------|-----|\n`;
  for (let i = 0; i < 20; i++) {
    const id = `BUG-9${String(i).padStart(2, '0')}`;
    index += `| ${id} | rail overflow filler ticket #${i} needing a decision from the user | 👤 | needs decision | low |\n`;
    fs.writeFileSync(path.join(bugs, `${id}-filler.md`),
      `# ${id} — rail overflow filler ticket #${i}\n\n- **Status:** OPEN\n- **Severity:** low\n\n` +
      `## Question\nPick an option for filler ticket #${i}?\n- yes\n- no\n\n` +
      `## Activity log (APPEND-ONLY)\n\n### 2026-08-06 — bug032 spec\n- seeded to overflow the rail.\n`);
  }
  index += `\n## Done (committed)\n\n| ID | Title | Commit |\n|----|-------|--------|\n`;
  fs.writeFileSync(path.join(bugs, 'INDEX.md'), index);
  const railReg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: railDir, name: 'rail-overflow-project' }),
  })).json() as { project?: { id: string } };
  if (!railReg.project?.id) throw new Error(`precondition failed: could not register rail project: ${JSON.stringify(railReg)}`);
  (globalThis as any).__railProjectId = railReg.project.id;
});

test.afterAll(async () => {
  stopByPid(server);
  await sleep(300);
  for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
});

async function wheelOver(page: Page, x: number, y: number, dy: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, dy);
  await page.waitForTimeout(200);
}

test('wheel over the sidebar scrolls it; wheel over the transcript / rail is unaffected; narrow viewport unaffected', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 560 });
  await page.goto(BASE);
  await page.waitForFunction(() => (window as any).__station !== undefined);
  await page.waitForSelector('#tree .proj', { timeout: 20_000 });
  // Freshly created projects with no sessions have no `lastActivityAt`, so
  // renderTree() folds them into the collapsed "N inactive projects" bucket
  // (only the current/expanded project stays visible unfolded) — reveal it so
  // the sidebar actually overflows with many rows, the real-world shape this
  // bug hits (a user with a long project list).
  const inactiveToggle = page.locator('.inactive-l');
  if (await inactiveToggle.count()) await inactiveToggle.click();
  await page.waitForFunction(() => {
    const tree = document.getElementById('tree');
    return !!tree && tree.scrollHeight > tree.clientHeight;
  }, undefined, { timeout: 20_000 });

  // ---- (1) THE FIX: wheel over the sidebar changes #tree.scrollTop ----
  // Target a point inside an expanded project's `.kids` list specifically —
  // that is the exact element the root cause sat on.
  const kidsPoint = await page.evaluate(() => {
    const kids = document.querySelector('.kids') as any;
    if (!kids) throw new Error('no .kids element found — precondition broken');
    const r = kids.getBoundingClientRect();
    return { x: r.left + Math.min(r.width / 2, 30), y: r.top + Math.min(r.height / 2, 8) };
  });
  const elAtKidsPoint = await page.evaluate((p) => {
    const el = document.elementFromPoint(p.x, p.y) as any;
    return { tag: el?.tagName, insideKids: !!el && !!el.closest('.kids') };
  }, kidsPoint);
  expect(elAtKidsPoint.insideKids, 'the wheel point must actually land inside .kids, the root-cause element').toBe(true);

  const treeBefore = await page.evaluate(() => document.getElementById('tree')!.scrollTop);
  expect(treeBefore).toBe(0);
  await wheelOver(page, kidsPoint.x, kidsPoint.y, 600);
  const treeAfter = await page.evaluate(() => document.getElementById('tree')!.scrollTop);
  expect(treeAfter, 'wheel over the sidebar (over a .kids list) must scroll #tree — BUG-032').toBeGreaterThan(treeBefore);

  // Also true from a plain, unambiguous point in the sidebar body (not just
  // over a project header, which never exhibited the bug).
  await page.evaluate(() => { document.getElementById('tree')!.scrollTop = 0; });
  const treeRect = await page.evaluate(() => {
    const r = document.getElementById('tree')!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await wheelOver(page, treeRect.x, treeRect.y, 600);
  const treeAfter2 = await page.evaluate(() => document.getElementById('tree')!.scrollTop);
  expect(treeAfter2, 'wheel over the general sidebar body must scroll #tree').toBeGreaterThan(0);

  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'BUG-032-sidebar-scrolled.png') }).catch(() => {});

  // ---- (2) NO REGRESSION: wheel over the transcript still scrolls IT, not the sidebar ----
  await page.evaluate(() => {
    const panes = document.getElementById('panes')!;
    panes.innerHTML = '';
    for (let i = 0; i < 200; i++) {
      const row = document.createElement('div');
      row.textContent = `synthetic transcript line ${i} — BUG-032 regression filler`;
      row.style.padding = '4px 0';
      panes.appendChild(row);
    }
  });
  const scrollRect = await page.evaluate(() => {
    const r = document.getElementById('scroll')!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const transcriptBefore = await page.evaluate(() => document.getElementById('scroll')!.scrollTop);
  const treeBeforeTranscriptTest = await page.evaluate(() => document.getElementById('tree')!.scrollTop);
  await wheelOver(page, scrollRect.x, scrollRect.y, 600);
  const transcriptAfter = await page.evaluate(() => document.getElementById('scroll')!.scrollTop);
  const treeAfterTranscriptTest = await page.evaluate(() => document.getElementById('tree')!.scrollTop);
  expect(transcriptAfter, 'wheel over the transcript must still scroll the transcript').toBeGreaterThan(transcriptBefore);
  expect(treeAfterTranscriptTest, 'scrolling the transcript must NOT move the sidebar').toBe(treeBeforeTranscriptTest);

  // ---- (3) NO REGRESSION: wheel over the Needs-You rail scrolls IT, unaffected ----
  // FEAT-053 changed the rail's geometry: the cards section (#railNeeds) is now
  // height-capped with its OWN scroll, so 20 cards overflow the SECTION rather
  // than the panel. The contract asserted here is the same one, one level in:
  // wheel over the rail lands (the capped section scrolls), it is never
  // swallowed (BUG-032's overscroll-behavior class of bug), and the sidebar
  // does not move.
  const railProjectId = (globalThis as any).__railProjectId as string;
  await page.goto(`${BASE}/#/project/${railProjectId}`);
  await page.waitForFunction(() => (window as any).__station !== undefined);
  await page.waitForSelector('#railNeeds .needs-card', { timeout: 20_000 });
  await page.waitForFunction(() => {
    const needs = document.getElementById('railNeeds');
    return !!needs && needs.scrollHeight > needs.clientHeight;
  }, undefined, { timeout: 20_000 });
  const railRect = await page.evaluate(() => {
    const r = document.getElementById('railNeeds')!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const railTreeBefore = await page.evaluate(() => document.getElementById('tree')!.scrollTop);
  await wheelOver(page, railRect.x, railRect.y, 600);
  const railAfter = await page.evaluate(() => ({
    needs: document.getElementById('railNeeds')!.scrollTop,
    tree: document.getElementById('tree')!.scrollTop,
  }));
  expect(railAfter.needs, 'wheel over the Needs-You rail must scroll its cards section, unaffected by the sidebar fix').toBeGreaterThan(0);
  expect(railAfter.tree, 'scrolling the rail must NOT move the sidebar').toBe(railTreeBefore);

  // ---- (4) NARROW VIEWPORT: unaffected (the sidebar collapses to icons; .kids
  //      is display:none there, so it never sat in the wheel hit-path) ----
  await page.setViewportSize({ width: 640, height: 560 });
  await page.waitForTimeout(150);
  const narrowKidsDisplay = await page.evaluate(() => {
    const kids = document.querySelector('.kids') as any;
    return kids ? getComputedStyle(kids).display : 'no-kids-element';
  });
  expect(['none', 'no-kids-element']).toContain(narrowKidsDisplay);
  await page.screenshot({ path: path.join(ROOT, 'docs', 'bugs', 'assets', 'BUG-032-narrow-viewport.png') }).catch(() => {});
});
