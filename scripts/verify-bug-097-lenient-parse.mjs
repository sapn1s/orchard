#!/usr/bin/env node
/**
 * verify-bug-097-lenient-parse.mjs — BUG-097.
 *
 * The clean-room verdict contract kept discarding real verification work over
 * citation FORMAT, not substance: a verifier recorded 4 real runs, cited them,
 * and was still ruled INVALID because an `ADVERSARIAL:` case tag was a long
 * descriptive phrase ("provider-routing-layer-is-hardcoded-not-derived", 47
 * chars) that overran the 40-char slug cap, so the whole line — and its orphaned
 * `WHY-UNCOVERED:` — failed to parse.
 *
 * The fix is "parse leniently, judge strictly": relax only the SYNTAX (pull the
 * run id from anywhere on its line, normalise an off-shape case tag, ignore
 * stray prose) while leaving the SUBSTANCE bar exactly where it was — a verdict
 * is still INVALID unless it cites a real recorded fixer-test run, at least one
 * DISTINCT recorded adversarial run, and a concrete UNTESTED statement, all
 * checked against the harness's own manifest.
 *
 * This suite is adversarial about NOT loosening the substance bar:
 *  (1) REPLAY the REAL previously-INVALID FEAT-076 verifier answers (verbatim
 *      fixtures, recovered from the anthropic clean-room transcripts of
 *      2026-08-14) — must-FAIL BOTH directions: the pre-fix strict rule rejects
 *      them; the post-fix parse accepts them and, given the harness manifest,
 *      composes a well-formed verdict citing the SAME run ids.
 *  (2) the substance bar MUST STILL REJECT: a static-only review with no runs;
 *      a verdict citing only the fixer's own test with no distinct adversarial
 *      run; a verdict citing a run id the harness never recorded.
 *
 * Run: node scripts/verify-bug-097-lenient-parse.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCitationReply, composeVerdict, validateVerdict } from './lib/verdict-contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'bug-097');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const o = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${(o ?? '').slice(0, 400)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

// The EXACT pre-fix adversarial-citation rule (verbatim from the committed
// contract before this fix). The replay must FAIL it — that is the historical
// INVALID we are un-breaking, reproduced mechanically rather than asserted.
const PRE_FIX_ADV_RE = /^([A-Za-z0-9][A-Za-z0-9_-]{0,39})\s+run\s+([A-Fa-f0-9]{6,64})$/i;
const PRE_FIX_FIXER_RE = /^run\s+([A-Fa-f0-9]{6,64})$/i;

/**
 * Build the manifest the harness ITSELF recorded for a specimen's cited runs.
 * (The real FEAT-076 run's manifest was not persisted separately — "manifest 4
 * recorded run(s)" is all the log kept — so it is reconstructed here with the
 * cited ids and DISTINCT commands. This is honest: the load-bearing claim is
 * that the SAME reply text, which pre-fix could not parse, now parses and
 * composes against a manifest that carries the runs it cites; the fixer/
 * adversarial DISTINCTNESS the substance bar enforces is preserved by giving
 * each cited id its own command.)
 */
function manifestFor(cite, fixerCmd) {
  const out = [];
  out.push({ id: cite.fixerId, cmd: fixerCmd, exit: 0, sha256: 'aaaa000011112222', output: `run ${cite.fixerId}: fixer test re-run, real recorded output line\n` });
  cite.adversarial.forEach((a, i) => {
    out.push({ id: a.id, cmd: `node scratch-adversarial-${i + 1}.mjs`, exit: 1, sha256: `bbbb${i}000011112222`.slice(0, 16), output: `run ${a.id}: adversarial case ${a.slug} recorded output\n` });
  });
  return out;
}

/* ============================ (1) REPLAY — must-FAIL both directions ======= */

console.log('\n(1) REPLAY the real FEAT-076 verifier answers previously ruled INVALID on FORMAT');

for (const [tag, file, fixerCmd] of [
  ['lFIBfH', 'feat076-lFIBfH-invalid-on-format.txt', 'node scripts/verify-feat-076-wiring.mjs'],
  ['6zrLKK', 'feat076-6zrLKK-invalid-on-format.txt', 'node scripts/verify-feat-076-wiring.mjs'],
]) {
  const specimen = fs.readFileSync(path.join(FIX, file), 'utf8');
  const advLines = specimen.split('\n').filter((l) => /^ADVERSARIAL:/i.test(l)).map((l) => l.replace(/^ADVERSARIAL:\s*/i, '').trim());
  const fixerLine = specimen.split('\n').find((l) => /^FIXER-TEST:/i.test(l)).replace(/^FIXER-TEST:\s*/i, '').trim();

  // --- Direction PRE-FIX: the strict rule rejects at least one real ADVERSARIAL
  //     line (the over-long descriptive slug), reproducing the INVALID.
  const preFixRejects = advLines.filter((l) => !PRE_FIX_ADV_RE.test(l));
  check(`[${tag}] PRE-FIX: the strict adversarial rule REJECTS a real ADVERSARIAL line (the ${preFixRejects.length ? 'over-long slug' : 'shape'}) — the historical INVALID reproduced`,
    preFixRejects.length >= 1 && PRE_FIX_FIXER_RE.test(fixerLine),
    preFixRejects.length ? `rejected: "${preFixRejects[0].slice(0, 60)}…"` : 'no line rejected — specimen no longer reproduces the bug');

  // --- Direction POST-FIX: the lenient parse accepts it cleanly, normalising
  //     the slug, and extracts every cited run id.
  const cite = parseCitationReply(specimen);
  check(`[${tag}] POST-FIX: the SAME answer now parses with ZERO violations (evidence present, shape normalised)`,
    cite.violations.length === 0 && cite.verdict === 'BROKEN' && !!cite.fixerId && cite.adversarial.length >= 2,
    cite.violations.length ? cite.violations : `verdict=${cite.verdict} fixer=${cite.fixerId} adv=${cite.adversarial.map((a) => a.slug + ':' + a.id).join(', ')}`);
  check(`[${tag}]   …and the fix is recorded as a format-normalisation, not silently`,
    cite.normalized.some((n) => /case tag normalised/.test(n)),
    cite.normalized);

  // …and, given the harness's manifest of the runs it cites, it composes a
  // well-formed verdict that carries the SAME run ids.
  const manifest = manifestFor(cite, fixerCmd);
  const composed = composeVerdict(cite, { manifest, knownRuns: [fixerCmd] });
  const validated = composed.text ? validateVerdict(composed.text, { manifest, knownRuns: [fixerCmd] }) : { valid: false, violations: composed.violations };
  const citesSameIds = composed.text && [cite.fixerId, ...cite.adversarial.map((a) => a.id)].every((id) => composed.text.includes(id));
  check(`[${tag}] POST-FIX: composes a VALID ${cite.verdict} verdict citing the SAME recorded run ids (no work discarded)`,
    !!composed.text && composed.violations.length === 0 && validated.valid && citesSameIds,
    composed.text ? `valid=${validated.valid} citesSameIds=${citesSameIds}` : composed.violations);
}

/* ==================== (2) SUBSTANCE — the bar must STILL bite ============== */

console.log('\n(2) the substance bar STILL rejects (leniency lowered syntax, never substance)');

// A well-formed template we degrade below. Fixer + one distinct adversarial.
const FIXER_CMD = 'node test/thing.test.mjs';
const OK_MANIFEST = [
  { id: 'aaaa11112222', cmd: FIXER_CMD, exit: 0, sha256: 'deadbeefcafe0011', output: 'PASS: fixer re-run\n' },
  { id: 'bbbb33334444', cmd: 'node test/adversarial.mjs', exit: 1, sha256: 'feedface99990022', output: 'FAIL: boundary case\n' },
];
const OK_REPLY = [
  'VERDICT: BROKEN',
  'CLAIM: total(xs) must count only the truthy entries of any input array.',
  'FIXER-TEST: run aaaa11112222',
  'ADVERSARIAL: boundary run bbbb33334444',
  'WHY-UNCOVERED: the existing fixture never feeds an empty second page.',
  'UNTESTED: Concurrent callers were not exercised; there is no injection seam.',
  'FINDING: paging stops after page one.',
].join('\n');
{
  // sanity: the healthy reply IS valid, so the rejections below are about the
  // degradation, not a broken baseline.
  const c = parseCitationReply(OK_REPLY);
  const comp = composeVerdict(c, { manifest: OK_MANIFEST, knownRuns: [FIXER_CMD] });
  check('baseline: a well-formed citation reply composes a VALID verdict (so the rejections below are real)',
    c.violations.length === 0 && !!comp.text && comp.violations.length === 0,
    c.violations.length ? c.violations : comp.violations);
}
{
  // (a) STATIC-ONLY review — no recorded runs at all.
  const staticOnly = parseCitationReply('This looks correct: the cursor loop is right and the guard prevents runaway.');
  check('(a) a STATIC-only review (no run citations) is INVALID — no VERDICT, no FIXER-TEST, no ADVERSARIAL',
    staticOnly.violations.some((x) => x.includes('VERDICT'))
      && staticOnly.violations.some((x) => x.includes('FIXER-TEST'))
      && staticOnly.violations.some((x) => x.includes('ADVERSARIAL')),
    staticOnly.violations);
  // …and a well-shaped reply whose ids simply were never recorded (empty
  // manifest) composes NOTHING.
  const c = parseCitationReply(OK_REPLY);
  const comp = composeVerdict(c, { manifest: [], knownRuns: [FIXER_CMD] });
  check('(a) …and a well-shaped reply against an EMPTY manifest composes nothing (INVALID) — parsing cleanly is not evidence',
    comp.text === null && comp.violations.some((x) => x.includes('never recorded')),
    comp.violations);
}
{
  // (b) ONLY the fixer's own test, no DISTINCT adversarial run: the "adversarial"
  // cites a run whose recorded command is the fixer's command. This is the
  // blind-spot rule — the whole point of the gate.
  const sameProgReply = [
    'VERDICT: HOLDS',
    'CLAIM: total(xs) must count only the truthy entries of any input array.',
    'FIXER-TEST: run aaaa11112222',
    'ADVERSARIAL: not-actually-distinct run cccc55556666',
    'WHY-UNCOVERED: claims to cover a boundary but re-runs the very same command.',
    'UNTESTED: nothing else was reachable.',
  ].join('\n');
  const manifest = [
    ...OK_MANIFEST.slice(0, 1),
    { id: 'cccc55556666', cmd: FIXER_CMD, exit: 0, sha256: '1111222233334444', output: 'PASS: fixer re-run again\n' },
  ];
  const c = parseCitationReply(sameProgReply);
  const comp = composeVerdict(c, { manifest, knownRuns: [FIXER_CMD] });
  check('(b) an adversarial run that is really the FIXER\'s own command again is INVALID (the blind-spot rule still bites)',
    comp.text === null && comp.violations.some((x) => x.includes('covers exactly what the fixture already covered')),
    comp.violations);
  // …and the degenerate form — no ADVERSARIAL line at all — is rejected at parse.
  const noAdv = parseCitationReply(sameProgReply.split('\n').filter((l) => !/^ADVERSARIAL:|^WHY-UNCOVERED:/i.test(l)).join('\n'));
  check('(b) …and a verdict with NO adversarial citation at all is INVALID at parse (fixer-only inherits the blind spot)',
    noAdv.violations.some((x) => x.includes('ADVERSARIAL')),
    noAdv.violations);
}
{
  // (c) a FABRICATED run id — the shape is perfect, the id is invented.
  const fabricated = OK_REPLY.replace('run bbbb33334444', 'run ffffffffffff');
  const c = parseCitationReply(fabricated);
  check('(c) parse is clean (lenient) but…', c.violations.length === 0, c.violations);
  const comp = composeVerdict(c, { manifest: OK_MANIFEST, knownRuns: [FIXER_CMD] });
  check('(c) a citation of a run id the harness NEVER recorded is INVALID — fabricated evidence is caught against the manifest',
    comp.text === null && comp.violations.some((x) => x.includes('ffffffffffff') && x.includes('never recorded')),
    comp.violations);
}
{
  // (d) leniency does not let an over-long slug produce an INVALID composed
  // banner label: the normalised slug must satisfy the label shape the composed
  // verdict's own self-check enforces.
  const longSlug = [
    'VERDICT: BROKEN',
    'CLAIM: total(xs) must count only the truthy entries of any input array.',
    'FIXER-TEST: run aaaa11112222',
    'ADVERSARIAL: this-is-a-deliberately-enormous-descriptive-case-tag-way-over-forty-characters run bbbb33334444',
    'WHY-UNCOVERED: the existing fixture never feeds an empty second page here.',
    'UNTESTED: Concurrent callers were not exercised; there is no injection seam.',
    'FINDING: paging stops after page one.',
  ].join('\n');
  const c = parseCitationReply(longSlug);
  const comp = composeVerdict(c, { manifest: OK_MANIFEST, knownRuns: [FIXER_CMD] });
  const v = comp.text ? validateVerdict(comp.text, { manifest: OK_MANIFEST, knownRuns: [FIXER_CMD] }) : { valid: false };
  check('(d) an absurdly long case tag is normalised to a valid slug and the composed verdict passes its own contract self-check',
    c.violations.length === 0 && !!comp.text && v.valid && /=== ADVERSARIAL: [A-Za-z0-9][A-Za-z0-9_-]{0,39} ===/.test(comp.text),
    comp.text ? (comp.text.split('\n').find((l) => l.startsWith('=== ADVERSARIAL')) ?? '') : comp.violations);
}

/* ================================= summary ================================= */
console.log(`\nverify:bug-097-lenient-parse — ${pass}/${pass + fail} PASS`);
if (fail) { console.log('FAILURES:'); for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
process.exit(0);
