/**
 * nonvacuity.mjs — proves each scorer in text-set.v2.jsonl is NON-VACUOUS:
 * the case's synthetic GOOD answer must PASS and every synthetic BAD answer
 * must FAIL. Prints the observed values the scorer actually read, so the proof
 * is inspectable, and exits nonzero if any expectation is violated.
 *
 *   node scripts/eval/nonvacuity.mjs [path-to-jsonl]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreCase } from './scorers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.resolve(HERE, '../../docs/evals/text-set.v2.jsonl');
const cases = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

let fails = 0, goodChecks = 0, badChecks = 0;
const out = [];
out.push(`NON-VACUITY PROOF — ${path.basename(file)} — ${cases.length} cases — ${new Date().toISOString()}`);
out.push('For each case: GOOD must PASS, every BAD must FAIL. Observed = values the scorer read.\n');

for (const c of cases) {
  out.push(`### ${c.id}  [${c.family}]  scorer=${c.scorer.type}${c.is_positive_control ? '  (positive-control)' : ''}`);
  const g = scoreCase(c, c._proof.good);
  goodChecks++;
  const gok = g.pass === true;
  if (!gok) fails++;
  out.push(`  GOOD  expect=PASS  got=${g.pass ? 'PASS' : 'FAIL'}  ${gok ? 'OK' : '*** VIOLATION'}  observed=${JSON.stringify(g.observed)}`);
  for (const b of c._proof.bad) {
    badChecks++;
    const r = scoreCase(c, b.text);
    const bok = r.pass === false;
    if (!bok) fails++;
    out.push(`  BAD   expect=FAIL  got=${r.pass ? 'PASS' : 'FAIL'}  ${bok ? 'OK' : '*** VIOLATION'}  (${b.why})  observed=${JSON.stringify(r.observed)}`);
  }
  out.push('');
}

out.push(`SUMMARY: ${cases.length} cases, ${goodChecks} good-answer checks, ${badChecks} bad-answer checks, ${fails} violation(s).`);
out.push(fails === 0 ? 'RESULT: PASS — every scorer is non-vacuous (good passes, bad fails).'
                     : `RESULT: FAIL — ${fails} violation(s); a scorer is vacuous or mis-keyed.`);

const text = out.join('\n') + '\n';
process.stdout.write(text);
const proofPath = path.resolve(HERE, '../../docs/evals/nonvacuity-proof.v2.txt');
if (process.env.WRITE_PROOF) fs.writeFileSync(proofPath, text);
process.exit(fails === 0 ? 0 : 1);
