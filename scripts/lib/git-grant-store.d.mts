/**
 * Types for git-grant-store.mjs (FEAT-108 round 2), so src/server/** imports the
 * SAME host-memory grant store the runtime hook consults. Same sidecar-.d.mts
 * convention as git-write-policy.d.mts. Keep in step with the module's exports.
 */

export interface GitWriteGrantView {
  projectKey: string;
  /** 'permanent' (FEAT-164) is the declared project setting, read at call time. */
  scope: 'once' | 'duration' | 'permanent';
  /** Uses still claimable; null for a duration or permanent grant (not use-bounded). */
  remainingUses: number | null;
  /** FEAT-164 r3 — once-grant uses reserved by an in-flight claim (absent on permanent). */
  reserved?: number;
  /** null only for a permanent grant whose setting carries no timestamp. */
  grantedAt: string | null;
  grantedVia: string;
  note: string;
  /** null for a permanent grant — it does not expire. */
  expiresAt: string | null;
  expiresInMs: number | null;
}

/** FEAT-164 — the declared permanent grant, as the registry stores it
 * (`ProjectSettings.gitWrite`). Only `permanent === true` grants. */
export interface GitWritePermanentSetting {
  permanent: boolean;
  grantedAt?: string;
  grantedVia?: string;
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
  /** BUG-231 — the one grant decision this write was authorised under (shared by every record of one Bash call). */
  decision: string | null;
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
/** FEAT-164 r3/r4 — an opaque, frozen claim HANDLE. It authorises nothing by itself: useClaim asks the store. */
export interface GitWriteClaim {
  readonly scope: 'once' | 'duration' | 'permanent';
  readonly view: Readonly<GitWriteGrantView>;
}
/** Claude Code Bash tool hard cap on a single call (600000 ms). */
export declare const BASH_MAX_TIMEOUT_MS: number;
/** BUG-231 r6 — a claim left unsettled this long lapses; must exceed the Bash max call
 *  duration (BASH_MAX_TIMEOUT_MS) so a legitimate long call's commit is not denied. */
export declare const CLAIM_MAX_MS: number;
/** FEAT-164 r3 — THE one grant decision: resolves permanent-first in one read and
 * reserves a once-grant's use atomically. null = no grant (deny). */
export declare function claimGrant(projectKey: string, now?: number): GitWriteClaim | null;
/** FEAT-164 r4 — THE allow: true iff the store, at this instant, still stands behind the
 * claim (same revocation generation, not lapsed, same unexpired grant / permanent
 * incarnation). A reserved once-claim spends its use here, once. False ends the claim. */
export declare function useClaim(claim: GitWriteClaim, now?: number): boolean;
/** FEAT-164 r4 — end a claim (idempotent); a still-reserved use returns. */
export declare function endClaim(claim: GitWriteClaim | null | undefined): void;
/** BUG-231 r5 — per-call claim state, owned by the store and keyed by binding + tool_use_id. */
export type GitWriteCallStatus = 'unknown' | 'open' | 'withdrawn' | 'ended';
export declare const CALL_TOMBSTONE_MS: number;
export declare function callClaimState(binding: string, toolUseId: string, now?: number): GitWriteCallStatus;
export declare function openCallClaim(opts: { binding: string; toolUseId: string; agentKey?: string; projectKey: string; claim: GitWriteClaim; data?: Record<string, unknown> }, now?: number): boolean;
/** BUG-231 r7 — tombstone a call id DENIED with no claim opened (no grant / a pre-claim refusal); terminal for the id's life. */
export declare function denyCallClaim(opts: { binding: string; toolUseId: string; agentKey?: string; projectKey?: string | null; data?: Record<string, unknown> }, now?: number): boolean;
export declare function useCallClaim(binding: string, toolUseId: string, now?: number): boolean;
export declare function findCallFor(binding: string, projectKey: string, verb: string, now?: number): { toolUseId: string; status: 'open' | 'withdrawn'; data: Record<string, unknown> } | null;
export declare function endCallClaims(binding: string, pred?: (c: { toolUseId: string; agentKey: string }) => boolean, now?: number): void;
export declare function _callClaimsOf(binding: string): Array<{ toolUseId: string; status: string; agentKey: string; data: Record<string, unknown> }>;
export declare function _resetCallClaimsForTest(): void;
/** TEST/DIAGNOSTIC — writes the store has authorised (useClaim → true). */
export declare function _authorisationCount(): number;
/** FEAT-164 r3 — end a claim exactly once. 'commit' → true iff the write may proceed. Throws on a second settle. */
export declare function settleClaim(claim: GitWriteClaim, outcome: 'commit' | 'release', now?: number): boolean;
/** FEAT-164 r3 — true once settled (or not a claim). Never throws. */
export declare function claimSettled(claim: GitWriteClaim): boolean;
export declare function recordGitWrite(rec: {
  projectKey?: string | null; offender?: string | null; command?: string | null;
  sessionLabel?: string | null; grantScope?: string | null; gatePassed?: boolean | null;
  outcome?: GitWriteOutcome; decision?: string | null; now?: number;
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
/** FEAT-164 — register the reader of the declared permanent grant (the registry). */
export declare function setPermanentGrantSource(fn: ((projectKey: string) => GitWritePermanentSetting | null | undefined) | null): void;
/** FEAT-164 — the declared permanent grant as a grant view, or null. Never throws. */
export declare function permanentGrantOf(projectKey: string): GitWriteGrantView | null;
