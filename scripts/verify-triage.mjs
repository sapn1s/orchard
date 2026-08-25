#!/usr/bin/env node
/**
 * verify-triage.mjs — FEAT-095: does intake triage actually recognise known work?
 *
 * This grades `scripts/triage.mjs` against REAL user requests, replayed verbatim
 * out of this project's own session transcripts, over the REAL board — not a
 * fixture board built to make it pass. The fixtures in `fixtures/triage/` are
 * the user's own words, typos included, including the surrounding meta-talk a
 * real request arrives wrapped in.
 *
 * The expectations below were written BEFORE the first graded run. Two of the
 * three requests were NEW when the user sent them and have since been filed, so
 * replaying them today must find the ticket that now exists — which is the
 * harder direction, because both of those tickets are FINISHED and finished
 * tickets appear in the digest as a bare title.
 *
 * This costs real money (one model turn per case, a few cents total). It is not
 * part of `npm run gate`. Run it when the digest, the prompt, or the model
 * changes:
 *
 *   npm run verify:triage            # graded cases
 *   npm run verify:triage -- --all   # plus the ungraded observation cases
 */

import path from 'node:path';
import url from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const FIX = path.join(HERE, 'fixtures/triage');

/**
 * `graded` cases assert. `observe` cases are recorded and printed but not
 * graded — their right answer is a genuine judgement call (several tickets
 * plausibly cover them), and inventing an expectation for one would be scoring
 * the model against my own guess rather than against the board.
 */
const CASES = [
  {
    name: 'cost-logging',
    graded: true,
    provenance: 'the user\'s verbatim request, as recorded in docs/analysis/orchestrator-required-workflow-2026-08-20.md',
    file: 'cost-logging.txt',
    expectTicket: 'FEAT-086',
    expectVerdict: ['already_exists', 'partly_exists'],
    note: 'FEAT-086 is open and half-built. This is the case that motivated the whole step: it was about to be dispatched as new work.',
  },
  {
    name: 'color-label',
    graded: true,
    provenance: 'verbatim from session 87564f3e (2026-08-20)',
    file: 'color-label.txt',
    expectTicket: 'BUG-131',
    expectVerdict: ['already_exists', 'partly_exists'],
    note: 'Was genuinely NEW when sent; BUG-131 was filed from it and is now done, so it appears in the digest as a title only.',
  },
  {
    name: 'queue-drain',
    graded: true,
    provenance: 'verbatim from session 87564f3e',
    file: 'queue-drain.txt',
    expectTicket: 'BUG-130',
    expectVerdict: ['already_exists', 'partly_exists'],
    flaky: true,
    note: [
      'KNOWN FLAKY, measured 3 of 6 runs naming BUG-130. Recorded, not tuned away.',
      'It does NOT fail the suite; it prints its result every run so a change in the rate is visible.',
      'Why it is flaky: the request is genuinely ambiguous. Several tickets are about the mid-turn',
      'message queue (FEAT-031, BUG-048, BUG-129, BUG-130) and BUG-130 is the one whose defect was',
      'its LABEL rather than the behaviour, so a reader can land on a sibling and not be wrong.',
      'Tested and ruled out as the cause: the finished-ticket title-only cut. Carrying finished',
      'tickets\' summaries too (--full, which doubles the digest) named FEAT-031 in 2 of 2 runs —',
      'it did not recover BUG-130, so the cut is not what loses it.',
      'The two unambiguous cases are stable: cost-logging 6/6, color-label 6/6.',
    ].join(' '),
  },
  {
    name: 'new-keyboard',
    graded: true,
    provenance: 'SYNTHETIC — written for this suite, in the register the user writes in. No real "genuinely new" request survives unfiled.',
    file: 'new-keyboard.txt',
    expectVerdict: ['new'],
    note: 'Guards the other direction: triage must not force every request onto some existing ticket.',
  },
  {
    name: 'ticket-ui',
    graded: false,
    provenance: 'verbatim from session 87564f3e',
    file: 'ticket-ui.txt',
    note: 'Several tickets plausibly cover this. Recorded to watch what it names, not graded.',
  },
];

function runTriage(file, model) {
  const args = [path.join(HERE, 'triage.mjs'), '--request-file', path.join(FIX, file), '--show-cost'];
  if (model) args.push('--model', model);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

async function main(argv) {
  const all = argv.includes('--all');
  const mi = argv.indexOf('--model');
  const model = mi === -1 ? null : argv[mi + 1];
  const cases = CASES.filter((c) => c.graded || all);

  const results = [];
  let fails = 0;
  let totalUsd = 0;

  for (const c of cases) {
    process.stdout.write(`\n=== ${c.name} ${c.graded ? '(graded)' : '(observation only)'}\n`);
    process.stdout.write(`    source: ${c.provenance}\n`);
    const run = await runTriage(c.file, model);
    if (run.code !== 0) {
      process.stdout.write(`FAIL ${c.name}: triage exited ${run.code}\n${run.err}\n`);
      if (c.graded) fails++;
      results.push({ case: c.name, ok: false });
      continue;
    }
    let v;
    try { v = JSON.parse(run.out); } catch (e) {
      process.stdout.write(`FAIL ${c.name}: verdict was not JSON — ${e.message}\n`);
      if (c.graded) fails++;
      continue;
    }
    const named = [v.ticket, ...(v.related || [])].filter(Boolean);
    totalUsd += v.cost?.usd || 0;
    process.stdout.write(`    verdict: ${v.verdict}  ticket: ${v.ticket || '—'}  related: ${(v.related || []).join(', ') || '—'}\n`);
    process.stdout.write(`    why: ${v.why}\n`);
    if (v.gap) process.stdout.write(`    gap: ${v.gap}\n`);
    if (v.draft) process.stdout.write(`    draft: ${v.draft.type} — ${v.draft.title}\n`);
    process.stdout.write(`    cost: $${(v.cost?.usd ?? 0).toFixed(4)} in ${((v.cost?.ms ?? 0) / 1000).toFixed(1)}s\n`);

    if (!c.graded) { results.push({ case: c.name, ok: null }); continue; }

    const problems = [];
    if (c.expectVerdict && !c.expectVerdict.includes(v.verdict)) {
      problems.push(`verdict ${v.verdict}, expected one of ${c.expectVerdict.join('/')}`);
    }
    if (c.expectTicket && !named.includes(c.expectTicket)) {
      problems.push(`did not name ${c.expectTicket} (named ${named.join(', ') || 'nothing'})`);
    }
    if (c.expectVerdict?.includes('new') && v.verdict === 'new' && !v.draft) {
      problems.push('verdict new carried no drafted ticket');
    }
    if (problems.length && c.flaky) {
      // A known-unstable case is reported, never hidden, and never counted as a
      // pass — but it does not turn the suite red, because a suite that is
      // always red stops being read. The measured rate is in its `note`.
      process.stdout.write(`FLAKY-MISS ${c.name}: ${problems.join('; ')}\n`);
      process.stdout.write(`    known: ${c.note}\n`);
      results.push({ case: c.name, ok: null, flakyMiss: true });
    } else if (problems.length) {
      process.stdout.write(`FAIL ${c.name}: ${problems.join('; ')}\n`);
      fails++;
      results.push({ case: c.name, ok: false });
    } else {
      process.stdout.write(`PASS ${c.name}${c.flaky ? ' (known-flaky case, hit this time)' : ''}\n`);
      results.push({ case: c.name, ok: true });
    }
  }

  const graded = results.filter((r) => r.ok !== null);
  const misses = results.filter((r) => r.flakyMiss).length;
  if (misses) process.stdout.write(`\n=== ${misses} known-flaky case(s) missed this run — reported, not counted\n`);
  process.stdout.write(`\n=== triage: ${graded.filter((r) => r.ok).length}/${graded.length} graded cases pass · $${totalUsd.toFixed(4)} for ${cases.length} runs (avg $${(totalUsd / Math.max(1, cases.length)).toFixed(4)}/run)\n`);
  return fails === 0 ? 0 : 1;
}

main(process.argv.slice(2)).then((c) => { process.exitCode = c; }).catch((e) => {
  process.stderr.write(`${e.stack || e.message}\n`);
  process.exitCode = 1;
});
