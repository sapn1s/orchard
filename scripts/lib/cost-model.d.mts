// FEAT-126 — hand-written types for the plain-ESM cost/dispatch model, matching
// the sidecar-.d.mts convention used for the other .mjs modules imported from TS
// (board-path.d.mts, ticket-schema.d.mts). Only the DISPATCH-DECLARATION surface
// is consumed from TypeScript today (agent-bridge.ts reads the charter's
// `Dispatch:` line for FEAT-126 lane attribution); the cost/usage internals stay
// JS-only and are intentionally not re-declared here. Extend this file if a .ts
// module starts importing more of cost-model.mjs.

/** The declared, validated Dispatch line. Fields are null when unstated/rejected. */
export interface DispatchDeclaration {
  present: boolean;
  tickets: string[] | null;
  phase: string | null;
  round: number | null;
  class: string | null;
  request: string | null;
  lines_seen: number;
  lines_in_fence: number;
  conflict: boolean;
  malformed: string[];
  unknown_keys: string[];
  rejected: string[];
}

export const DECLARED_PHASES: string[];
export const DISPATCH_CLASSES: string[];
export const DISPATCH_DECL_KEYS: string[];

export function parseDispatchDeclaration(text: string): DispatchDeclaration;
export function stripDispatchDeclarations(text: string): string;
export function formatDispatchDeclaration(fields?: {
  ticket?: string | string[];
  phase?: string;
  round?: number | null;
  class?: string;
  request?: string;
}): string | null;
