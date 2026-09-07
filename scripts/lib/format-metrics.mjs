#!/usr/bin/env node
/**
 * FEAT-091 — durable response-format metrics: the record side, and the reader
 * that turns those records into "which block are we missing?".
 *
 * WHY THIS IS THE LOAD-BEARING PART. The vocabulary is a fixed set of SEMANTIC
 * categories, and the design says the fallback firing is a SIGNAL TO ADD A
 * CATEGORY. That is only true if the record answers "what KIND of thing keeps
 * landing there", not "how much" — so this file captures the author's own label
 * on every declared `orchard-uncategorized` block, plus the shape and a readable
 * excerpt, and clusters the labels in the report.
 *
 * ── TWO FALLBACKS, NEVER ADDED TOGETHER
 *   declared  — an `orchard-uncategorized` block. The author reached for the
 *               vocabulary and found nothing that fit. This is a VOCABULARY gap:
 *               read the labels, name the missing category, add it.
 *   loose     — prose outside every block. The author did not categorise. This is
 *               a COMPLIANCE gap and calls for the opposite response.
 * Summing them would make both unreadable, so they are separate fields, separate
 * report sections, and separate decision rules.
 *
 * ── WHERE, AND WHY THERE
 * `<dataDir>/logs/response-format-metrics.jsonl`, one JSON object per graded
 * turn. Outside the repo, next to the existing stop-hook advisory log, for the
 * same reason: it is per-machine telemetry, not source, and it must never appear
 * in a commit or an exported tree (BUG-104).
 *
 * ── EVERY GRADED TURN IS RECORDED, not just the ones that fail.
 * Without the compliant turns there is no denominator, and "fallback is rising"
 * is unanswerable. A turn where everything landed inside blocks writes a line
 * too — it is just a small one.
 *
 * ── CONTENT CAPTURE POLICY (this writes reply text to local disk)
 *   - structured message (has blocks) + fallback  -> excerpt KEPT. This is the
 *     signal: the author reached for the format and still had something that did
 *     not fit. Reading these is how a new block gets named.
 *   - unstructured message (no blocks at all)     -> characterisation kept,
 *     excerpt truncated hard. These are expected (short replies need no
 *     ceremony), so they must not dominate the file or the disk.
 *   - per-line and per-file caps, plus one-generation rotation, so a long-running
 *     machine cannot be filled by telemetry.
 *
 * ── SAFETY: nothing here may affect a turn. Every export swallows its own
 * errors and returns a status instead of throwing. The Stop hook calls
 * `recordTurn` inside its own try/catch as a second belt.
 *
 * CLI:  node scripts/lib/format-metrics.mjs report [--file PATH] [--json]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/* ── caps ───────────────────────────────────────────────────────────────────── */

const MAX_RUNS_PER_TURN = 12;      // beyond this, count only (a pathological message)
const MAX_LINE_BYTES = 24 * 1024;  // one turn's record
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const UNSTRUCTURED_EXCERPT = 240;  // expected case: characterise, do not archive

/* FEAT-125 length budget, read back as measurement ceilings (FEAT-127). */
const DEFAULT_WORD_CEILING = 120;  // default per-turn prose budget
const HANDOFF_WORD_CEILING = 250;  // the higher budget for a handoff / pending decision

/* ── paths ──────────────────────────────────────────────────────────────────── */

/** dataDir() mirror — same resolution the Stop hook uses; no server-graph import. */
export function dataDir() {
  const env = process.env.CLAUDE_STATION_DATA;
  if (env && env.trim()) return path.resolve(env);
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.trim() ? path.resolve(xdg) : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'claude-station');
}

export function metricsPath(dir) {
  return path.join(dir ?? dataDir(), 'logs', 'response-format-metrics.jsonl');
}

/* ── prose-volume metric (FEAT-127) ──────────────────────────────────────────
 * FEAT-125 gave the length budget as INJECTED ADVICE; discipline has failed the
 * user twice, so the two failure modes are now MEASURED per graded turn:
 *   - proseWords : the words a reader actually reads — every category block's
 *                  body plus loose prose — EXCLUDING the `orchard-digest` JSON and
 *                  the fence wrappers themselves (block bodies already have their
 *                  fences stripped by the parser; the digest block is skipped).
 *   - askBlocks  : how many `orchard-ask` blocks the turn handed over. A turn with
 *                  more than one ask, or an ask over a decision that was not the
 *                  user's, is the second failure mode this ticket exists to watch.
 * ADVISORY BY NATURE: this records numbers, it does not truncate or block. The
 * Stop hook already cannot cost a turn (advisory), and neither can this — it is a
 * lens on the transcript, not a gate.
 *
 * The word rule matches characterise() EXACTLY (`[A-Za-z][A-Za-z'-]*`), so a
 * block body and a loose run are counted the same way and proseWords is the sum
 * of comparable units. */
const WORD_RE = /[A-Za-z][A-Za-z'-]*/g;
function wordCount(s) {
  return (String(s ?? '').match(WORD_RE) || []).length;
}

/**
 * Prose words a reader reads this turn, and the number of asks. Pure; derived
 * from the parseResponseBlocks() result so it needs no transcript re-read.
 * Digest JSON and fence wrappers are excluded (see the note above).
 */
export function proseVolume(parsed) {
  const blocks = Array.isArray(parsed?.blocks) ? parsed.blocks : [];
  let words = 0;
  for (const b of blocks) {
    if (!b || b.name === 'orchard-digest') continue; // JSON, not prose
    words += wordCount(b.content);
  }
  const runs = Array.isArray(parsed?.fallbackRuns) ? parsed.fallbackRuns : [];
  for (const r of runs) words += typeof r?.words === 'number' ? r.words : wordCount(r?.text);
  const askBlocks = Number(parsed?.counts?.['orchard-ask'] || 0);
  return { proseWords: words, askBlocks };
}

/**
 * Which length budget applies this turn, and whether the reply is over it
 * (FEAT-138 — the ENFORCED form of the FEAT-125 length budget).
 *   - default : ≤120 words of prose.
 *   - handoff : ≤250 words when the turn carries a PENDING DECISION — i.e. an
 *               `orchard-ask`. This is the only "handoff" the Stop hook can grade:
 *               a lane→orchestrator handoff is a sidechain the hook never sees, so
 *               on the main thread the ask turn IS the pending-decision turn.
 * Pure; derived from the same parseResponseBlocks() result as proseVolume().
 */
export function evaluateLength(parsed) {
  const { proseWords, askBlocks } = proseVolume(parsed);
  const ceiling = askBlocks > 0 ? HANDOFF_WORD_CEILING : DEFAULT_WORD_CEILING;
  return { proseWords, askBlocks, ceiling, over: proseWords > ceiling };
}

/* ── ask-ownership gate (FEAT-137) ────────────────────────────────────────────
 * The MECHANICAL form of WA §A's ownership test. Every `orchard-ask` must declare,
 * in its own body, a CONFIDENCE and a DECIDER — the user-held thing that makes the
 * call theirs (taste, priority, spend, risk appetite, project direction). The
 * defect this catches is the one the user hit verbatim ("there is a breaking bug
 * which will corrupt data … not sure if u want to fix it tho, so i will leave it"):
 * a HIGH-confidence ask that names no user-held decider is not the user's decision
 * at all — it is the author's, and should have been decided, not handed over.
 *
 * HONEST LIMITATION, stated where the code is: this is a PRESENCE/well-formedness
 * check, not a truth check. It verifies the ask carries a recognised `confidence:`
 * level and a non-empty `decider:` line; it CANNOT verify the named decider is
 * genuinely user-held (a model can type `decider: taste` over a pure sequencing
 * choice). It catches the missing or unnameable declaration — the shape the user
 * actually hit — and the report surfaces the rest for a human to read. */
const CONFIDENCE_RE = /^[ \t>*+-]*confidence[ \t]*:[ \t]*(high|hi|med(?:ium)?|low|lo)\b/im;
const DECIDER_RE = /^[ \t>*+-]*decider[ \t]*:[ \t]*(\S.*)$/im;

/** Normalise a declared confidence token to high|med|low, or '' when absent. */
function confidenceLevel(content) {
  const m = CONFIDENCE_RE.exec(String(content ?? ''));
  if (!m) return '';
  const t = m[1].toLowerCase();
  if (t === 'high' || t === 'hi') return 'high';
  if (t === 'low' || t === 'lo') return 'low';
  return 'med';
}

/**
 * Ownership defects across every `orchard-ask` block in a parsed reply. Pure.
 * One entry per offending ask: `{ confidence, hasDecider, defect }`, where defect is
 *   'missing-confidence'          — no recognised `confidence:` line at all.
 *   'high-confidence-no-decider'  — the CORE defect: confident AND no user-held decider.
 *   'missing-decider'             — a `decider:` line is absent (med/low confidence).
 * A well-formed ask (a confidence AND a decider) contributes nothing.
 */
export function askOwnershipDefects(parsed) {
  const blocks = Array.isArray(parsed?.blocks) ? parsed.blocks : [];
  const out = [];
  for (const b of blocks) {
    if (!b || b.name !== 'orchard-ask') continue;
    const content = String(b.content ?? '');
    const confidence = confidenceLevel(content);
    const hasDecider = DECIDER_RE.test(content);
    if (!confidence) { out.push({ confidence: '', hasDecider, defect: 'missing-confidence' }); continue; }
    if (!hasDecider) {
      out.push({ confidence, hasDecider, defect: confidence === 'high' ? 'high-confidence-no-decider' : 'missing-decider' });
    }
  }
  return out;
}

/* ── record ─────────────────────────────────────────────────────────────────── */

/**
 * Build the JSONL record for one graded turn from a parseResponseBlocks() result.
 * Pure — split out from the write so it is testable without touching a disk.
 */
export function buildRecord(parsed, meta = {}) {
  const structured = parsed?.shape === 'structured';
  const runs = Array.isArray(parsed?.fallbackRuns) ? parsed.fallbackRuns : [];
  const kept = runs.slice(0, MAX_RUNS_PER_TURN).map((r) => ({
    position: r.position,
    chars: r.chars,
    lines: r.lines,
    words: r.words,
    tags: r.tags,
    // The archive: full excerpt when the author was using the format, a short
    // characterising snippet when they legitimately were not.
    excerpt: structured ? r.excerpt : String(r.excerpt ?? '').slice(0, UNSTRUCTURED_EXCERPT),
  }));
  // The DECLARED fallback, with the author's label kept verbatim — the label is
  // the only part of this record that can name a new category, so it is never
  // truncated away by the excerpt caps below.
  const declared = (Array.isArray(parsed?.declaredUncategorized) ? parsed.declaredUncategorized : [])
    .slice(0, MAX_RUNS_PER_TURN)
    .map((d) => ({
      label: typeof d.label === 'string' ? d.label.slice(0, 160) : '',
      chars: d.chars,
      lines: d.lines,
      words: d.words,
      tags: d.tags,
      excerpt: d.excerpt,
    }));
  const volume = proseVolume(parsed);
  const len = evaluateLength(parsed);
  const ownership = askOwnershipDefects(parsed);
  return {
    v: 2,
    ts: new Date().toISOString(),
    proseWords: volume.proseWords,
    askBlocks: volume.askBlocks,
    // FEAT-137/138 enforcement telemetry: was this turn over its length budget,
    // and how many asks were unowned (so the report shows whether enforcement is
    // biting and how often, not just whether the checks exist).
    lengthCeiling: len.ceiling,
    overLengthBudget: len.over,
    asksMissingConfidence: ownership.filter((d) => d.defect === 'missing-confidence').length,
    asksHighNoDecider: ownership.filter((d) => d.defect === 'high-confidence-no-decider').length,
    asksMissingDecider: ownership.filter((d) => d.defect === 'missing-decider').length,
    session_id: typeof meta.session_id === 'string' ? meta.session_id : null,
    cwd: typeof meta.cwd === 'string' ? meta.cwd : null,
    shape: parsed?.shape ?? 'unstructured',
    totalChars: parsed?.totalChars ?? 0,
    blockChars: parsed?.blockChars ?? 0,
    fallbackChars: parsed?.fallbackChars ?? 0,
    counts: parsed?.counts ?? {},
    unknownBlocks: (parsed?.unknownBlocks ?? []).map((u) => u.name),
    malformed: parsed?.malformed ?? [],
    fallbackRuns: kept,
    fallbackRunsTotal: runs.length,
    declaredUncategorized: declared,
    declaredUncategorizedTotal: (parsed?.declaredUncategorized ?? []).length,
  };
}

/** Rotate one generation when the file gets large. Best-effort, never throws. */
function rotateIfLarge(file) {
  try {
    const st = fs.statSync(file);
    if (st.size < MAX_FILE_BYTES) return;
    fs.renameSync(file, `${file}.1`);
  } catch { /* missing file or a rename race: nothing to rotate */ }
}

/**
 * Append one turn's metrics. Returns `{ ok, file, reason? }`; NEVER throws, so a
 * full disk or a read-only data dir cannot cost the user a turn.
 */
export function recordTurn(parsed, meta = {}) {
  const file = meta.file ?? metricsPath(meta.dataDir);
  try {
    const rec = buildRecord(parsed, meta);
    let line = JSON.stringify(rec);
    if (line.length > MAX_LINE_BYTES) {
      // Drop the excerpts before dropping the record: the counts and tags are the
      // part we cannot reconstruct later, the prose is recoverable from the
      // transcript itself.
      rec.fallbackRuns = rec.fallbackRuns.map((r) => ({ ...r, excerpt: String(r.excerpt).slice(0, 200) }));
      rec.declaredUncategorized = rec.declaredUncategorized.map((d) => ({ ...d, excerpt: String(d.excerpt).slice(0, 200) }));
      rec.truncated = true;
      line = JSON.stringify(rec);
      if (line.length > MAX_LINE_BYTES) {
        // Labels survive even here: they are what a human reads to name the next
        // category, and they are two orders of magnitude smaller than the prose.
        rec.fallbackRuns = [];
        rec.declaredUncategorized = rec.declaredUncategorized.map((d) => ({ label: d.label, chars: d.chars, tags: d.tags }));
        line = JSON.stringify(rec);
      }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateIfLarge(file);
    fs.appendFileSync(file, line + '\n');
    return { ok: true, file };
  } catch (err) {
    return { ok: false, file, reason: err?.message ?? String(err) };
  }
}

/* ── read ───────────────────────────────────────────────────────────────────── */

/**
 * Aggregate the JSONL into the decision surface described in the FEAT-091
 * ticket. Tolerates a partially-written last line (the hook appends while a
 * reader may be running) — an unparseable line is skipped, never fatal.
 */
export function summariseMetrics(file = metricsPath()) {
  const out = {
    file,
    turns: 0,
    skippedLines: 0,
    structured: 0,
    unstructured: 0,
    blockCounts: {},
    unknownBlockCounts: {},
    malformedCounts: {},
    fallbackCharsTotal: 0,
    blockCharsTotal: 0,
    // The headline ratio: of the turns where the author DID use the format, how
    // much of the message still landed outside it.
    structuredFallbackChars: 0,
    structuredTotalChars: 0,
    runsByPosition: {},
    tagCounts: {},
    /* The DECLARED fallback — kept entirely separate from loose prose above. */
    declaredTurns: 0,
    declaredBlocks: 0,
    declaredChars: 0,
    declaredUnlabelled: 0,
    /** The author's own words for what did not fit, clustered. This is the list
     *  a human reads to decide which category the vocabulary is missing. */
    declaredLabelCounts: {},
    declaredTagCounts: {},
    declaredSamples: [],
    /** Co-occurring tag signatures, most frequent first — the "what shape is it" view. */
    signatures: {},
    samples: [],
    /* ── PROSE VOLUME & ASKS (FEAT-127) — the two failure modes, measured.
     * proseWords per turn is collected so the report can give mean/median and
     * count turns over each ceiling; asks are the second axis. Advisory. */
    proseWordSamples: [],
    proseWordsMax: 0,
    overDefaultCeiling: 0,   // > 120 words (the FEAT-125 default budget)
    overHandoffCeiling: 0,   // > 250 words (the handoff/decision budget)
    asksTotal: 0,
    turnsWithAsk: 0,         // >= 1 orchard-ask
    turnsWithMultipleAsks: 0, // >= 2 orchard-ask in one turn
    biggestProseTurns: [],   // {ts, proseWords, askBlocks}
    /* ── ENFORCEMENT (FEAT-137/138) — how often the two gates would/did bite.
     * These count turns whose LAST-message record carries the enforcement fields
     * (older records simply do not contribute). */
    enforcedTurns: 0,        // turns recorded since the enforcement fields existed
    overLengthTurns: 0,      // turns over their applicable length ceiling
    asksMissingConfidence: 0,
    asksHighNoDecider: 0,    // the core ownership defect
    asksMissingDecider: 0,
  };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return out; }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { out.skippedLines++; continue; }
    if (!rec || typeof rec !== 'object') { out.skippedLines++; continue; }
    out.turns++;
    if (rec.shape === 'structured') out.structured++; else out.unstructured++;

    // PROSE VOLUME & ASKS (FEAT-127). Older records (before this field existed)
    // simply do not contribute — proseWords is absent, not zero, so it is skipped.
    if (typeof rec.proseWords === 'number') {
      out.proseWordSamples.push(rec.proseWords);
      if (rec.proseWords > out.proseWordsMax) out.proseWordsMax = rec.proseWords;
      if (rec.proseWords > DEFAULT_WORD_CEILING) out.overDefaultCeiling++;
      if (rec.proseWords > HANDOFF_WORD_CEILING) out.overHandoffCeiling++;
      out.biggestProseTurns.push({ ts: rec.ts, proseWords: rec.proseWords, askBlocks: Number(rec.askBlocks || 0) });
    }
    const asks = Number(rec.askBlocks || rec.counts?.['orchard-ask'] || 0);
    out.asksTotal += asks;
    if (asks >= 1) out.turnsWithAsk++;
    if (asks >= 2) out.turnsWithMultipleAsks++;

    // ENFORCEMENT telemetry (FEAT-137/138). `overLengthBudget` is the marker that
    // a record predates or postdates the enforcement fields.
    if (typeof rec.overLengthBudget === 'boolean') {
      out.enforcedTurns++;
      if (rec.overLengthBudget) out.overLengthTurns++;
    }
    out.asksMissingConfidence += Number(rec.asksMissingConfidence || 0);
    out.asksHighNoDecider += Number(rec.asksHighNoDecider || 0);
    out.asksMissingDecider += Number(rec.asksMissingDecider || 0);
    out.fallbackCharsTotal += rec.fallbackChars || 0;
    out.blockCharsTotal += rec.blockChars || 0;
    if (rec.shape === 'structured') {
      out.structuredFallbackChars += rec.fallbackChars || 0;
      out.structuredTotalChars += rec.totalChars || 0;
    }
    for (const [k, v] of Object.entries(rec.counts || {})) out.blockCounts[k] = (out.blockCounts[k] || 0) + (v || 0);
    for (const n of rec.unknownBlocks || []) out.unknownBlockCounts[n] = (out.unknownBlockCounts[n] || 0) + 1;
    for (const m of rec.malformed || []) {
      const kind = String(m).split(':')[0];
      out.malformedCounts[kind] = (out.malformedCounts[kind] || 0) + 1;
    }
    const decl = Array.isArray(rec.declaredUncategorized) ? rec.declaredUncategorized : [];
    if (decl.length) out.declaredTurns++;
    for (const d of decl) {
      out.declaredBlocks++;
      out.declaredChars += d.chars || 0;
      const label = String(d.label || '').trim();
      if (!label) out.declaredUnlabelled++;
      // Cluster case-insensitively: "Copy-paste artifact" and "copy-paste
      // artifact" are the same evidence and must not read as two shapes.
      const key = label ? label.toLowerCase() : '(no label — a defect: the signal is lost)';
      out.declaredLabelCounts[key] = (out.declaredLabelCounts[key] || 0) + 1;
      for (const t of Array.isArray(d.tags) ? d.tags : []) out.declaredTagCounts[t] = (out.declaredTagCounts[t] || 0) + 1;
      out.declaredSamples.push({ ts: rec.ts, label, chars: d.chars, tags: d.tags || [], excerpt: d.excerpt });
    }
    for (const run of rec.fallbackRuns || []) {
      out.runsByPosition[run.position] = (out.runsByPosition[run.position] || 0) + 1;
      const tags = Array.isArray(run.tags) ? run.tags : [];
      for (const t of tags) out.tagCounts[t] = (out.tagCounts[t] || 0) + 1;
      const sig = tags.slice().sort().join('+') || '(none)';
      out.signatures[sig] = (out.signatures[sig] || 0) + 1;
      // Keep the biggest structured-message runs: the most expensive uncategorized
      // content is the best evidence for what a new block would be for.
      if (rec.shape === 'structured') {
        out.samples.push({ ts: rec.ts, chars: run.chars, position: run.position, tags, excerpt: run.excerpt });
      }
    }
  }
  out.samples.sort((a, b) => b.chars - a.chars);
  out.samples = out.samples.slice(0, 20);
  out.declaredSamples.sort((a, b) => b.chars - a.chars);
  out.declaredSamples = out.declaredSamples.slice(0, 20);
  out.fallbackShareStructured = out.structuredTotalChars
    ? out.structuredFallbackChars / out.structuredTotalChars
    : 0;

  // Prose-volume summary stats (FEAT-127).
  const pv = out.proseWordSamples.slice().sort((a, b) => a - b);
  out.proseWordsTurns = pv.length;
  out.proseWordsMean = pv.length ? pv.reduce((n, x) => n + x, 0) / pv.length : 0;
  out.proseWordsMedian = pv.length ? pv[Math.floor((pv.length - 1) / 2)] : 0;
  out.asksPerTurn = out.turns ? out.asksTotal / out.turns : 0;
  out.biggestProseTurns.sort((a, b) => b.proseWords - a.proseWords);
  out.biggestProseTurns = out.biggestProseTurns.slice(0, 5);
  return out;
}

/** Human-readable report — what a person runs to decide whether to add a block. */
export function formatReport(s) {
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  const top = (obj, n = 8) =>
    Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([k, v]) => `      ${String(v).padStart(5)}  ${k}`).join('\n') || '      (none)';
  const lines = [
    `response-format metrics — ${s.file}`,
    `  turns graded          : ${s.turns}  (structured ${s.structured} / unstructured ${s.unstructured}, ${s.skippedLines} unreadable lines)`,
    `  fallback share        : ${pct(s.fallbackShareStructured)} of characters in STRUCTURED messages landed outside every block`,
    `  chars                 : blocks ${s.blockCharsTotal}, fallback ${s.fallbackCharsTotal}`,
    '  blocks used (by category):',
    top(s.blockCounts, 12),
    '',
    '  PROSE VOLUME & ASKS (FEAT-127 measured; FEAT-137/138 ENFORCED) — the two failure modes.',
    '  The measurements below are the lens FEAT-127 added; the ENFORCEMENT block after them',
    '  says how often the Stop hook is now asking for a revision (FEAT-125 length budget and',
    '  the WA §A ask-ownership rule are no longer advice-only on the main thread).',
    `    prose words/turn       : mean ${s.proseWordsMean.toFixed(0)}, median ${s.proseWordsMedian}, max ${s.proseWordsMax}  (over ${s.proseWordsTurns} turns with the field)`,
    `    over ${DEFAULT_WORD_CEILING}-word budget    : ${s.overDefaultCeiling} turns${s.proseWordsTurns ? ` (${pct(s.overDefaultCeiling / s.proseWordsTurns)})` : ''}`,
    `    over ${HANDOFF_WORD_CEILING}-word handoff cap: ${s.overHandoffCeiling} turns${s.proseWordsTurns ? ` (${pct(s.overHandoffCeiling / s.proseWordsTurns)})` : ''}`,
    `    orchard-ask blocks     : ${s.asksTotal} total, ${s.asksPerTurn.toFixed(2)} per turn; ${s.turnsWithAsk} turns had an ask, ${s.turnsWithMultipleAsks} had MORE THAN ONE`,
    '    biggest prose turns (words / asks):',
    (s.biggestProseTurns.length
      ? s.biggestProseTurns.map((t) => `      ${String(t.proseWords).padStart(5)}w  ${t.askBlocks} ask  ${t.ts}`).join('\n')
      : '      (none)'),
    '',
    '  ENFORCEMENT (FEAT-137/138) — turns the Stop hook would ask to revise, over the',
    `  ${s.enforcedTurns} turns recorded since enforcement shipped:`,
    `    over the length budget : ${s.overLengthTurns} turns${s.enforcedTurns ? ` (${pct(s.overLengthTurns / s.enforcedTurns)})` : ''}  (blocked once for a tighter re-send)`,
    `    unowned asks           : ${s.asksHighNoDecider} high-confidence with NO decider (the core defect), ${s.asksMissingDecider} other missing-decider, ${s.asksMissingConfidence} missing-confidence`,
    '',
    '  DECLARED UNCATEGORIZED — the author reached for the vocabulary and nothing fit.',
    '  This is the signal the design exists to produce: a repeated label here NAMES',
    '  the category that is missing.',
    `    blocks ${s.declaredBlocks} across ${s.declaredTurns} turns, ${s.declaredChars} chars, ${s.declaredUnlabelled} with NO label`,
    '    what the author called it:',
    top(s.declaredLabelCounts, 12),
    '    shape tags of that content:',
    top(s.declaredTagCounts, 10),
    '',
    '  LOOSE PROSE — content left outside every block. A different problem: the',
    '  author did not categorise, so there is nothing to read but the shape.',
    '  fallback runs by position:',
    top(s.runsByPosition),
    '  fallback tag frequency:',
    top(s.tagCounts, 12),
    '  fallback tag SIGNATURES (co-occurring shape — a dominant one names the missing block):',
    top(s.signatures, 10),
    '  unknown orchard-* names seen:',
    top(s.unknownBlockCounts),
    '  malformed:',
    top(s.malformedCounts),
    '',
    '  DECIDE — two different decisions, from two different numbers:',
    '   * ADD A CATEGORY when one label (or one obvious family of labels) accounts',
    '     for a third or more of the declared uncategorized blocks over >= 50 graded',
    '     turns. The label is the proposed name. Read the samples below first.',
    '   * FIX COMPLIANCE (not the vocabulary) when loose-prose share in structured',
    '     messages stays above 15% while declared uncategorized stays near zero:',
    '     that is content nobody tried to categorise, and a new name will not help.',
    '',
    '  largest DECLARED uncategorized blocks:',
  ];
  for (const sm of s.declaredSamples.slice(0, 5)) {
    lines.push(`    - ${sm.chars} chars, label: ${sm.label || '(none)'} [${(sm.tags || []).join(', ')}]`);
    lines.push(String(sm.excerpt).split('\n').map((l) => `        | ${l}`).join('\n'));
  }
  if (!s.declaredSamples.length) lines.push('    (none)');
  lines.push('', '  largest LOOSE prose runs from structured messages:');
  for (const sm of s.samples.slice(0, 5)) {
    lines.push(`    - ${sm.chars} chars, ${sm.position}, [${sm.tags.join(', ')}]`);
    lines.push(String(sm.excerpt).split('\n').map((l) => `        | ${l}`).join('\n'));
  }
  if (!s.samples.length) lines.push('    (none)');
  return lines.join('\n');
}

/* ── CLI ────────────────────────────────────────────────────────────────────── */

const invokedDirectly = (() => {
  try { return path.resolve(process.argv[1] ?? '') === path.resolve(new URL(import.meta.url).pathname); }
  catch { return false; }
})();

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');
  const file = fileIdx >= 0 ? args[fileIdx + 1] : metricsPath();
  const s = summariseMetrics(file);
  process.stdout.write(args.includes('--json') ? JSON.stringify(s, null, 2) + '\n' : formatReport(s) + '\n');
}
