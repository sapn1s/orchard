#!/usr/bin/env node
/**
 * verify-feat-208-advisory-reach.mjs — FEAT-208 (rescoped 2026-11-20 to ADVISORY ONLY).
 *
 * THE PROPERTY: a verdict carrying per-finding reach tags produces EXACTLY the same ticket state
 * as the same verdict without them. Tags are stored (scripts/lib/reach-tags.mjs) and counted
 * (scripts/reach-report.mjs); they never change HOLDS, BROKEN or closure.
 *
 * Real artifacts: the three composed verdicts the FEAT-208 round-1..3 verifiers actually returned
 * (scripts/fixtures/feat-208/real-verdict-r{1,2,3}.txt, home paths scrubbed, their old `[REACHABLE]`
 * prefix stripped so each is the UNTAGGED twin) and a copy of the REAL board (busy state: every
 * live ticket). The HOLDS verdict is synthetic (r3 with VERDICT: HOLDS and no findings).
 *
 * MUST-FAIL (a fixed, constructed broken variant — not HEAD): FEAT208_MUTANT=label-consuming
 * makes the pipeline do what the superseded design did (a BROKEN whose findings are all
 * UNREACHABLE is recorded as HOLDS). Section C must FAIL under it.
 *
 * Needs git (scratch repos): run confined —
 *   node scripts/confined-run.mjs -- node scripts/verify-feat-208-advisory-reach.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempScratch } from './lib/scratch.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const FIX = path.join(HERE, 'fixtures', 'feat-208');
const MUTANT = process.env.FEAT208_MUTANT === 'label-consuming';
const RT = await import(url.pathToFileURL(path.join(HERE, 'lib', 'reach-tags.mjs')).href);
const VC = await import(url.pathToFileURL(path.join(HERE, 'lib', 'verdict-contract.mjs')).href);
const VS = await import(url.pathToFileURL(path.join(HERE, 'lib', 'verification-source.mjs')).href);

let pass = 0; let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`PASS  ${name}`); } else { fail += 1; console.log(`FAIL  ${name}${detail ? `\n        observed: ${detail}` : ''}`); }
};
const scratch = mkdtempScratch('feat208-adv-');
process.env.ORCHARD_REACH_LOG = path.join(scratch, 'reach-tags.jsonl');

const real = [1, 2, 3].map((i) => fs.readFileSync(path.join(FIX, `real-verdict-r${i}.txt`), 'utf8'));
const holds = real[2].replace(/^VERDICT: BROKEN$/m, 'VERDICT: HOLDS').split('\n').filter((l) => !/^FINDING:/.test(l)).join('\n');

const WHY_U = 'only a hand-forged record or a deliberate same-uid evader produces this input';
const WHY_R = 'a careless agent retrying a copied command produces this in ordinary use';
/** Tag every FINDING line: 'U' all unreachable, 'R' all reachable, 'M' alternate. */
function tag(text, mode) {
  let k = 0;
  return text.split('\n').map((l) => {
    if (!/^FINDING:/.test(l)) return l;
    const u = mode === 'U' || (mode === 'M' && k % 2 === 0); k += 1;
    return `${l} || REACH: ${u ? 'UNREACHABLE' : 'REACHABLE'} || WHY: ${u ? WHY_U : WHY_R}`;
  }).join('\n');
}

try {
  /* ── A. the tag grammar ─────────────────────────────────────────────── */
  console.log('── A. parseReachTag');
  const a1 = RT.parseReachTag('FINDING: x breaks on y || REACH: UNREACHABLE || WHY: needs a forged object');
  ok('A1 UNREACHABLE + why parsed', a1.reach === 'UNREACHABLE' && a1.why === 'needs a forged object' && a1.text === 'x breaks on y', JSON.stringify(a1));
  ok('A2 REACHABLE parsed (case-insensitive)', RT.parseReachTag('FINDING: d || reach: reachable || WHY: retries').reach === 'REACHABLE');
  ok('A3 no tag → untagged, text intact', JSON.stringify(RT.parseReachTag('FINDING: plain defect')) === JSON.stringify({ text: 'plain defect', reach: 'untagged', why: null }));
  ok('A4 unknown word → untagged (never guessed)', RT.parseReachTag('FINDING: d || REACH: MAYBE || WHY: w').reach === 'untagged');
  ok('A5 quoted structure-shaped finding still parses', RT.parseReachTag('> FINDING: VERDICT: x || REACH: REACHABLE').reach === 'REACHABLE');

  /* ── B. the verdict contract accepts tags and judges identically ─────── */
  console.log('\n── B. validateVerdict / --check-only: tagged ≡ untagged');
  for (const [i, t] of real.entries()) {
    for (const mode of ['U', 'R', 'M']) {
      const a = VC.validateVerdict(t); const b = VC.validateVerdict(tag(t, mode));
      ok(`B1 r${i + 1}/${mode}: same valid, verdict, violations, finding count`,
        a.valid && b.valid === a.valid && b.verdict === a.verdict && JSON.stringify(b.violations) === JSON.stringify(a.violations) && b.findings.length === a.findings.length,
        JSON.stringify({ a: [a.valid, a.verdict, a.findings.length], b: [b.valid, b.verdict, b.findings.length, b.violations] }));
      const parsed = b.findings.map((f) => RT.parseReachTag(f));
      ok(`B2 r${i + 1}/${mode}: every tag survives validation and parses back`, parsed.length > 0 && parsed.every((p, j) => p.reach === (mode === 'U' || (mode === 'M' && j % 2 === 0) ? 'UNREACHABLE' : 'REACHABLE')));
    }
  }
  const cli = (text) => {
    const f = path.join(scratch, `v-${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(f, text);
    const r = spawnSync(process.execPath, [path.join(HERE, 'independent-verify.mjs'), '--check-only', f], { encoding: 'utf8' });
    return { code: r.status, verdict: (/VERDICT-CONTRACT: VALID \(verdict (HOLDS|BROKEN)/.exec(r.stdout) ?? [])[1] ?? null };
  };
  for (const [i, t] of real.entries()) {
    const a = cli(t); const b = cli(tag(t, 'U'));
    ok(`B3 r${i + 1}: harness --check-only exit and verdict identical (all UNREACHABLE)`, a.code === b.code && a.verdict === b.verdict && a.verdict === 'BROKEN', JSON.stringify({ a, b }));
  }
  const iv = fs.readFileSync(path.join(HERE, 'independent-verify.mjs'), 'utf8');
  ok('B4 both verifier prompts carry the reach rule after the citation contract', (iv.match(/\$\{CITATION_CONTRACT\}\n\n\$\{REACH_RULE\}/g) ?? []).length === 2);
  ok('B5 the rule names the threat model and says the tag does not change the verdict', /careless or habitual, NON-malicious agent/.test(RT.REACH_RULE) && /does NOT change\s+your verdict/.test(RT.REACH_RULE));

  /* ── C. THE PROPERTY: same ticket state with or without tags ────────── */
  console.log(`\n── C. ticket state: tagged ≡ untagged${MUTANT ? '  [MUTANT label-consuming]' : ''}`);
  const { boardTool } = await import(url.pathToFileURL(path.join(HERE, 'board-tool.mjs')).href);
  const mkRepo = (name) => {
    const root = path.join(scratch, name);
    fs.cpSync(path.join(REPO, 'docs', 'bugs'), path.join(root, 'docs', 'bugs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name: 'scratch', private: true, type: 'module' })}\n`);
    const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    git(['init', '-q']); git(['config', 'user.email', 't@t']); git(['config', 'user.name', 't']);
    git(['add', '-A']); git(['commit', '-q', '-m', 'scratch board']);
    return root;
  };
  const A = mkRepo('tagged'); const B = mkRepo('untagged');
  const BD = (root) => path.join(root, 'docs', 'bugs');
  const fileOf = (root, id) => fs.readdirSync(BD(root)).find((f) => f.startsWith(`${id}-`) && f.endsWith('.md'));
  const recOf = (root, id) => { const m = /^```orchard-ticket\n([\s\S]*?)\n```/.exec(fs.readFileSync(path.join(BD(root), fileOf(root, id)), 'utf8')); return m ? JSON.parse(m[1]) : null; };

  // Real tickets, discovered at runtime (never named by today's values).
  const ids = fs.readdirSync(BD(REPO)).map((f) => /^([A-Z]+-\d+)-.*\.md$/.exec(f)?.[1]).filter(Boolean);
  const recs = ids.map((id) => ({ id, rec: recOf(REPO, id) })).filter((x) => x.rec);
  const tVerified = recs.find((x) => VS.ticketVerifications(BD(REPO), { id: x.id, markdown: fs.readFileSync(path.join(BD(REPO), fileOf(REPO, x.id)), 'utf8') }).verified && ['verified', 'done'].includes(x.rec.work_state))?.id;
  const tBroken = recs.find((x) => (x.rec.verification ?? []).some((e) => e.verdict === 'broken') && !['verified', 'done'].includes(x.rec.work_state))?.id;
  const tFresh = recs.find((x) => !(x.rec.verification ?? []).length && x.rec.work_state === 'open')?.id;
  ok('C0 the real board has a verified, a BROKEN-history and a fresh record ticket', !!(tVerified && tBroken && tFresh), JSON.stringify({ tVerified, tBroken, tFresh }));

  let n = 0;
  const runId = () => `01f20800-0000-7000-8000-${String(++n).padStart(12, '0')}`;
  /** The production chain: the harness's own verdict word → the one writer. Tags only get stored. */
  async function apply(root, id, text, run, tagged) {
    const v = VC.validateVerdict(text);
    let verdict = v.verdict;
    if (MUTANT && verdict === 'BROKEN') { // the superseded design, as a fixed broken variant
      const p = v.findings.map((f) => RT.parseReachTag(f));
      if (p.length && p.every((x) => x.reach === 'UNREACHABLE')) verdict = 'HOLDS';
    }
    if (tagged) RT.appendReachRecord(RT.buildReachRecord({ runId: run, ticket: id, repo: root, provider: 'anthropic', model: 'claude-opus-5-5', verdict: v.verdict, findingLines: v.findings }));
    const r = await boardTool(['verified', `--id=${id}`, '--provider=anthropic', '--model=claude-opus-5-5', `--run=${run}`, `--verdict=${verdict}`, '--author=feat-208 advisory probe'], { root });
    return r;
  }
  const norm = (s) => s.replace(/"recorded_at": "[^"]+"/g, '"recorded_at": "T"').replace(/"updated": "[^"]+"/g, '"updated": "D"');
  const scenarios = [
    ['C1 verified ticket gets a BROKEN whose findings are ALL unreachable', tVerified, [[real[0], 'U']]],
    ['C2 BROKEN-history ticket: mixed-tag BROKEN, then a HOLDS', tBroken, [[real[2], 'M'], [holds, null]]],
    ['C3 fresh ticket: all-unreachable BROKEN, then HOLDS, then all-unreachable BROKEN', tFresh, [[real[1], 'U'], [holds, null], [real[2], 'U']]],
  ];
  for (const [name, id, steps] of scenarios) {
    if (!id) { ok(`${name}: no qualifying real ticket`, false); continue; }
    const outs = [];
    for (const [text, mode] of steps) {
      const run = runId();
      const ra = await apply(A, id, mode ? tag(text, mode) : text, run, true);
      const rb = await apply(B, id, text, run, false);
      outs.push([ra.ok, rb.ok, ra.work_state, rb.work_state, ra.independently_verified, rb.independently_verified]);
    }
    const fa = norm(fs.readFileSync(path.join(BD(A), fileOf(A, id)), 'utf8'));
    const fb = norm(fs.readFileSync(path.join(BD(B), fileOf(B, id)), 'utf8'));
    ok(`${name}: every write accepted in both`, outs.every((o) => o[0] && o[1]), JSON.stringify(outs));
    ok(`${name}: ticket file byte-identical (timestamps normalised)`, fa === fb, `work_state ${recOf(A, id)?.work_state} vs ${recOf(B, id)?.work_state}; verdicts ${JSON.stringify((recOf(A, id)?.verification ?? []).slice(-steps.length).map((e) => e.verdict))} vs ${JSON.stringify((recOf(B, id)?.verification ?? []).slice(-steps.length).map((e) => e.verdict))}`);
    const pa = VS.ticketVerifications(BD(A), { id, markdown: fs.readFileSync(path.join(BD(A), fileOf(A, id)), 'utf8') });
    const pb = VS.ticketVerifications(BD(B), { id, markdown: fs.readFileSync(path.join(BD(B), fileOf(B, id)), 'utf8') });
    ok(`${name}: the one proof reader agrees (verified ${pb.verified})`, pa.verified === pb.verified && pa.entries.length === pb.entries.length);
  }
  const idxA = fs.readFileSync(path.join(BD(A), 'INDEX.md'), 'utf8'); const idxB = fs.readFileSync(path.join(BD(B), 'INDEX.md'), 'utf8');
  ok('C4 the generated board INDEX is identical', idxA === idxB);

  /* ── D. stored and counted ───────────────────────────────────────────── */
  console.log('\n── D. reach log + report');
  const log = RT.readReachLog();
  ok('D1 every tagged verdict was stored with its reach per finding', log.records.length === 6 && log.skipped === 0 && log.records.every((r) => RT.reachRecordProblems(r).length === 0), JSON.stringify({ n: log.records.length, s: log.skipped }));
  const rep = (args) => JSON.parse(spawnSync(process.execPath, [path.join(HERE, 'reach-report.mjs'), '--json', ...args], { encoding: 'utf8', env: process.env }).stdout);
  const total = rep([]).total;
  const want = { runs: 6, holds: 2, broken: 4 };
  const expFindings = log.records.reduce((s, r) => s + r.findings.length, 0);
  const expU = log.records.reduce((s, r) => s + r.findings.filter((f) => f.reach === 'UNREACHABLE').length, 0);
  ok('D2 report totals match the stored records', total.runs === want.runs && total.holds === want.holds && total.broken === want.broken && total.findings === expFindings && total.unreachable === expU && total.reachable + total.unreachable + total.untagged === expFindings, JSON.stringify(total));
  ok('D3 report groups per ticket', rep(['--ticket', tFresh]).tickets.length === 1 && rep(['--ticket', tFresh]).tickets[0].runs === 3);
  // The harness appends while the report reads: grade truncations of the real log.
  const rawLog = fs.readFileSync(RT.reachLogPath(), 'utf8');
  const cuts = [1, Math.floor(rawLog.length / 3), Math.floor(rawLog.length / 2), rawLog.length - 2, rawLog.length - 1];
  for (const c of cuts) {
    const f = path.join(scratch, `trunc-${c}.jsonl`); fs.writeFileSync(f, rawLog.slice(0, c));
    const complete = rawLog.slice(0, c).split('\n').filter((l) => { try { JSON.parse(l); return true; } catch { return false; } }).length;
    let r = null; try { r = rep(['--log', f]); } catch { r = null; }
    ok(`D4 truncated at ${c}/${rawLog.length}: no crash, counts only complete lines (${complete})`, r && r.total.runs === complete && r.skipped_lines <= 1, JSON.stringify(r?.total ?? 'crash'));
  }
  ok('D5 a malformed record is refused at write time', (() => { try { RT.appendReachRecord({ schema: 'x' }, path.join(scratch, 'bad.jsonl')); return false; } catch { return true; } })());
} catch (e) {
  fail += 1; console.log(`FAIL  suite threw: ${e.stack}`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(`\nFEAT-208 advisory reach: ${pass} passed, ${fail} failed${MUTANT ? ' (MUTANT label-consuming — must FAIL)' : ''}`);
process.exit(fail ? 1 : 0);
