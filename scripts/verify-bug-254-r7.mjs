#!/usr/bin/env node
/**
 * BUG-254 r7 — single fixer-test entrypoint: runs both no-docker suites (P4 reconciler + P3
 * credential-write atomicity) and exits 0 only if BOTH pass. The real container end-to-end heal is
 * scripts/verify-bug-254-container-heal.mjs (needs the Docker sandbox; run separately).
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const suites = [
  'scripts/verify-bug-254-reconciler-unknown.mjs',
  'scripts/verify-bug-254-cred-atomicity.mjs',
];
let bad = 0;
for (const s of suites) {
  console.log(`\n======== ${s} ========`);
  const r = spawnSync('npx', ['tsx', s], { cwd: REPO, stdio: 'inherit', timeout: 180_000 });
  if ((r.status ?? 1) !== 0) { bad++; console.log(`SUITE FAILED: ${s} (exit ${r.status})`); }
}
console.log(`\n==== BUG-254 r7 fixer tests: ${suites.length - bad}/${suites.length} suites passed ====`);
process.exit(bad ? 1 : 0);
