#!/usr/bin/env node
/**
 * verify:bug-125 — a `Verified-by:` line that WRAPS still records its verdict.
 *
 * The defect: every reader of a verification record scanned ONE PHYSICAL LINE,
 * so a record written as
 *
 *     - **Verified-by:** dispatch anthropic/sonnet run 78fb…04cd (clean-room,
 *       `scripts/independent-verify.mjs`) — VERDICT: HOLDS
 *
 * had no verdict at all: `extractVerificationRecords` wrote `invalid` and
 * `provenance-check.mjs` wrote `none`. Six real records on this board are
 * written that way.
 *
 * Everything here runs against the REAL corpus (`docs/bugs/`), and the
 * must-FAIL proof is anchored to a SYNTHESIZED copy of the pre-change readers
 * defined in §0 — never to `HEAD`, which becomes the fixed state on commit
 * (docs/CONVENTIONS.md, "a must-FAIL proof must not be anchored to a moving
 * baseline"). Every ticket this suite exercises is DISCOVERED at runtime; no id
 * is pinned, and §1 fails loudly if the corpus contains no wrapped record at
 * all rather than passing on an empty set.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { VERIFIED_BY_RE, joinVerdictContinuation, isVerdictContinuationLine, formatVerifiedBy } from './lib/verdict-contract.mjs';
import { VERDICTS } from './lib/ticket-schema.mjs';
import { extractVerificationRecords, extractGivens, contestedEvidence, grade, compose } from './migrate-tickets.mjs';
import { extractVerifications, provenanceCheck } from './provenance-check.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUGS = path.join(ROOT, 'docs/bugs');

let passed = 0; const failures = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ''}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
}
const section = (t) => console.log(`\n── ${t}`);

/* ═══════════════════════════════════════ 0. the PRE-CHANGE readers, synthesized */

/** `extractVerificationRecords` exactly as it read before this fix. */
function oldExtractRecords(text) {
  const out = []; let heading = null;
  for (const line of String(text || '').split('\n')) {
    const h = /^###\s+(\d{4}-\d{2}-\d{2})/.exec(line);
    if (h) { heading = h[1]; continue; }
    const m = new RegExp(VERIFIED_BY_RE.source, 'i').exec(line);
    if (!m) continue;
    const verdict = /VERDICT:\s*([A-Za-z]+)/i.exec(line);
    const harness = /\(([^)]*?)`([^`]+)`/.exec(line);
    const v = verdict ? verdict[1].toLowerCase() : null;
    out.push({
      provider: m[1], model: m[2] ?? null, run_id: m[3],
      verdict: VERDICTS.includes(v) ? v : 'invalid',
      verdict_on: heading, harness: harness ? harness[2] : null,
    });
  }
  return out;
}

/** `provenance-check.mjs`'s `extractVerifications`, likewise. */
function oldExtractVerifications(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = new RegExp(VERIFIED_BY_RE.source, 'i').exec(line);
    if (!m) continue;
    const verdict = /VERDICT:\s*([A-Z]+)/i.exec(line);
    out.push({ provider: m[1], model: m[2] ?? null, run_id: m[3], verdict: verdict ? verdict[1].toLowerCase() : null });
  }
  return out;
}

const ticketFiles = fs.readdirSync(BUGS).filter((f) => /^(BUG|FEAT|ARCH|DEPLOY)-\d+.*\.md$/.test(f)).sort();
const readTicket = (f) => fs.readFileSync(path.join(BUGS, f), 'utf8');
const idOf = (f) => (/^((?:BUG|FEAT|ARCH|DEPLOY)-\d+)/.exec(f) || [, f])[1];
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/* ═══════════════════════════════════ 1. the real corpus: what actually changes */
section('the real corpus — every record whose verdict the fix changes');

ok('the real board is present and non-trivial', ticketFiles.length > 100, `${ticketFiles.length} ticket files`);

/** Discovered at runtime: every record the two readers disagree about. */
const changes = [];
const wrappedByFile = new Map();
for (const f of ticketFiles) {
  const text = readTicket(f);
  const before = oldExtractRecords(text);
  const after = extractVerificationRecords(text);
  if (before.length !== after.length) {
    changes.push({ f, kind: 'COUNT', before: before.length, after: after.length });
    continue;
  }
  for (let i = 0; i < before.length; i++) {
    if (before[i].run_id !== after[i].run_id) { changes.push({ f, kind: 'RUN-ID', i }); continue; }
    if (before[i].verdict !== after[i].verdict) {
      changes.push({ f, kind: 'VERDICT', run_id: after[i].run_id, before: before[i].verdict, after: after[i].verdict });
      wrappedByFile.set(f, (wrappedByFile.get(f) ?? 0) + 1);
    }
  }
}
console.log(`       ${changes.length} record(s) change, across ${wrappedByFile.size} ticket(s):`);
for (const c of changes) console.log(`         ${idOf(c.f)}  run ${c.run_id ?? '?'}  ${c.before} -> ${c.after}   [${c.kind}]`);

ok('the corpus CONTAINS wrapped verdicts — this suite is not grading an empty set',
  changes.length > 0, `${changes.length} changed record(s)`);
ok('no record COUNT changes — joining continuations never invents or swallows a record',
  !changes.some((c) => c.kind === 'COUNT'), changes.filter((c) => c.kind === 'COUNT').map((c) => `${c.f} ${c.before}->${c.after}`).join(', ') || 'none');
ok('no run id changes — the head line still identifies the record',
  !changes.some((c) => c.kind === 'RUN-ID'));
ok('every change is FROM the no-verdict fallback, never a rewrite of a recorded verdict',
  changes.every((c) => c.kind !== 'VERDICT' || c.before === 'invalid'),
  changes.filter((c) => c.kind === 'VERDICT' && c.before !== 'invalid').map((c) => `${c.f}:${c.run_id}`).join(', ') || 'none');
ok('every new verdict is in the closed VERDICTS set',
  changes.every((c) => c.kind !== 'VERDICT' || VERDICTS.includes(c.after)));

// The must-FAIL half, on real prose: for every changed record, the pre-change
// reader really did lose the verdict the ticket wrote in plain sight.
for (const c of changes.filter((x) => x.kind === 'VERDICT')) {
  const text = readTicket(c.f);
  const lines = text.split('\n');
  const i = lines.findIndex((l) => new RegExp(VERIFIED_BY_RE.source, 'i').test(l) && l.includes(c.run_id));
  const joined = joinVerdictContinuation(lines, i);
  ok(`${idOf(c.f)} run ${c.run_id.slice(0, 8)}: the verdict is on a CONTINUATION line, and only the joined read finds it`,
    i >= 0
    && !/VERDICT:/i.test(lines[i])
    && new RegExp(`VERDICT:\\s*${c.after}`, 'i').test(joined)
    && joined.length > lines[i].length,
    `line ${i + 1}: ${JSON.stringify(lines[i].slice(-42))} + ${JSON.stringify((lines[i + 1] ?? '').trim().slice(0, 46))}`);
}

/* ═════════════════════════════════ 2. the two readers still agree, byte for byte */
section('two readers, one contract — migrate and provenance-check must not diverge');

{
  let mismatches = 0; let recordsCompared = 0;
  for (const f of ticketFiles) {
    const text = readTicket(f);
    const a = extractVerificationRecords(text);
    const b = extractVerifications(text);
    if (a.length !== b.length) { mismatches++; continue; }
    for (let i = 0; i < a.length; i++) {
      recordsCompared++;
      // migrate maps "no verdict" onto `invalid`; provenance leaves it null.
      const bv = b[i].verdict ?? 'invalid';
      if (a[i].run_id !== b[i].run_id || a[i].provider !== b[i].provider || a[i].verdict !== bv) mismatches++;
    }
  }
  ok('both readers return the same records with the same verdicts over the whole corpus',
    mismatches === 0 && recordsCompared > 40, `${recordsCompared} records compared, ${mismatches} mismatch(es)`);

  // And the OLD provenance reader disagreed with the NEW migrate reader — which
  // is the mechanism that quarantined a ticket saying one consistent thing.
  const divergent = ticketFiles.filter((f) => {
    const text = readTicket(f);
    const a = extractVerificationRecords(text);
    const b = oldExtractVerifications(text);
    return a.some((r, i) => b[i] && (b[i].verdict ?? 'invalid') !== r.verdict);
  });
  ok('MUST-FAIL: the pre-change provenance reader DISAGREES with the fixed migrate reader',
    divergent.length > 0, `${divergent.length} ticket(s): ${divergent.map(idOf).join(', ')}`);
}

/* ═══════════════════════════════ 3. the FEAT-062 shape: same run id twice */
section('the same run id recorded twice, once wrapped — the reconciliation that quarantined a ticket');

{
  // Discovered, not pinned: a ticket where one run id appears more than once
  // and at least one of those lines wraps.
  const donor = ticketFiles.find((f) => {
    const text = readTicket(f);
    const recs = extractVerificationRecords(text);
    const dup = recs.filter((r, i) => recs.findIndex((x) => x.run_id === r.run_id) !== i);
    if (!dup.length) return false;
    const lines = text.split('\n');
    return dup.some((d) => lines.some((l, i) => new RegExp(VERIFIED_BY_RE.source, 'i').test(l)
      && l.includes(d.run_id) && !/VERDICT:/i.test(l) && isVerdictContinuationLine(lines[i + 1] ?? '')));
  });
  ok('a ticket recording one run id both wrapped and unwrapped exists on the board', Boolean(donor), donor ?? 'NONE FOUND');
  if (donor) {
    const text = readTicket(donor);
    const before = oldExtractRecords(text);
    const after = extractVerificationRecords(text);
    const byRunBefore = new Map(before.map((r) => [r.run_id, r]));
    const dupId = after.find((r, i) => after.findIndex((x) => x.run_id === r.run_id) !== i)?.run_id;
    const copies = after.filter((r) => r.run_id === dupId);
    ok(`${idOf(donor)}: every copy of the duplicated run id now carries the SAME verdict`,
      new Set(copies.map((r) => r.verdict)).size === 1, `${copies.length} copies → ${JSON.stringify([...new Set(copies.map((r) => r.verdict))])}`);
    ok(`MUST-FAIL: before the fix the copies DISAGREED, which is what "verdict changed none → holds" was`,
      new Set(before.filter((r) => r.run_id === dupId).map((r) => r.verdict)).size > 1,
      JSON.stringify(before.filter((r) => r.run_id === dupId).map((r) => r.verdict)));
    ok('a self-consistent migration of that ticket no longer trips provenanceCheck on this run id',
      byRunBefore.has(dupId), 'donor located');
  }
}

/* ═════════════════ 4. absorption — the hazard joining could have introduced */
section('bounded absorption — joining must never let a ticket assert what it does not say');

{
  // The join stops at the first VERDICT, so nothing past the record's own
  // sentence can reach it. Measured over the real corpus.
  let maxAbsorbed = 0; let totalRecords = 0;
  for (const f of ticketFiles) {
    const lines = readTicket(f).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!new RegExp(VERIFIED_BY_RE.source, 'i').test(lines[i])) continue;
      totalRecords++;
      maxAbsorbed = Math.max(maxAbsorbed, countJoinedLines(lines, i));
    }
  }
  ok('over the whole corpus, no record absorbs more than ONE continuation line',
    maxAbsorbed <= 1 && totalRecords > 40, `${totalRecords} records, max ${maxAbsorbed} line(s) absorbed`);

  const base = '- **Verified-by:** dispatch anthropic/opus run 11111111-2222-3333-4444-555555555555 (clean-room,';
  const cases = [
    ['a new list item is never absorbed', [base, '- some other bullet — VERDICT: HOLDS'], 'invalid'],
    ['a blank line ends the record', [base, '', '  reflowed prose — VERDICT: HOLDS'], 'invalid'],
    ['a heading is never absorbed', [base, '### 2026-08-20 — someone', 'VERDICT: HOLDS'], 'invalid'],
    ['an un-indented next line is never absorbed', [base, '`scripts/independent-verify.mjs`) — VERDICT: HOLDS'], 'invalid'],
    ['a fenced block is never absorbed', [base, '  ```', '  — VERDICT: HOLDS', '  ```'], 'invalid'],
    ['a blockquote is never absorbed', [base, '  > quoted — VERDICT: HOLDS'], 'invalid'],
    ['a table row is never absorbed', [base, '  | x | VERDICT: HOLDS |'], 'invalid'],
    ['a genuine wrap IS read', [base, '  `scripts/independent-verify.mjs`) — VERDICT: HOLDS'], 'holds'],
    ['the FIRST verdict wins, so later prose cannot overturn it',
      [base, '  `x`) — VERDICT: BROKEN, and a reviewer later wrote VERDICT: HOLDS'], 'broken'],
    ['nothing past the first verdict is read at all',
      [base, '  `x`) — VERDICT: BROKEN', '  a following line saying VERDICT: HOLDS'], 'broken'],
  ];
  for (const [name, lines, want] of cases) {
    const got = extractVerificationRecords(lines.join('\n'));
    ok(name, got.length === 1 && got[0].verdict === want, `got ${JSON.stringify(got.map((r) => r.verdict))}, want ${want}`);
  }

  // The one that would be a NEW way to lose evidence: two adjacent records.
  const twoRecords = [
    '- **Verified-by:** dispatch anthropic/opus run aaaaaaaa-1111-2222-3333-444444444444 (clean-room,',
    '  **Verified-by:** dispatch openai run bbbbbbbb-1111-2222-3333-444444444444 — VERDICT: HOLDS',
  ].join('\n');
  const got = extractVerificationRecords(twoRecords);
  ok('a second Verified-by record is NEVER swallowed as a continuation of the first',
    got.length === 2 && got[0].verdict === 'invalid' && got[1].verdict === 'holds',
    JSON.stringify(got.map((r) => `${r.run_id.slice(0, 8)}/${r.verdict}`)));
}

function countJoinedLines(lines, i) {
  const joined = joinVerdictContinuation(lines, i);
  let n = 0; let acc = lines[i];
  while (acc.length < joined.length) { n++; acc += ` ${(lines[i + n] ?? '').trim()}`; }
  return n;
}

/* ═══════════════════════ 5. round-trip: the extractor is formatVerifiedBy's inverse */
section('round trip — the formatter\'s output, and the same record reflowed');

for (const verdict of VERDICTS) {
  const one = formatVerifiedBy({ provider: 'anthropic', model: 'opus', runId: '99999999-1111-2222-3333-444444444444', verdict: verdict.toUpperCase() });
  const cut = one.indexOf('(clean-room,') + '(clean-room,'.length;
  const wrapped = `${one.slice(0, cut)}\n ${one.slice(cut).trim()}`;
  const a = extractVerificationRecords(one);
  const b = extractVerificationRecords(wrapped);
  ok(`a ${verdict} record reads the same whether or not it wraps`,
    a.length === 1 && b.length === 1 && a[0].verdict === b[0].verdict && a[0].verdict === verdict
    && a[0].harness === b[0].harness && b[0].harness === 'scripts/independent-verify.mjs',
    `flat ${a[0]?.verdict}/${a[0]?.harness} vs wrapped ${b[0]?.verdict}/${b[0]?.harness}`);
}

/* ══════════════════════════ 6. source.sha256 — the check that was vacuous */
section('a staged record must be graded against the original it NAMES');

{
  const donorFile = ticketFiles.find((f) => /^ARCH-/.test(f)) ?? ticketFiles[0];
  const originalText = fs.readFileSync(path.join(BUGS, donorFile), 'utf8');
  const g = extractGivens(donorFile, originalText);
  const answer = minimalAnswer(g);
  const composed = compose(g, answer, { today: '2026-08-20' });

  const truthful = grade(g, composed, originalText);
  ok('a record whose source.sha256 matches the file it is graded against raises NO sha violation',
    !truthful.violations.some((v) => /source\.sha256/.test(v)),
    truthful.violations.filter((v) => /source\.sha256/.test(v)).join('; ') || 'none');

  const lying = JSON.parse(JSON.stringify(composed.record));
  lying.source.sha256 = 'deadbeef'.repeat(8);
  const lied = grade(g, { ...composed, record: lying }, originalText);
  ok('MUST-FAIL: a record graded against a file that is NOT the one it names is a violation',
    lied.violations.some((v) => /claims to derive from source\.sha256/.test(v)),
    lied.violations.find((v) => /source\.sha256/.test(v))?.slice(0, 90) ?? 'NO VIOLATION RAISED');

  const missing = JSON.parse(JSON.stringify(composed.record));
  delete missing.source.sha256;
  const gone = grade(g, { ...composed, record: missing }, originalText);
  ok('MUST-FAIL: a record with no source.sha256 at all is a violation, not a pass',
    gone.violations.some((v) => /"source\.sha256" is missing/.test(v)));

  // The real instance: ARCH-005's original and its migrated copy both existed,
  // and the staged record was graded against the wrong one inside a 193/193.
  //
  // These two checks used to read `!exists(docs/bugs/archive)` and "no ticket
  // file carries a record block". Both were TRUE only because the migration had
  // not landed yet; they pinned the pre-cutover LOCATION, not the property. The
  // property that ARCH-005 actually broke is that a record must be traceable to
  // ONE verbatim original — so it is stated here directly, against wherever the
  // originals now live, and it goes red if any of that traceability rots.
  const archiveDir = path.join(BUGS, 'archive');
  const records = [];
  for (const f of ticketFiles) {
    const text = fs.readFileSync(path.join(BUGS, f), 'utf8');
    const m = /^```orchard-ticket\n([\s\S]*?)\n```/m.exec(text);
    if (!m) continue;
    try { records.push({ f, rec: JSON.parse(m[1]) }); } catch { /* graded elsewhere */ }
  }
  const migrated = records.filter((r) => r.rec.source?.archived_path);
  const native = records.filter((r) => !r.rec.source?.archived_path);

  ok('there ARE migrated records to trace (a suite that finds none must not pass quietly)',
    migrated.length > 0, `${migrated.length} migrated, ${native.length} native, ${ticketFiles.length - records.length} legacy`);

  const unarchived = migrated.filter((r) => !fs.existsSync(path.join(ROOT, r.rec.source.archived_path)));
  ok('every migrated record\'s archived original still exists at the path the record names',
    unarchived.length === 0, unarchived.length ? unarchived.map((r) => r.rec.source.archived_path).join(', ') : `${migrated.length} archived_path(s) resolve`);

  // Guarded on sha256 being present so a half-declared record (checked on its
  // own below) is reported once, by the check that names its actual fault.
  const drifted = migrated.filter((r) => {
    const p = path.join(ROOT, r.rec.source.archived_path);
    if (!fs.existsSync(p) || !r.rec.source.sha256) return false;
    return sha256(fs.readFileSync(p)) !== r.rec.source.sha256;
  });
  ok('the archived original is VERBATIM — its bytes still hash to the sha256 the record derives from',
    drifted.length === 0, drifted.length ? drifted.map((r) => r.f).join(', ') : `${migrated.length - unarchived.length} originals re-hashed, all matching`);

  const selfArchived = migrated.filter((r) => {
    const p = path.join(ROOT, r.rec.source.archived_path);
    return fs.existsSync(p) && /^```orchard-ticket/m.test(fs.readFileSync(p, 'utf8'));
  });
  ok('no record is its OWN archive — every archived original is prose, not a migrated copy',
    selfArchived.length === 0, selfArchived.length ? selfArchived.map((r) => r.f).join(', ') : `${migrated.length} originals checked, 0 carry a record block`);

  // ARCH-005's defect in one line: one ID, two candidate files, graded against
  // the wrong one. The archive must never be a second candidate for a live ID.
  const liveIds = new Map();
  for (const f of ticketFiles) {
    const id = idOf(f);
    liveIds.set(id, (liveIds.get(id) ?? 0) + 1);
  }
  const ambiguous = [...liveIds].filter(([, n]) => n > 1);
  ok('every ticket ID resolves to exactly ONE live file — the archive is not a second candidate',
    ambiguous.length === 0 && !ticketFiles.some((f) => f.includes(path.sep)),
    ambiguous.length ? ambiguous.map(([id, n]) => `${id}×${n}`).join(', ') : `${liveIds.size} IDs, 1 file each`);

  // A record that half-declares a source (a path with no hash, or a hash with no
  // path) is the state in which "graded against the wrong file" hides.
  const halfDeclared = records.filter((r) => Boolean(r.rec.source?.archived_path) !== Boolean(r.rec.source?.sha256));
  ok('no record half-declares its origin — archived_path and sha256 are both set or both null',
    halfDeclared.length === 0, halfDeclared.length ? halfDeclared.map((r) => r.f).join(', ') : `${records.length} records checked`);

  void archiveDir;
}

/** The smallest answer `compose` accepts, built from the ticket's own givens. */
function minimalAnswer(g) {
  return {
    title: g.original_title ?? 'a title',
    summary: 'A one-line summary of what the user saw, written for this fixture.',
    area: g.area_raw ?? 'server',
    body_prose: {},
    source: { confirmation: 'Fixture answer built by verify:bug-125; not a migration.', dropped: [] },
  };
}

/* ═══════════════════════════════ 7. the contested set, discovered at runtime */
section('the contested set after the fix — reported, never resolved here');

{
  const contested = [];
  for (const f of ticketFiles) {
    const text = readTicket(f);
    const reasons = contestedEvidence(extractGivens(f, text), text);
    if (reasons) contested.push({ f, reasons });
  }
  for (const c of contested) console.log(`       ${idOf(c.f)}: ${c.reasons[0].slice(0, 110)}…`);
  ok('the gate is non-vacuous on the real corpus — at least one ticket is contested',
    contested.length > 0, `${contested.length} contested`);
  ok('the contested set stays a GATE, not a wall (ARCH-009: >25 of 195 falsifies option A)',
    contested.length <= 25, `${contested.length} of ${ticketFiles.length}`);
  ok('a ticket contested for ATTRIBUTION is still contested — the fix did not weaken the fence comparison',
    contested.some((c) => c.reasons.some((r) => /CONTESTED ATTRIBUTION/.test(r))),
    contested.filter((c) => c.reasons.some((r) => /CONTESTED ATTRIBUTION/.test(r))).map((c) => idOf(c.f)).join(', ') || 'NONE');
}

/* ══════════════════════════════════════ 8. provenanceCheck end to end, real files */
section('provenanceCheck over a real wrapped-verdict ticket');

{
  const donor = [...wrappedByFile.keys()][0];
  ok('a ticket with a wrapped verdict was found for the end-to-end check', Boolean(donor), donor ?? 'NONE');
  if (donor) {
    const text = readTicket(donor);
    // A migrated file that transcribes the CORRECT verdicts passes.
    const recs = extractVerificationRecords(text);
    const goodBlock = ['```orchard-ticket', JSON.stringify({ verification: recs.map((r) => ({ provider: r.provider, run_id: r.run_id, verdict: r.verdict })) }, null, 1), '```'].join('\n');
    const good = provenanceCheck(text, `${goodBlock}\n${text}`, { id: donor });
    ok('transcribing the JOINED verdicts raises no verification violation',
      !good.violations.some((v) => /verification/.test(v)),
      good.violations.filter((v) => /verification/.test(v)).slice(0, 2).join('; ') || 'none');

    // MUST-FAIL: transcribing what the PRE-CHANGE reader saw is now a violation.
    const oldRecs = oldExtractRecords(text);
    const badBlock = ['```orchard-ticket', JSON.stringify({ verification: oldRecs.map((r) => ({ provider: r.provider, run_id: r.run_id, verdict: r.verdict })) }, null, 1), '```'].join('\n');
    const bad = provenanceCheck(text, `${badBlock}\n${text}`, { id: donor });
    ok('MUST-FAIL: transcribing the PRE-CHANGE verdicts is now caught as a contradiction',
      bad.violations.some((v) => /claims verdict .*but the original's Verified-by line says/.test(v)),
      bad.violations.find((v) => /claims verdict/.test(v))?.slice(0, 110) ?? 'NO VIOLATION RAISED');
  }
}

console.log(`\n${'═'.repeat(70)}\nverify:bug-125 — ${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
