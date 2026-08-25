#!/usr/bin/env node
/**
 * FEAT-088 Layer 2 — the MODEL structural-review pass (SCAFFOLD, manual-only).
 *
 * Layer 1 (scripts/lib/structure.mjs) mechanically finds restated claims and a
 * misordered recommendation. It cannot judge the things that need reading
 * comprehension: whether a sentence is required-to-decide or merely orienting,
 * whether four options actually collapse to two, whether the ordering serves the
 * reader. Those are Layer 2 — a model review, run by a model that did NOT write
 * the text (the same generation-must-not-verify-itself rule as
 * independent-verify.mjs; a self-review shares the author's blind spot).
 *
 * This is a SCAFFOLD. It is invoked BY HAND against a file. Nothing runs it
 * automatically and nothing is gated on its output — FEAT-088 records an OPEN
 * user decision about where/whether it runs on every decision-bearing reply, so
 * wiring it into any blocking path is deliberately NOT done here.
 *
 *   node scripts/structure-review.mjs <file.md> [--author-provider anthropic|openai]
 *        [--provider anthropic|openai] [--model <m>] [--timeout-min <n>]
 *        [--no-layer1] [--print-prompt]
 *
 * Defaults: the reviewer is the CROSS provider to the author (decorrelated blind
 * spots, ROUTING.md). --print-prompt composes the review prompt and prints it
 * WITHOUT dispatching (the seam the verify script drives — no network needed).
 *
 * The reviewer's five steps (the checklist that demonstrably worked on ARCH-003):
 *   1. Classify EVERY sentence: required-to-decide / required-to-trust /
 *      orienting / redundant / dispensable.
 *   2. Count repetitions, with a quote and location for each occurrence.
 *   3. Ordering: does the reader meet the justification BEFORE the decision?
 *   4. Challenge the option count — are the choices genuinely distinct, or do
 *      some collapse into one another?
 *   5. State the irreducible core as a list of FACTS, so the floor is known
 *      independent of wording.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeStructure } from './lib/structure.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DISPATCH = path.join(HERE, 'dispatch.mjs');

const USAGE = 'usage: node scripts/structure-review.mjs <file.md> [--author-provider anthropic|openai] [--provider anthropic|openai] [--model <m>] [--timeout-min <n>] [--no-layer1] [--print-prompt]';

function die(msg, code = 2) { process.stderr.write(`structure-review: ${msg}\n`); process.exit(code); }

const argv = process.argv.slice(2);
const opts = { file: null, authorProvider: 'anthropic', provider: null, model: null, timeoutMin: 15, layer1: true, printPrompt: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const take = () => { if (i + 1 >= argv.length) die(`${a} needs a value`); return argv[++i]; };
  if (a === '--author-provider') opts.authorProvider = take();
  else if (a === '--provider') opts.provider = take();
  else if (a === '--model') opts.model = take();
  else if (a === '--timeout-min') opts.timeoutMin = Number(take());
  else if (a === '--no-layer1') opts.layer1 = false;
  else if (a === '--print-prompt') opts.printPrompt = true;
  else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
  else if (!a.startsWith('--') && !opts.file) opts.file = a;
  else die(`unknown argument ${a}\n${USAGE}`);
}
if (!opts.file) die(`a file to review is required\n${USAGE}`);
if (!fs.existsSync(opts.file)) die(`file not found: ${opts.file}`);
if (opts.authorProvider !== 'anthropic' && opts.authorProvider !== 'openai') die('--author-provider must be anthropic|openai');
// Reviewer must not be the author: cross-provider by default (decorrelated blind spots).
if (!opts.provider) opts.provider = opts.authorProvider === 'anthropic' ? 'openai' : 'anthropic';
if (opts.provider === opts.authorProvider) {
  process.stderr.write('structure-review: WARNING — reviewer provider equals the author provider; a self-review shares the author\'s blind spot (see FEAT-088 / independent-verify.mjs).\n');
}

const text = fs.readFileSync(opts.file, 'utf8');

/** The mechanical Layer-1 findings, folded in as a STARTING POINT for the model
 *  (it must still do its own count — Layer 1 under- and over-reports). */
function layer1Digest() {
  const s = analyzeStructure(text);
  const lines = [];
  if (s.repeatedClaims.length) {
    lines.push(`Layer-1 (mechanical) flagged ${s.repeatedClaims.length} restated-claim cluster(s) — verify and extend, do not trust blindly:`);
    for (const c of s.repeatedClaims) {
      lines.push(`  • ${c.size} occurrence(s) on ${c.lines} lines [theme: ${c.theme.join(', ')}] at lines ${c.occurrences.map((o) => o.line).join(', ')}`);
    }
  } else {
    lines.push('Layer-1 (mechanical) found no restated-claim cluster — do your own count anyway; it can under-report reshaped restatements.');
  }
  if (s.ordering) {
    lines.push(`Layer-1 ordering flag: the recommendation at line ${s.ordering.decisionLine} is only justified later, at line ${s.ordering.firstJustificationLine}.`);
  }
  return lines.join('\n');
}

function composePrompt() {
  return `You are a STRUCTURAL READABILITY REVIEWER. A human has to READ the document
below and act on it, and human reading time is the scarce resource — far scarcer
than your processing time. You did NOT write this text; do not be fair to it, do
not smooth it over. Your job is to find where it wastes the reader's attention
through STRUCTURE, not sentence complexity: the same fact restated as if new, a
justification placed after the decision it supports, options that look distinct
but collapse, a second decision buried in an aside.

${opts.layer1 ? `=== MECHANICAL PRE-PASS (a starting point, not the answer) ===\n${layer1Digest()}\n` : ''}
=== THE DOCUMENT UNDER REVIEW ===
${text}

=== DO EXACTLY THESE FIVE STEPS, IN ORDER ===
1. SENTENCE NECESSITY. Classify EVERY sentence of the human-facing prose as one
   of: required-to-decide | required-to-trust | orienting | redundant |
   dispensable. Give the count in each bucket.
2. REPETITION. List each claim that is asserted more than once. For each, quote
   every occurrence and give its location, and say how many times it appears.
   Count independently of the mechanical pre-pass.
3. ORDERING. Does the reader meet the JUSTIFICATION for the recommendation before
   the recommendation itself? If the thesis sentence sits after the decision it
   supports, say so and quote both.
4. OPTION COLLAPSE. Challenge the option count. For each pair of options, ask
   whether they are genuinely distinct choices or whether one collapses into
   another. State how many REAL choices remain.
5. IRREDUCIBLE CORE. State the irreducible core of the document as a flat list of
   FACTS a decision actually needs — so the floor is known independent of wording.

Then give: the ESTIMATED reading-time saving if the redundancy and misordering
were fixed, and the SINGLE highest-value structural edit. Be concrete and quote
the text. Do not rewrite the whole document.`;
}

if (opts.printPrompt) { process.stdout.write(composePrompt()); process.exit(0); }

const prompt = composePrompt();
process.stderr.write(`structure-review: reviewing ${opts.file}\n`);
process.stderr.write(`  reviewer ${opts.provider}${opts.model ? '/' + opts.model : ''} (author ${opts.authorProvider}${opts.provider === opts.authorProvider ? ' — SAME provider, decorrelation reduced' : ' → cross-provider'}), read-only\n`);

const child = spawn(process.execPath, [
  DISPATCH,
  '--provider', opts.provider,
  ...(opts.model ? ['--model', opts.model] : []),
  '--sandbox', 'read-only',
  '--timeout-min', String(opts.timeoutMin),
  '--prompt-stdin',
], { stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.on('error', () => {});
child.stdin.end(prompt);
child.once('error', (e) => die(`could not launch dispatch: ${e.message}`, 1));
child.once('exit', (code) => process.exit(code ?? 1));
