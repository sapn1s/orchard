#!/usr/bin/env node
/**
 * EXPERIMENT (scratch): compute the comparison metrics for the report-checker
 * experiment. Reads corpus/corpus.json, runs the two regex variants live, and
 * reads the cached Haiku verdicts from corpus/haiku-results.json.
 *
 * Two tasks are scored separately, because the corpus deliberately separates
 * them:
 *  TASK 1 — claim-vs-cited-evidence CONTRADICTION detection (what a report-
 *    reading checker can actually do). Positives = the 8 synthetic internal-
 *    contradiction reports (group C). Negatives = the 23 real reports that are
 *    internally consistent (groups A + B). Recall, precision, FP-rate here.
 *  TASK 2 — catching the CLASS THAT COSTS THE MOST: the 7 real reports that
 *    self-reported green and were then found BROKEN by an independent clean-room
 *    (group A). These have NO internal contradiction, so we report how many each
 *    checker flags and note that any flag is incidental, not signal.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkReport } from './regex-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(fs.readFileSync(path.join(HERE, 'corpus', 'corpus.json'), 'utf8'));
const haiku = JSON.parse(fs.readFileSync(path.join(HERE, 'corpus', 'haiku-results.json'), 'utf8'));

// predictions per checker
function predict(item) {
  const rx = checkReport(item.report);
  const h = haiku[item.id];
  return {
    naive: rx.naive.flag,
    smart: rx.smart.flag,
    haiku: h ? h.verdict === 'SUSPECT' : null,
  };
}

const rows = corpus.map((it) => ({ ...it, pred: predict(it) }));

function scoreTask1(checker) {
  // positives = group C (internallyContradicts true); negatives = A+B
  const pos = rows.filter((r) => r.group === 'C_synth_contradiction');
  const neg = rows.filter((r) => r.group !== 'C_synth_contradiction');
  const tp = pos.filter((r) => r.pred[checker] === true).length;
  const fn = pos.length - tp;
  const fp = neg.filter((r) => r.pred[checker] === true).length;
  const tn = neg.length - fp;
  const recall = tp / pos.length;
  const precision = tp + fp ? tp / (tp + fp) : NaN;
  const fpRate = fp / neg.length;
  return { tp, fn, fp, tn, recall, precision, fpRate, posN: pos.length, negN: neg.length };
}

function fmtPct(x) { return Number.isNaN(x) ? 'n/a' : (100 * x).toFixed(0) + '%'; }

console.log('='.repeat(78));
console.log('TASK 1 — claim-vs-cited-evidence CONTRADICTION detection');
console.log('  positives = 8 synthetic internal-contradiction reports (group C)');
console.log('  negatives = 23 real internally-consistent reports (groups A+B)');
console.log('='.repeat(78));
console.log('checker        recall(TP/8)   precision      FP-rate(FP/23)   TP FP FN TN');
for (const c of ['naive', 'smart', 'haiku']) {
  const s = scoreTask1(c);
  console.log(
    c.padEnd(14),
    `${fmtPct(s.recall)} (${s.tp}/${s.posN})`.padEnd(14),
    fmtPct(s.precision).padEnd(14),
    `${fmtPct(s.fpRate)} (${s.fp}/${s.negN})`.padEnd(16),
    `${s.tp} ${s.fp} ${s.fn} ${s.tn}`,
  );
}

// where the model wins: split group C by regexCatchable
console.log('\n--- Group C breakdown (numeric vs prose contradictions) ---');
console.log('id                 kind     regexCatchable  naive smart haiku');
for (const r of rows.filter((r) => r.group === 'C_synth_contradiction')) {
  console.log(
    r.id.padEnd(18),
    (r.kind || '').padEnd(8),
    String(r.regexCatchable).padEnd(15),
    (r.pred.naive ? 'FLAG' : 'pass').padEnd(5),
    (r.pred.smart ? 'FLAG' : 'pass').padEnd(5),
    r.pred.haiku == null ? '???' : (r.pred.haiku ? 'FLAG' : 'pass'),
  );
}

console.log('\n' + '='.repeat(78));
console.log('TASK 2 — the class that costs the most: real self-reported-green');
console.log('         reports later found BROKEN by independent clean-room (group A, n=7)');
console.log('  These reports have NO internal contradiction, so no report-reader can');
console.log('  catch them from the text. Flags below are INCIDENTAL, not signal.');
console.log('='.repeat(78));
console.log('id                    naive smart haiku   (note)');
for (const r of rows.filter((r) => r.group === 'A_real_reversed')) {
  console.log(
    r.id.padEnd(21),
    (r.pred.naive ? 'FLAG' : 'pass').padEnd(5),
    (r.pred.smart ? 'FLAG' : 'pass').padEnd(5),
    (r.pred.haiku == null ? '???' : (r.pred.haiku ? 'FLAG' : 'pass')).padEnd(7),
    r.note,
  );
}
const A = rows.filter((r) => r.group === 'A_real_reversed');
for (const c of ['naive', 'smart', 'haiku']) {
  const f = A.filter((r) => r.pred[c] === true).length;
  console.log(`  ${c} flags ${f}/7 of the reversed reports`);
}

// Cost & latency from the Haiku cache
console.log('\n' + '='.repeat(78));
console.log('COST & LATENCY (Haiku via `claude -p`, subscription path)');
console.log('='.repeat(78));
const hs = Object.values(haiku).filter((h) => h && h.measuredCostUsd != null);
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const measuredCosts = hs.map((h) => h.measuredCostUsd);
const walls = hs.map((h) => h.wall).filter(Boolean);
const durs = hs.map((h) => h.durationMs).filter(Boolean);
const intrinsicIn = hs.map((h) => h.intrinsic?.inputTokens).filter((x) => x != null);
const intrinsicOut = hs.map((h) => h.intrinsic?.outputTokens).filter((x) => x != null);
const intrinsicCost = hs.map((h) => h.intrinsic?.costUSD).filter((x) => x != null);
console.log(`n calls with usage: ${hs.length}`);
console.log(`measured cost/call (harness-inflated): avg $${avg(measuredCosts).toFixed(4)}  total $${measuredCosts.reduce((a,b)=>a+b,0).toFixed(3)}`);
console.log(`wall latency/call: avg ${(avg(walls)/1000).toFixed(1)}s  (claude duration_ms avg ${(avg(durs)/1000).toFixed(1)}s)`);
if (intrinsicCost.length) console.log(`intrinsic Haiku model cost/call (usage.modelUsage): avg $${avg(intrinsicCost).toFixed(5)}  (in ${Math.round(avg(intrinsicIn))} tok, out ${Math.round(avg(intrinsicOut))} tok)`);
// analytic intrinsic estimate from report sizes (Haiku $1/$5 per MTok, ~250 tok prompt, ~40 tok out)
const promptTok = 250;
const perReport = corpus.map((it) => {
  const inTok = promptTok + Math.ceil(it.report.length / 4);
  return (inTok * 1e-6 * 1.0) + (40 * 1e-6 * 5.0);
});
console.log(`analytic lean-API estimate (no harness): avg $${avg(perReport).toFixed(5)}/report  (Haiku $1/$5 per MTok, ~${promptTok}-tok prompt + report, ~40 tok out)`);

// parse-failure / error accounting for Haiku
const errs = Object.entries(haiku).filter(([, h]) => !h || !h.verdict);
if (errs.length) console.log(`\nHaiku calls without a verdict: ${errs.length} -> ${errs.map(([k]) => k).join(', ')}`);
const nullPreds = rows.filter((r) => r.pred.haiku == null).map((r) => r.id);
if (nullPreds.length) console.log(`items missing Haiku verdict: ${nullPreds.join(', ')}`);
