/**
 * verify-ticket-schema.mjs — steps 1 and 2 of
 * docs/analysis/ticket-board-redesign-plan.md §8.
 *
 * WHAT IT PROVES, in the order the plan asks for it:
 *
 *  (A) PORTABILITY. ticket-schema.mjs is import-free, so copying it into an
 *      onboarded repo cannot drag a dependency along.
 *  (B) THE TYPE DECLARATIONS ARE HONEST. Every name ticket-schema.d.mts
 *      declares exists at runtime — a .d.mts can otherwise promise anything.
 *  (C) ONE DEFINITION OF DONE, over the REAL corpus, IN BOTH FORMATS. board.mjs,
 *      tickets.ts and arch-watch.mjs classify every real ticket identically —
 *      legacy prose tickets off their `- **Status:**` line, promoted tickets off
 *      their ```orchard-ticket record. Before this work they disagreed on 12,
 *      including BUG-090, whose status is the single word `FIXED`: Done to the
 *      board tool, Open to the ticket API.
 *  (D) NO LEGACY TICKET MOVED. The pre-fix board.mjs rule is transcribed here
 *      and replayed over the PROSE half of the real corpus; the done SET is
 *      byte-identical. The disagreement was fixed by promoting the deliberated
 *      rule, not by reshuffling the board. Promoted tickets are excluded by
 *      name — the transcribed rules read a status LINE, which a promoted ticket
 *      does not have — and (D) fails loudly if the prose half is ever empty.
 *  (E) AN UNCLASSIFIABLE STATUS IS REPORTED, NOT GUESSED.
 *  (F) TRUNCATED AND MALFORMED INPUT does not throw and does not silently
 *      produce a plausible-looking record.
 *  (G) THE NEW-FORMAT VALIDATOR rejects each thing §2.2 says it must, and
 *      formatTicket → parseTicket round-trips.
 *  (H) THE MODULE IS GENUINELY SHARED, not copied: the consumers hold the same
 *      function OBJECT, and an onboarded project's copied board.mjs really runs
 *      — and really breaks if the shared module is missing, which is what makes
 *      (H) non-vacuous.
 *
 * Run: node scripts/verify-ticket-schema.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import * as S from './lib/ticket-schema.mjs';
import * as boardTool from './board.mjs';
import { readTicketsForArch } from './arch-watch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const BUGS = path.join(repoRoot, 'docs', 'bugs');

let pass = 0;
const failures = [];
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`PASS: ${label}`); }
  else { failures.push(label); console.log(`FAIL: ${label}${detail ? ` — ${String(detail).slice(0, 400)}` : ''}`); }
}

/* ───────────────────────────────────── (A) portability: no imports at all */

const schemaSrc = fs.readFileSync(path.join(repoRoot, 'scripts', 'lib', 'ticket-schema.mjs'), 'utf8');
check('(A) ticket-schema.mjs has no import statements (copied into onboarded repos verbatim)',
  !/^\s*import\s/m.test(schemaSrc) && !/\brequire\s*\(/.test(schemaSrc),
  schemaSrc.split('\n').filter((l) => /^\s*import\s/.test(l)).join(' | '));
check('(A) ticket-schema.mjs is a single file with no dynamic import', !/\bimport\s*\(/.test(schemaSrc));

/* ────────────────────────────── (B) the .d.mts declares only real exports */

const dts = fs.readFileSync(path.join(repoRoot, 'scripts', 'lib', 'ticket-schema.d.mts'), 'utf8');
const declared = [...dts.matchAll(/^export (?:declare )?(?:function|const) (\w+)/gm)].map((m) => m[1]);
const missing = declared.filter((n) => !(n in S));
check(`(B) every value ticket-schema.d.mts declares exists at runtime (${declared.length} names)`,
  missing.length === 0, `missing: ${JSON.stringify(missing)}`);

/* ─────────────────── (C)+(D) the real corpus, all three call sites, no moves */

/**
 * The PRE-FIX board.mjs rule, transcribed verbatim from commit a01bd3f. This is
 * the baseline (D) compares against, so it must NOT be imported from the module
 * under test — a shared implementation would make the comparison vacuous.
 */
function preFixBoardIsDone(raw) {
  if (!raw) return false;
  const s = raw.toUpperCase().trim();
  if (/^VERIFIED\b/.test(s)) return true;
  if (/^(?:RE-)?FIXED\b/.test(s)) return true;
  if (/^RESOLVED\b/.test(s)) return true;
  if (/\bDONE\b/.test(s)) return true;
  return false;
}
/** The PRE-FIX tickets.ts / arch-watch.mjs rule, likewise transcribed. */
function preFixNarrowIsDone(raw) {
  const s = String(raw || '').toUpperCase();
  return /^VERIFIED\b/.test(s.trim()) || /\bDONE\b/.test(s);
}

/**
 * THE CORPUS IS READ THE WAY THE CONSUMERS READ IT — both formats (BUG-122).
 *
 * Every case here used to be built from `legacyField(text, 'Status')`, the prose
 * `- **Status:**` line. A PROMOTED ticket (a leading ```orchard-ticket record)
 * has no such line: it arrived with `statusRaw: ""` and failed "every real
 * ticket's status maps to a work_state" — one failure on ARCH-005 today, 191 at
 * the migration cutover, none of them a defect. A suite that reddens because the
 * product is being used as designed is the trap docs/CONVENTIONS.md names.
 *
 * So the corpus is split by FORMAT and each half graded by the rule that governs
 * it — prose tickets by the legacy status table, promoted tickets by their
 * record's `work_state`, read through `parseTicket().summary`, the one consumer
 * view board.mjs, tickets.ts and the dashboard all read. Nothing is merely
 * excluded: the classification property below is TOTAL over both halves, and
 * every promoted id is printed so an exception cannot hide one.
 */
function readCorpus(dir) {
  const out = [];
  for (const file of fs.readdirSync(dir)) {
    if (!S.TICKET_FILE_RE.test(file)) continue;
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const parsed = S.parseTicket(text, { file, mode: 'auto', requireEmDash: true });
    out.push({
      file,
      id: S.idFromFilename(file),
      text,
      promoted: parsed.format === 'block',
      summary: parsed.summary,
      // The prose reading. Meaningful only on a legacy ticket, and never read
      // for a promoted one — see `undetermined` below.
      statusRaw: S.legacyField(text, 'Status'),
    });
  }
  return out;
}

/**
 * THE PROPERTY, stated once so the real board and a constructed violation are
 * graded by the SAME predicate: every ticket's work_state is DETERMINED — by
 * the legacy table if it is prose, by its own record if it is promoted — and a
 * ticket that determines none is named, whichever format it is in.
 */
function undetermined(entries) {
  return entries.filter((t) => (t.promoted
    ? !(S.WORK_STATES.indexOf(t.summary.work_state) !== -1 && t.summary.statusError === null)
    : !S.classifyLegacyStatus(t.statusRaw).matched));
}
const describe = (t) => `${t.id}[${t.promoted ? 'promoted' : 'prose'}]:"${
  String(t.promoted ? t.summary.work_state : t.statusRaw).slice(0, 50)}"`;

const corpus = readCorpus(BUGS);
const legacyCorpus = corpus.filter((t) => !t.promoted);
const promotedCorpus = corpus.filter((t) => t.promoted);
/** Names, not just a count — an exception that cannot be read hides what it excludes. */
const idList = (xs, cap = 12) => (xs.length <= cap
  ? xs.map((t) => t.id).join(', ')
  : `${xs.slice(0, cap).map((t) => t.id).join(', ')}, … +${xs.length - cap} more`);
console.log(`# corpus: ${corpus.length} tickets — ${legacyCorpus.length} legacy prose, `
  + `${promotedCorpus.length} promoted${promotedCorpus.length ? ` (${idList(promotedCorpus)})` : ''}`);
check(`(C) read the real corpus (${corpus.length} tickets in docs/bugs)`, corpus.length >= 150, corpus.length);

const boardDone = new Set([...boardTool.readTickets(BUGS).tickets.values()].filter((t) => t.done).map((t) => t.id));
const archDone = new Set(readTicketsForArch(BUGS).filter((t) => t.done).map((t) => t.id));
// tickets.ts's rule, reached the same way tickets.ts reaches it: `.summary.done`
// off one `parseTicket(…, { mode: 'auto' })`, for BOTH formats. Reading
// `isDoneStatus` off the prose line here — as this did — would call every
// promoted DONE ticket open the moment the migration runs, and report it as a
// three-way disagreement between board.mjs and an API that never said that.
const apiDone = new Set(corpus.filter((t) => t.summary.done).map((t) => t.id));

const threeWay = corpus.filter((t) => {
  const b = boardDone.has(t.id), a = archDone.has(t.id), p = apiDone.has(t.id);
  return !(b === a && a === p);
});
check(`(C) board.mjs, arch-watch.mjs and the ticket API agree on every ticket (${threeWay.length} disagree)`,
  threeWay.length === 0, threeWay.map((t) => `${t.id}:"${t.statusRaw.slice(0, 40)}"`).join(', '));

// The named regression case, by name. The PROSE half of it is asserted only
// while BUG-090 is still a prose ticket — promoting it replaces its status line
// with a `work_state`, which is the migration working, not the case rotting. The
// substance of the case ("Done to all three call sites") is format-independent
// and is asserted below either way.
const bug090 = corpus.find((t) => t.id === 'BUG-090');
check(`(C) BUG-090 exists in the corpus with the bare status "FIXED"${bug090 && bug090.promoted ? ' — n/a, it is promoted; its record states work_state directly' : ''}`,
  !!bug090 && (bug090.promoted ? S.isDoneWorkState(bug090.summary.work_state) : bug090.statusRaw === 'FIXED'),
  bug090 && (bug090.promoted ? bug090.summary.work_state : bug090.statusRaw));
if (bug090) {
  check('(C) BUG-090 is Done to ALL THREE call sites (it used to be Done to one and Open to two)',
    boardDone.has('BUG-090') && archDone.has('BUG-090') && apiDone.has('BUG-090'),
    `board=${boardDone.has('BUG-090')} arch=${archDone.has('BUG-090')} api=${apiDone.has('BUG-090')}`);
  check('(C) the OLD narrow rule really did call BUG-090 open (this check is not vacuous)',
    preFixNarrowIsDone('FIXED') === false && preFixBoardIsDone('FIXED') === true);
}

/**
 * (D) IS A CLAIM ABOUT PROSE, so it is asserted over the prose half only — and
 * the exclusion is NAMED, never silent. The pre-fix rules transcribed above read
 * a `- **Status:**` line; a promoted ticket has none, so replaying them over one
 * would compare the old rule's answer about an empty string with the new
 * reader's answer about a record. That is not a regression, it is two different
 * questions.
 *
 * When the LAST legacy ticket is promoted this guard has no subject at all, and
 * it says so LOUDLY rather than passing on an empty set: a check that finds no
 * candidate and reports success proves nothing (docs/CONVENTIONS.md). The remedy
 * at that point is to delete (D) and the narrow-rule comparison, or to re-anchor
 * them to a corpus snapshot pinned at the parser-collapse revision — not to
 * leave them running on nothing.
 */
check('(D) legacy prose tickets still exist for the pre-fix comparison to be ABOUT',
  legacyCorpus.length > 0,
  'the board is fully promoted — (D) and the narrow-rule comparison below are guards over a corpus that no longer exists; '
  + 'delete them or re-anchor them to a pinned snapshot of the parser-collapse revision');

// The dependent checks below say `legacyCorpus.length === 0 || …` so that a
// fully-promoted board produces exactly ONE loud failure — the one above, which
// carries the remedy — instead of a wall of derived ones saying the same thing.
const moved = legacyCorpus.filter((t) => preFixBoardIsDone(t.statusRaw) !== boardDone.has(t.id));
check(`(D) no legacy ticket changed board placement: the done set is identical to the pre-fix board.mjs rule's (${boardDone.size} done, ${promotedCorpus.length} promoted ticket(s) excluded: ${idList(promotedCorpus) || 'none'})`,
  legacyCorpus.length === 0 || moved.length === 0, idList(moved));

const narrowOnly = legacyCorpus.filter((t) => preFixNarrowIsDone(t.statusRaw) !== boardDone.has(t.id));
// PROPERTY, NOT A COUNT. This asserted `narrowOnly.length === 12` and reddened
// the moment anyone wrote a new `FIXED`/`VERIFIED` status line the old narrow
// rule would not have matched — i.e. every time the board is used correctly.
// (Observed 2026-08-20: closing ARCH-009 and BUG-119 and adding BUG-122 took it
// to 15 with no defect anywhere.) The invariant the count was standing in for is
// directional: the narrow rule UNDER-counted, calling done tickets open, and
// never the reverse. That is what is asserted, plus non-vacuity.
const narrowSaidOpen = narrowOnly.filter((t) => boardDone.has(t.id));
const narrowSaidDone = narrowOnly.filter((t) => !boardDone.has(t.id));
check(`(D) the ticket API and arch-watch changed on exactly the tickets the narrow rule got wrong (${narrowOnly.length})`,
  legacyCorpus.length === 0 || (narrowOnly.length > 0 && narrowSaidDone.length === 0),
  narrowSaidDone.length
    ? `narrow called these DONE while the board calls them open: ${narrowSaidDone.map((t) => t.id).join(', ')}`
    : `${narrowSaidOpen.length} tickets the narrow rule called open and the board calls done: ${narrowSaidOpen.map((t) => t.id).join(', ')}`);

// EVERY REAL TICKET'S WORK_STATE IS DETERMINED, whichever format it is in. If
// this fails, either a NEW unmapped status word has entered the board (the
// mapping table needs a deliberate decision, not a default) or a promoted
// record declares a work_state the schema does not know — and the message says
// which kind, because the two have different remedies.
const undet = undetermined(corpus);
check(`(C) every real ticket's work_state is determined — ${legacyCorpus.length} by the legacy status table, ${promotedCorpus.length} by its own record (${undet.length} undetermined)`,
  undet.length === 0, undet.map(describe).join(', '));

/**
 * …AND THE CHECK ABOVE STILL BITES, on both arms. Green over a board that
 * happens to be clean says nothing, so the SAME predicate is run over a copy of
 * the REAL board carrying one constructed violation of each kind: a real legacy
 * ticket given a status word nobody defined, and a real ticket promoted with a
 * record whose `work_state` is not a work_state. The baseline is the constructed
 * violation itself, never a revision — a HEAD-anchored one becomes the fixed
 * state the moment the fix commits (docs/CONVENTIONS.md).
 */
{
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-schema-determined-'));
  try {
    for (const t of corpus) fs.writeFileSync(path.join(probeDir, t.file), t.text);
    // The BLOCK arm needs only a real ticket to promote, so it runs on any
    // board. The PROSE arm needs a prose ticket, and a board with none is
    // already the single loud (D) failure above.
    const proseVictim = legacyCorpus[0];
    const blockVictim = corpus.find((t) => t !== proseVictim) ?? corpus[0];
    check('(C) the determination probe has a real ticket to break', !!blockVictim,
      `prose=${proseVictim?.id ?? 'n/a (fully-promoted board)'} block=${blockVictim?.id ?? 'NONE'}`);
    if (blockVictim) {
      // (i) a legacy ticket whose status word the table does not map.
      if (proseVictim) {
        fs.writeFileSync(path.join(probeDir, proseVictim.file),
          proseVictim.text.replace(/^- \*\*Status:\*\*.*$/m, '- **Status:** MARINATING — waiting on nothing in particular'));
      }
      // (ii) the same board with a ticket PROMOTED onto a record that declares
      // a work_state nobody defined. Real prose below, one constructed record
      // above it — which is exactly the shape a half-finished promotion leaves.
      fs.writeFileSync(path.join(probeDir, blockVictim.file),
        '```orchard-ticket\n' + JSON.stringify({ id: blockVictim.id, work_state: 'nearly' }, null, 2) + '\n```\n'
        + blockVictim.text);
      const broken = undetermined(readCorpus(probeDir));
      const brokenIds = new Set(broken.map((t) => t.id));
      check('(C) …a legacy ticket with an unmappable status word is NAMED by the same predicate',
        !proseVictim || brokenIds.has(proseVictim.id),
        broken.map(describe).join(', ') || 'NOTHING REPORTED — the check is vacuous');
      check('(C) …and so is a PROMOTED ticket whose record declares a work_state nobody defined',
        brokenIds.has(blockVictim.id), broken.map(describe).join(', ') || 'NOTHING REPORTED — the check is vacuous');
      check('(C) …and the probe board is otherwise clean, so it is the injected ticket(s) that are reported, not the corpus',
        broken.length === (proseVictim ? 2 : 1), broken.map(describe).join(', '));
    }
  } finally { fs.rmSync(probeDir, { recursive: true, force: true }); }
}

// work_state and placement can never contradict each other — over BOTH formats,
// each read the way its own consumers read it.
const contradictions = corpus.filter((t) => {
  if (t.promoted) return t.summary.done !== S.isDoneWorkState(t.summary.work_state);
  const c = S.classifyLegacyStatus(t.statusRaw);
  return c.done !== S.isDoneWorkState(c.workState);
});
check('(C) done-ness is derived from work_state, so the two cannot contradict', contradictions.length === 0,
  contradictions.map(describe).join(', '));

/* ─────────────────────── classification units, including the malformed ones */

const CASES = [
  // [status, expected work_state, expected done, expected matched]
  ['VERIFIED', 'verified', true, true],
  ['VERIFIED 2026-08-13 — fixed and deployed', 'verified', true, true],
  // The corpus survey's mangled forms. A state word run into the NEXT FIELD is
  // REJECTED, not repaired — see LEGACY_STATUS_TABLE's note. It is also exactly
  // what the pre-fix rule did, so rejecting moves no ticket.
  ['VERIFIED2026-08-13', null, false, false],
  ['SYNTHESISDONE', null, false, false],                    // likewise run together: rejected, exactly as before
  ['SYNTHESIS — v1 DONE, v2 pending', 'done', true, true],  // the REAL FEAT-020 shape: DONE is a separate token
  ['VERIFIED/DONE', 'verified', true, true],
  ['DONE (2026-08-12)', 'done', true, true],
  ['FIXED', 'done', true, true],
  ['RE-FIXED (7th time)', 'done', true, true],
  ['REFIXED', 'done', true, true],
  ['RESOLVED (2026-08-13)', 'done', true, true],
  ['OPEN', 'open', false, true],
  ['OPEN — needs a decision', 'open', false, true],
  ['IN PROGRESS', 'in_progress', false, true],
  ['IN-PROGRESS — phase 2', 'in_progress', false, true],
  ['IN VERIFICATION', 'in_verification', false, true],
  ['INVERIFICATION', 'in_verification', false, true],       // a missing space INSIDE one state name is accepted
  ['BLOCKED on a deploy', 'blocked', false, true],
  ['NOT-A-BUG', 'not_a_bug', false, true],
  ['not a bug — working as designed', 'not_a_bug', false, true],
  // Incidental words must NOT sweep an open ticket to Done.
  ['OPEN — not yet FIXED', 'open', false, true],
  ['OPEN — this is UNRESOLVED', 'open', false, true],
  ['OPEN — the earlier patch was re-fixed and regressed', 'open', false, true],
  // Unmappable: never guessed.
  ['SOMEDAY MAYBE', null, false, false],
  ['', null, false, false],
  [null, null, false, false],
  [undefined, null, false, false],
];
let clsFails = [];
for (const [raw, ws, done, matched] of CASES) {
  const c = S.classifyLegacyStatus(raw);
  if (c.workState !== ws || c.done !== done || c.matched !== matched) {
    clsFails.push(`${JSON.stringify(raw)} → ${c.workState}/${c.done}/${c.matched}, expected ${ws}/${done}/${matched}`);
  }
}
check(`(C) legacy status classification: ${CASES.length} cases including the corpus's malformed forms`,
  clsFails.length === 0, clsFails.join(' ; '));
check('(C) a mangled state word is rejected exactly as the PRE-FIX rule rejected it — no ticket moves either way',
  preFixBoardIsDone('VERIFIED2026-08-13') === false && S.classifyLegacyStatus('VERIFIED2026-08-13').done === false
  && S.classifyLegacyStatus('VERIFIED2026-08-13').matched === false);

// The verification nuance the single prose status used to lose.
check('(C) FIXED is work_state done + verification_state pending; VERIFIED is verified + holds',
  S.classifyLegacyStatus('FIXED').verificationState === 'pending'
  && S.classifyLegacyStatus('VERIFIED').verificationState === 'holds'
  && S.classifyLegacyStatus('FIXED').done === S.classifyLegacyStatus('VERIFIED').done);

// The ambiguity flag: board.mjs's deliberate match-anywhere DONE, made visible.
const amb = S.classifyLegacyStatus('IN PROGRESS — Phase R DONE; v1 shipped');
check('(C) a not-done leading word swept to Done by an incidental DONE is placed the same as before, but flagged ambiguous',
  amb.done === true && amb.ambiguous === true && preFixBoardIsDone('IN PROGRESS — Phase R DONE; v1 shipped') === true,
  JSON.stringify(amb));
check('(C) an unambiguous status is NOT flagged ambiguous', S.classifyLegacyStatus('VERIFIED 2026-08-13').ambiguous === false);
// Ambiguity is a property of a PROSE status line — a record states one
// `work_state` and cannot be ambiguous — so this is asserted over the legacy
// half, and the empty-legacy case is the loud (D) failure above, not a quiet
// pass here.
const realAmbiguous = legacyCorpus.filter((t) => S.classifyLegacyStatus(t.statusRaw).ambiguous).map((t) => t.id);
check(`(C) the real corpus's ambiguous placements are surfaced by name (${realAmbiguous.length}: ${realAmbiguous.join(', ')})`,
  legacyCorpus.length === 0 || realAmbiguous.length >= 1);

/* ────────────────────────── (E) an unclassifiable status is reported loudly */

const oddDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-schema-odd-'));
try {
  const oddFile = 'BUG-999-a-status-word-nobody-defined.md';
  fs.writeFileSync(path.join(oddDir, oddFile),
    '# BUG-999 — a status word nobody defined\n\n- **Status:** MARINATING — waiting on nothing in particular\n- **Severity:** low\n- **Reported:** 2026-08-19\n');
  const parsed = S.parseTicket(fs.readFileSync(path.join(oddDir, oddFile), 'utf8'), { file: oddFile, mode: 'compat' });
  check('(E) an unmappable status yields work_state null — never a guessed default',
    parsed.record.work_state === null && parsed.record.done === false, JSON.stringify(parsed.record.work_state));
  check('(E) an unmappable status is REPORTED as a named error, quoting the offending status',
    parsed.errors.some((e) => /UNMAPPABLE STATUS/.test(e) && /BUG-999/.test(e)), parsed.errors.join(' | '));
  check('(E) the ticket stays OUT of Done, where a human sees it', parsed.record.done === false);

  // board:check on a board containing it must FAIL, not shrug.
  fs.mkdirSync(path.join(oddDir, 'sub'), { recursive: true });
  const boardRes = boardTool.readTickets(oddDir);
  check('(E) board.mjs surfaces the same error through readTickets',
    boardRes.errors.some((e) => /UNMAPPABLE STATUS/.test(e)), boardRes.errors.join(' | '));
} finally { fs.rmSync(oddDir, { recursive: true, force: true }); }

/* ───────────────────────────── (F) truncated and malformed input never throws */

const MALFORMED = [
  ['empty file', ''],
  ['whitespace only', '   \n\n  '],
  ['H1 but nothing else', '# BUG-001 — a title\n'],
  ['no H1 at all', '- **Status:** OPEN\n'],
  ['H1 with a plain hyphen', '# BUG-001 - a title\n- **Status:** OPEN\n'],
  ['status line truncated mid-word', '# BUG-001 — t\n- **Status:** VERIF'],
  ['file truncated inside the status label', '# BUG-001 — t\n- **Stat'],
  ['a fence that never closes', '```orchard-ticket\n{"id":"BUG-001"'],
  ['block with invalid JSON', '```orchard-ticket\n{"id": }\n```\n\n# BUG-001 — t\n'],
  ['block that is an array', '```orchard-ticket\n[1,2,3]\n```\n'],
  ['block that is a bare string', '```orchard-ticket\n"nope"\n```\n'],
  ['CRLF line endings', '# BUG-001 — t\r\n- **Status:** VERIFIED\r\n'],
  ['a lone CR', '# BUG-001 — t\r- **Status:** VERIFIED\r'],
  // Written as an ESCAPE, never a raw literal NUL: a raw one would make THIS
  // file invisible to the Bash grep shim, which is BUG-103 itself.
  ['NUL byte in the body', '# BUG-001 — t\n- **Status:** OPEN\n\x00\n'],
  ['a 200KB activity log', '# BUG-001 — t\n- **Status:** OPEN\n' + '### 2026-08-01 — x\nbody\n'.repeat(8000)],
];
let threw = [];
for (const [label, text] of MALFORMED) {
  for (const mode of ['auto', 'compat', 'strict']) {
    try { S.parseTicket(text, { file: 'BUG-001-t.md', mode }); }
    catch (e) { threw.push(`${label} [${mode}]: ${e.message}`); }
  }
  try { S.validateTicket(text); } catch (e) { threw.push(`${label} [validate]: ${e.message}`); }
}
for (const junk of [null, undefined, 42, [], {}, true]) {
  try { S.validateTicket(junk); } catch (e) { threw.push(`validateTicket(${JSON.stringify(junk)}): ${e.message}`); }
}
check(`(F) ${MALFORMED.length} truncated/malformed inputs x 3 modes never throw`, threw.length === 0, threw.join(' ; '));

const truncBlock = S.parseTicket('```orchard-ticket\n{"id":"BUG-001"', { file: 'BUG-001-t.md', mode: 'auto' });
check('(F) an UNCLOSED block is not mistaken for a record — it falls through to legacy and reports a malformed H1',
  truncBlock.format === 'legacy' && truncBlock.errors.some((e) => /MALFORMED H1/.test(e)), JSON.stringify(truncBlock.errors));

const badJson = S.parseTicket('```orchard-ticket\n{"id": }\n```\n', { file: 'BUG-001-t.md' });
check('(F) a block with invalid JSON reports MALFORMED TICKET BLOCK and returns no record',
  badJson.ok === false && badJson.record === null && badJson.errors.some((e) => /MALFORMED TICKET BLOCK/.test(e)),
  JSON.stringify(badJson.errors));

const arrBlock = S.parseTicket('```orchard-ticket\n[1,2,3]\n```\n', { file: 'BUG-001-t.md' });
check('(F) a block whose top level is not an object is rejected, not coerced',
  arrBlock.ok === false && arrBlock.record === null, JSON.stringify(arrBlock.errors));

const noBlock = S.parseTicket('# BUG-001 — t\n- **Status:** OPEN\n', { file: 'BUG-001-t.md', mode: 'strict' });
check('(F) strict mode NAMES a file with no orchard-ticket block (§5.6: a half-migrated set fails loudly)',
  noBlock.ok === false && noBlock.errors.some((e) => /NO TICKET BLOCK/.test(e) && /BUG-001-t\.md/.test(e)),
  JSON.stringify(noBlock.errors));

// A fenced block deeper in a body must never be mistaken for the record.
const decoy = S.parseTicket('# BUG-001 — t\n- **Status:** OPEN\n\n```orchard-ticket\n{"id":"BUG-002"}\n```\n', { file: 'BUG-001-t.md' });
check('(F) a fenced orchard-ticket block LOWER in the body is not read as the record',
  decoy.format === 'legacy' && decoy.record.id === 'BUG-001', decoy.format);

/* ───────────────────────────────────────── (G) the new-format validator */

function validRecord(over = {}) {
  return {
    id: 'BUG-001', type: 'bug', title: 'Sidebar drops the newest session',
    summary: 'The sidebar stops listing a session that was created moments ago, so recent work is unreachable from the list.',
    impact_if_we_wait: 'A recent session is unreachable from the sidebar. Display-correctness only; nothing is deleted.',
    current_need: 'A decision on whether to raise the cap or paginate.',
    severity: 'medium', area: 'Sidebar', reported: '2026-08-01', reported_by: 'user',
    // ARCH-009: no `verification_state`. It is not omitted-because-optional —
    // the key no longer exists in the schema at all.
    owner: 'you', work_state: 'open', human_action: 'none',
    updated: '2026-08-19', decision: null, decision_history: [],
    success_criteria: ['The newest session is listed'], code_refs: [], related: [],
    recurrence_evidence: [], verification: [], verification_class: 'fix',
    body_slots: Object.fromEntries(S.BODY_SLOTS.map((s) => [s, false])),
    source: { archived_path: null, sha256: null, confirmation: null, dropped: [] },
    ...over,
  };
}
check('(G) a well-formed record validates clean', S.validateTicket(validRecord()).ok,
  S.validateTicket(validRecord()).violations.join(' | '));

// ARCH-009 — THE FIELD IS GONE, AND SO IS EVERY RULE THAT KEPT IT COHERENT.
//
// BUG-119 asserted here that two real board shapes ("VERIFIED with no
// clean-room dispatch may claim holds", "FIXED with no dispatch may claim
// pending") stayed representable under a work_state-cut rule. Both are now
// vacuously true: there is no state to claim. What replaces them is the
// stronger property — the record CANNOT express a proof state at all, in
// either direction, so it can be neither over-claimed nor under-claimed.
check('(G) ARCH-009: the key is ABSENT from the schema, not optional within it',
  S.REQUIRED_KEYS.indexOf('verification_state') === -1
  && Object.prototype.hasOwnProperty.call(S.RETIRED_KEYS, 'verification_state')
  && /ARCH-009/.test(S.RETIRED_KEYS.verification_state),
  `REQUIRED_KEYS has it? ${S.REQUIRED_KEYS.indexOf('verification_state') !== -1}; RETIRED_KEYS says: ${String(S.RETIRED_KEYS.verification_state).slice(0, 60)}`);
check('(G) ARCH-009: a record carrying no verification_state at all validates clean',
  S.validateTicket(validRecord()).ok, S.validateTicket(validRecord()).violations.join(' | '));

// NO RULE ABOUT ITS VALUE SURVIVES — the difference between "guarded" and
// "impossible". Three shapes that USED to be decided here (a VERIFIED ticket
// claiming holds, a FIXED ticket claiming pending, an OPEN ticket claiming
// proof it has not got) are now all the same non-event: the key is tolerated as
// a leftover on a record already on disk, and NOTHING reads it, so no rule can
// be right or wrong about it. A violation quoting the VALUE would mean a rule
// survived the removal, and that is what this asserts against.
for (const [name, over] of [
  ['a VERIFIED ticket claiming "holds"', { work_state: 'verified', verification_state: 'holds' }],
  ['a FIXED (done) ticket claiming "pending"', { work_state: 'done', verification_state: 'pending' }],
  ['an OPEN ticket claiming proof it has not got', { verification_state: 'holds' }],
  ['an OPEN ticket claiming "broken" with an empty verification[]', { verification_state: 'broken' }],
]) {
  const v = S.validateTicket(validRecord(over));
  check(`(G) ARCH-009: no rule decides anything about ${name} — the leftover key is inert`,
    v.ok && !v.violations.some((x) => /verification_state/.test(x)),
    v.violations.join(' | ') || 'clean');
}
// …but a leftover cannot become a fixture. The one WRITER refuses it.
const rtStrip = S.formatTicket(validRecord({ verification_state: 'holds' }), '\n# BUG-001 — t\n');
check('(G) ARCH-009: formatTicket cannot write the retired key back, whatever it is handed',
  !/verification_state/.test(rtStrip), rtStrip.slice(0, 220));

const REJECTS = [
  ['an unknown key is rejected, not dropped', validRecord({ mood: 'anxious' }), /unknown key "mood"/],
  ['a missing key is named', (() => { const r = validRecord(); delete r.summary; return r; })(), /missing required key "summary"/],
  ['an omitted optional is not the same as null', (() => { const r = validRecord(); delete r.decision; return r; })(), /missing required key "decision"/],
  ['an empty string is rejected — absence is null', validRecord({ area: '' }), /"area" is empty/],
  ['a placeholder word is rejected', validRecord({ area: 'N/A' }), /"area" is "N\/A"/],
  ['a bad enum is named with the legal set', validRecord({ work_state: 'nearly' }), /"work_state" is "nearly" — must be one of/],
  ['a word cap is enforced', validRecord({ summary: 'word '.repeat(61) }), /over its 60-word cap/],
  ['a title cap is enforced', validRecord({ title: 'word '.repeat(13) }), /"title" is 13 words, over its 12-word cap/],
  ['a proposal-shaped title is rejected (contains "+")', validRecord({ title: 'Facets + a proof card' }), /a title enumerating parts of a solution/],
  ['a proposal-shaped title is rejected (contains "(not")', validRecord({ title: 'Use facets (not lanes)' }), /a title arguing against an alternative/],
  ['type must agree with the id', validRecord({ type: 'feature' }), /derives "bug"/],
  ['a bad id shape is rejected', validRecord({ id: 'BUG-1' }), /"id" is "BUG-1"/],
  ['a non-ISO date is rejected', validRecord({ reported: 'August' }), /"reported" must be an ISO date/],
  ['success_criteria may not be empty', validRecord({ success_criteria: [] }), /"success_criteria" is empty/],
  ['an architecture ticket must cite its recurrences', validRecord({ id: 'ARCH-001', type: 'architecture' }), /"recurrence_evidence" must be non-empty/],
  ['a body slot must be a boolean, not absent', validRecord({ body_slots: {} }), /must be a boolean/],
  ['an unknown body slot is rejected', validRecord({ body_slots: { ...Object.fromEntries(S.BODY_SLOTS.map((s) => [s, false])), Rambling: true } }), /unknown body slot/],
  // ARCH-009 deleted three REJECTS that used to live here, all of them about
  // keeping a derived `verification_state` coherent with `verification[]`. They
  // are not relaxed — the thing they constrained no longer exists. The
  // properties that replace them are asserted above, and the one constraint
  // that still bites is the DATA one, kept here:
  ['a verdict must be from the fixed set', validRecord({ verification: [{ provider: 'openai', run_id: 'abc123', verdict: 'mostly' }] }), /"verification\[0\].verdict" is "mostly"/],
  ['a relation must be from the fixed set', validRecord({ related: [{ id: 'BUG-002', relation: 'kinda-like' }] }), /"related\[0\].relation" is "kinda-like"/],
];
const decisionBase = {
  mode: 'single', question: 'Should the cap rise or should the list paginate?',
  options: [
    { key: 'A', label: 'Raise the cap', what_changes: 'The sidebar keeps more sessions in memory.', benefit: 'One line of code.', cost: 'Memory grows with history.', why_not_obvious: 'It defers the same problem to a larger number.' },
    { key: 'B', label: 'Paginate the list', what_changes: 'The sidebar fetches a page at a time.', benefit: 'Bounded memory forever.', cost: 'A scroll handler and a loading state.', why_not_obvious: 'It adds a spinner to a surface that is currently instant.' },
  ],
  recommendation: 'B', recommendation_reason: 'Bounded memory is worth one spinner.', prerequisite: null,
};
REJECTS.push(
  ['a decision needs at least two options', validRecord({ human_action: 'decide', decision: { ...decisionBase, options: [decisionBase.options[0]] } }), /at least 2/],
  ['duplicate option keys are rejected', validRecord({ human_action: 'decide', decision: { ...decisionBase, options: [decisionBase.options[0], { ...decisionBase.options[1], key: 'A' }] } }), /is a duplicate/],
  ['recommendation must name a real option', validRecord({ human_action: 'decide', decision: { ...decisionBase, recommendation: 'Z' } }), /which is not an option key/],
  ['a recommendation without a reason is rejected', validRecord({ human_action: 'decide', decision: { ...decisionBase, recommendation_reason: null } }), /must be non-null when "recommendation" is non-null/],
  ['a reason without a recommendation is rejected', validRecord({ human_action: 'decide', decision: { ...decisionBase, recommendation: null } }), /must be null when "recommendation" is null/],
  ['a question that is not a question is rejected', validRecord({ human_action: 'decide', decision: { ...decisionBase, question: 'We should paginate.' } }), /must end in "\?"/],
  ['combines_with is rejected outside multi mode', validRecord({ human_action: 'decide', decision: { ...decisionBase, options: [{ ...decisionBase.options[0], combines_with: ['B'] }, decisionBase.options[1]] } }), /only valid when mode is "multi"/],
  ['combines_with is REQUIRED in multi mode', validRecord({ human_action: 'decide', decision: { ...decisionBase, mode: 'multi' } }), /required when mode is "multi"/],
  ['stage is rejected outside staged mode', validRecord({ human_action: 'decide', decision: { ...decisionBase, options: [{ ...decisionBase.options[0], stage: 1 }, decisionBase.options[1]] } }), /only valid when mode is "staged"/],
  ['stages is REQUIRED in staged mode', validRecord({ human_action: 'decide', decision: { ...decisionBase, mode: 'staged', options: decisionBase.options.map((o) => ({ ...o, stage: 1 })) } }), /"decision.stages" is required when mode is "staged"/],
  ['a done ticket may not carry a live decision', validRecord({ work_state: 'done', human_action: 'decide', decision: decisionBase }), /a live "decision" is present/],
  ['human_action "decide" with no decision is rejected', validRecord({ human_action: 'decide' }), /but "decision" is null/],
  ['an unknown decision key is rejected', validRecord({ human_action: 'decide', decision: { ...decisionBase, urgency: 'high' } }), /unknown key "decision.urgency"/],
  ['an unknown option key is rejected', validRecord({ human_action: 'decide', decision: { ...decisionBase, options: [{ ...decisionBase.options[0], vibe: 'ok' }, decisionBase.options[1]] } }), /unknown key "decision.options\[0\].vibe"/],
  ['why_not_obvious over its cap is rejected', validRecord({ human_action: 'decide', decision: { ...decisionBase, options: [{ ...decisionBase.options[0], why_not_obvious: 'word '.repeat(31) }, decisionBase.options[1]] } }), /over its 30-word cap/],
);
const rejectFails = [];
for (const [label, rec, re] of REJECTS) {
  const res = S.validateTicket(rec);
  if (res.ok || !res.violations.some((x) => re.test(x))) rejectFails.push(`${label} (got: ${res.violations.join(' | ') || 'NO VIOLATIONS'})`);
}
check(`(G) the validator rejects each of ${REJECTS.length} malformed records with a named violation`,
  rejectFails.length === 0, rejectFails.join('  ///  '));

const liveDecision = validRecord({ human_action: 'decide', decision: decisionBase });
check('(G) a valid live single-mode decision validates clean', S.validateTicket(liveDecision).ok, S.validateTicket(liveDecision).violations.join(' | '));
const multi = validRecord({
  human_action: 'multi_select_decision',
  decision: { ...decisionBase, mode: 'multi', recommendation: 'A + B', options: decisionBase.options.map((o) => ({ ...o, combines_with: ['A', 'B'] })) },
});
check('(G) a valid multi-mode decision with a "+"-joined recommendation validates clean', S.validateTicket(multi).ok, S.validateTicket(multi).violations.join(' | '));
const staged = validRecord({
  human_action: 'staged_decision',
  decision: {
    ...decisionBase, mode: 'staged', recommendation: 'A', options: decisionBase.options.map((o, i) => ({ ...o, stage: i + 1 })),
    stages: [{ stage: 1, question: 'Which inventory do we take first?', unlocked_by: null }],
  },
});
check('(G) a valid staged decision validates clean', S.validateTicket(staged).ok, S.validateTicket(staged).violations.join(' | '));

// Round-trip.
const rt = S.formatTicket(validRecord(), '\n# BUG-001 — t\n\nbody text\n');
const rtParsed = S.parseTicket(rt, { file: 'BUG-001-t.md' });
check('(G) formatTicket → parseTicket round-trips a valid record', rtParsed.ok && rtParsed.format === 'block', JSON.stringify(rtParsed.errors));
check('(G) the round-trip preserves every field exactly',
  rtParsed.ok && JSON.stringify({ ...rtParsed.record, body: undefined }) === JSON.stringify({ ...validRecord(), body: undefined }));
check('(G) the round-trip preserves the markdown body verbatim', rtParsed.record.body === '\n# BUG-001 — t\n\nbody text\n', JSON.stringify(rtParsed.record.body));
check('(G) formatTicket emits a canonical key order', rt.indexOf('"id"') < rt.indexOf('"title"') && rt.indexOf('"title"') < rt.indexOf('"summary"'));
check('(G) formatTicket is idempotent', S.formatTicket(S.parseTicket(rt, { file: 'BUG-001-t.md' }).record, '\n# BUG-001 — t\n\nbody text\n') === rt);

/* ────────────────────────── (H) genuinely shared, and it works when copied out */

check('(H) board.mjs re-exports the SAME isDoneStatus function object as the module (an import, not a copy)',
  boardTool.isDoneStatus === S.isDoneStatus);
for (const [name, rel] of [['board.mjs', 'scripts/board.mjs'], ['arch-watch.mjs', 'scripts/arch-watch.mjs'], ['tickets.ts', 'src/server/tickets.ts'], ['board.ts', 'src/server/board.ts']]) {
  const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  check(`(H) ${name} imports ticket-schema.mjs`, /from '[^']*ticket-schema\.mjs'/.test(src));
  // The old private rules must be GONE, not shadowed.
  const body = src.replace(/^[\s\S]*?\n(?=(?:import|const|function|export))/, '');
  check(`(H) ${name} carries no private done-rule any more`,
    !/\/\^VERIFIED\\b\//.test(body) || rel === 'scripts/verify-ticket-schema.mjs', 'a /^VERIFIED\\b/ literal survives');
}

// The onboarding path, end to end, against the REAL onboard tool.
const onboardRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-schema-onboard-'));
try {
  const target = path.join(onboardRoot, 'a-project');
  fs.mkdirSync(target, { recursive: true });
  execFileSync('node', [path.join(repoRoot, 'scripts', 'onboard.mjs'), target], { encoding: 'utf8', stdio: 'pipe' });
  const copied = path.join(target, 'scripts', 'lib', 'ticket-schema.mjs');
  check('(H) onboard copies scripts/lib/ticket-schema.mjs into the target', fs.existsSync(copied));
  check('(H) the copy is byte-identical to source', fs.existsSync(copied) && fs.readFileSync(copied, 'utf8') === schemaSrc);

  const runBoard = () => {
    try {
      execFileSync('node', [path.join(target, 'scripts', 'board.mjs'), 'check', `--dir=${path.join(target, 'docs', 'bugs')}`],
        { encoding: 'utf8', stdio: 'pipe' });
      return { code: 0, out: '' };
    } catch (e) { return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }; }
  };
  const before = runBoard();
  check('(H) the onboarded project\'s COPIED board.mjs runs board:check successfully', before.code === 0, before.out);

  // Non-vacuity: if the shared module were not really needed, removing it would
  // change nothing. It must break.
  fs.rmSync(copied);
  const after = runBoard();
  check('(H) removing the copied ticket-schema.mjs BREAKS the onboarded board.mjs (so the copy is load-bearing, not decorative)',
    after.code !== 0 && /ticket-schema/.test(after.out), `code=${after.code} out=${after.out.slice(0, 200)}`);
} finally { fs.rmSync(onboardRoot, { recursive: true, force: true }); }

/* ────────────────────────────────────────────────────────────────── summary */

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  FAILED: ${f}`); process.exit(1); }
process.exit(0);
