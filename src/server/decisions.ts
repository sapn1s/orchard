/**
 * Runtime-raised decision records (FEAT-029).
 *
 * The other half of the Needs-You rail (FEAT-018): a RUNNING session hits a
 * decision that is genuinely the user's and raises it via
 * `POST /api/sessions/:sid/needs-you`. Unlike a board 👤 ticket (which lives in
 * the project's docs/bugs/ files), a raised decision is a lightweight object of
 * this app's own — so it lives in a small JSON store under the data dir.
 *
 * It is PERSISTENT, not ephemeral: it survives a page reload / server restart /
 * context compaction, and stays on the rail until the user answers it. On answer
 * the record is marked resolved (leaves the rail) and the answer is routed back
 * to the SPECIFIC session that raised it. If that session is gone by then, the
 * answer is still recorded — nothing crashes, nothing is lost.
 *
 * The store is written with `writeAtomic` (temp + fsync + rename), so a crash
 * mid-write never truncates the file; the previous state is intact.
 */
import * as path from 'node:path';

import { dataDir, ensureDir, writeAtomic } from '../lib/paths.ts';
import { quarantine, readCapped } from './store-io.ts';

/** Largest decisions store, in bytes, a read will accept before treating the file
 *  as unreadable (bounds a hostile/corrupt file; realistic stores are far under). */
const MAX_STORE_BYTES = 16 * 1024 * 1024;

/**
 * FEAT-108 round 3 — a git-write PERMISSION request an agent raised. When a
 * decision carries this, approving it (answer starts "Allow") is the single
 * user action that mints a runtime git-write grant; the request route that
 * created the record mints nothing (the record is inert until the user acts),
 * which is the whole self-approval defence — an agent can raise requests all
 * day and none becomes a grant without a human on the answer route.
 */
export interface GitWriteRequest {
  /** 'once' = the next single permitted write; 'duration' = a time window. */
  scope: 'once' | 'duration';
  /** Window length in minutes for a 'duration' grant; null = the store default. */
  minutes: number | null;
  /** The agent's stated reason, shown on the card so the user approves in context. */
  reason: string;
}

/**
 * FEAT-112 — a set of service sidecars an agent PROPOSED. Same shape of defence
 * as GitWriteRequest: the request route mints nothing and writes no settings; the
 * record is inert until the user answers "Allow" on the rail, and only the answer
 * route writes the proposed services into the project. An agent proposing is
 * never an agent applying.
 */
export interface ServiceRequest {
  /** The proposed service specs (already validated by the request route). */
  services: import('./registry.ts').ServiceSpec[];
  /** The agent's stated reason, shown on the card so the user approves in context. */
  reason: string;
}

export interface DecisionRecord {
  id: string;
  projectId: string;
  /** The station session id (AgentSession.id) that raised it, for routing back. */
  sessionId: string;
  /** The SDK session id, if the raiser was known by that instead — a fallback route. */
  sdkSessionId: string | null;
  question: string;
  /** Optional multiple-choice answers, rendered as buttons on the card. */
  options: string[];
  createdAt: string;
  resolved: boolean;
  answer: string | null;
  answeredAt: string | null;
  /** Whether the answer was actually delivered to a live raising session. */
  delivered: boolean;
  /** FEAT-108 r3 — present iff this decision is a git-write permission request. */
  gitWrite?: GitWriteRequest | null;
  /** FEAT-112 — present iff this decision is a service-sidecar proposal. */
  services?: ServiceRequest | null;
}

function storeFile(): string {
  return path.join(dataDir(), 'decisions.json');
}

interface StoreRead {
  records: DecisionRecord[];
  /** false = present but could not be read as a record array (torn / mid-write /
   *  corrupt / wrong shape). An append writer must NOT clobber it. */
  ok: boolean;
}

/**
 * BUG-202 — read the store, distinguishing "no file yet" (ENOENT — genuinely
 * empty, safe to create) from "present but unreadable" (torn / corrupt / wrong
 * shape). This is the DATA-LOSS distinction the old `readAll` collapsed: it
 * returned `[]` for BOTH, so an append writer then wrote over a corrupt file as
 * if it were empty and WIPED every prior record (the same shape FEAT-126 fixed
 * in requests.ts). `ok:false` means "do not clobber — quarantine first".
 */
function readStore(): StoreRead {
  // Bounded read on the fd (store-io.readCapped) — no stat→read TOCTOU; a file
  // over the cap is refused without being read into memory.
  const res = readCapped(storeFile(), MAX_STORE_BYTES);
  if (res.kind === 'absent') return { records: [], ok: true };
  if (res.kind !== 'ok') return { records: [], ok: false }; // toobig | error — present but unreadable
  try {
    const parsed = JSON.parse(res.data);
    if (Array.isArray(parsed)) return { records: parsed as DecisionRecord[], ok: true };
    return { records: [], ok: false }; // valid JSON but not our shape — corrupt, never clobber
  } catch {
    return { records: [], ok: false }; // torn / partial / non-JSON — never clobber
  }
}

/**
 * Records only. Read-side callers (`get`, `listOpenForProject`) degrade to an
 * empty ledger on an unreadable file exactly as before — never an error. The
 * WRITE path uses `readStore()` so it can refuse to clobber a corrupt file. The
 * mutating writers below (`resolve`) are clobber-safe by construction: they
 * `writeAll` only after finding a record, and a corrupt store yields none.
 */
function readAll(): DecisionRecord[] {
  return readStore().records;
}

function writeAll(records: DecisionRecord[]): void {
  ensureDir(dataDir());
  writeAtomic(storeFile(), JSON.stringify(records, null, 2));
}

/** A stable, collision-resistant id for a new decision record. */
function newId(): string {
  return `dec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface RaiseInput {
  projectId: string;
  sessionId: string;
  sdkSessionId: string | null;
  question: string;
  options?: unknown;
  /** FEAT-108 r3 — set only by the git-write-request route. */
  gitWrite?: GitWriteRequest | null;
  /** FEAT-112 — set only by the services-request route. */
  services?: ServiceRequest | null;
}

/** Normalise a raw `options` value into a clean string[] (drops empties). */
function cleanOptions(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  return options
    .map((o) => (typeof o === 'string' ? o.trim() : String(o ?? '').trim()))
    .filter((o) => o.length > 0)
    .slice(0, 12);
}

/**
 * Persist a new decision record. `question` MUST be a non-empty string — the
 * caller (the route) is expected to have validated it, but this guards too so
 * the store can never hold a blank card. Returns the stored record.
 */
export function raise(input: RaiseInput): DecisionRecord {
  const question = String(input.question ?? '').trim();
  if (!question) throw new Error('question is required');
  const rec: DecisionRecord = {
    id: newId(),
    projectId: input.projectId,
    sessionId: input.sessionId,
    sdkSessionId: input.sdkSessionId ?? null,
    question,
    options: cleanOptions(input.options),
    createdAt: new Date().toISOString(),
    resolved: false,
    answer: null,
    answeredAt: null,
    delivered: false,
    gitWrite: input.gitWrite ?? null,
    services: input.services ?? null,
  };
  // BUG-202 — never overwrite a present-but-unreadable store as if it were
  // empty: preserve its bytes (quarantine), then start fresh with this record.
  const read = readStore();
  if (!read.ok) quarantine(storeFile(), 'decisions');
  const all = read.ok ? read.records : [];
  all.push(rec);
  writeAll(all);
  return rec;
}

/** One record by id, resolved or not. */
export function get(id: string): DecisionRecord | null {
  return readAll().find((r) => r.id === id) ?? null;
}

/** The OPEN (unresolved) decision records for a project — the rail cards. */
export function listOpenForProject(projectId: string): DecisionRecord[] {
  return readAll().filter((r) => r.projectId === projectId && !r.resolved);
}

/**
 * Mark a record resolved with the user's answer. Idempotent-ish: resolving an
 * already-resolved record just overwrites the answer/delivered fields. Returns
 * the updated record, or null when the id is unknown.
 */
export function resolve(id: string, answer: string, delivered: boolean): DecisionRecord | null {
  const all = readAll();
  const rec = all.find((r) => r.id === id);
  if (!rec) return null;
  rec.resolved = true;
  rec.answer = String(answer ?? '');
  rec.answeredAt = new Date().toISOString();
  rec.delivered = delivered;
  writeAll(all);
  return rec;
}
