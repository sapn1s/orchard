/** Type declarations for session-provenance.mjs (consumed by the .ts server). */

export type StartedBy = 'user' | 'agent';

/** FEAT-120 — a cross-provider continuation link (write-once, on the child). */
export interface ContinuedFromLink {
  sessionId: string;
  provider: 'openai' | 'anthropic';
}

export interface ProvenanceRecord {
  sessionId: string;
  startedBy: StartedBy;
  source: string | null;
  at: string;
  /** FEAT-120 — present when this session was continued from another engine. */
  continuedFrom?: ContinuedFromLink;
  /** FEAT-120 — how the seed was built for a continued session. */
  handoffMode?: 'replay-text' | 'summary';
}

export const STARTED_BY_VALUES: Set<string>;
export const INTERACTIVE_ENTRYPOINT: string;

export function isProgrammaticEntrypoint(entrypoint: unknown): boolean;

export function stationDataDir(): string;
export function provenanceDir(): string;
export function isSafeSessionId(sessionId: unknown): boolean;

export function isContinuedFromLink(link: unknown): boolean;

export function recordSessionProvenance(
  sessionId: string,
  startedBy: StartedBy,
  extra?: { source?: string; continuedFrom?: ContinuedFromLink; handoffMode?: 'replay-text' | 'summary' },
): boolean;

export function readSessionProvenance(sessionId: string): ProvenanceRecord | null;

export function loadProvenanceMap(): Map<string, ProvenanceRecord>;

export function looksAgentDispatched(firstUserMessage: unknown): boolean;

export function resolveStartedBy(opts: {
  sessionId?: string | null;
  firstUserMessage?: string | null;
  record?: ProvenanceRecord | null;
}): StartedBy;

export function foldsFromDefaultList(opts: {
  sessionId?: string | null;
  entrypoint?: string | null;
  firstUserMessage?: string | null;
  record?: ProvenanceRecord | null;
}): boolean;
