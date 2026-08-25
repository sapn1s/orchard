/**
 * Types for orchestrator-profile.mjs, so `src/server/**` imports the SAME
 * module the .mjs hook and report do rather than re-declaring the policy.
 * Same pattern as ticket-schema.d.mts and neighbor-project.d.mts, and the same
 * reason: ARCH-008 is on this board because one grammar was implemented twice
 * and the two readers disagreed. A tool policy implemented twice would let a
 * call be refused by the enforcer and counted as allowed by the report.
 *
 * Keep in step with orchestrator-profile.mjs's exports; `npm run typecheck`
 * catches a consumer that drifts, and
 * scripts/verify-orchestrator-enforcement.mjs asserts that every name declared
 * here exists at runtime.
 */

/* ── Log-only half (FEAT-096 phase 1) ─────────────────────────────────────── */

export declare const ALLOWED: string[];
export declare const KNOWN_DENIED: string[];
export declare const MCP_PREFIX: string;

export declare function isAllowed(toolName: string): boolean;

export type ProfileClass = 'allowed' | 'denied-mcp' | 'denied-known' | 'denied-unknown';
export declare function classify(toolName: string): ProfileClass;

export interface BriefSignals {
  chars: number;
  approxTokens: number;
  analysisPhrases: number;
  analysisPhraseList: string[];
  citations: number;
  taskPhrases: number;
  scanTruncated: boolean;
}
export declare function briefSignals(text: string): BriefSignals;

export declare function isDispatchViaShell(command: string): boolean;

/* ── Enforcement half (FEAT-096 phase 2) ──────────────────────────────────── */

export declare const ENFORCE_ALLOWED_TOOLS: string[];
export declare const ENFORCE_ALLOWED_BASH: string[];
export declare const ENFORCE_DENIED_GIT_SUBCOMMANDS: string[];

export declare function bashSegmentHead(segment: string): string;

export declare function decideBashCommand(command: string): {
  allow: boolean;
  offender: string | null;
};

export interface ProfileDecision {
  allow: boolean;
  /** Non-null exactly when `allow` is false; the text the model (and so the user) sees. */
  reason: string | null;
  /**
   * Which side of the discriminator this call came from. `'subagent'` is always
   * allowed — the restriction is on the orchestrating session only.
   */
  scope: 'subagent' | 'orchestrator';
}

export declare function decide(call: {
  toolName: string;
  toolInput?: unknown;
  /** `agent_id` from the PreToolUse payload; PRESENT means a dispatched subagent. */
  agentId?: string | null;
}): ProfileDecision;
