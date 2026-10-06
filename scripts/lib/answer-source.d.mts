/** Types for answer-source.mjs (FEAT-166 r3) — keep in step with its exports. */
export const ANSWER_LEDGER_FILE: string;
export const ANSWER_FROZEN_FILE: string;
export const ANSWER_LEDGER_SCHEMA: string;
export const ANSWER_FROZEN_SCHEMA: string;
export const ANSWER_KINDS: readonly string[];
export const ANSWER_FROZEN_PINS: readonly string[];
export const USER_REPLY_AUTHOR_RE: RegExp;
export function sha256(s: string): string;
export function canonicalJson(v: unknown): string;
export function activityHeadings(text: string): Array<{ date: string; author: string; line: number; k: number; sha: string }>;
export function loadAnswerFrozen(boardDir: string): { present: boolean; pinned: boolean; sha256: string | null; error: string | null; tickets: Record<string, unknown> };
export function frozenAnswerFor(boardDir: string, id: string): unknown;
export function loadAnswerLedger(boardDir: string): { present: boolean; error: string | null; entries: unknown[] };
export function ledgerAnswersFor(boardDir: string, id: string): unknown[];
export function appendLedgerAnswer(boardDir: string, id: string, typed: object): void;
export function recordTypedAnswers(record: unknown): Array<Record<string, unknown>>;
export function unaccountedAnswerHeadings(boardDir: string, id: string, text: string, record: unknown): Array<{ line: number; date: string; author: string }>;
