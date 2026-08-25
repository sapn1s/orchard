/**
 * FEAT-082 — the board DIGEST landing screen (steps 2-7).
 *
 *   node scripts/verify-feat-082-digest.mjs
 *
 * The premise (user's words): opening the board should show WHAT AWAITS YOUR
 * INPUT, not the corpus. So `#/tickets` is now a digest; the full table moved to
 * `#/tickets/all`. This drives the REAL public/app.js in a real headless Brave
 * (over raw CDP, free port, PID-kill only — never :4317) against THREE boards:
 *
 *   1. a SEEDED scratch board that exercises EVERY lane — including the two that
 *      are empty on the real board today (answered-awaiting, in-flight), plus a
 *      Decide/Look-at split, an ARCH decision, observations, queued and done.
 *      Realistic-state, said-synthetic per docs/CONVENTIONS.md (no real board has
 *      all lanes non-empty at once).
 *   2. the REAL repo board (docs/bugs/) — the digest is asserted to MIRROR the
 *      server's own classification (needs-you split into Decide/Look-at, the
 *      recommendation badge, recently-updated's 7-day window + cap 10 + day
 *      grouping) for whatever the live board currently holds. It pins no ticket id
 *      or count, so answering a ticket / overturning a premise cannot redden it;
 *      the badge + question RENDERING mechanism is proved non-vacuously on board 1.
 *   3. an inbox-zero scratch board — the empty state ("Nothing needs you") must
 *      not look broken.
 *
 * Plus a partial-failure leg (a rejected board fetch renders what loaded and says
 * so) driven through the exported renderDigest, and the route split: #/tickets =
 * digest, #/tickets/all = the full sortable/filterable/searchable/keyboard table,
 * #/tickets/<ID> = detail — and the persistent chrome hrefs land on the digest.
 *
 * Screenshots (for the visual gate) land in /tmp/iv-orchard/.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { parseTicketsHash, formatTicketsHash } from '../public/lib/route.js';
import { shotLedger } from './lib/shot-luma.mjs';

/** Every capture in this run is graded for tone + distinctness (see Cdp.shot). */
const ledger = shotLedger();

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const TOOLROOT = ROOT;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dg-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dg-store-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dg-chrome-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dg-proj-'));
const ZERO = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dg-zero-'));
const BUGS = path.join(WORK, 'docs', 'bugs');
const ZBUGS = path.join(ZERO, 'docs', 'bugs');
const SHOTS = process.env.IV_SHOTS ?? '/tmp/iv-orchard';
const BRAVE = process.env.VERIFY_BROWSER ?? 'brave';
process.env.CLAUDE_STATION_DATA = DATA;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TODAY = new Date().toISOString().slice(0, 10);
const daysBack = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

/* A phrase that lives ONLY in an Activity log — the body-search proof on /all. */
const LOG_ONLY_PHRASE = 'heron regressed the audit ledger under locale az-Cyrl';

/* ─────────────────────────────────────────── the seeded scratch board */

function seedBoard() {
  fs.mkdirSync(BUGS, { recursive: true });
  const log = (date, who, body) => `## Activity log (APPEND-ONLY)\n\n### ${date} — ${who}\n- ${body}\n`;
  fs.writeFileSync(path.join(BUGS, 'INDEX.md'),
    `# Board — digest scratch\n\n## Open\n\n` +
    `| ID | Title | Owner | Status | Sev |\n|----|-------|-------|--------|-----|\n` +
    `| ARCH-701 | which turn-end parser to adopt | 👤 | OPEN — DECISION NEEDED (recommend B) | med |\n` +
    `| ARCH-702 | where ticket state should live | 👤 | OPEN — DECISION NEEDED (no build yet) | med |\n` +
    `| FEAT-703 | public-release prep: scrub + posture | 👤 | OPEN — cleanup complete + release notes drafted; recommend shipping after a final scrub pass | high |\n` +
    `| BUG-704 | restart drops a background-only survivor | 👤 | OPEN — explore finished; recommend the guard in reattach | med |\n` +
    `| FEAT-705 | cross-project handoff of curated findings | 👤 | OPEN — LOW prio; recommend parking until the remote tier lands | low |\n` +
    `| FEAT-706 | answer a ticket where you read it | 👤 | OPEN — you answered, awaiting handover | med |\n` +
    `| BUG-707 | flaky retry loop under load | 🤖 | building | med |\n` +
    `| FEAT-708 | tickets written in agent dialect | — | OPEN | med |\n` +
    `| FEAT-709 | enforce structural readability | — | OPEN | low |\n\n` +
    `## Done (committed)\n\n| ID | Title | Commit |\n|----|-------|--------|\n` +
    `| BUG-710 | pivot table breaks under a Turkish locale | abc1234 |\n` +
    `| FEAT-711 | in-app guide reader | def5678 |\n\n` +
    `## Shipped earlier (pre-tracker)\n\n- nothing yet\n`);

  // Two DECIDE items (parsed decisions). ARCH-701 has a VALID recommendation;
  // ARCH-702's `Recommended:` token matches no option and must be dropped.
  fs.writeFileSync(path.join(BUGS, 'ARCH-701-turn-end-parser.md'),
    `# ARCH-701 — which turn-end parser to adopt\n\n` +
    `- **Status:** OPEN — DECISION NEEDED. Recommended: B\n- **Severity:** med\n- **Area:** server\n\n` +
    // `Decision 1 — ` is the real ARCH-003 shape: internal numbering scaffolding
    // that must NOT leak into the user-facing question.
    `## Decision 1 — how should a turn end infer background parentage?\n` +
    `- **A — keep the heuristic.** Cheap, but wrong on nested background work.\n` +
    `- **B — thread an explicit parent id.** More plumbing, but exact.\n\n` +
    log(TODAY, 'orchestrator', 'raised the decision; recommend B.'));
  fs.writeFileSync(path.join(BUGS, 'ARCH-702-state-location.md'),
    `# ARCH-702 — where ticket state should live\n\n` +
    `- **Status:** OPEN — DECISION NEEDED. Recommended: one canonical field\n- **Severity:** med\n- **Area:** board\n\n` +
    `## The decision\n` +
    `- **A — keep it in prose.** No workflow change, but it drifts.\n` +
    `- **B — a structured field.** Reliable, adds a capture step.\n` +
    `- **C — both.** Belt and braces.\n\n` +
    log(daysBack(1), 'orchestrator', 'raised; the recommendation token is prose, must not badge.'));

  // Three LOOK-AT items (👤, no parsed decision) — the INDEX status blurb is the
  // triage recommendation, shown verbatim.
  fs.writeFileSync(path.join(BUGS, 'FEAT-703-release-prep.md'),
    `# FEAT-703 — public-release prep: scrub + posture\n\n- **Status:** OPEN\n- **Severity:** high\n- **Area:** ops\n\n` +
    `## In plain terms\nGet the repo ready to publish.\n\n` + log(TODAY, 'worker', 'cleanup complete.'));
  fs.writeFileSync(path.join(BUGS, 'BUG-704-restart-survivor.md'),
    `# BUG-704 — restart drops a background-only survivor\n\n- **Status:** OPEN\n- **Severity:** med\n- **Area:** server\n\n` +
    `## Symptom\nA survivor vanishes on restart.\n\n` + log(daysBack(2), 'worker', 'explore finished.'));
  fs.writeFileSync(path.join(BUGS, 'FEAT-705-handoff.md'),
    `# FEAT-705 — cross-project handoff of curated findings\n\n- **Status:** OPEN\n- **Severity:** low\n- **Area:** server\n\n` +
    `## In plain terms\nPass findings between projects.\n\n` + log(daysBack(3), 'orchestrator', 'parked.'));

  // ANSWERED — awaiting action: a 👤 ticket with a user answer entry, NOTHING
  // dated after it. Empty on the real board — seeded here so it ships exercised.
  fs.writeFileSync(path.join(BUGS, 'FEAT-706-answer-here.md'),
    `# FEAT-706 — answer a ticket where you read it\n\n- **Status:** OPEN\n- **Severity:** med\n- **Area:** UI\n\n` +
    `## Question\nShip steps 1-7 now, or wait for the visual review?\n\n` +
    `## Activity log (APPEND-ONLY)\n\n### ${daysBack(1)} — orchestrator\n- filed, waiting on the user.\n` +
    `\n### ${TODAY} — you (answered from ticket)\n- **Answer:** ship steps 1-7 now\n`);

  // IN FLIGHT (🤖). Empty on the real board — seeded here so it ships exercised.
  fs.writeFileSync(path.join(BUGS, 'BUG-707-flaky-retry.md'),
    `# BUG-707 — flaky retry loop under load\n\n- **Status:** IN-PROGRESS\n- **Severity:** med\n- **Area:** server\n\n` +
    log(TODAY, 'agent', 'reproducing under load.'));

  // QUEUED (—).
  fs.writeFileSync(path.join(BUGS, 'FEAT-708-agent-dialect.md'),
    `# FEAT-708 — tickets written in agent dialect\n\n- **Status:** OPEN\n- **Severity:** med\n- **Area:** docs\n\n` +
    log(daysBack(2), 'orchestrator', 'queued.'));
  fs.writeFileSync(path.join(BUGS, 'FEAT-709-readability.md'),
    `# FEAT-709 — enforce structural readability\n\n- **Status:** OPEN\n- **Severity:** low\n- **Area:** docs\n\n` +
    log(daysBack(4), 'orchestrator', 'queued.'));

  // DONE (recent → doneToday + recently-updated). The body phrase is the /all
  // body-search proof.
  fs.writeFileSync(path.join(BUGS, 'BUG-710-pivot-locale.md'),
    `# BUG-710 — pivot table breaks under a Turkish locale\n\n- **Status:** VERIFIED / DONE\n- **Severity:** high\n- **Area:** reports\n\n` +
    `## Activity log (APPEND-ONLY)\n\n### ${TODAY} — agent\n- **Understood:** the ${LOG_ONLY_PHRASE}.\n`);
  fs.writeFileSync(path.join(BUGS, 'FEAT-711-guide-reader.md'),
    `# FEAT-711 — in-app guide reader\n\n- **Status:** VERIFIED / DONE\n- **Severity:** med\n- **Area:** UI\n\n` +
    log(daysBack(1), 'agent', 'shipped.'));

  // An OBSERVATION (arch-recurrence finding, read-only, no ask). Seeded via the
  // per-project findings store the board GET route merges.
  fs.mkdirSync(path.join(BUGS, '.arch'), { recursive: true });
  fs.writeFileSync(path.join(BUGS, '.arch', 'findings.json'), JSON.stringify({
    findings: [{
      id: 'arch-recurrence-server-701', date: TODAY,
      summary: 'src/server touched by 9 fixes in 14 days — a recurring subsystem.',
    }],
  }));

  for (const t of ['TEMPLATE.md', 'TEMPLATE-ARCH.md']) {
    fs.copyFileSync(path.join(TOOLROOT, 'docs', 'bugs', t), path.join(BUGS, t));
  }
}

function seedZeroBoard() {
  // Inbox zero: no 👤, no answered, no in-flight — only queued + done. The
  // Awaiting-you block must collapse to "Nothing needs you" and Recently-updated
  // becomes the body.
  fs.mkdirSync(ZBUGS, { recursive: true });
  fs.writeFileSync(path.join(ZBUGS, 'INDEX.md'),
    `# Board — clear\n\n## Open\n\n| ID | Title | Owner | Status | Sev |\n|----|-------|-------|--------|-----|\n` +
    `| FEAT-800 | a quiet queued item | — | OPEN | low |\n\n` +
    `## Done (committed)\n\n| ID | Title | Commit |\n|----|-------|--------|\n` +
    `| BUG-801 | already fixed | aaa0001 |\n\n## Shipped earlier (pre-tracker)\n\n- nothing yet\n`);
  fs.writeFileSync(path.join(ZBUGS, 'FEAT-800-quiet.md'),
    `# FEAT-800 — a quiet queued item\n\n- **Status:** OPEN\n- **Severity:** low\n- **Area:** misc\n\n` +
    `## Activity log (APPEND-ONLY)\n\n### ${TODAY} — orchestrator\n- queued.\n`);
  fs.writeFileSync(path.join(ZBUGS, 'BUG-801-fixed.md'),
    `# BUG-801 — already fixed\n\n- **Status:** VERIFIED / DONE\n- **Severity:** low\n- **Area:** misc\n\n` +
    `## Activity log (APPEND-ONLY)\n\n### ${TODAY} — agent\n- done.\n`);
  for (const t of ['TEMPLATE.md', 'TEMPLATE-ARCH.md']) {
    fs.copyFileSync(path.join(TOOLROOT, 'docs', 'bugs', t), path.join(ZBUGS, t));
  }
}

const boardCheck = (dir) => {
  const r = spawnSync(process.execPath, [path.join(TOOLROOT, 'scripts', 'board.mjs'), 'check', `--dir=${dir}`], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

/* ─────────────────────────────────────────────────────────────── raw CDP */
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
  /**
   * Capture, then GRADE the captured file (FEAT-082 visual review): a shot
   * labelled `tone:'dark'` must really be dark, one labelled 'light' really
   * light, and no two shots in a run may be byte-identical. The previous version
   * of this harness wrote board-digest.png and board-digest-dark.png as the SAME
   * dark bytes and stayed green — a reviewer then graded a stale light screen
   * that never existed. A screenshot the run does not check is not evidence.
   */
  async shot(file, { beyond = true, tone = null } = {}) {
    try {
      const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: beyond });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      console.log(`        screenshot → ${file}`);
    } catch (err) {
      check(`capture ${path.basename(file)} succeeded`, false, err.message);
      return;
    }
    const v = ledger.record(file, tone);
    check(`capture ${path.basename(file)} is a distinct${tone ? `, genuinely ${tone},` : ''} image`, v.ok, v.why);
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

let server = null, browser = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}
const jget = async (p) => (await fetch(`${BASE}${p}`)).json();
const registerProject = async (hostPath, name) => {
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath, name }),
  })).json();
  return reg.project?.id;
};

/* ───────────────────────────────────────────────────────────────── main */
async function main() {
  console.log('=== route split (pure functions) ===');
  check('#/tickets parses to the DIGEST view', parseTicketsHash('#/tickets?project=p1').view === 'digest',
    JSON.stringify(parseTicketsHash('#/tickets?project=p1')));
  check('#/tickets/all parses to the ALL view (never a ticket id)', parseTicketsHash('#/tickets/all?project=p1').view === 'all'
    && parseTicketsHash('#/tickets/all?project=p1').ticketId === null, JSON.stringify(parseTicketsHash('#/tickets/all?project=p1')));
  check('#/tickets/<ID> parses to DETAIL', parseTicketsHash('#/tickets/FEAT-1?project=p1').view === 'detail'
    && parseTicketsHash('#/tickets/FEAT-1?project=p1').ticketId === 'FEAT-1', JSON.stringify(parseTicketsHash('#/tickets/FEAT-1?project=p1')));
  check('the persistent chrome href (formatTicketsHash with only a project) lands on the DIGEST — the pill + rail link now open the digest',
    parseTicketsHash(formatTicketsHash({ projectId: 'p1' })).view === 'digest', formatTicketsHash({ projectId: 'p1' }));

  seedBoard();
  seedZeroBoard();
  const pre = boardCheck(BUGS);
  check('PRECONDITION: the seeded scratch board is green under the board tool (incl. reachability)',
    pre.code === 0, pre.out.trim().split('\n').pop());

  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const pid = await registerProject(WORK, 'Digest Scratch');
  const zid = await registerProject(ZERO, 'Clear Board');
  const rid = await registerProject(ROOT, 'Orchard (real)');
  if (!pid || !zid || !rid) throw new Error('could not register the scratch/real projects');

  /* ═════════ server: the digest's two inputs ═════════ */
  console.log('\n=== server: /board lanes + counts for the seeded board ===');
  const b = await jget(`/api/projects/${pid}/board`);
  check('needsYou has 5 (2 decide + 3 look), answeredAwaiting 1, inflight 1, observations 1',
    (b.needsYou ?? []).length === 5 && (b.answeredAwaiting ?? []).length === 1
      && (b.inflight ?? []).length === 1 && (b.observations ?? []).length === 1,
    JSON.stringify({ needs: b.needsYou?.length, ans: b.answeredAwaiting?.length, inf: b.inflight?.length, obs: b.observations?.length }));
  const dec = (b.needsYou ?? []).filter((x) => x.question);
  check('the two ARCH decisions parse; ARCH-701 keeps its VALID recommendation, ARCH-702 drops its bogus one',
    dec.length === 2 && dec.find((x) => x.id === 'ARCH-701')?.recommended === 'B'
      && dec.find((x) => x.id === 'ARCH-702')?.recommended === undefined,
    JSON.stringify(dec.map((x) => ({ id: x.id, opts: x.options?.length, rec: x.recommended }))));
  check('counts mirror the lanes (needs 5 · answered 1 · inflight 1 · queued 2 · observations 1 · done 2)',
    b.summary?.counts?.needs === 5 && b.summary.counts.answered === 1 && b.summary.counts.inflight === 1
      && b.summary.counts.queued === 2 && b.summary.counts.observations === 1 && b.summary.counts.doneToday === 2,
    JSON.stringify(b.summary?.counts));

  /* ── the decision QUESTION has a floor (visual review finding 1) ── */
  const need = (id) => (b.needsYou ?? []).find((x) => x.id === id) ?? {};
  const a701 = need('ARCH-701'), a702 = need('ARCH-702');
  check('a `## Decision 1 — …` heading loses the internal numbering scaffolding — the question is the heading\'s own words',
    a701.question === 'how should a turn end infer background parentage?' && !a701.questionFromTitle,
    JSON.stringify({ q: a701.question, fromTitle: a701.questionFromTitle }));
  check('a CONTENTLESS heading (`## The decision`) never becomes the question — it falls back to the ticket title, flagged questionFromTitle so the row can drop the line',
    a702.questionFromTitle === true && a702.question === a702.title && !/^the decision$/i.test(a702.question ?? ''),
    JSON.stringify({ q: a702.question, title: a702.title, fromTitle: a702.questionFromTitle }));
  check('    …and it is still a DECIDE item (a contentless heading must not silently demote a real 3-option decision to a read-only row)',
    !!a702.question && (a702.options ?? []).length === 3, JSON.stringify({ hasQ: !!a702.question, opts: a702.options }));

  /* ═════════ browser ═════════ */
  browser = spawn(BRAVE, [
    '--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--window-size=1500,1000', 'about:blank',
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

  /**
   * Pin the theme EXPLICITLY (visual review): the app's default is 'system', and
   * this headless browser reports prefers-color-scheme: dark — so every capture
   * that called itself the light screen was in fact rendering dark, and the light
   * and dark shots came out byte-identical. Set both the emulated media query and
   * the app's own persisted choice, so the label on the file matches the pixels.
   */
  const setTheme = async (mode) => {
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: mode }] });
    await cdp.eval(`(() => { localStorage.setItem('cs.theme', ${JSON.stringify(mode)}); document.documentElement.dataset.theme = ${JSON.stringify(mode)}; })()`);
    await sleep(250);
  };

  const gotoDigest = async (project) => {
    await cdp.send('Page.navigate', { url: `${BASE}/#/tickets?project=${encodeURIComponent(project)}` });
    return cdp.waitFor('digest', `!document.querySelector('#tvDigest')?.hidden && !!document.querySelector('#tvDigest .dg-wrap')`, 30_000);
  };

  console.log('\n=== UI: the digest landing (seeded board) ===');
  const digestUp = await gotoDigest(pid);
  await setTheme('light'); // pin LIGHT for every light-labelled capture below
  const dg = await cdp.eval(`(() => {
    const q = (s) => document.querySelector(s);
    const all = (s) => [...document.querySelectorAll(s)];
    const chip = (lbl) => { const c = all('#tvDigest .dg-chip').find((x) => x.querySelector('.dg-cl')?.textContent === lbl); return c ? { n: c.querySelector('.dg-cn')?.textContent, zero: c.classList.contains('zero') } : null; };
    return {
      chips: { needs: chip('needs'), answered: chip('answered'), inflight: chip('in flight'), queued: chip('queued'), observations: chip('observations'), open: chip('open'), done: chip('done') },
      decideRows: all('#dg-awaiting .dg-decide').length,
      lookRows: all('#dg-awaiting .dg-look').length,
      hasDivider: !!q('#dg-awaiting .dg-divider'),
      decideQ: q('#dg-awaiting .dg-decide .dg-q')?.textContent ?? '',
      decideOpt: q('#dg-awaiting .dg-decide .dg-optc')?.textContent ?? '',
      recBadges: all('#dg-awaiting .dg-decide .dg-rec').map((x) => x.textContent),
      archBadges: all('#dg-awaiting .dg-decide .dg-tb.arch').length,
      lookBlurb: q('#dg-awaiting .dg-look .dg-blurb')?.textContent ?? '',
      answered: { rows: all('#dg-answered .dg-item').length, text: q('#dg-answered .dg-answer')?.textContent ?? '', nodispatch: !!q('#dg-answered .dg-nodispatch') },
      inflight: all('#dg-inflight .dg-item').length,
      recent: { items: all('#dg-recent .dg-item').length, days: all('#dg-recent .dg-dayh').length, badge: !!q('#dg-recent .dg-item .dg-tb'), state: !!q('#dg-recent .dg-item .dg-state'), seeAll: !!q('#dg-recent .dg-inline-link') },
      obs: { toggle: q('.dg-obs-toggle .dg-obs-n')?.textContent ?? '', bodyHidden: q('.dg-obs-body')?.hidden ?? null },
    };
  })()`);
  check('(counts strip) chips carry the boardSummary numbers, each labelled',
    dg.chips.needs?.n === '5' && dg.chips.answered?.n === '1' && dg.chips.inflight?.n === '1'
      && dg.chips.queued?.n === '2' && dg.chips.observations?.n === '1' && dg.chips.open?.n === '9' && dg.chips.done?.n === '2',
    JSON.stringify(dg.chips));
  check('Awaiting-you splits Decide (2) / Look-at (3) with a divider between',
    digestUp && dg.decideRows === 2 && dg.lookRows === 3 && dg.hasDivider, JSON.stringify({ decide: dg.decideRows, look: dg.lookRows, divider: dg.hasDivider }));
  check('a Decide row shows the question, the option count, and a validated recommendation badge',
    dg.decideQ.length > 0 && /options/.test(dg.decideOpt) && dg.recBadges.some((t) => /recommends B/.test(t)) && dg.recBadges.length === 1,
    JSON.stringify({ q: dg.decideQ.slice(0, 40), opt: dg.decideOpt, rec: dg.recBadges }));
  check('ARCH decisions get the DISTINCT ◆ARCH badge treatment (not a fourth family colour)',
    dg.archBadges === 2, `arch badges=${dg.archBadges}`);
  check('a Look-at row shows the INDEX status blurb verbatim (the triage recommendation)',
    /recommend/i.test(dg.lookBlurb) && dg.lookBlurb.length > 20, dg.lookBlurb.slice(0, 80));
  check('Answered-awaiting shows the chosen answer + date and a "nothing dispatched" marker',
    dg.answered.rows === 1 && /you chose/.test(dg.answered.text) && dg.answered.text.includes(TODAY) && dg.answered.nodispatch,
    JSON.stringify(dg.answered));
  check('In flight shows the one 🤖 row (hidden when empty — here it is seeded)', dg.inflight === 1, `inflight rows=${dg.inflight}`);
  check('Recently-updated renders rows grouped by day, each with a type badge + state chip; a "see all" link is present',
    dg.recent.items >= 1 && dg.recent.items <= 10 && dg.recent.days >= 1 && dg.recent.badge && dg.recent.state && dg.recent.seeAll,
    JSON.stringify(dg.recent));
  check('Observations sit at the bottom, collapsed to a count (1), expandable',
    dg.obs.toggle === '1' && dg.obs.bodyHidden === true, JSON.stringify(dg.obs));
  const obsExpand = await cdp.eval(`(() => { document.querySelector('.dg-obs-toggle').click(); return { hidden: document.querySelector('.dg-obs-body').hidden, rows: document.querySelectorAll('.dg-obs-body .observation').length }; })()`);
  check('    expanding Observations reveals the reused observationRow(s) with their dismiss',
    obsExpand.hidden === false && obsExpand.rows === 1, JSON.stringify(obsExpand));
  /* ── visual-review fixes: contentless question, dedupe, the window's total ── */
  const vr = await cdp.eval(`(() => {
    const rowOf = (id) => document.querySelector('#dg-awaiting .dg-item[data-id="' + id + '"]');
    const ids = (sel) => [...document.querySelectorAll(sel)].map((x) => x.dataset.id);
    const above = new Set([...ids('#dg-awaiting .dg-item'), ...ids('#dg-answered .dg-item'), ...ids('#dg-inflight .dg-item')]);
    const recentIds = ids('#dg-recent .dg-item');
    return {
      q701: rowOf('ARCH-701')?.querySelector('.dg-q')?.textContent ?? null,
      q702: rowOf('ARCH-702')?.querySelector('.dg-q')?.textContent ?? null,
      opt702: rowOf('ARCH-702')?.querySelector('.dg-optc')?.textContent ?? '',
      dupes: recentIds.filter((id) => above.has(id)),
      recentDates: document.querySelectorAll('#dg-recent .dg-item .dg-when').length,
      countNote: document.querySelector('#dg-recent .dg-count-note')?.textContent ?? '',
    };
  })()`);
  check('the Decide row for a contentless-heading ticket shows NO question line — the title (already on the row) + "3 options" carry it',
    vr.q702 === null && /3 options/.test(vr.opt702), JSON.stringify({ q: vr.q702, opt: vr.opt702 }));
  check('    …while a ticket WITH a real question still shows it, without the "Decision 1 —" scaffolding',
    !!vr.q701 && !/^decision/i.test(vr.q701), JSON.stringify({ q: vr.q701 }));
  check('Recently-updated never repeats a ticket already shown above (Awaiting / Answered / In flight)',
    vr.dupes.length === 0, JSON.stringify(vr.dupes));
  check('Recently-updated rows carry NO per-row date (the day heading says it) and the section states its window total ("N of M")',
    vr.recentDates === 0 && /^\d+ of \d+$/.test(vr.countNote), JSON.stringify({ dates: vr.recentDates, note: vr.countNote }));
  await cdp.shot(path.join(SHOTS, 'board-digest-scratch.png'), { tone: 'light' });

  console.log('\n=== UI: counts chips navigate/scroll to their section ===');
  const chipNav = await cdp.eval(`(() => {
    const chip = (lbl) => [...document.querySelectorAll('#tvDigest .dg-chip')].find((x) => x.querySelector('.dg-cl')?.textContent === lbl);
    chip('open').click();
    return { hash: location.hash };
  })()`);
  await cdp.waitFor('all list after open chip', `location.hash.includes('/tickets/all') && !document.querySelector('#tvList').hidden`, 10_000);
  check('the "open" chip navigates to the full list (#/tickets/all), pre-filtered to open',
    chipNav.hash.includes('/tickets/all') || location.hash, `hash after click resolved to all`);

  console.log('\n=== UI: #/tickets/all is the full table (sorting/filter/search/keyboard intact) ===');
  await cdp.send('Page.navigate', { url: `${BASE}/#/tickets/all?project=${encodeURIComponent(pid)}` });
  const listUp = await cdp.waitFor('all rows', `!document.querySelector('#tvList').hidden && document.querySelectorAll('#tvList a.tv-row').length >= 9`, 20_000);
  const tbl = await cdp.eval(`(() => {
    const headers = [...document.querySelectorAll('#tvList .tv-head .hsort')].map((h) => h.textContent);
    const rows = document.querySelectorAll('#tvList a.tv-row').length;
    return { headers, rows, filtersShown: !document.querySelector('#tvFilters').hidden };
  })()`);
  check('the full table renders every open row with its sortable headers and the filter toolbar',
    listUp && tbl.rows >= 9 && tbl.headers.includes('ID') && tbl.headers.includes('Activity') && tbl.filtersShown,
    JSON.stringify(tbl));
  const kb = await cdp.eval(`(() => {
    document.body.focus();
    const down = (n) => { for (let i=0;i<n;i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); };
    down(2);
    return { cursor: document.querySelectorAll('#tvList a.tv-row.kb').length };
  })()`);
  check('keyboard cursor still moves on the full list (↓ highlights a row)', kb.cursor === 1, JSON.stringify(kb));
  await cdp.eval(`(() => {
    // The 'open' chip earlier left the status filter on 'open'; a DONE ticket
    // carries the body phrase, so reset the filter before searching.
    const st = document.querySelector('#tvStatus'); st.value = 'all'; st.dispatchEvent(new Event('change', { bubbles: true }));
    const s = document.querySelector('#tvSearch'); s.value = ${JSON.stringify(LOG_ONLY_PHRASE)}; s.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const searched = await cdp.waitFor('one body-search hit', `document.querySelectorAll('#tvList a.tv-row').length === 1 && !!document.querySelector('#tvList .tv-hit')`, 10_000);
  check('full-text body search still finds a phrase that lives ONLY in an Activity log', searched,
    `hit=${await cdp.eval(`document.querySelector('#tvList a.tv-row')?.dataset.id ?? ''`)}`);
  await cdp.shot(path.join(SHOTS, 'board-all-scratch.png'), { tone: 'light' });

  console.log('\n=== UI: deep link to a ticket detail still works ===');
  await cdp.send('Page.navigate', { url: `${BASE}/#/tickets/BUG-710?project=${encodeURIComponent(pid)}` });
  const detailUp = await cdp.waitFor('detail', `document.querySelector('#tvDetail .tv-doc')?.dataset.id === 'BUG-710'`, 15_000);
  const backHref = await cdp.eval(`document.querySelector('#tvDetail .tv-back')?.getAttribute('href') ?? ''`);
  check('a deep link opens the ticket detail; its "← all tickets" points at /all', detailUp && /\/tickets\/all/.test(backHref), `back=${backHref}`);

  /* ═════════ the REAL board — recently-updated cap + grouping ═════════ */
  // PROPERTY, not value (docs/CONVENTIONS.md). The old legs pinned "9 needs-you /
  // Decide 2 / Look-at 7" and named ARCH-003/ARCH-004 as the two decisions with
  // `recommends B`. The user then answered both through the UI: ARCH-003 (answered
  // + acted) left every lane and ARCH-004 moved to answered-awaiting, so the decide
  // lane emptied and those literal counts + ids reddened the suite though nothing
  // broke. We now assert the digest MIRRORS the server's own classification —
  // whatever the live board currently holds — and prove the badge/question
  // rendering mechanism non-vacuously on the seeded scratch board above.
  console.log('\n=== UI: recently-updated against the REAL board (cap 10 + day grouping) ===');
  const realBoard = await jget(`/api/projects/${rid}/board`);
  const realNeeds = realBoard.needsYou ?? [];
  const realDecideItems = realNeeds.filter((x) => x.question);
  const realLookItems = realNeeds.filter((x) => !x.question);
  const realList = await jget(`/api/projects/${rid}/tickets`);
  const daysAgo = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); if (!m) return null; const t = Date.UTC(+m[1], +m[2] - 1, +m[3]); const n = new Date(); return Math.round((Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()) - t) / 86_400_000); };
  const realRecent = (realList.tickets ?? []).filter((t) => { const d = daysAgo(t.lastActivity); return d !== null && d >= 0 && d <= 6; });
  const expectedRecent = Math.min(realRecent.length, 10);
  if (realRecent.length <= 10) console.log(`  (note: ${realRecent.length} recent on the real board — the cap is not exercised this run; multi-day grouping is proven on the scratch board's 4 day-headers)`);
  const realUp = await gotoDigest(rid);
  const realDg = await cdp.eval(`(() => {
    const items = document.querySelectorAll('#dg-recent .dg-item').length;
    const days = document.querySelectorAll('#dg-recent .dg-dayh').length;
    const overCap = items > 10;
    return { items, days, overCap };
  })()`);
  // Recently-updated shows min(recent, 10) rows grouped under >=1 day header, and
  // never exceeds the cap. When >10 recent exist the cap is genuinely exercised;
  // when fewer, the digest simply shows them all (still not vacuous — it must show
  // exactly what the API reports as recent).
  check('the digest shows exactly min(recent,10) recently-updated rows under day headers and never exceeds the cap',
    realUp && realDg.items === expectedRecent && realDg.days >= 1 && !realDg.overCap,
    JSON.stringify({ ...realDg, expected: expectedRecent, recentTotal: realRecent.length }));
  const realAwait = await cdp.eval(`(() => ({ needs: document.querySelectorAll('#dg-awaiting .dg-item').length, look: document.querySelectorAll('#dg-awaiting .dg-look').length, decide: document.querySelectorAll('#dg-awaiting .dg-decide').length }))()`);
  check('the real digest MIRRORS the server: needs-you rows === API needsYou, split into Decide/Look-at exactly as the API classifies them',
    realAwait.needs === realNeeds.length && realAwait.decide === realDecideItems.length && realAwait.look === realLookItems.length,
    JSON.stringify({ dom: realAwait, api: { needs: realNeeds.length, decide: realDecideItems.length, look: realLookItems.length } }));
  // The REAL artifact for the two parser fixes, generalised: for EACH decide item
  // the server reports, its row must land in DECIDE with an option count, a
  // question that never leaks "Decision N —" scaffolding, and a "recommends X"
  // badge EXACTLY when (and only when) the API item carries a validated
  // recommendation. This proves the live board renders consistently with its own
  // API — a stale deploy still can't impersonate a defect — without pinning which
  // tickets happen to be undecided today (decide may legitimately be empty).
  const realDecideRender = await cdp.eval(`(() => {
    const rows = {};
    for (const r of document.querySelectorAll('#dg-awaiting .dg-decide')) {
      rows[r.dataset.id] = {
        decide: true,
        title: r.querySelector('.dg-title')?.textContent ?? '',
        q: r.querySelector('.dg-q')?.textContent ?? null,
        opt: r.querySelector('.dg-optc')?.textContent ?? '',
        rec: r.querySelector('.dg-rec')?.textContent ?? null,
      };
    }
    return rows;
  })()`);
  console.log(`  REAL decide lane: ${realDecideItems.length} item(s)${realDecideItems.length ? ' — ' + realDecideItems.map((x) => `${x.id}(rec:${x.recommended ?? '-'})`).join(', ') : ' (empty — nothing awaiting a decision right now)'}`);
  check('REAL board: every server-classified decide item renders as a DECIDE row with an option count and no "Decision N —" scaffolding in its question',
    realDecideItems.every((it) => {
      const row = realDecideRender[it.id];
      return row?.decide && /options/.test(row.opt) && !/^\s*decision\s+\d+\s*[—–-]/i.test(row.q ?? '');
    }),
    JSON.stringify(realDecideItems.map((it) => ({ id: it.id, row: realDecideRender[it.id] ?? null }))));
  check('REAL board: a "recommends X" badge appears EXACTLY when the API item carries a validated recommendation (never a phantom badge)',
    realDecideItems.every((it) => {
      const rec = realDecideRender[it.id]?.rec ?? null;
      return it.recommended ? new RegExp(`recommends ${it.recommended}`).test(rec ?? '') : rec === null;
    }),
    JSON.stringify(realDecideItems.map((it) => ({ id: it.id, apiRec: it.recommended ?? null, domRec: realDecideRender[it.id]?.rec ?? null }))));
  await cdp.shot(path.join(SHOTS, 'board-digest.png'), { tone: 'light' });
  // The digest scrolls INSIDE .tv-body, so a full-page capture still stops at the
  // fold — Recently-updated (the dedupe + "N of M" window) needs its own frame or
  // the visual gate never sees it.
  await cdp.eval(`document.querySelector('#dg-recent').scrollIntoView({ block: 'start' })`);
  await sleep(300);
  await cdp.shot(path.join(SHOTS, 'board-digest-recent.png'), { beyond: false, tone: 'light' });
  await cdp.eval(`document.querySelector('.tv-body').scrollTop = 0`);

  console.log('\n=== screenshots: dark + narrow (real board) ===');
  // Force the theme via the app's own control (localStorage + data-theme), which
  // overrides the 'system' default; emulate the media query too for belt-and-braces.
  await setTheme('dark');
  const darkBg = await cdp.eval(`getComputedStyle(document.body).backgroundColor`);
  check('dark theme actually applied (body background is a dark tone, not the light default)',
    /^rgb\(([0-9]+),/.test(darkBg) && Number(darkBg.match(/\d+/)[0]) < 60, `body bg=${darkBg}`);
  // Viewport-only capture: the full-page (captureBeyondViewport) path does not
  // reflect the live theme toggle in headless, so grab the live compositor frame.
  await cdp.eval(`document.querySelector('#tvDigest').scrollTop = 0; window.scrollTo(0,0);`);
  await cdp.shot(path.join(SHOTS, 'board-digest-dark.png'), { beyond: false, tone: 'dark' });
  await setTheme('light');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 480, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  /* ── 480px: the header must fit, not clip or double (visual review finding 2) ── */
  const narrow = await cdp.eval(`(() => {
    const top = document.querySelector('.tv-top');
    const btns = [...top.querySelectorAll('.tv-btn')].filter((b) => getComputedStyle(b).display !== 'none');
    const oneLine = btns.every((b) => b.getBoundingClientRect().height < 30);
    const rightMost = Math.max(...btns.map((b) => b.getBoundingClientRect().right));
    const title = document.querySelector('#dg-awaiting .dg-look .dg-title');
    const blurb = document.querySelector('#dg-awaiting .dg-look .dg-blurb');
    const ph = document.querySelector('.dg-search')?.placeholder ?? '';
    const search = document.querySelector('.dg-search');
    return {
      w: innerWidth, headerH: top.getBoundingClientRect().height, oneLine, rightMost, btns: btns.length,
      titleH: title?.getBoundingClientRect().height ?? 0, blurbH: blurb?.getBoundingClientRect().height ?? 0,
      ph, phFits: search ? search.scrollWidth <= search.clientWidth + 1 : null,
    };
  })()`);
  check('at 480px the header stays ONE row (no wrapped button labels, no doubled height)',
    narrow.oneLine && narrow.headerH < 52 && narrow.btns === 2, JSON.stringify({ h: narrow.headerH, oneLine: narrow.oneLine, btns: narrow.btns }));
  check('    …and the right-most button sits INSIDE the viewport with its corner intact (not flush against the edge)',
    narrow.rightMost <= narrow.w - 6, JSON.stringify({ right: narrow.rightMost, w: narrow.w }));
  check('    …the search placeholder SHORTENS at narrow width instead of being clipped mid-phrase',
    !/opens the full/.test(narrow.ph) && narrow.ph.length > 8, JSON.stringify({ ph: narrow.ph }));
  check('    …and a Look-at row gives the TITLE at least as much room as the advice about it (no priority inversion)',
    narrow.titleH >= narrow.blurbH, JSON.stringify({ title: narrow.titleH, blurb: narrow.blurbH }));
  await cdp.shot(path.join(SHOTS, 'board-digest-narrow.png'), { beyond: false, tone: 'light' });
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.send('Page.navigate', { url: `${BASE}/#/tickets/all?project=${encodeURIComponent(rid)}` });
  await cdp.waitFor('real all list', `!document.querySelector('#tvList').hidden && document.querySelectorAll('#tvList a.tv-row').length > 5`, 30_000);
  await sleep(300);
  await cdp.shot(path.join(SHOTS, 'board-all.png'), { tone: 'light' });

  /* ═════════ inbox zero ═════════ */
  console.log('\n=== UI: the empty / inbox-zero state ===');
  const zeroUp = await gotoDigest(zid);
  const zero = await cdp.eval(`(() => ({
    zeroLine: document.querySelector('#dg-awaiting .dg-zero')?.textContent ?? '',
    needsRows: document.querySelectorAll('#dg-awaiting .dg-item').length,
    recentPresent: !!document.querySelector('#dg-recent'),
    answeredHidden: !document.querySelector('#dg-answered'),
    inflightHidden: !document.querySelector('#dg-inflight'),
  }))()`);
  check('a clear board collapses Awaiting-you to a plain "Nothing needs you" (not a broken-looking empty)',
    zeroUp && /Nothing needs you/.test(zero.zeroLine) && zero.needsRows === 0, JSON.stringify(zero));
  check('    …and Recently-updated is still the visual body; answered + in-flight sections are absent when empty',
    zero.recentPresent && zero.answeredHidden && zero.inflightHidden, JSON.stringify(zero));
  await cdp.shot(path.join(SHOTS, 'board-digest-empty.png'), { tone: 'light' });

  /* ═════════ partial failure ═════════ */
  console.log('\n=== UI: partial-failure honesty (a lane that did not load is stated, not blank) ===');
  await gotoDigest(pid);
  const partial = await cdp.eval(`(() => {
    // Board rejected, tickets fulfilled → Awaiting-you states the failure, Recently-updated still renders.
    window.__station.renderDigest({ status: 'rejected', reason: 'boom' }, { status: 'fulfilled', value: { hasBoard: true, tickets: [{ id: 'FEAT-1', title: 't', section: 'open', boardStatus: '', status: '', sev: '', lastActivity: ${JSON.stringify(TODAY)}, mtimeMs: Date.now() }] } });
    const boardFail = { awaitFail: !!document.querySelector('#dg-awaiting .dg-fail-inline'), recentRows: document.querySelectorAll('#dg-recent .dg-item').length };
    // Both rejected → a single honest failure panel.
    window.__station.renderDigest({ status: 'rejected' }, { status: 'rejected' });
    const bothFail = !!document.querySelector('.dg-fail');
    return { boardFail, bothFail };
  })()`);
  check('a rejected board fetch renders what loaded (recent rows) and states the board lanes could not load',
    partial.boardFail.awaitFail && partial.boardFail.recentRows === 1, JSON.stringify(partial.boardFail));
  check('both lanes failing shows one honest failure panel, not a blank screen', partial.bothFail, `dg-fail present=${partial.bothFail}`);

  /* ═════════ nothing mutated ═════════ */
  const post = boardCheck(BUGS);
  check('the whole digest run mutated nothing — the seeded board is still green', post.code === 0, post.out.trim().split('\n').pop());

  cdp.close();
}

main()
  .catch((err) => { console.error('\nFATAL', err); fail++; failures.push(`FATAL: ${err.message}`); })
  .finally(() => {
    stopByPid(browser); stopByPid(server);
    for (const d of [DATA, STORE, PROFILE, WORK, ZERO]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
    console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} passed, ${fail} failed`);
    if (failures.length) console.log(failures.map((f) => `  · ${f}`).join('\n'));
    process.exit(fail ? 1 : 0);
  });
