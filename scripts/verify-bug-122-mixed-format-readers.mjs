/**
 * BUG-122 — every server-side reader and `board:check` must describe a ticket
 * correctly whether or not it has been promoted to the record format.
 *
 *   node scripts/verify-bug-122-mixed-format-readers.mjs
 *   node scripts/verify-bug-122-mixed-format-readers.mjs --no-ui   # skip the browser leg
 *
 * EVERYTHING HERE RUNS AGAINST THE REAL BOARD (docs/CONVENTIONS.md "test against
 * the real artifact"): the real `docs/bugs/`, the real promoted ticket, real
 * legacy tickets, the real server on a free port, the real page in a real
 * browser. Nothing about the board is written — the ticket API's read path is
 * read-only by contract and this suite never posts.
 *
 * INVARIANTS, not today's values. The promoted ticket is DISCOVERED at runtime
 * (whichever files open with a ```orchard-ticket fence), never named, so this
 * suite keeps working as the other 191 tickets are promoted — and it FAILS
 * LOUDLY if the board contains no ticket of either kind, because a suite that
 * finds nothing to check and reports success proves nothing.
 *
 * THE MUST-FAIL ANCHOR is a SYNTHESIZED pre-fix state, not `HEAD`: the pre-fix
 * readers all called `parseTicket(text, { mode: 'compat' })`, and that mode is
 * still there, still doing exactly what it did. So block D re-runs the old call
 * against the real promoted ticket and asserts it still produces the reported
 * symptom (a fence-marker title, MALFORMED H1, MISSING STATUS FIELD). Committing
 * the fix cannot turn that green, which is the whole point.
 *
 * Ports are OS-assigned; never 4317. Processes are killed by PID, never pkill.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';

import {
  parseTicket, extractTicketBlock, classifyLegacyStatus, isDoneWorkState,
  WORK_STATES, WORK_STATE_STATUS_WORD, TICKET_FILE_RE,
} from '../scripts/lib/ticket-schema.mjs';

const ARGS = process.argv.slice(2);
const NO_UI = ARGS.includes('--no-ui');
const ROOT = path.resolve(import.meta.dirname, '..');
const BUGS = path.join(ROOT, 'docs', 'bugs');
const SHOTS = path.join(BUGS, 'assets');
const BRAVE = process.env.VERIFY_BROWSER ?? 'brave';

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ══════════════════════════════════════════ the real board, split by format */

/** Every real ticket file, read once. */
const files = fs.readdirSync(BUGS).filter((f) => TICKET_FILE_RE.test(f)).sort();
const real = files.map((f) => ({ file: f, text: fs.readFileSync(path.join(BUGS, f), 'utf8') }));
const promoted = real.filter((t) => extractTicketBlock(t.text).block !== null);
const legacy = real.filter((t) => extractTicketBlock(t.text).block === null);

console.log(`\n=== A. the real board (${ROOT}/docs/bugs) ===`);
check('the board has at least one ticket in the RECORD format (else this suite proves nothing)',
  promoted.length >= 1, `${promoted.length} promoted: ${promoted.map((t) => t.file.slice(0, 9)).join(', ') || '(none)'}`);
check('the board has at least one ticket in the LEGACY format (the unchanged-behaviour half)',
  legacy.length >= 1, `${legacy.length} legacy of ${real.length} total`);
if (!promoted.length || !legacy.length) {
  console.log('\nABORT: the real board cannot exercise a MIXED board. Not a pass.');
  process.exit(1);
}

/* ══════════════════════════════════ B. the shared reader, both formats */

console.log('\n=== B. parseTicket: one shape, both formats ===');

// The status WORD a record's work_state is stated as must classify BACK to the
// same work_state, or a mixed board sorts and places its two halves by two rules.
{
  const bad = WORK_STATES.filter((w) => {
    const word = WORK_STATE_STATUS_WORD[w];
    const cls = classifyLegacyStatus(word);
    return !word || cls.workState !== w || cls.done !== isDoneWorkState(w);
  });
  check('every work_state round-trips through its legacy status word (7/7)',
    bad.length === 0, bad.length ? `broken: ${bad.join(', ')}` : WORK_STATES.map((w) => `${w}→${WORK_STATE_STATUS_WORD[w]}`).join(' '));
}

for (const t of promoted) {
  const id = t.file.slice(0, t.file.indexOf('-', t.file.indexOf('-') + 1));
  const record = JSON.parse(extractTicketBlock(t.text).block);
  const s = parseTicket(t.text, { file: t.file, mode: 'auto', requireEmDash: true }).summary;
  check(`${id}: summary title === the record's own title field (whatever it currently is)`,
    s.title === record.title, `summary=${JSON.stringify(s.title)} record=${JSON.stringify(record.title)}`);
  check(`${id}: the title is NEVER a fence marker`,
    typeof s.title === 'string' && !s.title.includes('```') && !/orchard-ticket/.test(s.title), JSON.stringify(s.title));
  check(`${id}: no statusError — the state IS readable from the record`,
    s.statusError === null && s.statusMatched === true, `statusError=${JSON.stringify(s.statusError)} matched=${s.statusMatched}`);
  check(`${id}: work_state / done mirror the record`,
    s.work_state === record.work_state && s.done === isDoneWorkState(record.work_state),
    `work_state=${s.work_state} done=${s.done} (record ${record.work_state})`);
  check(`${id}: severity comes off the record`,
    s.severity === (record.severity === 'not_recorded' ? null : record.severity),
    `summary=${JSON.stringify(s.severity)} record=${JSON.stringify(record.severity)}`);
  check(`${id}: area comes off the record`, s.area === record.area, JSON.stringify(s.area));
}

// A legacy file's reading must be IDENTICAL to the pre-fix one. The pre-fix
// reading is `mode: 'compat'` — the exact argument the old call sites passed.
{
  const diffs = [];
  for (const t of legacy) {
    const before = parseTicket(t.text, { file: t.file, mode: 'compat', requireEmDash: true }).record;
    const after = parseTicket(t.text, { file: t.file, mode: 'auto', requireEmDash: true }).summary;
    if (JSON.stringify(before) !== JSON.stringify(after)) diffs.push(t.file);
  }
  check(`all ${legacy.length} legacy tickets read IDENTICALLY to the pre-fix (compat) path`,
    diffs.length === 0, diffs.length ? `differ: ${diffs.slice(0, 5).join(', ')}` : `${legacy.length}/${legacy.length} byte-identical records`);
}

/* ══════════════════════════════════ C. the server's own readers */

console.log('\n=== C. the server readers (imported, real board) ===');
const { listTickets, readTicket } = await import('../src/server/tickets.ts');
const { readBoard } = await import('../src/server/board.ts');

const listed = listTickets(ROOT);
check('listTickets reads the real board', listed.hasBoard && listed.tickets.length === real.length,
  `hasBoard=${listed.hasBoard} tickets=${listed.tickets.length} files=${real.length}`);

for (const t of promoted) {
  const record = JSON.parse(extractTicketBlock(t.text).block);
  const row = listed.tickets.find((x) => x.id === record.id);
  check(`API list row for ${record.id}: title === the record's title`,
    !!row && row.title === record.title, `row.title=${JSON.stringify(row?.title)}`);
  check(`API list row for ${record.id}: no MISSING STATUS FIELD badge, status is a real word`,
    !!row && row.statusError === null && /\S/.test(row.status ?? ''),
    `statusError=${JSON.stringify(row?.statusError)} status=${JSON.stringify(row?.status)}`);
  const detail = readTicket(ROOT, record.id);
  check(`API detail for ${record.id}: same title as the list (one reader, one answer)`,
    detail.title === record.title && detail.markdown === t.text,
    `title=${JSON.stringify(detail.title)} markdown bytes=${detail.markdown.length}`);
  // The rail (src/server/board.ts) describes the same ticket from the INDEX row.
  const board = readBoard(ROOT);
  const onRail = [...(board.needsYou ?? []), ...(board.answeredAwaiting ?? []), ...(board.inflight ?? []),
    ...(board.queued ?? []), ...(board.doneToday ?? [])].find((i) => i.id === record.id);
  check(`rail entry for ${record.id}: title === the record's title (or the ticket is on no lane)`,
    !onRail || onRail.title === record.title, onRail ? JSON.stringify(onRail.title) : '(on no rail lane)');
}

// A legacy ticket's API row must be unchanged: assert it against the pre-fix
// (compat) reading of the same file, field by field.
{
  const diffs = [];
  for (const t of legacy) {
    const before = parseTicket(t.text, { file: t.file, mode: 'compat', requireEmDash: true }).record;
    const row = listed.tickets.find((x) => x.id === before.id);
    if (!row) { diffs.push(`${t.file}: not listed`); continue; }
    const expectTitle = before.title ?? (t.text.split('\n', 1)[0] ?? before.id).replace(/^#\s*/, '');
    if (row.title !== expectTitle) diffs.push(`${t.file}: title`);
    if (row.status !== before.statusRaw) diffs.push(`${t.file}: status`);
    if (row.section !== (before.done ? 'done' : 'open')) diffs.push(`${t.file}: section`);
    if (row.statusError !== before.statusError) diffs.push(`${t.file}: statusError`);
  }
  check(`all ${legacy.length} legacy API rows match the pre-fix reading exactly`,
    diffs.length === 0, diffs.length ? diffs.slice(0, 5).join(' | ') : `${legacy.length}/${legacy.length} unchanged`);
}

/* ══════════════════════ D. MUST-FAIL, anchored to a synthesized pre-fix state */

console.log('\n=== D. must-FAIL: the pre-fix reader still reproduces the symptom ===');
for (const t of promoted) {
  const record = JSON.parse(extractTicketBlock(t.text).block);
  const pre = parseTicket(t.text, { file: t.file, mode: 'compat', requireEmDash: true });
  const preTitle = pre.record.title ?? (t.text.split('\n', 1)[0] ?? '').replace(/^#\s*/, '');
  check(`${record.id}: the PRE-FIX (compat) reader still shows the fence as the title`,
    preTitle.includes('orchard-ticket'), JSON.stringify(preTitle));
  check(`${record.id}: the PRE-FIX reader still emits MALFORMED H1 + MISSING STATUS FIELD`,
    pre.errors.some((e) => e.startsWith('MALFORMED H1')) && pre.errors.some((e) => e.startsWith('MISSING STATUS FIELD')),
    pre.errors.join(' | ').slice(0, 160));
  const post = parseTicket(t.text, { file: t.file, mode: 'auto', requireEmDash: true });
  check(`${record.id}: the FIXED reader emits neither of those errors`,
    !post.errors.some((e) => /^MALFORMED H1|^MISSING STATUS FIELD/.test(e)),
    post.errors.length ? post.errors.join(' | ').slice(0, 200) : '(no errors)');
}

/* ══════════════════════ E. board:check on the real board */

console.log('\n=== E. board:check on the real board ===');
{
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'board.mjs'), 'check', `--dir=${BUGS}`],
    { cwd: ROOT, encoding: 'utf8' });
  const fails = r.stdout.split('\n').filter((l) => l.startsWith('  FAIL'));
  // ONE family is excluded: the INDEX ROW-PLACEMENT classes. `INDEX.md` is
  // orchestrator-owned (docs/bugs/README.md) and regenerated by them, so a
  // freshly filed ticket, or one another lane just resolved, sits in this state
  // until they run `board:gen` — and a suite that reddens on that is a suite
  // that reddens on people following the process. Every excluded line is
  // PRINTED, so the exception can never quietly hide one.
  //
  // It cannot hide a defect of THIS ticket either: the check below asserts,
  // with no exclusions at all, that no FAIL of ANY class names a record-format
  // file — which is precisely where a mis-read promotion would surface.
  const ROW_PLACEMENT = /MISSING FROM BOARD|STATUS MISMATCH|STALE OWNER|DUPLICATE:|ORPHAN INDEX ROW/;
  const rowPending = fails.filter((l) => ROW_PLACEMENT.test(l));
  const realFails = fails.filter((l) => !ROW_PLACEMENT.test(l));
  check('board:check finds NO drift on the real board, beyond INDEX rows the orchestrator owns',
    realFails.length === 0,
    `exit=${r.status}; ${realFails.length} real FAIL(s)${realFails.length ? ` → ${realFails[0].slice(0, 120)}` : ''}` +
    `; ${rowPending.length} awaiting an INDEX regen${rowPending.length ? ` → ${rowPending.map((l) => l.slice(8, 52)).join(' | ')}` : ''}`);
  const aboutPromoted = fails.filter((l) => promoted.some((t) => l.includes(t.file)));
  check('no FAIL names a record-format ticket file',
    aboutPromoted.length === 0, aboutPromoted.slice(0, 2).join(' | ') || '(none)');
}

/* ══ F. PARTIAL / TRUNCATED writes — the state a bulk promotion is interrupted in */

console.log('\n=== F. truncated & corrupted promotions stay LISTABLE and LOUD ===');
{
  // Take the REAL promoted ticket and cut it at plausible points: a race is a
  // timing, not a shape, and 191 more files are about to be rewritten in place.
  const src = promoted[0];
  const blk = extractTicketBlock(src.text);
  const rec0Title = JSON.parse(blk.block).title;
  const fenceEnd = src.text.indexOf('\n```', src.text.indexOf('```orchard-ticket'));
  //
  // `complete` = the closing fence survived the cut, so the RECORD is whole and
  // only the prose body is short. That file is not damaged in any way a reader
  // can see — the record IS the human layer — so the invariant flips: it must
  // read CORRECTLY rather than be reported. A cut before the closing fence
  // leaves no readable record, and must be reported.
  const cuts = [
    ['just the opening fence', src.text.indexOf('\n') + 1, false],
    ['mid-JSON (a third in)', Math.floor(blk.block.length / 3) + 20, false],
    ['all of the JSON, no closing fence', fenceEnd, false],
    ['through the closing fence, no body', src.text.indexOf('\n', fenceEnd + 1) + 1, true],
    ['record whole, body cut mid-sentence', Math.floor((src.text.length + fenceEnd) / 2), true],
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug120-trunc-'));
  const bugs = path.join(dir, 'docs', 'bugs');
  fs.mkdirSync(bugs, { recursive: true });
  // A realistic mixed board: the truncated promotion, plus REAL legacy tickets,
  // and a real INDEX built by the board tool itself (a check with no INDEX only
  // proves the tool can fail to open a file).
  for (const t of legacy.slice(0, 3)) fs.writeFileSync(path.join(bugs, t.file), t.text);
  fs.writeFileSync(path.join(bugs, 'INDEX.md'), [
    '# Board', '', '## Open', '',
    '| ID | Title | Owner | Status | Sev |', '|----|-------|-------|--------|-----|', '',
    '## Done (committed)', '', '| ID | Title | Commit |', '|----|-------|--------|', '',
    '## Shipped', '',
  ].join('\n'));
  const boardRun = (cmd) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'board.mjs'), cmd, `--dir=${bugs}`],
    { cwd: ROOT, encoding: 'utf8' });
  try {
    for (const [label, at, complete] of cuts) {
      const cut = src.text.slice(0, at);
      fs.writeFileSync(path.join(bugs, src.file), cut);
      let listedT = null, threw = null;
      try { listedT = listTickets(dir); } catch (e) { threw = e.message; }
      const row = listedT?.tickets.find((x) => src.file.startsWith(x.id));
      check(`truncated ${label}: the list does not throw and still shows the row`,
        !threw && !!row, threw ? `THREW ${threw}` : `id=${row?.id} title=${JSON.stringify(row?.title ?? null).slice(0, 60)}`);
      if (complete) {
        check(`truncated ${label}: the record survived, so the row reads CORRECTLY (no invented error)`,
          !!row && row.title === rec0Title && row.statusError === null,
          `title=${JSON.stringify(row?.title)} statusError=${JSON.stringify(row?.statusError)}`);
      } else {
        check(`truncated ${label}: no readable record, so the damage is REPORTED (statusError)`,
          !!row?.statusError, `statusError=${JSON.stringify(row?.statusError ?? null).slice(0, 110)}`);
      }
      boardRun('gen');
      const r = boardRun('check');
      const named = r.stdout.split('\n').filter((l) => l.startsWith('  FAIL') && l.includes(src.file));
      check(`truncated ${label}: board:check runs to a verdict, no stack trace`,
        (r.status === 0 || r.status === 1) && !/TypeError|Cannot read|ENOENT/.test(r.stderr ?? ''),
        `exit=${r.status} stderr=${(r.stderr || '(empty)').slice(0, 80)}`);
      check(`truncated ${label}: board:check ${complete ? 'stays silent about a whole record' : 'names the damaged file'}`,
        complete ? named.length === 0 : named.length > 0, named.slice(0, 1).join('').slice(0, 120) || '(no FAIL names it)');
    }
    // Block closed, JSON corrupt (an editor mangles it, a merge lands badly).
    const corrupt = src.text.replace(/"id":/, '"id" ');
    fs.writeFileSync(path.join(bugs, src.file), corrupt);
    const l = listTickets(dir);
    const row = l.tickets.find((x) => src.file.startsWith(x.id));
    check('corrupt JSON in a closed block: listed, and the parse failure is on the row',
      !!row && /MALFORMED TICKET BLOCK/.test(row.statusError ?? ''), `statusError=${JSON.stringify(row?.statusError ?? null).slice(0, 110)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ═══ H. the DECISION — a promoted ticket must still reach the Needs-You rail */

console.log('\n=== H. a promoted ticket\'s decision still reaches a human ===');
const { ticketDecision } = await import('../src/server/board.ts');

// Discovered at runtime, never named: whichever promoted tickets carry a
// decision in their record. Fail loudly if none does — then this block proves
// nothing and that is itself worth knowing.
const withDecision = promoted
  .map((t) => ({ ...t, rec: JSON.parse(extractTicketBlock(t.text).block ?? 'null') }))
  .filter((t) => t.rec && t.rec.decision && Array.isArray(t.rec.decision.options) && t.rec.decision.options.length >= 2);
check('the board has a RECORD-format ticket that carries a decision (else H proves nothing)',
  withDecision.length >= 1, `${withDecision.length} of ${promoted.length} promoted ticket(s) carry a decision`);

for (const t of withDecision) {
  const d = t.rec.decision;
  const parsedD = ticketDecision(t.text);
  check(`${t.rec.id}: the decision is FOUND (it was invisible the moment the ticket was promoted)`,
    !!parsedD, parsedD ? `${parsedD.options.length} options` : 'null — no Decide card would render');
  check(`${t.rec.id}: every option the record authored is offered, in order, by key`,
    !!parsedD && JSON.stringify(parsedD.options.map((o) => o.key)) === JSON.stringify(d.options.map((o) => o.key)),
    JSON.stringify(parsedD?.options.map((o) => o.key)));
  check(`${t.rec.id}: labels are the record's own, and each option carries a description`,
    !!parsedD && parsedD.options.every((o, i) => o.label === String(d.options[i].label).replace(/\.$/, '') && o.description.length > 0),
    JSON.stringify(parsedD?.options.map((o) => `${o.label} (${o.description.length}c)`)));
  check(`${t.rec.id}: the question is the record's own (or the title, flagged — never empty)`,
    !!parsedD && parsedD.question.trim().length > 0
      && (d.question ? parsedD.question === d.question : parsedD.questionFromTitle === true),
    JSON.stringify(parsedD?.question));
  check(`${t.rec.id}: the recommendation is the record's, validated against real keys`,
    !!parsedD && parsedD.recommended === (d.options.some((o) => o.key === d.recommendation) ? d.recommendation : null),
    `parsed=${JSON.stringify(parsedD?.recommended)} record=${JSON.stringify(d.recommendation)}`);

  // MUST-FAIL, anchored to a SYNTHESIZED pre-fix state: the pre-fix parser was
  // the two PROSE shapes, and prose is exactly the ticket's body with the record
  // removed. That reference is a property of the file, not of a revision, so
  // committing the fix can never turn it green.
  const bodyOnly = extractTicketBlock(t.text).body;
  check(`${t.rec.id}: the PRE-FIX (prose-only) parser still finds NOTHING — the silence this fixes`,
    ticketDecision(bodyOnly) === null, JSON.stringify(ticketDecision(bodyOnly)));
  // …and the pre-fix board:check TRIGGER could not have fired either, so the
  // guard was not merely wrong — it had stopped looking.
  const DECLARED = /\b(?:needs?|need|needed|awaiting|await|pending|requires?|required|wants?)\b[^.;]{0,60}?\bdecisions?\b|\bdecisions?\b[^.;]{0,40}?\b(?:needed|required|pending|outstanding)\b/i;
  const OPTS_H2 = /^##\s+(?:.*\bdecisions?\b.*|options\b.*|.*\boptions\b.*)$/i;
  const preStatus = parseTicket(t.text, { file: t.file, mode: 'compat', requireEmDash: true }).record.statusRaw;
  check(`${t.rec.id}: the PRE-FIX board:check trigger was blind to it (no prose status, no options H2)`,
    !DECLARED.test(preStatus || '') && !t.text.split('\n').some((l) => OPTS_H2.test(l.trim())),
    `statusRaw=${JSON.stringify(preStatus)} optionsHeading=${t.text.split('\n').some((l) => OPTS_H2.test(l.trim()))}`);
}

// Legacy is protected by CONSTRUCTION (a file with no record block never enters
// the new branch) — asserted in block B — but state it here too, on a real
// legacy ticket that genuinely carries a prose decision, discovered at runtime.
{
  const legacyDecisions = legacy
    .map((t) => ({ file: t.file, d: ticketDecision(t.text) }))
    .filter((x) => x.d && x.d.options.length >= 2);
  check('a real LEGACY ticket still yields its prose decision, unchanged (else this half proves nothing)',
    legacyDecisions.length >= 1,
    `${legacyDecisions.length} legacy ticket(s) with ≥2 parsed options, e.g. ${legacyDecisions[0]?.file.slice(0, 9)} → ${JSON.stringify(legacyDecisions[0]?.d.options.map((o) => o.key))}`);
}

/* ══ I. board:check's decision-shape guard TRIGGERS AGAIN, on the record format */

console.log('\n=== I. the decision-shape guard, on a promoted ticket ===');
{
  const src = withDecision[0];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug122-guard-'));
  const bugs = path.join(dir, 'docs', 'bugs');
  fs.mkdirSync(bugs, { recursive: true });
  // A REALISTIC-STATE board built from real artifacts: the real promoted ticket
  // plus three real legacy tickets, and an INDEX the board tool generates. The
  // ticket under test is a COPY — the real board is never written to.
  for (const t of legacy.slice(0, 3)) fs.writeFileSync(path.join(bugs, t.file), t.text);
  fs.writeFileSync(path.join(bugs, 'INDEX.md'), [
    '# Board', '', '## Open', '',
    '| ID | Title | Owner | Status | Sev |', '|----|-------|-------|--------|-----|', '',
    '## Done (committed)', '', '| ID | Title | Commit |', '|----|-------|--------|', '',
    '## Shipped', '',
  ].join('\n'));
  const run = (cmd) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'board.mjs'), cmd, `--dir=${bugs}`],
    { cwd: ROOT, encoding: 'utf8' });
  const needsYouRow = (id) => {
    const p = path.join(bugs, 'INDEX.md');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(new RegExp(`^\\| ${id} \\| ([^|]*)\\| [^|]*\\|`, 'm'), `| ${id} | $1| 👤 |`));
  };
  try {
    // (a) the healthy promoted ticket: the guard inspects it and is SATISFIED.
    fs.writeFileSync(path.join(bugs, src.file), src.text);
    run('gen'); needsYouRow(src.rec.id);
    let r = run('check');
    check('(a) a promoted ticket with a well-formed record decision raises NO decision FAIL',
      !r.stdout.includes('UNPARSEABLE DECISION') && !r.stdout.includes('DECISION NOT ROUTED'),
      (r.stdout.split('\n').filter((l) => /DECISION/.test(l))[0] ?? '(no decision FAIL)').slice(0, 110));

    // (b) MUST-FAIL: break the record decision down to ONE option — not a choice.
    // The guard has to NAME it, or promotion has switched the guard off again.
    const oneOption = { ...src.rec, decision: { ...src.rec.decision, options: [src.rec.decision.options[0]] } };
    const broken = src.text.replace(extractTicketBlock(src.text).block, JSON.stringify(oneOption, null, 2));
    fs.writeFileSync(path.join(bugs, src.file), broken);
    run('gen'); needsYouRow(src.rec.id);
    r = run('check');
    check('(b) MUST-FAIL: one option is not a choice — the guard names the promoted ticket',
      /UNPARSEABLE DECISION: /.test(r.stdout) && r.stdout.includes(src.rec.id) && r.status === 1,
      (r.stdout.split('\n').find((l) => /UNPARSEABLE DECISION/.test(l)) ?? '(guard stayed silent)').slice(0, 140));

    // (c) …and it fires off the RECORD, not off leftover prose: strip the body
    // entirely, so there is no prose in the file at all.
    const recordOnly = extractTicketBlock(broken).raw ?? broken;
    fs.writeFileSync(path.join(bugs, src.file), recordOnly);
    run('gen'); needsYouRow(src.rec.id);
    r = run('check');
    check('(c) the trigger is the RECORD: a body-less promoted ticket is still inspected',
      /UNPARSEABLE DECISION: /.test(r.stdout) && r.stdout.includes(src.rec.id),
      (r.stdout.split('\n').find((l) => /UNPARSEABLE DECISION/.test(l)) ?? '(guard stayed silent)').slice(0, 140));

    // (d) the inverse arm still works on the record format: a real decision that
    // nothing routes to a human (Owner not 👤) is named too.
    fs.writeFileSync(path.join(bugs, src.file), src.text);
    run('gen');
    // `gen` PRESERVES the curated Owner cell it finds, so the 👤 stamped above
    // survives — clear it explicitly rather than assuming a fresh row.
    {
      const p = path.join(bugs, 'INDEX.md');
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(new RegExp(`^\\| ${src.rec.id} \\| ([^|]*)\\| [^|]*\\|`, 'm'), `| ${src.rec.id} | $1| — |`));
    }
    r = run('check');
    check('(d) a parseable record decision on a non-👤 row is reported as NOT ROUTED',
      /DECISION NOT ROUTED: /.test(r.stdout) && r.stdout.includes(src.rec.id),
      (r.stdout.split('\n').find((l) => /DECISION NOT ROUTED/.test(l)) ?? '(not reported)').slice(0, 140));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ══════════════════════════════════════════════════ G. the real UI, real browser */

let server = null, browser = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

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
  async waitFor(label, expr, timeoutMs = 30_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.eval(expr)) return true; } catch { /* mid-navigation */ }
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    const sha = createHash('sha256').update(Buffer.from(r.data, 'base64')).digest('hex').slice(0, 12);
    console.log(`        screenshot → ${file}  (sha256:${sha})`);
    return sha;
  }
  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

async function uiLeg() {
  console.log('\n=== G. the real UI: the All-tickets row for both formats ===');
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bug120-data-'));
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'bug120-store-'));
  const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'bug120-chrome-'));
  const shots = [];
  try {
    server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); }
    }
    if (!up) throw new Error('scratch server never became healthy');

    // The project under test is THIS repo — the real board, read-only.
    const reg = await (await fetch(`${BASE}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostPath: ROOT, name: 'BUG-122 real board' }),
    })).json();
    const pid = reg.project?.id;
    if (!pid) throw new Error(`could not register the real repo: ${JSON.stringify(reg).slice(0, 200)}`);

    const api = await (await fetch(`${BASE}/api/projects/${pid}/tickets`)).json();
    const rec0 = JSON.parse(extractTicketBlock(promoted[0].text).block);
    const apiRow = (api.tickets ?? []).find((t) => t.id === rec0.id);
    check(`HTTP /tickets: ${rec0.id}'s title over the wire === the record's title`,
      apiRow?.title === rec0.title, `${JSON.stringify(apiRow?.title)} (statusError=${JSON.stringify(apiRow?.statusError)})`);

    browser = spawn(BRAVE, [
      '--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
      '--no-first-run', '--disable-extensions', '--window-size=1500,950', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let devPort = 0;
    for (let i = 0; i < 100 && !devPort; i++) {
      try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
    }
    if (!devPort) throw new Error('browser never wrote DevToolsActivePort');
    const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
    const cdp = await Cdp.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    await cdp.send('Page.navigate', { url: `${BASE}/#/tickets/all?project=${encodeURIComponent(pid)}` });
    const listUp = await cdp.waitFor('ticket rows', `document.querySelectorAll('#tvList a.tv-row').length >= 20`);
    check('the All-tickets table renders the real board', listUp,
      await cdp.eval(`document.querySelectorAll('#tvList a.tv-row').length + ' rows'`));

    const rowOf = async (id) => cdp.eval(`(() => {
      const r = [...document.querySelectorAll('#tvList a.tv-row')].find((x) => x.querySelector('.c-id')?.textContent.trim() === ${JSON.stringify(id)});
      if (!r) return null;
      return { id: r.querySelector('.c-id')?.textContent.trim(), title: r.querySelector('.c-title')?.textContent.trim(),
               status: r.querySelector('.c-status')?.textContent.trim() ?? '', text: r.textContent };
    })()`);

    // The RECORD-format row, on screen.
    const recRow = await rowOf(rec0.id);
    check(`UI row ${rec0.id}: the title the USER SEES === the record's title`,
      recRow?.title === rec0.title, JSON.stringify(recRow?.title));
    check(`UI row ${rec0.id}: no fence marker anywhere in the row`,
      !!recRow && !recRow.text.includes('```') && !/orchard-ticket/.test(recRow.text), JSON.stringify(recRow?.title));
    check(`UI row ${rec0.id}: no MISSING STATUS FIELD badge`,
      !!recRow && !/MISSING STATUS FIELD/i.test(recRow.text), recRow?.status || '(no status cell text)');

    // A LEGACY row, on screen, unchanged.
    const legacyPick = legacy.map((t) => parseTicket(t.text, { file: t.file, mode: 'compat', requireEmDash: true }).record)
      .find((r) => r.id && r.title && !r.statusError);
    const legRow = await rowOf(legacyPick.id);
    check(`UI row ${legacyPick.id} (legacy): title still comes from its H1, unchanged`,
      legRow?.title === legacyPick.title, `${JSON.stringify(legRow?.title)} vs H1 ${JSON.stringify(legacyPick.title)}`);
    check(`UI row ${legacyPick.id} (legacy): status still its own Status line`,
      !!legRow && legacyPick.statusRaw.toUpperCase().startsWith((legRow.status || 'ZZZ').split(' ')[0].toUpperCase()),
      `row="${legRow?.status}" file="${legacyPick.statusRaw.slice(0, 40)}"`);

    shots.push(await cdp.shot(path.join(SHOTS, 'BUG-122-all-tickets-mixed-board.png')));

    // The matched AFTER of the before/after pair: the same filtered view the
    // pre-fix capture (BUG-122-before-all-tickets.png) was taken in.
    await cdp.eval(`(() => { const s = document.querySelector('#tvSearch');
      if (s) { s.value = ${JSON.stringify(rec0.id)}; s.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
    await cdp.waitFor('the filtered row', `[...document.querySelectorAll('#tvList a.tv-row')].some((x) => x.querySelector('.c-id')?.textContent.trim() === ${JSON.stringify(rec0.id)})`, 15_000);
    // The list re-lays-out as search snippets arrive, so scroll, settle, scroll
    // again — and then ASSERT the row is on screen. A capture that does not
    // contain the thing it is evidence for is not evidence.
    const scrollToRow = `(() => { const r = [...document.querySelectorAll('#tvList a.tv-row')].find((x) => x.querySelector('.c-id')?.textContent.trim() === ${JSON.stringify(rec0.id)}); r?.scrollIntoView({ block: 'center' }); const b = r?.getBoundingClientRect(); return b ? { top: Math.round(b.top), bottom: Math.round(b.bottom), h: window.innerHeight } : null; })()`;
    await cdp.eval(scrollToRow); await sleep(900);
    const box = await cdp.eval(scrollToRow); await sleep(400);
    check(`the ${rec0.id} row is IN FRAME for the capture`,
      !!box && box.top >= 0 && box.bottom <= box.h, JSON.stringify(box));
    shots.push(await cdp.shot(path.join(SHOTS, 'BUG-122-after-all-tickets.png')));
    await cdp.eval(`(() => { const s = document.querySelector('#tvSearch');
      if (s) { s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); } })()`);

    // A second, DIFFERENT capture: the promoted ticket's detail view.
    await cdp.eval(`(() => { location.hash = ${JSON.stringify(`#/tickets/${rec0.id}?project=${pid}`)}; })()`);
    await cdp.waitFor('detail view', `document.querySelector('#tvDetail .tv-doc')?.dataset.id === ${JSON.stringify(rec0.id)}`, 20_000);
    shots.push(await cdp.shot(path.join(SHOTS, `BUG-122-${rec0.id}-detail.png`)));

    /* ── the Decide card: rendered, and answerable (BUG-122 blocker 3) ── */
    const dec = withDecision[0];
    if (dec) {
      const recD = dec.rec.decision;
      await cdp.eval(`(() => { location.hash = ${JSON.stringify(`#/project/${pid}`)}; })()`);
      await cdp.waitFor('the rail', `!!document.querySelector('#rail, .needs-card') || !!window.__station`, 20_000);
      await cdp.eval(`window.__station?.refreshRail?.(true)`);
      const cardUp = await cdp.waitFor(`the ${dec.rec.id} needs-you card`,
        `!!document.querySelector('.needs-card[data-id="${dec.rec.id}"]')`, 20_000);
      const card = await cdp.eval(`(() => {
        const c = document.querySelector('.needs-card[data-id="${dec.rec.id}"]');
        if (!c) return null;
        return { question: c.querySelector('.nc-question')?.textContent.trim() ?? '',
                 opts: [...c.querySelectorAll('.nc-opts .nc-opt')].map((b) => b.textContent.trim()),
                 title: c.querySelector('.nc-title')?.textContent.trim() ?? '' };
      })()`);
      check(`RAIL: ${dec.rec.id} renders as an ANSWERABLE Decide card, not a read-only row`,
        cardUp && !!card && card.opts.length === recD.options.length,
        JSON.stringify({ opts: card?.opts, question: (card?.question ?? '').slice(0, 60) }));
      check(`RAIL: the buttons are the record's own option labels, in order`,
        !!card && JSON.stringify(card.opts) === JSON.stringify(recD.options.map((o) => String(o.label).replace(/\.$/, ''))),
        JSON.stringify(card?.opts));
      check(`RAIL: the card asks the record's question, not the ticket title`,
        !!card && card.question === recD.question && card.question !== card.title,
        JSON.stringify((card?.question ?? '').slice(0, 80)));
      // Same rule as the list capture: scroll the card into view and ASSERT it
      // is on screen. The DOM assertions above passed on a first attempt whose
      // screenshot showed the rail scrolled past the card — evidence that does
      // not contain its subject.
      const scrollCard = `(() => { const c = document.querySelector('.needs-card[data-id="${dec.rec.id}"]');
        c?.scrollIntoView({ block: 'center' });
        const b = c?.getBoundingClientRect();
        return b ? { top: Math.round(b.top), bottom: Math.round(b.bottom), h: window.innerHeight } : null; })()`;
      await cdp.eval(scrollCard); await sleep(700);
      const cbox = await cdp.eval(scrollCard); await sleep(300);
      check(`RAIL: the ${dec.rec.id} Decide card is IN FRAME for the capture`,
        !!cbox && cbox.top >= 0 && cbox.bottom <= cbox.h, JSON.stringify(cbox));
      shots.push(await cdp.shot(path.join(SHOTS, `BUG-122-${dec.rec.id}-decide-card.png`)));

      // ANSWERABLE, end to end — on a SCRATCH COPY of the real ticket. The real
      // board is never written to; the copy is the real bytes, with real legacy
      // tickets and a board-tool-generated INDEX beside it (a realistic board,
      // not a minimal one).
      const scratchProj = fs.mkdtempSync(path.join(os.tmpdir(), 'bug122-answer-'));
      const sBugs = path.join(scratchProj, 'docs', 'bugs');
      fs.mkdirSync(sBugs, { recursive: true });
      for (const t of legacy.slice(0, 3)) fs.writeFileSync(path.join(sBugs, t.file), t.text);
      fs.writeFileSync(path.join(sBugs, dec.file), dec.text);
      fs.writeFileSync(path.join(sBugs, 'INDEX.md'), [
        '# Board', '', '## Open', '',
        '| ID | Title | Owner | Status | Sev |', '|----|-------|-------|--------|-----|', '',
        '## Done (committed)', '', '| ID | Title | Commit |', '|----|-------|--------|', '',
        '## Shipped', '',
      ].join('\n'));
      spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'board.mjs'), 'gen', `--dir=${sBugs}`], { cwd: ROOT, encoding: 'utf8' });
      const ip = path.join(sBugs, 'INDEX.md');
      fs.writeFileSync(ip, fs.readFileSync(ip, 'utf8')
        .replace(new RegExp(`^\\| ${dec.rec.id} \\| ([^|]*)\\| [^|]*\\|`, 'm'), `| ${dec.rec.id} | $1| 👤 |`));
      const reg2 = await (await fetch(`${BASE}/api/projects`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostPath: scratchProj, name: 'BUG-122 answer copy' }),
      })).json();
      const pid2 = reg2.project?.id;
      const before = fs.readFileSync(path.join(sBugs, dec.file), 'utf8');
      const chosen = recD.options[1].label;
      const ansRes = await fetch(`${BASE}/api/projects/${encodeURIComponent(pid2)}/board/answer`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: dec.rec.id, answer: chosen }),
      });
      const ansBody = await ansRes.json();
      const after = fs.readFileSync(path.join(sBugs, dec.file), 'utf8');
      check('ANSWERABLE: the promoted ticket accepts an answer through the same route the card posts to',
        ansRes.status === 200 && ansBody.ok === true, `${ansRes.status} ${JSON.stringify(ansBody).slice(0, 120)}`);
      check('ANSWERABLE: the answer is APPENDED — every prior byte survives, the chosen label is recorded',
        after.startsWith(before) && after.length > before.length && after.slice(before.length).includes(chosen),
        JSON.stringify(after.slice(before.length).replace(/\n/g, '⏎').slice(0, 120)));
      const board2 = await (await fetch(`${BASE}/api/projects/${encodeURIComponent(pid2)}/board`)).json();
      const answered = (board2.answeredAwaiting ?? []).find((i) => i.id === dec.rec.id);
      check('ANSWERABLE: it then moves to the answered-awaiting lane, carrying the answer',
        !!answered && String(answered.answer ?? '').includes(chosen),
        JSON.stringify({ lane: answered ? 'answeredAwaiting' : 'none', answer: String(answered?.answer ?? '').slice(0, 60) }));
      fs.rmSync(scratchProj, { recursive: true, force: true });
    }

    check('every capture in this run is a DIFFERENT image (a capture that never changed is not a capture)',
      shots.length === 4 && new Set(shots).size === 4, shots.join(' vs '));
    cdp.close();
  } finally {
    stopByPid(browser);
    stopByPid(server);
    await sleep(1200);
    for (const d of [DATA, STORE, PROFILE]) fs.rmSync(d, { recursive: true, force: true });
  }
}

if (!NO_UI) await uiLeg();
else console.log('\n=== G. UI leg SKIPPED (--no-ui) ===');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail}`);
if (fail) console.log(`failures:\n  - ${failures.join('\n  - ')}`);
process.exit(fail === 0 ? 0 : 1);
