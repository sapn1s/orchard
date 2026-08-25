#!/usr/bin/env node
/**
 * FEAT-088 Layer 1 CLI — run the mechanical structural checks on a file and
 * print a human-readable report. Thin wrapper over scripts/lib/structure.mjs
 * (the pure module a stop hook or board check consumes the same way). Reports
 * only; gates nothing.
 *
 *   node scripts/structure-lint.mjs <file.md> [--json]
 *
 * Exit 0 always when it ran (a report, not a gate). --json emits the raw
 * analyzeStructure() object for programmatic callers.
 */
import * as fs from 'node:fs';
import { analyzeStructure } from './lib/structure.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const file = args.find((a) => !a.startsWith('--'));
if (!file) { process.stderr.write('usage: node scripts/structure-lint.mjs <file.md> [--json]\n'); process.exit(2); }
if (!fs.existsSync(file)) { process.stderr.write(`structure-lint: file not found: ${file}\n`); process.exit(2); }

const s = analyzeStructure(fs.readFileSync(file, 'utf8'));

if (json) { process.stdout.write(JSON.stringify(s, null, 2) + '\n'); process.exit(0); }

console.log(`structure-lint: ${file} — ${s.units} claim units`);
if (!s.repeatedClaims.length) {
  console.log('  no restated-claim clusters (>=3 restatements) found.');
} else {
  console.log(`  ${s.repeatedClaims.length} restated-claim cluster(s):`);
  for (const c of s.repeatedClaims) {
    console.log(`\n  ● ${c.size} occurrence(s) across ${c.lines} lines — theme: ${c.theme.join(', ')}`);
    for (const o of c.occurrences) console.log(`      L${o.line}: ${o.text.length > 120 ? o.text.slice(0, 117) + '…' : o.text}`);
  }
}
if (s.ordering) {
  console.log(`\n  ⤷ ordering: the recommendation at L${s.ordering.decisionLine} is only justified later, at L${s.ordering.firstJustificationLine}.`);
  console.log(`      decision:      ${s.ordering.decisionText.slice(0, 110)}`);
  console.log(`      justification: ${s.ordering.justificationText.slice(0, 110)}`);
}
process.exit(0);
