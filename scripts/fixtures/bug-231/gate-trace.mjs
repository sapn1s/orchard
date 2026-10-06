/**
 * BUG-231 — a NODE_OPTIONS `--import` preload that records every REAL leak-gate run.
 * The scratch server's env carries NODE_OPTIONS=--import=<this file> and
 * B231_GATE_TRACE=<file>; every node child inherits it, including the
 * `node scripts/leak-gate.mjs …` the host spawns from runLeakGateForRepo. When THIS
 * process is the gate, its argv is appended to the trace. One runLeakGateForRepo =
 * one `--summary` run (working tree) plus one `--summary --staged` run, so the suite
 * counts the runs that carry no `--staged`. Inert in every other process.
 */
import * as fs from 'node:fs';

const trace = process.env.B231_GATE_TRACE;
const script = process.argv[1] || '';
if (trace && /[\\/]scripts[\\/]leak-gate\.mjs$/.test(script)) {
  try { fs.appendFileSync(trace, `${JSON.stringify({ at: Date.now(), args: process.argv.slice(2) })}\n`); } catch { /* best effort */ }
}
