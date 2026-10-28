#!/usr/bin/env node
/**
 * verify:feat-199 (r3) — the canonical round-3 fixer test: runs BOTH round-3
 * suites and fails if either fails.
 *   - verify-feat-199-r3-deeplink.mjs — DEFECT 1 (server): deep link resolves a
 *     stem≠id / tail-recovered / same-id-twin session through the shared true-id
 *     index (must-FAIL on the r2 filename-only resolver).
 *   - verify-feat-199-r3-client.mjs — DEFECT 2 + the load-more race (client):
 *     the finder keeps a separate search corpus that a forced page-1 reload
 *     never shrinks, and a generation token drops a stale-cursor load-more
 *     (PART A model must-FAILs on the r2 shape; PART B drives the real browser).
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const suites = ['verify-feat-199-r3-deeplink.mjs', 'verify-feat-199-r3-client.mjs'];

const run = (s) => new Promise((resolve) => {
  console.log(`\n########## ${s} ##########`);
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', s)], { cwd: ROOT, stdio: 'inherit' });
  c.on('exit', (code) => resolve(code ?? 1));
});

let fail = 0;
for (const s of suites) { if (await run(s)) fail++; }
console.log(fail === 0 ? '\nPASS verify-feat-199-r3 (both suites)' : `\nFAIL verify-feat-199-r3 (${fail} suite(s))`);
process.exit(fail === 0 ? 0 : 1);
