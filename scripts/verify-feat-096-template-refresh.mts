/**
 * FEAT-096 (phase 3) — stored-template refresh verification.
 *
 *   npm run verify:feat-096-template-refresh
 *
 * THE DEFECT: `seedTemplates()` skipped any seed whose file already existed, so
 * the STORED body of a source-backed seed (e.g. the Working Agreement) stayed
 * frozen at first-seed time forever. Harmless while readTemplate()'s read-through
 * masks it, but a stale degraded fallback today and a silent three-week-old WA
 * the day the read-through is removed.
 *
 * THE FIX: `seedTemplates()` now refreshes the stored body of an already-seeded,
 * still-source-backed seed from its source file — never touching a template a
 * user detached or re-pointed, never churning an already-current body, and
 * failing open (degrade, don't throw) on an unreadable source for an EXISTING
 * template.
 *
 * ISOLATION: runs against a throwaway CLAUDE_STATION_DATA under ~/scratch
 * (NEVER /tmp, never the real data dir). No server on :4317. Synthetic
 * source-backed templates that need a real file on disk live in a dotdir under
 * the repo root (the read-through path guard refuses sources outside
 * projectRoot()); it is removed in `finally`.
 *
 * MUST-FAIL PROOF (anchored to a FIXED reconstruction, not HEAD): section 1
 * reconstructs the stale condition (seed, then overwrite the stored body with
 * old text) and shows a local `legacySeedStep()` — the exact pre-fix loop body
 * (`if (existsSync) skip`) — leaves it stale, while the real fixed
 * `seedTemplates()` refreshes it.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRATCH_ROOT = path.join(os.homedir(), 'scratch');
const DATA = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'cs-feat096-refresh-data-'));
// Synthetic in-repo source files (needed for the re-pointed case) — a dotdir
// under the repo root so the read-through path guard accepts them; removed in
// finally.
const SRC_DIR = fs.mkdtempSync(path.join(ROOT, '.cs-feat096-src-'));

process.env.CLAUDE_STATION_DATA = DATA;

let pass = 0,
  fail = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, observed?: unknown) {
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${
      typeof observed === 'string' ? observed : JSON.stringify(observed)
    }`,
  );
  if (ok) pass++;
  else {
    fail++;
    failures.push(name);
  }
}

const WA2_ID = 'working-agreement-v2';
const WA2_SRC = path.join(ROOT, 'docs', 'prompts', 'WORKING_AGREEMENT.v2.md');
const WA2_FILE = () => path.join(DATA, 'templates', `${WA2_ID}.md`);
const GONOGO_ID = 'pattern-go-no-go-preflight';
const GONOGO_SRC = path.join(ROOT, 'docs', 'prompts', 'patterns', 'GO_NO_GO_PREFLIGHT.md');
const GONOGO_FILE = () => path.join(DATA, 'templates', `${GONOGO_ID}.md`);

const THRESHOLD_A = 'Yes → dispatch, at any size';
const THRESHOLD_B = '93.2%';
const STALE_MARKER = 'STALE-PRE-FEAT096-BODY-DO-NOT-SERVE';

// A realistic reconstruction of the user's REAL stale file: no `source:` line
// (pre-FEAT-027 seed, relies on DEFAULT_SEED_SOURCES read-through) + a body that
// predates the inline-work threshold.
function staleWa2FileContents(): string {
  return [
    '---',
    'name: Working Agreement v2',
    'defaultMode: append',
    'living: true',
    'description: Living copy — appended to whenever a preference or failure mode shows up in practice.',
    '---',
    '',
    '# Working Agreement v2 — living version',
    '',
    `${STALE_MARKER}: this body is three weeks old and has no §I inline-work threshold.`,
    '',
  ].join('\n');
}

// The EXACT pre-fix loop body: an existing file is skipped, full stop. Anchors
// the must-FAIL to a fixed reconstruction of legacy behaviour, independent of
// what HEAD does.
function legacySeedStep(file: string): 'seeded' | 'skipped' {
  if (fs.existsSync(file)) return 'skipped';
  return 'seeded';
}

async function main() {
  const tpl = await import(path.join(ROOT, 'src', 'server', 'templates.ts'));
  const { seedTemplates, readTemplate, saveTemplate } = tpl;

  // =========================================================================
  // 1. MUST-FAIL PROOF — legacy skips a staled body; the fix refreshes it.
  // =========================================================================
  console.log('\n=== 1. must-FAIL proof: staled stored body ===');
  seedTemplates(); // fresh seed of everything
  // Reconstruct the stale condition: overwrite the stored body with old text.
  fs.writeFileSync(WA2_FILE(), staleWa2FileContents());

  // Pre-fix behaviour (fixed reconstruction): legacy skips → stays stale.
  const legacyVerdict = legacySeedStep(WA2_FILE());
  const afterLegacy = fs.readFileSync(WA2_FILE(), 'utf8');
  check(
    '[must-FAIL] legacy seed skips the existing file (does NOT refresh)',
    legacyVerdict === 'skipped',
    legacyVerdict,
  );
  check(
    '[must-FAIL] under legacy behaviour the stored body stays STALE (no threshold text)',
    afterLegacy.includes(STALE_MARKER) &&
      !afterLegacy.includes(THRESHOLD_A) &&
      !afterLegacy.includes(THRESHOLD_B),
    { hasStale: afterLegacy.includes(STALE_MARKER), hasA: afterLegacy.includes(THRESHOLD_A) },
  );

  // Fixed behaviour: real seedTemplates() refreshes the stored body.
  const r1 = seedTemplates();
  const afterFix = fs.readFileSync(WA2_FILE(), 'utf8');
  check('[fix] seedTemplates reports working-agreement-v2 as refreshed', r1.refreshed.includes(WA2_ID), r1);
  check('[fix] refreshed stored body now carries the inline-work threshold (both anchor strings)',
    afterFix.includes(THRESHOLD_A) && afterFix.includes(THRESHOLD_B),
    { hasA: afterFix.includes(THRESHOLD_A), hasB: afterFix.includes(THRESHOLD_B) });
  check('[fix] refreshed stored body no longer carries the stale marker',
    !afterFix.includes(STALE_MARKER), afterFix.includes(STALE_MARKER));
  check('[fix] curated frontmatter preserved (name/living), no source line added',
    afterFix.includes('name: Working Agreement v2') &&
      afterFix.includes('living: true') &&
      !/^source:/m.test(afterFix),
    afterFix.split('\n').slice(0, 6));

  // =========================================================================
  // 2. already-current body → NO rewrite, mtime unchanged.
  // =========================================================================
  console.log('\n=== 2. already-current body is a no-op (no churn) ===');
  const mtimeBefore = fs.statSync(WA2_FILE()).mtimeMs;
  const bytesBefore = fs.readFileSync(WA2_FILE(), 'utf8');
  await new Promise((res) => setTimeout(res, 15));
  const r2 = seedTemplates();
  const mtimeAfter = fs.statSync(WA2_FILE()).mtimeMs;
  check('current body is reported skipped, not refreshed', r2.skipped.includes(WA2_ID) && !r2.refreshed.includes(WA2_ID), r2);
  check('current body: mtime unchanged (no rewrite)', mtimeAfter === mtimeBefore, { mtimeBefore, mtimeAfter });
  check('current body: bytes unchanged', fs.readFileSync(WA2_FILE(), 'utf8') === bytesBefore, undefined);

  // =========================================================================
  // 3. user-DETACHED template is NOT rewritten.
  // =========================================================================
  console.log('\n=== 3. user-detached (source cleared) is left alone ===');
  const detachedBody = 'USER DETACHED — my own body, must survive re-seed untouched.';
  saveTemplate({
    id: GONOGO_ID,
    name: 'Pattern: Go/No-go (user-detached)',
    defaultMode: 'append',
    living: false,
    description: 'user override',
    body: detachedBody,
    overwrite: true,
    source: '', // deliberate detach
  });
  const r3 = seedTemplates();
  const detachedRead = readTemplate(GONOGO_ID);
  check('detached id reported skipped, NOT refreshed', r3.skipped.includes(GONOGO_ID) && !r3.refreshed.includes(GONOGO_ID), r3);
  check('detached body preserved verbatim (source stayed cleared)',
    (detachedRead?.body ?? '').trim() === detachedBody && !detachedRead?.source,
    { body: detachedRead?.body, source: detachedRead?.source });

  // =========================================================================
  // 4. RE-POINTED source is NOT rewritten.
  // =========================================================================
  console.log('\n=== 4. re-pointed at a different source is left alone ===');
  const otherSource = path.join(SRC_DIR, 'OTHER.md');
  fs.writeFileSync(otherSource, '# other source body\n');
  const otherRel = path.relative(ROOT, otherSource);
  const repointBody = 'REPOINTED body — points at a different in-repo source.';
  saveTemplate({
    id: 'pattern-index-table-router',
    name: 'Pattern: Index-table Router (repointed)',
    defaultMode: 'append',
    living: false,
    description: 'repointed',
    body: repointBody,
    overwrite: true,
    source: otherRel, // resolves inside root but != the seed's own source path
  });
  const r4 = seedTemplates();
  const repointRead = readTemplate('pattern-index-table-router');
  check('re-pointed id reported skipped, NOT refreshed',
    r4.skipped.includes('pattern-index-table-router') && !r4.refreshed.includes('pattern-index-table-router'), r4);
  check('re-pointed template still points at the other source (not the seed source)',
    repointRead?.source === otherRel, repointRead?.source);

  // =========================================================================
  // 5. UNREADABLE source on an EXISTING template degrades (no throw).
  //    Exercises the real `existing.sourceMissing` branch: the stored source
  //    resolves to EXACTLY the seed's own path, but that file is unreadable.
  //    Requires briefly removing a real repo source file — its bytes are saved
  //    and restored in `finally` even if the test throws.
  // =========================================================================
  console.log('\n=== 5. unreadable source on existing template degrades (no throw) ===');
  // Fresh-seed go-no-go pointing at its real source in a clean data dir corner:
  // re-seed it normally first so it is source-backed at its own path.
  saveTemplate({
    id: GONOGO_ID,
    name: 'Pattern: Go/No-go Pre-flight Gate',
    defaultMode: 'append',
    living: false,
    description: 'restored',
    body: 'placeholder stored body — pre-degrade.',
    overwrite: true,
    source: path.relative(ROOT, GONOGO_SRC),
  });
  const savedSrcBytes = fs.readFileSync(GONOGO_SRC);
  const beforeDegrade = fs.readFileSync(GONOGO_FILE(), 'utf8');
  let threw = false;
  let r5: { seeded: string[]; skipped: string[]; refreshed: string[] } | null = null;
  try {
    fs.rmSync(GONOGO_SRC); // make the seed's own source unreadable
    try {
      r5 = seedTemplates();
    } catch {
      threw = true;
    }
  } finally {
    fs.writeFileSync(GONOGO_SRC, savedSrcBytes); // guaranteed restore
  }
  check('unreadable source: seedTemplates did NOT throw', threw === false && r5 !== null, { threw });
  check('unreadable source: id degraded to skipped, NOT refreshed',
    !!r5 && r5.skipped.includes(GONOGO_ID) && !r5.refreshed.includes(GONOGO_ID), r5);
  check('unreadable source: stored file left unchanged (degrade to stored copy)',
    fs.readFileSync(GONOGO_FILE(), 'utf8') === beforeDegrade, undefined);

  // =========================================================================
  // 6. FRESH INSTALL still seeds normally.
  // =========================================================================
  console.log('\n=== 6. a fresh install still seeds ===');
  const FRESH = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'cs-feat096-fresh-'));
  const prev = process.env.CLAUDE_STATION_DATA;
  process.env.CLAUDE_STATION_DATA = FRESH;
  try {
    const rf = seedTemplates();
    check('fresh install seeds all six known ids',
      ['working-agreement', WA2_ID, GONOGO_ID, 'pattern-index-table-router',
        'pattern-manager-subagent-tree', 'pattern-raw-curated-memory-split'].every((id) => rf.seeded.includes(id)),
      rf);
    check('fresh install refreshes nothing and skips nothing',
      rf.refreshed.length === 0 && rf.skipped.length === 0, rf);
    const freshWa2 = fs.readFileSync(path.join(FRESH, 'templates', `${WA2_ID}.md`), 'utf8');
    check('fresh install WA-v2 stored body carries the threshold text',
      freshWa2.includes(THRESHOLD_A) && freshWa2.includes(THRESHOLD_B), undefined);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_STATION_DATA;
    else process.env.CLAUDE_STATION_DATA = prev;
    fs.rmSync(FRESH, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('FAILED CHECKS:\n' + failures.map((f) => `  - ${f}`).join('\n'));
  }
}

main()
  .catch((err) => {
    console.error(err);
    fail++;
  })
  .finally(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    fs.rmSync(SRC_DIR, { recursive: true, force: true });
    process.exit(fail === 0 ? 0 : 1);
  });
