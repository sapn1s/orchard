/**
 * Types for git-grant-store.mjs (FEAT-108 round 2), so src/server/** imports the
 * SAME host-memory grant store the runtime hook consults. Same sidecar-.d.mts
 * convention as git-write-policy.d.mts. Keep in step with the module's exports.
 */

export interface GitWriteGrantView {
  projectKey: string;
  scope: 'once' | 'duration';
  /** null for a duration grant (time-bounded, not use-bounded). */
  remainingUses: number | null;
  grantedAt: string;
  grantedVia: string;
  note: string;
  expiresAt: string;
  expiresInMs: number;
}

export interface GitWriteRecord {
  at: string;
  projectKey: string | null;
  sessionLabel: string | null;
  offender: string | null;
  command: string | null;
  grantScope: string | null;
  gatePassed: boolean | null;
}

export declare const MAX_GRANT_MS: number;
export declare const DEFAULT_GRANT_MS: number;

export declare function grantGitWrite(
  projectKey: string,
  opts?: { scope?: 'once' | 'duration'; ttlMs?: number; grantedVia?: string; note?: string; now?: number },
): GitWriteGrantView;

export declare function revokeGitWrite(projectKey: string): boolean;
export declare function peekGrant(projectKey: string, now?: number): GitWriteGrantView | null;
export declare function consumeGrant(projectKey: string, now?: number): void;
export declare function recordGitWrite(rec: {
  projectKey?: string | null; offender?: string | null; command?: string | null;
  sessionLabel?: string | null; grantScope?: string | null; gatePassed?: boolean | null; now?: number;
}): GitWriteRecord;
export declare function listGitWrites(projectKey?: string | null, limit?: number): GitWriteRecord[];
export declare function grantView(projectKey: string, now?: number): GitWriteGrantView | null;
export declare function setGitWriteAuditSink(fn: ((rec: GitWriteRecord) => void) | null): void;
export declare function _resetGitGrantsForTest(): void;
