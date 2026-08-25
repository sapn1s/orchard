/**
 * codex-native.ts — surface a project's NATIVE (external) Codex sessions.
 *
 * WHY (FEAT-078): Orchard reads Claude's *native* store
 * (`~/.claude/projects/<encodedCwd>/*.jsonl`) so Claude history auto-appears on
 * add-project. Codex sessions RUN THROUGH Orchard are captured under our own
 * `transcripts/openai` mirror (see orchard-transcripts.ts) — but sessions made
 * with the NATIVE `codex` CLI live in codex's OWN store and were invisible.
 *
 * NATIVE CODEX STORE (verified on disk, codex-cli 0.147.0)
 * -------------------------------------------------------
 *   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISOts>-<session_id>.jsonl
 * keyed by DATE (not by cwd like Claude). `$CODEX_HOME` defaults to `~/.codex`
 * — the SAME resolution codex-runtime.ts uses for auth. The first line is
 *   {"type":"session_meta","payload":{ session_id, id, timestamp, cwd, ... }}
 * The project association is `payload.cwd`; the resume handle is
 * `payload.session_id` (== the codex thread id). Subsequent lines are rollout
 * events (`response_item`, `event_msg`) — a different schema from Claude's.
 *
 * TWO PHASES, deliberately split for efficiency:
 *  1. LISTING (cheap, head-only). `listNativeCodexSessions` walks the date tree
 *     newest-first, reads only a BOUNDED HEAD of each rollout (session_meta +
 *     enough to derive a title), matches `cwd` to the project's hostPath, and
 *     returns SessionMeta rows tagged provider:'openai'. It NEVER full-parses a
 *     rollout — the tree can be large.
 *  2. IMPORT (on demand, full parse). `importNativeCodexSession` is called the
 *     moment a user opens or resumes one of those rows. It translates the whole
 *     rollout into an Orchard-owned transcript in the SAME entry shape
 *     TranscriptRecorder writes (`transcripts/openai/<encodedDir>/<id>.jsonl`).
 *     Once imported, the session is byte-for-byte a normal Orchard-owned Codex
 *     session for EVERY downstream reader (transcript route, live-detection,
 *     resume, fork) — so resume works through the existing codex thread/resume
 *     path with zero new lifecycle code. Idempotent: never overwrites an
 *     existing target (a live resume may already be appending to it).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { SessionMeta, SessionOS } from '../lib/session-history.ts';
import { encodeCwd, detectOs } from '../lib/session-history.ts';
import { orchardTranscriptFile } from './orchard-transcripts.ts';

/** Bytes read from the head of each rollout when deriving list metadata. */
const HEAD_BYTES = 256 * 1024;
/** Default cap on how many matching sessions a single scan returns. */
const DEFAULT_LIMIT = 200;
/** First-user-message title cap, matching session-history's FIRST_MESSAGE_CHARS. */
const TITLE_CHARS = 400;

export type NativeCodexSession = SessionMeta & { provider: 'openai'; native: true };

interface Env {
  CODEX_HOME?: string;
  [k: string]: string | undefined;
}

/** Root of the native codex session store — `$CODEX_HOME/sessions` or `~/.codex/sessions`. */
export function codexSessionsRoot(env: Env = process.env): string {
  const home = env.CODEX_HOME && env.CODEX_HOME.trim() ? env.CODEX_HOME.trim() : path.join(os.homedir(), '.codex');
  return path.join(home, 'sessions');
}

/* --------------------------------------------------------------- head read */

interface RolloutHead {
  sessionId: string | null;
  cwd: string | null;
  startedAt: string | null;
  model: string | null;
  firstUserMessage: string | null;
  /** user+assistant messages SEEN in the sampled head (a lower bound). */
  seenMessages: number;
  /** Bytes actually read from the file — proves the scan stays bounded. */
  bytesRead: number;
}

/**
 * `<text>`-tag wrappers the codex CLI injects as `user` role items that the
 * human did not type (environment/context/instruction blocks). A title must
 * skip these exactly as session-history skips Claude's command wrappers.
 */
const USER_WRAPPER_PREFIXES = [
  '<environment_context>',
  '<skills_instructions>',
  '<user_instructions>',
  '<multi_agent_mode>',
];

function isWrapperText(text: string): boolean {
  const t = text.trimStart();
  return !t || USER_WRAPPER_PREFIXES.some((p) => t.startsWith(p));
}

function normaliseTitle(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Plain text out of a codex message content array (`input_text` / `output_text`). */
function contentText(content: unknown, cap: number): string {
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const b = raw as { type?: string; text?: string };
    if ((b.type === 'input_text' || b.type === 'output_text' || b.type === 'text') && typeof b.text === 'string') {
      out.push(b.text);
    }
    if (out.join('\n').length >= cap) break;
  }
  return out.join('\n');
}

/**
 * Read a BOUNDED head of one rollout and pull out its listing metadata. Stops
 * as soon as it has a session_meta + a real first-user-message title (or hits
 * the head budget). Never reads more than `headBytes`.
 */
export function readRolloutHead(filePath: string, headBytes = HEAD_BYTES): RolloutHead {
  const res: RolloutHead = {
    sessionId: null,
    cwd: null,
    startedAt: null,
    model: null,
    firstUserMessage: null,
    seenMessages: 0,
    bytesRead: 0,
  };
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const want = Math.min(headBytes, size);
    const buf = Buffer.allocUnsafe(want);
    let filled = 0;
    while (filled < want) {
      const n = fs.readSync(fd, buf, filled, want - filled, filled);
      if (n <= 0) break;
      filled += n;
    }
    res.bytesRead = filled;
    // Drop a trailing partial line only when we did not read the whole file.
    const truncated = filled < size;
    const lines = buf.subarray(0, filled).toString('utf8').split('\n');
    if (truncated && lines.length) lines.pop();

    for (const line of lines) {
      const t = line.trim();
      if (!t || t[0] !== '{') continue;
      let o: any;
      try {
        o = JSON.parse(t);
      } catch {
        continue; // a straddled/partial line at the head boundary — skip it
      }
      const type = o?.type;
      const payload = o?.payload;
      if (type === 'session_meta' && payload && typeof payload === 'object') {
        if (typeof payload.session_id === 'string') res.sessionId = payload.session_id;
        if (typeof payload.cwd === 'string') res.cwd = payload.cwd;
        if (typeof payload.timestamp === 'string') res.startedAt = payload.timestamp;
        if (typeof payload.model === 'string') res.model = payload.model;
        continue;
      }
      if (type === 'turn_context' && payload && typeof payload.model === 'string' && !res.model) {
        res.model = payload.model;
        continue;
      }
      if (type === 'response_item' && payload && payload.type === 'message') {
        const role = payload.role;
        if (role !== 'user' && role !== 'assistant') continue; // developer/system — not human transcript
        res.seenMessages++;
        if (role === 'user' && !res.firstUserMessage) {
          const text = contentText(payload.content, TITLE_CHARS * 4);
          if (text && !isWrapperText(text)) {
            res.firstUserMessage = normaliseTitle(text).slice(0, TITLE_CHARS);
          }
        }
      }
      // Early exit once we have everything a list row needs.
      if (res.sessionId && res.cwd && res.firstUserMessage) break;
    }
  } catch {
    /* unreadable — honest empty head */
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
  return res;
}

/* ------------------------------------------------------------- date-tree walk */

/** Numeric-name subdirectories of `dir`, sorted DESCENDING (newest first). */
function numericDirsDesc(dir: string): string[] {
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return ents
    .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => b.localeCompare(a));
}

/**
 * Absolute paths of rollout files across the `YYYY/MM/DD` tree, NEWEST FIRST,
 * bounded by `maxFiles`. Ordering is by the ISO timestamp embedded in the
 * filename (`rollout-<ISOts>-<id>.jsonl`), which sorts lexicographically.
 */
export function listRolloutFiles(root: string, maxFiles = 5000): string[] {
  const out: string[] = [];
  for (const y of numericDirsDesc(root)) {
    for (const mo of numericDirsDesc(path.join(root, y))) {
      for (const d of numericDirsDesc(path.join(root, y, mo))) {
        const dayDir = path.join(root, y, mo, d);
        let files: string[];
        try {
          files = fs
            .readdirSync(dayDir, { withFileTypes: true })
            .filter((e) => e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl'))
            .map((e) => e.name)
            .sort((a, b) => b.localeCompare(a)); // newest first within the day
        } catch {
          files = [];
        }
        for (const f of files) {
          out.push(path.join(dayDir, f));
          if (out.length >= maxFiles) return out;
        }
      }
    }
  }
  return out;
}

/** Normalise a cwd for comparison — strip a trailing separator. */
function normCwd(p: string): string {
  return p.replace(/[\\/]+$/, '');
}

export interface ListOptions {
  env?: Env;
  /** Max rows returned. Default 200. */
  limit?: number;
  /** Max rollout files inspected before giving up (bound on a huge tree). */
  maxFilesScanned?: number;
}

/**
 * A project's native codex sessions, newest-activity first. Head-only: matches
 * `session_meta.cwd` to `hostPath` and derives a title without full-parsing any
 * rollout. Returns SessionMeta rows tagged provider:'openai' so the sidebar
 * badges them exactly like Orchard-run codex sessions.
 */
export function listNativeCodexSessions(hostPath: string, opts: ListOptions = {}): NativeCodexSession[] {
  const env = opts.env ?? process.env;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const maxFiles = opts.maxFilesScanned ?? 5000;
  const root = codexSessionsRoot(env);
  const target = normCwd(hostPath);
  const encodedDir = encodeCwd(hostPath);
  const os_: SessionOS = detectOs(hostPath);

  const out: NativeCodexSession[] = [];
  const seenIds = new Set<string>();
  for (const file of listRolloutFiles(root, maxFiles)) {
    const head = readRolloutHead(file);
    if (!head.cwd || !head.sessionId) continue;
    if (normCwd(head.cwd) !== target) continue; // other-cwd session — excluded
    if (seenIds.has(head.sessionId)) continue;
    seenIds.add(head.sessionId);

    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    // lastActivity from the file mtime (cheap + accurate to last write); the
    // start time from session_meta / the filename's leading ISO timestamp.
    const mtime = new Date(st.mtimeMs).toISOString();
    const title = head.firstUserMessage;
    out.push({
      sessionId: head.sessionId,
      encodedDir,
      filePath: file,
      fileBytes: st.size,
      fileMtime: mtime,
      startedAt: head.startedAt,
      lastActivityAt: mtime,
      messageCount: head.seenMessages, // lower bound (head only)
      models: head.model ? [head.model] : [],
      statsExact: false,
      title: null, // codex rollouts carry no ai-title
      firstUserMessage: title,
      firstCommand: null,
      displayTitle: title ?? '(untitled codex session)',
      cwd: head.cwd,
      os: os_,
      cwdExistsOnHost: (() => {
        try {
          return os_ === 'linux' && fs.statSync(head.cwd as string).isDirectory();
        } catch {
          return false;
        }
      })(),
      gitBranch: null,
      version: null,
      warnings: [],
      provider: 'openai',
      native: true,
    });
    if (out.length >= limit) break;
  }
  out.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  return out;
}

/* ------------------------------------------------------------------ import */

/** Find the rollout file for a session id — the id is IN the filename, so no parse. */
export function findRolloutBySessionId(sessionId: string, env: Env = process.env): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId.includes('..')) return null;
  const root = codexSessionsRoot(env);
  const suffix = `-${sessionId}.jsonl`;
  for (const file of listRolloutFiles(root)) {
    if (path.basename(file).endsWith(suffix)) return file;
  }
  return null;
}

export interface OrchardEntry {
  type: 'user' | 'assistant';
  content: Record<string, unknown>[];
}

/** Translate ONE rollout `response_item` payload into an Orchard transcript entry (or null to skip). */
export function translateItem(payload: any): OrchardEntry | null {
  const t = payload?.type;
  if (t === 'message') {
    const role = payload.role;
    if (role === 'assistant') {
      const text = contentText(payload.content, Number.MAX_SAFE_INTEGER);
      if (!text) return null;
      return { type: 'assistant', content: [{ type: 'text', text }] };
    }
    if (role === 'user') {
      const text = contentText(payload.content, Number.MAX_SAFE_INTEGER);
      if (!text || isWrapperText(text)) return null;
      return { type: 'user', content: [{ type: 'text', text }] };
    }
    return null; // developer/system
  }
  if (t === 'reasoning') {
    // Parity with the live codex path: the FACT of thinking, text empty.
    return { type: 'assistant', content: [{ type: 'thinking', thinking: '' }] };
  }
  if (t === 'function_call' || t === 'custom_tool_call' || t === 'local_shell_call') {
    const id = String(payload.call_id ?? payload.id ?? '');
    let input: unknown = payload.input ?? payload.arguments ?? null;
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch {
        /* keep the raw string */
      }
    }
    return {
      type: 'assistant',
      content: [{ type: 'tool_use', id, name: String(payload.name ?? t), input }],
    };
  }
  if (t === 'function_call_output' || t === 'custom_tool_call_output') {
    const id = String(payload.call_id ?? payload.id ?? '');
    const raw = payload.output;
    const text = typeof raw === 'string' ? raw : contentText(raw, Number.MAX_SAFE_INTEGER) || flatten(raw);
    return {
      type: 'user',
      content: [
        { type: 'tool_result', tool_use_id: id, is_error: payload.status === 'failed', content: text },
      ],
    };
  }
  return null;
}

function flatten(v: unknown): string {
  if (v == null) return '';
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

export interface ImportResult {
  filePath: string;
  entries: number;
  alreadyPresent: boolean;
}

/**
 * Backfill a native codex session into the Orchard-owned transcript store so
 * every existing reader (transcript route, resume, live-detection) serves it
 * unchanged. Idempotent: if the target file already exists it is LEFT ALONE
 * (a live resume may be appending to it) and reported as `alreadyPresent`.
 *
 * `expectedEncodedDir`, when given, is asserted against the rollout's own cwd —
 * a caller that only knows the encoded dir (the transcript route) uses it as a
 * safety check so a mismatched id cannot write into the wrong project's dir.
 */
export function importNativeCodexSession(
  sessionId: string,
  opts: { env?: Env; expectedEncodedDir?: string } = {},
): ImportResult | null {
  const env = opts.env ?? process.env;
  const rollout = findRolloutBySessionId(sessionId, env);
  if (!rollout) return null;

  const head = readRolloutHead(rollout);
  if (!head.cwd || head.sessionId !== sessionId) return null;
  const encodedDir = encodeCwd(head.cwd);
  if (opts.expectedEncodedDir && opts.expectedEncodedDir !== encodedDir) return null;

  const target = orchardTranscriptFile('openai', encodedDir, sessionId);
  if (fs.existsSync(target)) {
    return { filePath: target, entries: 0, alreadyPresent: true };
  }

  // Full parse — this is the on-demand path, not the listing scan.
  const cwd = head.cwd;
  const lines: string[] = [];
  let prevUuid: string | null = null;
  let entries = 0;

  const raw = fs.readFileSync(rollout, 'utf8');
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let o: any;
    try {
      o = JSON.parse(s);
    } catch {
      continue;
    }
    if (o?.type !== 'response_item') continue;
    const entry = translateItem(o.payload);
    if (!entry) continue;
    const uuid = randomUUID();
    const ts = typeof o.timestamp === 'string' ? o.timestamp : new Date().toISOString();
    lines.push(
      JSON.stringify({
        type: entry.type,
        uuid,
        parentUuid: prevUuid,
        timestamp: ts,
        sessionId,
        cwd,
        provider: 'openai',
        message:
          entry.type === 'assistant'
            ? { role: 'assistant', ...(head.model ? { model: head.model } : {}), content: entry.content }
            : { role: 'user', content: entry.content },
      }),
    );
    prevUuid = uuid;
    entries++;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Write atomically-ish: a temp file then rename, so a concurrent reader never
  // sees a half-written transcript. Never clobbers an existing target (checked
  // above), so a live resume's file is safe.
  const tmp = `${target}.import-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tmp, lines.length ? lines.join('\n') + '\n' : '');
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    // Lost a race to a concurrent import/resume — the target now exists; drop
    // our temp and report the winner.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    if (fs.existsSync(target)) return { filePath: target, entries: 0, alreadyPresent: true };
    throw err;
  }
  return { filePath: target, entries, alreadyPresent: false };
}
