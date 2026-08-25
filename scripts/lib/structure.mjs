/**
 * STRUCTURAL readability — repetition + ordering, pure and no I/O (FEAT-088).
 *
 * The sentence-level module (readability.mjs) measures how hard a SENTENCE is to
 * process (clause density, length, grade). It cannot see DOCUMENT-level defects:
 * the same claim asserted five times, the thesis placed after the decision it
 * justifies. Those are what actually stalled the user on ARCH-003, and every one
 * of them is invisible to per-sentence metrics.
 *
 * This module adds the cheap, deterministic Layer 1 from FEAT-088:
 *   - detectRepeatedClaims(text)  — clusters of restated claims, with quotes+lines
 *   - detectOrderingIssues(text)  — a recommendation whose justification appears
 *                                   ONLY after the decision it supports
 *
 * DESIGN — why keyword-set overlap with idf weights + single-link clustering:
 *   A restated CLAIM keeps its distinctive content words even as the wording is
 *   reshaped ("Three different fixes … rejected", "Three fixes, three rejections",
 *   "six distinct ways … in three attempts"). Sentence LENGTH and clause density
 *   are blind to that; a keyword-set signature is not. We:
 *     1. Split the doc into CLAIM UNITS (sentences of running prose — code blocks,
 *        tables, headings and blockquotes excluded, because a heading echoed in a
 *        table or a term of art quoted in code is NOT a restated claim).
 *     2. Normalise each unit to a set of content tokens (stopwords dropped, light
 *        suffix stemming, small cardinals folded so "3 attempts" == "three
 *        attempts").
 *     3. Weight tokens by idf across the document, so ubiquitous words carry
 *        almost nothing and distinctive ones ("rejected", "deployed", "restart")
 *        carry the signal. A specific recurring CARDINAL is boosted — a number
 *        restated verbatim across the document is a strong "same claim" tell.
 *     4. Two units are "the same claim" when their weighted OVERLAP coefficient
 *        clears a threshold AND they share ≥2 content tokens AND the shared weight
 *        clears an absolute floor (so a single common word can never merge them).
 *     5. SINGLE-LINK cluster those pairs; keep clusters of ≥3 occurrences. "Stated
 *        repeatedly" means 3+; a claim appearing exactly TWICE (a summary line and
 *        its detail) is the legitimate recurrence the ticket says to leave alone.
 *
 * Everything here is a PURE function of its string input — same reusable seam as
 * readability.mjs, so a stop hook, a board check and a test all share it.
 */

/* ── tokenisation ───────────────────────────────────────────────────────────── */

const STOPWORDS = new Set((
  'a an the and or but nor so yet for of to in on at by with from into onto upon ' +
  'as is are was were be been being am do does did done doing have has had having ' +
  'it its this that these those there here their them they he she his her him we us ' +
  'our you your i me my mine ours yours not no yes if then than that which who whom ' +
  'whose what when where why how all any some each every both few more most other ' +
  'such only own same too very can will just should now also about above after ' +
  'again against because before below between out over under up down off ' +
  'while during through per via still yet ever never always would could may might ' +
  'must shall being about it s t re ve ll d m one-of'
).split(/\s+/).filter(Boolean));

const CARDINALS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/** Fold small cardinals so "3" and "three" tokenise identically. */
function foldCardinal(w) {
  if (/^\d{1,2}$/.test(w)) {
    const n = Number(w);
    if (n >= 0 && n <= 12) return `num:${n}`;
  }
  if (w in CARDINALS) return `num:${CARDINALS[w]}`;
  return null;
}

/** Very light suffix stemmer — enough to fold fix/fixes, reject/rejected/rejections. */
function stem(w) {
  let s = w;
  if (s.length > 4 && s.endsWith('ions')) return s.slice(0, -4);   // rejections -> reject
  if (s.length > 4 && s.endsWith('tion')) return s.slice(0, -4);   // rejection  -> reject
  if (s.length > 4 && s.endsWith('ing')) s = s.slice(0, -3);       // running    -> runn
  else if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2);   // rejected   -> reject
  else if (s.length > 3 && s.endsWith('es')) s = s.slice(0, -2);   // fixes      -> fix
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1); // times -> time
  if (s.length > 4 && s.endsWith('ly')) s = s.slice(0, -2);        // silently   -> silent
  // undo a couple of over-stems from the -ing/-ed rules
  if (s.endsWith('nn')) s = s.slice(0, -1);                        // runn -> run
  return s;
}

/**
 * Neutralise numbers that are MEASUREMENTS / RATIOS / references, not counts — a
 * digit in "3:1", "3×", "≥3", "3.5", "128px", "1777" is not the ticket asserting
 * "three of something". Left un-neutralised these make a count-anchor fire on a
 * doc that merely reuses a number for unrelated measures (a WCAG ticket full of
 * "3:1" contrast ratios). Only a bare small integer survives as a countable.
 */
function maskMeasurements(text) {
  return text
    .replace(/\d+(\.\d+)?\s*[:×xX/]\s*\d+(\.\d+)?/g, ' ') // ratios: 3:1, 3x2, 3/4
    .replace(/[≥≤<>]=?\s*\d+(\.\d+)?/g, ' ')              // thresholds: ≥3, <5
    .replace(/\d+(\.\d+)?\s*(px|em|rem|ms|hz|fps|kb|mb|gb|pt|vh|vw|%|°|s|x|×)\b/gi, ' ') // units: 128px, 3×
    .replace(/\b\d+\.\d+\b/g, ' ')                        // decimals / versions
    .replace(/#?\b\d{3,}\b/g, ' ');                       // long numbers: code line refs, ids
}

/** Ordered content tokens of a unit (dups kept — needed for adjacency shingles). */
function tokenSeq(text) {
  const raw = (maskMeasurements(text).toLowerCase().match(/[a-z0-9]+/g) || []);
  const seq = [];
  for (const w of raw) {
    const card = foldCardinal(w);
    if (card) { seq.push({ token: card, isCardinal: true }); continue; }
    if (/^\d+$/.test(w)) continue;       // a bare number that is not a small count: not a claim word
    if (w.length < 3) continue;          // drop 1-2 char noise
    if (STOPWORDS.has(w)) continue;
    const s = stem(w);
    if (s.length < 3 || STOPWORDS.has(s)) continue;
    seq.push({ token: s, isCardinal: false });
  }
  return seq;
}

/** Tokenise a unit of prose into a de-duplicated set of {token -> isCardinal}. */
function tokenSet(text) {
  const out = new Map();
  for (const { token, isCardinal } of tokenSeq(text)) {
    if (!out.has(token)) out.set(token, isCardinal);
  }
  return out;
}

/**
 * Order-insensitive salient content shingles of a unit: adjacent content-token
 * pairs and triples (stopwords already dropped, so "nothing is live" -> the pair
 * nothing|live). Order-insensitive so "three rejections" and "rejected … three"
 * hash alike. Returns a Set of shingle keys.
 */
function shinglesOf(seq) {
  const out = new Set();
  for (let i = 0; i + 1 < seq.length; i++) {
    const a = seq[i].token, b = seq[i + 1].token;
    if (a === b) continue;
    out.add([a, b].sort().join('␟'));
    if (i + 2 < seq.length) {
      const c = seq[i + 2].token;
      out.add([a, b, c].sort().join('␟'));
    }
  }
  return out;
}

/* ── claim-unit extraction (with line locations) ────────────────────────────── */

/**
 * Split a markdown document into CLAIM UNITS — the sentences of its running
 * prose. Excluded, because they are not restated claims: fenced code blocks,
 * markdown tables, headings, blockquotes and horizontal rules. Wrapped lines are
 * re-joined into paragraphs first so a sentence spanning a hard line-break is one
 * unit; every unit keeps the 1-based line it STARTS on.
 *
 * @returns {Array<{text:string, line:number}>}
 */
export function extractClaimUnits(input) {
  const lines = String(input ?? '').split('\n');
  const units = [];
  let inFence = false;
  let para = null; // { parts: [{text,line}] }

  const flush = () => {
    if (!para || !para.parts.length) { para = null; return; }
    // Reconstruct paragraph text and an offset->line map so each sentence gets
    // the line it actually starts on (not just the paragraph's first line).
    let text = '';
    const map = []; // { start, line }
    for (const p of para.parts) {
      map.push({ start: text.length, line: p.line });
      text += (text ? ' ' : '') + p.text;
    }
    const lineAt = (offset) => {
      let line = map[0].line;
      for (const m of map) { if (m.start <= offset) line = m.line; else break; }
      return line;
    };
    // Sentence split identical in spirit to readability.mjs (after `.!?`), plus a
    // guard that keeps "e.g."/"i.e."/decimals from splitting mid-token.
    const re = /[^.!?]+[.!?]+|\S[^.!?]*$/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const s = m[0].trim();
      if (s) units.push({ text: s, line: lineAt(m.index) });
    }
    para = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const s = rawLine.trim();
    if (/^```/.test(s)) { inFence = !inFence; flush(); continue; }
    if (inFence) continue;
    if (!s) { flush(); continue; }                         // blank -> paragraph break
    if (/^#{1,6}\s/.test(s)) { flush(); continue; }        // heading
    if (s.startsWith('>')) { flush(); continue; }          // blockquote
    if (s.startsWith('|')) { flush(); continue; }          // table row
    if (/^\|?\s*:?-{3,}:?(\s*\|\s*:?-{3,}:?)+\s*\|?$/.test(s)) { flush(); continue; } // table divider
    if (/^([-*_])\s*(\1\s*){2,}$/.test(s)) { flush(); continue; } // horizontal rule

    // A new list item (bullet or ordered) is a NEW claim, not a continuation of
    // the previous one — flush first, so adjacent metadata bullets / option
    // bullets never fuse into one compound unit that bridges unrelated claims.
    const isListItem = /^\s*([-*+]\s+|\d+\.\s+)/.test(rawLine);
    if (isListItem) flush();

    // Keep the line as prose. Strip markdown noise but preserve words + the text.
    let t = rawLine
      .replace(/`[^`]*`/g, ' ')                    // inline code
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')   // links/images -> label
      .replace(/^\s*[-*+]\s+/, '')                 // list bullet
      .replace(/^\s*\d+\.\s+/, '')                 // ordered list marker
      .replace(/[*_#>]/g, ' ')                     // emphasis / stray marks
      .replace(/\s+/g, ' ')
      .trim();
    if (!t) continue;
    if (!para) para = { parts: [] };
    para.parts.push({ text: t, line: i + 1 });
  }
  flush();
  return units;
}

/* ── idf model + weighted overlap ───────────────────────────────────────────── */

const CARDINAL_BOOST = 1.6; // a specific recurring number is a strong same-claim tell

function buildIdf(unitTokenSets) {
  const N = unitTokenSets.length;
  const df = new Map();
  for (const set of unitTokenSets) {
    for (const tok of set.keys()) df.set(tok, (df.get(tok) || 0) + 1);
  }
  const idf = new Map();
  for (const [tok, d] of df) idf.set(tok, Math.log(1 + N / d));
  return { idf, df, N };
}

function weightOf(tok, isCardinal, idf) {
  const base = idf.get(tok) || 0;
  return isCardinal ? base * CARDINAL_BOOST : base;
}

/** Weighted overlap coefficient + the shared salient content tokens between two units. */
function pairSimilarity(a, b, idf) {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let interW = 0;
  let sumSmall = 0;
  const shared = [];
  for (const [tok, isCard] of small) sumSmall += weightOf(tok, isCard, idf);
  for (const [tok, isCard] of small) {
    if (big.has(tok)) {
      const w = weightOf(tok, isCard, idf);
      interW += w;
      shared.push({ tok, w, isCardinal: isCard });
    }
  }
  const overlap = sumSmall > 0 ? interW / sumSmall : 0;
  return { overlap, interW, shared };
}

/* ── repeated-claim detection ───────────────────────────────────────────────── */

export const REPEAT_DEFAULTS = Object.freeze({
  minUnitTokens: 4,      // a unit must carry ≥4 content tokens to be a "claim"
  minClusterSize: 3,     // "stated repeatedly" = restated on ≥3 distinct lines. A claim on
                         // exactly TWO lines (a summary + its detail) is the legitimate
                         // recurrence the ticket says to leave alone.
  maxDfFraction: 0.12,   // THE precision gate, scale-free: an anchor token must appear in
                         // ≤12% of units. A TOPIC term ("wheel", "sidebar", "scroll") pervades
                         // its ticket — high document frequency — so it can never anchor; a
                         // genuine restated claim reuses DISTINCTIVE rare words ("nothing",
                         // "live", the specific count) that do not appear elsewhere. This is
                         // what separates "the same claim asserted again" from "the subject of
                         // the ticket mentioned again", independent of document size.
  shingleMinWeight: 3.4, // secondary idf floor on the phrase as a whole (belt-and-braces).
  cardinalMinLines: 5,   // a SPECIFIC count (≥3) restated on ≥this many lines is itself the
                         // ticket's own "same fact stated five times" tell, and links
                         // reshaped restatements ("three fixes"/"failed three times"/"three
                         // attempts") that share only the number. Deliberately conservative.
  mergeOverlap: 0.6,     // two anchors describe ONE claim when their unit sets overlap this
                         // much (overlap coefficient) — a BOUNDED merge on set overlap, never
                         // the transitive single-unit bridging that chains a whole document.
  strongPairOverlap: 0.6, // a MINIMUM-size (3-line) cluster must contain one near-verbatim
                          // pair (weighted overlap ≥ this) — evidence the whole proposition
                          // recurs, not just a shared topic noun. Larger clusters are exempt:
                          // repeating anything 4+ times is already the pathology.
});

/**
 * Find clusters of RESTATED claims in a document. Deterministic, no I/O.
 *
 * APPROACH (why anchors, not transitive clustering): a naive "union any two
 * similar sentences" chains a whole document into one blob through a handful of
 * shared domain terms — 98% of normal tickets light up. Instead a cluster is
 * ANCHORED by a distinctive recurring SIGNATURE and contains exactly the units
 * carrying it:
 *   - a salient content PHRASE (idf-weighted shingle) recurring on ≥3 lines, or
 *   - a SPECIFIC count (≥3) recurring on ≥cardinalMinLines lines.
 * Two anchors merge only when their unit SETS substantially overlap (same claim,
 * two signatures) — a bounded set-overlap test, never single-unit bridging. This
 * keeps a genuinely repetitive document (ARCH-003) lighting up while normal
 * tickets stay dark.
 *
 * @param {string} input  markdown document
 * @param {object} [opts] overrides for REPEAT_DEFAULTS
 * @returns {{ units:number, clusters: Array<{
 *              size:number,                 // number of occurrences (units)
 *              lines:number,                // distinct lines the claim is restated on
 *              theme:string[],              // the salient tokens characterising the claim
 *              occurrences: Array<{text:string, line:number}>
 *            }> }}
 */
export function detectRepeatedClaims(input, opts = {}) {
  const cfg = { ...REPEAT_DEFAULTS, ...opts };
  const allUnits = extractClaimUnits(input);
  const tokenSeqs = allUnits.map((u) => tokenSeq(u.text));
  const tokenSets = allUnits.map((u) => tokenSet(u.text));

  // idf is built over ALL units (so document-wide rarity is honest), but only
  // units carrying enough content tokens are eligible to anchor a claim cluster.
  // NON-CLAIM units — structured test/verification reporting, not prose assertions
  // "stated as if new". These recur by design (every ticket reports "must-FAIL
  // pre-fix", "N/N", "run <id>") and would otherwise dominate the false positives,
  // yet none appear in a decision's substantive claims. Dropped before modelling.
  const NONCLAIM_RE = /\b\d+\s*\/\s*\d+\b|\b\d+\s+(?:passed|fail(?:ed|ing)?|pass(?:ing|es)?|green|ok)\b|\bmust-?fail\b|\bpre-?fix\b|\bpost-?fix\b|\bclean-?room\b|\bnon-?vacuous\b|\bverif(?:y|ied|ication)[:\-]|\brun\s+[0-9a-f]{6,}\b|\bexit\s+\d+\b|\bwanted\s+\d|\bPASS\b|\bFAIL\b|[✓✗]/;
  const claimLike = (t) => !NONCLAIM_RE.test(t);

  const idx = [];
  for (let i = 0; i < allUnits.length; i++) {
    if (tokenSets[i].size >= cfg.minUnitTokens && claimLike(allUnits[i].text)) idx.push(i);
  }
  // idf/df computed over the CLAIM-like units only, so rarity reflects the prose
  // that can actually restate a claim (not boilerplate we already excluded).
  const { idf, df, N } = buildIdf(idx.map((i) => tokenSets[i]));
  const linesOf = (units) => new Set([...units].map((i) => allUnits[i].line));
  // Scale-free rarity gate: a token pervading the document (a topic term) is
  // never distinctive enough to anchor a restated-claim cluster.
  const rare = (tok) => (df.get(tok) || 0) <= Math.max(cfg.minClusterSize, cfg.maxDfFraction * N);

  // ── build anchors: a signature -> the set of units carrying it ──────────────
  const anchors = []; // { toks:string[], units:Set<idx> }

  // (1) salient recurring PHRASES.
  const shUnits = new Map();     // shingleKey -> Set(unitIndex)
  const shWeight = new Map();
  for (const i of idx) {
    for (const key of shinglesOf(tokenSeqs[i])) {
      let w = shWeight.get(key);
      if (w === undefined) {
        const toks = key.split('␟');
        // Every token in the phrase must be rare (not a topic term), and the
        // phrase's total idf weight must clear the floor.
        w = toks.every(rare) ? toks.reduce((a, t) => a + (idf.get(t) || 0), 0) : -1;
        shWeight.set(key, w);
      }
      if (w < cfg.shingleMinWeight) continue;
      if (!shUnits.has(key)) shUnits.set(key, new Set());
      shUnits.get(key).add(i);
    }
  }
  for (const [key, set] of shUnits) {
    if (linesOf(set).size >= cfg.minClusterSize) anchors.push({ toks: key.split('␟'), units: set });
  }

  // (2) high-recurrence specific CARDINALS (≥3; 0/1/2 double as pronouns/loose
  // quantifiers and are never a distinctive count).
  const cardUnits = new Map();
  for (const i of idx) {
    for (const [tok, isCard] of tokenSets[i]) {
      if (!isCard || Number(tok.slice(4)) < 3) continue;
      if (!cardUnits.has(tok)) cardUnits.set(tok, new Set());
      cardUnits.get(tok).add(i);
    }
  }
  for (const [tok, set] of cardUnits) {
    if (rare(tok) && linesOf(set).size >= cfg.cardinalMinLines) anchors.push({ toks: [tok], units: set });
  }

  // ── merge anchors by BOUNDED unit-set overlap (never single-unit bridging) ──
  const parent = anchors.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let a = 0; a < anchors.length; a++) {
    for (let b = a + 1; b < anchors.length; b++) {
      const A = anchors[a].units, B = anchors[b].units;
      let inter = 0;
      const [small, big] = A.size <= B.size ? [A, B] : [B, A];
      for (const u of small) if (big.has(u)) inter++;
      const oc = inter / Math.max(1, Math.min(A.size, B.size));
      if (oc >= cfg.mergeOverlap) parent[find(a)] = find(b);
    }
  }

  const groups = new Map();
  for (let a = 0; a < anchors.length; a++) {
    const r = find(a);
    if (!groups.has(r)) groups.set(r, { units: new Set(), toks: new Set() });
    const g = groups.get(r);
    for (const u of anchors[a].units) g.units.add(u);
    for (const t of anchors[a].toks) g.toks.add(t);
  }

  const clusters = [];
  for (const g of groups.values()) {
    const members = [...g.units].sort((x, y) => x - y);
    const lines = linesOf(g.units);
    if (lines.size < cfg.minClusterSize) continue;
    // A cluster must show at least one near-verbatim pair — otherwise it is held
    // together only by a shared anchor (a 2-word TOPIC noun, a methodology
    // phrase) that recurs benignly in any single-subject ticket. A genuinely
    // restated claim has ≥2 members whose whole proposition overlaps; weakly
    // attached members (sharing only the anchor) then ride along legitimately.
    {
      let strong = false;
      for (let a = 0; a < members.length && !strong; a++) {
        for (let b = a + 1; b < members.length; b++) {
          if (pairSimilarity(tokenSets[members[a]], tokenSets[members[b]], idf).overlap >= cfg.strongPairOverlap) { strong = true; break; }
        }
      }
      if (!strong) continue;
    }
    // Theme = the anchor tokens plus the salient content tokens shared by the
    // most member units, ranked by idf; readable + distinctive.
    const freq = new Map();
    for (const i of members) for (const tok of tokenSets[i].keys()) freq.set(tok, (freq.get(tok) || 0) + 1);
    const theme = [...new Set([
      ...g.toks,
      ...[...freq.keys()]
        .filter((t) => freq.get(t) >= Math.max(2, Math.ceil(members.length / 2)))
        .sort((x, y) => (idf.get(y) || 0) - (idf.get(x) || 0)),
    ])].slice(0, 6);
    clusters.push({
      size: members.length,
      lines: lines.size,
      theme,
      occurrences: members.map((i) => ({ text: allUnits[i].text, line: allUnits[i].line })),
    });
  }

  // Most-restated (by distinct lines, then occurrences) first.
  clusters.sort((a, b) => b.lines - a.lines || b.size - a.size);
  return { units: allUnits.length, clusters };
}

/* ── ordering: justification-after-decision ─────────────────────────────────── */

const DECISION_RE = /\brecommend(?:ation|ed|s)?\b\s*[:—-]?/i;
const JUSTIFY_RE = /\b(because|since it|so it|the only (?:option|one|way)|which is why|the reason|rationale|removes the guessing|fixes (?:both|the problem)|is why this)\b/i;

/**
 * Conservative ordering check: does the justification for a recommendation appear
 * ONLY after the decision it supports? Silent unless the structure is clear:
 *   - there is exactly one identifiable "Recommendation:" style decision line,
 *   - no justifying sentence appears at or before it,
 *   - at least one justifying sentence appears after it.
 * Ambiguous shapes (no clear recommendation line, or justification already before
 * the decision) report nothing — a false alarm here is worse than a miss.
 *
 * @returns {{ issue: null | {decisionLine:number, decisionText:string,
 *             firstJustificationLine:number, justificationText:string} }}
 */
export function detectOrderingIssues(input) {
  const units = extractClaimUnits(input);
  const decisions = units.filter((u) => DECISION_RE.test(u.text));
  if (decisions.length !== 1) return { issue: null }; // ambiguous -> say nothing
  const decision = decisions[0];

  // A justification that is PART OF the recommendation sentence itself counts as
  // "before/at" the decision — the reader meets it in the same breath.
  const inlineJustified = JUSTIFY_RE.test(decision.text.replace(DECISION_RE, ' '));
  if (inlineJustified) return { issue: null };

  const justifications = units.filter((u) => JUSTIFY_RE.test(u.text));
  const before = justifications.filter((u) => u.line <= decision.line);
  const after = justifications.filter((u) => u.line > decision.line);
  if (before.length > 0) return { issue: null };   // reader already met a reason
  if (after.length === 0) return { issue: null };  // no justification anywhere clear

  return {
    issue: {
      decisionLine: decision.line,
      decisionText: decision.text,
      firstJustificationLine: after[0].line,
      justificationText: after[0].text,
    },
  };
}

/* ── convenience: a single structural report ────────────────────────────────── */

/**
 * Run both structural checks and return a combined, display-ready report.
 * Pure; callers decide whether to advise/block on it.
 */
export function analyzeStructure(input, opts = {}) {
  const repeats = detectRepeatedClaims(input, opts);
  const ordering = detectOrderingIssues(input);
  return {
    units: repeats.units,
    repeatedClaims: repeats.clusters,
    ordering: ordering.issue,
  };
}
