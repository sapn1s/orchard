/**
 * Orchard-owned transcript capture (FEAT-037 P2b).
 *
 * WHY: engines whose `capabilities.persistedTranscript` is FALSE (Codex) do not
 * write Claude's `~/.claude/projects/<encodedDir>/<sessionId>.jsonl` store —
 * the store every history feature (transcript routes, tail/forward paging,
 * session lists, live-follow, resume vetting) is built on. Rather than teaching
 * every reader a second format, the BRIDGE writes an Orchard-owned transcript
 * in the SAME entry shape (`{type:'user'|'assistant', message:{content:[…]}}`,
 * the one `jsonl.ts#toMessage` consumes), laid out the SAME way under our own
 * root:
 *
 *     dataDir()/transcripts/<provider>/<encodedDir>/<sessionId>.jsonl
 *
 * Mirroring the store layout is the whole trick: `session-history`'s functions
 * all take a `{ root }` option, so listing/resolving/live-detection reuse the
 * exact code paths the Claude store uses — one coordinate system, zero forked
 * readers. `<sessionId>` is the engine's own resume handle (the Codex thread
 * id from `system:init`), so a file's NAME is exactly what `thread/resume`
 * needs later.
 *
 * Append-only by construction: every write is an `fs.appendFileSync` of one
 * JSONL line; nothing here ever truncates or rewrites. Durable across
 * restarts because it is just a file under dataDir.
 *
 * HONEST LIMITS (documented, not hidden):
 *  - The recorder lives in the server process. If the server dies mid-turn,
 *    output produced after death is not captured — which is precisely why
 *    FEAT-015 survival stays gated OFF for persistedTranscript:false engines
 *    (see agent-bridge's survival comment): a surviving CLI would keep
 *    working with nobody recording, and the history would silently lie.
 *  - Search (`rg` over the Claude store) and rename/tag/delete target the
 *    Claude store only; Orchard transcripts are readable history + resume
 *    handles first. Extending those is additive follow-up work.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import * as hist from '../lib/session-history.ts';
import { dataDir } from '../lib/paths.ts';
// FEAT-144 round 2 — REUSE FEAT-129's file-lock liveness authority (do not invent
// a second staleness model) for the mirror's critical-section lock: reclaimReason
// (which itself uses the module's pidAlive ground-truth rung) + the shared TTL
// decide when a held lock is dead/stale and may be reclaimed.
import { reclaimReason, FILE_LOCK_TTL_MS } from '../../scripts/lib/file-lock.mjs';

/** Root of all Orchard-owned transcripts. */
export function orchardTranscriptsRoot(): string {
  return path.join(dataDir(), 'transcripts');
}

/** Provider sub-roots that exist on disk (e.g. [{provider:'openai', root:…}]). */
export function providerRoots(): { provider: string; root: string }[] {
  const root = orchardTranscriptsRoot();
  let names: string[];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return []; // no captures yet — not an error
  }
  return names
    .filter((n) => /^[a-z0-9-]+$/.test(n))
    .map((provider) => ({ provider, root: path.join(root, provider) }));
}

/** Absolute path an Orchard transcript lives (or would live) at. */
export function orchardTranscriptFile(provider: string, encodedDir: string, sessionId: string): string {
  return path.join(orchardTranscriptsRoot(), provider, encodedDir, `${sessionId}.jsonl`);
}

/**
 * Resolve a session id to an existing Orchard transcript. Same path-safety
 * rules as the Claude store (delegates to `hist.resolveSessionFile`).
 */
export function resolveOrchardSessionFile(
  encodedDir: string,
  sessionId: string,
): { filePath: string; provider: string } | null {
  for (const { provider, root } of providerRoots()) {
    const filePath = hist.resolveSessionFile(encodedDir, sessionId, { root });
    if (filePath) return { filePath, provider };
  }
  return null;
}

/**
 * FEAT-144 — provider directory the Claude MIRROR lives under. `'anthropic'` is
 * the canonical Claude provider key the rest of the server already speaks (the
 * resume-provider resolver and the sidebar engine badge both test for it), so a
 * mirror row surfacing AFTER a prune resumes-routes and badges as the Claude
 * session it is — not as a foreign engine.
 */
export const CLAUDE_MIRROR_PROVIDER = 'anthropic';

export type MirrorStatus =
  | 'appended'        // complete new lines copied from the CLI store
  | 'up-to-date'      // mirror already equals the source — no-op
  | 'recopied'        // source rewrote its prefix (compaction) → full snapshot
  | 'source-missing'  // CLI store pruned/absent — mirror left untouched
  | 'source-shorter'  // CLI store shorter than the mirror — mirror is more complete, kept
  | 'partial-only'    // only a half-written trailing line available yet — deferred
  | 'unsafe-id'       // session id is not filename-safe — refused
  | 'busy'            // another pass holds the mirror lock right now — benign skip
  | 'error';          // an I/O failure (reported once, never thrown)

export interface MirrorResult {
  status: MirrorStatus;
  file: string | null;
  bytesAdded: number;
  detail?: string;
}

/** Read `length` bytes of `file` starting at `start` (best effort — short read tolerated). */
function readRange(file: string, start: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const n = fs.readSync(fd, buf, got, length - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    return got === length ? buf : buf.subarray(0, got);
  } finally {
    fs.closeSync(fd);
  }
}

/** Byte offset just past the LAST '\n' in `file` (the length of its complete-line prefix), or 0. */
function lastCompleteLineEnd(file: string, size: number): number {
  const CHUNK = 65536;
  let pos = size;
  const fd = fs.openSync(file, 'r');
  try {
    while (pos > 0) {
      const start = Math.max(0, pos - CHUNK);
      const len = pos - start;
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const n = fs.readSync(fd, buf, got, len - got, start + got);
        if (n <= 0) break;
        got += n;
      }
      const idx = buf.lastIndexOf(0x0a, got - 1);
      if (idx >= 0) return start + idx + 1;
      pos = start;
    }
    return 0;
  } finally {
    fs.closeSync(fd);
  }
}

/** Read exactly `length` bytes of an open fd at absolute `pos` into `buf`; returns bytes actually read. */
function readFullAt(fd: number, buf: Buffer, length: number, pos: number): number {
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, pos + got);
    if (n <= 0) break;
    got += n;
  }
  return got;
}

/**
 * FEAT-144 round 2 (defect 1) — SOUND divergence check. Is the whole of `a`'s
 * first `len` bytes byte-identical to `b`'s first `len` bytes? Streams both files
 * in chunks and compares every byte, so an in-place rewrite of ANY entry (early,
 * late, or equal-size) is detected — unlike the old fixed 8 KiB tail window, which
 * an early-entry equal-size compaction slipped straight past. A short read on
 * either side (file changed under us) counts as NOT equal → the caller re-snapshots.
 */
function prefixesEqual(a: string, b: string, len: number): boolean {
  if (len <= 0) return true;
  const fa = fs.openSync(a, 'r');
  const fb = fs.openSync(b, 'r');
  try {
    const CHUNK = 1 << 16;
    const ba = Buffer.alloc(CHUNK);
    const bb = Buffer.alloc(CHUNK);
    let pos = 0;
    while (pos < len) {
      const want = Math.min(CHUNK, len - pos);
      if (readFullAt(fa, ba, want, pos) !== want) return false;
      if (readFullAt(fb, bb, want, pos) !== want) return false;
      if (!ba.subarray(0, want).equals(bb.subarray(0, want))) return false;
      pos += want;
    }
    return true;
  } finally {
    fs.closeSync(fa);
    fs.closeSync(fb);
  }
}

/**
 * Copy `[0, cut)` of `src` to `dst` atomically (temp + rename), streamed so a huge
 * file never loads whole. FEAT-144 round 2 (defect 4): the temp is unlinked on ANY
 * failure (copy or rename) so a repeated snapshot failure cannot litter temp files.
 */
function atomicCopyPrefix(src: string, dst: string, cut: number): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.tmp-${randomUUID()}`;
  try {
    const rfd = fs.openSync(src, 'r');
    const wfd = fs.openSync(tmp, 'w');
    try {
      const CHUNK = 1 << 20;
      const buf = Buffer.alloc(CHUNK);
      let pos = 0;
      while (pos < cut) {
        const want = Math.min(CHUNK, cut - pos);
        const n = fs.readSync(rfd, buf, 0, want, pos);
        if (n <= 0) break;
        fs.writeSync(wfd, buf, 0, n);
        pos += n;
      }
      fs.fsyncSync(wfd);
    } finally {
      fs.closeSync(rfd);
      fs.closeSync(wfd);
    }
    fs.renameSync(tmp, dst);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never created, or already gone */ }
    throw err;
  }
}

/**
 * FEAT-144 round 2 (defect 3) — append `delta` at the mirror's complete-line
 * boundary `atOffset`, TORN-LINE-PROOF. Writes at an explicit offset in a loop; on
 * a short write (ENOSPC/EFBIG writes only part) OR any thrown error, truncates the
 * file back to `atOffset` — always a newline boundary — before rethrowing, so a
 * half-written line can never remain in the mirror. Recoverable on the next sync.
 */
function appendCompleteLines(dst: string, atOffset: number, delta: Buffer): void {
  const fd = fs.openSync(dst, 'r+');
  try {
    let off = 0;
    while (off < delta.length) {
      const n = fs.writeSync(fd, delta, off, delta.length - off, atOffset + off);
      if (n <= 0) break;
      off += n;
    }
    if (off < delta.length) {
      fs.ftruncateSync(fd, atOffset);
      throw new Error(`short write (${off}/${delta.length} bytes) — rolled back to line boundary`);
    }
    fs.fsyncSync(fd);
  } catch (err) {
    try { fs.ftruncateSync(fd, atOffset); } catch { /* best effort rollback */ }
    throw err;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * FEAT-144 round 2 (defect 2) — serialize the mirror's read-check→append/recopy
 * critical section against ANY other writer of the SAME mirror file (the turn-end
 * hook and the mirror-on-read hook racing, or a second thread/process). Without
 * this, two passes both read the same mirror end, both compute the same delta, and
 * both append → the whole conversation duplicated (measured 12× in the clean room).
 *
 * REUSES FEAT-129's file-lock, not a new lock policy: acquire is the module's
 * atomic link-create pattern (temp + `linkSync`, so the lockfile is never observed
 * empty), and staleness is FEAT-129's `reclaimReason` (dead owner via pidAlive, or
 * past the shared TTL). The one difference is LIFETIME — this is a bounded critical
 * section (acquire, run the synchronous body, release in `finally`), which
 * `evaluateFileLock`'s claim-until-heartbeat model cannot express. Fail toward
 * SKIP, never duplicate: a live foreign holder means another pass is doing this
 * exact append, so we do nothing and let it — idempotency loses nothing.
 *
 * The lockfile is `<dst>.mirror-lock`; readers filter `*.jsonl` so it is invisible
 * to every session/transcript listing.
 */
function withMirrorLock<T>(dst: string, fn: () => T): { ran: true; result: T } | { ran: false } {
  const lockPath = `${dst}.mirror-lock`;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  for (let attempt = 0; attempt < 8; attempt++) {
    // Atomic create-with-content (link never observes an empty lock).
    const tmp = `${lockPath}.mk-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let created = false;
    try {
      const meta = { host: os.hostname(), ownerPid: process.pid, refreshedAt: Date.now() };
      const fd = fs.openSync(tmp, 'w', 0o600);
      try { fs.writeSync(fd, JSON.stringify(meta)); } finally { fs.closeSync(fd); }
      try { fs.linkSync(tmp, lockPath); created = true; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* linked or never made */ }
    }

    if (created) {
      try { return { ran: true, result: fn() }; }
      finally { try { fs.unlinkSync(lockPath); } catch { /* already reclaimed */ } }
    }

    // Held by someone. Reclaim ONLY if provably dead / stale (FEAT-129 authority).
    let held: unknown = null;
    try { held = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { held = null; }
    const why = reclaimReason(held ?? {}, Date.now(), FILE_LOCK_TTL_MS);
    if (why) {
      // Race-safe: rename aside; exactly one contender wins, the rest retry.
      const moved = `${lockPath}.reclaim-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try { fs.renameSync(lockPath, moved); fs.unlinkSync(moved); } catch { /* lost the reclaim race */ }
      continue;
    }
    return { ran: false }; // live foreign holder → benign skip
  }
  return { ran: false }; // retry storm → skip (fail-safe; a truly stuck lock frees on the TTL)
}

/**
 * FEAT-144 — mirror the Claude CLI's OWN jsonl store into Orchard's durable
 * transcript store, so a Claude conversation survives the CLI pruning its store
 * by age (`cleanupPeriodDays`, ~30d). Claude stays the AUTHORITATIVE store
 * (`persistedTranscript:true`); this is a byte-for-byte APPEND of the CLI file,
 * never a second writer of a divergent shape — the existing reader serves the
 * mirror unchanged, and the read/list precedence already prefers the live CLI
 * file and falls back to the mirror only once the CLI file is gone.
 *
 * Idempotent by construction — the mirror is always a strict PREFIX of the
 * source, so a sync copies only the bytes past the mirror's current end (up to
 * the last COMPLETE line — a half-written trailing line is deferred to the next
 * sync so no partial line ever lands). Re-opening, resuming and restarting
 * therefore cannot double-append: a repeat sync with nothing new is a no-op.
 *
 * WHERE THIS SESSION'S CONVERSATION IS DURABLY STORED IS OWNED HERE (ARCH-010):
 * the CLI store while it exists, this mirror once it does not. No reader
 * re-derives it — `resolveOrchardSessionFile`/`listOrchardSessions` already pick
 * the mirror up generically, de-duplicated by session id.
 *
 * HONEST LIMITS: only bytes the CLI has already written are captured — a turn
 * lost to a server crash before the CLI flushed it is not recoverable here, and
 * a mirror is readable history, not CLI-resumability (resume needs the CLI's own
 * store, which is exactly what a prune removed).
 */
export function mirrorClaudeStore(
  encodedDir: string,
  sessionId: string,
  opts: { onError?: (message: string) => void } = {},
): MirrorResult {
  const onError = opts.onError ?? ((m) => console.warn(`[orchard-transcript] ${m}`));
  const dst = orchardTranscriptFile(CLAUDE_MIRROR_PROVIDER, encodedDir, sessionId);
  // `resolveSessionFile` enforces the same filename-safety on both args and
  // returns null for an absent/pruned OR unsafe target. Either way we never
  // overwrite the mirror with nothing — protecting the record is the whole point.
  const src = hist.resolveSessionFile(encodedDir, sessionId);
  if (!src) {
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return { status: 'unsafe-id', file: null, bytesAdded: 0 };
    let has = false;
    try { has = fs.statSync(dst).isFile(); } catch { has = false; }
    return { status: 'source-missing', file: has ? dst : null, bytesAdded: 0 };
  }
  try {
    // The ENTIRE check-then-act runs under the mirror lock, so two concurrent
    // passes can never both read the same mirror end and both append (defect 2).
    const locked = withMirrorLock(dst, (): MirrorResult => {
      const srcSize = fs.statSync(src).size;
      let dstSize = 0;
      try { dstSize = fs.statSync(dst).size; } catch { dstSize = 0; }

      if (dstSize > srcSize) {
        // The CLI store is SHORTER than the mirror — truncated, compacted in
        // place, or replaced. The mirror is the more complete record; keep it.
        return { status: 'source-shorter', file: dst, bytesAdded: 0 };
      }

      // Defect 1: SOUND divergence check — the mirror must be a byte-identical
      // PREFIX of the source over its WHOLE length, not just a tail window. An
      // in-place rewrite of ANY entry (early/late/equal-size) diverges here and
      // triggers a full re-snapshot rather than interleaving or falsely reporting
      // current. (The old fixed 8 KiB window missed an early-entry rewrite.)
      if (dstSize > 0 && !prefixesEqual(src, dst, dstSize)) {
        const cut = lastCompleteLineEnd(src, srcSize);
        if (cut === 0) return { status: 'partial-only', file: dst, bytesAdded: 0 };
        atomicCopyPrefix(src, dst, cut);
        return { status: 'recopied', file: dst, bytesAdded: cut };
      }

      if (dstSize === srcSize) {
        // Consistent prefix AND identical size → the mirror is genuinely current.
        return { status: 'up-to-date', file: dst, bytesAdded: 0 };
      }

      // Append only COMPLETE lines from [dstSize, cut). A trailing partial line
      // (the CLI mid-write) is deferred — the truncated-read invariant.
      const cut = lastCompleteLineEnd(src, srcSize);
      if (cut <= dstSize) return { status: 'partial-only', file: dst, bytesAdded: 0 };
      const delta = readRange(src, dstSize, cut - dstSize);
      if (dstSize === 0) {
        // No mirror yet — create it atomically as the complete-line prefix copy
        // (torn-proof; `r+` append below requires an existing file).
        atomicCopyPrefix(src, dst, cut);
        return { status: 'appended', file: dst, bytesAdded: cut };
      }
      // Defect 3: torn-line-proof append — rolls back to the line boundary on a
      // short write / ENOSPC rather than leaving a half-written line.
      appendCompleteLines(dst, dstSize, delta);
      return { status: 'appended', file: dst, bytesAdded: delta.length };
    });
    if (!locked.ran) return { status: 'busy', file: dst, bytesAdded: 0 };
    return locked.result;
  } catch (err) {
    const detail = `Claude transcript mirror failed for ${sessionId}: ${(err as Error).message}`;
    onError(detail);
    return { status: 'error', file: dst, bytesAdded: 0, detail };
  }
}

export type OrchardSessionMeta = hist.SessionMeta & { provider: string };

/**
 * All Orchard-owned sessions recorded under one encoded dir, newest first —
 * `hist.listSessions` pointed at each provider root, so the metadata (title,
 * counts, timestamps, models) comes from the very same reader the Claude
 * store uses.
 */
export function listOrchardSessions(encodedDir: string): OrchardSessionMeta[] {
  const out: OrchardSessionMeta[] = [];
  for (const { provider, root } of providerRoots()) {
    let metas: hist.SessionMeta[];
    try {
      metas = hist.listSessions(encodedDir, { root });
    } catch {
      continue; // dir absent under this provider — nothing recorded there
    }
    for (const m of metas) out.push({ ...m, provider });
  }
  out.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  return out;
}

/* ----------------------------------------------------------- the recorder */

export interface RecorderOptions {
  /** Provider key — becomes the directory name (e.g. 'openai'). */
  provider: string;
  /** The session's cwd; encoded exactly like Claude's store keys its dirs. */
  cwd: string;
  /** Non-fatal problem channel (append failure etc.) — reported ONCE. */
  onError?: (message: string) => void;
}

interface PendingEntry {
  type: 'user' | 'assistant';
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  message: Record<string, unknown>;
}

/**
 * Per-session append-only writer. Entries recorded before the engine reports
 * its session/thread id (`system:init`) are buffered and flushed the moment
 * `adoptSessionId` names the file; a session that never inits leaves no file,
 * which matches "no session happened".
 */
export class TranscriptRecorder {
  readonly provider: string;
  readonly cwd: string;
  readonly encodedDir: string;
  #sessionId: string | null = null;
  #file: string | null = null;
  #buffer: PendingEntry[] = [];
  #lastUuid: string | null = null;
  #model: string | null = null;
  #failed = false;
  #onError: (message: string) => void;

  constructor(opts: RecorderOptions) {
    this.provider = opts.provider;
    this.cwd = opts.cwd;
    this.encodedDir = hist.encodeCwd(opts.cwd);
    this.#onError = opts.onError ?? ((m) => console.warn(`[orchard-transcript] ${m}`));
  }

  get filePath(): string | null {
    return this.#file;
  }

  /** Model string for assistant entries (from `system:init` / model-observed). */
  setModel(model: string | null): void {
    if (model && !model.startsWith('<')) this.#model = model;
  }

  /**
   * Name the file. Known up-front on resume (same thread id → the SAME file
   * simply continues — append-only across sessions), or on `system:init` for
   * a fresh thread. Idempotent for the same id.
   */
  adoptSessionId(sessionId: string): void {
    if (this.#failed || !sessionId || sessionId === this.#sessionId) return;
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
      this.#fail(`refusing to record: engine session id ${JSON.stringify(sessionId)} is not filename-safe`);
      return;
    }
    this.#sessionId = sessionId;
    this.#file = orchardTranscriptFile(this.provider, this.encodedDir, sessionId);
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    } catch (err) {
      this.#fail(`cannot create transcript dir: ${(err as Error).message}`);
      return;
    }
    const pending = this.#buffer.splice(0);
    for (const e of pending) this.#write(e);
  }

  /** A prompt the user (or the autonomous nudge) sent INTO the engine. */
  recordUserPrompt(text: string): void {
    this.#push('user', { role: 'user', content: [{ type: 'text', text }] });
  }

  /**
   * An inbound RuntimeMessage (the Claude-SDK-shaped dialect `#handle`
   * consumes). Only main-thread `assistant`/`user` frames carry renderable
   * content; deltas/results are transient and deliberately not recorded, so
   * the file's population is exactly the "renderable" canonical space the
   * transcript routes count.
   */
  recordRuntimeMessage(m: Record<string, any>): void {
    if (m.type !== 'assistant' && m.type !== 'user') return;
    if (m.parent_tool_use_id != null) return; // sidechain — none expected (subagents:false)
    const content = m.message?.content;
    if (!Array.isArray(content) || content.length === 0) return;
    const message: Record<string, unknown> =
      m.type === 'assistant'
        ? { role: 'assistant', ...(this.#model ? { model: this.#model } : {}), content }
        : { role: 'user', content };
    this.#push(m.type, message);
  }

  #push(type: 'user' | 'assistant', message: Record<string, unknown>): void {
    if (this.#failed) return;
    const entry: PendingEntry = {
      type,
      uuid: randomUUID(),
      parentUuid: this.#lastUuid,
      timestamp: new Date().toISOString(),
      message,
    };
    this.#lastUuid = entry.uuid;
    if (!this.#file) {
      this.#buffer.push(entry);
      return;
    }
    this.#write(entry);
  }

  #write(e: PendingEntry): void {
    if (this.#failed || !this.#file || !this.#sessionId) return;
    // Claude-store entry shape + a self-describing `provider` field (ignored
    // by every existing reader; lets a file name its engine without relying
    // on its directory).
    const line = JSON.stringify({
      type: e.type,
      uuid: e.uuid,
      parentUuid: e.parentUuid,
      timestamp: e.timestamp,
      sessionId: this.#sessionId,
      cwd: this.cwd,
      provider: this.provider,
      message: e.message,
    });
    try {
      fs.appendFileSync(this.#file, line + '\n');
    } catch (err) {
      this.#fail(`transcript append failed at ${this.#file}: ${(err as Error).message}`);
    }
  }

  #fail(message: string): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#buffer = [];
    this.#onError(
      `Orchard-owned transcript capture stopped for this session — ${message}. ` +
        'The session keeps running; its history will be missing from the sidebar.',
    );
  }
}
