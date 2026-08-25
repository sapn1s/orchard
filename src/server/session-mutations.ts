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

import * as hist from '../lib/session-history.ts';
import { deletedSessionsDir, backupFileTo, ensureDir } from '../lib/paths.ts';

/** The one reserved tag this app uses for "pinned". */
export const PIN_TAG = 'pinned';

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
  /** Value of the most recent `tag` entry seen ('' and null both mean cleared). */
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

/** Cache keyed by path, invalidated on size+mtime like session-history's own. */
const cache = new Map<string, { size: number; mtimeMs: number; meta: TitleMeta }>();

export function clearTitleMetaCache(): void {
  cache.clear();
}

function scanLines(text: string, out: TitleMeta): void {
  for (const raw of text.split('\n')) {
    // Cheap pre-filter: only three entry types matter and each is a tiny line.
    if (!raw.includes('"custom-title"') && !raw.includes('"ai-title"') && !raw.includes('"type":"tag"')) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    // Last one wins, exactly like the CLI's own reader.
    if (e.type === 'custom-title' && typeof e.customTitle === 'string') out.customTitle = e.customTitle;
    else if (e.type === 'ai-title' && typeof e.aiTitle === 'string') out.autoTitle = e.aiTitle;
    else if (e.type === 'tag') out.tag = typeof e.tag === 'string' && e.tag ? e.tag : null;
  }
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
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.meta;

  const meta: TitleMeta = { customTitle: null, autoTitle: null, tag: null, pinned: false, sampled: false };
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    if (st.size <= HEAD_BYTES + TAIL_BYTES) {
      const buf = Buffer.alloc(st.size);
      fs.readSync(fd, buf, 0, st.size, 0);
      scanLines(buf.toString('utf8'), meta);
    } else {
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
  cache.set(filePath, { size: st.size, mtimeMs: st.mtimeMs, meta });
  return meta;
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
  /** Authoritative cwd read out of the file — what the SDK's `dir` option takes. */
  cwd: string;
}

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
export function resolveSession(sessionId: string, encodedDir?: string | null): ResolvedSession {
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
    throw new SessionMutationError(
      409,
      'encoding-mismatch',
      `session ${sessionId} lives in store dir ${JSON.stringify(dir)} but its recorded cwd ${JSON.stringify(cwd)} encodes to ${JSON.stringify(expected)}. ` +
        `The SDK addresses sessions by cwd, so mutating this one would target the wrong directory. Refused.`,
      { encodedDir: dir, cwd, encodesTo: expected },
    );
  }
  return { sessionId, encodedDir: dir, filePath, cwd };
}

/* ---------------------------------------------------------------- mutations */

/** Rename via the SDK. Returns the meta as re-read from disk afterwards. */
export async function rename(target: ResolvedSession, title: string): Promise<TitleMeta> {
  await renameSession(target.sessionId, title, { dir: target.cwd });
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

  await tagSession(target.sessionId, pinned ? PIN_TAG : null, { dir: target.cwd });
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
  await deleteSession(target.sessionId, { dir: target.cwd });
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
