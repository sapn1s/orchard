#!/usr/bin/env node
/**
 * verify-ticket-writing-contract.mjs — does the writing contract measure the
 * right thing?
 *
 * THE MUST-FAIL PROOF IS THE POINT. A style checker that passes everything is
 * worthless, and one that fails everything is worse. So this runs the checkable
 * rules over THREE real corpora and asserts a separation, not a pass rate:
 *
 *   A. the prototype rewrites a human wrote to be readable   → must PASS
 *   B. the tickets the migration pipeline produced           → must PASS (core)
 *   C. every ticket in docs/bugs/ (the board as it is today) → must FAIL
 *   D. named real defects in migration output                → must FIRE
 *
 * If B and C do not separate, the rules are measuring the wrong thing, and the
 * correct response is to say so — NOT to move a threshold until they separate.
 *
 * TWO TIERS, AND WHY B IS NO LONGER CLEAN ON BOTH. The CORE rules (T/H/D) ask
 * whether a field is well written; corpus B satisfies all of them and always
 * did. The EXTENDED rules (N/C/U/P/S) ask a different question — whether what is
 * in the field BELONGS there — and they were written precisely because corpus B
 * passes the core rules while carrying evidence in a next-action field, a
 * benefit in a cost column, a precondition that states no precondition, and a
 * self-certifying claim. So corpus B is gated CORE-clean and its extended
 * violations are counted and printed rather than asserted away. Corpus A, the
 * hand-written quality bar, is gated clean on BOTH tiers: that is the assertion
 * that keeps the new rules from being a stylistic tax.
 *
 * HOLDOUT PROTOCOL, SPENT. ARCH-005 was held out of the positive corpora so the
 * user could judge whether the contract PRODUCES prototype-quality output rather
 * than whether a model can copy a known answer. That judgement was made on
 * 2026-08-19 — the four versions were compared and the findings became the
 * extended rules — so ARCH-005 now joins corpus A, and the migration's ARCH-005
 * output is the richest single source of corpus D. The non-contamination check
 * survives in narrowed form: the contract must still share no unexplained 8-gram
 * with the HAND-WRITTEN rewrite, because the contract is injected into the
 * migration prompt and handing over a target answer is still cheating. Quoting a
 * DEFECT out of the machine's own output is not cheating; it is the material.
 *
 * Corpus C is the PRE-MIGRATION PROSE — real tickets, never a fixture. It is the
 * must-FAIL side: the contract's rules earn their place only by firing on the
 * writing the contract was created to replace. What it is NOT is "whatever is in
 * docs/bugs today". It used to be addressed that way, which was correct only for
 * as long as docs/bugs happened to hold the prose. The 2026-08-20 cutover moved
 * the 194 verbatim originals to docs/bugs/archive/ and left records in their
 * place, so the old path silently re-aimed corpus C at the contract's OWN
 * OUTPUT — the positive corpus scored as the negative one — and separation
 * collapsed to 138/198. The corpus is the prose, wherever the prose lives.
 *
 * Corpora A, B and D are the real
 * artifacts of the redesign, in the scratch/prototype paths where they live; if
 * A or B is absent the run says so and does not silently pass on two corpora.
 * Corpus D falls back to verbatim copies, and says when it has, so a cleaned
 * scratch directory cannot quietly delete the must-FAIL side.
 */

import fs from 'node:fs';
import path from 'node:path';
import { checkTicketWriting, WORKED_EXAMPLES, EXTENDED_RULES, codeIdentifiers } from './lib/ticket-writing.mjs';
import { analyzeReadability } from './lib/readability.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
// Corpus C: the pre-migration originals, held verbatim in the archive since the
// cutover. Overridable so the corpus can be pointed at a snapshot, but never
// defaulted to a directory whose contents the contract itself produces.
const ORIGINALS = process.env.TICKET_ORIGINALS_DIR || path.join(REPO, 'docs/bugs/archive');
// Corpora A and B live OUTSIDE the repo (they are not migrated content yet), so
// they are addressed relative to $HOME and overridable — no absolute home path
// is committed. If a corpus is absent the run FAILS rather than passing on one.
const HOME = process.env.HOME || '';
const PROTOTYPE = process.env.TICKET_PROTOTYPE_DIR || path.join(HOME, 'temp_things/tickets/redesigned');
const MIGRATED = process.env.TICKET_MIGRATED_DIR || path.join(HOME, 'scratch/ticket-migration/staged');
// Corpus D's live source: the migration output written AFTER the contract
// landed. It is where the field-purpose defects were found.
const DEFECTS = process.env.TICKET_DEFECT_DIR || path.join(HOME, 'scratch/ticket-migration/staged-round2');
const CONTRACT = path.join(REPO, 'docs/TICKET-WRITING.md');

/**
 * The formerly held-out ticket. Now in corpus A; still the one the contract may
 * not QUOTE from its hand-written rewrite (check 4).
 */
const HOLDOUT = 'ARCH-005';

const read = (f) => fs.readFileSync(f, 'utf8');
const lsMd = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : null);

let failures = 0;
const fail = (m) => { failures++; console.log(`FAIL ${m}`); };
const pass = (m) => console.log(`PASS ${m}`);

/* ── corpus loaders ──────────────────────────────────────────────────────── */

/** New-format ticket: the leading ```orchard-ticket JSON block. */
function fromBlock(file) {
  const m = /^```orchard-ticket\r?\n([\s\S]*?)\r?\n```/.exec(read(file));
  return m ? JSON.parse(m[1]) : null;
}

/**
 * The prototype rewrites are MARKDOWN, not JSON — a human wrote them before the
 * schema existed. Their sections map onto the human-layer fields one-to-one, so
 * they are read into the same record shape rather than being excused from the
 * check for being a different file format.
 */
function fromPrototype(file) {
  const t = read(file);
  const sec = (h) => {
    const m = new RegExp(`^## ${h}.*$\\n([\\s\\S]*?)(?=\\n## |$)`, 'm').exec(t);
    return m ? m[1].trim() : null;
  };
  const title = (/^#\s+\S+\s+[—–-]\s+(.*)$/m.exec(t) || [, null])[1];
  const need = sec('Decision needed') || sec('Done means') || sec('Acceptance criteria');

  /**
   * The prototype's options are BULLETS, in one fixed shape:
   *   `- K — Label. <what it gives>. Not obviously best because <the catch>.`
   * They are parsed rather than skipped because the option-level rules (label
   * length, polarity, a homeless condition) are exactly the ones the four-way
   * comparison was about, and a positive corpus that cannot exercise them proves
   * nothing about them. The key prefix is stripped before the label is measured:
   * `1 — ` is rendering, not words the writer chose.
   */
  const options = [];
  for (const line of (sec('Decision needed') || '').split('\n')) {
    const m = /^-\s+(\S+)\s+[—–-]\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    const rest = m[2];
    const catchClause = /\bNot (?:obviously best|sufficient alone) because\s+(.*)$/i.exec(rest);
    options.push({
      key: m[1],
      label: rest.split(/\.\s/)[0].replace(/\.$/, ''),
      why_not_obvious: catchClause ? catchClause[1].replace(/\.$/, '') : null,
    });
  }
  // The prototype states a prerequisite as its own section when it has one.
  const prereq = (/^## Prerequisite[^\n]*\n([\s\S]*?)(?=\n## |$)/m.exec(t) || [, null])[1];

  return {
    title,
    summary: sec('Summary'),
    impact_if_we_wait: sec('Impact if we wait'),
    current_need: need ? need.split('\n')[0] : null,
    decision: options.length ? { options, prerequisite: prereq ? prereq.trim() : null } : null,
  };
}

/**
 * A LEGACY ticket has no human layer, so there is nothing to compare like for
 * like. What a reader actually meets at the top of the file is: the H1 title,
 * the prose `Status:` line, and the first body section. That is the material the
 * migration compresses into title/summary/impact/current_need, so that is what
 * is graded. Capped at 120 words so a long ticket is not failed merely for being
 * long.
 */
function fromLegacy(file) {
  const t = read(file);
  const title = (/^#\s+\S+\s+[—–-]\s+(.*)$/m.exec(t) || [, null])[1];
  const status = (/^- \*\*Status:\*\*\s*(.*)$/m.exec(t) || [, ''])[1];
  const i = t.search(/^## /m);
  const firstSection = i === -1 ? '' : t.slice(i).split('\n').slice(1).join('\n').split(/^## /m)[0];
  return {
    title,
    summary: (firstSection.match(/\S+/g) || []).slice(0, 120).join(' ') || null,
    impact_if_we_wait: status || null,
    current_need: null,
  };
}

/* ── 1–3: the separation ─────────────────────────────────────────────────── */

function grade(label, dir, loader, { excludeHoldout }) {
  const files = lsMd(dir);
  if (files === null) {
    fail(`${label}: corpus directory is missing (${dir}) — cannot claim separation on two corpora`);
    return null;
  }
  const rows = [];
  for (const f of files) {
    if (!/^(BUG|FEAT|ARCH|DEPLOY)-\d+/.test(f)) continue;
    if (excludeHoldout && f.startsWith(HOLDOUT)) continue;
    let rec;
    try { rec = loader(path.join(dir, f)); } catch (e) { fail(`${label}/${f}: unreadable — ${e.message}`); continue; }
    if (!rec) continue;
    const { violations } = checkTicketWriting(rec);
    rows.push({ f, violations });
  }
  return rows;
}

const byRule = (rows) => {
  const c = {};
  for (const r of rows) for (const v of r.violations) c[v.rule] = (c[v.rule] || 0) + 1;
  return c;
};

console.log('# Ticket writing contract — corpus separation\n');

const proto = grade('prototype', PROTOTYPE, fromPrototype, { excludeHoldout: false });
const migrated = grade('migrated', MIGRATED, fromBlock, { excludeHoldout: false });
const originals = grade('originals', ORIGINALS, fromLegacy, { excludeHoldout: false });

// Corpus A — the hand-written quality bar. Clean on BOTH tiers, or a new rule is
// a stylistic tax rather than a defect detector.
if (proto) {
  if (proto.length === 0) fail('prototype: corpus is empty');
  else {
    const bad = proto.filter((r) => r.violations.length);
    console.log(`  prototype: ${proto.length} tickets (${HOLDOUT} included — holdout spent), ${bad.length} violating`);
    for (const r of bad) for (const v of r.violations) console.log(`      ${r.f}: [${v.rule}/${v.tier}] ${v.field} ${v.message}`);
    if (bad.length === 0) pass(`prototype corpus is clean on core AND extended rules (${proto.length}/${proto.length})`);
    else fail(`prototype corpus should pass but ${bad.length}/${proto.length} violate — a rule that fires on the quality bar is wrong, do not retune the corpus`);
  }
}

// Corpus B — machine output. Gated on CORE; extended violations are the reason
// the extended rules exist, so they are counted, not asserted away.
if (migrated) {
  if (migrated.length === 0) fail('migrated: corpus is empty');
  else {
    const core = migrated.filter((r) => r.violations.some((v) => v.tier === 'core'));
    const ext = migrated.flatMap((r) => r.violations.filter((v) => v.tier === 'extended').map((v) => ({ f: r.f, v })));
    console.log(`  migrated: ${migrated.length} tickets, ${core.length} violating a CORE rule, ${ext.length} extended findings`);
    for (const r of migrated) for (const v of r.violations) console.log(`      ${r.f}: [${v.rule}/${v.tier}] ${v.field} ${v.message}`);
    if (core.length === 0) pass(`migrated corpus is clean on the core rules (${migrated.length}/${migrated.length})`);
    else fail(`migrated corpus should pass the core rules but ${core.length}/${migrated.length} violate`);
    if (ext.length > 0) pass(`the extended rules find ${ext.length} field-purpose defects the core rules pass — that is what they were added for`);
    else fail('the extended rules find nothing in machine output — they were written from defects in it, so finding nothing means they no longer match');
  }
}

if (originals) {
  const bad = originals.filter((r) => r.violations.length);
  console.log(`  originals: ${originals.length} tickets, ${bad.length} violating  ${JSON.stringify(byRule(originals))}`);

  // An empty corpus makes `bad.length === originals.length` true (0 === 0) and
  // the must-FAIL side would report PASS having graded nothing. Say so instead.
  if (originals.length === 0) fail(`originals: corpus at ${ORIGINALS} contains no tickets — the must-FAIL side graded nothing, which proves nothing`);

  // The corpus must be PROSE. If it is pointed at records, the contract is being
  // graded against its own output and a low violation count reads as success at
  // exactly the moment the check has stopped checking. This is the assertion the
  // suite lacked when the cutover re-aimed it at docs/bugs.
  const withRecord = originals.filter((r) => /^```orchard-ticket/m.test(fs.readFileSync(path.join(ORIGINALS, r.f), 'utf8')));
  if (withRecord.length === 0) pass(`corpus C is pre-migration prose — 0/${originals.length} carry a record block`);
  else fail(`originals: ${withRecord.length}/${originals.length} carry a record block (e.g. ${withRecord[0].f}) — this corpus is migration OUTPUT, not the prose the rules must fire on`);

  if (originals.length > 0 && bad.length === originals.length) pass(`every original violates (${bad.length}/${originals.length}) — the must-FAIL side holds`);
  else if (originals.length > 0) fail(`originals: only ${bad.length}/${originals.length} violate; the rules do not discriminate`);
  // Each rule must earn its place: a rule that fires on nothing is dead weight.
  for (const rule of ['T1', 'T2', 'T3', 'H1', 'H2']) {
    if (!byRule(originals)[rule]) fail(`rule ${rule} fires on 0 originals — it discriminates nothing and should be dropped`);
  }
}

/* ── 3b: corpus D — the named defects must FIRE, and only they ───────────── */

/**
 * Every case below is REAL TEXT, quoted from migration output, with the file it
 * came from named. The live file is graded first when it is present; the quoted
 * copies are the durable floor, so a cleaned scratch directory downgrades the
 * provenance of this check and never deletes it.
 *
 * The must-NOT-fire half matters as much: each defect is paired with the
 * correctly-written field that says nearly the same thing, so a rule that fires
 * on both is caught here rather than in a ticket six weeks from now.
 */
const rulesOn = (record) => new Set(checkTicketWriting(record).violations.map((v) => `${v.rule}`));
const firedOn = (record, field) => new Set(
  checkTicketWriting(record).violations.filter((v) => v.field === field).map((v) => v.rule));

console.log('\n# Corpus D — the field-purpose defects (real text, source named)');

const DEFECT_CASES = [
  {
    name: 'evidence in the field that must name the next act',
    src: 'staged-round2/ARCH-005 current_need',
    record: { current_need: "Choose the first-stage approach; verify:decision-shape ran 25/25 successfully and confirmed the decision record's structure, not the display-state design." },
    field: 'current_need', mustFire: ['N1', 'N2'],
  },
  {
    name: 'a status report where an act belongs',
    src: 'staged/BUG-085 current_need',
    record: { current_need: 'No further action is currently recorded; the fix is marked verified.' },
    field: 'current_need', mustFire: ['N3'],
  },
  {
    name: 'a benefit filed as a cost',
    src: 'staged-round2/ARCH-005 options[3].cost',
    record: { decision: { options: [{ key: '3', label: 'Guard every direct read', cost: 'The allowlist needs maintenance and no product behavior changes initially.' }] } },
    field: 'decision.options[0].cost', mustFire: ['C1'],
  },
  {
    name: 'the case FOR the option, inside the field that states the catch',
    src: 'staged-round2/ARCH-005 options[2].why_not_obvious',
    record: { decision: { options: [{ key: '2', label: 'Scope state by project', why_not_obvious: 'This strongest guarantee carries the largest regression surface and slows near-term work.' }] } },
    field: 'decision.options[0].why_not_obvious', mustFire: ['C2'],
  },
  {
    name: 'an argument for the option appended to its own downside',
    src: 'staged/ARCH-005 options[3].why_not_obvious',
    record: { decision: { options: [{ key: '3', label: 'Direct-read ratchet', why_not_obvious: 'It guards the class outside the language rather than eliminating it, but also supplies evidence needed to choose the structural design.' }] } },
    field: 'decision.options[0].why_not_obvious', mustFire: ['C3'],
  },
  {
    name: 'a precondition field that states no precondition',
    src: 'staged-round2/ARCH-005 stages[0].unlocked_by',
    record: { decision: { stages: [{ stage: 1, unlocked_by: 'The current evidence and known direct-read count.' }] } },
    field: 'decision.stages[0].unlocked_by', mustFire: ['U1'],
  },
  {
    name: 'the condition that makes a weak option right, with nowhere to live',
    // DERIVED, and labelled as such: option 4's real pre-guidelines text, with
    // the prerequisite nulled exactly as the post-guidelines rewrite nulled it.
    // Neither real file shows this shape — the earlier one kept the condition in
    // `prerequisite`, the later one deleted the condition altogether — so this is
    // the one case here built rather than quoted whole.
    src: 'staged/ARCH-005 options[4].why_not_obvious + staged-round2 prerequisite: null (derived)',
    record: { decision: { prerequisite: null, options: [{ key: '4', label: 'Per-surface repairs', why_not_obvious: 'It may be defensible under an imminent replacement plan; otherwise repeated verification and misleading intervals make it the costliest path.' }] } },
    field: 'decision.options[0].why_not_obvious', mustFire: ['P1'],
  },
  {
    name: 'the document certifying itself',
    src: 'staged-round2/ARCH-005 source.confirmation',
    record: { source: { confirmation: 'The recurrence, ownership flaw, known unfixed displays, four choices, staged recommendation, migration sequence, proof bar, evidence, bounds, and falsification conditions all survive.' } },
    field: 'source.confirmation', mustFire: ['S1'],
  },
];

for (const c of DEFECT_CASES) {
  const fired = firedOn(c.record, c.field);
  const missing = c.mustFire.filter((r) => !fired.has(r));
  if (missing.length === 0) pass(`D: ${c.name} → ${c.mustFire.join('+')} fires  [${c.src}]`);
  else fail(`D: ${c.name} → ${missing.join('+')} did NOT fire on ${c.field}  [${c.src}]`);
}

/**
 * The same defects, read off the LIVE file rather than off a quotation. A quoted
 * copy proves the rule matches a string; only the real record proves the rule
 * reaches the field inside a whole ticket. When the scratch directory is gone
 * this says so instead of passing quietly.
 */
const liveDefect = (lsMd(DEFECTS) || []).filter((f) => f.startsWith(HOLDOUT))[0];
if (!liveDefect) {
  console.log(`  (corpus D live source absent: ${DEFECTS} — the quoted copies above are the floor)`);
} else {
  const rec = fromBlock(path.join(DEFECTS, liveDefect));
  const fired = rulesOn(rec);
  const want = ['N1', 'N2', 'C1', 'C2', 'U1', 'S1'];
  const missing = want.filter((r) => !fired.has(r));
  if (missing.length === 0) pass(`D-live: the real post-contract ARCH-005 record trips ${want.join(',')} in one grading pass`);
  else fail(`D-live: ${missing.join(',')} did not fire on the real record — the rules match quotations but not tickets`);
}

/** Every extended rule must earn its place on real output or a derived case. */
{
  const seen = new Set([
    ...DEFECT_CASES.flatMap((c) => c.mustFire),
    ...(migrated || []).flatMap((r) => r.violations.filter((v) => v.tier === 'extended').map((v) => v.rule)),
  ]);
  const dead = EXTENDED_RULES.filter((r) => !seen.has(r));
  if (dead.length === 0) pass(`every extended rule (${EXTENDED_RULES.join(',')}) fires on real or derived material`);
  else fail(`extended rule(s) ${dead.join(',')} fire on nothing — dead weight, drop them or say in the doc that they are unproven`);
}

/** The paired good field: nearly the same sentence, correctly written. */
const CONTROL_CASES = [
  { name: 'a port the reader will type survives a next-action field', record: { current_need: 'Restart the service on :4317 so the verified fix becomes live.' }, field: 'current_need' },
  { name: '"nothing is outstanding" plus the proof is not a status report', record: { current_need: 'Nothing is outstanding. The delivery suite that failed before the fix now passes, and the change is live.' }, field: 'current_need' },
  // The BUG-119 boundary, asserted rather than assumed: naming the proof in
  // ordinary words is allowed; only the tally and the suite name are not.
  { name: 'naming the proof in words, with no tally, is allowed', record: { current_need: 'Treat the ticket as closed: the pre-fix case failed, the corrected cap and collapse behavior passed, and standing checks remained clean.' }, field: 'current_need' },
  { name: 'a negated benefit is a cost, not a reassurance', record: { decision: { options: [{ key: '4', label: 'Per-surface repairs', cost: 'Each round has found roughly three more leaks and offers no convergence signal.' }] } }, field: 'decision.options[0].cost' },
  { name: 'a precondition that names a thing which does not exist yet', record: { decision: { stages: [{ stage: 2, unlocked_by: 'Option 3 classification counts for display, non-display, and unclear readers.' }] } }, field: 'decision.stages[0].unlocked_by' },
  { name: 'a confirmation that names what was compared', record: { source: { confirmation: 'Compared line by line against the archived original; the four options, the recommendation and the bounds are present.' } }, field: 'source.confirmation' },
];

for (const c of CONTROL_CASES) {
  const fired = [...firedOn(c.record, c.field)];
  if (fired.length === 0) pass(`D-control: ${c.name} → silent`);
  else fail(`D-control: ${c.name} → ${fired.join(',')} fired on a correctly-written field`);
}

/* ── 3c: a tally is not a file path ──────────────────────────────────────── */

/**
 * The path shape used to be `/[\w.-]+\/[\w./-]+/`, which matched `25/25` and
 * reported a pass tally as "a file path" — failing two of four migrated tickets
 * for a defect they did not have, on a rule about file paths, while the defect
 * they DID have (evidence in a next-action field) went unnamed. Both directions
 * are asserted, because loosening a pattern until it stops firing is the easy
 * wrong fix.
 */
const isPath = (s) => codeIdentifiers(s).some((x) => x.name === 'path');
for (const [s, want] of [['25/25', false], ['the suite passed 14 / 14', false], ['31/0', false],
  ['public/app.js', true], ['docs/bugs/INDEX.md', true], ['scripts/lib', true],
  ['restart the service on :4317', false], ['roughly three per round', false]]) {
  if (isPath(s) === want) pass(`path shape: ${JSON.stringify(s)} ${want ? 'IS' : 'is not'} a path`);
  else fail(`path shape: ${JSON.stringify(s)} was ${isPath(s) ? '' : 'not '}reported as a path, expected the opposite`);
}

/* ── 4: the holdout is not contaminated ──────────────────────────────────── */

/**
 * n-gram overlap between the finished contract (doc + the worked examples it
 * ships) and both ARCH-005 rewrites. Two false-positive classes are EXPECTED and
 * excluded before counting, because a contract and any valid output must share
 * them: schema vocabulary (field names, enum values) and prompt/field labels.
 * Anything else is unexplained and is a failure.
 */
const N = 8;
const SCHEMA_VOCAB = new RegExp([
  'impact[_ ]if[_ ]we[_ ]wait', 'current[_ ]need', 'why[_ ]not[_ ]obvious', 'what[_ ]changes',
  'recommendation[_ ]reason', 'decision[_ ]history', 'verification[_ ]state', 'work[_ ]state',
  'human[_ ]action', 'success[_ ]criteria', 'code[_ ]refs', 'recurrence[_ ]evidence',
  'verification[_ ]class', 'body[_ ]slots', 'reported[_ ]by', 'not[_ ]recorded',
  'staged[_ ]decision', 'multi[_ ]select[_ ]decision', 'answer[_ ]question', 'not[_ ]a[_ ]bug',
  'in[_ ]progress', 'in[_ ]verification', 'not[_ ]required', 'options', 'severity', 'summary', 'title',
].join('|'), 'i');

const normWords = (s) => String(s)
  .toLowerCase()
  .replace(/[`*_#>|]/g, ' ')
  .replace(/[^a-z0-9’'\s]/g, ' ')
  .split(/\s+/).filter(Boolean);

function ngrams(text, n) {
  const w = normWords(text);
  const out = new Map();
  for (let i = 0; i + n <= w.length; i++) {
    const g = w.slice(i, i + n).join(' ');
    if (!out.has(g)) out.set(g, true);
  }
  return out;
}

/**
 * POSITIVE CONTROL for check 4. "0 shared 8-grams" is also what a broken
 * comparator prints, so the comparator is first shown to DETECT an overlap it is
 * given: a sentence lifted verbatim from a holdout source must be found.
 */
function ngramSelfTest(src) {
  const text = read(src);
  const w = normWords(text);
  if (w.length < N + 4) { fail(`n-gram self-test: ${path.basename(src)} is too short to plant a control`); return; }
  const planted = w.slice(4, 4 + N).join(' ');
  const probe = ngrams(`some unrelated preamble ${planted} and some unrelated tail`, N);
  const theirs = ngrams(text, N);
  const hit = [...probe.keys()].filter((g) => theirs.has(g));
  if (hit.length > 0) pass(`n-gram self-test: a planted ${N}-gram from ${path.basename(src)} IS detected (${hit.length} hit)`);
  else fail(`n-gram self-test: a verbatim ${N}-gram from ${path.basename(src)} was NOT detected — check 4 is a no-op`);
}

// Narrowed when the holdout was spent: the HAND-WRITTEN rewrite only. Quoting a
// defect out of the machine's own output is the material this contract is made
// of, so the migrated ARCH-005 files are no longer compared — see the header.
const HOLDOUT_SOURCES = [path.join(PROTOTYPE, 'ARCH-005.md')];

const mine = [read(CONTRACT), WORKED_EXAMPLES.map((e) => e.caption + ' ' + JSON.stringify(e.record)).join('\n')].join('\n');
const mineGrams = ngrams(mine, N);

let unexplained = 0;
for (const src of HOLDOUT_SOURCES) {
  if (!fs.existsSync(src)) { fail(`holdout source missing, cannot prove non-contamination: ${src}`); continue; }
  ngramSelfTest(src);
  const theirs = ngrams(read(src), N);
  const shared = [...mineGrams.keys()].filter((g) => theirs.has(g));
  const explained = shared.filter((g) => SCHEMA_VOCAB.test(g));
  const rest = shared.filter((g) => !SCHEMA_VOCAB.test(g));
  console.log(`  holdout overlap vs ${path.basename(src)}: ${shared.length} shared ${N}-grams `
    + `(${explained.length} schema-vocabulary, ${rest.length} unexplained)`);
  for (const g of rest) console.log(`      UNEXPLAINED: "${g}"`);
  unexplained += rest.length;
}
if (unexplained === 0) pass(`0 unexplained ${N}-grams shared with either ${HOLDOUT} rewrite — the holdout is intact`);
else fail(`${unexplained} unexplained ${N}-grams shared with a ${HOLDOUT} rewrite — injecting this contract would contaminate the holdout`);

/* ── 5: the worked examples obey their own contract ──────────────────────── */

WORKED_EXAMPLES.forEach((e, i) => {
  const { violations } = checkTicketWriting(e.record);
  if (violations.length === 0) pass(`worked example ${i + 1} satisfies the contract it demonstrates`);
  else {
    for (const v of violations) console.log(`      [${v.rule}] ${v.field} ${v.message}`);
    fail(`worked example ${i + 1} violates its own contract in ${violations.length} place(s)`);
  }
});

/* ── 6: the ungated metrics are reported, honestly ───────────────────────── */

console.log('\n# Reported, NOT gated (they do not separate — see docs/TICKET-WRITING.md)');
for (const [label, rows, dir, loader] of [
  ['prototype', proto, PROTOTYPE, fromPrototype],
  ['migrated', migrated, MIGRATED, fromBlock],
  ['originals', originals, ORIGINALS, fromLegacy],
]) {
  if (!rows) continue;
  const cds = [], fks = [];
  for (const r of rows) {
    const rec = loader(path.join(dir, r.f));
    const human = [rec.summary, rec.impact_if_we_wait, rec.current_need].filter(Boolean).join(' ');
    if (!human) continue;
    const a = analyzeReadability(human);
    cds.push(a.clauseDensity); fks.push(a.fkGrade);
  }
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };
  console.log(`  ${label}: clauseDensity median ${med(cds).toFixed(2)} (>1.0 in ${cds.filter((x) => x > 1).length}/${cds.length})`
    + `, fkGrade median ${med(fks).toFixed(1)}`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASS' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
