/**
 * aggregate.mjs — summarise FEAT-162 competition result rows.
 *   node scripts/eval/aggregate.mjs docs/evals/results/*.jsonl
 * Prints: model x prompt pass-rate (with n and run-variance), per-family
 * breakdown, and control pass-rate. Pure reader; no model calls.
 */
import fs from 'node:fs';

const files = process.argv.slice(2);
const rows = [];
for (const f of files) {
  for (const l of fs.readFileSync(f, 'utf8').trim().split('\n')) { if (l) rows.push(JSON.parse(l)); }
}
if (!rows.length) { console.log('no rows'); process.exit(0); }

function pct(p, n) { return n ? (100 * p / n).toFixed(0) + '%' : '-'; }
const key = (r) => `${r.label}|${r.model}|${r.prompt}`;

// model x prompt aggregate + per-run rates for variance
const cells = {};
for (const r of rows) {
  const k = key(r);
  cells[k] = cells[k] || { label: r.label, model: r.model, prompt: r.prompt, pass: 0, n: 0, runs: {}, fam: {}, ctrlPass: 0, ctrlN: 0 };
  const c = cells[k];
  c.n++; if (r.pass) c.pass++;
  c.runs[r.run] = c.runs[r.run] || { p: 0, n: 0 }; c.runs[r.run].n++; if (r.pass) c.runs[r.run].p++;
  c.fam[r.family] = c.fam[r.family] || { p: 0, n: 0 }; c.fam[r.family].n++; if (r.pass) c.fam[r.family].p++;
  if (r.control) { c.ctrlN++; if (r.pass) c.ctrlPass++; }
}

const sorted = Object.values(cells).sort((a, b) => a.label.localeCompare(b.label) || a.prompt.localeCompare(b.prompt) || a.model.localeCompare(b.model));
console.log('MODEL x PROMPT — pass-rate (n), per-run rates, control rate');
console.log('label           model                 prompt            rate   n   per-run        ctrl');
for (const c of sorted) {
  const runRates = Object.values(c.runs).map((r) => pct(r.p, r.n)).join(',');
  console.log(
    `${c.label.padEnd(15)} ${c.model.padEnd(21)} ${c.prompt.replace('.md', '').padEnd(17)} ${pct(c.pass, c.n).padStart(4)} ${String(c.n).padStart(3)}   ${runRates.padEnd(14)} ${c.ctrlN ? pct(c.ctrlPass, c.ctrlN) : '-'}`);
}

// family matrix per cell
console.log('\nPER-FAMILY (pass/n) by cell');
for (const c of sorted) {
  const fams = Object.entries(c.fam).map(([f, v]) => `${f}:${v.p}/${v.n}`).join('  ');
  console.log(`${c.label}|${c.model}|${c.prompt.replace('.md', '')}  ${fams}`);
}

// per-model aggregate across prompts (for ranking)
const perModel = {};
for (const r of rows) { perModel[r.model] = perModel[r.model] || { p: 0, n: 0 }; perModel[r.model].n++; if (r.pass) perModel[r.model].p++; }
console.log('\nPER-MODEL (all prompts/labels pooled)');
for (const [m, v] of Object.entries(perModel).sort((a, b) => (b[1].p / b[1].n) - (a[1].p / a[1].n))) console.log(`  ${m.padEnd(22)} ${pct(v.p, v.n)} (${v.p}/${v.n})`);

// per-prompt aggregate across models (for prompt effect)
const perPrompt = {};
for (const r of rows) { perPrompt[r.prompt] = perPrompt[r.prompt] || { p: 0, n: 0 }; perPrompt[r.prompt].n++; if (r.pass) perPrompt[r.prompt].p++; }
console.log('\nPER-PROMPT (all models/labels pooled)');
for (const [p, v] of Object.entries(perPrompt)) console.log(`  ${p.padEnd(22)} ${pct(v.p, v.n)} (${v.p}/${v.n})`);
