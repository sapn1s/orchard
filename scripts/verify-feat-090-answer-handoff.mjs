/**
 * FEAT-090 (steps 4-7, the routes + briefing + UI half) — answer a ticket where
 * you read it, and have that HAND THE WORK BACK to an agent without dispatching.
 *
 *   node scripts/verify-feat-090-answer-handoff.mjs
 *   node scripts/verify-feat-090-answer-handoff.mjs --no-ui   # skip the brave leg
 *
 * Everything asserts on VALUES and STATE, never printed text.
 *
 * PART A (pure, no server): the ONE composer, the ticket-detail reply parser, the
 *   answered-awaiting briefing (once per session per answer, silent when empty,
 *   seeded from the launch snapshot), and tickets.answerTicket over a REAL seeded
 *   board — a DECISION lands answered-awaiting (owner stays 👤), a QUESTION flips
 *   ownership to the AGENT (owner 🤖, NOT ready-for-work), and a stale rev is a 409.
 * PART B (real server + fake codex, no API cost): an IDLE live session, then a
 *   ticket answered via BOTH the legacy rail route AND the new ticket route —
 *   NOTHING is sent to the live session (no new turn). must-FAIL pre-change: the
 *   deleted auto-send injected a turn.
 * PART C (real brave over CDP, free port, PID-kill only): at a WIDE width the
 *   Decide card is visible beside the status line without scrolling and records an
 *   answer; at a NARROW width the pinned bar is present, the sheet opens and
 *   records. Screenshots to /tmp/iv-orchard/feat090-{wide,narrow}{,-dark}.png.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import {
  readBoard, boardStateSection, composeAnswerEntry, ticketAnswerState,
  boardAnswerBriefing, answeredAwaitingKeys,
} from '../src/server/board.ts';
import { answerTicket, readTicket, TicketError } from '../src/server/tickets.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const FAKE = path.join(ROOT, 'scripts', 'fixtures', 'codex-fake-app-server.mjs');
const TOOLROOT = ROOT;
const ARGS = process.argv.slice(2);
const NO_UI = ARGS.includes('--no-ui');
const BRAVE = process.env.VERIFY_BROWSER ?? 'brave';
const SHOTDIR = '/tmp/iv-orchard';
const TODAY = new Date().toISOString().slice(0, 10);

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─────────────────────────────────────────────────────── a valid seeded board */
const NEEDS_ID = 'FEAT-902';      // 👤, carries a ## Question decision
const ARCH_ID = 'ARCH-902';       // 👤, carries a ## Decision (bold-lead options)
const AGENT_ID = 'BUG-903';       // 🤖
const QUESTION_ID = 'FEAT-905';   // 👤, we will answer this with kind=question

function seedBoard(bugs) {
  fs.mkdirSync(bugs, { recursive: true });
  fs.writeFileSync(path.join(bugs, 'INDEX.md'),
    `# Board — scratch\n\n## Open\n\n` +
    `| ID | Title | Owner | Status | Sev |\n|----|-------|-------|--------|-----|\n` +
    `| ${NEEDS_ID} | export button needs a decision | 👤 | needs decision | high |\n` +
    `| ${ARCH_ID} | turn-end parentage: fix or shield | 👤 | needs decision | high |\n` +
    `| ${QUESTION_ID} | rename the widget | 👤 | needs decision | med |\n` +
    `| ${AGENT_ID} | flaky retry loop under load | 🤖 | building | med |\n\n` +
    `## Done (committed)\n\n| ID | Title | Commit |\n|----|-------|--------|\n\n` +
    `## Shipped earlier (pre-tracker)\n\n- nothing yet\n`);
  fs.writeFileSync(path.join(bugs, `${NEEDS_ID}-export-button.md`),
    `# ${NEEDS_ID} — export button needs a decision\n\n` +
    `- **Status:** OPEN\n- **Severity:** high\n- **Area:** UI\n\n` +
    `## Question\nShould export produce CSV or XLSX?\n- csv\n- xlsx\n\n` +
    `## Activity log (APPEND-ONLY)\n\n### 2026-08-03 — orchestrator\n- filed, waiting on the user.\n`);
  fs.writeFileSync(path.join(bugs, `${ARCH_ID}-parentage.md`),
    `# ${ARCH_ID} — turn-end parentage: fix or shield\n\n` +
    `- **Status:** OPEN — DECISION NEEDED. Recommended: B, with D as the interim shield.\n- **Severity:** high\n- **Area:** server\n\n` +
    `## Decision 1 — fix it properly, or just stop the harm\n` +
    `- **A — fix the root cause.** Rework turn-end so parentage is always known, at real cost.\n` +
    `- **B — decide later instead of on the spot.** Stop deciding under time pressure; revisit deliberately.\n` +
    `- **C — accept the risk.** Do nothing and live with the occasional wrong parentage.\n` +
    `- **D — ship an interim shield.** A cheap guard that prevents the worst case now.\n\n` +
    `## Activity log (APPEND-ONLY)\n\n### 2026-08-03 — orchestrator\n- filed, waiting on the user.\n`);
  fs.writeFileSync(path.join(bugs, `${QUESTION_ID}-rename.md`),
    `# ${QUESTION_ID} — rename the widget\n\n` +
    `- **Status:** OPEN\n- **Severity:** med\n- **Area:** UI\n\n` +
    `## Question\nRename "panel" to "board"?\n- yes\n- no\n\n` +
    `## Activity log (APPEND-ONLY)\n\n### 2026-08-03 — orchestrator\n- filed, waiting on the user.\n`);
  fs.writeFileSync(path.join(bugs, `${AGENT_ID}-flaky-retry.md`),
    `# ${AGENT_ID} — flaky retry loop under load\n\n` +
    `- **Status:** IN-PROGRESS\n- **Severity:** med\n- **Area:** server\n\n` +
    `## Activity log (APPEND-ONLY)\n\n### 2026-08-05 — agent\n- reproducing under load.\n`);
  for (const t of ['TEMPLATE.md', 'TEMPLATE-ARCH.md']) {
    try { fs.copyFileSync(path.join(TOOLROOT, 'docs', 'bugs', t), path.join(bugs, t)); } catch { /* optional */ }
  }
}
const ticketPath = (bugs, id) => {
  const hit = fs.readdirSync(bugs).find((n) => n.startsWith(`${id}-`));
  return hit ? path.join(bugs, hit) : null;
};

/* ═══════════════════════════════════════════════ PART A — pure functions ═════ */
function partA() {
  console.log('\n=== PART A — composer / parser / briefing / answerTicket ===');

  // The ONE composer — decision with a chosen option AND a note (the "B, but ship
  // D first" shape), plus the machine-readable State line.
  const dec = composeAnswerEntry({ kind: 'decision', question: 'fix or shield', chose: { key: 'B', label: 'decide later' }, note: 'but ship D first', via: 'ticket view' });
  check('composer(decision, option+note): heading is a you(answer…) mark, Chose + Note + answered State',
    /### \d{4}-\d\d-\d\d — you \(answer · via ticket view\)/.test(dec)
      && /- \*\*Question:\*\* fix or shield/.test(dec)
      && /- \*\*Chose:\*\* B — decide later/.test(dec)
      && /- \*\*Note:\*\* but ship D first/.test(dec)
      && /- \*\*State:\*\* answered — awaiting agent action \(not dispatched\)/.test(dec),
    dec.trim());
  const free = composeAnswerEntry({ kind: 'decision', note: 'just do the simplest thing', via: 'Needs-You rail' });
  check('composer(free-text only): writes - **Answer:** (no Chose) as today',
    /- \*\*Answer:\*\* just do the simplest thing/.test(free) && !/Chose/.test(free) && /you \(answer · via Needs-You rail\)/.test(free), free.trim());
  const ques = composeAnswerEntry({ kind: 'question', note: 'what about the mobile case?', via: 'ticket view' });
  check('composer(question): a you(question…) mark + an agent-owned State (not an answer)',
    /you \(question · via ticket view\)/.test(ques) && /ownership: agent, not ready for work/.test(ques) && !/awaiting agent action/.test(ques), ques.trim());

  // The ticket-detail parser round-trips the composer's output.
  const md1 = `# X\n## Activity log\n${dec}`;
  const s1 = ticketAnswerState(md1);
  check('ticketAnswerState(decision): kind=decision, chose B, note captured, awaiting=true',
    s1?.kind === 'decision' && s1?.chose?.key === 'B' && s1?.note === 'but ship D first' && s1?.awaiting === true, s1);
  const s2 = ticketAnswerState(`# X\n## Activity log\n${ques}`);
  check('ticketAnswerState(question): kind=question, awaiting=false (not a decision)',
    s2?.kind === 'question' && s2?.awaiting === false, s2);
  const s3 = ticketAnswerState(`# X\n## Activity log\n${dec}\n### ${TODAY} — agent\n- picked it up.\n`);
  check('ticketAnswerState: a dated agent note AFTER the answer → awaiting=false',
    s3?.kind === 'decision' && s3?.awaiting === false, s3);

  /* answerTicket over a real board: decision → answered-awaiting (owner 👤). */
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'f90a-'));
  const bugs = path.join(TMP, 'docs', 'bugs');
  seedBoard(bugs);
  const host = TMP;
  const rev0 = readTicket(host, NEEDS_ID).rev;
  const rDec = answerTicket(host, NEEDS_ID, { kind: 'decision', question: 'CSV or XLSX?', chose: { key: 'csv', label: 'csv' }, note: 'default to csv' }, rev0);
  const bAfter = readBoard(host);
  check('answerTicket(decision): owner stays 👤 and the ticket LANDS in answered-awaiting, LEAVES needsYou',
    rDec.owner === '👤'
      && bAfter.answeredAwaiting.some((x) => x.id === NEEDS_ID)
      && !bAfter.needsYou.some((x) => x.id === NEEDS_ID),
    { owner: rDec.owner, awaiting: bAfter.answeredAwaiting.map((x) => x.id), needs: bAfter.needsYou.map((x) => x.id) });
  check('answerTicket(decision): the reply state is surfaced (chose csv, awaiting)',
    rDec.answer?.chose?.key === 'csv' && rDec.answer?.awaiting === true, rDec.answer);

  /* answerTicket QUESTION → ownership flips to the AGENT, NOT ready-for-work. */
  const revQ = readTicket(host, QUESTION_ID).rev;
  const rQ = answerTicket(host, QUESTION_ID, { kind: 'question', question: 'rename panel to board?', note: 'which other names are on the table?' }, revQ);
  const bQ = readBoard(host);
  check('answerTicket(question): ownership FLIPS to the agent (owner 🤖 → inflight)',
    rQ.owner === '🤖' && bQ.inflight.some((x) => x.id === QUESTION_ID), { owner: rQ.owner, inflight: bQ.inflight.map((x) => x.id) });
  check('answerTicket(question): NOT ready-for-work — never in answeredAwaiting, never back in needsYou',
    !bQ.answeredAwaiting.some((x) => x.id === QUESTION_ID) && !bQ.needsYou.some((x) => x.id === QUESTION_ID),
    { awaiting: bQ.answeredAwaiting.map((x) => x.id), needs: bQ.needsYou.map((x) => x.id) });
  check('answerTicket(question): the INDEX Status blurb says the agent owes a reply',
    /🤖 to answer/.test(readBoard(host).inflight.find((x) => x.id === QUESTION_ID)?.status ?? ''),
    readBoard(host).inflight.find((x) => x.id === QUESTION_ID)?.status);

  /* rev conflict — a stale answer is a 409, file untouched. */
  const before = fs.readFileSync(ticketPath(bugs, ARCH_ID), 'utf8');
  let conflict = null;
  try { answerTicket(host, ARCH_ID, { kind: 'decision', chose: { key: 'B', label: 'decide later' }, note: 'stale' }, '1:1'); }
  catch (e) { conflict = e; }
  check('answerTicket(stale rev): refused 409 (TicketError.status), and the ticket file is UNTOUCHED',
    conflict instanceof TicketError && conflict.status === 409 && fs.readFileSync(ticketPath(bugs, ARCH_ID), 'utf8') === before,
    { status: conflict?.status, untouched: fs.readFileSync(ticketPath(bugs, ARCH_ID), 'utf8') === before });

  /* readTicket surfaces the parsed decision (client must not re-parse markdown). */
  const arch = readTicket(host, ARCH_ID);
  check('readTicket surfaces decision (ARCH-style bold-lead options A-D, recommended B) without re-parsing on the client',
    arch.decision?.options?.length === 4 && arch.decision?.recommended === 'B' && arch.decision.options.map((o) => o.key).join('') === 'ABCD',
    { rec: arch.decision?.recommended, keys: arch.decision?.options?.map((o) => o.key) });

  /* the briefing: once per (id,date), silent when empty, seeded from the snapshot. */
  const seen = new Set();
  const b1 = boardAnswerBriefing(host, seen);
  check('boardAnswerBriefing: announces the answered decision once, as a not-dispatched fact',
    !!b1 && b1.includes(NEEDS_ID) && /do not start work on it silently/i.test(b1), (b1 ?? '').split('\n')[0]);
  check('boardAnswerBriefing: the SAME answer is never announced twice (second call → null)',
    boardAnswerBriefing(host, seen) === null, 'second call null');
  const seedSeen = new Set(answeredAwaitingKeys(host));
  check('answeredAwaitingKeys seeds the seen-set so a fresh session (snapshot already carried it) does NOT re-announce',
    boardAnswerBriefing(host, seedSeen) === null && answeredAwaitingKeys(host).some((k) => k.startsWith(`${NEEDS_ID}@`)),
    answeredAwaitingKeys(host));
  // empty lane → null
  const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'f90b-'));
  seedBoard(path.join(TMP2, 'docs', 'bugs'));
  check('boardAnswerBriefing: silent (null) when the answered lane is empty',
    boardAnswerBriefing(TMP2, new Set()) === null, 'null on empty lane');
  // the snapshot still carries the answered lane (regression guard on step 1-3 seam)
  check('the launch snapshot still carries the answered lane for this board',
    /Answered — awaiting action/.test(boardStateSection(host) ?? ''), 'snapshot has answered section');

  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(TMP2, { recursive: true, force: true });
}

/* ═══════════════════════════════ PART B — no dispatch on a live session ═══════ */
const procs = new Set();
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
function openWs(port) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const events = [];
    ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
    ws.once('open', () => res({ ws, events, send: (o) => ws.send(JSON.stringify(o)) }));
    ws.once('error', rej);
  });
}
async function waitEv(events, pred, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const hit = events.find(pred); if (hit) return hit; await sleep(120); }
  return null;
}
const countTurnEnds = (events) => events.filter((e) => e?.t === 'turn-end').length;

async function partB() {
  console.log('\n=== PART B — answering a ticket sends NOTHING to a live session ===');
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'f90-data-'));
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'f90-store-'));
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'f90-proj-'));
  seedBoard(path.join(WORK, 'docs', 'bugs'));

  const srv = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE, CLAUDE_STATION_CODEX_BIN: FAKE, CLAUDE_STATION_SURVIVE: '0' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  srv.stderr?.on('data', (d) => { if (process.env.CS_VERBOSE) process.stderr.write(`  [srv] ${d}`); });
  procs.add(srv);
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { const r = await fetch(`${BASE}/api/health`); up = r.ok; } catch { await sleep(200); } }
  if (!up) throw new Error('server never healthy');

  const reg = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: WORK, name: 'F90' }) })).json();
  const pid = reg.project.id;

  // An IDLE live session: first turn completes (fake codex, no marker), then it sits.
  const c = await openWs(PORT);
  c.send({ type: 'start', projectId: pid, overrides: { provider: 'openai', model: null, permissionMode: 'bypassPermissions' }, prompt: 'turn one — simple, no agents' });
  const ack = await waitEv(c.events, (e) => e.t === 'ack' && e.of === 'start', 20000);
  const end1 = await waitEv(c.events, (e) => e.t === 'turn-end', 25000);
  check('PRECONDITION: a live session is open and its first turn completed (now idle)',
    !!ack?.stationSessionId && !!end1, { started: !!ack?.stationSessionId, turnEnded: !!end1 });
  const turnsBefore = countTurnEnds(c.events);

  // Legacy rail route — the deleted auto-send WOULD have injected a turn here.
  const railAns = await (await fetch(`${BASE}/api/projects/${pid}/board/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: NEEDS_ID, answer: 'go with csv' }),
  })).json();
  await sleep(1500);
  check('legacy /board/answer records the answer and DISPATCHES nothing (no delivered flag)',
    railAns.ok === true && railAns.dispatched === false && railAns.delivered === undefined, railAns);
  check('MUST-FAIL PROOF: answering did NOT start a turn on the idle live session (turn count unchanged)',
    countTurnEnds(c.events) === turnsBefore, { before: turnsBefore, after: countTurnEnds(c.events) });

  // New ticket route — a decision. Also must not dispatch.
  const detail = await (await fetch(`${BASE}/api/projects/${pid}/tickets/${ARCH_ID}`)).json();
  const ans = await (await fetch(`${BASE}/api/projects/${pid}/tickets/${ARCH_ID}/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'decision', question: detail.decision?.question, chose: { key: 'B', label: 'decide later' }, note: 'ship D first', rev: detail.rev }),
  })).json();
  await sleep(1200);
  const board = await (await fetch(`${BASE}/api/projects/${pid}/board`)).json();
  check('new /tickets/:id/answer records a decision → answered-awaiting (owner 👤), and NO dispatch',
    ans.owner === '👤' && (board.answeredAwaiting ?? []).some((x) => x.id === ARCH_ID) && countTurnEnds(c.events) === turnsBefore,
    { owner: ans.owner, awaiting: (board.answeredAwaiting ?? []).map((x) => x.id), turns: countTurnEnds(c.events) });

  // A QUESTION via the route flips ownership to the agent over HTTP too.
  const qDetail = await (await fetch(`${BASE}/api/projects/${pid}/tickets/${QUESTION_ID}`)).json();
  const qAns = await (await fetch(`${BASE}/api/projects/${pid}/tickets/${QUESTION_ID}/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'question', question: qDetail.decision?.question, note: 'which names are on the table?', rev: qDetail.rev }),
  })).json();
  await sleep(800);
  const board2 = await (await fetch(`${BASE}/api/projects/${pid}/board`)).json();
  check('new /tickets/:id/answer with kind=question flips ownership to the agent, NOT ready-for-work',
    qAns.owner === '🤖' && (board2.inflight ?? []).some((x) => x.id === QUESTION_ID) && !(board2.answeredAwaiting ?? []).some((x) => x.id === QUESTION_ID),
    { owner: qAns.owner, inflight: (board2.inflight ?? []).map((x) => x.id) });

  // rev conflict over HTTP preserves the record (409 path).
  const stale = await fetch(`${BASE}/api/projects/${pid}/tickets/${ARCH_ID}/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'decision', chose: { key: 'A', label: 'fix root cause' }, rev: '1:1' }),
  });
  const staleBody = await stale.json();
  check('a stale-rev answer returns 409 with the current rev (draft-preserving path)',
    stale.status === 409 && !!staleBody.rev, { status: stale.status, rev: staleBody.rev });

  try { c.ws.close(); } catch { /* gone */ }
  stopByPid(srv);
  return { WORK, STORE, DATA };
}

/* ═══════════════════════════════════════════════════ PART C — real brave UI ══ */
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c = new Cdp(ws);
    ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && c.waiting.has(m.id)) { const { res, rej } = c.waiting.get(m.id); c.waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } });
    return c;
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.waiting.set(id, { res, rej })); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`); return r.result?.value; }
  async waitFor(label, expr, timeoutMs = 20000) { const t0 = Date.now(); while (Date.now() - t0 < timeoutMs) { try { if (await this.eval(expr)) return true; } catch { /* mid-nav */ } await sleep(150); } console.log(`        (timed out waiting for ${label})`); return false; }
  async setViewport(width, height, dark) { await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 900 }); if (dark !== undefined) await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] }); }
  async shot(file) { try { const r = await this.send('Page.captureScreenshot', { format: 'png' }); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); console.log(`        screenshot → ${file}`); } catch (err) { console.log(`        (screenshot failed: ${err.message})`); } }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

async function partC() {
  console.log('\n=== PART C — real brave: wide Decide card + narrow pinned bar/sheet ===');
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'f90ui-data-'));
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'f90ui-store-'));
  const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'f90ui-prof-'));
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'f90ui-proj-'));
  seedBoard(path.join(WORK, 'docs', 'bugs'));

  const srv = spawn(process.execPath, [ENTRY], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  srv.stderr?.on('data', (d) => { if (process.env.CS_VERBOSE) process.stderr.write(`  [srv] ${d}`); });
  procs.add(srv);
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { const r = await fetch(`${BASE}/api/health`); up = r.ok; } catch { await sleep(200); } }
  if (!up) throw new Error('UI server never healthy');
  const reg = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: WORK, name: 'F90 UI' }) })).json();
  const pid = reg.project.id;

  const browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0', '--no-first-run', '--disable-extensions', '--window-size=1500,950', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  procs.add(browser);
  let devPort = 0;
  for (let i = 0; i < 80 && !devPort; i++) { try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); } }
  if (!devPort) throw new Error('browser never wrote DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');

  const openArch = async () => {
    await cdp.send('Page.navigate', { url: `${BASE}/#/tickets/${ARCH_ID}?project=${encodeURIComponent(pid)}` });
    return cdp.waitFor('decide card', `!!document.querySelector('#tvDetail .tv-decide')`, 20000);
  };

  /* ---- WIDE ---- */
  await cdp.setViewport(1400, 900, false);
  let ok = await openArch();
  // The Decide card must be visible beside the status line WITHOUT scrolling.
  const wide = await cdp.eval(`(() => {
    const card = document.querySelector('#tvDetail .tv-decide');
    const meta = document.querySelector('#tvDetail .tv-dmeta');
    if (!card || !meta) return { ok:false };
    const cr = card.getBoundingClientRect(), mr = meta.getBoundingClientRect();
    const inView = cr.top >= 0 && cr.bottom <= innerHeight && cr.right <= innerWidth + 1;
    const beside = cr.left > (document.querySelector('#tvDetail .tv-md').getBoundingClientRect().right - 5);
    const opts = document.querySelectorAll('#tvDetail .tv-decide .dc-opt').length;
    const barHidden = getComputedStyle(document.querySelector('#tvDetail .tv-decide-bar')).display === 'none';
    return { ok:true, inView, beside, opts, barHidden, cardTop: Math.round(cr.top) };
  })()`);
  check('(WIDE) the Decide card renders BESIDE the content, in view without scrolling, with all 4 options',
    ok && wide.ok && wide.inView && wide.beside && wide.opts === 4 && wide.barHidden, wide);
  await cdp.shot(path.join(SHOTDIR, 'feat090-wide.png'));

  // The wide-dark variant, still unanswered (shows the form, not the read-only flip).
  await cdp.setViewport(1400, 900, true); await openArch(); await sleep(400);
  await cdp.shot(path.join(SHOTDIR, 'feat090-wide-dark.png'));
  await cdp.setViewport(1400, 900, false); await openArch(); await sleep(300);

  // Record an answer at wide: pick B, add a note, submit; the card flips to read-only.
  const recorded = await cdp.eval(`(() => {
    const card = document.querySelector('#tvDetail .tv-decide');
    const b = [...card.querySelectorAll('.dc-opt input')].find((i) => i.value === 'B');
    b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true }));
    const note = card.querySelector('.dc-note'); note.value = 'B, but ship D first'; note.dispatchEvent(new Event('input', { bubbles: true }));
    const send = card.querySelector('.dc-send'); const disabled = send.disabled; send.click();
    return { disabled };
  })()`);
  const flipped = await cdp.waitFor('answered state', `!!document.querySelector('#tvDetail .tv-decide .dc-answered')`, 15000);
  const answeredState = await cdp.eval(`(() => {
    const a = document.querySelector('#tvDetail .tv-decide .dc-answered');
    // The ORIGINAL reply form (reply-kind segmented control + option list + the
    // "Record answer" button) must be GONE. FEAT-090 follow-up: the answered card
    // now carries a small follow-up composer (a .dc-followup-send, which reuses the
    // .dc-send class) — so "no form" means the reply KIND control is gone, not that
    // no button exists. The follow-up composer being present is the point.
    return {
      text: a?.textContent ?? '',
      hasReplyForm: !!document.querySelector('#tvDetail .tv-decide .dc-seg'),
      hasFollowupComposer: !!document.querySelector('#tvDetail .tv-decide .dc-followup-send'),
    };
  })()`);
  check('(WIDE) submitting records the answer and the card FLIPS in place to a read-only "You answered B on <date>" (reply form gone, follow-up composer present)',
    recorded.disabled === false && flipped && /You answered B on \d{4}-\d\d-\d\d/.test(answeredState.text) && /awaiting an agent/.test(answeredState.text) && !answeredState.hasReplyForm && answeredState.hasFollowupComposer,
    answeredState);
  // The disk record moved the ticket to answered-awaiting.
  const boardW = await (await fetch(`${BASE}/api/projects/${pid}/board`)).json();
  check('(WIDE) the answer reached disk: ARCH ticket is now in the answered-awaiting lane',
    (boardW.answeredAwaiting ?? []).some((x) => x.id === ARCH_ID), (boardW.answeredAwaiting ?? []).map((x) => x.id));

  /* ---- NARROW ---- (a fresh unanswered decision: FEAT-902) */
  const openNeeds = async (dark) => {
    await cdp.setViewport(430, 880, dark);
    await cdp.send('Page.navigate', { url: `${BASE}/#/tickets/${NEEDS_ID}?project=${encodeURIComponent(pid)}` });
    return cdp.waitFor('pinned bar', `(() => { const b = document.querySelector('#tvDetail .tv-decide-bar'); return b && getComputedStyle(b).display !== 'none'; })()`, 20000);
  };
  const barUp = await openNeeds(false);
  const narrow = await cdp.eval(`(() => {
    const bar = document.querySelector('#tvDetail .tv-decide-bar');
    const wideCard = document.querySelector('#tvDetail .tv-decide-wrap');
    const br = bar.getBoundingClientRect();
    return { pinnedBottom: Math.abs(br.bottom - innerHeight) < 2, wideHidden: getComputedStyle(wideCard).display === 'none', hasBtn: !!bar.querySelector('.tdb-open') };
  })()`);
  check('(NARROW) the pinned bar is present at the bottom, the sidebar card is hidden',
    barUp && narrow.pinnedBottom && narrow.wideHidden && narrow.hasBtn, narrow);
  await cdp.shot(path.join(SHOTDIR, 'feat090-narrow.png'));
  // dark variant of the narrow pinned bar
  await openNeeds(true); await sleep(300);
  await cdp.shot(path.join(SHOTDIR, 'feat090-narrow-dark.png'));
  await openNeeds(false);

  // Tapping opens the bottom sheet; record an answer there.
  await cdp.eval(`document.querySelector('#tvDetail .tv-decide-bar .tdb-open').click()`);
  const sheetUp = await cdp.waitFor('sheet', `!!document.querySelector('.tv-sheet .tv-decide')`, 8000);
  await sleep(300); // let the sheetUp animation settle before measuring geometry
  const sheet = await cdp.eval(`(() => { const s = document.querySelector('.tv-sheet-box'); const r = s.getBoundingClientRect(); return { dockedBottom: Math.abs(r.bottom - innerHeight) < 2, opts: document.querySelectorAll('.tv-sheet .dc-opt').length }; })()`);
  check('(NARROW) tapping Answer opens a bottom sheet docked to the bottom with the option list',
    sheetUp && sheet.dockedBottom && sheet.opts === 2, sheet);
  const sent = await cdp.eval(`(() => {
    const card = document.querySelector('.tv-sheet .tv-decide');
    const b = [...card.querySelectorAll('.dc-opt input')].find((i) => i.value === 'csv');
    b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true }));
    card.querySelector('.dc-send').click(); return true;
  })()`);
  const narrowDone = await cdp.waitFor('sheet closes + answered', `!document.querySelector('.tv-sheet') && !!document.querySelector('#tvDetail .tv-decide .dc-answered')`, 15000);
  check('(NARROW) submitting from the sheet records the answer, closes the sheet, and flips the card to answered',
    sent && narrowDone, { narrowDone });
  const boardN = await (await fetch(`${BASE}/api/projects/${pid}/board`)).json();
  check('(NARROW) the answer reached disk: FEAT-902 is now answered-awaiting',
    (boardN.answeredAwaiting ?? []).some((x) => x.id === NEEDS_ID), (boardN.answeredAwaiting ?? []).map((x) => x.id));

  cdp.close();
  stopByPid(browser);
  stopByPid(srv);
}

/* ─────────────────────────────────────────────────────────────────────── run */
async function main() {
  partA();
  await partB();
  if (!NO_UI) {
    try { await partC(); }
    catch (err) { check('PART C (brave UI) ran without throwing', false, err.message); }
  } else {
    console.log('\n(skipping PART C — --no-ui)');
  }
}

main().then(() => {
  for (const c of procs) stopByPid(c);
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exit(fail ? 1 : 0);
}).catch((err) => {
  for (const c of procs) stopByPid(c);
  console.error(err);
  process.exit(1);
});
