/**
 * provenance-check.mjs — §6.1 of docs/analysis/ticket-board-redesign-plan.md.
 * Step 3 of §8: the migration's acceptance check, landed and proven to fail
 * correctly BEFORE anything is migrated.
 *
 * THE LINE THIS DRAWS, and why it is drawn this narrow.
 * -----------------------------------------------------
 * CONTENT — summaries, impact, option prose, diagnosis — is a transformation
 * whose loss is visible to the next reader, and any reader acting on a ticket
 * re-verifies against the code anyway. It is graded by a human on a sample
 * (§6.2) and by the model's own `source.confirmation` / `source.dropped`.
 * Nothing here scores prose.
 *
 * PROVENANCE is different, and for exactly one reason: **if a dispatch run id
 * is dropped or altered, no future reader can notice.** The original will be
 * archived and nobody re-reads it, the run id is not re-derivable from
 * anything, and the verdict it anchors is what this project's method rests on.
 * That, and only that, is worth a check.
 *
 * So this is presence-and-equality only. No prose diffing, no thresholds, no
 * scoring, no judgement about wording. It tests the pipeline's COPY PATHS, not
 * the model's writing.
 *
 * Usage:
 *   node scripts/provenance-check.mjs --baseline [--dir=docs/bugs] [--out=FILE]
 *       Extract the provenance set from every ticket in the CURRENT corpus and
 *       report what is at stake. Establishes the baseline before any migration.
 *
 *   node scripts/provenance-check.mjs --original=A.md --migrated=B.md
 *       Grade one migrated ticket against its original. Exit 0 = clean.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { VERIFIED_BY_RE, joinVerdictContinuation } from './lib/verdict-contract.mjs';
import { TICKET_FILE_RE, countActivityEntries, extractTicketBlock } from './lib/ticket-schema.mjs';

/* ───────────────────────────────────────────────────────────── extraction */

/**
 * The `Verified-by:` line's PARSED form. verdict-contract.mjs's
 * `parseVerifiedBy` returns only the FIRST match; migration needs every one,
 * with its verdict, so this walks the same expression line by line. The
 * expression itself is imported, not re-written, so the round-trip contract
 * ("formatVerifiedBy stays the single formatter, the extractor is its inverse")
 * holds by construction.
 */
export function extractVerifications(text) {
  const out = [];
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = new RegExp(VERIFIED_BY_RE.source, 'i').exec(lines[i]);
    if (!m) continue;
    // The MIRROR half of the same fix: a wrapped verdict was read here as
    // `none`, so a ticket carrying one wrapped and one unwrapped copy of the
    // same run id made this checker report `verdict changed none → holds` and
    // quarantine a ticket that says one consistent thing (`FEAT-062`).
    const verdict = /VERDICT:\s*([A-Z]+)/i.exec(joinVerdictContinuation(lines, i));
    out.push({
      provider: m[1],
      model: m[2] ?? null,
      run_id: m[3],
      verdict: verdict ? verdict[1].toLowerCase() : null,
    });
  }
  return out;
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/**
 * A commit sha, conservatively. 7–40 lowercase hex, in backticks or preceded by
 * a word this project uses when it means a commit. Bare hex runs are NOT
 * harvested: a ticket's prose is full of counts, ids and hashes, and a check
 * that demands every incidental hex string survive would fail on every ticket
 * and therefore be turned off — which is worse than not having it.
 */
const SHA_RE = /(?:`([0-9a-f]{7,40})`|\b(?:commit|sha|at|in tree at|HEAD)\s+([0-9a-f]{7,40})\b)/gi;
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
const TICKET_REF_RE = /\b(?:ARCH|BUG|FEAT|DEPLOY)-\d+\b/g;

const uniq = (xs) => [...new Set(xs)];

/** Everything a future reader could not re-derive, extracted from one ticket. */
export function provenanceOf(text) {
  const s = String(text || '');
  const shas = [];
  for (const m of s.matchAll(SHA_RE)) {
    const hex = m[1] ?? m[2];
    // A pure-decimal run is a number, not a sha.
    if (hex && /[a-f]/i.test(hex)) shas.push(hex.toLowerCase());
  }
  return {
    verifications: extractVerifications(s),
    runIds: uniq(s.match(UUID_RE)?.map((x) => x.toLowerCase()) ?? []),
    shas: uniq(shas),
    ticketRefs: uniq(s.match(TICKET_REF_RE) ?? []),
    dates: uniq(s.match(ISO_DATE_RE) ?? []),
    activityEntries: countActivityEntries(s),
  };
}

/** The `## Activity log` section of a ticket, verbatim, or null if it has none. */
export function activityLogOf(text) {
  const s = String(text || '');
  const i = s.indexOf('## Activity log');
  return i === -1 ? null : s.slice(i);
}

/** Parse a migrated file's orchard-ticket block, or null. Never throws. */
function parseBlockSafely(text) {
  const block = extractTicketBlock(text).block;
  if (block === null) return null;
  try { const r = JSON.parse(block); return r && typeof r === 'object' && !Array.isArray(r) ? r : null; } catch { return null; }
}

/**
 * Where the migrated file stops containing the original log. Reported as an
 * OFFSET rather than a diff, because the log can be 150 KB and the useful
 * answer is "it was cut here", not a wall of text.
 */
function firstDivergence(haystack, needle) {
  let lo = 0, hi = needle.length;
  if (!haystack.includes(needle.slice(0, 1))) return 0;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (haystack.includes(needle.slice(0, mid))) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/* ─────────────────────────────────────────────────────────────── the check */

/**
 * Grade a migrated ticket against its original.
 *
 * `migratedText` is the WHOLE new file (JSON block + body) because the
 * assertion is "this value still appears SOMEWHERE in the ticket" — which field
 * it landed in is the schema validator's business, not provenance's.
 *
 * Returns `{ ok, violations[], counts }`. Never throws.
 */
export function provenanceCheck(originalText, migratedText, opts = {}) {
  const where = opts.id ? `${opts.id}: ` : '';
  const violations = [];
  const bad = (m) => violations.push(where + m);

  const orig = provenanceOf(originalText);
  const mig = provenanceOf(migratedText);
  const migAll = String(migratedText || '');

  // GUARD AGAINST VACUOUS SUCCESS. An empty (or truncated-to-nothing) migrated
  // file trivially satisfies "no value was contradicted", so emptiness is
  // checked FIRST and explicitly. §6.1's must-FAIL case (B).
  if (migAll.trim().length === 0) {
    bad('the migrated file is EMPTY — a check that passes on empty input is worse than no check');
    return { ok: false, violations, counts: { ...countsOf(orig), migratedBytes: 0 } };
  }
  if (originalText != null && migAll.length < String(originalText).length * 0.02 && String(originalText).length > 2000) {
    bad(`the migrated file is ${migAll.length} bytes against an original of ${String(originalText).length} — implausibly small for a copied activity log`);
  }

  // 1. Verification records: provider, run_id and verdict must all survive.
  //    This is the one class whose loss is undetectable later.
  //
  //    Read from BOTH sides of the migrated file: the verbatim-copied
  //    `Verified-by:` lines AND the structured `verification[]` array in the
  //    JSON block. Reading only the copied lines was a real hole — the model
  //    authors `verification[]`, so a WRONG verdict there would have passed
  //    while the correct one sat untouched in the log. A structured entry that
  //    CONTRADICTS the line it was derived from is now its own violation.
  const migBlock = parseBlockSafely(migAll);
  const structured = Array.isArray(migBlock?.verification) ? migBlock.verification : [];
  const migByRun = new Map(mig.verifications.map((v) => [v.run_id, v]));
  for (const e of structured) {
    if (e && typeof e === 'object' && typeof e.run_id === 'string' && !migByRun.has(e.run_id)) migByRun.set(e.run_id, e);
  }
  const origByRun = new Map(orig.verifications.map((v) => [v.run_id, v]));
  for (const e of structured) {
    if (!e || typeof e !== 'object' || typeof e.run_id !== 'string') continue;
    const src = origByRun.get(e.run_id);
    if (!src) continue;
    if (src.provider && e.provider && e.provider !== src.provider) {
      bad(`verification[] entry for run ${e.run_id} claims provider ${JSON.stringify(e.provider)}, but the original's Verified-by line says ${JSON.stringify(src.provider)}`);
    }
    if (src.verdict && e.verdict && String(e.verdict).toLowerCase() !== src.verdict) {
      bad(`verification[] entry for run ${e.run_id} claims verdict ${JSON.stringify(e.verdict)}, but the original's Verified-by line says ${JSON.stringify(src.verdict)}`);
    }
  }
  for (const v of orig.verifications) {
    const got = migByRun.get(v.run_id);
    if (!got) { bad(`verification record for run ${v.run_id} (provider ${v.provider}, verdict ${v.verdict ?? 'none'}) is MISSING from the migrated ticket`); continue; }
    if (got.provider !== v.provider) bad(`verification ${v.run_id}: provider changed ${v.provider} → ${got.provider}`);
    if ((got.verdict ?? null) !== (v.verdict ?? null)) bad(`verification ${v.run_id}: verdict changed ${v.verdict ?? 'none'} → ${got.verdict ?? 'none'}`);
  }

  // 2–6. Presence assertions. Each value must appear SOMEWHERE in the new file.
  const presence = [
    ['run id', orig.runIds, (x) => migAll.toLowerCase().includes(x)],
    ['commit sha', orig.shas, (x) => migAll.toLowerCase().includes(x)],
    ['ticket cross-reference', orig.ticketRefs, (x) => migAll.includes(x)],
    ['ISO date', orig.dates, (x) => migAll.includes(x)],
  ];
  for (const [label, values, present] of presence) {
    const lost = values.filter((v) => !present(v));
    for (const v of lost.slice(0, 20)) bad(`${label} ${JSON.stringify(v)} from the original does not appear in the migrated ticket`);
    if (lost.length > 20) bad(`… and ${lost.length - 20} further ${label}s`);
  }

  // 7. The activity log. §5.2 says it is copied BYTE-FOR-BYTE and the model
  //    never sees it, so the strongest possible assertion is also the cheapest:
  //    the original's log section must appear as a literal substring of the
  //    migrated file. The entry COUNT is kept as well, because it names the
  //    failure usefully when the substring test fails.
  if (mig.activityEntries !== orig.activityEntries) {
    bad(`activity log has ${mig.activityEntries} \`### <date> —\` entries, original has ${orig.activityEntries} — the log is copied verbatim, so these must be equal`);
  }
  const origLog = activityLogOf(originalText);
  if (origLog !== null && !migAll.includes(origLog)) {
    // Narrow the report to WHERE it diverges — a "the log differs" line on a
    // 150 KB section is useless to whoever has to fix it.
    const at = firstDivergence(migAll, origLog);
    bad(`the \`## Activity log\` section is NOT copied byte-for-byte (${origLog.length} bytes in the original${at === null ? '' : `; first divergence near original offset ${at}: ${JSON.stringify(origLog.slice(Math.max(0, at - 40), at + 40))}`})`);
  }

  // 8. The live decision's option keys, when the migrated ticket has a block.
  const block = extractTicketBlock(migAll).block;
  if (block) {
    let rec = null;
    try { rec = JSON.parse(block); } catch { /* the schema validator reports this */ }
    const keys = rec?.decision?.options?.map((o) => o?.key).filter((k) => typeof k === 'string') ?? [];
    const origKeys = opts.expectedOptionKeys ?? null;
    if (origKeys) {
      const missingKeys = origKeys.filter((k) => !keys.includes(k));
      if (missingKeys.length) bad(`live decision is missing option key(s) ${JSON.stringify(missingKeys)} — original offered ${JSON.stringify(origKeys)}`);
      if (keys.length !== origKeys.length) bad(`live decision has ${keys.length} options, original had ${origKeys.length}`);
    }
  }

  return { ok: violations.length === 0, violations, counts: { ...countsOf(orig), migratedBytes: migAll.length } };
}

function countsOf(p) {
  return {
    verifications: p.verifications.length,
    runIds: p.runIds.length,
    shas: p.shas.length,
    ticketRefs: p.ticketRefs.length,
    dates: p.dates.length,
    activityEntries: p.activityEntries,
  };
}

/* ─────────────────────────────────────────────────────────────────── CLI */

function baseline(dir, outFile) {
  const rows = [];
  const totals = { verifications: 0, runIds: 0, shas: 0, ticketRefs: 0, dates: 0, activityEntries: 0 };
  for (const file of fs.readdirSync(dir).sort()) {
    if (!TICKET_FILE_RE.test(file)) continue;
    const p = provenanceOf(fs.readFileSync(path.join(dir, file), 'utf8'));
    const c = countsOf(p);
    for (const k of Object.keys(totals)) totals[k] += c[k];
    rows.push({ file, ...c, verificationRunIds: p.verifications.map((v) => v.run_id) });
  }
  console.log(`provenance baseline over ${rows.length} tickets in ${dir}`);
  for (const [k, v] of Object.entries(totals)) console.log(`  ${k.padEnd(18)} ${v}`);
  const withVerdicts = rows.filter((r) => r.verifications > 0).length;
  console.log(`  tickets carrying at least one Verified-by record: ${withVerdicts}`);
  console.log(`  tickets carrying at least one UUID run id:        ${rows.filter((r) => r.runIds > 0).length}`);
  if (outFile) {
    fs.writeFileSync(outFile, JSON.stringify({ dir, generated: new Date().toISOString().slice(0, 10), totals, rows }, null, 2));
    console.log(`wrote ${outFile}`);
  }
  return rows.length > 0 ? 0 : 1;
}

const isMain = process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) ?? `--${n}=${d}`).slice(n.length + 3);
  if (process.argv.includes('--baseline')) {
    process.exit(baseline(arg('dir', 'docs/bugs'), process.argv.some((a) => a.startsWith('--out=')) ? arg('out', '') : null));
  }
  const originalPath = arg('original', '');
  const migratedPath = arg('migrated', '');
  if (!originalPath || !migratedPath) {
    console.error('usage: provenance-check.mjs --baseline [--dir=…] [--out=…]\n       provenance-check.mjs --original=A.md --migrated=B.md');
    process.exit(2);
  }
  const res = provenanceCheck(
    fs.readFileSync(originalPath, 'utf8'),
    fs.existsSync(migratedPath) ? fs.readFileSync(migratedPath, 'utf8') : '',
    { id: path.basename(migratedPath) },
  );
  for (const v of res.violations) console.log(`  VIOLATION  ${v}`);
  console.log(res.ok ? 'PROVENANCE OK' : `PROVENANCE FAILED — ${res.violations.length} violation(s)`);
  process.exit(res.ok ? 0 : 1);
}
