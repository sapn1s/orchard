/**
 * FEAT-067 — top-of-rail STATUS SUMMARY card verification, driven in a REAL
 * Chromium (brave --headless=new over raw CDP) against a REAL server. The card
 * is server-DERIVED (board.ts `boardSummary` attached to the board GET after all
 * merges) and painted client-side in renderRail from `state.board.summary` plus
 * the already-fetched outcomes — NOT an orchestrator-emitted snapshot.
 *
 *   node scripts/verify-feat-067-rail-summary.mjs
 *
 * Everything is real: a scratch project on disk with an opt-in docs/bugs/ board
 * carrying KNOWN needs/queued/inflight/done rows, registered through the API,
 * rendered by the real public/app.js. Checks:
 *   a. the server board GET carries `summary` (focus + counts) computed from the
 *      merged lists — the single source of truth;
 *   b. the rail paints a #railSummary card whose Focus line names the highest-
 *      priority open ticket and OPENS it (a real ticket → the modal);
 *   c. the counts strip has one chip per section, each chip's number EXACTLY
 *      matches the ground-truth board.summary / outcomes (never fabricated), and
 *      a non-empty chip targets its live section (enabled; target not hidden);
 *   d. MUST-FAIL / honesty guard: mutate the board on disk, force a poll, and the
 *      card's counts MOVE to the new truth — proving it is derived live every
 *      poll, not a frozen snapshot that would lie (BUG-041/074 class).
 *   e. FAST-FOLLOW live running-set count: with no session id in hand the live
 *      chip is OMITTED (not faked); a running-set snapshot (state.snap, the same
 *      the strip polls) paints a live count DISTINCT from board.inflight, and
 *      MOVES when the set grows — must-FAIL that it is not a stored count.
 *   f. FAST-FOLLOW deploy-pending: a DERIVED board filter (DEPLOY-* rows +
 *      needs-deploy/not-deployed statuses) computed server-side in boardSummary;
 *      the count equals the independently-derived filter and MOVES 0→N when
 *      such rows appear (must-FAIL a stored/fabricated 0); the chip links to the
 *      board portal where those tickets live.
 *
 * Ports are OS-assigned (VERIFY_RAIL_PORT pins one); never 4317 (the live
 * server) and never a fixed default. Processes are killed by PID, never pkill.
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
const PORT = Number(process.env.VERIFY_RAIL_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f067-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f067-store-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f067-chrome-'));
const WITH = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f067-with-'));
const BRAVE = process.env.VERIFY_RAIL_BROWSER ?? 'brave';

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- raw CDP */
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
  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

let server = null, browser = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

const FOCUS_ID = 'BUG-701';   // the highest-priority 👤 — the Focus target
const STATUS_ID = 'BUG-703';  // a second 👤 (bare status)
const INFLIGHT_ID = 'BUG-702';
const QUEUED_ID = 'BUG-704';
const DONE_ID = 'BUG-700';
const NEW_NEEDS_ID = 'BUG-705'; // added mid-run to prove live derivation

function bugsDir() { return path.join(WITH, 'docs', 'bugs'); }

function writeIndex(extraNeeds = '') {
  fs.writeFileSync(path.join(bugsDir(), 'INDEX.md'),
    `# Board\n\n## Open\n\n` +
    `| ID | Title | Owner | Status | Sev |\n` +
    `|----|-------|-------|--------|-----|\n` +
    `| ${FOCUS_ID} | should the importer skip malformed rows or halt? | 👤 | needs decision | high |\n` +
    `| ${STATUS_ID} | waiting on user to review the billing copy | 👤 | user-owned | low |\n` +
    extraNeeds +
    `| ${INFLIGHT_ID} | flaky retry loop under load | 🤖 | building | med |\n` +
    `| ${QUEUED_ID} | tidy the config loader | — | queued | low |\n\n` +
    `## Done (committed)\n\n| ID | Title | Commit |\n|----|-------|--------|\n` +
    `| ${DONE_ID} | ship the export button | abc1234 |\n`);
}

function seedBoard() {
  fs.mkdirSync(bugsDir(), { recursive: true });
  writeIndex();
  fs.writeFileSync(path.join(bugsDir(), `${FOCUS_ID}-importer-malformed-rows.md`),
    `# ${FOCUS_ID} — should the importer skip malformed rows or halt?\n\n` +
    `- **Status:** OPEN\n- **Severity:** high\n\n` +
    `## Question\nShould the importer skip malformed rows, or halt the whole batch?\n` +
    `- skip and log\n- halt\n\n` +
    `## Activity log (APPEND-ONLY)\n\n### 2026-08-04 — orchestrator\n- filed.\n`);
  fs.writeFileSync(path.join(bugsDir(), `${STATUS_ID}-billing-copy-review.md`),
    `# ${STATUS_ID} — waiting on user to review the billing copy\n\n- **Status:** OPEN\n`);
  fs.writeFileSync(path.join(bugsDir(), `${INFLIGHT_ID}-flaky-retry.md`),
    `# ${INFLIGHT_ID} — flaky retry loop under load\n\n- **Status:** OPEN\n`);
  fs.writeFileSync(path.join(bugsDir(), `${QUEUED_ID}-config-loader.md`),
    `# ${QUEUED_ID} — tidy the config loader\n\n- **Status:** OPEN\n`);
  // doneToday requires the ticket FILE to exist with a recent mtime (readBoard
  // stat check) — writing it now sets mtime = now.
  fs.writeFileSync(path.join(bugsDir(), `${DONE_ID}-export-button.md`),
    `# ${DONE_ID} — ship the export button\n\n- **Status:** DONE\n`);
}

async function registerProject(hostPath, name) {
  const r = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath, name }),
  })).json();
  if (!r.project?.id) throw new Error(`could not register ${name}: ${JSON.stringify(r)}`);
  return r.project.id;
}
const boardOf = async (id) => (await (await fetch(`${BASE}/api/projects/${id}/board`)).json());

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

  const withId = await registerProject(WITH, 'Has Board');

  console.log('\n=== (a) server board GET carries a derived summary (single source of truth) ===');
  const b0 = await boardOf(withId);
  check('the board GET response includes `summary` with focus + counts',
    !!b0.summary && !!b0.summary.counts && ('focus' in b0.summary), JSON.stringify(b0.summary));
  check('summary.counts EXACTLY match the merged board list lengths (derived, not guessed)',
    b0.summary?.counts?.needs === b0.needsYou.length &&
    b0.summary?.counts?.queued === b0.queued.length &&
    b0.summary?.counts?.inflight === b0.inflight.length &&
    b0.summary?.counts?.doneToday === b0.doneToday.length,
    JSON.stringify({ summary: b0.summary?.counts, board: { needs: b0.needsYou.length, queued: b0.queued.length, inflight: b0.inflight.length, doneToday: b0.doneToday.length } }));
  check('summary.focus is the highest-priority open item — the first 👤 needs-you row',
    b0.summary?.focus?.id === FOCUS_ID && b0.needsYou[0]?.id === FOCUS_ID,
    JSON.stringify(b0.summary?.focus));
  check('PRECONDITION: the seeded board parsed to needs=2, queued=1, inflight=1, doneToday=1',
    b0.needsYou.length === 2 && b0.queued.length === 1 && b0.inflight.length === 1 && b0.doneToday.length === 1,
    JSON.stringify({ needs: b0.needsYou.length, queued: b0.queued.length, inflight: b0.inflight.length, doneToday: b0.doneToday.length }));

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
    if (!row) {
      const t = document.querySelector('#tree .inactive-l');
      if (t) { t.click(); row = find(); }
    }
    if (!row) return false;
    row.click(); return true;
  })()`);

  console.log('\n=== (b) the rail paints the #railSummary card, Focus names + opens the ticket ===');
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('boot', `document.querySelectorAll('#tree button.proj').length >= 1`, 30_000);
  const picked = await clickProj('Has Board');
  check('PRECONDITION: the seeded board project is selectable', picked, `clicked=${picked}`);
  const shown = await cdp.waitFor('rail summary visible',
    `(() => { const s = document.querySelector('#railSummary'); return s && !s.hidden && s.querySelector('.rs-focus'); })()`, 20_000);
  const focusState = await cdp.eval(`(() => {
    const s = document.querySelector('#railSummary');
    const open = s?.querySelector('.rs-focus-open');
    return {
      visible: !!s && !s.hidden,
      focusId: s?.querySelector('.rs-focus .rs-id')?.textContent ?? null,
      focusTitle: s?.querySelector('.rs-focus .rs-ft')?.textContent ?? '',
      glyph: s?.querySelector('.rs-glyph')?.textContent ?? '',
      openIsButton: open?.tagName === 'BUTTON' && !open.classList.contains('static'),
      openDataId: open?.dataset.id ?? null,
    };
  })()`);
  check('(b) the summary card is visible with a Focus line naming the top ticket',
    shown && focusState.visible && focusState.focusId === FOCUS_ID && /malformed rows/.test(focusState.focusTitle),
    JSON.stringify(focusState));
  check('    the Focus glyph is 👤 (blocked on the user) and its id is an OPEN affordance (a real ticket)',
    focusState.glyph === '\u{1F464}' && focusState.openIsButton && focusState.openDataId === FOCUS_ID,
    JSON.stringify(focusState));
  // Clicking the Focus opens the ticket modal for exactly that ticket.
  await cdp.eval(`document.querySelector('#railSummary .rs-focus-open').click()`);
  const opened = await cdp.waitFor('ticket modal opened for the focus ticket',
    `(() => { const m = document.querySelector('#ticketModal'); return m && !m.hidden && /${FOCUS_ID}/.test(m.textContent || ''); })()`, 10_000);
  check('    clicking the Focus opens the ticket modal for that ticket (openTicketModal)', opened, `opened=${opened}`);
  await cdp.eval(`(() => { const c = document.querySelector('#ticketModalClose'); if (c) c.click(); })()`);

  console.log('\n=== (c) counts strip: one chip per section, numbers match ground truth, chips target live sections ===');
  const chips = await cdp.eval(`(() => {
    const out = {};
    for (const c of document.querySelectorAll('#railSummary .rs-chip')) {
      out[c.dataset.target] = {
        count: Number(c.dataset.count),
        disabled: !!c.disabled,
        zero: c.classList.contains('zero'),
        shownN: c.querySelector('.rs-n')?.textContent ?? null,
      };
    }
    return out;
  })()`);
  check('(c) the strip has exactly the 5 chips done · needs · queued · running · stopped',
    ['done', 'needs', 'queued', 'running', 'stopped'].every((k) => chips[k]), JSON.stringify(Object.keys(chips)));
  check('    each chip number EXACTLY matches the ground-truth board.summary counts (never fabricated)',
    chips.done?.count === b0.summary.counts.doneToday &&
    chips.needs?.count === b0.summary.counts.needs &&
    chips.queued?.count === b0.summary.counts.queued &&
    chips.running?.count === b0.summary.counts.inflight,
    JSON.stringify({ chips: { done: chips.done?.count, needs: chips.needs?.count, queued: chips.queued?.count, running: chips.running?.count }, summary: b0.summary.counts }));
  check('    "stopped" is sourced from live outcomes (none seeded → 0, chip disabled/zero) — omitted-not-faked',
    chips.stopped?.count === 0 && chips.stopped?.disabled && chips.stopped?.zero,
    JSON.stringify(chips.stopped));
  // A non-empty chip must target a rendered (not-hidden) section it can reach.
  const targetsReachable = await cdp.eval(`(() => {
    const map = { done: '#railDone', needs: '#railNeeds', queued: '#railQueued', running: '#railInflight' };
    const r = {};
    for (const [label, sel] of Object.entries(map)) {
      const chip = document.querySelector('#railSummary .rs-chip[data-target="' + label + '"]');
      const section = document.querySelector(sel);
      r[label] = { chipEnabled: chip && !chip.disabled, sectionShown: section && !section.hidden };
    }
    return r;
  })()`);
  check('    every non-empty chip is enabled AND its target rail section is actually rendered (reachable)',
    Object.values(targetsReachable).every((t) => t.chipEnabled && t.sectionShown),
    JSON.stringify(targetsReachable));

  console.log('\n=== (d) MUST-FAIL / honesty guard: mutate the board → the card MOVES to the new truth (no stale snapshot) ===');
  const needsBefore = chips.needs.count;
  // Add a THIRD 👤 row (ticket + INDEX row) on disk, then force one rail poll.
  fs.writeFileSync(path.join(bugsDir(), `${NEW_NEEDS_ID}-late-arrival.md`),
    `# ${NEW_NEEDS_ID} — a late-arriving decision\n\n- **Status:** OPEN\n`);
  writeIndex(`| ${NEW_NEEDS_ID} | a late-arriving decision | 👤 | needs decision | med |\n`);
  const b1 = await boardOf(withId); // server ground truth after the mutation
  await cdp.eval(`window.__station.refreshRail(true)`);
  const moved = await cdp.waitFor('needs chip reflects the newly-added ticket',
    `Number(document.querySelector('#railSummary .rs-chip[data-target="needs"]')?.dataset.count) === ${b1.needsYou.length}`, 15_000);
  const needsAfter = await cdp.eval(`Number(document.querySelector('#railSummary .rs-chip[data-target="needs"]')?.dataset.count)`);
  check('(d) the derived card is LIVE: after a board change the needs count moved to the new server truth',
    moved && needsAfter === b1.needsYou.length && needsAfter === needsBefore + 1 && needsBefore === 2,
    JSON.stringify({ needsBefore, needsAfter, serverTruth: b1.needsYou.length }));
  // The core anti-lie: the card must NEVER show a count that disagrees with the
  // server's current board.summary — a stored snapshot would still read "2".
  check('    the card never disagrees with the current server board.summary (a snapshot would still read stale)',
    needsAfter === b1.summary.counts.needs && needsAfter !== needsBefore,
    JSON.stringify({ cardNeeds: needsAfter, serverSummaryNeeds: b1.summary.counts.needs }));

  console.log('\n=== (e) FAST-FOLLOW live running-set count: distinct from board.inflight, derived from the snapshot, omitted with no session id ===');
  // No open session in this scratch → no running-set snapshot in hand. The live
  // chip must be OMITTED (the honesty invariant: never fake a 0 that would read
  // as "nothing is running" when we simply have no session id to ask about).
  const liveOmitted = await cdp.eval(`document.querySelector('#railSummary .rs-chip[data-target="live"]') === null`);
  check('(e) with NO running-set snapshot in hand the live chip is OMITTED (not faked to 0)',
    liveOmitted, `liveChipAbsent=${liveOmitted}`);
  // Drive the SAME running-set snapshot the strip polls (state.snap via
  // applySnapshot — the one writer), trusted so it applies without a matching
  // open session, exactly as pollRunning would land it.
  const live2 = await cdp.eval(`(() => {
    window.__station.applySnapshot({ v: 1, session: 'verify', running: [
      { id: 'r1', row: 'main' }, { id: 'r2', row: 'agent', label: 'sub' },
    ] }, { trusted: true });
    const chip = document.querySelector('#railSummary .rs-chip[data-target="live"]');
    const running = document.querySelector('#railSummary .rs-chip[data-target="running"]');
    return {
      liveCount: chip ? Number(chip.dataset.count) : null,
      liveEnabled: chip ? !chip.disabled : null,
      runningCount: running ? Number(running.dataset.count) : null,
    };
  })()`);
  check('    a 2-member running-set snapshot paints a live chip reading 2 (the true count of processes now)',
    live2.liveCount === 2 && live2.liveEnabled === true, JSON.stringify(live2));
  check('    the live count is DISTINCT from board.inflight — live processes now (2) ≠ tickets marked 🤖 (1)',
    live2.liveCount === 2 && live2.runningCount === 1 && live2.liveCount !== live2.runningCount, JSON.stringify(live2));
  // MUST-FAIL / live-derived guard: mutate the snapshot, the live count MOVES —
  // a stored/frozen count would still read 2.
  const liveMoved = await cdp.eval(`(() => {
    window.__station.applySnapshot({ v: 1, session: 'verify', running: [
      { id: 'r1', row: 'main' }, { id: 'r2', row: 'agent' }, { id: 'r3', row: 'agent' },
    ] }, { trusted: true });
    const chip = document.querySelector('#railSummary .rs-chip[data-target="live"]');
    return chip ? Number(chip.dataset.count) : null;
  })()`);
  check('    MUST-FAIL guard: growing the running-set to 3 moves the live count to 3 (derived every poll, not a snapshot)',
    liveMoved === 3, `liveAfter=${liveMoved}`);

  console.log('\n=== (f) FAST-FOLLOW deploy-pending: a DERIVED board filter (DEPLOY-* / needs-deploy status), server-computed, live ===');
  // Independently re-derive the deploy filter over the board GET rows — the
  // ground truth the server count must equal (mirrors board.ts isDeployPending).
  const DEPLOY_ID_RE = /^DEPLOY-\d+$/i;
  const DEPLOY_STATUS_RE = /\b(needs?[\s-]?deploy|deploy[\s-]?(?:pending|needed|required)|pending[\s-]?deploy|await\w*[\s-]?deploy|not[\s-]?deployed|un-?deployed)\b/i;
  const deployFilter = (bd) => [...bd.needsYou, ...bd.inflight, ...bd.queued]
    .filter((it) => DEPLOY_ID_RE.test(it.id) || DEPLOY_STATUS_RE.test(it.status ?? '')).length;
  const bBefore = await boardOf(withId);
  check('(f) PRECONDITION: with no deploy rows the derived filter is 0 and the summary agrees',
    deployFilter(bBefore) === 0 && bBefore.summary.counts.deployPending === 0,
    JSON.stringify({ filter: deployFilter(bBefore), summary: bBefore.summary.counts.deployPending }));
  // Add a DEPLOY-* row + a needs-deploy status row + a not-deployed row.
  writeIndex(
    `| ${NEW_NEEDS_ID} | a late-arriving decision | 👤 | needs decision | med |\n` +
    `| DEPLOY-901 | roll out the export button | — | queued | low |\n` +
    `| BUG-706 | ship the retry fix | 🤖 | needs deploy | med |\n` +
    `| BUG-707 | tidy the config loader | — | done, not deployed | low |\n`);
  const bAfter = await boardOf(withId);
  const expectedDeploy = deployFilter(bAfter);
  check('    the summary deploy-pending count EXACTLY equals the independently-derived filter (DEPLOY-901 + needs-deploy + not-deployed = 3)',
    bAfter.summary.counts.deployPending === expectedDeploy && expectedDeploy === 3,
    JSON.stringify({ summary: bAfter.summary.counts.deployPending, filter: expectedDeploy }));
  check('    MUST-FAIL guard: the count MOVED 0 → 3 after the rows were added (server-derived live, not a stored/fabricated 0)',
    bBefore.summary.counts.deployPending === 0 && bAfter.summary.counts.deployPending === 3,
    JSON.stringify({ before: bBefore.summary.counts.deployPending, after: bAfter.summary.counts.deployPending }));
  await cdp.eval(`window.__station.refreshRail(true)`);
  const deployPainted = await cdp.waitFor('deploy chip reflects the server-derived count',
    `Number(document.querySelector('#railSummary .rs-chip[data-target="deploy"]')?.dataset.count) === ${bAfter.summary.counts.deployPending}`, 15_000);
  const deployState = await cdp.eval(`(() => {
    const chip = document.querySelector('#railSummary .rs-chip[data-target="deploy"]');
    return { count: chip ? Number(chip.dataset.count) : null, enabled: chip ? !chip.disabled : null };
  })()`);
  check('    the rail paints a deploy chip whose number equals the server-derived count and is an enabled link',
    deployPainted && deployState.count === bAfter.summary.counts.deployPending && deployState.enabled === true,
    JSON.stringify(deployState));
  // Clicking the deploy chip opens the board portal (FEAT-066) — where those
  // scattered deploy-pending tickets are all listed.
  await cdp.eval(`document.querySelector('#railSummary .rs-chip[data-target="deploy"]').click()`);
  const onBoard = await cdp.waitFor('deploy chip opened the board portal', `/#\\/tickets/.test(location.hash)`, 10_000);
  const boardHash = await cdp.eval(`location.hash`);
  check('    clicking the deploy chip navigates to the board portal (where the deploy-pending tickets are listed)',
    onBoard && /#\/tickets/.test(boardHash), `hash=${boardHash}`);

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
    for (const d of [DATA, STORE, PROFILE, WITH]) fs.rmSync(d, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }, 2500);
});
