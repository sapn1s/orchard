#!/usr/bin/env node
/**
 * verify:feat-199 (r4) — the ONE canonical runner for round 4. Chains every
 * FEAT-199 suite so a single fixer-test command covers the whole contract:
 *   - r4-canonical : the single shared canonical index; full/page/deep agree on
 *                    twins across dirs (breaks 1 & 2 must-FAIL + fix); the
 *                    round-4 cursor-is-a-position decision lives in keyset.
 *   - keyset       : findings 1/2/3, limit edges, and the cursor contract
 *                    (malformed → 400; a well-formed fabricated cursor is a
 *                    valid position → 200).
 *   - adversarial  : paged SET == full SET on hostile store shapes.
 *   - r3           : deep-link resolver + finder-corpus + load-more race.
 *   - pagination   : the REAL store (union == full, timings, browser deep link).
 *
 * Exits non-zero if any suite fails. No port 4317, no writes outside scratch.
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const suites = [
  'verify-feat-199-r4-canonical.mjs',
  'verify-feat-199-keyset.mjs',
  'verify-feat-199-adversarial.mjs',
  'verify-feat-199-r3.mjs',
  'verify-feat-199-pagination.mjs',
];

let failed = 0;
for (const s of suites) {
  console.log(`\n########## ${s} ##########`);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', s)], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.log(`!! ${s} exited ${r.status}`); }
}
console.log(`\n${failed === 0 ? 'PASS' : `FAIL (${failed} suite(s))`} — verify-feat-199-r4 (canonical runner)`);
process.exit(failed === 0 ? 0 : 1);
