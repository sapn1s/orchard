#!/usr/bin/env node
/**
 * FEAT-043 — provider-routing injection, compose-layer verification.
 *
 *   node scripts/verify-routing-inject.mjs
 *
 * Mirrors scripts/verify-local-conventions.mjs: exercises the REAL compose
 * functions (routingSection, composeInstructions with the FEAT-043 `routing`
 * opt) from src/server/templates.ts against throwaway temp files — no mocks,
 * no server on :4317. Contract under test:
 *   - routingSection() extracts ONLY the `routing-inject` marked core (the
 *     condensed rules), never the full research dump, under a header carrying
 *     the staleness date + dispatch pointer;
 *   - absent/empty file → null → composeInstructions output BYTE-IDENTICAL to
 *     the no-routing base (opt-in, no error);
 *   - composeInstructions(refs, { routing }) wiring: section appended AFTER
 *     the WA, appliedIds records 'provider-routing';
 *   - the REAL committed mirror (docs/prompts/ROUTING.md) produces a small
 *     section (attention budget), and `routing: true` reads it.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-routing-data-'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-routing-files-'));
process.env.CLAUDE_STATION_DATA = DATA; // before importing the template layer

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const appendOf = (sp) => (typeof sp === 'string' ? sp : sp && typeof sp === 'object' ? sp.append : '');

async function main() {
  const { composeInstructions, routingSection, seedTemplates, ROUTING_MIRROR_RELPATH } =
    await import(path.join(ROOT, 'src', 'server', 'templates.ts'));

  const marked = path.join(TMP, 'ROUTING-marked.md');
  fs.writeFileSync(marked, [
    '# ROUTING.md — test copy',
    '',
    '> STALENESS: researched 2026-08-05.',
    '',
    'PREAMBLE-EVIDENCE-DUMP must never be injected.',
    '',
    '<!-- routing-inject:start -->',
    '## Top routing rules',
    '- math goes to Fable 5 first (test rule)',
    '- cross-provider adversarial review by default',
    '<!-- routing-inject:end -->',
    '',
    'TRAILING-EVIDENCE-DUMP must never be injected either.',
  ].join('\n'));

  /* ---- routingSection() in isolation ---- */
  console.log('\n[1] routingSection: marked-core extraction + header');
  const sec = routingSection({ filePath: marked });
  check('non-null for an existing routing file', typeof sec === 'string' && sec.length > 0, typeof sec);
  check('contains the marked core rules', (sec ?? '').includes('math goes to Fable 5 first')
    && (sec ?? '').includes('cross-provider adversarial review'), 'core rules present');
  check('EXCLUDES everything outside the markers (no research dump)',
    !(sec ?? '').includes('PREAMBLE-EVIDENCE-DUMP') && !(sec ?? '').includes('TRAILING-EVIDENCE-DUMP'), 'dump excluded');
  check('header surfaces the staleness date + points at the full doc + the dispatch command',
    /researched 2026-08-05/.test(sec ?? '') && (sec ?? '').includes(ROUTING_MIRROR_RELPATH)
    && (sec ?? '').includes('npm run dispatch'), 'header complete');

  console.log('\n[2] routingSection: absent/empty/degraded/capped');
  check('missing file → null (opt-in, no error)', routingSection({ filePath: path.join(TMP, 'nope.md') }) === null, 'null');
  const empty = path.join(TMP, 'empty.md');
  fs.writeFileSync(empty, '   \n\n');
  check('whitespace-only file → null (no vacuous section)', routingSection({ filePath: empty }) === null, 'null');
  const unmarked = path.join(TMP, 'unmarked.md');
  fs.writeFileSync(unmarked, '# routing without markers\n- rule A\n');
  const secUnmarked = routingSection({ filePath: unmarked });
  check('file WITHOUT markers degrades to the (capped) full body, not silence',
    (secUnmarked ?? '').includes('rule A'), typeof secUnmarked);
  const big = path.join(TMP, 'big.md');
  fs.writeFileSync(big, `<!-- routing-inject:start -->\n${'- rule line\n'.repeat(2000)}<!-- routing-inject:end -->\n`);
  const secBig = routingSection({ filePath: big, maxChars: 1000 });
  check('maxChars cap enforced (attention budget)', (secBig ?? '').length <= 1000, `len=${secBig?.length}`);

  /* ---- composeInstructions wiring ---- */
  console.log('\n[3] composeInstructions(refs, { routing }) wiring');
  seedTemplates();
  const base = composeInstructions([{ templateId: 'working-agreement-v2' }]);
  const baseAppend = appendOf(base.systemPrompt);
  check('PRECONDITION: WA base composed', base.mode === 'append' && baseAppend.length > 200, `bytes=${baseAppend.length}`);

  const wired = composeInstructions([{ templateId: 'working-agreement-v2' }], { routing: marked });
  const wiredAppend = appendOf(wired.systemPrompt);
  check('WIRED: routing section present in the composed prompt',
    wiredAppend.includes('math goes to Fable 5 first'), 'routing content present');
  check('WIRED: WA content intact, routing lands AFTER it',
    wiredAppend.includes('# Working Agreement v2')
    && wiredAppend.indexOf('# Working Agreement v2') < wiredAppend.indexOf('Provider Routing'),
    { waAt: wiredAppend.indexOf('# Working Agreement v2'), routingAt: wiredAppend.indexOf('Provider Routing') });
  check('WIRED: appliedIds records the provider-routing fold',
    wired.appliedIds.includes('provider-routing'), wired.appliedIds);
  check('WIRED: prompt keeps the preset+append shape',
    wired.systemPrompt?.type === 'preset' && wired.systemPrompt?.preset === 'claude_code', wired.systemPrompt?.type);

  const wiredMissing = composeInstructions([{ templateId: 'working-agreement-v2' }], { routing: path.join(TMP, 'nope.md') });
  check('WIRED: missing routing file → BYTE-IDENTICAL to the base, no spurious applied id',
    appendOf(wiredMissing.systemPrompt) === baseAppend && !wiredMissing.appliedIds.includes('provider-routing'),
    `equal=${appendOf(wiredMissing.systemPrompt) === baseAppend}`);
  const noOpt = composeInstructions([{ templateId: 'working-agreement-v2' }], {});
  check('WIRED: no routing opt at all → byte-identical (existing call sites unchanged)',
    appendOf(noOpt.systemPrompt) === baseAppend, 'backward compatible');

  /* ---- the REAL committed mirror ---- */
  console.log('\n[4] the real mirror (docs/prompts/ROUTING.md) via routing:true');
  const realFile = path.join(ROOT, ROUTING_MIRROR_RELPATH);
  check('mirror exists in the repo', fs.existsSync(realFile), realFile);
  const realSec = routingSection();
  check('routingSection() (default path) reads it and stays SMALL (condensed core, not the ~7KB dump)',
    typeof realSec === 'string' && realSec.length > 400 && realSec.length <= 4000
    && realSec.includes('Top routing rules') && !realSec.includes('## Ladder'),
    `len=${realSec?.length}`);
  const wiredReal = composeInstructions([{ templateId: 'working-agreement-v2' }], { routing: true });
  check('routing:true (the launch-path spelling) folds the real mirror in',
    appendOf(wiredReal.systemPrompt).includes('Provider Routing (mixed Claude + GPT fleet)')
    && wiredReal.appliedIds.includes('provider-routing'), wiredReal.appliedIds);

  console.log(`\nTOTAL: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log('failing checks:\n  - ' + failures.join('\n  - '));
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`FATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(() => {
  for (const d of [DATA, TMP]) fs.rmSync(d, { recursive: true, force: true });
});
