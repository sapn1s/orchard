#!/usr/bin/env node
/**
 * FEAT-085 — Readability enforcement verification.
 *
 *   npm run verify:feat-085-readability
 *
 * Two layers:
 *  1. MODULE (scripts/lib/readability.mjs) fed the REAL calibration texts under
 *     /tmp/iv-orchard/samples/ — the must-FAIL proof in BOTH directions on real
 *     data: every un-rewritten ORIGINAL must VIOLATE, every readability REWRITE
 *     must PASS. (If the samples are absent — a fresh clone — those checks SKIP
 *     with a loud note; the synthetic layer below still runs.)
 *  2. HOOK (scripts/hooks/response-format-gate.mjs) driven as a subprocess with
 *     synthetic transcripts: a convoluted reply is reported (advisory) / blocked
 *     (enforce); a readable reply ALLOWs; and short / code-heavy / table-heavy /
 *     quote-heavy replies ALLOW (no false positives). Same advisory/enforce path
 *     as the format checks.
 *
 * No live session, no server, no CLI turn.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeReadability, evaluateReadability, READABILITY_THRESHOLDS } from './lib/readability.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, 'hooks', 'response-format-gate.mjs');
const SAMPLES = '/tmp/iv-orchard/samples';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feat085-read-'));

let pass = 0, fail = 0, skip = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
}
function skipped(name, why) { skip++; console.log('  --  SKIP ' + name + ' (' + why + ')'); }

const GOOD_DIGEST = '```orchard-digest\n{"items":[{"text":"Reviewed the streaming options","kind":"decision","importance":"high"}]}\n```\n';

function transcript(name, text) {
  const file = path.join(TMP, name + '.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}
/*
 * BUG-118 (round 2): the Stop hook grades only the session its ORCHARD_SESSION
 * marker NAMES — a presence flag was inherited by nested hand-started sessions.
 * These suites test the GRADER, so each run declares itself the owner of the
 * payload it sends, injecting a session id when a fixture omits one (a real Stop
 * payload always carries one). The launcher gate is BUG-118's own suite.
 */
const SUITE_SESSION_ID = '0b118000-0000-4000-8000-000000000118';
const ownPayload = (o) => (o && typeof o === 'object' && typeof o.session_id !== 'string')
  ? { ...o, session_id: SUITE_SESSION_ID } : o;
const ownMarker = (o) => (o && typeof o?.session_id === 'string') ? o.session_id : SUITE_SESSION_ID;
/** Same, for suites that feed RAW stdin (including deliberate garbage). */
function ownRaw(input) {
  try {
    const o = JSON.parse(input);
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      const p = ownPayload(o);
      return { input: JSON.stringify(p), marker: ownMarker(p) };
    }
  } catch { /* garbage stays garbage: the hook must fail open on it */ }
  return { input, marker: SUITE_SESSION_ID };
}

function run(text, env = {}) {
  const tp = transcript('t' + Math.random().toString(36).slice(2), text);
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({ session_id: SUITE_SESSION_ID, hook_event_name: 'Stop', stop_hook_active: false, transcript_path: tp, cwd: '/nonexistent/proj' }),
    encoding: 'utf8', env: { ...process.env, ORCHARD_SESSION: SUITE_SESSION_ID, ...env }, timeout: 15000,
  });
  return { code: r.status, stdout: (r.stdout || '').trim() };
}
function isAllow(res) { return res.code === 0 && res.stdout === ''; }
function blockReason(res) {
  try { const o = JSON.parse(res.stdout); return o.decision === 'block' ? String(o.reason || '') : null; }
  catch { return null; }
}
function advisoryMsg(res) {
  try { const o = JSON.parse(res.stdout); return typeof o.systemMessage === 'string' ? o.systemMessage : null; }
  catch { return null; }
}

console.log('=== FEAT-085 readability ===');
console.log('thresholds: ' + JSON.stringify(READABILITY_THRESHOLDS));

/* ── 1. MODULE on the REAL calibration samples ─────────────────────────────── */
console.log('\n-- module vs real calibration samples --');
{
  const ORIGINALS = ['S1_A_original', 'S2_A_original', 'S3_A_original', 'S4_A_original'];
  const REWRITES = [
    'S1_B_opus5', 'S2_B_opus5', 'S3_B_opus5', 'S4_B_opus5',
    'S1_C_opus46', 'S2_C_opus46', 'S3_C_opus46', 'S4_C_opus46',
  ];
  const readFile = (n) => fs.readFileSync(path.join(SAMPLES, n + '.txt'), 'utf8');
  const haveSamples = fs.existsSync(SAMPLES) && fs.existsSync(path.join(SAMPLES, 'S1_A_original.txt'));

  if (!haveSamples) {
    skipped('real-sample must-FAIL (originals VIOLATE / rewrites PASS)', 'samples absent at ' + SAMPLES);
  } else {
    for (const n of ORIGINALS) {
      const ev = evaluateReadability(readFile(n));
      const m = ev.measured;
      check(`ORIGINAL ${n} VIOLATES readability (must-FAIL)`,
        !ev.tooShort && ev.violations.length > 0,
        { max: m.maxSentenceLength, clause: +m.clauseDensity.toFixed(2), tooShort: ev.tooShort });
    }
    for (const n of REWRITES) {
      const ev = evaluateReadability(readFile(n));
      const m = ev.measured;
      check(`REWRITE  ${n} PASSES readability`,
        ev.tooShort || ev.violations.length === 0,
        { max: m.maxSentenceLength, clause: +m.clauseDensity.toFixed(2), violations: ev.violations.map((v) => v.metric) });
    }
    // Metric fidelity: module must reproduce the experiment's headline numbers.
    const s1a = analyzeReadability(readFile('S1_A_original'));
    check('metric fidelity: S1_A max sentence = 49', s1a.maxSentenceLength === 49, s1a.maxSentenceLength);
    check('metric fidelity: S1_A clause density = 1.26', +s1a.clauseDensity.toFixed(2) === 1.26, +s1a.clauseDensity.toFixed(2));
    const s4a = analyzeReadability(readFile('S4_A_original'));
    check('metric fidelity: S4_A max sentence = 38 (collides with good S4_B)', s4a.maxSentenceLength === 38, s4a.maxSentenceLength);
    check('S4_A caught by clause density alone (the borderline original)',
      s4a.clauseDensity > READABILITY_THRESHOLDS.clauseDensity && s4a.maxSentenceLength <= READABILITY_THRESHOLDS.maxSentenceLength,
      { clause: +s4a.clauseDensity.toFixed(2), max: s4a.maxSentenceLength });
  }
}

/* ── 2. Threshold headroom sanity (against both distributions) ──────────────── */
console.log('\n-- threshold headroom --');
check('clauseDensity threshold above good ceiling (0.81) and below bad floor (1.10)',
  READABILITY_THRESHOLDS.clauseDensity > 0.81 && READABILITY_THRESHOLDS.clauseDensity < 1.10);
check('maxSentenceLength threshold above good ceiling (38) and below clearly-bad (42)',
  READABILITY_THRESHOLDS.maxSentenceLength >= 39 && READABILITY_THRESHOLDS.maxSentenceLength < 42);

/* ── 3. HOOK-level: convoluted vs readable ─────────────────────────────────── */
console.log('\n-- hook-level (advisory default + enforce opt-in) --');

// A convoluted reply that is FORMAT-COMPLIANT (valid digest) so only readability
// is at issue — proves the readability path fires independently of the format path.
// Prefer the REAL S1_A calibration prose (a genuine hard reply); fall back to a
// synthetic multi-sentence convoluted body so the check runs on a fresh clone too.
const realS1A = (() => {
  try { return fs.readFileSync(path.join(SAMPLES, 'S1_A_original.txt'), 'utf8'); }
  catch { return null; }
})();
const convolutedBody = realS1A || (
  'The tradeoff here is genuine, unavoidable, and hiding in plain sight, ' +
  'because to hide the token before it closes, you have to guess — betting, ' +
  'always, that it will in fact close, which is exactly the state this app, ' +
  'whose whole ethos is never assert a state you have not reached, refuses to ' +
  'assert, so the optimistic path, though smoother and more seamless, quietly ' +
  'contradicts the spine of the design in a way that matters. ' +
  'The honest path is slower to feel smooth, but it never lies. ' +
  'It renders literal syntax briefly, then snaps. ' +
  'The web UIs, by contrast, chose optimism, because the flickers are rare, ' +
  'self-correcting, and, for most readers, invisible. ' +
  'Mine blobs for a duller reason, which is pure simplicity. ' +
  'It appends raw text, and only the final event runs the formatter. ' +
  'That was deliberate once, but you have found its real cost now.'
);
const convoluted = GOOD_DIGEST + convolutedBody;

{
  // Advisory (shipped default): report via systemMessage, never block.
  const res = run(convoluted); // no ENFORCE env
  const msg = advisoryMsg(res);
  check('convoluted + valid digest -> ADVISORY: NOT blocked', blockReason(res) === null && res.code === 0, res.stdout.slice(0, 80));
  check('convoluted -> advisory systemMessage present', typeof msg === 'string' && /Readability/i.test(msg), (msg || '').slice(0, 120));
  check('advisory message is actionable (names clauses or sentence length)',
    !!msg && (/clauses per sentence/i.test(msg) || /one sentence runs \d+ words/i.test(msg)), (msg || '').slice(0, 160));
}
{
  // Enforce (opt-in): block with the readability reason.
  const res = run(convoluted, { ORCHARD_STOP_HOOK_ENFORCE: '1' });
  const reason = blockReason(res);
  check('convoluted + valid digest -> ENFORCE: BLOCK on readability', reason !== null, res.stdout.slice(0, 80));
  check('enforce reason names the readability offence (not a missing digest)',
    !!reason && /Readability/i.test(reason) && !/Missing the leading/.test(reason), (reason || '').slice(0, 160));
}
{
  // A readable, format-compliant reply -> ALLOW (silence) in BOTH modes.
  const readable = GOOD_DIGEST +
    'Here is the plan. It is short. Each sentence is easy to read. ' +
    'The decision is clear. Do the honest variant. It matches the app. ' +
    'You can switch later. This keeps the reply simple. A busy reader can act fast.';
  check('readable reply -> ADVISORY ALLOW (silent)', isAllow(run(readable)));
  check('readable reply -> ENFORCE ALLOW (silent)', isAllow(run(readable, { ORCHARD_STOP_HOOK_ENFORCE: '1' })));
}

/* ── 4. No false positives: short / code / table / quote heavy ─────────────── */
console.log('\n-- no false positives (bias hard toward allowing) --');
{
  // Two-sentence reply must NEVER trip (explicit brief requirement).
  const short = GOOD_DIGEST + 'Done. Shipped the honest variant and it works.';
  check('two-sentence reply -> ENFORCE ALLOW', isAllow(run(short, { ORCHARD_STOP_HOOK_ENFORCE: '1' })));
}
{
  // Code-heavy: a big fenced block, tiny prose -> prose stripped -> tooShort -> ALLOW.
  const bigCode = Array.from({ length: 40 }, (_, i) =>
    `const x${i} = compute(${i}, longArgumentName, anotherLongArgument, yetAnother, andMore);`).join('\n');
  const codeHeavy = GOOD_DIGEST + 'Here is the patch.\n\n```js\n' + bigCode + '\n```\n\nApply it.';
  check('code-heavy reply -> ENFORCE ALLOW', isAllow(run(codeHeavy, { ORCHARD_STOP_HOOK_ENFORCE: '1' })));
}
{
  // Table-heavy: rows are excluded -> only tiny prose remains -> ALLOW.
  const rows = Array.from({ length: 20 }, (_, i) =>
    `| item-${i} | some long descriptive value here, with clauses — and dashes; and commas | done |`).join('\n');
  const tableHeavy = GOOD_DIGEST + 'Summary table.\n\n| name | detail | status |\n|---|---|---|\n' + rows + '\n\nThat is all.';
  check('table-heavy reply -> ENFORCE ALLOW', isAllow(run(tableHeavy, { ORCHARD_STOP_HOOK_ENFORCE: '1' })));
}
{
  // Quote-heavy: blockquote lines are excluded (someone else's prose) -> ALLOW.
  const quote = Array.from({ length: 15 }, () =>
    '> A very long quoted sentence, full of nested clauses — em-dashes and commas, semicolons; and more, that would trip the gate if it counted, but it must not because it is quoted material and not the reply\'s own prose at all.').join('\n');
  const quoteHeavy = GOOD_DIGEST + 'They wrote:\n\n' + quote + '\n\nI agree.';
  check('quote-heavy reply -> ENFORCE ALLOW', isAllow(run(quoteHeavy, { ORCHARD_STOP_HOOK_ENFORCE: '1' })));
}
{
  // The digest block itself must never be measured as prose.
  const denseDigestOnly = '```orchard-digest\n{"items":[{"text":"A dense decision line, with clauses — dashes, commas, semicolons; and more, running long past forty words so that if the digest were ever measured as prose it would certainly and unavoidably trip both the max-sentence and clause-density gates, which it must not.","kind":"decision","importance":"high"}]}\n```\nShort note.';
  check('digest content is excluded from prose -> ENFORCE ALLOW', isAllow(run(denseDigestOnly, { ORCHARD_STOP_HOOK_ENFORCE: '1' })));
}

/* ── 5. Safety split intact: readability alone cannot block in advisory ────── */
console.log('\n-- readability follows the advisory/enforce split --');
{
  const res = run(convoluted); // advisory default
  const parsed = (() => { try { return JSON.parse(res.stdout); } catch { return {}; } })();
  check('advisory: readability violation has NO decision/continue (cannot halt turn)',
    parsed.decision === undefined && parsed.continue === undefined, res.stdout.slice(0, 100));
  // stop_hook_active must still short-circuit even a readability violation.
  const tp = transcript('active', convoluted);
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({ session_id: SUITE_SESSION_ID, hook_event_name: 'Stop', stop_hook_active: true, transcript_path: tp, cwd: '/nonexistent/proj' }),
    encoding: 'utf8', env: { ...process.env, ORCHARD_SESSION: SUITE_SESSION_ID, ORCHARD_STOP_HOOK_ENFORCE: '1' }, timeout: 15000,
  });
  check('stop_hook_active:true + readability violation -> ALLOW (loop cap)', r.status === 0 && (r.stdout || '').trim() === '');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed, ${skip} skipped ===`);
process.exit(fail === 0 ? 0 : 1);
