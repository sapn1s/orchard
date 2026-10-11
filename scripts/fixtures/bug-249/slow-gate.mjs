#!/usr/bin/env node
/**
 * BUG-249 fixture — a stand-in for scripts/leak-gate.mjs that takes a controlled amount
 * of WALL time, so a responsiveness test can contrast execFileSync (blocks the event
 * loop) with execFile (does not) deterministically, without depending on a specific
 * large repository. Behaviour via env:
 *   SLOW_GATE_MS   — wall time to take before printing/exiting (default 900).
 *   SLOW_GATE_EXIT — exit code (default 0 = clean). Non-zero = a leak/error (fail-closed).
 *   SLOW_GATE_HANG — if '1', never exit (so the caller's timeout must fire).
 * It is deliberately NOT a real scan; the responsiveness property under test is purely
 * "does the host loop keep turning while the gate subprocess runs", which is independent
 * of what the gate actually computes. A real-repo run of the same test is driven by
 * passing --big-repo=<path> to the verifier instead (see verify-bug-249-gate-nonblocking).
 */
const ms = Number(process.env.SLOW_GATE_MS ?? '900');
const exit = Number(process.env.SLOW_GATE_EXIT ?? '0');
if (process.env.SLOW_GATE_HANG === '1') { setInterval(() => {}, 1 << 30); }
else {
  setTimeout(() => {
    process.stdout.write(exit === 0 ? 'leak gate: clean (fixture)\n' : 'leak gate: FAIL (fixture)\n');
    process.exit(exit);
  }, Math.max(0, ms));
}
