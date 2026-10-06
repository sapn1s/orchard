/**
 * Session mutation: rename, pin (native tag), delete.
 *
 * Everything that WRITES goes through the Agent SDK's own mutation functions
 * (`renameSession`, `tagSession`, `deleteSession`) — this module never edits a
 * session file itself. Everything that READS the resulting fields is done here
 * rather than via the SDK's `listSessions`, for two measured reasons:
 *
 *  1. `SDKSessionInfo.customTitle` CONFLATES the two on-disk entry types. A
 *     session that was never renamed but has a model-generated `ai-title`
 *     reports that string as `customTitle` (observed: a scratch session with
 *     only an `{"type":"ai-title"}` entry came back with
 *     `customTitle:"Auto summary about swallows"`). So it cannot answer
 *     "renamed or auto?", which is exactly what the sidebar needs.
 *  2. `listSessions({dir})` is keyed by a real cwd, while the sidebar is keyed
 *     by the ENCODED store dir and deliberately merges several of them
 *     (Windows copies, `-workspace-<id>` container dirs). Reading the file we
 *     already located sidesteps that mapping entirely.
 *
 * On-disk representation, confirmed by running the SDK against a scratch store:
 *   rename -> {"type":"custom-title","customTitle":"...","sessionId":"..."}
 *   tag    -> {"type":"tag","tag":"pinned","sessionId":"..."}
 * Both are APPENDED; nothing existing is rewritten, so the `ai-title` auto
 * summary survives a rename and is still readable as `SessionMeta.title`.
 * Also confirmed: an `ai-title` written AFTER a `custom-title` does not win —
 * a custom title is sticky, so a rename is not silently undone by a later turn.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { renameSession, tagSession, deleteSession } from '@anthropic-ai/claude-agent-sdk';
import { asOrchardWriteAsync } from './own-writes.ts';

import * as hist from '../lib/session-history.ts';
import { deletedSessionsDir, backupFileTo, ensureDir } from '../lib/paths.ts';

/** The one reserved tag this app uses for "pinned". */
export const PIN_TAG = 'pinned';
// FEAT-168: "closed" is NOT a tag. It is an Orchard-owned record kept in Orchard's
// data dir (session-closed.ts) and never written to the transcript; round 6 READS
// the transcript's latest input prompt as its watermark (readLastPromptKey below).

/** Bounded read window, matching session-history's own head+tail sampling. */
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 256 * 1024;

export class SessionMutationError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: Record<string, unknown>;
  constructor(status: number, code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'SessionMutationError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/* ------------------------------------------------------------------ reading */

export interface TitleMeta {
  /** Value of the most recent `custom-title` entry seen, or null. */
  customTitle: string | null;
  /** Value of the most recent `ai-title` entry seen, or null. */
  autoTitle: string | null;
  /**
   * The session's current tag — the last complete JSONL record whose PARSED
   * top-level `type` is "tag", read authoritatively (not from the head+tail title
   * sample, and never by text shape). A non-string or empty value means cleared ->
   * null. See scanTagBackward.
   */
  tag: string | null;
  pinned: boolean;
  /**
   * true when the file was too large to read whole, so only head+tail were
   * scanned and a `null` above is "not seen", NOT "not present". Reported so a
   * UI never renders a confident "auto" for a title it could not actually check.
   */
  sampled: boolean;
}

const EMPTY_TITLE_META: TitleMeta = { customTitle: null, autoTitle: null, tag: null, pinned: false, sampled: false };

/**
 * Cache keyed by path. A hit requires the file's FULL identity to be unchanged:
 * dev + inode + size + mtime + ctime. ctime cannot be set from userspace (any
 * write or utimes bumps it), so an in-place rewrite that restores the size and
 * mtime still misses. FEAT-168 round 4: there is NO cross-change reuse — round 3
 * reused the previous scan for a grown file guarded by a 256-byte fingerprint,
 * and an in-place rewrite that regrew the file and kept those bytes served a
 * stale tag (round-3 verifier, run 5f20faa854e1). Any change => a full fresh scan.
 */
interface CacheEntry {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  meta: TitleMeta;
}
const cache = new Map<string, CacheEntry>();
const sameFile = (e: CacheEntry, st: fs.Stats): boolean =>
  e.dev === st.dev && e.ino === st.ino && e.size === st.size && e.mtimeMs === st.mtimeMs && e.ctimeMs === st.ctimeMs;

export function clearTitleMetaCache(): void {
  cache.clear();
}

function scanLines(text: string, out: TitleMeta): void {
  for (const raw of text.split('\n')) {
    // Cheap pre-filter: only the two TITLE entry types are resolved here; each is
    // a tiny line. The `tag` slot is NOT read from this head+tail sampling — see
    // scanTagBackward below — because a tag in the unsampled middle would be
    // missed (FEAT-168 round 2).
    if (!raw.includes('"custom-title"') && !raw.includes('"ai-title"')) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    // Last one wins, exactly like the CLI's own reader.
    if (e.type === 'custom-title' && typeof e.customTitle === 'string') out.customTitle = e.customTitle;
    else if (e.type === 'ai-title' && typeof e.aiTitle === 'string') out.autoTitle = e.aiTitle;
  }
}

/**
 * FEAT-168 — THE one authoritative read of a session's current tag slot (pin).
 * ARCH-010: the tag is the fact, the SDK transcript owns it, and this is the
 * single place that resolves it. (Round 4: `closed` no longer lives here — it is
 * Orchard's own fact, session-closed.ts. This reader now serves pin only.)
 *
 * WHY NOT THE OWNER'S OWN READER. The Agent SDK does expose the tag
 * (`getSessionInfo`/`listSessions` -> `SDKSessionInfo.tag`), but for a local
 * transcript it reads only the LAST 64KB and picks the tag line by text shape
 * (`l.includes('"type":"tag"') && l.includes('"tag":"')`) — measured in
 * sdk.mjs 0.3.281. That reintroduces BOTH earlier breaks (round 1: a tag outside
 * the sampled window; round 2: a valid record in a format the text test does not
 * expect). What we take from the owner is its DECISION RULE, from its full-parse
 * (session-store) path: a record is a tag iff the parsed object's top-level
 * `type === "tag"`; its value is `tag` when that is a non-empty string, else the
 * slot is cleared. The writer (`tagSession`) appends one JSON.stringify'd record
 * per line, so the store's format is JSONL: one record per newline-terminated line.
 *
 * THE RULE — no text-shape matching anywhere: scan BACKWARD from EOF over
 * complete (newline-terminated) lines, JSON.parse EVERY one, and stop at the
 * first whose parsed value is a tag record. The bytes after the last newline are
 * a record a writer is midway through appending; it has not taken effect, so it
 * is ignored until its newline lands (JSONL commit rule). A record pretty-printed
 * across several physical lines is not a JSONL record and never matches (the
 * SDK's readers agree). Lines are assembled from chunk pieces and concatenated
 * ONCE per line, so a giant single-line record costs O(its length), not O(n^2).
 *
 * Always a FULL scan from EOF (round 4): no result from an earlier version of the
 * file is ever reused, so an in-place rewrite cannot be served stale.
 *
 * Returns null when the read came back short (the file shrank under us); the
 * caller then reports no tag and does NOT cache, so the next read retries.
 */
interface TagScan {
  /** the found record's value (null = a clearing record, or no tag record at all). */
  tag: string | null;
}

/** Parse one complete JSONL line; a non-object (or unparsable) line is no record. */
function parseRecord(line: string): Record<string, unknown> | null {
  if (line.length === 0) return null;
  let e: unknown;
  try {
    e = JSON.parse(line);
  } catch {
    return null;
  }
  if (e === null || typeof e !== 'object' || Array.isArray(e)) return null;
  return e as Record<string, unknown>;
}

/** The tag decision, on the PARSED value only: a JSON object whose top-level type is "tag". */
function tagOfRecord(rec: Record<string, unknown>): { tag: string | null } | undefined {
  if (rec.type !== 'tag') return undefined;
  return { tag: typeof rec.tag === 'string' && rec.tag ? rec.tag : null };
}

/**
 * THE backward scanner (FEAT-168): walk complete JSONL lines from EOF toward the
 * start, JSON.parse each, and return the first `pick` that is not undefined —
 * `{ found }`, or `{ found: undefined }` when no line matched. Shared by the pin
 * tag (tagOfRecord) and the CLOSED watermark (promptMatchOf) so both are read by
 * one authoritative walk with the same commit rule. Returns null on a short read.
 */
function scanBackward<T>(fd: number, size: number, pick: (rec: Record<string, unknown>, line: string, lineBuf: Buffer) => T | undefined): { found: T | undefined } | null {
  const CHUNK = 1024 * 1024;
  let pos = size;
  let sawNewline = false;
  // `pick` gets BOTH the decoded string (for JSON classification) AND the RAW
  // line bytes: identity (hash + occurrence count) must key on the raw bytes, not
  // the lossy-decoded text, or a non-UTF-8 byte makes distinct prompts collide
  // and a byte-identical repeat never re-counts (FEAT-168 round 9).
  const decide = (lineBuf: Buffer): T | undefined => {
    const line = lineBuf.toString('utf8');
    const rec = parseRecord(line);
    return rec ? pick(rec, line, lineBuf) : undefined;
  };
  // Pieces (file order) of the line currently being assembled, all to the right
  // of `pos`. Only populated once the last newline has been seen.
  let frag: Buffer[] = [];
  while (pos > 0) {
    const start = Math.max(0, pos - CHUNK);
    const len = pos - start;
    const buf = Buffer.allocUnsafe(len);
    if (fs.readSync(fd, buf, 0, len, start) !== len) return null; // shrank under us
    pos = start;
    let end = len; // exclusive end of the not-yet-consumed bytes in buf
    if (!sawNewline) {
      const lastNl = buf.lastIndexOf(0x0a);
      if (lastNl === -1) continue; // still inside the uncommitted final segment
      sawNewline = true; // everything right of this newline is uncommitted
      end = lastNl;
    }
    const first = buf.indexOf(0x0a);
    if (first === -1 || first >= end) {
      if (end > 0) frag.unshift(buf.subarray(0, end)); // no line boundary in this chunk
      continue;
    }
    // The rightmost line of this chunk continues into the carried fragment.
    const last = buf.lastIndexOf(0x0a, end - 1);
    const right = buf.subarray(last + 1, end);
    const joined = frag.length ? Buffer.concat([right, ...frag]) : right;
    const r = joined.length ? decide(joined) : undefined;
    if (r !== undefined) return { found: r };
    // Whole lines strictly inside the chunk: split on RAW newlines, walk them
    // backward keeping each line's raw bytes (identity keys on bytes, not decoded
    // text — FEAT-168 round 9). A newline never splits a multibyte character.
    if (first < last) {
      const segs: Buffer[] = [];
      let s = first + 1;
      let nl: number;
      while ((nl = buf.indexOf(0x0a, s)) !== -1 && nl < last) {
        segs.push(buf.subarray(s, nl));
        s = nl + 1;
      }
      segs.push(buf.subarray(s, last));
      for (let i = segs.length - 1; i >= 0; i--) {
        const t = decide(segs[i]!);
        if (t !== undefined) return { found: t };
      }
    }
    frag = first > 0 ? [buf.subarray(0, first)] : [];
  }
  if (!sawNewline) return { found: undefined };
  // Reached the start of the file: what remains is the first whole line.
  const r = frag.length ? decide(Buffer.concat(frag)) : undefined;
  return { found: r };
}

function scanTagBackward(fd: number, size: number): TagScan | null {
  const r = scanBackward(fd, size, (rec) => tagOfRecord(rec));
  return r ? { tag: r.found ? r.found.tag : null } : null;
}

/** Read the custom-title / ai-title / tag entries out of one session file. */
export function readTitleMeta(filePath: string): TitleMeta {
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch {
    return EMPTY_TITLE_META;
  }
  const hit = cache.get(filePath);
  if (hit && sameFile(hit, st)) return hit.meta;

  const meta: TitleMeta = { customTitle: null, autoTitle: null, tag: null, pinned: false, sampled: false };
  let cacheable = false;
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    // Identity and size come from the DESCRIPTOR we read through, not the path
    // stat above, so a replace-between-stat-and-open cannot mix two files.
    st = fs.fstatSync(fd);
    if (st.size <= HEAD_BYTES + TAIL_BYTES) {
      const buf = Buffer.alloc(st.size);
      fs.readSync(fd, buf, 0, st.size, 0);
      scanLines(buf.toString('utf8'), meta);
    } else {
      // TITLES only are sampled (and flagged `sampled`); a missing title in the
      // window is reported as "unknown", never guessed. The tag slot is resolved
      // authoritatively below instead, so pin is never sampled.
      meta.sampled = true;
      const head = Buffer.alloc(HEAD_BYTES);
      fs.readSync(fd, head, 0, HEAD_BYTES, 0);
      const tail = Buffer.alloc(TAIL_BYTES);
      fs.readSync(fd, tail, 0, TAIL_BYTES, st.size - TAIL_BYTES);
      // Head first, then tail, so "last wins" still holds in file order. The
      // first/last fragment of each buffer may be a partial line; JSON.parse
      // rejects it and scanLines skips it.
      scanLines(head.toString('utf8'), meta);
      scanLines(tail.toString('utf8'), meta);
    }
    // The tag slot (pin) — a full fresh scan, never from the sampled window above.
    const t = scanTagBackward(fd, st.size);
    if (t) {
      meta.tag = t.tag;
      cacheable = true;
    }
  } catch {
    /* unreadable file -> honest empty meta, same as session-history does */
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
  meta.pinned = meta.tag === PIN_TAG;
  // A short read is never cached: the next read retries rather than serving it.
  if (cacheable) cache.set(filePath, { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, meta });
  else cache.delete(filePath);
  return meta;
}

/* ===================================================================== *
 * FEAT-168 round 6 — the CLOSED watermark: "the latest INPUT PROMPT".
 *
 * A session reads CLOSED iff the identity of its latest input-prompt record is
 * the one recorded when it was closed (session-closed.ts). Nothing writes on
 * reopen: any new prompt, by whatever Orchard route delivered it (ws send, ws
 * start/resume, an adopt-gated broker after a restart, the outbox, a survivor,
 * the autonomous nudge) or a `claude --resume` typed in a terminal, lands in the
 * transcript as a new prompt record, and the comparison flips by construction.
 * Rounds 4–5 cleared a store flag at each delivery path and broke twice on a path
 * they had not listed; this reads the one place every path ends up.
 *
 * WHAT IS AN INPUT PROMPT — decided ONLY on fields the CLI itself declares
 * (surveyed over the real store, CLI 2.1.1xx–2.1.286):
 *   - a top-level `user` record carrying `promptSource` (the CLI's own "where did
 *     this prompt come from": sdk | typed | system), other than `system`, and
 *     not a background-task notification (`origin.kind`). Since CLI 2.1.197
 *     EVERY prompt that came in through the session's input carries it; records
 *     the CLI synthesises itself do not — the interrupt marker, local slash
 *     command / `!`-bash wrappers and their stdout, /compact. So an interrupt
 *     (Orchard-caused or not) never reopens a closed session. A `user` record
 *     WITHOUT `promptSource` is never an input prompt — including anything a
 *     pre-2.1.197 CLI wrote (the field did not exist then). The installed CLI
 *     Orchard launches is >= 2.1.197 and every real current-CLI input prompt in
 *     the store carries `promptSource` (verified over the real store, FEAT-168
 *     round 7); there is no structural guessing, so a legacy CLI-synthesised
 *     record (e.g. a shutdown interrupt) can no longer masquerade as a prompt.
 *     CONSEQUENCE: a session driven by a pre-2.1.197 CLI will NOT auto-reopen on a
 *     new prompt and stays closed until the user reopens it (the safe direction —
 *     a stale closed session reappears on explicit reopen, work is never lost).
 *   - an `attachment` of type `queued_command` with `commandMode: "prompt"` — a
 *     prompt sent MID-TURN can land only in this form (real store: human mid-turn
 *     messages that exist nowhere else), excluding meta and task notifications.
 * Never a prompt: assistant output, tool results, hook feedback (isMeta), compact
 * summaries, system/attachment/queue-operation records, `ai-title`,
 * `custom-title` (rename), `tag` (pin), `last-prompt`, `mode`, … So the session's
 * own continuing work never reopens it — closing a RUNNING session sticks until a
 * new prompt arrives (criterion 6) — and Orchard's metadata writes cannot either.
 * Sidechain records never count (a subagent's turns are not this session's input).
 *
 * The identity is the record's `uuid` when it carries one, else a hash of the
 * record's full raw line plus how many byte-identical committed lines precede it
 * (so two distinct UUID-less prompts never alias — the round-7 `ts:<timestamp>`
 * collision — and a repeated identical prompt still yields a NEW key): an EQUALITY
 * test against the value read at close time, so no clock is ever compared (no
 * server-vs-CLI skew) and a rewound/truncated transcript whose latest prompt
 * changes reads open (fails toward "reappears", never "lost").
 * Read by the same authoritative backward walk as the pin tag (scanBackward): no
 * sampling, every complete line JSON.parsed, the uncommitted tail ignored.
 * ===================================================================== */

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const originKind = (v: unknown): unknown => (isObj(v) ? v.kind : undefined);

/** Is this parsed record an input prompt (see the block above)? */
export function isInputPromptRecord(rec: Record<string, unknown>): boolean {
  if (rec.isSidechain === true) return false;
  if (rec.type === 'user') {
    if (rec.isMeta === true || rec.isCompactSummary === true) return false;
    if (originKind(rec.origin) === 'task-notification') return false;
    // POSITIVE single marker: only the CLI's own `promptSource` makes a record an
    // input prompt. A record without it (an interrupt marker, a local slash-command
    // / `!`-bash wrapper or its stdout, a /compact summary, a pure tool_result, OR
    // anything written by a pre-2.1.197 CLI that predates the field) is NEVER an
    // input prompt. No structural guessing: the legacy branch is gone (FEAT-168
    // round 7), because it mis-classified legacy CLI-synthesised records (e.g. a
    // shutdown interrupt) as prompts and wrongly reopened a closed session.
    // Classification depends ONLY on type + isSidechain + promptSource, never on
    // message.content (FEAT-168 round 8): a promptSource prompt with empty/odd
    // content is still a prompt — the content shape is not a field the contract
    // consults, and the real store has no promptSource record that is a pure
    // tool_result (verified read-only, round 8), so dropping the content gate
    // changes no real session.
    if (!('promptSource' in rec)) return false;
    return rec.promptSource !== 'system';
  }
  if (rec.type === 'attachment' && isObj(rec.attachment) && rec.attachment.type === 'queued_command') {
    const a = rec.attachment;
    if (a.isMeta === true || rec.isMeta === true) return false;
    if (originKind(a.origin) === 'task-notification') return false;
    return a.commandMode === 'prompt';
  }
  return false;
}

/**
 * The latest input-prompt record's uuid (null when it carries none) + its RAW
 * line bytes. scanBackward returns the FIRST match from EOF — i.e. the last input
 * prompt in file order — so `lineBuf` is that record's committed bytes. Identity
 * keys on these bytes, never the decoded string (FEAT-168 round 9).
 */
function promptMatchOf(rec: Record<string, unknown>, _line: string, lineBuf: Buffer): { uuid: string | null; lineBuf: Buffer } | undefined {
  if (!isInputPromptRecord(rec)) return undefined;
  return { uuid: typeof rec.uuid === 'string' && rec.uuid ? rec.uuid : null, lineBuf };
}

/**
 * Count committed (newline-terminated) lines byte-equal to `target`, streaming
 * forward in 1 MB chunks so a huge transcript never loads whole. The uncommitted
 * final segment after the last newline is NOT counted — the same commit rule as
 * scanBackward, so a prompt mid-append stays invisible until its newline lands.
 * Only reached for a UUID-less latest prompt (none in the real store today), so
 * the extra forward pass is effectively never paid. `targetBuf` is the RAW line
 * bytes — comparison is byte-exact, never via a re-encoded decoded string, so a
 * non-UTF-8 byte still counts its own line (FEAT-168 round 9).
 */
function countCommittedLines(fd: number, size: number, targetBuf: Buffer): number {
  const CHUNK = 1024 * 1024;
  let count = 0;
  let pos = 0;
  let carry = Buffer.alloc(0); // bytes of the current, not-yet-terminated line
  while (pos < size) {
    const len = Math.min(CHUNK, size - pos);
    const buf = Buffer.allocUnsafe(len);
    if (fs.readSync(fd, buf, 0, len, pos) !== len) return count; // shrank under us
    pos += len;
    let start = 0;
    let nl: number;
    while ((nl = buf.indexOf(0x0a, start)) !== -1) {
      const seg = buf.subarray(start, nl);
      const lineBuf = carry.length ? Buffer.concat([carry, seg]) : seg;
      if (lineBuf.equals(targetBuf)) count++;
      carry = Buffer.alloc(0);
      start = nl + 1;
    }
    // Copy the tail: it views `buf`, which the next loop reallocates.
    carry = start < len ? Buffer.from(buf.subarray(start)) : Buffer.alloc(0);
  }
  return count;
}

interface PromptCacheEntry { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; key: string | null }
const promptCache = new Map<string, PromptCacheEntry>();

/**
 * The identity of the transcript's latest input-prompt record: a string, `null`
 * when the file holds none, or `undefined` when it could not be read (missing,
 * unreadable, or it shrank under the read — never cached, so the next read
 * retries). Cached per path only while dev+ino+size+mtime+ctime are unchanged
 * (the pin reader's key: any change at all => a fresh full walk from EOF).
 */
export function readLastPromptKey(filePath: string): string | null | undefined {
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch {
    promptCache.delete(filePath);
    return undefined;
  }
  const hit = promptCache.get(filePath);
  if (hit && hit.dev === st.dev && hit.ino === st.ino && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.ctimeMs === st.ctimeMs) return hit.key;
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    st = fs.fstatSync(fd); // identity + size from the descriptor we read through
    const r = scanBackward(fd, st.size, promptMatchOf);
    if (!r) {
      promptCache.delete(filePath);
      return undefined;
    }
    let key: string | null;
    if (!r.found) {
      key = null;
    } else if (r.found.uuid) {
      key = `uuid:${r.found.uuid}`;
    } else {
      // No uuid: identity = the record's full raw line PLUS its ordinal among
      // byte-identical committed lines. The matched line is the LAST input prompt,
      // and any byte-identical line classifies identically as a prompt, so none
      // follows it — the total count IS this record's ordinal. A re-read of the
      // unchanged file yields the same count (same key); a newly appended
      // identical-looking prompt makes count+1 (a new key -> reopen), and a
      // distinct prompt differs in its line hash. Hash + count on the RAW line
      // bytes, never the decoded string: a non-UTF-8 byte must not collide
      // distinct prompts nor zero the count (FEAT-168 round 9). Replaces round-7's
      // `ts:<timestamp>`, which aliased distinct UUID-less prompts sharing a
      // timestamp (FEAT-168 round 8).
      const n = countCommittedLines(fd, st.size, r.found.lineBuf);
      key = `h:${createHash('sha1').update(r.found.lineBuf).digest('hex')}#${n}`;
    }
    promptCache.set(filePath, { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, key });
    return key;
  } catch {
    promptCache.delete(filePath);
    return undefined;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Test seam: drop the prompt-watermark cache. */
export function clearPromptKeyCache(): void {
  promptCache.clear();
}

/**
 * How the title a UI shows was produced.
 *  custom  — the user renamed it (a `custom-title` entry exists)
 *  auto    — a model-generated `ai-title`
 *  prompt  — neither; falling back to the first user message / slash command
 *  unknown — the file was sampled and no title entry was in the window
 */
export type TitleSource = 'custom' | 'auto' | 'prompt' | 'unknown';

export function titleSourceOf(meta: TitleMeta): TitleSource {
  if (meta.customTitle !== null) return 'custom';
  if (meta.autoTitle !== null) return 'auto';
  return meta.sampled ? 'unknown' : 'prompt';
}

/* ---------------------------------------------------------------- resolving */

export interface ResolvedSession {
  sessionId: string;
  encodedDir: string;
  filePath: string;
  /** Authoritative cwd read out of the file. */
  cwd: string;
  /**
   * What the SDK's `dir` option is handed: a path whose store encoding IS
   * `encodedDir`. Normally the recorded cwd; for a DECLARED container store
   * whose session ran at bare `/workspace` (FEAT-155) it is the store's declared
   * address instead, because the recorded cwd encodes to a different dir.
   */
  sdkDir: string;
}

/**
 * FEAT-155 — who owns a store dir, as declared by its owner. Given an encoded
 * store dir, returns the declared SDK address for it (a cwd that encodes back
 * to exactly that dir) and the cwds a session in it may legitimately record,
 * or null when no registered project declares it. Supplied by the server,
 * which holds the registry; this module never parses a dir name to guess.
 */
export type DeclaredStoreLookup = (encodedDir: string) => { address: string; recordedCwds: string[] } | null;

/** Every encoded store dir that holds a `<sessionId>.jsonl`. */
export function findDirsForSession(sessionId: string): string[] {
  const out: string[] = [];
  for (const d of hist.listProjectDirs()) {
    if (hist.resolveSessionFile(d.encodedDir, sessionId)) out.push(d.encodedDir);
  }
  return out;
}

/**
 * Turn (sessionId, optional encodedDir) into everything a mutation needs.
 *
 * `dir` is the ENCODED store dir the sidebar already holds. It is REQUIRED
 * whenever more than one store dir holds this session id — which is normal on
 * this dual-boot machine, where the same transcript exists under both a
 * `C--Users-…` and a `-home-…` directory. Guessing would rename or DELETE the
 * wrong copy, so we refuse and list the candidates instead.
 */
export function resolveSession(sessionId: string, encodedDir?: string | null, declaredStore?: DeclaredStoreLookup): ResolvedSession {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId.includes('..')) {
    throw new SessionMutationError(400, 'bad-session-id', `invalid sessionId ${JSON.stringify(sessionId)}`);
  }
  let dir = encodedDir?.trim() || null;
  if (!dir) {
    const dirs = findDirsForSession(sessionId);
    if (dirs.length === 0) throw new SessionMutationError(404, 'no-session', `no session file on disk for ${sessionId}`);
    if (dirs.length > 1) {
      throw new SessionMutationError(
        409,
        'ambiguous-dir',
        `session ${sessionId} exists under ${dirs.length} store dirs (${dirs.join(', ')}) — pass "dir" to say which. Refusing to guess: the wrong choice would mutate the wrong copy.`,
        { dirs },
      );
    }
    dir = dirs[0]!;
  }
  const filePath = hist.resolveSessionFile(dir, sessionId);
  if (!filePath) throw new SessionMutationError(404, 'no-session', `no session file for ${JSON.stringify(dir)}/${JSON.stringify(sessionId)}`);

  const meta = hist.readSessionMeta(filePath, dir);
  const cwd = meta?.cwd ?? null;
  if (!cwd) {
    throw new SessionMutationError(
      409,
      'no-cwd',
      `session ${sessionId} records no cwd, and the SDK's mutation APIs are addressed by cwd (their "dir" option). ` +
        `Decoding ${JSON.stringify(dir)} back to a path is lossy and could target a different project, so this is refused rather than guessed.`,
      { encodedDir: dir },
    );
  }
  /*
   * The SDK maps `dir` -> store directory with the same `[^a-zA-Z0-9] -> -`
   * encoding we do. If the file's own cwd does not encode back to the directory
   * it is sitting in — which happens to transcripts COPIED between installs —
   * then handing that cwd to the SDK would address a DIFFERENT directory. For a
   * rename that is a silent no-op on the wrong file; for a delete it is data
   * loss. Refuse.
   */
  const expected = hist.encodeCwd(cwd);
  if (expected !== dir) {
    /*
     * FEAT-155 — the one sanctioned mismatch: a DECLARED container store dir
     * (`-workspace-<id>`) holding a session that ran at bare `/workspace`. The
     * SDK is then addressed by the store's declared address, which encodes back
     * to this very dir — never by the recorded cwd (that would reach the shared
     * `-workspace`). Only accepted when (a) the owner declares the dir, (b) the
     * recorded cwd is one that store may hold, (c) the address really encodes to
     * the dir, and (d) the address does not resolve elsewhere on the host (the
     * SDK realpaths `dir` before encoding it, so a host symlink there would
     * redirect the mutation to another store).
     */
    const decl = declaredStore?.(dir) ?? null;
    if (decl && decl.recordedCwds.includes(cwd) && hist.encodeCwd(decl.address) === dir && !resolvesElsewhere(decl.address)) {
      return { sessionId, encodedDir: dir, filePath, cwd, sdkDir: decl.address };
    }
    throw new SessionMutationError(
      409,
      'encoding-mismatch',
      `session ${sessionId} lives in store dir ${JSON.stringify(dir)} but its recorded cwd ${JSON.stringify(cwd)} encodes to ${JSON.stringify(expected)}. ` +
        `The SDK addresses sessions by cwd, so mutating this one would target the wrong directory. Refused.`,
      { encodedDir: dir, cwd, encodesTo: expected },
    );
  }
  return { sessionId, encodedDir: dir, filePath, cwd, sdkDir: cwd };
}

/** True when `p` exists on the host and realpaths to something other than itself. */
function resolvesElsewhere(p: string): boolean {
  try {
    return fs.realpathSync(p) !== path.resolve(p);
  } catch {
    return false; // absent — the SDK falls back to the resolved path itself
  }
}

/* ---------------------------------------------------------------- mutations */

/** Rename via the SDK. Returns the meta as re-read from disk afterwards. */
export async function rename(target: ResolvedSession, title: string): Promise<TitleMeta> {
  // FEAT-154 r9: the SDK appends a title entry — ORCHARD's write, declared so it never reads as a running turn.
  await asOrchardWriteAsync(target.filePath, () => renameSession(target.sessionId, title, { dir: target.sdkDir }));
  invalidate(target.filePath);
  const after = readTitleMeta(target.filePath);
  if (after.customTitle !== title) {
    // Never report a rename we cannot see on disk.
    throw new SessionMutationError(
      500,
      'rename-not-persisted',
      `renameSession() returned successfully but re-reading ${target.filePath} shows customTitle=${JSON.stringify(after.customTitle)}, not ${JSON.stringify(title)}`,
      { filePath: target.filePath },
    );
  }
  return after;
}

/**
 * Pin / unpin via the SDK's native `tagSession`, so the pin lives in the real
 * session store and survives a dashboard data-dir reset or plain CLI use.
 *
 * THE STORE HAS ONE TAG SLOT. `tagSession(id, tag)` sets a single string, not a
 * set — so pinning a session that already carries some other tag would destroy
 * that tag, and unpinning a session tagged something else would clear a tag we
 * never set. Both are refused unless `force`.
 */
export async function setPinned(target: ResolvedSession, pinned: boolean, force = false): Promise<TitleMeta> {
  const before = readTitleMeta(target.filePath);
  if (pinned && before.tag && before.tag !== PIN_TAG && !force) {
    throw new SessionMutationError(
      409,
      'tag-occupied',
      `session ${target.sessionId} already carries the tag ${JSON.stringify(before.tag)}. The session store holds ONE tag per session, so pinning would destroy it. Retry with force to overwrite.`,
      { tag: before.tag },
    );
  }
  if (!pinned && before.tag && before.tag !== PIN_TAG && !force) {
    throw new SessionMutationError(
      409,
      'tag-not-pin',
      `session ${target.sessionId} is tagged ${JSON.stringify(before.tag)}, not ${JSON.stringify(PIN_TAG)} — unpinning would clear a tag this app did not set. Retry with force to clear it anyway.`,
      { tag: before.tag },
    );
  }
  if (!pinned && !before.tag) return before; // already unpinned; nothing to write

  // FEAT-154 r9: declared as ORCHARD's write (see rename above).
  await asOrchardWriteAsync(target.filePath, () => tagSession(target.sessionId, pinned ? PIN_TAG : null, { dir: target.sdkDir }));
  invalidate(target.filePath);
  const after = readTitleMeta(target.filePath);
  if (after.pinned !== pinned) {
    throw new SessionMutationError(
      500,
      'pin-not-persisted',
      `tagSession() returned successfully but re-reading ${target.filePath} shows tag=${JSON.stringify(after.tag)} (pinned=${after.pinned}), expected pinned=${pinned}`,
      { filePath: target.filePath },
    );
  }
  return after;
}

export interface DeleteReport {
  sessionId: string;
  encodedDir: string;
  filePath: string;
  backup: { path: string; bytes: number; sha256: string; verified: true };
  subagentBackup: { path: string; files: number } | null;
  fileBytes: number;
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Delete a session transcript — the most destructive thing this server can do.
 *
 * A byte-identical copy is taken FIRST and its sha256 compared against the
 * original before `deleteSession()` is allowed to run. If the copy does not
 * match, nothing is deleted. The subagent transcript subdirectory (which
 * `deleteSession` also removes) is copied too.
 */
export async function destroy(target: ResolvedSession): Promise<DeleteReport> {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '');
  const destDir = path.join(deletedSessionsDir(), target.encodedDir);
  const srcHash = sha256(target.filePath);
  const bak = backupFileTo(target.filePath, destDir, `${target.sessionId}-${stamp}.jsonl`);
  const bakHash = sha256(bak.path);
  if (bakHash !== srcHash || bak.bakBytes !== bak.srcBytes) {
    throw new SessionMutationError(
      500,
      'backup-mismatch',
      `refusing to delete ${target.sessionId}: the backup at ${bak.path} is not byte-identical to the original (${bak.srcBytes} bytes/${srcHash} vs ${bak.bakBytes} bytes/${bakHash})`,
      { backup: bak.path },
    );
  }

  // Subagent transcripts live in a sibling `<sessionId>/` directory that
  // deleteSession() removes as well, so they are backed up with the same rigour.
  let subagentBackup: DeleteReport['subagentBackup'] = null;
  const subDir = path.join(path.dirname(target.filePath), target.sessionId);
  try {
    if (fs.statSync(subDir).isDirectory()) {
      const dest = path.join(destDir, `${target.sessionId}-${stamp}-subagents`);
      ensureDir(destDir);
      fs.cpSync(subDir, dest, { recursive: true });
      subagentBackup = { path: dest, files: fs.readdirSync(dest, { recursive: true }).length };
    }
  } catch {
    /* no subagent dir — normal */
  }

  const fileBytes = bak.srcBytes;
  await deleteSession(target.sessionId, { dir: target.sdkDir });
  invalidate(target.filePath);
  if (fs.existsSync(target.filePath)) {
    throw new SessionMutationError(
      500,
      'delete-not-applied',
      `deleteSession() returned successfully but ${target.filePath} still exists`,
      { filePath: target.filePath, backup: bak.path },
    );
  }
  return {
    sessionId: target.sessionId,
    encodedDir: target.encodedDir,
    filePath: target.filePath,
    backup: { path: bak.path, bytes: bak.bakBytes, sha256: bakHash, verified: true },
    subagentBackup,
    fileBytes,
  };
}

/** Drop both metadata caches for a file we just mutated. */
function invalidate(filePath: string): void {
  cache.delete(filePath);
  hist.clearSessionCache();
}

/**
 * Was the most recent write to this file a metadata entry rather than a turn?
 *
 * "Live" is detected from the file's mtime, and rename/pin APPEND to the file —
 * so without this, renaming a session made it look live and the very next pin
 * on the same row came back 409. Reproduced.
 *
 * This is deliberately read off the FILE rather than remembered in a Map: an
 * in-memory marker is lost on restart, which is exactly how the bug came back
 * (pin, restart the server, unpin -> 409). A live conversation's newest line is
 * a user/assistant/system entry; only a rename or a tag leaves `custom-title`
 * or `tag` as the last thing in the file. If the CLI appends one more turn, the
 * last line changes and the session correctly reads live again.
 *
 * Used ONLY to unblock the append-only mutations. Delete does not consult it —
 * see the delete route.
 */
export function lastWriteWasMetadata(filePath: string): boolean {
  try {
    const st = fs.statSync(filePath);
    const want = Math.min(st.size, 64 * 1024);
    const fd = fs.openSync(filePath, 'r');
    let text: string;
    try {
      const buf = Buffer.alloc(want);
      fs.readSync(fd, buf, 0, want, st.size - want);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const last = text.split('\n').filter((l) => l.trim()).pop();
    if (!last) return false;
    const e = JSON.parse(last) as { type?: unknown };
    return e.type === 'custom-title' || e.type === 'tag';
  } catch {
    return false;
  }
}
