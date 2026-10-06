/**
 * BUG-203 r4 — guard() must not retain superseded continuations.
 *
 * The r3 guard adopted a single module-lifetime `NEVER = new Promise(()=>{})`
 * for every superseded resolution. NEVER is a GC root, and adopting it adds the
 * awaiting op's async frame to NEVER's reaction list forever — so every project
 * switch with a request in flight leaks that frame (the clean room measured
 * 500/500 frames retained; 0 with a fresh never-promise per call). r4 gives each
 * superseded resolution its OWN `new Promise(()=>{})`, an unrooted cycle that GC
 * collects.
 *
 * This extracts the ACTUAL shipped guard (and any NEVER) from the file, runs 500
 * superseded ops, and counts how many of their frames GC reclaims via a
 * FinalizationRegistry. Must be run with --expose-gc.
 *
 *   node --expose-gc scripts/verify-gitview-guard-retention.mjs
 *   GV_FILE=/tmp/gv-b203-r3.js node --expose-gc scripts/verify-gitview-guard-retention.mjs   # must-FAIL
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = process.env.GV_FILE || path.join(ROOT, 'public', 'lib', 'git-view.js');
const N = Number(process.env.RETAIN_N || 500);

if (typeof global.gc !== 'function') {
  console.error('  FATAL: run with --expose-gc (node --expose-gc scripts/verify-gitview-guard-retention.mjs)');
  process.exit(2);
}

const src = fs.readFileSync(FILE, 'utf8');
const neverLine = (src.match(/^\s*const NEVER\s*=.*$/m) || [null])[0];
const guardLine = (src.match(/^\s*const guard\s*=.*$/m) || [null])[0];
if (!guardLine) { console.error('  FATAL: no `const guard =` found in ' + FILE); process.exit(2); }

// Build the real guard with a captured `superseded` over a mutable generation.
let generation = 0;
const superseded = (t) => t !== generation;
const makeGuard = new Function('superseded', `${neverLine ? neverLine.trim() + '\n' : ''}${guardLine.trim()}\nreturn guard;`);
const guard = makeGuard(superseded);

let collected = 0;
const fr = new FinalizationRegistry(() => { collected += 1; });

function spawn() {
  const big = { pad: new Array(256).fill(7) }; // the frame closes over this
  fr.register(big);
  void (async () => { const v = await guard(0, Promise.resolve(1)); big.used = v; })();
}

async function main() {
  generation = 999999;               // supersede every op (token 0 never matches)
  for (let i = 0; i < N; i += 1) spawn();
  for (let k = 0; k < 25; k += 1) { global.gc(); await new Promise((r) => setTimeout(r, 15)); }

  const shared = !!neverLine;
  const rate = collected / N;
  console.log(`  file: ${FILE}`);
  console.log(`  guard uses a ${shared ? 'SHARED module-lifetime NEVER (r3)' : 'per-call never-promise (r4)'}`);
  console.log(`  superseded ops: ${N} — frames GC-reclaimed: ${collected} (${(rate * 100).toFixed(0)}%)`);

  const ok = collected >= N * 0.5;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  superseded continuations are collectable (>=50% reclaimed)`);
  console.log(`\n  ${ok ? 'ALL PASS' : 'FAILURES'}`);
  process.exitCode = ok ? 0 : 1;
}
main();
