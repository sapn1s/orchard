/**
 * FEAT-058 — ticket dashboard verification.
 *
 *   node scripts/verify-ticket-dashboard.mjs
 *   node scripts/verify-ticket-dashboard.mjs --no-model   # skip the live-model leg
 *
 * Everything is real: a scratch project on disk with a SEEDED docs/bugs/ board
 * (Open/Done/Shipped tables, one Done ticket, one 👤 ticket, one 🤖 ticket, and a
 * phrase that exists ONLY inside an Activity-log entry), a real server on an
 * OS-assigned free port with a scratch data dir, and the real public/app.js
 * driven in a real Chromium (brave --headless=new over raw CDP).
 *
 * What it proves, in the ticket's own order:
 *   1. the list renders every ticket with the right status/owner, and filters work
 *   2. search finds a phrase that exists ONLY in an Activity log (body search,
 *      not title search) and says which line it was on
 *   3. the detail view renders the REAL file (an activity-log line is on screen)
 *   4. browsing mutates NOTHING (every ticket file's mtime+size is unchanged)
 *   5. appending a note writes a dated, attributed, APPEND-ONLY entry, and every
 *      prior byte of the file survives BYTE-IDENTICALLY
 *   6. CONCURRENCY: a write carrying a stale `rev` is refused 409 and the file is
 *      untouched — an agent's concurrent entry can never be clobbered
 *   7. reopening a Done ticket flips its Status header, logs why, moves the row
 *      Done → Open through the board TOOL, and leaves `board:check` green
 *   8. END-TO-END: a NEW session for that project receives the reopened ticket in
 *      its injected board snapshot — asserted through the real compose path AND
 *      through a REAL (cheap, haiku) session that reads it back
 *   9. the 👤 flag puts the ticket on the Needs-You rail
 *  10. filing a new ticket allocates the id by the board tool's rule, writes from
 *      TEMPLATE.md, and leaves `board:check` green
 *  11. a SECOND TAB can sit on #/tickets while the session tab stays live
 *
 * Ports are OS-assigned; never 4317 (the user's live server). Processes are
 * killed by PID, never pkill.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ARGS = process.argv.slice(2);
const NO_MODEL = ARGS.includes('--no-model');

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_TICKETS_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
/** The tree the SERVER + static assets are served from (a base worktree proves
 *  the pre-change RED). Defaults to this repo. */
const ROOT = path.resolve(process.env.VERIFY_TICKETS_ROOT ?? path.join(import.meta.dirname, '..'));
const TOOLROOT = path.resolve(import.meta.dirname, '..'); // board.mjs always from THIS tree
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-tix-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-tix-store-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-tix-chrome-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-tix-proj-'));
const BUGS = path.join(WORK, 'docs', 'bugs');
const SHOTS = path.join(TOOLROOT, 'docs', 'bugs', 'assets');
const BRAVE = process.env.VERIFY_TICKETS_BROWSER ?? 'brave';
// The template layer resolves its data dir from the env AT IMPORT TIME — set it
// before anything imports src/server/templates.ts (the end-to-end leg does).
process.env.CLAUDE_STATION_DATA = DATA;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TODAY = new Date().toISOString().slice(0, 10);

/* ─────────────────────────────────────────────────────────── the seeded board */

/* The phrase that exists ONLY inside an Activity-log entry — nowhere in any
   title, id, or header. Finding it is the proof that search reads BODIES. */
const LOG_ONLY_PHRASE = 'jackdaw pivot table regressed under locale tr-TR';
const DONE_ID = 'BUG-901';
const NEEDS_ID = 'FEAT-902';
const AGENT_ID = 'BUG-903';
const OPEN_ID = 'FEAT-904';
const PRIOR_LOG = 'orchestrator closed this after the locale fix landed';

function seedBoard() {
  fs.mkdirSync(BUGS, { recursive: true });
  fs.writeFileSync(path.join(BUGS, 'INDEX.md'),
    `# Board — scratch\n\nThe board for a scratch project.\n\n` +
    `## Open\n\n` +
    `| ID | Title | Owner | Status | Sev |\n` +
    `|----|-------|-------|--------|-----|\n` +
    `| ${NEEDS_ID} | export button needs a decision | 👤 | needs decision | high |\n` +
    `| ${AGENT_ID} | flaky retry loop under load | 🤖 | building | med |\n` +
    `| ${OPEN_ID} | paginate the audit view | — | queued | low |\n\n` +
    `## Done (committed)\n\n| ID | Title | Commit |\n|----|-------|--------|\n` +
    `| ${DONE_ID} | pivot table breaks under a Turkish locale | abc1234 |\n\n` +
    `## Shipped earlier (pre-tracker)\n\n- nothing yet\n`);

  fs.writeFileSync(path.join(BUGS, `${DONE_ID}-pivot-locale.md`),
    `# ${DONE_ID} — pivot table breaks under a Turkish locale\n\n` +
    `- **Status:** VERIFIED / DONE\n- **Severity:** high\n- **Area:** reports\n` +
    `- **Reported:** 2026-08-01 by user\n\n` +
    `## Symptom\nThe report grid renders empty for some users.\n\n` +
    `## Activity log (APPEND-ONLY)\n\n### 2026-08-02 — agent\n` +
    `- **Understood:** the ${LOG_ONLY_PHRASE}, because uppercasing the key is locale-sensitive.\n` +
    `- ${PRIOR_LOG}\n`);
  fs.writeFileSync(path.join(BUGS, `${NEEDS_ID}-export-button.md`),
    `# ${NEEDS_ID} — export button needs a decision\n\n` +
    `- **Status:** OPEN\n- **Severity:** high\n- **Area:** UI\n\n` +
    `## Question\nShould export produce CSV or XLSX?\n- csv\n- xlsx\n\n` +
    `## Activity log (APPEND-ONLY)\n\n### 2026-08-03 — orchestrator\n- filed, waiting on the user.\n`);
  fs.writeFileSync(path.join(BUGS, `${AGENT_ID}-flaky-retry.md`),
    `# ${AGENT_ID} — flaky retry loop under load\n\n` +
    `- **Status:** IN-PROGRESS\n- **Severity:** med\n- **Area:** server\n\n` +
    `## Activity log (APPEND-ONLY)\n\n### 2026-08-05 — agent\n- reproducing under load.\n`);
  fs.writeFileSync(path.join(BUGS, `${OPEN_ID}-paginate-audit.md`),
    `# ${OPEN_ID} — paginate the audit view\n\n` +
    `- **Status:** OPEN\n- **Severity:** low\n- **Area:** UI\n\n` +
    `## Activity log (APPEND-ONLY)\n\n### 2026-08-06 — orchestrator\n- queued.\n`);
  // The board tool's templates, so "file a new ticket" has something to file from.
  for (const t of ['TEMPLATE.md', 'TEMPLATE-ARCH.md']) {
    fs.copyFileSync(path.join(TOOLROOT, 'docs', 'bugs', t), path.join(BUGS, t));
  }
}

const ticketPath = (id) => {
  const hit = fs.readdirSync(BUGS).find((n) => n.startsWith(`${id}-`));
  return hit ? path.join(BUGS, hit) : null;
};
const readTicket = (id) => fs.readFileSync(ticketPath(id), 'utf8');
const boardCheck = () => {
  const r = spawnSync(process.execPath, [path.join(TOOLROOT, 'scripts', 'board.mjs'), 'check', `--dir=${BUGS}`], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
/** mtime+size of every ticket file — the read-only-browsing assertion. */
const fileStamps = () => Object.fromEntries(fs.readdirSync(BUGS)
  .filter((n) => n.endsWith('.md'))
  .map((n) => { const s = fs.statSync(path.join(BUGS, n)); return [n, `${Math.round(s.mtimeMs)}:${s.size}`]; }));

/* ─────────────────────────────────────────────────────────────────── raw CDP */

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
  async shot(file) {
    try {
      const r = await this.send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      console.log(`        screenshot → ${file}`);
    } catch (err) { console.log(`        (screenshot failed: ${err.message})`); }
  }
  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

let server = null, browser = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

const jget = async (p) => (await fetch(`${BASE}${p}`)).json();
const jpost = async (p, body) => {
  const r = await fetch(`${BASE}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

/* ───────────────────────────────────────────────────────────────────── main */

async function main() {
  seedBoard();
  const pre = boardCheck();
  check('PRECONDITION: the seeded scratch board starts green under the board tool',
    pre.code === 0, pre.out.trim().split('\n').pop());

  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); }
  }
  if (!up) throw new Error('server never became healthy');

  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: WORK, name: 'Tix Scratch' }),
  })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`could not register the scratch project: ${JSON.stringify(reg)}`);
  await fetch(`${BASE}/api/projects/${encodeURIComponent(pid)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { permissionMode: 'bypassPermissions', model: 'haiku' } }),
  });

  /* ═════════ server routes ═════════ */
  console.log('\n=== server: list / search / detail ===');
  const list = await jget(`/api/projects/${pid}/tickets`);
  check('the list route returns every seeded ticket with its derived section + curated owner',
    list.tickets?.length === 4
      && list.tickets.find((t) => t.id === DONE_ID)?.section === 'done'
      && list.tickets.find((t) => t.id === NEEDS_ID)?.needsYou === true
      && list.tickets.find((t) => t.id === AGENT_ID)?.owner.includes('🤖'),
    JSON.stringify(list.tickets?.map((t) => [t.id, t.section, t.owner])));

  const found = await jget(`/api/projects/${pid}/tickets?q=${encodeURIComponent(LOG_ONLY_PHRASE)}`);
  const hit = found.tickets?.[0];
  check('SEARCH finds a phrase that exists ONLY in an Activity log (body search, not title search)',
    found.tickets?.length === 1 && hit?.id === DONE_ID && hit?.where?.body === true
      && hit?.where?.title === false && hit?.matches?.[0]?.inActivityLog === true,
    JSON.stringify({ ids: found.tickets?.map((t) => t.id), where: hit?.where, line: hit?.matches?.[0]?.line }));

  const detail = await jget(`/api/projects/${pid}/tickets/${DONE_ID}`);
  check('the detail route returns the REAL file bytes (markdown === the file on disk)',
    detail.markdown === readTicket(DONE_ID) && detail.rev,
    `bytes=${detail.markdown?.length} rev=${detail.rev}`);

  console.log('\n=== server: concurrency — a stale rev is REFUSED, never clobbered ===');
  const staleRev = detail.rev;
  // An "agent" appends to the same ticket, exactly as one would mid-fix.
  fs.appendFileSync(ticketPath(DONE_ID), `\n### ${TODAY} — agent (concurrent)\n- an agent wrote here while the tab was open.\n`);
  const agentBytes = readTicket(DONE_ID);
  const conflict = await jpost(`/api/projects/${pid}/tickets/${DONE_ID}/note`, { text: 'user note racing the agent', rev: staleRev });
  check('a note carrying a STALE rev is refused with 409 and names the current rev',
    conflict.status === 409 && !!conflict.body.rev && conflict.body.rev !== staleRev,
    JSON.stringify({ status: conflict.status, rev: conflict.body.rev, error: String(conflict.body.error).slice(0, 90) }));
  check("   …and the agent's concurrent entry is still on disk, byte-identical (nothing was clobbered)",
    readTicket(DONE_ID) === agentBytes, `file unchanged=${readTicket(DONE_ID) === agentBytes}`);
  const noRev = await jpost(`/api/projects/${pid}/tickets/${DONE_ID}/note`, { text: 'no rev at all' });
  check('a write with NO rev at all is refused too (a freshness check that can be skipped is no check)',
    noRev.status === 400 && readTicket(DONE_ID) === agentBytes, JSON.stringify({ status: noRev.status }));

  /* ═════════ browser ═════════ */
  browser = spawn(BRAVE, [
    '--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--window-size=1500,950', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 80 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  if (!devPort) throw new Error('browser never wrote DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  console.log('\n=== UI: #/tickets/all renders the whole board ===');
  // FEAT-082: the full table moved to #/tickets/all (bare #/tickets is the digest
  // now). The table's own behaviour — sortable headers, filters, keyboard cursor,
  // full-text body search — is unchanged; only its placement moved.
  const beforeBrowse = fileStamps();
  await cdp.send('Page.navigate', { url: `${BASE}/#/tickets/all?project=${encodeURIComponent(pid)}` });
  const listUp = await cdp.waitFor('ticket rows', `document.querySelectorAll('#tvList a.tv-row').length >= 4`, 30_000);
  const rows = await cdp.eval(`(() => [...document.querySelectorAll('#tvList a.tv-row')].map((r) => ({
    id: r.querySelector('.c-id').textContent,
    title: r.querySelector('.c-title').textContent,
    owner: r.querySelector('.c-own').textContent,
    status: r.querySelector('.c-status').textContent,
    sev: r.querySelector('.c-sev').textContent,
    when: r.querySelector('.c-when').textContent,
    href: r.getAttribute('href'),
  })))()`);
  check('(1) the list renders every ticket with id/title/owner/status/sev/last-activity',
    listUp && rows.length === 4
      && rows.every((r) => r.id && r.title && r.when && r.href.startsWith('#/tickets/'))
      && rows.find((r) => r.id === NEEDS_ID)?.owner === '👤'
      && rows.find((r) => r.id === AGENT_ID)?.owner === '🤖'
      && rows.find((r) => r.id === DONE_ID)?.status === 'Done',
    JSON.stringify(rows));
  check('    the tickets view is a ROUTE with per-ticket hrefs (ctrl/cmd-click opens a second tab)',
    rows.length === 4 && rows.every((r) => r.href === `#/tickets/${r.id}?project=${pid}`),
    `${rows.length} rows, first href=${rows[0]?.href}`);
  await cdp.shot(path.join(SHOTS, 'FEAT-058-list.png'));

  console.log('\n=== UI: filters ===');
  const filtered = await cdp.eval(`(() => {
    const set = (sel, v) => { const e = document.querySelector(sel); e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); };
    set('#tvStatus', 'done');
    const done = [...document.querySelectorAll('#tvList a.tv-row')].map((r) => r.dataset.id);
    set('#tvStatus', 'all'); set('#tvOwner', 'you');
    const you = [...document.querySelectorAll('#tvList a.tv-row')].map((r) => r.dataset.id);
    set('#tvOwner', 'all'); set('#tvSev', 'high');
    const high = [...document.querySelectorAll('#tvList a.tv-row')].map((r) => r.dataset.id);
    set('#tvSev', 'all');
    return { done, you, high, count: document.querySelector('#tvCount').textContent };
  })()`);
  check('(1b) status / owner / severity filters each narrow the list correctly',
    JSON.stringify(filtered.done) === JSON.stringify([DONE_ID])
    && JSON.stringify(filtered.you) === JSON.stringify([NEEDS_ID])
    && filtered.high.length === 2 && filtered.high.includes(NEEDS_ID) && filtered.high.includes(DONE_ID),
    JSON.stringify(filtered));

  console.log('\n=== UI: full-text search over ticket BODIES ===');
  await cdp.eval(`(() => { const s = document.querySelector('#tvSearch');
    s.value = ${JSON.stringify(LOG_ONLY_PHRASE)}; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const searched = await cdp.waitFor('one search hit',
    `document.querySelectorAll('#tvList .tv-rowwrap').length === 1 && document.querySelectorAll('#tvList a.tv-row').length === 1`, 10_000);
  const hitUi = await cdp.eval(`(() => {
    const row = document.querySelector('#tvList a.tv-row');
    const h = document.querySelector('#tvList .tv-hit');
    return { id: row?.dataset.id ?? null, line: h?.querySelector('.ln')?.textContent ?? '', text: h?.querySelector('.tx')?.textContent ?? '', inLog: h?.classList.contains('log') ?? false };
  })()`);
  check('(2) searching a phrase that appears ONLY in an activity log finds exactly that ticket, with the line',
    searched && hitUi.id === DONE_ID && hitUi.text.includes('jackdaw') && hitUi.inLog && /^:\d+$/.test(hitUi.line),
    JSON.stringify(hitUi));
  await cdp.shot(path.join(SHOTS, 'FEAT-058-search.png'));

  console.log('\n=== UI: detail renders the real file ===');
  await cdp.eval(`document.querySelector('#tvList a.tv-row').click()`);
  const detailUp = await cdp.waitFor('detail', `document.querySelector('#tvDetail .tv-doc')?.dataset.id === ${JSON.stringify(DONE_ID)}`, 15_000);
  const doc = await cdp.eval(`(() => {
    const d = document.querySelector('#tvDetail .tv-doc');
    return {
      id: d?.dataset.id ?? null,
      title: d?.querySelector('.tv-dtitle')?.textContent ?? '',
      hash: location.hash,
      md: d?.querySelector('.tv-md')?.textContent ?? '',
      headings: [...(d?.querySelectorAll('.tv-md .prose h3, .tv-md .prose h4, .tv-md .prose h5') ?? [])].map((h) => h.textContent),
      hasNoteBox: !!d?.querySelector('textarea.tv-note'),
      reopenEnabled: !document.querySelector('#tvReopenBtn')?.disabled,
    };
  })()`);
  check('(3) the detail view renders the ticket\'s REAL markdown — an activity-log LINE is on screen',
    detailUp && doc.id === DONE_ID && doc.md.includes(LOG_ONLY_PHRASE) && doc.md.includes(PRIOR_LOG)
      && doc.headings.some((h) => /Activity log/i.test(h)) && doc.hash === `#/tickets/${DONE_ID}?project=${pid}`,
    JSON.stringify({ hash: doc.hash, headings: doc.headings, hasPhrase: doc.md.includes(LOG_ONLY_PHRASE) }));
  check('    the markdown went through the transcript renderer (real headings/lists, no raw "##")',
    !doc.md.includes('## Activity log') && doc.headings.length >= 2, JSON.stringify(doc.headings.slice(0, 4)));
  await cdp.shot(path.join(SHOTS, 'FEAT-058-detail.png'));

  check('(4) read-only browsing mutated NOTHING on disk (every ticket file byte-for-byte where it was)',
    JSON.stringify(fileStamps()) === JSON.stringify(beforeBrowse),
    JSON.stringify({ before: Object.keys(beforeBrowse).length }));

  console.log('\n=== UI: append a note (append-only, dated, attributed) ===');
  const NOTE = `user note — ${Date.now()} — please re-check the tr-TR case`;
  const beforeNote = readTicket(DONE_ID);
  await cdp.eval(`(() => {
    const ta = document.querySelector('#tvDetail textarea.tv-note');
    ta.value = ${JSON.stringify(NOTE)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#tvNoteBtn').click();
  })()`);
  const noteLanded = await cdp.waitFor('note write reported', `/board reconciled|drift|could not/.test(document.querySelector('#tvDetail .tv-msg')?.textContent ?? '')`, 15_000);
  await sleep(300);
  const afterNote = readTicket(DONE_ID);
  check('(5) the note is APPENDED to the ticket file, dated and attributed to the user',
    noteLanded && afterNote.includes(NOTE)
      && new RegExp(`### ${TODAY} — user \\(via dashboard\\)`).test(afterNote),
    JSON.stringify(afterNote.slice(beforeNote.length).trim().slice(0, 120)));
  check('    APPEND-ONLY: every prior byte of the file survives BYTE-IDENTICALLY',
    afterNote.startsWith(beforeNote) && afterNote.length > beforeNote.length,
    `prefix-identical=${afterNote.startsWith(beforeNote)} grew=${afterNote.length - beforeNote.length}B`);
  const afterNoteCheck = boardCheck();
  check('    board:check is still green after the write', afterNoteCheck.code === 0, afterNoteCheck.out.trim().split('\n').pop());

  console.log('\n=== UI: reopen a Done ticket ===');
  const REASON = `reopening — the tr-TR case is back on ${TODAY}`;
  const beforeReopen = readTicket(DONE_ID);
  await cdp.eval(`(() => {
    const ta = document.querySelector('#tvDetail textarea.tv-note');
    ta.value = ${JSON.stringify(REASON)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#tvReopenBtn').click();
  })()`);
  const reopened = await cdp.waitFor('reopen reported',
    `document.querySelector('#tvDetail .tv-doc .d-badge')?.textContent === 'Open'`, 20_000);
  await sleep(300);
  const afterReopen = readTicket(DONE_ID);
  const indexText = fs.readFileSync(path.join(BUGS, 'INDEX.md'), 'utf8');
  const openTable = indexText.slice(indexText.indexOf('## Open'), indexText.indexOf('## Done'));
  const doneTable = indexText.slice(indexText.indexOf('## Done'), indexText.indexOf('## Shipped'));
  check('(7) reopening flipped the ticket\'s Status header back to OPEN',
    reopened && /^- \*\*Status:\*\* OPEN \(reopened/m.test(afterReopen),
    (afterReopen.match(/^- \*\*Status:\*\*.*$/m) ?? [])[0]);
  check('    the reason is recorded as a NEW dated log entry, and every prior entry survives',
    afterReopen.includes(REASON) && afterReopen.includes(PRIOR_LOG) && afterReopen.includes(NOTE)
      && afterReopen.indexOf(PRIOR_LOG) < afterReopen.indexOf(REASON),
    `prior entries intact=${afterReopen.includes(PRIOR_LOG) && afterReopen.includes(NOTE)}`);
  check('    the board TOOL moved the row Done → Open and kept the curated columns',
    openTable.includes(`| ${DONE_ID} |`) && !doneTable.includes(`| ${DONE_ID} |`)
      && openTable.includes('| 👤 | reopened by user |')
      && openTable.includes(`| ${AGENT_ID} | flaky retry loop under load | 🤖 | building |`),
    openTable.split('\n').filter((l) => l.includes(DONE_ID) || l.includes(AGENT_ID)).join(' ⏎ '));
  const afterReopenCheck = boardCheck();
  check('    board:check is STILL green after the reopen',
    afterReopenCheck.code === 0, afterReopenCheck.out.trim().split('\n').pop());
  await cdp.shot(path.join(SHOTS, 'FEAT-058-reopened.png'));

  /* ═════════ the end-to-end claim ═════════ */
  console.log('\n=== END-TO-END: a NEW session receives the reopened ticket in its board snapshot ===');
  const { boardStateSection } = await import(path.join(ROOT, 'src', 'server', 'board.ts'));
  const { composeInstructions, seedTemplates } =
    await import(path.join(ROOT, 'src', 'server', 'templates.ts'));
  seedTemplates();
  const section = boardStateSection(WORK);
  check('(8a) the launch-time board snapshot NAMES the reopened ticket (composed from the files just written)',
    typeof section === 'string' && section.includes(DONE_ID) && /Needs you \(2\)/.test(section),
    (section ?? '').split('\n').filter((l) => l.includes(DONE_ID) || l.includes('Needs you')).join(' ⏎ '));
  const composed = composeInstructions([{ templateId: 'working-agreement-v2' }]);
  const foldedText = typeof composed.systemPrompt === 'string'
    ? composed.systemPrompt : composed.systemPrompt?.append ?? '';
  // FEAT-113 — the launch keeps the volatile board snapshot OUT of the (cached,
  // byte-stable) system prompt and rides it in the FIRST TURN instead. So the
  // real launch prompt = the composed WA system block + a first-turn preamble
  // that carries the snapshot; assert BOTH halves the way the launch now builds
  // them (WA in system, ticket in the turn).
  const firstTurn = [section, 'orchestrator: continue'].filter((s) => s && s.trim()).join('\n\n---\n\n');
  check('(8b) …the WA is the system prompt and the reopened ticket rides the first turn (the exact split a launch builds)',
    foldedText.includes('# Working Agreement v2') && !foldedText.includes(DONE_ID) && firstTurn.includes(DONE_ID),
    `WA in system=${foldedText.includes('# Working Agreement v2')} ticket off-system=${!foldedText.includes(DONE_ID)} ticket in turn=${firstTurn.includes(DONE_ID)}`);

  if (NO_MODEL) {
    console.log('  SKIP  (8c) live-model leg skipped (--no-model)');
  } else {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const events = [];
    ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    ws.send(JSON.stringify({
      type: 'start', projectId: pid,
      prompt: 'Do not use any tool. This session was launched with a "Project state (live board snapshot)" section '
        + 'injected into its opening context. Reply with ONLY the ticket ids listed under "Needs you" in it, comma-separated, and nothing else.',
    }));
    const waitEv = async (pred, ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { const h = events.find(pred); if (h) return h; await sleep(200); }
      return null;
    };
    const init = await waitEv((e) => e.t === 'session-init', 120_000);
    const end = await waitEv((e) => e.t === 'turn-end', 180_000);
    const said = events.filter((e) => e.t === 'text' && !e.agentId).map((e) => e.text).join('\n');
    check('(8c) a REAL new (haiku) session for this project reads the reopened ticket back out of its own injected board state',
      !!init && !!end && said.includes(DONE_ID),
      JSON.stringify({ started: !!init, ended: !!end, model: init?.model, said: said.trim().slice(0, 160) }));
    try { ws.close(); } catch { /* gone */ }
  }

  console.log('\n=== the reopened ticket is on the Needs-You rail (👤) ===');
  const railBoard = await jget(`/api/projects/${pid}/board`);
  check('(9) the board route now lists the reopened ticket as a 👤 needs-you item',
    (railBoard.needsYou ?? []).some((x) => x.id === DONE_ID),
    JSON.stringify((railBoard.needsYou ?? []).map((x) => x.id)));

  console.log('\n=== UI: file a new ticket from the template ===');
  await cdp.eval(`(() => { location.hash = ${JSON.stringify(`#/tickets/all?project=${pid}`)}; })()`);
  await cdp.waitFor('back on the list', `!document.querySelector('#tvList').hidden`, 10_000);
  await cdp.eval(`document.querySelector('#tvNew').click()`);
  await cdp.waitFor('new-ticket form', `!!document.querySelector('#tvFileBtn')`, 10_000);
  const NEW_TITLE = 'audit export drops the last page';
  await cdp.eval(`(() => {
    const d = document.querySelector('#tvDetail');
    d.querySelectorAll('select')[0].value = 'BUG';
    d.querySelector('input.tv-in').value = ${JSON.stringify(NEW_TITLE)};
    d.querySelector('textarea.tv-note').value = 'Exporting 3 pages yields 2. Seen on the audit view.';
    document.querySelector('#tvFileBtn').click();
  })()`);
  const filedUp = await cdp.waitFor('the new ticket opened', `/^#\\/tickets\\/BUG-904/.test(location.hash)`, 20_000);
  const newFile = ticketPath('BUG-904');
  const newText = newFile ? fs.readFileSync(newFile, 'utf8') : '';
  check('(10) filing allocates the next id by the board tool\'s rule (BUG-903 → BUG-904) and writes a real ticket file',
    filedUp && !!newFile && newText.startsWith(`# BUG-904 — ${NEW_TITLE}`)
      && /^- \*\*Status:\*\* OPEN$/m.test(newText)
      && /^- \*\*Severity:\*\* med$/m.test(newText)
      && new RegExp(`### ${TODAY} — user \\(via dashboard\\)`).test(newText)
      && /## Context pack/.test(newText),
    JSON.stringify({ file: newFile && path.basename(newFile), head: newText.split('\n').slice(0, 4) }));
  check('    …and the template\'s PLACEHOLDER activity entry did not come with it (no fake log entry)',
    !newText.includes('<date>') && !newText.includes('**Understood:** …'),
    `placeholders=${newText.includes('<date>')}`);
  const afterFileCheck = boardCheck();
  check('    board:check is STILL green after filing (the row was added through the tool)',
    afterFileCheck.code === 0 && fs.readFileSync(path.join(BUGS, 'INDEX.md'), 'utf8').includes('| BUG-904 |'),
    afterFileCheck.out.trim().split('\n').pop());

  console.log('\n=== two tabs: the dashboard in one, a live session view in the other ===');
  const t2 = await (await fetch(`http://127.0.0.1:${devPort}/json/new?${encodeURIComponent(`${BASE}/#/tickets/all?project=${pid}`)}`, { method: 'PUT' })).json();
  const cdp2 = await Cdp.connect(t2.webSocketDebuggerUrl);
  await cdp2.send('Runtime.enable');
  const tab2Up = await cdp2.waitFor('tab 2 dashboard', `document.querySelectorAll('#tvList a.tv-row').length >= 5`, 30_000);
  // Meanwhile tab 1 goes back to the session view and must be fully alive.
  await cdp.eval(`(() => { location.hash = ${JSON.stringify(`#/project/${pid}`)}; })()`);
  await cdp.waitFor('tab 1 back on the session view', `document.querySelector('#ticketsView').hidden === true`, 15_000);
  // The rail polls on its own clock (BUG-016); force one cycle rather than
  // sleeping out RAIL_POLL_MS in a headless tab whose timers are throttled.
  await cdp.eval(`window.__station.refreshRail(true)`);
  await cdp.waitFor('the rail repainted with the reopened 👤 ticket',
    `document.querySelectorAll('#railNeeds .needs-card').length >= 2`, 15_000);
  const tab1 = await cdp.eval(`(() => ({
    ticketsHidden: document.querySelector('#ticketsView').hidden,
    winVisible: getComputedStyle(document.querySelector('#win')).visibility !== 'hidden',
    composerPresent: !!document.querySelector('#prompt'),
    projects: document.querySelectorAll('#tree button.proj').length,
    railCards: document.querySelectorAll('#railNeeds .needs-card').length,
    railTicketLink: document.querySelector(${JSON.stringify(`#railNeeds .needs-card[data-id="${DONE_ID}"] a.nc-send`)})?.getAttribute('href') ?? null,
  }))()`);
  check('(11) a SECOND tab holds #/tickets while the first tab is back on a live, usable session view',
    tab2Up && tab1.ticketsHidden && tab1.winVisible && tab1.composerPresent && tab1.projects >= 1,
    JSON.stringify({ tab2Rows: tab2Up, ...tab1 }));
  check('(9b) the rail\'s "Open ticket" affordance deep-links into the dashboard (opens in a second tab)',
    tab1.railTicketLink === `#/tickets/${DONE_ID}?project=${pid}`, tab1.railTicketLink);
  await cdp2.shot(path.join(SHOTS, 'FEAT-058-second-tab.png'));
  cdp2.close();

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
    for (const d of [DATA, STORE, PROFILE, WORK]) fs.rmSync(d, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }, 2500);
});
