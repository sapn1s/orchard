#!/usr/bin/env node
/**
 * FEAT-084 — response-format (orchard-digest) injection + per-project override.
 *
 *   node scripts/verify-feat-084-response-format-inject.mjs
 *
 * Closes the FEAT-083 gap: the parser/renderer/opt-out flag/convention doc all
 * shipped, but NOTHING injected the format instruction into a session — so it
 * worked only by the agent's memory and no other project got it. This exercises
 * the REAL compose functions (responseFormatSection, composeInstructions with the
 * FEAT-084 `responseFormat` opt) + the REAL registry merge + the REAL validator
 * against throwaway temp files — no mocks, no server on :4317.
 *
 * Load-bearing safety property under test (the ticket's named risk): the
 * disabled / missing-file / no-option path is BYTE-IDENTICAL to the output
 * before this option existed — composeInstructions builds every session's system
 * prompt, so a perturbation there touches every session. Proven BOTH directions:
 * disabled === base (identical), enabled !== base (injection actually happens, so
 * the identity test can't pass vacuously).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rf-data-'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rf-files-'));
process.env.CLAUDE_STATION_DATA = DATA; // before importing the server layers

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const appendOf = (sp) => (typeof sp === 'string' ? sp : sp && typeof sp === 'object' ? sp.append : '');

function writeDoc(name, core, { preamble = 'PREAMBLE-DOC-DUMP', trailing = 'TRAILING-DOC-DUMP' } = {}) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, [
    '# RESPONSE_FORMAT.md — test copy',
    '',
    `${preamble} must never be injected.`,
    '',
    '<!-- response-format-inject:start -->',
    core,
    '<!-- response-format-inject:end -->',
    '',
    `${trailing} must never be injected either.`,
  ].join('\n'));
  return p;
}

async function main() {
  const { composeInstructions, responseFormatSection, seedTemplates, RESPONSE_FORMAT_RELPATH } =
    await import(path.join(ROOT, 'src', 'server', 'templates.ts'));
  const registry = await import(path.join(ROOT, 'src', 'server', 'registry.ts'));
  const { validateProjectPatch } = await import(path.join(ROOT, 'src', 'server', 'validate.ts'));

  const CORE = [
    '## Response format — `orchard-digest` (agent core)',
    '',
    'Lead substantive replies with a single ```orchard-digest fence holding JSON.',
    '- kind: decision | done | in-flight | fyi. No emojis, ever.',
  ].join('\n');

  /* ---- [1] responseFormatSection() in isolation ---- */
  console.log('\n[1] responseFormatSection: marked-core extraction + header');
  const marked = writeDoc('RF-marked.md', CORE);
  const sec = responseFormatSection({ filePath: marked });
  check('non-null for an existing doc', typeof sec === 'string' && sec.length > 0, typeof sec);
  check('contains the marked core rules',
    (sec ?? '').includes('orchard-digest') && (sec ?? '').includes('No emojis, ever'), 'core present');
  check('EXCLUDES everything outside the markers (no doc dump)',
    !(sec ?? '').includes('PREAMBLE-DOC-DUMP') && !(sec ?? '').includes('TRAILING-DOC-DUMP'), 'dump excluded');
  check('header points at the full doc',
    (sec ?? '').includes(RESPONSE_FORMAT_RELPATH), 'header present');
  check('NO override subhead when no guidance', !(sec ?? '').includes('## Project override'), 'no override');

  console.log('\n[2] responseFormatSection: absent/empty/degraded/capped');
  check('missing file → null (opt-in, no error)', responseFormatSection({ filePath: path.join(TMP, 'nope.md') }) === null, 'null');
  const empty = path.join(TMP, 'empty.md');
  fs.writeFileSync(empty, '   \n\n');
  check('whitespace-only file → null (no vacuous section)', responseFormatSection({ filePath: empty }) === null, 'null');
  const unmarked = path.join(TMP, 'unmarked.md');
  fs.writeFileSync(unmarked, '# rf without markers\n- rule A\n');
  check('file WITHOUT markers degrades to the (capped) full body, not silence',
    (responseFormatSection({ filePath: unmarked }) ?? '').includes('rule A'), 'degraded');
  const big = path.join(TMP, 'big.md');
  fs.writeFileSync(big, `<!-- response-format-inject:start -->\n${'- rule line\n'.repeat(2000)}<!-- response-format-inject:end -->\n`);
  const secBig = responseFormatSection({ filePath: big, maxChars: 1000 });
  check('maxChars cap enforced (attention budget)', (secBig ?? '').length <= 1000, `len=${secBig?.length}`);

  console.log('\n[3] guidance → ## Project override subhead');
  const secG = responseFormatSection({ filePath: marked, guidance: 'Keep digests to at most 3 items; skip fyi.' });
  check('guidance text appears UNDER the override subhead when set',
    (secG ?? '').includes('## Project override') && (secG ?? '').includes('Keep digests to at most 3 items')
      && (secG ?? '').indexOf('## Project override') < (secG ?? '').indexOf('Keep digests to at most 3 items'),
    'guidance under subhead');
  check('empty-string guidance → NO override subhead (identical to no guidance)',
    responseFormatSection({ filePath: marked, guidance: '   ' }) === sec, 'empty == none');
  check('null guidance → NO override subhead', !(responseFormatSection({ filePath: marked, guidance: null }) ?? '').includes('## Project override'), 'null none');

  /* ---- [4] composeInstructions wiring + BYTE-IDENTITY (the named risk) ---- */
  console.log('\n[4] composeInstructions(refs, { responseFormat }) wiring + byte-identity');
  seedTemplates();
  const refs = [{ templateId: 'working-agreement-v2' }];
  // Launch-shaped base: hostPath + routing:true, exactly what agent-bridge builds,
  // but WITHOUT the responseFormat option — the "before this option existed" output.
  const base = composeInstructions(refs, { routing: true });
  const baseAppend = appendOf(base.systemPrompt);
  check('PRECONDITION: base composed (WA + routing)', base.mode === 'append' && baseAppend.length > 200, `bytes=${baseAppend.length}`);

  const enabled = composeInstructions(refs, { routing: true, responseFormat: { filePath: marked } });
  const enabledAppend = appendOf(enabled.systemPrompt);
  check('ENABLED: response-format section present in the composed prompt',
    enabledAppend.includes('Response Format (orchard-digest)') && enabledAppend.includes('No emojis, ever'), 'present');
  check('ENABLED: lands LAST — after WA and after routing',
    enabledAppend.indexOf('# Working Agreement v2') < enabledAppend.indexOf('Provider Routing')
      && enabledAppend.indexOf('Provider Routing') < enabledAppend.indexOf('Response Format (orchard-digest)'),
    { waAt: enabledAppend.indexOf('# Working Agreement v2'), rtAt: enabledAppend.indexOf('Provider Routing'), rfAt: enabledAppend.indexOf('Response Format (orchard-digest)') });
  check('ENABLED: appliedIds records the response-format fold', enabled.appliedIds.includes('response-format'), enabled.appliedIds);
  check('ENABLED: keeps the preset+append shape',
    enabled.systemPrompt?.type === 'preset' && enabled.systemPrompt?.preset === 'claude_code', enabled.systemPrompt?.type);

  // BYTE-IDENTITY, direction 1: disabled === base. responseFormat:false is the
  // exact value agent-bridge passes when responseDigest.enabled === false.
  const disabled = composeInstructions(refs, { routing: true, responseFormat: false });
  check('DISABLED (responseFormat:false) → BYTE-IDENTICAL to base',
    appendOf(disabled.systemPrompt) === baseAppend && !disabled.appliedIds.includes('response-format'),
    `equal=${appendOf(disabled.systemPrompt) === baseAppend}`);
  const noOpt = composeInstructions(refs, { routing: true });
  check('NO opt at all → byte-identical (existing call sites unchanged)',
    appendOf(noOpt.systemPrompt) === baseAppend, 'backward compatible');
  const missing = composeInstructions(refs, { routing: true, responseFormat: { filePath: path.join(TMP, 'nope.md') } });
  check('ENABLED but doc MISSING → byte-identical, no spurious applied id',
    appendOf(missing.systemPrompt) === baseAppend && !missing.appliedIds.includes('response-format'),
    `equal=${appendOf(missing.systemPrompt) === baseAppend}`);

  // BYTE-IDENTITY, direction 2 (the MUST-FAIL guard): enabled MUST differ from
  // base — otherwise the identity checks above would pass vacuously (a no-op
  // injection). This asserts the injection genuinely changes the bytes.
  check('MUST-FAIL guard: ENABLED output DIFFERS from base (injection is real, not a no-op)',
    enabledAppend !== baseAppend && enabledAppend.length > baseAppend.length, `enabled=${enabledAppend.length} base=${baseAppend.length}`);

  /* ---- [5] REALISTIC STATE: full launch shape, digest on + real guidance ---- */
  console.log('\n[5] realistic launch state: WA + local conventions + routing + response-format + guidance');
  const host = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rf-host-'));
  fs.mkdirSync(path.join(host, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(host, 'docs', 'CONVENTIONS.md'), '# Local\n- project-specific rule XYZ\n');
  const real = composeInstructions(refs, {
    hostPath: host,
    routing: true,
    responseFormat: { filePath: marked, guidance: 'Prefer done+decision items; keep it terse.' },
  });
  const realAppend = appendOf(real.systemPrompt);
  check('all four layers present and ORDERED (WA → conventions → routing → response-format)',
    realAppend.indexOf('# Working Agreement v2') < realAppend.indexOf('Project Conventions (local)')
      && realAppend.indexOf('Project Conventions (local)') < realAppend.indexOf('Provider Routing')
      && realAppend.indexOf('Provider Routing') < realAppend.indexOf('Response Format (orchard-digest)'),
    'ordered');
  check('realistic guidance lands under the override subhead',
    realAppend.includes('## Project override') && realAppend.includes('Prefer done+decision items'), 'guidance present');
  check('appliedIds shows the full stack',
    ['local-conventions', 'provider-routing', 'response-format'].every((x) => real.appliedIds.includes(x)), real.appliedIds);
  fs.rmSync(host, { recursive: true, force: true });

  /* ---- [6] the REAL committed doc via responseFormat:true ---- */
  console.log('\n[6] the real committed doc (docs/prompts/RESPONSE_FORMAT.md) via responseFormat:true');
  const realFile = path.join(ROOT, RESPONSE_FORMAT_RELPATH);
  check('committed doc exists + carries the inject markers', fs.existsSync(realFile)
    && /<!--\s*response-format-inject:start\s*-->/.test(fs.readFileSync(realFile, 'utf8')), realFile);
  const realSec = responseFormatSection();
  // BUDGET. This bound is the attention budget, not a formatting detail: the section
  // is paid on every turn of every project. It was 4000 through round 13 (observed
  // 3716). Round 14 added the in-block prose shape — rules plus a worked
  // narrative/shaped pair — for +1529 bytes, deliberately, because "be concise" as an
  // assertion had already failed here repeatedly and a demonstration is what changes
  // output. Raised to 5500, which keeps ~250 bytes of headroom AND stays under the
  // default maxChars (6000) so the core is delivered whole rather than truncated
  // mid-rule. Growing past this is a decision, not an accident.
  check('responseFormatSection() (default path) reads it, stays condensed (marked core only)',
    typeof realSec === 'string' && realSec.length > 300 && realSec.length <= 5500
      && realSec.length < 6000
      && realSec.includes('orchard-digest') && !realSec.includes('How it degrades (the UI contract)'),
    `len=${realSec?.length}`);
  const wiredReal = composeInstructions(refs, { routing: true, responseFormat: true });
  check('responseFormat:true (launch-path spelling) folds the real doc in',
    appendOf(wiredReal.systemPrompt).includes('Response Format (orchard-digest)') && wiredReal.appliedIds.includes('response-format'),
    wiredReal.appliedIds);

  /* ---- [7] registry merge: siblings preserved ---- */
  console.log('\n[7] registry merge preserves siblings (patch one key, keep the other)');
  const host2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rf-proj-'));
  const proj = registry.createProject({ name: 'rf-merge', hostPath: host2 });
  // seed both fields
  registry.updateProject(proj.id, { settings: { responseDigest: { enabled: true, guidance: 'seed-guidance' } } });
  // patch ONLY guidance → enabled must survive
  const afterG = registry.updateProject(proj.id, { settings: { responseDigest: { guidance: 'new-guidance' } } });
  check('patch only guidance → enabled SURVIVES (still true) and guidance updated',
    afterG.settings.responseDigest.enabled === true && afterG.settings.responseDigest.guidance === 'new-guidance',
    afterG.settings.responseDigest);
  // patch ONLY enabled → guidance must survive
  const afterE = registry.updateProject(proj.id, { settings: { responseDigest: { enabled: false } } });
  check('patch only enabled → guidance SURVIVES and enabled updated',
    afterE.settings.responseDigest.enabled === false && afterE.settings.responseDigest.guidance === 'new-guidance',
    afterE.settings.responseDigest);
  fs.rmSync(host2, { recursive: true, force: true });

  /* ---- [8] validator: accept + reject ---- */
  console.log('\n[8] validator whitelists guidance, rejects abuse');
  const ok = (label, fn) => { try { fn(); check(label, true, 'accepted'); } catch (e) { check(label, false, e.message); } };
  const rej = (label, fn, frag) => {
    try { fn(); check(label, false, 'accepted (should have thrown)'); }
    catch (e) { check(label, String(e.message).includes(frag ?? ''), e.message); }
  };
  ok('accepts a normal guidance string',
    () => validateProjectPatch({ settings: { responseDigest: { guidance: 'be terse' } } }));
  ok('accepts guidance:null (clear)',
    () => validateProjectPatch({ settings: { responseDigest: { guidance: null } } }));
  ok('accepts multi-line guidance (tab/newline allowed)',
    () => validateProjectPatch({ settings: { responseDigest: { guidance: 'line one\n\tline two' } } }));
  const overlong = 'x'.repeat(601);
  rej('rejects over-long guidance (>600)',
    () => validateProjectPatch({ settings: { responseDigest: { guidance: overlong } } }), '600');
  rej('rejects a control character in guidance',
    () => validateProjectPatch({ settings: { responseDigest: { guidance: 'bad\u0000null' } } }), 'control');
  rej('rejects a non-string, non-null guidance',
    () => validateProjectPatch({ settings: { responseDigest: { guidance: 42 } } }), 'string or null');
  rej('rejects an unknown responseDigest sub-key',
    () => validateProjectPatch({ settings: { responseDigest: { verbosity: 'high' } } }), 'unknown responseDigest field');
  // whitelisted enabled still works alongside guidance
  ok('accepts {enabled, guidance} together',
    () => validateProjectPatch({ settings: { responseDigest: { enabled: true, guidance: 'ok' } } }));

  console.log(`\nTOTAL: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log('failing checks:\n  - ' + failures.join('\n  - '));
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`FATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(() => {
  for (const dir of [DATA, TMP]) fs.rmSync(dir, { recursive: true, force: true });
});
