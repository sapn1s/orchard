#!/usr/bin/env node
/**
 * verify-feat-094-allow-legacy.mjs — the promotion gate's ONE recorded exception.
 *
 * FEAT-094 makes a mixed corpus a first-class state: a ticket NAMED in
 * `--allow-legacy` may stay in legacy format, and an UNNAMED one must still
 * refuse exactly as before. The refusal is the whole value of the flag — an
 * opt-out that quietly covers tickets nobody named is just a deleted gate — so
 * the case this suite exists for is #2: one of three legacy tickets is named and
 * the promotion still REFUSES, naming the other two.
 *
 * REAL ARTIFACTS, NOT A CONSTRUCTED CORPUS. Every fixture ticket is a real
 * ticket from this board paired with its real migrated record, copied into a
 * throwaway git repo in scratch. Before the cutover that pair is
 * (docs/bugs/<f>, <staging dir>/<f>); after it, it is (docs/bugs/archive/<f>,
 * docs/bugs/<f>) — the same two real files under new names. The suite discovers
 * whichever exists and FAILS LOUDLY if neither yields enough pairs, rather than
 * passing on an empty corpus.
 *
 * MUST-FAIL BASELINE, ANCHORED TO A PINNED SNAPSHOT, NOT TO HEAD. Section 8
 * runs the pre-change script itself — a byte-identical copy taken before the
 * edit and kept at $FEAT094_PRECHANGE — over the same fixture, and requires that
 * it cannot do this at all. A baseline of `git show HEAD:` would become the
 * FIXED state the moment the fix lands and could never fail again.
 *
 *   node scripts/verify-feat-094-allow-legacy.mjs
 *
 *   FEAT094_STAGING    staging dir holding the migrated records (pre-cutover)
 *   FEAT094_PRECHANGE  pinned pre-change copy of migrate-tickets.mjs (section 8)
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

import { TICKET_FILE_RE, extractTicketBlock, idFromFilename, parseTicket } from './lib/ticket-schema.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUGS = path.join(ROOT, 'docs/bugs');
/**
 * The build under test. Overridable so the suite itself can be shown to
 * discriminate: pointed at a deliberately LOOSENED build (one where the
 * allow-list covers every legacy ticket, named or not), section 2 must go RED.
 * A clean-room verifier can point it at any build for the same reason.
 */
const MIGRATE = process.env.FEAT094_BIN || path.join(HERE, 'migrate-tickets.mjs');
const SCRATCH_ROOT = process.env.MIGRATE_SCRATCH || path.join(os.homedir(), 'scratch');
const WORK = path.join(SCRATCH_ROOT, 'feat-094-allow-legacy');
const STAGING = process.env.FEAT094_STAGING || path.join(SCRATCH_ROOT, 'ticket-migration/staged-final');
const PRECHANGE = process.env.FEAT094_PRECHANGE
  || path.join(SCRATCH_ROOT, 'allow-legacy/pre-change/scripts/migrate-tickets.mjs');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t) { console.log(`\n── ${t}`); }
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* ════════════════════════════════════ real (original, record) pairs, either era */

function discoverPairs() {
  const archive = path.join(BUGS, 'archive');
  const isRecord = (t) => extractTicketBlock(t).block !== null;
  const out = [];
  const take = (file, originalPath, recordPath) => {
    const original = fs.readFileSync(originalPath, 'utf8');
    const record = fs.readFileSync(recordPath, 'utf8');
    if (!isRecord(record) || isRecord(original)) return;
    out.push({ file, original, record, era: originalPath.includes(`${path.sep}archive${path.sep}`) ? 'post-cutover' : 'pre-cutover' });
  };
  if (fs.existsSync(archive)) {
    for (const f of fs.readdirSync(archive).filter((x) => TICKET_FILE_RE.test(x)).sort()) {
      const live = path.join(BUGS, f);
      if (fs.existsSync(live)) take(f, path.join(archive, f), live);
    }
  }
  if (out.length < 6 && fs.existsSync(STAGING)) {
    for (const f of fs.readdirSync(STAGING).filter((x) => TICKET_FILE_RE.test(x)).sort()) {
      const live = path.join(BUGS, f);
      if (fs.existsSync(live)) take(f, live, path.join(STAGING, f));
    }
  }
  return out;
}

const pairs = discoverPairs();
section(`real (original, record) pairs discovered: ${pairs.length}${pairs.length ? ` [${pairs[0].era}]` : ''}`);
if (pairs.length < 6) {
  console.log(`  FAIL  no usable real corpus — need >= 6 (original, record) pairs, found ${pairs.length}.`);
  console.log(`        looked in ${path.join(BUGS, 'archive')} and ${STAGING}. This suite refuses to run on a synthesized one.`);
  process.exit(1);
}
ok('the fixture is built from real board tickets and their real records', pairs.length >= 6, `${pairs.length} pairs`);

/**
 * A throwaway git repo holding: `promoted` real tickets with their records,
 * `legacy` real tickets with NO record, and one real record placed as a live
 * ticket to stand for a ticket authored natively in the new format.
 */
function buildFixture({ promoted = 4, legacy = 3, nativeCount = 1, staleMarkerFor = null } = {}) {
  fs.rmSync(WORK, { recursive: true, force: true });
  const dir = path.join(WORK, 'docs/bugs');
  const out = path.join(WORK, 'staged');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  const used = pairs.slice(0, promoted + legacy + nativeCount);
  const P = used.slice(0, promoted);
  const L = used.slice(promoted, promoted + legacy);
  const N = used.slice(promoted + legacy);
  for (const p of P) {
    fs.writeFileSync(path.join(dir, p.file), p.original);
    fs.writeFileSync(path.join(out, p.file), p.record);
  }
  for (const p of L) fs.writeFileSync(path.join(dir, p.file), p.original);
  // Natively-authored: the record IS the live ticket file, and nothing is staged.
  for (const p of N) fs.writeFileSync(path.join(dir, p.file), p.record);
  if (staleMarkerFor) {
    fs.mkdirSync(path.join(out, 'failed'), { recursive: true });
    fs.writeFileSync(path.join(out, 'failed', `${staleMarkerFor}.violations.txt`), 'CONTESTED EVIDENCE: (a marker left by an earlier attempt)\n');
  }
  spawnSync('git', ['init', '-q', WORK], { encoding: 'utf8' });
  spawnSync('git', ['-C', WORK, 'add', '-A'], { encoding: 'utf8' });
  spawnSync('git', ['-C', WORK, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { encoding: 'utf8' });
  return {
    dir, out, promoted: P, legacy: L, native: N,
    ids: { promoted: P.map((p) => idFromFilename(p.file)), legacy: L.map((p) => idFromFilename(p.file)), native: N.map((p) => idFromFilename(p.file)) },
  };
}

function runPromote(fx, args, { bin = MIGRATE } = {}) {
  const r = spawnSync(process.execPath,
    [bin, '--promote', '--dir', fx.dir, '--out', fx.out, '--today', '2026-08-20', ...args],
    { cwd: WORK, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/* ═════════════════════════════════════ 1. the unchanged refusal: nobody named */
section('1. no allow-list — the gate refuses exactly as it always did');
{
  const fx = buildFixture();
  const r = runPromote(fx, []);
  ok('refuses when legacy tickets are left and none are named', r.status === 1, `exit ${r.status}`);
  ok('names every unnamed legacy ticket in the refusal',
    fx.ids.legacy.every((id) => r.out.includes(id)), r.out.slice(-400));
  ok('nothing moved: no archive dir was created', !fs.existsSync(path.join(fx.dir, 'archive')));
  ok('nothing moved: the staging dir is untouched',
    fs.readdirSync(fx.out).filter((f) => TICKET_FILE_RE.test(f)).length === fx.promoted.length);
}

/* ══════════════ 2. THE MUST-FAIL THAT MATTERS: a partially named legacy set */
section('2. one of three legacy tickets named — the promotion must STILL refuse');
{
  const fx = buildFixture();
  const [named, ...unnamed] = fx.ids.legacy;
  const r = runPromote(fx, ['--allow-legacy', `${named}=contested attribution, deliberately left behind`]);
  ok('an UNNAMED legacy ticket still refuses the whole promotion', r.status === 1, `exit ${r.status}\n${r.out.slice(-500)}`);
  ok('the refusal names the tickets that were NOT named', unnamed.every((id) => r.out.includes(id)), r.out.slice(-400));
  ok('nothing moved', !fs.existsSync(path.join(fx.dir, 'archive')));
  ok('the named ticket is not silently promoted either',
    fs.readFileSync(path.join(fx.dir, fx.legacy[0].file), 'utf8') === fx.legacy[0].original);
}

/* ═══════════════════════════════════════════ 3. every legacy ticket named: dry */
section('3. every legacy ticket named — dry run passes and moves nothing');
{
  const fx = buildFixture();
  const args = fx.ids.legacy.flatMap((id) => ['--allow-legacy', `${id}=its own evidence is contested; no migration exists that is not a guess`]);
  const r = runPromote(fx, args);
  ok('dry run succeeds', r.status === 0, `exit ${r.status}\n${r.out.slice(-500)}`);
  ok('it reports only the staged tickets as ready', new RegExp(`PROMOTION DRY RUN — ${fx.promoted.length} tickets ready`).test(r.out), r.out.slice(0, 300));
  ok('it names each deliberately-legacy ticket AND its reason',
    fx.ids.legacy.every((id) => new RegExp(`LEGACY, BY DECISION\\s+${id}\\b.*contested`).test(r.out)), r.out.slice(-600));
  ok('it names the natively-authored record as needing no migration',
    fx.ids.native.every((id) => new RegExp(`ALREADY A RECORD\\s+${id}\\b`).test(r.out)), r.out.slice(-600));
  ok('a dry run still moves nothing', !fs.existsSync(path.join(fx.dir, 'archive')));
}

/* ═════════════════════════════════════════ 4. every legacy ticket named: apply */
section('4. --apply on a mixed corpus');
{
  const fx = buildFixture();
  const args = fx.ids.legacy.flatMap((id) => ['--allow-legacy', `${id}=contested evidence: fence-aware and fence-blind readers disagree`]);
  const r = runPromote(fx, [...args, '--apply']);
  const archive = path.join(fx.dir, 'archive');
  const archived = fs.existsSync(archive) ? fs.readdirSync(archive).filter((f) => TICKET_FILE_RE.test(f)).sort() : [];
  ok('apply succeeds', r.status === 0, `exit ${r.status}\n${r.out.slice(-600)}`);
  ok('the archive count equals the promoted count, and only the promoted are in it',
    archived.length === fx.promoted.length && archived.join() === fx.promoted.map((p) => p.file).sort().join(),
    `${archived.length} archived vs ${fx.promoted.length} promoted`);
  ok('every archived original is BYTE-IDENTICAL to what it was',
    fx.promoted.every((p) => fs.readFileSync(path.join(archive, p.file), 'utf8') === p.original));
  ok("each archived original's sha256 is the one its own record pins",
    fx.promoted.every((p) => {
      const rec = JSON.parse(extractTicketBlock(fs.readFileSync(path.join(fx.dir, p.file), 'utf8')).block);
      return rec.source?.sha256 === sha(fs.readFileSync(path.join(archive, p.file), 'utf8'));
    }));
  ok('the live path now holds the record, and it parses strictly',
    fx.promoted.every((p) => parseTicket(fs.readFileSync(path.join(fx.dir, p.file), 'utf8'), { file: p.file, mode: 'strict' }).ok));

  ok('every deliberately-legacy ticket is STILL THERE, byte-identical, in legacy format',
    fx.legacy.every((p) => fs.readFileSync(path.join(fx.dir, p.file), 'utf8') === p.original));
  ok('no deliberately-legacy ticket was archived',
    fx.legacy.every((p) => !fs.existsSync(path.join(archive, p.file))));
  ok('the natively-authored record was neither archived nor overwritten',
    fx.native.every((p) => !fs.existsSync(path.join(archive, p.file))
      && fs.readFileSync(path.join(fx.dir, p.file), 'utf8') === p.record));

  const idx = fs.readFileSync(path.join(archive, 'INDEX.md'), 'utf8');
  ok('archive/INDEX.md lists every promoted original with its sha256',
    fx.promoted.every((p) => idx.includes(p.file) && idx.includes(sha(p.original))));
  ok('archive/INDEX.md records the deliberately-legacy set, with reasons',
    /Deliberately NOT migrated/.test(idx)
    && fx.ids.legacy.every((id) => new RegExp(`\\|\\s*${id}\\s*\\|.*fence-aware`).test(idx)), idx.slice(-700));
  ok('archive/INDEX.md does NOT list a legacy ticket as an archived original',
    fx.legacy.every((p) => !new RegExp(`\\[${idFromFilename(p.file)}\\]\\(${p.file.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}\\)`).test(idx)));
  ok('the staging dir is drained', fs.readdirSync(fx.out).filter((f) => TICKET_FILE_RE.test(f)).length === 0);
  const st = spawnSync('git', ['-C', WORK, 'status', '--porcelain'], { encoding: 'utf8' }).stdout;
  ok('the archived originals are staged as git renames, not deletions',
    fx.promoted.every((p) => new RegExp(`^R.*${p.file.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}`, 'm').test(st)), st.slice(0, 600));
  ok('git sees no change at all to a deliberately-legacy ticket',
    fx.legacy.every((p) => !st.includes(`docs/bugs/${p.file}`)), st.slice(0, 600));
}

/* ════════════════════════════════════════════════════ 5. operator error refuses */
section('5. an allow-list entry that names the wrong thing refuses, loudly');
{
  const fx = buildFixture();
  const all = fx.ids.legacy.flatMap((id) => ['--allow-legacy', id]);
  const bogus = runPromote(fx, [...all, '--allow-legacy', 'BUG-9999']);
  ok('naming a ticket that does not exist refuses (a typo cannot silently cover nothing)',
    bogus.status === 1 && /BUG-9999/.test(bogus.out), bogus.out.slice(-300));
  const staged = runPromote(fx, [...all, '--allow-legacy', fx.ids.promoted[0]]);
  ok('naming a ticket that HAS a record refuses rather than leaving it behind',
    staged.status === 1 && new RegExp(`${fx.ids.promoted[0]}, but it HAS a staged record`).test(staged.out), staged.out.slice(-300));
  const native = runPromote(fx, [...all, '--allow-legacy', fx.ids.native[0]]);
  ok('naming a natively-authored record refuses — it is not legacy',
    native.status === 1 && /already carries an orchard-ticket block/.test(native.out), native.out.slice(-300));
  ok('none of the three refusals moved anything', !fs.existsSync(path.join(fx.dir, 'archive')));
}

/* ══════════════════════════════ 6. quarantine markers: named passes, stale ignored */
section('6. quarantine markers');
{
  const fx = buildFixture({ staleMarkerFor: null });
  const legacyId = fx.ids.legacy[0];
  fs.mkdirSync(path.join(fx.out, 'failed'), { recursive: true });
  fs.writeFileSync(path.join(fx.out, 'failed', `${legacyId}.violations.txt`), 'CONTESTED EVIDENCE: the ticket disagrees with its own evidence\n');
  const unnamed = runPromote(fx, fx.ids.legacy.slice(1).flatMap((id) => ['--allow-legacy', id]));
  ok('a QUARANTINED ticket that is not named still refuses',
    unnamed.status === 1 && unnamed.out.includes(legacyId), unnamed.out.slice(-400));
  const named = runPromote(fx, fx.ids.legacy.flatMap((id) => ['--allow-legacy', `${id}=contested`]));
  ok('a quarantined ticket that IS named is permitted', named.status === 0, named.out.slice(-400));

  // The hand-workaround this replaces: six stale markers were physically moved
  // out of the staging dir so the gate would stop refusing on tickets that were
  // sitting, valid, in the set.
  const fx2 = buildFixture({ staleMarkerFor: null });
  fs.mkdirSync(path.join(fx2.out, 'failed'), { recursive: true });
  fs.writeFileSync(path.join(fx2.out, 'failed', `${fx2.ids.promoted[0]}.violations.txt`), 'an earlier attempt failed; this run succeeded\n');
  const stale = runPromote(fx2, fx2.ids.legacy.flatMap((id) => ['--allow-legacy', `${id}=contested`]));
  ok('a marker left over for a ticket that IS staged no longer blocks the promotion',
    stale.status === 0, stale.out.slice(-400));
}

/* ═════════════════════════════════════════════════ 7. the flag parses as documented */
section('7. flag parsing');
{
  const fx = buildFixture();
  const [a, b, c] = fx.ids.legacy;
  const commas = runPromote(fx, ['--allow-legacy', `${a},${b},${c}`]);
  ok('a comma-separated list of bare ids is accepted', commas.status === 0, commas.out.slice(-300));
  ok('a bare id records no reason rather than inventing one',
    /LEGACY, BY DECISION.*\(no reason recorded\)/.test(commas.out), commas.out.slice(-400));
  const comma = runPromote(fx, ['--allow-legacy', `${a}=its Repro quotes a verdict line, so readers disagree, legitimately`,
    '--allow-legacy', `${b},${c}`]);
  ok('a reason containing a comma is not split into bogus ids',
    comma.status === 0 && /so readers disagree, legitimately/.test(comma.out), comma.out.slice(-400));
}

/* ═════════════════ 8. must-FAIL against the PINNED pre-change script (not HEAD) */
section('8. the pinned pre-change script cannot do this — the capability is new');
{
  if (!fs.existsSync(PRECHANGE)) {
    ok('the pinned pre-change snapshot exists', false, `no file at ${PRECHANGE} — set FEAT094_PRECHANGE`);
  } else {
    const fx = buildFixture();
    const args = fx.ids.legacy.flatMap((id) => ['--allow-legacy', `${id}=contested`]);
    const withFlag = runPromote(fx, args, { bin: PRECHANGE });
    ok('pre-change: the flag does not exist at all',
      withFlag.status === 2 && /unknown argument .*--allow-legacy/.test(withFlag.out), `exit ${withFlag.status}: ${withFlag.out.slice(-300)}`);
    const without = runPromote(fx, [], { bin: PRECHANGE });
    ok('pre-change: the same corpus is refused outright, all-or-nothing',
      without.status === 1 && /no staged counterpart/.test(without.out), `exit ${without.status}: ${without.out.slice(-300)}`);
    ok('pre-change: it also refuses the natively-authored record (why the rule was needed)',
      without.out.includes(fx.ids.native[0]), without.out.slice(-400));
    ok('pre-change: nothing moved', !fs.existsSync(path.join(fx.dir, 'archive')));
  }
}

fs.rmSync(WORK, { recursive: true, force: true });

console.log(`\n${'═'.repeat(70)}`);
console.log(`verify-feat-094-allow-legacy: ${pass} passed, ${fail} failed`);
if (fail) { console.log('failed:'); for (const f of failures) console.log(`  - ${f}`); }
process.exit(fail ? 1 : 0);
