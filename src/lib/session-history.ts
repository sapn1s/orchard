/**
 * session-history.ts — index the real Claude Code session store (~/.claude/projects).
 *
 * Self-contained: only node:fs / node:path / node:os. No Next.js, no project imports.
 * Everything is synchronous and bounded — no file is ever slurped whole.
 *
 * ---------------------------------------------------------------------------
 * ON-DISK FORMAT (verified empirically against 663 session files / 681 MB on
 * this machine, Claude Code v2.1.x)
 * ---------------------------------------------------------------------------
 * <root>/<encodedDir>/<sessionId>.jsonl      <- a session transcript
 * <root>/<encodedDir>/<sessionId>/subagents/agent-*.jsonl   <- subagent logs (ignored)
 * <root>/<encodedDir>/sessions-index.json    <- a stale CLI-written cache (ignored)
 *
 * encodedDir = cwd.replace(/[^a-zA-Z0-9]/g, '-')
 *   Verified on 17/18 directories that contain a session file. It is LOSSY
 *   (`/`, `\`, `:`, `_`, `.` all collapse to `-`), so the encoded name is only
 *   ever used as a fallback guess — the authoritative cwd is the `cwd` field
 *   inside the JSONL entries, which is what this module reads.
 *   The 1 mismatch is real data, not a rule violation: a directory named for a
 *   Linux path that contains files copied over from the Windows install.
 *   Older Claude Code versions used a narrower rule that PRESERVED `_`
 *   (`…-random-projects-some_project` sits next to `…-some-project` in this
 *   store). Such legacy dirs are read fine — the cwd still comes from the file —
 *   and logicalKeyForCwd() normalises `_` so both spellings merge.
 *
 * Each line is one JSON object. Observed `type` values and what they carry:
 *   user                 message.content: string | Array<{type:'text'|'tool_result'|...}>
 *                        + uuid, parentUuid, timestamp, cwd, sessionId, version,
 *                          gitBranch, isSidechain, isMeta?, isCompactSummary?
 *   assistant            message.model, message.usage, message.content:
 *                          Array<{type:'thinking'|'text'|'tool_use'|'fallback'}>
 *   attachment           deferred-tool / agent-listing deltas (noise)
 *   system               subtype:'turn_duration', durationMs, messageCount
 *   ai-title             { aiTitle } — the model-generated session title.
 *                        Re-emitted every turn; the LAST one is current.
 *   last-prompt          { lastPrompt, leafUuid }
 *   mode / permission-mode / file-history-snapshot / file-history-delta /
 *   queue-operation / frame-link                                   (bookkeeping)
 *
 * Only `user` / `assistant` / `system` / `attachment` / `queue-operation` /
 * `file-history-*` entries carry `timestamp`; the rest do not.
 *
 * Dual boot: the same logical project shows up under several encoded dirs, e.g.
 *   C--Users-alice-Documents-GitHub-Example-App  (Windows)
 *   -home-alice-projects-Example-App             (Linux)
 *   -workspace-example-app                     (container)
 * groupByLogicalProject() merges them. Session files are also literally
 * duplicated across dirs (26 duplicate ids observed, byte-identical), so the
 * merged listing de-duplicates by sessionId.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/* ------------------------------------------------------------------ types */

export type SessionOS = 'linux' | 'windows' | 'unknown';

export interface ProjectDir {
  /** Directory name as it exists on disk, e.g. `C--Users-alice-Documents-GitHub-Example-App`. */
  encodedDir: string;
  /** Absolute path to the directory. */
  dirPath: string;
  /** Authoritative cwd read out of a session file. null when no session file is readable. */
  cwd: string | null;
  /** Lossy best-effort decode of `encodedDir`; only meaningful when `cwd` is null. */
  cwdGuess: string;
  os: SessionOS;
  /** Number of top-level *.jsonl session files. */
  sessionCount: number;
  /** ISO. Derived from file mtimes (cheap); exact per-session times come from listSessions(). */
  lastActivityAt: string | null;
  /** Total bytes of the session files in this directory. */
  totalBytes: number;
  /** True only if `cwd` is non-null and currently exists on this host. */
  cwdExistsOnHost: boolean;
  /** True when `encodedDir` does not match encodeCwd(cwd) — e.g. files copied between installs. */
  encodingMismatch: boolean;
  warnings: string[];
}

export interface SessionMeta {
  sessionId: string;
  encodedDir: string;
  filePath: string;
  fileBytes: number;
  fileMtime: string;
  /** ISO timestamp of the first timestamped entry. */
  startedAt: string | null;
  /** ISO timestamp of the last timestamped entry; falls back to file mtime. */
  lastActivityAt: string | null;
  /**
   * ISO timestamp of the last message the HUMAN actually submitted — the same
   * "real user prompt" test `firstUserMessage` uses (tool_results, command
   * wrappers, system-reminders, task-notifications, sidechain/meta entries are
   * NOT user submits). Distinct from `lastActivityAt`, which moves on agent
   * output too: this is the recency signal the sidebar orders by, so a session
   * an agent has been grinding in for hours does not keep jumping to the top.
   * Null when no human prompt was found in the scanned region (falls back to
   * `lastActivityAt` at the call site). In sample mode it reflects the last
   * user prompt within the head+tail window.
   */
  lastUserMessageAt: string | null;
  /** Count of non-meta, non-sidechain user+assistant entries. See `statsExact`. */
  messageCount: number;
  /** Distinct assistant models seen (synthetic entries excluded). See `statsExact`. */
  models: string[];
  /**
   * false => the file was too large to read whole and only its head+tail were
   * sampled, so `messageCount`/`models` are lower bounds over the sampled region.
   * Pass `{ scan: 'full' }` for exact values.
   */
  statsExact: boolean;
  /** Model-generated title (`ai-title`), the most recent one in the file. */
  title: string | null;
  /** First real user prompt, trimmed/normalised, capped at 400 chars. */
  firstUserMessage: string | null;
  /** First slash command invoked, e.g. `/simplify`. Some sessions contain nothing else. */
  firstCommand: string | null;
  /** title ?? firstUserMessage ?? firstCommand ?? '(untitled session)' — what a UI should show. */
  displayTitle: string;
  cwd: string | null;
  os: SessionOS;
  /** false for Windows and for container paths absent from this host: file paths inside won't resolve. */
  cwdExistsOnHost: boolean;
  gitBranch: string | null;
  /** Claude Code version that wrote the session. */
  version: string | null;
  /**
   * The CLI launch channel declared in the transcript: `'cli'` for an
   * interactive session, `'sdk-cli'`/`'sdk-ts'` for a programmatic Agent-SDK or
   * `claude -p` run, `null` on legacy transcripts written before the field
   * existed. The nav-list fold reads it (with session-provenance) to keep
   * external programmatic sessions out of the default view — see
   * `foldsFromDefaultList` in session-provenance.mjs.
   */
  entrypoint: string | null;
  warnings: string[];
}

export interface LogicalProject {
  /** Stable merge key (normalised basename of the cwd). */
  key: string;
  /** Human label, e.g. `Example_App`. */
  name: string;
  dirs: ProjectDir[];
  /** Distinct OSes contributing sessions. */
  oses: SessionOS[];
  /** Sum of per-dir session counts (before cross-dir de-duplication). */
  sessionCount: number;
  lastActivityAt: string | null;
  /** True when more than one OS contributed — paths differ between them. */
  crossOs: boolean;
}

export type TranscriptRole = 'user' | 'assistant';

export interface TranscriptBlock {
  type: string;
  /** Text for text/thinking blocks, tool name for tool_use, flattened output for tool_result. */
  text?: string;
  toolName?: string;
  toolUseId?: string;
  isError?: boolean;
  /** true when `text` was cut to `maxTextChars`. */
  truncated?: boolean;
  /** Original length of a `truncated` text/thinking/tool_result block (BUG-234). */
  fullLength?: number;
  /**
   * FEAT-177 — a user-message attachment (`type:'attachment'`). Either a
   * `dataUrl` (a CLI-written base64 image/document, rendered inline) or an
   * `uploadId`+`projectId` the client fetches from `GET /api/uploads/...`.
   */
  attachment?: {
    kind: 'image' | 'document' | 'text';
    mediaType?: string;
    name?: string;
    bytes?: number;
    uploadId?: string;
    projectId?: string;
    dataUrl?: string;
  };
}

/**
 * FEAT-177 — map a raw user-message content block (either the CLI's native
 * base64 `image`/`document` block or Orchard's lean `attachment` reference
 * block) to a renderable attachment TranscriptBlock. Returns null for any
 * block that is not an attachment. Shared by both block builders so the tail,
 * forward, live and main-transcript routes render attachments identically.
 */
export function attachmentBlockOf(b: Record<string, any>): TranscriptBlock | null {
  const MAX_INLINE_B64 = 8 * 1024 * 1024; // ~6 MB image after the 5 MB cap; larger falls back to a no-preview chip
  if (b?.type === 'image' || b?.type === 'document') {
    const src = b.source;
    const kind: 'image' | 'document' = b.type === 'document' ? 'document' : 'image';
    if (src && src.type === 'base64' && typeof src.data === 'string') {
      const mediaType = typeof src.media_type === 'string' ? src.media_type : (kind === 'document' ? 'application/pdf' : 'image/png');
      const att: NonNullable<TranscriptBlock['attachment']> = { kind, mediaType, name: typeof b.title === 'string' ? b.title : undefined };
      if (src.data.length <= MAX_INLINE_B64) att.dataUrl = `data:${mediaType};base64,${src.data}`;
      return { type: 'attachment', attachment: att };
    }
    // An Orchard-style reference carried on a native-typed block.
    if (src && src.type === 'orchard-upload' && typeof src.uploadId === 'string') {
      return { type: 'attachment', attachment: { kind, uploadId: src.uploadId, projectId: src.projectId, mediaType: src.media_type, name: typeof b.title === 'string' ? b.title : undefined } };
    }
    return { type: 'attachment', attachment: { kind } };
  }
  if (b?.type === 'attachment' && typeof b.uploadId === 'string') {
    const kind: 'image' | 'document' | 'text' = b.kind === 'document' ? 'document' : b.kind === 'text' ? 'text' : 'image';
    return { type: 'attachment', attachment: { kind, uploadId: b.uploadId, projectId: typeof b.projectId === 'string' ? b.projectId : undefined, mediaType: typeof b.mediaType === 'string' ? b.mediaType : undefined, name: typeof b.name === 'string' ? b.name : undefined, bytes: typeof b.bytes === 'number' ? b.bytes : undefined } };
  }
  return null;
}

export interface TranscriptMessage {
  index: number;
  uuid: string | null;
  parentUuid: string | null;
  role: TranscriptRole;
  timestamp: string | null;
  model: string | null;
  isMeta: boolean;
  isCompactSummary: boolean;
  /**
   * BUG-028 — true when the CLI recorded this entry because it was SHUT DOWN
   * mid-turn (server restart/redeploy/close — the process got a graceful
   * signal), not because the user stopped it. The CLI writes the same literal
   * "[Request interrupted by user]" text either way, but stamps
   * `interruptedByShutdown: true` only on the shutdown case (a real user stop
   * carries `interruptedMessageId` instead — verified against live
   * transcripts, 45 shutdown vs 181 user-stop entries, zero overlap). Carried
   * through so the renderer can attribute the break honestly.
   */
  interruptedByShutdown?: boolean;
  blocks: TranscriptBlock[];
}

export interface SessionTranscript {
  sessionId: string;
  encodedDir: string;
  filePath: string;
  messages: TranscriptMessage[];
  /** Index of the first returned message (== opts.offset). */
  offset: number;
  /** Number of qualifying messages seen while scanning, i.e. offset+returned+skipped-ahead. */
  scannedMessages: number;
  /** True when scanning stopped early because `maxBytes` was hit — counts are lower bounds. */
  budgetExhausted: boolean;
  /** True when more messages exist past the returned window. */
  hasMore: boolean;
  bytesRead: number;
  malformedLines: number;
  warnings: string[];
}

export interface ScanOptions {
  /** Root of the session store. Default: $CLAUDE_PROJECTS_DIR or ~/.claude/projects. */
  root?: string;
  /**
   * 'sample' (default) reads only a bounded head+tail of each file: exact
   * timestamps/title, lower-bound messageCount on big files.
   * 'full' streams the whole file for exact counts.
   */
  scan?: 'sample' | 'full';
  /** Bytes read from the start of each file in sample mode. Default 256 KiB. */
  headBytes?: number;
  /** Bytes read from the end of each file in sample mode. Default 256 KiB. */
  tailBytes?: number;
  /** Hard ceiling on bytes read per file in full mode. Default 256 MiB. */
  maxBytes?: number;
  /** Reuse results for files whose (size, mtime) are unchanged. Default true. */
  useCache?: boolean;
}

export interface ReadSessionOptions {
  root?: string;
  /** Skip this many qualifying messages. Default 0. */
  offset?: number;
  /** Max messages to return. Default 200, hard-capped at 2000. */
  limit?: number;
  /** Per-block text cap. Default 4000 chars. */
  maxTextChars?: number;
  /** Include tool_result blocks in user messages. Default false (they are huge). */
  includeToolResults?: boolean;
  /** Include `isMeta` / sidechain entries. Default false. */
  includeMeta?: boolean;
  /** Byte budget for the scan. Default 128 MiB. Exceeding it sets `budgetExhausted`. */
  maxBytes?: number;
}

/* -------------------------------------------------------------- constants */

const DEFAULT_HEAD_BYTES = 256 * 1024;
const DEFAULT_TAIL_BYTES = 256 * 1024;
const DEFAULT_FULL_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_READ_MAX_BYTES = 128 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const MAX_LIMIT = 2000;
const FIRST_MESSAGE_CHARS = 400;

const WINDOWS_ABS = /^[A-Za-z]:[\\/]/;

/* ------------------------------------------------------------------ paths */

export function defaultRoot(): string {
  const env = process.env.CLAUDE_PROJECTS_DIR;
  if (env && env.trim()) return env.trim();
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Reproduce Claude Code's directory encoding: every non-alphanumeric character
 * becomes '-'. Verified against 17/18 real directories.
 *
 * NOTE (BUG-243): this is the PLAIN char-replacement only. It equals the SDK's
 * actual on-disk project-dir name ONLY while the result is <= 200 chars; beyond
 * that the SDK truncates and appends a hash (see `sdkEncodeDir`). For listing,
 * where a near-miss just hides a dir, plain encoding is tolerable; for a
 * MUTATION's safety guard — "does this address resolve to the dir the file sits
 * in?" — the plain encoding is WRONG for long paths and must never be the
 * authority (it let a long-hostPath DELETE target a same-id foreign dir). Use
 * `sdkEncodeDir` wherever the answer has to match where the SDK will actually go.
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * THE SDK's REAL project-dir encoder — the single authority for "which store dir
 * does the Agent SDK resolve this cwd to?" (BUG-243). A byte-for-byte reproduction
 * of the SDK's `Vl()` (sdk.mjs): plain-encode, and if that exceeds 200 chars,
 * truncate to 200 and append `-<hash36>`, where the hash is the SDK's `b_()` — a
 * 32-bit `(h<<5)-h+c` rolling hash of the ORIGINAL cwd, `Math.abs`, base-36.
 *
 * Pinned against the SDK's actual behaviour by scripts/verify-bug-243 (a real
 * `renameSession` at a >200-char cwd lands in exactly this dir); if a future SDK
 * changes the algorithm, that test fails loudly rather than the guard silently
 * addressing the wrong directory.
 */
export function sdkEncodeDir(cwd: string): string {
  const plain = encodeCwd(cwd);
  if (plain.length <= 200) return plain;
  let h = 0;
  for (let i = 0; i < cwd.length; i++) h = ((h << 5) - h + cwd.charCodeAt(i)) | 0;
  return `${plain.slice(0, 200)}-${Math.abs(h).toString(36)}`;
}

/**
 * Best-effort inverse of `encodeCwd`. The encoding is lossy, so this is a GUESS
 * and is only used when no session file is readable. Prefer `ProjectDir.cwd`.
 */
export function decodeEncodedDir(encodedDir: string): string {
  const win = /^([A-Za-z])--(.*)$/.exec(encodedDir);
  if (win) return `${win[1]}:\\${win[2].replace(/-/g, '\\')}`;
  if (encodedDir.startsWith('-')) return '/' + encodedDir.slice(1).replace(/-/g, '/');
  return encodedDir.replace(/-/g, '/');
}

export function detectOs(cwd: string | null | undefined): SessionOS {
  if (!cwd) return 'unknown';
  if (WINDOWS_ABS.test(cwd)) return 'windows';
  if (cwd.startsWith('/')) return 'linux';
  return 'unknown';
}

/** Last path segment of a cwd, handling both separators. */
export function cwdBasename(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return cwd;
  const last = parts[parts.length - 1];
  // `C:` alone (drive root)
  if (/^[A-Za-z]:$/.test(last)) return last[0];
  return last;
}

/** Merge key: normalised basename, so `Example_App` == `example-app`. */
export function logicalKeyForCwd(cwd: string): string {
  return cwdBasename(cwd).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'root';
}

/* --------------------------------------------------------- bounded reader */

/** Read `length` bytes at `position`. Never allocates more than requested. */
function readRange(fd: number, position: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const n = fs.readSync(fd, buf, filled, length - filled, position + filled);
    if (n <= 0) break;
    filled += n;
  }
  return filled === length ? buf : buf.subarray(0, filled);
}

/**
 * Iterate whole lines from `position` to EOF (or until `maxBytes` consumed),
 * reading in CHUNK_BYTES pieces. A trailing partial line (live session being
 * appended to) is yielded only if `emitTail` is set.
 */
function* iterLinesFrom(
  fd: number,
  position: number,
  size: number,
  maxBytes: number,
  emitTail: boolean,
): Generator<string, void, void> {
  let pos = position;
  let consumed = 0;
  let carry = '';
  while (pos < size && consumed < maxBytes) {
    const want = Math.min(CHUNK_BYTES, size - pos, maxBytes - consumed);
    const buf = readRange(fd, pos, want);
    if (buf.length === 0) break;
    pos += buf.length;
    consumed += buf.length;
    const text = carry + buf.toString('utf8');
    let start = 0;
    for (;;) {
      const nl = text.indexOf('\n', start);
      if (nl === -1) break;
      yield text.slice(start, nl);
      start = nl + 1;
    }
    carry = text.slice(start);
    // Guard against a pathological single line larger than the whole budget.
    if (carry.length > maxBytes) {
      carry = '';
      break;
    }
  }
  if (emitTail && carry.length > 0) yield carry;
}

/** Split a sampled buffer into complete lines, dropping partial edges. */
function linesFromSample(buf: Buffer, dropFirst: boolean, dropLast: boolean): string[] {
  const lines = buf.toString('utf8').split('\n');
  if (dropLast && lines.length > 0) lines.pop();
  if (dropFirst && lines.length > 0) lines.shift();
  return lines;
}

/* ----------------------------------------------------------- entry helpers */

interface RawEntry {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  cwd?: string;
  sessionId?: string;
  version?: string;
  gitBranch?: string;
  /**
   * The CLI's own launch channel, declared on every user/assistant/attachment
   * entry: `cli` for an interactive session, `sdk-cli`/`sdk-ts` for a
   * programmatic Agent-SDK / `claude -p` run. Absent on legacy transcripts
   * written before the field existed. See `SessionMeta.entrypoint`.
   */
  entrypoint?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  aiTitle?: string;
  lastPrompt?: string;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
  };
}

function parseLine(line: string): RawEntry | null {
  const t = line.trim();
  if (!t || t[0] !== '{') return null;
  try {
    const v = JSON.parse(t) as unknown;
    return v && typeof v === 'object' ? (v as RawEntry) : null;
  } catch {
    return null;
  }
}

function isRealMessage(e: RawEntry): boolean {
  if (e.type !== 'user' && e.type !== 'assistant') return false;
  if (e.isSidechain === true) return false;
  if (e.isMeta === true) return false;
  return true;
}

/** Extract plain text from a user/assistant message content field. */
function contentToText(content: unknown, cap: number): string {
  if (typeof content === 'string') return content.slice(0, cap);
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; text?: string };
    if (b.type === 'text' && typeof b.text === 'string') out.push(b.text);
    if (out.join('\n').length >= cap) break;
  }
  return out.join('\n').slice(0, cap);
}

/**
 * Wrappers the CLI injects as `user` entries that are not things the human typed.
 * All observed in the real store.
 */
const WRAPPER_PREFIXES = [
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<task-notification>',
  '<system-reminder>',
  'Caveat: The messages below',
];

function isRealUserPrompt(e: RawEntry, text: string): boolean {
  if (e.type !== 'user') return false;
  if (e.isMeta === true || e.isSidechain === true || e.isCompactSummary === true) return false;
  const t = text.trimStart();
  if (!t) return false;
  return !WRAPPER_PREFIXES.some((p) => t.startsWith(p));
}

/** Pull `/simplify` out of a `<command-name>/simplify</command-name>` wrapper. */
function extractCommandName(text: string): string | null {
  const m = /<command-name>\s*([^<\s][^<]*?)\s*<\/command-name>/.exec(text);
  if (!m) return null;
  const name = m[1].trim();
  if (!name) return null;
  return name.startsWith('/') ? name : `/${name}`;
}

function normaliseTitle(s: string): string {
  return s.replace(/\s+/g, ' ').trim().replace(/^"+|"+$/g, '');
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  const d = Date.parse(v);
  return Number.isNaN(d) ? null : v;
}

function maxIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function minIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

/* ------------------------------------------------------------------ cache */

interface CacheEntry {
  size: number;
  mtimeMs: number;
  scan: 'sample' | 'full';
  meta: SessionMeta;
}

const metaCache = new Map<string, CacheEntry>();

/**
 * FEAT-199 (round 6) — exact real-message counts for the canonical twin
 * tie-break, keyed by `path\0mtimeMs\0size`. Populated ONLY on a same-id twin
 * collision (rare), by a FULL streaming parse of the whole file (no sampling,
 * no size cap) — see `exactRealMessageCount`. A count already in this cache is
 * valid as long as the file's mtime and size are unchanged, so repeated list
 * calls over a steady store never re-parse; a file that grows between calls
 * (run d37b0ba5's "twin grows between list and deep link") gets a NEW key and a
 * fresh exact parse.
 */
const exactCountCache = new Map<string, number>();

/**
 * BUG-158 — `probeCwd` memoised by file PATH. A session file's `cwd` is written
 * on the first line and never changes (even as the file grows, and Claude's
 * store is append-only with per-session-id filenames that are never reused), so
 * path alone is a sound, permanent key. This matters because `listProjectDirs`
 * probes the newest file of every one of ~750 directories, and that probe — not
 * the `stat` walk — is the bulk of its cost (~120 ms of ~135 ms measured); on a
 * `GET /api/projects` request that runs it once per registered project the same
 * newest files were re-read up to 13 times.
 */
const cwdProbeCache = new Map<string, string | null>();

/** Drop all memoised session metadata. Exposed for tests / forced refresh. */
export function clearSessionCache(): void {
  metaCache.clear();
  cwdProbeCache.clear();
  exactCountCache.clear();
}

/* -------------------------------------------------------- project listing */

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Absolute paths of the top-level session files in an encoded dir (excludes subagents/). */
export function listSessionFiles(encodedDir: string, opts: ScanOptions = {}): string[] {
  const root = opts.root ?? defaultRoot();
  const dirPath = path.join(root, encodedDir);
  return safeReaddir(dirPath)
    .filter((d) => d.isFile() && d.name.endsWith('.jsonl'))
    .map((d) => path.join(dirPath, d.name))
    .sort();
}

/**
 * FEAT-199 — a STAT-ONLY enumeration of an encoded dir's sessions. No file is
 * opened or parsed, so this is O(files) stats and nothing else — the cheap pass
 * that lets the paginated list sort by recency and parse ONLY the first page's
 * files instead of sampling ~512 KB from every file in the store on a cold load.
 *
 * `sessionId` is the filename stem. That is sound and permanent: the store names
 * each file `<sessionId>.jsonl` and never reuses an id (see the BUG-158 note on
 * `cwdProbeCache`); `readSessionMeta` itself falls back to the stem when the
 * in-file `sessionId` is absent. `mtimeMs` is the recency proxy the page orders
 * by — a pin/rename/new prompt all APPEND to the file, so a touched session
 * rises to the top exactly as the parsed `lastActivityAt` ordering would place
 * it. The true `lastUserMessageAt` order is restored for the page once its files
 * are parsed.
 */
export interface SessionStub {
  sessionId: string;
  encodedDir: string;
  filePath: string;
  mtimeMs: number;
  fileBytes: number;
}

export function listSessionStubs(encodedDir: string, opts: ScanOptions = {}): SessionStub[] {
  const out: SessionStub[] = [];
  for (const f of listSessionFiles(encodedDir, opts)) {
    let st: fs.Stats;
    try {
      st = fs.statSync(f);
    } catch {
      continue;
    }
    out.push({
      sessionId: path.basename(f).replace(/\.jsonl$/, ''),
      encodedDir,
      filePath: f,
      mtimeMs: st.mtimeMs,
      fileBytes: st.size,
    });
  }
  return out;
}

/**
 * FEAT-199 — the in-file `sessionId` and `cwd` of a session file, the two
 * top-level head facts the canonical index needs, recovered cheaply but
 * returning EXACTLY what `readSessionMeta` would resolve (the id before its stem
 * fallback; the cwd as the first top-level `cwd` field). The store names each
 * file `<sessionId>.jsonl` so the stem is almost always the id, but the full
 * list (`listLogicalProjectSessions`) de-duplicates on the IN-FILE id and breaks
 * same-id cross-dir twin ties by the file's OWN cwd — so the paginated pool and
 * the deep-link resolver must key on those SAME facts, or a file whose stem was
 * renamed/copied away from its id would surface the session twice, or a twin
 * would resolve to a different copy than the list shows.
 *
 * It must NOT diverge from `readSessionMeta`: a first attempt that read only
 * 16 KB and regex-matched the first `"sessionId"` string was BROKEN (anthropic
 * run 0ebe209e) — a file whose first entry is a >16 KB snapshot with no
 * top-level id would key by stem while readSessionMeta recovered the real id
 * deeper in the head. So this PARSES JSONL lines (never a raw regex, so a
 * `"sessionId"`/`"cwd"` inside a message body can't be mistaken for the field)
 * over the SAME regions readSessionMeta samples — the whole file when small,
 * else the 256 KB head and, only if a fact is still missing, the 256 KB tail —
 * and takes the first top-level value for each. A 32 KB fast path covers every
 * normal file (both are on the first entry) so the big reads happen only for a
 * pathological oversized first entry. Either fact is null only when no top-level
 * value exists anywhere readSessionMeta would look (→ id caller falls back to
 * the stem, as readSessionMeta does).
 */
export function readSessionHeadFacts(filePath: string): { sessionId: string | null; cwd: string | null } {
  let fd: number | null = null;
  let sessionId: string | null = null;
  let cwd: string | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size === 0) return { sessionId, cwd };
    // Scan one sampled region; return true once BOTH facts are in hand so the
    // bigger reads are skipped as soon as nothing more can be learned.
    const scanInto = (buf: Buffer, dropFirst: boolean, dropLast: boolean): boolean => {
      for (const line of linesFromSample(buf, dropFirst, dropLast)) {
        const e = parseLine(line);
        if (!e) continue;
        if (!sessionId && typeof e.sessionId === 'string' && e.sessionId) sessionId = e.sessionId;
        if (!cwd && typeof e.cwd === 'string' && e.cwd) cwd = e.cwd;
        if (sessionId && cwd) return true;
      }
      return false;
    };
    // Fast path: in every normal file both are on the first entry.
    const FAST = 32 * 1024;
    if (size <= FAST) {
      scanInto(readRange(fd, 0, size), false, false);
      return { sessionId, cwd };
    }
    if (scanInto(readRange(fd, 0, FAST), false, true)) return { sessionId, cwd };
    // Mirror readSessionMeta's sampling for an oversized first entry.
    if (size <= DEFAULT_HEAD_BYTES + DEFAULT_TAIL_BYTES) {
      scanInto(readRange(fd, 0, size), false, false);
      return { sessionId, cwd };
    }
    if (scanInto(readRange(fd, 0, DEFAULT_HEAD_BYTES), false, true)) return { sessionId, cwd };
    scanInto(readRange(fd, size - DEFAULT_TAIL_BYTES, DEFAULT_TAIL_BYTES), true, false);
    return { sessionId, cwd };
  } catch {
    return { sessionId, cwd };
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

/** FEAT-199 — the in-file sessionId alone (see `readSessionHeadFacts`). */
export function readSessionIdHead(filePath: string): string | null {
  return readSessionHeadFacts(filePath).sessionId;
}

/**
 * Enumerate every project directory in the store.
 * Cheap by design: stats every session file, but only parses the head of one
 * file per directory to recover the authoritative cwd.
 */
export function listProjectDirs(opts: ScanOptions = {}): ProjectDir[] {
  const root = opts.root ?? defaultRoot();
  const out: ProjectDir[] = [];

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    throw new Error(
      `session-history: cannot read session store at ${root}: ${(err as Error).message}. ` +
        `Set CLAUDE_PROJECTS_DIR or pass { root }.`,
    );
  }

  for (const de of dirents) {
    if (!de.isDirectory()) continue;
    const encodedDir = de.name;
    const dirPath = path.join(root, encodedDir);
    const warnings: string[] = [];

    const files = safeReaddir(dirPath).filter((d) => d.isFile() && d.name.endsWith('.jsonl'));
    let lastMtimeMs = 0;
    let totalBytes = 0;
    let newestFile: string | null = null;
    for (const f of files) {
      const p = path.join(dirPath, f.name);
      try {
        const st = fs.statSync(p);
        totalBytes += st.size;
        if (st.mtimeMs > lastMtimeMs) {
          lastMtimeMs = st.mtimeMs;
          newestFile = p;
        }
      } catch {
        warnings.push(`unreadable file: ${f.name}`);
      }
    }

    let cwd: string | null = null;
    if (newestFile) {
      cwd = probeCwdCached(newestFile);
      if (!cwd) warnings.push('no cwd field found in the sampled head of the newest session file');
    }

    const cwdGuess = decodeEncodedDir(encodedDir);
    const detected = detectOs(cwd ?? cwdGuess);
    const encodingMismatch = cwd !== null && encodeCwd(cwd) !== encodedDir;
    if (encodingMismatch) {
      warnings.push(
        `directory name does not match encodeCwd(${JSON.stringify(cwd)}) = ` +
          `${encodeCwd(cwd as string)} — sessions were likely copied in from another install`,
      );
    }

    let cwdExistsOnHost = false;
    if (cwd && detected === 'linux') {
      try {
        cwdExistsOnHost = fs.statSync(cwd).isDirectory();
      } catch {
        cwdExistsOnHost = false;
      }
    }
    if (detected === 'windows') {
      warnings.push('Windows session: file paths inside these transcripts do not resolve on this host');
    }

    out.push({
      encodedDir,
      dirPath,
      cwd,
      cwdGuess,
      os: detected,
      sessionCount: files.length,
      lastActivityAt: lastMtimeMs ? new Date(lastMtimeMs).toISOString() : null,
      totalBytes,
      cwdExistsOnHost,
      encodingMismatch,
      warnings,
    });
  }

  out.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  return out;
}

/** `probeCwd` behind the path-keyed memo (BUG-158). See `cwdProbeCache`. */
function probeCwdCached(filePath: string): string | null {
  const hit = cwdProbeCache.get(filePath);
  if (hit !== undefined) return hit;
  const cwd = probeCwd(filePath);
  cwdProbeCache.set(filePath, cwd);
  return cwd;
}

/** Read just enough of a file's head to find its `cwd`. */
function probeCwd(filePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const buf = readRange(fd, 0, Math.min(DEFAULT_HEAD_BYTES, size));
    for (const line of linesFromSample(buf, false, buf.length < size)) {
      const e = parseLine(line);
      if (e && typeof e.cwd === 'string' && e.cwd) return e.cwd;
    }
    return null;
  } catch {
    return null;
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

/* -------------------------------------------------------- session listing */

/** Metadata for every session in one encoded directory, newest activity first. */
export function listSessions(encodedDir: string, opts: ScanOptions = {}): SessionMeta[] {
  const files = listSessionFiles(encodedDir, opts);
  const out: SessionMeta[] = [];
  for (const f of files) {
    const meta = readSessionMeta(f, encodedDir, opts);
    if (meta) out.push(meta);
  }
  out.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  return out;
}

/** Metadata for a single session file. Returns null if the file cannot be opened. */
export function readSessionMeta(
  filePath: string,
  encodedDir: string,
  opts: ScanOptions = {},
): SessionMeta | null {
  const scan = opts.scan ?? 'sample';
  const useCache = opts.useCache !== false;

  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch {
    return null;
  }

  const cacheKey = filePath;
  if (useCache) {
    const hit = metaCache.get(cacheKey);
    if (
      hit &&
      hit.size === st.size &&
      hit.mtimeMs === st.mtimeMs &&
      (hit.scan === 'full' || scan === 'sample')
    ) {
      return hit.meta;
    }
  }

  const headBytes = opts.headBytes ?? DEFAULT_HEAD_BYTES;
  const tailBytes = opts.tailBytes ?? DEFAULT_TAIL_BYTES;
  const maxBytes = opts.maxBytes ?? DEFAULT_FULL_MAX_BYTES;

  const warnings: string[] = [];
  let messageCount = 0;
  let malformed = 0;
  let startedAt: string | null = null;
  let lastActivityAt: string | null = null;
  let lastUserMessageAt: string | null = null;
  let title: string | null = null;
  let firstUserMessage: string | null = null;
  let firstCommand: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let version: string | null = null;
  let entrypoint: string | null = null;
  let sessionId: string | null = null;
  const models = new Set<string>();
  let statsExact = true;

  const consume = (line: string, region: 'head' | 'tail' | 'full'): void => {
    if (!line.trim()) return;
    const e = parseLine(line);
    if (!e) {
      malformed++;
      return;
    }
    if (!sessionId && typeof e.sessionId === 'string') sessionId = e.sessionId;
    if (!cwd && typeof e.cwd === 'string' && e.cwd) cwd = e.cwd;
    if (!gitBranch && typeof e.gitBranch === 'string') gitBranch = e.gitBranch;
    if (!version && typeof e.version === 'string') version = e.version;
    // First declared launch channel wins; it is re-emitted identically on every
    // entry, so the head is enough and this never needs a full scan.
    if (!entrypoint && typeof e.entrypoint === 'string' && e.entrypoint) entrypoint = e.entrypoint;

    const ts = isoOrNull(e.timestamp);
    if (ts) {
      // In sample mode the head holds the earliest and the tail the latest.
      if (region !== 'tail') startedAt = minIso(startedAt, ts);
      lastActivityAt = maxIso(lastActivityAt, ts);
    }

    if (e.type === 'ai-title' && typeof e.aiTitle === 'string' && e.aiTitle.trim()) {
      // Re-emitted every turn; later wins.
      title = normaliseTitle(e.aiTitle);
    }

    if (isRealMessage(e)) {
      messageCount++;
      if (e.type === 'assistant') {
        const m = e.message?.model;
        if (typeof m === 'string' && m && !m.startsWith('<')) models.add(m);
      } else {
        // Evaluate EVERY user entry (not just the first) so the LAST genuine
        // human submit's timestamp is captured — the ordering signal. The
        // text is bounded by contentToText's cap, and user prompts are sparse
        // relative to tool_result turns, so this stays cheap.
        const text = contentToText(e.message?.content, FIRST_MESSAGE_CHARS * 4);
        if (isRealUserPrompt(e, text)) {
          lastUserMessageAt = maxIso(lastUserMessageAt, ts);
          if (!firstUserMessage) firstUserMessage = normaliseTitle(text).slice(0, FIRST_MESSAGE_CHARS);
        } else if (!firstUserMessage && !firstCommand) {
          firstCommand = extractCommandName(text);
        }
      }
    }
  };

  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = st.size;

    if (scan === 'full' || size <= headBytes + tailBytes) {
      if (scan === 'full' && size > maxBytes) {
        statsExact = false;
        warnings.push(`file is ${size} bytes, above maxBytes=${maxBytes}: counts are lower bounds`);
      }
      for (const line of iterLinesFrom(fd, 0, size, Math.min(size, maxBytes), true)) {
        consume(line, 'full');
      }
    } else {
      statsExact = false;
      const head = readRange(fd, 0, headBytes);
      for (const line of linesFromSample(head, false, true)) consume(line, 'head');
      const tail = readRange(fd, size - tailBytes, tailBytes);
      for (const line of linesFromSample(tail, true, false)) consume(line, 'tail');
      warnings.push(
        `sampled ${headBytes + tailBytes} of ${size} bytes: messageCount/models are lower bounds`,
      );
    }
  } catch (err) {
    warnings.push(`read error: ${(err as Error).message}`);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }

  if (malformed > 0) warnings.push(`${malformed} malformed JSONL line(s) skipped`);

  const base = path.basename(filePath).replace(/\.jsonl$/, '');
  const resolvedId = sessionId ?? base;
  if (sessionId && sessionId !== base) {
    warnings.push(`sessionId field (${sessionId}) differs from filename (${base})`);
  }

  const detected = detectOs(cwd);
  let cwdExistsOnHost = false;
  if (cwd && detected === 'linux') {
    try {
      cwdExistsOnHost = fs.statSync(cwd).isDirectory();
    } catch {
      cwdExistsOnHost = false;
    }
  }

  const meta: SessionMeta = {
    sessionId: resolvedId,
    encodedDir,
    filePath,
    fileBytes: st.size,
    fileMtime: new Date(st.mtimeMs).toISOString(),
    startedAt,
    lastActivityAt: lastActivityAt ?? new Date(st.mtimeMs).toISOString(),
    lastUserMessageAt,
    messageCount,
    models: Array.from(models).sort(),
    statsExact,
    title,
    firstUserMessage,
    firstCommand,
    displayTitle: title ?? firstUserMessage ?? firstCommand ?? '(untitled session)',
    cwd,
    os: detected,
    cwdExistsOnHost,
    gitBranch,
    version,
    entrypoint,
    warnings,
  };

  if (opts.useCache !== false) {
    metaCache.set(cacheKey, { size: st.size, mtimeMs: st.mtimeMs, scan, meta });
  }
  return meta;
}

/** Absolute path of a session file, or null when it does not exist. */
export function resolveSessionFile(
  encodedDir: string,
  sessionId: string,
  opts: { root?: string } = {},
): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId.includes('..')) return null;
  if (encodedDir.includes('/') || encodedDir.includes('\\') || encodedDir.includes('..')) return null;
  const root = opts.root ?? defaultRoot();
  const p = path.join(root, encodedDir, `${sessionId}.jsonl`);
  const rel = path.relative(path.resolve(root), path.resolve(p));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try {
    return fs.statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

/**
 * FEAT-199 (r7) — resolve a session id to its CANONICAL file in one encoded dir,
 * THROUGH `canonicalSessionIndex` (the ONE owner of "which file is this id",
 * ARCH-010). Use this, not `resolveSessionFile`, anywhere a session id must map
 * to the SAME file the list / page / deep-link resolver chose.
 *
 * `resolveSessionFile` maps an id to `<id>.jsonl` by FILENAME, which re-derives
 * the choice and loses two ways (IV run 5824d6f4): (a) a truncated/metadata
 * `<id>.jsonl` STUB sitting next to a renamed real copy with the same in-file id
 * wins on filename, so the read serves the stub the list already rejected; and
 * (b) a stem COLLISION — `<Y>.jsonl` holding in-file id Z — serves session Z's
 * transcript when the caller asked for Y. Resolving through the index keys by the
 * IN-FILE id and applies the same twin tie-break, so it can never disagree with
 * the list. Same path-safety guards as `resolveSessionFile` (a bad id/dir returns
 * null rather than steering the dir scan outside the store).
 */
export function resolveCanonicalSessionFile(
  encodedDir: string,
  sessionId: string,
  opts: ScanOptions = {},
): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId.includes('..')) return null;
  if (encodedDir.includes('/') || encodedDir.includes('\\') || encodedDir.includes('..')) return null;
  return canonicalSessionIndex([encodedDir], opts).get(sessionId)?.filePath ?? null;
}

/* ------------------------------------------------------------ transcripts */

/**
 * Read a page of a session transcript. Streams in 1 MiB chunks and never holds
 * more than `limit` messages, so a 286 MB session cannot blow memory.
 */
export function readSession(
  encodedDir: string,
  sessionId: string,
  opts: ReadSessionOptions = {},
): SessionTranscript {
  const filePath = resolveSessionFile(encodedDir, sessionId, { root: opts.root });
  if (!filePath) {
    throw new Error(
      `session-history: no session file for ${JSON.stringify(encodedDir)}/${JSON.stringify(sessionId)} under ${opts.root ?? defaultRoot()}`,
    );
  }

  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? 200)));
  // BUG-234: absent cap = full fidelity (not 4000). A cap applies only when a
  // caller asks; delivery goes through deliverText (plain cut + metadata).
  const maxTextChars = opts.maxTextChars == null ? undefined : Math.max(0, Math.floor(opts.maxTextChars));
  const includeToolResults = opts.includeToolResults === true;
  const includeMeta = opts.includeMeta === true;
  const maxBytes = opts.maxBytes ?? DEFAULT_READ_MAX_BYTES;

  const messages: TranscriptMessage[] = [];
  const warnings: string[] = [];
  let scanned = 0;
  let malformed = 0;
  let hasMore = false;
  let bytesRead = 0;
  let budgetExhausted = false;

  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    bytesRead = Math.min(size, maxBytes);
    if (size > maxBytes) {
      budgetExhausted = true;
      warnings.push(`file is ${size} bytes; scan stopped at maxBytes=${maxBytes}`);
    }

    // emitTail=true: a complete final line may legitimately lack a trailing
    // newline. A genuinely partial line (live session) fails to parse and is
    // reported as malformed rather than silently swallowing a real message.
    for (const line of iterLinesFrom(fd, 0, size, maxBytes, true)) {
      if (!line.trim()) continue;
      const e = parseLine(line);
      if (!e) {
        malformed++;
        continue;
      }
      if (e.type !== 'user' && e.type !== 'assistant') continue;
      if (!includeMeta && (e.isMeta === true || e.isSidechain === true)) continue;

      const idx = scanned;
      scanned++;
      if (idx < offset) continue;
      if (messages.length >= limit) {
        hasMore = true;
        break;
      }

      messages.push({
        index: idx,
        uuid: typeof e.uuid === 'string' ? e.uuid : null,
        parentUuid: typeof e.parentUuid === 'string' ? e.parentUuid : null,
        role: e.type,
        timestamp: isoOrNull(e.timestamp),
        model: typeof e.message?.model === 'string' ? (e.message.model as string) : null,
        isMeta: e.isMeta === true,
        isCompactSummary: e.isCompactSummary === true,
        blocks: toBlocks(e.message?.content, maxTextChars, includeToolResults),
      });
    }
  } catch (err) {
    warnings.push(`read error: ${(err as Error).message}`);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }

  if (malformed > 0) warnings.push(`${malformed} malformed JSONL line(s) skipped`);

  return {
    sessionId,
    encodedDir,
    filePath,
    messages,
    offset,
    scannedMessages: scanned,
    budgetExhausted,
    hasMore,
    bytesRead,
    malformedLines: malformed,
    warnings,
  };
}

/*
 * ------------------------------------------------------------------------
 * SINGLE AUTHORITY: transcript text block -> delivered text (BUG-234)
 * ------------------------------------------------------------------------
 * Exactly ONE function owns "given a stored text/thinking/tool_result block
 * and an optional cap, HOW MUCH text do we deliver?": `deliverText`. jsonl.ts
 * `blocksOf` (main tail / forward / live follow), subagents.ts
 * `getSubagentMessages` (subagent tail + PAGE routes) and this file's
 * `readSession` all call it; there is no second `?? 4000` and no second raw
 * slice of block text anywhere.
 *
 *   - DEFAULT is FULL fidelity. `maxTextChars == null` means "all of it"; a
 *     cap applies ONLY when a caller asks for one.
 *   - A cap that bites is a PLAIN STRING cut (it only refuses to split a
 *     UTF-16 surrogate pair) plus METADATA: `truncated: true` and the original
 *     `fullLength`. Nothing is appended to the text.
 *
 * BUG-234 r7: the READING ROUTES NO LONGER PASS A CAP. The main tail/forward,
 * live follow and subagent tail/page routes all call these with `maxTextChars`
 * undefined, so a block delivered to the reading view is NEVER `truncated` — the
 * mid-fence-cut class that rendered a table as raw <pre> is removed by
 * construction, and the client's old `closeTruncatedFence` / truncation-note
 * machinery is gone. The only caller that still passes a cap is a NON-reading one:
 * transcript.ts's emptiness check (`maxTextChars: 1`, used only for `.length > 0`).
 *
 * THE SERVER DOES NOT REASON ABOUT MARKDOWN (BUG-234 r3, ARCH-010). Rounds 1-2
 * closed a dangling code fence here by mirroring the client's fence grammar;
 * independent verification broke that mirror three times (CRLF, then a
 * list-nested fence whose column-0 closer the client's container bound rejects).
 * `deliverText` only ever cuts the string; it adds no fence/markdown repair.
 */
export function deliverText(
  s: string,
  maxTextChars?: number | null,
): { text: string; truncated?: boolean; fullLength?: number } {
  const cap = maxTextChars == null ? Infinity : Math.max(0, Math.floor(maxTextChars));
  if (s.length <= cap) return { text: s };
  let cut = cap;
  // Never leave half a surrogate pair at the end of the delivered string.
  if (cut > 0 && /[\uD800-\uDBFF]/.test(s[cut - 1]!)) cut -= 1;
  return { text: s.slice(0, cut), truncated: true, fullLength: s.length };
}

function toBlocks(content: unknown, cap: number | undefined, includeToolResults: boolean): TranscriptBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'text', ...deliverText(content, cap) }];
  }
  if (!Array.isArray(content)) return [];
  const out: TranscriptBlock[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const b = raw as {
      type?: string;
      text?: string;
      thinking?: string;
      name?: string;
      id?: string;
      input?: unknown;
      tool_use_id?: string;
      is_error?: boolean;
      content?: unknown;
    };
    const type = typeof b.type === 'string' ? b.type : 'unknown';
    const att = attachmentBlockOf(b as Record<string, any>); // FEAT-177
    if (att) { out.push(att); continue; }
    if (type === 'text' || type === 'thinking') {
      const src = type === 'thinking' ? (b.thinking ?? '') : (b.text ?? '');
      out.push({ type, ...deliverText(src, cap) });
    } else if (type === 'tool_use') {
      let input = '';
      try {
        input = JSON.stringify(b.input ?? null);
      } catch {
        input = '<uninspectable input>';
      }
      // tool_use carries JSON the UI JSON.parses for the chip arg, not a
      // delivered text block; it keeps its own raw-slice cap (BUG-234).
      const jsonCap = cap == null ? Infinity : cap;
      out.push({
        type,
        toolName: typeof b.name === 'string' ? b.name : undefined,
        toolUseId: typeof b.id === 'string' ? b.id : undefined,
        text: input.slice(0, jsonCap),
        truncated: input.length > jsonCap,
      });
    } else if (type === 'tool_result') {
      if (!includeToolResults) {
        out.push({ type, toolUseId: b.tool_use_id, isError: b.is_error === true, text: '' });
        continue;
      }
      const flat = flattenToolResult(b.content, cap ?? Infinity);
      out.push({
        type,
        toolUseId: typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined,
        isError: b.is_error === true,
        ...deliverText(flat, cap),
      });
    } else {
      out.push({ type });
    }
  }
  return out;
}

function flattenToolResult(content: unknown, cap: number): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (c && typeof c === 'object') {
        const cc = c as { type?: string; text?: string };
        if (cc.type === 'text' && typeof cc.text === 'string') parts.push(cc.text);
        else parts.push(`[${cc.type ?? 'block'}]`);
      }
      if (parts.join('\n').length >= cap) break;
    }
    return parts.join('\n');
  }
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return '';
  }
}

/* ------------------------------------------------------- logical grouping */

/**
 * Merge the encoded dirs that belong to one logical project — i.e. the Windows
 * (`C--Users-…`), Linux (`-home-…`) and container (`-workspace-…`) copies of
 * the same repo — keyed on the normalised basename of their cwd.
 *
 * Known limitation: two genuinely unrelated projects whose folders share a name
 * merge into one. `LogicalProject.dirs` keeps the full paths so a UI can show
 * the distinction.
 */
export function groupByLogicalProject(dirs: ProjectDir[]): LogicalProject[] {
  const byKey = new Map<string, LogicalProject>();
  for (const d of dirs) {
    const source = d.cwd ?? d.cwdGuess;
    const key = logicalKeyForCwd(source);
    let g = byKey.get(key);
    if (!g) {
      g = {
        key,
        name: cwdBasename(source),
        dirs: [],
        oses: [],
        sessionCount: 0,
        lastActivityAt: null,
        crossOs: false,
      };
      byKey.set(key, g);
    }
    g.dirs.push(d);
    g.sessionCount += d.sessionCount;
    g.lastActivityAt = maxIso(g.lastActivityAt, d.lastActivityAt);
    if (!g.oses.includes(d.os)) g.oses.push(d.os);
  }
  const out = Array.from(byKey.values());
  for (const g of out) {
    g.oses.sort();
    g.crossOs = g.oses.filter((o) => o !== 'unknown').length > 1;
    g.dirs.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
    // Prefer a name from a dir with a real cwd.
    const named = g.dirs.find((d) => d.cwd);
    if (named && named.cwd) g.name = cwdBasename(named.cwd);
  }
  out.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  return out;
}

/**
 * Every session across a logical project's dirs, de-duplicated by sessionId and
 * sorted newest-activity-first. Duplicates are real: sessions copied between the
 * Windows and Linux stores appear under both encoded dirs (byte-identical).
 */
export function listLogicalProjectSessions(
  project: LogicalProject,
  opts: ScanOptions = {},
): SessionMeta[] {
  // ARCH-010 — the choice of WHICH file is the canonical copy of each session id
  // is owned by `canonicalSessionIndex` and read here, by the paginated pool and
  // by the deep-link resolver alike. No reader re-derives the tie-break (an
  // earlier second derivation in the pool chose a different twin than this list:
  // runs b757f33e / c44745cb). This list just parses each canonical copy.
  const index = canonicalSessionIndex(project.dirs.map((d) => d.encodedDir), opts);
  const out: SessionMeta[] = [];
  for (const entry of index.values()) {
    const meta = readSessionMeta(entry.filePath, entry.encodedDir, opts);
    if (!meta) continue;
    // NB: never mutate the memo-cached `meta`; copy when attaching warnings.
    if (entry.droppedCopies.length) {
      out.push({
        ...meta,
        warnings: meta.warnings.concat(
          entry.droppedCopies.map((d) => `duplicate copy ignored: ${d.encodedDir}/${d.sessionId}.jsonl`),
        ),
      });
    } else {
      out.push(meta);
    }
  }
  out.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  return out;
}

/**
 * FEAT-199 (round 6) — the EXACT count of real (`user`/`assistant`, non-meta,
 * non-sidechain) messages in a session file, by a FULL streaming parse of the
 * whole file: no head/tail sampling, no `maxBytes` cap. This is the ground
 * truth the canonical tie-break needs — every proxy for completeness has
 * broken in turn (fileBytes>0 let a metadata stub win, run 72b30fd7; a sampled
 * messageCount let a truncated prefix win, run 459a68fa; file SIZE let an
 * 822 KB metadata-only twin with 0 real messages beat an 80-message real
 * transcript, run d37b0ba5). Size is a proxy for completeness, and proxies keep
 * breaking, so on a collision we count exactly.
 *
 * Cost is bounded by rarity: this runs ONLY when a same-id twin collision is
 * actually found (see `canonicalSessionIndex`), and the result is memoised in
 * `exactCountCache` keyed by (path, mtime, size) so repeated list calls over a
 * steady store never re-parse. Returns -1 for an unreadable file (a DEFINITE
 * "no real transcript", strictly below any real count).
 */
function exactRealMessageCount(filePath: string): number {
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch {
    return -1;
  }
  const key = `${filePath}\0${st.mtimeMs}\0${st.size}`;
  const hit = exactCountCache.get(key);
  if (hit !== undefined) return hit;

  let count = 0;
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    // Full file, whole size as the byte budget — no sampling, no cap.
    for (const ln of iterLinesFrom(fd, 0, st.size, st.size, true)) {
      const e = parseLine(ln);
      if (e && isRealMessage(e)) count++;
    }
  } catch {
    count = -1;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
  exactCountCache.set(key, count);
  return count;
}

/**
 * FEAT-199 / ARCH-010 — the SINGLE owner of the fact "which file is the
 * canonical copy of each session id" across a set of encoded dirs. Built cheaply
 * (stat + a head parse per file via `readSessionHeadFacts` — no whole-file read),
 * keyed by the IN-FILE sessionId (stem fallback, as `readSessionMeta` does).
 *
 * The tie-break for same-id cross-dir twins lives here and NOWHERE else, so the
 * full list, the paginated page and the by-id resolver can never disagree on
 * which copy a given id names. On a collision we compute a total-order SORT KEY
 * per copy and pick the MAX (never pairwise "prefer" calls — a non-transitive
 * comparator over 3+ copies could pick a loser). The key, most significant
 * first:
 *   1. the EXACT real-message count (full streaming parse — NO proxy). More
 *      real messages wins, so a 0-byte / metadata-only / truncated twin can
 *      NEVER win: it has fewer (often 0) real messages than the real
 *      transcript. This replaces every earlier completeness proxy that broke in
 *      turn — fileBytes>0 (run 72b30fd7), sampled messageCount (run 459a68fa)
 *      and file SIZE (run d37b0ba5: an 822 KB metadata-only twin with 0 real
 *      messages beat an 80-message real transcript because size was the proxy).
 *   2. equal counts → the copy whose OWN cwd encodes to its dir is canonical
 *      (the other is a copy carried in from another install);
 *   3. then the NEWEST mtime;
 *   4. then a stable path comparison (the lexicographically smaller path wins),
 *      a deterministic, dir-order-independent final tiebreak.
 * The exact count is computed LAZILY and ONLY on a collision (rare — twins are
 * a same-id clash across dirs), memoised by (path, mtime, size); the common
 * no-twin walk stays at stat + one head parse per file (no whole-file read), so
 * the first page stays cheap. Each entry carries the copies it beat, so the
 * full list can keep emitting its "duplicate copy ignored" warnings unchanged.
 */
export interface CanonicalSessionEntry {
  sessionId: string;
  filePath: string;
  encodedDir: string;
  mtimeMs: number;
  fileBytes: number;
  cwd: string | null;
  messages?: number; // EXACT real-message count (lazy; filled only on a twin collision)
  messagesExact?: boolean; // always true once filled (exact full parse); kept for callers
  droppedCopies: { encodedDir: string; sessionId: string }[];
}

export function canonicalSessionIndex(
  encodedDirs: string[],
  opts: ScanOptions = {},
): Map<string, CanonicalSessionEntry> {
  // Collect every copy of each id first (encounter order preserved), then
  // resolve collisions by a total-order sort key — so 3+ copies pick a unique,
  // transitive winner independent of dir-walk order.
  const copiesById = new Map<string, CanonicalSessionEntry[]>();
  for (const d of encodedDirs) {
    for (const stub of listSessionStubs(d, opts)) {
      const facts = readSessionHeadFacts(stub.filePath);
      const id = facts.sessionId ?? stub.sessionId;
      const cur: CanonicalSessionEntry = {
        sessionId: id,
        filePath: stub.filePath,
        encodedDir: stub.encodedDir,
        mtimeMs: stub.mtimeMs,
        fileBytes: stub.fileBytes,
        cwd: facts.cwd,
        droppedCopies: [],
      };
      const arr = copiesById.get(id);
      if (arr) arr.push(cur);
      else copiesById.set(id, [cur]);
    }
  }

  // "Does this copy's OWN cwd resolve to the dir it sits in?" — a
  // store-placement question, so it MUST use `sdkEncodeDir`, the SDK's real
  // encoder, NOT plain `encodeCwd` (BUG-243): for a cwd over 200 chars the SDK
  // truncates and appends a hash, so plain `encodeCwd` NEVER matches the real
  // dir and rule (b) would silently never fire for long-path projects, letting
  // a newer non-canonical twin win on mtime (independent-verify run 87bdfef5).
  const isCanon = (e: CanonicalSessionEntry): boolean =>
    e.cwd !== null && sdkEncodeDir(e.cwd) === e.encodedDir;

  // Returns > 0 when `a` is the more-canonical copy than `b` (a total order:
  // exact messages, then canonical-cwd, then newest mtime, then smaller path).
  const better = (a: CanonicalSessionEntry, b: CanonicalSessionEntry): number => {
    if (a.messages !== b.messages) return (a.messages as number) - (b.messages as number);
    const ac = isCanon(a) ? 1 : 0;
    const bc = isCanon(b) ? 1 : 0;
    if (ac !== bc) return ac - bc;
    if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs - b.mtimeMs;
    if (a.filePath === b.filePath) return 0;
    return a.filePath < b.filePath ? 1 : -1;
  };

  const byId = new Map<string, CanonicalSessionEntry>();
  for (const [id, copies] of copiesById) {
    if (copies.length === 1) {
      byId.set(id, copies[0]);
      continue;
    }
    // Collision: compute the EXACT real-message count for every copy, then pick
    // the max by the total-order key.
    for (const e of copies) {
      e.messages = exactRealMessageCount(e.filePath);
      e.messagesExact = true;
    }
    let winner = copies[0];
    for (let i = 1; i < copies.length; i++) {
      if (better(copies[i], winner) > 0) winner = copies[i];
    }
    winner.droppedCopies = copies
      .filter((e) => e !== winner)
      .map((e) => ({ encodedDir: e.encodedDir, sessionId: e.sessionId }));
    byId.set(id, winner);
  }
  return byId;
}

/** Convenience: the whole store as logical projects, newest first. */
export function listLogicalProjects(opts: ScanOptions = {}): LogicalProject[] {
  return groupByLogicalProject(listProjectDirs(opts));
}
