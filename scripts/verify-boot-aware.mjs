/**
 * FEAT-021 — "Session boots aware" verification.
 *
 *   node scripts/verify-boot-aware.mjs
 *
 * Every session launched via the dashboard for a project that HAS a board
 * (docs/bugs/) must boot ALREADY AWARE of current state: a compact, capped
 * "Project state" section is FOLDED onto the composed Working-Agreement system
 * prompt — ADDED to it, never clobbering it. A project with no board injects
 * nothing (opt-in) yet still gets the WA.
 *
 * This exercises the REAL compose layer — the exact two functions the session
 * launcher (src/server/agent-bridge.ts) uses to assemble the prompt:
 *   - boardStateSection(hostPath)  (src/server/board.ts)
 *   - appendToSystemPrompt(sp, x)  (src/server/templates.ts)
 * plus the real composeInstructions() over a really-seeded Working-Agreement
 * template. No mocks. No server on port 4317: this is a pure in-process compose,
 * with all state in throwaway temp dirs.
 *
 * MUST FAIL before the FEAT-021 code exists (the two imports resolve to nothing)
 * and PASS after — non-vacuous by construction, and the checks below assert both
 * halves are present at once (WA content AND the live board section), so neither
 * one clobbering the other passes silently.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-boot-data-'));
const WITH = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-boot-with-'));   // has docs/bugs/
const WITHOUT = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-boot-none-')); // no docs/bugs/

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
  // A project WITH an opt-in board: two 👤 rows and one 🤖 row.
  const bugs = path.join(WITH, 'docs', 'bugs');
  fs.mkdirSync(bugs, { recursive: true });
  fs.writeFileSync(path.join(bugs, 'INDEX.md'),
    `# Board\n\n## Open\n\n` +
    `| ID | Title | Owner | Status | Sev |\n` +
    `|----|-------|-------|--------|-----|\n` +
    `| BUG-801 | should the importer skip malformed rows or halt? | 👤 | needs decision | high |\n` +
    `| FEAT-802 | wire the export button to the new endpoint | 👤 | needs decision | med |\n` +
    `| BUG-803 | flaky retry loop under load | 🤖 | building | med |\n\n` +
    `## Done (committed)\n\n| ID | Title | Commit |\n|----|-------|--------|\n`);
  for (const [id, title] of [
    ['BUG-801', 'should the importer skip malformed rows or halt?'],
    ['FEAT-802', 'wire the export button to the new endpoint'],
    ['BUG-803', 'flaky retry loop under load'],
  ]) {
    fs.writeFileSync(path.join(bugs, `${id}-x.md`), `# ${id} — ${title}\n\n- **Status:** OPEN\n`);
  }
  fs.writeFileSync(path.join(WITHOUT, 'README.md'), '# no board here\n');

  const { boardStateSection } = await import(path.join(ROOT, 'src', 'server', 'board.ts'));
  const { composeInstructions, appendToSystemPrompt, seedTemplates } =
    await import(path.join(ROOT, 'src', 'server', 'templates.ts'));

  // Seed the REAL Working-Agreement templates into the scratch data dir, then
  // compose them exactly as a launch would — this is the WA base prompt.
  seedTemplates();
  const composed = composeInstructions([{ templateId: 'working-agreement-v2' }]);
  const baseAppend = appendOf(composed.systemPrompt);
  check('PRECONDITION: composeInstructions produced a non-empty WA append base',
    composed.mode === 'append' && baseAppend.length > 200, `mode=${composed.mode} bytes=${baseAppend.length}`);
  // A distinctive slice of the WA content we will require to survive intact.
  const waMarker = baseAppend.slice(50, 130);

  // --- board-having project: section is composed, capped, and non-clobbering ---
  const section = boardStateSection(WITH);
  check('board section is composed for a project WITH docs/bugs/ (not null)',
    typeof section === 'string' && section.length > 0, typeof section);
  check('section carries the CURRENT needs-you count (2 seeded)',
    /Needs you \(2\)/.test(section ?? ''), (section ?? '').match(/Needs you \(\d+\)/)?.[0]);
  check('section carries a one-line Focus on the highest-priority open item',
    /\*\*Focus:\*\*/.test(section ?? '') && (section ?? '').includes('BUG-801'),
    (section ?? '').split('\n').find((l) => l.includes('Focus')) ?? '(no focus line)');
  check('section names the in-flight (🤖) item too',
    (section ?? '').includes('BUG-803'), (section ?? '').includes('BUG-803'));
  check('section stays within the hard length cap (attention budget)',
    (section ?? '').length <= 1200, `${(section ?? '').length} chars`);

  // Fold it onto the WA — the REAL launch assembly.
  const folded = appendToSystemPrompt(composed.systemPrompt, section);
  const foldedAppend = appendOf(folded);
  check('FOLDED prompt CONTAINS the live needs-you count (board half present)',
    /Needs you \(2\)/.test(foldedAppend) && /\*\*Focus:\*\*/.test(foldedAppend), 'both board markers present');
  check('FOLDED prompt STILL CONTAINS the WA content (WA half not clobbered)',
    foldedAppend.includes(waMarker) && foldedAppend.includes('# Working Agreement v2'),
    `waMarker present=${foldedAppend.includes(waMarker)}`);
  check('folded prompt keeps the preset+append shape (Claude Code base intact)',
    folded && typeof folded === 'object' && folded.type === 'preset' && folded.preset === 'claude_code',
    JSON.stringify({ type: folded?.type, preset: folded?.preset }));

  // --- board-less project: injects nothing, WA still applies ---
  const none = boardStateSection(WITHOUT);
  check('a project with NO docs/bugs/ injects NOTHING (null section)', none === null, none);
  const foldedNone = appendToSystemPrompt(composed.systemPrompt, none);
  const noneAppend = appendOf(foldedNone);
  check('board-less prompt still contains the WA content',
    noneAppend.includes(waMarker) && noneAppend.includes('# Working Agreement v2'), 'WA present');
  check('board-less prompt contains NO Project-state section',
    !noneAppend.includes('Project state') && noneAppend === baseAppend, 'no board section injected');

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
