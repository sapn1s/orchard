#!/usr/bin/env node
/**
 * verify-bug-175.mjs — proof suite for the three MEASURED telemetry defects.
 *
 *   node scripts/verify-bug-175.mjs
 *
 * DEFECT 1  `blocked_on_lane` is structurally blind to async dispatch (3.8% vs 84%).
 * DEFECT 2  `npm run usage` over-reports 7-day spend ~4× (whole-lane by ended_at).
 * DEFECT 3  the `Dispatch:` grammar rejects `ticket=none` (a declared absence).
 *
 * MUST-FAIL DISCIPLINE (docs/CONVENTIONS.md): every behavioural fix carries a
 * check that reddens against the PRE-FIX behaviour, and each pre-fix behaviour is
 * SYNTHESIZED inline (a local re-implementation of the old rule) or measured as
 * the real pre-fix quantity — never read from HEAD, which would stop being a
 * proof the moment the fix lands.
 *
 * REAL ARTIFACT: defects 1 and 2 are also exercised against the real orchestrator
 * transcript on this machine (discovered at runtime, never named), and the suite
 * FAILS LOUDLY if no qualifying orchestrator transcript exists at all.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  pairDispatches,
  dispatchOccupancy,
  mergeIntervals,
  attributePhases,
  laneRequestCosts,
  parseDispatchDeclaration,
  formatDispatchDeclaration,
  resolveLaneAttribution,
} from './lib/cost-model.mjs';
import { buildLane, rollUp, encodeProjectDir } from './cost-collect.mjs';

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
const H = 3600e3;
const MIN = 60e3;

/* ------------------------------------------------------------ real artifact */

const REAL_ROOT = process.env.CLAUDE_TRANSCRIPT_ROOT || path.join(os.homedir(), '.claude', 'projects');
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

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

/** The project's own orchestrator transcript with the MOST Agent dispatches. */
function realOrchestratorFile() {
  const token = encodeProjectDir(path.basename(REPO));
  let dirs = [];
  try {
    dirs = fs.readdirSync(REAL_ROOT).filter((d) => d.includes(token));
  } catch {
    return null;
  }
  let best = null;
  let bestN = 0;
  for (const d of dirs) {
    const abs = path.join(REAL_ROOT, d);
    let ents = [];
    try {
      ents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const sessionId = e.name.replace(/\.jsonl$/, '');
      if (!fs.existsSync(path.join(abs, sessionId, 'subagents'))) continue; // orchestrator
      // Count Agent dispatches cheaply from the raw text.
      const raw = fs.readFileSync(path.join(abs, e.name), 'utf8');
      const n = (raw.match(/"name":"Agent"/g) || []).length;
      if (n > bestN) {
        bestN = n;
        best = path.join(abs, e.name);
      }
    }
  }
  return best;
}

/* ================================================= DEFECT 1: async occupancy */

section('DEFECT 1 — blocked_on_lane is blind to async dispatch');

/*
 * SYNTHETIC (a controlled timeline; the real store is exercised below). One
 * dispatch, its completion notification 20 min later (past the 5-min idle
 * cutoff), the orchestrator's next turn at 25 min. The gap the old rule swept
 * into idle is 25 min; 20 of those had a dispatch outstanding.
 */
const T0 = Date.parse('2026-08-20T10:00:00.000Z');
const synth = [
  { type: 'assistant', timestamp: new Date(T0).toISOString(), message: { content: [{ type: 'tool_use', id: 'toolu_a1', name: 'Agent', input: { prompt: 'go' } }] } },
  { type: 'user', timestamp: new Date(T0 + 5e3).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_a1', content: 'Async agent launched successfully. agentId: aaa' }] } },
  { type: 'queue-operation', operation: 'enqueue', timestamp: new Date(T0 + 20 * MIN).toISOString(), content: '<task-notification>\n<task-id>aaa</task-id>\n<tool-use-id>toolu_a1</tool-use-id>\n<status>completed</status>\n</task-notification>' },
  { type: 'user', timestamp: new Date(T0 + 25 * MIN).toISOString(), message: { content: 'the lane finished, next step' } },
];

const pair = pairDispatches(synth);
ok('SYNTHETIC: the async Agent dispatch pairs to its completion notification', pair.dispatches === 1 && pair.waits.length === 1 && pair.unpaired === 0);
ok('...and the wait is dispatch→notification (20 min), not the ~0 tool span', pair.waits[0].end - pair.waits[0].start === 20 * MIN, `${(pair.waits[0].end - pair.waits[0].start) / MIN} min`);

const occ = dispatchOccupancy(synth);
ok('SYNTHETIC: outstanding union is the 20-min wait', occ.outstanding_union_ms === 20 * MIN, `${occ.outstanding_union_ms / MIN} min`);
ok('...occupancy is union / engaged wall, > 0 (not swept to idle)', occ.occupancy > 0.7, `${(occ.occupancy * 100).toFixed(1)}%`);

const ph = attributePhases(synth);
ok('NEW: attributePhases charges the outstanding wait to blocked_on_lane', ph.blocked_on_lane === 20 * MIN, `${ph.blocked_on_lane / MIN} min`);
ok('...and only the non-outstanding remainder (5 min) is idle', ph.idle_gap_ms === 5 * MIN, `${ph.idle_gap_ms / MIN} min`);

// MUST-FAIL, synthesized pre-fix rule: the old loop sent EVERY >idle gap to idle
// with no dispatch exemption, so blocked_on_lane could only ever catch the ~0
// Agent tool span. Re-implemented inline so the baseline cannot move.
function preFixBlocked(entries, idleGapMs = 5 * MIN) {
  const rows = entries
    .filter((e) => e.type === 'user' || e.type === 'assistant')
    .map((e) => Date.parse(e.timestamp))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  let blocked = 0;
  let idle = 0;
  for (let i = 0; i + 1 < rows.length; i++) {
    const dt = rows[i + 1] - rows[i];
    if (dt <= 0) continue;
    if (dt > idleGapMs) {
      idle += dt;
      continue;
    }
    // a sub-idle gap: under the old rule it is charged to the spanning tool's
    // phase; the Agent tool span here is ~0, so blocked stays 0.
  }
  return { blocked, idle };
}
const old = preFixBlocked(synth);
ok(
  'MUST-FAIL: the pre-fix idle rule swept the ~25-min gap into idle; the fix moves ~20 min to blocked',
  old.blocked === 0 && old.idle > 24 * MIN && ph.blocked_on_lane >= 19 * MIN && ph.idle_gap_ms < 6 * MIN,
  `pre-fix idle ${(old.idle / MIN).toFixed(1)}min blocked 0; new blocked ${(ph.blocked_on_lane / MIN).toFixed(1)}min idle ${(ph.idle_gap_ms / MIN).toFixed(1)}min`,
);

// A genuine overnight PARK (no dispatch outstanding) must still be idle.
const parked = [
  { type: 'user', timestamp: new Date(T0).toISOString(), message: { content: 'a' } },
  { type: 'assistant', timestamp: new Date(T0 + 8 * H).toISOString(), message: { content: [{ type: 'text', text: 'b' }] } },
];
const pp = attributePhases(parked);
ok('a park with NO dispatch outstanding is still idle, not blocked', pp.idle_gap_ms === 8 * H && pp.blocked_on_lane === 0, `idle ${pp.idle_gap_ms / H}h blocked ${pp.blocked_on_lane / H}h`);

/* ---- real orchestrator transcript ---- */

const orchFile = realOrchestratorFile();
ok('LOUD: a real orchestrator transcript with Agent dispatches was found', Boolean(orchFile), orchFile ? path.basename(orchFile) : 'NONE');

if (orchFile) {
  const entries = parseFile(orchFile);
  const d = dispatchOccupancy(entries);
  console.log(
    `    real: ${d.dispatches} dispatches, ${d.pairable} paired · engaged ${(d.engaged_wall_ms / H).toFixed(1)}h · ` +
      `outstanding ${(d.outstanding_union_ms / H).toFixed(1)}h = ${(d.occupancy * 100).toFixed(1)}% · parallelism ${d.parallelism.toFixed(2)}x · ` +
      `wait med/p90/max ${(d.wait_ms.median / MIN).toFixed(1)}/${(d.wait_ms.p90 / MIN).toFixed(1)}/${(d.wait_ms.max / MIN).toFixed(1)} min`,
  );
  ok('REAL: occupancy is a large fraction of engaged wall (far from the 3.8% the phase reported)', d.occupancy > 0.5, `${(d.occupancy * 100).toFixed(1)}%`);
  ok('REAL: parallelism is >= 1.0 (summed wait >= union)', d.parallelism >= 1, d.parallelism.toFixed(2));
  ok('REAL: most dispatches paired to a completion', d.pairable > d.dispatches * 0.6, `${d.pairable}/${d.dispatches}`);

  // MUST-FAIL on REAL data: the pre-fix metric the old blocked_on_lane could see
  // was the Agent TOOL span (tool_use → its immediate "launched" tool_result).
  // Measure it directly and show it is a rounding error next to the true wait.
  const dispAt = new Map();
  for (const e of entries) {
    if (e?.type !== 'assistant') continue;
    const t = Date.parse(e?.timestamp ?? '');
    if (!Number.isFinite(t)) continue;
    for (const b of e.message?.content ?? []) if (b?.type === 'tool_use' && b.name === 'Agent' && !dispAt.has(String(b.id))) dispAt.set(String(b.id), t);
  }
  let toolSpan = 0;
  for (const e of entries) {
    if (e?.type !== 'user' || !Array.isArray(e.message?.content)) continue;
    const t = Date.parse(e?.timestamp ?? '');
    if (!Number.isFinite(t)) continue;
    for (const b of e.message.content) {
      const s = dispAt.get(String(b?.tool_use_id));
      if (b?.type === 'tool_result' && s != null && t >= s) {
        toolSpan += t - s;
        dispAt.delete(String(b.tool_use_id));
      }
    }
  }
  console.log(`    real: Agent tool span (what the old blocked_on_lane could see) = ${(toolSpan / H).toFixed(3)}h across ${d.dispatches} dispatches`);
  ok(
    'MUST-FAIL: the old metric (Agent tool span) is < 1h while true outstanding is tens of hours',
    toolSpan < 1 * H && d.outstanding_union_ms > 20 * H,
    `tool span ${(toolSpan / H).toFixed(3)}h vs outstanding ${(d.outstanding_union_ms / H).toFixed(1)}h`,
  );

  // The collector's own lane record carries the occupancy.
  const lane = buildLane({
    kind: 'orchestrator', laneId: 'real', sessionId: 's', projectDir: 'd',
    entries, meta: {}, source: { bytes: 1 }, malformed: 0, truncated: false,
  });
  ok('the lane record exposes dispatch occupancy', lane.dispatch && lane.dispatch.occupancy > 0.5, `${(lane.dispatch.occupancy * 100).toFixed(1)}%`);
  const phaseSum = Object.values(lane.phases).reduce((a, b) => a + b, 0);
  ok('phase parts STILL sum exactly to accounted_ms after the blocked_on_lane fix', phaseSum === lane.accounted_ms, `${phaseSum} vs ${lane.accounted_ms}`);
  ok('accounted + idle STILL never exceeds wall clock', lane.accounted_ms + lane.idle_gap_ms <= lane.wall_ms + 1);
}

/* ================================================= DEFECT 2: per-request bins */

section('DEFECT 2 — usage buckets a whole lane by ended_at, over-reporting 7d');

/*
 * SYNTHETIC lane spanning 36 days: many requests old, a few recent, the lane
 * "ended" today. laneRequestCosts must carry each request's OWN timestamp so a
 * window can be filled per request rather than per lane end.
 */
const now = Date.parse('2026-09-08T08:00:00.000Z');
const day = 86400e3;
function reqEntry(ageDays, out) {
  const ts = new Date(now - ageDays * day).toISOString();
  return { type: 'assistant', timestamp: ts, message: { id: `m${ageDays}-${out}`, model: 'claude-opus-5', content: [], usage: { input_tokens: 0, output_tokens: out, cache_read_input_tokens: 0, service_tier: 'standard' } } };
}
// 30 old requests (36..8 days ago) + 3 recent (within 7d). Opus out = $25/M.
const spanEntries = [];
for (let ageDays = 36; ageDays >= 8; ageDays--) spanEntries.push(reqEntry(ageDays, 40000)); // 29 old, each $1.00
spanEntries.push(reqEntry(2, 40000), reqEntry(1, 40000), reqEntry(0.1, 40000)); // 3 recent, $1.00 each

const reqCosts = laneRequestCosts(spanEntries);
ok('laneRequestCosts returns one priced row per request, each with its own at_ms', reqCosts.length === 32 && reqCosts.every((r) => Number.isFinite(r.at_ms)), `${reqCosts.length} rows`);

const cutoff7d = now - 7 * day;
const perRequest7d = reqCosts.filter((r) => r.at_ms >= cutoff7d).reduce((a, r) => a + r.cost_priced_usd, 0);
// MUST-FAIL, synthesized pre-fix rule: whole-lane cost bucketed by ended_at. The
// lane ended 0.1 days ago, so the OLD rule dumps ALL 32 requests into 7d.
const laneTotal = reqCosts.reduce((a, r) => a + r.cost_priced_usd, 0);
const laneEndMs = Math.max(...reqCosts.map((r) => r.at_ms));
const wholeLane7d = laneEndMs >= cutoff7d ? laneTotal : 0;
ok('per-request 7d counts only the 3 recent requests (~$3), not the whole lane', Math.abs(perRequest7d - 3) < 0.01, `$${perRequest7d.toFixed(2)}`);
ok(
  'MUST-FAIL: the pre-fix whole-lane-by-ended_at rule dumps the entire lane (~$32) into 7d',
  Math.abs(wholeLane7d - 32) < 0.01 && wholeLane7d > perRequest7d * 5,
  `pre-fix $${wholeLane7d.toFixed(2)} vs per-request $${perRequest7d.toFixed(2)}`,
);

/* ---- real store: the SAME over-report direction on real lanes ---- */

if (orchFile) {
  // Reprice per request from the real orchestrator transcript and compare the two
  // window rules on the real 7-day window anchored at the transcript's own end.
  const entries = parseFile(orchFile);
  const rc = laneRequestCosts(entries);
  const withTs = rc.filter((r) => Number.isFinite(r.at_ms));
  ok('REAL: the orchestrator lane yields per-request timestamps to bin by', withTs.length > 100, `${withTs.length} requests`);
  if (withTs.length) {
    const end = Math.max(...withTs.map((r) => r.at_ms));
    const cut = end - 7 * day;
    const perReq = withTs.filter((r) => r.at_ms >= cut).reduce((a, r) => a + r.cost_priced_usd, 0);
    const whole = withTs.reduce((a, r) => a + r.cost_priced_usd, 0); // lane ended at `end` → all in 7d under old rule
    console.log(`    real 7d (anchored at lane end): per-request $${perReq.toFixed(2)} vs whole-lane-by-end $${whole.toFixed(2)}`);
    ok(
      'MUST-FAIL (real): a long lane over-reports 7d spend when bucketed by its end',
      whole > perReq * 1.5,
      `whole $${whole.toFixed(2)} vs per-request $${perReq.toFixed(2)} (${(whole / perReq).toFixed(1)}x)`,
    );
  }
}

// Proration: a request with no timestamp is prorated across the lane span, not dropped.
const noTs = [
  { type: 'assistant', timestamp: 'not-a-date', message: { id: 'x', model: 'claude-opus-5', content: [], usage: { output_tokens: 40000, service_tier: 'standard' } } },
];
const rcNoTs = laneRequestCosts(noTs);
ok('a request with an unparseable timestamp still prices, with at_ms null (to prorate)', rcNoTs.length === 1 && rcNoTs[0].at_ms === null && rcNoTs[0].cost_priced_usd > 0);

/* ================================================= DEFECT 3: ticket=none */

section('DEFECT 3 — the Dispatch grammar accepts ticket=none as a declared absence');

const dNone = parseDispatchDeclaration('Dispatch: ticket=none phase=fixing round=1 class=explore');
ok('ticket=none parses as a declared absence (ticket_none), not a ticket id', dNone.ticket_none === true && dNone.tickets === null, JSON.stringify({ ticket_none: dNone.ticket_none, tickets: dNone.tickets }));
ok('...and is NOT reported as a rejected/malformed complaint', dNone.rejected.length === 0 && dNone.malformed.length === 0, JSON.stringify(dNone.rejected));
ok('...while the other fields still parse normally', dNone.phase === 'fixing' && dNone.round === 1 && dNone.class === 'explore');

// MUST-FAIL, synthesized pre-fix rule: `none` validated against the ticket-id
// regex and rejected. (The live regex still rejects it — the fix is the sentinel
// branch ABOVE that regex, so this reproduces exactly the pre-fix path.)
const TICKET_ID_ONE = /^(BUG|FEAT|ARCH|TASK)-\d{3,}$/;
const preFixRejectedNone = !TICKET_ID_ONE.test('none');
ok(
  'MUST-FAIL: the pre-fix rule rejected ticket=none as "not a ticket id"',
  preFixRejectedNone === true && dNone.ticket_none === true,
  `pre-fix rejected=${preFixRejectedNone}, now ticket_none=${dNone.ticket_none}`,
);

// Three distinct states, kept apart.
const dTicket = parseDispatchDeclaration('Dispatch: ticket=BUG-175 phase=fixing');
const dUndeclared = parseDispatchDeclaration('just a normal charter with no dispatch line');
ok('declared-with-ticket is distinct: tickets set, ticket_none false', dTicket.tickets?.[0] === 'BUG-175' && dTicket.ticket_none === false);
ok('undeclared is distinct: present false, ticket_none false', dUndeclared.present === false && dUndeclared.ticket_none === false);

// Round-trip through the shared grammar.
const line = formatDispatchDeclaration({ ticket: 'none' });
ok('formatDispatchDeclaration emits ticket=none', line === 'Dispatch: ticket=none', line);
ok('...and it round-trips back to ticket_none', parseDispatchDeclaration(line).ticket_none === true);

// resolveLaneAttribution: a declared none is not overridden by a prose ticket.
const laneNone = { declared: dNone, tickets: [{ id: 'BUG-999' }], dispatch_class: null };
const resolved = resolveLaneAttribution(laneNone, null);
ok('a declared ticket=none is NOT overridden by an inferred prose ticket', resolved.primary_ticket === null && resolved.ticket_source === 'declared-none' && resolved.ticket_declared_none === true, JSON.stringify({ p: resolved.primary_ticket, s: resolved.ticket_source }));

// Coverage separates the three states.
const mkLane = (charter, id) => {
  const declared = parseDispatchDeclaration(charter);
  const l = { lane_id: id, declared, tickets: [], dispatch_class: null, cost_usd: 0, cost_priced_usd: 0, wall_ms: 0, accounted_ms: 0, idle_gap_ms: 0, phases: {}, usage: [], tokens: {}, dispatch: { dispatches: 0 } };
  return Object.assign(l, resolveLaneAttribution(l, null));
};
const covLanes = [
  mkLane('Dispatch: ticket=BUG-175', 'a'),
  mkLane('Dispatch: ticket=none', 'b'),
  mkLane('no declaration at all', 'c'),
];
const rep = rollUp(covLanes);
const cov = rep.declared_coverage;
ok('coverage counts the three states separately', cov.ticket === 1 && cov.ticket_none === 1 && cov.lanes - cov.ticket - cov.ticket_none === 1, JSON.stringify({ ticket: cov.ticket, none: cov.ticket_none, undeclared: cov.lanes - cov.ticket - cov.ticket_none }));
ok('the ticket=none lane produced NO complaint in coverage', !cov.complaints.some((c) => /none/i.test(c)), JSON.stringify(cov.complaints));

/* ----------------------------------------------------------------- verdict */

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
if (fail) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
