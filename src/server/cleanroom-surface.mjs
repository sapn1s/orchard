/**
 * cleanroom-surface.mjs — the ONE declaration of which of THIS project's paths
 * are methodology/board PROSE that an independent clean-room verifier must never
 * read (BUG-120), read by BOTH the room strip and the verifier's diff (BUG-186).
 *
 * WHY THIS FILE EXISTS (ARCH-010, docs/CONVENTIONS.md). The clean room used to
 * strip a hand-maintained DENY-LIST (`CONTAMINATION` in
 * `scripts/independent-verify.mjs`) that named `docs/prompts` and `docs/bugs`
 * but not `docs/CONVENTIONS.md`, `docs/ARCHITECTURE-REVIEW.md` or `docs/analysis/`
 * — so those reached every verifier, and the diff handed to the verifier
 * (`git diff` with no pathspec) leaked the ticket's own reasoning on top. A
 * deny-list is wrong here by construction: it must be edited whenever the
 * project grows a new document, and NOTHING fails when it is not (that is how
 * the three above entered). ARCH-010's third success criterion settles it — a
 * list that names what to leave OUT is replaced by naming what to let IN.
 *
 * THE INVERSION. The prose surface is declared as a ROOT (`docs`), not a
 * per-file list, so every document under it is covered FOREVER with no edit
 * here. The clean room strips everything under these roots and re-includes only
 * what a check explicitly declares (`--allow-input`); the verifier's diff
 * excludes exactly the same set. One fact, one owner, two readers.
 *
 * This declares only the PROJECT'S OWN prose. The universal
 * ambient-instruction surface the agent CLIs auto-discover (CLAUDE.md,
 * AGENTS.md, .claude, …) is a property of the CLIs, not of any project, and is
 * owned tool-side in `scripts/independent-verify.mjs` (AMBIENT_INSTRUCTION_PATHS)
 * so it applies even to a foreign repo that has no file like this one.
 *
 * Plain ESM (with a sidecar `.d.mts`), exactly like `seed-sources.mjs` and
 * `scripts/lib/board-path.mjs`, because a `scripts/*.mjs` reader has to import
 * it without a TypeScript toolchain. Paths are repo-relative, POSIX-separated —
 * that is the interchange form. The clean room reads this OUT OF ITS OWN
 * EXPORTED COPY (the revision under test), so a repo that reorganises its docs
 * is self-describing with zero edits to the verify script.
 */

/**
 * The repo-relative roots under which this project keeps prose a clean-room
 * verifier must not read: methodology, board, architecture notes, conventions,
 * in-flight analysis, the guide. `docs/` is the single home for all of it, so
 * naming the root — not the individual docs — is what makes "adding a new
 * document requires no change to the isolation rule" (BUG-120 criterion 2) true.
 */
export const PROSE_ROOTS = Object.freeze(['docs']);

/**
 * The prose roots, de-duplicated. Use this rather than re-typing `['docs']`;
 * a reader that reconstructs the list is the second place able to hold a
 * different answer (ARCH-010).
 */
export function cleanroomProseRoots() {
  return [...new Set(PROSE_ROOTS)];
}
