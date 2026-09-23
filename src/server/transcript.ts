/**
 * Tail reads and exact totals for session transcripts.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `session-history.readSession` (carried-over, not modifiable) always scans
 * FORWARD from byte 0 and stops at a 128 MiB budget. Measured on the user's real
 * 286 MB session (`-workspace/b933f622-…`):
 *
 *   offset=0       -> budgetExhausted:true, bytesRead 128.0 MiB
 *   offset=100000  -> 0 messages, scanned 23859, budgetExhausted:true, 350ms
 *
 * i.e. everything past ~128 MiB — including every recent message — was
 * unreachable at ANY offset. The newest message the route could serve was dated
 * 2026-06-29 while the file had been appended to long after.
 *
 * A backward scan from EOF fixes the common "show me the latest" case outright:
 * it is O(N) in the number of messages requested and completely independent of
 * file size, because it never touches the 285 MB it does not need.
 */
import * as fs from 'node:fs';

import type { TranscriptMessage } from '../lib/session-history.ts';
import { blocksOf, isMainThreadEntry, isMessageEntry, toMessage, type BuildOptions } from './jsonl.ts';

/** Backward read chunk. Big enough that a few hops cover most tails. */
const CHUNK = 1 << 20; // 1 MiB
/**
 * Per-CALL backward budget. With `startByte` scroll-up is O(page size), so this
 * only bounds a single hop; 256 MiB keeps even a from-EOF `?before=<deep index>`
 * able to reach anywhere in the 286 MB file rather than leaving a middle band
 * unreachable by either direction.
 */
const MAX_TAIL_BYTES = 256 * 1024 * 1024;

export interface TailOptions extends BuildOptions {
  /** Number of messages wanted. */
  limit: number;
  /**
   * Skip this many canonical messages from the very end before collecting.
   *
   * This is what makes backward SCROLL-UP work on files forward paging cannot
   * reach: `skip = total - K` collects the N messages ending just before
   * absolute index K, by a backward scan that never touches the front of the
   * file. On the 286 MB session the newest ~10,848 messages are unreachable by
   * ?offset at all, so this is the only correct way to page up through them.
   */
  skip?: number;
  /**
   * Begin the backward scan at this byte (exclusive) instead of EOF. Pass the
   * `blockStartByte` a previous page returned to make scroll-up O(page size)
   * regardless of how deep into the file you are — the flat-bytes fix for the
   * 286 MB case, where `?before=<index>` alone re-reads from EOF every page.
   */
  startByte?: number;
  /** Count subagent/meta entries too (subagent files are all sidechain). */
  includeMeta?: boolean;
  /** Predicate override; defaults to the main-thread filter. */
  entryFilter?: (e: Record<string, any>) => boolean;
  /**
   * Drop entries that produce no renderable block (tool_result-only turns).
   *
   * MUST match the route this is serving, or `?tail` and `?offset` disagree
   * about the same file. `readSession` — which backs the main transcript route —
   * KEEPS such entries, so the main tail passes false. The subagent reader in
   * subagents.ts drops them, so the subagent tail passes true. Verified both
   * ways against a full read of a real file.
   */
  requireRenderable?: boolean;
}

export interface TailResult {
  messages: TranscriptMessage[];
  /** Bytes actually read from the end of the file. */
  bytesRead: number;
  /** True when the scan hit MAX_TAIL_BYTES before collecting `limit` messages. */
  budgetExhausted: boolean;
  malformedLines: number;
  fileBytes: number;
  /**
   * Byte offset where the earliest returned message begins — a line boundary.
   * Feed it back as `startByte` for the next (older) page: O(page size), no
   * matter the depth. 0 once the front of the file is reached.
   */
  blockStartByte: number;
}

/**
 * Read the last `limit` messages by scanning BACKWARD from EOF.
 *
 * Chunks are read end-to-start and concatenated in front of the carry, so a
 * record split across a chunk boundary is reassembled rather than dropped. The
 * first (possibly partial) line of each chunk is held back as carry until the
 * next, earlier chunk arrives — except at byte 0, where it is by definition
 * complete.
 */
export function tailMessages(filePath: string, opts: TailOptions): TailResult {
  const limit = Math.min(2000, Math.max(1, Math.floor(opts.limit)));
  const skip = Math.max(0, Math.floor(opts.skip ?? 0));
  const keep = opts.entryFilter ?? ((e: Record<string, any>) => isMainThreadEntry(e, opts.includeMeta === true));

  const fd = fs.openSync(filePath, 'r');
  let fileBytes = 0;
  let bytesRead = 0;
  let malformed = 0;
  let skipped = 0;
  let budgetExhausted = false;
  /*
   * Newest-first, and blocks are built HERE rather than in a second pass.
   * Counting entries that merely pass `keep` over-counts: a tool_result-only
   * turn passes the filter but renders nothing, so `?tail=50` returned 35 on the
   * real file. The stop condition has to be "50 things the UI will draw".
   */
  const collected: { e: Record<string, any>; blocks: ReturnType<typeof blocksOf> }[] = [];

  let blockStartByte = 0;
  try {
    fileBytes = fs.fstatSync(fd).size;
    // startByte lets a caller resume backward from an earlier line boundary.
    const from = opts.startByte != null ? Math.max(0, Math.min(Math.floor(opts.startByte), fileBytes)) : fileBytes;
    let pos = from;
    blockStartByte = from;
    let carry = '';

    while (pos > 0 && collected.length < limit) {
      if (bytesRead >= MAX_TAIL_BYTES) {
        budgetExhausted = true;
        break;
      }
      const len = Math.min(CHUNK, pos, MAX_TAIL_BYTES - bytesRead);
      pos -= len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      bytesRead += len;

      // `carry` is the partial FRONT line of the later region; it continues
      // exactly where this chunk ends, so appending reconstructs that line.
      const text = buf.toString('utf8') + carry;
      const parts = text.split('\n');
      // File-byte start of each part. parts[0] begins at `pos`.
      const startBytes: number[] = new Array(parts.length);
      startBytes[0] = pos;
      for (let k = 1; k < parts.length; k++) startBytes[k] = startBytes[k - 1]! + Buffer.byteLength(parts[k - 1]!) + 1;
      // parts[0] is the tail of a line whose start is earlier in the file, unless
      // we are at byte 0 where it is whole.
      const firstComplete = pos > 0 ? 1 : 0;
      if (pos > 0) carry = parts[0]!;
      else carry = '';
      for (let i = parts.length - 1; i >= firstComplete && collected.length < limit; i--) {
        const line = parts[i]!;
        if (!line.trim()) continue;
        let e: Record<string, any>;
        try {
          e = JSON.parse(line);
        } catch {
          malformed++;
          continue;
        }
        if (!keep(e)) continue;
        const blocks = blocksOf(e, opts);
        if (blocks.length === 0 && opts.requireRenderable !== false) continue;
        // `skip` newest messages are discarded before collecting — the backward
        // equivalent of an offset, counted from the scan's start.
        if (skipped < skip) {
          skipped++;
          continue;
        }
        collected.push({ e, blocks });
        // The earliest collected message is the last one pushed, so this ends up
        // holding the start byte of messages[0].
        blockStartByte = startBytes[i]!;
      }
    }
    if (pos <= 0) blockStartByte = 0;
  } finally {
    fs.closeSync(fd);
  }

  // Emit oldest-first so ordering matches the paginated route.
  const messages: TranscriptMessage[] = [];
  for (let i = collected.length - 1; i >= 0; i--) {
    const { e, blocks } = collected[i]!;
    messages.push(toMessage(e, -1, blocks));
  }
  return { messages, bytesRead, budgetExhausted, malformedLines: malformed, fileBytes, blockStartByte };
}

/* --------------------------------------------------------- forward paging */

export interface ForwardOptions extends BuildOptions {
  offset: number;
  limit: number;
  includeMeta?: boolean;
  entryFilter?: (e: Record<string, any>) => boolean;
  /** Canonical space: renderable-filtered (default true). */
  requireRenderable?: boolean;
  /** Byte ceiling. 128 MiB by default, matching the historical forward budget. */
  maxBytes?: number;
}

export interface ForwardResult {
  messages: TranscriptMessage[];
  offset: number;
  /** Canonical messages seen while scanning (>= offset + messages.length). */
  scannedMessages: number;
  budgetExhausted: boolean;
  bytesRead: number;
  fileBytes: number;
  malformedLines: number;
}

const FORWARD_MAX_BYTES = 128 * 1024 * 1024;

/**
 * Forward page in the CANONICAL index space.
 *
 * This REPLACES `readSession` for the main transcript route. readSession counts
 * a different population — it keeps tool_result-only entries that render nothing
 * — so its indices (916 on the reproduced file) disagreed with the tail's
 * renderable indices (609). Sharing this reader's filter with `tailMessages` and
 * `countMessages` is what makes tail.index === forward.index === total's space:
 * one coordinate system, defined as "the messages the client actually lists".
 *
 * Keeps the 128 MiB budget so the honest "forward cannot reach the newest N
 * messages of a 286 MB file" boundary is preserved and reported, rather than
 * silently doing a multi-hundred-MB read per page.
 */
export function readForward(filePath: string, opts: ForwardOptions): ForwardResult {
  const offset = Math.max(0, Math.floor(opts.offset));
  const limit = Math.min(2000, Math.max(1, Math.floor(opts.limit)));
  const requireRenderable = opts.requireRenderable !== false;
  const keep = opts.entryFilter ?? ((e: Record<string, any>) => isMainThreadEntry(e, opts.includeMeta === true));
  const maxBytes = opts.maxBytes ?? FORWARD_MAX_BYTES;

  const st = fs.statSync(filePath);
  const fd = fs.openSync(filePath, 'r');
  const messages: TranscriptMessage[] = [];
  let scanned = 0; // canonical index counter
  let bytesRead = 0;
  let malformed = 0;
  let budgetExhausted = false;
  let carry = '';

  try {
    const buf = Buffer.alloc(CHUNK);
    while (bytesRead < st.size) {
      if (bytesRead >= maxBytes) {
        budgetExhausted = true;
        break;
      }
      const want = Math.min(CHUNK, st.size - bytesRead, maxBytes - bytesRead);
      const len = fs.readSync(fd, buf, 0, want, bytesRead);
      if (len <= 0) break;
      bytesRead += len;
      const parts = (carry + buf.toString('utf8', 0, len)).split('\n');
      carry = parts.pop() ?? '';
      for (const line of parts) {
        if (!line.trim()) continue;
        let e: Record<string, any>;
        try {
          e = JSON.parse(line);
        } catch {
          malformed++;
          continue;
        }
        if (!keep(e)) continue;
        const blocks = blocksOf(e, opts);
        if (blocks.length === 0 && requireRenderable) continue;
        const index = scanned++;
        if (index < offset) continue;
        if (messages.length < limit) messages.push(toMessage(e, index, blocks));
      }
      // Stop once the window is full AND we have seen one canonical message past
      // it (so an eventual `hasMore` computed against `total` is exact), without
      // reading the rest of a huge file.
      if (messages.length >= limit && scanned > offset + limit) break;
    }
    // Final carry (a file with no trailing newline, or the live tail).
    if (bytesRead >= st.size && carry.trim()) {
      try {
        const e = JSON.parse(carry);
        if (keep(e)) {
          const blocks = blocksOf(e, opts);
          if (!(blocks.length === 0 && requireRenderable)) {
            const index = scanned++;
            if (index >= offset && messages.length < limit) messages.push(toMessage(e, index, blocks));
          }
        }
      } catch {
        /* partial trailing line */
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  return { messages, offset, scannedMessages: scanned, budgetExhausted, bytesRead, fileBytes: st.size, malformedLines: malformed };
}

/* ------------------------------------------------- hook-failure roll-up */

/**
 * A quality gate (a Claude Code hook) can fail on EVERY turn and the transcript
 * records it — as a `type:"attachment"` line whose `attachment.type` is
 * `hook_non_blocking_error` — but that line is neither `user` nor `assistant`,
 * so every reader above filters it out and the UI shows the user nothing. A gate
 * whose failure is invisible is worse than no gate: it manufactures the
 * confidence it was installed to earn. So the fact is OWNED here, at the one full
 * scan the route already pays for (`countMessages`), and carried to the client
 * as a session-level roll-up rather than re-derived by any reader (ARCH-010).
 *
 * `crash` = the hook FAILED TO RUN at all (interpreter/loader/spawn failure:
 * module missing, ENOENT, exec-format, permission). This is the dangerous one —
 * the gate never executed. `reported` = the hook ran and exited non-zero with a
 * message of its own. The two are distinguished by the shape of stderr.
 */
export type HookErrorKind = 'crash' | 'reported';

/** One distinct (hook, event, kind, message) failure, with a turn count. */
export interface HookErrorGroup {
  hookName: string;
  hookEvent: string;
  kind: HookErrorKind;
  /** Short, human-legible error extracted from stderr/stdout. */
  message: string;
  exitCode: number | null;
  /** Number of turns this exact failure occurred on. */
  count: number;
}

/** A single occurrence, kept (capped) so the client can badge the owning turn. */
export interface HookErrorRef {
  parentUuid: string | null;
  hookName: string;
  hookEvent: string;
  kind: HookErrorKind;
  message: string;
  exitCode: number | null;
}

export interface HookErrorSummary {
  /** Total hook-failure records in the scanned span (turns affected overall). */
  totalRecords: number;
  crashRecords: number;
  reportedRecords: number;
  /** Distinct failures, most-frequent first. */
  groups: HookErrorGroup[];
  /** Per-occurrence refs for per-turn badges; capped for pathological sessions. */
  records: HookErrorRef[];
  recordsCapped: boolean;
}

/** How many per-occurrence refs we keep for badging before we stop growing. */
const HOOK_REF_CAP = 500;

/**
 * The hook process never ran — an interpreter/loader/spawn failure, as opposed
 * to a hook that ran and exited non-zero with its own message. These signatures
 * come from node's module loader, the shell, and exec(); a hook that merely
 * `process.exit(1)`s after printing prose matches none of them.
 */
const HOOK_CRASH_RX =
  /Cannot find module|MODULE_NOT_FOUND|ENOENT|command not found|No such file or directory|Exec format error|Permission denied|cannot execute|is not recognized as an internal or external command|Error \[ERR_MODULE_NOT_FOUND\]/i;

function classifyHookError(stderr: string, stdout: string): HookErrorKind {
  return HOOK_CRASH_RX.test(stderr) || HOOK_CRASH_RX.test(stdout) ? 'crash' : 'reported';
}

/** Pull one legible line out of a hook's output for display + grouping. */
function hookErrorMessage(att: Record<string, any>): string {
  const stderr = String(att?.stderr ?? '').trim();
  const stdout = String(att?.stdout ?? '').trim();
  const src = stderr || stdout;
  if (!src) {
    const cmd = String(att?.command ?? '').trim();
    return cmd || `hook exited ${att?.exitCode ?? '?'}`;
  }
  const lines = src.split('\n').map((s) => s.trim()).filter(Boolean);
  const pick =
    lines.find((l) => /Cannot find module|ERR_MODULE_NOT_FOUND/i.test(l)) ??
    lines.find((l) => /^Error:/i.test(l)) ??
    // Skip the generic wrapper header, node stack frames, and the caret line.
    lines.find((l) => !/^Failed with non-blocking status code/i.test(l) && !/^at /.test(l) && l !== '^') ??
    lines[0]!;
  return pick.length > 200 ? pick.slice(0, 200) + '…' : pick;
}

/** Mutable accumulator threaded through a single scan. */
interface HookAcc {
  total: number;
  crash: number;
  reported: number;
  groups: Map<string, HookErrorGroup>;
  records: HookErrorRef[];
  capped: boolean;
}

function newHookAcc(): HookAcc {
  return { total: 0, crash: 0, reported: 0, groups: new Map(), records: [], capped: false };
}

/**
 * If `line` is a hook-failure attachment, fold it into `acc`. Cheap-guarded by a
 * substring test so it costs a single `indexOf` on the > 99.9% of lines that are
 * ordinary messages — no parse, no allocation.
 */
function collectHookError(line: string, acc: HookAcc): void {
  if (line.indexOf('hook_non_blocking_error') === -1) return;
  let e: Record<string, any>;
  try {
    e = JSON.parse(line);
  } catch {
    return;
  }
  const att = e?.attachment;
  if (!att || att.type !== 'hook_non_blocking_error') return;

  const hookName = String(att.hookName ?? att.hookEvent ?? 'hook');
  const hookEvent = String(att.hookEvent ?? '');
  const exitCode = Number.isFinite(att.exitCode) ? Number(att.exitCode) : null;
  const kind = classifyHookError(String(att.stderr ?? ''), String(att.stdout ?? ''));
  const message = hookErrorMessage(att);

  acc.total++;
  if (kind === 'crash') acc.crash++;
  else acc.reported++;

  const key = `${hookName}\0${hookEvent}\0${kind}\0${message}`;
  const g = acc.groups.get(key);
  if (g) g.count++;
  else acc.groups.set(key, { hookName, hookEvent, kind, message, exitCode, count: 1 });

  if (acc.records.length < HOOK_REF_CAP) {
    acc.records.push({
      parentUuid: typeof e.parentUuid === 'string' ? e.parentUuid : null,
      hookName, hookEvent, kind, message, exitCode,
    });
  } else {
    acc.capped = true;
  }
}

function finishHookAcc(acc: HookAcc): HookErrorSummary {
  const groups = [...acc.groups.values()].sort((a, b) => b.count - a.count);
  return {
    totalRecords: acc.total,
    crashRecords: acc.crash,
    reportedRecords: acc.reported,
    groups,
    records: acc.records,
    recordsCapped: acc.capped,
  };
}

/* ------------------------------------------------------------------ totals */

interface CountEntry {
  size: number;
  mtimeMs: number;
  total: number;
  bytesScanned: number;
  isLowerBound: boolean;
  hookErrors: HookErrorSummary;
}

/**
 * Cache keyed on (size, mtimeMs). A transcript is append-only, so any change
 * moves both — a stale hit is not possible without the file being rewritten in
 * place at identical size and mtime.
 */
const countCache = new Map<string, CountEntry>();

/** Default ceiling for an exact count. 512 MiB covers the largest real file (286 MB). */
const COUNT_MAX_BYTES = 512 * 1024 * 1024;

export interface CountResult {
  total: number;
  /** True when the count stopped at the byte ceiling — `total` is then a floor. */
  isLowerBound: boolean;
  bytesScanned: number;
  cached: boolean;
  /**
   * Failed quality gates (hook_non_blocking_error) seen in the same single scan.
   * Empty in the healthy case, so a reader can `if (hookErrors.totalRecords)`.
   */
  hookErrors: HookErrorSummary;
}

/**
 * Does this raw line count as one message the API will hand back?
 *
 * `renderable` is the subtle half. Counting entries that merely pass the type
 * filter over-counts: a tool_result-only user turn is a real entry but produces
 * no blocks at the default `tools=0`, so it is never returned. Counting those
 * made the subagent route report total=30 against a full read of 21 — the same
 * "the header disagrees with the list" bug already fixed once between the
 * subagent summary and its transcript. `total` must mean what the client will
 * actually receive.
 */
// Exported for search's locate(): mapping a matched line to its canonical
// index MUST use this exact predicate, or search deep-links land off-by-N.
export function countable(line: string, keep: (e: Record<string, any>) => boolean, opts: { includeToolResults?: boolean; requireRenderable?: boolean }): boolean {
  if (!line.trim()) return false;
  // Cheap prefilter: skip JSON.parse for lines that cannot possibly qualify.
  if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) return false;
  let e: Record<string, any>;
  try {
    e = JSON.parse(line);
  } catch {
    return false; // malformed, or a partial trailing line mid-write
  }
  if (!keep(e)) return false;
  if (opts.requireRenderable === false) return true;
  return blocksOf(e, { maxTextChars: 1, includeToolResults: opts.includeToolResults === true }).length > 0;
}

/**
 * Exact number of messages in a transcript.
 *
 * Streams the file once and counts entries with the SAME predicate the routes
 * use, so `total` and `scannedMessages` agree rather than being two different
 * numbers the client has to reconcile. Cached per (path, size, mtime) so the
 * cost is paid once per append, not once per request.
 *
 * `isLowerBound` is set — never silently — if the ceiling is hit.
 */
export function countMessages(
  filePath: string,
  opts: { includeMeta?: boolean; entryFilter?: (e: Record<string, any>) => boolean; maxBytes?: number; cacheKeySuffix?: string; includeToolResults?: boolean; requireRenderable?: boolean } = {},
): CountResult {
  const st = fs.statSync(filePath);
  const key = `${filePath}\0${opts.cacheKeySuffix ?? ''}\0${opts.includeToolResults === true ? 'tools' : ''}\0${opts.requireRenderable === false ? 'all' : ''}`;
  const hit = countCache.get(key);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
    return { total: hit.total, isLowerBound: hit.isLowerBound, bytesScanned: hit.bytesScanned, cached: true, hookErrors: hit.hookErrors };
  }

  const keep = opts.entryFilter ?? ((e: Record<string, any>) => isMainThreadEntry(e, opts.includeMeta === true));
  const maxBytes = opts.maxBytes ?? COUNT_MAX_BYTES;
  const fd = fs.openSync(filePath, 'r');
  let total = 0;
  let scanned = 0;
  let carry = '';
  let isLowerBound = false;
  // Folded into this ONE full scan — the failed-gate roll-up costs a single
  // indexOf on lines that are not hook attachments (see collectHookError).
  const hookAcc = newHookAcc();
  try {
    const buf = Buffer.alloc(CHUNK);
    while (scanned < st.size) {
      if (scanned >= maxBytes) {
        isLowerBound = true;
        break;
      }
      const len = fs.readSync(fd, buf, 0, Math.min(CHUNK, st.size - scanned), scanned);
      if (len <= 0) break;
      scanned += len;
      const text = carry + buf.toString('utf8', 0, len);
      const parts = text.split('\n');
      carry = parts.pop() ?? '';
      for (const line of parts) {
        if (countable(line, keep, opts)) total++;
        collectHookError(line, hookAcc);
      }
    }
    if (carry.trim()) {
      if (countable(carry, keep, opts)) total++;
      collectHookError(carry, hookAcc);
    }
  } finally {
    fs.closeSync(fd);
  }

  const hookErrors = finishHookAcc(hookAcc);
  const entry: CountEntry = { size: st.size, mtimeMs: st.mtimeMs, total, bytesScanned: scanned, isLowerBound, hookErrors };
  // Bounded: this map would otherwise grow once per session file ever viewed.
  if (countCache.size > 256) countCache.clear();
  countCache.set(key, entry);
  return { total, isLowerBound, bytesScanned: scanned, cached: false, hookErrors };
}

/** Predicate for subagent files: every entry there is sidechain by design. */
export const subagentEntryFilter = (e: Record<string, any>): boolean => isMessageEntry(e);

export function clearTranscriptCaches(): void {
  countCache.clear();
}
