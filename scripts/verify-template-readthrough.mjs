/**
 * FEAT-027 — "read-through" verification.
 *
 *   node scripts/verify-template-readthrough.mjs
 *
 * A `living` template that declares a `source:` repo-file path must resolve
 * its BODY from that file at read/compose time — no stored-copy drift, no
 * manual re-POST after editing the repo file. This exercises the REAL
 * functions the session launcher uses (readTemplate / composeInstructions /
 * saveTemplate / seedTemplates) against a throwaway temp data dir and a
 * throwaway temp "repo" source file — no mocks, no server on port 4317.
 *
 * MUST FAIL before the FEAT-027 code exists: pre-change, `readTemplate()`
 * only ever returns the stored copy taken at save time, so editing the
 * source file on disk with NO re-save is invisible to a fresh read — the
 * "edit source, re-read with no save" check below is the one that catches
 * that and is non-vacuous by construction (it requires ACTUALLY re-reading
 * after a real filesystem edit, not just checking the field exists).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-tmplrt-data-'));
// The read-through path guard in templates.ts deliberately refuses to resolve
// a `source` OUTSIDE projectRoot() (no path escape) — so the scratch "repo
// file" this test edits must live INSIDE the repo tree, not /tmp. Still
// throwaway: a dotdir under the repo root, removed in `finally` below.
const SRC_DIR = fs.mkdtempSync(path.join(ROOT, '.cs-tmplrt-src-'));

// Data dir MUST be set before importing the template layer — templatesDir()
// reads $CLAUDE_STATION_DATA lazily.
process.env.CLAUDE_STATION_DATA = DATA;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const appendOf = (sp) => (typeof sp === 'string' ? sp : sp && typeof sp === 'object' ? sp.append : '');

async function main() {
  const {
    saveTemplate,
    readTemplate,
    composeInstructions,
    seedTemplates,
  } = await import(path.join(ROOT, 'src', 'server', 'templates.ts'));

  // --------------------------------------------------------- 1. basic wiring
  // A source-backed living template, created with an initial body copy (as
  // saveTemplate always requires a body) but pointing at a real repo-relative
  // file outside the data dir.
  const sourceFile = path.join(SRC_DIR, 'LIVING_DOC.md');
  fs.writeFileSync(sourceFile, '# v1\n\nOriginal content.\n');
  const sourceRel = path.relative(ROOT, sourceFile);

  saveTemplate({
    id: 'rt-living-doc',
    name: 'RT Living Doc',
    defaultMode: 'append',
    living: true,
    description: 'read-through test doc',
    body: '# v1\n\nOriginal content.\n', // initial stored copy, same as source
    source: sourceRel,
  });

  const t1 = readTemplate('rt-living-doc');
  check('readTemplate resolves source and reports it on the Template',
    t1?.source === sourceRel, t1?.source);
  check('readTemplate body matches the source file (not a stale copy)',
    (t1?.body ?? '').includes('Original content.'), t1?.body);
  check('sourceMissing is false when the source file is present',
    t1?.sourceMissing === false, t1?.sourceMissing);

  const composed1 = composeInstructions([{ templateId: 'rt-living-doc' }]);
  const append1 = appendOf(composed1.systemPrompt);
  check('composeInstructions includes the source content (v1)',
    append1.includes('Original content.'), append1);

  // --------------------------------------------- 2. THE non-vacuous crux ---
  // Modify the source file on disk directly — NO saveTemplate/POST call.
  fs.writeFileSync(sourceFile, '# v2\n\nEDITED content — no re-POST happened.\n');

  const t2 = readTemplate('rt-living-doc');
  check('a fresh readTemplate reflects the on-disk edit with NO save/POST',
    (t2?.body ?? '').includes('EDITED content — no re-POST happened.'), t2?.body);
  check('the stale v1 text is gone from the fresh read',
    !(t2?.body ?? '').includes('Original content.'), t2?.body);

  const composed2 = composeInstructions([{ templateId: 'rt-living-doc' }]);
  const append2 = appendOf(composed2.systemPrompt);
  check('composeInstructions ALSO reflects the edit with no save/POST (the real launch path)',
    append2.includes('EDITED content — no re-POST happened.') && !append2.includes('Original content.'),
    append2);

  // ------------------------------------------- 3. missing-source fallback --
  fs.unlinkSync(sourceFile);
  let threw = null;
  let t3 = null;
  try {
    t3 = readTemplate('rt-living-doc');
  } catch (err) {
    threw = err;
  }
  check('a deleted source does NOT throw', threw === null, threw?.message ?? '(no throw)');
  check('a deleted source falls back to the last stored body (not empty/crashed)',
    (t3?.body ?? '').includes('Original content.'), t3?.body);
  check('sourceMissing is true once the source disappears', t3?.sourceMissing === true, t3?.sourceMissing);
  const composed3 = composeInstructions([{ templateId: 'rt-living-doc' }]);
  check('composeInstructions still works (no throw) with a missing source',
    composed3.mode === 'append' && appendOf(composed3.systemPrompt).includes('Original content.'),
    composed3.mode);

  // ------------------------------------------- 4. non-source templates unchanged
  saveTemplate({
    id: 'rt-plain-doc',
    name: 'RT Plain Doc',
    defaultMode: 'append',
    living: false,
    description: 'no source — behaves exactly as today',
    body: 'plain stored body, no source',
  });
  const plain = readTemplate('rt-plain-doc');
  check('a template with no source has source undefined',
    plain?.source === undefined, plain?.source);
  check('a template with no source just returns its stored body',
    (plain?.body ?? '').trim() === 'plain stored body, no source', plain?.body);

  // A save that overwrites WITHOUT mentioning source must not detach an
  // existing source-backed template (unaware UI edits shouldn't drift it).
  saveTemplate({
    id: 'rt-living-doc',
    name: 'RT Living Doc',
    defaultMode: 'append',
    living: true,
    description: 'read-through test doc',
    body: 'irrelevant — source still governs body',
    overwrite: true,
  });
  fs.writeFileSync(sourceFile, '# v3\n\nrestored + re-edited.\n');
  const t4 = readTemplate('rt-living-doc');
  check('an overwrite save that omits source preserves the existing source (no silent detach)',
    t4?.source === sourceRel, t4?.source);
  check('...and the read-through body still reflects the live source file',
    (t4?.body ?? '').includes('restored + re-edited.'), t4?.body);

  // ------------------------------------------------------- 5. seed migration
  // seedTemplates() must record `source` on the two real WA seeds so this
  // repo's own docs/prompts/WORKING_AGREEMENT*.md are read-through too.
  const { seeded } = seedTemplates();
  check('seedTemplates seeds both working-agreement docs into the scratch dir',
    seeded.includes('working-agreement') && seeded.includes('working-agreement-v2'), seeded);
  const wa2 = readTemplate('working-agreement-v2');
  check('the seeded working-agreement-v2 records a source path',
    typeof wa2?.source === 'string' && wa2.source.length > 0, wa2?.source);
  const realWaFile = path.join(ROOT, 'docs', 'prompts', 'WORKING_AGREEMENT.v2.md');
  const realWaContent = fs.readFileSync(realWaFile, 'utf8');
  check('the seeded working-agreement-v2 body matches the REAL repo file right now',
    (wa2?.body ?? '').trim() === realWaContent.trim(), `bytes stored=${wa2?.bytes} real=${realWaContent.length}`);

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(() => {
  for (const d of [DATA, SRC_DIR]) fs.rmSync(d, { recursive: true, force: true });
});
