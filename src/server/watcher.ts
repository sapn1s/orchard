/**
 * Live-follow of session files the dashboard did NOT spawn.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * A session running in another terminal appends to its `.jsonl`. This module
 * watches that file and pushes the newly-appended MESSAGES.
 *
 * It is deliberately NOT token-level streaming. Token deltas exist only inside
 * the process driving the model; there is no way to recover them from disk, and
 * synthesising them would be a lie. What lands here is persisted messages, at
 * the granularity the CLI writes them.
 *
 * ---------------------------------------------------------------------------
 * BYTE CURSOR
 * ---------------------------------------------------------------------------
 * Each watch keeps a byte offset and reads ONLY `[cursor, newSize)` on change.
 * Rescanning is not an option: the user's largest session is 286 MB and a
 * rescan per keystroke-append would be fatal. A partial trailing line (the CLI
 * mid-write) is held as carry and completed by the next append.
 *
 * Truncation/rotation: if the file SHRINKS, the cursor is past the end. That is
 * treated as a resync — cursor resets to 0 and the carry is dropped — rather
 * than as an error, and it is reported so the UI can refetch rather than splice
 * unrelated messages onto what it already has.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { TranscriptMessage } from '../lib/session-history.ts';
import * as hist from '../lib/session-history.ts';
import { LIVE_WINDOW_MS, transcriptLiveness } from './liveness.ts';
import { blocksOf, isMainThreadEntry, toMessage, type BuildOptions } from './jsonl.ts';
import { providerRoots, resolveOrchardSessionFile } from './orchard-transcripts.ts';
// FEAT-154 round 9: a transcript's fresh mtime is evidence of a running turn only when an ENGINE wrote it;
// Orchard's own writes (mirror, import, rename/pin, fork copy) are declared in own-writes.ts and read here.
import { lastEngineWriteMs } from './own-writes.ts';
import { countMessages } from './transcript.ts';

/**
 * FEAT-037 P2b: a session file may live in the Claude store OR in the
 * Orchard-owned transcript store (engines with persistedTranscript:false).
 * Every follow/liveness lookup goes through this one fallback so the two
 * stores cannot disagree about what "this session's file" means.
 */
function resolveAnySessionFile(dir: string, sessionId: string): string | null {
  return hist.resolveSessionFile(dir, sessionId) ?? resolveOrchardSessionFile(dir, sessionId)?.filePath ?? null;
}

export interface AppendBatch {
  sessionId: string;
  dir: string;
  messages: TranscriptMessage[];
  /** Bytes read for THIS batch — the proof that appends are incremental. */
  bytesRead: number;
  /** File shrank; the client should refetch rather than append. */
  resynced: boolean;
  fileBytes: number;
}

interface Watch {
  key: string;
  sessionId: string;
  dir: string;
  filePath: string;
  cursor: number;
  /** Bytes after the last newline read so far (BUG-190 round 3: BYTES, not a
   *  decoded string — a chunk may end inside a multi-byte character). */
  carry: Buffer;
  /** BUG-190 round 4: `carry` (no newline yet) already parsed as a COMPLETE record
   *  and was emitted, so the line it heads must not be emitted again when its
   *  newline (or anything else) arrives. */
  carryEmitted: boolean;
  watcher: fs.FSWatcher;
  timer: NodeJS.Timeout | null;
  reading: boolean;
  subscribers: Set<(b: AppendBatch) => void>;
  opts: BuildOptions;
  totalBytesRead: number;
  batches: number;
  /**
   * Next canonical (renderable) index to assign. Seeded from the renderable
   * count of the file at follow time, so an appended message continues the same
   * numbering the tail/forward routes use — not the `-1` sentinel it used to be.
   */
  nextIndex: number;
}

const watches = new Map<string, Watch>();
/** Coalesce bursts: the CLI writes several lines per turn. */
const DEBOUNCE_MS = 150;

const keyOf = (dir: string, sessionId: string) => `${dir}\0${sessionId}`;

function readAppend(w: Watch): void {
  if (w.reading) return;
  w.reading = true;
  try {
    let st: fs.Stats;
    try {
      st = fs.statSync(w.filePath);
    } catch {
      return; // file vanished; the watcher's own error/rename path handles it
    }
    let resynced = false;
    if (st.size < w.cursor) {
      // Truncated or rotated. Do not try to splice — say so and start over. The
      // new file's messages start at renderable index 0.
      w.cursor = 0;
      w.carry = Buffer.alloc(0);
      w.carryEmitted = false;
      w.nextIndex = 0;
      resynced = true;
    }
    if (st.size === w.cursor && !resynced) return;

    const len = st.size - w.cursor;
    if (len <= 0) return;
    const fd = fs.openSync(w.filePath, 'r');
    let buf: Buffer;
    try {
      buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, w.cursor);
    } finally {
      fs.closeSync(fd);
    }
    w.cursor = st.size;
    w.totalBytesRead += len;
    w.batches++;

    // BUG-190 round 3: split on the newline BYTE and decode only whole lines.
    // Decoding each chunk on its own turned a write split inside a multi-byte
    // character into U+FFFD on both sides of the cut.
    const joined = w.carry.length ? Buffer.concat([w.carry, buf]) : buf;
    const nl = joined.lastIndexOf(0x0a);
    // Everything after the last newline has no newline YET.
    w.carry = Buffer.from(joined.subarray(nl + 1));
    let parts = nl >= 0 ? joined.subarray(0, nl).toString('utf8').split('\n') : [];
    // The first whole line began as the previous carry: if that carry was
    // already emitted as a complete record, its newline arriving adds nothing.
    if (w.carryEmitted && nl >= 0) { parts = parts.slice(1); w.carryEmitted = false; }

    const messages: TranscriptMessage[] = [];
    const take = (line: string): void => {
      if (!line.trim()) return;
      let e: Record<string, any>;
      try {
        e = JSON.parse(line);
      } catch {
        return; // torn line; the carry mechanism means we rarely see these
      }
      if (!isMainThreadEntry(e)) return;
      const blocks = blocksOf(e, w.opts);
      if (blocks.length === 0) return; // canonical space excludes empty-block entries
      messages.push(toMessage(e, w.nextIndex++, blocks));
    };
    for (const line of parts) take(line);
    /*
     * BUG-190 round 4: a record completed WITHOUT its trailing newline (the
     * file's final record, or a writer that flushes the record and the newline
     * separately) is complete as soon as it parses. A transcript record is one
     * JSON OBJECT per line, and no proper prefix of an object parses as one — a
     * cut anywhere before the closing brace is a syntax error — so a parse
     * decides completeness exactly, and a genuinely partial line never renders.
     */
    if (!w.carryEmitted && w.carry.length && isCompleteRecord(w.carry)) {
      take(w.carry.toString('utf8'));
      w.carryEmitted = true;
    }

    if (!messages.length && !resynced) return;
    const batch: AppendBatch = { sessionId: w.sessionId, dir: w.dir, messages, bytesRead: len, resynced, fileBytes: st.size };
    for (const fn of w.subscribers) {
      try {
        fn(batch);
      } catch {
        /* a broken subscriber must not stop the others */
      }
    }
  } finally {
    w.reading = false;
  }
}

/**
 * Byte offset just past the file's last newline (0 if it has none), searched
 * backward in chunks. Bounded: past the cap it falls back to `size` (the old
 * behaviour) rather than scan an arbitrarily long single line.
 */
function lastLineBoundary(filePath: string, size: number): number {
  const CHUNK = 64 * 1024;
  const CAP = 64 * 1024 * 1024;
  let fd: number;
  try { fd = fs.openSync(filePath, 'r'); } catch { return size; }
  // A last line that is already complete JSON without its newline is not
  // "still being written" as far as every reader is concerned — the tail
  // parser rendered it and the count includes it — so it is not re-read.
  const complete = (b: number): number => {
    if (b >= size) return size;
    try {
      const frag = Buffer.alloc(size - b);
      fs.readSync(fd, frag, 0, size - b, b);
      return isCompleteRecord(frag) ? size : b;
    } catch {
      return b;
    }
  };
  try {
    let end = size;
    while (end > 0 && size - end < CAP) {
      const len = Math.min(CHUNK, end);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, end - len);
      const i = buf.lastIndexOf(0x0a);
      if (i >= 0) return complete(end - len + i + 1);
      end -= len;
    }
    return end <= 0 ? complete(0) : size;
  } catch {
    return size;
  } finally {
    fs.closeSync(fd);
  }
}

/** One complete JSONL record: parses, and is a JSON object (BUG-190 round 4). */
function isCompleteRecord(bytes: Buffer): boolean {
  const text = bytes.toString('utf8').trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return false;
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  } catch {
    return false;
  }
}

function schedule(w: Watch): void {
  if (w.timer) return;
  w.timer = setTimeout(() => {
    w.timer = null;
    readAppend(w);
  }, DEBOUNCE_MS);
  w.timer.unref();
}

export interface WatchHandle {
  /** Stop THIS subscription. The underlying fs.watch closes with the last one. */
  close(): void;
  filePath: string;
  startCursor: number;
  stats(): { totalBytesRead: number; batches: number; fileBytes: number };
}

/**
 * Follow a session file, starting from its CURRENT end (so a client that has
 * just fetched a tail does not immediately receive what it already has).
 *
 * Returns null when the session file does not exist.
 */
export function watchSession(
  dir: string,
  sessionId: string,
  onAppend: (b: AppendBatch) => void,
  opts: BuildOptions = {},
): WatchHandle | null {
  const filePath = resolveAnySessionFile(dir, sessionId);
  if (!filePath) return null;
  const key = keyOf(dir, sessionId);

  let w = watches.get(key);
  if (!w) {
    const size = fs.statSync(filePath).size;
    // Seed the index cursor with the renderable count of the file as it stands,
    // so the first appended message reports the index that continues the tail.
    // One-time cost (~800ms on the 286 MB file), cached by countMessages.
    const seedIndex = countMessages(filePath).total;
    const created: Watch = {
      key,
      sessionId,
      dir,
      filePath,
      // BUG-190 round 3: start at the last line BOUNDARY, not the raw end. A
      // trailing line still being written is not in the tail the client already
      // has (the tail parser skips it), so starting past it meant its completion
      // was read as a headless fragment and never rendered.
      cursor: lastLineBoundary(filePath, size),
      carry: Buffer.alloc(0),
      carryEmitted: false,
      nextIndex: seedIndex,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      watcher: undefined as unknown as fs.FSWatcher,
      timer: null,
      reading: false,
      subscribers: new Set(),
      opts,
      totalBytesRead: 0,
      batches: 0,
    };
    // Watch the DIRECTORY entry, not just the inode: an editor/rotation that
    // replaces the file would leave an inode watch pointing at nothing.
    const watcher = fs.watch(filePath, { persistent: false }, () => schedule(created));
    watcher.on('error', () => {
      // Rotation or deletion. Drop the watch rather than throw out of an event
      // handler, which would take the whole server down.
      stopWatch(key);
    });
    created.watcher = watcher;
    w = created;
    watches.set(key, w);
  }

  w.subscribers.add(onAppend);
  const startCursor = w.cursor;
  return {
    filePath,
    startCursor,
    stats: () => ({ totalBytesRead: w!.totalBytesRead, batches: w!.batches, fileBytes: (() => { try { return fs.statSync(filePath).size; } catch { return 0; } })() }),
    close() {
      const cur = watches.get(key);
      if (!cur) return;
      cur.subscribers.delete(onAppend);
      if (cur.subscribers.size === 0) stopWatch(key);
    },
  };
}

function stopWatch(key: string): void {
  const w = watches.get(key);
  if (!w) return;
  watches.delete(key);
  if (w.timer) clearTimeout(w.timer);
  try {
    w.watcher.close();
  } catch {
    /* already closed */
  }
}

/** Every watch, for leak assertions. */
export function activeWatchCount(): number {
  return watches.size;
}

export function closeAllWatches(): void {
  for (const key of [...watches.keys()]) stopWatch(key);
}

/* -------------------------------------------------------- live detection */

/*
 * ARCH-001 — the window and the rationale for choosing mtime over /proc fd
 * scanning now live in `liveness.ts`, with the rung that applies them.
 * Re-exported here because this module's public API has always carried it.
 */
export { LIVE_WINDOW_MS };

export interface LiveSessionInfo {
  sessionId: string;
  dir: string;
  lastWriteAt: string;
  ageMs: number;
  fileBytes: number;
}

/**
 * Sessions written within `windowMs`. Cheap: one stat per file, no parsing, and
 * directories are skipped entirely when their own mtime is old.
 */
export function liveSessions(windowMs = LIVE_WINDOW_MS, root = hist.defaultRoot()): LiveSessionInfo[] {
  const now = Date.now();
  const out: LiveSessionInfo[] = [];
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dirPath = path.join(root, d.name);
    try {
      /*
       * No directory-mtime shortcut: appending to an existing file does not
       * touch its directory's mtime, so skipping "cold" directories would hide
       * exactly the long-running sessions this is meant to find. One readdir
       * plus a stat per .jsonl is fast enough — measured below in the report.
       */
      for (const f of fs.readdirSync(dirPath)) {
        if (!f.endsWith('.jsonl')) continue;
        let st: fs.Stats;
        const fp = path.join(dirPath, f);
        try {
          st = fs.statSync(fp);
        } catch {
          continue;
        }
        // ARCH-001: even the LISTING asks the authority whether the file
        // counts as being written right now, so the window cannot be applied
        // one way here and another way anywhere else. FEAT-154 r9: the input is
        // the last ENGINE write, not the raw mtime (own-writes.ts).
        const v = transcriptLiveness({ lastWriteMs: lastEngineWriteMs(fp, st), windowMs }, now);
        if (v.state !== 'alive') continue;
        out.push({
          sessionId: f.slice(0, -6),
          dir: d.name,
          lastWriteAt: new Date(st.mtimeMs).toISOString(),
          ageMs: v.evidence.ageMs ?? 0,
          fileBytes: st.size,
        });
      }
    } catch {
      continue;
    }
  }
  out.sort((a, b) => a.ageMs - b.ageMs);
  return out;
}

/**
 * FEAT-037 P2b: live detection over the Orchard-owned transcript store — the
 * same mtime-window scan (`liveSessions` pointed at each provider root), so a
 * codex session being appended to RIGHT NOW badges exactly like a Claude one.
 * Every root is scanned; Orchard's own copies into them (the Claude mirror, a
 * native-Codex import) are told apart by the own-writes declaration inside
 * `liveSessions`, not by which directory they sit in (FEAT-154 round 9).
 */
export function orchardLiveSessions(windowMs = LIVE_WINDOW_MS): (LiveSessionInfo & { provider: string })[] {
  const out: (LiveSessionInfo & { provider: string })[] = [];
  for (const { provider, root } of providerRoots()) {
    for (const s of liveSessions(windowMs, root)) out.push({ ...s, provider });
  }
  return out;
}

/**
 * The transcript's own facts for a session, or null if it has no file yet.
 *
 * ARCH-001: exists so a caller that already KNOWS a session is live (because
 * the authority says so) can still report its real file facts, instead of the
 * route silently omitting the session because its mtime fell out of the window.
 */
export function sessionFileFacts(dir: string, sessionId: string, now = Date.now()): { dir: string; lastWriteAt: string; ageMs: number; fileBytes: number } | null {
  const f = resolveAnySessionFile(dir, sessionId);
  if (!f) return null;
  try {
    const st = fs.statSync(f);
    const v = transcriptLiveness({ lastWriteMs: lastEngineWriteMs(f, st) }, now);
    return { dir, lastWriteAt: new Date(st.mtimeMs).toISOString(), ageMs: v.evidence.ageMs ?? 0, fileBytes: st.size };
  } catch {
    return null;
  }
}

/**
 * Is one specific session's transcript being appended to right now?
 *
 * ARCH-001 — this is EVIDENCE, not a verdict: `false` means "nothing has been
 * written lately", which is NOT the same as "nothing is running" (a turn that
 * thinks, or sits inside a long tool call, writes nothing at all). The
 * authority is what draws that distinction — `transcriptLiveness` answers
 * `alive` or `unknown` and never `dead`. This boolean is kept because callers
 * legitimately want the narrow disk question, and each of them unions it with
 * the bridge/host answer rather than reading `false` as death.
 */
export function isSessionLive(dir: string, sessionId: string, windowMs = LIVE_WINDOW_MS): boolean {
  const f = resolveAnySessionFile(dir, sessionId);
  if (!f) return false;
  let lastWriteMs: number | null = null;
  try { lastWriteMs = lastEngineWriteMs(f, fs.statSync(f)); } catch { return false; }
  return transcriptLiveness({ lastWriteMs, windowMs }).state === 'alive';
}
