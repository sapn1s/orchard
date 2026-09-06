/**
 * Types for fable-tier-policy.mjs (FEAT-124), so `src/server/**` imports the SAME
 * module the runtime hook uses rather than re-declaring the policy. Same
 * sidecar-.d.mts convention as git-write-policy.d.mts and orchestrator-profile.d.mts.
 *
 * Keep in step with fable-tier-policy.mjs's exports; `npm run typecheck` catches a
 * consumer that drifts, and scripts/verify-feat-124-fable-gate.mjs asserts every
 * name declared here behaves at runtime.
 */

/** Gate ON by default; open the hatch with ORCHARD_ALLOW_FABLE=1/true/yes/on. */
export declare function fableTierGateEnabled(env?: Record<string, string | undefined>): boolean;

/** True for the Fable premium tier: the `fable` alias and every `claude-fable-*` id. */
export declare function isFableModel(model: unknown): boolean;

/** The trimmed reason from a `fable-justified: <reason>` line in the prompt, else null. */
export declare function fableJustification(prompt: unknown): string | null;

/** The sanctioned ceiling an unjustified Fable dispatch is rerouted to. */
export declare const FALLBACK_MODEL: string;

/** The decision for one tool call. See fable-tier-policy.mjs for the action semantics. */
export declare function decideFableTier(
  call?: { toolName?: string; toolInput?: unknown },
  env?: Record<string, string | undefined>,
): {
  action: 'ignore' | 'allow' | 'reroute';
  requested?: string | null;
  label?: string | null;
  justification?: string | null;
  hatch?: boolean;
  fallbackModel?: string;
  updatedInput?: Record<string, unknown>;
};
