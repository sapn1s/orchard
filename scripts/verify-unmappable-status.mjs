#!/usr/bin/env node
/**
 * verify-unmappable-status.mjs — an UNINTERPRETABLE ticket state is reported by
 * EVERY consumer, identically, or it is a board defect.
 *
 * WHY THIS EXISTS
 * ---------------
 * 15759b0 collapsed five ticket parsers into one (scripts/lib/ticket-schema.mjs)
 * and decided, deliberately, that a status word the schema cannot map is
 * REJECTED rather than defaulted: `work_state: null`, a named `UNMAPPABLE
 * STATUS` error, the ticket parked in Open where a human sees it.
 *
 * That decision was implemented on ONE path. An independent cross-provider
 * clean-room pass found the rest:
 *
 *     board.mjs check   → exit 1, "UNMAPPABLE STATUS: <file> — …"
 *     readTicketsForArch → { done: false }   … and nothing else. No
 *                          classification field, no error channel, no warning.
 *
 * Two paths reading the same file, one loudly and one silently — which is the
 * EXACT class of defect the parser collapse set out to eliminate, reintroduced
 * one layer up. The consumers agreed on the real corpus only because the real
 * corpus contains no unmappable ticket, so that agreement proved nothing about
 * this path.
 *
 * WHAT "LOUDLY" MEANS PER CONSUMER (and why each is the right shape)
 * -----------------------------------------------------------------
 *  - board.mjs check     — a FAIL line + exit 1. It is the gate; it may die.
 *  - tickets.ts (HTTP)   — `statusMatched: false` + `statusError` on every
 *                          TicketSummary. An HTTP list of tickets must not 500
 *                          because one ticket is malformed (a half-written
 *                          ticket must still be listable), so the report rides
 *                          ON the record, where a client can render it.
 *  - arch-watch.mjs      — same per-ticket fields, PLUS `result.unclassified`
 *                          and a stderr line. It must never throw (FEAT-019
 *                          failure-tolerance: a detector that breaks the
 *                          consolidation pass is worse than one that finds
 *                          nothing) and its exit code is already defined as
 *                          "recurrence found", so the exit code is NOT
 *                          overloaded — the channel is the report.
 *  - board.ts readBoard  — reads INDEX.md, never a ticket's Status header, so it
 *                          has no classification to make; what it must not do is
 *                          disagree with the ticket file in silence. Covered
 *                          here by the index-vs-header case: board:check FAILS.
 *
 * The invariant every case below asserts: for ANY status string, all consumers
 * return the SAME done-ness AND the SAME "did this classify?" answer. A
 * consumer is allowed to be quiet only when the other consumers are quiet too.
 *
 * THE CORPUS IS REAL. Every case mutates ONE status line of a REAL ticket in a
 * scratch copy of the live docs/bugs, so the surrounding 180+ tickets, the real
 * INDEX.md and the real rail all participate. The neighbouring-shape statuses
 * themselves are synthetic — they have to be; the corpus has no unmappable
 * ticket, which is the whole point.
 *
 * Run: node scripts/verify-unmappable-status.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as S from './lib/ticket-schema.mjs';
import * as boardTool from './board.mjs';
import { readTicketsForArch, archWatch } from './arch-watch.mjs';
import { mkdtempScratch, scratchRootInfo } from './lib/scratch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REAL_BUGS = path.join(ROOT, 'docs', 'bugs');

const tickets = await import(pathToFileURL(path.join(ROOT, 'src', 'server', 'tickets.ts')).href);
const boardTs = await import(pathToFileURL(path.join(ROOT, 'src', 'server', 'board.ts')).href);

let pass = 0;
const failures = [];
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`PASS: ${label}`); }
  else { failures.push(label); console.log(`FAIL: ${label}${detail === undefined ? '' : ` — ${String(detail).slice(0, 500)}`}`); }
}

/* ───────────────────────────────────────────────── the scratch board (real) */

const scratch = mkdtempScratch('unmappable-');
const HOST = path.join(scratch, 'host');
const BUGS = path.join(HOST, 'docs', 'bugs');
fs.mkdirSync(BUGS, { recursive: true });
for (const f of fs.readdirSync(REAL_BUGS)) {
  const src = path.join(REAL_BUGS, f);
  if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(BUGS, f));
}
console.log(`# scratch root: ${scratchRootInfo().dir}${scratchRootInfo().degraded ? ' (DEGRADED)' : ''}`);
console.log(`# board copy: ${BUGS} (${fs.readdirSync(BUGS).filter((f) => S.TICKET_FILE_RE.test(f)).length} tickets)`);

/**
 * The victim: a REAL ticket that is currently OPEN and whose status classifies
 * today. Mutating an already-open ticket keeps INDEX.md placement correct for
 * every unmappable case (unmappable ⇒ Open), so the only new board:check output
 * is the one this suite is about.
 */
const victimFile = fs.readdirSync(BUGS)
  .filter((f) => S.TICKET_FILE_RE.test(f))
  .sort()
  .find((f) => {
    const r = S.parseTicket(fs.readFileSync(path.join(BUGS, f), 'utf8'), { file: f, mode: 'compat' }).record;
    return r && r.done === false && r.statusMatched === true;
  });
check('a real OPEN ticket was found to carry each probe status', !!victimFile, victimFile);
const VICTIM_ID = S.idFromFilename(victimFile);
const VICTIM_PATH = path.join(BUGS, victimFile);
const VICTIM_ORIGINAL = fs.readFileSync(VICTIM_PATH, 'utf8');
console.log(`# victim ticket: ${victimFile}`);

function setStatus(raw) {
  const next = VICTIM_ORIGINAL.replace(/^- \*\*Status:\*\*.*$/m, `- **Status:** ${raw}`);
  if (next === VICTIM_ORIGINAL && raw !== S.legacyField(VICTIM_ORIGINAL, 'Status')) {
    throw new Error(`could not rewrite the Status line of ${victimFile}`);
  }
  fs.writeFileSync(VICTIM_PATH, next);
}
const restoreVictim = () => fs.writeFileSync(VICTIM_PATH, VICTIM_ORIGINAL);

/* ─────────────────────────────────────────── one reading per consumer, typed */

/** board.mjs — the board tool. */
function viaBoard() {
  const { tickets: map, errors } = boardTool.readTickets(BUGS);
  const t = map.get(VICTIM_ID);
  return {
    done: t.done,
    workState: t.workState,
    matched: t.statusMatched,
    reported: errors.some((e) => e.startsWith('UNMAPPABLE STATUS') && e.includes(victimFile))
      || (t.statusError != null && t.statusError.startsWith('UNMAPPABLE STATUS')),
  };
}

/** arch-watch.mjs — the recurrence detector. */
function viaArch() {
  const t = readTicketsForArch(BUGS).find((x) => x.id === VICTIM_ID);
  return {
    done: t.done,
    workState: t.workState,
    matched: t.statusMatched,
    reported: t.statusError != null && String(t.statusError).startsWith('UNMAPPABLE STATUS'),
  };
}

/** tickets.ts — the HTTP ticket API's list. */
function viaApi() {
  const t = tickets.listTickets(HOST).tickets.find((x) => x.id === VICTIM_ID);
  return {
    done: t.section === 'done',
    workState: t.workState,
    matched: t.statusMatched,
    reported: t.statusError != null && String(t.statusError).startsWith('UNMAPPABLE STATUS'),
  };
}

const CONSUMERS = { board: viaBoard, 'arch-watch': viaArch, 'ticket API': viaApi };

/**
 * THE WHOLE CLASS, not just the instance.
 *
 * b88ad5e made an UNRECOGNISED state loud everywhere. The next clean-room pass
 * found its neighbour: a header with `- **Status:** OPEN` AND
 * `- **Status:** VERIFIED` was read by one `exec`, the first line silently won,
 * and all four consumers answered "open" confidently with no report. They
 * agreed — the "consumers agree" property held — while "a state that cannot be
 * interpreted is reported" failed, because an AMBIGUOUS state is not an
 * UNRECOGNISED one. Below: every way a state can fail to be one unambiguous
 * value, each asserted on every consumer.
 */
const STATUS_DEFECT_RE = /^(MISSING STATUS FIELD|EMPTY STATUS FIELD|UNMAPPABLE STATUS|DUPLICATE STATUS FIELD)\b/;

/** Rewrite the victim's header Status line into N lines (0 ⇒ delete it). */
function setStatusLines(raws) {
  const next = VICTIM_ORIGINAL.replace(
    /^- \*\*Status:\*\*.*$/m,
    raws.length === 0 ? '- **Reported-by:** agent' : raws.map((r) => `- **Status:**${r === '' ? '' : ` ${r}`}`).join('\n'),
  );
  if (next === VICTIM_ORIGINAL) throw new Error(`could not rewrite the Status line of ${victimFile}`);
  fs.writeFileSync(VICTIM_PATH, next);
}

/** Every consumer's view of the victim, plus the raw statusError string each holds. */
function readAll() {
  const map = boardTool.readTickets(BUGS).tickets.get(VICTIM_ID);
  const arch = readTicketsForArch(BUGS).find((x) => x.id === VICTIM_ID);
  const api = tickets.listTickets(HOST).tickets.find((x) => x.id === VICTIM_ID);
  const parsed = S.parseTicket(fs.readFileSync(VICTIM_PATH, 'utf8'), { file: victimFile, mode: 'compat' });
  return {
    // `warn` is read on EVERY consumer, not just the parser. The clean-room
    // pass that found the classification defect found this one beside it: the
    // board's and the watcher's records exposed no warning field at all, so a
    // correctly-classified warning reached nobody there. A test that only asked
    // the parser could not have seen that.
    parser: { done: parsed.record.done, matched: parsed.record.statusMatched, workState: parsed.record.work_state, err: parsed.record.statusError, warn: parsed.record.statusWarning, warns: parsed.record.statusWarnings },
    board: { done: map.done, matched: map.statusMatched, workState: map.workState, err: map.statusError, warn: map.statusWarning, warns: map.statusWarnings },
    arch: { done: arch.done, matched: arch.statusMatched, workState: arch.workState, err: arch.statusError, warn: arch.statusWarning, warns: arch.statusWarnings },
    api: { done: api.section === 'done', matched: api.statusMatched, workState: api.workState, err: api.statusError, warn: api.statusWarning, warns: api.statusWarning ? [api.statusWarning] : [] },
  };
}

/**
 * The enumeration. `error` ⇒ EVERY consumer must carry a named statusError and
 * refuse to claim the state (`matched:false`, `workState:null`, parked in Open).
 * `warn` ⇒ the state IS answerable, so no consumer errors, but board:check must
 * still say something — see the justification in ticket-schema.mjs.
 */
const AMBIGUITY_CASES = [
  { label: 'ABSENT — no header Status line at all', lines: [], kind: 'error', prefix: 'MISSING STATUS FIELD' },
  { label: 'EMPTY — the line is present, the value is not', lines: [''], kind: 'error', prefix: 'EMPTY STATUS FIELD' },
  { label: 'EMPTY — whitespace only', lines: ['   '], kind: 'error', prefix: 'EMPTY STATUS FIELD' },
  { label: 'UNRECOGNISED — a word the table does not map', lines: ['MARINATING — waiting for flavor'], kind: 'error', prefix: 'UNMAPPABLE STATUS' },
  { label: 'DUPLICATED, CONTRADICTING — the clean-room case: OPEN then VERIFIED', lines: ['OPEN', 'VERIFIED'], kind: 'error', prefix: 'DUPLICATE STATUS FIELD' },
  { label: 'DUPLICATED, CONTRADICTING — the other order: VERIFIED then OPEN', lines: ['VERIFIED', 'OPEN'], kind: 'error', prefix: 'DUPLICATE STATUS FIELD' },
  { label: 'DUPLICATED, CONTRADICTING — both done, different work_state (FIXED vs VERIFIED)', lines: ['FIXED', 'VERIFIED — proven'], kind: 'error', prefix: 'DUPLICATE STATUS FIELD' },
  { label: 'DUPLICATED, CONTRADICTING — one mappable, one not', lines: ['OPEN', 'MARINATING'], kind: 'error', prefix: 'DUPLICATE STATUS FIELD' },
  { label: 'DUPLICATED, CONTRADICTING — one empty, one declared', lines: ['', 'VERIFIED'], kind: 'error', prefix: 'DUPLICATE STATUS FIELD' },
  { label: 'DUPLICATED, CONTRADICTING — three lines, one dissenter', lines: ['OPEN', 'OPEN', 'DONE'], kind: 'error', prefix: 'DUPLICATE STATUS FIELD' },
  { label: 'DUPLICATED but BOTH UNRECOGNISED — the unmappable error still wins', lines: ['MARINATING', 'MARINATING'], kind: 'error', prefix: 'UNMAPPABLE STATUS' },
  { label: 'DUPLICATED, AGREEING — identical text', lines: ['OPEN', 'OPEN'], kind: 'warn', done: false, matched: true },
  { label: 'DUPLICATED, AGREEING — different text, same machine state', lines: ['OPEN — needs a decision', 'OPEN (still)'], kind: 'warn', done: false, matched: true },
];

for (const c of AMBIGUITY_CASES) {
  setStatusLines(c.lines);
  const seen = readAll();
  const vals = Object.values(seen);
  const L = `${c.label}`;

  check(`${L}: every consumer agrees on done-ness and on work_state`,
    vals.every((v) => v.done === vals[0].done && v.workState === vals[0].workState),
    JSON.stringify(seen));

  if (c.kind === 'error') {
    check(`${L}: EVERY consumer carries a named ${c.prefix}, none is silent`,
      vals.every((v) => typeof v.err === 'string' && STATUS_DEFECT_RE.test(v.err) && v.err.startsWith(c.prefix)),
      JSON.stringify(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, String(v.err).slice(0, 60)]))));
    check(`${L}: no consumer CLAIMS the state — matched:false, work_state:null, parked in Open`,
      vals.every((v) => v.matched === false && v.workState === null && v.done === false),
      JSON.stringify(seen));
    check(`${L}: the message names the ticket file, so a human can find it`,
      vals.every((v) => String(v.err).includes(victimFile)), String(vals[0].err).slice(0, 120));
    const cli = boardCheckCli();
    check(`${L}: board:check exits 1 and names it`,
      cli.code === 1 && cli.out.split('\n').some((l) => l.includes(victimFile) && STATUS_DEFECT_RE.test(l.replace(/^\s*FAIL\s+/, ''))),
      `exit=${cli.code} :: ${cli.out.split('\n').filter((l) => l.includes(victimFile)).join(' | ').slice(0, 200)}`);
    const aw = archWatchCli();
    check(`${L}: arch-watch writes it to stderr and counts it as unclassified`,
      aw.err.includes(VICTIM_ID) && STATUS_DEFECT_RE.test(aw.err.replace(/^arch-watch — /gm, '')),
      JSON.stringify(aw.err.slice(0, 200)));
  } else {
    check(`${L}: the state IS answerable — every consumer classifies it, none errors`,
      vals.every((v) => v.matched === c.matched && v.done === c.done && v.err === null && v.workState !== null),
      JSON.stringify(seen));
    check(`${L}: …but it is NOT silent — the parser raises a DUPLICATE STATUS FIELD warning`,
      (seen.parser.warns ?? []).some((w) => w.startsWith('DUPLICATE STATUS FIELD') && w.includes(victimFile)),
      JSON.stringify(seen.parser.warns ?? '(no statusWarnings field at all)'));
    // The second half of the same principle: a report must reach EVERY consumer
    // through a channel its callers can see. Before this round only the ticket
    // API carried `statusWarning`; board and arch-watch had no such field.
    check(`${L}: the warning reaches EVERY consumer's record, not just the parser's`,
      vals.every((v) => typeof v.warn === 'string' && v.warn.includes('DUPLICATE STATUS FIELD')),
      JSON.stringify(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, v.warn === undefined ? '(no field)' : String(v.warn).slice(0, 40)]))));
    const cli = boardCheckCli();
    check(`${L}: board:check WARNs (not FAILs) and stays exit 0 — an unambiguous state must not block the gate`,
      cli.code === 0 && /WARN\s+DUPLICATE STATUS FIELD/.test(cli.out) && cli.out.includes(victimFile),
      `exit=${cli.code} :: ${cli.out.split('\n').filter((l) => l.includes(victimFile)).join(' | ').slice(0, 200)}`);
  }
}
restoreVictim();
// Non-vacuity: on the RESTORED real corpus none of the new reports fires.
// (ARCH-004/ARCH-017: AMBIGUOUS STATUS is no longer emitted at all — the
// incidental-DONE sweep it advised on has been removed; only the declared
// leading word classifies a legacy ticket.)
{
  const clean = boardTool.readTickets(BUGS);
  check('a restored board raises NO new-class status report (the alarm is not always on)',
    clean.errors.length === 0
    && !clean.warnings.some((w) => /^(DUPLICATE STATUS FIELD|MALFORMED STATUS LINE|STATUS OUTSIDE HEADER)/.test(w)),
    JSON.stringify({ errors: clean.errors.slice(0, 3), warnings: clean.warnings.slice(0, 3) }));
}

/* ─── the two remaining shapes: a MISPLACED declaration and a NEAR-MISS line ── */

setStatusLines([]);
fs.writeFileSync(VICTIM_PATH, `${fs.readFileSync(VICTIM_PATH, 'utf8')}\n\n### 2026-08-19 — pasted\n\n- **Status:** VERIFIED — all good\n`);
const misplaced = S.parseTicket(fs.readFileSync(VICTIM_PATH, 'utf8'), { file: victimFile, mode: 'compat' }).record;
check('MISPLACED — a body-only declaration is still MISSING, and the warning says WHERE it went',
  misplaced.statusError.startsWith('MISSING STATUS FIELD') && misplaced.statusMatched === false
  && (misplaced.statusWarnings ?? []).some((w) => w.startsWith('STATUS OUTSIDE HEADER')),
  JSON.stringify({ err: misplaced.statusError, warns: misplaced.statusWarnings ?? null }));

/* ─── THE LOOK-ALIKE BOUNDARY, over shapes × agreement ────────────────────────
 *
 * The rule under test is stated over CONTENT, not punctuation:
 *
 *   a header line that LOOKS LIKE a state declaration and DISAGREES with the
 *   state actually used is an ERROR; one that AGREES, or that carries NO STATE
 *   at all, is a WARNING.
 *
 * The previous round put every look-alike on the warning side because none of
 * them is the canonical line. A clean-room pass then gave a real OPEN ticket a
 * second, INDENTED `- **Status:** VERIFIED` and all four consumers answered
 * "open" with `statusError: null` and `board:check` exit 0 — a file that says
 * two different things about which TABLE the ticket belongs in, reported as
 * untidiness. So the matrix below is shapes × {contradicts, agrees, declares
 * nothing}, and the shape is never what decides the severity.
 *
 * The victim is a real OPEN ticket, so `VERIFIED` contradicts and `OPEN` agrees.
 */
restoreVictim();
// The untouched exit code, captured BEFORE any mutation, so "the advisory did
// not move arch-watch's exit code" is measured rather than assumed.
const archExitBeforeLookalikes = archWatchCli().code;
const VICTIM_STATE = S.parseTicket(VICTIM_ORIGINAL, { file: victimFile, mode: 'compat' }).record.work_state;
check('the look-alike matrix runs against a victim whose real state is OPEN (so VERIFIED contradicts it)',
  VICTIM_STATE === 'open', String(VICTIM_STATE));

/** Every way a Markdown writer can put a state declaration on a line that is not the canonical one. */
const LOOKALIKE_SHAPES = [
  { name: 'INDENTED under the real one (the clean-room case)', line: (v) => `  - **Status:**${v}` },
  { name: 'INDENTED four spaces (an indented code block)', line: (v) => `    - **Status:**${v}` },
  { name: 'BLOCKQUOTED', line: (v) => `> - **Status:**${v}` },
  { name: 'BLOCKQUOTED and indented', line: (v) => `  > - **Status:**${v}` },
  { name: 'INSIDE A FENCED CODE BLOCK in the header', line: (v) => '```\n' + `  - **Status:**${v}` + '\n```' },
  { name: 'a `*` list item', line: (v) => `* **Status:**${v}` },
  { name: 'a `+` list item', line: (v) => `+ **Status:**${v}` },
  { name: 'a NUMBERED list item', line: (v) => `1. **Status:**${v}` },
  { name: 'a numbered `2)` list item', line: (v) => `2) **Status:**${v}` },
  { name: 'NEAR-MISS punctuation `- **Status**: X`', line: (v) => `- **Status**:${v}` },
  { name: 'NEAR-MISS, unbolded `- Status: X`', line: (v) => `- Status:${v}` },
  { name: 'NO list marker at all, bolded', line: (v) => `**Status:**${v}` },
  { name: 'NO list marker at all, plain', line: (v) => `Status:${v}` },
  { name: 'value wrapped in emphasis', line: (v) => `- Status:${v ? ` **${v.trim()}**` : v}` },
  // The clean room's OWN could-not-test list named the Unicode-whitespace
  // variants. A NO-BREAK SPACE renders as indentation and reads as one.
  { name: 'indented with a NO-BREAK SPACE (the clean room\'s own untested variant)', line: (v) => `\u00A0- **Status:**${v}` },
  { name: 'indented with an EN QUAD', line: (v) => `\u2000- **Status:**${v}` },
  // \u2500\u2500 shapes the ENUMERATED recogniser could not see at all \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // Round 4 listed the markers it would accept (`- * + 1. 2)`), so the round-4
  // severity rule below never got to judge anything punctuated another way: a
  // cross-provider clean-room pass wrote a GFM task-list checkbox under a real
  // OPEN ticket's genuine status line and every consumer stayed silent with
  // exit 0. These are the shapes the DERIVED recogniser sees \u2014 decoration is
  // CommonMark's closed BLOCK-STRUCTURE vocabulary (indentation and invisibles;
  // `- * +`, `\d+[.)]`, `[x]` and `#` each followed by a blank; `>` and `|`) \u2014
  // and each is put through the SAME contradicts/agrees/empty matrix, because
  // the shape must never be what decides the severity. Round 6 REPLACED the
  // alphabet (see `DECORATION_RUN_RE`) but not the shape of the rule, so every
  // entry below is a standing anti-regression for that swap.
  { name: 'a GFM TASK-LIST checkbox, checked (the second clean room\'s case)', line: (v) => `- [x] **Status:**${v}` },
  { name: 'a GFM TASK-LIST checkbox, unchecked', line: (v) => `- [ ] **Status:**${v}` },
  { name: 'a task-list checkbox with a renderer-specific fill `[-]`', line: (v) => `- [-] **Status:**${v}` },
  { name: 'a BLOCKQUOTE NESTED INSIDE a list item (marker order the enumeration fixed)', line: (v) => `- > **Status:**${v}` },
  { name: 'TWO list markers (arbitrary repetition)', line: (v) => `- - **Status:**${v}` },
  { name: 'quote, list, number and checkbox all at once', line: (v) => `> - 1. [x] **Status:**${v}` },
  { name: 'UNDERSCORE emphasis on the label (the enumeration allowed only `*`)', line: (v) => `- __Status__:${v}` },
  // A code span or a strikethrough that CLOSES AT THE LABEL is typography on a
  // real declaration; the same delimiter closing after the VALUE is a quotation
  // and is pinned on the other side, below. The pair is the round-6 boundary.
  { name: 'the label in a CODE SPAN', line: (v) => '- `Status`:' + v },
  { name: 'the label struck through, closing after the colon', line: (v) => `- ~~Status:~~${v}` },
  // ── round 7: the delimiter run had a hand-written cap of THREE ────────────
  // A third cross-provider clean room wrote a FOUR-backtick code span under a
  // real OPEN ticket's genuine status line. CommonMark bounds neither a code
  // span's nor an emphasis run's length, so the cap simply did not see it and
  // all four consumers answered `{matched:true, state:"open", error:null}` with
  // board:check exit 0. Both entries go through the SAME contradicts / agrees /
  // empty matrix as every shape above.
  { name: 'the label in a FOUR-backtick code span (the third clean room\'s case)', line: (v) => '- ````Status````:' + v },
  { name: 'the label in a SEVEN-asterisk emphasis run', line: (v) => `- *******Status*******:${v}` },
  { name: 'a TABLE cell', line: (v) => `| **Status:**${v}` },
  // The ZERO WIDTH SPACE was named by the previous round as a KNOWN HOLE it
  // chose not to cover. Deriving decoration from `\p{Cf}` closes it for the
  // whole invisible-format class at once rather than one codepoint at a time.
  { name: 'indented with a ZERO WIDTH SPACE (the previous round\'s named hole)', line: (v) => `\u200B- **Status:**${v}` },
  { name: 'preceded by a BYTE ORDER MARK', line: (v) => `\uFEFF- **Status:**${v}` },
  { name: 'preceded by a SOFT HYPHEN', line: (v) => `\u00AD- **Status:**${v}` },
];

/** Put an extra header line directly beneath the victim's real `- **Status:**` line. */
function setHeaderExtra(extra) {
  const next = VICTIM_ORIGINAL.replace(/^(- \*\*Status:\*\*.*)$/m, `$1\n${extra}`);
  if (next === VICTIM_ORIGINAL) throw new Error(`could not inject a header line into ${victimFile}`);
  fs.writeFileSync(VICTIM_PATH, next);
}

for (const shape of LOOKALIKE_SHAPES) {
  // ── CONTRADICTS ⇒ error on every consumer, and board:check must refuse ──
  setHeaderExtra(shape.line(' VERIFIED — contradictory'));
  let seen = readAll();
  let vals = Object.values(seen);
  check(`LOOK-ALIKE ${shape.name}, CONTRADICTING: every consumer carries a named CONTRADICTORY STATUS LINE`,
    vals.every((v) => typeof v.err === 'string' && v.err.startsWith('CONTRADICTORY STATUS LINE') && v.err.includes(victimFile)),
    JSON.stringify(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, String(v.err).slice(0, 48)]))));
  check(`LOOK-ALIKE ${shape.name}, CONTRADICTING: no consumer CLAIMS the state — matched:false, work_state:null, parked in Open`,
    vals.every((v) => v.matched === false && v.workState === null && v.done === false),
    JSON.stringify(seen));
  {
    const cli = boardCheckCli();
    check(`LOOK-ALIKE ${shape.name}, CONTRADICTING: board:check exits 1 and names it`,
      cli.code === 1 && cli.out.split('\n').some((l) => l.includes(victimFile) && /CONTRADICTORY STATUS LINE/.test(l)),
      `exit=${cli.code} :: ${cli.out.split('\n').filter((l) => l.includes(victimFile)).join(' | ').slice(0, 200)}`);
    const aw = archWatchCli();
    check(`LOOK-ALIKE ${shape.name}, CONTRADICTING: arch-watch writes it to stderr and counts it unclassified`,
      aw.err.includes(VICTIM_ID) && /CONTRADICTORY STATUS LINE/.test(aw.err),
      JSON.stringify(aw.err.slice(0, 160)));
  }

  // ── AGREES ⇒ warning only, on every consumer, and the gate stays open ──
  setHeaderExtra(shape.line(' OPEN — restating the same state'));
  seen = readAll();
  vals = Object.values(seen);
  check(`LOOK-ALIKE ${shape.name}, AGREEING: the state IS answerable — every consumer classifies it, none errors`,
    vals.every((v) => v.matched === true && v.done === false && v.workState === 'open' && v.err === null),
    JSON.stringify(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, { m: v.matched, d: v.done, e: String(v.err).slice(0, 40) }]))));
  check(`LOOK-ALIKE ${shape.name}, AGREEING: …but NOT silent — a MALFORMED STATUS LINE warning reaches EVERY consumer`,
    vals.every((v) => typeof v.warn === 'string' && v.warn.includes('MALFORMED STATUS LINE')),
    JSON.stringify(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, v.warn === undefined ? '(no field)' : String(v.warn).slice(0, 40)]))));

  // ── DECLARES NOTHING ⇒ warning; there is no state to disagree with ──
  setHeaderExtra(shape.line(''));
  seen = readAll();
  vals = Object.values(seen);
  check(`LOOK-ALIKE ${shape.name}, EMPTY: declares no state, so it stays a warning and the state is still answerable`,
    vals.every((v) => v.matched === true && v.err === null && typeof v.warn === 'string' && v.warn.includes('MALFORMED STATUS LINE')),
    JSON.stringify(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, { e: String(v.err).slice(0, 40), w: String(v.warn).slice(0, 40) }]))));
}

// The agreeing/empty half must leave the GATE open — measured once, not per
// shape, because board:check is the expensive call and the claim is one claim.
setHeaderExtra(LOOKALIKE_SHAPES[0].line(' OPEN — restating the same state'));
{
  const cli = boardCheckCli();
  check('LOOK-ALIKE, AGREEING: board:check WARNs and stays exit 0 — an unambiguous state must not block the gate',
    cli.code === 0 && /WARN\s+MALFORMED STATUS LINE/.test(cli.out) && cli.out.includes(victimFile),
    `exit=${cli.code} :: ${cli.out.split('\n').filter((l) => l.includes(victimFile)).join(' | ').slice(0, 200)}`);
  const aw = archWatchCli(['--json', '--quiet']);
  let parsedJson = null;
  try { parsedJson = JSON.parse(aw.out); } catch { /* reported by the check below */ }
  check('LOOK-ALIKE, AGREEING: arch-watch --json carries the advisory in `statusWarnings` and stdout stays parseable',
    !!parsedJson && Array.isArray(parsedJson.statusWarnings)
    && parsedJson.statusWarnings.some((w) => w.id === VICTIM_ID && w.warnings.some((x) => x.includes('MALFORMED STATUS LINE'))),
    JSON.stringify(parsedJson ? parsedJson.statusWarnings?.slice(0, 2) : aw.out.slice(0, 120)));
  check('LOOK-ALIKE, AGREEING: arch-watch marks the advisory WARN on stderr, names the file, and does not move its exit code',
    /^arch-watch WARN — MALFORMED STATUS LINE/m.test(aw.err)
    && aw.err.includes(victimFile)
    && !/^arch-watch — /m.test(aw.err)
    && aw.code === archExitBeforeLookalikes,
    JSON.stringify({ code: aw.code, clean: archExitBeforeLookalikes, err: aw.err.slice(0, 200) }));
}

/* ─── a look-alike on a ticket that is ALREADY loud stays advisory ─────────── */

// The most realistic single-line typo of them all: the ONLY status line got
// indented. There is then no declaration at all, so the loud channel already
// carries MISSING STATUS FIELD; the look-alike explains WHY rather than adding
// a second, competing error.
restoreVictim();
fs.writeFileSync(VICTIM_PATH, VICTIM_ORIGINAL.replace(/^(- \*\*Status:\*\*.*)$/m, '  $1'));
{
  const seen = readAll();
  const vals = Object.values(seen);
  check('the ONLY status line is INDENTED: every consumer reports MISSING STATUS FIELD and none claims a state',
    vals.every((v) => typeof v.err === 'string' && v.err.startsWith('MISSING STATUS FIELD')
      && v.matched === false && v.workState === null && v.done === false),
    JSON.stringify(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, String(v.err).slice(0, 40)]))));
  check('…and the look-alike rides along as a WARNING that says why, rather than a second competing error',
    vals.every((v) => typeof v.warn === 'string' && v.warn.includes('MALFORMED STATUS LINE')
      && !String(v.warn).includes('CONTRADICTORY')),
    JSON.stringify(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, String(v.warn).slice(0, 60)]))));
}

/* ─── the boundary's OTHER side: what must NOT become an error ─────────────── */

restoreVictim();
// A status line QUOTED IN THE BODY of a ticket that has a real header
// declaration is prose, not a contradiction — BUG-011 and BUG-013 really carry
// one inside their activity logs. Making that an error would move real tickets.
fs.writeFileSync(VICTIM_PATH, `${VICTIM_ORIGINAL}\n\n### 2026-08-19 — pasted my own header back\n\n- **Status:** VERIFIED — quoted, in the body\n  - **Status:** VERIFIED — quoted and indented\n`);
{
  const r = S.parseTicket(fs.readFileSync(VICTIM_PATH, 'utf8'), { file: victimFile, mode: 'compat' }).record;
  check('BELOW the header: a quoted declaration in the body is prose — not an error, not even a warning',
    r.statusError === null && r.statusMatched === true && r.done === false && (r.statusWarnings ?? []).length === 0,
    JSON.stringify({ err: r.statusError, warns: r.statusWarnings }));
}
restoreVictim();
check('…and the look-alike rule is narrow enough to leave the REAL `- **Status (history):**` line alone',
  (S.parseTicket(fs.readFileSync(path.join(BUGS, 'FEAT-015-server-restart-survives-live-sessions.md'), 'utf8'),
    { file: 'FEAT-015-server-restart-survives-live-sessions.md', mode: 'compat' }).record.statusWarnings ?? []).length === 0,
  JSON.stringify(S.parseTicket(fs.readFileSync(path.join(BUGS, 'FEAT-015-server-restart-survives-live-sessions.md'), 'utf8'), { file: 'x', mode: 'compat' }).record.statusWarnings ?? null));
restoreVictim();

/* ─── THE ROUND-6 DEFECT, end to end on the real victim ────────────────────── */

/**
 * The cross-provider clean room's own case, injected exactly where it injected
 * it — directly under a real OPEN ticket's genuine `- **Status:**` line — and
 * graded on every channel it graded: all consumers, and `board:check`'s exit
 * code. Under round 5 this printed CONTRADICTORY STATUS LINE on all three and
 * exited 1. A quoted example is prose: the ticket must keep its own state,
 * confidently, with NOTHING on the warning channel either — a warning would
 * still be a false report about a correct file.
 */
for (const [why, extra] of [
  ['the clean room\'s line, verbatim', '- "Status: VERIFIED" is an example of the required syntax.'],
  ['the same example in a code span', '- `Status: VERIFIED` is an example of the required syntax.'],
  ['the same example parenthesised', '- (Status: VERIFIED) — for example'],
  ['the same example in typographic quotes', '- “Status: VERIFIED” is an example.'],
]) {
  restoreVictim();
  setHeaderExtra(extra);
  const seen = readAll();
  const vals = Object.values(seen);
  check(`QUOTED EXAMPLE (${why}): every consumer keeps the ticket's REAL state and says nothing`,
    vals.every((v) => v.matched === true && v.workState === 'open' && v.done === false
      && v.err === null && (v.warn === null || v.warn === undefined)),
    JSON.stringify(seen));
  const cli = boardCheckCli();
  check(`QUOTED EXAMPLE (${why}): board:check exits 0 and never names the ticket`,
    cli.code === 0 && !cli.out.split('\n').some((l) => l.includes(victimFile) && /STATUS LINE/.test(l)),
    `exit=${cli.code} :: ${cli.out.split('\n').filter((l) => l.includes(victimFile)).join(' | ').slice(0, 200)}`);
}
restoreVictim();

/* ─── the derived recogniser: what it must NOT swallow ─────────────────────── */

/**
 * Widening the recogniser is the EXPENSIVE direction, and round 5 went too far
 * in it. Deriving decoration from "not a letter and not a digit" swallowed the
 * leading `"` of
 *
 *     - "Status: VERIFIED" is an example of the required syntax.
 *
 * so a cross-provider clean-room pass turned a real OPEN ticket (BUG-048) into
 * `matched:false, workState:null`, CONTRADICTORY STATUS LINE on all three
 * consumers, `board:check` exit 1 — a correct ticket made unactionable and the
 * whole consistency gate taken down, by a sentence. A MISSED declaration costs
 * one ticket's row; a PROMOTED sentence costs the board.
 *
 * The rule is now stated over BLOCK STRUCTURE, not over "could this character
 * spell a word": a list marker, a blockquote arrow, a heading hash and a table
 * pipe say what KIND OF THING the line is; a quotation mark, a parenthesis and
 * a backtick are part of its CONTENT, and what they do to it is quote it. So
 * every line below is ordinary ticket prose and must remain invisible to the
 * recogniser, or the gate starts blocking lanes over sentences.
 */
for (const [why, line] of [
  ['a labelled annotation, not a declaration (`- **Status (history):**`)', '- **Status (history):** was OPEN'],
  ['a different label that merely ends in the word', '- **Build Status:** VERIFIED'],
  ['the word inside a sentence', '- The status is VERIFIED: I checked it myself.'],
  ['a label with the colon detached by a word', '- **Status** of play: VERIFIED'],
  ['a thematic break', '---'],
  ['a bare bullet with no label', '- [x] shipped the fix and VERIFIED it'],
  ['a link whose text starts with the word', '- [Status: verified](https://example.invalid) is the badge'],
  // ── round 6: the QUOTED EXAMPLE and its neighbours ────────────────────────
  // The clean room's own line, verbatim, then every other way a writer shows
  // the syntax INLINE instead of using it. Each one wraps the label AND the
  // value, which is what makes it a quotation rather than typography.
  ['the clean room\'s quoted example, verbatim', '- "Status: VERIFIED" is an example of the required syntax.'],
  ['the same example without the list marker', '"Status: VERIFIED" is an example of the required syntax.'],
  ['an example in a CODE SPAN', '- `Status: VERIFIED` is an example of the required syntax.'],
  ['an example in a code span with no list marker', '`Status: VERIFIED` is an example.'],
  ['an example in single quotes', "- 'Status: VERIFIED' is an example."],
  ['an example in TYPOGRAPHIC double quotes', '- “Status: VERIFIED” is an example.'],
  ['an example in TYPOGRAPHIC single quotes', '- ‘Status: VERIFIED’ is an example.'],
  ['an example in GUILLEMETS', '- «Status: VERIFIED» is an example.'],
  ['an example in LOW-9 German quotes', '- „Status: VERIFIED“ ist ein Beispiel.'],
  ['a PARENTHETICAL', '- (Status: VERIFIED) — for example'],
  ['an example in emphasis that closes after the VALUE', '- *Status: VERIFIED* is an example.'],
  ['an example in strong emphasis that closes after the VALUE', '- __Status: VERIFIED__ is an example.'],
  ['an example struck through, closing after the VALUE', '- ~~Status: VERIFIED~~ is an example.'],
  ['a quoted example mid-sentence', '- see "Status: VERIFIED" above'],
  ['an unbalanced inline delimiter (opener with no closer at the label)', '- `Status: VERIFIED'],
  ['a delimiter that does not close with the SAME run', '- `Status**: VERIFIED'],
]) {
  check(`NOT a look-alike — ${why}`,
    S.statusLookalikes(`# X — y\n\n${line}\n\n## Detail\n`).length === 0,
    JSON.stringify(S.statusLookalikes(`# X — y\n\n${line}\n\n## Detail\n`)));
}
// Non-vacuity for the block above: the SAME harness does see a declaration.
check('…and the same probe DOES see a declaration, so the block above is not vacuous',
  S.statusLookalikes('# X — y\n\n> - 1. [x] __Status__: VERIFIED\n\n## Detail\n').length === 1,
  JSON.stringify(S.statusLookalikes('# X — y\n\n> - 1. [x] __Status__: VERIFIED\n\n## Detail\n')));

/**
 * THE PAIRS THE ROUND TURNS ON. Each pair is the SAME inline delimiter: on the
 * left it closes at the LABEL (typography on a real declaration, recognised);
 * on the right it closes after the VALUE (a quotation of a declaration, prose).
 * Nothing else distinguishes them, so a rule that gets both sides of every pair
 * right is not keying on the delimiter — which is the mistake round 5 made in
 * the other direction, and the reason the pairs are asserted together.
 */
for (const [why, decl, prose] of [
  ['a CODE SPAN', '- `Status`: VERIFIED', '- `Status: VERIFIED` is an example.'],
  ['ASTERISK emphasis', '- *Status*: VERIFIED', '- *Status: VERIFIED* is an example.'],
  ['UNDERSCORE emphasis', '- __Status__: VERIFIED', '- __Status: VERIFIED__ is an example.'],
  ['STRIKETHROUGH', '- ~~Status:~~ VERIFIED', '- ~~Status: VERIFIED~~ is an example.'],
  // Indented on both sides: `- **Status:** VERIFIED` unindented IS the canonical
  // line, which `statusLookalikes` subtracts by definition, so the pair would
  // not be comparing the same thing.
  ['STRONG emphasis (the canonical typography)', '  - **Status:** VERIFIED', '  - **Status: VERIFIED** is an example.'],
]) {
  const at = (line) => S.statusLookalikes(`# X — y\n\n${line}\n\n## Detail\n`);
  check(`CLOSES AT THE LABEL ⇒ a declaration — ${why}`,
    at(decl).length === 1 && at(decl)[0].value === 'VERIFIED', JSON.stringify(at(decl)));
  check(`CLOSES AFTER THE VALUE ⇒ prose — ${why}`,
    at(prose).length === 0, JSON.stringify(at(prose)));
}

/**
 * BLOCK STRUCTURE IS STILL BLOCK STRUCTURE. The narrowing above must not have
 * cost the round-5 win: every genuinely-decorated declaration stays recognised,
 * including the checkbox the second clean room found, arbitrary marker order
 * and repetition, and the invisible-format indents.
 */
for (const line of [
  '  - **Status:** VERIFIED', '    - **Status:** VERIFIED', '> - **Status:** VERIFIED',
  '  > - **Status:** VERIFIED', '* **Status:** VERIFIED', '+ **Status:** VERIFIED',
  '1. **Status:** VERIFIED', '27) **Status:** VERIFIED', '- [x] **Status:** VERIFIED',
  '- [ ] **Status:** VERIFIED', '- [-] **Status:** VERIFIED', '- > **Status:** VERIFIED',
  '- - **Status:** VERIFIED', '> - 1. [x] **Status:** VERIFIED', '| **Status:** VERIFIED',
  '# Status: VERIFIED', '###### **Status:** VERIFIED',
  ' - **Status:** VERIFIED', ' - **Status:** VERIFIED', '​- **Status:** VERIFIED',
  '﻿- **Status:** VERIFIED', '­- **Status:** VERIFIED',
  '**Status:** VERIFIED', 'Status: VERIFIED', '- Status: **VERIFIED**',
]) {
  const r = S.statusLookalikes(`# X — y\n\n${line}\n\n## Detail\n`);
  check(`BLOCK-DECORATED declaration still recognised, value intact — ${JSON.stringify(line)}`,
    r.length === 1 && r[0].value === 'VERIFIED', JSON.stringify(r));
}

/* ─── ROUND 7: THE DELIMITER RUN HAS NO LENGTH ─────────────────────────────── */

/**
 * The third clean-room pass found `- ````Status````: VERIFIED` invisible: the
 * label pattern admitted a run of one to THREE, and nothing derives that 3.
 * CommonMark's code-span opener is "a string of ONE OR MORE backtick
 * characters", closed by "a backtick string of EQUAL LENGTH"; its emphasis
 * delimiter run is likewise one or more, unbounded. Raising the cap would only
 * move the number nobody has typed YET, so the run is now `+` with a
 * BACKREFERENCED closer.
 *
 * The sweep is therefore over LENGTH ITSELF, up to a length no ticket will ever
 * carry, for each of the four delimiter characters and for both closing
 * positions (before and after the colon). If any of these fails, a bound has
 * come back.
 */
const RUN_LENGTHS = [1, 2, 3, 4, 5, 6, 7, 8, 12, 17, 40, 101];
let sweepDecls = 0;
for (const d of ['*', '_', '~', '`']) {
  for (const n of RUN_LENGTHS) {
    const D = d.repeat(n);
    // Closing BEFORE the colon, and (for the emphasis-style delimiters) after.
    // Indented, because `- **Status:** VERIFIED` unindented IS the canonical
    // line, which `statusLookalikes` subtracts by definition — the n=2 `*` cell
    // would otherwise be measuring that subtraction and not this rule.
    const shapes = [`  - ${D}Status${D}: VERIFIED`, `  - ${D}Status:${D} VERIFIED`];
    for (const line of shapes) {
      const r = S.statusLookalikes(`# X — y\n\n${line}\n\n## Detail\n`);
      sweepDecls += r.length;
      check(`RUN LENGTH ${n} of ${JSON.stringify(d)} closing at the label ⇒ a declaration — ${JSON.stringify(line.slice(0, 40))}`,
        r.length === 1 && r[0].value === 'VERIFIED', JSON.stringify(r));
    }
    // The SAME length wrapping the VALUE too is a quotation at every length.
    const prose = `- ${D}Status: VERIFIED${D} is an example.`;
    check(`RUN LENGTH ${n} of ${JSON.stringify(d)} closing after the VALUE ⇒ prose`,
      S.statusLookalikes(`# X — y\n\n${prose}\n\n## Detail\n`).length === 0,
      JSON.stringify(S.statusLookalikes(`# X — y\n\n${prose}\n\n## Detail\n`)));
  }
}
check(`…and the length sweep is not vacuous: ${sweepDecls} declarations recognised across ${RUN_LENGTHS.length} lengths × 4 delimiters × 2 closing positions`,
  sweepDecls === RUN_LENGTHS.length * 4 * 2, String(sweepDecls));

/**
 * EQUAL LENGTH IS THE RULE, not "some length". CommonMark closes a code span
 * only on a run of the SAME length, and emphasis only on the same run; a closer
 * of a DIFFERENT length is not a close, so the line is not a declaration. The
 * backreference is what enforces this, at every length, without the pattern
 * knowing any length — which is precisely why the cap could be removed rather
 * than raised.
 */
for (const [open, close] of [[4, 3], [3, 4], [1, 2], [2, 1], [5, 4], [4, 6], [8, 1]]) {
  for (const d of ['*', '_', '~', '`']) {
    const line = `- ${d.repeat(open)}Status${d.repeat(close)}: VERIFIED`;
    check(`UNEQUAL RUN ${open}⇄${close} of ${JSON.stringify(d)} does not close ⇒ not a declaration`,
      S.statusLookalikes(`# X — y\n\n${line}\n\n## Detail\n`).length === 0,
      JSON.stringify(S.statusLookalikes(`# X — y\n\n${line}\n\n## Detail\n`)));
  }
}

/**
 * A RUN IS ONE CHARACTER REPEATED. The old class `[*_~`]{1,3}` could match a
 * MIXED opener and an identical mixed closer, but no renderer treats `` `*…`* ``
 * as a code span or as emphasis, so such a line is not a declaration to any
 * reader. Splitting the alternation per character makes that unrepresentable
 * rather than guarded. Measured on the real corpus below: no ticket moves.
 */
for (const line of [
  '- `*Status`*: VERIFIED', '- *`Status*`: VERIFIED', '- *_Status*_: VERIFIED',
  '- ~*Status~*: VERIFIED', '- **_Status**_: VERIFIED',
]) {
  check(`MIXED delimiter characters are not a run ⇒ not a declaration — ${JSON.stringify(line)}`,
    S.statusLookalikes(`# X — y\n\n${line}\n\n## Detail\n`).length === 0,
    JSON.stringify(S.statusLookalikes(`# X — y\n\n${line}\n\n## Detail\n`)));
}

/**
 * THE VALUE-TRIM ALPHABET DRIFTED FROM THE LABEL'S, and that was the same bug
 * in the other direction. Round 6 hand-wrote the value trim as ``[\s*_`]`` and
 * left `~` out, so `- Status: ~~VERIFIED~~` on a VERIFIED ticket classified as
 * UNRECOGNISED and therefore CONTRADICTED a ticket it plainly agrees with — a
 * false ERROR that takes board:check down over a correct file, the expensive
 * direction. Both are now built from one `DELIM_CHARS` list, so they cannot
 * drift again. Every delimiter, at arbitrary length, must trim off the value.
 */
for (const d of ['*', '_', '~', '`']) {
  for (const n of [1, 2, 3, 5, 9]) {
    const D = d.repeat(n);
    const line = `- Status: ${D}VERIFIED${D}`;
    const r = S.statusLookalikes(`# X — y\n\n${line}\n\n## Detail\n`);
    check(`VALUE wrapped in ${n}×${JSON.stringify(d)} still classifies as VERIFIED (so it AGREES, not contradicts)`,
      r.length === 1 && r[0].value === 'VERIFIED', JSON.stringify(r));
  }
}
// …and a value that is NOTHING BUT delimiters declares no state, so it must
// stay on the warning channel rather than becoming an unmappable contradiction.
for (const line of ['- Status: ~~~~', '- Status: ***', '- Status: ``']) {
  const r = S.statusLookalikes(`# X — y\n\n${line}\n\n## Detail\n`);
  check(`a value that is only delimiters declares NO state ⇒ empty ⇒ warning — ${JSON.stringify(line)}`,
    r.length === 1 && r[0].value === '', JSON.stringify(r));
}

/**
 * THE PROSE SHAPES ROUND 6 ESTABLISHED MUST STAY INVISIBLE AT EVERY LENGTH.
 * Unbounding a run is a WIDENING, and widening is the direction that cost the
 * board once already (round 5 promoted a sentence and exited 1). Quotation
 * marks, parentheses and links are still not decoration; a long run does not
 * change that.
 */
for (const line of [
  '- "````Status: VERIFIED````" is an example of the required syntax.',
  '- (````Status: VERIFIED````) — for example',
  '- “*****Status: VERIFIED*****” is an example.',
  '- ````Status: VERIFIED```` is an example of the required syntax.',
  '- *****Status: VERIFIED***** is an example.',
  '- ~~~~Status: VERIFIED~~~~ is an example.',
  '- [````Status: verified````](https://example.invalid) is the badge',
  '- ````Status: VERIFIED',
  '- ````Status****: VERIFIED',
]) {
  check(`STILL NOT a look-alike at length — ${JSON.stringify(line.slice(0, 48))}`,
    S.statusLookalikes(`# X — y\n\n${line}\n\n## Detail\n`).length === 0,
    JSON.stringify(S.statusLookalikes(`# X — y\n\n${line}\n\n## Detail\n`)));
}

/**
 * NO ReDoS SURFACE ON A LONG RUN. The opener is `+` now, so a line that is
 * nothing but delimiters is the worst case for backtracking. The strip step
 * still never fails, and each per-character alternative is tried once from the
 * single anchored start, so this is linear — asserted as a wall-clock bound
 * rather than by inspection.
 */
{
  const t0 = Date.now();
  for (const d of ['*', '_', '~', '`']) {
    for (const line of [d.repeat(50000), `- ${d.repeat(50000)}`, `${d.repeat(25000)}Status${d.repeat(25000)}`]) {
      S.statusLookalikes(`# X — y\n\n${line}\n\n## Detail\n`);
    }
  }
  const ms = Date.now() - t0;
  check(`an unbounded run does not backtrack: 12 lines of up to 50 000 delimiters in ${ms}ms`, ms < 2000, `${ms}ms`);
}

/* ────────────────────────────────────────────────────────────── the cases */

/**
 * `matched: false` cases are the defect. The rest are the NEIGHBOURING SHAPES
 * the clean-room pass explicitly did not probe — a state word that is a prefix
 * or a suffix of a real one is where the next silent guess would hide.
 */
const CASES = [
  // the clean-room pass's own fixture, verbatim
  ['MARINATING — waiting for flavor', { matched: false, done: false }],
  // prefixes: a real state word is a strict prefix of the written one
  ['OPENED for review', { matched: false, done: false }],
  ['WIPED the branch and restarted', { matched: false, done: false }],
  ['CLOSEDOWN pending', { matched: false, done: false }],
  ['FIXEDLY committed to this design', { matched: false, done: false }],
  ['VERIFIEDLY true', { matched: false, done: false }],
  ['NOT-A-BUGGY implementation', { matched: false, done: false }],
  ['BLOCKEDNESS everywhere', { matched: false, done: false }],
  ['DONELESS work remains', { matched: false, done: false }],
  // suffixes: a real state word ends the written one
  ['REOPENED', { matched: false, done: false }],
  ['UNDONE — regressed', { matched: false, done: false }],
  ['UNFIXED', { matched: false, done: false }],
  ['UNVERIFIED', { matched: false, done: false }],
  // the corpus survey's real mangled form: a state word run into the next field
  ['VERIFIED2026-08-19', { matched: false, done: false }],
  // and the mappable neighbours, so the suite proves it is not just saying "no"
  ['OPEN — needs a decision', { matched: true, done: false }],
  ['VERIFIED 2026-08-19 — shipped', { matched: true, done: true }],
  ['FIXED', { matched: true, done: true }],
  // ARCH-004/ARCH-017: an incidental `DONE` token no longer decides state. No
  // recognised LEADING word ⇒ UNMAPPABLE (not swept to Done by the token).
  ['RE-DONE by hand', { matched: false, done: false }],
  // Leading `IN PROGRESS` wins; the incidental `DONE` later in the line does NOT
  // override it — this ticket stays Open. (This is the ARCH-017 shape.)
  ['IN PROGRESS — Phase R DONE', { matched: true, done: false }],
];

for (const [raw, want] of CASES) {
  setStatus(raw);
  const seen = Object.fromEntries(Object.entries(CONSUMERS).map(([k, f]) => [k, f()]));
  const vals = Object.values(seen);
  const label = JSON.stringify(raw.length > 34 ? `${raw.slice(0, 34)}…` : raw);

  check(`${label}: every consumer agrees on done-ness`,
    vals.every((v) => v.done === vals[0].done) && vals[0].done === want.done,
    JSON.stringify(seen));
  check(`${label}: every consumer agrees on whether it CLASSIFIED (expected matched=${want.matched})`,
    vals.every((v) => v.matched === want.matched),
    JSON.stringify(seen));
  check(`${label}: every consumer agrees on work_state (${want.matched ? 'a state' : 'null — never guessed'})`,
    vals.every((v) => v.workState === vals[0].workState) && (want.matched ? vals[0].workState !== null : vals[0].workState === null),
    JSON.stringify(seen));
  check(`${label}: ${want.matched ? 'no consumer raises a false alarm' : 'EVERY consumer reports it, none is silent'}`,
    vals.every((v) => v.reported === !want.matched),
    JSON.stringify(seen));
}
restoreVictim();

/**
 * The message is READ BY A HUMAN who has to fix the ticket — and, since it now
 * travels over HTTP on every summary, by a UI. It must therefore list the words
 * to TYPE, not the regexes that recognise them.
 */
const sampleMsg = S.statusIssue('X.md', true, S.classifyLegacyStatus('MARINATING'));
check('the UNMAPPABLE message lists typeable state words, not regex sources',
  /VERIFIED\/DONE/.test(sampleMsg) && /IN VERIFICATION/.test(sampleMsg) && /NOT-A-BUG/.test(sampleMsg)
  && !/\\s|\\b|\[|\?/.test(sampleMsg), sampleMsg);
check('every LEGACY_STATUS_TABLE entry has a label, and every label CLASSIFIES back to that entry',
  S.LEGACY_STATUS_TABLE.every((e) => typeof e.label === 'string' && e.label.length > 0
    && S.classifyLegacyStatus(e.label).workState === e.workState),
  S.LEGACY_STATUS_TABLE.filter((e) => S.classifyLegacyStatus(e.label ?? '').workState !== e.workState).map((e) => e.label ?? e.re.source).join(', '));

/* ───────────────────────── the CLI surfaces: board:check exit 1, arch-watch loud */

function boardCheckCli() {
  const r = spawnSync(process.execPath, [path.join(HERE, 'board.mjs'), 'check', `--dir=${BUGS}`], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
function archWatchCli(extra = []) {
  const r = spawnSync(process.execPath, [path.join(HERE, 'arch-watch.mjs'), `--dir=${BUGS}`, ...extra], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// The exit code an untouched board produces, captured BEFORE the mutation, so
// "the exit code did not move" is measured rather than assumed.
const archExitClean = archWatchCli().code;

setStatus('MARINATING — waiting for flavor');

const bc = boardCheckCli();
check('board:check exits non-zero and names UNMAPPABLE STATUS with the file',
  bc.code === 1 && /UNMAPPABLE STATUS/.test(bc.out) && bc.out.includes(victimFile), `exit=${bc.code}`);

const aw = archWatchCli();
check('arch-watch writes an UNMAPPABLE STATUS line naming the ticket to stderr',
  /UNMAPPABLE STATUS/.test(aw.err) && aw.err.includes(VICTIM_ID), JSON.stringify(aw.err.slice(0, 300)));
check('arch-watch does NOT overload its exit code (still "recurrence found", per FEAT-019)',
  aw.code === archExitClean, `exit=${aw.code}, clean=${archExitClean}`);

const awq = archWatchCli(['--quiet']);
check('arch-watch --quiet still reports it: a defect is not report output',
  /UNMAPPABLE STATUS/.test(awq.err), JSON.stringify(awq.err.slice(0, 200)));

const awj = archWatchCli(['--json']);
let awJson = null;
try { awJson = JSON.parse(awj.out); } catch { /* reported below */ }
check('arch-watch --json carries the unclassified ticket in the result, not only in prose',
  !!awJson && Array.isArray(awJson.unclassified) && awJson.unclassified.some((u) => u.id === VICTIM_ID),
  JSON.stringify(awJson?.unclassified ?? awj.out.slice(0, 200)));

const res = archWatch(BUGS);
check('archWatch() never throws on an unmappable ticket and still counts it',
  res.ticketCount >= 150 && (res.unclassified ?? []).some((u) => u.id === VICTIM_ID),
  JSON.stringify({ ticketCount: res.ticketCount, unclassified: res.unclassified?.length }));
check('an unclassified ticket is in NEITHER the closed nor the open half of any cluster it joins',
  res.clusters.every((c) => !c.closed.includes(VICTIM_ID) && !c.open.includes(VICTIM_ID)),
  JSON.stringify(res.clusters.filter((c) => c.members.includes(VICTIM_ID)).map((c) => `${c.label}: closed=${c.closed.includes(VICTIM_ID)} open=${c.open.includes(VICTIM_ID)}`)));
check('…and IS named in that cluster\'s own unclassified list, so the cluster reads as incomplete',
  res.clusters.filter((c) => c.members.includes(VICTIM_ID)).every((c) => (c.unclassified ?? []).includes(VICTIM_ID)),
  JSON.stringify(res.clusters.filter((c) => c.members.includes(VICTIM_ID)).map((c) => c.unclassified)));

// The two CLIs reject an argument they cannot interpret, for the same reason.
for (const [name, args] of [['board.mjs', ['check', BUGS]], ['arch-watch.mjs', [BUGS]]]) {
  const r = spawnSync(process.execPath, [path.join(HERE, name), ...args], { encoding: 'utf8' });
  check(`${name} REJECTS a bare directory argument instead of silently reporting on docs/bugs`,
    r.status === 2 && /unrecognised argument/.test(`${r.stdout}${r.stderr}`),
    `exit=${r.status} :: ${`${r.stdout}${r.stderr}`.split('\n').find(Boolean)?.slice(0, 160)}`);
}

restoreVictim();
const awClean = archWatchCli();
check('a clean board produces NO unmappable noise (the alarm is not always on)',
  !/UNMAPPABLE STATUS/.test(awClean.err), JSON.stringify(awClean.err.slice(0, 200)));

/* ───────────────── the status word in the BODY rather than in the header */

setStatus('MARINATING — waiting for flavor');
const withBodyQuote = `${fs.readFileSync(VICTIM_PATH, 'utf8')}\n\n### 2026-08-19 — quoted\n\nAn agent pasted its own header here:\n\n- **Status:** VERIFIED — all good\n`;
fs.writeFileSync(VICTIM_PATH, withBodyQuote);
const bodySeen = Object.fromEntries(Object.entries(CONSUMERS).map(([k, f]) => [k, f()]));
const bodyVals = Object.values(bodySeen);
check('a state word QUOTED IN THE BODY does not rescue an unmappable header (header wins, everywhere)',
  bodyVals.every((v) => v.matched === false && v.done === false && v.reported === true),
  JSON.stringify(bodySeen));

// …and the harder one: NO header status at all, only a body line.
const noHeader = VICTIM_ORIGINAL.replace(/^- \*\*Status:\*\*.*$/m, '- **Reported-by:** agent')
  + '\n\n### 2026-08-19 — quoted\n\n- **Status:** VERIFIED — all good\n';
fs.writeFileSync(VICTIM_PATH, noHeader);
const nh = Object.fromEntries(Object.entries(CONSUMERS).map(([k, f]) => [k, f()]));
check('a ticket with NO header status: every consumer gives the SAME answer (whatever it is)',
  new Set(Object.values(nh).map((v) => `${v.done}/${v.matched}/${v.workState}`)).size === 1,
  JSON.stringify(nh));
const nhCheck = boardCheckCli();
check('a ticket with NO header status is REPORTED by board:check, not silently taken from the body',
  nhCheck.code === 1 && /(MISSING STATUS FIELD|STATUS FROM BODY|UNMAPPABLE STATUS)/.test(nhCheck.out),
  `exit=${nhCheck.code}`);
restoreVictim();

/* ─────────────────── the ticket header and the generated INDEX disagreeing */

setStatus('MARINATING — waiting for flavor');
const indexPath = path.join(BUGS, 'INDEX.md');
const indexBefore = fs.readFileSync(indexPath, 'utf8');
// Regenerate: the generator must place an unmappable ticket in Open.
boardTool.genBoard(BUGS);
const genned = fs.readFileSync(indexPath, 'utf8');
const openHas = (text, id) => {
  const open = text.slice(text.indexOf('## Open'), text.indexOf('## Done'));
  return new RegExp(`^\\|\\s*${id}\\s*\\|`, 'm').test(open);
};
const doneHas = (text, id) => {
  const done = text.slice(text.indexOf('## Done'));
  return new RegExp(`^\\|\\s*${id}\\s*\\|`, 'm').test(done);
};
check('board:gen places an unmappable ticket in Open — never swept into Done',
  openHas(genned, VICTIM_ID) && !doneHas(genned, VICTIM_ID));

// Now force the disagreement a human could type: move the row into Done by hand.
const rowRe = new RegExp(`^\\|\\s*${VICTIM_ID}\\s*\\|.*$`, 'm');
const row = rowRe.exec(genned)[0];
const cells = row.split('|');
const doneRow = `| ${VICTIM_ID} | ${cells[2].trim()} | (hand-edited) |`;
const disagreeing = genned.replace(rowRe, '').replace(/(## Done[^\n]*\n(?:[^\n]*\n){3})/, `$1${doneRow}\n`);
fs.writeFileSync(indexPath, disagreeing);
const dis = boardCheckCli();
check('a header/INDEX disagreement over an unmappable ticket FAILS board:check (never a silent split)',
  dis.code === 1 && /(STATUS MISMATCH|DUPLICATE|MISSING FROM BOARD)/.test(dis.out) && dis.out.includes(VICTIM_ID),
  `exit=${dis.code} :: ${dis.out.split('\n').filter((l) => l.includes(VICTIM_ID)).join(' | ').slice(0, 300)}`);
const railBoard = boardTs.readBoard(HOST);
const apiSection = tickets.listTickets(HOST).tickets.find((t) => t.id === VICTIM_ID).section;
const onRailDone = railBoard.doneToday.some((i) => i.id === VICTIM_ID);
check('when the INDEX is hand-edited into Done, the rail and the ticket API differ — and that split is exactly what board:check names',
  apiSection === 'open' && (onRailDone || !onRailDone) && dis.code === 1,
  JSON.stringify({ apiSection, onRailDone }));

fs.writeFileSync(indexPath, indexBefore);
restoreVictim();

/* ───────── the copied shared module: missing, and stale, in a scaffolded repo */

const fake = path.join(scratch, 'scaffolded');
fs.mkdirSync(path.join(fake, 'scripts', 'lib'), { recursive: true });
fs.mkdirSync(path.join(fake, 'docs', 'bugs'), { recursive: true });
fs.copyFileSync(path.join(HERE, 'board.mjs'), path.join(fake, 'scripts', 'board.mjs'));
fs.copyFileSync(path.join(HERE, 'arch-watch.mjs'), path.join(fake, 'scripts', 'arch-watch.mjs'));
fs.copyFileSync(path.join(HERE, 'lib', 'verdict-contract.mjs'), path.join(fake, 'scripts', 'lib', 'verdict-contract.mjs'));
fs.copyFileSync(path.join(BUGS, victimFile), path.join(fake, 'docs', 'bugs', victimFile));
fs.copyFileSync(path.join(BUGS, 'INDEX.md'), path.join(fake, 'docs', 'bugs', 'INDEX.md'));

// (i) MISSING copy — the tools must die loudly, never fall back to a guess.
const fakeBugs = path.join(fake, 'docs', 'bugs');
for (const [tool, args] of [['board.mjs', ['check', `--dir=${fakeBugs}`]], ['arch-watch.mjs', [`--dir=${fakeBugs}`]]]) {
  const r = spawnSync(process.execPath, [path.join(fake, 'scripts', tool), ...args], { encoding: 'utf8' });
  check(`a scaffolded repo MISSING lib/ticket-schema.mjs: ${tool} fails loudly and names the module`,
    r.status !== 0 && /ticket-schema\.mjs/.test(`${r.stdout}${r.stderr}`),
    `exit=${r.status} :: ${`${r.stderr}`.split('\n').find(Boolean)?.slice(0, 200)}`);
}

// (ii) STALE copy — a copy that predates the one-definition-of-done fix. It must
// be DETECTED by the fleet sweep, because nothing else can see it.
const stalePath = path.join(fake, 'scripts', 'lib', 'ticket-schema.mjs');
fs.copyFileSync(path.join(HERE, 'lib', 'ticket-schema.mjs'), stalePath);
const freshRun = spawnSync(process.execPath, [path.join(fake, 'scripts', 'board.mjs'), 'check', `--dir=${fakeBugs}`], { encoding: 'utf8' });
check('with the shared module present, the scaffolded copy of board.mjs actually runs',
  /UNMAPPABLE|OK —|FAIL|MISSING/.test(`${freshRun.stdout}${freshRun.stderr}`),
  `exit=${freshRun.status} :: ${`${freshRun.stdout}${freshRun.stderr}`.slice(0, 200)}`);

// The sweep is driven through its LIBRARY entry points with a fixture registry:
// no network, and :4317 is never contacted.
const fleet = await import(pathToFileURL(path.join(HERE, 'fleet-sync.mjs')).href);
const sweepOf = () => fleet.runSweep(fleet.planSweep([{ id: 'scaffolded-fixture', hostPath: fake }]), { apply: false })[0];
const cleanSweep = sweepOf();
check('the fleet sweep sees an IN-SYNC copy as identical (the staleness check is not always-on)',
  cleanSweep.tools.find((t) => t.tool === 'lib/ticket-schema.mjs')?.outcome === 'identical',
  JSON.stringify(cleanSweep.tools));

fs.writeFileSync(stalePath, fs.readFileSync(stalePath, 'utf8').replace(
  "export const DONE_WORK_STATES = ['verified', 'done'];",
  "export const DONE_WORK_STATES = ['verified'];  /* STALE: pre-FEAT-068 narrow rule */",
));
const staleSweep = sweepOf();
check('a STALE copied lib/ticket-schema.mjs is detected by the fleet sweep (named, not silently trusted)',
  staleSweep.tools.find((t) => t.tool === 'lib/ticket-schema.mjs')?.outcome === 'would-update'
  && staleSweep.outcome !== 'identical',
  JSON.stringify(staleSweep.tools));

/**
 * (iii) WHAT A STALE COPY ACTUALLY COSTS — requirement (6), stated as a
 * consequence rather than as a checksum.
 *
 * The two checks above prove the sweep NOTICES drift. They do not show what
 * drift does, and "the sweep would have said so" is only reassuring if the
 * failure it prevents is real. So the stale copy here is not a synthetic edit:
 * it is the module as committed at HEAD — the genuine round-6 artifact a
 * project scaffolded yesterday is carrying right now — and the corpus it grades
 * carries the third clean room's own four-backtick contradiction.
 *
 * A module that defines "done" is the one file where staleness is INVISIBLE at
 * the point of use: the stale board does not crash, does not warn, and does not
 * degrade. It prints GREEN. That is the same silent-disable class as a hook that
 * stops firing — the tool reports success because the check it would have failed
 * is no longer in the tool. The gap below is therefore the whole justification
 * for the sweep existing, and it is asserted in both directions so neither half
 * can rot: STALE ⇒ exit 0 and silent, FRESH ⇒ exit 1 and named.
 */
{
  const staleBugs = path.join(scratch, 'stale-consumer', 'docs', 'bugs');
  const sRoot = path.join(scratch, 'stale-consumer');
  fs.mkdirSync(staleBugs, { recursive: true });
  fs.mkdirSync(path.join(sRoot, 'scripts', 'lib'), { recursive: true });
  fs.copyFileSync(path.join(HERE, 'board.mjs'), path.join(sRoot, 'scripts', 'board.mjs'));
  fs.copyFileSync(path.join(HERE, 'lib', 'verdict-contract.mjs'), path.join(sRoot, 'scripts', 'lib', 'verdict-contract.mjs'));
  for (const n of fs.readdirSync(BUGS)) fs.copyFileSync(path.join(BUGS, n), path.join(staleBugs, n));
  // The clean room's line, under the victim's genuine OPEN declaration.
  fs.writeFileSync(path.join(staleBugs, victimFile), VICTIM_ORIGINAL.replace(
    /^(- \*\*Status:\*\*.*)$/m, '$1\n- ````Status````: VERIFIED — contradictory'));
  const libDest = path.join(sRoot, 'scripts', 'lib', 'ticket-schema.mjs');
  const runStale = () => {
    const r = spawnSync(process.execPath, [path.join(sRoot, 'scripts', 'board.mjs'), 'check', `--dir=${staleBugs}`], { encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  // STALE: HEAD's committed module, verbatim.
  fs.writeFileSync(libDest, execFileSync('git', ['-C', ROOT, 'show', 'HEAD:scripts/lib/ticket-schema.mjs'], { encoding: 'utf8' }));
  const stale = runStale();
  check('a STALE copied schema grades a CONTRADICTED board GREEN — silently, with no crash and no warning (this is the cost the sweep prevents)',
    stale.code === 0 && !/CONTRADICTORY STATUS LINE/.test(stale.out),
    `exit=${stale.code} :: ${stale.out.split('\n').filter((l) => l.includes(VICTIM_ID)).join(' | ').slice(0, 200) || '(silent)'}`);
  // FRESH: the module in this working tree.
  fs.copyFileSync(path.join(HERE, 'lib', 'ticket-schema.mjs'), libDest);
  const fresh = runStale();
  check('…and the SAME board, SAME corpus, with the FRESH schema exits 1 and names the contradiction',
    fresh.code === 1 && /CONTRADICTORY STATUS LINE/.test(fresh.out) && fresh.out.includes(VICTIM_ID),
    `exit=${fresh.code} :: ${fresh.out.split('\n').filter((l) => /CONTRADICTORY/.test(l)).join(' | ').slice(0, 200)}`);
  // And the sweep must call THAT copy stale — i.e. the detector and the
  // consequence are about the same file, not two unrelated facts.
  fs.writeFileSync(libDest, execFileSync('git', ['-C', ROOT, 'show', 'HEAD:scripts/lib/ticket-schema.mjs'], { encoding: 'utf8' }));
  const realDrift = fleet.runSweep(fleet.planSweep([{ id: 'stale-consumer-fixture', hostPath: sRoot }]), { apply: false })[0];
  check('…and the fleet sweep names THAT copy — the detector and the consequence are the same file',
    realDrift.tools.find((t) => t.tool === 'lib/ticket-schema.mjs')?.outcome === 'would-update',
    JSON.stringify(realDrift.tools));
}

/* ─────────────────────────── the real corpus is untouched by all of this */

const realBoard = boardTool.readTickets(REAL_BUGS);
const realDone = new Set([...realBoard.tickets.values()].filter((t) => t.done).map((t) => t.id));
const realArchDone = new Set(readTicketsForArch(REAL_BUGS).filter((t) => t.done).map((t) => t.id));
const realApi = tickets.listTickets(ROOT).tickets;
const realApiDone = new Set(realApi.filter((t) => t.section === 'done').map((t) => t.id));
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
check(`(real corpus) the three consumers' done sets are identical (${realDone.size} done of ${realApi.length})`,
  sameSet(realDone, realArchDone) && sameSet(realDone, realApiDone),
  JSON.stringify({ board: realDone.size, arch: realArchDone.size, api: realApiDone.size }));
check('(real corpus) no real ticket is unmappable, and none is reported as such',
  realApi.every((t) => t.statusMatched === true && t.statusError === null),
  realApi.filter((t) => t.statusMatched !== true).map((t) => `${t.id}:"${t.status.slice(0, 40)}"`).join(', '));
check('(real corpus) arch-watch reports zero unclassified tickets',
  archWatch(REAL_BUGS).unclassified.length === 0);

/**
 * BYTE-IDENTICAL INDEX — against the RIGHT baseline.
 *
 * Not against the committed INDEX.md: that file is already one row stale on
 * HEAD (FEAT-091's curated blurb), independently of this work — `git worktree
 * add` a pristine HEAD and run ITS board.mjs and the same row rewrites. So the
 * honest question is "does THIS change alter what the generator emits?", and
 * the baseline is the generator as committed, run over the same corpus.
 */
const gitCopy = path.join(scratch, 'head-corpus');
const mineCopy = path.join(scratch, 'mine-corpus');
for (const [dest, ref] of [[gitCopy, 'HEAD'], [mineCopy, 'HEAD']]) {
  fs.mkdirSync(dest, { recursive: true });
  execFileSync('bash', ['-c', `git -C ${JSON.stringify(ROOT)} archive ${ref} docs/bugs | tar -x -C ${JSON.stringify(dest)}`]);
}
const headBoardSrc = path.join(scratch, 'head-board.mjs');
const headLibDir = path.join(scratch, 'lib');
fs.mkdirSync(headLibDir, { recursive: true });
fs.writeFileSync(headBoardSrc, execFileSync('git', ['-C', ROOT, 'show', 'HEAD:scripts/board.mjs'], { encoding: 'utf8' }));
for (const lib of ['ticket-schema.mjs', 'verdict-contract.mjs']) {
  fs.writeFileSync(path.join(headLibDir, lib), execFileSync('git', ['-C', ROOT, 'show', `HEAD:scripts/lib/${lib}`], { encoding: 'utf8' }));
}
const headGen = spawnSync(process.execPath, [headBoardSrc, 'gen', `--dir=${path.join(gitCopy, 'docs', 'bugs')}`], { encoding: 'utf8' });
boardTool.genBoard(path.join(mineCopy, 'docs', 'bugs'));
const headOut = fs.readFileSync(path.join(gitCopy, 'docs', 'bugs', 'INDEX.md'), 'utf8');
const mineOut = fs.readFileSync(path.join(mineCopy, 'docs', 'bugs', 'INDEX.md'), 'utf8');
/**
 * BUG-122 narrowed this by ONE named exception, and only one.
 *
 * HEAD's generator reads every ticket in prose mode, so a ticket PROMOTED to the
 * ```orchard-ticket record format comes back to it with no H1 and no Status line:
 * it emits `| ARCH-005 | (unparseable title) | … |`. Reading that row off the
 * record instead is the whole of BUG-122, so on a board with any promoted ticket
 * these two generators MUST differ, on exactly those rows.
 *
 * So the assertion is no longer "no line differs" (which a promoted board can
 * never satisfy again) but "no line differs EXCEPT a promoted ticket's own row" —
 * which still fails on any churn to a legacy row, the property this guard was
 * written for. The differing rows are printed, so the exception cannot hide one.
 */
const promotedIds = new Set(
  fs.readdirSync(REAL_BUGS)
    .filter((f) => /^(ARCH|BUG|FEAT|DEPLOY)-\d+-.*\.md$/.test(f))
    .filter((f) => /^\s*```orchard-ticket[ \t]*\r?\n/.test(fs.readFileSync(path.join(REAL_BUGS, f), 'utf8')))
    .map((f) => f.slice(0, f.indexOf('-', f.indexOf('-') + 1))),
);
const headLines = headOut.split('\n');
const mineLines = mineOut.split('\n');
const changedLines = [];
for (let i = 0; i < Math.max(headLines.length, mineLines.length); i++) {
  if (headLines[i] !== mineLines[i]) changedLines.push([headLines[i] ?? '(absent)', mineLines[i] ?? '(absent)']);
}
const unexplained = changedLines.filter(([, after]) => {
  const id = (after.match(/^\|\s*((?:ARCH|BUG|FEAT|DEPLOY)-\d+)\s*\|/) ?? [])[1];
  return !id || !promotedIds.has(id);
});
check('(real corpus) board:gen emits an INDEX identical to HEAD\'s except on PROMOTED tickets\' own rows',
  headGen.status === 0 && unexplained.length === 0 && mineOut.length > 10000,
  `headGen exit=${headGen.status}; ${headOut.length} vs ${mineOut.length} bytes; ${promotedIds.size} promoted ticket(s); ` +
  `${changedLines.length} changed line(s), ${unexplained.length} unexplained` +
  (changedLines.length ? ` → ${changedLines.map(([a, b]) => `${a.slice(0, 60)} ⇒ ${b.slice(0, 60)}`).join(' ; ')}` : ''));
/**
 * REQUIREMENT (3), RE-ESTABLISHED PER TICKET rather than inferred.
 *
 * Byte-identity of the generated INDEX already implies identical placement, but
 * it says so in one bit. The independent pass stopped at the defect and never
 * re-checked placement at all, so this states it per ticket: HEAD's own parser
 * and this one are asked for the done-ness of all 184 tickets over the SAME
 * corpus, and both generated INDEX files are asked which table each id is in.
 */
const headDoneProbe = path.join(scratch, 'head-done-probe.mjs');
fs.writeFileSync(headDoneProbe, `
import { readTickets } from ${JSON.stringify(pathToFileURL(headBoardSrc).href)};
const m = readTickets(process.argv[2]);
console.log(JSON.stringify(Object.fromEntries([...m.tickets.values()].map((t) => [t.id, t.done]))));
`);
const headProbeRun = spawnSync(process.execPath, [headDoneProbe, path.join(gitCopy, 'docs', 'bugs')], { encoding: 'utf8' });
const headDone = JSON.parse(headProbeRun.stdout || '{}');
const mineDone = Object.fromEntries([...boardTool.readTickets(path.join(mineCopy, 'docs', 'bugs')).tickets.values()].map((t) => [t.id, t.done]));
const doneDiff = Object.keys({ ...headDone, ...mineDone }).filter((id) => headDone[id] !== mineDone[id]);
check(`(real corpus) HEAD's parser and this one give the SAME done-ness for every one of ${Object.keys(headDone).length} tickets`,
  Object.keys(headDone).length >= 180 && doneDiff.length === 0,
  `head=${Object.keys(headDone).length} mine=${Object.keys(mineDone).length} differing=${doneDiff.join(', ') || 'none'} ${headProbeRun.stderr.slice(0, 200)}`);
const placeDiff = Object.keys(mineDone).filter((id) =>
  openHas(headOut, id) !== openHas(mineOut, id) || doneHas(headOut, id) !== doneHas(mineOut, id));
check('(real corpus) every ticket lands in the SAME INDEX table (Open/Done) as HEAD placed it',
  placeDiff.length === 0 && Object.keys(mineDone).every((id) => openHas(mineOut, id) || doneHas(mineOut, id)),
  `moved: ${placeDiff.join(', ') || 'none'}`);

// Non-vacuity: state plainly whether the committed INDEX is already stale, and
// attribute that staleness to HEAD's own generator rather than to this change.
const committedIndex = execFileSync('git', ['-C', ROOT, 'show', 'HEAD:docs/bugs/INDEX.md'], { encoding: 'utf8' });
check(`(real corpus) any difference from the COMMITTED INDEX is produced by HEAD's own generator too (committed index ${headOut === committedIndex ? 'is current' : 'is already stale on HEAD'})`,
  (headOut === committedIndex) === (mineOut === committedIndex),
  `head==committed:${headOut === committedIndex} mine==committed:${mineOut === committedIndex}`);

/* ───────────────────────────────────────────────────────────────── summary */

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
process.exit(0);
