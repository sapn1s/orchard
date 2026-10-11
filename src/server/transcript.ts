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
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

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
  /**
   * BUG-245 r3 (F2) — the count's SNAPSHOT. When given, the backward read never
   * starts past `snapshot.fileBytes`, so `base = total - len` labels exactly the
   * prefix the count counted; bytes appended after the count arrive through the
   * follow/catch-up path instead of being mislabelled here. The tail re-checks its
   * OWN descriptor against the snapshot (same inode, not shorter, boundary window
   * unchanged) and reports `snapshotMismatch` on a replace/truncate between the two
   * opens, so the caller re-counts rather than labelling a different file.
   */
  snapshot?: CountSnapshot;
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
  /** BUG-245 r3 (F2): the file is no longer the one `opts.snapshot` counted — re-count. */
  snapshotMismatch: boolean;
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
  let snapshotMismatch = false;
  try {
    const st = fs.fstatSync(fd);
    fileBytes = st.size;
    const snap = opts.snapshot;
    if (snap) {
      if (st.ino !== snap.ino || st.dev !== snap.dev || st.size < snap.fileBytes || !snapshotBoundaryHolds(fd, snap)) {
        snapshotMismatch = true;
      } else {
        fileBytes = snap.fileBytes; // the counted prefix IS the file, for this read
      }
    }
    // startByte lets a caller resume backward from an earlier line boundary.
    const from = opts.startByte != null ? Math.max(0, Math.min(Math.floor(opts.startByte), fileBytes)) : fileBytes;
    let pos = from;
    blockStartByte = from;
    // BUG-190 round 4 sibling: the carry is BYTES. Chunks are read end-to-start,
    // so a chunk boundary can fall inside a multi-byte character; decoding each
    // chunk alone turned it into U+FFFD on both sides (3 of 4 offsets on a real
    // emoji line). Lines are cut on the newline byte and decoded whole.
    let carry: Buffer = Buffer.alloc(0);

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
      const joined = carry.length ? Buffer.concat([buf, carry]) : buf;
      // Byte ranges of each newline-separated part; parts[0] begins at `pos`.
      const bounds: [number, number][] = [];
      for (let from = 0; ; ) {
        const nl = joined.indexOf(0x0a, from);
        if (nl < 0) { bounds.push([from, joined.length]); break; }
        bounds.push([from, nl]);
        from = nl + 1;
      }
      const startBytes: number[] = bounds.map(([a]) => pos + a);
      // parts[0] is the tail of a line whose start is earlier in the file, unless
      // we are at byte 0 where it is whole.
      const firstComplete = pos > 0 ? 1 : 0;
      carry = pos > 0 ? Buffer.from(joined.subarray(bounds[0]![0], bounds[0]![1])) : Buffer.alloc(0);
      for (let i = bounds.length - 1; i >= firstComplete && collected.length < limit; i--) {
        const line = joined.subarray(bounds[i]![0], bounds[i]![1]).toString('utf8');
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
    // BUG-190 round 3: only when the scan ran out of FILE before it filled the
    // page. A small file is read to byte 0 in one chunk even when the page filled
    // long before its start; zeroing the cursor then told the next backward page
    // "nothing older" (beforeBytes=0 → 0 messages) and silently dropped the rest.
    if (pos <= 0 && collected.length < limit) blockStartByte = 0;
  } finally {
    fs.closeSync(fd);
  }

  // Emit oldest-first so ordering matches the paginated route.
  const messages: TranscriptMessage[] = [];
  for (let i = collected.length - 1; i >= 0; i--) {
    const { e, blocks } = collected[i]!;
    messages.push(toMessage(e, -1, blocks));
  }
  return { messages, bytesRead, budgetExhausted, malformedLines: malformed, fileBytes, blockStartByte, snapshotMismatch };
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
  const fwdDecoder = new StringDecoder('utf8');

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
      // BUG-190 round 4 sibling: a streaming decoder, so a multi-byte character
      // split across two chunks decodes whole instead of as U+FFFD on each side.
      const parts = (carry + fwdDecoder.write(buf.subarray(0, len))).split('\n');
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
    if (bytesRead >= st.size) carry += fwdDecoder.end();
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

/**
 * Detached snapshot of an accumulator. Group objects are DEEP-copied and the
 * records array is sliced, so a returned summary can never alias — and a later
 * `collectHookError` on a checkpoint accumulator can never mutate — a summary
 * already handed to a caller (critique #5).
 */
function finishHookAcc(acc: HookAcc): HookErrorSummary {
  const groups = [...acc.groups.values()].map((g) => ({ ...g })).sort((a, b) => b.count - a.count);
  return {
    totalRecords: acc.total,
    crashRecords: acc.crash,
    reportedRecords: acc.reported,
    groups,
    records: acc.records.slice(),
    recordsCapped: acc.capped,
  };
}

/**
 * Deep-copy a live accumulator so it can be extended (a delta scan, or folding a
 * provisional trailing line) without touching the original — the checkpoint's
 * committed accumulator must survive a returned summary and a failed delta.
 */
function cloneHookAcc(a: HookAcc): HookAcc {
  const groups = new Map<string, HookErrorGroup>();
  for (const [k, g] of a.groups) groups.set(k, { ...g });
  return { total: a.total, crash: a.crash, reported: a.reported, groups, records: a.records.slice(), capped: a.capped };
}

/* ------------------------------------------------------------------ totals */

/*
 * BUG-245 — THE COUNT IS A RESUMABLE LEFT FOLD (r3 redesign, "B on C").
 *
 * `countMessages` is the single owner of a transcript's total / isLowerBound /
 * hook-error roll-up (ARCH-010): the tail, forward and subagent routes and the
 * watcher's follow-seed all READ it. The state of the fold after byte P — where P
 * is just past a newline — is `{ lastNlPos: P, committedTotal, committedAcc }`.
 * Only newline-terminated lines are ever committed and the trailing unterminated
 * line is never part of the state, so folding `[0, P)` then `[P, end)` is the same
 * computation as folding `[0, end)`: a delta ("warm") count equals a fresh full
 * ("cold") count BY CONSTRUCTION, for any newline-aligned resume point.
 *
 * That invariant is what the two r2 breaks violated, and why the fix is the
 * invariant rather than a third boundary patch:
 *  - the byte CEILING is an absolute OFFSET in the file (`limit = min(size,
 *    maxBytes)`), never a per-scan budget — r2's delta re-applied it per scan, so
 *    an append across 512 MiB counted bytes a cold scan never reads (F1);
 *  - the tail route labels its page with `base = total - len`, which is only true
 *    if the tail reads the SAME prefix the count folded — the count returns its
 *    snapshot and the tail is clamped to it (F2, `CountSnapshot`);
 *  - the fold state survives a restart / cache eviction through a validated,
 *    code-versioned sidecar, so a cold open of a previously-indexed session is a
 *    delta too (F3, `enableCountPersistence`).
 *
 * SUPPORTED CONTRACT (BUG-245 r2 RESCOPE, unchanged). Resuming a fold trusts that
 * `[0, lastNlPos)` is unchanged. That is verified, not assumed, for every real
 * writer: the CLI only appends; a compaction rewrites from the head and changes
 * size; /rewind, truncation and the retention sweep change size or delete;
 * fork/codex-import and the FEAT-144 mirror re-snapshot via temp+rename (new
 * inode); SDK rename/tag and the mirror append (BUG-245 activity log, r2). The
 * guard is identity (dev+ino) + size/mtime + a HEAD window `[0,W)` + a BOUNDARY
 * window `[lastNlPos-W, lastNlPos)`. An O(1) fingerprint cannot prove an O(n)
 * prefix, so a same-length edit strictly between the windows is undetected — the
 * accepted out-of-contract residual (clean-room 01a121a2); no real writer does it.
 * This is the same assumption the pre-BUG-245 (size,mtime) cache already made.
 */

interface FoldCheckpoint {
  /** Byte just past the last newline folded — the resume point. */
  lastNlPos: number;
  committedTotal: number;
  /** Carry-EXCLUSIVE accumulator; never handed out (see finishHookAcc/cloneHookAcc). */
  committedAcc: HookAcc;
  headLen: number;
  /** sha256 of `[0, headLen)` — a compaction rewrites the head. */
  headHash: string;
  boundLen: number;
  /** sha256 of `[lastNlPos - boundLen, lastNlPos)` — the bytes an append extends. */
  boundHash: string;
}

interface CountEntry {
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  /** Finished, carry-INCLUSIVE roll-up — returned verbatim on an unchanged-file hit. */
  total: number;
  isLowerBound: boolean;
  hookErrors: HookErrorSummary;
  /** Fold state at the last newline before `min(size, maxBytes)`; null if the scan was cut short. */
  checkpoint: FoldCheckpoint | null;
}

/**
 * In-memory fold states keyed on (path, counting options, ceiling). Bounded LRU —
 * the old `clear()` at 257 entries dropped every warm session at once and forced
 * each one back to a full scan. With persistence on, an evicted entry reloads
 * from its sidecar instead.
 */
const countCache = new Map<string, CountEntry>();
const COUNT_CACHE_MAX = 256;

/** Default ceiling for an exact count. 512 MiB covers the largest real file (286 MB). */
const COUNT_MAX_BYTES = 512 * 1024 * 1024;

/** Fingerprint window size (head + boundary). See the contract above. */
const COUNT_FINGERPRINT_BYTES = 4096;

/** Read `len` bytes at `offset` from an open fd (clamped). Short read → shorter Buffer. */
function readWindow(fd: number, offset: number, len: number): Buffer {
  if (len <= 0) return Buffer.alloc(0);
  const b = Buffer.alloc(len);
  const n = fs.readSync(fd, b, 0, len, offset);
  return n === len ? b : b.subarray(0, Math.max(0, n));
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** Does the fd still hold the checkpoint's head + boundary bytes? */
function checkpointHolds(fd: number, cp: FoldCheckpoint, size: number): boolean {
  if (cp.lastNlPos > size || cp.headLen > size) return false;
  const head = readWindow(fd, 0, cp.headLen);
  if (head.length !== cp.headLen || sha(head) !== cp.headHash) return false;
  const bound = readWindow(fd, cp.lastNlPos - cp.boundLen, cp.boundLen);
  return bound.length === cp.boundLen && sha(bound) === cp.boundHash;
}

interface ScanOut {
  committedTotal: number;
  acc: HookAcc;
  lastNlPos: number;
  carry: string;
  bytesRead: number;
  /** The scan read every byte up to its limit (no short read). */
  reachedLimit: boolean;
}

/**
 * Fold `[startByte, limit)` of an open fd onto `(seedTotal, acc)`. `limit` is an
 * ABSOLUTE file offset (the caller passes `min(size, maxBytes)`), so a delta and a
 * full scan stop at the same byte. Tracks `lastNlPos` off the RAW buffer — 0x0a is
 * a single byte never inside a multi-byte character — and returns the trailing
 * `carry` (bytes after the last newline) for the caller to treat as provisional.
 */
function runScan(
  fd: number, startByte: number, limit: number,
  keep: (e: Record<string, any>) => boolean,
  opts: { includeToolResults?: boolean; requireRenderable?: boolean },
  seedTotal: number, acc: HookAcc,
): ScanOut {
  let committedTotal = seedTotal;
  let lastNlPos = startByte;
  let carry = '';
  const dec = new StringDecoder('utf8');
  let pos = startByte;
  const buf = Buffer.alloc(CHUNK);
  while (pos < limit) {
    const len = fs.readSync(fd, buf, 0, Math.min(CHUNK, limit - pos), pos);
    if (len <= 0) break;
    const lastNlInChunk = buf.subarray(0, len).lastIndexOf(0x0a); // BUG-190 r4 sibling: 0x0a is a clean byte boundary
    const chunkStart = pos;
    pos += len;
    const text = carry + dec.write(buf.subarray(0, len));
    const parts = text.split('\n');
    carry = parts.pop() ?? '';
    for (const line of parts) {
      if (countable(line, keep, opts)) committedTotal++;
      collectHookError(line, acc);
    }
    if (lastNlInChunk >= 0) lastNlPos = chunkStart + lastNlInChunk + 1;
  }
  const reachedLimit = pos >= limit;
  carry += dec.end();
  return { committedTotal, acc, lastNlPos, carry, bytesRead: pos - startByte, reachedLimit };
}

/**
 * The exact byte prefix a count folded (BUG-245 r3, F2). A reader that labels
 * messages from this count must read THIS prefix — see `TailOptions.snapshot`.
 */
export interface CountSnapshot {
  fileBytes: number;
  dev: number;
  ino: number;
  /**
   * BUG-245 r3 Gap 1 — window at the END of the counted prefix,
   * `[endOffset, endOffset + endLen)` ending at `fileBytes` (empty for an empty
   * file). It ends at `fileBytes`, NOT at the fold's last newline: the count also
   * counts a trailing complete-JSON line with no newline (the carry), and a window
   * stopping at the last newline left that carry unprotected — a truncate-to-the-
   * last-newline-then-regrow between the count and the tail slipped past the
   * re-check and mislabelled the page (clean-room 8a282a45b7c7). Covering the
   * carry forces a re-count on any change to the counted prefix's tail.
   */
  endOffset: number;
  endLen: number;
  endHash: string;
}

/** Re-check, on the READER's own fd, that the snapshot's end-of-prefix bytes are still there. */
function snapshotBoundaryHolds(fd: number, snap: CountSnapshot): boolean {
  if (snap.endLen === 0) return true;
  const b = readWindow(fd, snap.endOffset, snap.endLen);
  return b.length === snap.endLen && sha(b) === snap.endHash;
}

export interface CountResult {
  total: number;
  /** True when the file is larger than the byte ceiling — `total` is then a floor. */
  isLowerBound: boolean;
  bytesScanned: number;
  cached: boolean;
  /**
   * Failed quality gates (hook_non_blocking_error) seen in the same single scan.
   * Empty in the healthy case, so a reader can `if (hookErrors.totalRecords)`.
   */
  hookErrors: HookErrorSummary;
  /** The prefix this count describes (BUG-245 r3, F2). */
  snapshot: CountSnapshot;
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

/* ------------------------------------------------- persisted fold state (F3) */

/**
 * BUG-245 r3 (F3). A cold server (restart, or an LRU eviction) used to re-fold a
 * whole session — 249 ms on the user's 53 MiB session, ~2.3 s on the 286 MiB one —
 * before the first message painted. The fold state is now persisted per (file,
 * options) and resumed after validation, so a cold open of a session that has
 * EVER been counted is a delta.
 *
 * OFF unless the server enables it (`enableCountPersistence`), so importing this
 * module (tests, scripts, search) never writes into anyone's data dir.
 *
 * A persisted state is accepted only if ALL hold, else the count is a full scan —
 * persistence can cost performance, never correctness beyond the contract above:
 *  - format version and CODE HASH match. The code hash covers every module that
 *    defines what a counted line or a hook error IS (this file, jsonl.ts,
 *    session-history.ts), so a deploy that changes the counting semantics
 *    invalidates every sidecar: a persisted count can never outlive the code that
 *    defined it (the one risk persistence adds over the deploy-reset memory cache);
 *  - same path, options key and ceiling; same dev+ino;
 *  - size grew, or is equal with an equal mtime;
 *  - the head and boundary windows re-read from the CURRENT fd hash the same.
 * Writes are tmp(pid+random)+rename, so a crash or a concurrent writer leaves
 * either the old or the new whole file, never a torn one (a torn/unparseable file
 * is a full scan anyway). The directory is LRU-capped and swept of stale tmps.
 */
const SIDECAR_VERSION = 1;
const SIDECAR_MAX_FILES = 512;
const SIDECAR_TMP_STALE_MS = 60 * 60 * 1000;
let sidecarDir: string | null = null;
let sidecarWrites = 0;

const COUNT_CODE_HASH: string | null = (() => {
  try {
    const h = createHash('sha256');
    for (const rel of ['./transcript.ts', './jsonl.ts', '../lib/session-history.ts']) {
      h.update(rel).update('\0').update(fs.readFileSync(new URL(rel, import.meta.url)));
    }
    return h.digest('hex');
  } catch {
    return null; // sources unreadable → persistence stays off (never guess a version)
  }
})();

/** Turn persistence on (server boot) or off (`null`). Sweeps the directory once. */
export function enableCountPersistence(dir: string | null): void {
  sidecarDir = dir && COUNT_CODE_HASH ? dir : null;
  if (!sidecarDir) return;
  try {
    fs.mkdirSync(sidecarDir, { recursive: true, mode: 0o700 });
    sweepSidecars();
  } catch {
    sidecarDir = null;
  }
}

const sidecarPath = (key: string): string =>
  path.join(sidecarDir!, `${createHash('sha256').update(key).digest('hex').slice(0, 40)}.json`);

interface SidecarV1 {
  v: number;
  codeHash: string;
  key: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  cp: Omit<FoldCheckpoint, 'committedAcc'> & {
    acc: { total: number; crash: number; reported: number; groups: [string, HookErrorGroup][]; records: HookErrorRef[]; capped: boolean };
  };
}

function loadSidecar(key: string): { size: number; mtimeMs: number; dev: number; ino: number; checkpoint: FoldCheckpoint } | null {
  if (!sidecarDir) return null;
  let j: SidecarV1;
  try {
    j = JSON.parse(fs.readFileSync(sidecarPath(key), 'utf8'));
  } catch {
    return null;
  }
  try {
    if (j.v !== SIDECAR_VERSION || j.codeHash !== COUNT_CODE_HASH || j.key !== key) return null;
    const { acc, ...rest } = j.cp;
    const nums = [j.dev, j.ino, j.size, j.mtimeMs, rest.lastNlPos, rest.committedTotal, rest.headLen, rest.boundLen, acc.total, acc.crash, acc.reported];
    if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) return null;
    if (typeof rest.headHash !== 'string' || typeof rest.boundHash !== 'string' || !Array.isArray(acc.groups) || !Array.isArray(acc.records)) return null;
    const groups = new Map<string, HookErrorGroup>();
    for (const [k, g] of acc.groups) groups.set(k, { ...g });
    return {
      size: j.size, mtimeMs: j.mtimeMs, dev: j.dev, ino: j.ino,
      checkpoint: { ...rest, committedAcc: { total: acc.total, crash: acc.crash, reported: acc.reported, groups, records: acc.records.slice(), capped: acc.capped === true } },
    };
  } catch {
    return null;
  }
}

function saveSidecar(key: string, e: CountEntry): void {
  if (!sidecarDir || !e.checkpoint || !COUNT_CODE_HASH) return;
  const { committedAcc: a, ...rest } = e.checkpoint;
  const body: SidecarV1 = {
    v: SIDECAR_VERSION, codeHash: COUNT_CODE_HASH, key,
    dev: e.dev, ino: e.ino, size: e.size, mtimeMs: e.mtimeMs,
    cp: { ...rest, acc: { total: a.total, crash: a.crash, reported: a.reported, groups: [...a.groups], records: a.records, capped: a.capped } },
  };
  const dest = sidecarPath(key);
  const tmp = `${dest}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
    fs.renameSync(tmp, dest);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    return;
  }
  if (++sidecarWrites % 64 === 0) sweepSidecars();
}

/** LRU-cap the directory by mtime and drop stale tmps (a crash between write and rename). */
function sweepSidecars(): void {
  if (!sidecarDir) return;
  try {
    const now = Date.now();
    const live: { f: string; m: number }[] = [];
    for (const name of fs.readdirSync(sidecarDir)) {
      const f = path.join(sidecarDir, name);
      let m: number;
      try { m = fs.statSync(f).mtimeMs; } catch { continue; }
      if (name.endsWith('.tmp')) { if (now - m > SIDECAR_TMP_STALE_MS) { try { fs.unlinkSync(f); } catch { /* raced */ } } continue; }
      if (name.endsWith('.json')) live.push({ f, m });
    }
    if (live.length <= SIDECAR_MAX_FILES) return;
    live.sort((x, y) => x.m - y.m);
    for (const { f } of live.slice(0, live.length - SIDECAR_MAX_FILES)) { try { fs.unlinkSync(f); } catch { /* raced */ } }
  } catch {
    /* a sweep failure costs disk, never correctness */
  }
}

/**
 * Exact number of messages in a transcript.
 *
 * Folds the file with the SAME predicate the routes use, so `total` and
 * `scannedMessages` agree rather than being two different numbers the client
 * has to reconcile. An unchanged file is answered from memory; a grown one is
 * folded over only its appended bytes (from memory or a validated sidecar); any
 * other change is a full scan.
 *
 * `isLowerBound` is set — never silently — when the file exceeds the ceiling.
 */
export function countMessages(
  filePath: string,
  opts: { includeMeta?: boolean; entryFilter?: (e: Record<string, any>) => boolean; maxBytes?: number; cacheKeySuffix?: string; includeToolResults?: boolean; requireRenderable?: boolean } = {},
): CountResult {
  // Open FIRST, then fstat THAT descriptor (r1 critique #3): the identity we key
  // and the bytes we fold are one consistent snapshot.
  const fd = fs.openSync(filePath, 'r');
  try {
    const st = fs.fstatSync(fd);
    const size = st.size;
    const maxBytes = opts.maxBytes ?? COUNT_MAX_BYTES;
    // Every input that changes the fold's result is in the key (r3 critique #4:
    // the ceiling and includeMeta were missing). An `entryFilter` without a
    // `cacheKeySuffix` is an anonymous predicate: memory-cached as before, never
    // persisted (its identity cannot be named across processes).
    const key = [filePath, opts.cacheKeySuffix ?? '', opts.includeToolResults === true ? 'tools' : '',
      opts.requireRenderable === false ? 'all' : '', opts.includeMeta === true ? 'meta' : '', String(maxBytes)].join('\0');
    const persistable = !opts.entryFilter || opts.cacheKeySuffix != null;
    const limit = Math.min(size, maxBytes);
    const W = COUNT_FINGERPRINT_BYTES;

    let hit = countCache.get(key);
    if (hit) { countCache.delete(key); countCache.set(key, hit); } // LRU touch
    const sameId = (e: { dev: number; ino: number }) => e.dev === st.dev && e.ino === st.ino;

    // BUG-245 r3 Gap 1 — hash the END of the counted prefix `[size-W, size)`, so the
    // tail's re-check covers the trailing carry (a complete-JSON line with no newline)
    // the count counted, not just the bytes up to the last newline.
    const snapshotOf = (): CountSnapshot => {
      const endLen = Math.min(size, W);
      const end = readWindow(fd, size - endLen, endLen);
      return { fileBytes: size, dev: st.dev, ino: st.ino, endOffset: size - endLen, endLen: end.length, endHash: sha(end) };
    };

    // Unchanged file: the stored carry-inclusive result, no read at all.
    if (hit && hit.size === size && hit.mtimeMs === st.mtimeMs && sameId(hit)) {
      return { total: hit.total, isLowerBound: hit.isLowerBound, bytesScanned: 0, cached: true, hookErrors: hit.hookErrors, snapshot: snapshotOf() };
    }

    // A resumable prior fold state: memory first, else the validated sidecar.
    let prior: { size: number; mtimeMs: number; dev: number; ino: number; checkpoint: FoldCheckpoint | null } | null = hit ?? null;
    if (!prior && persistable) prior = loadSidecar(key);

    let seedTotal = 0;
    let acc = newHookAcc();
    let startByte = 0;
    if (
      prior && prior.checkpoint && sameId(prior) &&
      (size > prior.size || (size === prior.size && prior.mtimeMs === st.mtimeMs)) &&
      prior.checkpoint.lastNlPos <= limit &&
      checkpointHolds(fd, prior.checkpoint, size)
    ) {
      seedTotal = prior.checkpoint.committedTotal;
      acc = cloneHookAcc(prior.checkpoint.committedAcc); // a failed/partial fold must not corrupt the stored base
      startByte = prior.checkpoint.lastNlPos;
    }

    const scan = runScan(fd, startByte, limit, entryPredicate(opts), opts, seedTotal, acc);
    const isLowerBound = size > maxBytes;

    // The trailing (unterminated) line is PROVISIONAL: counted into the returned
    // total only when the WHOLE file was read (a line cut by the ceiling is never
    // counted — the same rule a fresh scan applies), and folded into a CLONE so the
    // checkpoint stays carry-exclusive.
    let total = scan.committedTotal;
    let returnAcc = scan.acc;
    if (scan.reachedLimit && !isLowerBound && scan.carry.trim()) {
      if (countable(scan.carry, entryPredicate(opts), opts)) total++;
      returnAcc = cloneHookAcc(scan.acc);
      collectHookError(scan.carry, returnAcc);
    }
    const hookErrors = finishHookAcc(returnAcc);

    // A fold that read every byte up to its limit is a valid resume point — also
    // past the ceiling: `[0, maxBytes)` cannot change under the contract, so a
    // grown >512 MiB session re-reads only its last partial line, not 512 MiB.
    let checkpoint: FoldCheckpoint | null = null;
    if (scan.reachedLimit) {
      const head = readWindow(fd, 0, Math.min(size, W));
      const bLen = Math.min(scan.lastNlPos, W);
      const bound = readWindow(fd, scan.lastNlPos - bLen, bLen);
      if (head.length === Math.min(size, W) && bound.length === bLen) {
        checkpoint = {
          lastNlPos: scan.lastNlPos, committedTotal: scan.committedTotal, committedAcc: scan.acc,
          headLen: head.length, headHash: sha(head), boundLen: bLen, boundHash: sha(bound),
        };
      }
    }
    const entry: CountEntry = { size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino, total, isLowerBound, hookErrors, checkpoint };
    countCache.delete(key);
    countCache.set(key, entry);
    while (countCache.size > COUNT_CACHE_MAX) countCache.delete(countCache.keys().next().value!);
    if (persistable) saveSidecar(key, entry);
    return { total, isLowerBound, bytesScanned: scan.bytesRead, cached: false, hookErrors, snapshot: snapshotOf() };
  } finally {
    fs.closeSync(fd);
  }
}

/** The entry predicate a count/tail uses for these options. */
function entryPredicate(opts: { includeMeta?: boolean; entryFilter?: (e: Record<string, any>) => boolean }): (e: Record<string, any>) => boolean {
  return opts.entryFilter ?? ((e: Record<string, any>) => isMainThreadEntry(e, opts.includeMeta === true));
}

/**
 * BUG-245 r3 (F2) — count, then tail the SAME prefix. `mkTail` builds the tail
 * options from the count (skip/before need the total). If the file was replaced
 * or truncated between the count and the tail's open (`snapshotMismatch`), the
 * pair is re-taken, so a page is never labelled from a different file's count.
 * Appends after the count are not a mismatch: the tail is clamped to the counted
 * prefix and the newer bytes arrive through follow/catch-up.
 */
export function countThenTail<T>(
  filePath: string,
  countOpts: Parameters<typeof countMessages>[1],
  mkTail: (counted: CountResult) => { tail: TailOptions; extra: T },
): { counted: CountResult; tail: TailResult; extra: T; raced: boolean } {
  for (let attempt = 0; ; attempt++) {
    const counted = countMessages(filePath, countOpts);
    const { tail: tOpts, extra } = mkTail(counted);
    const tail = tailMessages(filePath, { ...tOpts, snapshot: counted.snapshot });
    if (!tail.snapshotMismatch) return { counted, tail, extra, raced: false };
    if (attempt >= 2) return { counted, tail, extra, raced: true };
  }
}

/**
 * BUG-245 r3 Gap 2 — label a backward (tail / ?before) page with ABSOLUTE
 * indices. The block sits at `[before - len, before)` in canonical space, so the
 * base is `before - len` and `index = base + i`.
 *
 * BUT when the count is a LOWER BOUND — the file is past the 512 MiB ceiling, so
 * the count stopped counting before it reached the bytes this tail read from EOF —
 * `before` is itself a floor and `base = before - len` would hand the NEWEST
 * messages an absolute index the count never reached, silently colliding with the
 * early messages that really hold those numbers. The r3 decision is to NEVER hide
 * content past the ceiling, but we also refuse to fabricate an index for it: each
 * such message gets `index = NaN`, which serialises to JSON `null`, so the client
 * (every index consumer already guards on `Number.isInteger`) renders it
 * UNNUMBERED — no `data-i` — and a FEAT-118 bookmark / read-mark restore finds no
 * node to land on and degrades VISIBLY instead of pointing at the wrong message.
 *
 * Returns the base (a floor when `isLowerBound`), for the route's `offset` /
 * `hasMore`.
 */
export function labelBackwardPage(messages: TranscriptMessage[], before: number, isLowerBound: boolean): number {
  const base = Math.max(0, before - messages.length);
  if (isLowerBound) {
    for (const m of messages) m.index = Number.NaN;
  } else {
    messages.forEach((m, i) => { m.index = base + i; });
  }
  return base;
}

/** Predicate for subagent files: every entry there is sidechain by design. */
export const subagentEntryFilter = (e: Record<string, any>): boolean => isMessageEntry(e);

export function clearTranscriptCaches(): void {
  countCache.clear();
}
