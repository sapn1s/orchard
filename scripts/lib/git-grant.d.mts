/**
 * Types for git-grant.mjs (FEAT-108 round 2). The grant-aware git-write decision
 * the runtime PreToolUse hook runs. Same sidecar-.d.mts convention.
 */
import type { GitWriteGrantView, GitWriteRecord } from './git-grant-store.d.mts';

export declare const PUBLISHING_SUBCOMMANDS: Set<string>;

export interface GitWriteEvaluation {
  allow: boolean;
  offender?: string;
  reason?: string;
  granted?: boolean;
  gateFailed?: boolean;
  grant?: GitWriteGrantView;
  record?: GitWriteRecord;
}

export declare function evaluateGitWrite(opts: {
  command: string;
  projectKey?: string | null;
  env?: Record<string, string | undefined>;
  now?: number;
  runLeakGate?: (() => { ok: boolean; detail?: string }) | null;
  sessionLabel?: string | null;
}): GitWriteEvaluation;
