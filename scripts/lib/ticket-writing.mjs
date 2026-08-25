/**
 * ticket-writing.mjs — the MECHANICAL half of docs/TICKET-WRITING.md.
 *
 * The schema (`ticket-schema.mjs`) settles WHICH fields exist, their enums and
 * their word caps. It cannot settle HOW they are written, and a 60-word summary
 * can be written in exactly the register that made the old board unreadable.
 * This module checks the part of "how" that is honestly checkable and refuses to
 * pretend about the rest.
 *
 * WHY IT IS NOT IN ticket-schema.mjs — two independent reasons:
 *   1. That file carries a PORTABILITY CONTRACT: single file, no imports at all.
 *      These checks reuse `readability.mjs`, so they cannot live there.
 *   2. `validateTicket` is the gate the migration accepts or QUARANTINES on.
 *      A register violation is not a correctness violation; quarantining a
 *      factually-correct ticket for a comma would be the wrong failure mode.
 *      So these are ADVISORY: they report, callers decide.
 *
 * WHAT IS DELIBERATELY NOT HERE. "Leads with consequence, not mechanism", "the
 * impact states its bound", "this number is load-bearing", "the option label
 * names the option rather than the argument for it" are JUDGEMENT. They are
 * stated in the doc with real good/bad pairs and are not faked as tests here.
 * A taste rule dressed as an assertion is worse than an unenforced one, because
 * it gets trusted.
 *
 * CALIBRATION (2026-08-19, three corpora — see verify-ticket-writing-contract.mjs):
 *   prototype rewrites   0/3 violate
 *   migrated tickets     0/3 violate
 *   originals            194/194 violate
 * Per-rule counts on the originals (tickets firing each rule): T1 109, T2 91,
 * T3 178, H1 194, H2 86. Measured 2026-08-20 over docs/bugs/archive/, which is
 * where the pre-migration prose lives since the cutover; the earlier reading
 * (186/186) was the same corpus at docs/bugs, before records took that path.
 * No rule fires on either good corpus, so nothing here is separating by luck.
 *
 * REUSED, NOT REINVENTED: `maxSentenceLength > 40` is `readability.mjs`'s own
 * primary threshold at its own value. Its OTHER primary — clause density > 1.0 —
 * is NOT gated here: it was calibrated on multi-paragraph replies and on 30–60
 * word ticket fields it fires on legitimate LISTS (2/3 migrated tickets), so it
 * is measured and reported as context only. Flesch–Kincaid likewise shows no gap
 * between the corpora (medians 8.2 / 12.5 / 12.0). The thresholds were not
 * adjusted to make the corpora separate; the metrics that do not separate are
 * named as such.
 */

import { analyzeReadability, READABILITY_THRESHOLDS } from './readability.mjs';

/**
 * CODE identifiers — the things that identify a defect to a FIXER and belong in
 * the deep-layer body.
 *
 * Ports, versions and plain numbers are deliberately ABSENT: a symbol earns the
 * human layer when the reader must type it, click it, or recognise it in their
 * own environment, and `:4317` in "restart the service on :4317" is exactly
 * that. A function name never is.
 */
export const CODE_IDENTIFIER_SHAPES = [
  { name: 'code span', re: /`[^`]+`/, why: 'a backticked symbol' },
  // A PATH must contain a letter somewhere. Without the lookahead this shape
  // also matched a pass tally — `25/25` — and reported it as "a file path",
  // which failed two of four migrated tickets for a defect they did not have
  // while missing the one they did (evidence in a next-action field). A tally is
  // caught by N1, in the field where it is actually wrong, with the true reason.
  { name: 'path', re: /(?=[\w./-]*[A-Za-z])[\w.-]+\/[\w./-]+/, why: 'a file path' },
  { name: 'filename', re: /\.(mjs|cjs|js|ts|tsx|json|md|py|sh|css|html)\b/, why: 'a filename' },
  { name: 'camelCase', re: /\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/, why: 'a camelCase symbol' },
  { name: 'snake_case', re: /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/, why: 'a snake_case symbol' },
  { name: 'flag', re: /(^|\s)--[a-z]/, why: 'a command-line flag' },
  { name: 'call', re: /\b\w+\(\)/, why: 'a function call' },
  // A sha must contain BOTH a digit and a hex letter, so "deferred" and plain
  // years are not mistaken for one.
  { name: 'sha', re: /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/, why: 'a commit sha' },
  { name: 'shouting', re: /\b[A-Z]{3,}\b/, why: 'a SHOUTED word' },
  { name: 'ticket id', re: /\b(BUG|FEAT|ARCH|DEPLOY)-\d+\b/, why: 'a ticket id (it belongs in `related`)' },
];

/** Which identifier shapes appear in `s`. Empty array = clean. */
export function codeIdentifiers(s) {
  const t = String(s ?? '');
  return CODE_IDENTIFIER_SHAPES.filter((x) => x.re.test(t));
}

/**
 * A title that is more than one clause. Each of these is a second sentence
 * hiding inside a 12-word line, and each is a shape our own titles actually
 * take — measured over 186 originals: lowercase start 120, parenthesis 79,
 * comma 69, colon 58, quote 32, `, so`-chain 17.
 */
export const TITLE_CLAUSE_SHAPES = [
  { name: 'clause chain', re: /,\s*(so|and|but|which|because)\b/i, why: 'a comma plus a conjunction — state the outcome, put the mechanism in the summary' },
  { name: 'colon clause', re: /\S:\s/, why: 'a colon clause — the log-line shape' },
  { name: 'parenthesis', re: /\(/, why: 'a parenthetical aside' },
  { name: 'quotation', re: /["“]/, why: 'a quoted string — it belongs in the summary or the body' },
  { name: 'dash clause', re: /\s[—–]\s|\s-\s/, why: 'a dash clause — two statements joined' },
  { name: 'lowercase start', re: /^[a-z]/, why: 'a lowercase first word — titles are sentence case' },
];

const words = (s) => (String(s ?? '').trim().match(/\S+/g) || []).length;

/** The doc's own caps, re-stated here only for the fields this module judges. */
export const TITLE_WORD_CAP = 12;
export const OPTION_LABEL_WORD_CAP = 8;
export const MIN_RECOMMENDATION_REASON_WORDS = 8;

/** Sentence punctuation in an option LABEL means the argument leaked into it. */
const LABEL_SENTENCE_SHAPES = [
  { re: /[,;]/, why: 'a comma or semicolon' },
  { re: /\.\s|\S\.$/, why: 'a full stop' },
  { re: /\b(because|so that|but|however|whereas)\b/i, why: 'an argument connective' },
];

const normalize = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/* ────────────────────────────────── field purpose: the WRONG KIND OF THING ──
 *
 * The rules above ask whether a field is well written. These ask whether what
 * is in it belongs there at all — a different failure, and the one that survived
 * two tuning rounds because every field was individually well written.
 *
 * Each shape below was written against a REAL defect in real migration output
 * (docs/TICKET-WRITING.md quotes the instances). Each is deliberately NARROW: it
 * matches a shape, not a meaning, and the meaning-level version of every one of
 * them is stated in the doc as [judgement] rather than faked here.
 */

/** A next-action field carrying EVIDENCE instead of an act. */
export const NEED_EVIDENCE_SHAPES = [
  // `25/25`, `31/0`, `14 / 14` — a run tally. True and interesting; it changes
  // nothing the reader does next, and this is the one field they always read.
  { rule: 'N1', re: /\b\d+\s*\/\s*\d+\b/, why: 'a pass tally — evidence belongs in the body, not in the field that names the next act' },
  // `verify:decision-shape`, `npm run gate`, `board:check` — a suite name.
  { rule: 'N2', re: /\b[a-z][a-z0-9-]*:[a-z][a-z0-9-]+|(^|\s)npm run\b/, why: 'a suite or command name — the reader of this field is not the one who runs it' },
];

/** A next-action field REPORTING A STATUS: it names no act and no actor. */
export const NEED_STATUS_SHAPES = [
  { rule: 'N3', re: /^\s*(no further action|nothing (further )?(is|was|has been) recorded|this (is|remains) blocked|blocked pending|pending (a )?review)/i, why: 'a status report — say what someone must now do, or what closed the ticket and what proves it' },
];

/**
 * POLARITY. `benefit` is the upside column and `cost` / `why_not_obvious` are
 * the downside columns. A table whose value is comparability is corrupted by one
 * cell of the wrong sign, because the reader compares columns, not paragraphs.
 */
export const POLARITY_SHAPES = [
  // "The allowlist needs maintenance and no product behavior changes initially."
  { rule: 'C1', fields: ['cost'], re: /\b(and|but|while|with)\s+(no|nothing)\s+(\w+\s+){0,2}(change|changes|behaviou?r|impact|risk|regression|downside|cost|migration)\b|\bnothing changes\b/i, why: 'a reassurance clause — "no X changes" is a benefit, and it is in the cost column' },
  // "This strongest guarantee carries the largest regression surface…"
  { rule: 'C2', fields: ['cost', 'why_not_obvious'], re: /\b(strongest|cheapest|safest|simplest|fastest|most reliable|most robust)\b/i, why: 'a superiority claim — the case FOR the option belongs in benefit' },
  // "…rather than eliminating it, but also supplies evidence needed to choose…"
  { rule: 'C3', fields: ['why_not_obvious'], re: /\b(but|while|though|yet) (also|it also|this also)\b|\band it also (supplies|gives|provides|creates)\b/i, why: 'an argument FOR inside the field that states the catch — the sentence was finished before it' },
];

/**
 * A PRECONDITION field that states no precondition. "The current evidence and
 * known direct-read count" means "nothing blocks this", phrased as if it were a
 * blocker — the reader has to work that out, and gets no gate from the gate.
 */
export const PRESENT_STATE_SHAPES = [
  { rule: 'U1', re: /\b(current|currently|existing|already|today'?s?|the present|so far)\b/i, why: 'present state — a precondition names something that does not exist yet' },
];

/**
 * A condition that makes an otherwise-weak option CORRECT. It has exactly one
 * home — `decision.prerequisite` — and when that is null the condition is loose
 * in an option field, where it reads as a hedge instead of as a gate.
 */
export const CONDITIONAL_CORRECTNESS = {
  rule: 'P1',
  re: /\b(only if|defensible|unless|provided that|depends on whether|so long as|contingent on)\b/i,
  why: 'a condition that would make this option right — that is a prerequisite, and prerequisite is null',
};

/** Self-certification: a claim about the document, by the document. */
export const SELF_CERTIFICATION = {
  rule: 'S1',
  claim: /\b(survives?|survive|preserved|preserves|retained|intact|carried over)\b/i,
  method: /\b(compared|comparison|diff(ed)?|checked against|re-?read|line by line|byte|sha|word count|against the archived|against the original)\b/i,
  why: 'asserts that nothing was lost without saying what was compared or how — unfalsifiable from inside the document',
};

/** Rules added by the field-purpose pass; reported separately from the core. */
export const EXTENDED_RULES = Object.freeze(['N1', 'N2', 'N3', 'C1', 'C2', 'C3', 'U1', 'P1', 'S1']);

/**
 * Grade one ticket record against the CHECKABLE rules of docs/TICKET-WRITING.md.
 *
 * @param {object} record a new-format ticket record (or any object with the
 *   human-layer fields; missing fields are skipped, never invented).
 * @returns {{violations: Array<{rule,field,message}>, measured: object}}
 *   `measured` carries the two readability numbers that are REPORTED and not
 *   gated, so a caller can show them without them ever failing a ticket.
 */
export function checkTicketWriting(record) {
  const violations = [];
  const r = record && typeof record === 'object' ? record : {};
  const bad = (rule, field, message) => violations.push({
    rule, field, message, tier: EXTENDED_RULES.includes(rule) ? 'extended' : 'core',
  });

  // ── T: the title ────────────────────────────────────────────────────────
  if (typeof r.title === 'string' && r.title.trim()) {
    const t = r.title.trim();
    if (words(t) > TITLE_WORD_CAP) {
      bad('T1', 'title', `is ${words(t)} words, over the ${TITLE_WORD_CAP}-word cap`);
    }
    for (const id of codeIdentifiers(t)) {
      bad('T2', 'title', `contains ${id.why} — the human layer names what a person sees, not what the code is called`);
    }
    for (const shape of TITLE_CLAUSE_SHAPES) {
      if (shape.re.test(t)) bad('T3', 'title', `contains ${shape.why}`);
    }
  }

  // ── H: the human-layer prose ────────────────────────────────────────────
  const HUMAN_FIELDS = ['summary', 'impact_if_we_wait', 'current_need'];
  const humanParts = [];
  for (const f of HUMAN_FIELDS) {
    const v = r[f];
    if (typeof v !== 'string' || !v.trim()) continue;
    humanParts.push(v.trim());
    for (const id of codeIdentifiers(v)) {
      bad('H1', f, `contains ${id.why} — move it to the deep-layer body`);
    }
  }

  const human = humanParts.join(' ');
  const measured = human ? analyzeReadability(human) : null;
  if (measured && measured.maxSentenceLength > READABILITY_THRESHOLDS.maxSentenceLength) {
    bad('H2', 'summary/impact/need',
      `one sentence runs ${measured.maxSentenceLength} words; keep every sentence at or under ` +
      `${READABILITY_THRESHOLDS.maxSentenceLength}`);
  }

  // ── N: the field the reader is GUARANTEED to read ───────────────────────
  if (typeof r.current_need === 'string' && r.current_need.trim()) {
    const need = r.current_need.trim();
    for (const s of [...NEED_EVIDENCE_SHAPES, ...NEED_STATUS_SHAPES]) {
      if (s.re.test(need)) bad(s.rule, 'current_need', `contains ${s.why}`);
    }
  }

  // ── D: the decision fields ──────────────────────────────────────────────
  const d = r.decision;
  if (d && typeof d === 'object') {
    if (typeof d.question === 'string' && d.question.trim()) {
      const q = d.question.trim();
      if (!/\?$/.test(q)) bad('D1', 'decision.question', 'does not end in "?" — a decision field states the question being asked');
      for (const id of codeIdentifiers(q)) {
        bad('D1', 'decision.question', `contains ${id.why} — the question must be answerable without opening the body`);
      }
    }
    if (Array.isArray(d.options)) {
      d.options.forEach((o, i) => {
        const at = `decision.options[${i}].label`;
        if (!o || typeof o.label !== 'string' || !o.label.trim()) return;
        const label = o.label.trim();
        if (words(label) > OPTION_LABEL_WORD_CAP) {
          bad('D2', at, `is ${words(label)} words, over the ${OPTION_LABEL_WORD_CAP}-word cap`);
        }
        for (const s of LABEL_SENTENCE_SHAPES) {
          if (s.re.test(label)) {
            bad('D2', at, `contains ${s.why} — the label names the option; the argument goes in what_changes / benefit / cost / why_not_obvious`);
            break;
          }
        }
      });

      // Polarity, and the homeless condition. Both are read per option, because
      // the reader compares the COLUMN and one cell of the wrong sign is enough.
      d.options.forEach((o, i) => {
        if (!o || typeof o !== 'object') return;
        for (const s of POLARITY_SHAPES) {
          for (const f of s.fields) {
            const v = o[f];
            if (typeof v === 'string' && v.trim() && s.re.test(v)) {
              bad(s.rule, `decision.options[${i}].${f}`, `contains ${s.why}`);
            }
          }
        }
        if (d.prerequisite === null || d.prerequisite === undefined) {
          for (const f of ['what_changes', 'benefit', 'cost', 'why_not_obvious']) {
            const v = o[f];
            if (typeof v === 'string' && v.trim() && CONDITIONAL_CORRECTNESS.re.test(v)) {
              bad(CONDITIONAL_CORRECTNESS.rule, `decision.options[${i}].${f}`,
                `contains ${CONDITIONAL_CORRECTNESS.why}`);
            }
          }
        }
      });
    }

    // A stage gate that names present state is not a gate.
    if (Array.isArray(d.stages)) {
      d.stages.forEach((st, i) => {
        if (!st || typeof st.unlocked_by !== 'string' || !st.unlocked_by.trim()) return;
        for (const s of PRESENT_STATE_SHAPES) {
          if (s.re.test(st.unlocked_by)) {
            bad(s.rule, `decision.stages[${i}].unlocked_by`, `names ${s.why}`);
          }
        }
      });
    }
    // The reason must give WHY this option beats the others. `null` is honest
    // and is checked by validateTicket, not here — this rule only fires on a
    // reason that EXISTS and says nothing the label did not already say.
    const reason = d.recommendation_reason;
    if (typeof reason === 'string' && reason.trim()) {
      const rr = reason.trim();
      if (words(rr) < MIN_RECOMMENDATION_REASON_WORDS) {
        bad('D3', 'decision.recommendation_reason',
          `is ${words(rr)} words — too short to say why this option beats the others`);
      }
      const chosen = Array.isArray(d.options)
        ? d.options.find((o) => o && o.key === d.recommendation)
        : null;
      if (chosen && typeof chosen.label === 'string' && normalize(rr) === normalize(chosen.label)) {
        bad('D3', 'decision.recommendation_reason',
          'restates the option label — say why it beats the others, not what it is');
      }
    }
  }

  // ── S: the document's claim about itself ────────────────────────────────
  const conf = r.source && typeof r.source === 'object' ? r.source.confirmation : null;
  if (typeof conf === 'string' && conf.trim()) {
    if (SELF_CERTIFICATION.claim.test(conf) && !SELF_CERTIFICATION.method.test(conf)) {
      bad(SELF_CERTIFICATION.rule, 'source.confirmation', SELF_CERTIFICATION.why);
    }
  }

  return { violations, measured };
}

/* ───────────────────────────────────────────────────────── worked examples */

/**
 * THE DEMONSTRATION, owned here rather than in the migration prompt.
 *
 * Why this is an artifact of the contract and not of the pipeline: a model takes
 * REGISTER and DENSITY from a demonstration far more reliably than from a
 * description of them, so the example is load-bearing. Two independently
 * maintained sources of "how to write a field" drift, and the drift is invisible
 * — every ticket still validates. So the rules and their demonstration ship from
 * one module, and `migrate-tickets.mjs` imports both.
 *
 * ALL examples are SYNTHETIC — invented for this contract, not migrated from
 * any real ticket. That is deliberate on two counts: an invented example cannot
 * leak a held-out ticket's answer into a prompt, and the real good/bad pairs
 * that teach each individual rule are in docs/TICKET-WRITING.md, drawn from the
 * board. The example teaches voice; the doc teaches rules.
 *
 * There are THREE because the corpus has three shapes. Measured over the 183
 * real tickets: 127 lead with VERIFIED and carry no live decision at all. A
 * single decision-shaped example leaves the majority shape — done work,
 * `decision: null`, a `current_need` that is not a question — with nothing to
 * imitate.
 *
 * The THIRD was added because example 2 alone taught something false. It shows a
 * finished ticket that is CLEANLY finished, and a demonstration that only shows
 * the clean case teaches that every finished ticket is clean: given a ticket
 * that shipped but left two pieces unbuilt, a model wrote `human_action: none`
 * and "nothing is outstanding" over the top of a live handoff, and the decision
 * stopped being visible to anyone. Reproduced on a second ticket. Example 3 is
 * therefore the commonest real shape — shipped, verified, and still carrying a
 * choice — so that "done" and "nothing outstanding" stop being the same word.
 *
 * All three pass `checkTicketWriting` with zero violations; the verify script
 * asserts it, so an example can never drift out of its own contract.
 */
export const WORKED_EXAMPLES = Object.freeze([
  Object.freeze({
    caption: 'A ticket waiting on a person. Note: the title is the outcome, not the cause; '
      + 'the summary leads with what someone saw; the impact names its own bound; '
      + 'each option label is short enough to compare four of them at a glance.',
    record: Object.freeze({
      title: 'Restoring a snapshot deletes the snapshot it restored',
      summary: 'Restoring a saved snapshot overwrites the session and removes the file it just read. '
        + 'The snapshot is gone afterwards, so the same restore cannot be repeated or undone.',
      impact_if_we_wait: 'One snapshot is lost per restore, silently. Bounded: only the restored snapshot '
        + 'is affected. Other snapshots and live session data are untouched, and nothing outside the '
        + 'snapshot store is written.',
      current_need: 'Decide whether restore should copy or consume the snapshot, then schedule the fix.',
      area: 'Session snapshots',
      severity: 'high',
      human_action: 'decide',
      decision: Object.freeze({
        mode: 'single',
        question: 'Should restoring a snapshot consume it, or leave it in place?',
        options: Object.freeze([
          Object.freeze({
            key: 'A',
            label: 'Copy on restore',
            what_changes: 'Restore reads the snapshot and leaves the file untouched; the store grows until pruned.',
            benefit: 'A snapshot can be restored repeatedly, which is what people already assume it does.',
            cost: 'The store grows without bound and needs a retention rule nobody has written yet.',
            why_not_obvious: 'It trades a visible data-loss bug for an invisible disk-growth one, which is harder to notice and harder to attribute later.',
          }),
          Object.freeze({
            key: 'B',
            label: 'Consume on restore with confirmation',
            what_changes: 'Restore still removes the snapshot but says so first and offers to keep a copy.',
            benefit: 'Storage stays bounded and the loss stops being silent.',
            cost: 'Adds a prompt to a path that is one click today, on every restore.',
            why_not_obvious: 'A confirmation people learn to dismiss is not consent, so the loss may stay effectively silent.',
          }),
        ]),
        recommendation: 'A',
        recommendation_reason: 'Losing a user file silently is the worse failure, and unbounded growth is measurable and can be capped later.',
        prerequisite: null,
      }),
    }),
  }),
  Object.freeze({
    caption: 'The majority shape: work that is finished. There is no decision, the '
      + 'summary is written in the past tense about what was wrong, and `current_need` '
      + 'names the remaining act rather than restating the problem. When nothing '
      + 'remains, it says what CLOSED the ticket — the evidence — and never that no '
      + 'evidence is recorded. "No further action is recorded" and "the fix is '
      + 'verified" are the two shapes to avoid: the first states the absence of a '
      + 'record where a record exists, the second asserts the conclusion while '
      + 'withholding what produced it. A finished ticket almost always has a suite, '
      + 'a tally or a failure-then-pass proof in its log; name it.',
    record: Object.freeze({
      title: 'Queued messages were sent after the session had closed',
      summary: 'A message typed while a session was shutting down was accepted and then delivered to '
        + 'nothing. The sender saw it leave the compose box, and no reply ever arrived.',
      impact_if_we_wait: 'Work is lost quietly, and the person only finds out by noticing silence. '
        + 'Bounded: the message text stays in the transcript, and no other session is affected.',
      current_need: 'Nothing is outstanding. The delivery suite that failed before the fix now passes, and the change is live.',
      area: 'Message delivery',
      severity: 'medium',
      human_action: 'none',
      decision: null,
    }),
  }),
  Object.freeze({
    caption: 'The commonest shape of all: the work SHIPPED, and a piece of it did not. '
      + 'Note what leads — what is in place now, not the symptom it replaced and not the '
      + 'leftover. The gap is stated plainly, in one clause, and it is not promoted into '
      + 'being the subject of the ticket just because it is the only thing still open. '
      + 'The summary names the evidence that closed the built part, because "verified" '
      + 'with nothing behind it is the same empty sentence as "no further action is '
      + 'recorded". `human_action` is `decide` because the original left a real choice — '
      + 'not because a ticket with a decision looks more important than one without. An '
      + 'idea the original merely offers in passing is a note, and stays one. '
      + 'Four things this example carries that a shorter rewrite drops, all of which change '
      + 'what a reader decides: the impact says what is wrong RIGHT NOW and on purpose, so '
      + 'waiting does not read as free; the weak option is priced with the observed rate '
      + 'rather than called weak; `prerequisite` holds the condition that would make that '
      + 'weak option the right answer, instead of it being softened into a hedge; and the '
      + 'recommendation reason says the work is reversible, which is usually the strongest '
      + 'argument available and is usually left in the body.',
    record: Object.freeze({
      title: 'Uploads no longer appear half-written to readers',
      summary: 'Uploads are now published only once complete, so a reader can no longer open a '
        + 'partly-written file. The import suite that reproduced the torn read passes. Scheduled '
        + 'imports still bypass the new path and were left as they were.',
      impact_if_we_wait: 'Two scheduled imports are serving partial files today, left that way on '
        + 'purpose until this is decided. Bounded: interactive uploads are fixed, and no stored '
        + 'file is at risk either way.',
      current_need: 'Decide whether to move scheduled imports onto the same publish step or leave '
        + 'them on the old path.',
      area: 'Upload publishing',
      severity: 'medium',
      human_action: 'decide',
      decision: Object.freeze({
        mode: 'single',
        question: 'Should scheduled imports use the new publish step, or stay as they are?',
        options: Object.freeze([
          Object.freeze({
            key: 'A',
            label: 'Move scheduled imports over',
            what_changes: 'Scheduled imports write to the holding area and publish the same way interactive ones do.',
            benefit: 'The torn read becomes impossible on every path rather than most of them.',
            cost: 'The scheduler retries differ enough that its failure handling has to be reworked.',
            why_not_obvious: 'A reworked retry can drop an import silently, which is worse than the partial file it prevents.',
          }),
          Object.freeze({
            key: 'B',
            label: 'Leave scheduled imports alone',
            what_changes: 'Nothing moves, and the older path keeps publishing directly.',
            benefit: 'No further work, and the path that people actually use is already fixed.',
            cost: 'Every review round so far has found one more caller still writing the old way.',
            why_not_obvious: 'The remaining path is the one nobody watches, so its failures surface late.',
          }),
        ]),
        recommendation: 'A',
        recommendation_reason: 'It removes the failures nobody watches, and each batch lands alone and reverts in one step.',
        prerequisite: 'Establish whether the scheduler is being replaced anyway. If it is, leaving it alone stops being a shortcut and becomes correct.',
      }),
    }),
  }),
]);

/** The worked examples as prompt text: caption, then the record as JSON. */
export function renderWorkedExamples() {
  return WORKED_EXAMPLES.map((e, i) =>
    `WORKED EXAMPLE ${i + 1} — the shape and the REGISTER expected. Synthetic, not a migrated ticket.\n`
    + `${e.caption}\n\n${JSON.stringify(e.record, null, 2)}`).join('\n\n');
}
