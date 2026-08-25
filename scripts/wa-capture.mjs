#!/usr/bin/env node
/**
 * FEAT-019 — Living-doc self-maintenance, the CAPTURE half (the under-persist guard).
 *
 * Operationalizes WORKING_AGREEMENT.v2 §L: "Default ephemeral; persist deliberately.
 * Write a rule only when it is (a) a standing preference ('always / never / from now
 * on') or (b) a failure mode that has recurred (≥2×)." This tool APPENDS one such
 * qualifying rule to the CANONICAL Working Agreement under the right themed section,
 * then runs the existing sync so the claude-station mirror updates. A one-off is
 * REFUSED (parked), never persisted.
 *
 * Recoverability (§D): capture is APPEND-ONLY — it never rewrites or deletes existing
 * content, so the prior version is always recoverable via git in the canonical repo.
 * (Consolidation — the lossy/opinionated half — is a separate tool that only PROPOSES;
 * see scripts/wa-consolidate.mjs.)
 *
 * Canonical target (honors METHODOLOGY_DIR, default ~/projects/methodology):
 *   $METHODOLOGY_DIR/WORKING_AGREEMENT.v2.md
 * After appending, runs scripts/sync-methodology.mjs so docs/prompts mirror matches.
 *
 * Usage:
 *   node scripts/wa-capture.mjs --rule "<rule text>" --section <ID|theme> [options]
 *
 *   --rule "<text>"      REQUIRED. The rule to persist (one bullet's worth).
 *   --section <ID|theme> REQUIRED. Target section: a stable letter ID (e.g. C, L)
 *                        matching "### C." / "### L.", or a case-insensitive substring
 *                        of a section heading (e.g. "Rigor", "Working method").
 *   --kind standing|recurring   Optional. Defaults to auto: 'standing' when the rule
 *                        text contains always / never / from now on, else you must pass
 *                        --kind recurring --recurrences N (N≥2) to qualify.
 *   --recurrences <N>    Required with --kind recurring; must be ≥2 (§L's ≥2× bar).
 *   --file <basename>    Canonical file to target (default WORKING_AGREEMENT.v2.md).
 *   --no-sync            Append only; skip the sync-methodology step AND the
 *                        consolidation mini-pass (used by tests that assert the
 *                        append + sync contracts separately).
 *   --no-consolidate     Skip the automatic consolidation mini-pass that normally
 *                        follows a successful capture+sync (FEAT-019, 2026-08-05:
 *                        consolidation is automatic — every capture may add drift,
 *                        so every capture triggers a safe-class `--apply` pass).
 *   --no-append          MUST-FAIL harness: run every step EXCEPT the write, to prove
 *                        the append is what mutates canonical (non-vacuous verify).
 *   --dry-run            Print what WOULD be appended + where; write nothing.
 *
 * Exit codes: 0 appended (or dry-run/no-append handled), 2 usage error,
 *             3 REFUSED (does not clear §L's persistence bar — parked).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const METHODOLOGY_DIR =
  process.env.METHODOLOGY_DIR || path.join(os.homedir(), 'projects', 'methodology');

// --- arg parse -------------------------------------------------------------
function parseArgs(argv) {
  const out = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-sync' || a === '--no-append' || a === '--dry-run' || a === '--no-consolidate') {
      out.flags.add(a);
      continue;
    }
    if (a.startsWith('--')) {
      out[a.slice(2)] = argv[++i];
    }
  }
  return out;
}

function die(msg, code = 2) {
  console.error(`wa-capture: ${msg}`);
  process.exit(code);
}

const args = parseArgs(process.argv.slice(2));
const ruleText = (args.rule || '').trim();
const section = (args.section || '').trim();
const fileName = args.file || 'WORKING_AGREEMENT.v2.md';

if (!ruleText) die('--rule "<text>" is required.');
if (!section) die('--section <ID|theme> is required.');

// --- §L persistence bar ----------------------------------------------------
// Standing preference: always / never / from now on. Recurring failure: ≥2×.
const STANDING_RE = /\b(always|never|from now on)\b/i;
const isStandingText = STANDING_RE.test(ruleText);

let kind = args.kind;
if (!kind) kind = isStandingText ? 'standing' : 'unclassified';

let qualifies = false;
let qualifyWhy = '';
let recurrences = null;

if (kind === 'standing') {
  if (isStandingText) {
    qualifies = true;
    qualifyWhy = 'standing preference (contains always/never/from now on)';
  } else {
    qualifyWhy =
      "classified --kind standing but the text has no standing marker (always/never/from now on)";
  }
} else if (kind === 'recurring') {
  recurrences = Number(args.recurrences);
  if (Number.isFinite(recurrences) && recurrences >= 2) {
    qualifies = true;
    qualifyWhy = `recurring failure mode (${recurrences}× ≥ 2× bar)`;
  } else {
    qualifyWhy =
      '--kind recurring requires --recurrences N with N≥2 (§L: a failure mode that has recurred ≥2×)';
  }
} else {
  qualifyWhy =
    "one-off: no standing marker (always/never/from now on) and not declared a ≥2×-recurring failure (--kind recurring --recurrences N)";
}

if (!qualifies) {
  console.error('REFUSED — does not clear §L\'s persistence bar; PARKED (not persisted).');
  console.error(`  rule:    ${JSON.stringify(ruleText)}`);
  console.error(`  reason:  ${qualifyWhy}`);
  console.error(
    '  §L: persist only a standing preference ("always / never / from now on") OR a\n' +
      '      failure mode that has recurred (≥2×). A one-off stays ephemeral by design.',
  );
  console.error(
    '  If this really is standing, phrase it as such or pass --kind recurring --recurrences N.',
  );
  process.exit(3);
}

// --- locate canonical file + section --------------------------------------
if (!fs.existsSync(METHODOLOGY_DIR)) {
  die(
    `canonical methodology repo not found at ${METHODOLOGY_DIR}. Capture targets the ` +
      'canonical WA, not the mirror. Set METHODOLOGY_DIR or clone the repo.',
    2,
  );
}
const canonicalPath = path.join(METHODOLOGY_DIR, fileName);
const original = fs.readFileSync(canonicalPath, 'utf8');
const lines = original.split('\n');

// A heading line is `#`..`###` + space. Section IDs are the letter in "### L. ...".
const headingRe = /^(#{1,3})\s+(.*)$/;
function headingLetter(text) {
  const m = text.match(/^([A-Z])\.\s/);
  return m ? m[1] : null;
}

let startIdx = -1;
const wantLetter = /^[A-Za-z]$/.test(section) ? section.toUpperCase() : null;
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(headingRe);
  if (!m) continue;
  const text = m[2];
  if (wantLetter && headingLetter(text) === wantLetter) {
    startIdx = i;
    break;
  }
  if (!wantLetter && text.toLowerCase().includes(section.toLowerCase())) {
    startIdx = i;
    break;
  }
}

if (startIdx === -1) {
  const available = lines
    .map((l) => l.match(headingRe))
    .filter(Boolean)
    .map((m) => m[2])
    .join('\n    ');
  die(
    `section ${JSON.stringify(section)} not found in ${fileName}. Available headings:\n    ${available}`,
    2,
  );
}

const startDepth = lines[startIdx].match(headingRe)[1].length;
// Section body ends at the next heading of equal-or-shallower depth (or EOF).
let endIdx = lines.length;
for (let i = startIdx + 1; i < lines.length; i++) {
  const m = lines[i].match(headingRe);
  if (m && m[1].length <= startDepth) {
    endIdx = i;
    break;
  }
}
// Insert after the last non-blank line of the section body (append-only, in-section).
let insertAt = startIdx + 1;
for (let i = endIdx - 1; i > startIdx; i--) {
  if (lines[i].trim() !== '') {
    insertAt = i + 1;
    break;
  }
}

const sectionHeading = lines[startIdx].replace(headingRe, '$2');

// Normalize the rule into a single bullet; tag its provenance so a later
// consolidation pass can see why it earned its keep.
let bullet = ruleText;
if (!/^[-*]\s/.test(bullet)) bullet = `- ${bullet}`;
const tag =
  kind === 'recurring'
    ? `_(captured ${today()} — recurring ≥${recurrences}×)_`
    : `_(captured ${today()} — standing preference)_`;
bullet = `${bullet} ${tag}`;

function today() {
  return new Date().toISOString().slice(0, 10);
}

console.log('wa-capture — §L persistence check:');
console.log(`  qualifies: YES — ${qualifyWhy}`);
console.log(`  file:      ${canonicalPath}`);
console.log(`  section:   ${lines[startIdx].trim()}  (line ${startIdx + 1})`);
console.log(`  append at: line ${insertAt + 1}`);
console.log(`  bullet:    ${bullet}`);

if (args.flags.has('--dry-run')) {
  console.log('\n[--dry-run] nothing written.');
  process.exit(0);
}

if (args.flags.has('--no-append')) {
  // MUST-FAIL harness: everything up to the write ran, but we deliberately skip
  // the mutation so a verifier can prove canonical is unchanged without the append.
  console.log('\n[--no-append] append step DISABLED — canonical left byte-for-byte unchanged.');
  process.exit(0);
}

// --- append (append-only; existing content untouched) ---------------------
const before = lines.slice(0, insertAt);
const after = lines.slice(insertAt);
const updated = [...before, bullet, ...after].join('\n');
fs.writeFileSync(canonicalPath, updated);

const delta = Buffer.byteLength(updated) - Buffer.byteLength(original);
console.log(
  `\nAPPENDED to §${sectionHeading} (+${delta} bytes; ${Buffer.byteLength(original)} → ${Buffer.byteLength(updated)}).`,
);

// --- sync canonical -> mirror ---------------------------------------------
if (args.flags.has('--no-sync')) {
  console.log('[--no-sync] skipped sync-methodology; run `npm run sync:methodology` to propagate.');
  process.exit(0);
}
console.log('\nRunning sync-methodology (canonical -> mirror)…');
const sync = spawnSync(process.execPath, [path.join(HERE, 'sync-methodology.mjs')], {
  stdio: 'inherit',
  env: process.env,
});
if (sync.status !== 0) {
  die(`sync-methodology exited ${sync.status}; canonical was appended but mirror may be stale.`, 1);
}

/*
 * FEAT-019 (2026-08-05, user decision): consolidation is AUTOMATIC. Every capture
 * can add drift (a near-dup, a project-specific leak), so every successful
 * capture+sync triggers a safe-class consolidation mini-pass (`--apply`: relocate /
 * merge / cleanup only; contradictions still surface as needs-human). FAILURE
 * TOLERANT by contract: the capture itself already succeeded and synced — a broken
 * mini-pass (e.g. methodology dir not a git repo) is warned about, never fatal.
 */
// BUG-040: the same env that opts a server boot out of the automatic pass opts
// the post-capture mini-pass out too — a harness that set it has already said
// "no automatic maintenance passes", and this spawn used to ignore it.
if (!args.flags.has('--no-consolidate') && process.env.CLAUDE_STATION_NO_WA_CONSOLIDATE) {
  console.log('\nConsolidation mini-pass suppressed (CLAUDE_STATION_NO_WA_CONSOLIDATE set).');
} else if (!args.flags.has('--no-consolidate')) {
  console.log('\nRunning automatic consolidation mini-pass (wa-consolidate --apply)…');
  const cons = spawnSync(process.execPath, [path.join(HERE, 'wa-consolidate.mjs'), '--apply'], {
    stdio: 'inherit',
    env: process.env,
  });
  if (cons.status !== 0) {
    console.warn(
      `wa-capture: consolidation mini-pass exited ${cons.status ?? 'null'} — the capture itself ` +
        'succeeded and is synced; run `npm run wa:consolidate -- --apply` by hand when convenient.',
    );
  }
}
console.log('\nDone — rule persisted to canonical and synced to the mirror.');
process.exit(0);
