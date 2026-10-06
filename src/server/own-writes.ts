/**
 * FEAT-154 round 9 — THE ONE DECLARATION of transcript writes ORCHARD makes
 * itself, as opposed to an ENGINE appending a turn (ARCH-010).
 *
 * The live scan (watcher.ts) reads "was this transcript written in the last
 * 30s?" as evidence that a turn is running. That is true only when the ENGINE
 * wrote it: the Claude CLI into its own store, or Orchard's TranscriptRecorder
 * on behalf of an engine with no store of its own (Codex). Orchard also writes
 * transcript files for its own reasons — the FEAT-144 mirror on every open and
 * at every turn end, the FEAT-078 native-Codex import on open, a rename/pin
 * appended by the SDK, a fork's staged copy. Each of those gave the file a
 * fresh mtime, and the session then read as RUNNING for 30s. (Round 8 excluded
 * the mirror's provider dir by name, and the native-Codex import still landed
 * in an engine dir. A per-writer or per-engine exclusion list gets missed by
 * the next writer.)
 *
 * So the fact is stated where the write happens, once, through one wrapper:
 * every Orchard-side write to a transcript runs inside `asOrchardWrite`, which
 * records the file's resulting (mtime, size) along with the last ENGINE write
 * time the file had before it. The liveness scan asks `lastEngineWriteMs`,
 * never the raw mtime. As long as the file still stands exactly as Orchard left
 * it, the answer is the engine's last write, or null if Orchard created the
 * file. The moment anything else appends, (mtime, size) no longer match, and
 * the raw mtime is the engine's answer again. That makes a genuine new turn
 * read as running on its very first append.
 *
 * The engine path (TranscriptRecorder) deliberately does NOT use the wrapper.
 * A new engine that records through it is evidence by default. A new
 * Orchard-side writer that forgets the wrapper is the one way to regress, and
 * that is why the wrapper lives here, beside the reader, and not per call site.
 *
 * In-memory is enough: the window is 30s, and both the writes and the scan
 * happen in this server process. After a restart, every file Orchard wrote
 * before it is older than the window anyway.
 *
 * Honest limit: if the engine appends to the SAME file between Orchard's write
 * and the stat that follows it (a rename while that session's CLI is mid-turn),
 * that one append is attributed to Orchard. The next engine append clears it,
 * and a driven session has its bridge's liveness regardless.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

interface Stamp {
  mtimeMs: number;
  size: number;
  /** The last write an ENGINE made to this file, as far as we know; null = none (Orchard created it). */
  engineWriteMs: number | null;
}

const ledger = new Map<string, Stamp>();
const CAP = 20_000; // bounded: evict the oldest declaration (a stale stamp only ever falls back to the raw mtime)

function statOf(file: string): { mtimeMs: number; size: number } | null {
  try {
    const st = fs.statSync(file);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

function before(abs: string): { st: { mtimeMs: number; size: number } | null; engineWriteMs: number | null } {
  const st = statOf(abs);
  if (!st) return { st: null, engineWriteMs: null };
  const prior = ledger.get(abs);
  const unchangedSinceOrchard = !!prior && prior.mtimeMs === st.mtimeMs && prior.size === st.size;
  return { st, engineWriteMs: unchangedSinceOrchard ? prior!.engineWriteMs : st.mtimeMs };
}

function after(abs: string, pre: ReturnType<typeof before>): void {
  const st = statOf(abs);
  if (!st) return;
  if (pre.st && pre.st.mtimeMs === st.mtimeMs && pre.st.size === st.size) return; // nothing was written
  ledger.delete(abs);
  if (ledger.size >= CAP) {
    const oldest = ledger.keys().next().value;
    if (oldest !== undefined) ledger.delete(oldest);
  }
  ledger.set(abs, { mtimeMs: st.mtimeMs, size: st.size, engineWriteMs: pre.engineWriteMs });
}

/** Run an ORCHARD-side write to transcript `file` and declare it as Orchard's own. */
export function asOrchardWrite<T>(file: string, write: () => T): T {
  const abs = path.resolve(file);
  const pre = before(abs);
  try {
    return write();
  } finally {
    after(abs, pre);
  }
}

/** Async twin, for writes that go through the SDK (rename / tag). */
export async function asOrchardWriteAsync<T>(file: string, write: () => Promise<T>): Promise<T> {
  const abs = path.resolve(file);
  const pre = before(abs);
  try {
    return await write();
  } finally {
    after(abs, pre);
  }
}

/**
 * The time an ENGINE last wrote `file`, which is the only write that says a
 * turn is running. It is the raw mtime unless the file still stands exactly as
 * an Orchard-side write left it. Then it is the engine time recorded before that
 * write, or null when Orchard created the file.
 */
export function lastEngineWriteMs(file: string, st: { mtimeMs: number; size: number }): number | null {
  const s = ledger.get(path.resolve(file));
  if (s && s.mtimeMs === st.mtimeMs && s.size === st.size) return s.engineWriteMs;
  return st.mtimeMs;
}
