// FEAT-184 — types for delegation-source.mjs (the store of the user's delegations).
export const DELEGATION_DIR: string;
export const DELEGATION_KEY_FILE: string;
export const MAX_SCOPE_TICKETS: number;
export const MAX_DAYS: number;
export const DEFAULT_DAYS: number;
export const MAX_STATEMENT: number;
export const PERMITS: 'recommended';
export const READS_AS_USER: RegExp;

export interface StoreEntry {
  seq: number;
  prev: string;
  board: string;
  kind: 'record' | 'revoke' | 'adoption' | 'answer' | 'genesis' | 'migrated';
  digest?: string;
  answer_kind?: string;
  followup?: boolean;
  legacy?: boolean;
  seal: string;
  delegation_id: string;
  statement?: string;
  scope?: { tickets: string[] };
  permits?: string;
  recorded_on?: string;
  recorded_at: string;
  expires_at?: string;
  recorded_by?: string;
  origin?: string;
  answer_id?: string;
  ticket?: string;
  decision_key?: string;
  chose?: { key: string; label: string } | null;
  adopted_by?: string;
}
export interface Store { ok: boolean; damaged: string | null; entries: StoreEntry[]; headSeq: number; board: string }
export interface ListedDelegation extends Omit<StoreEntry, 'seal' | 'prev' | 'board'> { state: 'live' | 'revoked' | 'expired'; revoked_at: string | null }

export function sha256(s: string): string;
export function defaultDataDir(env?: NodeJS.ProcessEnv): string;
export function delegationKeyPath(dataDir: string): string;
export function readDelegationKey(dataDir: string): string | null;
export function ensureDelegationKey(dataDir: string): string;
export function boardBinding(boardDir: string): string;
export function storeFiles(dataDir: string, boardDir: string): { file: string; head: string };
export function loadStore(dataDir: string, boardDir: string, key?: string | null): Store;
export function appendEntry(dataDir: string, boardDir: string, key: string | null, entry: Record<string, unknown>): StoreEntry;
export function validateDelegationInput(input: unknown, now?: Date):
  | { ok: true; errors: string[]; value: { statement: string; scope: { tickets: string[] }; permits: 'recommended'; expires_at: string } }
  | { ok: false; errors: string[]; value?: undefined };
export function listDelegations(store: Store, now?: Date): ListedDelegation[];
export function liveDelegation(
  boardDirOrStore: string | Store, id: string, ticketId: string,
  opts?: { dataDir?: string; key?: string | null; now?: Date },
): { ok: true; delegation: StoreEntry } | { ok: false; code: string; why: string };
export function adoptionReceipt(store: Store, ticketId: string, a: { answer_id: string; decision_key: string; delegation_id?: string; chose: { key: string } | null }): StoreEntry | null;
export function userAnswerTrust(store: Store, storePresent: boolean): 'legacy' | 'receipts' | 'damaged';
export function storePresent(dataDir: string, boardDir: string): boolean;
export function answerReceipt(store: Store, ticketId: string, a: { answer_id: string; decision_key: string; kind: string; followup?: boolean }): StoreEntry | null;
export function answerReceiptEntry(ticketId: string, a: { answer_id: string; decision_key: string; kind: string; followup?: boolean; recorded_at?: string }, legacy?: boolean): Record<string, unknown>;
export function ensureBoardStore(dataDir: string, boardDir: string, legacy: () => Array<{ ticket: string; answer: { answer_id: string; decision_key: string; kind: string; followup?: boolean; recorded_at?: string } }>, opts?: { hasAdoptions?: () => boolean }): string;
export function withTicketLock<T>(file: string, fn: () => T, opts?: { waitMs?: number }): T;
export function typedAnswerDigest(a: unknown): string;
export function storeMigrated(store: Store): boolean;
