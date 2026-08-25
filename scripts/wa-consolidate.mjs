#!/usr/bin/env node
/**
 * FEAT-019 — Living-doc self-maintenance, the CONSOLIDATE half (the over-accumulate guard).
 *
 * 2026-08-05 redesign (user decision): consolidation is an AUTOMATIC system, not an
 * approval-gated ceremony. The methodology repo is git, so every pass is recoverable
 * (§D) — pre-approval of SAFE mechanical classes was ceremony. The contract now:
 *
 *   AUTO-APPLIED with `--apply` (safe classes — deterministic, content-preserving):
 *     (a) RELOCATE a whole rule section that is UNAMBIGUOUSLY project-specific
 *         (≥2 blocks, EVERY block project-specific in its normative clause with
 *         ≥2 distinct markers — see the BUG-042 classifier below) into the
 *         owning project's docs/CONVENTIONS.md
 *         (create/append, never overwrite; a pointer stub keeps the §letter
 *         resolvable). Applied relocations name every moved rule in CHANGELOG.md
 *         AND surface as a `relocation-applied` finding on the needs-human rail,
 *         so a human reviews them after the fact.
 *     (b) MERGE near-duplicate rule sections (keep the richer wording; unique
 *         content from the poorer section moves into the richer one);
 *     (c) mechanical cleanup (trailing whitespace, collapsed blank runs).
 *   NEVER auto-applied ("needs human" — surfaced in the report + CHANGELOG):
 *     - genuine CONTRADICTIONS (two rules whose resolution changes behavior);
 *     - ANY partial relocation — a single project-flavored block inside an
 *       otherwise-universal section (BUG-042: "is this rule universal?" is a
 *       judgment call; a wrong relocation silently weakens every future
 *       session's instructions, so per §N the bar is raised);
 *     - moderate-overlap section pairs (merge is a judgment call);
 *     - rules-without-why (adding the why is judgment, not mechanics).
 *
 *   BUG-042 classifier: a project marker ANYWHERE in a block used to mean
 *   "project-specific", which relocated UNIVERSAL rules that merely cite a
 *   product as an EXAMPLE (the "separate process, not a subagent" incident —
 *   it contained the word "Orchard"). Now a block is project-specific only if a
 *   NON-ILLUSTRATIVE marker (not parenthetical, not after e.g./for example/
 *   such as/like) appears in the block's FIRST sentence — the normative clause,
 *   per WA house style — or if ≥2 DISTINCT non-illustrative markers appear.
 *   A block tagged `universal:` is never relocated or flagged (protected marker).
 *
 *   Each apply pass makes ONE git commit in the methodology repo (plus, if the WA
 *   had uncommitted captures, one prior snapshot commit so the pre-consolidation
 *   state is itself recoverable) and appends a human-skimmable entry to
 *   $METHODOLOGY_DIR/CHANGELOG.md. Rollback is one `git revert`. After applying,
 *   the canonical->mirror sync runs so docs/prompts stays current.
 *
 * Without `--apply` the tool keeps its original propose-only behavior: scan, write
 * a reviewable proposal artifact, never touch the WA.
 *
 * Honors METHODOLOGY_DIR (default ~/projects/methodology).
 *
 * Usage:
 *   node scripts/wa-consolidate.mjs [--apply] [options]
 *     --apply                 Auto-apply the safe classes (relocate/merge/cleanup),
 *                             commit in the methodology repo, append CHANGELOG.md,
 *                             then sync the mirror. Requires the methodology dir to
 *                             be a git repo (the recoverability contract).
 *     --conventions-dir <dir> Owning project for relocated rules (its
 *                             docs/CONVENTIONS.md is appended). Default: this repo.
 *     --file <basename>       WA file to scan (default WORKING_AGREEMENT.v2.md).
 *     --out <path>            Proposal artifact path (propose mode only; default
 *                             $METHODOLOGY_DIR/CONSOLIDATION-PROPOSAL.md).
 *     --no-sync               (--apply) skip the canonical->mirror sync step.
 *     --stdout                (propose mode) also print the proposal to stdout.
 *
 * Exit codes:
 *   propose mode: 0 proposal written (≥1 tension), 2 usage/IO error, 4 no tensions.
 *   apply mode:   0 success (applied, or honest no-op), 2 usage/IO/git error.
 *   --check-routing (standalone): 0 fresh/missing/unparseable (honest warning, never a
 *                   crash), 1 stale (>90d since the researched date in ROUTING.md).
 *
 * FEAT-043 Phase R staleness trigger: both apply and propose passes ALSO check the
 * canonical ROUTING.md's staleness header (researched date). Missing/unparseable is a
 * console warning only (boot-tolerance, FEAT-019); older than 90 days is surfaced as a
 * NEEDS-HUMAN item on the same report/changelog/console surface as every other
 * needs-human finding here — this script never edits ROUTING.md and never re-researches.
 */
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const METHODOLOGY_DIR =
  process.env.METHODOLOGY_DIR || path.join(os.homedir(), 'projects', 'methodology');

function parseArgs(argv) {
  const out = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stdout' || a === '--apply' || a === '--no-sync' || a === '--check-routing' || a === '--check-arch' || a === '--no-arch')
      out.flags.add(a);
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}
function die(msg, code = 2) {
  console.error(`wa-consolidate: ${msg}`);
  process.exit(code);
}

/**
 * FEAT-043 staleness trigger: parse the "researched YYYY-MM-DD" date out of the
 * canonical ROUTING.md's STALENESS header and compare against ROUTING_STALE_DAYS.
 * Never throws — every failure mode (repo/file absent, unreadable, unparseable
 * header/date) returns an honest status instead (boot-tolerance, FEAT-019 contract).
 */
const ROUTING_STALE_DAYS = 90;
function checkRoutingStaleness() {
  const routingPath = path.join(METHODOLOGY_DIR, 'ROUTING.md');
  let raw;
  try {
    raw = fs.readFileSync(routingPath, 'utf8');
  } catch (err) {
    return {
      status: 'missing',
      message: `ROUTING.md not found (or unreadable) at ${routingPath} — skipping staleness check (${err.code || err.message}).`,
    };
  }
  const m = raw.match(/STALENESS:\*\*\s*researched\s+(\d{4}-\d{2}-\d{2})/i);
  if (!m) {
    return {
      status: 'unparseable',
      message: `ROUTING.md staleness header missing or unparseable (expected "researched YYYY-MM-DD") — cannot verify freshness.`,
    };
  }
  const researched = new Date(`${m[1]}T00:00:00Z`);
  if (Number.isNaN(researched.getTime())) {
    return { status: 'unparseable', message: `ROUTING.md staleness date "${m[1]}" did not parse as a valid date.` };
  }
  const ageDays = Math.floor((Date.now() - researched.getTime()) / 86400000);
  if (ageDays > ROUTING_STALE_DAYS) {
    return {
      status: 'stale',
      ageDays,
      researched: m[1],
      message:
        `routing table stale — re-run FEAT-043 Phase R research (ROUTING.md researched ${m[1]}, ` +
        `${ageDays}d ago, > ${ROUTING_STALE_DAYS}d staleness bar).`,
    };
  }
  return {
    status: 'fresh',
    ageDays,
    researched: m[1],
    message: `ROUTING.md fresh (researched ${m[1]}, ${ageDays}d old, ≤ ${ROUTING_STALE_DAYS}d).`,
  };
}

/**
 * FEAT-056 — the architecture-review pass. The consolidation loop already runs
 * at server boot and after every WA capture; that is the only recurring,
 * failure-tolerant loop in the system, so the recurrence detector rides it
 * instead of inventing a fourth schedule.
 *
 * Contract (identical to everything else here): this can NEVER break the pass.
 * arch-watch is loaded by DYNAMIC import inside a try/catch, so a syntax error,
 * a missing file, a broken board, or an exception anywhere in the detector
 * degrades to one honest console warning. Findings are per-PROJECT — they are
 * written into that project's own docs/bugs/.arch/findings.json and surface on
 * THAT project's Needs-You rail, never bolted onto the methodology-home
 * project's rail (which carries WA findings only).
 */
async function runArchPass(boardDir, { quiet = false } = {}) {
  try {
    if (!fs.existsSync(boardDir)) {
      if (!quiet) console.log(`wa-consolidate: arch-watch skipped — no board at ${boardDir}.`);
      return { skipped: true, findings: [] };
    }
    const mod = await import(path.join(HERE, 'arch-watch.mjs'));
    const findings = mod.archFindings(boardDir);
    const file = mod.persistArchFindings(boardDir, findings);
    if (!quiet) {
      console.log(
        `wa-consolidate: arch-watch — ${findings.length} recurrence finding(s) for ${boardDir}` +
          `${file ? ` (persisted to ${file})` : ' (not persisted)'}`,
      );
      for (const f of findings) console.log(`   - [${f.type}] ${f.summary}`);
    }
    return { skipped: false, findings };
  } catch (err) {
    console.warn(`wa-consolidate: arch-watch pass failed (consolidation unaffected): ${err.message}`);
    return { skipped: true, findings: [], error: err.message };
  }
}

const args = parseArgs(process.argv.slice(2));
const APPLY = args.flags.has('--apply');

// --check-routing is a standalone, self-contained check: it never requires the WA
// file (or even a valid METHODOLOGY_DIR) to exist, and it never crashes — same
// boot-tolerance contract as sync-methodology.mjs's absent-repo no-op.
if (args.flags.has('--check-routing')) {
  const rc = checkRoutingStaleness();
  console.log(`wa-consolidate --check-routing: ${rc.message}`);
  process.exit(rc.status === 'stale' ? 1 : 0);
}

// --check-arch is the standalone architecture-review pass: same self-contained,
// never-crash contract as --check-routing. It needs no WA and no methodology
// repo — only a board dir (default: this repo's). Exit 1 = ≥1 recurrence
// finding raised (a signal, not an error).
if (args.flags.has('--check-arch')) {
  const dir = path.resolve(args['board-dir'] || path.join(REPO_ROOT, 'docs', 'bugs'));
  const { findings } = await runArchPass(dir);
  process.exit(findings.length ? 1 : 0);
}

const fileName = args.file || 'WORKING_AGREEMENT.v2.md';
const outPath = args.out || path.join(METHODOLOGY_DIR, 'CONSOLIDATION-PROPOSAL.md');
const conventionsDir = path.resolve(args['conventions-dir'] || REPO_ROOT);
const conventionsFile = path.join(conventionsDir, 'docs', 'CONVENTIONS.md');

if (!fs.existsSync(METHODOLOGY_DIR)) {
  die(`canonical methodology repo not found at ${METHODOLOGY_DIR}. Set METHODOLOGY_DIR.`, 2);
}
const waPath = path.join(METHODOLOGY_DIR, fileName);
if (!fs.existsSync(waPath)) die(`WA file not found: ${waPath}`, 2);

const bytesBefore = fs.statSync(waPath).size;
const raw = fs.readFileSync(waPath, 'utf8');
const lines = raw.split('\n');

// --- parse into sections ---------------------------------------------------
const headingRe = /^(#{1,3})\s+(.*)$/;
const sections = []; // { idx (0-based heading line), depth, title, letter, theme, bodyStart, bodyEnd }
let currentTheme = '(top)';
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(headingRe);
  if (!m) continue;
  const depth = m[1].length;
  const title = m[2];
  const letter = (title.match(/^([A-Z])\.\s/) || [])[1] || null;
  if (depth === 2) currentTheme = title;
  if (sections.length) sections[sections.length - 1].bodyEnd = i;
  sections.push({ idx: i, depth, title, letter, theme: currentTheme, bodyStart: i + 1, bodyEnd: lines.length });
}
// A "rule section" is a lettered ### subsection (A, B, … the stable-ID rules).
const ruleSections = sections.filter((s) => s.depth === 3 && s.letter);
const UNIVERSAL = (s) => !/project-specific conventions/i.test(s.theme);

/**
 * Split a section body into BLOCKS: a top-level bullet plus its continuation
 * lines, or a paragraph of contiguous non-bullet lines. Blocks are the unit of
 * relocation/merge — a whole thought moves, never half a sentence.
 */
function parseBlocks(s) {
  const blocks = [];
  let cur = null;
  for (let i = s.bodyStart; i < s.bodyEnd; i++) {
    const t = lines[i];
    if (t.trim() === '') {
      if (cur) blocks.push(cur);
      cur = null;
      continue;
    }
    const isBulletStart = /^[-*]\s/.test(t);
    const isContinuation = /^\s+\S/.test(t);
    if (cur && (isContinuation || (!isBulletStart && !cur.isBullet))) {
      cur.end = i;
      cur.lines.push(t);
    } else {
      if (cur) blocks.push(cur);
      cur = { start: i, end: i, lines: [t], isBullet: isBulletStart, section: s };
    }
  }
  if (cur) blocks.push(cur);
  for (const b of blocks) b.text = b.lines.join('\n');
  return blocks;
}
const blocksBySection = new Map(ruleSections.map((s) => [s, parseBlocks(s)]));

// Project-specific markers that leak into the universal set (§L "demote project-
// specific rules out of the universal set").
// BUG-042 live lesson: `INDEX.md` / `docs/bugs` are NOT project markers — they
// are the universal board convention's own vocabulary (WA §K, the `tickets`
// skill), and keeping them here made the detector eat §K itself.
const PROJECT_MARKERS =
  /\b(claude-station|port ?4317|4317|btrfs|Serena|ast-grep|external-project-\w+|Orchard|dual-boot|Linux ?\+ ?Windows|1500|2100)\b/i;

const STOP = new Set(
  ('a an the and or but if then else for to of in on at by with without into onto from as is are ' +
    'be it its this that these those not no do does don do dont so than when where which who whom whose ' +
    'you your we our they their them he she his her i me my will would can could should shall may might ' +
    'one two more most less least each every any all some such only just very own here there over under ' +
    'up down out off about above below between per via while still yet also too rather instead per e g').split(
    /\s+/,
  ),
);
function tokens(s) {
  return new Set(
    (s.toLowerCase().match(/[a-z][a-z-]{2,}/g) || []).filter((w) => !STOP.has(w)),
  );
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
const bodyText = (s) =>
  lines.slice(s.bodyStart, s.bodyEnd).join('\n').trim();
const where = (s) => `§${s.letter} "${s.title}" (line ${s.idx + 1})`;
function today() {
  return new Date().toISOString().slice(0, 10);
}

// --- detectors -------------------------------------------------------------
// Auto-applicable (safe classes):
const relocations = []; // { section, markers, ruleFirstLines } — WHOLE unambiguously project-specific section (BUG-042)
const merges = []; // { richer, poorer, sim } — near-duplicate sections (high confidence)
// Needs human (never auto-applied):
const needsHuman = []; // { type, where, evidence, why }
// Rail-only findings (persisted to needs-human.json for after-the-fact review,
// but NOT listed under the CHANGELOG's "NOT auto-applied" section — they WERE
// applied; BUG-042 point 3: an applied relocation must still reach a human):
const railExtras = []; // { type: 'relocation-applied', where, evidence, why }
// Informational (no action required; propose mode lists them as tensions):
const informational = [];

// CONTRADICTIONS first — a block party to a contradiction is frozen (never
// relocated/merged automatically; its resolution changes behavior).
const ALWAYS_RE = /\balways\b/i;
const NEVER_RE = /\b(never|do not|don'?t)\b/i;
const contradictionBlocks = new Set();
{
  const all = [];
  for (const s of ruleSections) for (const b of blocksBySection.get(s)) all.push(b);
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];
      const aAlw = ALWAYS_RE.test(a.text) && !NEVER_RE.test(a.text);
      const bAlw = ALWAYS_RE.test(b.text) && !NEVER_RE.test(b.text);
      const aNev = NEVER_RE.test(a.text) && !ALWAYS_RE.test(a.text);
      const bNev = NEVER_RE.test(b.text) && !ALWAYS_RE.test(b.text);
      if (!((aAlw && bNev) || (aNev && bAlw))) continue;
      const sim = jaccard(tokens(a.text), tokens(b.text));
      if (sim < 0.3) continue;
      contradictionBlocks.add(a).add(b);
      needsHuman.push({
        type: 'contradiction',
        where: `${where(a.section)} line ${a.start + 1} ↔ ${where(b.section)} line ${b.start + 1}`,
        evidence:
          `opposing imperatives on shared ground (Jaccard ≈ ${sim.toFixed(2)}): ` +
          `${JSON.stringify(a.text.trim().slice(0, 70))} vs ${JSON.stringify(b.text.trim().slice(0, 70))}`,
        why: 'Resolving a contradiction changes behavior — that is a judgment call, never auto-applied. Both rules left in place.',
      });
    }
  }
}

// 1) RELOCATE (BUG-042 rebuild). Per-block classifier first:
//    - `universal:` tag => protected, never relocated or flagged;
//    - markers in ILLUSTRATIVE context (inside parentheses, or preceded in the
//      same sentence by e.g. / for example / for instance / such as / as in /
//      like / say) are EXAMPLES, not subject matter — ignored entirely;
//    - a remaining marker in the FIRST sentence (the normative clause — WA house
//      style leads with the bold imperative), or ≥2 DISTINCT remaining markers,
//      => 'specific'; one marker only in a later sentence => 'ambiguous'.
//    Application policy (§N — cost of a wrong relocation is every future
//    session's instructions silently weakened):
//    - AUTO-APPLY only the unambiguous whole-section case: EVERY block in a
//      universal section classifies 'specific' => relocate the whole section
//      (pointer stub keeps the §letter resolvable). Also surfaced on the rail.
//    - Anything partial or ambiguous => needs-human, never auto-applied.
const UNIVERSAL_TAG = /\buniversal:/i;
const ILLUSTRATIVE_LEAD = /\b(e\.?\s?g\.?|for example|for instance|such as|as in|like|say)\b/i;
function classifyBlock(b) {
  if (UNIVERSAL_TAG.test(b.text)) return { cls: 'universal', markers: [] };
  // Pointer stubs left by earlier passes are structure, not rules — never
  // reclassify them (a stub that mentions the project name must not make the
  // pass relocate its own stub forever — observed live, BUG-042).
  if (/^_(Relocated to|Merged into) /.test(b.text.trim())) return { cls: 'universal', markers: [] };
  // Flatten: drop bullet prefixes and markdown emphasis so sentence boundaries
  // are detectable (a bold imperative ends ".**" — the ** must not hide the ".").
  const flat = b.text
    .split('\n')
    .map((l) => l.replace(/^\s*[-*]\s+/, ''))
    .join(' ')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const boundaries = [];
  const bre = /[.!?](?=\s|$)/g;
  for (let m; (m = bre.exec(flat)); ) boundaries.push(m.index);
  const firstSentenceEnd = boundaries.length ? boundaries[0] : flat.length;
  const re = new RegExp(PROJECT_MARKERS.source, 'gi');
  const normative = new Set();
  const anywhere = new Set();
  for (let m; (m = re.exec(flat)); ) {
    const idx = m.index;
    let parenDepth = 0;
    for (let i = 0; i < idx; i++) {
      if (flat[i] === '(') parenDepth++;
      else if (flat[i] === ')') parenDepth = Math.max(0, parenDepth - 1);
    }
    const sentStart = boundaries.filter((x) => x < idx).pop();
    const leadIn = flat.slice(sentStart === undefined ? 0 : sentStart + 1, idx);
    if (parenDepth > 0 || ILLUSTRATIVE_LEAD.test(leadIn)) continue; // an example, not subject matter
    const tok = m[0].toLowerCase();
    anywhere.add(tok);
    if (idx <= firstSentenceEnd) normative.add(tok);
  }
  if (normative.size >= 1 || anywhere.size >= 2) return { cls: 'specific', markers: [...anywhere] };
  if (anywhere.size === 1) return { cls: 'ambiguous', markers: [...anywhere] };
  return { cls: 'universal', markers: [] };
}
const firstLineOf = (b) => b.lines[0].trim().slice(0, 110);
for (const s of ruleSections) {
  if (!UNIVERSAL(s)) continue;
  const blocks = blocksBySection.get(s);
  if (!blocks.length) continue;
  const classed = blocks.map((b) => ({ b, ...classifyBlock(b) }));
  const flagged = classed.filter((c) => c.cls !== 'universal' && !contradictionBlocks.has(c.b));
  if (!flagged.length) continue;
  // "Unambiguous whole-section" bar (raised again after a LIVE misfire on the
  // real §K during this fix): ≥2 blocks, EVERY block 'specific', and every
  // block corroborated by ≥2 DISTINCT markers. A single-paragraph section, or
  // one leaning on a lone marker, is a judgment call — needs-human.
  const allSpecific =
    blocks.length >= 2 &&
    classed.every((c) => c.cls === 'specific' && c.markers.length >= 2) &&
    !classed.some((c) => contradictionBlocks.has(c.b));
  if (allSpecific) {
    const markers = [...new Set(classed.flatMap((c) => c.markers))];
    relocations.push({ section: s, markers, ruleFirstLines: blocks.map(firstLineOf) });
    // Rail finding only when this pass will actually apply it (--apply); a
    // propose run applies nothing, so "relocation-applied" would be a lie there.
    if (APPLY) railExtras.push({
      type: 'relocation-applied',
      where: where(s),
      evidence:
        `whole section auto-relocated to the owning project's docs/CONVENTIONS.md — every block ` +
        `is unambiguously project-specific (markers: ${markers.join(', ')})`,
      why: 'Auto-applied (the one relocation class that still is, BUG-042) — review after the fact; rollback is one git revert in the methodology repo.',
    });
  } else {
    for (const c of flagged) {
      needsHuman.push({
        type: 'relocation-candidate',
        where: `${where(s)} line ${c.b.start + 1}`,
        evidence:
          `${c.cls === 'specific' ? 'project marker in the normative clause' : 'project marker outside the normative clause (ambiguous)'} ` +
          `(${c.markers.join(', ')}): ${JSON.stringify(firstLineOf(c.b))}`,
        why: 'BUG-042: whether a rule is universal is a JUDGMENT call — a wrong relocation silently weakens every future session\'s instructions. Move it by hand if it truly belongs to one project; tag it `universal:` if the marker is only an example.',
      });
    }
  }
}

// 2) MERGE: near-duplicate rule sections. ≥0.5 token-overlap Jaccard is a safe
//    mechanical merge (keep the richer wording; unique blocks move over; the
//    poorer section keeps its stable letter as a pointer so cross-refs survive).
//    0.22–0.5 is a judgment call -> needs human.
for (let i = 0; i < ruleSections.length; i++) {
  for (let j = i + 1; j < ruleSections.length; j++) {
    const a = ruleSections[i];
    const b = ruleSections[j];
    // Pointer-stub bodies (left by prior relocations/merges) are structure, not
    // rules — two stubs are near-identical by construction and must never
    // "merge" with anything (observed live, BUG-042).
    if (/^_(Relocated to|Merged into) /.test(bodyText(a)) || /^_(Relocated to|Merged into) /.test(bodyText(b))) continue;
    const sim = jaccard(tokens(bodyText(a)), tokens(bodyText(b)));
    if (sim < 0.22) continue;
    const frozen =
      [...blocksBySection.get(a), ...blocksBySection.get(b)].some((x) => contradictionBlocks.has(x)) ||
      relocations.some((r) => r.section === a || r.section === b);
    if (sim >= 0.5 && !frozen) {
      const richer = bodyText(a).length >= bodyText(b).length ? a : b;
      const poorer = richer === a ? b : a;
      merges.push({ richer, poorer, sim });
    } else {
      needsHuman.push({
        type: 'near-duplicate-sections',
        where: `${where(a)} ↔ ${where(b)}`,
        evidence: `token-overlap Jaccard ≈ ${sim.toFixed(2)}${frozen ? ' (auto-merge frozen: overlaps a contradiction/relocation)' : ''}`,
        why: 'Overlap below the mechanical-merge bar (or entangled with another tension) — merging vs cross-referencing is a judgment call.',
      });
    }
  }
}

// 3) Cross-reference clusters — informational (the split is by design; confirm it
//    still earns its keep). Never an action.
{
  const xrefPairs = new Map();
  for (const s of ruleSections) {
    for (let i = s.bodyStart; i < s.bodyEnd; i++) {
      for (const r of lines[i].match(/§([A-Z])/g) || []) {
        const other = r.slice(1);
        if (other === s.letter) continue;
        const key = [s.letter, other].sort().join('↔');
        if (!xrefPairs.has(key)) xrefPairs.set(key, new Set());
        xrefPairs.get(key).add(`§${s.letter} line ${i + 1}`);
      }
    }
  }
  for (const [key, sites] of xrefPairs) {
    informational.push({
      type: 'cross-reference-cluster',
      where: `${key} (cited at ${[...sites].join(', ')})`,
      evidence: 'sections explicitly cross-reference each other',
      why: 'Complementary by design — confirm the split still earns its keep. No action unless it has drifted into overlap.',
    });
  }
}

// 4) Rule lacking the "why" — needs human (writing the missing rationale is
//    judgment; a wrong invented "why" is worse than none).
const RATIONALE = /(because|so that|so no|otherwise|—|:|\(§|learned the hard way|the point|the tell)/i;
const IMPERATIVE = /\b(always|never|must|don'?t|do not|prefer|avoid|use |kill |commit )/i;
for (const s of ruleSections) {
  for (const b of blocksBySection.get(s)) {
    const t = b.text.trim();
    if (!b.isBullet || t.length < 24) continue;
    if (IMPERATIVE.test(t) && !RATIONALE.test(t)) {
      needsHuman.push({
        type: 'rule-without-why',
        where: `${where(s)} line ${b.start + 1}`,
        evidence: `imperative bullet with no stated rationale: ${JSON.stringify(t.slice(0, 90))}`,
        why: 'A rule with no "why" is hard to apply with judgment — add the failure it prevents, or cut it. Auto-inventing a rationale would be dishonest.',
      });
    }
  }
}

// 5) FEAT-043 Phase R staleness trigger — routing table too old to trust for
//    provider/model dispatch decisions. Never auto-edited/re-researched here;
//    surfaced on the same needs-human report/changelog/console surface as every
//    other finding above. Missing/unparseable is a console warning, never a crash.
{
  const rc = checkRoutingStaleness();
  if (rc.status === 'stale') {
    needsHuman.push({
      type: 'routing-stale',
      where: `ROUTING.md (${path.join(METHODOLOGY_DIR, 'ROUTING.md')})`,
      evidence: rc.message,
      why: 'FEAT-043 Phase R discipline: re-verify routing after any major model release; a table older than ~3 months is expired and must not be trusted for provider/model dispatch decisions — re-research by hand, this pass never auto-edits ROUTING.md.',
    });
  } else if (rc.status === 'missing' || rc.status === 'unparseable') {
    console.warn(`wa-consolidate: routing-staleness check: ${rc.message}`);
  }
}

// ---------------------------------------------------------------------------
// FEAT-047: persist the needs-human findings so the dashboard's Needs-You rail
// can surface them (they are literally "needs you" items — dying in the server
// console was the FEAT-046 audit's top offender). Written on EVERY full pass
// (apply AND propose; boot + post-capture share this code path), OVERWRITTEN
// each time so a finding resolved by hand disappears on the next clean pass.
//
// Location: $METHODOLOGY_DIR/.station/needs-human.json — beside the repo the
// findings are ABOUT, so every producer (boot pass, capture mini-pass, any
// project) and the station server resolve the same file via the one
// METHODOLOGY_DIR rule, and scratch-suite isolation is automatic. Because a
// clean `git status` in the canonical repo is itself an asserted invariant
// (verify-wa-selfmaintain), the .station/ dir is excluded via the LOCAL
// .git/info/exclude (never a commit, never dirties porcelain).
//
// Stable ids: hash of type + where + evidence with all digits normalized (line
// numbers shift as the WA is edited; ages/similarity scores drift) — so the
// SAME finding keeps the SAME id across passes. `date` is carried forward from
// the previous JSON when the id was already present, so a dismissal (ack'd by
// id+date beside this file) stays effective while the finding merely persists,
// and the finding resurfaces only when it REAPPEARS in a later pass after
// having been gone (a fresh, newer date). Failure to write NEVER breaks the
// pass — same failure-tolerance contract as the rest of this script.
// ---------------------------------------------------------------------------
const NEEDS_HUMAN_JSON = path.join(METHODOLOGY_DIR, '.station', 'needs-human.json');
function persistNeedsHuman() {
  try {
    fs.mkdirSync(path.dirname(NEEDS_HUMAN_JSON), { recursive: true });
    // Keep the canonical repo's porcelain clean without committing anything:
    // .git/info/exclude is local-only config. A non-git dir simply skips this.
    try {
      const excl = path.join(METHODOLOGY_DIR, '.git', 'info', 'exclude');
      if (fs.existsSync(path.join(METHODOLOGY_DIR, '.git'))) {
        let cur = '';
        try { cur = fs.readFileSync(excl, 'utf8'); } catch { /* absent — created below */ }
        if (!cur.split('\n').includes('/.station/')) {
          fs.mkdirSync(path.dirname(excl), { recursive: true });
          fs.appendFileSync(excl, `${cur.endsWith('\n') || cur === '' ? '' : '\n'}/.station/\n`);
        }
      }
    } catch { /* exclude is best-effort; a dirty porcelain is survivable, a crashed pass is not */ }
    const prevDates = new Map();
    try {
      const prev = JSON.parse(fs.readFileSync(NEEDS_HUMAN_JSON, 'utf8'));
      for (const f of prev.findings ?? []) if (f?.id && f?.date) prevDates.set(f.id, f.date);
    } catch { /* first pass, or unreadable — every finding gets a fresh date */ }
    const now = new Date().toISOString();
    const norm = (s) => String(s ?? '').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
    const seen = new Set();
    // BUG-042 point 3: APPLIED relocations ride the same rail as needs-human
    // findings so a human reviews them even though they were auto-applied.
    const findings = [...needsHuman, ...railExtras].map((t) => {
      let id = `${t.type}-${crypto.createHash('sha1').update(`${t.type}|${norm(t.where)}|${norm(t.evidence)}`).digest('hex').slice(0, 8)}`;
      for (let n = 2; seen.has(id); n++) id = `${id.replace(/~\d+$/, '')}~${n}`;
      seen.add(id);
      return {
        id,
        type: t.type,
        summary: `${t.where} — ${t.evidence}`.replace(/\s+/g, ' ').slice(0, 280),
        date: prevDates.get(id) ?? now,
      };
    });
    fs.writeFileSync(
      NEEDS_HUMAN_JSON,
      `${JSON.stringify({ generatedAt: now, source: 'wa-consolidate', file: fileName, findings }, null, 2)}\n`,
    );
    console.log(`wa-consolidate: ${findings.length} needs-human finding(s) persisted to ${NEEDS_HUMAN_JSON}`);
  } catch (err) {
    console.warn(`wa-consolidate: could not persist needs-human findings (pass unaffected): ${err.message}`);
  }
}
persistNeedsHuman();

// FEAT-056: the architecture-review pass rides this same loop (boot +
// post-capture). Failure-tolerant by construction — see runArchPass. Opt out
// with --no-arch (used by fixtures that assert WA behavior in isolation).
// BUG-040: CLAUDE_STATION_NO_WA_CONSOLIDATE suppresses this implicit ride-along
// too — the env is the harness-wide "no automatic maintenance passes" switch,
// and before this check it only gated the server's spawn, so a capture-triggered
// pass still wrote arch findings. An explicit --check-arch run stays explicit.
if (!args.flags.has('--no-arch')) {
  if (process.env.CLAUDE_STATION_NO_WA_CONSOLIDATE) {
    console.log('wa-consolidate: arch-watch ride-along suppressed (CLAUDE_STATION_NO_WA_CONSOLIDATE set).');
  } else {
    await runArchPass(path.resolve(args['board-dir'] || path.join(conventionsDir, 'docs', 'bugs')));
  }
}

// ===========================================================================
// APPLY MODE — auto-apply the safe classes, commit, changelog, sync.
// ===========================================================================
if (APPLY) {
  applyMode();
} else {
  proposeMode();
}

function git(argv) {
  return spawnSync('git', ['-C', METHODOLOGY_DIR, ...argv], { encoding: 'utf8' });
}

function applyMode() {
  // Recoverability contract: --apply is safe BECAUSE every pass is a git commit.
  const inRepo = git(['rev-parse', '--is-inside-work-tree']);
  if (inRepo.status !== 0 || !/true/.test(inRepo.stdout)) {
    die(
      `refusing --apply: ${METHODOLOGY_DIR} is not a git repo. The automatic-consolidation ` +
        'contract (WA §L) rests on every pass being one revertable commit — no git, no auto-apply. ' +
        'Run without --apply for a propose-only pass.',
      2,
    );
  }

  console.log(`wa-consolidate --apply: scanned ${fileName} (${bytesBefore} bytes).`);
  console.log(
    `  auto-applicable: ${relocations.length} relocation(s), ${merges.length} merge(s); ` +
      `needs-human: ${needsHuman.length}; informational: ${informational.length}`,
  );

  if (relocations.length === 0 && merges.length === 0) {
    // Honest no-op: nothing mechanical to do. No commit, no changelog churn, no sync.
    reportNeedsHuman();
    console.log('  Nothing auto-applicable — WA unchanged, no commit made.');
    process.exit(0);
  }

  // If the WA has uncommitted changes (e.g. captures since the last pass), commit
  // them FIRST as their own snapshot so the pre-consolidation state is recoverable.
  const dirty = git(['status', '--porcelain', '--', fileName]).stdout.trim();
  if (dirty) {
    git(['add', '--', fileName]);
    const snap = git(['commit', '-m', `WA pre-consolidation snapshot: uncommitted captures in ${fileName}`]);
    if (snap.status !== 0) die(`pre-consolidation snapshot commit failed:\n${snap.stdout}${snap.stderr}`, 2);
    console.log('  committed pre-consolidation snapshot (WA had uncommitted captures).');
  }

  // --- build the edit set ---------------------------------------------------
  const deletions = new Set(); // 0-based line idx removed from the WA
  const insertions = new Map(); // afterIdx -> [lines]
  const applied = []; // human-skimmable action lines (commit body + CHANGELOG)
  const movedBlocks = []; // { sectionTitle, letter, text } for CONVENTIONS.md

  for (const r of relocations) {
    // Whole-section relocation (the only auto-applied class, BUG-042): body moves,
    // the heading stays with a pointer stub so §letter cross-references resolve.
    for (let i = r.section.bodyStart; i < r.section.bodyEnd; i++) deletions.add(i);
    // The stub is deliberately PROJECT-TOKEN-FREE (the CHANGELOG names the
    // project): a stub carrying the project name re-classified as
    // project-specific on the next pass and relocated itself forever.
    insertions.set(r.section.idx, [
      `_Relocated to the owning project's docs/CONVENTIONS.md (${today()}) — every rule was project-specific (BUG-042 bar); prior wording recoverable via git._`,
      '',
    ]);
    movedBlocks.push({ letter: r.section.letter, sectionTitle: r.section.title, text: bodyText(r.section) });
    // CHANGELOG must NAME each relocated rule explicitly (BUG-042 point 3).
    for (const ruleLine of r.ruleFirstLines) {
      applied.push(
        `relocate: §${r.section.letter} "${r.section.title}" rule ${JSON.stringify(ruleLine)} -> ` +
          `${path.relative(conventionsDir, conventionsFile)} of ${path.basename(conventionsDir)} (markers: ${r.markers.join(', ')})`,
      );
    }
  }

  for (const m of merges) {
    const richerBlocks = blocksBySection.get(m.richer);
    const poorerBlocks = blocksBySection.get(m.poorer);
    // Unique content from the poorer section survives inside the richer one.
    const uniques = poorerBlocks.filter(
      (pb) => !richerBlocks.some((rb) => jaccard(tokens(pb.text), tokens(rb.text)) >= 0.5),
    );
    // Poorer body -> a stable-ID pointer (letters are cited as §X; keep them resolvable).
    for (let i = m.poorer.bodyStart; i < m.poorer.bodyEnd; i++) deletions.add(i);
    insertions.set(m.poorer.idx, [
      `_Merged into §${m.richer.letter} "${m.richer.title}" (${today()}); prior wording recoverable via git._`,
      '',
    ]);
    if (uniques.length) {
      let lastNonBlank = m.richer.bodyStart;
      for (let i = m.richer.bodyEnd - 1; i >= m.richer.bodyStart; i--) {
        if (lines[i].trim() !== '') {
          lastNonBlank = i;
          break;
        }
      }
      const ins = insertions.get(lastNonBlank) || [];
      for (const u of uniques) ins.push(...u.lines);
      insertions.set(lastNonBlank, ins);
    }
    applied.push(
      `merge: §${m.poorer.letter} "${m.poorer.title}" -> §${m.richer.letter} "${m.richer.title}" ` +
        `(Jaccard ${m.sim.toFixed(2)}; kept richer wording, moved ${uniques.length} unique block(s), left a pointer)`,
    );
  }

  // Materialize + mechanical cleanup (trailing whitespace, blank-line runs).
  const outLines = [];
  for (let i = 0; i < lines.length; i++) {
    if (!deletions.has(i)) outLines.push(lines[i]);
    const ins = insertions.get(i);
    if (ins) outLines.push(...ins);
  }
  let cleanupCount = 0;
  const cleaned = [];
  for (const l of outLines) {
    const stripped = l.replace(/[ \t]+$/, '');
    if (stripped !== l) cleanupCount++;
    if (stripped === '' && cleaned.length && cleaned[cleaned.length - 1] === '') {
      cleanupCount++;
      continue; // collapse blank runs to one
    }
    cleaned.push(stripped);
  }
  if (cleanupCount) applied.push(`cleanup: ${cleanupCount} mechanical fix(es) (trailing whitespace / blank runs)`);

  fs.writeFileSync(waPath, cleaned.join('\n'));
  const bytesAfter = fs.statSync(waPath).size;

  // --- CONVENTIONS.md of the owning project (create/append, NEVER overwrite) ---
  if (movedBlocks.length) {
    fs.mkdirSync(path.dirname(conventionsFile), { recursive: true });
    let chunk = '';
    if (!fs.existsSync(conventionsFile)) {
      chunk +=
        `# Project conventions — ${path.basename(conventionsDir)}\n\n` +
        `Project-specific working rules. Auto-injected into sessions launched for this\n` +
        `project (see src/server/templates.ts localConventionsSection). Grows by hand and\n` +
        `by relocation from the universal Working Agreement (\`wa-consolidate --apply\`, WA §L).\n`;
    }
    chunk += `\n## Relocated from the universal Working Agreement — ${today()}\n`;
    for (const b of movedBlocks) {
      chunk += `\n### From WA §${b.letter} "${b.sectionTitle}"\n\n${b.text}\n`;
    }
    fs.appendFileSync(conventionsFile, chunk);
  }

  // --- CHANGELOG.md (human-skimmable, append-only) ---------------------------
  const changelogPath = path.join(METHODOLOGY_DIR, 'CHANGELOG.md');
  let clog = '';
  if (!fs.existsSync(changelogPath)) {
    clog += `# Methodology changelog\n\nAutomated consolidation passes (\`wa-consolidate --apply\`, WA §L) and notable\nhand edits. Every pass is one git commit — rollback is one \`git revert\`.\n`;
  }
  clog += `\n## ${today()} — automated consolidation pass (${fileName})\n\n`;
  for (const a of applied) clog += `- ${a}\n`;
  if (needsHuman.length) {
    clog += `\nNeeds human (NOT auto-applied):\n`;
    for (const t of needsHuman) clog += `- [${t.type}] ${t.where} — ${t.evidence}\n`;
  }
  fs.appendFileSync(changelogPath, clog);

  // --- ONE commit for the pass (explicit file list, §J) ----------------------
  const add = git(['add', '--', fileName, 'CHANGELOG.md']);
  if (add.status !== 0) die(`git add failed:\n${add.stdout}${add.stderr}`, 2);
  const summary =
    `WA consolidation (auto): ${relocations.length} relocation(s), ${merges.length} merge(s)` +
    (cleanupCount ? `, ${cleanupCount} cleanup(s)` : '') +
    ` — details in CHANGELOG.md`;
  const commit = git(['commit', '-m', summary, '-m', applied.join('\n')]);
  if (commit.status !== 0) die(`git commit failed:\n${commit.stdout}${commit.stderr}`, 2);
  const hash = git(['rev-parse', '--short', 'HEAD']).stdout.trim();

  console.log(`  applied (${bytesBefore} -> ${bytesAfter} bytes):`);
  for (const a of applied) console.log(`   - ${a}`);
  console.log(`  committed ${hash} in ${METHODOLOGY_DIR} (rollback: git revert ${hash})`);
  console.log(`  CHANGELOG.md appended.`);
  reportNeedsHuman();

  // --- sync canonical -> mirror ---------------------------------------------
  if (args.flags.has('--no-sync')) {
    console.log('  [--no-sync] mirror sync skipped; run `npm run sync:methodology` to propagate.');
  } else {
    const sync = spawnSync(process.execPath, [path.join(HERE, 'sync-methodology.mjs')], {
      stdio: 'inherit',
      env: process.env,
    });
    if (sync.status !== 0) {
      die(`sync-methodology exited ${sync.status}; canonical consolidated but mirror may be stale.`, 2);
    }
  }
  process.exit(0);
}

function reportNeedsHuman() {
  if (needsHuman.length) {
    console.log(`  NEEDS HUMAN (not auto-applied — judgment calls):`);
    for (const t of needsHuman) console.log(`   - [${t.type}] ${t.where}\n       ${t.evidence}`);
  } else {
    console.log('  needs-human: none.');
  }
  if (informational.length) {
    console.log(`  informational (no action): ${informational.length} cross-reference cluster(s).`);
  }
}

// ===========================================================================
// PROPOSE MODE — original behavior: scan + write a reviewable artifact; the WA
// is never modified (asserted). Useful for a dry look before an --apply.
// ===========================================================================
function proposeMode() {
  const tensions = [];
  for (const r of relocations) {
    tensions.push({
      type: 'project-specific-in-universal',
      severity: 'med',
      where: where(r.section),
      evidence: `every block in the section is unambiguously project-specific (markers: ${r.markers.join(', ')})`,
      why: 'A universal Working Agreement should not hard-code one project\'s tools/paths/sizes. §L: demote project-specific rules out of the universal set.',
      proposal: `AUTO-APPLICABLE: \`wa-consolidate --apply\` relocates the whole section to the owning project's docs/CONVENTIONS.md (git-recoverable; pointer stub left). Partial/ambiguous cases are needs-human (BUG-042).`,
    });
  }
  for (const m of merges) {
    tensions.push({
      type: 'near-duplicate-sections',
      severity: 'high',
      where: `${where(m.richer)} ↔ ${where(m.poorer)}`,
      evidence: `token-overlap Jaccard ≈ ${m.sim.toFixed(2)}`,
      why: '§L: merge duplicates — readers must otherwise reconcile overlapping rules.',
      proposal: `AUTO-APPLICABLE: \`wa-consolidate --apply\` merges §${m.poorer.letter} into §${m.richer.letter} (richer wording kept, unique content preserved, pointer left).`,
    });
  }
  for (const t of needsHuman) {
    tensions.push({
      type: t.type,
      severity: t.type === 'contradiction' ? 'high' : 'med',
      where: t.where,
      evidence: t.evidence,
      why: t.why,
      proposal:
        t.type === 'routing-stale'
          ? 'NEEDS HUMAN — never auto-applied/auto-researched; re-run FEAT-043 Phase R research by hand and update the canonical ROUTING.md, then `npm run sync:methodology`.'
          : 'NEEDS HUMAN — never auto-applied; resolve by hand in the canonical WA, then `npm run sync:methodology`.',
    });
  }
  for (const t of informational) {
    tensions.push({ ...t, severity: 'low', proposal: 'Confirm the split is intentional; no change needed if so.' });
  }

  if (tensions.length === 0) {
    console.log(`wa-consolidate: scanned ${fileName} (${bytesBefore} bytes) — no tensions detected.`);
    console.log('Nothing to propose. Exit 4 (WA looks clean by the current heuristics).');
    assertUnchanged();
    process.exit(4);
  }

  const order = { high: 0, med: 1, low: 2 };
  tensions.sort((a, b) => order[a.severity] - order[b.severity]);
  const counts = tensions.reduce((m, t) => ((m[t.type] = (m[t.type] || 0) + 1), m), {});
  const stamp = new Date().toISOString();

  let md = '';
  md += `# Working Agreement — consolidation report (propose-only run)\n\n`;
  md += `> **NOT AUTO-APPLIED — this was a propose-only run.** The Working Agreement itself\n`;
  md += `> was **not modified**. Safe classes (relocations/merges/cleanup) are auto-applied by\n`;
  md += `> \`npm run wa:consolidate -- --apply\` (WA §L): each pass is ONE git commit in the\n`;
  md += `> canonical repo, logged in CHANGELOG.md, so rollback is one \`git revert\`. Judgment\n`;
  md += `> calls (contradictions and the like) are never auto-applied — resolve those by hand\n`;
  md += `> (\`git -C ${METHODOLOGY_DIR} diff\` shows any pass).\n\n`;
  md += `- Generated: ${stamp}\n`;
  md += `- Source: \`${waPath}\` (${bytesBefore} bytes, unchanged)\n`;
  md += `- Tensions found: ${tensions.length} — ${Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(', ')}\n\n`;
  md += `---\n\n`;
  tensions.forEach((t, i) => {
    md += `## ${i + 1}. [${t.severity.toUpperCase()}] ${t.type}\n`;
    md += `- **Where:** ${t.where}\n`;
    md += `- **Evidence:** ${t.evidence}\n`;
    md += `- **Why it's a tension:** ${t.why}\n`;
    md += `- **Proposed resolution:** ${t.proposal}\n\n`;
  });
  md += `---\n\n`;
  md += `_Heuristic first pass — false positives are expected; a needs-human listing costs\nnothing to reject. Safe classes are mechanical and git-recoverable, hence automatic._\n`;

  fs.writeFileSync(outPath, md);

  console.log(`wa-consolidate: scanned ${fileName} (${bytesBefore} bytes).`);
  console.log(`  Found ${tensions.length} tension(s): ${Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(', ')}`);
  for (const t of tensions) console.log(`   - [${t.severity}] ${t.type}: ${t.where}`);
  console.log(`  Proposal written: ${outPath}`);
  console.log('  The WA was NOT modified — propose-only run (use --apply for the automatic pass).');
  assertUnchanged();
  if (args.flags.has('--stdout')) {
    console.log('\n----- PROPOSAL -----\n');
    console.log(md);
  }
  process.exit(0);
}

function assertUnchanged() {
  const bytesAfter = fs.statSync(waPath).size;
  if (bytesAfter !== bytesBefore) {
    die(
      `INVARIANT VIOLATED: WA byte length changed ${bytesBefore} -> ${bytesAfter}. ` +
        'a propose-only run must never modify the WA.',
      2,
    );
  }
  console.log(`  invariant OK: WA unchanged (${bytesBefore} == ${bytesAfter} bytes).`);
}
