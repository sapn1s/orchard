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
  return {
    v: 2,
    ts: new Date().toISOString(),
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
