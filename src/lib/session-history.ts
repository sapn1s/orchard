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
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
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
  const maxTextChars = Math.max(0, Math.floor(opts.maxTextChars ?? 4000));
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

function toBlocks(content: unknown, cap: number, includeToolResults: boolean): TranscriptBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content.slice(0, cap), truncated: content.length > cap }];
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
    if (type === 'text' || type === 'thinking') {
      const src = type === 'thinking' ? (b.thinking ?? '') : (b.text ?? '');
      out.push({ type, text: src.slice(0, cap), truncated: src.length > cap });
    } else if (type === 'tool_use') {
      let input = '';
      try {
        input = JSON.stringify(b.input ?? null);
      } catch {
        input = '<uninspectable input>';
      }
      out.push({
        type,
        toolName: typeof b.name === 'string' ? b.name : undefined,
        toolUseId: typeof b.id === 'string' ? b.id : undefined,
        text: input.slice(0, cap),
        truncated: input.length > cap,
      });
    } else if (type === 'tool_result') {
      if (!includeToolResults) {
        out.push({ type, toolUseId: b.tool_use_id, isError: b.is_error === true, text: '' });
        continue;
      }
      const flat = flattenToolResult(b.content, cap);
      out.push({
        type,
        toolUseId: typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined,
        isError: b.is_error === true,
        text: flat.slice(0, cap),
        truncated: flat.length > cap,
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
  const byId = new Map<string, SessionMeta>();
  for (const d of project.dirs) {
    for (const s of listSessions(d.encodedDir, opts)) {
      const prev = byId.get(s.sessionId);
      if (!prev) {
        byId.set(s.sessionId, s);
        continue;
      }
      // Keep the copy in the dir whose encoding matches its own cwd; then the
      // larger file. The other is a copy from the other install.
      // NB: never mutate `s`/`prev` — they may be memo-cached objects.
      const prevCanon = prev.cwd !== null && encodeCwd(prev.cwd) === prev.encodedDir;
      const curCanon = s.cwd !== null && encodeCwd(s.cwd) === s.encodedDir;
      const keepCur = (curCanon && !prevCanon) || (curCanon === prevCanon && s.fileBytes > prev.fileBytes);
      const kept = keepCur ? s : prev;
      const dropped = keepCur ? prev : s;
      byId.set(s.sessionId, {
        ...kept,
        warnings: kept.warnings.concat(
          `duplicate copy ignored: ${dropped.encodedDir}/${dropped.sessionId}.jsonl`,
        ),
      });
    }
  }
  const out = Array.from(byId.values());
  out.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  return out;
}

/** Convenience: the whole store as logical projects, newest first. */
export function listLogicalProjects(opts: ScanOptions = {}): LogicalProject[] {
  return groupByLogicalProject(listProjectDirs(opts));
}
