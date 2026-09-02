/** Type declarations for session-provenance.mjs (consumed by the .ts server). */

export type StartedBy = 'user' | 'agent';

export interface ProvenanceRecord {
  sessionId: string;
  startedBy: StartedBy;
  source: string | null;
  at: string;
}

export const STARTED_BY_VALUES: Set<string>;

export function stationDataDir(): string;
export function provenanceDir(): string;
export function isSafeSessionId(sessionId: unknown): boolean;

export function recordSessionProvenance(
  sessionId: string,
  startedBy: StartedBy,
  extra?: { source?: string },
): boolean;

export function readSessionProvenance(sessionId: string): ProvenanceRecord | null;

export function loadProvenanceMap(): Map<string, ProvenanceRecord>;

export function looksAgentDispatched(firstUserMessage: unknown): boolean;

export function resolveStartedBy(opts: {
  sessionId?: string | null;
  firstUserMessage?: string | null;
  record?: ProvenanceRecord | null;
}): StartedBy;
