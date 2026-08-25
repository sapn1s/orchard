#!/usr/bin/env node
/**
 * BUG-127 — a `--allow-legacy` reason or a ticket title that carries a newline,
 * a `<!--`, or a `\|` corrupts the archive index `promote()` writes, and the
 * promotion still exits 0.
 *
 * WHAT THIS SUITE RUNS AGAINST. Not a fixture. Every case rebuilds the REAL
 * corpus into a throwaway git repo out of what this repo already holds:
 *
 *   originals  ->  docs/bugs/archive/*.md   (the 194 verbatim pre-migration files)
 *                  + the two files named in `--allow-legacy`, still legacy
 *   staged     ->  docs/bugs/*.md           (the promoted record for each of those 194)
 *
 * so `promote()` runs the same 194 moves and generates the same index it
 * generated for the cutover. The hazard values are then driven onto that real
 * corpus one at a time — a real reason with a newline in it, a real ticket's
 * real H1 with a `<!--` appended — because the defect is invisible on the
 * minimal case and only shows its shape at 196 rows, where a hidden region
 * swallows the rows that follow it.
 *
 * NON-VACUITY, and the trap it avoids. Case group F re-runs the defect cases
 * against a SYNTHESIZED PRE-FIX variant of the generator: the shipped file with
 * the two `escapeTableCell(...)` call sites rewritten back to the old
 * `.replace(/\|/g, '\\|')`. It is anchored to a constructed broken state, not
 * to HEAD, so committing the fix cannot turn the proof into a tautology
 * (docs/CONVENTIONS.md). And before grading a single red, F asserts the broken
 * variant LOADED AND RAN — it must still pass the byte-identical real-corpus
 * case. A copied script that cannot resolve its imports reddens every assertion
 * for the wrong reason and is indistinguishable from a genuine regression; the
 * control case is what tells those two apart.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { mkdtempScratch } from './lib/scratch.mjs';

import { escapeTableCell, extractTicketBlock, formatTicket } from './lib/ticket-schema.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The cutover commit, PINNED. The corpus is read at this revision and nowhere
 * else, for two reasons:
 *
 *  - `promote()`'s gate requires each staged record's activity log to be a
 *    byte-for-byte copy of its original's. The live board keeps being worked,
 *    so a record that legitimately grew one log entry since the cutover fails
 *    that gate — the suite would go red because someone used the product
 *    correctly (docs/CONVENTIONS.md). Reading the working tree here measured
 *    exactly that: BUG-124, mid-fix in another lane.
 *  - a pinned revision cannot become the fixed state the way `HEAD` does.
 */
const CUTOVER = 'f109aa8';

const SCRATCH = mkdtempScratch('verify-bug-127-');

/** The corpus at CUTOVER, exported once: `archive/` = the originals, the rest = the records. */
const CORPUS = (() => {
  const at = path.join(SCRATCH, 'corpus');
  fs.mkdirSync(at, { recursive: true });
  const r = spawnSync('sh', ['-c',
    `git -C ${JSON.stringify(ROOT)} archive ${CUTOVER} docs/bugs | tar -x -C ${JSON.stringify(at)}`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`could not export the corpus at ${CUTOVER}: ${r.stderr}`);
  const bugs = path.join(at, 'docs/bugs');
  const archive = path.join(bugs, 'archive');
  const originals = fs.readdirSync(archive).filter((f) => /^(ARCH|BUG|FEAT|DEPLOY)-\d+-.*\.md$/.test(f));
  if (originals.length < 100) throw new Error(`the corpus at ${CUTOVER} holds ${originals.length} archived originals — that is not the real board`);
  return { bugs, archive, originals, index: fs.readFileSync(path.join(archive, 'INDEX.md'), 'utf8') };
})();

let pass = 0; const fails = [];
const ok = (name, cond, observed) => {
  if (cond) { pass++; console.log(`  PASS  ${name}${observed === undefined ? '' : `  [${observed}]`}`); }
  else { fails.push(name); console.log(`  FAIL  ${name}  [observed: ${observed}]`); }
};

/* ────────────────────────────────────────────── the real corpus, in a room */

/** The ids the cutover named in `--allow-legacy`, and the reasons it gave. */
function shippedLegacy() {
  const out = new Map();
  const start = CORPUS.index.indexOf('| ID | Still at |');
  if (start < 0) throw new Error('the archived index has no legacy section — the corpus this suite reads has changed shape');
  for (const line of CORPUS.index.slice(start).split('\n').slice(2)) {
    const m = /^\| (\S+) \| \[[^\]]+\]\([^)]+\) \| (.*) \|$/.exec(line);
    if (!m) break;
    out.set(m[1], m[2]);
  }
  if (out.size < 2) throw new Error(`expected ≥2 legacy rows in the archived index, found ${out.size}`);
  return out;
}

let roomSeq = 0;
/**
 * Rebuild the pre-promotion state in a throwaway git repo: the originals back in
 * `docs/bugs/`, their records back in a staging dir. `mutate` may rewrite an
 * original before promotion — that is how a hazard is driven onto a real H1.
 */
function buildRoom(mutate = null) {
  const room = path.join(SCRATCH, `room-${roomSeq += 1}`);
  fs.rmSync(room, { recursive: true, force: true });
  const dir = path.join(room, 'docs/bugs');
  const out = path.join(room, 'staged');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(out, { recursive: true });

  for (const f of CORPUS.originals) {
    fs.copyFileSync(path.join(CORPUS.archive, f), path.join(dir, f));
    const record = path.join(CORPUS.bugs, f);
    if (!fs.existsSync(record)) throw new Error(`archived original ${f} has no record at ${CUTOVER}`);
    // The corpus at CUTOVER carries the self-edge BUG-128 later found and
    // repaired (`FEAT-084 --see_also--> FEAT-084`), so the validation gate now
    // REFUSES it — correctly, and for a reason that has nothing to do with cell
    // escaping. Dropping self-edges here keeps this suite pinned to the real
    // corpus while testing the one thing it is about. It touches records only;
    // the index rows are built from the ORIGINALS, so it cannot affect the
    // byte-identity case below.
    const text = fs.readFileSync(record, 'utf8');
    const { block, body } = extractTicketBlock(text);
    let cleaned = text;
    if (block !== null) {
      const rec = JSON.parse(block);
      if (Array.isArray(rec.related) && rec.related.some((rel) => rel && rel.id === rec.id)) {
        rec.related = rec.related.filter((rel) => !(rel && rel.id === rec.id));
        cleaned = formatTicket(rec, body);
      }
    }
    fs.writeFileSync(path.join(out, f), cleaned);
  }
  for (const id of shippedLegacy().keys()) {
    const f = fs.readdirSync(CORPUS.bugs).find((n) => n.startsWith(`${id}-`) && n.endsWith('.md'));
    if (!f) throw new Error(`legacy ticket ${id} named in the archived index is not in the corpus`);
    fs.copyFileSync(path.join(CORPUS.bugs, f), path.join(dir, f));
  }
  if (mutate) mutate({ dir, out });

  const git = (...a) => spawnSync('git', ['-C', room, ...a], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'verify@local');
  git('config', 'user.name', 'verify');
  git('add', 'docs/bugs');
  git('commit', '-qm', 'corpus');
  return { room, dir, out };
}

/** Run a `promote` implementation over a fresh room; return its exit code + the index it wrote. */
function runPromote(promote, { reasons, mutate = null }) {
  const { room, dir, out } = buildRoom(mutate);
  const log = [];
  const realLog = console.log; const realErr = console.error;
  console.log = (...a) => log.push(a.join(' '));
  console.error = (...a) => log.push(a.join(' '));
  let code;
  try {
    code = promote({ dir, out, apply: true, allowLegacy: new Map(reasons), today: '2026-08-20' });
  } finally {
    console.log = realLog; console.error = realErr;
  }
  const file = path.join(dir, 'archive/INDEX.md');
  const index = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  fs.rmSync(room, { recursive: true, force: true });
  return { code, index, log: log.join('\n') };
}

/* ──────────────────────────────────────────── what a correct index looks like */

const REAL = shippedLegacy();
const [LEGACY_A, LEGACY_B] = [...REAL.keys()].sort();

/**
 * The properties a generated index must hold whatever anyone wrote. Each is a
 * terminator class: cell, row, region.
 */
function gradeIndex(index, { expectRows, expectLegacy }) {
  if (index === null) return ['no index was written at all'];
  const lines = index.split('\n');
  const problems = [];

  /**
   * A markdown table is the CONTIGUOUS run of `|` lines under its header. That
   * is the property the defect breaks: a value with a newline in it ends the
   * run early and everything after the break is prose, not a row. Counting
   * `l.startsWith('|')` across the whole document would not notice, because the
   * surviving half-row still starts with a pipe.
   */
  const table = (headerPrefix, want, columns, label) => {
    const start = lines.findIndex((l) => l.startsWith(headerPrefix));
    if (start < 0) { problems.push(`${label} table is missing entirely`); return; }
    const rows = [];
    for (let i = start + 2; i < lines.length && lines[i].startsWith('|'); i++) rows.push(lines[i]);
    if (rows.length !== want) problems.push(`${label} table has ${rows.length} contiguous rows, expected ${want}`);
    for (const l of rows) {
      // An UNESCAPED `|` is a column separator; `\|` is a literal.
      const n = l.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).length;
      if (n !== columns) problems.push(`${label} row has ${n} cells, expected ${columns}: ${l.slice(0, 70)}`);
    }
  };
  table('| ID | Original title |', expectRows, 5, 'main');
  if (expectLegacy > 0) table('| ID | Still at |', expectLegacy, 3, 'legacy');

  // REGION: no HTML comment may be opened. An unterminated one hides every
  // following row when rendered; a terminated one hides the rows between.
  if (index.includes('<!--')) problems.push('index opens an HTML comment');
  // REGION: nothing may introduce a heading the generator did not write.
  const headings = lines.filter((l) => /^#{1,6} /.test(l));
  const expectedHeadings = expectLegacy > 0 ? 2 : 1;
  if (headings.length !== expectedHeadings) {
    problems.push(`index has ${headings.length} headings, expected ${expectedHeadings}: ${JSON.stringify(headings)}`);
  }
  return problems;
}

/* ═══════════════════════════════════════════════════════════════════ cases */

console.log('BUG-127 — the archive index survives any reason or title someone writes\n');

/* ── A. escapeTableCell, the class it claims to close ───────────────────── */
console.log('A. the terminator classes, at the unit');
const CELL = [
  ['LF splits the row', 'a\nb', 'a b'],
  ['CRLF splits the row', 'a\r\nb', 'a b'],
  ['a lone CR splits the row (ARCH-006)', 'a\rb', 'a b'],
  ['U+2028 is a line break to JS and to some renderers', 'a\u2028b', 'a b'],
  ['a NUL makes the file binary to grep (BUG-103)', 'a\u0000b', 'a b'],
  ['an ESC can make a reviewed line lie', 'a\u001bb', 'a b'],
  ['a pipe terminates the cell', 'a|b', 'a\\|b'],
  ['a backslash before a pipe re-opens the cell', 'a\\|b', 'a\\\\\\|b'],
  ['`<!--` opens a region that hides the rest', 'a <!-- b', 'a &lt;!-- b'],
  ['a block tag ends the table', 'a <div> b', 'a &lt;div> b'],
  ['an ampersand is left alone — it terminates nothing', 'compaction & reusable', 'compaction & reusable'],
  ['an ordinary title is untouched', 'Running sessions keep outdated project instructions', 'Running sessions keep outdated project instructions'],
];
for (const [name, input, want] of CELL) {
  const got = escapeTableCell(input);
  ok(name, got === want, JSON.stringify(got));
}
ok('null and undefined do not throw', escapeTableCell(null) === '' && escapeTableCell(undefined) === '', 'both empty');

/* ── B. the real corpus is unchanged by the fix ─────────────────────────── */
console.log('\nB. the shipped archive index regenerates byte-identical');
const { promote } = await import('./migrate-tickets.mjs');
const control = runPromote(promote, { reasons: [...REAL] });
ok('promote() exits 0 on the real corpus', control.code === 0, `exit ${control.code}${control.code ? ` :: ${control.log.split('\n').slice(-3).join(' / ')}` : ''}`);
const shipped = CORPUS.index;
ok('regenerated index is byte-identical to the shipped one', control.index === shipped,
  control.index === shipped ? `${Buffer.byteLength(shipped)} bytes` : `${Buffer.byteLength(control.index || '')} vs ${Buffer.byteLength(shipped)} bytes`);
ok('escaping altered none of the 194 real titles + 2 real reasons', control.log.includes('CELL ESCAPED') === false, 'no CELL ESCAPED lines');
{
  const problems = gradeIndex(control.index, { expectRows: 194, expectLegacy: 2 });
  ok(`the real index (${CORPUS.originals.length} rows) passes every terminator property`, problems.length === 0, problems.join(' / ') || 'clean');
}

/* ── C. a newline in a reason, on the real corpus ───────────────────────── */
console.log('\nC. a reason carrying a newline');
const NEWLINE_REASON = `Contested evidence.\n\n## Injected heading\n\nloose prose that is no longer a row.`;
const caseNewline = { reasons: [[LEGACY_B, NEWLINE_REASON], [LEGACY_A, REAL.get(LEGACY_A)]] };
const rNewline = runPromote(promote, caseNewline);
{
  const problems = gradeIndex(rNewline.index, { expectRows: 194, expectLegacy: 2 });
  ok('both legacy rows survive as rows', problems.length === 0, problems.join(' / ') || 'clean');
  ok('no heading was injected into the archive index', !/^## Injected heading$/m.test(rNewline.index), 'absent');
  ok('the reason still reads as one line in its cell',
    /\| Contested evidence\. ## Injected heading loose prose that is no longer a row\. \|/.test(rNewline.index), 'collapsed to one line');
  ok('promote() names the value it rewrote', /CELL ESCAPED\s+\S+\s+legacy reason/.test(rNewline.log),
    (rNewline.log.match(/CELL ESCAPED.*/) || ['none'])[0].slice(0, 80));
}

/* ── D. a `<!--` in a reason hides the rows after it ────────────────────── */
console.log('\nD. a reason opening an HTML comment');
const caseComment = { reasons: [[LEGACY_A, 'Contested evidence <!-- from here on, invisible'], [LEGACY_B, REAL.get(LEGACY_B)]] };
const rComment = runPromote(promote, caseComment);
{
  const problems = gradeIndex(rComment.index, { expectRows: 194, expectLegacy: 2 });
  ok('no comment is opened, so the row after it is still visible', problems.length === 0, problems.join(' / ') || 'clean');
  ok('the second legacy ticket is still readable', rComment.index.includes(`| ${LEGACY_B} |`), `${LEGACY_B} present`);
}

/* ── E. the same hazard on a real ticket's real H1 ──────────────────────── */
console.log('\nE. a ticket title carrying a region opener');

/**
 * Retitle the FIRST archived original — a real ticket, its real H1 extended —
 * and re-pin the staged record's `source` to it, because `promote()`'s gate
 * checks the record against the original it claims to derive from and would
 * otherwise refuse for an unrelated reason. This case is a title hazard, not a
 * provenance one.
 */
const caseTitle = {
  reasons: [...REAL],
  mutate: ({ dir, out }) => {
    const f = CORPUS.originals.filter((n) => /^ARCH-\d+-/.test(n)).sort()[0];
    const p = path.join(dir, f);
    const text = fs.readFileSync(p, 'utf8');
    const m = /^# (.*)$/m.exec(text);
    if (!m) throw new Error(`${f} has no H1 — the corpus this case drives has changed`);
    const newTitle = `${m[1]} <!-- and the 193 rows below me`;
    const retitled = text.replace(/^# .*$/m, `# ${newTitle}`);
    fs.writeFileSync(p, retitled);

    const rp = path.join(out, f);
    const { block, body } = extractTicketBlock(fs.readFileSync(rp, 'utf8'));
    if (block === null) throw new Error(`${f}'s staged record has no orchard-ticket block`);
    const rec = JSON.parse(block);
    rec.source.sha256 = createHash('sha256').update(retitled).digest('hex');
    rec.source.original_title = newTitle;
    fs.writeFileSync(rp, formatTicket(rec, body));
  },
};
const rTitle = runPromote(promote, caseTitle);
{
  const problems = gradeIndex(rTitle.index, { expectRows: 194, expectLegacy: 2 });
  ok('a title cannot hide the 193 rows beneath it', problems.length === 0, (problems.join(' / ') || 'clean') + (rTitle.code ? ` :: ${rTitle.log.split('\n').slice(-4).join(' / ')}` : ''));
  ok('promote() names the title it rewrote', /CELL ESCAPED\s+\S+\s+title/.test(rTitle.log),
    (rTitle.log.match(/CELL ESCAPED.*/) || ['none'])[0].slice(0, 90));
}

/* ── F. must-FAIL against a synthesized pre-fix generator ───────────────── */
console.log('\nF. non-vacuity — the same cases against the pre-fix generator');
const prefixFile = path.join(SCRATCH, 'pre-fix-generator.mjs');
{
  let src = fs.readFileSync(path.join(ROOT, 'scripts/migrate-tickets.mjs'), 'utf8');
  const before = src;
  src = src
    .replace('${escapeTableCell(r.reason)}', "${r.reason.replace(/\\|/g, '\\\\|')}")
    .replace('${escapeTableCell(r.title)}', "${r.title.replace(/\\|/g, '\\\\|')}");
  if (src === before) throw new Error('could not synthesize the pre-fix generator — the call sites moved');
  // Relative specifiers must resolve from a file outside scripts/. Rewriting
  // them is exactly the step whose silent failure the header warns about, which
  // is why the control case below must pass before any red here is graded.
  src = src.replace(/from '\.\/([^']+)'/g, (_, rel) => `from '${pathToFileURL(path.join(ROOT, 'scripts', rel)).href}'`)
    .replace(/from '\.\.\/([^']+)'/g, (_, rel) => `from '${pathToFileURL(path.join(ROOT, rel)).href}'`);
  fs.writeFileSync(prefixFile, src);
}
const { promote: prefixPromote } = await import(pathToFileURL(prefixFile).href);

// The control: the pre-fix generator LOADS, RUNS, and is correct on the corpus
// as it actually shipped. Without this, every red below could equally mean the
// copied module never imported.
const prefixControl = runPromote(prefixPromote, { reasons: [...REAL] });
const prefixLoaded = prefixControl.code === 0 && prefixControl.index === shipped;
ok('CONTROL — the pre-fix generator loads and reproduces the shipped index', prefixLoaded,
  prefixControl.code === 0 ? (prefixControl.index === shipped ? 'byte-identical' : 'ran but differs') : `exit ${prefixControl.code}`);

if (!prefixLoaded) {
  fails.push('non-vacuity is UNGRADED — the pre-fix control did not run, so a red below would prove nothing');
  console.log('  FAIL  non-vacuity ungraded — refusing to read the reds below as a must-FAIL proof');
} else {
  // Each case names the SIGNATURE of the corruption it is supposed to produce,
  // not merely "something went red". A broken variant that failed for any other
  // reason — a module that did not load, a gate that refused — would satisfy
  // `problems.length > 0` and prove nothing.
  const mustFail = [
    ['a newline in a reason', caseNewline,
      'the reason\'s own text escapes the table and becomes a heading in the document',
      (idx) => /^## Injected heading$/m.test(idx)],
    ['a `<!--` in a reason', caseComment,
      'the index opens an HTML comment that hides every row after it',
      (idx) => idx.includes('<!-- from here on, invisible')],
    ['a `<!--` in a real ticket title', caseTitle,
      'a row in the main table opens an HTML comment',
      (idx) => /^\| \[ARCH-\d+\].*<!-- and the 193 rows below me/m.test(idx)],
  ];
  for (const [label, kase, signature, matches] of mustFail) {
    const r = runPromote(prefixPromote, kase);
    ok(`pre-fix: ${label} — an index was still written`, r.index !== null, r.index === null ? 'nothing written' : `${Buffer.byteLength(r.index)} bytes`);
    const problems = r.index === null ? ['no index'] : gradeIndex(r.index, { expectRows: 194, expectLegacy: 2 });
    ok(`pre-fix: ${label} — corrupts the index`, problems.length > 0, problems.join(' / ') || 'NO PROBLEMS FOUND');
    ok(`pre-fix: ${label} — for the INTENDED reason: ${signature}`, r.index !== null && matches(r.index),
      problems.join(' / ') || 'no signature match');
    ok(`pre-fix: ${label} — and the promotion still exits 0`, r.code === 0, `exit ${r.code}`);
  }
}
fs.rmSync(SCRATCH, { recursive: true, force: true });

/* ═══════════════════════════════════════════════════════════════ verdict */
console.log(`\n${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.log('FAILED:');
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
