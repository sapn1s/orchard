#!/usr/bin/env node
/**
 * ARCH-003 — REPRODUCTION of the 4th clean-room BROKEN verdict on `2427220`.
 *
 * Reconstructed from the verdict's own output line so the defect is reproduced before
 * anything is changed. The design CLAIMS order-independence, which makes
 * `tool_result` before `assistant` a SUPPORTED ordering, not a protocol violation.
 * Under that ordering `ended()` is discarded (it was guarded by `#open.has(id)`), the
 * later `issuedBySubagent()` opens a call that is ALREADY OVER, and no further end
 * signal will ever arrive for it — so `reap()` never touches it.
 *
 * Expected on the defective build: resident === total, bounded === false, exit 1.
 *
 * Usage: node scripts/adversarial-arch-003-result-before-open-growth.mjs
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


const TOTAL = 100_000;
const r = new OpenToolCalls();
for (let i = 0; i < TOTAL; i++) {
  const id = 'c' + i;
  r.ended(id);                       // the call's tool_result arrives FIRST
  r.issuedBySubagent(id, 'ownerW');  // ... then the assistant frame that issued it
  if (i % 1000 === 0) r.reap();      // turn boundaries throughout
}
r.reap();

const resident = r.size;
const bounded = resident < 1000;
console.log(JSON.stringify({ ordering: 'result>assistant>boundary', total: TOTAL, resident, bounded }));
if (!bounded) {
  console.log('DEFECT: already-ended calls accumulate without bound when result precedes assistant');
  process.exit(1);
}
console.log('BOUNDED: result-before-assistant calls are reclaimed at the turn boundary');
process.exit(0);
