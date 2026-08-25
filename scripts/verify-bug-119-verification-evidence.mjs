#!/usr/bin/env node
/**
 * verify-bug-119-verification-evidence.mjs
 *
 * BUG-119: the migration wrote `verification_state: "not_recorded"` onto tickets
 * whose own status line says VERIFIED and whose logs record passing suites.
 *
 * ARCH-009 (2026-08-20) ANSWERED THAT BY DELETING THE FIELD, so this suite now
 * grades two different things at once and the split is worth stating:
 *
 *   · BUG-119's SURVIVING HALF — the self-evidence a ticket records is
 *     extracted and put in front of the model, so the migrated prose says what
 *     actually ran instead of "no further action is recorded". That machinery is
 *     untouched and its sections are unchanged.
 *   · ARCH-009's PROPERTIES — nothing derives a proof state any more, and the
 *     one pass where verdicts still have to be read out of prose STOPS on
 *     contested evidence rather than guessing. Where BUG-119's sections asserted
 *     that a derived value was RIGHT, they now assert that no value exists.
 *
 * §12 used to be the opposite shape to everything else here: characterization
 * tests asserting the CURRENT, WRONG behaviour, so the suite would go red the
 * moment ARCH-009 was decided. It was decided; §12 is now the same two cases,
 * inverted, plus the whole-corpus consequence.
 *
 * HOW THIS SUITE IS BUILT, and the two traps it is written to avoid.
 *
 * 1. It runs against the REAL `docs/bugs/` corpus, never a fixture — a fixture
 *    here would encode the author's belief about what a ticket looks like, which
 *    is the belief under test. `ARCH-005` is excluded: it is a protected holdout
 *    for the migration's own evaluation and must not be read by tooling.
 *
 * 2. It asserts INVARIANTS, never today's values. Which ticket is VERIFIED, how
 *    many are, and which suite each names all change whenever someone uses the
 *    board correctly, and a suite that reddens on correct use gets ignored. So
 *    qualifying tickets are DISCOVERED at runtime, and every discovery step
 *    FAILS LOUDLY when nothing qualifies — a check that finds no candidate and
 *    reports success proves nothing.
 *
 * The must-FAIL proofs are anchored to PRE-FIX BEHAVIOUR SYNTHESIZED IN THIS
 * FILE (`preFixDerive`, `preFixHeadProvenance`), never to `git show HEAD:…`.
 * A HEAD-anchored baseline becomes the FIXED state the moment the fix commits,
 * and the proof silently degrades from guard to decoration.
 *
 *   node scripts/verify-bug-119-verification-evidence.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

import {
  TICKET_FILE_RE, idFromFilename, isDoneWorkState, parseTicket, validateTicket, BODY_SLOTS,
  REQUIRED_KEYS, RETIRED_KEYS, formatTicket,
} from './lib/ticket-schema.mjs';
import { outstandingBroken, ticketView } from '../public/lib/ticket-record.js';
import {
  extractGivens, extractSelfEvidence, extractVerificationRecords, summariseSelfEvidence,
  hasSelfEvidence, contestedEvidence, buildPrompt, compose, grade,
} from './migrate-tickets.mjs';

const summariseSelfEvidenceOf = (text) => summariseSelfEvidence(extractSelfEvidence(text));
import { provenanceOf } from './provenance-check.mjs';
import { checkTicketWriting, WORKED_EXAMPLES } from './lib/ticket-writing.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIR = path.join(ROOT, 'docs/bugs');
/** The migration's protected holdout — never read, never migrated by tooling. */
const HOLDOUT = 'ARCH-005';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
};
const section = (s) => console.log(`\n=== ${s}`);

/* ─────────────────────────────────────────────────────── the real corpus */

const files = fs.readdirSync(DIR)
  .filter((f) => TICKET_FILE_RE.test(f) && !f.startsWith(HOLDOUT))
  .sort();
const corpus = files.map((f) => {
  const text = fs.readFileSync(path.join(DIR, f), 'utf8');
  return { file: f, id: idFromFilename(f), text, g: extractGivens(f, text) };
});

section(`corpus — ${corpus.length} real tickets from docs/bugs (${HOLDOUT} excluded)`);
ok('the corpus is non-empty', corpus.length > 20, `${corpus.length} tickets`);

/* ─────────────── the qualifying set, discovered — never named, never pinned */

/**
 * The charter's invariant, restated as a predicate over a REAL ticket:
 * "a ticket whose status line says VERIFIED and whose log contains a passing
 * suite must not produce not_recorded". Both halves are read from the ticket
 * itself, independently of anything under test:
 *   - the status line, by a local regex (NOT by classifyLegacyStatus — using
 *     the code under test to select the cases it is graded on is circular);
 *   - a passing suite, by a matched `n/n` tally on a line naming a suite.
 */
const STATUS_LINE_RE = /^-\s*\*\*Status:\*\*\s*(.*)$/m;
function saysVerified(text) {
  const m = STATUS_LINE_RE.exec(text);
  return !!m && /^\s*VERIFIED\b/i.test(m[1]);
}
function hasPassingSuiteInLog(text) {
  const i = text.indexOf('## Activity log');
  if (i === -1) return false;
  for (const line of text.slice(i).split('\n')) {
    if (!/verify[:-][a-z0-9]/i.test(line)) continue;
    const t = /\b(\d{1,4})\s*\/\s*(\d{1,4})\b/.exec(line);
    if (t && t[1] === t[2] && Number(t[1]) >= 2) return true;
  }
  return false;
}

const qualifying = corpus.filter((c) => saysVerified(c.text) && hasPassingSuiteInLog(c.text));

section('the qualifying set exists at all (fail LOUDLY if the board has none)');
ok('the real board contains ≥1 ticket that says VERIFIED and logs a passing suite',
  qualifying.length > 0,
  `${qualifying.length} qualifying: ${qualifying.slice(0, 5).map((c) => c.id).join(', ')}${qualifying.length > 5 ? ', …' : ''}`);
if (!qualifying.length) {
  console.log('\nABORT — with no qualifying real ticket every assertion below would be vacuous.');
  process.exit(1);
}

/* ─── DRIVING ONE VALUE ONTO REAL PROSE, and why anything is driven here ─── */

/**
 * THE LIVE CONTESTED SET IS NOT AN INVARIANT. It is a function of what the
 * board's tickets currently CLAIM, and resolving a claim is the gate's whole
 * purpose.
 *
 * Three checks here used to assert facts about it — "every ticket round 3
 * mis-derived is now CONTESTED", "both kinds of conflict occur on the real
 * board", "every ticket the two folds disagree about is stopped". On 2026-08-20
 * a human read three tickets' own evidence and corrected three status lines
 * (BUG-109 VERIFIED→FIXED, FEAT-061 VERIFIED→DONE, FEAT-062 confirmed; commit
 * 3288342). That is the gate WORKING: it stopped the migration, a person
 * resolved the conflict, the conflict went away — and all three checks went red
 * with no defect anywhere. A suite that reddens when someone simply uses the
 * product trains everyone to ignore it (docs/CONVENTIONS.md).
 *
 * So no check below asserts WHICH tickets are contested. Each asserts that an
 * ARM OF THE GATE FIRES on a conflict DRIVEN onto a real ticket's real prose —
 * the shape BUG-109 and FEAT-061 genuinely carried until that commit — and that
 * it does NOT fire on the same real ticket left alone. The live set is printed
 * as context and graded only where the property is genuinely about it (the
 * gate-not-a-wall proportion).
 */
const STATUS_LINE_SET_RE = /^-\s*\*\*Status:\*\*.*$/m;
/** Rewrite ONLY the status line; every other byte of the real ticket survives. */
function withStatusLine(text, raw) {
  const next = String(text).replace(STATUS_LINE_SET_RE, `- **Status:** ${raw}`);
  return next === String(text) ? null : next;
}
/** A real `Verified-by:` line, in the board's own shape. */
const verdictLine = (verdict, n) => `- **Verified-by:** dispatch openai run 01a0${n}-1111-2222-3333-444455556666`
  + ` (clean-room, \`scripts/independent-verify.mjs\`) — VERDICT: ${verdict.toUpperCase()}`;
const withAppendedVerdict = (text, verdict, n) => `${text}

### 2026-01-03 — a later pass

${verdictLine(verdict, n)}
`;

/**
 * THE DONORS: real tickets whose own verdicts leave a BROKEN unresolved, and
 * whose status line can be driven. Discovered at runtime, never named.
 */
const brokenDonors = corpus.filter((c) => outstandingBroken(c.g.verification) && withStatusLine(c.text, 'OPEN'));
section('the donor set for every driven case (fail LOUDLY if the board has none)');
ok('the real board contains ≥1 ticket whose verdicts leave a BROKEN unresolved',
  brokenDonors.length > 0, `${brokenDonors.length} donors: ${brokenDonors.map((c) => c.id).join(', ')}`);
if (!brokenDonors.length) {
  console.log('\nABORT — with no such ticket, every claim-versus-evidence case below would have to be invented whole.');
  process.exit(1);
}

/* ───────────────── 1. ARCH-009's INVARIANT: nothing derives a proof state */

section('1. ARCH-009 — NOTHING derives a proof state, on any real ticket');
{
  // The removal, asserted where it has to be true: in the pipeline's own output.
  // `extractGivens` is what the prompt, `compose` and `grade` all read, so a
  // `verification_state` surviving anywhere in it would mean the derivation had
  // come back under another name.
  const withState = corpus.filter((c) => Object.prototype.hasOwnProperty.call(c.g, 'verification_state'));
  ok('no real ticket produces a `verification_state` given', withState.length === 0,
    withState.slice(0, 4).map((c) => c.id).join(', ') || `all ${corpus.length} clear`);

  // The status line's own word SURVIVES — it is a transcription of one authored
  // token by one fixed table, not a derivation over an evidence set — and it
  // must, because the contested gate compares it against `verification[]`.
  // Asserted so that deleting it would be noticed rather than silently gutting
  // the gate that depends on it.
  const claiming = corpus.filter((c) => c.g.status_verification_state);
  ok('the ticket\'s OWN status word is still transcribed (the gate compares against it)',
    claiming.length > 20, `${claiming.length}/${corpus.length} tickets state one`);

  // …and it never becomes a record field. This is the difference between C and
  // merely renaming the derivation: a transcription written into the record
  // would be the same claim with a tidier provenance story.
  ok('the record schema has no `verification_state` key at all',
    REQUIRED_KEYS.indexOf('verification_state') === -1
    && Object.prototype.hasOwnProperty.call(RETIRED_KEYS, 'verification_state'),
    `REQUIRED_KEYS: ${REQUIRED_KEYS.indexOf('verification_state') === -1 ? 'absent' : 'PRESENT'}`);

  const composedRecord = compose(corpus[0].g, {}, { today: '2026-01-01' }).record;
  ok('`compose` cannot produce the key, even from an empty answer',
    !Object.prototype.hasOwnProperty.call(composedRecord, 'verification_state'),
    Object.keys(composedRecord).filter((k) => /verif/.test(k)).join(', '));
  ok('`formatTicket` strips it even when handed a record that carries one',
    !/verification_state/.test(formatTicket({ ...composedRecord, verification_state: 'holds' }, '\n# x\n')));
}

section('1b. MUST-FAIL — the SYNTHESIZED round-3 derivation mis-derived REAL tickets');
{
  // ROUND 3'S EXACT RULE, reproduced here so the baseline can never move — never
  // `git show HEAD:…`, which BECOMES the fixed state the moment a fix commits.
  // This is the behaviour ARCH-009 deleted:
  //
  //   1. the LAST record is `broken`                        → broken
  //   2. else the status line claims holds                  → holds
  //   3. else the status line says anything else meaningful → that
  //   4. else any record at all                             → pending
  //   5. else finished + self-evidence                      → pending
  //   6. else                                                 not_recorded
  const round3 = ({ records, statusState, workState, selfEvidence }) => {
    const last = records.length ? records[records.length - 1] : null;
    const fromRecords = last ? (last.verdict === 'holds' ? 'holds' : last.verdict === 'broken' ? 'broken' : 'pending') : null;
    if (fromRecords === 'broken') return 'broken';
    if (statusState === 'holds') return 'holds';
    if (statusState && statusState !== 'not_recorded') return statusState;
    if (fromRecords) return 'pending';
    if (['verified', 'done', 'in_verification'].includes(workState) && hasSelfEvidence(selfEvidence)) return 'pending';
    return 'not_recorded';
  };
  const derived3Of = (g) => round3({
    records: g.verification, statusState: g.status_verification_state,
    workState: g.work_state, selfEvidence: g.self_evidence,
  });

  /**
   * THE MIS-DERIVATION IS DRIVEN, NOT LOOKED UP.
   *
   * This used to filter the live corpus for tickets round 3 got wrong and assert
   * that all of them are contested today. That set is exactly what a human
   * resolving a conflict makes smaller — see the note above the donor set — and
   * on 2026-08-20 it emptied of its evidence half and this check went red.
   *
   * The shape it was about is reproduced instead, on a REAL ticket: a status
   * line claiming VERIFIED over verdicts that leave a `broken` unresolved, with
   * a trailing `invalid` so the LAST record is not the broken one. Every byte
   * except the status line and the appended verdict is the real ticket's. Both
   * halves are real board shapes — BUG-109 carried the first until 2026-08-20,
   * FEAT-061 carries four trailing `invalid`s today.
   */
  const misDerived = [];
  const unstopped = [];
  const unnamed = [];
  for (const c of brokenDonors) {
    const text = withAppendedVerdict(
      withStatusLine(c.text, 'VERIFIED — closed on the fixer\'s own run'), 'invalid', 'dead');
    const g = extractGivens(c.file, text);
    if (!outstandingBroken(g.verification)) continue;      // the drive did not build the shape
    if (derived3Of(g) !== 'broken') misDerived.push(`${c.id} [${g.verification.map((v) => v.verdict).join(',')}] -> ${derived3Of(g)}`);
    const why = contestedEvidence(g, text) ?? [];
    if (!why.some((r) => /^CONTESTED EVIDENCE/.test(r))) unstopped.push(c.id);
    else if (!why.some((r) => /BROKEN unresolved/.test(r) && r.includes('VERIFIED'))) unnamed.push(c.id);
  }
  ok('MUST-FAIL: round 3 claims proof over an unresolved BROKEN on a real ticket driven to that shape',
    misDerived.length === brokenDonors.length,
    `${misDerived.length}/${brokenDonors.length}: ${misDerived.slice(0, 4).join('; ')}`
      || 'NONE — the deleted derivation cannot be shown to misbehave, so this proof is vacuous');

  // …and every one of them is now STOPPED rather than answered. That is C-gated-
  // by-A in one assertion: the pipeline does not produce a BETTER value for these
  // tickets, it produces no value at all and a named conflict for a human.
  ok('every one of them is CONTESTED instead — stopped, not re-answered',
    unstopped.length === 0 && unnamed.length === 0,
    [unstopped.length ? `not stopped: ${unstopped.join(', ')}` : '', unnamed.length ? `stopped without naming the conflict: ${unnamed.join(', ')}` : '']
      .filter(Boolean).join(' | ') || `all ${brokenDonors.length} donors quarantined with the conflict named`);

  /**
   * THE DISCRIMINATOR, and it is the 2026-08-20 correction itself. The gate keys
   * on the ticket's CLAIM, not on the presence of a `broken`: the same real
   * ticket, same verdicts, with a status line that claims no proof — the exact
   * word a human wrote onto FEAT-061 — must NOT be stopped for an evidence
   * conflict. Without this the gate would be a halt on every unresolved verdict,
   * and the correction that resolved these tickets would have achieved nothing.
   */
  const falseStops = [];
  for (const c of brokenDonors) {
    const text = withAppendedVerdict(
      withStatusLine(c.text, 'DONE — CLOSED under the recorded bounded-scope bar'), 'invalid', 'dead');
    const why = contestedEvidence(extractGivens(c.file, text), text) ?? [];
    if (why.some((r) => /^CONTESTED EVIDENCE/.test(r))) falseStops.push(c.id);
  }
  ok('…and the SAME tickets claiming no proof are NOT stopped (the gate reads the claim, not the broken)',
    falseStops.length === 0,
    falseStops.join(', ') || `all ${brokenDonors.length} donors pass once the claim is corrected`);
}

/* ───────────────── 2. the record cannot express a proof state at all */

section('2. no real ticket can produce a record carrying a proof state');
{
  const slots = {}; for (const s of BODY_SLOTS) slots[s] = false;
  const offenders = [];
  for (const c of corpus) {
    const rec = {
      id: c.g.id, type: c.g.type, title: 'A placeholder symptom title', summary: 'x'.repeat(20),
      impact_if_we_wait: 'Bounded placeholder impact for validation.', current_need: 'Nothing.',
      area: 'Placeholder', severity: c.g.severity ?? 'not_recorded', reported: c.g.reported ?? '2026-01-01',
      reported_by: 'agent', owner: 'unassigned', work_state: c.g.work_state, human_action: 'none',
      updated: c.g.reported ?? '2026-01-01',
      decision: null, decision_history: [], success_criteria: ['Not recorded'], code_refs: [],
      related: [], recurrence_evidence: c.g.type === 'architecture' ? ['BUG-001'] : [],
      verification: c.g.verification, verification_class: c.g.verification_class,
      body_slots: slots, source: { archived_path: 'x', sha256: c.g.sha256, bytes: c.g.bytes },
    };
    const v = validateTicket(rec, { file: c.file });
    // Scoped to what ARCH-009 touched. `verification_class` is null on tickets
    // that never declared one — a real, separate gap, not this one.
    const relevant = v.violations.filter((x) => /"verification"|"verification\[/.test(x));
    if (relevant.length) offenders.push(`${c.id}: ${relevant[0]}`);
  }
  ok('a record carrying only `verification[]` validates on every real ticket', offenders.length === 0,
    offenders.slice(0, 3).join(' | ') || `all ${corpus.length} clean`);
}

section('2c. the DATA is still constrained — removing the state relaxed nothing about verdicts');
{
  const slots = {}; for (const s of BODY_SLOTS) slots[s] = false;
  const base = {
    id: 'BUG-001', type: 'bug', title: 'A placeholder symptom title', summary: 'x'.repeat(20),
    impact_if_we_wait: 'Bounded placeholder impact.', current_need: 'Nothing.', area: 'Placeholder',
    severity: 'low', reported: '2026-01-01', reported_by: 'agent', owner: 'unassigned',
    work_state: 'verified', human_action: 'none', updated: '2026-01-01', decision: null, decision_history: [],
    success_criteria: ['Not recorded'], code_refs: [], related: [], recurrence_evidence: [],
    verification: [], verification_class: 'fix', body_slots: slots,
    source: { archived_path: 'x', sha256: 'a', bytes: 1 },
  };
  const viol = (over) => validateTicket({ ...base, ...over }, { file: 'x.md' }).violations.filter((v) => /verification/.test(v));
  const good = { provider: 'openai', run_id: '01a0dead-1111-2222-3333-444455556666', verdict: 'holds' };
  ok('a verdict outside the closed set is rejected', viol({ verification: [{ ...good, verdict: 'mostly' }] }).length > 0,
    viol({ verification: [{ ...good, verdict: 'mostly' }] })[0] ?? 'NO VIOLATION');
  ok('a verdict with no provider is rejected', viol({ verification: [{ ...good, provider: null }] }).length > 0);
  ok('a verdict with no run id is rejected — an unattributable record is not a record',
    viol({ verification: [{ ...good, run_id: null }] }).length > 0);
  ok('a well-formed verdict is accepted', viol({ verification: [good] }).length === 0,
    viol({ verification: [good] }).join(' | ') || 'clean');

  // …and NOTHING adjudicates the SHAPE of the array any more. Two rules used to
  // live here, both about keeping a derived state coherent with these entries;
  // their absence is the substance of C and is asserted, not assumed.
  ok('an empty verification[] on a VERIFIED ticket raises nothing (it is not a claim)',
    viol({ verification: [] }).length === 0, viol({ verification: [] }).join(' | ') || 'clean');
  ok('a lone BROKEN verdict on a VERIFIED ticket raises nothing either — the schema does not adjudicate',
    viol({ verification: [{ ...good, verdict: 'broken' }] }).length === 0,
    viol({ verification: [{ ...good, verdict: 'broken' }] }).join(' | ') || 'clean');
}

/* ─────────────────────────────────────── 3. the prompt no longer orders it */

section('3. buildPrompt never orders a proof state, and never states one');
{
  const offenders = [];
  const noEvidence = [];
  for (const c of qualifying) {
    const p = buildPrompt(c.g);
    if (/"not_recorded" or "not_required"/.test(p)) offenders.push(`${c.id}(orders placeholder)`);
    if (/verification_state is ALREADY DECIDED/.test(p)) offenders.push(`${c.id}(states a value)`);
    if (!/THERE IS NO verification_state FIELD/.test(p)) offenders.push(`${c.id}(no refusal stated)`);
    if (!/the fixer's OWN executed evidence/.test(p)) noEvidence.push(c.id);
  }
  ok('no qualifying ticket\'s prompt orders or states a proof state', offenders.length === 0,
    offenders.slice(0, 4).join(', ') || `all ${qualifying.length} clean`);
  ok('every qualifying ticket\'s prompt still carries the extracted self-evidence block (BUG-119\'s surviving half)',
    noEvidence.length === 0, noEvidence.slice(0, 4).join(', ') || `all ${qualifying.length}`);

  // The WHOLE corpus, not just the qualifying subset: a demonstration of the key
  // in the worked example is how a removed field comes back into a model's
  // output, so the PIPELINE-AUTHORED half of the prompt must not show one
  // anywhere. The ticket's own text is excluded on purpose — BUG-119's ticket
  // quotes the removed key in its prose, correctly, and the prompt copies that
  // prose verbatim. Scanning it would be the attribution bug in the test itself:
  // treating text the pipeline QUOTES as text the pipeline SAYS.
  const TICKET_MARKER = 'THE TICKET (everything before its activity log):';
  const leaks = corpus.filter((c) => {
    const whole = buildPrompt(c.g);
    const p = whole.slice(0, whole.indexOf(TICKET_MARKER) === -1 ? whole.length : whole.indexOf(TICKET_MARKER));
    return /"verification_state":/.test(p) || /verification_state\s+enum/.test(p);
  });
  ok('no prompt on the whole board demonstrates or enumerates the removed field',
    leaks.length === 0, leaks.slice(0, 4).map((c) => c.id).join(', ') || `${corpus.length} prompts checked`);
}

section('3b. MUST-FAIL — the pre-change prompts DID order it, on the same real tickets');
{
  // Synthesized pre-change prompt lines, from the shipped code they replace.
  const preBug119 = (g) => (g.verification.length
    ? 'one of pending | holds | broken'
    : '"not_recorded" or "not_required" (there are NO verification records)');
  const preArch009 = (g) => `verification_state is ALREADY DECIDED: ${JSON.stringify(g.status_verification_state ?? 'not_recorded')}`;
  const ordered = qualifying.filter((c) => /not_recorded/.test(preBug119(c.g)));
  ok('BUG-119\'s pre-fix prompt ordered the placeholder on qualifying real tickets', ordered.length > 0,
    `${ordered.length}/${qualifying.length}`);
  ok('ARCH-009\'s pre-change prompt handed the model a value to copy on EVERY ticket, and no longer does',
    corpus.every((c) => /ALREADY DECIDED/.test(preArch009(c.g)))
    && corpus.every((c) => !/ALREADY DECIDED/.test(buildPrompt(c.g))),
    `${corpus.length} tickets: was stated on all, now absent on all`);
}
/* ──────────────────────────────── 4. self-evidence recovery, as an invariant */

section('4. self-evidence is recovered wherever the ticket actually records it');
{
  // Invariant, not a value: any ticket whose text carries a suite name adjacent
  // to a matched tally must yield at least one SCORED suite.
  const shouldScore = corpus.filter((c) => hasPassingSuiteInLog(c.text));
  ok('the board has tickets logging a scored suite (else this section is vacuous)', shouldScore.length > 5,
    `${shouldScore.length} tickets`);
  // The invariant is that the NUMBER reaches the model, not that the extractor
  // guesses which suite it belongs to. Attribution beyond an adjacent window is
  // unsound on this corpus (see summariseSelfEvidence), so the bar is: a scored
  // suite OR a reported tally — and it must survive into the prompt summary,
  // which is the only path by which the log's evidence reaches the model.
  const missed = shouldScore.filter((c) => !c.g.self_evidence.suites.some((s) => s.total !== null)
    && !c.g.self_evidence.tallies.length);
  ok('every one of them yields a scored suite or a reported tally', missed.length === 0,
    missed.slice(0, 5).map((c) => c.id).join(', ') || `all ${shouldScore.length}`);

  const notInPrompt = shouldScore.filter((c) => !/passing|pass tallies recorded/.test(buildPrompt(c.g)));
  ok('the tally reaches the prompt for every one of them', notInPrompt.length === 0,
    notInPrompt.slice(0, 5).map((c) => c.id).join(', ') || `all ${shouldScore.length}`);

  // Non-vacuity for the unbound path specifically: the two real shapes that
  // defeat proximity binding must still surface their number.
  const farTally = summariseSelfEvidenceOf('ran `verify:search`, and after a long clause about HTTP 400 and 500 and 200 responses across several checks, all 11/11 passed');
  ok('a tally far from its suite name is still reported (BUG-012 shape)',
    /11\/11/.test(farTally ?? ''), JSON.stringify(farTally));
  const beforeTally = summariseSelfEvidenceOf('17/17 PASS, verify:ui 7/0 PASS, typecheck clean');
  ok('a tally PRECEDING a different suite is reported, not mis-bound (FEAT-079 shape)',
    /without an adjacent suite name: 17\/17/.test(beforeTally ?? '')
    && !/verify:ui — 17/.test(beforeTally ?? ''), JSON.stringify(beforeTally));

  const finished = corpus.filter((c) => isDoneWorkState(c.g.work_state));
  const withEvidence = finished.filter((c) => c.g.self_evidence.suites.length
    || c.g.self_evidence.preFixProof || c.g.self_evidence.checks.length);
  ok('the recovery is broad, not incidental, across finished tickets',
    withEvidence.length > finished.length * 0.8,
    `${withEvidence.length}/${finished.length} finished tickets carry recovered evidence`);

  // Non-vacuity in the other direction: it must NOT hallucinate evidence on a
  // ticket that has none. Discovered, not named.
  const barren = corpus.filter((c) => !/verify[:-][a-z0-9]/i.test(c.text) && !/\b(\d{1,3})\s*\/\s*\1\b/.test(c.text));
  ok('tickets with no suite and no tally yield no scored suite',
    barren.every((c) => !c.g.self_evidence.suites.some((s) => s.total !== null)),
    `${barren.length} barren tickets checked`);

  ok('a tally is never invented from an unmatched ratio',
    extractSelfEvidence('ran verify:thing 3/9 and it failed').suites[0].total === null,
    JSON.stringify(extractSelfEvidence('ran verify:thing 3/9 and it failed').suites));
  ok('a matched tally adjacent to a suite IS captured',
    extractSelfEvidence('`verify:thing` 12/12 green').suites[0].total === 12);
}

/* ────────────────────────── 5. MUST APPEAR VERBATIM: smaller, and still sound */

section('5. the MUST-APPEAR list drops only tokens the verbatim log copy guarantees');
{
  // SOUNDNESS is the assertion that matters: nothing may be dropped that the
  // pipeline does not already place. For every head token the new
  // headProvenance omits, that token must be inside the log — which
  // provenanceCheck separately asserts is copied byte-for-byte.
  // The predicate here is provenanceCheck's OWN, per kind — case-folded for run
  // ids and shas, EXACT for ticket refs and dates. Approximating it with one
  // case-folded test is precisely the bug this section exists to catch: a log
  // containing `verify:feat-067-rail-summary` does not carry `FEAT-067`.
  const unsound = [];
  let before = 0, after = 0;
  for (const c of corpus) {
    const head = provenanceOf(c.g.head);
    const raw = String(c.g.log ?? '');
    const folded = raw.toLowerCase();
    const kept = c.g.provenance;
    const covers = {
      runIds: (x) => folded.includes(String(x).toLowerCase()),
      shas: (x) => folded.includes(String(x).toLowerCase()),
      ticketRefs: (x) => raw.includes(String(x)),
      dates: (x) => raw.includes(String(x)),
    };
    for (const [k, xs] of Object.entries({ runIds: head.runIds, shas: head.shas, ticketRefs: head.ticketRefs, dates: head.dates })) {
      before += xs.length;
      after += kept[k].length;
      for (const x of xs) {
        if (kept[k].includes(x)) continue;
        if (!covers[k](x)) unsound.push(`${c.id}: ${k} ${x} dropped but NOT in the log`);
      }
    }
  }
  ok('every dropped token is present in the verbatim-copied activity log', unsound.length === 0,
    unsound.slice(0, 3).join(' | ') || `${before - after} tokens dropped, all backed by the log`);
  ok('the list actually shrank (else the seam fix is a no-op)', after < before,
    `${before} head tokens → ${after} the model must carry (${Math.round((1 - after / before) * 100)}% less)`);
  ok('the reduction leaves real work — it did not empty the list', after > 0, `${after} tokens still required`);
}

section('5b. the prompt no longer glues a kind-label to a token');
{
  const seams = [];
  for (const c of corpus) {
    const p = buildPrompt(c.g);
    // The exact shapes the graders saw sewn into prose.
    for (const re of [/^\s+date \d{4}-\d{2}-\d{2}\s*$/m, /^\s+ticket (BUG|FEAT|ARCH|DEPLOY)-\d+\s*$/m, /^\s+run id [0-9a-f-]{8,}\s*$/m, /^\s+commit sha [0-9a-f]{7,}\s*$/m]) {
      if (re.test(p)) { seams.push(`${c.id}: ${re}`); break; }
    }
  }
  ok('no prompt lists a token prefixed by its kind word', seams.length === 0,
    seams.slice(0, 3).join(' | ') || `${corpus.length} prompts clean`);

  const withTokens = corpus.filter((c) => c.g.provenance.dates.length + c.g.provenance.ticketRefs.length
    + c.g.provenance.shas.length + c.g.provenance.runIds.length > 0);
  ok('tickets with tokens still get the MUST APPEAR block (not silently dropped)',
    withTokens.length > 0 && withTokens.every((c) => /MUST APPEAR VERBATIM/.test(buildPrompt(c.g))),
    `${withTokens.length} tickets carry residual tokens`);
  ok('the anti-seam instruction is present when tokens are',
    withTokens.every((c) => /THE HEADINGS BELOW ARE LABELS FOR YOU, NOT WORDS TO WRITE/.test(buildPrompt(c.g))));
  ok('a ticket with no residual token gets NO MUST APPEAR block at all',
    corpus.some((c) => !/MUST APPEAR VERBATIM/.test(buildPrompt(c.g))),
    `${corpus.length - withTokens.length} tickets need none`);
}

/* ───────── 6. grade() refuses the field the model must no longer author ── */

section('6. grade() rejects a model that emits verification_state — at ANY value');
{
  const c = qualifying[0];
  const answer = {
    title: 'A plain symptom title here', summary: 'x '.repeat(15),
    impact_if_we_wait: 'Bounded placeholder impact.', current_need: 'Nothing outstanding.',
    area: 'Placeholder', severity: 'low', reported_by: 'agent', owner: 'unassigned',
    human_action: 'none', decision: null, decision_history: [],
    success_criteria: ['Not recorded'], code_refs: [], related: [], recurrence_evidence: [],
    verification_class: 'fix', body_prose: {}, source: { confirmation: 'x '.repeat(10), dropped: [] },
  };
  const clean = grade(c.g, compose(c.g, answer, { today: '2026-01-01' }), c.text);
  ok('an answer that omits the field raises no verification violation',
    !clean.violations.some((v) => /verification_state/.test(v)),
    clean.violations.filter((v) => /verification_state/.test(v)).join(' | ') || 'clean');

  // EVERY value of the old enum, on a real ticket of every SHAPE the board has —
  // and the interesting one is not the wrong answer, it is the one that used to
  // be RIGHT. Under BUG-119, "holds" on a VERIFIED ticket was the correct copy
  // and sailed through; the model can no longer buy passage with a good guess.
  const shapes = new Map();
  for (const t of corpus) {
    const key = `${t.g.work_state}/${t.g.status_verification_state}/${outstandingBroken(t.g.verification)}`;
    if (!shapes.has(key)) shapes.set(key, t);
  }
  ok('the board exercises more than one ticket shape (else this is thin)', shapes.size >= 3,
    `${shapes.size} shapes`);
  const escaped = [];
  for (const [shape, t] of shapes) {
    for (const value of ['not_required', 'not_recorded', 'pending', 'holds', 'broken']) {
      const g2 = grade(t.g, compose(t.g, { ...answer, verification_state: value }, { today: '2026-01-01' }), t.text);
      if (!g2.violations.some((v) => /that field was REMOVED \(ARCH-009\)/.test(v))) {
        escaped.push(`${t.id} (${shape}) accepted ${value}`);
      }
    }
  }
  ok('every value of the removed enum is rejected on a real ticket of every shape',
    escaped.length === 0, escaped.slice(0, 4).join(' | ') || `${shapes.size} shapes × 5 values, all rejected`);

  // The refusal must be LOUD, not a dropped key nobody reads. `compose` drops it
  // (that is what keeps a bad answer off disk); `grade` is what turns the drop
  // into a re-prompt.
  const dropped = compose(c.g, { ...answer, verification_state: 'holds' }, { today: '2026-01-01' });
  ok('compose drops it AND says so in its notes',
    !Object.prototype.hasOwnProperty.call(dropped.record, 'verification_state')
    && dropped.notes.some((n) => /verification_state/.test(n)),
    dropped.notes.join(' | ') || 'NO NOTE');
}

section('6b. MUST-FAIL — the pre-change grade() ACCEPTED the value it was given');
{
  // BUG-119's gate compared the model's value against the pipeline's derived
  // one, so an answer that COPIED the derivation passed by construction. That is
  // the hole ARCH-009 closes: agreement with a wrong derivation is not a defence.
  // Synthesized here, not fetched from a revision.
  const preGrade = (derived, answered) => (derived && answered !== derived
    ? [`verification_state is ${JSON.stringify(answered)} but the pipeline derived ${JSON.stringify(derived)}`]
    : []);
  const donor = corpus.find((c) => c.g.status_verification_state === 'holds') ?? corpus[0];
  ok('the old gate accepted "holds" whenever the derivation said "holds"',
    preGrade('holds', 'holds').length === 0,
    'agreement was a pass — so a wrong derivation could never be caught by the gate that read it');
  const nowViolations = grade(donor.g, compose(donor.g, {
    title: 'A plain symptom title here', summary: 'x '.repeat(15),
    impact_if_we_wait: 'Bounded placeholder impact.', current_need: 'Nothing outstanding.',
    area: 'Placeholder', severity: 'low', reported_by: 'agent', owner: 'unassigned',
    human_action: 'none', verification_state: 'holds', decision: null, decision_history: [],
    success_criteria: ['Not recorded'], code_refs: [], related: [], recurrence_evidence: [],
    verification_class: 'fix', body_prose: {}, source: { confirmation: 'x '.repeat(10), dropped: [] },
  }, { today: '2026-01-01' }), donor.text).violations;
  ok('the same answer on the same real ticket is rejected now',
    nowViolations.some((v) => /that field was REMOVED \(ARCH-009\)/.test(v)),
    `${donor.id}: ${nowViolations.find((v) => /ARCH-009/.test(v))?.slice(0, 90) ?? 'NOT REJECTED'}`);
}

/* ── 11. the DOWNSTREAM readers, driven rather than reasoned about ──────── */

section('11. proof reaches the reader from `verification[]`, not from a state');
{
  // CARRY-FORWARD from the round-2 verdict: these were once checked statically
  // only. A rule that renders as nothing is a half-shipped rule, which is the
  // exact argument that justified reusing `pending` — so it has to be true.
  //
  // The UI consumer is `outstandingBroken`, driven here over the REAL board's
  // verdict sequences rather than over invented ones.
  const withRecords = corpus.filter((c) => c.g.verification.length);
  ok('the board carries tickets with verdicts to fold (else this is vacuous)',
    withRecords.length > 3, `${withRecords.length} tickets carry ≥1 verdict`);

  const broken = withRecords.filter((c) => outstandingBroken(c.g.verification));
  ok('the fold identifies ≥1 real ticket with an unresolved BROKEN', broken.length > 0,
    broken.map((c) => `${c.id} [${c.g.verification.map((v) => v.verdict).join(',')}]`).join('; ') || 'NONE');

  // …and it is a DISCRIMINATOR: a ticket whose last `broken` is followed by a
  // `holds` is resolved, and must not be painted as broken.
  const resolved = withRecords.filter((c) => c.g.verification.some((v) => v.verdict === 'broken')
    && !outstandingBroken(c.g.verification));
  ok('a ticket whose BROKEN was later resolved by a HOLDS is not reported broken',
    resolved.length > 0 && resolved.every((c) => !outstandingBroken(c.g.verification)),
    resolved.map((c) => `${c.id} [${c.g.verification.map((v) => v.verdict).join(',')}]`).join('; ')
      || 'NO resolved-after-broken ticket on the board — the discriminator is untested here');

  // THE RENDERER, driven for real: the view model must carry the verdicts and
  // must NOT carry a proof state, on a record built the way the migration builds
  // one. A DOM assertion is not run here (verify-ticket-view-redesign drives the
  // real click-path); this asserts the DATA the renderer reads.
  const donor = broken[0] ?? withRecords[0];
  const rec = compose(donor.g, {
    title: 'A plain symptom title here', summary: 'x '.repeat(15),
    impact_if_we_wait: 'Bounded placeholder impact.', current_need: 'Nothing outstanding.',
    area: 'Placeholder', severity: 'low', reported_by: 'agent', owner: 'unassigned',
    human_action: 'none', decision: null, decision_history: [], success_criteria: ['Not recorded'],
    code_refs: [], related: [], recurrence_evidence: donor.g.type === 'architecture' ? ['BUG-001'] : [],
    verification_class: 'fix', body_prose: {}, source: { confirmation: 'x '.repeat(10), dropped: [] },
  }, { today: '2026-01-01' });
  const view = ticketView({ id: donor.id, markdown: rec.text });
  ok('the view model carries no `verificationState` at all', view.verificationState === undefined,
    JSON.stringify(view.verificationState ?? null));
  ok('the view model carries the attributed verdicts instead',
    Array.isArray(view.verification) && view.verification.length === donor.g.verification.length,
    `${view.verification?.length ?? 0} verdict(s) reach the renderer`);
  ok('and the UI rule fires on them exactly as it does on the raw records',
    outstandingBroken(view.verification) === outstandingBroken(donor.g.verification),
    `${donor.id}: ${outstandingBroken(view.verification)}`);

  // board:check is the linter that must keep flagging unverified tickets: the
  // NO INDEPENDENT VERIFICATION warning is what survives the state's removal.
  const board = spawnSync(process.execPath, [path.join(ROOT, 'scripts/board.mjs'), 'check'],
    { cwd: ROOT, encoding: 'utf8' });
  ok('board:check runs (exit 0/1, not a crash)', board.status === 0 || board.status === 1,
    `exit ${board.status}${board.error ? ` — ${board.error.message}` : ''}`);
  const out = `${board.stdout ?? ''}${board.stderr ?? ''}`;
  ok('board:check still emits NO INDEPENDENT VERIFICATION warnings',
    /NO INDEPENDENT VERIFICATION/.test(out),
    `${(out.match(/NO INDEPENDENT VERIFICATION/g) ?? []).length} warning(s)`);

  // The tickets that warning is for are exactly the ones with an empty
  // `verification[]` — the one signal removing the state did not touch.
  const barren = corpus.filter((c) => isDoneWorkState(c.g.work_state) && !c.g.verification.length);
  ok('finished tickets with no independent verdict keep an empty verification[]',
    barren.length > 0 && barren.every((c) => c.g.verification.length === 0),
    `${barren.length} finished tickets carry 0 independent records`);
}
/* ──────────────────────── 7. partial / truncated reads (another agent writes these) */

section('7. truncated tickets — agents append to these files while tooling reads them');
{
  // A race is a timing, not a shape, so the REAL artifact is cut at plausible
  // points and each cut graded. The bar is not "correct": a half-written ticket
  // has no correct answer. The bar is NEVER THROW, NEVER INVENT — and, since
  // ARCH-009, NEVER MIGRATE A PARTIAL READ AS IF IT WERE WHOLE.
  //
  // A truncated ticket is the sharpest case for the gate, because truncation
  // removes verdicts: cut a file above its last `Verified-by:` line and the
  // evidence set genuinely changes underneath the reader. Deriving a state from
  // that was the old behaviour. Refusing to derive one is the new behaviour, and
  // what remains to assert is that the refusal does not throw and does not
  // silently invent a record.
  const subject = qualifying[Math.floor(qualifying.length / 2)];
  const n = subject.text.length;
  const cuts = [0, 1, 40, 120, 400, 1000, Math.floor(n * 0.25), Math.floor(n * 0.5),
    Math.floor(n * 0.75), Math.floor(n * 0.9), n - 1];
  let threw = 0, invented = 0, stated = 0;
  for (const cut of cuts) {
    const partial = subject.text.slice(0, cut);
    let g = null;
    try { g = extractGivens(subject.file, partial); } catch (e) { threw++; console.log(`        threw at ${cut}: ${e.message}`); continue; }
    if (Object.prototype.hasOwnProperty.call(g, 'verification_state')) stated++;
    // A partial read may hold FEWER records than the whole file. It must never
    // hold one the whole file does not — that would be a record manufactured by
    // truncation, which is the attribution class in its purest form.
    const whole = new Set(subject.g.verification.map((v) => `${v.run_id}:${v.verdict}`));
    if (g.verification.some((v) => !whole.has(`${v.run_id}:${v.verdict}`))) invented++;
  }
  ok(`extractGivens never throws on a truncated real ticket (${subject.id}, ${cuts.length} cuts)`, threw === 0, `${threw} threw`);
  ok('no truncation states a proof state (there is none to state)', stated === 0, `${stated} stated one`);
  ok('no truncation manufactures a verification record the whole file does not have',
    invented === 0, `${invented} invented`);

  // The header arrives before the log, so a cut AFTER the status line already
  // carries the ticket's own CLAIM — which is what the contested gate compares
  // the evidence against, so losing it to truncation would silently disarm the
  // gate rather than trip it.
  const afterStatus = subject.text.indexOf('\n', subject.text.indexOf('**Status:**')) + 1;
  ok('a cut just past the status line already carries the ticket\'s own claim',
    extractGivens(subject.file, subject.text.slice(0, afterStatus + 50)).status_verification_state
      === subject.g.status_verification_state,
    `${subject.id} → ${JSON.stringify(extractGivens(subject.file, subject.text.slice(0, afterStatus + 50)).status_verification_state)}`);

  // A ticket cut BEFORE its status line has genuinely claimed nothing, and the
  // pipeline says so rather than defaulting.
  const beforeStatus = subject.text.slice(0, subject.text.indexOf('**Status:**'));
  ok('a cut BEFORE the status line claims nothing (no claim is invented)',
    extractGivens(subject.file, beforeStatus).status_verification_state === null,
    JSON.stringify(extractGivens(subject.file, beforeStatus).status_verification_state));

  // AND THE ONE THAT MATTERS FOR THE GATE: a truncation that removes the
  // resolving `holds` from a sequence must not be migrated as resolved. Built by
  // cutting the REAL file at the byte before its last verdict line.
  const withVerdicts = corpus.filter((c) => c.g.verification.length >= 2);
  if (withVerdicts.length) {
    const t = withVerdicts[0];
    const lastVerdictAt = t.text.lastIndexOf('**Verified-by:**');
    const cutBefore = t.text.slice(0, lastVerdictAt);
    const gCut = extractGivens(t.file, cutBefore);
    ok('a cut above the last verdict loses it rather than inventing its outcome',
      gCut.verification.length === t.g.verification.length - 1,
      `${t.id}: ${t.g.verification.length} verdicts whole, ${gCut.verification.length} truncated`);
    ok('  …and nothing about proof is decided from the shortened set',
      !Object.prototype.hasOwnProperty.call(gCut, 'verification_state'));
  } else {
    ok('the board carries a ticket with ≥2 verdicts to truncate between', false,
      'NONE — the truncation-between-verdicts case cannot be built from this board');
  }
}

/* ─────────── 9. THE RESIDUAL: evidence held in self_evidence, denied to the model */

section('9. a finished ticket\'s own evidence reaches the model instead of being dropped');
{
  // The clean-room verdict (openai run 01a01bb8) called round 1 BROKEN on
  // exactly this: evidence the pipeline had ALREADY extracted was being held and
  // then denied. ARCH-009 deleted the FIELD that denial was written into, but
  // the denial itself was never about the field — it was about 144 finished
  // tickets whose recorded proof never reached the model, so the migrated prose
  // said "no further action is recorded" about work that had been proven. That
  // half of BUG-119 is untouched, and this is where it is graded: the evidence
  // must reach the PROMPT.
  const finished = corpus.filter((c) => isDoneWorkState(c.g.work_state));
  const holding = finished.filter((c) => hasSelfEvidence(c.g.self_evidence));
  ok('the board has finished tickets holding self-evidence (else vacuous)', holding.length > 20,
    `${holding.length}/${finished.length}`);

  // THE BAR IS "NEVER DENIED", NOT "ALWAYS SUMMARISED", and the difference is a
  // real gap this suite reports rather than hides. `summariseSelfEvidence` has
  // no line for the PASS-MARKER shape (FEAT-028's: five hand-run checks each
  // marked `(PASS)` under a `## Verification` heading, no suite name and no
  // tally), so `hasSelfEvidence` says yes while the summary is empty and the
  // block is omitted. That is weaker than it should be — but it is silence, not
  // a denial, and the prompt never tells the model that nothing was found.
  // Denial is what BUG-119 was about and what is asserted here.
  const summarised = holding.filter((c) => /the fixer's OWN executed evidence/.test(buildPrompt(c.g)));
  const denied = holding.filter((c) => /the pipeline judged that NONE of/.test(buildPrompt(c.g)));
  ok('no ticket holding evidence is TOLD the pipeline found none', denied.length === 0,
    denied.slice(0, 6).map((c) => c.id).join(', ') || `all ${holding.length} clear`);
  ok('the evidence block reaches all but the summariser\'s known blind shape',
    summarised.length >= holding.length - 2,
    `${summarised.length}/${holding.length} summarised; unsummarised: `
    + `${holding.filter((c) => !summarised.includes(c)).map((c) => c.id).join(', ') || 'none'}`
    + ' (PASS-marker-only tickets — a known summariser gap, reported not hidden)');

  // ...and the converse, so this is a discriminator and not a blanket upgrade:
  // a ticket with NO evidence must be told so, in those words, rather than
  // handed an empty block it could read as proof.
  const barrenFinished = finished.filter((c) => !hasSelfEvidence(c.g.self_evidence));
  ok('a finished ticket with NO evidence is told the pipeline found none',
    barrenFinished.length > 0
    && barrenFinished.every((c) => !/the fixer's OWN executed evidence/.test(buildPrompt(c.g))),
    `${barrenFinished.length} evidence-free closures: ${barrenFinished.map((c) => c.id).join(', ')}`);

  // The upgrade must never be presented as an independent verdict — a fixer's
  // own suite is not one, and conflating them is what README rule 5 prevents.
  const conflated = holding.filter((c) => !c.g.verification.length
    && /independent verdict\(s\) above are carried/.test(buildPrompt(c.g)));
  ok('self-evidence is NEVER presented as an independent verdict', conflated.length === 0,
    conflated.slice(0, 4).map((c) => c.id).join(', ') || 'none');

  // ROUND 3: the marker path additionally requires a `## Verification` section,
  // so bare markers in prose no longer qualify. Full case list in section 10e.
  ok('PASS markers count only under a Verification section',
    hasSelfEvidence(extractSelfEvidence('## Verification\n\nchecked it (PASS) and then (PASS) again'))
    && !hasSelfEvidence(extractSelfEvidence('checked it (PASS) and then (PASS) again'))
    && !hasSelfEvidence(extractSelfEvidence('the reviewer said it would PASS eventually')));
}

section('9b. MUST-FAIL — the pre-BUG-119 pipeline DID drop evidence it was holding');
{
  // The pre-fix prompt, synthesized: the self-evidence block did not exist, so a
  // finished ticket's own proof — extracted, held, and sitting in `self_evidence`
  // — never reached the model at all. Reproduced, never fetched from a revision.
  const preFixPromptMentionsEvidence = () => false;
  const wouldHaveBeenDropped = corpus.filter((c) => isDoneWorkState(c.g.work_state)
    && hasSelfEvidence(c.g.self_evidence) && !preFixPromptMentionsEvidence(c.g));
  ok('the pre-fix pipeline dropped real evidence on real finished tickets (so this is not vacuous)',
    wouldHaveBeenDropped.length > 0,
    `${wouldHaveBeenDropped.length} tickets: ${wouldHaveBeenDropped.slice(0, 6).map((c) => c.id).join(', ')}${wouldHaveBeenDropped.length > 6 ? ', …' : ''}`);
  const recovered = wouldHaveBeenDropped.filter((c) => /the fixer's OWN executed evidence/.test(buildPrompt(c.g)));
  ok('almost all of them now have that evidence in their prompt',
    recovered.length >= wouldHaveBeenDropped.length - 2,
    `${recovered.length}/${wouldHaveBeenDropped.length} recovered`);
}

/* ─── 10. THE THREE METAMORPHIC PROPERTIES — ARCH-009's own proof bar ───── */

section('10. the metamorphic properties, over the REAL corpus');
{
  // ARCH-009 states the invariant as three transformations that must not change
  // the answer, and says why they are the right test: none of them requires
  // knowing the right answer for any particular ticket. Round 3 fails all three.
  //
  // Under option C "the answer" is no longer a state — it is (i) what the
  // pipeline transcribes into `verification[]` and (ii) whether the ticket is
  // CONTESTED. So each property is graded against both, over every real ticket.
  const rec = (verdict, n) => `- **Verified-by:** dispatch openai run 01a0${n}-1111-2222-3333-444455556666 (clean-room, \`scripts/independent-verify.mjs\`) — VERDICT: ${verdict.toUpperCase()}`;
  const answerOf = (g, text) => ({
    outstanding: outstandingBroken(g.verification),
    contested: Boolean(contestedEvidence(g, text)),
  });
  const same = (a, b) => a.outstanding === b.outstanding && a.contested === b.contested;

  /* ── (1) APPEND A QUOTED VERDICT → the ticket does not silently change ── */
  //
  // The extractor is still fence-BLIND, deliberately: a CommonMark strip drops 8
  // genuine verdicts from FEAT-091, so filtering would delete real records to
  // catch a hypothetical quoted one. C does not claim quotation is impossible.
  // It claims quotation cannot silently CHANGE an answer — because there is no
  // state to change, and because a document whose two readings disagree is
  // CONTESTED and stops. That is the property, and it is the honest one.
  const quotedBlock = `

### 2026-01-03 — worked example, NOT a record of this ticket

\`\`\`markdown
${rec('holds', 'aaaa')}
\`\`\`
`;
  const quotedOffenders = [];
  for (const c of corpus) {
    const text = c.text + quotedBlock;
    const g = extractGivens(c.file, text);
    // Either the quoted line changed nothing at all, or the ticket is now
    // contested. What is forbidden is a silent change.
    if (!same(answerOf(c.g, c.text), answerOf(g, text)) && !contestedEvidence(g, text)) {
      quotedOffenders.push(`${c.id}: changed silently`);
    }
  }
  ok('(1) appending a QUOTED verdict never silently changes a real ticket\'s answer',
    quotedOffenders.length === 0,
    quotedOffenders.slice(0, 4).join(' | ') || `${corpus.length} tickets, all either unchanged or stopped`);
  // …and non-vacuously: it must actually be DETECTED, not merely tolerated.
  const quotedDetected = corpus.filter((c) => {
    const text = c.text + quotedBlock;
    return Boolean(contestedEvidence(extractGivens(c.file, text), text));
  });
  ok('(1) …and the quoted verdict is DETECTED as contested attribution, not ignored',
    quotedDetected.length === corpus.length,
    `${quotedDetected.length}/${corpus.length} flagged`);

  /* ── (2) APPEND AN `invalid` → nothing changes, on every real ticket ──── */
  //
  // THIS IS FEAT-061 AND FEAT-062'S ENTIRE DEFECT. `invalid` is a legal verdict
  // and the ordinary outcome of a clean-room run that fails its own contract, so
  // a record that resolves nothing must not resolve anything.
  const invalidBlock = `

### 2026-01-03 — a later pass that returned no usable verdict

${rec('invalid', 'dead')}
`;
  //
  // THE PROPERTY IS TWO-SIDED, and stating it loosely would hide a real case.
  // What is OUTSTANDING must not move — strictly, on every ticket. Whether the
  // ticket is CONTESTED may move in ONE direction only: toward a stop. A ticket
  // whose file ends inside an unterminated fence genuinely acquires ambiguous
  // attribution the moment anything is appended to it, and stopping on that is
  // correct. What would be a defect is an `invalid` RESOLVING something, or
  // clearing a conflict that was already there.
  const invalidOffenders = [];
  const invalidStops = [];
  for (const c of corpus) {
    const text = c.text + invalidBlock;
    const g = extractGivens(c.file, text);
    const before = answerOf(c.g, c.text);
    const after = answerOf(g, text);
    if (before.outstanding !== after.outstanding) {
      invalidOffenders.push(`${c.id}: outstanding ${before.outstanding} -> ${after.outstanding}`);
    } else if (before.contested && !after.contested) {
      invalidOffenders.push(`${c.id}: an \`invalid\` CLEARED a conflict`);
    } else if (!before.contested && after.contested) {
      invalidStops.push(c.id);
    }
  }
  ok('(2) appending an `invalid` never resolves anything and never clears a conflict',
    invalidOffenders.length === 0,
    invalidOffenders.slice(0, 4).join(' | ') || `${corpus.length} tickets: nothing resolved, nothing cleared`);
  // …and every such stop must be an ATTRIBUTION conflict, named as one. If an
  // appended `invalid` ever produced a CONTESTED EVIDENCE conflict, the fold
  // would be treating an inert verdict as a claim, which is the defect itself.
  const misnamed = invalidStops.filter((id) => {
    const c = corpus.find((x) => x.id === id);
    const text = c.text + invalidBlock;
    return (contestedEvidence(extractGivens(c.file, text), text) ?? []).some((r) => /CONTESTED EVIDENCE/.test(r));
  });
  ok('(2) …and any resulting stop is an ATTRIBUTION conflict, never an evidence one',
    misnamed.length === 0,
    misnamed.join(', ') || (invalidStops.length
      ? `${invalidStops.length} ticket(s) stop on attribution (files ending inside an open fence): ${invalidStops.join(', ')}`
      : 'no ticket changed at all'));
  // Non-vacuity: there must be tickets where an `invalid` COULD have mattered —
  // i.e. ones carrying an outstanding broken for it to suppress.
  const suppressible = corpus.filter((c) => outstandingBroken(c.g.verification));
  ok('(2) …and the corpus contains tickets an `invalid` could have suppressed (else vacuous)',
    suppressible.length > 0,
    suppressible.map((c) => c.id).join(', ') || 'NONE — property (2) is untestable on this board');

  /* ── (3) REORDER records that resolve nothing → nothing changes ───────── */
  //
  // The last-record fold made position decisive. The whole-set predicate makes
  // only the broken/holds ORDER decisive, so moving an `invalid` anywhere in the
  // sequence must not matter. Driven over every real verdict sequence.
  const reorderOffenders = [];
  let reorderExercised = 0;
  for (const c of corpus) {
    const vs = c.g.verification;
    if (vs.length < 2) continue;
    const inert = vs.filter((v) => v.verdict !== 'broken' && v.verdict !== 'holds');
    const decisive = vs.filter((v) => v.verdict === 'broken' || v.verdict === 'holds');
    if (!inert.length) continue;
    reorderExercised++;
    // Every position an inert record can occupy relative to the decisive ones.
    for (let at = 0; at <= decisive.length; at++) {
      const permuted = [...decisive.slice(0, at), ...inert, ...decisive.slice(at)];
      if (outstandingBroken(permuted) !== outstandingBroken(vs)) {
        reorderOffenders.push(`${c.id} @${at}: ${outstandingBroken(vs)} -> ${outstandingBroken(permuted)}`);
      }
    }
  }
  ok('(3) moving records that resolve nothing never changes what is outstanding',
    reorderOffenders.length === 0,
    reorderOffenders.slice(0, 4).join(' | ') || `${reorderExercised} real sequences permuted, all stable`);
  ok('(3) …and the corpus actually has mixed sequences to permute (else vacuous)',
    reorderExercised > 0, `${reorderExercised} tickets carry both decisive and inert verdicts`);
}

section('10b. MUST-FAIL — round 3 broke all three properties, on the same real data');
{
  // Round 3's rule, synthesized (see §1b for why it is written out rather than
  // fetched). Each property is re-run against it; each must FAIL.
  const round3 = ({ records, statusState }) => {
    const last = records.length ? records[records.length - 1] : null;
    const fromRecords = last ? (last.verdict === 'holds' ? 'holds' : last.verdict === 'broken' ? 'broken' : 'pending') : null;
    if (fromRecords === 'broken') return 'broken';
    if (statusState === 'holds') return 'holds';
    if (statusState && statusState !== 'not_recorded') return statusState;
    if (fromRecords) return 'pending';
    return 'not_recorded';
  };
  const st = (g) => round3({ records: g.verification, statusState: g.status_verification_state });
  const rec = (verdict, n) => `- **Verified-by:** dispatch openai run 01a0${n}-1111-2222-3333-444455556666 (clean-room, \`scripts/independent-verify.mjs\`) — VERDICT: ${verdict.toUpperCase()}`;

  // (1) a QUOTED broken verdict flipped a real VERIFIED ticket to `broken`.
  const verifiedDonor = corpus.find((c) => saysVerified(c.text) && st(c.g) === 'holds');
  ok('a VERIFIED donor exists to build the quoted-verdict case on', Boolean(verifiedDonor),
    verifiedDonor?.id ?? 'NONE — this case cannot be built from the real board');
  if (verifiedDonor) {
    const text = `${verifiedDonor.text}

### 2026-01-03 — worked example, NOT a record of this ticket

\`\`\`markdown
${rec('broken', 'dead')}
\`\`\`
`;
    const g = extractGivens(verifiedDonor.file, text);
    ok('(1) round 3 DID flip a VERIFIED ticket to "broken" on quoted text alone',
      st(verifiedDonor.g) === 'holds' && st(g) === 'broken',
      `${verifiedDonor.id}: ${st(verifiedDonor.g)} -> ${st(g)}`);
    ok('(1) …and the same file is now stopped instead', Boolean(contestedEvidence(g, text)),
      contestedEvidence(g, text)?.[0]?.slice(0, 80) ?? 'NOT STOPPED');
  }

  // (2) a trailing `invalid` suppressed an outstanding `broken`.
  const suppressDonor = corpus.find((c) => outstandingBroken(c.g.verification));
  ok('a donor with an OUTSTANDING broken exists to build the suppression case on', Boolean(suppressDonor),
    suppressDonor ? `${suppressDonor.id} [${suppressDonor.g.verification.map((v) => v.verdict).join(',')}]` : 'NONE');
  if (suppressDonor) {
    const text = `${suppressDonor.text}

### 2026-01-03 — a later pass that returned no usable verdict

${rec('invalid', 'beef')}
`;
    const g = extractGivens(suppressDonor.file, text);
    ok('(2) round 3 DID let one `invalid` suppress an outstanding `broken`',
      outstandingBroken(g.verification) && st(g) !== 'broken',
      `${suppressDonor.id}: outstanding=${outstandingBroken(g.verification)}, round3 said ${st(g)}`);
    ok('(2) …and the fold now reports it unchanged',
      outstandingBroken(g.verification) === outstandingBroken(suppressDonor.g.verification));
  }

  // (3) reordering: the last-record fold is position-sensitive by construction.
  const seq = [{ verdict: 'broken' }, { verdict: 'invalid' }];
  const swapped = [{ verdict: 'invalid' }, { verdict: 'broken' }];
  ok('(3) round 3\'s last-record fold changed its answer on a pure reorder',
    round3({ records: seq, statusState: null }) !== round3({ records: swapped, statusState: null }),
    `${round3({ records: seq, statusState: null })} vs ${round3({ records: swapped, statusState: null })}`);
  ok('(3) …and the whole-set fold does not',
    outstandingBroken(seq) === outstandingBroken(swapped), `both ${outstandingBroken(seq)}`);
}

/* ─── 10c. THE GATE — measured on the real board, bounded, and non-vacuous ─ */

section('10c. the contested-evidence gate — BOTH ARMS fire, on real prose');
{
  const contested = corpus.map((c) => ({ c, why: contestedEvidence(c.g, c.text) })).filter((x) => x.why);
  const liveKinds = new Set(contested.flatMap((x) => x.why.map((r) => (/ATTRIBUTION/.test(r) ? 'attribution' : 'evidence'))));
  console.log(`        (context, NOT asserted) ${contested.length}/${corpus.length} live tickets contested`
    + `${contested.length ? ` [${[...liveKinds].join(', ')}]: ${contested.map((x) => x.c.id).join(', ')}` : ''}`);

  /**
   * WHAT IS NOT ASSERTED HERE, and why.
   *
   * "the gate flags ≥1 real ticket" and "both kinds of conflict occur on the
   * real board" were assertions about the live set. The evidence arm had exactly
   * one live instance, and on 2026-08-20 a human resolved it — correctly — and
   * the second went red; the first would have followed the moment FEAT-091's
   * fence ambiguity is tidied. Both were measuring the board's tidiness, not the
   * gate. What must be true of the GATE is that each arm fires when its conflict
   * is present and stays quiet when it is not, and that is driven below on real
   * tickets.
   */

  // ── ARM 1, EVIDENCE: the claim disagrees with the ticket's own verdicts ──
  const evidenceDriven = [];
  for (const c of brokenDonors) {
    const text = withStatusLine(c.text, 'VERIFIED — proven by the clean room');
    const why = contestedEvidence(extractGivens(c.file, text), text) ?? [];
    if (why.some((r) => /^CONTESTED EVIDENCE/.test(r))) evidenceDriven.push({ id: c.id, why });
  }
  ok('ARM 1 (evidence): a real ticket claiming proof over an unresolved BROKEN is stopped',
    evidenceDriven.length === brokenDonors.length,
    `${evidenceDriven.length}/${brokenDonors.length} donors stopped`);

  // ── ARM 2, ATTRIBUTION: the document's two readings disagree ────────────
  const quoted = `

### 2026-01-03 — worked example, NOT a record of this ticket

\`\`\`markdown
${verdictLine('holds', 'aaaa')}
\`\`\`
`;
  const attributionDriven = [];
  for (const c of corpus) {
    const text = c.text + quoted;
    const why = contestedEvidence(extractGivens(c.file, text), text) ?? [];
    if (why.some((r) => /^CONTESTED ATTRIBUTION/.test(r))) attributionDriven.push({ id: c.id, why });
  }
  ok('ARM 2 (attribution): a quoted verdict makes the two readings disagree, on every real ticket',
    attributionDriven.length === corpus.length,
    `${attributionDriven.length}/${corpus.length} flagged`);

  // ARCH-009's OWN FALSIFICATION CLAUSE, executable: "if the contested set turns
  // out to be large (say >25 of 195), option A is not a gate but a wall". This
  // one IS about the live board — it is a measurement of whether the gate is
  // usable — and it is a proportion, so growing the board does not redden it.
  ok('the contested set is a gate, not a wall (ARCH-009\'s falsification threshold)',
    contested.length <= Math.max(25, Math.round(corpus.length * 0.13)),
    `${contested.length}/${corpus.length} contested (${(100 * contested.length / corpus.length).toFixed(1)}%)`);

  // Every reason NAMES the conflict — "quarantined" with no statement of what
  // disagrees is the pipeline refusing to answer AND refusing to explain. Over
  // the live set AND both driven arms, so it can never be graded on nothing.
  const named = [...contested.map((x) => ({ id: x.c.id, why: x.why })), ...evidenceDriven, ...attributionDriven];
  const mute = named.filter((x) => !x.why.every((r) => /CONTESTED (EVIDENCE|ATTRIBUTION)/.test(r) && r.length > 80));
  ok('every contested ticket names the conflict a human has to resolve', named.length > 0 && mute.length === 0,
    mute.map((x) => x.id).join(', ') || `${named.length} conflict reports, all named`);

  // …and the converse: a ticket whose status line and verdicts AGREE is not
  // stopped, or the gate is just a halt.
  const agreeing = corpus.filter((c) => c.g.verification.length && !outstandingBroken(c.g.verification));
  const falseStops = agreeing.filter((c) => (contestedEvidence(c.g, c.text) ?? []).some((r) => /CONTESTED EVIDENCE/.test(r)));
  ok('a ticket whose claim and evidence agree is NOT stopped', falseStops.length === 0,
    falseStops.map((c) => c.id).join(', ') || `${agreeing.length} agreeing tickets pass`);
}

section('10d. the gate stops the ticket BEFORE the model is asked — driven end to end');
{
  // Not asserted from the function: driven through the real driver, with a
  // dispatch responder that RECORDS being called. A gate that fires only after
  // the answer comes back has already paid for the guess.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arch009-gate-'));
  try {
    const marker = path.join(scratch, 'dispatched.txt');
    const responder = path.join(scratch, 'responder.mjs');
    fs.writeFileSync(responder, `import fs from 'node:fs';\n`
      + `fs.appendFileSync(${JSON.stringify(marker)}, process.argv.join(' ') + '\\n');\n`
      + `process.stdout.write('{}\\n');\n`);

    /**
     * THE BOARD IT RUNS AGAINST IS A COPY, and the conflict is DRIVEN onto it.
     *
     * This used to pick whichever live ticket happened to be contested. When a
     * human resolves the last one — which is the gate succeeding — the check
     * had nothing to run on and failed. So the whole real board is copied, ONE
     * real ticket's status line is driven to claim proof it does not have, and
     * the migration is pointed at the copy with `--dir`. The real docs/bugs is
     * never written to (asserted at the end of this block), which also keeps
     * this suite safe to run beside another lane editing tickets.
     */
    const donor = brokenDonors[0];
    const bugsCopy = path.join(scratch, 'docs', 'bugs');
    fs.mkdirSync(bugsCopy, { recursive: true });
    for (const f of fs.readdirSync(DIR)) {
      const p = path.join(DIR, f);
      if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(bugsCopy, f));
    }
    const drivenText = withStatusLine(donor.text, 'VERIFIED — proven by the clean room');
    fs.writeFileSync(path.join(bugsCopy, donor.file), drivenText);
    const contested = { id: donor.id, file: donor.file, text: donor.text };
    ok('the driven ticket really is contested before the migration is asked to run it',
      Boolean(contestedEvidence(extractGivens(donor.file, drivenText), drivenText)),
      `${donor.id} [${donor.g.verification.map((v) => v.verdict).join(',')}]`);
    {
      const out = path.join(scratch, 'staged');
      const res = spawnSync(process.execPath, [
        path.join(ROOT, 'scripts/migrate-tickets.mjs'), '--dir', bugsCopy, '--ids', contested.id,
        '--out', out, '--today', '2026-08-20',
      ], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, MIGRATE_DISPATCH_BIN: responder } });

      ok('the run exits NONZERO — a stopped ticket is a stopped migration',
        res.status === 1, `exit ${res.status}`);
      ok('the contested ticket is NOT staged — nothing half-decided is written',
        !fs.existsSync(path.join(out, `${contested.file}`)));
      const violFile = path.join(out, 'failed', `${contested.id}.violations.txt`);
      ok('it lands in the EXISTING quarantine path with the conflict named',
        fs.existsSync(violFile) && /CONTESTED (EVIDENCE|ATTRIBUTION)/.test(fs.readFileSync(violFile, 'utf8')),
        fs.existsSync(violFile) ? fs.readFileSync(violFile, 'utf8').slice(0, 100) : 'no violations file');
      ok('the model was NEVER ASKED — the gate runs before the dispatch, not after',
        !fs.existsSync(marker),
        fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').slice(0, 120) : 'no dispatch occurred');
      ok('the original ticket file is untouched',
        fs.readFileSync(path.join(DIR, contested.file), 'utf8') === contested.text);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
section('10e. defect 3 — self-evidence must be a RESULT, never an intention');
{
  // Every case here is the verifier's own, quoted from the round-2 verdict.
  const ev = (t) => hasSelfEvidence(extractSelfEvidence(t));
  ok('a NAMED but unscored suite is not evidence (the sharpest case)',
    !ev('Next step: run verify:foo. The command verify:foo does not exist yet.'));
  ok('two **PASS** tokens in ordinary release prose are not evidence',
    !ev('We shipped it. **PASS** of the release window. Another **PASS** here.'));
  ok('two (PASS) lines with no Verification section are not evidence',
    !ev('text\n```\n(PASS)\n(PASS)\n```\n'));
  ok('"all verification PASSED, but two checks crashed" is not evidence',
    !ev('all verification PASSED, but two checks crashed'));

  // ...and the shapes that MUST still count, so this is a discriminator.
  ok('a SCORED suite is evidence', ev('`verify:real` 12/12 green'));
  ok('a named suite plus a tally elsewhere is evidence (the BUG-012 shape)',
    ev('ran `verify:search`, and after a long clause about 400 and 500 responses, all 11/11 passed'));
  ok('a pre-fix FAIL proof is evidence', ev('pre-fix FAIL proven at 4/9'));
  ok('a standing check reported clean is evidence', ev('typecheck clean'));
  ok('PASS markers under a Verification section are evidence (the FEAT-028 shape)',
    ev('## Verification\n\n1. checked the unit (PASS)\n2. checked the socket (PASS)\n'));
}

section('10f. MUST-FAIL — round 2 accepted every one of those');
{
  const round2Has = (e) => e.suites.length > 0 || e.tallies.length > 0 || e.checks.length > 0
    || e.preFixProof !== null || e.passMarkers >= 2;
  const cases = [
    'Next step: run verify:foo. The command verify:foo does not exist yet.',
    'We shipped it. **PASS** of the release window. Another **PASS** here.',
    'text\n```\n(PASS)\n(PASS)\n```\n',
  ];
  const acceptedThen = cases.filter((t) => round2Has(extractSelfEvidence(t)));
  ok('round 2 accepted these as proof', acceptedThen.length === cases.length,
    `${acceptedThen.length}/${cases.length}`);
  ok('round 3 rejects all of them', cases.every((t) => !hasSelfEvidence(extractSelfEvidence(t))));
}

/* ── 12. ARCH-009 RESOLVED — the two pinned defects, inverted ───────────── */

section('12. ARCH-009 — the two defects this section pinned as PRESENT are gone');
{
  // THIS SECTION USED TO ASSERT THE CURRENT, WRONG BEHAVIOUR, deliberately: a
  // known defect that no test mentions is one that gets forgotten or silently
  // "fixed" outside the decision, so it was encoded to go RED the moment the
  // behaviour changed — which was exactly when someone should read ARCH-009.
  //
  // ARCH-009 was decided on 2026-08-20: option C, gated by A. The two cases are
  // kept, on the same runtime-discovered real donors, with the opposite
  // expectation. Note what the new expectation is NOT: it is not "the pipeline
  // now answers correctly". It is "the pipeline no longer answers", and for the
  // contested half, "it stops and says why".

  /* DEFECT 1 — a trailing `invalid` suppressed an outstanding `broken`. */
  const donor = corpus.find((c) => outstandingBroken(c.g.verification));
  ok('a donor with an OUTSTANDING broken verdict exists to build defect 1 on', Boolean(donor),
    donor ? `${donor.id} [${donor.g.verification.map((v) => v.verdict).join(',')}]`
      : 'NONE — defect 1 cannot be demonstrated from the real board');
  if (!donor) {
    console.log('\nABORT — with no donor this section proves nothing either way.');
    process.exit(1);
  }
  const invalidText = `${donor.text}

### 2026-01-03 — a later pass that returned no usable verdict

- **Verified-by:** dispatch openai run 01a0dead-1111-2222-3333-444455556666 (clean-room, \`scripts/independent-verify.mjs\`) — VERDICT: INVALID
`;
  const withInvalid = extractGivens(donor.file, invalidText);
  ok('DEFECT 1 GONE: the `invalid` is recorded as data and suppresses nothing',
    withInvalid.verification.length === donor.g.verification.length + 1
    && outstandingBroken(withInvalid.verification),
    `${donor.id}: ${withInvalid.verification.map((v) => v.verdict).join(',')} → outstanding=${outstandingBroken(withInvalid.verification)}`);
  ok('DEFECT 1 GONE: and there is no state for it to have suppressed',
    !Object.prototype.hasOwnProperty.call(withInvalid, 'verification_state'));

  /* DEFECT 2 — a QUOTED `VERDICT: BROKEN` fabricated `broken` on a VERIFIED
     ticket, the direct consequence of making the `broken` guard absolute while
     attribution remained impossible (settled: a CommonMark strip drops 8 genuine
     verdicts from FEAT-091, so filtering is not available). */
  const verifiedDonor = corpus.find((c) => saysVerified(c.text) && !contestedEvidence(c.g, c.text));
  ok('an uncontested VERIFIED donor exists to build the quoted-verdict case on', Boolean(verifiedDonor),
    verifiedDonor?.id ?? 'NONE — this case cannot be built from the real board');
  if (verifiedDonor) {
    const quotedText = `${verifiedDonor.text}

### 2026-01-03 — worked example, NOT a record of this ticket

\`\`\`markdown
- **Verified-by:** dispatch openai run 01a0dead-7777-8888-9999-aaaabbbbcccc (clean-room, \`scripts/independent-verify.mjs\`) — VERDICT: BROKEN
\`\`\`
`;
    const withQuoted = extractGivens(verifiedDonor.file, quotedText);
    ok('DEFECT 2 GONE: the quoted verdict cannot flip a state, because there is none',
      !Object.prototype.hasOwnProperty.call(withQuoted, 'verification_state'));
    ok('DEFECT 2 GONE: and the document is STOPPED rather than migrated on a guess',
      Boolean(contestedEvidence(withQuoted, quotedText))
      && !contestedEvidence(verifiedDonor.g, verifiedDonor.text),
      `${verifiedDonor.id}: uncontested before, ${contestedEvidence(withQuoted, quotedText)?.length ?? 0} conflict(s) after`);
  }

  /**
   * THE WHOLE-CORPUS CONSEQUENCE — restated as what the READER gets.
   *
   * This asserted that every ticket the two folds disagree about is CONTESTED.
   * That was never what ARCH-009 promises: a fold disagreement is not a
   * conflict between the ticket and its evidence, it is a disagreement between
   * two ways of reading the evidence, and option C settles it by deleting one
   * of them. FEAT-061 is the case that proves the difference — trailing
   * `invalid`s make the folds disagree, and once its status line stopped
   * claiming proof (2026-08-20) it is correctly NOT contested, at which point
   * this check went red over a ticket the pipeline handles exactly right.
   *
   * The invariant is that wherever the two folds disagree, the answer that
   * reaches the reader is the WHOLE-SET one and the verdicts arrive verbatim —
   * position never decides. Driven through `compose` → `ticketView`, the
   * shipped path, on every disagreeing real ticket.
   */
  const lastFold = (vs) => (vs.length ? vs[vs.length - 1].verdict === 'broken' : false);
  const foldDisagrees = (g) => g.verification.length && outstandingBroken(g.verification) !== lastFold(g.verification);
  const disagree = corpus.filter((c) => foldDisagrees(c.g)).map((c) => ({ id: c.id, g: c.g, live: true }));
  console.log(`        (context, NOT asserted) ${disagree.length} live ticket(s) where the whole-set predicate and the last-record fold disagree`
    + `${disagree.length ? `: ${disagree.map((d) => `${d.id} [${d.g.verification.map((v) => v.verdict).join(',')}]`).join('; ')}` : ''}`);

  // NON-VACUITY BY CONSTRUCTION: a disagreeing sequence is always available,
  // because appending an `invalid` to a donor's outstanding `broken` builds one
  // — the real FEAT-061 shape — whatever the live board currently holds.
  {
    const c = brokenDonors[0];
    const text = withAppendedVerdict(c.text, 'invalid', 'beef');
    const g = extractGivens(c.file, text);
    ok('a disagreeing sequence is constructible from a real ticket (so this section is never vacuous)',
      Boolean(foldDisagrees(g)), `${c.id} + one invalid → [${g.verification.map((v) => v.verdict).join(',')}]`);
    if (foldDisagrees(g) && !disagree.some((d) => d.id === c.id)) disagree.push({ id: c.id, g, live: false });
  }

  const wrongAnswer = [];
  for (const d of disagree) {
    const rec = compose(d.g, {
      title: 'A plain symptom title here', summary: 'x '.repeat(15),
      impact_if_we_wait: 'Bounded placeholder impact.', current_need: 'Nothing outstanding.',
      area: 'Placeholder', severity: 'low', reported_by: 'agent', owner: 'unassigned',
      human_action: 'none', decision: null, decision_history: [], success_criteria: ['Not recorded'],
      code_refs: [], related: [], recurrence_evidence: d.g.type === 'architecture' ? ['BUG-001'] : [],
      verification_class: 'fix', body_prose: {}, source: { confirmation: 'x '.repeat(10), dropped: [] },
    }, { today: '2026-01-01' });
    const view = ticketView({ id: d.id, markdown: rec.text });
    const verbatim = Array.isArray(view.verification)
      && view.verification.length === d.g.verification.length
      && view.verification.every((v, i) => v.verdict === d.g.verification[i].verdict);
    if (!verbatim || outstandingBroken(view.verification) !== outstandingBroken(d.g.verification)) {
      wrongAnswer.push(`${d.id}: view [${(view.verification ?? []).map((v) => v.verdict).join(',')}] outstanding=${outstandingBroken(view.verification ?? [])}`
        + ` vs ticket [${d.g.verification.map((v) => v.verdict).join(',')}] outstanding=${outstandingBroken(d.g.verification)}`);
    }
  }
  ok('where the folds disagree, the reader gets the WHOLE-SET answer and the verdicts verbatim',
    disagree.length > 0 && wrongAnswer.length === 0,
    wrongAnswer.slice(0, 3).join(' | ')
      || `${disagree.length} disagreeing sequence(s) (${disagree.filter((d) => d.live).length} live, ${disagree.filter((d) => !d.live).length} driven), all answered by position-independent fold`);
}
/* ──────────────────────────────────── 8. the worked example stops teaching it */

section('8. worked example #2 no longer demonstrates the evasion');
{
  const need = WORKED_EXAMPLES[1].record.current_need;
  ok('example #2 exists and has a current_need', typeof need === 'string' && need.length > 10, JSON.stringify(need));
  const EVASIONS = [
    /no further action is recorded/i,
    /\bnot recorded\b/i,
    /^\s*the fix is verified\b/i,
    /;\s*the fix is verified and live/i,
  ];
  const hit = EVASIONS.filter((re) => re.test(need));
  ok('it contains none of the evasion shapes the user complained about', hit.length === 0,
    hit.map(String).join(' | ') || JSON.stringify(need));
  ok('it names what actually closed the ticket, not just that it closed',
    /\b(suite|test|check|passes|failed)\b/i.test(need), JSON.stringify(need));
  ok('the caption teaches the rule so the register is not left to luck',
    /never that no evidence is recorded/i.test(WORKED_EXAMPLES[1].caption));

  for (const [i, e] of WORKED_EXAMPLES.entries()) {
    const v = checkTicketWriting(e.record).violations;
    ok(`worked example ${i + 1} still passes the writing contract`, v.length === 0,
      v.map((x) => `${x.rule} ${x.field}: ${x.message}`).join(' | ') || '0 violations');
  }
}

/* ──────────────────────────────────────────────────────────────── summary */

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
