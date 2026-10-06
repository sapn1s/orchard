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
/** git ALLOW-known-good set (BUG-226 round 4). Default-deny; readers/dumpers are absent. */
export declare const GIT_ALLOWED_SUBCOMMANDS: string[];

export declare function bashSegmentHead(segment: string): string;

/** Resolve the real git subcommand past leading global options (`-c k=v`, `-C <dir>`, …). */
export declare function resolveGitSubcommand(words: string[]): string;

/** curl localhost-only guard on the raw (quotes-intact) command. Offender string or null. */
export declare function curlRawViolation(raw: string): string | null;

/**
 * The "Still available here" help text, generated from ENFORCE_ALLOWED_TOOLS and
 * ENFORCE_ALLOWED_BASH so it cannot drift from what `decide()` permits (BUG-226).
 * One line per array element.
 */
export declare function stillAvailableHere(): string[];

/**
 * The Bash command heads worth advertising, derived by asking `decideBashCommand`
 * itself so an allowlisted-but-always-refused head (npx) is never named (BUG-226).
 */
export declare function allowedBashHeads(): string[];

/** Advertised heads that carry an argument rule (allowed only in read-free forms). */
export declare function restrictedBashHeads(): string[];

export declare function decideBashCommand(command: string): {
  allow: boolean;
  offender: string | null;
};

export interface OrchBypass {
  /** Non-trivial reason (>= 15 chars) the model supplied on the marker's first line. */
  reason: string;
  /** The full Bash command the marker admitted, for the audit ledger (hook truncates). */
  command: string;
}

export interface ProfileDecision {
  allow: boolean;
  /** Non-null exactly when `allow` is false; the text the model (and so the user) sees. */
  reason: string | null;
  /**
   * Which side of the discriminator this call came from. `'subagent'` is always
   * allowed — the restriction is on the orchestrating session only.
   */
  scope: 'subagent' | 'orchestrator';
  /**
   * FEAT-152 — present ONLY when a valid `# ORCH-BYPASS:` marker allowed an
   * otherwise-refused Bash command. The enforcing hook logs it and counts it;
   * `decide()` itself stays pure and performs no I/O.
   */
  bypass?: OrchBypass;
}

export type OrchBypassDetection =
  | { present: false }
  | { present: true; valid: false; reason: string; problem: string }
  | { present: true; valid: true; reason: string };

/** PURE first-line marker check. See orchestrator-profile.mjs. */
export declare function detectOrchBypass(command: string): OrchBypassDetection;

export declare function decide(call: {
  toolName: string;
  toolInput?: unknown;
  /** `agent_id` from the PreToolUse payload; PRESENT means a dispatched subagent. */
  agentId?: string | null;
}): ProfileDecision;
