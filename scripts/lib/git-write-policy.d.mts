/**
 * Types for git-write-policy.mjs (FEAT-108), so `src/server/**` imports the SAME
 * module the runtime hook uses rather than re-declaring the policy. Same
 * sidecar-.d.mts convention as orchestrator-profile.d.mts and board-path.d.mts.
 *
 * Keep in step with git-write-policy.mjs's exports; `npm run typecheck` catches
 * a consumer that drifts, and scripts/verify-feat-108-git-write-block.mjs
 * asserts every name declared here exists at runtime.
 */

export declare const GIT_READONLY: Set<string>;
export declare const GIT_DUAL_READ: Record<string, (args: string[]) => boolean>;

/** Block ON by default; open the hatch with ORCHARD_ALLOW_GIT_WRITE=1/true/yes/on. */
export declare function gitWriteBlockEnabled(env?: Record<string, string | undefined>): boolean;

/** The offending `git <sub>` reachable in a Bash command, or null if none. */
export declare function scanForGitWrite(command: string, depth?: number): string | null;

/** The decision for one Bash command. `offender` is non-null exactly when denied. */
export declare function decideGitWrite(
  command: string,
  env?: Record<string, string | undefined>,
): { allow: boolean; offender: string | null };

/** The refusal text: names the offender and tells the agent to leave work unstaged. */
export declare function gitWriteRefusal(offender: string): string;

/** FEAT-108 round 2 — refusal when a GRANTED commit/push fails the mandatory leak gate. */
export declare function gitWriteGateFailedRefusal(offender: string, gateDetail?: string): string;
