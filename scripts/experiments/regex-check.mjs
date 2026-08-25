#!/usr/bin/env node
/**
 * EXPERIMENT (scratch): deterministic REGEX baseline for detecting a report
 * whose green CLAIM contradicts EVIDENCE quoted in the same report.
 *
 * Two variants, both good-faith:
 *  - naive: flags if the report contains ANY green claim AND ANY failure token
 *    (FAIL / exit 1 / N<M) anywhere. (This is the strawman a lot of people
 *    reach for; it ignores the must-FAIL-first methodology.)
 *  - smart: segments the report into a "pre-fix / must-FAIL" region (where
 *    failures are EXPECTED) and the rest ("live"), then flags only when a green
 *    claim coexists with a LIVE failure: a live tally with N<M, a live `exit 1`,
 *    a live standalone FAIL, or a green N/N claim whose own numbers don't match.
 *
 * Exported: checkReport(text) -> { naive:{flag,reasons[]}, smart:{flag,reasons[]} }
 */

const GREEN_CLAIM = [
  /\ball green\b/i,
  /\ball (?:pass|passing)\b/i,
  /\bpasses? end to end\b/i,
  /\bno regressions?\b/i,
  /\bevery suite passes\b/i,
  /\bsuite is green\b/i,
  /\b(?:is|are|stay) green\b/i,
  /\bgate\b[^.\n]{0,20}\bpass\b/i,
  /\bexit 0\b/i,
  /\b(\d+)\/\1\b/, // N/N tally asserted as a whole (e.g. 19/19)
];

// tallies like 15/19, 45/48, "15 passed, 4 failed"
const SLASH_TALLY = /\b(\d{1,4})\/(\d{1,4})\b/g;
const PASSFAIL_TALLY = /\b(\d{1,4})\s+passed(?:,|\s)+(\d{1,4})\s+failed\b/gi;
const EXIT1 = /\bexit(?:\s+code)?[:= ]*\s*1\b/gi;
const FAIL_TOKEN = /(?:^|\s)(?:FAIL|FAILED|FAILURE)\b/g;

// markers that a nearby failure is EXPECTED (pre-fix / must-FAIL-first)
const PREFIX_MARK = /(must-?fail|pre-?fix|pre-change|before the fix|unmodified|old[- ]code|on `?[0-9a-f]{6,}`? \(pre|stashed (?:my|the) fix|reproduced the (?:reported|must))/i;

function greenClaims(text) {
  const hits = [];
  for (const re of GREEN_CLAIM) {
    const m = text.match(re);
    if (m) hits.push(m[0]);
  }
  return hits;
}

// find all failure signals with their char offset
function failureSignals(text) {
  const sigs = [];
  let m;
  const s1 = new RegExp(SLASH_TALLY);
  while ((m = s1.exec(text))) {
    const n = +m[1], d = +m[2];
    if (d > 0 && n < d && d <= 2000) sigs.push({ kind: 'tally', at: m.index, text: m[0], n, d });
  }
  const s2 = new RegExp(PASSFAIL_TALLY);
  while ((m = s2.exec(text))) {
    const passed = +m[1], failed = +m[2];
    if (failed > 0) sigs.push({ kind: 'passfail', at: m.index, text: m[0], failed });
  }
  const s3 = new RegExp(EXIT1);
  while ((m = s3.exec(text))) sigs.push({ kind: 'exit1', at: m.index, text: m[0] });
  const s4 = new RegExp(FAIL_TOKEN);
  while ((m = s4.exec(text))) sigs.push({ kind: 'failword', at: m.index, text: m[0].trim() });
  return sigs;
}

// Is a signal at offset `at` inside a pre-fix/must-FAIL region? Heuristic:
// look back up to 220 chars for a pre-fix marker (regions are short blurbs).
function isExpected(text, at) {
  const windowStart = Math.max(0, at - 220);
  const before = text.slice(windowStart, at);
  return PREFIX_MARK.test(before);
}

export function checkReport(text) {
  const greens = greenClaims(text);
  const sigs = failureSignals(text);

  // naive: green claim + any failure token anywhere
  const naiveFlag = greens.length > 0 && sigs.length > 0;
  const naive = {
    flag: naiveFlag,
    reasons: naiveFlag
      ? [`green claim ${JSON.stringify(greens)} co-occurs with failure token(s) ${JSON.stringify(sigs.slice(0, 4).map((s) => s.text))}`]
      : [],
  };

  // smart: green claim + a LIVE (non-expected) failure signal
  const liveSigs = sigs.filter((s) => !isExpected(text, s.at));
  // also catch a green N/N claim whose own numbers mismatch: e.g. "green (48/48)"
  // right next to a 45/48 — already covered by liveSigs tally. And a bare
  // mismatched-in-claim like "12/12 and 7/7" alongside "12/14" -> liveSigs tally.
  const smartFlag = greens.length > 0 && liveSigs.length > 0;
  const smart = {
    flag: smartFlag,
    reasons: smartFlag
      ? [`green claim ${JSON.stringify(greens)} co-occurs with LIVE (non-pre-fix) failure ${JSON.stringify(liveSigs.slice(0, 4).map((s) => s.text))}`]
      : [],
  };

  return { naive, smart, _debug: { greens, sigs, liveSigs } };
}

// CLI: node regex-check.mjs corpus/corpus.json
if (import.meta.url === `file://${process.argv[1]}`) {
  const fs = await import('node:fs');
  const p = process.argv[2] || new URL('./corpus/corpus.json', import.meta.url).pathname;
  const corpus = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const item of corpus) {
    const r = checkReport(item.report);
    console.log(item.id.padEnd(22), 'naive', r.naive.flag ? 'FLAG' : 'pass', ' smart', r.smart.flag ? 'FLAG' : 'pass');
  }
}
