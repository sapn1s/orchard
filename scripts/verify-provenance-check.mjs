/**
 * verify-provenance-check.mjs — step 3 of
 * docs/analysis/ticket-board-redesign-plan.md §8, and §6.1's two mandatory
 * must-FAIL cases.
 *
 * §6.1 is explicit that the check must be shown to FAIL before it is trusted,
 * "because a check that passes on empty input is worse than none":
 *
 *   (A) mangle one character of one run id → the check must REJECT.
 *   (B) hand it an empty migrated file → it must FAIL rather than pass vacuously.
 *
 * Everything here runs against REAL tickets from docs/bugs/, not invented ones.
 * The "migrated" side is built by the transformation the plan actually
 * specifies (§5.2): the head becomes a JSON block carrying the deterministically
 * extracted provenance, and the `## Activity log` is copied BYTE-FOR-BYTE. So a
 * pass means the check accepts the shape the pipeline will really produce, and
 * each failure case is a real value really going missing.
 *
 * Run: node scripts/verify-provenance-check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { provenanceCheck, provenanceOf, extractVerifications } from './provenance-check.mjs';
import { TICKET_FILE_RE } from './lib/ticket-schema.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const BUGS = path.join(repoRoot, 'docs', 'bugs');

let pass = 0;
const failures = [];
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`PASS: ${label}`); }
  else { failures.push(label); console.log(`FAIL: ${label}${detail ? ` — ${String(detail).slice(0, 400)}` : ''}`); }
}

/* ────────────────────────────────── the real corpus, and the real fixtures */

const corpus = fs.readdirSync(BUGS).filter((f) => TICKET_FILE_RE.test(f)).sort()
  .map((file) => ({ file, text: fs.readFileSync(path.join(BUGS, file), 'utf8') }));
check(`read the real corpus (${corpus.length} tickets)`, corpus.length >= 150, corpus.length);

/**
 * Simulate the pipeline's migration of ONE real ticket, per §5.2: the activity
 * log is copied verbatim; everything the model would author is replaced by a
 * JSON block that carries the deterministically extracted provenance.
 *
 * This is deliberately NOT a hand-written "expected output" — it is the real
 * ticket's own bytes, rearranged the way the pipeline rearranges them.
 */
function migrate(text) {
  const i = text.indexOf('## Activity log');
  const head = i === -1 ? text : text.slice(0, i);
  const log = i === -1 ? '' : text.slice(i);
  const p = provenanceOf(text);
  const block = {
    id: (/^#\s+(\S+)/.exec(text) ?? [, 'BUG-000'])[1],
    // Everything the model does not author, carried across as data.
    related: p.ticketRefs.map((id) => ({ id, relation: 'see_also' })),
    verification: p.verifications,
    run_ids: p.runIds,
    commits: p.shas,
    dates: p.dates,
    // A one-line stand-in for the human layer the model would write. The
    // provenance check must NOT care what this says.
    summary: 'A short human summary would go here.',
    original_head_bytes: head.length,
  };
  return '```orchard-ticket\n' + JSON.stringify(block, null, 2) + '\n```\n\n# migrated\n\n' + log;
}

// Pick the richest real tickets — the ones with the most at stake.
const scored = corpus.map((t) => ({ ...t, p: provenanceOf(t.text) }))
  .sort((a, b) => (b.p.verifications.length * 100 + b.p.runIds.length * 10 + b.p.activityEntries)
                 - (a.p.verifications.length * 100 + a.p.runIds.length * 10 + a.p.activityEntries));
const rich = scored[0];
const withVerdict = scored.find((t) => t.p.verifications.some((v) => v.verdict));
check('the corpus contains a ticket carrying a real Verified-by run id + verdict', !!withVerdict,
  withVerdict && withVerdict.file);
console.log(`  richest ticket: ${rich.file} — ${rich.p.verifications.length} verifications, ${rich.p.runIds.length} run ids, ${rich.p.shas.length} shas, ${rich.p.ticketRefs.length} refs, ${rich.p.activityEntries} activity entries`);
if (withVerdict) console.log(`  verdict-bearing ticket: ${withVerdict.file} — runs ${withVerdict.p.verifications.map((v) => `${v.run_id}:${v.verdict}`).join(', ')}`);

/* ───────────────────────────────── positive control: a faithful migration */

let cleanCount = 0;
const dirty = [];
for (const t of corpus) {
  const res = provenanceCheck(t.text, migrate(t.text), { id: t.file });
  if (res.ok) cleanCount++; else dirty.push(`${t.file}: ${res.violations.slice(0, 2).join(' ; ')}`);
}
check(`a faithful migration of EVERY real ticket passes (${cleanCount}/${corpus.length})`,
  dirty.length === 0, dirty.slice(0, 5).join('  ///  '));

/* ───────────────────────────── (A) must-FAIL: one mangled run-id character */

const runTickets = corpus.filter((t) => provenanceOf(t.text).runIds.length > 0);
check(`the corpus has tickets carrying UUID run ids to mangle (${runTickets.length})`, runTickets.length > 0);

let aDetected = 0;
const aMissed = [];
for (const t of runTickets) {
  const runId = provenanceOf(t.text).runIds[0];
  // Flip ONE character. Not a deletion, not a truncation — the subtlest
  // possible corruption, and the one no future reader could ever notice.
  const flipped = runId.slice(0, -1) + (runId.slice(-1) === 'a' ? 'b' : 'a');
  const mangled = migrate(t.text).split(runId).join(flipped);
  const res = provenanceCheck(t.text, mangled, { id: t.file });
  const namesIt = res.violations.some((v) => v.includes(runId));
  if (!res.ok && namesIt) aDetected++; else aMissed.push(`${t.file} (${runId})`);
}
check(`(A) MUST-FAIL: mangling ONE character of a run id is rejected, and the check NAMES the lost id — on all ${runTickets.length} real tickets that carry one`,
  aMissed.length === 0, aMissed.slice(0, 5).join(', '));

// The same corruption on a Verified-by record must be caught as a MISSING
// VERIFICATION RECORD, not merely as a missing hex string.
if (withVerdict) {
  const v = withVerdict.p.verifications[0];
  const flipped = v.run_id.slice(0, -1) + (v.run_id.slice(-1) === 'a' ? 'b' : 'a');
  const res = provenanceCheck(withVerdict.text, migrate(withVerdict.text).split(v.run_id).join(flipped), { id: withVerdict.file });
  check('(A) a mangled Verified-by run id is reported as a MISSING verification record, not just a missing string',
    !res.ok && res.violations.some((x) => /verification record for run/.test(x) && x.includes(v.run_id)),
    res.violations.join(' | '));

  // A silently CHANGED verdict is the other undetectable-later corruption.
  if (v.verdict) {
    const other = v.verdict === 'holds' ? 'BROKEN' : 'HOLDS';
    const swapped = migrate(withVerdict.text).replace(`"verdict": ${JSON.stringify(v.verdict)}`, `"verdict": ${JSON.stringify(other.toLowerCase())}`);
    const res2 = provenanceCheck(withVerdict.text, swapped, { id: withVerdict.file });
    // The structured `verification[]` array is what the MODEL authors, so a
    // verdict flipped there — while the verbatim log still carries the truth —
    // is the realistic corruption. It was NOT caught until the check learned to
    // read both sides and report the contradiction.
    check('(A) a VERDICT flipped in the structured verification[] is rejected as a contradiction of the copied Verified-by line',
      !res2.ok && res2.violations.some((x) => /verdict changed|claims verdict .* but the original's Verified-by line says/.test(x)),
      res2.violations.join(' | '));
  }
}

/* ────────────────────────────── (B) must-FAIL: the empty migrated file */

const bTarget = rich;
const empties = [['', 'empty string'], ['   \n\n\t\n  ', 'whitespace only'], ['\n', 'a single newline']];
const bMissed = [];
for (const [migrated, label] of empties) {
  const res = provenanceCheck(bTarget.text, migrated, { id: bTarget.file });
  const namesEmptiness = res.violations.some((v) => /EMPTY/.test(v));
  if (!(res.ok === false && namesEmptiness)) bMissed.push(`${label}: ok=${res.ok} violations=${res.violations.join('|')}`);
}
check('(B) MUST-FAIL: an empty migrated file FAILS, and says so explicitly rather than passing vacuously',
  bMissed.length === 0, bMissed.join(' ; '));

// The near-miss of (B): a file that is not empty but has lost the log.
const headOnly = '```orchard-ticket\n{"id":"X"}\n```\n\n# migrated\n\nnothing else survived.\n';
const resHead = provenanceCheck(bTarget.text, headOnly, { id: bTarget.file });
check('(B) a NON-empty but gutted migrated file also fails (emptiness is not the only guard)',
  !resHead.ok && resHead.violations.length > 1, resHead.violations.length);

/* ────────────────────────── the other §6.1 classes, each proven to bite */

const CLASSES = [
  ['a dropped commit sha', (t, m) => { const sha = provenanceOf(t).shas[0]; return sha ? m.split(sha).join('deadbee') : null; }, /commit sha .* does not appear/],
  ['a dropped ticket cross-reference', (t, m) => { const r = provenanceOf(t).ticketRefs[0]; return r ? m.split(r).join('BUG-000') : null; }, /ticket cross-reference .* does not appear/],
  ['a dropped ISO date', (t, m) => { const d = provenanceOf(t).dates[0]; return d ? m.split(d).join('1999-01-01') : null; }, /ISO date .* does not appear/],
  ['a truncated activity log', (t, m) => m.replace(/### \d{4}-\d{2}-\d{2} —/, '### (removed)'), /activity log has \d+ .* entries, original has \d+/],
];
for (const [label, corrupt, re] of CLASSES) {
  const t = rich;
  const migrated = corrupt(t.text, migrate(t.text));
  if (migrated === null) { check(`${label}: fixture available`, false, 'no such value in the richest ticket'); continue; }
  const res = provenanceCheck(t.text, migrated, { id: t.file });
  check(`${label} is rejected with a named violation`, !res.ok && res.violations.some((v) => re.test(v)),
    res.violations.slice(0, 3).join(' | ') || 'NO VIOLATIONS');
}

/* ────────────────────── it must NOT reject on things it is not judging */

const proseChanged = migrate(rich.text).replace('A short human summary would go here.', 'Something entirely different, written badly, in the wrong voice.');
check('rewritten PROSE is not a provenance violation (this check grades copy paths, never content)',
  provenanceCheck(rich.text, proseChanged, { id: rich.file }).ok);

/* ───────────────── truncation: the migrated file caught part-written */

const full = migrate(rich.text);
const truncPoints = [1, 5, 25, 50, 75, 90, 99].map((pct) => Math.floor(full.length * pct / 100));
const truncMissed = [];
for (const at of truncPoints) {
  const res = provenanceCheck(rich.text, full.slice(0, at), { id: rich.file });
  // A partially-written migration must never grade CLEAN — the whole point of
  // an all-or-nothing promotion gate (§5.6) is that a half-written file is a
  // reject, not a pass.
  if (res.ok) truncMissed.push(`${at} bytes graded clean`);
  let threw = false;
  try { provenanceCheck(rich.text, full.slice(0, at), { id: rich.file }); } catch { threw = true; }
  if (threw) truncMissed.push(`${at} bytes threw`);
}
check(`a migrated file TRUNCATED at ${truncPoints.length} points is rejected at every one, and never throws`,
  truncMissed.length === 0, truncMissed.join(' ; '));

/* ───────────────────── the extractor is the inverse of the formatter */

const line = '- **Verified-by:** dispatch openai/gpt-5.6-sol run 0f8c1d2e-3a4b-5c6d-7e8f-9a0b1c2d3e4f (clean-room, `scripts/independent-verify.mjs`) — VERDICT: HOLDS';
const parsed = extractVerifications(line);
check('extractVerifications is the inverse of formatVerifiedBy for a canonical line',
  parsed.length === 1 && parsed[0].provider === 'openai' && parsed[0].model === 'gpt-5.6-sol'
  && parsed[0].run_id === '0f8c1d2e-3a4b-5c6d-7e8f-9a0b1c2d3e4f' && parsed[0].verdict === 'holds',
  JSON.stringify(parsed));
check('extractVerifications finds EVERY record, not only the first (verdict-contract parseVerifiedBy returns one)',
  extractVerifications(`${line}\n${line.replace('0f8c', '1a2b').replace('HOLDS', 'BROKEN')}`).length === 2);

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  FAILED: ${f}`); process.exit(1); }
process.exit(0);
