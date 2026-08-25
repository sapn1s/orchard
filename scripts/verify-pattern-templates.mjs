/**
 * FEAT-024 — workflow-pattern templates verification.
 *
 *   node scripts/verify-pattern-templates.mjs
 *
 * Four opt-in "dispatch shape" templates (manager→sub-agent tree, index-table
 * router, raw+curated memory split, go/no-go pre-flight gate) are seeded by
 * seedTemplates() alongside the two Working Agreement docs, but — unlike
 * those — nothing auto-references them; a project only gets one if it
 * explicitly selects it. This exercises the real functions the session
 * launcher and UI use (seedTemplates / listTemplates / readTemplate /
 * composeInstructions) against a throwaway temp data dir — no mocks, no
 * server on port 4317.
 *
 * Checks:
 *   1. seedTemplates() seeds all four pattern ids (alongside the two WA ids).
 *   2. Seeding is idempotent — a second call skips all of them, and does NOT
 *      clobber a user's hand-edited body (the same conflict/backup rule the
 *      WA seeds already rely on).
 *   3. Each pattern template is listable via listTemplates(), with a
 *      non-empty name/description and real body content read through from
 *      its docs/prompts/patterns/*.md source file.
 *   4. Each pattern template composes into a prompt when an InstructionRef
 *      selects it (and is ABSENT from the composed prompt when not selected
 *      — proving they are opt-in, not auto-injected).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pattern-tmpl-data-'));
process.env.CLAUDE_STATION_DATA = DATA;
const tmpDirs = [DATA];

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const appendOf = (sp) => (typeof sp === 'string' ? sp : sp && typeof sp === 'object' ? sp.append : '');

const PATTERN_IDS = [
  'pattern-manager-subagent-tree',
  'pattern-index-table-router',
  'pattern-raw-curated-memory-split',
  'pattern-go-no-go-preflight',
];

async function main() {
  const { saveTemplate, readTemplate, listTemplates, composeInstructions, seedTemplates } =
    await import(path.join(ROOT, 'src', 'server', 'templates.ts'));

  // --------------------------------------------------------- 1. basic seeding
  const { seeded, skipped } = seedTemplates();
  check('seedTemplates seeds all four pattern templates',
    PATTERN_IDS.every((id) => seeded.includes(id)), seeded);
  check('seedTemplates also still seeds the two Working Agreement docs',
    seeded.includes('working-agreement') && seeded.includes('working-agreement-v2'), seeded);
  check('first call reports nothing skipped for the pattern ids',
    PATTERN_IDS.every((id) => !skipped.includes(id)), skipped);

  // --------------------------------------------------- 2. idempotent re-seed
  const second = seedTemplates();
  check('a second seedTemplates() call skips all four pattern ids (idempotent)',
    PATTERN_IDS.every((id) => second.skipped.includes(id)) && PATTERN_IDS.every((id) => !second.seeded.includes(id)),
    second);

  // ------------------------------------------- 3. does not clobber user edits
  const editedBody = 'USER EDITED BODY — must survive re-seed untouched.';
  saveTemplate({
    id: 'pattern-go-no-go-preflight',
    name: 'Pattern: Go/No-go Pre-flight Gate (user-edited)',
    defaultMode: 'append',
    living: false,
    description: 'user override',
    body: editedBody,
    overwrite: true,
    source: '', // deliberately detach from the repo source, mirroring a real hand-edit via the UI
  });
  const third = seedTemplates();
  check('re-seeding after a user edit reports the edited id as skipped, not re-seeded',
    third.skipped.includes('pattern-go-no-go-preflight') && !third.seeded.includes('pattern-go-no-go-preflight'),
    third);
  const editedRead = readTemplate('pattern-go-no-go-preflight');
  check('the user-edited body is preserved verbatim after re-seed',
    (editedRead?.body ?? '').trim() === editedBody, editedRead?.body);

  // Restore the real seed for the rest of the checks by using a fresh data dir.
  const DATA2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pattern-tmpl-data2-'));
  tmpDirs.push(DATA2);
  process.env.CLAUDE_STATION_DATA = DATA2;
  seedTemplates();

  // --------------------------------------------------------------- 4. listable
  const list = listTemplates();
  for (const id of PATTERN_IDS) {
    const t = list.find((x) => x.id === id);
    check(`listTemplates() includes ${id}`, !!t, t?.id ?? '(missing)');
    check(`${id} has a non-empty name`, !!t && t.name.trim().length > 0, t?.name);
    check(`${id} has a non-empty description`, !!t && t.description.trim().length > 0, t?.description);
    check(`${id} body is read through from its docs/prompts/patterns source (non-trivial length)`,
      !!t && t.body.trim().length > 200, t?.body?.length);
  }

  // Content sanity: each body actually mentions its own pattern name, so this
  // isn't accidentally comparing against the wrong file.
  const expectSubstr = {
    'pattern-manager-subagent-tree': 'manager→sub-agent',
    'pattern-index-table-router': 'Index-table router',
    'pattern-raw-curated-memory-split': 'Raw + curated memory split',
    'pattern-go-no-go-preflight': 'Go/no-go pre-flight gate',
  };
  for (const [id, needle] of Object.entries(expectSubstr)) {
    const t = readTemplate(id);
    check(`${id} body contains its own pattern heading`, (t?.body ?? '').includes(needle), t?.body?.slice(0, 80));
  }

  // ---------------------------------------------------- 5. opt-in composition
  // Selected: shows up in the composed prompt.
  const composedSelected = composeInstructions([{ templateId: 'pattern-index-table-router' }]);
  const appendSelected = appendOf(composedSelected.systemPrompt);
  check('composeInstructions includes a pattern template body when explicitly selected',
    appendSelected.includes('Index-table router'), appendSelected.slice(0, 80));
  check('composeInstructions reports the pattern id as applied',
    composedSelected.appliedIds.includes('pattern-index-table-router'), composedSelected.appliedIds);

  // Not selected: composing an UNRELATED ref must not pull it in — proves
  // these are opt-in, not auto-injected like the WA docs.
  const composedOther = composeInstructions([{ templateId: 'working-agreement-v2' }]);
  const appendOther = appendOf(composedOther.systemPrompt);
  check('a pattern template is ABSENT from a compose that does not select it (opt-in, not auto-injected)',
    !appendOther.includes('Index-table router') && !appendOther.includes('manager→sub-agent'), appendOther.length);

  // All four together, in order, compose cleanly with distinct sections.
  const composedAll = composeInstructions(PATTERN_IDS.map((templateId) => ({ templateId })));
  const appendAll = appendOf(composedAll.systemPrompt);
  check('all four pattern templates compose together with no missing ids',
    composedAll.missingIds.length === 0 && composedAll.appliedIds.length === 4, composedAll);
  for (const [id, needle] of Object.entries(expectSubstr)) {
    check(`combined compose includes ${id}'s heading`, appendAll.includes(needle), id);
  }

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});
