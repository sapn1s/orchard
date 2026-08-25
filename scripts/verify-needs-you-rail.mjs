/**
 * "Needs You" right-rail verification (FEAT-018, scoped first cut) — driven in a
 * REAL Chromium (brave --headless=new over raw CDP; happy-dom has no layout, so
 * the collapse-on-narrow half would be unverifiable there) against a REAL server.
 *
 *   node scripts/verify-needs-you-rail.mjs
 *
 * Everything is real: a scratch project on disk with an opt-in docs/bugs/ board
 * whose INDEX.md carries a KNOWN 👤 row, registered through the API, rendered by
 * the real public/app.js. Checks:
 *   a. the rail shows exactly one unresolved card, with a response field, for the
 *      seeded 👤 ticket;
 *   b. submitting the answer REMOVES the card AND appends it to the ticket file
 *      on disk (append-only — the prior log entry survives);
 *   c. a project with NO docs/bugs/ shows the quiet "nothing needs you" empty
 *      rail — not an error;
 *   d. a narrow viewport collapses the rail to a floating badge.
 *
 * Ports are OS-assigned (VERIFY_RAIL_PORT pins one); never 4317 (the live server)
 * and never a fixed default. Processes are killed by PID, never pkill.
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rail-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rail-store-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rail-chrome-'));
const WITH = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rail-with-'));   // has docs/bugs/
const WITHOUT = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rail-none-')); // no docs/bugs/
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

/* The unique answer text we type — searched for on disk to prove the write. */
const ANSWER = `ship it — rail-answer-${Date.now()}`;
const TICKET_ID = 'BUG-701';
const PRIOR_LOG = 'orchestrator filed this on 2026-08-04';
// BUG-025: a 👤 ticket with NO `## Question` section is board STATUS, not an
// ask — this seeds a SECOND 👤 row that carries no question at all, to prove
// it renders read-only (no textarea) rather than as a contextless answer box.
const STATUS_ID = 'BUG-703';

async function seedBoard() {
  // A project WITH an opt-in board: INDEX.md has one ANSWERABLE 👤 row (a
  // ticket with an explicit `## Question` — BUG-025) and one bare-👤 STATUS
  // row (no question at all); the answerable ticket's file carries a prior
  // Activity-log entry the append must not clobber.
  const bugs = path.join(WITH, 'docs', 'bugs');
  fs.mkdirSync(bugs, { recursive: true });
  fs.writeFileSync(path.join(bugs, 'INDEX.md'),
    `# Board\n\n## Open\n\n` +
    `| ID | Title | Owner | Status | Sev |\n` +
    `|----|-------|-------|--------|-----|\n` +
    `| ${TICKET_ID} | should the importer skip malformed rows or halt? | 👤 | needs decision | high |\n` +
    `| ${STATUS_ID} | waiting on user to review the new billing copy | 👤 | user-owned | low |\n` +
    `| BUG-702 | flaky retry loop under load | 🤖 | building | med |\n\n` +
    `## Done (committed)\n\n| ID | Title | Commit |\n|----|-------|--------|\n`);
  fs.writeFileSync(path.join(bugs, `${TICKET_ID}-importer-malformed-rows.md`),
    `# ${TICKET_ID} — should the importer skip malformed rows or halt?\n\n` +
    `- **Status:** OPEN\n- **Severity:** high\n\n` +
    `## Question\nShould the importer skip malformed rows, or halt the whole batch?\n` +
    `- skip and log\n- halt\n\n` +
    `## Activity log (APPEND-ONLY)\n\n### 2026-08-04 — orchestrator\n- ${PRIOR_LOG}\n`);
  // BUG-025: a bare 👤 ticket — board status ("user-owned"), no `## Question`
  // section anywhere in the file — must NOT become an answerable card.
  fs.writeFileSync(path.join(bugs, `${STATUS_ID}-billing-copy-review.md`),
    `# ${STATUS_ID} — waiting on user to review the new billing copy\n\n` +
    `- **Status:** OPEN\n- **Severity:** low\n\n` +
    `## Activity log (APPEND-ONLY)\n\n### 2026-08-04 — orchestrator\n- marked 👤, user to review copy in the PR.\n`);
  // A project WITHOUT any board — no docs/bugs/ at all.
  fs.writeFileSync(path.join(WITHOUT, 'README.md'), '# no board here\n');
}

async function registerProject(hostPath, name) {
  const r = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath, name }),
  })).json();
  if (!r.project?.id) throw new Error(`could not register ${name}: ${JSON.stringify(r)}`);
  return r.project.id;
}

async function main() {
  await seedBoard();
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
  const withoutId = await registerProject(WITHOUT, 'No Board');

  // Server-side precondition: the board reader sees BOTH 👤 rows as needsYou
  // (the questioned ticket AND the bare-status ticket) and the 🤖 row as
  // inflight; the no-board project returns hasBoard:false.
  const b = await (await fetch(`${BASE}/api/projects/${withId}/board`)).json();
  const answerableRow = b.needsYou?.find((x) => x.id === TICKET_ID);
  const statusRow = b.needsYou?.find((x) => x.id === STATUS_ID);
  check('PRECONDITION: board route parses both 👤 rows into needsYou and the 🤖 row into inflight',
    b.needsYou?.length === 2 && answerableRow && statusRow && b.inflight?.some((x) => x.id === 'BUG-702'),
    JSON.stringify({ needsYou: b.needsYou?.map((x) => x.id), inflight: b.inflight?.map((x) => x.id) }));
  check('PRECONDITION (BUG-025): the `## Question`-bearing ticket carries a parsed `question` + options',
    answerableRow?.question?.includes('malformed rows') && Array.isArray(answerableRow?.options) && answerableRow.options.length === 2,
    JSON.stringify({ question: answerableRow?.question, options: answerableRow?.options }));
  check('PRECONDITION (BUG-025): the bare 👤 ticket (no `## Question`) carries NO `question`',
    statusRow && statusRow.question === undefined,
    JSON.stringify({ question: statusRow?.question }));
  const nb = await (await fetch(`${BASE}/api/projects/${withoutId}/board`)).json();
  check('PRECONDITION: a project with no docs/bugs/ returns an empty board (hasBoard:false), not an error',
    nb.hasBoard === false && (nb.needsYou?.length ?? 0) === 0, JSON.stringify(nb));

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

  // A freshly-registered project has no `lastActivityAt`, so the sidebar's
  // recency split (`isActiveProject`) folds it under the collapsed "N
  // inactive projects" row until it is expanded — a `.proj` query alone
  // would miss it. Expand that row first (harmless if already expanded/
  // absent) so BOTH seeded projects are always reachable by name.
  const clickProj = async (name) => cdp.eval(`(() => {
    const find = () => [...document.querySelectorAll('#tree button.proj')]
      .find((r) => (r.querySelector('.nm')?.textContent ?? '').includes(${JSON.stringify(name)}));
    let row = find();
    if (!row) {
      const inactiveToggle = document.querySelector('#tree .inactive-l');
      if (inactiveToggle) { inactiveToggle.click(); row = find(); }
    }
    if (!row) return false;
    row.click(); return true;
  })()`);

  console.log('\n=== rail: a 👤 board item WITH a `## Question` renders an answerable card ===');
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('boot', `document.querySelectorAll('#tree button.proj').length >= 2`, 30_000);
  const picked = await clickProj('Has Board');
  check('PRECONDITION: the seeded board project is in the sidebar and selectable', picked, `clicked=${picked}`);
  await cdp.waitFor('needs-you cards', `document.querySelectorAll('#railNeeds .needs-card').length >= 2`, 20_000);
  const cardState = await cdp.eval(`(() => {
    const cards = [...document.querySelectorAll('#railNeeds .needs-card')];
    const c = document.querySelector(${JSON.stringify(`#railNeeds .needs-card[data-id="${TICKET_ID}"]`)});
    return {
      count: cards.length,
      id: c?.dataset.id ?? null,
      title: c?.querySelector('.nc-title')?.textContent ?? '',
      question: c?.querySelector('.nc-question')?.textContent ?? '',
      hasField: !!c?.querySelector('textarea.nc-input'),
      hasSubmit: !!c?.querySelector('.nc-send'),
      hasOptions: c?.querySelectorAll('.nc-opt').length ?? 0,
      emptyShown: !!document.querySelector('#railNeeds .rail-empty'),
    };
  })()`);
  check('(a) the `## Question`-bearing ticket renders an answerable card WITH a response field + submit + its 2 options',
    cardState.count === 2 && cardState.id === TICKET_ID && cardState.hasField && cardState.hasSubmit && cardState.hasOptions === 2 && !cardState.emptyShown,
    JSON.stringify(cardState));
  check('    the card shows the ticket title (from the ticket H1), not a placeholder',
    /malformed rows/.test(cardState.title), JSON.stringify(cardState.title));
  check('    (BUG-025) the card also shows the parsed `## Question` text',
    /skip malformed rows, or halt/.test(cardState.question), JSON.stringify(cardState.question));

  console.log('\n=== BUG-025: a bare 👤 ticket (no `## Question`) renders READ-ONLY — no answer box ===');
  const statusCard = await cdp.eval(`(() => {
    const c = document.querySelector(${JSON.stringify(`#railNeeds .needs-card[data-id="${STATUS_ID}"]`)});
    const open = c?.querySelector('a.nc-send');
    return {
      found: !!c,
      kind: c?.dataset.kind ?? null,
      title: c?.querySelector('.nc-title')?.textContent ?? '',
      hasField: !!c?.querySelector('textarea.nc-input, .nc-input'),
      hasOpenLink: !!open,
      openHref: open?.getAttribute('href') ?? null,
      openIsAnchor: open?.tagName === 'A',
    };
  })()`);
  check('(BUG-025) the bare 👤 ticket is a read-only status row: NO response field/textarea at all',
    statusCard.found && statusCard.kind === 'status' && !statusCard.hasField, JSON.stringify(statusCard));
  check('    it shows the ticket title, and an "open ticket" affordance (an anchor with a real href), not a submit button',
    /billing copy/.test(statusCard.title) && statusCard.hasOpenLink && statusCard.openIsAnchor && !!statusCard.openHref && statusCard.openHref !== '#',
    JSON.stringify(statusCard));

  console.log('\n=== rail: answering the questioned ticket removes ONLY that card AND writes to the ticket ===');
  const ticketPath = path.join(WITH, 'docs', 'bugs', `${TICKET_ID}-importer-malformed-rows.md`);
  const before = fs.readFileSync(ticketPath, 'utf8');
  await cdp.eval(`(() => {
    const c = document.querySelector(${JSON.stringify(`#railNeeds .needs-card[data-id="${TICKET_ID}"]`)});
    const ta = c.querySelector('textarea.nc-input');
    ta.value = ${JSON.stringify(ANSWER)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    c.querySelector('.nc-send').click();
  })()`);
  // The card leaves optimistically; the reconciling refresh must keep it gone
  // (the server marks the answered ticket resolved). The STATUS card (a
  // different, unrelated ticket) must stay put — answering one never touches
  // the other. Wait for both to settle.
  const gone = await cdp.waitFor('answered card removed, status card still present, rail not empty',
    `document.querySelectorAll('#railNeeds .needs-card[data-id="${TICKET_ID}"]').length === 0 &&
     document.querySelectorAll('#railNeeds .needs-card[data-id="${STATUS_ID}"]').length === 1 &&
     !document.querySelector('#railNeeds .rail-empty')`, 20_000);
  check('(b1) submitting removed only the answered card; the unrelated status card is untouched',
    gone, `cards now = ${await cdp.eval(`document.querySelectorAll('#railNeeds .needs-card').length`)}`);

  // Give the append a beat, then read the file from disk.
  await sleep(400);
  const after = fs.readFileSync(ticketPath, 'utf8');
  check('(b2) the answer was APPENDED to the ticket file on disk (dated Activity-log entry)',
    after.includes(ANSWER) && after.length > before.length && /###\s+\d{4}-\d{2}-\d{2}\s+—\s+you/.test(after),
    JSON.stringify(after.slice(before.length).trim().slice(0, 160)));
  check('(b3) append-only: the prior Activity-log entry still survives verbatim',
    after.includes(PRIOR_LOG) && after.indexOf(PRIOR_LOG) < after.indexOf(ANSWER),
    `prior entry present=${after.includes(PRIOR_LOG)}`);

  console.log('\n=== rail: a project with no board shows the quiet empty state ===');
  const pickedNoBoard = await clickProj('No Board');
  check('PRECONDITION: the no-board project is reachable and selectable (not stuck under "Has Board")',
    pickedNoBoard, `clicked=${pickedNoBoard}`);
  await cdp.waitFor('board switched to the no-board project', `window.__station?.state?.current?.projectId === ${JSON.stringify(withoutId)}`, 10_000);
  const empty = await cdp.waitFor('empty rail',
    `!!document.querySelector('#railNeeds .rail-empty') && document.querySelectorAll('#railNeeds .needs-card').length === 0`, 15_000);
  const emptyText = await cdp.eval(`document.querySelector('#railNeeds .rail-empty')?.textContent ?? ''`);
  const errShown = await cdp.eval(`(() => { const f = document.querySelector('#fine'); return f && !f.hidden && f.classList.contains('err') ? f.textContent : null; })()`);
  check('(c) no-board project shows "nothing needs you" — and NOT an error',
    empty && /nothing needs you/i.test(emptyText) && !errShown, JSON.stringify({ emptyText: emptyText.trim(), errShown }));

  console.log('\n=== rail: a narrow viewport collapses the rail to a badge ===');
  // Re-select the board project so there IS a card/count to collapse.
  await clickProj('Has Board');
  await sleep(300);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 780, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const narrow = await cdp.eval(`(() => {
    const rail = document.querySelector('#rail');
    const badge = document.querySelector('#railBadge');
    const rr = rail.getBoundingClientRect();
    // The rail is absolute inside #win (which itself has a desktop inset), so
    // "off-canvas" is measured against the window's right edge, not innerWidth.
    const win = document.querySelector('#win').getBoundingClientRect();
    const bcs = getComputedStyle(badge);
    return {
      badgeVisible: bcs.display !== 'none' && badge.offsetWidth > 0,
      railOffscreen: rr.left >= win.right - 4,             // translated fully to the right
      railAbsolute: getComputedStyle(rail).position === 'absolute',
      winRight: Math.round(win.right),
      railLeft: Math.round(rr.left),
    };
  })()`);
  check('(d) narrow viewport: the rail panel is off-canvas and a floating badge is shown instead',
    narrow.badgeVisible && narrow.railOffscreen && narrow.railAbsolute, JSON.stringify(narrow));
  // And the badge opens it back as an overlay (the affordance is real, not decorative).
  await cdp.eval(`document.querySelector('#railBadge').click()`);
  await sleep(300);
  const opened = await cdp.eval(`(() => {
    const rr = document.querySelector('#rail').getBoundingClientRect();
    return rr.left < window.innerWidth - 40;
  })()`);
  check('    the badge opens the rail back as an overlay', opened, `opened=${opened}`);
  await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});

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
