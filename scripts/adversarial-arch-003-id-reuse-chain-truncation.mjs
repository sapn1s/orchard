#!/usr/bin/env node
/**
 * ARCH-003 — THE 7th CLEAN-ROOM VERDICT, MADE PERMANENT: A CHAIN MUST NOT BE
 * CORRUPTIBLE BY WHAT LATER HAPPENS TO AN EXTERNAL ID.
 *
 * VERDICT (7th clean-room pass, verbatim):
 *   node scratch-id-reuse-truncation.mjs → exit 1
 *   {"source":"DIRECT UNIT DRIVE","rootRunning":true,"leafRunning":true,
 *    "chainBeforeSweep":["M"],"chainAfterSweep":[],
 *    "leafRecordSurvived":false,"liveAncestorStillReachable":false}
 *
 * THE MECHANISM. Records were keyed by the tool_use id the ENGINE mints, and a
 * record's ancestry was resolved by re-reading that map at every walk. So any later
 * write under an id that some OTHER record's chain passes through rewrote that other
 * record's ancestry:
 *   - `issuedByMainThread(M)` DELETED M's record, and the still-running leaf's chain
 *     truncated from ["M","R"] to ["M"] — the live root R became unreachable, the
 *     boundary predicate saw no live ancestor, the leaf's record was reclaimed, and
 *     the sweep recorded a death for live work under a live root (property (b), the
 *     BUG-037 failure).
 *   - `issuedBySubagent(M, X)` REBOUND M's parent, so the leaf's ancestry silently
 *     became someone else's — the same corruption without a deletion.
 *
 * WHY THIS IS THE SEVENTH OF ONE CLASS. Every defect on this surface traces to
 * ownership being keyed by an id the system does not mint and cannot guarantee
 * unique. Six rounds guarded one consequence each. This script grades the CLASS:
 *
 *   AN ESTABLISHED CHAIN IS IMMUTABLE. Once a record exists, nothing that later
 *   happens to any external id — reuse by the main thread, reuse by another
 *   subagent, an end signal, a reclamation — may change, shorten or redirect the
 *   ancestry that record was created with.
 *
 * Cases (5)(6)(7) are the counterweights: the fix must not buy property (b) by
 * trading property (a) (a main-thread lane that re-used the id still records its
 * honest death, and no arrangement of live agents suppresses it), and must not buy
 * either with unbounded residency.
 *
 * REACHABILITY, honestly. The engine is not known to emit a reused tool_use id: a
 * result frame names an id minted by an earlier assistant frame, and there is one
 * ordered path with no replay. This is a state-machine fault reached by a sequence
 * that should not occur in practice — fixed anyway because "should not occur" has
 * been wrong twice on this ticket, and because a structure that cannot be corrupted
 * is cheaper to reason about than one defended by an argument about engine output.
 *
 * Usage: node scripts/adversarial-arch-003-id-reuse-chain-truncation.mjs
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
 * THE BRIDGE, MODELLED FROM ITS REAL CODE (identical to the model in
 * `adversarial-arch-003-nested-terminal-owner.mjs`). `agents` is `#agents` (task id
 * -> status), `level` is `#backgroundTasks` (the engine's REPLACE-semantics
 * background level). `cannotStillBeInFlight` mirrors
 * `AgentSession.#callCannotStillBeInFlight`; `spares` mirrors the sweep's
 * `#ownershipSpares`.
 */
function bridge({ agents, level, terminalLanes = new Set() }) {
  const notLive = (owner) => {
    if (!owner) return false;
    if (level.has(owner)) return false;              // the engine still lists it
    const row = agents.get(owner);
    if (!row) return false;                          // untracked — no evidence at all
    return row !== 'running';
  };
  return {
    cannotStillBeInFlight: (toolUseId, chain) => {
      if (terminalLanes.has(toolUseId)) return true;
      if (!chain.length) return false;
      return chain.every((owner) => notLive(owner));
    },
    spares: (chain) => chain.some((owner) => level.has(owner) || !agents.has(owner)),
  };
}

/** The live-work-under-a-live-root fixture every case below starts from. */
function nested() {
  const r = new OpenToolCalls();
  r.issuedBySubagent('M', 'R');     // the intermediate agent's Task call, issued BY the root R
  r.issuedBySubagent('L', 'M');     // the leaf bash, issued BY M — its lane is still RUNNING
  return r;
}
// R is a live background root; M (the intermediate) has gone terminal — the 6th
// verdict's own configuration, which the chain rule already handles.
const ROOT_LIVE = () => bridge({ agents: new Map([['R', 'running'], ['M', 'completed']]), level: new Set(['R']) });

// ============================================================ (1) THE VERDICT
{
  const r = nested();
  r.issuedByMainThread('M');                 // the main thread RE-USES the intermediate's id
  const b = ROOT_LIVE();
  const chainBeforeSweep = r.ownerChainOf('L');
  r.reap(b.cannotStillBeInFlight);           // the turn boundary
  const chainAfterSweep = r.ownerChainOf('L');
  check('(1) THE 7th CLEAN-ROOM VERDICT: reusing an INTERMEDIATE\'s tool_use id on the main thread must not touch the still-running leaf\'s ancestry — the leaf keeps ["M","R"], its record survives the boundary, and the live root stays reachable. On cb2ceb2 this printed the verdict line: {"chainBeforeSweep":["M"],"chainAfterSweep":[],"leafRecordSurvived":false,"liveAncestorStillReachable":false}',
    chainBeforeSweep.join(',') === 'M,R' && chainAfterSweep.join(',') === 'M,R'
      && r.parentOf('L') === 'M' && b.spares(chainAfterSweep) === true,
    { source: 'DIRECT UNIT DRIVE', rootRunning: true, leafRunning: true,
      chainBeforeSweep, chainAfterSweep,
      leafRecordSurvived: r.parentOf('L') === 'M',
      liveAncestorStillReachable: chainAfterSweep.includes('R') });
}

// ================================= (2) the same corruption WITHOUT a deletion
{
  /*
   * Reuse by ANOTHER SUBAGENT rebinds the ancestor's parent instead of deleting it,
   * so the leaf's chain is not shortened but REDIRECTED — it now names an ancestry
   * it never had. If the new ancestry is dead and the real one is live, the leaf is
   * reclaimed and fabricated dead exactly as in (1). Guarding only the delete would
   * leave this open, which is why the property is "a chain is immutable", not "the
   * main-thread branch must not delete".
   */
  const r = nested();
  r.issuedBySubagent('M', 'DEAD_OTHER');      // id M re-issued under a DIFFERENT owner
  const b = bridge({ agents: new Map([['R', 'running'], ['DEAD_OTHER', 'completed']]), level: new Set(['R']) });
  const chain = r.ownerChainOf('L');
  r.reap(b.cannotStillBeInFlight);
  check('(2) REUSE BY ANOTHER SUBAGENT CANNOT REDIRECT AN ESTABLISHED CHAIN EITHER: the leaf issued under the FIRST M keeps the ancestry it was created with (["M","R"]) rather than inheriting the re-issue\'s dead owner — a rewritten chain fabricates the same death as a truncated one',
    chain.join(',') === 'M,R' && r.ownerChainOf('L').join(',') === 'M,R' && b.spares(r.ownerChainOf('L')) === true,
    { chainAfterReuseBySubagent: chain, chainAfterBoundary: r.ownerChainOf('L') });
}

// ========================================== (3) AT DEPTH, AND AT EVERY LEVEL
{
  const rows = [];
  for (const depth of [2, 3, 5]) {
    for (let victim = 0; victim < depth; victim++) {
      const r = new OpenToolCalls();
      const ids = ['R', ...Array.from({ length: depth - 1 }, (_, i) => 'a' + i)];
      for (let i = 1; i < ids.length; i++) r.issuedBySubagent(ids[i], ids[i - 1]);
      r.issuedBySubagent('L', ids[ids.length - 1]);
      r.issuedByMainThread(ids[victim]);          // reuse ANY link of the chain, incl. the root
      const agents = new Map([['R', 'running'], ...ids.slice(1).map((id) => [id, 'completed'])]);
      const b = bridge({ agents, level: new Set(['R']) });
      for (let k = 0; k < 3; k++) r.reap(b.cannotStillBeInFlight);
      const chain = r.ownerChainOf('L');
      rows.push({ depth, reused: ids[victim], reachesRoot: chain.includes('R'), spared: b.spares(chain) });
    }
  }
  check('(3) NO LINK OF THE CHAIN IS A WEAK POINT: reusing ANY id in the ancestry — including the root\'s own — leaves the leaf still reaching the live root and still spared, at depths 2, 3 and 5, across three boundaries',
    rows.every((x) => x.reachesRoot && x.spared), rows);
}

// ============================ (4) WHEREVER THE REUSE AND THE BOUNDARIES FALL
{
  /*
   * The leaf is always issued BEFORE the reuse — the shape where an ancestry is
   * already established — and the reuse, the boundaries and further reuses are moved
   * around it. An immutable chain is indifferent to all of them.
   */
  const rows = [];
  for (const shape of ['reuse-boundary', 'boundary-reuse-boundary', 'three-reuses', 'reuse-and-end-of-the-old-generation']) {
    const r = nested();
    const b = ROOT_LIVE();
    if (shape === 'reuse-boundary') { r.issuedByMainThread('M'); r.reap(b.cannotStillBeInFlight); }
    if (shape === 'boundary-reuse-boundary') { r.reap(b.cannotStillBeInFlight); r.issuedByMainThread('M'); r.reap(b.cannotStillBeInFlight); }
    if (shape === 'three-reuses') { r.issuedByMainThread('M'); r.issuedBySubagent('M', 'DEAD_OTHER'); r.issuedByMainThread('M'); r.reap(b.cannotStillBeInFlight); }
    if (shape === 'reuse-and-end-of-the-old-generation') { r.ended('M'); r.issuedByMainThread('M'); r.reap(b.cannotStillBeInFlight); }
    rows.push({ shape, chain: r.ownerChainOf('L'), spared: b.spares(r.ownerChainOf('L')) });
  }
  check('(4) WHEREVER THE REUSE FALLS: with the leaf issued first, an established ancestry survives a reuse before or after a boundary, three reuses in a row, and an end signal spent on the id it was issued under — the chain still reaches the live root and the leaf is still spared',
    rows.every((x) => x.chain.join(',') === 'M,R' && x.spared === true), rows);
}

// ================================ (5) COUNTERWEIGHT — property (a) is not traded
{
  const r = nested();
  r.issuedByMainThread('M');                 // the MAIN THREAD now owns id M
  const b = ROOT_LIVE();
  r.reap(b.cannotStillBeInFlight);
  const mainChain = r.ownerChainOf('M');
  check('(5) PROPERTY (a) IS NOT TRADED FOR IT: the MAIN-THREAD lane that re-used the id resolves to an EMPTY chain however live the background root is — a main lane can never inherit a subagent ancestry, so its genuine death is recorded (the over-suppression direction that broke attempts 1, 2 and 3)',
    mainChain.length === 0 && r.parentOf('M') === null && b.spares(mainChain) === false,
    { mainThreadChain: mainChain, parentOf_M: r.parentOf('M'), spared: b.spares(mainChain) });
}

// ================================ (6) COUNTERWEIGHT — a dead chain still reclaims
{
  const r = nested();
  r.issuedByMainThread('M');
  const b = bridge({ agents: new Map([['R', 'completed'], ['M', 'completed']]), level: new Set() });
  r.reap(b.cannotStillBeInFlight);
  check('(6) THE BOUND IS NOT BOUGHT WITH THE VERDICT EITHER: once the ROOT retires too, nothing in the leaf\'s (preserved) chain can be in flight — every record goes and the leaf is no longer spared, so a child that genuinely outlived its owners still records its honest death',
    r.size === 0 && b.spares(r.ownerChainOf('L')) === false,
    { residentAfterWholeChainRetired: r.size, chain: r.ownerChainOf('L') });
}

// ============================== (7) COUNTERWEIGHT — reuse cannot leak, at volume
{
  const r = new OpenToolCalls();
  for (let i = 0; i < 20_000; i++) {
    r.issuedBySubagent('HOT', 'R');           // one id, re-issued 20,000 times
    r.issuedBySubagent('leaf_' + i, 'HOT');
    r.issuedByMainThread('HOT');
    r.ended('leaf_' + i);
  }
  const live = bridge({ agents: new Map([['R', 'running']]), level: new Set(['R']) });
  r.reap(live.cannotStillBeInFlight);
  const whileRootLive = r.size;
  const dead = bridge({ agents: new Map([['R', 'completed']]), level: new Set() });
  r.reap(dead.cannotStillBeInFlight);
  check('(7) KEEPING OLD GENERATIONS DOES NOT LEAK: 20,000 re-issues of ONE id, each with its own leaf, leave nothing resident once the leaves have ended and nothing once the root retires — superseded generations are kept only while a descendant still needs them, which is a reason rather than a policy',
    whileRootLive === 0 && r.size === 0,
    { generationsIssued: 20_000, residentWhileRootLive: whileRootLive, residentAfterRootRetired: r.size });
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) console.log(`failed: ${failures.join(' | ')}`);
process.exit(fail ? 1 : 0);
