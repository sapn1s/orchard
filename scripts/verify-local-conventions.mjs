/**
 * FEAT-039 — per-project local-conventions doc, compose-layer verification.
 *
 *   node scripts/verify-local-conventions.mjs
 *
 * Mirrors scripts/verify-boot-aware.mjs / verify-template-readthrough.mjs:
 * exercises the REAL compose-layer functions (composeInstructions,
 * appendToSystemPrompt, localConventionsSection — all src/server/templates.ts)
 * against throwaway temp dirs, no mocks, no server on :4317.
 *
 * A project with `docs/CONVENTIONS.md` present must get it injected ALONGSIDE
 * (appended after) the shared Working Agreement; a project without one must
 * inject nothing extra — opt-in, exactly like the board section (FEAT-021).
 *
 * WIRING assertions (composeInstructions(refs, { hostPath }) itself, not a
 * manual appendToSystemPrompt() fold done by the test): these are the ones
 * that must FAIL against a pre-wiring templates.ts, since before the wiring
 * composeInstructions() took only one argument and ignored a second one
 * entirely — the manual-fold checks above prove the pieces work in isolation,
 * these prove they're actually connected.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-localconv-data-'));
const WITH = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-localconv-with-'));     // has docs/CONVENTIONS.md
const WITHOUT = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-localconv-none-'));  // no docs/CONVENTIONS.md

// Data dir MUST be set before importing the template layer — templatesDir()
// reads $CLAUDE_STATION_DATA lazily, and we seed the real WA into this scratch.
process.env.CLAUDE_STATION_DATA = DATA;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const appendOf = (sp) => (typeof sp === 'string' ? sp : sp && typeof sp === 'object' ? sp.append : '');

async function main() {
  const { composeInstructions, appendToSystemPrompt, localConventionsSection, seedTemplates, LOCAL_CONVENTIONS_RELPATH } =
    await import(path.join(ROOT, 'src', 'server', 'templates.ts'));

  fs.mkdirSync(path.join(WITH, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(WITH, LOCAL_CONVENTIONS_RELPATH),
    '# Local rules\n\n- This project deploys via `deploy.sh`, never manually.\n- Staging DB lives at db.internal:5432.\n',
  );
  fs.writeFileSync(path.join(WITHOUT, 'README.md'), '# no local conventions doc here\n');

  seedTemplates();
  const composed = composeInstructions([{ templateId: 'working-agreement-v2' }]);
  const baseAppend = appendOf(composed.systemPrompt);
  check('PRECONDITION: composeInstructions produced a non-empty WA append base',
    composed.mode === 'append' && baseAppend.length > 200, `mode=${composed.mode} bytes=${baseAppend.length}`);
  const waMarker = baseAppend.slice(50, 130);

  // --- project WITH docs/CONVENTIONS.md: section composed, non-null ---
  const section = localConventionsSection(WITH);
  check('localConventionsSection is non-null for a project WITH docs/CONVENTIONS.md',
    typeof section === 'string' && section.length > 0, typeof section);
  check('section carries the actual local-doc content',
    (section ?? '').includes('deploy.sh'), section);

  const folded = appendToSystemPrompt(composed.systemPrompt, section);
  const foldedAppend = appendOf(folded);
  check('FOLDED prompt contains the local-conventions content',
    foldedAppend.includes('deploy.sh') && foldedAppend.includes('db.internal:5432'), 'local content present');
  check('FOLDED prompt STILL contains the shared WA content (not clobbered)',
    foldedAppend.includes(waMarker) && foldedAppend.includes('# Working Agreement v2'),
    `waMarker present=${foldedAppend.includes(waMarker)}`);
  check('local conventions land AFTER the shared WA in the composed text (universal first, local as addendum)',
    foldedAppend.indexOf('# Working Agreement v2') < foldedAppend.indexOf('Project Conventions (local)'),
    { waAt: foldedAppend.indexOf('# Working Agreement v2'), localAt: foldedAppend.indexOf('Project Conventions (local)') });
  check('folded prompt keeps the preset+append shape (Claude Code base intact)',
    folded && typeof folded === 'object' && folded.type === 'preset' && folded.preset === 'claude_code',
    JSON.stringify({ type: folded?.type, preset: folded?.preset }));

  // --- project WITHOUT docs/CONVENTIONS.md: injects nothing extra ---
  const none = localConventionsSection(WITHOUT);
  check('a project with NO docs/CONVENTIONS.md injects NOTHING (null section)', none === null, none);
  const foldedNone = appendToSystemPrompt(composed.systemPrompt, none);
  const noneAppend = appendOf(foldedNone);
  check('doc-less prompt still contains the WA content',
    noneAppend.includes(waMarker) && noneAppend.includes('# Working Agreement v2'), 'WA present');
  check('doc-less prompt contains NO Project Conventions section, and is byte-identical to the WA-only base',
    !noneAppend.includes('Project Conventions (local)') && noneAppend === baseAppend, 'no local section injected');

  // --- WIRING: composeInstructions(refs, { hostPath }) itself, no manual fold ---
  const wiredWith = composeInstructions([{ templateId: 'working-agreement-v2' }], { hostPath: WITH });
  const wiredWithAppend = appendOf(wiredWith.systemPrompt);
  check('WIRED: composeInstructions(refs, {hostPath}) for a project WITH docs/CONVENTIONS.md includes the local content',
    wiredWithAppend.includes('deploy.sh') && wiredWithAppend.includes('db.internal:5432'), wiredWithAppend.slice(-400));
  check('WIRED: still includes the shared WA content (local is an addendum, not a replacement)',
    wiredWithAppend.includes('# Working Agreement v2'), 'WA header present=' + wiredWithAppend.includes('# Working Agreement v2'));
  check('WIRED: local conventions land AFTER the WA in the wired output',
    wiredWithAppend.indexOf('# Working Agreement v2') < wiredWithAppend.indexOf('Project Conventions (local)'),
    { waAt: wiredWithAppend.indexOf('# Working Agreement v2'), localAt: wiredWithAppend.indexOf('Project Conventions (local)') });
  check('WIRED: appliedIds records the local-conventions fold',
    wiredWith.appliedIds.includes('local-conventions'), wiredWith.appliedIds);

  const wiredWithout = composeInstructions([{ templateId: 'working-agreement-v2' }], { hostPath: WITHOUT });
  const wiredWithoutAppend = appendOf(wiredWithout.systemPrompt);
  check('WIRED: composeInstructions(refs, {hostPath}) for a project WITHOUT docs/CONVENTIONS.md injects NOTHING extra (byte-identical to the no-opts base)',
    wiredWithoutAppend === baseAppend, `equal=${wiredWithoutAppend === baseAppend} bytes=${wiredWithoutAppend.length} vs ${baseAppend.length}`);
  check('WIRED: no-doc project does not record a spurious "local-conventions" applied id',
    !wiredWithout.appliedIds.includes('local-conventions'), wiredWithout.appliedIds);
  check('WIRED: composeInstructions() called with NO opts at all (existing call sites) still works unchanged',
    appendOf(composeInstructions([{ templateId: 'working-agreement-v2' }]).systemPrompt) === baseAppend,
    'backward-compatible: no opts arg produces identical output');

  // --- empty/whitespace-only doc behaves like absent (no vacuous injection) ---
  const EMPTYDOC = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-localconv-empty-'));
  fs.mkdirSync(path.join(EMPTYDOC, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(EMPTYDOC, LOCAL_CONVENTIONS_RELPATH), '   \n\n  \n');
  const emptySection = localConventionsSection(EMPTYDOC);
  check('a whitespace-only docs/CONVENTIONS.md is treated as absent (null, not an empty injected section)',
    emptySection === null, emptySection);
  fs.rmSync(EMPTYDOC, { recursive: true, force: true });

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(() => {
  for (const d of [DATA, WITH, WITHOUT]) fs.rmSync(d, { recursive: true, force: true });
});
