#!/usr/bin/env node
/**
 * ARCH-017 step 2 — THE RAIL AND THE API, the half no suite could reach.
 *
 * WHY THIS FILE EXISTS. Round 2 shipped five fixes; three of them live in
 * `src/server/index.ts` and `public/app.js`, and NOTHING in `scripts/` loaded
 * either. An independent verifier's mutation run scored 3 killed / 5 survived
 * against those paths: the 503 guard, the `CAP`/`+N more` logic, the composer
 * append and the ⚠ row could all be deleted with every suite still green. The
 * drain suite's "0 survived" was a true statement about two files and a false
 * impression about the feature — exactly the false assurance this ticket has
 * spent eight rounds fighting.
 *
 * So this suite drives the REAL server over HTTP and the REAL `public/app.js`
 * in a REAL headless browser. Same harness shape as
 * `verify-bug-070-outcomes-rail.mjs`, which covers the rail this one is
 * modelled on.
 *
 * `--must-fail-proof` runs only the legs that prove the properties were
 * breakable.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const BRAVE = process.env.QA_BRAVE_PATH ?? '/usr/bin/brave';
const ONLY_MUST_FAIL = process.argv.includes('--must-fail-proof');

let pass = 0, fail = 0;
function check(name, ok, observed) {
  if (ONLY_MUST_FAIL) return;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}\n      observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else fail++;
}
function mustFail(name, ok, observed) {
  if (!ONLY_MUST_FAIL) return;
  console.log(`${ok ? 'PASS' : 'FAIL'} MUST-FAIL ${name}\n      observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDirs = new Set();
function mkTmp(tag) { const d = fs.mkdtempSync(path.join(os.tmpdir(), `a17-rail-${tag}-`)); tmpDirs.add(d); return d; }
async function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
const servers = new Set();
function startServer(port, dataDir, store) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: dataDir, CLAUDE_PROJECTS_DIR: store },
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
async function waitHealth(port, ms = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* not up */ }
    await sleep(200);
  }
  return false;
}
const post = (port, route, body) => fetch(`http://127.0.0.1:${port}${route}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

/**
 * A wait whose TIMEOUT is a named failure, not a harness crash.
 *
 * The mutation check grades a mutant as killed when the suite goes red — and a
 * `waitForFunction` timeout escaping to the outer catch prints `FAIL harness`,
 * which is red for the wrong reason and tells a reader nothing about WHICH
 * property died. Mutants M11/M13 were reported exactly that way. Returns false
 * on timeout so the caller can assert against it by name.
 */
async function waitFor(page, fn, ms = 20000) {
  try { await page.waitForFunction(fn, null, { timeout: ms }); return true; }
  catch { return false; }
}

/* ------------------------------------------------------- the fixture ledger */
/**
 * REALISTIC STATE, and synthetic — said plainly. Sized past the 12-row cap on
 * purpose: the round-2 defect was invisible at five items and obvious at
 * seventeen, so the fixture is the busy afternoon, not the minimal case.
 */
const MIN = 60_000;
function buildLedger(dataDir, projectId) {
  const now = Date.now();
  let n = 0;
  const lane = (over) => {
    const id = `lane-rail-${(n++).toString().padStart(2, '0')}`;
    const dir = path.join(dataDir, 'lanes', id);
    fs.mkdirSync(dir, { recursive: true });
    const text = over.resultText ?? `RESULT BODY of ${over.label}\n${'.'.repeat(80)}\nthe useful part`;
    const ptr = path.join(dir, 'result.txt');
    fs.writeFileSync(ptr, text);
    delete over.resultText;
    return {
      id, projectId, projectName: 'a17rail', parentSessionId: null,
      groupId: id, groupSize: 1, groupClosed: true, groupOpen: false,
      groupCloseDeadline: null, groupClosedAt: now - 90 * MIN, groupExtendedAt: null,
      label: 'lane', charter: 'c', provider: 'openai', model: null, transport: 'blocking-dispatch',
      ticket: 'ARCH-017', phase: 'fixing', round: '3', laneClass: 'fix',
      dispatchedAt: now - 60 * MIN, state: 'settled', settledAt: now - 5 * MIN,
      resultPointer: ptr, resultExcerpt: text.slice(0, 200), failureKind: null, usage: null,
      handoffAt: null, handoffBytes: null, handoffEvidence: null,
      acknowledgedAt: null, acknowledgedBy: null, deliveryProof: null, acknowledgementEvidence: null,
      heldReason: null, dismissedAt: null, pid: null, argvToken: `tok-${id}`,
      serverPid: process.pid, serverStart: null, bootId: null, reconciledAt: null, reconcileDetail: null,
      ...over,
    };
  };
  const records = [
    ...[0, 1, 2].map((i) => lane({ groupId: 'g-trio', groupSize: 3, label: `trio lane ${i + 1}`, settledAt: now - (8 - i) * MIN })),
    ...Array.from({ length: 15 }, (_, i) => lane({ groupId: `g-solo-${i}`, label: `solo lane ${i}`, settledAt: now - (10 + i) * MIN })),
  ];
  fs.writeFileSync(path.join(dataDir, 'lanes.json'), JSON.stringify(records, null, 2));
  return records;
}

/* ══════════════════════════════════════════════════════════════════════════ */
let browser = null;
try {
  const DATA = mkTmp('data');
  const STORE = mkTmp('store');
  const WORK = mkTmp('work');
  const port = await freePort();
  const srv = startServer(port, DATA, STORE);
  if (!await waitHealth(port)) throw new Error('scratch server never became healthy');
  const reg = await (await post(port, '/api/projects', { hostPath: WORK, name: 'a17rail', applyMethod: false })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  const records = buildLedger(DATA, pid);

  // A SECOND server on the SAME data dir: it cannot take the writer claim, which
  // is the real production shape (a restart overlap) behind every 503 below.
  const port2 = await freePort();
  const srv2 = startServer(port2, DATA, STORE);
  if (!await waitHealth(port2)) throw new Error('second server never became healthy');

  const api1 = await (await fetch(`http://127.0.0.1:${port}/api/lanes/pending?projectId=${pid}`)).json();
  check('A0 — precondition: the fixture really is bigger than the row cap',
    api1.pending.length > 12, { records: records.length, items: api1.pending.length, cap: 12 });

  /* ─────────────── A — the API half (X1: the 503 guard) ─────────────── */

  const r503 = await post(port2, '/api/lanes/process', { ids: ['group:g-trio'], projectId: pid });
  const b503 = await r503.json();
  check('A1 — a drain that could hand over NOTHING answers 503, not a cheerful 200 (X1)',
    r503.status === 503 && typeof b503.error === 'string' && b503.error.includes('writer'),
    { status: r503.status, error: (b503.error ?? '').slice(0, 120), lanes: b503.lanes ?? null });

  check('A2 — and the 503 body carries the store\'s OWN recovery path, not a generic message',
    /CLAUDE_STATION_DATA|stop it/i.test(b503.error ?? ''),
    { hasRecovery: /CLAUDE_STATION_DATA|stop it/i.test(b503.error ?? ''), tail: (b503.error ?? '').slice(-120) });

  const rAll = await post(port2, '/api/lanes/process', { all: true, projectId: pid });
  const bAll = await rAll.json();
  const rDis = await post(port2, '/api/lanes/dismiss', { ids: ['group:g-solo-0'], projectId: pid });
  check('A3 — process-all and dismiss refuse the same way on a non-writer server',
    rAll.status === 503 && rDis.status === 503, { processAll: rAll.status, dismiss: rDis.status });

  /*
   * A5 — ONE REASON, NOT ONE PER LANE. `process all` is the PRIMARY button, so
   * it is the realistic case, and it was the worst one: the identical ~545-char
   * writer-claim message was joined once per lane. A verifier measured a
   * 9,820-character / ~335-line body over 18 lanes with 2.4% of it visible —
   * 17 of the 18 copies pure repetition. Two rounds of work on the row's
   * readability were spent on text that was one sentence repeated.
   */
  const copies = (bAll.error ?? '').match(/this process is NOT the lane ledger's writer/g)?.length ?? 0;
  const oneCopies = (b503.error ?? '').match(/this process is NOT the lane ledger's writer/g)?.length ?? 0;
  check('A5 — the 503 body states each distinct reason ONCE, however many lanes were refused',
    copies === 1 && oneCopies === 1 && (bAll.error ?? '').length < 1200 && Array.isArray(bAll.reasons) && bAll.reasons.length === 1,
    { lanesRefused: bAll.skipped?.length ?? 0, reasonCopies: copies, bodyChars: (bAll.error ?? '').length,
      singleLaneChars: (b503.error ?? '').length, distinctReasons: bAll.reasons?.length ?? null,
      preFixWouldHaveBeen: (bAll.skipped?.length ?? 0) * ((bAll.reasons?.[0] ?? '').length + 2) });

  check('A6 — and it still says HOW MANY results are held, so collapsing the reason loses no fact',
    /\d+ results? still held/.test(bAll.error ?? '') && (bAll.skipped?.length ?? 0) > 1,
    { header: (bAll.error ?? '').slice(0, 90), skippedLanes: bAll.skipped?.length ?? 0 });

  const onDisk = JSON.parse(fs.readFileSync(path.join(DATA, 'lanes.json'), 'utf8'));
  check('A4 — a refused drain stamped NOTHING: every record is still held',
    onDisk.length === records.length && records.length > 0
      && onDisk.every((r) => r.handoffAt == null && r.acknowledgedAt == null),
    { recordsOnDisk: onDisk.length, expectedRecords: records.length, handed: onDisk.filter((r) => r.handoffAt != null).length, acked: onDisk.filter((r) => r.acknowledgedAt != null).length });

  /*
   * A MEASURED must-FAIL, replacing a hardcoded `true`.
   *
   * The old leg was `const preFixWouldSend200 = true;` ANDed with the shipped
   * status — a constant that could not fail, restating A1 while claiming to
   * prove breakability. Both quantities below are now MEASURED from the same
   * live response: the pre-fix length is computed from the server's own
   * `skipped[]` (what `join('; ')` would have produced), and the shipped length
   * is what actually came back.
   */
  const preFixLen = (bAll.skipped ?? []).map((x) => x.why).join('; ').length;
  const shippedLen = (bAll.error ?? '').length;
  mustFail('leg 1: the pre-fix 503 body repeated one reason per lane; the shipped one states it once',
    preFixLen > shippedLen * 3 && copies === 1,
    { lanes: bAll.skipped?.length ?? 0, preFixChars: preFixLen, shippedChars: shippedLen,
      shrunkBy: `${(preFixLen / Math.max(1, shippedLen)).toFixed(1)}x`, reasonCopiesNow: copies });

  /* ─────────────── B — the browser half (X4, X5, X8 + readability) ─────── */

  browser = await chromium.launch({ headless: true, executablePath: BRAVE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/?a17rail#/p/${pid}`, { waitUntil: 'domcontentloaded' });
  check('B0 — the pending rail renders rows at all', await waitFor(page, () => document.querySelector('#railPending')?.querySelectorAll('[data-pending-id]').length > 0, 30000), 'rows rendered');

  /*
   * ROUND 11 (finding 2) — collecting a result requires an OPEN session to deliver
   * INTO. The delivery guard now refuses when `state.current` has no `sessionId`,
   * because there is no composer belonging to "no open session". The happy-path
   * delivery tests below (C3-C6, B3…) model a user WITH a session open, so a real
   * one is set once here; the guard-negative tests (C9/C10/C11) set their own.
   */
  await page.evaluate((p) => { window.__station.state.current = { sessionId: 'rail-sess', projectId: p, encodedDir: 'rail-dir', title: 'rail', os: 'linux' }; }, pid);

  const capped = await page.evaluate(async () => {
    const api = await (await fetch(`/api/lanes/pending?projectId=${location.hash.split('/p/')[1]}`)).json();
    const h = document.querySelector('#railPending');
    const rows = [...h.querySelectorAll('[data-pending-id]')].map((r) => r.dataset.pendingId);
    const more = h.querySelector('[data-pending-more]');
    return { apiItems: api.pending.length, domRows: rows.length, moreText: more?.textContent ?? null,
             missing: api.pending.map((i) => i.id).filter((id) => !rows.includes(id)) };
  });
  check('B1 — the rail caps rows but ANNOUNCES the remainder (X4)',
    // Cardinality first: with 0 items every clause below is trivially true.
    capped.apiItems > 12 && capped.missing.length > 0
      && capped.domRows === 12 && capped.moreText && /\+\d+/.test(capped.moreText)
      && capped.missing.length === capped.apiItems - 12,
    capped);

  await page.click('#railPending [data-pending-more]');
  const expanded = await page.evaluate(async () => {
    const api = await (await fetch(`/api/lanes/pending?projectId=${location.hash.split('/p/')[1]}`)).json();
    const h = document.querySelector('#railPending');
    const rows = [...h.querySelectorAll('[data-pending-id]')];
    return { apiItems: api.pending.length, domRows: rows.length,
             missing: api.pending.map((i) => i.id).filter((id) => !rows.some((r) => r.dataset.pendingId === id)),
             everyRowActionable: rows.every((r) => r.querySelectorAll('button').length >= 2),
             zeroSized: rows.filter((r) => r.getBoundingClientRect().width < 2 || r.getBoundingClientRect().height < 2).length };
  });
  /*
   * CARDINALITY FIRST. A cross-provider review extracted this predicate and
   * showed that `{domRows:0, apiItems:0, missing:[], everyRowActionable:
   * [].every(...)}` satisfies it — an empty API plus an empty DOM "passes".
   * The counts the check is about are now asserted to be real and to exceed the
   * cap, so this cannot be certified by a rail that rendered nothing.
   */
  check('B2 — expanding makes EVERY item reachable and individually actionable (X4)',
    expanded.apiItems > 12 && expanded.domRows === expanded.apiItems && expanded.missing.length === 0
      && expanded.everyRowActionable && expanded.zeroSized === 0,
    { ...expanded, cardinalityGuard: `apiItems ${expanded.apiItems} must exceed the 12-row cap for this to mean anything` });

  mustFail('leg 2: the pre-fix hard break left items with no row and no indicator (X4)',
    capped.missing.length > 0 && expanded.apiItems > 12 && expanded.domRows === expanded.apiItems && expanded.missing.length === 0,
    { preFix: `${capped.missing.length} items had NO row and no toggle`, shipped: `announced as "${capped.moreText}", all ${expanded.domRows} reachable after one click` });

  // X5 — the composer must be APPENDED to, never overwritten.
  const DRAFT = 'MY IMPORTANT DRAFT THAT MUST SURVIVE';
  await page.evaluate((d) => { const b = document.querySelector('#prompt'); b.value = d; b.dispatchEvent(new Event('input', { bubbles: true })); }, DRAFT);
  await page.click('#railPending .brow[data-pending-id="group:g-trio"] button');
  /*
   * Wait for the RECEIPT, not for the row to vanish. The row is removed
   * OPTIMISTICALLY before the fetch is issued, so waiting on its absence
   * returns almost immediately and reads the composer before the bundle has
   * landed — which is how this assertion first failed, on a correct build.
   */
  const drained = await waitFor(page, () => !!document.querySelector('#railPending [data-last-drain]'));
  check('B3a — collecting produces a visible receipt row (the drain completed at all)', drained, { receiptRowAppeared: drained });
  const composer = await page.evaluate((d) => {
    const v = document.querySelector('#prompt').value;
    const gone = !document.querySelector('[data-pending-id="group:g-trio"]');
    return { rowLeftTheRail: gone, draftPreserved: v.startsWith(d), hasBundle: v.includes('RESULT BODY of trio lane 2'),
             allThree: ['trio lane 1', 'trio lane 2', 'trio lane 3'].every((t) => v.includes(t)),
             len: v.length, head: v.slice(0, 60) };
  }, DRAFT);
  check('B3 — the collected bundle APPENDS to the composer and carries all N results (X5)',
    composer.draftPreserved && composer.hasBundle && composer.allThree && composer.rowLeftTheRail, composer);

  mustFail('leg 3: an overwriting composer would eat the user\'s draft (X5)',
    composer.draftPreserved && composer.len > DRAFT.length,
    { preFix: 'assignment replaced the draft — the user\'s unsent message is destroyed by collecting', shipped: `draft kept, ${composer.len - DRAFT.length} bytes appended` });

  // X8 + finding 2 — the ⚠ row on the NON-WRITER server, and its READABILITY.
  const page2 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page2.goto(`http://127.0.0.1:${port2}/?a17rail2#/p/${pid}`, { waitUntil: 'domcontentloaded' });
  check('B0b — the rail renders on the NON-WRITER server too (the read path needs no writer)', await waitFor(page2, () => document.querySelector('#railPending')?.querySelectorAll('[data-pending-id]').length > 0, 30000), 'rows rendered on :port2');
  await page2.click('#railPending .brow[data-pending-id] button');
  const warned = await waitFor(page2, () => !!document.querySelector('#railPending [data-pending-problem]'));
  check('B3b — a refused drain raises a problem row AT ALL (X8, named rather than timing out)', warned, { problemRowAppeared: warned });

  const warn = warned ? await page2.evaluate(() => {
    const row = document.querySelector('#railPending [data-pending-problem]');
    const bt = row.querySelector('.bt');
    const cs = getComputedStyle(bt);
    const hint = bt.querySelector('.fix-first');
    return {
      isFirstChild: row === document.querySelector('#railPending').firstElementChild,
      textLen: bt.textContent.length,
      whiteSpace: cs.whiteSpace, textOverflow: cs.textOverflow,
      clientWidth: Math.round(bt.clientWidth), scrollWidth: Math.round(bt.scrollWidth),
      clientHeight: Math.round(bt.clientHeight), scrollHeight: Math.round(bt.scrollHeight),
      lines: Math.round(bt.scrollHeight / parseFloat(cs.lineHeight)),
      overflowY: cs.overflowY,
      maxHeight: cs.maxHeight,
      visibleLines: Math.round(bt.clientHeight / parseFloat(cs.lineHeight)),
      namesTheCause: /writer/i.test(bt.textContent),
      // Is the instruction inside the band the user can see WITHOUT scrolling?
      hintWithinVisibleBand: hint ? (hint.getBoundingClientRect().bottom - bt.getBoundingClientRect().top) <= bt.clientHeight + 1 : false,
      hintText: hint ? hint.textContent.slice(0, 120) : null,
      hintVisible: hint ? hint.getBoundingClientRect().height > 0 : false,
      // How many distinct reasons the body actually contains (the dedupe fix).
      reasonCopies: (bt.textContent.match(/this process is NOT the lane ledger's writer/g) || []).length,
    };
  }) : { isFirstChild: false, namesTheCause: false, textLen: 0, whiteSpace: 'n/a', clientWidth: 0, scrollWidth: 0, clientHeight: 0, scrollHeight: 0, lines: 0, visibleLines: 0, overflowY: 'n/a', maxHeight: 'n/a', hintText: null, hintVisible: false, hintWithinVisibleBand: false, reasonCopies: 0 };
  check('B4 — the failure is named at the user, as the first row of the rail (X8)',
    warn.isFirstChild && warn.namesTheCause, { isFirstChild: warn.isFirstChild, namesTheCause: warn.namesTheCause, textLen: warn.textLen });

  /*
   * FINDING 2, ROUND 3 — READABLE, not merely present. A verifier measured
   * `{clientWidth:210, scrollWidth:1195, approxVisibleChars:38}` of a
   * 1115-character message, the recovery path reachable only by hover. The
   * horizontal overflow is the whole defect: a wrapped block has
   * scrollWidth == clientWidth and spends its length on LINES instead.
   */
  /*
   * B5 USED TO MEASURE clientHeight/scrollHeight AND NEVER USE THEM, so the
   * VERTICAL property — the one the round-3 `max-height` and `overflow:auto`
   * actually govern — was asserted by nobody. A verifier's mutants V1
   * (`overflow:auto` → `hidden`) and V3 (`max-height:11.6em` → `1.45em`)
   * deleted the exact change being landed and this suite stayed 15/0.
   *
   * Four properties now, each naming a way the text becomes unreadable:
   *   horizontal — no side-clipping (the round-2 defect);
   *   vertical   — more than one line is actually shown (V3);
   *   reachable  — if anything IS cut off, the box scrolls to it (V1);
   *   front      — the instruction sits inside the band visible WITHOUT
   *                scrolling, not merely somewhere in the DOM (V2).
   */
  const noSideClip = warn.scrollWidth <= warn.clientWidth + 2 && warn.whiteSpace !== 'nowrap';
  const showsMultipleLines = warn.visibleLines >= 3;
  const overflowReachable = warn.scrollHeight <= warn.clientHeight + 2 || /auto|scroll/.test(warn.overflowY);
  const hintReachableWithoutScrolling = warn.hintVisible && warn.hintWithinVisibleBand && /CLAUDE_STATION_DATA|stop it/i.test(warn.hintText ?? '');
  check('B5 — the recovery text is readable: no side-clip, multiple lines shown, overflow reachable, instruction in the visible band',
    noSideClip && showsMultipleLines && overflowReachable && hintReachableWithoutScrolling,
    { whiteSpace: warn.whiteSpace, clientWidth: warn.clientWidth, scrollWidth: warn.scrollWidth, noSideClip,
      maxHeight: warn.maxHeight, clientHeight: warn.clientHeight, scrollHeight: warn.scrollHeight,
      visibleLines: warn.visibleLines, totalLines: warn.lines, showsMultipleLines,
      overflowY: warn.overflowY, overflowReachable,
      hintWithinVisibleBand: warn.hintWithinVisibleBand, hintReachableWithoutScrolling, hint: warn.hintText });

  const composer2 = await page2.evaluate(() => document.querySelector('#prompt').value.length);
  check('B6 — a refused drain puts NOTHING in the composer',
    composer2 === 0, { composerLen: composer2 });

  mustFail('leg 4: swallowing the failure left the row silently reappearing with nothing shown (X8)',
    warn.isFirstChild && warn.namesTheCause,
    { preFix: 'no toast, no banner, no [role=alert] — the row just came back', shipped: `a ⚠ row of ${warn.textLen} chars across ${warn.lines} lines, naming the writer claim` });

  mustFail('leg 5: the round-2 warn row surfaced the error and clipped the instruction out of it',
    noSideClip && showsMultipleLines && hintReachableWithoutScrolling,
    { preFix: 'nowrap + ellipsis + slice(0,220): ~38 of 1115 chars, recovery hover-only',
      shipped: `whiteSpace:${warn.whiteSpace}, scrollWidth ${warn.scrollWidth} <= clientWidth ${warn.clientWidth}, ${warn.visibleLines} of ${warn.lines} lines visible, overflowY:${warn.overflowY}, instruction inside the visible band` });

  /* ───────── C — the paths a verifier's mutants walked straight through ───── */

  /*
   * V4 — `process all` MUST NOT pull from a group that is still filling.
   *
   * `index.ts` filters `all:true` to `i.ready` for `process` (but not for
   * `dismiss`), because collecting an item whose group is still accepting
   * members delivers a partial fan-out — the exact defect the whole group-settle
   * design exists to prevent. Dropping that filter left every suite green.
   *
   * Driven against the WRITER server with a genuinely in-flight group present.
   */
  {
    const g = 'g-inflight-v4';
    const dir = path.join(DATA, 'lanes');
    const all = JSON.parse(fs.readFileSync(path.join(DATA, 'lanes.json'), 'utf8'));
    const mk = (id, state, settled) => {
      fs.mkdirSync(path.join(dir, id), { recursive: true });
      fs.writeFileSync(path.join(dir, id, 'result.txt'), `body of ${id}`);
      return { ...all[0], id, groupId: g, groupSize: 2, groupOpen: false, groupClosed: true, groupClosedAt: Date.now() - MIN,
        state, settledAt: settled, resultPointer: settled ? path.join(dir, id, 'result.txt') : null,
        resultExcerpt: settled ? `body of ${id}` : null, handoffAt: null, handoffBytes: null, handoffEvidence: null,
        acknowledgedAt: null, acknowledgedBy: null, deliveryProof: null, acknowledgementEvidence: null,
        heldReason: null, dismissedAt: null, failureKind: null };
    };
    all.push(mk('lane-v4-done', 'settled', Date.now() - MIN));
    all.push(mk('lane-v4-running', 'running', null));
    /*
     * A READY CONTROL, ADDED IN ROUND 6. Without it this check said only
     * "`pulled` does not contain the unready ids", which is TRUE of an empty
     * `pulled` — so a `process all` that collected nothing at all (a 503, a
     * refused drain, a filter that excluded everything) certified the exact
     * property it exists to test. The standing vacuity scanner named this block
     * once it learned the `!xs.includes(…)` idiom, and a cross-provider
     * reviewer had independently flagged "the open-group item assertion" as
     * passing on empty input.
     *
     * This member is a complete, closed, single-lane group, so it IS ready and
     * MUST be collected. The check now asserts a positive and a negative
     * together: the filter discriminates, rather than merely declining.
     */
    const ready = { ...mk('lane-v4-control', 'settled', Date.now() - MIN), groupId: 'g-ready-v4', groupSize: 1 };
    all.push(ready);
    fs.writeFileSync(path.join(DATA, 'lanes.json'), JSON.stringify(all, null, 2));

    const before = await (await fetch(`http://127.0.0.1:${port}/api/lanes/pending?projectId=${pid}`)).json();
    const inflight = before.pending.find((i) => i.groupId === g);
    const okPre = !!inflight && inflight.ready === false;
    const res = await (await post(port, '/api/lanes/process', { all: true, projectId: pid })).json();
    const pulled = (res.lanes ?? []).map((l) => l.id);
    check('C1 — "process all" collects only READY items, never one from a group still in flight (V4)',
      okPre && pulled.length > 0 && pulled.includes('lane-v4-control')
        && !pulled.includes('lane-v4-done') && !pulled.includes('lane-v4-running'),
      { inflightItemReady: inflight?.ready, inflightItemId: inflight?.id,
        pulledCount: pulled.length, pulledTheReadyControl: pulled.includes('lane-v4-control'),
        pulledTheUnreadyOne: pulled.includes('lane-v4-done') });

    const after = JSON.parse(fs.readFileSync(path.join(DATA, 'lanes.json'), 'utf8'));
    const donerec = after.find((r) => r.id === 'lane-v4-done');
    check('C2 — and the in-flight group\'s finished member is untouched on disk',
      donerec.handoffAt == null && donerec.acknowledgedAt == null,
      { handoff: donerec.handoffAt, acknowledged: donerec.acknowledgedAt });

    mustFail('leg 6: without the ready-filter, "process all" delivers a partial fan-out (V4)',
      okPre && pulled.includes('lane-v4-control') && !pulled.includes('lane-v4-done'),
      { preFix: 'the unready member of an in-flight group would be collected by the primary button',
        shipped: `item ${inflight?.id} reported ready:${inflight?.ready} and was left alone` });
  }

  /*
   * V5 / V6 — the two USER-FACING failure paths with no coverage at all:
   * a PARTIAL skip (some lanes handed over, some not) and a REFUSED ACK after a
   * successful send. Both set `state.pendingActionProblem`; both mutants
   * (`→ null`) survived every suite.
   *
   * The server cannot reach a partial skip (`lanes.get()` and `pending()` read
   * one snapshot, and held records are prune-exempt) — the verifier said so and
   * I could not reach it either. So these are driven through the REAL client
   * functions with a stubbed API layer: the assertion is about `app.js`'s
   * handling, which is exactly where the mutants live.
   */
  {
    /*
     * Injected at the NETWORK, not by monkey-patching the module: `api` is an
     * ESM namespace object and is read-only, so assigning to it silently does
     * nothing (measured — the stub never ran and the real request went out).
     * Route interception is also the more faithful test: the real `api.js`,
     * the real `processPending`, the real render, only the server's answer
     * replaced.
     */
    const lanePayload = { id: 'lane-probe', label: 'probe lane', state: 'settled', failureKind: null, text: 'hello' };
    const receipt = { nonce: 'n', bytes: Buffer.byteLength('hello'), digest: 'd'.repeat(64) };

    // (a) PARTIAL SKIP — one lane handed over, one refused by the store.
    await page.route('**/api/lanes/process', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ receipt, itemIds: ['lane:lane-probe'], lanes: [lanePayload], bundle: 'hello',
        skipped: [{ id: 'lane-other', why: 'the store refused this one: disk full' }] }),
    }));
    await page.route('**/api/lanes/ack', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ acknowledged: ['lane-probe'], refused: [] }),
    }));
    const partial = await page.evaluate(async () => {
      const t = window.__station;
      if (!t?.processPending) return { unavailable: true };
      t.state.pendingActionProblem = null;
      await t.processPending(['lane:lane-probe']);
      const row = document.querySelector('#railPending [data-pending-problem] .bt');
      return { message: t.state.pendingActionProblem, rendered: row ? row.textContent.slice(0, 160) : null };
    });
    check('C3 — a PARTIAL skip is named at the user, with the store\'s own reason (V5)',
      !partial.unavailable && /still held/i.test(partial.message ?? '') && /disk full/.test(partial.message ?? '') && !!partial.rendered,
      { message: (partial.message ?? '(NONE)').slice(0, 150), renderedInRail: !!partial.rendered });

    // (b) REFUSED ACK after a successful send.
    await page.unroute('**/api/lanes/ack');
    await page.route('**/api/lanes/ack', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ acknowledged: [], refused: [{ id: 'lane-probe', why: 'the receipt did not prove possession' }] }),
    }));
    await page.unroute('**/api/lanes/process');
    await page.route('**/api/lanes/process', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ receipt, itemIds: ['lane:lane-probe'], lanes: [lanePayload], bundle: 'hello', skipped: [] }),
    }));
    const refusedAck = await page.evaluate(async () => {
      const t = window.__station;
      t.state.pendingActionProblem = null;
      await t.processPending(['lane:lane-probe']);
      const row = document.querySelector('#railPending [data-pending-problem] .bt');
      return { message: t.state.pendingActionProblem, rendered: row ? row.textContent.slice(0, 160) : null };
    });
    check('C4 — a REFUSED ACK after a successful send is named at the user (V6)',
      /offered again|could not be marked collected/i.test(refusedAck.message ?? '') && !!refusedAck.rendered,
      { message: (refusedAck.message ?? '(NONE)').slice(0, 150), renderedInRail: !!refusedAck.rendered });
    await page.unroute('**/api/lanes/process');
    await page.unroute('**/api/lanes/ack');

    mustFail('leg 7: both partial-skip and refused-ack used to fail silently (V5/V6)',
      !!partial.message && !!refusedAck.message,
      { preFix: 'state.pendingActionProblem stayed null on both paths — the row returned with nothing shown',
        shipped: `partial-skip ${(partial.message ?? '').length} chars, refused-ack ${(refusedAck.message ?? '').length} chars, both rendered` });
  }


  /*
   * C5 — DELIVER BEFORE ACKNOWLEDGE, observed at the moment the ack is sent.
   *
   * The cross-provider review's probe: `4 ack: composerHasResult=false`. It
   * extracted `processPending` and ran it with a stub that recorded whether the
   * composer already held the result WHEN `ackLanes` was called — and it did
   * not. An acknowledgement is the consumer's statement that it HAS the bytes
   * where it said it would put them; sending it first is a claim about the
   * future, and a failure in between leaves the ledger saying "collected" for a
   * result that reached nowhere the user can see.
   *
   * Adopted here against the REAL client in a REAL browser: the ack request is
   * intercepted and the composer inspected at that instant.
   */
  {
    const lanePayload = { id: 'lane-order', label: 'ordering lane', state: 'settled', failureKind: null, text: 'ORDERING-RESULT-BODY' };
    await page.evaluate(() => { window.__ackSawComposer = null; const b = document.querySelector('#prompt'); b.value = ''; b.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.route('**/api/lanes/process', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ receipt: { nonce: 'a'.repeat(32), channel: 'composer', bytes: 20, digest: 'd'.repeat(64) },
        itemIds: ['lane:lane-order'], lanes: [lanePayload], bundle: 'ORDERING-RESULT-BODY', skipped: [] }),
    }));
    await page.route('**/api/lanes/ack', async (route) => {
      // The instant the ack leaves the client: is the result already delivered?
      const seen = await page.evaluate(() => document.querySelector('#prompt').value.includes('ORDERING-RESULT-BODY'));
      await page.evaluate((v) => { window.__ackSawComposer = v; }, seen);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ acknowledged: ['lane-order'], refused: [] }) });
    });
    const ordering = await page.evaluate(async () => {
      const t = window.__station;
      t.state.pendingActionProblem = null;
      await t.processPending(['lane:lane-order']);
      return { ackSawComposer: window.__ackSawComposer,
               composerHasResultAfter: document.querySelector('#prompt').value.includes('ORDERING-RESULT-BODY') };
    });
    check('C5 — the result is IN the composer before the acknowledgement is sent (cross-provider finding 4)',
      ordering.ackSawComposer === true && ordering.composerHasResultAfter === true,
      { composerHasResultAtAckTime: ordering.ackSawComposer, composerHasResultAfter: ordering.composerHasResultAfter });
    mustFail('leg 8: the acknowledgement used to precede composer delivery (cross-provider finding 4)',
      ordering.ackSawComposer === true,
      { preFix: 'ack:composerHasResult=false — the ledger could record "collected" for a result the user never received',
        shipped: `composer already held the result when ack was issued: ${ordering.ackSawComposer}` });
    await page.unroute('**/api/lanes/process');
    await page.unroute('**/api/lanes/ack');
  }

  /*
   * W5 — A MISSING COMPOSER MUST REFUSE TO ACKNOWLEDGE.
   *
   * The round-5 fix made `showPendingBundle` return a verdict and read the
   * composer back, precisely so that "there is nowhere to put this" is a
   * refusal rather than a silent success. Round 6 measured that property with
   * mutant W5 — make the missing-composer branch return `{delivered:true}` —
   * and it SURVIVED: nothing anywhere noticed. C5 proves delivery precedes the
   * ack when a composer exists; nothing proved what happens when one does not,
   * which is the whole point of checking the destination.
   *
   * Driven against the real client: the composer node is removed from the DOM,
   * a drain is served, and the ack endpoint is watched. No ack may be sent, the
   * failure must be NAMED at the user, and the rail must refresh so the results
   * are offered again.
   */
  {
    const lanePayload = { id: 'lane-nocomposer', label: 'homeless lane', state: 'settled', failureKind: null, text: 'HOMELESS-RESULT-BODY' };
    await page.route('**/api/lanes/process', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ receipt: { nonce: 'b'.repeat(32), channel: 'composer', bytes: 20, digest: 'e'.repeat(64) },
        itemIds: ['lane:lane-nocomposer'], lanes: [lanePayload], bundle: 'HOMELESS-RESULT-BODY', skipped: [] }),
    }));
    await page.route('**/api/lanes/ack', async (route) => {
      await page.evaluate(() => { window.__ackWasSent = true; });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ acknowledged: ['lane-nocomposer'], refused: [] }) });
    });
    const homeless = await page.evaluate(async () => {
      const t = window.__station;
      window.__ackWasSent = false;
      t.state.pendingActionProblem = null;
      const box = document.querySelector('#prompt');
      const parent = box.parentNode;
      const next = box.nextSibling;
      box.remove();                                  // the destination is GONE
      const composerPresent = !!document.querySelector('#prompt');
      let threw = null;
      try { await t.processPending(['lane:lane-nocomposer']); } catch (e) { threw = String(e && e.message); }
      const problem = t.state.pendingActionProblem;
      parent.insertBefore(box, next);                // put the page back
      return { composerPresent, ackWasSent: window.__ackWasSent, problem, threw,
               composerRestored: !!document.querySelector('#prompt') };
    });
    check('W5 — with NO composer on screen, nothing is acknowledged and the user is told (round-6 probe)',
      homeless.composerPresent === false && homeless.ackWasSent === false
        && typeof homeless.problem === 'string' && homeless.problem.length > 0
        && /message box|still held|offered again/i.test(homeless.problem)
        && homeless.threw === null && homeless.composerRestored === true,
      { composerPresentDuringRun: homeless.composerPresent, ackWasSent: homeless.ackWasSent,
        problemShown: (homeless.problem ?? '').slice(0, 120), threw: homeless.threw });
    mustFail('leg 9: a missing composer used to acknowledge anyway — "collected" for a result that reached nowhere',
      homeless.ackWasSent === false && typeof homeless.problem === 'string' && homeless.problem.length > 0,
      { preFix: 'showPendingBundle returned nothing, so processPending acknowledged regardless of whether a destination existed',
        shipped: `no ack was sent and the user was told: "${(homeless.problem ?? '').slice(0, 80)}"` });
    await page.unroute('**/api/lanes/process');
    await page.unroute('**/api/lanes/ack');
  }

  /*
   * C6 — A COMPOSER TORN DURING THE ASYNC GAP IS CAUGHT AT THE ACK INSTANT.
   *
   * Round 6 checked the composer once, INSIDE showPendingBundle, before the
   * digest await. A third cross-provider review showed that only proves
   * something about the instant it runs:
   *   4 replace-on-input      {"acks":1,"refresh":1,"connected":false}
   *   4 replace-during-digest {"acks":1,"refresh":1,"connected":false}
   * A listener on the very `input` event the write dispatches can detach the
   * composer — ordinary re-render-on-input behaviour — and the round-6 check had
   * already passed. The round-7 fix RE-ASKS `composerProblem` immediately before
   * the ack, after every await. This drives exactly that scenario against the
   * REAL client in a REAL browser: an input listener removes #prompt during the
   * write; the pre-ack re-check must refuse, no ack may be sent, and the user
   * must be told. W5 above proves a composer missing BEFORE the run refuses;
   * this proves the harder torn-DURING-the-gap case the round-6 check missed.
   */
  {
    const lanePayload = { id: 'lane-torn', label: 'torn lane', state: 'settled', failureKind: null, text: 'TORN-RESULT-BODY' };
    await page.route('**/api/lanes/process', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ receipt: { nonce: 'c'.repeat(32), channel: 'composer', bytes: 16, digest: 'f'.repeat(64) },
        itemIds: ['lane:lane-torn'], lanes: [lanePayload], bundle: 'TORN-RESULT-BODY', skipped: [] }),
    }));
    await page.route('**/api/lanes/ack', async (route) => {
      await page.evaluate(() => { window.__ackWasSentTorn = true; });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ acknowledged: ['lane-torn'], refused: [] }) });
    });
    const torn = await page.evaluate(async () => {
      const t = window.__station;
      window.__ackWasSentTorn = false;
      t.state.pendingActionProblem = null;
      const box = document.querySelector('#prompt');
      const parent = box.parentNode, next = box.nextSibling;
      box.value = '';
      // The write dispatches `input`; this listener tears the composer out on it,
      // AFTER showPendingBundle's own pre-await check has already passed. `once`
      // so the re-inserted node below is clean for any later work.
      box.addEventListener('input', () => { if (box.isConnected) box.remove(); }, { once: true });
      let threw = null;
      try { await t.processPending(['lane:lane-torn']); } catch (e) { threw = String(e && e.message); }
      const problem = t.state.pendingActionProblem;
      const wasDetached = !box.isConnected;
      if (!box.isConnected) parent.insertBefore(box, next);   // put the page back
      return { ackWasSent: window.__ackWasSentTorn, problem, threw, wasDetached };
    });
    check('C6 — a composer torn on the input event is caught at the ACK INSTANT; nothing is acknowledged (cross-provider finding 3)',
      torn.wasDetached === true && torn.ackWasSent === false
        && typeof torn.problem === 'string' && /message box|still held|offered again/i.test(torn.problem)
        && torn.threw === null,
      { composerDetachedDuringWrite: torn.wasDetached, ackWasSent: torn.ackWasSent,
        problemShown: (torn.problem ?? '').slice(0, 120), threw: torn.threw });
    mustFail('leg 10: the composer check ran only before the await, so a torn composer still acknowledged (cross-provider finding 3)',
      torn.wasDetached === true && torn.ackWasSent === false && typeof torn.problem === 'string' && torn.problem.length > 0,
      { preFix: 'isConnected was checked once, before the digest await; a listener detaching on input slipped past it and the ack went out',
        shipped: `re-checked at the ack instant: no ack was sent and the user was told "${(torn.problem ?? '').slice(0, 80)}"` });
    await page.unroute('**/api/lanes/process');
    await page.unroute('**/api/lanes/ack');
  }

  /*
   * C7 — A COMPOSER INSIDE A HIDDEN ANCESTOR IS NOT A VISIBLE DESTINATION.
   * `4 hidden-ancestor {"acks":1,...}` — the box's own `hidden` was false but a
   * PARENT was hidden, and only `box.hidden` was checked, so it acknowledged into
   * a composer the user cannot see. `composerProblem` now walks ancestors.
   *
   * C8 — A RE-CHECK THAT THROWS IS A REFUSAL, NOT AN ESCAPE.
   * `4 throw-recheck {"acks":0,"refresh":0,"rejected":true,"problem":false}` — the
   * pre-ack re-check threw and the whole turn escaped with nothing shown. A check
   * that cannot answer must refuse: no ack, a problem, a refresh.
   */
  {
    const mk = (id, body) => ({ receipt: { nonce: 'd'.repeat(32), channel: 'composer', bytes: body.length, digest: '0'.repeat(64) }, itemIds: [`lane:${id}`], lanes: [{ id, label: id, state: 'settled', failureKind: null, text: body }], bundle: body, skipped: [] });
    for (const [name, id, arm] of [
      ['C7', 'lane-hidden-anc', () => { const box = document.querySelector('#prompt'); box.hidden = false; box.parentElement.hidden = true; return () => { box.parentElement.hidden = false; }; }],
      ['C8', 'lane-throw-recheck', () => {
        const box = document.querySelector('#prompt');
        let n = 0; const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), 'isConnected');
        Object.defineProperty(box, 'isConnected', { configurable: true, get() { n++; if (n >= 2) throw new Error('isConnected recheck'); return true; } });
        return () => { delete box.isConnected; if (d) Object.defineProperty(Object.getPrototypeOf(box), 'isConnected', d); };
      }],
    ]) {
      await page.route('**/api/lanes/process', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mk(id, `BODY-${id}`)) }));
      await page.route('**/api/lanes/ack', async (route) => { await page.evaluate(() => { window.__ackSent = true; }); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ acknowledged: [id], refused: [] }) }); });
      const out = await page.evaluate(async ({ id, armSrc }) => {
        const t = window.__station; window.__ackSent = false; t.state.pendingActionProblem = null;
        document.querySelector('#prompt').value = '';
        const restore = (new Function('return (' + armSrc + ')')())();
        let threw = null;
        try { await t.processPending([`lane:${id}`]); } catch (e) { threw = String(e && e.message); }
        const problem = t.state.pendingActionProblem;
        try { restore(); } catch { /* best effort */ }
        return { ackSent: window.__ackSent, problem, threw };
      }, { id, armSrc: arm.toString() });
      check(`${name} — a composer that is not a visible, answerable destination refuses to acknowledge and tells the user (cross-provider finding 3)`,
        out.ackSent === false && out.threw === null && typeof out.problem === 'string' && out.problem.length > 0,
        { ackSent: out.ackSent, escaped: out.threw, problemShown: (out.problem ?? '').slice(0, 120) });
      mustFail(`${name} must-FAIL: this destination used to acknowledge (or escape) silently (cross-provider finding 3)`,
        out.ackSent === false && out.threw === null && typeof out.problem === 'string' && out.problem.length > 0,
        { shipped: `no ack, no escape, user told: "${(out.problem ?? '').slice(0, 70)}"` });
      await page.unroute('**/api/lanes/process');
      await page.unroute('**/api/lanes/ack');
    }
  }

  /*
   * C9 — A PROJECT SWITCH MID-DRAIN MUST NOT LEAK ONE PROJECT'S RESULT INTO
   * ANOTHER. Round-9 finding 5 (the most serious): while `processPending` awaits
   * the drain, the user switches project A→B; `node.prompt` is a boot cache, so
   * A's collected results were written into B's composer and acknowledged
   * (`rail switch: destination:"B" contains:true acks:1`). Driven against the REAL
   * client in a REAL browser: the drain response is HELD, the session is switched
   * to B, then released — B's composer must NOT contain A's result and nothing is
   * acknowledged.
   */
  {
    const shotDir0 = path.join(ROOT, '.playwright-mcp');
    fs.mkdirSync(shotDir0, { recursive: true });
    let releaseProcess;
    const held = new Promise((res) => { releaseProcess = res; });
    await page.route('**/api/lanes/process', async (route) => {
      await held;
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ receipt: { nonce: 'e'.repeat(32), channel: 'composer', bytes: 16, digest: '0'.repeat(64) },
          itemIds: ['lane:lane-xproj'], lanes: [{ id: 'lane-xproj', label: 'x lane', state: 'settled', failureKind: null, text: 'PROJECT-A-RESULT' }], bundle: 'PROJECT-A-RESULT', skipped: [] }) });
    });
    await page.route('**/api/lanes/ack', async (route) => { await page.evaluate(() => { window.__xprojAck = true; }); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ acknowledged: ['lane-xproj'], refused: [] }) }); });
    await page.evaluate(() => {
      const t = window.__station;
      window.__xprojAck = false;
      t.state.pendingActionProblem = null;
      t.state.current = { id: 'A', projectId: 'A' };
      document.querySelector('#prompt').value = '';
      window.__xprojPromise = t.processPending(['lane:lane-xproj']);
    });
    await page.evaluate(() => { window.__station.state.current = { id: 'B', projectId: 'B' }; }); // switch mid-drain
    releaseProcess();
    const res = await page.evaluate(async () => {
      try { await window.__xprojPromise; } catch { /* refusal is not a throw, but be safe */ }
      return { ackSent: window.__xprojAck, aInB: document.querySelector('#prompt').value.includes('PROJECT-A-RESULT'),
        problem: window.__station.state.pendingActionProblem, destination: window.__station.state.current.id };
    });
    check('C9 — a project switch mid-drain does NOT leak A\'s result into B\'s composer, and nothing is acknowledged (round-9 finding 5)',
      res.ackSent === false && res.aInB === false && res.destination === 'B' && typeof res.problem === 'string' && res.problem.length > 0,
      { ackSent: res.ackSent, aResultInBcomposer: res.aInB, destination: res.destination, problemShown: (res.problem ?? '').slice(0, 120) });
    mustFail('leg 11: A\'s result used to be inserted into B\'s composer and acknowledged after a mid-drain session switch (round-9 finding 5)',
      res.ackSent === false && res.aInB === false,
      { shipped: `no cross-project leak, no ack; user told: "${(res.problem ?? '').slice(0, 70)}"` });
    await page.screenshot({ path: path.join(shotDir0, 'arch-017-r9-xproject.png') });
    if (!ONLY_MUST_FAIL) console.log(`      screenshot: ${path.join(shotDir0, 'arch-017-r9-xproject.png')}`);
    await page.unroute('**/api/lanes/process');
    await page.unroute('**/api/lanes/ack');
  }

  /*
   * C10 — THE NEGATIVE SESSION CASE (round-10 finding 1). Round 9 compared
   * `state.current.id`, which does not exist on a selected session
   * (`{sessionId, projectId, ...}`), so the guard passed for EVERY destination and
   * the round-9 "proof" screenshot showed only the happy path. This drives the
   * cases that must REFUSE: the session changed to a DIFFERENT one, and the session
   * is GONE (null). A result must not land in either. Fails if the guard is deleted
   * (mutant W26). Screenshots saved per case.
   */
  {
    const shotDir1 = path.join(ROOT, '.playwright-mcp');
    fs.mkdirSync(shotDir1, { recursive: true });
    for (const [dest, next] of [['other', { sessionId: 'S2', projectId: 'P' }], ['gone', null]]) {
      let releaseP; const held = new Promise((r) => { releaseP = r; });
      await page.route('**/api/lanes/process', async (route) => { await held; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ receipt: { nonce: 'e'.repeat(32), channel: 'composer', bytes: 16, digest: '0'.repeat(64) }, itemIds: ['lane:lane-sess'], lanes: [{ id: 'lane-sess', label: 's', state: 'settled', failureKind: null, text: 'PRIVATE-A-RESULT' }], bundle: 'PRIVATE-A-RESULT', skipped: [] }) }); });
      await page.route('**/api/lanes/ack', async (route) => { await page.evaluate(() => { window.__sessAck = true; }); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ acknowledged: ['lane-sess'], refused: [] }) }); });
      await page.evaluate(() => { const t = window.__station; window.__sessAck = false; t.state.pendingActionProblem = null; t.state.current = { sessionId: 'S1', projectId: 'P' }; document.querySelector('#prompt').value = ''; window.__sessP = t.processPending(['lane:lane-sess']); });
      await page.evaluate((n) => { window.__station.state.current = n; }, next);
      releaseP();
      const res = await page.evaluate(async () => { try { await window.__sessP; } catch { /* refusal is not a throw */ } return { ackSent: window.__sessAck, leaked: document.querySelector('#prompt').value.includes('PRIVATE-A-RESULT'), problem: window.__station.state.pendingActionProblem }; });
      check(`C10/${dest} — a result refuses to land when the session ${dest === 'gone' ? 'is GONE' : 'DIFFERS'}; no ack, no leak (round-10 finding 1, the NEGATIVE case)`,
        res.ackSent === false && res.leaked === false && typeof res.problem === 'string' && res.problem.length > 0,
        { ackSent: res.ackSent, resultLeaked: res.leaked, problemShown: (res.problem ?? '').slice(0, 120) });
      mustFail(`leg 12/${dest}: a differing/absent session used to receive and acknowledge another session's result (round-10 finding 1)`,
        res.ackSent === false && res.leaked === false,
        { shipped: `no ack, no leak; user told: "${(res.problem ?? '').slice(0, 70)}"` });
      await page.screenshot({ path: path.join(shotDir1, `arch-017-r10-session-${dest}.png`) });
      if (!ONLY_MUST_FAIL) console.log(`      screenshot: ${path.join(shotDir1, `arch-017-r10-session-${dest}.png`)}`);
      await page.unroute('**/api/lanes/process');
      await page.unroute('**/api/lanes/ack');
    }
  }

  /*
   * C11 — THE SESSION GUARD KEYS ON EVERYTHING SELECTION STORES, AND REFUSES AN
   * ABSENT DESTINATION (round-11 finding 2). The seventh review showed round 10's
   * guard still delivered when it must not:
   *   absent:    sessionId null on both sides ⇒ null === null passed
   *   directory: `encodedDir` changed (which selection DOES key on) but was never
   *              compared — driven here by mutating the SAME object in place, so
   *              the reference check cannot be what saves us and the field check
   *              is proven non-vacuous
   *   recreated: the same id re-selected is a NEW state.current object — caught by
   *              the object-reference check
   * All three must REFUSE (no ack, no leak, user told). Fails if the guard is
   * reverted (mutant W36).
   */
  {
    const shotDirC = path.join(ROOT, '.playwright-mcp');
    fs.mkdirSync(shotDirC, { recursive: true });
    // 'mutate' cases change state.current IN PLACE (same reference); 'replace' cases assign a new object.
    for (const [dest, kind, payload] of [
      ['absent', 'start-null', null],
      ['directory', 'mutate', { encodedDir: 'dir2' }],
      ['recreated', 'replace', { sessionId: 'S1', projectId: 'P', encodedDir: 'dir1' }],
    ]) {
      let releaseP; const held = new Promise((r) => { releaseP = r; });
      await page.route('**/api/lanes/process', async (route) => { await held; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ receipt: { nonce: 'a'.repeat(32), channel: 'composer', bytes: 16 }, itemIds: ['lane:lane-c11'], lanes: [{ id: 'lane-c11', label: 's', state: 'settled', failureKind: null, text: 'PRIVATE-C11-RESULT' }], bundle: 'PRIVATE-C11-RESULT', skipped: [] }) }); });
      await page.route('**/api/lanes/ack', async (route) => { await page.evaluate(() => { window.__c11Ack = true; }); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ acknowledged: ['lane-c11'], refused: [] }) }); });
      await page.evaluate((startNull) => {
        const t = window.__station; window.__c11Ack = false; t.state.pendingActionProblem = null;
        t.state.current = { sessionId: startNull ? null : 'S1', projectId: 'P', encodedDir: 'dir1' };
        document.querySelector('#prompt').value = '';
        window.__c11P = t.processPending(['lane:lane-c11']);
      }, kind === 'start-null');
      await page.evaluate(({ k, p }) => {
        const t = window.__station;
        if (k === 'mutate') Object.assign(t.state.current, p);          // SAME object reference, changed field
        else if (k === 'replace') t.state.current = p;                  // new object, identical fields
        /* start-null: leave it — the destination was absent from the start */
      }, { k: kind, p: payload });
      releaseP();
      const res = await page.evaluate(async () => { try { await window.__c11P; } catch { /* refusal is not a throw */ } return { ackSent: window.__c11Ack, leaked: document.querySelector('#prompt').value.includes('PRIVATE-C11-RESULT'), problem: window.__station.state.pendingActionProblem }; });
      check(`C11/${dest} — a result refuses to land when the session is ${dest} (round-11 finding 2)`,
        res.ackSent === false && res.leaked === false && typeof res.problem === 'string' && res.problem.length > 0,
        { ackSent: res.ackSent, resultLeaked: res.leaked, problemShown: (res.problem ?? '').slice(0, 120) });
      mustFail(`leg 13/${dest}: an absent / directory-changed / recreated session used to receive and acknowledge another context's result (round-11 finding 2)`,
        res.ackSent === false && res.leaked === false,
        { shipped: `no ack, no leak; user told: "${(res.problem ?? '').slice(0, 70)}"` });
      await page.unroute('**/api/lanes/process');
      await page.unroute('**/api/lanes/ack');
    }
  }

  const shotDir = path.join(ROOT, '.playwright-mcp');
  fs.mkdirSync(shotDir, { recursive: true });
  const shot = path.join(shotDir, 'arch-017-r3-warn-readable.png');
  await page2.screenshot({ path: shot });
  if (!ONLY_MUST_FAIL) console.log(`      screenshot: ${shot}`);

  stopByPid(srv2.pid); stopByPid(srv.pid);
} catch (e) {
  fail++;
  console.log(`FAIL harness: ${e.message}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const s of servers) stopByPid(s.pid);
  await sleep(400);
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* scratch */ } }
}

console.log(`\nRESULT ${pass} PASS / ${fail} FAIL${ONLY_MUST_FAIL ? '  (must-FAIL legs only)' : ''}`);
process.exit(fail ? 1 : 0);
