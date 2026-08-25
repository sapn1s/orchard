#!/usr/bin/env node
/**
 * FEAT-088 — STRUCTURAL readability (repetition + ordering) verification.
 *
 *   npm run verify:feat-088
 *
 * On REAL data (the committed ARCH-003, its de-duplicated twin, and the live
 * ticket corpus). No live session, no server, no network — the Layer 2 model
 * pass is exercised only through its --print-prompt seam.
 *
 * MUST-FAIL, BOTH DIRECTIONS (the core of the ticket):
 *   - the repetition detector on ARCH-003 AS COMMITTED surfaces the two known
 *     clusters with EVERY enumerated occurrence (five "three fixes", three
 *     "nothing is live"),
 *   - on the SAME document with those repetitions removed, both clusters are
 *     gone (reports clean).
 * Assertions are on the CLUSTERS returned, never on printed text.
 *
 * INVARIANT: the sentence-level checks (FEAT-085) behave IDENTICALLY on both
 * versions — they passed the un-readable ticket before and still do; that is the
 * whole reason this structural layer exists.
 *
 * FALSE POSITIVES: named clean control tickets stay dark, and the corpus-wide
 * flag rate is reported and bounded (a regression that lit up everything fails).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectRepeatedClaims, detectOrderingIssues, analyzeStructure } from './lib/structure.mjs';
import { evaluateReadability } from './lib/readability.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'feat-088');
const REVIEW = path.join(HERE, 'structure-review.mjs');
const BUGS = path.join(HERE, '..', 'docs', 'bugs');
const read = (p) => fs.readFileSync(p, 'utf8');
const committed = read(path.join(FIX, 'ARCH-003-committed.md'));
const cleaned = read(path.join(FIX, 'ARCH-003-cleaned.md'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
}

/** The cluster whose occurrences cover ALL of `lines` (a claim restated on them). */
function clusterCovering(clusters, lines) {
  return clusters.find((c) => {
    const set = new Set(c.occurrences.map((o) => o.line));
    return lines.every((l) => set.has(l));
  }) || null;
}

console.log('=== FEAT-088 structural readability ===');

/* ── 1. MUST-FAIL direction A: committed ARCH-003 surfaces both clusters ─────── */
console.log('\n-- committed ARCH-003: the two known clusters MUST surface --');
{
  const { clusters } = detectRepeatedClaims(committed);
  // "three fixes / three rejections": header (4), situation (16), option A cost
  // (36), "How we got here" opener (59), closing "six … three attempts" (72).
  const threeFixes = [4, 16, 36, 59, 72];
  const c1 = clusterCovering(clusters, threeFixes);
  check('three-fixes cluster present with ALL 5 enumerated occurrences', !!c1,
    { found: clusters.map((c) => c.occurrences.map((o) => o.line)) });
  if (c1) check('three-fixes cluster is themed on the count + the fix/attempt claim',
    c1.theme.includes('num:3') && c1.theme.some((t) => t === 'fix' || t === 'attempt'), c1.theme);

  // "nothing is live / not deployed until a restart": 54, 151, 164.
  const nothingLive = [54, 151, 164];
  const c2 = clusterCovering(clusters, nothingLive);
  check('nothing-is-live cluster present with ALL 3 enumerated occurrences', !!c2,
    { found: clusters.map((c) => c.occurrences.map((o) => o.line)) });
  if (c2) check('nothing-is-live cluster is themed on live/nothing', c2.theme.includes('live') && c2.theme.includes('noth'), c2.theme);

  check('the two required clusters are DISTINCT (not merged into one blob)', c1 && c2 && c1 !== c2);
}

/* ── 2. MUST-FAIL direction B: cleaned ARCH-003 reports clean ────────────────── */
console.log('\n-- de-duplicated ARCH-003: both known clusters MUST be gone --');
{
  const { clusters } = detectRepeatedClaims(cleaned);
  check('cleaned: NO cluster covers the three-fixes lines (16 & 59)', !clusterCovering(clusters, [16, 59]),
    clusters.map((c) => c.occurrences.map((o) => o.line)));
  check('cleaned: NO cluster covers the nothing-is-live lines (54 & 164)', !clusterCovering(clusters, [54, 164]));
  check('cleaned: no cluster carries the num:3+fix theme', !clusters.some((c) => c.theme.includes('num:3') && c.theme.includes('fix')));
  check('cleaned: no cluster carries the live/nothing theme', !clusters.some((c) => c.theme.includes('live') && c.theme.includes('noth')));
  check('cleaned: reports fully clean (0 clusters)', clusters.length === 0, clusters.map((c) => c.theme));
}

/* ── 3. INVARIANT: sentence-level checks identical on both versions ──────────── */
console.log('\n-- sentence-level readability behaves identically on both versions --');
{
  const ec = evaluateReadability(committed);
  const ek = evaluateReadability(cleaned);
  check('committed: sentence-level PASSES (no violations) — the gate that missed it', !ec.tooShort && ec.violations.length === 0,
    { tooShort: ec.tooShort, violations: ec.violations.map((v) => v.metric) });
  check('cleaned:   sentence-level PASSES (no violations)', !ek.tooShort && ek.violations.length === 0,
    { tooShort: ek.tooShort, violations: ek.violations.map((v) => v.metric) });
  check('same sentence-level verdict on both (structural layer is what differs)',
    ec.tooShort === ek.tooShort && ec.violations.length === ek.violations.length);
}

/* ── 4. FALSE POSITIVES: clean controls stay dark; corpus rate bounded ───────── */
console.log('\n-- false positives on real tickets --');
{
  // Named, well-scoped, single-defect bug tickets that carry no restated claim.
  for (const f of ['BUG-032-sidebar-scroll-wheel.md', 'BUG-025-needs-you-card-lacks-question.md', 'BUG-030-stale-agent-tool-cards-after-host-cut.md']) {
    const { clusters } = detectRepeatedClaims(read(path.join(BUGS, f)));
    check(`clean control ${f} reports NO cluster`, clusters.length === 0, clusters.map((c) => c.theme));
  }
  // Corpus-wide rate — informational, with a loose regression bound. Most flags
  // are GENUINE near-verbatim repeats; a rate near 100% would mean chaining is
  // back.
  const files = fs.readdirSync(BUGS).filter((f) => f.endsWith('.md') && f !== 'INDEX.md' && !f.startsWith('ARCH-003'));
  let flagged = 0;
  for (const f of files) if (detectRepeatedClaims(read(path.join(BUGS, f))).clusters.length) flagged++;
  const rate = flagged / files.length;
  console.log(`      corpus: ${flagged}/${files.length} tickets carry ≥1 restated-claim cluster (${(100 * rate).toFixed(1)}%)`);
  check('corpus flag rate is bounded (<60% — no runaway transitive chaining)', rate < 0.6, +(rate).toFixed(3));
}

/* ── 5. ORDERING: fires only when the justification is clearly after ─────────── */
console.log('\n-- ordering: justification-after-decision (conservative) --');
{
  const pos = '# T\n## Decision\n**Recommendation: do B.**\n## Why\nB is the only option that removes the guessing, because it uses ground truth.\n';
  const neg = '# T\n## Why\nB removes the guessing because it uses ground truth.\n## Decision\n**Recommendation: do B**, since it uses what actually happened.\n';
  const amb = '# T\nWe recommend B here.\nWe also recommend C there.\nBecause it works.\n';
  check('ordering FIRES when justification is only after the recommendation', !!detectOrderingIssues(pos).issue);
  check('ordering SILENT when justification precedes/accompanies the recommendation', !detectOrderingIssues(neg).issue);
  check('ordering SILENT when the structure is ambiguous (multiple recommendations)', !detectOrderingIssues(amb).issue);
}

/* ── 6. LAYER 2 scaffold: prompt shape + reviewer≠author, no dispatch ────────── */
console.log('\n-- Layer 2 model-review scaffold (prompt seam; no network) --');
{
  const r = spawnSync('node', [REVIEW, path.join(FIX, 'ARCH-003-committed.md'), '--author-provider', 'anthropic', '--print-prompt'],
    { encoding: 'utf8', timeout: 15000 });
  const out = r.stdout || '';
  check('--print-prompt exits 0 without dispatching', r.status === 0);
  check('prompt carries all FIVE review steps', /1\. SENTENCE NECESSITY/.test(out) && /2\. REPETITION/.test(out) && /3\. ORDERING/.test(out) && /4\. OPTION COLLAPSE/.test(out) && /5\. IRREDUCIBLE CORE/.test(out));
  check('prompt states the reviewer did NOT write the text (generation must not verify itself)', /did NOT write this text/i.test(out));
  check('prompt folds in the Layer-1 mechanical pre-pass', /MECHANICAL PRE-PASS/.test(out) && /restated-claim cluster/.test(out));

  // Reviewer defaults CROSS-provider (author anthropic -> reviewer openai); a
  // same-provider request warns that a self-review shares the blind spot.
  const same = spawnSync('node', [REVIEW, path.join(FIX, 'ARCH-003-committed.md'), '--author-provider', 'openai', '--provider', 'openai', '--print-prompt'],
    { encoding: 'utf8', timeout: 15000 });
  check('same-provider reviewer emits the shared-blind-spot WARNING', /WARNING.*blind spot/i.test(same.stderr || ''));

  // analyzeStructure() is the single reusable seam (module, hook, board).
  const s = analyzeStructure(committed);
  check('analyzeStructure() exposes repeatedClaims + ordering for reuse', Array.isArray(s.repeatedClaims) && 'ordering' in s);
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
