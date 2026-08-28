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
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dataDir, ensureDir, writeAtomic } from '../lib/paths.ts';

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
}

function storeFile(): string {
  return path.join(dataDir(), 'decisions.json');
}

function readAll(): DecisionRecord[] {
  try {
    const raw = fs.readFileSync(storeFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DecisionRecord[]) : [];
  } catch {
    return []; // no store yet, or unreadable — an empty ledger, never an error
  }
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
  };
  const all = readAll();
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
