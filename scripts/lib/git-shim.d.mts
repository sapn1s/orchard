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

/** A shim decision. `consultHost` (BUG-173) marks a local deny a host grant COULD lift. */
export interface GitShimDecision {
  allow: boolean;
  reason?: string;
  sanctioned?: boolean;
  consultHost?: boolean;
  granted?: boolean;
}

/**
 * The shim's LOCAL classification for one git invocation (argv WITHOUT the `git`
 * head). Synchronous and network-free: a classified write denies locally with
 * `consultHost: true` — the async `resolveGitShim` then asks the host authority.
 */
export declare function decideGitShim(
  argv: string[],
  env?: Record<string, string | undefined>,
  opts?: { ignoreEnvHatch?: boolean },
): GitShimDecision;

/** Bounded timeout (ms) on the host grant consult — the shim must never hang. */
export declare const HOST_GRANT_TIMEOUT_MS: number;

/**
 * Ask the HOST grant authority (BUG-173) whether a runtime grant permits this
 * classified write, at CALL TIME over loopback. FAILS CLOSED on any failure.
 */
export declare function askHostGrant(
  argv: string[],
  env?: Record<string, string | undefined>,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number; hostUrl?: string; grantKey?: string; shimAuth?: string },
): Promise<GitShimDecision>;

/**
 * The shim's full CALL-TIME decision: local classification, then — only for a
 * classified write — the host grant consult (BUG-173). Fails closed.
 */
export declare function resolveGitShim(
  argv: string[],
  env?: Record<string, string | undefined>,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number; hostUrl?: string; grantKey?: string; shimAuth?: string; ignoreEnvHatch?: boolean },
): Promise<GitShimDecision>;

/** The loud refusal a shimmed subprocess prints before exiting non-zero. */
export declare function gitShimRefusal(offender: string): string;

/** Called BY the generated shim executable: decide, then exec real git or deny. */
export declare function runGitShim(argv: string[], opts?: { realGit?: string; hostUrl?: string; grantKey?: string; shimAuth?: string }): Promise<void>;

/**
 * Install the shim onto a COPY of `env` and return the new env. Pure: it does
 * not mutate process.env or the host PATH — the caller uses the returned env for
 * the subprocess it launches, scoping the shim to that session. `grantKey` +
 * `hostUrl` (BUG-173) let the shim consult the host grant authority at call time;
 * without them a classified write fails closed with no network call.
 */
export declare function installGitShim(
  env?: Record<string, string | undefined>,
  opts?: { baseDir?: string; grantKey?: string; hostUrl?: string; sessionLabel?: string; shimAuth?: string },
): { env: Record<string, string>; shimDir: string; realGit: string };
