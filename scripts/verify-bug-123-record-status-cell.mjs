/**
 * BUG-123 — `board:gen` must not flatten a promoted ticket's Status cell.
 *
 *   node scripts/verify-bug-123-record-status-cell.mjs
 *
 * The Open-table Status cell is re-derived from the ticket's prose
 * `- **Status:**` header on every `gen` (FEAT-068 item #1). A promoted ticket has
 * no such header, so it derived to the bare word `OPEN`: the first real
 * `board:gen` after ARCH-005 was promoted erased which decision was waiting, what
 * was recommended and why, and what delay costs. That is the cell a reader scans
 * on the board landing page. One ticket today, 191 in one silent pass at cutover.
 *
 * THE RULE UNDER TEST, and both halves are asserted:
 *   · a ticket WITH a prose Status header keeps it verbatim — a human's curated
 *     sentence is never paraphrased. Asserted as BYTE-IDENTICAL rows across a
 *     regeneration, over the whole real board.
 *   · a ticket WITH A RECORD has no such sentence, so its cell is COMPOSED from
 *     the record's own authored fields.
 *
 * Everything runs against the REAL board, and the promoted ticket is DISCOVERED
 * at runtime rather than named, so this keeps working as the other 191 are
 * promoted. It ABORTS if the board holds no ticket of either kind.
 *
 * The must-FAIL is anchored to a SYNTHESIZED pre-change state — the pre-change
 * cell for a promoted ticket is exactly `boardStatusFromHeader(statusRaw)`, which
 * is still exported behaviour and still what every legacy ticket gets — never to
 * `HEAD`, which becomes the fixed state the moment this commits.
 *
 * Nothing is written to the real board: every generation happens in a scratch
 * copy.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { extractTicketBlock, TICKET_FILE_RE } from '../scripts/lib/ticket-schema.mjs';
import * as boardTool from '../scripts/board.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUGS = path.join(ROOT, 'docs', 'bugs');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

/* ═════════════════════════════════════════ the real board, split by format */

const files = fs.readdirSync(BUGS).filter((f) => TICKET_FILE_RE.test(f)).sort();
const real = files.map((f) => ({ file: f, text: fs.readFileSync(path.join(BUGS, f), 'utf8') }));
const promoted = real.filter((t) => extractTicketBlock(t.text).block !== null);
const legacy = real.filter((t) => extractTicketBlock(t.text).block === null);

console.log(`\n=== A. the real board (${real.length} tickets) ===`);
check('the board has a RECORD-format ticket (else this suite proves nothing)',
  promoted.length >= 1, `${promoted.length} promoted: ${promoted.map((t) => t.file.slice(0, 9)).join(', ') || '(none)'}`);
check('the board has LEGACY tickets (the must-not-change half)',
  legacy.length >= 1, `${legacy.length} legacy`);
if (!promoted.length || !legacy.length) {
  console.log('\nABORT: the real board cannot exercise a MIXED board. Not a pass.');
  process.exit(1);
}

/** A scratch copy of the real board — the real one is never generated into. */
function scratchBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug123-board-'));
  const bugs = path.join(dir, 'docs', 'bugs');
  fs.mkdirSync(bugs, { recursive: true });
  for (const f of fs.readdirSync(BUGS)) {
    const src = path.join(BUGS, f);
    if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(bugs, f));
  }
  return { dir, bugs };
}
const openRows = (indexText) => {
  const rows = new Map();
  let inOpen = false;
  for (const line of indexText.split('\n')) {
    const h = /^##\s+(.*)$/.exec(line);
    if (h) { inOpen = h[1].trim().toLowerCase().startsWith('open'); continue; }
    if (!inOpen) continue;
    const m = /^\|\s*((?:ARCH|BUG|FEAT|DEPLOY)-\d+)\s*\|/.exec(line);
    if (m) rows.set(m[1], line);
  }
  return rows;
};

/* ═══════════════════════ B. a promoted ticket's cell is COMPOSED, not flattened */

console.log('\n=== B. the promoted ticket keeps what the board is for ===');
const { dir: genDir, bugs: genBugs } = scratchBoard();
let generated;
try {
  boardTool.genBoard(genBugs);
  generated = fs.readFileSync(path.join(genBugs, 'INDEX.md'), 'utf8');
} finally { /* dir removed at the end */ }
const rowsAfter = openRows(generated);

/*
 * WHICH promoted tickets this section grades, and why it is not "all of them".
 *
 * The claim under test is about the Open table: a promoted ticket's Status cell
 * must be COMPOSED from its record, not flattened to the bare state word. A
 * promoted ticket that is DONE has no Open row, and that is the board working
 * correctly — closing a ticket is legitimate use, not a defect.
 *
 * This loop used to run over every promoted ticket and fail the ones with no
 * Open row. That was sound only while the board held exactly two promoted
 * tickets and both were open. The 2026-08-20 cutover promoted 194, most of them
 * already done, and the suite reported 177 failures without a single defect —
 * it had pinned a POPULATION rather than stated a property.
 *
 * So the population is DISCOVERED: every promoted ticket that is on the Open
 * table. The guards below make that non-vacuous — an empty or uninteresting
 * population is reported LOUDLY rather than passing quietly, which is the whole
 * risk of letting a suite choose its own subjects.
 */
const gradable = promoted
  .map((t) => ({ t, rec: JSON.parse(extractTicketBlock(t.text).block) }))
  .map((x) => ({ ...x, row: rowsAfter.get(x.rec.id) }))
  .filter((x) => x.row);

console.log(`  population: ${gradable.length} of ${promoted.length} promoted tickets are on the Open table `
  + `(${promoted.length - gradable.length} are done/closed, which is correct and not graded here)`);

check('there ARE promoted tickets on the Open table (a suite that grades none must not pass quietly)',
  gradable.length > 0, `${gradable.length} gradable`);

// Coverage: the properties below only bite on tickets that HAVE the shapes they
// test. If the Open table ever holds only shapeless rows, the section would go
// green having exercised nothing — so the interesting shapes are asserted present.
const withDecision = gradable.filter((x) => Array.isArray(x.rec.decision?.options) && x.rec.decision.options.length >= 2);
const withRecommendation = withDecision.filter((x) => typeof x.rec.decision.recommendation === 'string'
  && x.rec.decision.options.some((o) => String(o.key).trim() === x.rec.decision.recommendation.trim()));
const withImpact = gradable.filter((x) => typeof x.rec.impact_if_we_wait === 'string' && x.rec.impact_if_we_wait.trim());
const archTickets = gradable.filter((x) => x.rec.type === 'architecture');
check('coverage: the graded population contains a DECISION-bearing ticket', withDecision.length > 0, `${withDecision.length} with >=2 options`);
check('coverage: …one whose RECOMMENDATION points at a real option', withRecommendation.length > 0, `${withRecommendation.length} with a valid recommendation`);
check('coverage: …one carrying a CONSEQUENCE OF DELAY', withImpact.length > 0, `${withImpact.length} with impact_if_we_wait`);
check('coverage: …and an ARCH ticket (the "no build starts" clause)', archTickets.length > 0, `${archTickets.length} architecture tickets`);

for (const { rec, row } of gradable) {
  const cell = row.split('|')[4]?.trim() ?? '';

  // MUST-FAIL, anchored to a SYNTHESIZED pre-change state: before this change a
  // promoted ticket's cell was `boardStatusFromHeader(statusRaw)`, and a promoted
  // ticket has no prose Status header, so that function returned the bare word.
  // That reference is a property of the format, not of a revision.
  const preChange = boardTool.boardStatusFromHeader(
    boardTool.readTickets(genBugs).tickets.get(rec.id).statusRaw,
  );
  check(`${rec.id}: MUST-FAIL — the PRE-CHANGE cell really was the bare state word`,
    /^[A-Z-]+$/.test(preChange) && preChange.length <= 16, JSON.stringify(preChange));
  check(`${rec.id}: the generated cell is no longer that bare word`,
    cell !== preChange && cell.length > preChange.length, `${cell.length} chars (pre-change ${preChange.length})`);

  const d = rec.decision && typeof rec.decision === 'object' ? rec.decision : null;
  const options = d && Array.isArray(d.options) ? d.options : [];
  if (options.length >= 2) {
    check(`${rec.id}: the cell says a human must choose, and how many options`,
      /NEEDS A HUMAN DECISION/.test(cell) && cell.includes(`(${options.length} options)`),
      JSON.stringify(cell.slice(0, 70)));
    const valid = typeof d.recommendation === 'string'
      && options.some((o) => String(o.key).trim() === d.recommendation.trim());
    check(`${rec.id}: the RECOMMENDATION survives regeneration (the thing the board is scanned for)`,
      valid ? cell.includes(`Recommended: ${d.recommendation}`) : !/Recommended:/.test(cell),
      valid ? `Recommended: ${d.recommendation} present` : 'no valid recommendation on the record, and none badged');
    if (valid && d.recommendation_reason) {
      check(`${rec.id}: …and its REASON, whole — never truncated, never elided`,
        cell.includes(d.recommendation_reason.replace(/\.?$/, '').trim()),
        JSON.stringify(d.recommendation_reason.slice(0, 60)));
    }
    check(`${rec.id}: an ARCH ticket still says no build starts until someone chooses`,
      rec.type === 'architecture'
        ? /No build starts until an option is chosen/.test(cell)
        : !/No build starts/.test(cell),
      `type=${rec.type}`);
  }
  if (typeof rec.impact_if_we_wait === 'string' && rec.impact_if_we_wait.trim()) {
    check(`${rec.id}: the named CONSEQUENCE OF DELAY survives, whole`,
      cell.includes(rec.impact_if_we_wait.trim()), JSON.stringify(rec.impact_if_we_wait.slice(0, 60)));
  }
  check(`${rec.id}: the cell is ONE well-formed table cell (single line, no raw pipe)`,
    !cell.includes('\n') && !/(^|[^\\])\|/.test(cell), `${cell.length} chars, pipes=${(cell.match(/\|/g) ?? []).length}`);
  // A recommendation that points at no option must never be badged — the same
  // rule `ticketDecision` applies, stated here so the two cannot drift apart.
  const bogus = JSON.parse(JSON.stringify(rec));
  if (bogus.decision) bogus.decision.recommendation = 'zzz';
  const bogusCell = boardTool.boardStatusFromRecord(bogus);
  check(`${rec.id}: a recommendation matching NO option is dropped, never badged`,
    !/Recommended:/.test(bogusCell),
    `recommendation "zzz" → badged=${/Recommended:/.test(bogusCell)} (cell ${bogusCell.length} chars, real cell badges "${(cell.match(/Recommended: \S+/) ?? ['none'])[0]}")`);
}

/* ═══════════ C. every LEGACY row is byte-identical across the regeneration */

console.log('\n=== C. a legacy ticket\'s curated prose is untouched ===');
{
  /**
   * NO GIT BASELINE HERE, ON PURPOSE — and this block previously had one.
   *
   * It compared the generated INDEX against `git show HEAD:scripts/board.mjs`'s
   * output. That passed while the fix was uncommitted and went red the instant it
   * committed, because HEAD BECAME the fixed state: the two generators were then
   * the same program, no row differed, and the anti-vacuity check ("the promoted
   * row DID change") correctly reported that the comparison had stopped comparing
   * anything. Exactly the trap docs/CONVENTIONS.md names, written into the suite
   * that was supposed to respect it; the guard caught it, which is why the guard
   * was there.
   *
   * The anchor is now a PROPERTY, not a revision: the pre-change rule for every
   * ticket was `boardStatusFromHeader(statusRaw)`, and that function is still live
   * and is still exactly what a legacy ticket must get. So every legacy Open row is
   * asserted against it directly. That reference cannot move, and the assertion is
   * not vacuous — it fails the moment `gen` composes anything for a legacy ticket.
   *
   * The HEAD-vs-now comparison is not lost: verify-unmappable-status.mjs owns it,
   * and block E asserts that guard still passes.
   */
  const promotedIds = new Set(promoted.map((t) => JSON.parse(extractTicketBlock(t.text).block).id));
  const tickets = boardTool.readTickets(genBugs).tickets;
  const wrong = [];
  let checked = 0;
  for (const [id, line] of rowsAfter) {
    if (promotedIds.has(id)) continue;
    const t = tickets.get(id);
    if (!t) continue;
    checked++;
    const cell = line.split('|')[4]?.trim() ?? '';
    const fromHeader = boardTool.boardStatusFromHeader(t.statusRaw);
    if (cell !== fromHeader) wrong.push(`${id}: ${JSON.stringify(cell.slice(0, 40))} != ${JSON.stringify(fromHeader.slice(0, 40))}`);
  }
  /*
   * The floor here was `checked >= 10`. That was a fair non-vacuity guard while
   * the board was ~190 legacy tickets, but the cutover left exactly TWO legacy
   * tickets by decision (BUG-125 and FEAT-091), only one of which is open — so
   * the floor became not merely red but UNSATISFIABLE, and no amount of correct
   * behaviour could ever turn it green again. A floor that the design forbids
   * meeting is not a guard.
   *
   * The population is now discovered, and the vacuity risk it existed to cover
   * is handled properly: a SYNTHESIZED legacy Open row is graded alongside the
   * real ones, so the property keeps a subject even if the last legacy ticket
   * closes. The real rows are still graded and still reported by count — the
   * synthetic one is a floor, not a replacement.
   */
  check('there ARE legacy Open rows to check, or the count is stated plainly',
    checked >= 1, `${checked} real legacy Open row(s): ${[...rowsAfter.keys()].filter((id) => !promotedIds.has(id)).join(', ') || '(none)'}`);

  {
    // A legacy ticket built here, not found — declared synthetic on purpose. It
    // guarantees this property is exercised no matter what the real board holds.
    const synthDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug123-synth-'));
    const synthBugs = path.join(synthDir, 'docs', 'bugs');
    fs.mkdirSync(synthBugs, { recursive: true });
    for (const f of fs.readdirSync(genBugs)) {
      const src = path.join(genBugs, f);
      if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(synthBugs, f));
    }
    const prose = 'Held open pending a decision on the adapter, and not a word of this is composed by gen.';
    fs.writeFileSync(path.join(synthBugs, 'BUG-901-a-synthesized-legacy-open-ticket.md'),
      `# BUG-901 — A synthesized legacy ticket\n\n- **Status:** OPEN ${prose}\n- **Severity:** low\n\n## Symptom\n\nSynthetic fixture for verify:bug-123 section C.\n`);
    try {
      boardTool.genBoard(synthBugs);
      const synthRows = openRows(fs.readFileSync(path.join(synthBugs, 'INDEX.md'), 'utf8'));
      const line = synthRows.get('BUG-901');
      const synthCell = line?.split('|')[4]?.trim() ?? '';
      const synthTicket = boardTool.readTickets(synthBugs).tickets.get('BUG-901');
      check('SYNTHETIC legacy row: gen reproduces its prose Status header exactly, composing nothing',
        Boolean(line) && synthCell === boardTool.boardStatusFromHeader(synthTicket.statusRaw) && synthCell.includes(prose),
        JSON.stringify(synthCell.slice(0, 80)));
    } finally { fs.rmSync(synthDir, { recursive: true, force: true }); }
  }
  check(`all ${checked} legacy Open rows are EXACTLY their own prose Status header — gen paraphrases nothing`,
    wrong.length === 0, wrong.length ? wrong.slice(0, 3).join(' | ') : `${checked}/${checked} verbatim`);
  // Non-vacuity from the other side: the promoted row must NOT equal that rule,
  // or this block would pass with the fix reverted.
  const promotedWrong = [];
  for (const id of promotedIds) {
    const line = rowsAfter.get(id);
    if (!line) continue;
    const cell = line.split('|')[4]?.trim() ?? '';
    if (cell === boardTool.boardStatusFromHeader(tickets.get(id).statusRaw)) promotedWrong.push(id);
  }
  check('…and every promoted row is NOT that rule (else C would pass with the fix reverted)',
    promotedWrong.length === 0 && promotedIds.size >= 1,
    promotedWrong.length ? `still bare: ${promotedWrong.join(', ')}` : `${promotedIds.size} promoted row(s) composed instead`);
}

/* ═══ D. gen is IDEMPOTENT, and board:check still passes on the regenerated board */

console.log('\n=== D. regeneration is stable and stays green ===');
{
  boardTool.genBoard(genBugs);
  const twice = fs.readFileSync(path.join(genBugs, 'INDEX.md'), 'utf8');
  check('a second board:gen changes nothing (the composed cell is stable, not re-composed differently)',
    twice === generated, `${generated.length} vs ${twice.length} bytes`);
  const chk = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'board.mjs'), 'check', `--dir=${genBugs}`],
    { cwd: ROOT, encoding: 'utf8' });
  const fails = chk.stdout.split('\n').filter((l) => l.startsWith('  FAIL'));
  check('board:check on the regenerated real board: exit 0, zero FAILs',
    chk.status === 0 && fails.length === 0, `exit=${chk.status}, ${fails.length} FAIL(s)${fails.length ? ` → ${fails[0].slice(0, 110)}` : ''}`);
}
/* ═══ F. the composed cell REACHES the surface a person reads */

console.log('\n=== F. the cell reaches the ticket API, whole ===');
{
  // The INDEX cell is what the ticket dashboard renders in its Status column
  // (`TicketSummary.boardStatus`, read from the Open row). Asserted against a
  // real server over the regenerated scratch board — the real board is never
  // regenerated here, so this is the only place the composed cell exists yet.
  //
  // The BROWSER leg is not repeated: BUG-122's run already captured this exact
  // field rendering verbatim in the All-tickets Status column
  // (docs/bugs/assets/BUG-122-after-all-tickets.png), so what is unproven here is
  // the value, not the rendering.
  const net = await import('node:net');
  const port = await new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
  const { spawn } = await import('node:child_process');
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bug123-data-'));
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'bug123-store-'));
  const srv = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      try { await fetch(`${base}/api/health`); up = true; } catch { await sleep(250); }
    }
    if (!up) throw new Error('scratch server never became healthy');
    const reg = await (await fetch(`${base}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostPath: genDir, name: 'BUG-123 regenerated board' }),
    })).json();
    const pid = reg.project?.id;
    const list = await (await fetch(`${base}/api/projects/${encodeURIComponent(pid)}/tickets`)).json();
    /*
     * The second check here used to require every promoted ticket's API status
     * to match /Recommended:|NEEDS A HUMAN DECISION/. That is a property of a
     * DECISION-BEARING ticket, not of a promoted one, and it held only while the
     * board's two promoted tickets both happened to carry decisions. After the
     * cutover, nine promoted tickets on the Open table have no decision block —
     * BUG-111, BUG-113, BUG-114, BUG-117, BUG-118, BUG-126, FEAT-090, FEAT-093,
     * FEAT-094 — and each was reported as a failure with nothing wrong with it.
     *
     * "Not flattened" is anchored to the same reference block B uses: the
     * PRE-CHANGE rule, `boardStatusFromHeader(statusRaw)`, which is still live
     * and is still what a legacy ticket must get. The decision wording is
     * asserted only on the tickets that actually declare a decision.
     */
    const apiTickets = boardTool.readTickets(genBugs).tickets;
    let decisionBearing = 0;
    for (const { rec } of gradable) {
      const row = (list.tickets ?? []).find((x) => x.id === rec.id);
      const expected = rowsAfter.get(rec.id)?.split('|')[4]?.trim() ?? '';
      if (!expected) continue;
      const got = String(row?.boardStatus ?? '');
      check(`API: ${rec.id}'s Status column carries the composed cell, whole`,
        row?.boardStatus === expected, JSON.stringify(got.slice(0, 80)));

      const preChange = boardTool.boardStatusFromHeader(apiTickets.get(rec.id).statusRaw);
      check(`API: ${rec.id}'s Status column is NOT the flattened pre-change value`,
        got.trim() !== preChange.trim() && got.length > preChange.length,
        `${got.length} chars vs pre-change ${JSON.stringify(preChange)}`);

      const opts = Array.isArray(rec.decision?.options) ? rec.decision.options : [];
      if (opts.length >= 2) {
        decisionBearing++;
        check(`API: ${rec.id} declares a decision, so the API says a human must choose`,
          /NEEDS A HUMAN DECISION/.test(got), JSON.stringify(got.slice(0, 60)));
      }
    }
    check('API: at least one graded ticket was decision-bearing (else the decision wording is never exercised)',
      decisionBearing > 0, `${decisionBearing} decision-bearing of ${gradable.length} graded`);
  } finally {
    try { process.kill(srv.pid, 'SIGTERM'); } catch { /* gone */ }
    await sleep(1000);
    for (const d of [DATA, STORE]) fs.rmSync(d, { recursive: true, force: true });
  }
}
fs.rmSync(genDir, { recursive: true, force: true });

/* ═══ E. this change and verify-unmappable-status's guard must AGREE */

console.log('\n=== E. the neighbouring guard agrees rather than being defeated ===');
{
  // That guard asserts the generated INDEX matches HEAD's EXCEPT on promoted
  // tickets' own rows. This change alters exactly one promoted row, so the guard
  // must still pass — if it went red, one of the two would be silently wrong.
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'verify-unmappable-status.mjs')],
    { cwd: ROOT, encoding: 'utf8', timeout: 900_000 });
  const line = (r.stdout ?? '').split('\n').find((l) => /except on PROMOTED tickets/.test(l)) ?? '(check not found)';
  check('verify-unmappable-status\'s narrowed board:gen guard still PASSES',
    /^PASS/.test(line.trim()), line.trim().slice(0, 150));
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail}`);
if (fail) console.log(`failures:\n  - ${failures.join('\n  - ')}`);
process.exit(fail === 0 ? 0 : 1);
