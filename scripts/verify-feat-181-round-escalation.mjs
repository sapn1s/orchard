#!/usr/bin/env node
/**
 * FEAT-181 — verify the AUTOMATIC surfacing of the round ceiling.
 *
 * FEAT-148 built the reader; nothing fired it. FEAT-181 wires it into two
 * surfaces that fire without being remembered: (1) a dispatch preflight
 * (scripts/lib/round-ceiling-preflight.mjs) that raises when a dispatch is about
 * to spend another round on a ticket, and (2) a board:status over-ceiling
 * section. The deliverable is not a notification — it is the ceiling firing INTO
 * an actionable decision (rescope / redesign / stop) owned by the orchestrator.
 *
 * Proves:
 *   A. must-FAIL pair (synthetic ledger, no real store touched): the SAME
 *      dispatch raises at round=5 / round=3 and goes SILENT at round=2 — the
 *      check cannot fire on empty/below-ceiling input;
 *   B. the raised item IS an actionable decision: named owner + rescope/redesign/
 *      stop, and the formatted warning names all three;
 *   C. ledger history dominates: a ticket already at round 8 in the ledger is
 *      raised even when THIS dispatch declares round=2 (and the control: prior
 *      round 2 + this round 2 → silent);
 *   D. multi-ticket dispatch raises ONLY the ticket(s) over the ceiling;
 *   E. ACCEPTANCE against the REAL board: board:status surfaces a LIVE
 *      over-ceiling ticket discovered at runtime, with owner + actions, in both
 *      the whole-board summary and the single-ticket report. FAILS LOUDLY if the
 *      real board has no qualifying LIVE ticket (never an empty success);
 *   F. theatre-avoidance: a CLOSED over-ceiling ticket is NOT re-surfaced on the
 *      board summary (skips loudly if the real board has no closed exemplar);
 *   G. dispatch.mjs actually wires the preflight (structural — the surface is
 *      unit-tested here against the real function, dispatch.mjs is the 3-line
 *      caller).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { preflightRoundCeiling, formatRoundCeilingWarning } from './lib/round-ceiling-preflight.mjs';
import { roundCeiling, readRoundHistory } from './round-ceiling.mjs';
import { readLedger } from './cost-collect.mjs';
import { readTickets } from './board.mjs';
import { resolveBoardDir } from './lib/board-path.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIR = resolveBoardDir(ROOT);
const CLI = path.join(HERE, 'board-status.mjs');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

/* A synthetic prior-ledger lane the canonical reader counts. */
const lane = (ticket, round, phase = 'verifying') => ({ declared: { present: true, round, tickets: [ticket], phase } });

/* ── A. must-FAIL pair: same dispatch, only the declared round differs ──────── */
const EMPTY = [];
const a5 = preflightRoundCeiling({ round: 5, tickets: ['BUG-901'], lanes: EMPTY });
check('A1 round=5 (no prior history) raises BUG-901 at maxRound 5, severity high',
  a5.raised.some((r) => r.ticket === 'BUG-901' && r.maxRound === 5 && r.severity === 'high'),
  { raised: a5.raised.map((r) => `${r.ticket}:${r.maxRound}:${r.severity}`), minRound: a5.minRound });

const a3 = preflightRoundCeiling({ round: 3, tickets: ['BUG-901'], lanes: EMPTY });
check('A2 round=3 (at ceiling) raises BUG-901, severity elevated',
  a3.raised.some((r) => r.ticket === 'BUG-901' && r.maxRound === 3 && r.severity === 'elevated'),
  a3.raised.map((r) => `${r.ticket}:${r.maxRound}:${r.severity}`));

const a2 = preflightRoundCeiling({ round: 2, tickets: ['BUG-901'], lanes: EMPTY });
check('A3 MUST-FAIL control: same dispatch at round=2 (below ceiling) → SILENT',
  a2.raised.length === 0,
  { raised: a2.raised.map((r) => r.ticket), minRound: a2.minRound });

/* ── B. the raised item is an actionable decision, not a bare count ─────────── */
const r5 = a5.raised.find((r) => r.ticket === 'BUG-901');
const actionsOk = r5 && r5.owner === 'orchestrator'
  && ['rescope', 'redesign', 'stop'].every((k) => (r5.actions || []).includes(k));
check('B1 raised item carries owner=orchestrator and rescope/redesign/stop choices',
  !!actionsOk, { owner: r5?.owner, actions: r5?.actions });

const warn = formatRoundCeilingWarning(a5.raised, 5, a5.minRound).join('\n');
check('B2 formatted warning names the owner and all three actionable choices',
  /OWNER orchestrator/.test(warn) && /rescope/.test(warn) && /redesign/.test(warn) && /stop/.test(warn) && /QUESTION, not a block/.test(warn),
  warn.split('\n').slice(0, 3));

/* ── C. ledger history dominates the round being launched now ───────────────── */
const c = preflightRoundCeiling({ round: 2, tickets: ['BUG-902'], lanes: [lane('BUG-902', 8, 'fixing')] });
check('C1 prior ledger round 8 + this dispatch round 2 → raised at maxRound 8 (history dominates)',
  c.raised.some((r) => r.ticket === 'BUG-902' && r.maxRound === 8),
  c.raised.map((r) => `${r.ticket}:${r.maxRound}`));
const cCtl = preflightRoundCeiling({ round: 2, tickets: ['BUG-902'], lanes: [lane('BUG-902', 2, 'fixing')] });
check('C2 control: prior round 2 + this round 2 → SILENT (never crosses the ceiling)',
  cCtl.raised.length === 0, cCtl.raised.map((r) => r.ticket));

/* ── D. multi-ticket dispatch raises only the over-ceiling ticket ───────────── */
// Dispatch declares round=2 for BOTH tickets; BUG-903 is already deep in the
// ledger (round 8) while BUG-904 has only one prior round, so only BUG-903
// crosses the ceiling once this dispatch's round is folded in.
const d = preflightRoundCeiling({ round: 2, tickets: ['BUG-903', 'BUG-904'], lanes: [lane('BUG-903', 8), lane('BUG-904', 1)] });
check('D dispatch names two tickets; only the one over the ceiling (history round 8) is raised',
  d.raised.length === 1 && d.raised[0].ticket === 'BUG-903' && d.raised[0].maxRound === 8,
  d.raised.map((r) => `${r.ticket}:${r.maxRound}`));

/* ── Discover the REAL board's state through the canonical reader ───────────── */
let realLive = [], realDone = [];
try {
  const lanes = readLedger();
  const res = roundCeiling(lanes, {});
  const { tickets } = readTickets(DIR);
  for (const r of res.raised) {
    const t = tickets.get(r.ticket);
    if (!t) continue;
    (t.done ? realDone : realLive).push({ ticket: r.ticket, maxRound: r.maxRound });
  }
} catch (e) {
  check('E/F setup: read the real ledger + board', false, String(e?.message ?? e));
}

/* ── E. ACCEPTANCE — board:status surfaces a LIVE over-ceiling ticket ───────── */
if (realLive.length === 0) {
  check('E ACCEPTANCE — the REAL board has at least one LIVE over-ceiling ticket', false,
    'NONE found: the durable ledger shows no OPEN ticket at or over the ceiling. '
    + 'This FAILS loudly rather than passing vacuously (FEAT-181 cannot be demonstrated against the real board right now).');
} else {
  const target = realLive.sort((a, b) => b.maxRound - a.maxRound)[0];
  const sum = spawnSync('node', [CLI, '--json'], { encoding: 'utf8', cwd: ROOT, env: process.env });
  let sumJson = {}; try { sumJson = JSON.parse(sum.stdout); } catch { /* leave empty */ }
  const oc = sumJson.over_ceiling || {};
  const inSummary = (oc.tickets || []).find((r) => r.ticket === target.ticket);
  check(`E1 board:status summary surfaces LIVE over-ceiling ${target.ticket} with owner + actions`,
    oc.available === true && !!inSummary && inSummary.max_round === target.maxRound
      && inSummary.owner === 'orchestrator' && ['rescope', 'redesign', 'stop'].every((k) => (inSummary.actions || []).includes(k)),
    { available: oc.available, count: oc.count, match: inSummary });

  const one = spawnSync('node', [CLI, target.ticket, '--json'], { encoding: 'utf8', cwd: ROOT, env: process.env });
  let oneJson = {}; try { oneJson = JSON.parse(one.stdout); } catch { /* leave empty */ }
  const ocOne = oneJson.over_ceiling || {};
  check(`E2 board:status ${target.ticket} single report carries the §N escalation (round ${target.maxRound}, owner, actions)`,
    ocOne.max_round === target.maxRound && ocOne.owner === 'orchestrator'
      && ['rescope', 'redesign', 'stop'].every((k) => (ocOne.actions || []).includes(k)),
    ocOne);

  // Human-readable surface actually prints the warning (not just JSON).
  const human = spawnSync('node', [CLI], { encoding: 'utf8', cwd: ROOT, env: process.env });
  check('E3 human board:status prints a "round ceiling" section naming the live count',
    /round ceiling .*LIVE ticket/.test(human.stdout) && human.stdout.includes(target.ticket),
    human.stdout.split('\n').filter((l) => /round ceiling/i.test(l)).slice(0, 1));
}

/* ── F. theatre-avoidance — a CLOSED over-ceiling ticket is NOT re-surfaced ──── */
if (realDone.length === 0) {
  console.log('  SKIP  F theatre-avoidance — the real board has no CLOSED over-ceiling ticket to test the filter against');
} else {
  const closed = realDone[0];
  const sum = spawnSync('node', [CLI, '--json'], { encoding: 'utf8', cwd: ROOT, env: process.env });
  let sumJson = {}; try { sumJson = JSON.parse(sum.stdout); } catch { /* leave empty */ }
  const present = (sumJson.over_ceiling?.tickets || []).some((r) => r.ticket === closed.ticket);
  check(`F closed over-ceiling ${closed.ticket} (round ${closed.maxRound}) is NOT in the live board summary (no notification theatre)`,
    !present, { closed: closed.ticket, present });
}

/* ── H. NAMED-GAP contract (FEAT-181 r2 redesign — the r1 BROKEN criterion) ──── */
// The ONE owner classifies round-history usability; every surface renders it.
const hNoLedger = readRoundHistory({ lanes: [] });
check('H1 readRoundHistory: absent/empty ledger → unusable, code no-ledger (not a silent []→usable)',
  hNoLedger.usable === false && hNoLedger.code === 'no-ledger' && /ledger/i.test(hNoLedger.reason || ''),
  { usable: hNoLedger.usable, code: hNoLedger.code });

// d2: lanes exist but ZERO declared a round → a NAMED gap, never a vacuous "none".
const hNoDeclared = readRoundHistory({ lanes: [{ declared: { present: false } }, { declared: { present: true, round: null, tickets: ['BUG-901'] } }] });
check('H2 (d2) readRoundHistory: lanes present but 0 declared rounds → unusable, code no-declared-round',
  hNoDeclared.usable === false && hNoDeclared.code === 'no-declared-round',
  { usable: hNoDeclared.usable, code: hNoDeclared.code, reason: hNoDeclared.reason });

const hUsable = readRoundHistory({ lanes: [lane('BUG-902', 4)] });
check('H3 readRoundHistory: a declared-round lane → usable, code null',
  hUsable.usable === true && hUsable.code === null && hUsable.result.lanesWithDeclaredRound === 1,
  { usable: hUsable.usable, code: hUsable.code });

// d1: preflight over an unusable (empty) history, round below ceiling → NOT a
// silent empty success; it carries the named gap.
const pfGap = preflightRoundCeiling({ round: 2, tickets: ['BUG-901'], lanes: [] });
check('H4 (d1) preflight, unusable history + below-ceiling round → raised:[] BUT history gap named',
  pfGap.raised.length === 0 && pfGap.history && pfGap.history.usable === false && pfGap.history.code === 'no-ledger',
  { raised: pfGap.raised.map((r) => r.ticket), history: pfGap.history });

// b: no --round declared, but history already at round 12 → must raise.
const pfNoRound = preflightRoundCeiling({ tickets: ['BUG-902'], lanes: [lane('BUG-902', 12, 'verifying')] });
check('H5 (b) preflight, NO declared round, history round 12 → raises from history alone (not skipped)',
  pfNoRound.skipped === null && pfNoRound.raised.some((r) => r.ticket === 'BUG-902' && r.maxRound === 12),
  { raised: pfNoRound.raised.map((r) => `${r.ticket}:${r.maxRound}`), skipped: pfNoRound.skipped });

// review strongest objection: a raise must NOT hide the gap — both rendered.
const pfBoth = preflightRoundCeiling({ round: 5, tickets: ['BUG-901'], lanes: [] });
check('H6 raise AND history gap are rendered INDEPENDENTLY (fresh host, round 5)',
  pfBoth.raised.some((r) => r.ticket === 'BUG-901' && r.maxRound === 5) && pfBoth.history.usable === false,
  { raised: pfBoth.raised.map((r) => `${r.ticket}:${r.maxRound}`), history: pfBoth.history });

// coverage policy (review Q2): in a USABLE ledger, a ticket with no declared-round
// lane stays SILENT (declared-only ⇒ legitimately round-0), NOT a per-ticket gap.
const pfMixed = preflightRoundCeiling({ tickets: ['BUG-UNSEEN'], lanes: [lane('BUG-OTHER', 7)] });
check('H7 mixed history: usable ledger, unseen ticket → silent (NOT raised, NOT a gap)',
  pfMixed.raised.length === 0 && pfMixed.history.usable === true,
  { raised: pfMixed.raised.map((r) => r.ticket), history: pfMixed.history });

// ADJUDICATION (orchestrator, 2026-10-14, r3 rescope): a dispatch naming a ticket
// with NO --round over a USABLE ledger is NOT a history gap — it raises from the
// ledger as normal, history.usable stays true, and THIS dispatch's own round is
// labelled "undeclared", never "null"/"undefined", never a silent round-0.
const pfNoRoundUsable = preflightRoundCeiling({ tickets: ['BUG-902'], lanes: [lane('BUG-902', 12, 'verifying')] });
const warnNoRound = formatRoundCeilingWarning(pfNoRoundUsable.raised, null, pfNoRoundUsable.minRound).join('\n');
check('H9 (adjudication) no --round + usable ledger → raises, NOT a gap, round labelled "undeclared" (never "null")',
  pfNoRoundUsable.raised.some((r) => r.ticket === 'BUG-902' && r.maxRound === 12)
    && pfNoRoundUsable.history.usable === true
    && /dispatching round undeclared/.test(warnNoRound) && !/round null/.test(warnNoRound) && !/round undefined/.test(warnNoRound),
  { raised: pfNoRoundUsable.raised.map((r) => `${r.ticket}:${r.maxRound}`), usable: pfNoRoundUsable.history.usable, line: warnNoRound.split('\n')[0] });

// a declared positive round still renders as itself (not regressed to "undeclared").
const warnDeclared = formatRoundCeilingWarning(a5.raised, 5, a5.minRound).join('\n');
check('H10 a declared round still renders its integer (no over-eager "undeclared")',
  /dispatching round 5\b/.test(warnDeclared) && !/round undeclared/.test(warnDeclared),
  warnDeclared.split('\n')[0]);

// ordering (review Q4): no declared ticket → skip BEFORE any history work.
const pfNoTicket = preflightRoundCeiling({ round: 9, tickets: [] });
check('H8 no declared ticket → skipped (never a spurious history warning)',
  pfNoTicket.skipped === 'no declared ticket' && pfNoTicket.history === null,
  { skipped: pfNoTicket.skipped, history: pfNoTicket.history });

/* ── G. dispatch.mjs wires the preflight (structural) ───────────────────────── */
const dispatchSrc = fs.readFileSync(path.join(HERE, 'dispatch.mjs'), 'utf8');
check('G dispatch.mjs imports and calls the round-ceiling preflight',
  dispatchSrc.includes("round-ceiling-preflight.mjs") && /preflightRoundCeiling\s*\(/.test(dispatchSrc) && /formatRoundCeilingWarning\s*\(/.test(dispatchSrc),
  { imports: dispatchSrc.includes('round-ceiling-preflight.mjs'), calls: /preflightRoundCeiling\s*\(/.test(dispatchSrc) });

check('G2 dispatch.mjs renders the named history gap independently of raises',
  /pf\.history\s*&&\s*pf\.history\.usable\s*===\s*false/.test(dispatchSrc) && /pf\.history\.reason/.test(dispatchSrc),
  { gapRendered: /pf\.history\.reason/.test(dispatchSrc) });

console.log(`\n  FEAT-181 verify: ${pass} passed, ${fail} failed${failures.length ? ` (${failures.join(', ')})` : ''}`);
process.exit(fail ? 1 : 0);
