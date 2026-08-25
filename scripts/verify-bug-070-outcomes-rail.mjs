#!/usr/bin/env node
/**
 * BUG-070 — the outcomes rail must DATE its entries and be CLEARABLE.
 *
 * The reported failure, verbatim: "50 agents stopped — rate-limited … these
 * errors were idk like 1-2 days ago and still will show always as if 7pm today.
 * this section needs ability to clear data somehow and/or show dates". Two
 * defects: (1) entries render time-of-day only, so a 2-day-old fossil is
 * indistinguishable from a fresh death; (2) a mass event (yesterday's
 * session-limit cut = ~50 records at once) can only be dismissed one by one, so
 * nobody does, so the rail is permanently full and real new deaths drown.
 *
 * Load-bearing properties proven here:
 *  - every rail entry carries a RELATIVE DAY label (today/yesterday/Mon DD) —
 *    MUST FAIL pre-fix, where the renderer prints bare times;
 *  - "dismiss all" and per-cluster dismiss are SERVER writes (dismissedAt), so
 *    they persist across a reload;
 *  - dismissal is DISPLAY state, not deletion: the on-disk ledger's line count
 *    and record count are UNCHANGED by any dismissal (ARCH-002 evidence kept);
 *  - the default view is recent/undismissed; "show all" reveals old + dismissed.
 *
 * Part A is the real `outcomes` module against a scratch data dir; Part B is a
 * real server + a fixture ledger (today / yesterday / 3-days-ago + a 50-record
 * same-cluster swarm) + a real browser. No API cost.
 *
 * Usage: node scripts/verify-bug-070-outcomes-rail.mjs
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const BRAVE = process.env.QA_BRAVE_PATH ?? '/usr/bin/brave';

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDirs = new Set();
function mkTmp(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `cs-b70-${tag}-`));
  tmpDirs.add(d);
  return d;
}
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const servers = new Set();
function startServer(port, dataDir, env = {}) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: dataDir, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (d) => { if (process.env.CS_VERBOSE) process.stderr.write(`  [srv] ${d}`); });
  servers.add(child);
  return child;
}
function stopByPid(pid) {
  if (!pid) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }, 2500).unref();
}
async function waitHealth(port, ms = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* not up */ }
    await sleep(200);
  }
  return false;
}
async function registerProject(port, workDir, name) {
  const reg = await (await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: workDir, name }),
  })).json();
  if (!reg.project?.id) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  return reg.project.id;
}

const HOUR = 3600 * 1000;
function outcome(over) {
  const at = over.at ?? Date.now();
  return {
    id: over.id ?? `out-${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at,
    projectId: over.projectId ?? null,
    projectName: over.projectName ?? 'b70',
    stationSessionId: over.stationSessionId ?? null,
    sdkSessionId: over.sdkSessionId ?? null,
    agentId: over.agentId,
    row: over.row ?? 'agent',
    label: over.label ?? 'worker',
    description: over.description ?? '',
    kind: over.kind ?? 'unknown',
    detail: over.detail ?? 'the engine reported no outcome for it',
    providerError: over.providerError ?? null,
    clusterId: over.clusterId ?? null,
    dismissedAt: over.dismissedAt ?? null,
    briefedAt: over.briefedAt ?? null,
  };
}

/* =================================================== A — the record itself */

async function partA() {
  console.log('\n===== A — dayLabel is honest; dismissal is display-state, not deletion =====');
  const DATA = mkTmp('a-data');
  process.env.CLAUDE_STATION_DATA = DATA;
  let out = null;
  try { out = await import(path.join(ROOT, 'src', 'server', 'outcomes.ts')); } catch { out = null; }
  check('A0 the outcomes module exists', !!out, out ? 'ok' : 'MISSING');
  if (!out) return;

  const now = Date.now();
  check('A1 dayLabel: exists and names today/yesterday/an older calendar day',
    typeof out.dayLabel === 'function'
      && out.dayLabel(now, now) === 'today'
      && out.dayLabel(now - 26 * HOUR, now) === 'yesterday'
      && /^[A-Z][a-z]{2} \d{1,2}$/.test(out.dayLabel(now - 74 * HOUR, now)),
    typeof out.dayLabel === 'function'
      ? `today=${out.dayLabel(now, now)} y=${out.dayLabel(now - 26 * HOUR, now)} old=${out.dayLabel(now - 74 * HOUR, now)}`
      : 'dayLabel MISSING (pre-fix)');
  // One minute before local midnight is LATE YESTERDAY — a calendar-day label
  // must call it "yesterday" even though it is <24h ago (a rolling window would
  // wrongly say "today"). This is exactly the reported "as if today" failure.
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  check('A1 dayLabel: a late-yesterday time still reads "yesterday", not a rolling 24h',
    typeof out.dayLabel === 'function' && out.dayLabel(startOfToday - 60 * 1000, now) === 'yesterday',
    typeof out.dayLabel === 'function' ? out.dayLabel(startOfToday - 60 * 1000, now) : 'MISSING');

  // Fixture ledger straight to disk: dismissal must NOT change the file's line
  // or record count — it flips dismissedAt in place (append-only on disk).
  const store = path.join(DATA, 'agent-outcomes.json');
  const recs = [];
  for (let i = 0; i < 6; i++) recs.push(outcome({ agentId: `a-${i}`, sdkSessionId: 's-A', at: now - i * 1000 }));
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(store, JSON.stringify(recs, null, 2));
  const linesBefore = fs.readFileSync(store, 'utf8').split('\n').length;
  const recsBefore = JSON.parse(fs.readFileSync(store, 'utf8')).length;

  const dismissed = out.dismiss(recs.slice(0, 3).map((r) => r.id));
  const linesAfter = fs.readFileSync(store, 'utf8').split('\n').length;
  const recsAfter = JSON.parse(fs.readFileSync(store, 'utf8')).length;
  check('A2 dismiss() flips dismissedAt on the named records (a server write)',
    dismissed === 3 && JSON.parse(fs.readFileSync(store, 'utf8')).filter((r) => r.dismissedAt).length === 3, dismissed);
  check('A2 the on-disk ledger line count is UNCHANGED by dismissal (display-state, not deletion)',
    linesAfter === linesBefore, { linesBefore, linesAfter });
  check('A2 the on-disk record count is UNCHANGED by dismissal (ARCH-002 evidence kept)',
    recsAfter === recsBefore && recsAfter === 6, { recsBefore, recsAfter });
  check('A2 the default list hides dismissed; includeDismissed reveals them again',
    out.list({ sessionIds: ['s-A'] }).length === 3 && out.list({ sessionIds: ['s-A'], includeDismissed: true }).length === 6,
    { def: out.list({ sessionIds: ['s-A'] }).length, all: out.list({ sessionIds: ['s-A'], includeDismissed: true }).length });
  check('A2 dismiss-all ("*") clears the rest, still without deleting anything',
    out.dismiss('*') === 3 && out.list({ sessionIds: ['s-A'] }).length === 0
      && JSON.parse(fs.readFileSync(store, 'utf8')).length === 6,
    JSON.parse(fs.readFileSync(store, 'utf8')).length);
}

/* ====================================== B — the rail: dated, clearable, capped */

const READ_RAIL = () => ({
  hidden: document.querySelector('#railStopped')?.hidden !== false,
  head: document.querySelector('#railStopped .sub-h')?.textContent ?? '',
  rows: [...document.querySelectorAll('#railStopped .brow')].map((r) => r.textContent),
  clusterDismissBtns: document.querySelectorAll('#railStopped .brow .lnk').length,
});

async function openTab(browser, port, projectId) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/#/project/${encodeURIComponent(projectId)}`);
  await page.waitForFunction(() => window.__station && document.querySelector('#prompt'), undefined, { timeout: 30000 });
  return page;
}
async function pollFor(page, fn, pred, ms) {
  const t0 = Date.now();
  let v = null;
  while (Date.now() - t0 < ms) {
    try { v = await page.evaluate(fn); } catch { /* mid-nav */ }
    if (v && pred(v)) return { ok: true, v };
    await sleep(300);
  }
  return { ok: false, v };
}

async function partB(browser) {
  console.log('\n===== B — a real rail over a fixture ledger: today/yesterday/3-days + a 50 swarm =====');
  const port = await freePort();
  const DATA = mkTmp('b-data');
  const WORK = mkTmp('b-work');
  const srv = startServer(port, DATA, { CLAUDE_STATION_SURVIVE: '0' });
  if (!(await waitHealth(port))) throw new Error('scratch server never became healthy');
  const projectId = await registerProject(port, WORK, 'b70-rail');

  // Write the fixture ledger AFTER registration so records carry the real
  // projectId the rail scopes to. `readAll()` reads disk per call, so a file
  // written post-boot is picked up on the next poll — no restart needed.
  const now = Date.now();
  const quota = { kind: 'quota-window', provider: 'anthropic', detail: "You've hit your usage limit.", resetsAt: now + HOUR };
  const recs = [
    outcome({ agentId: 'fresh', label: 'today-worker', kind: 'unknown', sdkSessionId: 's-today', projectId, at: now - 2 * HOUR }),
    outcome({ agentId: 'yday', label: 'yesterday-worker', kind: 'killed', detail: 'killed mid-flight', sdkSessionId: 's-yest', projectId, at: now - 26 * HOUR }),
    outcome({ agentId: 'ancient', label: 'old-worker', kind: 'failed', detail: 'failed long ago', sdkSessionId: 's-old', projectId, at: now - 74 * HOUR }),
  ];
  // The 50-agent same-cluster swarm — yesterday's session-limit cut, one event.
  for (let i = 0; i < 50; i++) {
    recs.push(outcome({
      agentId: `swarm-${i}`, label: `swarm-${i}`, kind: 'provider-error', detail: 'the account hit its usage limit',
      providerError: quota, clusterId: 'swarm-cut', sdkSessionId: 's-swarm', projectId, at: (now - 25 * HOUR) + i,
    }));
  }
  const store = path.join(DATA, 'agent-outcomes.json');
  fs.writeFileSync(store, JSON.stringify(recs, null, 2));
  const linesAtStart = fs.readFileSync(store, 'utf8').split('\n').length;
  const recsAtStart = JSON.parse(fs.readFileSync(store, 'utf8')).length;

  const page = await openTab(browser, port, projectId);
  const rail = await pollFor(page, READ_RAIL, (r) => r.hidden === false && r.rows.length > 0, 20000);
  const railText = (rail.v?.rows ?? []).join(' || ') + ' || ' + (rail.v?.head ?? '');

  /* B1 — the core defect: entries are DATED. today + yesterday must both be
   *      named as such. MUST FAIL pre-fix (bare times, no day words). */
  check('B1 the rail names TODAY\'s death with a "today" day-label (not a bare time)',
    /today/i.test(railText), railText.slice(0, 220));
  check('B1 the rail names YESTERDAY\'s deaths with a "yesterday" day-label',
    /yesterday/i.test(railText), (rail.v?.rows ?? []).find((r) => /yesterday/i.test(r)) ?? '(none dated yesterday)');
  check('B1 no row is a BARE clock-only time (the reported "as if 7pm today" bug)',
    (rail.v?.rows ?? []).length > 0 && (rail.v?.rows ?? []).every((r) => !/\b\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?\b/i.test(r) || /today|yesterday|[A-Z][a-z]{2} \d/.test(r)),
    (rail.v?.rows ?? []).slice(0, 3));

  /* B1b — the 50-swarm is ONE grouped event with ONE dismiss, not 50 rows. */
  check('B1b the 50-agent swarm collapses to one grouped "ended together" event, dated',
    /\d+ ended together/.test(railText) && /yesterday/i.test((rail.v?.rows ?? []).find((r) => /ended together/.test(r)) ?? ''),
    (rail.v?.rows ?? []).find((r) => /ended together/.test(r)) ?? '(no cluster header)');
  check('B1b exactly one per-cluster dismiss control is offered (the swarm), not one per record',
    rail.v?.clusterDismissBtns === 1, rail.v?.clusterDismissBtns);

  /* B2 — the default view is RECENT: the 3-days-ago death is hidden until "show all". */
  const recentText = (rail.v?.rows ?? []).join(' ');
  check('B2 the 3-days-ago death is HIDDEN in the default recent view',
    !/old-worker/.test(recentText) && !/[A-Z][a-z]{2} \d/.test(recentText.replace(/ended together/g, '')),
    recentText.slice(0, 200));
  // Click "show all".
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#railStopped .sub-h .lnk')].find((x) => /show all/i.test(x.textContent));
    b?.click();
  });
  const shown = await pollFor(page, READ_RAIL, (r) => r.rows.some((x) => /old-worker|[A-Z][a-z]{2} \d/.test(x)), 8000);
  check('B2 "show all" REVEALS the old (3-days-ago) death, dated with a month/day',
    shown.ok && (shown.v?.rows ?? []).some((r) => /old-worker/.test(r) && /[A-Z][a-z]{2} \d/.test(r)),
    (shown.v?.rows ?? []).find((r) => /old-worker/.test(r)) ?? '(old death not revealed)');
  // Back to recent for the dismiss flow.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#railStopped .sub-h .lnk')].find((x) => /show recent/i.test(x.textContent));
    b?.click();
  });
  await sleep(400);

  /* B3 — per-cluster dismiss: one click clears the 50-swarm, others remain. */
  await page.evaluate(() => document.querySelector('#railStopped .brow .lnk')?.click());
  const afterCluster = await pollFor(page, READ_RAIL, (r) => !r.rows.some((x) => /ended together/.test(x)), 8000);
  check('B3 per-cluster dismiss clears the whole 50-swarm in one click',
    afterCluster.ok && !(afterCluster.v?.rows ?? []).some((r) => /ended together/.test(r)),
    (afterCluster.v?.rows ?? []).map((r) => r.slice(0, 40)));
  check('B3 the swarm dismiss did NOT touch the unrelated today/yesterday deaths',
    (afterCluster.v?.rows ?? []).some((r) => /today/i.test(r)) && (afterCluster.v?.rows ?? []).some((r) => /yesterday/i.test(r)),
    (afterCluster.v?.rows ?? []).map((r) => r.slice(0, 40)));
  // The dismiss is optimistic in the UI; poll disk for the server write to land.
  const swarmDismissed = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      const n = JSON.parse(fs.readFileSync(store, 'utf8')).filter((r) => r.clusterId === 'swarm-cut' && r.dismissedAt).length;
      if (n === 50) return n;
      await sleep(300);
    }
    return JSON.parse(fs.readFileSync(store, 'utf8')).filter((r) => r.clusterId === 'swarm-cut' && r.dismissedAt).length;
  })();
  check('B3 the cluster dismiss persisted server-side (50 records now carry dismissedAt)',
    swarmDismissed === 50, swarmDismissed);

  /* B4 — dismiss all, then reload: the cleared rail stays cleared. */
  await page.evaluate(() => document.querySelector('#railStopped .sub-h .lnk')?.click());
  await sleep(900);
  await page.reload();
  await page.waitForFunction(() => window.__station && document.querySelector('#prompt'), undefined, { timeout: 30000 });
  await sleep(2500);
  const afterReload = await page.evaluate(READ_RAIL);
  check('B4 after "dismiss all" + reload, the recent rail is EMPTY/hidden (persisted)',
    afterReload.hidden === true, afterReload);

  /* B5 — nothing was ever deleted: the ledger file is byte-for-byte intact in
   *      line & record count; every dismissal only flipped dismissedAt. */
  const finalTxt = fs.readFileSync(store, 'utf8');
  const finalRecs = JSON.parse(finalTxt);
  check('B5 the on-disk ledger line count is UNCHANGED by all the dismissals',
    finalTxt.split('\n').length === linesAtStart, { start: linesAtStart, end: finalTxt.split('\n').length });
  check('B5 the on-disk record count is UNCHANGED (53 records, none deleted)',
    finalRecs.length === recsAtStart && finalRecs.length === 53, { start: recsAtStart, end: finalRecs.length });
  check('B5 every recent record is now dismissed on disk; the old one is retained undismissed',
    finalRecs.filter((r) => r.dismissedAt).length === 52 && finalRecs.find((r) => r.agentId === 'ancient')?.dismissedAt == null,
    { dismissed: finalRecs.filter((r) => r.dismissedAt).length });

  await page.close();
  stopByPid(srv.pid);
}

/* ------------------------------------------------------------------- main */

let browser = null;
try {
  await partA();
  if (!fs.existsSync(BRAVE)) {
    check('a browser is available for the end-to-end half', false, BRAVE);
  } else {
    browser = await chromium.launch({ headless: true, executablePath: BRAVE });
    await partB(browser);
  }
} catch (err) {
  check('the suite ran to completion', false, String(err?.stack ?? err));
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const s of servers) stopByPid(s.pid);
  await sleep(600);
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) { console.log(`FAILED: ${failures.join(' | ')}`); process.exitCode = 1; }
