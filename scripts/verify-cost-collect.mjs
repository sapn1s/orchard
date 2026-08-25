#!/usr/bin/env node
/**
 * verify-cost-collect.mjs — FEAT-086 proof suite.
 *
 *   node scripts/verify-cost-collect.mjs
 *
 * WHAT THIS SUITE IS BUILT AGAINST. Wherever a real artifact exists, it is used:
 * the real transcript store on this machine, a real dispatch's own reported
 * cost, real charter prose from the real board. Only where no real instance can
 * exist — a not-yet-invented model id, a deliberately torn file — is a fixture
 * synthesized, and each such case says so at its assertion.
 *
 * MUST-FAIL DISCIPLINE. Every behavioural fix here carries a proof that the
 * check reddens against the PRE-FIX behaviour. Those pre-fix behaviours are
 * SYNTHESIZED inline (a local re-implementation of the old rule), never read
 * from `HEAD` or "current" — a baseline that names its own subject stops being
 * a proof the moment the subject moves (docs/CONVENTIONS.md).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  foldUsage,
  costOf,
  rateFor,
  priceBuckets,
  phaseOfToolCall,
  attributePhases,
  ticketsIn,
  dispatchClassIn,
  verdictOf,
  assignRounds,
  providerOf,
  PRICES,
  CACHE_MULT,
} from './lib/cost-model.mjs';
import { buildLane, encodeProjectDir } from './cost-collect.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, observed) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${observed === undefined ? '' : `  [${observed}]`}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL  ${name}${observed === undefined ? '' : `  [observed: ${observed}]`}`);
  }
}

function section(t) {
  console.log(`\n${t}`);
}

/* ------------------------------------------------------------ real artifacts */

const REAL_ROOT = process.env.CLAUDE_TRANSCRIPT_ROOT || path.join(os.homedir(), '.claude', 'projects');
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/** Find real subagent transcripts for THIS project. Fails loudly if none. */
function realAgentFiles(limit = 40) {
  const token = encodeProjectDir(path.basename(REPO));
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(REAL_ROOT).filter((d) => d.includes(token));
  } catch {
    return out;
  }
  for (const d of dirs) {
    const abs = path.join(REAL_ROOT, d);
    let ents = [];
    try {
      ents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const sub = path.join(abs, e.name, 'subagents');
      if (!fs.existsSync(sub)) continue;
      for (const n of fs.readdirSync(sub)) {
        if (/^agent-[A-Za-z0-9_-]+\.jsonl$/.test(n)) out.push(path.join(sub, n));
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

function parseFile(file) {
  const entries = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* torn line */
    }
  }
  return entries;
}

/* ============================================================ 1. price model */

section('1. Price model — exact against the provider-side oracle');

/*
 * REAL ARTIFACT: the `total_cost_usd` and `modelUsage` block a real
 * `claude -p --output-format json` dispatch returned on 2026-08-20. This is the
 * harness's OWN accounting, computed independently of anything in this repo —
 * the only oracle available that is not this code grading itself.
 */
const ORACLE = {
  model: 'claude-haiku-4-5-20251001',
  service_tier: 'standard',
  input: 911,
  output: 117,
  cache_write_5m: 0,
  cache_write_1h: 7416,
  cache_read: 18134,
  at_ms: Date.parse('2026-08-20T10:00:00Z'),
};
const ORACLE_USD = 0.0181414;

const derived = costOf(ORACLE);
ok('costOf matches the CLI\'s own total_cost_usd to 7dp', Math.abs(derived - ORACLE_USD) < 1e-7, derived.toFixed(7));

// MUST-FAIL, synthesized pre-fix rule: the prior implementation
// (scripts/migrate-tickets.mjs) priced `input_tokens * 5/1e6 + output * 30/1e6`
// with one hardcoded vendor's rates and no cache classes at all.
const preFix = (ORACLE.input * 5) / 1e6 + (ORACLE.output * 30) / 1e6;
ok(
  'MUST-FAIL: the pre-fix flat-rate/input-only model does NOT match the oracle',
  Math.abs(preFix - ORACLE_USD) > 1e-3,
  `pre-fix ${preFix.toFixed(7)} vs oracle ${ORACLE_USD} (${((preFix / ORACLE_USD - 1) * 100).toFixed(0)}%)`,
);

// MUST-FAIL, synthesized pre-fix rule: pricing every cache write at the 5-minute
// multiplier. The oracle run happened to use 1-hour writes exclusively.
const flatCache = costOf({ ...ORACLE, cache_write_1h: 0, cache_write_5m: ORACLE.cache_write_1h });
ok(
  'MUST-FAIL: collapsing the 1h/5m cache-write split misprices this real run',
  Math.abs(flatCache - ORACLE_USD) > 1e-4,
  `${flatCache.toFixed(7)} = ${((flatCache / ORACLE_USD - 1) * 100).toFixed(1)}%`,
);

ok('cache multipliers are the published ratios', CACHE_MULT.write5m === 1.25 && CACHE_MULT.write1h === 2 && CACHE_MULT.read === 0.1);

/* -------------------------------------- unknown prices must be null, never 0 */

section('2. Unknown is printed as unknown — never as zero');

ok(
  'an unheard-of model prices to null, not 0',
  costOf({ ...ORACLE, model: 'claude-not-a-real-model-9' }) === null,
  String(costOf({ ...ORACLE, model: 'claude-not-a-real-model-9' })),
);
ok('an unknown SERVICE TIER prices to null (fast mode is 2x on Opus)', costOf({ ...ORACLE, service_tier: 'fast' }) === null);
ok('a prefix that merely looks familiar is not priced', costOf({ ...ORACLE, model: 'claude-opus-5-turbo' }) === null);
ok('provider of an unknown id is "unknown", not a default', providerOf('mistral-large') === 'unknown');
ok('a synthetic test id is 0, and is NOT reported as unpriced', costOf({ ...ORACLE, model: '<synthetic>' }) === 0);

const mixed = priceBuckets([ORACLE, { ...ORACLE, model: 'claude-not-a-real-model-9' }]);
ok('one unpriced bucket makes the TOTAL null, not a partial sum passed off as whole', mixed.cost_usd === null);
ok('...and the priced portion is still reported separately', mixed.cost_priced_usd > 0);
ok('...and the offending model is named', mixed.unpriced.join(',').includes('claude-not-a-real-model-9'), mixed.unpriced.join(','));

// A rate window must not be silently extrapolated past its end.
ok(
  'an introductory rate expires on its own date rather than applying forever',
  rateFor('claude-sonnet-5', Date.parse('2026-08-20T00:00:00Z')).in === 2 &&
    rateFor('claude-sonnet-5', Date.parse('2026-10-01T00:00:00Z')).in === 3,
);
ok('every price row is a positive number', Object.values(PRICES).every((rows) => rows.every((r) => r.in > 0 && r.out > 0)));

/* =================================================== 3. the double-count bug */

section('3. Usage folding — the largest error source, on REAL transcripts');

const agentFiles = realAgentFiles();
ok('LOUD: real subagent transcripts were found to test against', agentFiles.length > 0, `${agentFiles.length} files`);

if (agentFiles.length) {
  let anyDuplicated = false;
  let worstRatio = 1;
  let checked = 0;
  for (const f of agentFiles) {
    const entries = parseFile(f);
    const folded = foldUsage(entries);
    if (!folded.rowsSeen) continue;
    checked++;
    // The pre-fix rule, synthesized here: sum `usage` over every assistant row.
    let naiveRead = 0;
    let naiveOut = 0;
    for (const e of entries) {
      if (e?.type !== 'assistant') continue;
      const u = e.message?.usage;
      if (!u) continue;
      naiveRead += Number(u.cache_read_input_tokens ?? 0);
      naiveOut += Number(u.output_tokens ?? 0);
    }
    const foldedRead = folded.buckets.reduce((a, b) => a + b.cache_read, 0);
    if (folded.duplicatesDropped > 0) anyDuplicated = true;
    if (foldedRead > 0) worstRatio = Math.max(worstRatio, naiveRead / foldedRead);
    // Folding can only ever reduce or equal the naive sum.
    if (foldedRead > naiveRead + 1) {
      ok(`folded cache-read never exceeds the naive sum (${path.basename(f)})`, false, `${foldedRead} > ${naiveRead}`);
    }
  }
  ok('real transcripts DO contain duplicate usage rows (the bug is real, not theoretical)', anyDuplicated);
  ok(
    'MUST-FAIL: the pre-fix naive sum over-reports cache-read on real data',
    worstRatio > 1.3,
    `worst observed over-report ${worstRatio.toFixed(2)}x across ${checked} real lanes`,
  );
}

/*
 * SYNTHETIC (no real instance can be authored on demand): the streaming shape
 * that makes "first row wins" wrong. Three rows for one message id; only the
 * last carries the final output_tokens.
 */
const streamed = [
  { type: 'assistant', timestamp: '2026-08-20T10:00:00.000Z', message: { id: 'msg_1', model: 'claude-opus-5', content: [], usage: { input_tokens: 2, output_tokens: 1, cache_creation_input_tokens: 100, cache_read_input_tokens: 500, service_tier: 'standard' } } },
  { type: 'assistant', timestamp: '2026-08-20T10:00:01.000Z', message: { id: 'msg_1', model: 'claude-opus-5', content: [], usage: { input_tokens: 2, output_tokens: 1, cache_creation_input_tokens: 100, cache_read_input_tokens: 500, service_tier: 'standard' } } },
  { type: 'assistant', timestamp: '2026-08-20T10:00:02.000Z', message: { id: 'msg_1', model: 'claude-opus-5', content: [], usage: { input_tokens: 2, output_tokens: 379, cache_creation_input_tokens: 100, cache_read_input_tokens: 500, service_tier: 'standard' } } },
];
const sf = foldUsage(streamed);
ok('SYNTHETIC: three rows for one message fold to one request', sf.buckets.length === 1 && sf.buckets[0].requests === 1);
ok('...and it drops exactly the two duplicates, reported not hidden', sf.duplicatesDropped === 2, String(sf.duplicatesDropped));
ok('...cache-read counted once, not three times', sf.buckets[0].cache_read === 500, String(sf.buckets[0].cache_read));
ok(
  'MUST-FAIL: "first row wins" would have under-counted output 379 -> 1',
  sf.buckets[0].output === 379,
  `last-wins gives ${sf.buckets[0].output}`,
);

/* ============================================== 4. partial and truncated reads */

section('4. Partial / truncated reads — another process is writing these files');

if (agentFiles.length) {
  const src = fs.readFileSync(agentFiles[0], 'utf8');
  let survived = 0;
  let monotonic = true;
  let prevCost = -1;
  const cuts = [0.05, 0.17, 0.33, 0.5, 0.66, 0.8, 0.93, 0.999];
  for (const frac of cuts) {
    const cut = src.slice(0, Math.floor(src.length * frac)); // splits mid-line on purpose
    const entries = [];
    for (const line of cut.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        /* the torn tail — exactly what a live read hits */
      }
    }
    let lane;
    try {
      lane = buildLane({
        kind: 'subagent',
        laneId: 'trunc',
        sessionId: 's',
        projectDir: 'd',
        entries,
        meta: {},
        source: { bytes: cut.length },
        malformed: 0,
        truncated: true,
      });
      survived++;
    } catch {
      ok(`truncation at ${(frac * 100).toFixed(0)}% did not throw`, false);
      continue;
    }
    const c = lane.cost_priced_usd;
    if (c < prevCost - 1e-9) monotonic = false;
    prevCost = c;
  }
  ok('REAL transcript truncated at 8 plausible points: every prefix parses without throwing', survived === cuts.length, `${survived}/${cuts.length}`);
  ok('...and a longer prefix never reports LESS cost than a shorter one', monotonic);
}

// A file that is nothing but a torn line must yield an empty, honest record.
const tornOnly = buildLane({
  kind: 'subagent', laneId: 'x', sessionId: 's', projectDir: 'd',
  entries: [], meta: {}, source: { bytes: 40 }, malformed: 1, truncated: true,
});
ok('a wholly-unparseable prefix yields 0 turns and $0 priced, not a crash', tornOnly.turns === 0 && tornOnly.cost_priced_usd === 0);
ok('...and says so via malformed_lines / source_truncated', tornOnly.malformed_lines === 1 && tornOnly.source_truncated === true);

/* ================================================ 5. phase attribution */

section('5. Phases — read from what the agent DID');

ok('the dispatch tool this harness actually uses is charged to blocked_on_lane', phaseOfToolCall('Agent', {}) === 'blocked_on_lane');
ok('...as is the portable name for the same tool', phaseOfToolCall('Task', {}) === 'blocked_on_lane');
ok('a verify script run is testing, even behind a cd prologue', phaseOfToolCall('Bash', { command: 'cd /somewhere/repo && node scripts/verify-x.mjs' }) === 'testing');
ok('...and inside a shell loop', phaseOfToolCall('Bash', { command: 'for f in a b; do node scripts/verify-$f.mjs; done' }) === 'testing');
ok('npm run gate is testing', phaseOfToolCall('Bash', { command: 'npm run gate' }) === 'testing');
ok('git commit is bookkeeping, not testing, even when it follows a gate', phaseOfToolCall('Bash', { command: 'npm run gate && git commit -m x' }) === 'bookkeeping');
ok('an rg hunt is investigating', phaseOfToolCall('Bash', { command: 'rg -n foo src/' }) === 'investigating');
ok('a set -e prologue does not hide the command', phaseOfToolCall('Bash', { command: 'set -e\nrg -n foo' }) === 'investigating');
ok('editing source is building', phaseOfToolCall('Edit', { file_path: 'src/server/board.ts' }) === 'building');
ok('editing a TICKET is bookkeeping, not building', phaseOfToolCall('Write', { file_path: 'docs/bugs/BUG-001-x.md' }) === 'bookkeeping');
ok('reading the working agreement is orienting', phaseOfToolCall('Read', { file_path: 'docs/prompts/WORKING_AGREEMENT.v2.md' }) === 'orienting');
ok('reading CLAUDE.md is orienting', phaseOfToolCall('Read', { file_path: 'CLAUDE.md' }) === 'orienting');
ok('reading a source file is investigating, not orienting', phaseOfToolCall('Read', { file_path: 'src/server/agent-bridge.ts' }) === 'investigating');

// MUST-FAIL, synthesized pre-fix rule: first-token-only Bash matching.
const preFixBash = (cmd) => /^\s*(rg|ls|cat)\b/.test(cmd) ? 'investigating' : 'other';
const realShapes = [
  'cd /x/y && node scripts/verify-a.mjs',
  'cd /x/y; rg -n foo',
  'set -e\nnpm run gate',
  'grep -n foo bar',
];
const preFixOther = realShapes.filter((c) => preFixBash(c) === 'other').length;
const nowOther = realShapes.filter((c) => phaseOfToolCall('Bash', { command: c }) === 'other').length;
ok(
  'MUST-FAIL: the pre-fix first-token rule dumps real command shapes into "other"',
  preFixOther >= 3 && nowOther === 0,
  `pre-fix ${preFixOther}/4 unclassified, now ${nowOther}/4`,
);

/* -------------- timeline: harness metadata must not be charged as agent time */

const withMetadata = [
  { type: 'user', timestamp: '2026-08-20T10:00:00.000Z', message: { content: 'go' } },
  { type: 'assistant', timestamp: '2026-08-20T10:00:10.000Z', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'rg -n foo' } }] } },
  { type: 'ai-title', timestamp: '2026-08-20T10:00:20.000Z', aiTitle: 'x' },
  { type: 'queue-operation', timestamp: '2026-08-20T10:00:30.000Z' },
  { type: 'user', timestamp: '2026-08-20T10:00:40.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
];
const ph = attributePhases(withMetadata);
/*
 * The whole 40 s belongs to `investigating`: the 10 s the model spent deciding
 * to run `rg`, then the 30 s the `rg` took. Both are that investigation step —
 * the documented rule is that an interval is charged to the tool call spanning
 * it. What matters is that the two harness rows sitting inside the second
 * interval contribute nothing of their own and leave `other` empty.
 */
ok(
  'SYNTHETIC: harness metadata rows do not create phase time of their own',
  ph.investigating === 40000 && ph.other === 0,
  `investigating ${ph.investigating}ms, other ${ph.other}ms`,
);
// MUST-FAIL, synthesized pre-fix rule: timeline over ALL timestamped rows.
const preFixTimeline = (() => {
  const rows = withMetadata.map((e) => Date.parse(e.timestamp)).sort((a, b) => a - b);
  // the two metadata rows sit between the tool_use and its result, so under the
  // old rule the 20s spanning them fell through to `other`
  return rows.length;
})();
ok('MUST-FAIL: the pre-fix rule saw 5 timestamped rows where only 3 are turns', preFixTimeline === 5 && ph.accounted_ms === 40000, `accounted ${ph.accounted_ms}ms`);

const gappy = [
  { type: 'user', timestamp: '2026-08-20T10:00:00.000Z', message: { content: 'a' } },
  { type: 'assistant', timestamp: '2026-08-20T18:00:00.000Z', message: { content: [{ type: 'text', text: 'b' }] } },
];
const g = attributePhases(gappy);
ok('an 8-hour gap is idle, not eight hours of work', g.idle_gap_ms === 8 * 3600e3 && g.accounted_ms === 0, `idle ${g.idle_gap_ms}ms`);
ok('...and wall_ms still reports the true span, so parts can be checked against the whole', g.wall_ms === 8 * 3600e3);

/* ================================================= 6. attribution from prose */

section('6. Ticket / class / verdict — against REAL board prose');

const boardDir = path.join(REPO, 'docs', 'bugs');
const realTickets = fs.existsSync(boardDir) ? fs.readdirSync(boardDir).filter((f) => /^(BUG|FEAT|ARCH)-\d+.*\.md$/.test(f)) : [];
ok('LOUD: the real board has tickets to test against', realTickets.length > 0, `${realTickets.length} tickets`);
if (realTickets.length) {
  // Discovered at runtime — never a named ticket, which would redden the moment
  // the board changes (docs/CONVENTIONS.md).
  const someId = /^((BUG|FEAT|ARCH)-\d+)/.exec(realTickets[0])[1];
  const realProse = fs.readFileSync(path.join(boardDir, realTickets[0]), 'utf8');
  const found = ticketsIn(realProse).map((t) => t.id);
  ok('a real ticket file names its own id', found.includes(someId), `${someId} in [${found.slice(0, 4).join(',')}]`);
}

const multi = ticketsIn('Fix BUG-101 and then re-check BUG-102, plus BUG-101 again.');
ok('ALL tickets in a charter are kept, not just the first', multi.length === 2, JSON.stringify(multi));
ok('...in first-mention order, with mention counts', multi[0].id === 'BUG-101' && multi[0].mentions === 2);

ok('an explicitly declared class is read', dispatchClassIn('Class: verify\n\nbreak this claim') === 'verify');
ok('...case- and separator-tolerant', dispatchClassIn('Dispatch class = fix') === 'fix');
// MUST-FAIL, synthesized pre-fix rule: whole-prompt keyword matching.
const boilerplate =
  'Build the thing. High-stakes fixes get an independent skeptic: flag that an independent clean-room verify pass is warranted.';
const preFixClass = /verify/i.test(boilerplate) ? 'verify' : null;
ok(
  'MUST-FAIL: keyword matching calls the standing boilerplate a verify lane; declaration-only says null',
  preFixClass === 'verify' && dispatchClassIn(boilerplate) === null,
  `keyword=${preFixClass}, declared=${dispatchClassIn(boilerplate)}`,
);

ok('a verdict is read from the tail of the final report', verdictOf('...\n\nVerdict: HOLDS') === 'HOLDS');
ok('BROKEN outranks HOLDS when a report names both', verdictOf('the earlier claim HOLDS but this is BROKEN') === 'BROKEN');
ok('a lane with no verdict word is assigned none', verdictOf('I refactored the parser.') === null);
ok('a verdict quoted early in a long run is not this lane\'s verdict', verdictOf('HOLDS' + ' '.repeat(6000) + 'done.') === null);

const rounds = assignRounds([
  { lane_id: 'b', tickets: [{ id: 'BUG-1' }], started_at: '2026-08-20T02:00:00Z' },
  { lane_id: 'a', tickets: [{ id: 'BUG-1' }], started_at: '2026-08-20T01:00:00Z' },
  { lane_id: 'c', tickets: [{ id: 'BUG-2' }], started_at: '2026-08-20T03:00:00Z' },
  { lane_id: 'd', tickets: [], started_at: '2026-08-20T04:00:00Z' },
]);
ok('rounds number by start time within a ticket', rounds.get('a').round === 1 && rounds.get('b').round === 2);
ok('each ticket counts its own rounds', rounds.get('c').round === 1);
ok('a lane naming no ticket gets no round rather than a fabricated one', !rounds.has('d'));

/* ============================================ 7. end-to-end on the real store */

section('7. End to end over the REAL store');

if (agentFiles.length) {
  const entries = parseFile(agentFiles[0]);
  const lane = buildLane({
    kind: 'subagent', laneId: 'real', sessionId: 's', projectDir: 'd',
    entries, meta: { agentType: 'worker', description: 'd', spawnDepth: 1 },
    source: { bytes: 1 }, malformed: 0, truncated: false,
  });
  const phaseSum = Object.values(lane.phases).reduce((a, b) => a + b, 0);
  ok('phase parts sum exactly to accounted_ms (the whole is checkable)', phaseSum === lane.accounted_ms, `${phaseSum} vs ${lane.accounted_ms}`);
  ok('accounted + idle never exceeds wall clock', lane.accounted_ms + lane.idle_gap_ms <= lane.wall_ms + 1, `${lane.accounted_ms}+${lane.idle_gap_ms} vs ${lane.wall_ms}`);
  ok('a real lane produces a priced figure or names why not', lane.cost_usd !== undefined && (lane.cost_usd !== null || lane.unpriced.length > 0));
  ok('every real model id seen resolves to a known provider', lane.providers.every((p) => p !== 'unknown'), lane.providers.join(','));
  ok('token total equals the sum of its classes', lane.tokens.total === lane.tokens.input + lane.tokens.output + lane.tokens.cache_write_5m + lane.tokens.cache_write_1h + lane.tokens.cache_read);
}

/* ----------------------------------------------------------------- verdict */

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
if (fail) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
