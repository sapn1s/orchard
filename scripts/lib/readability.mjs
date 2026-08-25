/**
 * Readability metrics for assistant PROSE — pure, no I/O, unit-testable.
 *
 * Built for FEAT-085 (Stop-hook readability enforcement) and deliberately kept
 * standalone so a ticket-readability check can consume the SAME metrics next.
 *
 * The proxies here are IDENTICAL to the ones used in the calibration experiment
 * (/tmp/iv-orchard/metrics.py), so thresholds justified against that experiment's
 * two distributions (un-rewritten vs rewritten-for-readability replies) transfer
 * directly:
 *   - sentence  = a line, then split on `.!?` + whitespace (each bullet is ≥1 unit)
 *   - word      = /[A-Za-z0-9']+/
 *   - clause density = (commas + semicolons + " - "/em-dash separators) / sentence
 *                      — the subordinate-clause proxy the experiment used
 *   - Flesch–Kincaid grade = 0.39·(w/s) + 11.8·(syl/w) − 15.59  (local syllable heuristic)
 *
 * MEASUREMENT SCOPE (what is EXCLUDED before measuring — these legitimately skew
 * every metric and are not the assistant's running prose):
 *   - a leading ```orchard-digest fenced block and ALL fenced code blocks
 *   - markdown table rows / dividers
 *   - blockquote lines (quoted text is someone else's prose, not the reply's)
 *   - bare URLs
 * Inline `code` spans are collapsed to a single placeholder word (as the
 * experiment did), so a sentence mentioning code is not spuriously lengthened.
 */

// FEAT-088: STRUCTURAL readability (repeated-claim + ordering detection) lives in
// the sibling module and is re-exported here, so a caller that already depends on
// this module gets both the sentence-level and the document-level checks from one
// import (the stop hook and a board check share the same seam).
export {
  extractClaimUnits, detectRepeatedClaims, detectOrderingIssues, analyzeStructure,
  REPEAT_DEFAULTS,
} from './structure.mjs';

const INLINE_CODE = /`[^`]+`/g;
const FENCED_BLOCK = /```[\s\S]*?```/g; // includes the leading ```orchard-digest
const URL = /\bhttps?:\/\/[^\s)]+/gi;

/** Strip the parts that legitimately skew prose metrics. Returns plain-ish text. */
export function extractProse(input) {
  let t = String(input ?? '');
  // 1. Remove every fenced code block (the orchard-digest block included).
  t = t.replace(FENCED_BLOCK, ' ');
  // 2. Drop table rows/dividers and blockquotes line-by-line.
  const kept = [];
  for (const line of t.split('\n')) {
    const s = line.trim();
    if (!s) { kept.push(''); continue; }
    if (s.startsWith('|')) continue;                 // markdown table row (leading pipe)
    if (/^\|?\s*:?-{3,}:?(\s*\|\s*:?-{3,}:?)+\s*\|?$/.test(s)) continue; // table divider
    if (s.startsWith('>')) continue;                 // blockquote
    kept.push(line);
  }
  t = kept.join('\n');
  // 3. Remove bare URLs.
  t = t.replace(URL, ' ');
  return t;
}

/** Collapse markdown so words/sentences read cleanly (mirrors the experiment). */
function stripMarkdown(t) {
  t = t.replace(INLINE_CODE, ' CODE ');            // inline code -> one placeholder word
  t = t.replace(/[#>*_`]/g, ' ');                  // emphasis / heading / stray fence marks
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');   // [label](url) -> label
  t = t.replace(/^\s*[-+]\s+/gm, ' ');             // list bullets
  return t;
}

function splitSentences(t) {
  const units = [];
  for (const line of t.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    for (const p of l.split(/(?<=[.!?])\s+/)) {
      const pp = p.trim();
      if (pp) units.push(pp);
    }
  }
  return units;
}

function wordsOf(t) {
  return t.match(/[A-Za-z0-9']+/g) || [];
}

/** Local syllable heuristic, identical to the experiment's. */
function syllables(w) {
  const s = w.toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return 0;
  const groups = s.match(/[aeiouy]+/g) || [];
  let n = groups.length;
  if (s.endsWith('e') && n > 1) n -= 1;
  return Math.max(1, n);
}

/**
 * Analyze prose readability. Pure. Returns raw (unrounded) numbers so callers
 * can compare against thresholds precisely; round only for display.
 *
 * @param {string} input raw reply text (may contain digest/code/tables/urls)
 * @returns {{words:number, sentences:number, meanSentenceLength:number,
 *            maxSentenceLength:number, clauseDensity:number, fkGrade:number}}
 */
export function analyzeReadability(input) {
  const prose = extractProse(input);
  const md = stripMarkdown(prose);
  const sentences = splitSentences(md);
  const words = wordsOf(md);
  const nw = words.length;
  const ns = Math.max(1, sentences.length);

  const sentenceLengths = sentences.map((s) => wordsOf(s).length);
  const meanSentenceLength = nw / ns;
  const maxSentenceLength = sentenceLengths.length ? Math.max(...sentenceLengths) : 0;

  const commas = (md.match(/[,;]/g) || []).length;       // commas + semicolons
  const dashes = (md.match(/\s[-—–]\s|—/g) || []).length; // " - " / em-dash separators
  const clauseDensity = (commas + dashes) / ns;

  const totalSyll = words.reduce((a, w) => a + syllables(w), 0);
  const fkGrade = 0.39 * (nw / ns) + 11.8 * (totalSyll / Math.max(1, nw)) - 15.59;

  return {
    words: nw,
    sentences: sentences.length,
    meanSentenceLength,
    maxSentenceLength,
    clauseDensity,
    fkGrade,
  };
}

/* ── Thresholds (justified against the experiment's TWO distributions) ────────
 *
 * Distribution A — un-rewritten (hard to process):
 *     max sentence  38 / 42 / 49 / 52   (min 38)
 *     clause dens   1.10 / 1.15 / 1.26 / 1.73  (min 1.10)
 * Distribution B — rewritten-for-readability (both rewrite models, effortless 1/5):
 *     max sentence  15..38  (max 38, at the single hardest sample S4)
 *     clause dens   0.30..0.81  (max 0.81)
 *
 * PRIMARY gates (the two strongest discriminators, weighted per the brief):
 *   clauseDensity > 1.0   — CLEAN GAP: every good reply ≤ 0.81, every hard reply
 *       ≥ 1.10. 1.0 sits ~23% above the good ceiling and below every bad case.
 *       This is the discriminator that catches the borderline S4 original, whose
 *       max sentence (38) collides with the good S4 rewrite (also 38).
 *   maxSentenceLength > 40 — above the good ceiling (38); the clearly-hard
 *       originals are 42/49/52. 40 gives headroom over good writing while still
 *       flagging a genuinely runaway sentence.
 * A reply violates if EITHER primary is exceeded. Keeping BOTH is why the S4
 * pair (identical max=38) is still separated — by clause density.
 *
 * SECONDARY (reported for actionable context, NEVER a sole trigger — bias to
 * allow): meanSentenceLength 22, fkGrade 12. Un-rewritten means were 16.8 /
 * FK 8.1; good means 8.8 / FK 4.5. These lines sit well above BOTH ranges, so
 * they only ever add colour to a message a primary already raised.
 *
 * LENGTH GUARD (bias hard toward allowing): below minWords OR minSentences we
 * do not judge at all — a short answer, a mostly-code/table/quote reply (whose
 * prose is stripped away above), or a two-sentence reply can never trip. The
 * calibration texts were 140–637 words / 15–43 sentences, so 40/5 is safely
 * below every real "hard" case while protecting every short reply. */
export const READABILITY_THRESHOLDS = Object.freeze({
  minWords: 40,
  minSentences: 5,
  maxSentenceLength: 40, // primary
  clauseDensity: 1.0,    // primary
  meanSentenceLength: 22, // secondary (context only)
  fkGrade: 12,            // secondary (context only)
});

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Evaluate a reply's prose against readability thresholds.
 * Pure. Returns the measurement, whether it was too short to judge, and any
 * violations with an ACTIONABLE per-offence message.
 *
 * @returns {{measured:object, tooShort:boolean, violations:Array<{metric,value,limit,message}>}}
 */
export function evaluateReadability(input, thresholds = READABILITY_THRESHOLDS) {
  const measured = analyzeReadability(input);

  // Bias to allow: too little prose to measure reliably.
  if (measured.words < thresholds.minWords || measured.sentences < thresholds.minSentences) {
    return { measured, tooShort: true, violations: [] };
  }

  const violations = [];

  if (measured.maxSentenceLength > thresholds.maxSentenceLength) {
    violations.push({
      metric: 'maxSentenceLength',
      value: measured.maxSentenceLength,
      limit: thresholds.maxSentenceLength,
      message:
        `one sentence runs ${measured.maxSentenceLength} words; ` +
        `split long sentences so none exceeds ${thresholds.maxSentenceLength}.`,
    });
  }

  if (measured.clauseDensity > thresholds.clauseDensity) {
    violations.push({
      metric: 'clauseDensity',
      value: round2(measured.clauseDensity),
      limit: thresholds.clauseDensity,
      message:
        `averages ${round2(measured.clauseDensity)} clauses per sentence ` +
        `(commas/semicolons/dashes); keep it under ${thresholds.clauseDensity} — ` +
        `fewer nested clauses, more full stops.`,
    });
  }

  // Secondary context: only ever ADDED alongside a primary violation, never the
  // sole cause (keeps the gate biased toward allowing).
  if (violations.length > 0) {
    if (measured.meanSentenceLength > thresholds.meanSentenceLength) {
      violations.push({
        metric: 'meanSentenceLength',
        value: round1(measured.meanSentenceLength),
        limit: thresholds.meanSentenceLength,
        message: `average sentence length is ${round1(measured.meanSentenceLength)} words (aim well below ${thresholds.meanSentenceLength}).`,
      });
    }
    if (measured.fkGrade > thresholds.fkGrade) {
      violations.push({
        metric: 'fkGrade',
        value: round1(measured.fkGrade),
        limit: thresholds.fkGrade,
        message: `reading grade is ~${round1(measured.fkGrade)} (aim well below ${thresholds.fkGrade}).`,
      });
    }
  }

  return { measured, tooShort: false, violations };
}
