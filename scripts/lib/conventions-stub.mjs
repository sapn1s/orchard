/**
 * The docs/CONVENTIONS.md scaffold text — owned in ONE place (ARCH-010).
 *
 * `scripts/onboard.mjs` WRITES this into every freshly-onboarded project, and
 * `localConventionsSection()` (src/server/templates.ts) COMPARES a project's
 * doc against it to decide whether the file is still an unedited stub (which
 * injects nothing — an empty opt-in must cost zero tokens, BUG-146). Both read
 * the same constant, so the "is this the stub?" test can never drift from the
 * text onboard actually emits: exact-match, not a length heuristic.
 *
 * If you change the scaffold, change it here; both readers follow automatically.
 */
export const CONVENTIONS_STUB = `# Project Conventions (local)

Project-specific rules for THIS project only. Anything universal — not
specific to this project — belongs in the shared Working Agreement instead
(see that doc's §L, and \`scripts/check-scope.mjs\` in claude-station, which
flags misfiled universal-sounding lines here and project-specific ones in the
shared doc).

This file is auto-injected alongside the shared Working Agreement for
sessions launched on this project (see \`localConventionsSection()\` in
claude-station's \`src/server/templates.ts\`). Empty/whitespace-only = treated
as absent, injects nothing.

<!-- Add this project's local rules below. Examples: repo-specific ports to
     never touch, a stack-specific test command, a directory layout quirk. -->
`;

/**
 * True when `body` is the scaffold onboard writes, unedited — normalised for
 * line-ending and surrounding-whitespace differences only. A project that has
 * added even one real rule differs and is NOT a stub.
 */
export function isUneditedConventionsStub(body) {
  if (typeof body !== 'string') return false;
  const norm = (s) => s.replace(/\r\n/g, '\n').trim();
  return norm(body) === norm(CONVENTIONS_STUB);
}
