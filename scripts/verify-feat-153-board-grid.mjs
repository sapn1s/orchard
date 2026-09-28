/**
 * FEAT-153 — the ticket-board GRID verification, driven in a REAL Chromium
 * (brave --headless=new over raw CDP) against a REAL server rendering the real
 * public/app.js.
 *
 *   node scripts/verify-feat-153-board-grid.mjs
 *
 * The board is REAL on disk (a realistic busy day: 4 needs-you incl. a bare
 * status ticket, 3 in-flight, 8 queued, 2 done — a mix of BUG/FEAT/ARCH and
 * high/med/low), registered through the API and read by the real board reader.
 *
 * The session↔ticket linkage (state.requests bindings + state.snap live-lane
 * attribution) is INJECTED via window.__station.state, then the real renderRail
 * runs — because minting real request records needs a live orchestrator turn
 * (requests.observeAssistantText over an orchard-request block), which this
 * headless harness has no session to produce. The RENDER, the partition, and the
 * click→answer flow it drives are all the real code; only the two declared inputs
 * are synthesised, and that is stated here per the WA "say so" rule.
 *
 * Checks:
 *   a. the grid renders one card per UNRESOLVED ticket (needs+inflight+queued),
 *      never a done ticket; each card carries its id, title, kind tag and state;
 *   b. needs-you cards carry the accent ring; a bare-status needs card is NOT
 *      answerable and opens the ticket modal, an answerable one opens the answer;
 *   c. the current session's tickets render in a "This session" section at full
 *      opacity; every other ticket is dimmed (opacity < 1), full on hover;
 *   d. answering a needs card writes to the ticket file on disk (append-only) and
 *      clears the mount;
 *   e. no horizontal overflow at the real rail width;
 *   f. the "others" section collapses and the choice PERSISTS (localStorage);
 *   g. a project with no board shows a hidden grid, not an error.
 *
 * Screenshots (collapsed+expanded × light+dark, at 1440 and 1024) → /tmp/feat-153-r2/.
 * Ports are OS-assigned; never 4317. Processes killed by PID, never pkill.
 *
 * FEAT-153 r2 — the round-2 fix defects each get a must-FAIL assertion here
 * (checks h–m): they RED on the round-1 code and green on the fix.
 *   h. the grid has NO inner scroll (one scroll surface = #railPanel);
 *   i. #railPanel scroll position SURVIVES a poll re-render;
 *   j. a keyed poll re-render REUSES card nodes (no clear()+rebuild flicker);
 *   k. cards carry NO redundant kind tag (the id already shows "BUG-201");
 *   l. the rail header names the new role ("Board", not "Needs you");
 *   m. needs-you emphasis is the ring, not ALSO a "needs you" chip (pick one).
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_GRID_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-grid-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-grid-store-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-grid-chrome-'));
const WITH = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-grid-with-'));
const WITHOUT = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-grid-none-'));
const SHOTS = '/tmp/feat-153-r3';
const BRAVE = process.env.VERIFY_GRID_BROWSER ?? 'brave';
fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c = new Cdp(ws);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && c.waiting.has(m.id)) {
        const { res, rej } = c.waiting.get(m.id);
        c.waiting.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.waiting.set(id, { res, rej }));
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async waitFor(label, expr, timeoutMs = 20_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.eval(expr)) return true; } catch { /* mid-navigation */ }
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  async shot(name) {
    try {
      const r = await this.send('Page.captureScreenshot', { format: 'png' });
      const p = path.join(SHOTS, name);
      fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
      console.log(`        shot → ${p}`);
    } catch (e) { console.log(`        (screenshot ${name} failed: ${e.message})`); }
  }
  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

let server = null, browser = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

const ANSWER = `ship it — grid-answer-${Date.now()}`;
const PRIOR_LOG = 'orchestrator filed this on 2026-09-20';

// A realistic busy board. Owner glyphs: 👤 needs-you, 🤖 in-flight, — queued.
const ROWS = [
  ['BUG-201', 'importer drops rows silently under load', '👤', 'needs decision', 'high', true],
  ['FEAT-202', 'expose the retry budget in settings', '👤', 'needs decision', 'med', true],
  ['BUG-203', 'review the new billing copy before release', '👤', 'user-owned', 'low', false],
  ['ARCH-204', 'one liveness authority, or keep two?', '👤', 'needs decision', 'high', true],
  ['BUG-205', 'flaky reconnect after sleep', '🤖', 'building', 'med', false],
  ['FEAT-206', 'inline diff chips on the git view', '🤖', 'building', 'low', false],
  ['BUG-207', 'orphaned lane after crash', '🤖', 'building', 'high', false],
  ['FEAT-208', 'keyboard nav for the ticket board', '—', 'queued', 'low', false],
  ['FEAT-209', 'export usage as csv', '—', 'queued', 'low', false],
  ['BUG-210', 'tooltip clips at the rail edge', '—', 'queued', 'med', false],
  ['FEAT-211', 'per-project theme override', '—', 'queued', 'low', false],
  ['BUG-212', 'stale badge count after switch', '—', 'queued', 'med', false],
  ['FEAT-213', 'bulk-dismiss stopped agents', '—', 'queued', 'low', false],
  ['BUG-214', 'wrong timezone in day labels', '—', 'queued', 'low', false],
  ['FEAT-215', 'pin a ticket to the top', '—', 'queued', 'low', false],
];
const DONE = [
  ['BUG-220', 'fix the double-render on boot', 'abc1234'],
  ['BUG-221', 'guard the empty-board case', 'def5678'],
];
const ANSWERABLE_ID = 'BUG-201';
const STATUS_ID = 'BUG-203';

// Injected session↔ticket declarations (see header): the open session owns one
// needs, one in-flight and one queued ticket via a request binding, plus one more
// needs ticket via a live-lane Dispatch attribution.
const MINE = ['BUG-201', 'BUG-205', 'FEAT-208', 'FEAT-202'];

function seedBoard() {
  const bugs = path.join(WITH, 'docs', 'bugs');
  fs.mkdirSync(bugs, { recursive: true });
  const open = ROWS.map(([id, t, owner, status, sev]) => `| ${id} | ${t} | ${owner} | ${status} | ${sev} |`).join('\n');
  const done = DONE.map(([id, t, commit]) => `| ${id} | ${t} | ${commit} |`).join('\n');
  fs.writeFileSync(path.join(bugs, 'INDEX.md'),
    `# Board\n\n## Open\n\n` +
    `| ID | Title | Owner | Status | Sev |\n|----|-------|-------|--------|-----|\n${open}\n\n` +
    `## Done (committed)\n\n| ID | Title | Commit |\n|----|-------|--------|\n${done}\n`);
  // The answerable needs ticket carries a real ## Question + options + a prior log.
  fs.writeFileSync(path.join(bugs, `${ANSWERABLE_ID}-importer-rows.md`),
    `# ${ANSWERABLE_ID} — importer drops rows silently under load\n\n` +
    `- **Status:** OPEN\n- **Severity:** high\n\n` +
    `## Question\nShould the importer skip malformed rows, or halt the whole batch?\n` +
    `- skip and log\n- halt\n\n` +
    `## Activity log (APPEND-ONLY)\n\n### 2026-09-20 — orchestrator\n- ${PRIOR_LOG}\n`);
  // The bare-status needs ticket: no ## Question anywhere → read-only.
  fs.writeFileSync(path.join(bugs, `${STATUS_ID}-billing-copy.md`),
    `# ${STATUS_ID} — review the new billing copy before release\n\n` +
    `- **Status:** OPEN\n- **Severity:** low\n\n` +
    `## Activity log (APPEND-ONLY)\n\n### 2026-09-20 — orchestrator\n- marked 👤, user to review copy.\n`);
  fs.writeFileSync(path.join(WITHOUT, 'README.md'), '# no board here\n');
}

// FEAT-153 r3 — rewrite the busy board's INDEX from a mutable rows array so the
// mutation checks below can change / add / remove / reorder a ticket ON DISK and
// let the REAL 5s rail poll pick it up, exactly as a live user's board changes.
function writeBoardIndex(rows) {
  const open = rows.map(([id, t, owner, status, sev]) => `| ${id} | ${t} | ${owner} | ${status} | ${sev} |`).join('\n');
  const done = DONE.map(([id, t, commit]) => `| ${id} | ${t} | ${commit} |`).join('\n');
  fs.writeFileSync(path.join(WITH, 'docs', 'bugs', 'INDEX.md'),
    `# Board\n\n## Open\n\n` +
    `| ID | Title | Owner | Status | Sev |\n|----|-------|-------|--------|-----|\n${open}\n\n` +
    `## Done (committed)\n\n| ID | Title | Commit |\n|----|-------|--------|\n${done}\n`);
}

async function registerProject(hostPath, name) {
  const r = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath, name }),
  })).json();
  if (!r.project?.id) throw new Error(`could not register ${name}: ${JSON.stringify(r)}`);
  return r.project.id;
}

// The injection: set the declared session→ticket inputs and re-render.
const injectExpr = `(() => {
  const s = window.__station.state;
  s.requests = [{ id: 'REQ-1', stationSessionId: 'sess-x', projectId: s.current.projectId,
                  title: 'ship the importer fix', source: null,
                  tickets: ['BUG-201', 'BUG-205', 'FEAT-208'], createdAt: '', updatedAt: '' }];
  s.snap = { v: 1, turn: { running: true }, running: [
    { id: 'lane-1', row: 'sub', label: 'worker', background: true, ticket: ['FEAT-202'] },
  ] };
  window.__station.renderRail();
  return true;
})()`;

async function main() {
  seedBoard();
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); }
  }
  if (!up) throw new Error('server never became healthy');

  const withId = await registerProject(WITH, 'Busy Board');
  const withoutId = await registerProject(WITHOUT, 'No Board');

  const b = await (await fetch(`${BASE}/api/projects/${withId}/board`)).json();
  // doneToday is a <24h window over commit/mtime, so seeded rows legitimately
  // count 0 — the grid excludes done regardless; assert only the unresolved lanes.
  check('PRECONDITION: the busy board parses (4 needs, 3 inflight, 8 queued)',
    b.needsYou?.length === 4 && b.inflight?.length === 3 && b.queued?.length === 8,
    JSON.stringify({ needs: b.needsYou?.length, inflight: b.inflight?.length, queued: b.queued?.length, done: b.doneToday?.length }));

  browser = spawn(BRAVE, [
    '--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--window-size=1400,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  if (!devPort) throw new Error('browser never wrote DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const clickProj = async (name) => cdp.eval(`(() => {
    const find = () => [...document.querySelectorAll('#tree button.proj')]
      .find((r) => (r.querySelector('.nm')?.textContent ?? '').includes(${JSON.stringify(name)}));
    let row = find();
    if (!row) { const t = document.querySelector('#tree .inactive-l'); if (t) { t.click(); row = find(); } }
    if (!row) return false;
    row.click(); return true;
  })()`);

  console.log('\n=== the board grid is the primary immediate view ===');
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('boot', `document.querySelectorAll('#tree button.proj').length >= 2 || !!document.querySelector('#tree .inactive-l')`, 30_000);
  check('PRECONDITION: the busy-board project is selectable', await clickProj('Busy Board'), 'clicked');
  await cdp.waitFor('grid cards', `!document.querySelector('#railBoardGrid')?.hidden && document.querySelectorAll('#railBoardGrid .tc').length >= 15`, 20_000);

  // (a) one card per UNRESOLVED ticket, never a done ticket.
  const grid = await cdp.eval(`(() => {
    const cards = [...document.querySelectorAll('#railBoardGrid .tc')];
    const ids = cards.map((c) => c.dataset.id);
    const anyKind = cards.some((c) => !!c.querySelector('.nc-kind'));
    const needsCard = document.querySelector('#railBoardGrid .tc[data-id="${ANSWERABLE_ID}"]');
    const queuedCard = document.querySelector('#railBoardGrid .tc[data-id="FEAT-208"]');
    return {
      count: cards.length,
      ids,
      hasDone: ids.includes('BUG-220') || ids.includes('BUG-221'),
      anyKind,
      // a card's structural contract: id + title always; a state chip on the
      // non-needs cards (needs uses the ring instead — see check m).
      queuedShape: queuedCard ? {
        hasId: !!queuedCard.querySelector('.tc-id')?.textContent,
        hasTitle: !!queuedCard.querySelector('.tc-title')?.textContent,
        hasStateChip: !!queuedCard.querySelector('.tc-state'),
      } : null,
      needsHasTitle: !!needsCard?.querySelector('.tc-title')?.textContent,
    };
  })()`);
  check('(a) the grid renders exactly the 15 unresolved tickets and NO done ticket',
    grid.count === 15 && !grid.hasDone, JSON.stringify({ count: grid.count, hasDone: grid.hasDone }));
  check('    a queued card carries id + title + state chip; a needs card carries a title',
    grid.queuedShape && grid.queuedShape.hasId && grid.queuedShape.hasTitle && grid.queuedShape.hasStateChip && grid.needsHasTitle,
    JSON.stringify(grid.queuedShape));
  // (k) DEFECT #4 — the kind TAG ("BUG") duplicated the id prefix ("BUG-201").
  // MUST-FAIL on round-1 (every card had a .nc-kind).
  check('(k) no card carries a redundant kind tag (.nc-kind) — the id already shows the kind',
    grid.anyKind === false, JSON.stringify({ anyKind: grid.anyKind }));

  // (b) needs-you accent ring.
  const ring = await cdp.eval(`(() => {
    const c = document.querySelector('#railBoardGrid .tc[data-id="${ANSWERABLE_ID}"]');
    const q = document.querySelector('#railBoardGrid .tc[data-id="FEAT-208"]');
    const cs = getComputedStyle(c), qs = getComputedStyle(q);
    return { needsState: c?.dataset.state, needsRing: cs.boxShadow, needsAnswerable: c?.dataset.answerable === '1',
             needsChip: !!c?.querySelector('.tc-state'), needsAria: c?.getAttribute('aria-label') ?? '',
             queuedState: q?.dataset.state, queuedRing: qs.boxShadow, queuedChip: !!q?.querySelector('.tc-state') };
  })()`);
  check('(b) a needs-you card is data-state="needs", answerable, and carries an accent ring (box-shadow); a queued card has none',
    ring.needsState === 'needs' && ring.needsAnswerable && ring.needsRing !== 'none' && ring.needsRing.length > 3 &&
    ring.queuedState === 'queued' && (ring.queuedRing === 'none' || ring.queuedRing === ''),
    JSON.stringify(ring));
  // (m) DEFECT #5 (ring vs chip) — needs-you emphasis is the RING ALONE, not also
  // a "needs you" chip; the accessible name still says "needs you". A queued card
  // keeps its chip. MUST-FAIL on round-1 (needs cards carried both ring AND chip).
  check('(m) a needs card has the ring but NO redundant state chip (aria says "needs you"); the queued card keeps its chip',
    ring.needsChip === false && /needs you/i.test(ring.needsAria) && ring.queuedChip === true,
    JSON.stringify({ needsChip: ring.needsChip, queuedChip: ring.queuedChip, needsAria: ring.needsAria }));

  // (l) DEFECT #5 (header) — the rail header names the board role, not "Needs
  // you". MUST-FAIL on round-1 (the header literal was "Needs you").
  const header = await cdp.eval(`document.querySelector('#railPanel .rail-head .lbl')?.textContent?.trim() ?? ''`);
  check('(l) the rail header reads "Board" (the panel is a board grid, not a needs-you list)',
    header === 'Board', JSON.stringify({ header }));

  // (h) DEFECT #1 — no nested inner scroll AND the grid fills the panel. Every
  // .bg-grid uses the panel as its scroll surface (overflow-y NOT auto/scroll),
  // and the grid rises past the round-1 32vh cap that left the rail ~39% empty.
  // MUST-FAIL on round-1 (grids were max-height 32/36vh + overflow-y:auto, so the
  // tallest grid could never exceed 0.36*viewport and overflow-y was 'auto').
  const scroll = await cdp.eval(`(() => {
    const grids = [...document.querySelectorAll('#railBoardGrid .bg-grid')];
    const vh = window.innerHeight;
    return {
      vh,
      ovs: grids.map((g) => getComputedStyle(g).overflowY),
      maxGridH: Math.max(0, ...grids.map((g) => g.clientHeight)),
      // the panel — not any grid — is the surface that actually scrolls
      panelScrolls: (() => { const p = document.querySelector('#railPanel'); return p.scrollHeight > p.clientHeight + 1; })(),
    };
  })()`);
  check('(h) no grid is an inner scroller (overflow-y visible) and the grid fills past the old 32vh cap into one panel-level scroll',
    scroll.ovs.length > 0 && scroll.ovs.every((o) => o !== 'auto' && o !== 'scroll') &&
    scroll.maxGridH > 0.36 * scroll.vh && scroll.panelScrolls,
    JSON.stringify(scroll));

  // (c) current-session partition + opacity, after injecting the declared inputs.
  await cdp.eval(injectExpr);
  await cdp.waitFor('this-session section', `!!document.querySelector('#railBoardGrid .bg-section.mine')`, 8_000);
  await sleep(350); // let the one-shot `rise` entrance animation settle before reading opacity
  const part = await cdp.eval(`(() => {
    const mine = [...document.querySelectorAll('#railBoardGrid .bg-section.mine .tc')].map((c) => c.dataset.id);
    const others = [...document.querySelectorAll('#railBoardGrid .bg-section.others .tc')].map((c) => c.dataset.id);
    const mineOpacity = [...document.querySelectorAll('#railBoardGrid .bg-section.mine .tc')].map((c) => Number(getComputedStyle(c).opacity));
    const otherOpacity = [...document.querySelectorAll('#railBoardGrid .bg-section.others .tc')].map((c) => Number(getComputedStyle(c).opacity));
    return { mine, others,
      allMinePresent: ${JSON.stringify(MINE)}.every((id) => mine.includes(id)),
      noMineInOthers: ${JSON.stringify(MINE)}.every((id) => !others.includes(id)),
      mineFull: mineOpacity.every((o) => o === 1),
      othersDim: otherOpacity.length > 0 && otherOpacity.every((o) => o < 1) };
  })()`);
  check('(c) the 4 current-session tickets render in "This session", none leak into "others"',
    part.allMinePresent && part.noMineInOthers && part.mine.length === 4, JSON.stringify({ mine: part.mine, others: part.others.length }));
  check('    "This session" cards are full opacity; every "others" card is dimmed (< 1)',
    part.mineFull && part.othersDim, JSON.stringify({ mineFull: part.mineFull, othersDim: part.othersDim }));

  // (e) no horizontal overflow at the real rail width.
  const overflow = await cdp.eval(`(() => {
    const p = document.querySelector('#railPanel');
    const grids = [...document.querySelectorAll('#railBoardGrid .bg-grid')];
    return { panelH: p.scrollWidth - p.clientWidth,
             gridsH: grids.map((g) => g.scrollWidth - g.clientWidth) };
  })()`);
  check('(e) no horizontal overflow — the rail panel and each grid fit their width',
    overflow.panelH <= 1 && overflow.gridsH.every((h) => h <= 1), JSON.stringify(overflow));

  // (i)+(j) DEFECTS #2/#3 — the poll re-render must preserve scroll position and
  // REUSE card nodes (no clear()+rebuild). Force a short viewport so the rail's
  // ONE scroll surface (#railPanel) actually overflows, then drive the render.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 560, deviceScaleFactor: 1, mobile: false });
  await sleep(200);
  const pollProof = await cdp.eval(`(() => {
    const panel = document.querySelector('#railPanel');
    // The surface the USER actually scrolls in the grid region: an INNER grid
    // scroller if one exists (round-1's capped .bg-grid), else the panel (the
    // fix). Testing this — not always the panel — is what makes the assertion
    // red on round-1, where the poll's clear()+rebuild throws the surface away.
    const innerScroller = [...document.querySelectorAll('#railBoardGrid .bg-grid')].find((g) => {
      const cs = getComputedStyle(g);
      return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && g.scrollHeight > g.clientHeight + 1;
    });
    const surface = innerScroller || panel;
    const onPanel = surface === panel;
    // tag a live card so we can prove the SAME node survives the re-render
    const probeCard = document.querySelector('#railBoardGrid .tc');
    const probeId = probeCard?.dataset.id ?? null;
    if (probeCard) probeCard.dataset.pollProbe = 'keep-me';
    surface.scrollTop = Math.max(0, surface.scrollHeight - surface.clientHeight - 20);
    const setTop = surface.scrollTop;
    const scrolls = setTop > 0;
    // a poll: the real render path, same injected state
    window.__station.renderRail();
    // re-acquire the surface AFTER render (an inner grid may have been rebuilt)
    const afterSurface = onPanel ? panel
      : [...document.querySelectorAll('#railBoardGrid .bg-grid')].find((g) => {
          const cs = getComputedStyle(g); return cs.overflowY === 'auto' || cs.overflowY === 'scroll';
        }) ?? panel;
    const afterTop = afterSurface.scrollTop;
    const same = document.querySelector('#railBoardGrid .tc[data-id="' + probeId + '"]');
    return { onPanel, scrolls, setTop, afterTop, nodeReused: !!(same && same.dataset.pollProbe === 'keep-me') };
  })()`);
  check('(i) the grid scroll surface holds its position across a poll re-render (and that surface is the panel, one surface)',
    pollProof.scrolls && pollProof.onPanel && Math.abs(pollProof.afterTop - pollProof.setTop) <= 2,
    JSON.stringify(pollProof));
  check('(j) a poll re-render REUSES card nodes (keyed update, no clear()+rebuild flicker)',
    pollProof.nodeReused === true, JSON.stringify({ nodeReused: pollProof.nodeReused }));
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(150);

  // ══════════════════════════════════════════════════════════════════════════
  // FEAT-153 r3 — MUTATE the board over REAL polls. The round-2 review found that
  // a mid-view ticket STATE CHANGE threw NotFoundError in reconcileGridCards
  // (card vanished) AND the throw propagated out of pollRail (which had no
  // try/finally), killing the 5s poll loop permanently. The r2 suite never
  // mutated the board after first paint, so it could not catch this class. These
  // checks change / add / remove / reorder a ticket ON DISK and drive the REAL
  // poll (window.__station.pollRail — the exact function the 5s timer calls), then
  // assert: no throw, the card is present with its NEW state, a stable sibling was
  // NOT re-animated (its node was reused), and the loop keeps processing later
  // mutations (a dead loop can't). MUST-FAIL on the round-2 code (n,o,q,r red).
  console.log('\n=== a live board mutates under the grid over REAL 5s polls: no crash, card updates, poll SURVIVES ===');
  const RAIL_POLL_MS = await cdp.eval(`window.__station.RAIL_POLL_MS`);
  const rowsNow = ROWS.map((r) => r.slice()); // mutable mirror of the on-disk board
  const setRow = (id, owner, status, sev) => {
    const r = rowsNow.find((x) => x[0] === id);
    r[2] = owner; r[3] = status; if (sev != null) r[4] = sev;
  };
  const gridState = (id) => cdp.eval(`(() => {
    const c = document.querySelector('#railBoardGrid .tc[data-id=${JSON.stringify(id)}]');
    return { present: !!c, state: c?.dataset.state ?? null,
             count: document.querySelectorAll('#railBoardGrid .tc').length };
  })()`);
  const realPoll = () => cdp.eval(`window.__station.pollRail().then(() => true, () => false)`);
  // The round-2 loop death is ONLY observable over the REAL self-scheduled 5s
  // timer: a crashing tick never reschedules, so a LATER disk change is never
  // picked up. Driving pollRail() by hand would be masked by the independently
  // running boot timer, so `settle` waits for the WALL-CLOCK timer to reflect a
  // disk change — never a manual poll. (If the headless tab reports itself hidden
  // no timer arms by design; we fall back to a manual pollRail, which still
  // exercises the reconcile fix but cannot demonstrate loop liveness — stated so
  // per the WA. In practice this harness reports visible and takes the timer path.)
  const visible = await cdp.eval(`document.visibilityState === 'visible'`);
  const settle = async (label, boolExpr, timeoutMs = RAIL_POLL_MS + 7000) => {
    if (visible) return cdp.waitFor(label, boolExpr, timeoutMs);
    await realPoll();
    return cdp.eval(boolExpr);
  };
  // Install an error trap and tag a stable sibling. A crashing timer tick rejects
  // pollRail() → 'unhandledrejection'; capturing it proves the render threw.
  await cdp.eval(`(() => {
    window.__gridErrs = [];
    if (!window.__gridErrTrap) { window.__gridErrTrap = 1;
      window.addEventListener('error', (e) => window.__gridErrs.push(String(e.message || e.error)));
      window.addEventListener('unhandledrejection', (e) => window.__gridErrs.push('rejection:' + String((e.reason && e.reason.message) || e.reason))); }
    const c = document.querySelector('#railBoardGrid .tc[data-id="BUG-201"]');
    if (c) c.dataset.stableProbe = 'r3';
    return true;
  })()`);

  // (n)+(o) STATE CHANGE — the exact round-2 repro: a building 🤖 ticket flips to
  // queued mid-view. On round-2 the timer tick threw in insertBefore, BUG-205
  // VANISHED, and the loop died. Driven purely by the real 5s poll.
  await cdp.eval(`window.__gridErrs.length = 0`);
  setRow('BUG-205', '—', 'queued');
  writeBoardIndex(rowsNow);
  await settle('BUG-205 → queued via the real timer poll',
    `document.querySelector('#railBoardGrid .tc[data-id="BUG-205"]')?.dataset.state === 'queued'`);
  const s1 = await gridState('BUG-205');
  const errs1 = await cdp.eval(`window.__gridErrs.slice()`);
  check('(n) a mid-view state change over a real poll does NOT throw in the render path (no page error / rejection)',
    errs1.length === 0, JSON.stringify({ errs: errs1 }));
  check('(o) the changed card stays present with its NEW state (queued) and the count is intact (no vanish)',
    s1.present && s1.state === 'queued' && s1.count === 15, JSON.stringify(s1));
  const sib1 = await cdp.eval(`document.querySelector('#railBoardGrid .tc[data-id="BUG-201"]')?.dataset.stableProbe === 'r3'`);
  check('(p) a stable sibling card is REUSED across the mutation (its node survives → not re-animated)',
    sib1 === true, `stableProbeSurvived=${sib1}`);

  // (q) ADD — a new ticket appears on a LATER poll. This is the liveness proof:
  // a round-2-dead loop (killed by the state-change crash above) can never pick
  // this up, so it NEVER appears → red on the round-2 code.
  await cdp.eval(`window.__gridErrs.length = 0`);
  rowsNow.push(['BUG-230', 'new race surfaced under load', '—', 'queued', 'high', false]);
  writeBoardIndex(rowsNow);
  const addSeen = await settle('BUG-230 appears via a later timer poll',
    `!!document.querySelector('#railBoardGrid .tc[data-id="BUG-230"]')`);
  const s2 = await gridState('BUG-230');
  check('(q) a ticket ADDED after the state change appears on a later poll — the loop stayed ALIVE (round-2 killed it)',
    addSeen && s2.present && s2.count === 16, JSON.stringify(s2));

  // (r) REMOVE — a ticket leaves the board; its card drops on a later poll.
  rowsNow.splice(rowsNow.findIndex((r) => r[0] === 'BUG-210'), 1);
  writeBoardIndex(rowsNow);
  const rmGone = await settle('BUG-210 drops via a later timer poll',
    `!document.querySelector('#railBoardGrid .tc[data-id="BUG-210"]')`);
  const s3 = await gridState('BUG-210');
  check('(r) a removed ticket drops from the grid on a later poll, count decrements (loop still alive)',
    rmGone && s3.present === false && s3.count === 15, JSON.stringify(s3));

  // (s) REORDER by priority — FEAT-215 is the LAST low-sev queued card; escalate it
  // to high and it must JUMP ahead of a low-sev sibling it was originally AFTER
  // (FEAT-213). A genuine move, not a no-op: originally iFEAT215 > iFEAT213, so a
  // dead/no-render loop leaves it after FEAT-213 (round-2 red). Verify the invert.
  const before215 = await cdp.eval(`(() => {
    const ids = [...document.querySelectorAll('#railBoardGrid .tc')].map((c) => c.dataset.id);
    return { i215: ids.indexOf('FEAT-215'), i213: ids.indexOf('FEAT-213') };
  })()`);
  setRow('FEAT-215', '—', 'queued', 'high');
  writeBoardIndex(rowsNow);
  await settle('FEAT-215 escalated + reordered ahead of FEAT-213 via a later poll',
    `(() => { const ids=[...document.querySelectorAll('#railBoardGrid .tc')].map(c=>c.dataset.id);
      const e=ids.indexOf('FEAT-215'), l=ids.indexOf('FEAT-213'); return e>=0 && l>=0 && e<l; })()`);
  const order = await cdp.eval(`(() => {
    const ids = [...document.querySelectorAll('#railBoardGrid .tc')].map((c) => c.dataset.id);
    return { iEsc: ids.indexOf('FEAT-215'), iLow: ids.indexOf('FEAT-213') };
  })()`);
  const errsS = await cdp.eval(`window.__gridErrs.slice()`);
  check('(s) escalating the LAST low-sev queued ticket to high moves it AHEAD of a sibling it was after, no throw',
    before215.i215 > before215.i213 && order.iEsc >= 0 && order.iLow >= 0 && order.iEsc < order.iLow && errsS.length === 0,
    JSON.stringify({ before: before215, after: order, errs: errsS }));

  // (t) MOVE BETWEEN SECTIONS — a card migrates from "This session" to "others"
  // when its request binding drops. The shared `existing` map must MOVE the node
  // across sections, never destroy+recreate it, and never throw. One synchronous
  // eval (inject → tag → drop → re-render), so an interleaving timer tick cannot
  // clear the injected binding mid-assert. (Injected requests are synthetic per
  // this script's header — a real binding needs a live orchestrator turn.)
  const mig = await cdp.eval(`(() => {
    const s = window.__station.state;
    window.__gridErrs.length = 0;
    s.requests = [{ id: 'RQ-mig', stationSessionId: 'sess-x', projectId: s.current.projectId,
                    title: 'mig', source: null, tickets: ['BUG-207'], createdAt: '', updatedAt: '' }];
    s.snap = { v: 1, turn: { running: false }, running: [] };
    window.__station.renderRail();
    const before = document.querySelector('#railBoardGrid .bg-section.mine .tc[data-id="BUG-207"]');
    if (before) before.dataset.migProbe = 'kept';
    const startedInMine = !!before;
    s.requests = []; // binding drops → BUG-207 belongs to "others" now
    let threw = null;
    try { window.__station.renderRail(); } catch (e) { threw = String((e && e.message) || e); }
    const inOthers = document.querySelector('#railBoardGrid .bg-section.others .tc[data-id="BUG-207"]');
    const anywhere = document.querySelector('#railBoardGrid .tc[data-id="BUG-207"]');
    return { startedInMine, threw, present: !!anywhere, inOthers: !!inOthers,
             reused: anywhere?.dataset.migProbe === 'kept', errs: window.__gridErrs.slice() };
  })()`);
  check('(t) a card migrating between sections is MOVED (same node reused), lands in "others", no throw',
    mig.startedInMine && mig.threw === null && mig.present && mig.inOthers && mig.reused && mig.errs.length === 0,
    JSON.stringify(mig));

  // Restore the pristine 15-ticket board for the remaining checks/screenshots.
  writeBoardIndex(ROWS.map((r) => r.slice()));
  await realPoll();
  await sleep(300);
  // ══════════════════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════════════════
  // FEAT-153 r4 — ANTI-FLICKER. The user, after r3 PASSED review: "it keeps
  // flickering every few seconds, ig it has polling or something." Round 3 keyed
  // only the grid CARDS; the rest of the panel still clear()+rebuilt on every
  // ~5s poll (the FEAT-067 summary strip, FEAT-126 requests, observations,
  // stopped, pending), and — the visible flash — renderBoardGrid unconditionally
  // re-appended its sections, which disconnects+reconnects the subtree and
  // RESTARTS every .tc card's `rise` entrance animation. So on an UNCHANGED poll
  // the WHOLE #railPanel must produce ZERO DOM mutations and ZERO animationstart
  // events. This drives ≥3 REAL polls (window.__station.pollRail — the exact
  // function the 5s timer calls; refreshRail(true) → full board refetch) with the
  // board unchanged on disk, and asserts a whole-panel MutationObserver + an
  // animationstart trap stay silent. MUST-FAIL on the r3 code (observed live on
  // 4317 before the fix: 456 mutations + 774 `rise` over ~7 polls; after: 0 / 0).
  console.log('\n=== an UNCHANGED poll produces ZERO panel churn (the flicker fix) ===');
  await realPoll(); // one settling poll to absorb any async outcomes/requests fetch
  await sleep(500);
  const flick = await cdp.eval(`(async () => {
    const panel = document.querySelector('#railPanel');
    const mut = []; const anim = [];
    const obs = new MutationObserver((recs) => {
      for (const r of recs) {
        let n = r.target, p = [];
        while (n && n !== panel && p.length < 4) {
          p.unshift(n.id ? '#'+n.id : (n.className ? '.'+String(n.className).split(' ').slice(0,2).join('.') : n.nodeName));
          n = n.parentElement;
        }
        mut.push((r.type === 'attributes' ? 'attr['+r.attributeName+'] ' : r.type+' ') + p.join(' > '));
      }
    });
    obs.observe(panel, { childList: true, subtree: true, attributes: true, characterData: true });
    const ah = (e) => { if (panel.contains(e.target)) anim.push(e.animationName); };
    document.addEventListener('animationstart', ah, true);
    for (let i = 0; i < 4; i++) { await window.__station.pollRail().catch(() => {}); await new Promise((r) => setTimeout(r, 200)); }
    await new Promise((r) => setTimeout(r, 300));
    obs.disconnect(); document.removeEventListener('animationstart', ah, true);
    const byPath = {}; for (const m of mut) byPath[m] = (byPath[m] || 0) + 1;
    return {
      cardCount: document.querySelectorAll('#railBoardGrid .tc').length,
      mutations: mut.length, anims: anim.length, byPath, animNames: [...new Set(anim)],
    };
  })()`);
  check('    the grid is populated during the silent polls (not a hidden/empty panel)',
    flick.cardCount >= 15, `cards=${flick.cardCount}`);
  check('(u) 4 REAL polls over unchanged data produce ZERO panel DOM mutations',
    flick.mutations === 0, JSON.stringify({ mutations: flick.mutations, byPath: flick.byPath }));
  check('(v) 4 REAL polls over unchanged data replay ZERO entrance animations (no flicker)',
    flick.anims === 0, JSON.stringify({ anims: flick.anims, names: flick.animNames }));
  // ══════════════════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════════════════
  // FEAT-153 r5 — the r4 review found the anti-flicker sigs from r4 are OVER-TIGHT
  // on TIME/relational inputs the render reads but the sig omitted, so a poll
  // early-returns and the UI silently shows stale data. These three checks each
  // reproduce a real stale render with a byte-STABLE gated input, and pass only
  // once the sig captures the missing input. They FAIL on the r4 code (proven by
  // reverting the three sigs and re-running: w,x,y RED).
  console.log('\n=== r5 — no rail sig is over-tight: a gated poll still repaints on a real change ===');

  // (w) MED — renderOutcomes osig omitted the time-derived rows. With a BYTE-STABLE
  // outcomes array + showAll, a day-boundary crossing must still re-label the death
  // (BUG-070: "an old entry must never read as today's"). Install a fake clock,
  // render a "today 23:50" death, advance +49h across midnight, and re-render via
  // the GATED path. r4: osig=[outcomes,showAll] unchanged → early-return → the row
  // still reads "today". r5: osig folds in the calendar day + the 48h-recent id set.
  const wProof = await cdp.eval(`(() => {
    const st = window.__station, s = st.state;
    const savedO = s.outcomes, savedShow = s.showAllOutcomes;
    const RealDate = Date;
    let fakeNow = new RealDate(2026, 8, 27, 23, 50, 0).getTime(); // Sep 27 23:50 local
    class FakeDate extends RealDate {
      constructor(...a) { if (a.length === 0) super(fakeNow); else super(...a); }
      static now() { return fakeNow; }
    }
    window.Date = FakeDate;
    try {
      s.showAllOutcomes = true; // keep the record visible even once it ages past 48h
      s.outcomes = [{ id: 'DEATH-1', at: fakeNow, kind: 'tooling-unavailable', row: 'sub', label: 'worker-x', dismissedAt: null }];
      st.renderOutcomes();
      const before = document.querySelector('#railStopped .brow .bt')?.textContent ?? '';
      fakeNow += 49 * 3600 * 1000; // +49h → 2 calendar days later, and past the 48h window
      st.renderOutcomes(); // GATED path; outcomes array + showAll are byte-identical
      const after = document.querySelector('#railStopped .brow .bt')?.textContent ?? '';
      return { before, after };
    } finally {
      window.Date = RealDate;
      s.outcomes = savedO; s.showAllOutcomes = savedShow;
      st.renderOutcomes();
    }
  })()`);
  check('(w) an outcomes poll across a day boundary re-labels the death (no stale "today") despite a byte-stable array',
    /today\s+23:50/.test(wProof.before) && !/today/.test(wProof.after) && /Sep\s*27/.test(wProof.after),
    JSON.stringify(wProof));

  // (x) LOW — renderRailRequests rqSig captured running lanes as [owner,ticket,state]
  // but attributedLanes() also matches on lane.request. An in-place change of an
  // existing lane's .request (no length/ticket/state change) re-attributes it to a
  // different request. Two idle-fallback requests (queued tickets, so the coarse
  // fallback yields idle, isolating the per-lane attribution): a lane bound to RQA
  // then flipped to RQB must move the "running" badge from RQA to RQB. One
  // synchronous eval so no timer poll interleaves. r4: rqSig unchanged → RQA stays
  // "running" (wrong). r5: l.request in the tuple → repaint.
  const xProof = await cdp.eval(`(() => {
    const st = window.__station, s = st.state;
    const saved = { requests: s.requests, snap: s.snap, caps: s.caps.requests };
    s.caps.requests = false; // an "older server" path so no refresh wipes the injection
    s.requests = [
      { id: 'RQA', stationSessionId: 'sess-x', projectId: s.current.projectId, title: 'Req A', source: null, tickets: ['FEAT-208'], createdAt: '', updatedAt: '' },
      { id: 'RQB', stationSessionId: 'sess-x', projectId: s.current.projectId, title: 'Req B', source: null, tickets: ['FEAT-209'], createdAt: '', updatedAt: '' },
    ];
    s.snap = { v: 1, turn: { running: true }, running: [
      { id: 'lane-9', row: 'sub', label: 'w', background: true, ticket: [], request: 'RQA', state: 'running' },
    ] };
    const readExec = () => Object.fromEntries([...document.querySelectorAll('#railRequests .req-row')].map((r) => [
      r.querySelector('.req-id')?.textContent,
      (r.querySelector('.req-exec')?.className.match(/\\b(run|stall|idle)\\b/) || [])[1] ?? null,
    ]));
    st.renderRail();
    const before = readExec();
    s.snap.running[0].request = 'RQB'; // in-place: owner/ticket/state all unchanged
    st.renderRail(); // GATED renderRailRequests inside
    const after = readExec();
    s.requests = saved.requests; s.snap = saved.snap; s.caps.requests = saved.caps;
    return { before, after };
  })()`);
  check('(x) an in-place lane.request re-attribution moves the running badge (RQA→RQB) despite an otherwise-identical lane tuple',
    xProof.before.RQA === 'run' && xProof.before.RQB === 'idle' &&
    xProof.after.RQA === 'idle' && xProof.after.RQB === 'run',
    JSON.stringify(xProof));

  // (z) LOW (r5 gap) — renderRailRequests rqSig mapped snap=null (liveness UNKNOWN)
  // and snap.running=[] (liveness KNOWN-idle) to the same '[]', so an empty snapshot
  // that CONFIRMS the lane went idle never repaints the exec badge off "N running".
  // Reachable in normal use: state.snap starts null and is reset to null on every
  // session switch (BUG-034), so a running poll returning [] leaves a stale count.
  // A request bound to a `prog` (board.inflight) ticket with NO attributed lane:
  // executionOf's COARSE fallback reads `running` for null (count>0, unconfirmed)
  // but `idle` for the confirmed-empty []. Two synchronous renders, no timer poll.
  // Before the fix: rqSig unchanged (both '[]') → badge stays "1 running" (WRONG).
  // After: Array.isArray(state.snap?.running) in the sig (false vs true) → repaint.
  const zProof = await cdp.eval(`(() => {
    const st = window.__station, s = st.state;
    const saved = { requests: s.requests, snap: s.snap, board: s.board, caps: s.caps.requests };
    s.caps.requests = false; // "older server" path so no refresh wipes the injection
    s.requests = [
      { id: 'RQZ', stationSessionId: 'sess-z', projectId: s.current.projectId, title: 'Req Z', source: null, tickets: ['FEAT-210'], createdAt: '', updatedAt: '' },
    ];
    s.board = { hasBoard: true, needsYou: [], queued: [], doneToday: [],
      inflight: [{ id: 'FEAT-210', kind: 'feat', title: 'ship it', sev: 'med' }] };
    const readExec = () => {
      const r = document.querySelector('#railRequests .req-row');
      const e = r?.querySelector('.req-exec');
      return { cls: (e?.className.match(/\\b(run|stall|idle)\\b/) || [])[1] ?? null,
               text: e?.textContent ?? null };
    };
    s.snap = null;                       // liveness UNKNOWN → coarse fallback = running
    st.renderRail();
    const unknown = readExec();
    s.snap = { v: 1, turn: { running: false }, running: [] }; // KNOWN-idle: nothing runs
    st.renderRail();                     // GATED renderRailRequests inside
    const knownEmpty = readExec();
    s.requests = saved.requests; s.snap = saved.snap; s.board = saved.board; s.caps.requests = saved.caps;
    return { unknown, knownEmpty };
  })()`);
  check('(z) an empty running snapshot after a null one clears the exec badge from "1 running" to "idle" (snap=null vs snap.running=[] discriminated in rqSig)',
    zProof.unknown.cls === 'run' && /1\s*running/.test(zProof.unknown.text) &&
    zProof.knownEmpty.cls === 'idle' && /idle/.test(zProof.knownEmpty.text),
    JSON.stringify(zProof));

  // (y) LOW — renderRailSummary sig captured inflight as [id,title] but the FOCUS
  // row reads the focus item's kind to decide the click-to-open affordance
  // (isTicket = kind not decision/finding/stall). A same-id/same-title kind flip on
  // the in-flight focus item (a runtime 'decision' becoming a real 'bug' ticket)
  // must turn the static focus text into a clickable link. r4: inflight tuple has no
  // kind → sig unchanged → the link never appears. r5: kind is in the tuple.
  const yProof = await cdp.eval(`(() => {
    const st = window.__station, s = st.state;
    const savedBoard = s.board;
    s.board = {
      hasBoard: true,
      summary: { focus: { id: 'ZZZ-1', title: 'a runtime decision' }, needs: 0, queued: 0, running: 1, done: 0 },
      needsYou: [], queued: [], doneToday: [], observations: [],
      inflight: [{ id: 'ZZZ-1', kind: 'decision', title: 'a runtime decision' }],
    };
    const readLink = () => {
      const l = document.querySelector('#railSummary .rs-focus .rs-focus-open');
      return { present: !!l, isButton: l?.tagName === 'BUTTON', static: !!l?.classList.contains('static') };
    };
    st.renderRailSummary();
    const before = readLink();
    s.board.inflight[0].kind = 'bug'; // same id + title, now a real ticket → link should appear
    st.renderRailSummary(); // GATED path
    const after = readLink();
    s.board = savedBoard;
    return { before, after };
  })()`);
  check('(y) a kind flip on the in-flight FOCUS item turns the static focus text into a clickable open-link despite same id/title',
    yProof.before.present && yProof.before.isButton === false && yProof.before.static === true &&
    yProof.after.present && yProof.after.isButton === true && yProof.after.static === false,
    JSON.stringify(yProof));

  // Restore a clean, pristine state for the screenshots + remaining checks: the
  // real board from disk, no injected outcomes, and the "This session" partition.
  await cdp.eval(`(() => { const s = window.__station.state; s.outcomes = []; s.showAllOutcomes = false; s.requests = []; s.snap = { v: 1, turn: { running: false }, running: [] }; window.__station.renderRail(); return true; })()`);
  await realPoll();
  await cdp.eval(injectExpr);
  await sleep(350);
  // ══════════════════════════════════════════════════════════════════════════

  // Required screenshot matrix: light+dark at 1440 and 1024, on the busy board
  // with the current-session partition live. (At 1024 the rail is behind the
  // responsive reopen badge — pre-existing behaviour, captured for the record.)
  await cdp.eval(`document.querySelector('#railPanel').scrollTop = 0`); // show the header/summary, not the poll-proof's scrolled state
  for (const w of [1440, 1024]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const theme of ['light', 'dark']) {
      await cdp.eval(`document.documentElement.setAttribute('data-theme','${theme}')`);
      await sleep(200);
      await cdp.shot(`grid-${w}-${theme}.png`);
    }
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(150);

  await cdp.eval(`document.documentElement.setAttribute('data-theme','light')`);
  await sleep(150);
  await cdp.shot('grid-light-expanded.png');

  // (f) collapse "others" and prove it persists across a re-render.
  await cdp.eval(`document.querySelector('#railBoardGrid .bg-section.others .bg-toggle').click()`);
  await sleep(200);
  const collapsed = await cdp.eval(`(() => {
    const sec = document.querySelector('#railBoardGrid .bg-section.others');
    const grid = sec?.querySelector('.bg-grid');
    return { collapsed: sec?.classList.contains('collapsed'),
             gridHidden: grid ? getComputedStyle(grid).display === 'none' : null,
             ls: localStorage.getItem('cs.rail.boardOthers') };
  })()`);
  check('(f) collapsing "others" hides its grid and stores the choice (localStorage cs.rail.boardOthers=0)',
    collapsed.collapsed && collapsed.gridHidden && collapsed.ls === '0', JSON.stringify(collapsed));
  await cdp.eval(injectExpr); // a full re-render (as a poll would do)
  const stillCollapsed = await cdp.eval(`document.querySelector('#railBoardGrid .bg-section.others')?.classList.contains('collapsed')`);
  check('    the collapse survives a re-render (a background poll cannot re-expand it)',
    stillCollapsed === true, `collapsed=${stillCollapsed}`);
  await sleep(350); // let the re-render's entrance animation settle for a clean shot
  await cdp.shot('grid-light-collapsed.png');
  // re-open for the answer-flow checks below.
  await cdp.eval(`document.querySelector('#railBoardGrid .bg-section.others .bg-toggle').click()`);

  // dark theme screenshots.
  await cdp.eval(`document.documentElement.setAttribute('data-theme','dark')`);
  await sleep(200);
  await cdp.shot('grid-dark-expanded.png');
  await cdp.eval(`document.querySelector('#railBoardGrid .bg-section.others .bg-toggle').click()`);
  await sleep(150);
  await cdp.shot('grid-dark-collapsed.png');
  await cdp.eval(`document.querySelector('#railBoardGrid .bg-section.others .bg-toggle').click()`);
  await cdp.eval(`document.documentElement.setAttribute('data-theme','light')`);

  // (b2) a bare-status needs card opens the ticket MODAL, not an answer box.
  console.log('\n=== a bare-status needs card is read-only (opens the ticket) ===');
  await cdp.eval(`document.querySelector('#railBoardGrid .tc[data-id="${STATUS_ID}"]').click()`);
  const modalOpen = await cdp.waitFor('ticket modal',
    `(() => { const m = document.querySelector('#ticketModal'); return m && !m.hidden && /${STATUS_ID}/.test(m.textContent || ''); })()`, 8_000);
  const noMount = await cdp.eval(`document.querySelectorAll('#railNeeds .needs-card').length === 0`);
  check('(b2) a bare-status needs card opens the ticket modal and mounts NO answer box',
    modalOpen && noMount, JSON.stringify({ modalOpen, noMount }));
  await cdp.eval(`(() => { const c = document.querySelector('#ticketModalClose'); if (c) c.click(); })()`);

  // (d) answering an answerable needs card writes to disk + clears the mount.
  console.log('\n=== answering a needs card via the grid writes to disk (append-only) ===');
  await cdp.eval(`document.querySelector('#railBoardGrid .tc[data-id="${ANSWERABLE_ID}"]').click()`);
  const mounted = await cdp.waitFor('answer mount',
    `!!document.querySelector('#railNeeds .needs-card[data-id="${ANSWERABLE_ID}"] textarea.nc-input')`, 8_000);
  check('(d1) clicking an answerable needs card mounts the full answer flow (textarea) in #railNeeds', mounted, `mounted=${mounted}`);
  const ticketPath = path.join(WITH, 'docs', 'bugs', `${ANSWERABLE_ID}-importer-rows.md`);
  const before = fs.readFileSync(ticketPath, 'utf8');
  await cdp.eval(`(() => {
    const ta = document.querySelector('#railNeeds .needs-card[data-id="${ANSWERABLE_ID}"] textarea.nc-input');
    ta.value = ${JSON.stringify(ANSWER)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#railNeeds .needs-card[data-id="${ANSWERABLE_ID}"] .nc-send').click();
  })()`);
  const cleared = await cdp.waitFor('mount cleared',
    `document.querySelectorAll('#railNeeds .needs-card').length === 0 && window.__station.state.openAnswerId === null`, 15_000);
  check('(d2) after answering, the mount clears and openAnswerId resets', cleared, `cleared=${cleared}`);
  await sleep(400);
  const after = fs.readFileSync(ticketPath, 'utf8');
  check('(d3) the answer was APPENDED to the ticket file (dated entry, prior log survives)',
    after.includes(ANSWER) && after.length > before.length && after.includes(PRIOR_LOG) &&
    /###\s+\d{4}-\d{2}-\d{2}\s+—\s+you/.test(after) && after.indexOf(PRIOR_LOG) < after.indexOf(ANSWER),
    JSON.stringify(after.slice(before.length).trim().slice(0, 120)));

  // (g) an EMPTY board (a freshly-registered project — registration scaffolds an
  // empty docs/bugs, so hasBoard is true with no tickets) shows the quiet
  // "board is clear" empty state, no cards, and no error.
  console.log('\n=== an empty board shows the quiet "board is clear" state (no error) ===');
  await clickProj('No Board');
  await cdp.waitFor('switched', `window.__station.state.current.projectId === ${JSON.stringify(withoutId)}`, 10_000);
  await cdp.waitFor('empty grid', `(() => {
    const g = document.querySelector('#railBoardGrid');
    return g && !g.hidden && document.querySelectorAll('#railBoardGrid .tc').length === 0 && !!g.querySelector('.bg-empty');
  })()`, 10_000);
  const noBoard = await cdp.eval(`(() => {
    const g = document.querySelector('#railBoardGrid');
    const f = document.querySelector('#fine');
    return { cards: document.querySelectorAll('#railBoardGrid .tc').length,
             empty: g?.querySelector('.bg-empty')?.textContent ?? null,
             err: f && !f.hidden && f.classList.contains('err') ? f.textContent : null };
  })()`);
  check('(g) empty board: no cards, a "board is clear" message, and no error',
    noBoard.cards === 0 && /clear/i.test(noBoard.empty ?? '') && !noBoard.err, JSON.stringify(noBoard));

  cdp.close();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(() => {
  stopByPid(browser);
  stopByPid(server);
  setTimeout(() => {
    for (const d of [DATA, STORE, PROFILE, WITH, WITHOUT]) fs.rmSync(d, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }, 2500);
});
