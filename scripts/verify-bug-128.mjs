#!/usr/bin/env node
/**
 * BUG-128 — a ticket related to ITSELF.
 *
 *   npm run verify:bug-128
 *
 * Two halves, and they fail in opposite directions:
 *
 *   - one self-edge is LIVE on the board (`FEAT-084 --see_also--> FEAT-084`).
 *     It came out of the migration, not out of `--reconcile`, and neither the
 *     reconciler nor the validation gate said a word about it;
 *   - `reconcileRelations` will MANUFACTURE one. Given `A --blocks--> A` it
 *     looks up the inverse, finds the target is A, and writes
 *     `A --depends_on--> A` — a repair pass turning one defect into two.
 *
 * WHAT THIS SUITE RUNS AGAINST. The real board for the sweep (an invariant over
 * whatever is on it today, not a pinned count), and the real 194-record corpus
 * at the cutover commit for the reconciler — pinned, because the live records
 * keep being appended to and a suite that reddens when someone uses the product
 * correctly trains everyone to ignore it (docs/CONVENTIONS.md).
 *
 * NON-VACUITY. Group F synthesizes PRE-FIX variants of both files — the guard
 * blocks cut back out — and requires each to fail with the signature this fix
 * exists to remove. Each variant is gated on a CONTROL that proves it LOADED
 * and still does its normal job: a copied module that cannot resolve its
 * imports reddens everything and looks exactly like a real regression.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { mkdtempScratch } from './lib/scratch.mjs';
import { extractTicketBlock, formatTicket, idsMatch, validateTicket } from './lib/ticket-schema.mjs';
import { reconcileRelations } from './migrate-tickets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUGS = path.join(ROOT, 'docs/bugs');
const CUTOVER = 'f109aa8';
const SCRATCH = mkdtempScratch('verify-bug-128-');

let pass = 0; const fails = [];
const ok = (name, cond, observed) => {
  if (cond) { pass++; console.log(`  PASS  ${name}  [${observed}]`); }
  else { fails.push(name); console.log(`  FAIL  ${name}  [observed: ${observed}]`); }
};

/** Every record on the real board today, live and archived. */
function realRecords() {
  const out = [];
  for (const dir of [BUGS, path.join(BUGS, 'archive')]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const file = path.join(dir, f);
      const { block, body } = extractTicketBlock(fs.readFileSync(file, 'utf8'));
      if (block === null) continue;
      try { out.push({ file, record: JSON.parse(block), body }); } catch { /* malformed is another check's job */ }
    }
  }
  return out;
}

/** The records at the cutover, as a staging dir `reconcileRelations` can be pointed at. */
let corpusSeq = 0;
function stagedCorpus(mutate = null) {
  const at = path.join(SCRATCH, `staged-${corpusSeq += 1}`);
  fs.mkdirSync(at, { recursive: true });
  const r = spawnSync('sh', ['-c',
    `git -C ${JSON.stringify(ROOT)} archive ${CUTOVER} docs/bugs | tar -x -C ${JSON.stringify(at)}`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`could not export the corpus at ${CUTOVER}: ${r.stderr}`);
  const out = path.join(at, 'docs/bugs');
  fs.rmSync(path.join(out, 'archive'), { recursive: true, force: true });
  const n = fs.readdirSync(out).filter((f) => f.endsWith('.md')).length;
  if (n < 100) throw new Error(`the corpus at ${CUTOVER} holds ${n} records — that is not the real board`);
  if (mutate) mutate(out);
  return out;
}

/** Read a staged record back off disk. */
const readStaged = (dir, file) => JSON.parse(extractTicketBlock(fs.readFileSync(path.join(dir, file), 'utf8')).block);

/** Write a self-edge onto a REAL record in a staging dir; return the file it chose. */
function injectSelfEdge(dir, relation) {
  // Chosen at runtime, not named: any record with a `related` array will do,
  // and naming one couples the suite to a ticket that may be re-filed.
  const file = fs.readdirSync(dir).filter((f) => /^(ARCH|BUG|FEAT|DEPLOY)-\d+-.*\.md$/.test(f)).sort()
    .find((f) => {
      const { block } = extractTicketBlock(fs.readFileSync(path.join(dir, f), 'utf8'));
      return block !== null && Array.isArray(JSON.parse(block).related);
    });
  if (!file) throw new Error('no record in the corpus carries a related[] array — nothing to drive this case onto');
  const p = path.join(dir, file);
  const { block, body } = extractTicketBlock(fs.readFileSync(p, 'utf8'));
  const rec = JSON.parse(block);
  rec.related.push({ id: rec.id, relation });
  fs.writeFileSync(p, formatTicket(rec, body));
  return { file, id: rec.id };
}

/* ═══════════════════════════════════════════════════════════════════ cases */

console.log('BUG-128 — a ticket cannot be related to itself\n');

/* ── A. the comparison the guard turns on ───────────────────────────────── */
console.log('A. two ids name the same ticket');
const SAME = [['FEAT-084', 'FEAT-084'], ['feat-084', 'FEAT-084'], ['FEAT-84', 'FEAT-084'], [' FEAT-084 ', 'FEAT-084']];
const DIFFERENT = [['FEAT-084', 'FEAT-085'], ['BUG-084', 'FEAT-084'], ['FEAT-084', 'FEAT-0840'], ['FEAT-084', ''], [null, null], ['FEAT-084', 'FEAT-084-response-format']];
for (const [a, b] of SAME) ok(`${JSON.stringify(a)} is ${JSON.stringify(b)}`, idsMatch(a, b), 'match');
for (const [a, b] of DIFFERENT) ok(`${JSON.stringify(a)} is NOT ${JSON.stringify(b)}`, !idsMatch(a, b), 'no match');

/* ── B. validation rejects a self-edge, on a real record ────────────────── */
console.log('\nB. the validation gate, driven onto a real record');
const REAL_RECORDS = realRecords();
ok('the board holds records to test against', REAL_RECORDS.length > 100, `${REAL_RECORDS.length} records`);
{
  const subject = REAL_RECORDS.find((r) => Array.isArray(r.record.related));
  const clean = { ...subject.record, body: subject.body };
  const cleanV = validateTicket({ ...clean }, { file: path.basename(subject.file) });
  ok('the real record validates as it stands', cleanV.ok, `${path.basename(subject.file)}: ${cleanV.violations.length} violations`);

  for (const relation of ['see_also', 'blocks', 'duplicate_of', 'supersedes']) {
    const dirty = { ...clean, related: [...clean.related, { id: clean.id, relation }] };
    const v = validateTicket(dirty, { file: path.basename(subject.file) });
    const named = v.violations.filter((x) => /points at this ticket itself/.test(x));
    ok(`a \`${relation}\` edge to itself is rejected, and the violation says so`,
      !v.ok && named.length === 1, named[0] ?? `ok=${v.ok}, violations: ${v.violations.join(' / ')}`);
  }
  // The evasions the check must not be walked around by.
  for (const written of ['feat-084'.replace('feat-084', clean.id.toLowerCase()), clean.id.replace(/-0*(\d+)$/, '-$1')]) {
    const v = validateTicket({ ...clean, related: [...clean.related, { id: written, relation: 'see_also' }] }, { file: path.basename(subject.file) });
    ok(`a self-edge written as ${JSON.stringify(written)} is still rejected`,
      v.violations.some((x) => /points at this ticket itself/.test(x)), written);
  }
  // And an ordinary edge to a DIFFERENT ticket must stay legal, or the guard
  // has bought its green by rejecting everything.
  const other = REAL_RECORDS.find((r) => r.record.id !== clean.id).record.id;
  const v = validateTicket({ ...clean, related: [...clean.related, { id: other, relation: 'see_also' }] }, { file: path.basename(subject.file) });
  ok('an edge to a different ticket is still accepted', v.ok, `${clean.id} -> ${other}`);
}

/* ── C. the real board carries no self-edge ─────────────────────────────── */
console.log('\nC. the real board, swept');
{
  const found = [];
  let edges = 0;
  for (const { file, record } of REAL_RECORDS) {
    for (const rel of Array.isArray(record.related) ? record.related : []) {
      edges++;
      if (rel && idsMatch(rel.id, record.id)) found.push(`${path.basename(file)} -> ${rel.id} (${rel.relation})`);
    }
  }
  ok('the sweep actually looked at edges', edges > 100, `${edges} edges across ${REAL_RECORDS.length} records`);
  ok('no record on the board is related to itself', found.length === 0, found.join(' / ') || 'none');
}

/* ── D. the reconciler refuses to manufacture one ───────────────────────── */
console.log('\nD. back-edge reconciliation over the real corpus');
{
  // The corpus AS PROMOTED still carries the self-edge, because the repair went
  // onto the live board and not into history. That is the evidence, not a
  // nuisance: it is where the edge came from. `--reconcile` ran over this exact
  // set and said nothing about it.
  const asPromoted = reconcileRelations({ out: stagedCorpus() });
  ok('the corpus at the cutover is already reconciled, so a clean run adds nothing',
    asPromoted.added === 0, `${asPromoted.files} records, ${asPromoted.added} added, ${asPromoted.dangling.length} dangling`);
  ok('the promoted corpus carries exactly the one self-edge the MIGRATION authored',
    asPromoted.selfEdges.length === 1 && asPromoted.selfEdges[0].startsWith('FEAT-084 -> itself (see_also)'),
    asPromoted.selfEdges.join(' / ') || 'none');
  const DANGLING = asPromoted.dangling.length;

  /** The corpus with the historical self-edge repaired — i.e. the board as it stands now. */
  const repair = (dir) => {
    const f = fs.readdirSync(dir).find((n) => n.startsWith('FEAT-084-'));
    const p = path.join(dir, f);
    const { block, body } = extractTicketBlock(fs.readFileSync(p, 'utf8'));
    const rec = JSON.parse(block);
    rec.related = rec.related.filter((rel) => !idsMatch(rel.id, rec.id));
    fs.writeFileSync(p, formatTicket(rec, body));
  };
  const repaired = reconcileRelations({ out: stagedCorpus(repair) });
  ok('with that one edge removed, the corpus reports no self-edge at all',
    repaired.selfEdges.length === 0 && repaired.added === 0 && repaired.dangling.length === DANGLING,
    `${repaired.selfEdges.length} self-edges, ${repaired.added} added, ${repaired.dangling.length} dangling`);

  for (const relation of ['blocks', 'see_also', 'supersedes']) {
    let injected = null;
    const dir = stagedCorpus((d) => { repair(d); injected = injectSelfEdge(d, relation); });
    const r = reconcileRelations({ out: dir });
    const after = readStaged(dir, injected.file);
    const selfEdgesLeft = after.related.filter((rel) => idsMatch(rel.id, injected.id));
    ok(`a \`${relation}\` self-edge is reported, not propagated`,
      r.selfEdges.length === 1 && r.selfEdges[0].includes(injected.id), r.selfEdges.join(' / ') || 'NOT REPORTED');
    ok(`no inverse self-edge is written back onto ${injected.id}`,
      selfEdgesLeft.length === 1 && selfEdgesLeft[0].relation === relation,
      JSON.stringify(selfEdgesLeft));
    // The rest of the pass must still be correct: one bad edge does not license
    // dropping the other 767.
    ok(`the other edges are untouched by the refusal (${relation})`,
      r.added === 0 && r.dangling.length === DANGLING,
      `${r.added} added, ${r.dangling.length} dangling (baseline ${DANGLING})`);
  }

  // A second pass over an unchanged set must still change nothing.
  const idem = stagedCorpus(repair);
  reconcileRelations({ out: idem });
  const second = reconcileRelations({ out: idem });
  ok('reconciliation is still idempotent', second.added === 0, `${second.added} added on the second pass`);
}

/* ── E. the CLI stops on a self-edge instead of reporting success ───────── */
console.log('\nE. `--reconcile` as it is actually run');
{
  const repair = (dir) => {
    const f = fs.readdirSync(dir).find((n) => n.startsWith('FEAT-084-'));
    const p = path.join(dir, f);
    const { block, body } = extractTicketBlock(fs.readFileSync(p, 'utf8'));
    const rec = JSON.parse(block);
    rec.related = rec.related.filter((rel) => !idsMatch(rel.id, rec.id));
    fs.writeFileSync(p, formatTicket(rec, body));
  };
  const run = (dir) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/migrate-tickets.mjs'), '--reconcile', '--out', dir], { encoding: 'utf8' });

  const clean = run(stagedCorpus(repair));
  ok('a corpus with no self-edge still exits 0', clean.status === 0, `exit ${clean.status}`);

  // The corpus exactly as it was promoted — the run that actually happened,
  // which reported success. It must now stop.
  const asShipped = run(stagedCorpus());
  ok('the run over the corpus AS PROMOTED now stops instead of reporting success',
    asShipped.status !== 0 && asShipped.stdout.includes('FEAT-084'), `exit ${asShipped.status}`);

  let injected = null;
  const dirty = stagedCorpus((d) => { repair(d); injected = injectSelfEdge(d, 'blocks'); });
  const r = run(dirty);
  ok('a self-edge makes the run exit non-zero', r.status !== 0, `exit ${r.status}`);
  ok('and it is named on stdout, with the ticket', /SELF-EDGE/.test(r.stdout) && r.stdout.includes(injected.id),
    (r.stdout.split('\n').find((l) => l.includes('SELF-EDGE')) ?? 'nothing printed').trim());
}

/* ── F. must-FAIL against synthesized pre-fix variants ──────────────────── */
console.log('\nF. non-vacuity — the same cases against pre-fix code');

/** Copy a module out of scripts/, cutting `mutate` out of it, with imports re-resolved. */
function preFix(relFile, name, mutate) {
  let src = fs.readFileSync(path.join(ROOT, relFile), 'utf8');
  const before = src;
  src = mutate(src);
  if (src === before) throw new Error(`could not synthesize ${name} — the guard moved; this suite must be updated, not skipped`);
  src = src
    .replace(/from '\.\/([^']+)'/g, (_, rel) => `from '${pathToFileURL(path.join(ROOT, 'scripts', rel)).href}'`)
    .replace(/from '\.\.\/([^']+)'/g, (_, rel) => `from '${pathToFileURL(path.join(ROOT, rel)).href}'`);
  const at = path.join(SCRATCH, `${name}.mjs`);
  fs.writeFileSync(at, src);
  return at;
}

// F1 — the validator without its self-edge block.
{
  const file = preFix('scripts/lib/ticket-schema.mjs', 'pre-fix-schema', (src) => {
    const start = src.indexOf('      // BUG-128 — a ticket related to ITSELF.');
    const end = src.indexOf('    });', start);
    if (start < 0 || end < 0) return src;
    return src.slice(0, start) + src.slice(end);
  });
  const old = await import(pathToFileURL(file).href);
  const subject = REAL_RECORDS.find((r) => Array.isArray(r.record.related));
  const clean = { ...subject.record, body: subject.body };

  // CONTROL: the module loaded and its OTHER checks still work. Without this a
  // red below is indistinguishable from a module that never imported.
  const controlOk = old.validateTicket({ ...clean }, { file: 'x.md' }).ok;
  const controlBad = old.validateTicket({ ...clean, related: [{ id: 'NOT-A-TICKET', relation: 'see_also' }] }, { file: 'x.md' });
  const loaded = controlOk === true && controlBad.ok === false;
  ok('CONTROL — the pre-fix validator loads, passes a real record and still rejects a bad id',
    loaded, `clean=${controlOk}, badId rejected=${!controlBad.ok}`);
  if (!loaded) {
    fails.push('F1 is UNGRADED — the pre-fix validator did not run, so a red below would prove nothing');
    console.log('  FAIL  F1 ungraded');
  } else {
    const v = old.validateTicket({ ...clean, related: [...clean.related, { id: clean.id, relation: 'see_also' }] }, { file: 'x.md' });
    ok('pre-fix: a self-edge passes validation silently — for the INTENDED reason, no violation names it',
      v.ok === true && !v.violations.some((x) => /itself/.test(x)), `ok=${v.ok}, violations=${JSON.stringify(v.violations)}`);
  }
}

// F2 — the reconciler without its self-edge guard.
{
  const file = preFix('scripts/migrate-tickets.mjs', 'pre-fix-reconcile', (src) => {
    const start = src.indexOf('      // BUG-128 — a self-edge is REPORTED and never propagated.');
    const end = src.indexOf('      const inverse = RELATION_INVERSE[rel.relation];', start);
    if (start < 0 || end < 0) return src;
    return src.slice(0, start) + src.slice(end);
  });
  const old = await import(pathToFileURL(file).href);

  // CONTROL: it loads and still does the reconciler's normal job on the real
  // corpus — same record count, same dangling set, nothing invented.
  const cleanDir = stagedCorpus();
  const controlRun = old.reconcileRelations({ out: cleanDir });
  const loaded = controlRun.files > 100 && controlRun.added === 0;
  ok('CONTROL — the pre-fix reconciler loads and reconciles the real corpus normally',
    loaded, `${controlRun.files} records, ${controlRun.added} added, ${controlRun.dangling.length} dangling`);
  if (!loaded) {
    fails.push('F2 is UNGRADED — the pre-fix reconciler did not run, so a red below would prove nothing');
    console.log('  FAIL  F2 ungraded');
  } else {
    const dir = stagedCorpus();
    const { file: f, id } = injectSelfEdge(dir, 'blocks');
    const r = old.reconcileRelations({ out: dir });
    const after = readStaged(dir, f);
    const made = after.related.filter((rel) => idsMatch(rel.id, id) && rel.relation === 'depends_on');
    ok('pre-fix: `A blocks A` MANUFACTURES `A depends_on A` — the exact signature this fix removes',
      made.length === 1, `${made.length} manufactured: ${JSON.stringify(made)}`);
    ok('pre-fix: and it reports nothing — not dangling, not anything',
      r.dangling.length === controlRun.dangling.length && (r.selfEdges === undefined || r.selfEdges.length === 0),
      `${r.added} added, ${r.dangling.length} dangling (baseline ${controlRun.dangling.length})`);
  }
}

fs.rmSync(SCRATCH, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.log('FAILED:');
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
