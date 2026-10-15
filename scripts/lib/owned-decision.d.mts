// BUG-259 — types for owned-decision.mjs (an agent's own decision, and the user's reopen of it).
export const OWN_BASES: readonly string[];
export const OWN_BASES_NEEDING_REF: readonly string[];
export const OWN_BASES_NEEDING_CHOICE: readonly string[];
export const WITHDRAW_BASIS: string;
export const READS_AS_USER_RE: RegExp;

type Rec = Record<string, unknown>;

export function ownRefusal(
  record: Rec,
  opts: { chose?: string | null; basis: string; ref?: string | null; why: string; author: string },
  ctx?: { refExists?: (ref: string) => boolean },
): { code: string; message: string } | null;

export function ownRecord(record: Rec, opts: {
  chose?: string | null; basis: string; ref?: string | null; why: string; author: string;
  next?: string | null; handoff?: string | null; today: string; askedOn?: string | null;
}): { record: Rec; entry: Rec };

export function withdrawRefusal(
  record: Rec,
  opts: { reason: string; decided: string; author: string },
): { code: string; message: string } | null;

export function withdrawRecord(record: Rec, opts: {
  reason: string; decided: string; author: string; today: string; askedOn?: string | null;
}): { record: Rec; entry: Rec };

export function ownedEntry(record: Rec, historyId?: string | null): { entry: Rec; index: number } | null;

export function reopenRecord(record: Rec, historyId: string, opts?: { today: string; newId?: string }): {
  record?: Rec; decisionId?: string; already?: boolean;
  refusal?: { code: string; status: number; message: string };
};

export interface AgentDecision {
  decision_id: string | null; question: string | null; chosen: string | null; on: string | null;
  by: string; basis: string; why: string; next: string | null; handoff: string | null; decided: string | null; reopened: boolean;
}
export function agentDecisionsOf(record: Rec): AgentDecision[];
