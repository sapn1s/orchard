/**
 * Types for git-shim.mjs (FEAT-135), so `src/server/**` imports the SAME module
 * the runtime activates rather than re-declaring the shim. Same sidecar-.d.mts
 * convention as git-write-policy.d.mts / git-grant.d.mts.
 *
 * Keep in step with git-shim.mjs's exports; `npm run typecheck` catches a
 * consumer that drifts, and scripts/verify-feat-135-git-shim.mjs asserts the
 * runtime behaviour behind these names.
 */

/** Plumbing verbs the sanctioned temp-index snapshot (FEAT-134) uses. */
export declare const SANCTIONED_PLUMBING: Set<string>;

/** The shim's decision for one git invocation (argv WITHOUT the `git` head). */
export declare function decideGitShim(
  argv: string[],
  env?: Record<string, string | undefined>,
): { allow: boolean; reason?: string; sanctioned: boolean };

/** The loud refusal a shimmed subprocess prints before exiting non-zero. */
export declare function gitShimRefusal(offender: string): string;

/** Called BY the generated shim executable: decide, then exec real git or deny. */
export declare function runGitShim(argv: string[], opts?: { realGit?: string }): void;

/**
 * Install the shim onto a COPY of `env` and return the new env. Pure: it does
 * not mutate process.env or the host PATH — the caller uses the returned env for
 * the subprocess it launches, scoping the shim to that session.
 */
export declare function installGitShim(
  env?: Record<string, string | undefined>,
  opts?: { baseDir?: string },
): { env: Record<string, string>; shimDir: string; realGit: string };
