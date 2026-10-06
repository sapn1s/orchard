/**
 * FEAT-168 — THE one owner of "this session is CLOSED" (the user's "done,
 * nothing pending" label).
 *
 * WHY HERE AND NOT IN THE TRANSCRIPT'S TAG SLOT (round 4). Rounds 1-3 stored
 * `closed` as the Agent SDK's single native session tag (the slot pin uses), so
 * every round had to guard a foreign tag on close/reopen (P1) and resolve the
 * latest tag from a file another process writes (P4). `closed` is an ORCHARD
 * fact, so the record lives in Orchard's data dir and close/reopen never write
 * the transcript.
 *
 * ROUND 6 — CLOSED IS A DERIVED COMPARISON; NOTHING WRITES ON REOPEN. Rounds 4-5
 * cleared the record from each prompt-delivery path ("auto-reopen") and broke
 * twice on a path they had not listed (ws start/resume; then an adopt-gated
 * broker's deliver after a restart), and round 5's resume hook would have
 * reopened a fork's SOURCE. Now a close records the identity of the session's
 * latest INPUT PROMPT at that moment (session-mutations `readLastPromptKey`), and
 * the session reads closed iff that is still its latest input prompt. Any new
 * prompt, by any route, lands in the transcript and flips the answer by
 * construction; the session's own continuing output, a rename, a pin, a view
 * and a fork (which writes a different file) do not. Explicit Reopen deletes the
 * record. `isSessionClosed` / `closedReader` are THE read, used by the session
 * list (sidebar) and sessionStateOf (crown + every mutation response).
 *
 * Consequences, stated:
 *   - pin and closed are INDEPENDENT (pin stays on the SDK tag).
 *   - the record does not travel with the transcript and does not survive a reset
 *     of Orchard's data dir — it is dashboard state, like session-accounts.json.
 *   - keyed by the SDK session id; each FILE of that id (this machine dual-boots,
 *     so one id can exist under several store dirs) is compared on its own, so a
 *     byte-identical copy reads closed and a copy that has since been continued
 *     reads open.
 *   - an ORPHAN record (the session was deleted) or a STALE one (a prompt has
 *     since arrived) is inert: it is never consulted, or it compares unequal.
 *   - a record in any other shape (round 4/5's bare ISO string) reads OPEN — a
 *     closed session reappears, it is never lost. The real data dir held none.
 *
 * Durability: `writeAtomic` (temp + fsync + rename). A present-but-unreadable
 * file is never clobbered: a write quarantines it first (store-io), exactly as
 * the other small JSON stores do; a read degrades to "nothing closed".
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dataDir, writeAtomic } from '../lib/paths.ts';
import { quarantine, readCapped } from './store-io.ts';
import { readLastPromptKey } from './session-mutations.ts';

/** Largest store a read accepts (bounds a hostile/corrupt file; realistic stores are KBs). */
const MAX_STORE_BYTES = 8 * 1024 * 1024;

/** Same id grammar session-mutations' resolveSession accepts. */
function validId(sid: unknown): sid is string {
  return typeof sid === 'string' && sid.length > 0 && sid.length <= 200 && /^[A-Za-z0-9._-]+$/.test(sid) && !sid.includes('..');
}

export function sessionClosedFile(): string {
  return path.join(dataDir(), 'session-closed.json');
}

/** One close: when (display/audit only — never compared) and the watermark. */
export interface ClosedRecord {
  closedAt: string;
  /** Identity of the latest input-prompt record at close time; null = it had none. */
  promptKey: string | null;
}

interface StoreRead {
  /** sessionId -> its close record (well-formed entries only). */
  map: Map<string, ClosedRecord>;
  /** false = present but unreadable (torn/corrupt/wrong shape/too big): never clobber. */
  ok: boolean;
}

/**
 * Cache keyed by the resolved file AND its identity (ino, size, mtime, ctime), so a
 * re-pointed CLAUDE_STATION_DATA (the in-process verify harnesses do that) or a
 * write by another process is never served stale.
 */
let cache: { file: string; ino: number; size: number; mtimeMs: number; ctimeMs: number; read: StoreRead } | null = null;

function readStore(): StoreRead {
  const file = sessionClosedFile();
  let st: fs.Stats | null = null;
  try { st = fs.statSync(file); } catch { st = null; }
  if (!st) {
    cache = null;
    return { map: new Map(), ok: true };
  }
  if (cache && cache.file === file && cache.ino === st.ino && cache.size === st.size && cache.mtimeMs === st.mtimeMs && cache.ctimeMs === st.ctimeMs) {
    return cache.read;
  }
  const res = readCapped(file, MAX_STORE_BYTES);
  let read: StoreRead;
  if (res.kind === 'absent') read = { map: new Map(), ok: true };
  else if (res.kind !== 'ok') read = { map: new Map(), ok: false };
  else {
    read = { map: new Map(), ok: false };
    try {
      const parsed = JSON.parse(res.data) as unknown;
      const closed = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { closed?: unknown }).closed : undefined;
      if (closed && typeof closed === 'object' && !Array.isArray(closed)) {
        const map = new Map<string, ClosedRecord>();
        for (const [sid, rec] of Object.entries(closed as Record<string, unknown>)) {
          if (!validId(sid) || !rec || typeof rec !== 'object' || Array.isArray(rec)) continue; // legacy/garbled -> reads open
          const r = rec as { closedAt?: unknown; promptKey?: unknown };
          if (!(r.promptKey === null || typeof r.promptKey === 'string')) continue;
          map.set(sid, { closedAt: typeof r.closedAt === 'string' ? r.closedAt : '', promptKey: r.promptKey });
        }
        read = { map, ok: true };
      }
    } catch {
      /* torn / partial / non-JSON -> ok:false, never clobbered */
    }
  }
  cache = { file, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, read };
  return read;
}

function writeStore(map: Map<string, ClosedRecord>): void {
  const closed: Record<string, ClosedRecord> = {};
  for (const [sid, at] of [...map].sort((a, b) => a[0].localeCompare(b[0]))) closed[sid] = at;
  writeAtomic(sessionClosedFile(), `${JSON.stringify({ closed }, null, 2)}\n`);
  cache = null;
}

/** The comparison itself — the ONE place "closed" is decided. */
function closedBy(rec: ClosedRecord | undefined, filePath: string | null | undefined): boolean {
  if (!rec || typeof filePath !== 'string' || !filePath) return false;
  const now = readLastPromptKey(filePath);
  if (now === undefined) return false; // unreadable transcript: reads open (reappears, never lost)
  return now === rec.promptKey;
}

/**
 * THE read: is this session (this transcript FILE of it) closed? True iff a close
 * record exists AND the file's latest input prompt is still the one recorded at
 * close. Unknown/invalid ids, an unreadable store or transcript read as open.
 */
export function isSessionClosed(sid: string | null | undefined, filePath: string | null | undefined): boolean {
  if (!validId(sid)) return false;
  return closedBy(readStore().map.get(sid), filePath);
}

/** The same read for a whole list: one store read, then one comparison per row. */
export function closedReader(): (sid: string, filePath: string) => boolean {
  const map = readStore().map;
  return (sid, filePath) => validId(sid) && closedBy(map.get(sid), filePath);
}

export class SessionCloseError extends Error {
  readonly status = 503;
  readonly code = 'transcript-unreadable';
}

/**
 * Close (record the watermark) or reopen (delete the record). Returns true when
 * it changed anything. Synchronous read-modify-write in one tick, so two
 * requests in this process cannot interleave. Never touches the transcript.
 * A close whose transcript cannot be read throws SessionCloseError (503): it
 * never stores a guessed watermark.
 */
export function setSessionClosed(target: { sessionId: string; filePath: string }, closed: boolean): boolean {
  const sid = target.sessionId;
  if (!validId(sid)) throw new Error(`setSessionClosed: not a valid session id: ${String(sid)}`);
  const read = readStore();
  let next: ClosedRecord | null = null;
  if (closed) {
    const promptKey = readLastPromptKey(target.filePath);
    if (promptKey === undefined) throw new SessionCloseError(`cannot read the transcript of ${sid} to record where it was closed — not closed`);
    const prev = read.ok ? read.map.get(sid) : undefined;
    if (prev && prev.promptKey === promptKey) return false; // already closed at this point
    next = { closedAt: new Date().toISOString(), promptKey };
  } else if (read.ok && !read.map.has(sid)) {
    return false; // nothing to reopen
  }
  // Present-but-unreadable: preserve its bytes aside, then start from empty.
  if (!read.ok) quarantine(sessionClosedFile(), 'session-closed');
  const map = new Map(read.ok ? read.map : []);
  if (next) map.set(sid, next);
  else map.delete(sid);
  writeStore(map);
  return true;
}

/** Test seam: drop the in-memory cache. */
export function _resetSessionClosedCache(): void {
  cache = null;
}
