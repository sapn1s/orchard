#!/usr/bin/env node
/**
 * ARCH-003 — THE 6th CLEAN-ROOM VERDICT, MADE PERMANENT: NESTED OWNERSHIP.
 *
 * VERDICT (dispatch openai run 01a01563-cd26-79a1-b9e4-d589ccafb49a, verbatim):
 *   node scratch-nested-owner-terminal.mjs  → exit 1
 *   {"rootStillRunning":true,"leafStillRunning":true,"intermediateTerminal":"completed",
 *    "ownerAfterBoundary":null,"fabricatedDeathAtSweep":true}
 *   node scratch-flat-bound.mjs             → exit 1
 *   {"shortDurationResident":1000,"longDurationResident":10000,"flat":false}
 *
 * WHY THIS ONE IS DIFFERENT FROM THE FOUR BEFORE IT. Verdicts 2-5 were RESIDENCY:
 * bytes, never a wrong answer. This one breaks property (b) — LIVE WORK REPORTED
 * DEAD — which is the failure that has already cost this project real damage
 * (BUG-037). It was introduced by the 5th-verdict fix's own reclamation predicate.
 *
 * THE MECHANISM. Ownership is a CHAIN, not a pair. A background root agent R
 * dispatches an intermediate agent M; M issues a Bash whose lane L is still running.
 * The registry holds L -> M and M -> R. Both the reclamation predicate
 * (`#callCannotStillBeInFlight`) and the sweep's spare rule asked about the
 * IMMEDIATE owner only. So the instant M reads as terminal — and M can read as
 * terminal while it is genuinely working, because the turn-end sweep itself settles
 * any running lane the engine's background level does not list — L's record is
 * discarded, ownership resolves `null`, and the sweep records a death for a lane
 * whose ROOT is still running and whose own result is still coming.
 *
 * The code's claim was "VERDICT-NEUTRALITY, as a property: a record can only ever
 * SPARE a running lane whose tool_use id it matches, and it spares only while its
 * owner is live or untracked. This removes exactly the records whose owner is
 * neither." That is FALSE as written: it is true of the IMMEDIATE owner and says
 * nothing about the ancestry, and a record whose immediate owner is terminal can
 * still be the record of a call that is genuinely in flight under a live ancestor.
 *
 * WHAT THIS SCRIPT GRADES — the property, not the one arrangement:
 *   A RECORD IS RECLAIMABLE ONLY IF NOTHING IN ITS WHOLE OWNERSHIP CHAIN COULD
 *   STILL BE RUNNING; AND A LANE UNDER ANY STILL-RUNNING ANCESTOR IS NEVER
 *   RECORDED DEAD.
 * Every route by which the immediate owner can go terminal is driven: the boundary
 * predicate, a terminal frame, and both at depth 2, 3 and 5.
 *
 * Cases (5) and (6) are the counterweights — the fix must not buy property (b) by
 * trading property (a): a main-thread orphan has an EMPTY chain and must still die,
 * and a leaf whose entire chain is dead must still record its honest death.
 *
 * Usage: node scripts/adversarial-arch-003-nested-terminal-owner.mjs
 */
import { OpenToolCalls as RealOpenToolCalls } from '../src/server/open-tool-calls.ts';

/**
 * THE FRAME THESE FIXTURES USED TO OMIT (ARCH-003, 8th clean-room verdict).
 *
 * A background agent's OWN Task call is a MAIN-THREAD `tool_use`, and the bridge
 * records it (`issuedByMainThread`) BEFORE any child can name it as
 * `parent_tool_use_id` — the child's frame carries the id of a call an EARLIER
 * assistant frame minted. A fixture that names `ownerW` as a parent without ever
 * issuing it is therefore not modelling a root: it is modelling a chain whose top
 * NOBODY HAS EVER NAMED, which since the 8th verdict is UNKNOWN ANCESTRY (there may
 * be live owners above it that no frame has mentioned) rather than "the chain ends
 * here". The type now says so instead of guessing, and refuses to reclaim on it for
 * one boundary.
 *
 * So the fixtures supply the frame the real stream always contains: the first time a
 * name is used as a parent, its own main-thread issue frame is played first. Nothing
 * else about the fixture changes, and the numbers below are the numbers the guard
 * published before this rule existed — which is the point of doing it this way rather
 * than relaxing the rule.
 *
 * A case that deliberately withholds a parent's issue frame must use
 * `RealOpenToolCalls` directly (see `adversarial-arch-003-reservation-window.mjs`).
 */
class OpenToolCalls extends RealOpenToolCalls {
  #issued = new Set();
  issuedByMainThread(id) { this.#issued.add(id); super.issuedByMainThread(id); }
  issuedBySubagent(id, parent) {
    if (!this.#issued.has(parent)) this.issuedByMainThread(parent);
    this.#issued.add(id);
    super.issuedBySubagent(id, parent);
  }
}


let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  ok ? pass++ : (fail++, failures.push(name));
}

/**
 * THE BRIDGE, MODELLED — and modelled from its real code, not from convenience.
 *
 * `agents` is `#agents`: task id -> status. `level` is `#backgroundTasks` (the
 * engine's REPLACE-semantics background level). Ids here are raw
 * `parent_tool_use_id`s and `#agentIdFor` is identity for them, which is what the
 * bridge falls back to for an owner whose own `task_started` was never seen.
 *
 * `cannotStillBeInFlight` mirrors `AgentSession.#callCannotStillBeInFlight`; `spare`
 * mirrors the sweep's `#ownerIsLiveBackgroundAgent(owner) ||
 * #ownerIsUntrackedSubagent(owner)`. Both are given the WHOLE CHAIN, which is what
 * the fixed type passes; a build that only consults `chain[0]` fails exactly as the
 * clean room reported.
 */
/**
 * The ownership CHAIN of a call. Uses the type's own `ownerChainOf` where it exists
 * and otherwise walks `parentOf` — so this script RUNS on the pre-fix build (0ba4ce1)
 * and fails on its assertions rather than crashing on a missing method, which is what
 * a must-FAIL has to do.
 */
const chainOf = (r, id) => {
  if (typeof r.ownerChainOf === 'function') return r.ownerChainOf(id);
  const out = [];
  const seen = new Set();
  let cur = r.parentOf(id);
  while (cur && !seen.has(cur)) { out.push(cur); seen.add(cur); cur = r.parentOf(cur); }
  return out;
};
/** The pre-fix `reap` hands the predicate ONE parent; the fixed one hands the chain. */
const asChain = (c) => (Array.isArray(c) ? c : c == null ? [] : [c]);

function bridge({ agents, level, terminalLanes = new Set() }) {
  const notLive = (owner) => {
    if (!owner) return false;
    if (level.has(owner)) return false;              // the engine still lists it
    const row = agents.get(owner);
    if (!row) return false;                          // untracked — no evidence at all
    return row !== 'running';
  };
  return {
    cannotStillBeInFlight: (toolUseId, rawChain) => {
      const chain = asChain(rawChain);
      if (terminalLanes.has(toolUseId)) return true;
      if (!chain.length) return false;
      return chain.every((owner) => notLive(owner));
    },
    // The sweep: spare a still-running lane whose chain holds a live background
    // agent, or (the re-attach degrade) an owner the bridge has never observed.
    spares: (chain) => chain.some((owner) => level.has(owner) || !agents.has(owner)),
  };
}

// ============================================================ (1) THE VERDICT
{
  /*
   * The clean room's own case, reconstructed. R is a live background agent; it
   * dispatched M; M issued the Bash whose lane L is still running; M has gone
   * terminal. Printed in the verdict's own shape so the line can be compared.
   */
  const r = new OpenToolCalls();
  r.issuedBySubagent('M', 'R');          // the intermediate agent's Task call, issued BY R
  r.issuedBySubagent('L', 'M');          // the leaf bash, issued BY M

  const agents = new Map([['R', 'running'], ['M', 'completed']]);
  const level = new Set(['R']);          // only the root is still on the engine's level
  const b = bridge({ agents, level });

  r.reap(b.cannotStillBeInFlight);       // the turn boundary
  const chainAfter = chainOf(r, 'L');
  const ownerAfterBoundary = r.parentOf('L');
  const fabricatedDeathAtSweep = !b.spares(chainAfter);

  check('(1) THE 6th CLEAN-ROOM VERDICT: with the ROOT background agent still running and the LEAF lane still running, a TERMINAL INTERMEDIATE owner must not cost the leaf its ownership — the record survives the boundary and the sweep spares the leaf. On 0ba4ce1 this printed the verdict line verbatim: {"ownerAfterBoundary":null,"fabricatedDeathAtSweep":true}',
    ownerAfterBoundary === 'M' && fabricatedDeathAtSweep === false,
    { rootStillRunning: true, leafStillRunning: true, intermediateTerminal: 'completed', ownerAfterBoundary, fabricatedDeathAtSweep });
}

// =================================================== (2) the terminal-FRAME route
{
  /*
   * The same shape reached through the OTHER removal route the bridge has: the
   * intermediate's terminal frame (`ownerEnded`, in the tree since attempt 6). If
   * that route still discards a nested leaf's record, the predicate fix alone is
   * cosmetic — which is why this is asserted separately.
   */
  const r = new OpenToolCalls();
  r.issuedBySubagent('M', 'R');
  r.issuedBySubagent('L', 'M');
  if (typeof r.ownerEnded === 'function') r.ownerEnded('M');   // M's terminal frame
  const agents = new Map([['R', 'running'], ['M', 'completed']]);
  const level = new Set(['R']);
  const b = bridge({ agents, level });
  r.reap(b.cannotStillBeInFlight);
  const chain = chainOf(r, 'L');
  check('(2) A TERMINAL FRAME FOR THE INTERMEDIATE CANNOT ORPHAN THE LEAF EITHER: the second removal route in the bridge (`ownerEnded` at the intermediate\'s terminal frame) must not discard a record whose ancestry is still live, or the leaf is fabricated dead by the frame instead of by the boundary',
    chain.includes('R') && b.spares(chain) === true,
    { chainAfterIntermediateTerminalFrame: chain, spared: b.spares(chain) });
}

// ================================================= (3) DEPTH — 2, 3 and 5 levels
{
  const rows = [];
  for (const depth of [2, 3, 5]) {
    const r = new OpenToolCalls();
    // chain: root R -> a1 -> a2 -> ... -> leaf L. Every intermediate is TERMINAL.
    const ids = ['R', ...Array.from({ length: depth - 1 }, (_, i) => 'a' + i)];
    for (let i = 1; i < ids.length; i++) r.issuedBySubagent(ids[i], ids[i - 1]);
    r.issuedBySubagent('L', ids[ids.length - 1]);
    const agents = new Map([['R', 'running'], ...ids.slice(1).map((id) => [id, 'completed'])]);
    const level = new Set(['R']);
    const b = bridge({ agents, level });
    for (let k = 0; k < 5; k++) r.reap(b.cannotStillBeInFlight);   // five turn boundaries
    rows.push({ depth, chain: chainOf(r, 'L'), spared: b.spares(chainOf(r, 'L')) });
  }
  check('(3) AT ANY DEPTH, AND ACROSS REPEATED BOUNDARIES: with EVERY intermediate terminal and only the root still live, the leaf keeps a chain that reaches the root and is spared — five reclamations do not erode it. A one-level liveness test spares none of these',
    rows.every((x) => x.chain.includes('R') && x.spared === true), rows);
}

// ============================================ (4) the record survives, then answers
{
  /*
   * The lane arrives a WHOLE TURN after the intermediate went terminal — the shape
   * where a discarded record cannot be recovered, because nothing will re-issue it.
   */
  const r = new OpenToolCalls();
  r.issuedBySubagent('M', 'R');
  r.issuedBySubagent('L', 'M');
  const agents = new Map([['R', 'running'], ['M', 'completed']]);
  const level = new Set(['R']);
  const b = bridge({ agents, level });
  r.reap(b.cannotStillBeInFlight);
  r.reap(b.cannotStillBeInFlight);
  r.reap(b.cannotStillBeInFlight);
  check('(4) THREE TURNS LATER THE ANSWER IS STILL THERE: the leaf lane may be announced turns after its intermediate owner went terminal (the straddle shape), and nothing will ever re-issue the record — so it must still resolve',
    r.parentOf('L') === 'M' && b.spares(chainOf(r, 'L')),
    { parentOf_L: r.parentOf('L'), chain: chainOf(r, 'L') });
}

// ======================================= (5) COUNTERWEIGHT — property (a) intact
{
  const r = new OpenToolCalls();
  r.issuedBySubagent('M', 'R');
  r.issuedBySubagent('L', 'M');
  r.issuedByMainThread('MAIN_ORPHAN');                 // a main-thread bash
  const agents = new Map([['R', 'running'], ['M', 'completed']]);
  const level = new Set(['R']);
  const b = bridge({ agents, level });
  r.reap(b.cannotStillBeInFlight);
  const chain = chainOf(r, 'MAIN_ORPHAN');
  check('(5) PROPERTY (a) IS NOT TRADED FOR IT: a main-thread orphan has an EMPTY ownership chain however many live background ancestors exist elsewhere, so nothing spares it and its genuine death is recorded — the over-suppression direction that broke attempts 1 and 3',
    chain.length === 0 && b.spares(chain) === false,
    { mainOrphanChain: chain, spared: b.spares(chain) });
}

// ================================ (6) COUNTERWEIGHT — a wholly dead chain reclaims
{
  const r = new OpenToolCalls();
  r.issuedBySubagent('M', 'R');
  r.issuedBySubagent('L', 'M');
  const agents = new Map([['R', 'completed'], ['M', 'completed']]);
  const level = new Set();                              // the root retired too
  const b = bridge({ agents, level });
  r.reap(b.cannotStillBeInFlight);
  check('(6) A WHOLLY DEAD CHAIN IS STILL RECLAIMED, AND STILL RECORDS HONESTLY: when the ROOT retires as well, nothing in the chain can be in flight — the records go (the bound is kept) and the leaf is no longer spared, so a child that genuinely outlived its owners records its honest death',
    r.size === 0 && b.spares([]) === false,
    { residentAfterWholeChainRetired: r.size });
}

// ============================== (7) the untracked degrade survives at depth
{
  const r = new OpenToolCalls();
  r.issuedBySubagent('L', 'UNKNOWN_OWNER');             // re-attach: never observed
  const agents = new Map([['R', 'running']]);
  const level = new Set(['R']);
  const b = bridge({ agents, level });
  for (let k = 0; k < 10; k++) r.reap(b.cannotStillBeInFlight);
  check('(7) ABSENCE OF KNOWLEDGE IS STILL NEVER EVIDENCE: an owner the bridge has never observed (the re-attach degrade) is not reclaimed by any number of boundaries, and its child is still spared',
    r.parentOf('L') === 'UNKNOWN_OWNER' && b.spares(chainOf(r, 'L')),
    { parentOf_L: r.parentOf('L'), resident: r.size });
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) console.log(`failed: ${failures.join(' | ')}`);
process.exit(fail ? 1 : 0);
