/**
 * Types for file-lock.mjs (FEAT-129), so `src/server/**` imports the SAME module
 * the runtime hook uses rather than re-declaring the policy. Same sidecar-.d.mts
 * convention as git-write-policy.d.mts / fable-tier-policy.d.mts.
 *
 * Keep in step with file-lock.mjs's exports; `npm run typecheck` catches a
 * consumer that drifts, and scripts/verify-feat-129-file-lock.mjs asserts every
 * name declared here behaves at runtime.
 */

/** Lock ON by default; open the hatch with ORCHARD_ALLOW_FILE_CLOBBER=1/true/yes/on. */
export declare function fileLockEnabled(env?: Record<string, string | undefined>): boolean;

/** The stale bound (ms): a lock untouched this long is reclaimable even if the owner cannot be probed. */
export declare const FILE_LOCK_TTL_MS: number;

/** The ONE pid-liveness check (same shape as liveness.ts): pid <= 1 refused, never probed. */
export declare function pidAlive(pid: unknown): boolean;

/** Why an existing lock is reclaimable by a different owner (dead owner / stale TTL), or null if it stands. */
export declare function reclaimReason(
  lock: unknown,
  now: number,
  ttlMs?: number,
): string | null;

export interface MutationClass {
  mutates: boolean;
  /** Raw target paths (as written) for a path-scoped mutation. */
  paths?: string[];
  /** True for a whole-working-tree mutation (git reset --hard, stash, branch switch). */
  tree?: boolean;
  /** A short label for the mutation (`write`, `edit`, `git checkout`, …). */
  kind?: string;
}

/** Classify a tool call into the path(s)/tree it mutates. Pure (no fs). */
export declare function classifyMutation(call?: { toolName?: string; toolInput?: unknown }): MutationClass;

/** Scan a Bash command string for whole-file / git-tree mutations and their targets. Pure. */
export declare function scanBashMutation(command: string, depth?: number): MutationClass;

/** Normalise a raw target to its lock KEY (repo-relative when under the repo, else absolute). */
export declare function lockKeyFor(rawPath: string, repoRoot?: string | null): string;

export interface LockHolder {
  owner: string;
  ownerPid?: number | null;
  host?: string;
  key?: string;
  acquiredAt?: number;
  refreshedAt?: number;
  kind?: string | null;
}

export interface FileLockResult {
  allow: boolean;
  busy?: boolean;
  holder?: LockHolder | null;
  reason?: string;
  kind?: string;
  tree?: boolean;
  mode?: 'acquired' | 'refresh' | 'reclaimed';
}

/** THE decision the PreToolUse hook runs: classify the call, then claim its target(s). */
export declare function evaluateFileLock(input: {
  toolName?: string;
  toolInput?: unknown;
  lockDir?: string | null;
  repoRoot?: string | null;
  owner?: string | null;
  ownerPid?: number;
  now?: number;
  ttlMs?: number;
  env?: Record<string, string | undefined>;
}): FileLockResult;

/** How often to heartbeat-refresh held locks (ms), comfortably below the TTL. */
export declare function heartbeatIntervalMs(ttlMs?: number): number;

/**
 * The heartbeat: re-stamp (or release) the locks THIS process owns, gated on a
 * per-owner liveness check wired to the bridge's running-set. Called on a timer,
 * INDEPENDENT of tool calls, so a lane in one long tool call never goes stale.
 */
export declare function refreshOwnedLocks(input: {
  lockDir?: string | null;
  ownerPid?: number;
  host?: string;
  /** false ⇒ the lane is provably gone (release its lock); anything else ⇒ live (refresh). */
  isOwnerLive?: (owner: string) => boolean;
  now?: number;
}): { refreshed: number; released: number; skipped: number };

/** The fail-loud "file busy" message shown to the agent. */
export declare function busyRefusal(
  kind: string | undefined,
  holder: LockHolder | null,
  opts?: { tree?: boolean; exhausted?: boolean; error?: string | null },
): string;
