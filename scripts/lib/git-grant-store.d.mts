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

/** BUG-184 — a ledger record's execution lifecycle (see git-grant-store.mjs). */
export type GitWriteOutcome = 'permitted' | 'executed' | 'failed' | 'blocked-gate';

export interface GitWriteRecord {
  /** Stable id so the executor can CONFIRM this record's real outcome (BUG-184). */
  id: string;
  at: string;
  projectKey: string | null;
  sessionLabel: string | null;
  offender: string | null;
  command: string | null;
  grantScope: string | null;
  gatePassed: boolean | null;
  /** What actually happened, owned by the executor (BUG-184). */
  outcome: GitWriteOutcome;
  /** The git exit status the executor observed, or null until confirmed. */
  exitStatus: number | null;
  /** When the executor confirmed, or null while still 'permitted'. */
  executedAt: string | null;
  /** BUG-184 round 3 — count of REJECTED confirm attempts (wrong token / foreign
   * owner / replay). Non-zero flags attempted tampering; surfaced to readers. */
  confirmAnomalies: number;
}

/** BUG-184 round 3 — a freshly recorded write plus the single-use capability token
 * the executor must present to confirm it. The token is NEVER on the stored record
 * (so it never appears in listGitWrites) — only recordGitWrite's return carries it. */
export type RecordedGitWrite = GitWriteRecord & { confirmToken: string };

/** BUG-184 round 3 — the result of a confirm attempt. `ok:false` never changed the
 * recorded outcome; `reason` classifies the rejection. */
export interface GitWriteConfirmResult {
  ok: boolean;
  reason: string | null;
  record: GitWriteRecord | null;
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
  sessionLabel?: string | null; grantScope?: string | null; gatePassed?: boolean | null;
  outcome?: GitWriteOutcome; now?: number;
}): RecordedGitWrite;
/** BUG-184 — the executor reports the observed git exit; moves a 'permitted' record
 * to 'executed' (status 0) / 'failed'. Round 3: requires the single-use capability
 * `token` + owner `projectKey`; a wrong/absent capability, foreign owner, unknown
 * id, or replay is rejected and recorded as an anomaly (outcome never changed). */
export declare function confirmGitWrite(
  id: string,
  opts?: { token?: string | null; projectKey?: string | null; exitStatus?: number | null; now?: number },
): GitWriteConfirmResult;
export declare function listGitWrites(projectKey?: string | null, limit?: number): GitWriteRecord[];
export declare function grantView(projectKey: string, now?: number): GitWriteGrantView | null;
export declare function setGitWriteAuditSink(fn: ((rec: GitWriteRecord) => void) | null): void;
export declare function _resetGitGrantsForTest(): void;
