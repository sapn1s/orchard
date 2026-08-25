/**
 * Types for ticket-schema.mjs, so src/server/*.ts imports the SAME module the
 * .mjs tools do rather than re-declaring the format. Same pattern as
 * neighbor-project.d.mts.
 *
 * Keep in step with ticket-schema.mjs's exports; `npm run typecheck` catches a
 * consumer that drifts, and scripts/verify-ticket-schema.mjs asserts that every
 * name declared here actually exists at runtime.
 */

export type TicketType = 'bug' | 'feature' | 'architecture' | 'deploy';
export type WorkState = 'open' | 'in_progress' | 'in_verification' | 'verified' | 'done' | 'blocked' | 'not_a_bug';
export type HumanAction = 'none' | 'decide' | 'answer_question' | 'review' | 'staged_decision' | 'multi_select_decision';
export type VerificationState = 'not_required' | 'not_recorded' | 'pending' | 'holds' | 'broken';
export type Severity = 'low' | 'medium' | 'high' | 'not_recorded';
export type Owner = 'you' | 'agent' | 'unassigned';
export type DecisionMode = 'single' | 'multi' | 'staged';
export type Verdict = 'holds' | 'broken' | 'invalid';
export type Relation = 'supersedes' | 'superseded_by' | 'depends_on' | 'blocks' | 'duplicate_of' | 'recurrence_of' | 'see_also';

export const TICKET_TYPES: readonly TicketType[];
export const WORK_STATES: readonly WorkState[];
export const HUMAN_ACTIONS: readonly HumanAction[];
export const VERIFICATION_STATES: readonly VerificationState[];
export const SEVERITIES: readonly Severity[];
export const OWNERS: readonly Owner[];
export const DECISION_MODES: readonly DecisionMode[];
export const VERDICTS: readonly Verdict[];
export const VERIFICATION_CLASSES: readonly string[];
export const RELATIONS: readonly Relation[];
export const BODY_SLOTS: readonly string[];
/** Which deep-layer H2 slots a body actually contains — derived, never asserted. */
export function deriveBodySlots(body: string | null | undefined): Record<string, boolean>;
export const DONE_WORK_STATES: readonly WorkState[];
export const RELATION_INVERSE: Readonly<Record<Relation, Relation>>;
/** The legacy `- **Status:**` word a record's `work_state` is stated as (BUG-122). */
export const WORK_STATE_STATUS_WORD: Readonly<Record<WorkState, string>>;
export const REQUIRED_KEYS: readonly string[];
/** Keys this schema USED to have: tolerated on a record already on disk, never required, never read, never written back (ARCH-009). */
export const RETIRED_KEYS: Readonly<Record<string, string>>;
export const WORD_CAPS: Readonly<Record<string, number>>;
export const LEGACY_STATUS_TABLE: ReadonlyArray<{ re: RegExp; workState: WorkState; verificationState: VerificationState; label: string }>;

export const TICKET_FILE_RE: RegExp;
export const TICKET_ID_RE: RegExp;
export const STRICT_TICKET_ID_RE: RegExp;
export const TICKET_ID_IN_TEXT_RE: RegExp;
export const EM_DASH: string;

export function typeFromId(id: string): TicketType | null;
export function idFromFilename(file: string): string | null;
export function isDoneWorkState(workState: string | null): boolean;

export interface LegacyStatusClassification {
  raw: string;
  token: string | null;
  workState: WorkState | null;
  verificationState: VerificationState | null;
  done: boolean;
  matched: boolean;
  ambiguous: boolean;
  reason: string | null;
}
export function classifyLegacyStatus(raw: string | null | undefined): LegacyStatusClassification;
export function isDoneStatus(raw: string | null | undefined): boolean;
export function statusIssue(
  file: string | null,
  statusLinePresent: boolean,
  cls: LegacyStatusClassification,
): string | null;

export function headerRegion(text: string): string;
/** Every `- **Status:**` value declared in the ticket HEADER, in file order. */
export function statusDeclarations(text: string): string[];
/**
 * Header lines that LOOK LIKE a state declaration without being the canonical
 * `- **Status:** <state>` — decorated by any BLOCK STRUCTURE (indentation and
 * invisible format characters, `- * +`, `1.`/`2)`, `[x]`, `#`, `>`, `|`, in any
 * order and any number), or bare, or with the label wrapped in an inline
 * delimiter that CLOSES AT THE LABEL (`**Status:**`, `` `Status`: ``).
 *
 * NOT a look-alike: a line that QUOTES a declaration rather than making one —
 * `- "Status: VERIFIED" is an example`, the same in a code span, in
 * parentheses, or in emphasis that closes after the value. Those are prose, and
 * promoting one makes a correct ticket unactionable.
 *
 * `value` is the declared state with surrounding emphasis stripped.
 */
export function statusLookalikes(text: string): { line: string; value: string }[];
/**
 * The state AND its report, produced together from EVERY header declaration —
 * so an absent / empty / unrecognised / duplicated-and-contradicting state, or
 * a look-alike line that CONTRADICTS the one used, can never be answered about
 * silently.
 */
export function classifyStatusField(
  file: string | null | undefined,
  text: string,
): { cls: LegacyStatusClassification; statusRaw: string; statusError: string | null; statusWarnings: string[] };
export function legacyField(text: string, label: string): string;
export function parseTitleLine(text: string, opts?: { scan?: boolean }): { id: string | null; title: string | null; dash: string | null; ok: boolean };
export function indexRowCells(line: string, opts?: { requireClosingPipe?: boolean }): string[];
export function lastActivityDate(text: string): string | null;
export function countActivityEntries(text: string): number;
export function severityToEnum(raw: string | null | undefined): Severity | null;
export function extractTicketBlock(text: string): { block: string | null; body: string; raw: string | null };

export interface LegacyTicketRecord {
  id: string | null;
  type: TicketType | null;
  title: string | null;
  idFromH1: string | null;
  idMismatch: string | null;
  statusRaw: string;
  work_state: WorkState | null;
  /**
   * The LEGACY prose Status line's proof half, transcribed by
   * `LEGACY_STATUS_TABLE`. Always `null` for a promoted (record-carrying)
   * ticket: ARCH-009 removed `verification_state` from the record, so a
   * promoted ticket has `verification[]` and no derived state at all.
   */
  verification_state: VerificationState | null;
  done: boolean;
  statusMatched: boolean;
  statusAmbiguous: boolean;
  statusToken: string | null;
  /** Non-null ⇒ this ticket's state could not be interpreted. Carried on the record so a consumer that reads only `.record` still has the loud channel. */
  statusError: string | null;
  /** Non-null ⇒ the state IS answerable but its declaration is untidy (duplicated-in-agreement, incidental DONE token, an agreeing or state-less look-alike line, …). Joined form of `statusWarnings`. */
  statusWarning: string | null;
  /** The advisory reports, one per issue. Empty ⇒ the declaration is clean. */
  statusWarnings: string[];
  severity: Severity | null;
  severityRaw: string;
  area: string;
  reported: string | null;
  updated: string | null;
  activityEntries: number;
  body: string;
}

export function parseTicket(
  text: string,
  opts?: {
    file?: string | null;
    mode?: 'auto' | 'compat' | 'strict';
    /** Legacy mode: require the board's em-dash H1 (`# <ID> — <title>`). */
    requireEmDash?: boolean;
    /** Legacy mode: accept an H1 anywhere in the file, not only on line 1. */
    scanForH1?: boolean;
  },
): {
  ok: boolean;
  format: 'legacy' | 'block' | 'unknown';
  record: LegacyTicketRecord | Record<string, unknown> | null;
  /**
   * BUG-122 — the ONE-SHAPE consumer view, for every caller that describes a
   * ticket rather than caring which format it is in (board tables, board:check,
   * the ticket API's list). Legacy: the identical `record` object. Block: the
   * human-layer fields mapped off the JSON record. NEVER null — an unreadable
   * block still summarises, with the failure in `statusError`, so a half-written
   * ticket stays listable and loud.
   */
  summary: LegacyTicketRecord;
  errors: string[];
  warnings: string[];
};

export function validateTicket(record: unknown, opts?: { file?: string | null }): { ok: boolean; violations: string[] };
export function formatTicket(record: Record<string, unknown>, body?: string): string;
