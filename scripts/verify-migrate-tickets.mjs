#!/usr/bin/env node
/**
 * verify-migrate-tickets.mjs — the migration pipeline's own harness.
 *
 * WHAT IT IS AND IS NOT. This grades the PIPELINE — its extraction, its
 * acceptance gate, its retry, its quarantine, its refusal to write anything
 * half-migrated, and its promise that no original is ever touched. It does NOT
 * grade the model's prose: §6 draws that line deliberately and content
 * preservation rides on `source.confirmation` plus a human sample.
 *
 * It runs against the REAL corpus (all 186 tickets in docs/bugs) wherever a real
 * artifact exists, and drives the full dispatch loop through a scripted
 * responder over the fixture seam (`MIGRATE_DISPATCH_BIN`) where a live model
 * call would be the only alternative.
 *
 * MUST-FAIL cases are first-class here: a gate that cannot be made to fail is
 * not a gate. §6.1 names two (a mangled run id, an empty migrated file); this
 * adds the ones the pipeline's own copy paths need.
 *
 *   node scripts/verify-migrate-tickets.mjs
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

import { TICKET_FILE_RE, parseTicket } from './lib/ticket-schema.mjs';
import { extractVerifications, provenanceOf } from './provenance-check.mjs';
import {
  buildPrompt, compose, extractGivens, extractJson, extractVerificationRecords,
  grade, reconcileRelations, splitAtActivityLog, validateSet,
} from './migrate-tickets.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUGS = path.join(ROOT, 'docs/bugs');
/** Persistent scratch, same filesystem as the repo, never inside it, never /tmp. */
const SCRATCH_ROOT = process.env.MIGRATE_SCRATCH || path.join(os.homedir(), 'scratch');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t) { console.log(`\n── ${t}`); }

const ticketFiles = fs.readdirSync(BUGS).filter((f) => TICKET_FILE_RE.test(f)).sort();
const readOrig = (f) => fs.readFileSync(path.join(BUGS, f), 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** A well-formed model answer for one ticket, built from its own givens. */
function goodAnswer(g, over = {}) {
  const done = ['verified', 'done'].includes(g.work_state);
  // Every provenance token the model is told it must carry, parked in a body
  // slot — which is exactly what a real answer does with them.
  const tokens = [...g.provenance.runIds, ...g.provenance.shas, ...g.provenance.ticketRefs, ...g.provenance.dates];
  return {
    title: 'A thing goes wrong in a way a person notices',
    summary: 'The described behaviour does not match what the surface promises, so a reader is told something untrue by the interface rather than by the data.',
    impact_if_we_wait: 'The wrong text keeps being shown. Bounded: display correctness only, no data is written or lost, and nothing outside this surface is affected.',
    current_need: 'A decision on which of the two shapes to adopt, then the fix.',
    area: 'Ticket board',
    severity: g.severity ?? 'medium',
    reported_by: g.reported_by ?? 'user',
    owner: done ? 'unassigned' : 'you',
    human_action: done ? 'none' : 'none',
    // ARCH-009: a GOOD answer carries NO `verification_state`. BUG-119 had the
    // pipeline derive it and the model copy it; the derivation is deleted and
    // the field with it, so the correct answer is silence. The must-FAIL case
    // (H) below proves the gate rejects an answer that emits one anyway.
    decision: null,
    decision_history: [],
    success_criteria: ['The surface shows what the data says'],
    code_refs: [{ path: 'src/server/tickets.ts', symbol: null, note: null }],
    related: [],
    recurrence_evidence: g.type === 'architecture' ? (g.provenance.ticketRefs.length ? g.provenance.ticketRefs : ['BUG-001']) : [],
    verification_class: g.verification_class ?? 'fix',
    body_prose: {
      Diagnosis: 'The reader and the writer disagree about the shape of the value.',
      Evidence: tokens.length ? `Provenance carried forward: ${tokens.join(', ')}.` : 'Reproduced by hand.',
      'Implementation notes': null,
      'Verification plan': 'Assert the rendered text equals the stored value.',
      'Migration and rollback': null,
      Risks: null,
    },
    source: { confirmation: 'The substance of the original head is carried into the fields above.', dropped: [] },
    ...over,
  };
}

/* ══════════════════════════════════════════ 1. deterministic extraction, real corpus */
section('deterministic extraction over the REAL corpus (all tickets in docs/bugs)');

{
  let bad = [];
  let verifMismatch = [];
  let noLog = 0, totalVerifs = 0;
  for (const f of ticketFiles) {
    const text = readOrig(f);
    let g;
    try { g = extractGivens(f, text); } catch (e) { bad.push(`${f}: threw ${e.message}`); continue; }
    if (!g.id || !g.type || !g.work_state || !g.reported) bad.push(`${f}: id=${g.id} type=${g.type} ws=${g.work_state} reported=${g.reported}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(g.reported ?? '')) bad.push(`${f}: reported ${JSON.stringify(g.reported)} is not an ISO date`);
    if (g.sha256 !== sha(text)) bad.push(`${f}: sha256 mismatch`);
    if (g.bytes !== Buffer.byteLength(text, 'utf8')) bad.push(`${f}: bytes mismatch`);
    // The extractor must agree with provenance-check's independent reader of the
    // SAME expression — two readers, one contract.
    const mine = extractVerificationRecords(text).map((v) => `${v.provider}/${v.run_id}/${v.verdict}`);
    const theirs = extractVerifications(text).map((v) => `${v.provider}/${v.run_id}/${v.verdict ?? 'invalid'}`);
    if (mine.join('|') !== theirs.join('|')) verifMismatch.push(f);
    totalVerifs += mine.length;
    if (g.log === null) noLog++;
    // The head must never contain the log, and head+log must be the whole file.
    if (g.log !== null && g.head + g.log !== text) bad.push(`${f}: head+log !== original bytes`);
    if (g.log === null && g.head !== text) bad.push(`${f}: head !== original bytes for a log-less ticket`);
  }
  ok(`extractGivens is total over ${ticketFiles.length} real tickets`, bad.length === 0, bad.slice(0, 4).join(' ; '));
  ok(`verification extraction agrees with provenance-check on all ${ticketFiles.length} (${totalVerifs} records)`, verifMismatch.length === 0, verifMismatch.slice(0, 5).join(', '));
  console.log(`        (${ticketFiles.length} tickets, ${totalVerifs} verification records, ${noLog} with no activity log)`);
}

/* ══════════════════════════════════════════════ 2. the happy path, real tickets */
section('compose + grade a well-formed answer, on real tickets');

{
  const sample = ['FEAT-092', 'BUG-085', 'ARCH-003', 'ARCH-004', 'BUG-104', 'FEAT-082'];
  let graded = 0, bad = [];
  for (const id of sample) {
    const f = ticketFiles.find((x) => x.startsWith(`${id}-`));
    if (!f) { bad.push(`${id}: no file`); continue; }
    const text = readOrig(f);
    const g = extractGivens(f, text);
    const c = compose(g, goodAnswer(g), { today: '2026-08-19' });
    const r = grade(g, c, text);
    graded++;
    if (!r.ok) bad.push(`${id}: ${r.violations.slice(0, 3).join(' ; ')}`);
  }
  ok(`a well-formed answer passes the whole gate on ${graded} real tickets`, bad.length === 0, bad.join(' | '));
}

{
  // The whole corpus, not a sample: the gate must be satisfiable everywhere, or
  // the pipeline is going to quarantine tickets for the harness's reasons.
  let bad = [];
  for (const f of ticketFiles) {
    const text = readOrig(f);
    const g = extractGivens(f, text);
    const r = grade(g, compose(g, goodAnswer(g), { today: '2026-08-19' }), text);
    if (!r.ok) bad.push(`${g.id}: ${r.violations[0]}`);
  }
  ok(`the gate is satisfiable on ALL ${ticketFiles.length} real tickets`, bad.length === 0, `${bad.length} unsatisfiable: ${bad.slice(0, 5).join(' | ')}`);
}

{
  // Round-trip: the composed file must parse in STRICT mode (§5.6 item 4).
  const f = ticketFiles.find((x) => x.startsWith('ARCH-003-'));
  const text = readOrig(f);
  const g = extractGivens(f, text);
  const c = compose(g, goodAnswer(g), { today: '2026-08-19' });
  const p = parseTicket(c.text, { file: f, mode: 'strict' });
  ok('the composed file parses in STRICT mode with no errors', p.ok && p.format === 'block', p.errors.slice(0, 3).join(' ; '));
  ok('the composed file carries the activity log byte-for-byte', c.text.includes(splitAtActivityLog(text).log));
  ok('the composed record\'s body_slots are DERIVED, not asserted', c.record.body_slots['Activity log'] === true && c.record.body_slots.Diagnosis === true && c.record.body_slots['Implementation notes'] === false);
}

/* ═══════════════════════════════════════════════════════ 3. MUST-FAIL cases */
section('MUST-FAIL — a gate that cannot fail is not a gate');

const F = ticketFiles.find((x) => x.startsWith('ARCH-003-'));
const FTEXT = readOrig(F);
const G = extractGivens(F, FTEXT);
const CLEAN = compose(G, goodAnswer(G), { today: '2026-08-19' });

function mustFail(name, mutate, wantRe) {
  const c = mutate(JSON.parse(JSON.stringify(CLEAN.record)), CLEAN.body, CLEAN.text);
  const r = grade(G, c, FTEXT);
  const hit = r.violations.some((v) => wantRe.test(v));
  ok(name, !r.ok && hit, r.ok ? 'PASSED — it should not have' : `failed, but for the wrong reason: ${r.violations.slice(0, 2).join(' ; ')}`);
}

// §6.1 must-FAIL (A): one character of one run id, mangled.
mustFail('(A) one mangled character in one run id is caught', (rec, body) => {
  const rid = G.verification[0].run_id;
  const broken = rid.slice(0, -1) + (rid.slice(-1) === 'a' ? 'b' : 'a');
  const text = CLEAN.text.split(rid).join(broken);
  return { record: rec, body, text };
}, /run id .* does not appear|verification record for run/i);

// §6.1 must-FAIL (B): an empty migrated file passes vacuously if unguarded.
mustFail('(B) an EMPTY migrated file fails rather than passing vacuously',
  (rec, body) => ({ record: rec, body: '', text: '' }), /EMPTY/i);

mustFail('(C) a truncated activity log is caught by the byte-for-byte assertion',
  (rec, body) => { const text = CLEAN.text.slice(0, Math.floor(CLEAN.text.length * 0.6)); return { record: rec, body, text }; },
  /Activity log|activity log has \d+/i);

mustFail('(D) a DROPPED activity log is caught',
  () => { const c = compose({ ...G, log: null }, goodAnswer(G), { today: '2026-08-19' }); return c; },
  /Activity log|implausibly small|activity log has/i);

mustFail('(E) a live decision on a finished ticket is rejected',
  () => compose(G, goodAnswer(G, {
    human_action: 'decide',
    decision: { mode: 'single', question: 'Which shape?', options: [
      { key: 'A', label: 'One', what_changes: 'a', benefit: 'b', cost: 'c', why_not_obvious: 'd' },
      { key: 'B', label: 'Two', what_changes: 'a', benefit: 'b', cost: 'c', why_not_obvious: 'd' }],
      recommendation: null, recommendation_reason: null, prerequisite: null },
  }), { today: '2026-08-19' }),
  /live "decision" is present|a finished ticket/i);

mustFail('(F) an over-cap summary is rejected',
  () => compose(G, goodAnswer(G, { summary: 'word '.repeat(80).trim() }), { today: '2026-08-19' }),
  /"summary" is \d+ words, over its 60-word cap/);

mustFail('(G) a null source.confirmation is rejected — preservation rides on it',
  () => compose(G, goodAnswer(G, { source: { confirmation: null, dropped: [] } }), { today: '2026-08-19' }),
  /source\.confirmation/);

// ARCH-009 replaced BUG-119's pair of "the model must not CONTRADICT the
// derived value" cases with one stronger case: the model must not emit the
// field at ALL. There is no longer a value it could agree with, so agreement is
// not a defence — every proof state a model could write is now arbitrary prose
// in a field that does not exist, and the gate says so by name.
//
// Both old values are exercised, because the interesting one is not the wrong
// answer, it is the RIGHT one: under BUG-119 `"holds"` on a VERIFIED ticket was
// the correct copy and sailed through. It must now be refused too.
for (const value of ['broken', 'not_recorded', 'holds', 'pending']) {
  mustFail(`(H) a model that emits verification_state: ${JSON.stringify(value)} is rejected — including when it would have been "right"`,
    () => compose(G, goodAnswer(G, { verification_state: value }), { today: '2026-08-19' }),
    /the answer carries "verification_state" — that field was REMOVED \(ARCH-009\)/);
}

mustFail('(I) an argument-shaped title is rejected',
  () => compose(G, goodAnswer(G, { title: 'Rewrite the owner map + drop the side map' }), { today: '2026-08-19' }),
  /"title" contains "\+"/);

mustFail('(J) an architecture ticket with no recurrence evidence is rejected',
  () => compose(G, goodAnswer(G, { recurrence_evidence: [] }), { today: '2026-08-19' }),
  /recurrence_evidence.*architecture/i);

/* ══════════════════════════════════ 4. the model cannot overwrite provenance */
section('the model cannot author what it was not given');

{
  const hostile = goodAnswer(G, {
    id: 'BUG-999', type: 'bug', reported: '1999-01-01', updated: '1999-01-01',
    work_state: 'open', verification: [{ provider: 'anthropic', run_id: 'made-up', verdict: 'holds' }],
    source: { confirmation: 'ok', dropped: [], sha256: 'deadbeef', archived_path: '/etc/passwd' },
  });
  const c = compose(G, hostile, { today: '2026-08-19' });
  ok('id/type/reported/work_state/verification come from the pipeline, not the reply',
    c.record.id === G.id && c.record.type === G.type && c.record.reported === G.reported
    && c.record.work_state === G.work_state
    && JSON.stringify(c.record.verification) === JSON.stringify(G.verification));
  ok('source.sha256 and archived_path are pipeline-authored',
    c.record.source.sha256 === G.sha256 && c.record.source.archived_path === `docs/bugs/archive/${F}`);
  ok('unknown model keys are dropped BEFORE validation and reported as notes',
    c.notes.some((n) => /unexpected key "id"/.test(n)) && grade(G, c, FTEXT).ok);
}

/* ══════════════════════════ 5. concurrent writers: partial and truncated reads */
section('the corpus is being written by other lanes — partial reads must not pass');

{
  // The standing rule: a complete fixture cannot prove a concurrent read
  // correct. Take the REAL ticket and truncate it at plausible points; the
  // pipeline must never crash, and must never emit a ticket that GRADES CLEAN
  // against the whole original.
  let crashes = 0, falsePasses = 0, n = 0;
  for (const frac of [0.05, 0.2, 0.4, 0.5, 0.6, 0.75, 0.9, 0.99]) {
    const cut = FTEXT.slice(0, Math.floor(FTEXT.length * frac));
    n++;
    try {
      const gp = extractGivens(F, cut);
      const cp = compose(gp, goodAnswer(gp), { today: '2026-08-19' });
      // Graded against the WHOLE original, which is what the promotion gate does.
      if (grade(G, cp, FTEXT).ok) falsePasses++;
    } catch { crashes++; }
  }
  ok(`extractGivens/compose survive ${n} truncations of a real 176 KB ticket`, crashes === 0, `${crashes} crashed`);
  ok('no truncated read grades clean against the whole original', falsePasses === 0, `${falsePasses} false passes`);
}

{
  // Truncation mid-JSON-block on the MIGRATED side: validateSet must report it,
  // not throw and not silently skip.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  // NOTE: os.tmpdir is used ONLY for a throwaway dir of synthetic files here;
  // the pipeline itself never writes there.
  fs.writeFileSync(path.join(dir, F), CLEAN.text.slice(0, 400));
  const set = validateSet({ dir: BUGS, out: dir });
  ok('validateSet reports a truncated migrated file instead of throwing',
    set.ok === false && set.rows.length === 1 && /no orchard-ticket block|malformed block/.test(set.rows[0].violations[0]));
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ══════════════════════════════════════════════ 6. the full loop, offline */
section('the full dispatch → retry → quarantine loop, over the fixture seam');

{
  const scratch = path.join(SCRATCH_ROOT, 'ticket-migration-verify');
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });

  // A scripted responder standing in for dispatch.mjs. Modes are chosen per
  // ticket id so one run exercises success, retry-then-success, and quarantine.
  const responder = path.join(scratch, 'fake-dispatch.mjs');
  fs.writeFileSync(responder, `#!/usr/bin/env node
import fs from 'node:fs';
const argv = process.argv.slice(2);
const at = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };
const metaOut = at('--meta-out');
const dashdash = argv.indexOf('--');
let prompt = dashdash === -1 ? fs.readFileSync(0, 'utf8') : argv.slice(dashdash + 1).join(' ');
const id = (/^  id                  ([A-Z]+-\\d+)/m.exec(prompt) || [, '?'])[1];
const retrying = /YOUR PREVIOUS ANSWER WAS REJECTED/.test(prompt);
const answers = JSON.parse(fs.readFileSync(process.env.FAKE_ANSWERS, 'utf8'));
const mode = answers.modes[id] || 'good';
if (metaOut) fs.writeFileSync(metaOut, JSON.stringify({ provider: 'fake', exitCode: 0, failureKind: null }));
process.stderr.write('[dispatch] tokens: {"input_tokens":12000,"output_tokens":2500}\\n');
if (mode === 'quarantine') { process.stdout.write('I am afraid I cannot do that.\\n'); process.exit(0); }
if (mode === 'retry' && !retrying) { process.stdout.write('here is some prose instead of JSON\\n'); process.exit(0); }
if (mode === 'dispatch-fail') { process.stderr.write('dispatch failed [quota-window]: out of quota\\n'); process.exit(1); }
process.stdout.write(JSON.stringify(answers.byId[id]) + '\\n');
`);

  const ids = ['FEAT-092', 'BUG-085', 'ARCH-005'];
  const files = ids.map((id) => ticketFiles.find((f) => f.startsWith(`${id}-`))).filter(Boolean);
  const byId = {};
  for (const f of files) byId[extractGivens(f, readOrig(f)).id] = goodAnswer(extractGivens(f, readOrig(f)));
  const answersFile = path.join(scratch, 'answers.json');
  fs.writeFileSync(answersFile, JSON.stringify({
    byId,
    modes: { 'FEAT-092': 'good', 'BUG-085': 'retry', 'ARCH-005': 'quarantine' },
  }));

  const out = path.join(scratch, 'staged');
  const before = new Map(files.map((f) => [f, sha(readOrig(f))]));
  // A REFUSED promotion must move NOTHING — not just the three tickets this run
  // names. The old wording of that check was `!exists(docs/bugs/archive)`, which
  // stood in for "promotion did not run" only while no archive existed anywhere;
  // the cutover created one legitimately and the check went red without a defect
  // ever occurring. The property is that the directory is byte-identical, so it
  // is snapshotted whole — names and contents, recursively — and compared.
  const snapshotBugs = () => {
    const acc = new Map();
    const walk = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const abs = path.join(dir, e.name);
        const key = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(abs, key);
        else acc.set(key, sha(fs.readFileSync(abs, 'utf8')));
      }
    };
    walk(BUGS, '');
    return acc;
  };
  const diffSnapshots = (a, b) => {
    const out = [];
    for (const [k, v] of a) { if (!b.has(k)) out.push(`removed ${k}`); else if (b.get(k) !== v) out.push(`modified ${k}`); }
    for (const k of b.keys()) if (!a.has(k)) out.push(`added ${k}`);
    return out;
  };
  const bugsBefore = snapshotBugs();
  const res = spawnSync(process.execPath, [
    path.join(HERE, 'migrate-tickets.mjs'), '--ids', ids.join(','), '--out', out,
    '--concurrency', '3', '--today', '2026-08-19',
  ], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, MIGRATE_DISPATCH_BIN: responder, FAKE_ANSWERS: answersFile } });

  const staged = fs.existsSync(out) ? fs.readdirSync(out).filter((f) => TICKET_FILE_RE.test(f)) : [];
  ok('the loop exits NONZERO when a ticket is quarantined', res.status === 1, `exit ${res.status}\n${res.stderr?.slice(-500)}`);
  ok('a first-attempt success is staged', staged.some((f) => f.startsWith('FEAT-092-')));
  ok('a retry-then-success is staged (ONE corrective re-dispatch)', staged.some((f) => f.startsWith('BUG-085-')) && /BUG-085.*attempt 2/.test(res.stderr));
  ok('a twice-failing ticket is NOT staged — nothing half-migrated is written', !staged.some((f) => f.startsWith('ARCH-005-')));
  ok('the quarantined ticket lands in failed/ with its violations',
    fs.existsSync(path.join(out, 'failed', 'ARCH-005.violations.txt')));
  ok('EVERY original is byte-identical after the run',
    files.every((f) => sha(readOrig(f)) === before.get(f)));
  ok('the run report records spend and attempts',
    JSON.parse(fs.readFileSync(path.join(out, 'run-report.json'), 'utf8')).rows.some((r) => r.usd > 0 && r.attempts >= 1));

  // The promotion gate must REFUSE while the set is incomplete (§5.6 step 2).
  const prom = spawnSync(process.execPath, [path.join(HERE, 'migrate-tickets.mjs'), '--promote', '--out', out], { cwd: ROOT, encoding: 'utf8' });
  ok('promotion REFUSES an incomplete/quarantined set and moves nothing',
    prom.status === 1 && /PROMOTION REFUSED/.test(prom.stderr) && /quarantined/.test(prom.stderr));
  {
    const changed = diffSnapshots(bugsBefore, snapshotBugs());
    ok('promotion refusing left docs/bugs untouched — every file, not just the three named',
      changed.length === 0 && files.every((f) => sha(readOrig(f)) === before.get(f)),
      changed.length ? changed.slice(0, 10).join('; ') : `${bugsBefore.size} files byte-identical`);
  }

  // --validate-set re-grades the staged set independently of the run.
  const vs = spawnSync(process.execPath, [path.join(HERE, 'migrate-tickets.mjs'), '--validate-set', '--out', out], { cwd: ROOT, encoding: 'utf8' });
  ok('--validate-set re-grades the staged files and passes on them', vs.status === 0 && /2\/2 staged tickets pass/.test(vs.stdout), vs.stdout.slice(-300));
}

/* ══════════════════════════════════════ 6b. back-edge reconciliation, whole set */
section('related[] back-edges — a per-ticket dispatch cannot write both sides');

{
  const scratch = path.join(SCRATCH_ROOT, 'ticket-migration-reconcile');
  fs.rmSync(scratch, { recursive: true, force: true });
  const out = path.join(scratch, 'staged');
  fs.mkdirSync(out, { recursive: true });
  const a = ticketFiles.find((f) => f.startsWith('FEAT-092-'));
  const b = ticketFiles.find((f) => f.startsWith('BUG-104-'));
  const ga = extractGivens(a, readOrig(a));
  const gb = extractGivens(b, readOrig(b));
  // A ONE-SIDED edge, exactly as a per-ticket dispatch produces it.
  fs.writeFileSync(path.join(out, a), compose(ga, goodAnswer(ga, {
    related: [{ id: 'BUG-104', relation: 'depends_on' }, { id: 'BUG-999', relation: 'see_also' }],
  }), { today: '2026-08-19' }).text);
  fs.writeFileSync(path.join(out, b), compose(gb, goodAnswer(gb), { today: '2026-08-19' }).text);

  const r1 = reconcileRelations({ out });
  const back = JSON.parse(/```orchard-ticket\n([\s\S]*?)\n```/.exec(fs.readFileSync(path.join(out, b), 'utf8'))[1]);
  ok('the inverse edge is written onto the target ticket',
    r1.added === 1 && back.related.some((x) => x.id === 'FEAT-092' && x.relation === 'blocks'),
    JSON.stringify(back.related));
  ok('an edge to a ticket that is not in the set is REPORTED, never invented',
    r1.dangling.some((d) => /BUG-999/.test(d)) && !back.related.some((x) => x.id === 'BUG-999'));
  const r2 = reconcileRelations({ out });
  ok('reconciliation is idempotent', r2.added === 0);
  ok('reconciled files still pass the whole gate',
    validateSet({ dir: BUGS, out }).rows.every((x) => x.ok));
  fs.rmSync(scratch, { recursive: true, force: true });
}

/* ═══════════════════════════════════════════════ 7. promotion, on a copy of the real tree */
section('promotion, rehearsed on a COPY of the real corpus (never the real tree)');

{
  const scratch = path.join(SCRATCH_ROOT, 'ticket-migration-promote');
  fs.rmSync(scratch, { recursive: true, force: true });
  const dir = path.join(scratch, 'bugs');
  const out = path.join(scratch, 'staged');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  const subset = ticketFiles.slice(0, 6);
  for (const f of subset) {
    fs.copyFileSync(path.join(BUGS, f), path.join(dir, f));
    const text = readOrig(f);
    const g = extractGivens(f, text);
    fs.writeFileSync(path.join(out, f), compose(g, goodAnswer(g), { today: '2026-08-19' }).text);
  }
  const origSha = new Map(subset.map((f) => [f, sha(fs.readFileSync(path.join(dir, f), 'utf8'))]));

  const dry = spawnSync(process.execPath, [path.join(HERE, 'migrate-tickets.mjs'), '--promote', '--dir', dir, '--out', out, '--today', '2026-08-19'], { cwd: ROOT, encoding: 'utf8' });
  ok('promotion DRY RUN succeeds on a complete set and moves nothing',
    dry.status === 0 && /PROMOTION DRY RUN — 6 tickets ready/.test(dry.stdout)
    && subset.every((f) => sha(fs.readFileSync(path.join(dir, f), 'utf8')) === origSha.get(f)),
    dry.stdout.slice(-300) + dry.stderr.slice(-300));

  // --apply uses `git mv`, which needs a repo; rehearse in a throwaway one.
  spawnSync('git', ['init', '-q', scratch], { encoding: 'utf8' });
  spawnSync('git', ['-C', scratch, 'add', '-A'], { encoding: 'utf8' });
  spawnSync('git', ['-C', scratch, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { encoding: 'utf8' });
  const app = spawnSync(process.execPath, [path.join(HERE, 'migrate-tickets.mjs'), '--promote', '--apply', '--dir', dir, '--out', out, '--today', '2026-08-19'], { cwd: scratch, encoding: 'utf8' });
  const archive = path.join(dir, 'archive');
  const archived = fs.existsSync(archive) ? fs.readdirSync(archive).filter((f) => TICKET_FILE_RE.test(f)) : [];
  ok('--apply archives every original', app.status === 0 && archived.length === subset.length, `${archived.length}/${subset.length} ${app.stdout}${app.stderr}`);
  ok('every archived original is BYTE-IDENTICAL to what it was',
    subset.every((f) => fs.existsSync(path.join(archive, f)) && sha(fs.readFileSync(path.join(archive, f), 'utf8')) === origSha.get(f)));
  ok('the live path now holds the MIGRATED file, parsed strictly',
    subset.every((f) => parseTicket(fs.readFileSync(path.join(dir, f), 'utf8'), { file: f, mode: 'strict' }).ok));
  const idx = fs.existsSync(path.join(archive, 'INDEX.md')) ? fs.readFileSync(path.join(archive, 'INDEX.md'), 'utf8') : '';
  ok('archive/INDEX.md is generated, complete and carries each sha256',
    subset.every((f) => idx.includes(f) && idx.includes(origSha.get(f))), `${idx.length} bytes`);
  ok('the staging dir is drained by promotion',
    fs.readdirSync(out).filter((f) => TICKET_FILE_RE.test(f)).length === 0);
  fs.rmSync(scratch, { recursive: true, force: true });
}

/* ═══════════════════════════════════════════════════════════ 8. prompt shape */
section('the prompt');

{
  const p = buildPrompt(G);
  ok('the prompt never contains the activity log', !p.includes('## Activity log') && !p.includes(splitAtActivityLog(FTEXT).log.slice(0, 200)));
  ok('the prompt states the given work_state and its consequences', p.includes(`work_state          ${G.work_state}`) && /decision` MUST be null/.test(p));
  // BUG-119: MUST APPEAR now lists only the head tokens the pipeline does NOT
  // already place — a token also present in the byte-for-byte-copied log is
  // carried by the copy. So this asserts both halves: everything listed is
  // listed, and everything OMITTED is genuinely covered by the log, using
  // provenanceCheck's own per-kind case rules (folded for shas, exact for
  // ticket refs and dates).
  ok('the prompt lists every AT-RISK head provenance token as MUST APPEAR',
    [...G.provenance.shas, ...G.provenance.ticketRefs, ...G.provenance.dates].every((t) => p.includes(t)));
  {
    const head = provenanceOf(G.head);
    const raw = G.log ?? '';
    const covered = { shas: (x) => raw.toLowerCase().includes(x.toLowerCase()), ticketRefs: (x) => raw.includes(x), dates: (x) => raw.includes(x) };
    const leaked = [];
    for (const k of ['shas', 'ticketRefs', 'dates']) {
      for (const x of head[k]) if (!G.provenance[k].includes(x) && !covered[k](x)) leaked.push(`${k} ${x}`);
    }
    ok('every head token OMITTED from MUST APPEAR is carried by the verbatim log copy',
      leaked.length === 0, leaked.slice(0, 3).join(', ') || `${head.dates.length + head.shas.length + head.ticketRefs.length} head tokens checked`);
  }
  ok('the schema contract is generated from the validator (caps present)', p.includes('<= 60 words') && p.includes('<= 30 words'));
  const r = buildPrompt(G, ['x is wrong', 'y is wrong']);
  ok('a corrective prompt names every violation and discards the prior answer',
    r.includes('YOUR PREVIOUS ANSWER WAS REJECTED') && r.includes('x is wrong') && r.includes('y is wrong'));
  ok('extractJson is lenient about fences and preamble',
    extractJson('here you go:\n```json\n{"a":1}\n```').value?.a === 1
    && extractJson('{"a":2}').value?.a === 2
    && extractJson('no json here').ok === false);
}

/* ══════════════════════════════════════════════════════════════════ summary */
console.log(`\n${'═'.repeat(70)}`);
console.log(`verify-migrate-tickets: ${pass} passed, ${fail} failed`);
if (fail) { console.log('failed:'); for (const f of failures) console.log(`  - ${f}`); }
process.exit(fail ? 1 : 0);
