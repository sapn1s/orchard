/**
 * seed-sources.mjs — the ONE declaration of which repo docs `seedTemplates()`
 * reads at server boot (BUG-182).
 *
 * WHY THIS FILE EXISTS (ARCH-010, docs/CONVENTIONS.md). `seedTemplates()` in
 * `templates.ts` reads a set of doc paths and THROWS if any of them is missing,
 * which takes the whole server boot down. A second place used to hold that same
 * fact — `BOOT_STUBS` in `scripts/independent-verify.mjs`, the clean room's list
 * of files it must stub back after stripping `docs/prompts`. The two drifted:
 * `templates.ts` grew `WORKING_AGREEMENT.v3.md` and `.v4.md`, the clean room did
 * not, and every clean-room verification that needed a live server died on an
 * opaque `server never became healthy` — a false-proof failure, because the
 * round then quietly degraded to static evidence.
 *
 * So the fact is declared HERE, once, by the owner, and every reader READS it:
 *
 *   - `templates.ts` builds its seed sources from `seedSourceRelPath(id)` and
 *     has no path literal of its own left to drift — a seed whose id is not
 *     declared below throws by NAME at boot instead of at a random read;
 *   - `scripts/independent-verify.mjs` imports this module OUT OF THE CLEAN ROOM
 *     ITSELF (the exported copy under test, not the live repo) to decide what to
 *     stub, so a newly-added seed doc is picked up with zero edits to the clean
 *     room script.
 *
 * Plain ESM (with a sidecar `.d.mts`) rather than TypeScript, exactly like
 * `scripts/lib/board-path.mjs`, because a `scripts/*.mjs` reader has to import
 * it without a TypeScript toolchain.
 *
 * Paths are repo-relative and POSIX-separated — that is the interchange form.
 * Use `seedSourceRelPath()` / `seedSourceRelPaths()`; do not re-type a path.
 */

/**
 * Seed template id → the repo-relative doc it is seeded from.
 * ADDING A SEED? Add its path here. There is nowhere else to put it.
 */
export const SEED_SOURCE_PATHS = Object.freeze({
  'working-agreement': 'docs/prompts/WORKING_AGREEMENT.md',
  'working-agreement-v2': 'docs/prompts/WORKING_AGREEMENT.v2.md',
  'working-agreement-v3': 'docs/prompts/WORKING_AGREEMENT.v3.md',
  'working-agreement-v4': 'docs/prompts/WORKING_AGREEMENT.v4.md',
  'pattern-manager-subagent-tree': 'docs/prompts/patterns/MANAGER_SUBAGENT_TREE.md',
  'pattern-index-table-router': 'docs/prompts/patterns/INDEX_TABLE_ROUTER.md',
  'pattern-raw-curated-memory-split': 'docs/prompts/patterns/RAW_CURATED_MEMORY_SPLIT.md',
  'pattern-go-no-go-preflight': 'docs/prompts/patterns/GO_NO_GO_PREFLIGHT.md',
});

/**
 * The seed ids that predate FEAT-027's `source:` frontmatter line and therefore
 * adopt their declared path as a READ-TIME default (see DEFAULT_SEED_SOURCES in
 * templates.ts). Kept here beside the paths so the two cannot disagree either.
 */
export const READ_THROUGH_SEED_IDS = Object.freeze([
  'working-agreement',
  'working-agreement-v2',
  'working-agreement-v3',
  'working-agreement-v4',
]);

/**
 * The repo-relative path a seed id is read from. Throws BY NAME for an
 * undeclared id: a seed that forgot to declare its doc must fail loudly at the
 * owner, never as a missing file somewhere downstream.
 */
export function seedSourceRelPath(id) {
  const rel = Object.prototype.hasOwnProperty.call(SEED_SOURCE_PATHS, id) ? SEED_SOURCE_PATHS[id] : undefined;
  if (!rel) {
    throw new Error(
      `seed-sources: no doc path is declared for seed id ${JSON.stringify(id)}. ` +
      `Declare it in src/server/seed-sources.mjs (SEED_SOURCE_PATHS) — that is the only place ` +
      `this fact is written down, and both seedTemplates() and the clean room read it from there.`,
    );
  }
  return rel;
}

/**
 * Every repo-relative doc path a boot needs, de-duplicated, in declaration
 * order. This is what the clean room stubs.
 */
export function seedSourceRelPaths() {
  return [...new Set(Object.values(SEED_SOURCE_PATHS))];
}
