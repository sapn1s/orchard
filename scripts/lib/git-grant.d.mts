/**
 * Types for git-grant.mjs (FEAT-108 round 2). The grant-aware git-write decision
 * the runtime PreToolUse hook runs. Same sidecar-.d.mts convention.
 */
import type { GitWriteGrantView, RecordedGitWrite } from './git-grant-store.d.mts';

export declare const PUBLISHING_SUBCOMMANDS: Set<string>;

export interface GitWriteEvaluation {
  allow: boolean;
  offender?: string;
  reason?: string;
  granted?: boolean;
  gateFailed?: boolean;
  grant?: GitWriteGrantView;
  /** Carries the single-use confirm token (BUG-184 r3) for the decide response. */
  record?: RecordedGitWrite | { id: string; confirmToken: string };
  /** BUG-231 — the one grant decision this write is authorised under. */
  decision?: string;
  /** BUG-231 — the hook only reserved: the shim gates and spends at the write. */
  deferred?: boolean;
  /** BUG-231 — the shim redeemed a hook window instead of deciding again. */
  redeemed?: boolean;
}

/** BUG-231 — binds the hook's decision to ONE Bash tool call of one session. */
export interface GitWriteToolCallWindow {
  /** Per-session random key, baked into the session's shim. */
  binding: string;
  /** The CLI's tool_use_id for this Bash call. */
  toolUseId: string;
  /** agent_id of the calling (sub)agent, or 'main'. */
  agentKey?: string;
  /** True only when the session's shim is on the CLI's PATH (a direct session). */
  shimReachesCli?: boolean;
}

/**
 * ONE grant authority for BOTH enforcement layers (BUG-173): pass EITHER
 *   - `command` — a Bash command STRING (the FEAT-108 PreToolUse hook), OR
 *   - `argv`    — already-isolated git args WITHOUT the `git` head (the FEAT-135
 *                 PATH shim, via /api/git-shim/decide).
 * Whichever shape, the same claim (FEAT-164 r4: claimGrant → useClaim, the store asked at the write) / leak-gate tail runs.
 */
export declare function evaluateGitWrite(opts: {
  command?: string;
  argv?: string[];
  projectKey?: string | null;
  env?: Record<string, string | undefined>;
  now?: number;
  runLeakGate?: (() => { ok: boolean; detail?: string }) | null;
  sessionLabel?: string | null;
  /** BUG-231 — the hook passes its tool call; the decision becomes that call's window. */
  window?: GitWriteToolCallWindow | null;
  /** BUG-231 — the repo content the gate scanned ({head, path:blob entries}); lets the shim skip an unchanged re-gate. */
  repoFingerprint?: (() => { head: string; entries: string[]; gateKey?: string | null } | null) | null;
}): GitWriteEvaluation;

/** BUG-231 — the shim's decision for one invocation: redeem the session's live window, else decide independently. */
export declare function redeemGitWrite(opts: {
  binding?: string | null;
  argv: string[];
  projectKey?: string | null;
  env?: Record<string, string | undefined>;
  now?: number;
  runLeakGate?: (() => { ok: boolean; detail?: string }) | null;
  sessionLabel?: string | null;
  repoFingerprint?: (() => { head: string; entries: string[]; gateKey?: string | null } | null) | null;
}): GitWriteEvaluation;

/** BUG-231 — at every PreToolUse: ends the calling agent's earlier windows (supersession). */
export declare function beginGitWriteToolCall(opts: { binding: string; toolUseId?: string | null; agentKey?: string; now?: number }): void;
/** BUG-231 — end one tool call's window (Post / failure / permission deny / a deny). */
export declare function endGitWriteToolCall(binding: string, toolUseId: string, now?: number): void;
/** BUG-231 — end every window of a session (turn end, session close). */
export declare function endGitWriteToolCalls(binding: string, now?: number): void;
/** BUG-231 — end every window one (sub)agent left open (SubagentStop). */
export declare function endGitWriteAgent(binding: string, agentKey: string, now?: number): void;
export declare function _resetGitWriteWindowsForTest(): void;
export declare function _gitWriteWindowsOf(binding: string): Array<{ toolUseId: string; decision: string; state: string; slots: string[]; agentKey: string }>;
