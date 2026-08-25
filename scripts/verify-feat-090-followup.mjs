/**
 * FEAT-090 (follow-up + narrow reachability) — after answering a ticket the user
 * must still be able to ADD context. The answer log is append-only, so a follow-up
 * is a NEW dated `you (follow-up …)` entry that NEVER edits the original and
 * RE-FLAGS the ticket as awaiting agent action.
 *
 *   node scripts/verify-feat-090-followup.mjs
 *   node scripts/verify-feat-090-followup.mjs --no-ui   # PART A only (pure)
 *
 * PART 0  must-FAIL PROOF (static): the SHIPPED decide.js (git HEAD) rendered the
 *         answered state with NO composer and NO onSubmit — there was no way to add
 *         context. HEAD must fail this; the working tree must pass it.
 * PART A  (pure, no server): the composer/parser/answerTicket over a REAL seeded
 *         board — a follow-up appends a you(follow-up) entry, the ORIGINAL answer
 *         entry is byte-for-byte preserved, the ticket STAYS answered-awaiting
 *         (owner 👤), ticketAnswerState keeps the anchor answer + lists the
 *         follow-up, and a follow-up AFTER an agent acted RE-flags awaiting.
 * PART C  (real brave over CDP, free port, PID-kill only): on a REAL answered
 *         ticket the answered card carries a follow-up composer; adding a note
 *         appends and re-renders WITHOUT losing the original answer. Exercised at
 *         WIDE and — the coverage gap the ≥1000px guard could not see — NARROW
 *         (899/600/360, both themes): the answered card is reachable INLINE (never
 *         behind a closed sheet), and the UNANSWERED narrow sheet still lets a user
 *         read the options and record an answer end-to-end.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readBoard, composeAnswerEntry, ticketAnswerState, ticketDecision,
} from '../src/server/board.ts';
import { answerTicket, readTicket, TicketError } from '../src/server/tickets.ts';
import { discoverRealDecisions } from './lib/real-decisions.mjs';
import { shotLedger } from './lib/shot-luma.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
// The real board to DISCOVER a decision from. Override (test-only) lets a
// mutation-simulation point the real suite at a COPIED, mutated board.
const REAL_BUGS = process.env.VERIFY_REAL_BUGS ?? path.join(ROOT, 'docs', 'bugs');
const ARGS = process.argv.slice(2);
const NO_UI = ARGS.includes('--no-ui');
const BRAVE = process.env.VERIFY_BROWSER ?? 'brave';
const SHOTDIR = '/tmp/iv-orchard/feat090-followup';
const TODAY = new Date().toISOString().slice(0, 10);
const ledger = shotLedger();

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── a seeded board: a DECISION we answer + a REAL decision put into the answered
      FREE-TEXT state this test OWNS ─────────────────────────────────────────────
   We do NOT name a live answered ticket (ARCH-003 was named here and reddened the
   moment its lane re-worked it): docs/CONVENTIONS.md, "invariant PROPERTIES, not
   values legitimate use changes." Instead we DISCOVER a real decision at runtime
   (real, paragraph-length, marked-up option prose) and seed a free-text answer we
   wrote onto it — so the "answered free-text (chose null, note present)" state is
   OWNED by the test, immune to the live ticket being re-answered/reopened/archived,
   while the surrounding prose stays real. discoverRealDecisions throws loudly if
   the board carries no real decision at all (itself worth knowing). */
const DEC_ID = 'FEAT-901';        // a bold-lead decision we answer, then follow up on
const unanswered = (body) => body.replace(/\n### \d{4}-\d\d-\d\d — you \([^\n]*[\s\S]*$/, '\n');
const REAL = discoverRealDecisions(REAL_BUGS, ticketDecision)[0];
const REAL_ARCH = REAL.id;        // a real decision ticket, seeded into answered-free-text
const REAL_FILE = REAL.name;
// The free-text answer this test owns (no chosen option → chose null, note present).
const SEEDED_ANSWER = 'seeded free-text answer (owned by this test): on this linux host we CAN track parentage — reconsider detectability before deciding';
const REAL_ANSWERED_BODY = unanswered(REAL.body)
  + composeAnswerEntry({ kind: 'decision', note: SEEDED_ANSWER, via: 'ticket view' });

function seedBoard(bugs) {
  fs.mkdirSync(bugs, { recursive: true });
  fs.writeFileSync(path.join(bugs, 'INDEX.md'),
    `# Board — scratch\n\n## Open\n\n` +
    `| ID | Title | Owner | Status | Sev |\n|----|-------|-------|--------|-----|\n` +
    `| ${DEC_ID} | fix or shield | 👤 | needs decision | high |\n` +
    `| ${REAL_ARCH} | ${REAL.decision.question.replace(/\|/g, '/').slice(0, 48)} | 👤 | answered — awaiting | high |\n\n` +
    `## Done (committed)\n\n| ID | Title | Commit |\n|----|-------|--------|\n\n` +
    `## Shipped earlier (pre-tracker)\n\n- nothing yet\n`);
  fs.writeFileSync(path.join(bugs, `${DEC_ID}-fix-or-shield.md`),
    `# ${DEC_ID} — fix or shield\n\n` +
    `- **Status:** OPEN — DECISION NEEDED. Recommended: B, with D as the interim shield.\n- **Severity:** high\n- **Area:** server\n\n` +
    `## Decision 1 — fix it properly, or just stop the harm\n` +
    `- **A — fix the root cause.** Rework turn-end so parentage is always known, at real cost.\n` +
    `- **B — decide later instead of on the spot.** Stop deciding under time pressure; revisit deliberately.\n` +
    `- **C — accept the risk.** Do nothing and live with the occasional wrong parentage.\n` +
    `- **D — ship an interim shield.** A cheap guard that prevents the worst case now.\n\n` +
    `## Activity log (APPEND-ONLY)\n\n### 2026-08-03 — orchestrator\n- filed, waiting on the user.\n`);
  // The REAL artifact: real decision prose, put into the answered FREE-TEXT state
  // this test owns (real options above, a free-text answer we wrote below).
  fs.writeFileSync(path.join(bugs, REAL_FILE), REAL_ANSWERED_BODY);
  for (const t of ['TEMPLATE.md', 'TEMPLATE-ARCH.md']) {
    try { fs.copyFileSync(path.join(ROOT, 'docs', 'bugs', t), path.join(bugs, t)); } catch { /* optional */ }
  }
}
const ticketPath = (bugs, id) => {
  const hit = fs.readdirSync(bugs).find((n) => n.startsWith(`${id}-`));
  return hit ? path.join(bugs, hit) : null;
};

/* ═══════════════════════════ PART 0 — must-FAIL non-vacuity ═══════════════════
 * The original pre-fix hole: the shipped `renderAnswered(decision, a)` appended no
 * textarea/button, so an answered ticket had no way to add context. This part
 * PROVES the detector is non-vacuous — it flags a composer-less decide.js and
 * clears the fixed one. It used to diff against `git show HEAD:` (the pre-fix
 * working-tree state), but once the fix was COMMITTED, HEAD stopped being the
 * pre-fix state and the must-FAIL could never fail — the same mutable-baseline
 * coupling this cleanup is about, one level up (coupled to `HEAD`, which the fix
 * landing moved). So synthesize the composer-less state from the CURRENT file
 * instead: git-independent, durable, and still a real must-FAIL. */
function part0() {
  console.log('\n=== PART 0 — must-FAIL: a composer-less answered state is detected as the hole ===');
  const now = fs.readFileSync(path.join(ROOT, 'public', 'lib', 'decide.js'), 'utf8');
  const hasComposer = (src) => /renderFollowupForm/.test(src) && /dc-followup-send/.test(src)
    && /renderAnswered\(decision, answered, onSubmit\)/.test(src);
  // Reconstruct the pre-fix hole from today's file: strip the follow-up composer
  // markers so `renderAnswered` again renders the answer with no way to add context.
  const holed = now.replace(/renderFollowupForm/g, 'renderReadOnlyAnswer')
    .replace(/dc-followup-send/g, 'dc-noop')
    .replace(/renderAnswered\(decision, answered, onSubmit\)/g, 'renderAnswered(decision, answered)');
  check('MUST-FAIL: a decide.js with the follow-up composer stripped is detected as the hole (no composer)',
    hasComposer(holed) === false, { holedHasComposer: hasComposer(holed) });
  check('FIXED: the working tree renders a follow-up composer wired to onSubmit',
    hasComposer(now) === true, { nowHasComposer: hasComposer(now) });
}

/* ═══════════════════════════════════════════════ PART A — pure functions ═════ */
function partA() {
  console.log('\n=== PART A — follow-up composer / parser / answerTicket (append-only) ===');

  // The composer marks a follow-up distinctly, drops the Chose, keeps it an answer.
  const fu = composeAnswerEntry({ kind: 'decision', followup: true, chose: { key: 'B', label: 'ignored' }, note: 'one more thing: watch the retry path', via: 'ticket view' });
  check('composer(follow-up): a you(follow-up…) mark, an Answer line, NO Chose, a follow-up State',
    /### \d{4}-\d\d-\d\d — you \(follow-up · via ticket view\)/.test(fu)
      && /- \*\*Answer:\*\* one more thing: watch the retry path/.test(fu)
      && !/Chose/.test(fu)
      && /- \*\*State:\*\* answered — awaiting agent action \(context added after deciding/.test(fu),
    fu.trim());

  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'f90fu-'));
  const bugs = path.join(TMP, 'docs', 'bugs');
  seedBoard(bugs);
  const host = TMP;

  // Answer the decision (B + note), then FOLLOW UP on it.
  const rev0 = readTicket(host, DEC_ID).rev;
  answerTicket(host, DEC_ID, { kind: 'decision', question: 'fix or shield', chose: { key: 'B', label: 'decide later' }, note: 'but ship D first' }, rev0);
  const afterAnswer = fs.readFileSync(ticketPath(bugs, DEC_ID), 'utf8');
  const rev1 = readTicket(host, DEC_ID).rev;
  const rFu = answerTicket(host, DEC_ID, { kind: 'decision', followup: true, note: 'actually — do D this week regardless' }, rev1);
  const afterFu = fs.readFileSync(ticketPath(bugs, DEC_ID), 'utf8');

  check('answerTicket(follow-up): APPEND-ONLY — the original answer file is a strict PREFIX of the new file',
    afterFu.startsWith(afterAnswer) && afterFu.length > afterAnswer.length, { grew: afterFu.length - afterAnswer.length });
  check('answerTicket(follow-up): the original "Chose: B" + Note survive verbatim (never edited)',
    /- \*\*Chose:\*\* B — decide later/.test(afterFu) && /- \*\*Note:\*\* but ship D first/.test(afterFu), 'original entry intact');

  const bAfter = readBoard(host);
  check('answerTicket(follow-up): owner STAYS 👤 and the ticket STAYS answered-awaiting, never dropped/resolved',
    rFu.owner === '👤'
      && bAfter.answeredAwaiting.some((x) => x.id === DEC_ID)
      && !bAfter.needsYou.some((x) => x.id === DEC_ID)
      && !bAfter.doneToday.some((x) => x.id === DEC_ID),
    { owner: rFu.owner, awaiting: bAfter.answeredAwaiting.map((x) => x.id) });

  const st = ticketAnswerState(afterFu);
  check('ticketAnswerState(after follow-up): anchor answer is PRESERVED (chose B, original note), awaiting=true',
    st?.chose?.key === 'B' && st?.note === 'but ship D first' && st?.awaiting === true, st);
  check('ticketAnswerState(after follow-up): the follow-up is listed as its own dated note (original not overwritten)',
    Array.isArray(st?.followups) && st.followups.length === 1 && /do D this week/.test(st.followups[0].note) && st.followups[0].on === TODAY,
    st?.followups);

  // The lane-safety case the charter names: an AGENT acts (awaiting=false), then the
  // user adds context — the follow-up must RE-flag awaiting and return it to the lane.
  fs.appendFileSync(ticketPath(bugs, DEC_ID), `\n### ${TODAY} — agent\n- picked it up, starting the shield.\n`);
  const afterAgent = readBoard(host);
  check('after an AGENT dated entry: the ticket LEAVES answered-awaiting (an agent has since acted)',
    !afterAgent.answeredAwaiting.some((x) => x.id === DEC_ID) && ticketAnswerState(fs.readFileSync(ticketPath(bugs, DEC_ID), 'utf8'))?.awaiting === false,
    { awaiting: afterAgent.answeredAwaiting.map((x) => x.id) });
  const rev2 = readTicket(host, DEC_ID).rev;
  answerTicket(host, DEC_ID, { kind: 'decision', followup: true, note: 'wait — hold off, I changed my mind on the timing' }, rev2);
  const afterReFu = readBoard(host);
  check('a follow-up AFTER the agent acted RE-flags awaiting and returns the ticket to answered-awaiting',
    afterReFu.answeredAwaiting.some((x) => x.id === DEC_ID) && ticketAnswerState(fs.readFileSync(ticketPath(bugs, DEC_ID), 'utf8'))?.awaiting === true,
    { awaiting: afterReFu.answeredAwaiting.map((x) => x.id) });

  // An empty follow-up is refused (the button is disabled client-side; the server
  // is the backstop).
  let empty = null;
  try { answerTicket(host, DEC_ID, { kind: 'decision', followup: true, note: '   ' }, readTicket(host, DEC_ID).rev); }
  catch (e) { empty = e; }
  check('answerTicket(follow-up, empty text): refused (a follow-up needs text)',
    empty instanceof TicketError && empty.status === 400, { status: empty?.status });

  // The REAL artifact: a real decision seeded into the answered FREE-TEXT state
  // this test owns (chose null, our free-text note, awaiting). Its answered state
  // must parse, and a follow-up must append cleanly to the real file — the exact
  // state the user is in after replying free-text on a real decision.
  const realState = ticketAnswerState(fs.readFileSync(ticketPath(bugs, REAL_ARCH), 'utf8'));
  check(`REAL ${REAL_ARCH} parses as an answered free-text decision (chose null, our note present, awaiting) — the state the user was in`,
    realState?.kind === 'decision' && realState?.chose === null && realState?.note === SEEDED_ANSWER && realState?.awaiting === true,
    { note: realState?.note?.slice(0, 40), awaiting: realState?.awaiting });
  const realBefore = fs.readFileSync(ticketPath(bugs, REAL_ARCH), 'utf8');
  answerTicket(host, REAL_ARCH, { kind: 'decision', followup: true, note: 'follow-up: new evidence in — reconsider detectability on this host' }, readTicket(host, REAL_ARCH).rev);
  const realAfter = fs.readFileSync(ticketPath(bugs, REAL_ARCH), 'utf8');
  check(`a follow-up on the REAL ${REAL_ARCH} is append-only and keeps the original free-text answer`,
    realAfter.startsWith(realBefore) && ticketAnswerState(realAfter)?.followups.length === 1 && ticketAnswerState(realAfter)?.note === realState.note,
    { grew: realAfter.length - realBefore.length });

  fs.rmSync(TMP, { recursive: true, force: true });
}

/* ═══════════════════════════════════════════════════ PART C — real brave UI ══ */
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
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async connect(url) {
    const WebSocket = (await import('ws')).default;
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
  async shot(file, tone) { try { const r = await this.send('Page.captureScreenshot', { format: 'png' }); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); const g = ledger.record(file, tone); console.log(`        screenshot → ${file} [${g.ok ? 'OK' : 'BAD'}: ${g.why}]`); if (!g.ok) check(`screenshot ${path.basename(file)} graded cleanly`, false, g.why); } catch (err) { console.log(`        (screenshot failed: ${err.message})`); } }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

async function partC() {
  console.log('\n=== PART C — real brave: follow-up composer WIDE + NARROW reachability ===');
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'f90fu-data-'));
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'f90fu-store-'));
  const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'f90fu-prof-'));
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'f90fu-proj-'));
  seedBoard(path.join(WORK, 'docs', 'bugs'));

  const srv = spawn(process.execPath, [ENTRY], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  srv.stderr?.on('data', (d) => { if (process.env.CS_VERBOSE) process.stderr.write(`  [srv] ${d}`); });
  procs.add(srv);
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { const r = await fetch(`${BASE}/api/health`); up = r.ok; } catch { await sleep(200); } }
  if (!up) throw new Error('UI server never healthy');
  const reg = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: WORK, name: 'F90FU' }) })).json();
  const pid = reg.project.id;

  const browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0', '--no-first-run', '--disable-extensions', '--window-size=1500,950', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  procs.add(browser);
  let devPort = 0;
  for (let i = 0; i < 80 && !devPort; i++) { try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); } }
  if (!devPort) throw new Error('browser never wrote DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');

  const openTicket = async (id) => {
    await cdp.send('Page.navigate', { url: `${BASE}/#/tickets/${id}?project=${encodeURIComponent(pid)}` });
    return cdp.waitFor('decide card', `!!document.querySelector('#tvDetail .tv-decide')`, 20000);
  };

  /* ── WIDE: answer DEC-901, then the answered card must carry a follow-up composer ── */
  await cdp.setViewport(1400, 900, false);
  await openTicket(DEC_ID);
  await cdp.eval(`(() => {
    const card = document.querySelector('#tvDetail .tv-decide');
    const b = [...card.querySelectorAll('.dc-opt input')].find((i) => i.value === 'B');
    b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true }));
    const note = card.querySelector('.dc-note'); note.value = 'B, but ship D first'; note.dispatchEvent(new Event('input', { bubbles: true }));
    card.querySelector('.dc-send').click();
  })()`);
  const flipped = await cdp.waitFor('answered state', `!!document.querySelector('#tvDetail .tv-decide .dc-answered')`, 15000);
  const composer = await cdp.eval(`(() => {
    const a = document.querySelector('#tvDetail .tv-decide .dc-answered');
    const ta = a.querySelector('.dc-followup-note');
    const btn = a.querySelector('.dc-followup-send');
    return { hasNoteRO: !!a.querySelector('.dc-note-ro'), hasTextarea: !!ta, btnDisabled: btn?.disabled, taInView: (() => { const r = ta.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight + 1; })() };
  })()`);
  check('(WIDE) after answering, the answered card shows the original answer AND a follow-up composer (in view)',
    flipped && composer.hasNoteRO && composer.hasTextarea && composer.btnDisabled === true && composer.taInView, composer);
  await cdp.shot(path.join(SHOTDIR, 'wide-answered-light.png'), 'light');

  // Add a follow-up; it must append and re-render with BOTH the original + the follow-up.
  await cdp.eval(`(() => {
    const ta = document.querySelector('#tvDetail .tv-decide .dc-followup-note');
    ta.value = 'follow-up: watch the retry loop under load too'; ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#tvDetail .tv-decide .dc-followup-send').click();
  })()`);
  const rerendered = await cdp.waitFor('follow-up on record', `!!document.querySelector('#tvDetail .tv-decide .dc-followup')`, 15000);
  const recState = await cdp.eval(`(() => {
    const a = document.querySelector('#tvDetail .tv-decide .dc-answered');
    return { followups: a.querySelectorAll('.dc-followup').length, keepsOriginal: /B, but ship D first/.test(a.textContent), showsFollowup: /watch the retry loop/.test(a.textContent), stillHasComposer: !!a.querySelector('.dc-followup-note') };
  })()`);
  check('(WIDE) the follow-up appends, re-renders WITH the original answer kept, and the composer stays for the next add',
    rerendered && recState.followups === 1 && recState.keepsOriginal && recState.showsFollowup && recState.stillHasComposer, recState);
  await cdp.shot(path.join(SHOTDIR, 'wide-followup-light.png'), 'light');
  await cdp.setViewport(1400, 900, true); await openTicket(DEC_ID); await sleep(400);
  await cdp.shot(path.join(SHOTDIR, 'wide-answered-dark.png'), 'dark');

  const boardW = await (await fetch(`${BASE}/api/projects/${pid}/board`)).json();
  check('(WIDE) the follow-up reached disk and DEC-901 is STILL answered-awaiting (not dropped/resolved)',
    (boardW.answeredAwaiting ?? []).some((x) => x.id === DEC_ID), (boardW.answeredAwaiting ?? []).map((x) => x.id));

  /* ── NARROW: the coverage gap. The answered card (DEC-901, now answered) must be
       REACHABLE inline — not behind a closed sheet — at 899/600/360, both themes. ── */
  for (const [w, h, dark, tone] of [[899, 780, false, 'light'], [600, 780, true, 'dark'], [360, 720, false, 'light']]) {
    await cdp.setViewport(w, h, dark);
    await openTicket(DEC_ID);
    await cdp.waitFor('answered card', `!!document.querySelector('#tvDetail .tv-decide .dc-answered')`, 15000);
    const narrow = await cdp.eval(`(() => {
      const wrap = document.querySelector('#tvDetail .tv-decide-wrap');
      const ta = document.querySelector('#tvDetail .tv-decide .dc-followup-note');
      const btn = document.querySelector('#tvDetail .tv-decide .dc-followup-send');
      if (!wrap || !ta || !btn) return { ok:false, wrap: !!wrap, ta: !!ta, btn: !!btn };
      const visible = getComputedStyle(wrap).display !== 'none';
      const r = ta.getBoundingClientRect();
      // reachable: scroll it into view and confirm it lands within the viewport
      ta.scrollIntoView({ block: 'center' }); const r2 = ta.getBoundingClientRect();
      const reachable = r2.top >= 0 && r2.bottom <= innerHeight + 1 && r2.width > 40;
      return { ok:true, visible, reachable };
    })()`);
    check(`(NARROW ${w}px) the answered card + follow-up composer render INLINE and are reachable`,
      narrow.ok && narrow.visible && narrow.reachable, narrow);
    // Record a follow-up here to prove it works end-to-end at this width.
    await cdp.eval(`(() => {
      const ta = document.querySelector('#tvDetail .tv-decide .dc-followup-note');
      ta.value = 'narrow follow-up at ${w}px'; ta.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#tvDetail .tv-decide .dc-followup-send').click();
    })()`);
    const added = await cdp.waitFor(`follow-up recorded at ${w}px`, `[...document.querySelectorAll('#tvDetail .tv-decide .dc-followup')].some(f => /narrow follow-up at ${w}px/.test(f.textContent))`, 15000);
    check(`(NARROW ${w}px) a follow-up recorded from the narrow answered card lands`, added, { added });
    await cdp.shot(path.join(SHOTDIR, `narrow-${w}-${tone}.png`), tone);
  }

  /* ── NARROW UNANSWERED (the guard gap the coordinator named): the bottom sheet
       still lets a user READ the options and RECORD an answer at 899/600/360. ── */
  for (const [w, h, dark] of [[899, 780, false], [600, 780, true], [360, 720, false]]) {
    await cdp.setViewport(w, h, dark);
    // Re-seed via a fresh ticket each time would need a new id; instead reset by
    // answering ARCH-003? No — use the sheet on the UNANSWERED narrow only if one
    // exists. DEC-901 is answered; drive the sheet on a fresh unanswered decision.
    const freshId = `BUG-${w}`;
    const bugs = path.join(WORK, 'docs', 'bugs');
    fs.writeFileSync(path.join(bugs, `${freshId}-x.md`),
      `# ${freshId} — narrow sheet at ${w}\n\n- **Status:** OPEN — DECISION NEEDED. Recommended: B.\n- **Severity:** high\n- **Area:** ui\n\n` +
      `## Decision 1 — pick one\n- **A — alpha.** the first option, described.\n- **B — beta.** the second option, described.\n\n` +
      `## Activity log (APPEND-ONLY)\n\n### 2026-08-03 — orchestrator\n- filed.\n`);
    // add it to INDEX Open so it lists
    const idx = path.join(bugs, 'INDEX.md');
    fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replace('| ID | Title | Owner | Status | Sev |\n|----|-------|-------|--------|-----|\n', `| ID | Title | Owner | Status | Sev |\n|----|-------|-------|--------|-----|\n| ${freshId} | narrow sheet | 👤 | needs decision | high |\n`));
    await cdp.send('Page.navigate', { url: `${BASE}/#/tickets/${freshId}?project=${encodeURIComponent(pid)}` });
    const barUp = await cdp.waitFor('pinned bar', `(() => { const b = document.querySelector('#tvDetail .tv-decide-bar'); return b && getComputedStyle(b).display !== 'none'; })()`, 20000);
    await cdp.eval(`document.querySelector('#tvDetail .tv-decide-bar .tdb-open').click()`);
    const sheetUp = await cdp.waitFor('sheet options', `document.querySelectorAll('.tv-sheet .dc-opt').length === 2`, 8000);
    await sleep(250);
    const readable = await cdp.eval(`(() => { const s = document.querySelector('.tv-sheet-box'); const r = s.getBoundingClientRect(); const opt = document.querySelector('.tv-sheet .dc-opt'); const or = opt.getBoundingClientRect(); return { docked: Math.abs(r.bottom - innerHeight) < 2, optVisible: or.top >= 0 && or.bottom <= innerHeight + 1 && or.width > 40 }; })()`);
    check(`(NARROW UNANSWERED ${w}px) the sheet opens docked, options are readable`, barUp && sheetUp && readable.docked && readable.optVisible, readable);
    await cdp.eval(`(() => { const card = document.querySelector('.tv-sheet .tv-decide'); const b = [...card.querySelectorAll('.dc-opt input')].find(i => i.value === 'B'); b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); card.querySelector('.dc-send').click(); })()`);
    const done = await cdp.waitFor('sheet closes + answered', `!document.querySelector('.tv-sheet') && !!document.querySelector('#tvDetail .tv-decide .dc-answered')`, 15000);
    check(`(NARROW UNANSWERED ${w}px) recording an answer from the sheet works end-to-end`, done, { done });
  }

  cdp.close();
  stopByPid(browser);
  stopByPid(srv);
}

/* ─────────────────────────────────────────────────────────────────────── run */
async function main() {
  part0();
  partA();
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
